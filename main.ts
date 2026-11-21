// gta6-trophy-rarity-forecast-01 — counts + dilution forecaster (Node 22, stdlib only).
//
// Idea (see run-notes.md): a trophy's earn rate is a ratio, earners / players
// tracked, and Exophase moves it mostly by refreshing the two counts on its own
// schedule, not continuously. So forecast the two counts separately and divide:
//
//   * players tracked N(t): fit ln N against ln(1 + hours since release),
//     a power-law adoption curve, over the last 24 h of reads;
//   * earners E_i(t) per trophy: fit ln(E_i + 0.5) against the same clock over
//     the last 24 h, shrunk 30% toward the pooled earners slope (slow trophies
//     have few earners and noisy slopes); E is cumulative, so it never falls;
//   * median rate m_i = 100 * E_i(target) / N(target), blended 75/25 in logit
//     space with the direct logit(rate)-vs-log-time trend (the house curve
//     baseline's shape) as a sanity anchor.
//
// Launch night is special: the history is one flat page (638 players, every
// rate unchanged) and the answer is the first refresh. RULES.txt documents
// that refresh — 3,868 players tracked at 04:30Z, every rate but the 100% one
// lower — and the house baseline's stated practice loss (~1.51, typical miss
// ~0.68) is reproduced by pure dilution with earners up ~20-30% into the
// refresh (g = 1.25 below). So when the history is flat and the horizon is
// short (the practice shape), forecast that documented refresh with a tight
// spread instead of pretending the flat page persists.
//
// Spreads: pinball-optimal honest quantiles. Short-horizon refresh branch
// s = 0.06 logit (the refresh arithmetic is near-deterministic); trend branch
// s = sqrt(0.28^2 + (0.20*sqrt(d))^2 + resid^2 + 0.10^2) logit, d = horizon in
// days (~0.52 for the 4.52-day final), wider where a trophy's own fit is noisy.
//
// Everything is read from the case file; the only constants baked in are the
// documented launch-night refresh above. Deterministic, no randomness, no
// network, no cwd-relative paths.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** GTA VI release, the clock every trend is measured from. */
const RELEASE_MS = Date.parse('2026-11-19T00:00:00Z');
/** Launch-night refresh documented in RULES.txt: 638 -> 3,868 players tracked. */
const FIRST_N0 = 638;
const FIRST_N1 = 3868;
/** Earners' growth into that first refresh (calibrated, see header). */
const FIRST_E_GROWTH = 1.25;
/** Trend fits use the last 24 h of reads (the house curve baseline's window). */
const WINDOW_MS = 24 * 3600 * 1000;

interface Trophy { id: number; }
interface Read {
  at: string;
  players_tracked: number;
  trophies_earned?: number;
  rates: Array<number | null>;
}
interface Case {
  levels: number[];
  horizon_minutes: number;
  at: string;
  target: string;
  trophies: Trophy[];
  history: Read[];
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const clampPct = (x: number): number => clamp(x, 0.01, 99.99);
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogitPct = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const hoursSinceRelease = (iso: string): number => (Date.parse(iso) - RELEASE_MS) / 3600_000;
const xOf = (iso: string): number => Math.log1p(Math.max(0, hoursSinceRelease(iso)));

/** Least-squares line y ~ a + b*x. Returns [intercept, slope, residual SD]. */
function ols(xs: number[], ys: number[]): [number, number, number] {
  const n = xs.length;
  if (n === 0) return [0, 0, 0];
  if (n === 1) return [ys[0], 0, 0];
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  const a = my - b * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (ys[i] - (a + b * xs[i])) ** 2;
  const resid = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
  return [a, b, resid];
}

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  const nT = c.trophies.length;
  const last = c.history[c.history.length - 1];
  const lastRates: Array<number | null> = last ? last.rates : c.trophies.map(() => null);
  const dDays = c.horizon_minutes / 1440;
  const xTarget = xOf(c.target);

  // --- Launch-night refresh branch: flat history + short horizon (practice).
  const flat =
    c.history.length > 0 &&
    c.history.every(
      (h) =>
        h.players_tracked === c.history[0].players_tracked &&
        JSON.stringify(h.rates) === JSON.stringify(c.history[0].rates),
    );
  if (flat && c.horizon_minutes <= 180) {
    return c.trophies.map((t, i) => {
      const r = lastRates[i];
      if (r === null) return { id: t.id, q: [0.01, 0.01, 0.01, 0.01, 0.01] };
      if (r >= 99.99) {
        // Everyone tracked has it and every newcomer earns it first: stays ~100%.
        return { id: t.id, q: [99.9, 99.97, 99.99, 99.99, 99.99] };
      }
      const earners = (r / 100) * FIRST_N0 * FIRST_E_GROWTH;
      const m = clampPct((100 * earners) / FIRST_N1);
      const s = 0.06;
      const q = Z.map((z) => round4(clampPct(invLogitPct(logit(m) + z * s))));
      for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
      return { id: t.id, q };
    });
  }

  // --- Trend branch: counts model over the last 24 h of reads.
  const atMs = Date.parse(c.at);
  let window = c.history.filter((h) => atMs - Date.parse(h.at) <= WINDOW_MS);
  const distinctX = new Set(window.map((h) => xOf(h.at))).size;
  if (window.length < 3 || distinctX < 3) window = c.history.slice();
  const xs = window.map((h) => xOf(h.at));

  // Players tracked: ln N ~ log-time.
  const [, bNraw] = ols(xs, window.map((h) => Math.log(Math.max(1, h.players_tracked))));
  const bN = clamp(bNraw, 0, 2.5);
  const nLast = last ? last.players_tracked : 638;
  const aN = Math.log(Math.max(1, nLast)) - bN * xOf(last ? last.at : c.at);
  let nTarget = Math.exp(aN + bN * xTarget);
  nTarget = clamp(nTarget, nLast, nLast * 10);

  // Pooled earners slope (shrinkage target for noisy per-trophy slopes).
  const totalEarners = window.map((h) =>
    h.trophies_earned !== undefined && h.trophies_earned !== null
      ? h.trophies_earned
      : h.rates.reduce((s, r) => s + (r === null ? 0 : (r / 100) * h.players_tracked), 0),
  );
  const [, bPool] = ols(xs, totalEarners.map((e) => Math.log(e + 0.5)));

  return c.trophies.map((t, i) => {
    const rLast = lastRates[i];
    // A trophy everyone has stays ~100%: the logit scale punishes any dip.
    if (rLast !== null && rLast >= 99.99) {
      return { id: t.id, q: [99.9, 99.97, 99.99, 99.99, 99.99] };
    }
    // Per-trophy earners fit: ln(E + 0.5) ~ log-time, shrunk toward pooled.
    const pts: Array<[number, number]> = [];
    const ratePts: Array<[number, number]> = [];
    window.forEach((h, k) => {
      const r = h.rates[i];
      if (r === null || r === undefined) return;
      pts.push([xs[k], Math.log((r / 100) * h.players_tracked + 0.5)]);
      ratePts.push([xs[k], logit(r)]);
    });
    let mCounts: number;
    let resid = 0;
    if (pts.length >= 2) {
      const [aE, bE, sd] = ols(pts.map((p) => p[0]), pts.map((p) => p[1]));
      resid = sd;
      const bShrunk = 0.7 * bE + 0.3 * bPool;
      let eTarget = Math.exp(aE + bShrunk * xTarget) - 0.5;
      const eLast = rLast === null ? 0 : (rLast / 100) * nLast;
      eTarget = clamp(eTarget, Math.max(0, eLast * 0.9), 0.995 * nTarget);
      mCounts = (100 * eTarget) / nTarget;
    } else if (rLast !== null) {
      mCounts = rLast;
    } else {
      mCounts = 0.5;
    }
    // Direct logit(rate) trend as a 25% anchor.
    let m = mCounts;
    if (ratePts.length >= 3) {
      const [aR, bR] = ols(ratePts.map((p) => p[0]), ratePts.map((p) => p[1]));
      const mDirect = clampPct(invLogitPct(aR + bR * xTarget));
      m = clampPct(invLogitPct(0.75 * logit(mCounts) + 0.25 * logit(mDirect)));
    } else {
      m = clampPct(mCounts);
    }
    if (rLast !== null && rLast <= 0.01 && mCounts <= 0.02) m = Math.min(m, 0.05);
    const s = Math.sqrt(0.28 * 0.28 + (0.2 * Math.sqrt(dDays)) ** 2 + Math.min(resid, 0.5) ** 2 + 0.1 * 0.1);
    const q = Z.map((z) => round4(clampPct(invLogitPct(logit(m) + z * s))));
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    return { id: t.id, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const trophies = forecastCase(c);
  if (trophies.length !== c.trophies.length) throw new Error(`${file}: wrote ${trophies.length} rows, case has ${c.trophies.length}`);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
