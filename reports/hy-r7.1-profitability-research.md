# HY-R7.1 Profitability Research + Candidate Selection

Classification: **NO_PROFITABLE_CANDIDATE**

## Scope and safety

This is a research-only, frozen-rule backtest. No Production, Supabase, Vercel, PAPER strategy, email, private API, order, or AUTO_TRADING state was changed. `AUTO_TRADING=false`.

The 37 SENT emails from 2026-08-12 through 2026-08-23 are a frozen known-failure audit set. They are not used for parameter selection or FINAL OOS.

## Data and PIT contract

- Window: 2025-08-09T02:15:00.000Z to 2026-08-09T02:14:59.999Z; 20 fixed symbols from the authoritative baseline cache.
- Train: through 2026-02-07T02:15:00.000Z; validation: 2026-02-09T02:15:00.000Z to 2026-05-07T02:15:00.000Z; final OOS: 2026-05-09T02:15:00.000Z onward.
- Signal uses a closed 15m candle; execution is the next 15m open with adverse slippage. Same-close fills are rejected.
- Funding, liquidity, dynamic top-10 membership, and BTC regime are point-in-time. A 48h embargo protects split boundaries.

## Cost models

- BASE_REALISTIC: 4.0 bps taker fee, 2 bps slippage.
- STRESS: 6.0 bps taker fee, 4 bps slippage.
- Every baseline and candidate uses both models; stress reprices the same eligibility rules.

## Frozen baselines

- Optimized baseline full window: 216.00000000 trades, 1429.59878804U; final OOS: 29.00000000 trades, 469.31166529U, PF 1.59999141; stress 400.66533784U, PF 1.48858398.
- Authoritative independent-quarter sum: 216 trades; details and stress fold totals are in JSON.
- Corrected previous baseline: score75-cooldown8-rr2.5-h72; its full/train/validation/OOS metrics are in the JSON artifact.

The reproduced optimized baseline is 216 full-window trades and 29 final-OOS trades under the existing authoritative 20-symbol setup; the OOS sample is below the 100-trade readiness gate.

## Pre-registered hypotheses

H0 is the frozen baseline. H1 tests source-timestamp same-symbol cooldowns of 12h/24h/48h. H2 tests 24h/48h lockout after a known same-direction stop. H3 is the frozen B4 veto. H4 adds PIT BTC 1h confirmation. H5 combines H1 and H3. No seventh hypothesis or post-OOS parameter was added.

| Hypothesis | Variant | Status | Train+validation gate | OOS |
|---|---|---|---|---|
| H0 | score80-cooldown24-rr2-h48 | VALID | FAIL | NOT RUN BEFORE SELECTION |
| H1 | h1-source-cooldown-12h | VALID | FAIL | NOT RUN BEFORE SELECTION |
| H1 | h1-source-cooldown-24h | VALID | FAIL | NOT RUN BEFORE SELECTION |
| H1 | h1-source-cooldown-48h | VALID | FAIL | NOT RUN BEFORE SELECTION |
| H2 | h2-post-stop-lockout-24h | VALID | FAIL | NOT RUN BEFORE SELECTION |
| H2 | h2-post-stop-lockout-48h | VALID | FAIL | NOT RUN BEFORE SELECTION |
| H3 | h3-b4-opposing-reversal-veto | INVALID | N/A | N/A |
| H4 | h4-btc-1h-regime-confirmation | VALID | FAIL | NOT RUN BEFORE SELECTION |
| H5 | h5-cooldown-plus-b4-veto | INVALID | N/A | N/A |

H3 and H5 are INVALID rather than approximated because the local R7.1 input has no PIT-safe historical B4 feature series. The frozen B4 thresholds remain 0.25/0.75 and B4 is only a veto/risk filter, never an entry signal.

## Candidate selection

- Historical eligible candidates: NONE
- Primary: NONE
- Backup: NONE
- Candidate OOS executions after selection: 0; baseline OOS executions: 1.
- Final classification: **NO_PROFITABLE_CANDIDATE**. No email enablement is implied by a positive historical result.

## Old email failure attribution (audit only)

- Frozen rows: 37; mapped signal/paper-trade rows: 37.
- Net PnL: -372.87426925U; gross after slippage: -278.64303527U; fees 53.72452475U; slippage 26.86225227U; funding -40.50670923U.
- Would send under the declared partial frozen-baseline subset: 0; would suppress: 37; retained PnL: 0U.
- MFE/MAE coverage: 0/37; missing symbols remain NOT_AVAILABLE and were not downloaded or inferred.
- Dimensions included: strategy version, side, score band, symbol repetition, regime, UTC timing, stop distance, holding duration, MFE/MAE coverage, exit reason, and cost contribution.

## Artifacts and verification

- `reports/hy-r7.1-profitability-research.json` — machine-readable evidence.
- `reports/hy-r7.1-profitability-research.md` — human-readable report.
- `reports/hy-r7.1-old-email-failure-ledger.csv` — all 37 frozen old email rows.
- `lib/research/r7-1.ts` and `tests/hy-r7.1-research.test.ts` — pure research guardrails and tests.
- Verification commands were run before final artifact generation: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`; `git diff --check` was run after generation. GitHub CI was not run because no commit was created.

STOP — waiting for acceptance.
