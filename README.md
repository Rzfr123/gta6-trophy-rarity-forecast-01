# GTA VI Trophy Rarity Forecast

[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/c/gta6-trophy-rarity-forecast-01)
[![Node](https://img.shields.io/badge/node-22-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Forecasts every GTA VI (PS5) trophy's Exophase earn rate at
2026-11-26T00:00:00Z as five quantiles, for the
[make.fun bounty](https://make.fun/c/gta6-trophy-rarity-forecast-01) ($250).

## Model

A rate is earners / players tracked, and Exophase moves it by refreshing
the two counts. So this entry forecasts the counts separately — log-time
power-law fits for players tracked and per-trophy earners over the last
24 h of reads, shrunk toward the pooled slope — and divides. Launch
night's flat page is handled by the refresh the rules document
(638 → 3,868 players, earners +25%). See `run-notes.md`.

## Run

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only. Reads every `*.in`, writes `<id>.out`.
