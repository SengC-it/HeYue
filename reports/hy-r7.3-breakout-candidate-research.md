# HY-R7.3 R7.2 Reconciliation + Breakout Candidate Research

Classification: **NO_HIGHER_THROUGHPUT_PROFITABLE_ALTERNATIVE**

Research-only artifact. No Production, Supabase, Vercel, PAPER strategy, email, private API, or order state was changed.

## Frozen authority and PIT dataset

- Authoritative Candidate A: `HY-R7-FORWARD-CANDIDATE-A`; exact R7.1A reproduction: **YES**.
- A OOS: **29 trades**, **469.31166529 USDT**, PF **1.59999141**; stress **400.66533784 USDT**, PF **1.48858398**.
- Selection dataset: **20 fixed symbols** from `data/validation-cache`; 49-symbol R7.2 data is sensitivity-only.
- PIT: closed 15m decision data through t; next-bar open execution; 48h embargo between train/validation/final OOS.
- Candidate A hash: `3c3df714d4e5768a4393e523b331b70f239e5c07b963e5bdada7442d69a27918` (unchanged).

## A49 relabeling

R7.2’s 31-trade / 516.82431928 USDT / PF 1.62010391 replay is explicitly **A49_SENSITIVITY_REPLAY**. It is not authoritative A and is not used for selection.

## Production diagnostics (read-only)

Rows: **775**; scan runs: **775**; symbol observations: **7750**.

| rejectionStage | Count | Share |
|---|---:|---:|
| NO_RAW_CANDIDATE | 6421 | 82.851613% |
| SCORE | 1272 | 16.412903% |
| SIDE | 48 | 0.619355% |
| EXECUTION_COST | 8 | 0.103226% |
| QUALIFIED | 1 | 0.012903% |

Primary throughput limiter: **ENTRY PATTERN SCARCITY** (NO_RAW_CANDIDATE is largest). Secondary limiter: **SCORE FILTER**. Score was not lowered. Candidate-level filter counters are non-sequential; conditional rates are intentionally **not calculated**. Latest diagnostics remain `hy-paper-candidate-v2`, global regime `RANGE`, deep universe 10.

## Pre-registered candidate selection

Selection gate: net > 0, expectancy > 0, PF >= 1.20, stress net > 0, stress PF >= 1.05, and at least 2 positive base folds. Profitability is ranked before throughput.

| Candidate | Selection net | Expectancy | PF | Stress net | Stress PF | Positive base folds | Gate |
|---|---:|---:|---:|---:|---:|---:|---|
| HY-R7-BREAKOUT-CANDIDATE-C1 | -1850.17543873 | -12.01412623 | 0.66536883 | -2115.81967028 | 0.6294043 | 0 | REJECTED |
| HY-R7-COMBINED-CANDIDATE-C2 | 80.85027732 | 0.32211266 | 1.00990161 | -439.00865762 | 0.94830681 | 1 | REJECTED |

- C1 defaults are frozen `BREAKOUT_RETEST`, breakoutPeriod=20, breakoutVolumeRatio=1.15; no optimization was performed.
- C2 is the union of A and C1 with one 24h same-symbol cooldown, shared portfolio caps, and higher-score de-duplication at the same symbol/timestamp.

## Final OOS (one-shot after selection)

| Candidate | Status | OOS trades | OOS net | OOS PF | Profitability | Throughput |
|---|---|---:|---:|---:|---|---|
| HY-R7-BREAKOUT-CANDIDATE-C1 | NOT_RUN_BEFORE_SELECTION | NOT RUN | NOT RUN | NOT RUN | NO | NO |
| HY-R7-COMBINED-CANDIDATE-C2 | NOT_RUN_BEFORE_SELECTION | NOT RUN | NOT RUN | NOT RUN | NO | NO |

Neither preregistered challenger passed the selection gate; Candidate A remains the only frozen forward candidate.

## Bootstrap and decision

Bootstrap confidence is present for every actual final-OOS run. No final OOS was run for a rejected challenger. Classification is limited to the R7.3 allowed set and is **NO_HIGHER_THROUGHPUT_PROFITABLE_ALTERNATIVE**.

## Verification and safety

- Tests: **200/201 (1 skipped)**
- Typecheck: **PASS**
- Lint: **PASS**
- Build: **blocked after compile by sandbox `spawn EPERM`; standalone typecheck PASS**
- Diff: **PASS**
- GitHub CI: **pending push**
- Production modified: **NO**; Supabase modified: **NO**; Vercel modified: **NO**; PAPER strategy modified: **NO**.
- Real email: **OFF**; private API: **NO**; orders: **0**; AUTO_TRADING: **FALSE**.

Reports updated: `reports/hy-r7.2-signal-throughput-research.{json,md}`.
