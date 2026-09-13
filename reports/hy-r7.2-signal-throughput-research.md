# HY-R7.2 Signal Throughput + Profitability Research

Research-only report generated from the frozen 49-symbol PIT dataset. Candidate A remains immutable and Production was not modified.

## Safety and freeze

- Candidate A: `HY-R7-FORWARD-CANDIDATE-A`, `hy-paper-candidate-v2`
- Strategy hash: `3c3df714d4e5768a4393e523b331b70f239e5c07b963e5bdada7442d69a27918`
- Production / Supabase / Vercel / PAPER strategy modified: **NO**
- Real email: **OFF**; private API: **NO**; orders: **0**; AUTO_TRADING: **FALSE**
- B4 historical series: **NOT USED**

## Dataset and PIT protocol

- Files: 49; bytes: 633080652; symbols: 49
- Manifest SHA-256: `95d71fb5cfedcf07e7272e60a64e50488a5281230b569b786bdf136e7852793f`
- Window: 2025-08-09T02:15:00.000Z → 2026-08-09T02:14:59.999Z
- Split: train through 2026-02-07T02:15:00.000Z; validation 2026-02-09T02:15:00.000Z → 2026-05-07T02:15:00.000Z; final OOS 2026-05-09T02:15:00.000Z → 2026-08-09T02:14:59.999Z
- PIT rule: At each 15m decision, only candles and dynamic quote-volume rank through that closed decision candle are consumed; entry is the next bar open.

## Candidate A final-OOS funnel

Unit: symbol x closed 15m decision observation; final signal means post-cooldown, execution-cost eligible event before portfolio caps.

| Stage | Input | Passed | Rejected | Pass rate | Cumulative |
|---|---:|---:|---:|---:|---:|
| symbols considered | 432719 | 432719 | 0 | 100.0000% | 100.0000% |
| liquidity/universe eligible | 432719 | 88310 | 344409 | 20.4082% | 20.4082% |
| TREND_PULLBACK condition met | 88310 | 15206 | 73104 | 17.2189% | 3.5141% |
| SHORT side eligible | 15206 | 7686 | 7520 | 50.5458% | 1.7762% |
| local regime aligned | 7686 | 4594 | 3092 | 59.7710% | 1.0617% |
| BTC 4h regime aligned | 4594 | 3210 | 1384 | 69.8737% | 0.7418% |
| score >=80 | 3210 | 205 | 3005 | 6.3863% | 0.0474% |
| cooldown eligible | 205 | 110 | 95 | 53.6585% | 0.0254% |
| execution-cost eligible | 110 | 32 | 78 | 29.0909% | 0.0074% |
| final signal emitted | 32 | 32 | 0 | 100.0000% | 0.0074% |

Dominant bottleneck: **liquidity/universe eligible** (UNIVERSE), rejecting 344409 of 432719 (79.591837%).

Train and validation funnels are retained in the JSON artifact; no thresholds were searched or changed.

## Signal rates

- Candidate A historical final-OOS signals: **31**
- Candidate A historical OOS signals/week: **2.35869565**; annualized: **123.07336958**
- Candidate A Production forward scans: **3284**
- Candidate A Production forward signals: **1**
- Candidate A Production forward signals/week: **0.20314895**
- Estimated days to 30 matured trades at current Production rate: **1033.7242602**
- Estimated days to 100 matured trades at current Production rate: **3445.747534**

Historical OOS frequency meets the throughput target, but the current Production forward rate is below 0.5 signal/week. That is a current-usability classification only, not an edge failure.

## Challenger selection and comparison

Candidate family selected: **UNIVERSE**.

- B1: top-20; selection eligible=false; final OOS=NOT_RUN_BEFORE_SELECTION; OOS signals=NOT RUN
- B2: top-30; selection eligible=false; final OOS=NOT_RUN_BEFORE_SELECTION; OOS signals=NOT RUN

No Candidate B reached a permitted final-OOS comparison in this run.

Profitability is ranked before throughput. Candidate B final OOS is one-shot after train+validation selection; non-selected challengers remain NOT RUN.

## Production read-only evidence

The live snapshot recorded 3284 completed scans and 0 failed scans. Only 749 diagnostics rows cover 749 scans, so the complete production funnel is **UNKNOWN** rather than inferred. Observed diagnostic counters are preserved verbatim in JSON with their units.

Current strategy: `hy-paper-candidate-v2`, stage `PAPER`, source `DB`, dryRun=`false`, exchange credentials configured=`false`, autoTrading=`false`.

## Forward-gate proposal

- Fixed gate: at least 100 matured trades.
- Statistical gate: bootstrap expectancy 95% CI, bootstrap PF distribution, and worst-case cost stress.
- Real email remains OFF until at least 30 matured trades and 30 calendar days even if a confidence interval is positive.
- Early kill remains unchanged and is not triggered by the current one-trade Production sample.

## Legacy failure-set isolation

The frozen 37-row failure set is audit-only: retained=0, suppressed=37, retained PnL=0, and it was not used for selection or OOS scoring.

## Result

Classification: **CANDIDATE_A_TOO_SPARSE_NO_SAFE_EXPANSION**

Local verification: tests **191 passed / 192 (1 skipped)**, typecheck **PASS**, lint **PASS**, build **PASS**, and diff **PASS**. GitHub CI is pending the push of this classification correction.
