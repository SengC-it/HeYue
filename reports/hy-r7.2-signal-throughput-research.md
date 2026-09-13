# HY-R7.2 Signal Throughput + Profitability Research (R7.3 reconciled)

This report preserves the R7.2 49-symbol replay as sensitivity evidence and restores R7.1A as the only authoritative Candidate A.

## Authority correction

- Authoritative Candidate A: **HY-R7-FORWARD-CANDIDATE-A**, R7.1A 20-symbol dataset; 29 OOS trades, 469.31166529 USDT, PF 1.59999141.
- Former R7.2 Candidate A: **A49_SENSITIVITY_REPLAY** only; 31 trades, 516.82431928 USDT, PF 1.62010391.
- The 49-symbol replay cannot overwrite, select, or mutate Candidate A.

## 49-symbol sensitivity funnel

| Stage | Input | Passed | Rejected |
|---|---:|---:|---:|
| symbols considered | 432719 | 432719 | 0 |
| liquidity/universe eligible | 432719 | 88310 | 344409 |
| TREND_PULLBACK condition met | 88310 | 15206 | 73104 |
| SHORT side eligible | 15206 | 7686 | 7520 |
| local regime aligned | 7686 | 4594 | 3092 |
| BTC 4h regime aligned | 4594 | 3210 | 1384 |
| score >=80 | 3210 | 205 | 3005 |
| cooldown eligible | 205 | 110 | 95 |
| execution-cost eligible | 110 | 32 | 78 |
| final signal emitted | 32 | 32 | 0 |

  The former 79.591837% universe share is **STRUCTURAL_UNIVERSE_SELECTION_SHARE**, actionable=false. It reflects top-10 selection inside a 49-symbol replay, not an actionable entry-family bottleneck.
  No further B1/B2/A49 research is authorized; B1=REJECTED, B2=REJECTED by train+validation profitability evidence.

## Production read-only rejection-stage evidence

| Rejection stage | Count | Share of symbol observations |
|---|---:|---:|
| NO_RAW_CANDIDATE | 6421 | 82.851613% |
| SCORE | 1272 | 16.412903% |
| SIDE | 48 | 0.619355% |
| EXECUTION_COST | 8 | 0.103226% |
| QUALIFIED | 1 | 0.012903% |

Counters are candidate-level and non-sequential. Conditional pass rates are not calculated; the mutually exclusive denominator is `symbol_diagnostics[].rejectionStage`. Source: `lib/core/candidate-funnel.ts:evaluateCandidateFunnel`, `recordCooldownResult`, and `addFilterFunnel`.

## Safety

Production / Supabase / Vercel / PAPER strategy modified: **NO**. Real email: **OFF**. Private API: **NO**. Orders: **0**. AUTO_TRADING: **FALSE**.

Reconciled by HY-R7.3; no historical sensitivity result was recalculated.
