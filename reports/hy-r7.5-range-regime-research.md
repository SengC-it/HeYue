# HY-R7.5 RANGE REGIME RESEARCH

Classification: **NO_RANGE_PROFITABLE_CANDIDATE**

Research-only artifact. No Production, Supabase, Vercel, PAPER strategy, scheduler, email, private API, or order state was changed.

## Frozen authority and Candidate A reproduction

- PR #9; branch `research/hy-r7-profitability`; frozen base research HEAD `31a1f53a2cae599a962b27c39cd03bea9396b1b0`; PR remains **DRAFT**.
- Candidate A: `HY-R7-FORWARD-CANDIDATE-A`, strategy `hy-paper-candidate-v2`, SHA256 `3c3df714d4e5768a4393e523b331b70f239e5c07b963e5bdada7442d69a27918`.
- Reproduction gate: **PASS**; base 29 trades / 469.31166529 USDT / PF 1.59999141; stress 400.66533784 USDT / PF 1.48858398.
- Expected authority: 29 trades / 469.31166529 USDT / PF 1.59999141; stress 400.66533784 USDT / PF 1.48858398.

## PIT windows and frozen RANGE contract

- Dataset: 2025-08-09T02:15:00.000Z through 2026-08-09T02:14:59.999Z.
- Train: 2025-08-09T02:15:00.000Z through 2026-02-07T02:15:00.000Z; validation: 2026-02-09T02:15:00.000Z through 2026-05-07T02:15:00.000Z; final OOS: 2026-05-09T02:15:00.000Z through 2026-08-09T02:14:59.999Z.
- 48-hour embargo is preserved. Only closed 15m candles through decision time t are consumed; execution is next-bar open.
- RANGE_RECLAIM / MEAN_REVERSION / LONG + SHORT; local regime RANGE is required. Frozen Bollinger=20/2; RSI=14, thresholds 35/65.
- No parameter search and no new indicators. Common settings: minScore 80, cooldown 24h, RR 2, max hold 48h, stop ATR 0.75, top-10 universe, risk 50 USDT/trade, daily budget 600, leverage 20.

## Train + validation selection (no final OOS for rejected candidates)

| Candidate | Base net | Base expectancy | Base PF | Stress net | Stress PF | Positive base folds | Distinct symbols | Gate |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| HY-R7-RANGE-CANDIDATE-D1 | -288.9109456 | -22.22391889 | 0.40979153 | -319.19739496 | 0.37776706 | 0 | 6 | REJECTED |
| HY-R7-RANGE-CANDIDATE-D2 | -127.20366234 | -12.72036623 | 0.61194654 | -149.7254107 | 0.56413719 | 1 | 5 | REJECTED |

- D1 is local-RANGE-only and does not use a BTC global filter.
- D2 uses a PIT BTCUSDT 4h RANGE filter and does not use directional `globalRegimeAlignment`.
- Selection attribution (train + validation, before any Final OOS): [{"candidateId":"HY-R7-RANGE-CANDIDATE-D1","regimeImpact":{"candidateId":"HY-R7-RANGE-CANDIDATE-D1","window":{"start":"2025-08-09T02:15:00.000Z","end":"2026-05-07T02:15:00.000Z"},"localRangeObservations":199584,"totalDecisionObservations":520320,"btcGlobalRegimeDistribution":{"BULL":6912,"BEAR":8752,"RANGE":10352,"UNKNOWN":0},"signalsByGlobalRegime":{"BULL":1,"BEAR":3,"RANGE":9,"UNKNOWN":0},"pnlByGlobalRegime":{"BULL":-52.61378681,"BEAR":-163.36299869,"RANGE":-72.93416009,"UNKNOWN":0},"conclusion":"D1 observes local RANGE without a BTC directional filter; D2 is the explicit PIT BTC 4h RANGE restriction. The D1 distribution is descriptive attribution, not a D3 search or a post-hoc rule change."}},{"candidateId":"HY-R7-RANGE-CANDIDATE-D2","regimeImpact":{"candidateId":"HY-R7-RANGE-CANDIDATE-D2","window":{"start":"2025-08-09T02:15:00.000Z","end":"2026-05-07T02:15:00.000Z"},"localRangeObservations":199584,"totalDecisionObservations":520320,"btcGlobalRegimeDistribution":{"BULL":6912,"BEAR":8752,"RANGE":10352,"UNKNOWN":0},"signalsByGlobalRegime":{"BULL":0,"BEAR":0,"RANGE":10,"UNKNOWN":0},"pnlByGlobalRegime":{"BULL":0,"BEAR":0,"RANGE":-127.20366234,"UNKNOWN":0},"conclusion":"D1 observes local RANGE without a BTC directional filter; D2 is the explicit PIT BTC 4h RANGE restriction. The D1 distribution is descriptive attribution, not a D3 search or a post-hoc rule change."}}]. This is the required D1 answer on whether BTC global regime changes local-RANGE outcomes; it is descriptive and does not authorize D3.
- Selection ranking is profitability-first, then stress PF, base expectancy, lower drawdown, stability, and trade count. Selected: **NONE**.
- Rejected candidates were not run in Final OOS: ["HY-R7-RANGE-CANDIDATE-D1","HY-R7-RANGE-CANDIDATE-D2"].

## Selected RANGE Final OOS

No D1/D2 passed train + validation; selected D* Final OOS was not run.

## Candidate E and portfolio combination

Candidate E was not run because no RANGE candidate passed selection.

## Forward audit (post-hoc, not independent validation)

- Window: 2026-08-09T17:34:48.982760Z to not run; status **NOT_RUN**.
- No D1/D2 candidate passed train + validation selection; no D*/E forward audit was authorized.
- This is explicitly **POST-HOC AUDIT / NOT INDEPENDENT VALIDATION** and was not used for selection, thresholds, or OOS gates.

## Score parity warning

- R7.4 raw score exact parity: {"compared":798,"exact":502,"mismatch":296,"matchPercent":62.907268}; qualified score parity: {"compared":798,"exact":798,"mismatch":0,"matchPercent":100}.
- Forward replay raw candidate scores in 79–81: **not run**.
- Production score parity required before activation: **NO / NOT APPLICABLE**.

## Data, attribution, and audit boundaries

- Selection dataset: **20 symbols only**; 49-symbol replay, forward data, and the frozen 37-row email failure set were not selection inputs.
- Local RANGE observations in selected final OOS: not run; BTC global regime distribution and PnL attribution are retained without deleting losing sides.
- Failure-set audit: 37 rows, used for selection: **NO**.
- Data manifest SHA256: `257931a398f10a3572bc550c0529590720929286d7c6e2a51719ed2e39796d52`; representation: sorted UTF-8 `filename:raw-file-SHA256` rows. No raw dataset is submitted.

## Verification and safety

- Tests: **220 passed / 1 skipped (221 total)**
- Typecheck: **PASS**; lint: **PASS**; build: **PASS**; diff: **PASS**; GitHub CI: **pending push**.
- Production modified: **NO**; Supabase modified: **NO**; Vercel modified: **NO**; PAPER strategy modified: **NO**; real emails: **0**; private API: **NO**; orders: **0**; AUTO_TRADING: **FALSE**.
- Final classification: **NO_RANGE_PROFITABLE_CANDIDATE**.
