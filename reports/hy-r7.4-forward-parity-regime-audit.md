# HY-R7.4 Forward Parity + Regime Drift Audit

本报告仅审计冻结的 Candidate A；没有参数搜索、Production 写入、部署或邮件发送。所有 forward replay 使用公开 Binance 市场数据，决策只读 closed 15m candle，执行价为下一根 15m open。

## 1. Frozen authority

- Candidate: HY-R7-FORWARD-CANDIDATE-A; strategy: hy-paper-candidate-v2; strategy SHA256: 3c3df714d4e5768a4393e523b331b70f239e5c07b963e5bdada7442d69a27918
- Reproduction gate: **PASS**; base: 29 trades / 469.31166529 USDT / PF 1.59999141; stress: 400.66533784 USDT / PF 1.48858398. Expected 29 / 469.31166529 / 1.59999141 and 400.66533784 / 1.48858398.
- Historical OOS boundary: 2026-08-09T02:15:00.000Z
- Forward observation start: 2026-08-09T17:34:48.982760Z (= max(strategy created_at 2026-08-09T15:46:25.317519Z, first completed scan 2026-08-09T17:34:48.982760Z))
- Forward end: 2026-09-13T15:44:59.999Z; calendar days: 34.923738622685185

## 2. Production parity window

- Scans compared: 798; aggregate parity average: 99.449%; timestamp mapping: 798/798 exact, 0 mismatch (100.000%); HYPE anchor: **MATCH**.
- universe: 788/798 exact, 10 mismatch (98.747%)
- globalRegime: 798/798 exact, 0 mismatch (100.000%)
- rawCandidate: 786/798 exact, 12 mismatch (98.496%)
- rejectionStage: 786/798 exact, 12 mismatch (98.496%)
- score: 502/798 exact, 296 mismatch (62.907%)
- qualifiedCandidate: 798/798 exact, 0 mismatch (100.000%)
- claimedSignal: 798/798 exact, 0 mismatch (100.000%)
- Each scan also records exact universe order, global regime, raw symbols, rejection stages, raw scores, qualified symbols, and claimed symbols in the JSON artifact.

## 3. Forward counterfactual

- Qualified candidates: 1; final claimed replay signals: 1; Production forward signals: 1.
- Replay matured trades: 1; Production forward paper trades: 1.
- Incomplete observations: 0
- PIT violations: 0

## 4. Regime distribution and opportunity rates

- Historical OOS global regimes: {"BULL":1881,"BEAR":3024,"RANGE":3926,"UNKNOWN":0}; BEAR share: 34.243%.
- Forward global regimes: {"BULL":1072,"BEAR":671,"RANGE":1609,"UNKNOWN":0}; BEAR share: 20.018%.
- Candidate A tradeable BEAR-aligned share among score-pass candidates: 3.030%.
- Historical rates (denominator 176620 symbol-observations): raw 17.310044%, score>=80 0.187408%, BEAR-aligned 0.114936%, execution-cost eligible 0.058883%, final 0.015287%.
- Forward rates (denominator 82823 symbol-observations): raw 17.391304%, score>=80 0.358596%, BEAR-aligned 0.010867%, execution-cost eligible 0.001207%, final 0.001207%.
- Drift ratios (forward / historical): {"rawCandidateRate":1.0046944,"scorePassRate":1.91345115,"bearRegimeShare":0.58458357,"finalSignalRate":0.07898146}.
- Material opportunity-drift rule: BEAR-aligned candidate rate and final signal rate must each be at least 25% below Historical OOS; raw and score-pass rates are reported separately.

## 5. Actual Production evidence

- Completed scans: 3336; failed scans: 0; forward signals: 1; paper trades: 1; read-only notification rows: 1; newly sent real emails: 0.
- The HYPE historical SENT notification remains historical evidence; this audit did not send a notification.

## 6. Evidence and classification

- Data manifest SHA256: b6e8e2916dbc20749f383d6659d8122f2176e8af7b00e0c17ffd8702d0b4323f (sorted UTF-8 path:raw-file-SHA256 rows; no raw dataset is included).
- Missing evidence / fail-closed reasons: NONE
- Production parity: PASS; forward opportunity materially lower: true; forward regime materially lower: true.
- Classification: **MARKET_REGIME_DRIFT_CONFIRMED**.

## 7. Safety

- Production modified: NO; Supabase modified: NO; Vercel modified: NO; PAPER strategy modified: NO; strategy search: NO; private API: NO; orders: 0; AUTO_TRADING: FALSE; real emails: 0.

## 8. Verification

- Tests: 209 passed / 1 skipped (210 total); typecheck: PASS; lint: PASS; build: PASS; diff: PASS; GitHub CI: PASS (run 34770335635; verify).
