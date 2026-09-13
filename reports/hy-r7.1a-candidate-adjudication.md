# HY-R7.1A Evidence Freeze + Forward Candidate Adjudication

Classification: **FORWARD_VALIDATION_CANDIDATE_READY**

## Decision

H0 is frozen as a forward-validation candidate under the explicit R7.1A special ruling. This does not mean `PROFITABLE_STRATEGY_CONFIRMED`; real email remains OFF until the independent forward gate passes.

- Candidate: **HY-R7-FORWARD-CANDIDATE-A**
- Source strategy: `hy-paper-candidate-v2`
- Historical final OOS: 29 trades; base net 469.31166529 USDT; base PF 1.59999141; stress net 400.66533784 USDT; stress PF 1.48858398.
- Current forward evidence: 1 matured trade(s); net 95.36074897 USDT; PF UNDEFINED (zero losses).
- Forward gate: OPEN_INSUFFICIENT_SAMPLE; 34.95271281 calendar day(s) observed and 1 matured trade(s) against 30 days + 100 trades.

## Frozen authoritative facts

| Evidence | Value |
|---|---:|
| Old SENT failure rows | 37 |
| Old failure net PnL | -372.87426925 USDT |
| Old failure PF | 0.656914905250825 |
| Historical final OOS trades | 29 |
| Historical final OOS base net / PF | 469.31166529 / 1.59999141 |
| Historical final OOS stress net / PF | 400.66533784 / 1.48858398 |
| Historical rolling stress | 216 trades; 934.14588272 USDT; PF 1.1320718; 3/4 positive folds |
| Current forward matured PAPER trades | 1 |
| Current forward net PnL | 95.36074897 USDT |

## H0 special ruling

- Historical OOS criteria: **PASS FOR FORWARD CANDIDATE**.
- Base OOS: net 469.31166529, expectancy 16.18316087, PF 1.59999141, DD 0.03510843.
- Stress OOS: net 400.66533784, expectancy 13.81604613, PF 1.48858398, DD 0.03677949.
- Rolling folds: base 3 positive / 1 negative; stress 3 positive / 1 negative.
- Top-1 / top-3 concentration from the frozen selection artifact: 0.52714702 / 1.0660976.
- Legacy train+validation gate: **FAIL**; it remains unchanged and is disclosed rather than retuned.
- The special ruling is applied because the final OOS and stress evidence meet the explicitly supplied H0 thresholds and the dominant unresolved blocker is forward evidence size. This is a candidate freeze, not a profitability confirmation.

## Unified H0–H5 adjudication

For H1/H2/H4, the PnL/expectancy/PF fields below are the frozen train+validation selection metrics; final OOS was intentionally not run before selection. H0 uses its already-authoritative final OOS metrics.

| Hypothesis | Status | Train | Validation | Final OOS | Base net / exp / PF | Stress net / exp / PF | DD base / stress | Positive folds base / stress | Top-1 / Top-3 | Gate result |
|---|---|---:|---:|---:|---|---|---|---|---|---|
| H0 · score80-cooldown24-rr2-h48 | FORWARD_VALIDATION_CANDIDATE | 165 | 21 | 29 | 469.31166529 / 16.18316087 / 1.59999141 | 400.66533784 / 13.81604613 / 1.48858398 | 0.03510843 / 0.03677949 | 3 / 3 | 0.52714702 / 1.0660976 | SPECIAL_RULING_PASS_FOR_FORWARD_CANDIDATE |
| H1 · h1-source-cooldown-12h | REJECTED | 196 | 23 | NOT RUN | 268.23469963 / 1.22481598 / 1.03665197 | -227.04165981 / -1.03671991 / 0.97026631 | 0.13972601 / 0.15458349 | 1 / 1 | 1.15780224 / 3.16044765 | REJECTED |
| H1 · h1-source-cooldown-24h | REJECTED | 175 | 21 | NOT RUN | 632.7421047 / 3.22827604 / 1.09866506 | 187.1608382 / 0.95490224 / 1.0279577 | 0.11852914 / 0.1317757 | 1 / 1 | 0.69399073 / 1.53037045 | REJECTED |
| H1 · h1-source-cooldown-48h | REJECTED | 147 | 20 | NOT RUN | 632.05996254 / 3.78479019 / 1.11689309 | 242.53693285 / 1.45231696 / 1.04291994 | 0.08302355 / 0.09352889 | 1 / 1 | 0.46866745 / 1.12117347 | REJECTED |
| H2 · h2-post-stop-lockout-24h | REJECTED | 168 | 21 | NOT RUN | 256.84817164 / 1.35898504 / 1.04073928 | -173.25025969 / -0.91666804 / 0.9736717 | 0.11738935 / 0.12988038 | 1 / 1 | 1.70963706 / 3.79764796 | REJECTED |
| H2 · h2-post-stop-lockout-48h | REJECTED | 154 | 21 | NOT RUN | 401.38897526 / 2.29365129 / 1.06951328 | 1.80715911 / 0.01032662 / 1.00029975 | 0.10233015 / 0.11813286 | 1 / 1 | 0.90198472 / 2.29982502 | REJECTED |
| H3 · h3-b4-opposing-reversal-veto | INVALID_INSUFFICIENT_PIT_DATA | N/A | N/A | NOT RUN | N/A / N/A / N/A | N/A / N/A / N/A | N/A | N/A | N/A / N/A | INVALID_INSUFFICIENT_PIT_DATA |
| H4 · h4-btc-1h-regime-confirmation | REJECTED | 161 | 19 | NOT RUN | 253.13549279 / 1.40630829 / 1.04207241 | -161.88082887 / -0.89933794 / 0.97423018 | 0.12609159 / 0.14216798 | 1 / 1 | 2.16371977 / 4.40566498 | REJECTED |
| H5 · h5-cooldown-plus-b4-veto | INVALID_INSUFFICIENT_PIT_DATA | N/A | N/A | NOT RUN | N/A / N/A / N/A | N/A / N/A / N/A | N/A | N/A | N/A / N/A | INVALID_INSUFFICIENT_PIT_DATA |

### Exact adjudication reasons

- **H0 score80-cooldown24-rr2-h48** — FORWARD_VALIDATION_CANDIDATE: NONE; forward gate remains open because the final-OOS sample is below 100 matured trades.
- **H1 h1-source-cooldown-12h** — REJECTED: Pre-registered train+validation gate failed: base PF 1.03665197 < 1.20; stress net PnL -227.04165981 <= 0; stress PF 0.97026631 < 1.05; positive base folds 1 < 2. No OOS run and no post-result tuning.
- **H1 h1-source-cooldown-24h** — REJECTED: Pre-registered train+validation gate failed: base PF 1.09866506 < 1.20; stress PF 1.0279577 < 1.05; positive base folds 1 < 2. No OOS run and no post-result tuning.
- **H1 h1-source-cooldown-48h** — REJECTED: Pre-registered train+validation gate failed: base PF 1.11689309 < 1.20; stress PF 1.04291994 < 1.05; positive base folds 1 < 2. No OOS run and no post-result tuning.
- **H2 h2-post-stop-lockout-24h** — REJECTED: Pre-registered train+validation gate failed: base PF 1.04073928 < 1.20; stress net PnL -173.25025969 <= 0; stress PF 0.9736717 < 1.05; positive base folds 1 < 2. No OOS run and no post-result tuning.
- **H2 h2-post-stop-lockout-48h** — REJECTED: Pre-registered train+validation gate failed: base PF 1.06951328 < 1.20; stress PF 1.00029975 < 1.05; positive base folds 1 < 2. No OOS run and no post-result tuning.
- **H3 h3-b4-opposing-reversal-veto** — INVALID_INSUFFICIENT_PIT_DATA: No PIT-safe historical B4 feature series is present in the local R7.1 research input
- **H4 h4-btc-1h-regime-confirmation** — REJECTED: Pre-registered train+validation gate failed: base PF 1.04207241 < 1.20; stress net PnL -161.88082887 <= 0; stress PF 0.97423018 < 1.05; positive base folds 1 < 2. No OOS run and no post-result tuning.
- **H5 h5-cooldown-plus-b4-veto** — INVALID_INSUFFICIENT_PIT_DATA: H5 depends on the unavailable PIT-safe historical B4 feature series

## Forward candidate freeze

- Candidate ID: `HY-R7-FORWARD-CANDIDATE-A`
- Strategy SHA256: `3c3df714d4e5768a4393e523b331b70f239e5c07b963e5bdada7442d69a27918`
- Historical evidence SHA256: `b90c267d023d3e5999403dc6a42682e48dcb1c2cb9e8617db9118ed1cb1044a6`
- Failure-set SHA256: `a296fea0422c0b9be8fe9116f808a59f9428404211bb3747b4b3e54a6cc5a41d`
- Research commit SHA: `3abc82435eab8c832a89017cf1f0c4799b794b5d`
- Locked until the forward gate passes or the candidate is formally failed.
- Prohibited changes during the lock: score, cooldown, rewardRisk, maxHold, stop multiplier, side filter, regime filter.

### Forward gate

- Minimum: 30 calendar days AND 100 matured PAPER trades.
- Observed: 34.95271281 days and 1 matured trades.
- Economic snapshot: net 95.36074897 USDT; expectancy 95.36074897; total R 1.90725694; max DD 0.
- PF: UNDEFINED_NO_LOSSES; not claimed as a finite PF; no finite PF is claimed when there are zero losses.
- Early kill: NOT TRIGGERED (requires at least 30 matured trades plus all three negative conditions).
- Real email: OFF. PAPER evidence may continue; no real trade-action email is authorized by this packet.

## Old failure-set audit only

- Rows: 37; unique signal IDs: 37; all SENT: true.
- Retained: 0; suppressed: 37.
- Retained winners / losers: 0 / 0.
- Suppressed winners / losers: 12 / 25.
- Retained PnL: 0 USDT.
- Reason: BASE_RULES for all 37 rows under the declared partial frozen-baseline audit subset.
- This is AUDIT ONLY and was not used for threshold selection, parameter ranking, or candidate selection.

## Reproducibility and source evidence

The adjudication generator reads the frozen R7.1 JSON, the exact 37-row CSV export, and the read-only Production PAPER evidence snapshot. It performs no data download, backtest, threshold search, database write, deployment, or email operation.

- Failure-set representation: canonical CSV text with CRLF/CR normalized to LF, UTF-8 encoded.
- Historical evidence representation: canonical JSON with recursively sorted object keys.
- Strategy representation: canonical JSON of {version, strategyFamily, parameters} with recursively sorted object keys.
- Production evidence representation: canonical JSON with recursively sorted object keys.

Source files committed for regeneration:

- `scripts/run-hy-r7-1a-candidate-adjudication.ts`
- `lib/research/r7-1a.ts`
- `tests/hy-r7.1a-adjudication.test.ts`
- `reports/hy-r7.1-profitability-research.json`
- `reports/hy-r7.1-profitability-research.md`
- `reports/hy-r7.1-old-email-failure-ledger.csv`
- `reports/hy-r7.1a-production-evidence.json`

## Safety

Production, Supabase, Vercel, PAPER strategy, real email, private API, and orders were not modified or invoked. `AUTO_TRADING=false`.

STOP — waiting for ChatGPT final acceptance.
