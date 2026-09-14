# HY-R8.0 EXTENDED INDEPENDENT HOLDOUT

Classification: **PROFITABILITY_RESEARCH_INVALID**

The one-shot holdout data and Candidate A reproduction are preserved, but the result is not an authoritative edge pass/fail because the generated quarter partitions did not match the explicitly frozen protocol boundaries. No second holdout run was performed.

This is a one-shot, backward independent, research-only validation. It does not select parameters, tune thresholds, modify Production, write Supabase, deploy Vercel, send email, call a private API, or place orders.

## Frozen authority

- PR #9 remains **DRAFT** on `research/hy-r7-profitability`.
- Protocol commit: `3e28d6179d6903c24b18b304c82f492997329bba`; protocol committed before holdout: **YES**.
- Research base HEAD: `f02dc98eb48701cf9eff43f9ff91c69fc1b9888c`.
- Candidate: `HY-R7-FORWARD-CANDIDATE-A`; version `hy-paper-candidate-v2`; strategy SHA256 `3c3df714d4e5768a4393e523b331b70f239e5c07b963e5bdada7442d69a27918`.
- Frozen rules: {"entryMode":"TREND_PULLBACK","side":"SHORT","strategyFamily":"TREND","minScore":80,"cooldownHours":24,"rewardRisk":2,"maxHoldHours":48,"stopAtrMultiplier":0.75,"dynamicUniverseSize":10,"dynamicUniverseLookbackDays":1,"localRegimeAlignment":true,"btc4hRegimeAlignment":true,"globalReferenceSymbol":"BTCUSDT","globalReferenceTimeframe":"4h","baseTakerFeeRate":0.0004,"baseSlippageBps":2,"stressTakerFeeRate":0.0006,"stressSlippageBps":4,"maxExecutionCostRiskFraction":0.1,"funding":"PIT historical actual funding"}.

## Candidate A reproduction gate

- Result: **PASS**.
- Expected: {"trades":29,"baseNetPnlUsdt":469.31166529,"baseProfitFactor":1.59999141,"stressNetPnlUsdt":400.66533784,"stressProfitFactor":1.48858398}.
- Actual: {"base":{"trades":29,"wins":13,"losses":16,"winRate":0.448276,"netPnlUsdt":469.31166529,"expectancyUsdt":16.18316087,"netR":9.35404337,"profitFactor":1.59999141,"maxDrawdownUsdt":351.08433764,"maxDrawdownPercent":0.03510843,"averageWinnerUsdt":96.26992069,"averageLoserUsdt":-48.88733148,"totalFeesUsdt":68.64637257,"totalFundingUsdt":0.00330584,"totalSlippageUsdt":34.32320918,"grossPnlUsdt":537.95473202,"pricePnlBeforeExecutionCostsUsdt":572.2779412,"finalEquityUsdt":10469.31166529},"stress":{"trades":29,"wins":13,"losses":16,"winRate":0.448276,"netPnlUsdt":400.66533784,"expectancyUsdt":13.81604613,"netR":7.97917342,"profitFactor":1.48858398,"maxDrawdownUsdt":367.79493094,"maxDrawdownPercent":0.03677949,"averageWinnerUsdt":93.90150221,"averageLoserUsdt":-51.25338693,"totalFeesUsdt":102.96949018,"totalFundingUsdt":0.00330518,"totalSlippageUsdt":68.64641835,"grossPnlUsdt":503.63152285,"pricePnlBeforeExecutionCostsUsdt":572.2779412,"finalEquityUsdt":10400.66533784}}.

## Independent holdout

- Window: **2024-08-09T02:15:00.000Z through 2025-08-09T02:14:59.999Z**; label **PRE-R7 INDEPENDENT HOLDOUT**.
- Data source: Binance public historical 15m/1h/4h klines and historical funding; no private/account/order data.
- Universe: ["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","DOGEUSDT","ADAUSDT","LINKUSDT","AVAXUSDT","SUIUSDT","1000SHIBUSDT","1000PEPEUSDT","AAVEUSDT","TRXUSDT","PAXGUSDT","INJUSDT","COTIUSDT","LTCUSDT","XLMUSDT","XMRUSDT"]; listing eligibility is first actual candle plus the frozen warm-up, with no future listing knowledge.
- One-shot holdout execution count: **1**.
- Data manifest: `reports/hy-r8.0-data-manifest.json`; raw dataset committed: **NO**.

### Listing and coverage

| Symbol | First available | First eligible | Expected 15m | Actual 15m | Coverage | Status |
|---|---|---|---:|---:|---:|---|
| BTCUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |
| ETHUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |
| BNBUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |
| SOLUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |
| XRPUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |
| DOGEUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |
| ADAUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |
| LINKUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |
| AVAXUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |
| SUIUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |
| 1000SHIBUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |
| 1000PEPEUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |
| AAVEUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |
| TRXUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |
| PAXGUSDT | 2025-03-27T10:30:00.000Z | 2025-03-28T06:44:59.999Z | 35040 | 12927 | 0.36892123 | PARTIAL |
| INJUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |
| COTIUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |
| LTCUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |
| XLMUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |
| XMRUSDT | 2024-07-26T02:15:00.000Z | 2024-07-26T22:29:59.999Z | 35040 | 35040 | 1 | FULL |

### Metrics

Base uses taker fee 0.0004 and 2 bps slippage. Stress uses 0.0006 and 4 bps. Selection eligibility and signal set are unchanged between the two cost models.

| Model | All selected signals | Matured trades | Net PnL USDT | Expectancy USDT | PF | Max DD fraction |
|---|---:|---:|---:|---:|---:|---:|
| Base | 219 | 219 | 404.96613442 | 1.84916043 | 1.05536706 | 0.1408135 |
| Stress | 219 | 219 | -96.12185875 | -0.4389126 | 0.98740276 | 0.15656981 |

Max DD is stored as a fraction (0.10 = 10%). Signal rate: {"count":219,"uniqueSignalTimestamps":173,"observationDays":364.99999999,"signalsPerDay":0.6,"signalsPerWeek":4.2,"medianDaysBetweenSignals":0.16666667,"p90DaysBetweenSignals":4.490625,"p95DaysBetweenSignals":11.2671875,"annualizedSignals":219.15000001}.

### PIT and execution validation

```json
{
  "dataIntegrity": true,
  "listingEligibility": true,
  "dynamicTop10UsesClosedPITVolume": true,
  "regimeUsesClosedPITCandles": true,
  "fundingPIT": true,
  "nextBarExecution": true,
  "sameSignalSet": true,
  "quarterBoundaries": false,
  "noFutureOutcome": true,
  "noFutureVolume": true,
  "noFutureFunding": true,
  "noFutureListing": true,
  "noSameCloseFill": true,
  "dataIssues": []
}
```

Decision inputs are closed 15m/1h/4h candles through t; dynamic Top-10 ranks rolling closed 15m quote volume through t; funding is charged only for fundingTime > entryTime and <= exitTime; entry is the next 15m open; same-candle stop-first is delegated to the frozen engine.

### Fixed quarters

| Quarter | Base trades | Base net | Base PF | Stress net | Stress PF | Base positive |
|---|---:|---:|---:|---:|---:|---|
| Q1 | 33 | -1310.48044404 | 0.18107949 | -1386.34473635 | 0.16982251 | NO |
| Q2 | 60 | 556.51916392 | 1.29989466 | 426.38962563 | 1.22131166 | YES |
| Q3 | 91 | 585.97626468 | 1.20255266 | 378.28142676 | 1.12517727 | YES |
| Q4 | 35 | 572.95114986 | 1.5935592 | 485.5518252 | 1.47987048 | YES |

Positive base quarters under the non-authoritative generated partitions: **3/4**. This count is not used for a final gate because the frozen protocol boundary parity failed.

### Symbol stability and bootstrap

```json
{
  "distinctTradedSymbols": 14,
  "profitableSymbols": [
    "XRPUSDT",
    "DOGEUSDT",
    "LINKUSDT",
    "ETHUSDT",
    "LTCUSDT",
    "BTCUSDT",
    "AAVEUSDT",
    "SUIUSDT"
  ],
  "losingSymbols": [
    "AVAXUSDT",
    "1000SHIBUSDT",
    "BNBUSDT",
    "1000PEPEUSDT",
    "ADAUSDT",
    "SOLUSDT"
  ],
  "top1ProfitContribution": 1.29792646,
  "top3ProfitContribution": 2.89668231,
  "top5ProfitContribution": 4.02669345,
  "concentrationRisk": true,
  "bySymbol": [
    {
      "symbol": "XRPUSDT",
      "trades": 21,
      "netPnlUsdt": 525.61625938,
      "contribution": 1.29792646
    },
    {
      "symbol": "DOGEUSDT",
      "trades": 24,
      "netPnlUsdt": 368.5112666,
      "contribution": 0.90998045
    },
    {
      "symbol": "LINKUSDT",
      "trades": 6,
      "netPnlUsdt": 278.93071089,
      "contribution": 0.6887754
    },
    {
      "symbol": "ETHUSDT",
      "trades": 23,
      "netPnlUsdt": 229.20263075,
      "contribution": 0.56597975
    },
    {
      "symbol": "LTCUSDT",
      "trades": 7,
      "netPnlUsdt": 228.41361274,
      "contribution": 0.56403139
    },
    {
      "symbol": "BTCUSDT",
      "trades": 14,
      "netPnlUsdt": 149.97085948,
      "contribution": 0.37032938
    },
    {
      "symbol": "AAVEUSDT",
      "trades": 2,
      "netPnlUsdt": 43.73011381,
      "contribution": 0.10798462
    },
    {
      "symbol": "SUIUSDT",
      "trades": 28,
      "netPnlUsdt": 10.46765361,
      "contribution": 0.02584822
    },
    {
      "symbol": "AVAXUSDT",
      "trades": 3,
      "netPnlUsdt": -12.08322394,
      "contribution": -0.02983762
    },
    {
      "symbol": "1000SHIBUSDT",
      "trades": 3,
      "netPnlUsdt": -161.60784523,
      "contribution": -0.39906509
    },
    {
      "symbol": "BNBUSDT",
      "trades": 6,
      "netPnlUsdt": -174.47756237,
      "contribution": -0.43084482
    },
    {
      "symbol": "1000PEPEUSDT",
      "trades": 34,
      "netPnlUsdt": -313.08327045,
      "contribution": -0.77310976
    },
    {
      "symbol": "ADAUSDT",
      "trades": 18,
      "netPnlUsdt": -361.35812042,
      "contribution": -0.89231689
    },
    {
      "symbol": "SOLUSDT",
      "trades": 30,
      "netPnlUsdt": -407.26695042,
      "contribution": -1.0056815
    }
  ]
}
```

Bootstrap is fixed at 10,000 resamples with seed 8052024, resampling matured trade net PnL with replacement:

```json
{
  "expectancyUsdt": {
    "sampleCount": 219,
    "iterations": 10000,
    "seed": 8052024,
    "p025": -7.67205044,
    "median": 1.81405285,
    "p975": 11.6376351
  },
  "profitFactor": {
    "sampleCount": 219,
    "iterations": 10000,
    "seed": 8052024,
    "p025": 0.79119777,
    "median": 1.05448767,
    "p975": 1.38819843
  },
  "probabilityExpectancyPositive": 0.6452,
  "probabilityProfitFactorGreaterThanOne": 0.6452,
  "probabilityProfitFactorAtLeastOnePointTwo": 0.1758
}
```

Edge gate: ```json
{
  "maturedTradesPass": true,
  "netPnlPass": true,
  "expectancyPass": true,
  "profitFactorPass": false,
  "stressNetPass": false,
  "stressProfitFactorPass": false,
  "maxDrawdownPass": false,
  "positiveQuartersPass": true,
  "symbolBreadthPass": true,
  "bootstrapExpectancyPass": false,
  "pass": false
}
```

### Window comparison

| Window | Trades | Trades/week | Expectancy | PF | Max DD fraction | BEAR share | RANGE share |
|---|---:|---:|---:|---:|---:|---:|---:|
| A_PRE_R7_INDEPENDENT_HOLDOUT | 219 | 4.2 | 1.84916043 | 1.05536706 | 0.1408135 | 0.19153722 | 0.42862163 |
| B_ORIGINAL_R7_HISTORICAL | 216 | 4.14246575 | 6.61851291 | 1.21114746 | 0.09241423 | 0.31505748 | 0.4243282 |
| C_PRODUCTION_FORWARD | 1 | 0.20043673 | 95.31484745 | 999 | 0 | 0.20017899761336516 | 0.48001193317422436 |

Window C is the existing R7.4 Production Forward post-hoc artifact and is not a selection input.

## Protocol and future-label audit

- Protocol quarter-boundary parity: **FAIL**; the exact mismatch is recorded in `reports/hy-r8.0-independent-holdout.json`.
- Future-outcome negative evidence: **NONE** in the R8 runner/module/tests; no future-label builder was called.
- Candidate final status: **INSUFFICIENT_EVIDENCE**. Candidate A is not promoted to a stable historical edge conclusion from this invalid result.

## Failure-set isolation

```json
{
  "rows": 37,
  "retained": 0,
  "suppressed": 37,
  "usedForSelection": false,
  "rowCount": 37,
  "uniqueNotificationIds": 37,
  "uniqueSignalIds": 37,
  "role": "audit-only historical failure set; not a selection, holdout, threshold, or symbol input"
}
```

The frozen 37-row historical email failure set was read only after the holdout result was frozen and was not used for symbols, thresholds, tuning, selection, or the gate.

## Verification and safety

- Tests: **PASS (231 passed, 1 skipped of 232)**; typecheck: **PASS**; lint: **PASS**; build: **PASS**; diff: **PASS**; GitHub CI: **PASS**.
- Production modified: **NO**; Supabase modified: **NO**; Vercel modified: **NO**; PAPER strategy modified: **NO**.
- Real emails: **0**; private API: **NO**; orders: **0**; AUTO_TRADING: **FALSE**.
