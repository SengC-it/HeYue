import { describe, expect, it } from "vitest";
import { evaluateHistoricalTrade, snapshotAt } from "../lib/backtest/engine";
import { runProductionParityBacktest } from "../lib/backtest/production-parity";
import { evaluateCandidateFunnel } from "../lib/core/candidate-funnel";
import { createRuntimeStrategyPolicy } from "../lib/core/runtime-strategy";
import { scoreCandidate } from "../lib/core/scoring";
import type { HistoricalDataset } from "../lib/backtest/types";
import type { Candle, Instrument, MarketSnapshot, ScoredCandidate, StrategyCandidate } from "../lib/core/types";

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const instrument: Instrument = {
  symbol: "BTCUSDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  contractType: "PERPETUAL",
  status: "TRADING",
  priceTick: 0.1,
  quantityStep: 0.001,
  minQuantity: 0.001,
};

const strategy = createRuntimeStrategyPolicy({
  version: "hy-paper-candidate-v2",
  entryMode: "TREND_PULLBACK",
  stopAtrMultiplier: 0.75,
  minScore: 80,
  sideFilter: "SHORT",
  strategyFamily: "TREND",
  requireRegimeAlignment: true,
  riskPolicy: {
    marginUsdt: 100,
    leverage: 20,
    singleSignalRiskCapUsdt: 50,
    dailyRiskBudgetUsdt: 600,
    maxHoldHours: 48,
    rewardRisk: 2,
    riskPerTradeUsdt: 50,
    maxPositionNotionalUsdt: 10_000,
  },
  cooldownHours: 24,
  maxExecutionCostRiskFraction: 0.1,
  takerFeeRate: 0.0004,
  slippageBps: 2,
  globalRegimeAlignment: true,
  globalReferenceSymbol: "BTCUSDT",
  globalReferenceTimeframe: "4h",
});

describe("production parity execution pricing", () => {
  it("reprices the parity TradePlan from the next 15m open", () => {
    const dataset = datasetWithGap();
    const snapshot = snapshotAt(dataset, 80);
    const entryOpen = dataset.candles["15m"][81].open;
    const entryOpenTime = dataset.candles["15m"][81].openTime;
    const result = evaluateParity(snapshot, entryOpen);

    expect(result.diagnostics.rejectionStage).toBe("QUALIFIED");
    expect(result.candidate).toMatchObject({
      entryPrice: 105,
      score: 100,
      side: "SHORT",
      strategyFamily: "TREND",
      marketRegime: "BEAR",
    });
    expect(result.plan).toMatchObject({
      entryPrice: 105,
      stopPrice: 110,
      takeProfitPrice: 95,
    });
    expect(result.plan?.validUntil).toBe(snapshot.sourceTimestamp + 48 * HOUR);
    expect(entryOpenTime - snapshot.sourceTimestamp).toBe(1);
  });

  it("recalculates fixed-risk quantity from the next-open risk distance", () => {
    const dataset = datasetWithGap();
    const snapshot = snapshotAt(dataset, 80);
    const closeBased = evaluateParity(snapshot);
    const nextOpenBased = evaluateParity(snapshot, 105);

    expect(closeBased.plan?.entryPrice).toBe(100);
    expect(closeBased.plan?.quantity).toBe(5);
    expect(nextOpenBased.plan?.entryPrice).toBe(105);
    expect(nextOpenBased.plan?.quantity).toBe(10);
    expect(closeBased.plan?.theoreticalRiskUsdt).toBeCloseTo(50, 8);
    expect(nextOpenBased.plan?.theoreticalRiskUsdt).toBeCloseTo(50, 8);
  });

  it("applies the execution-cost gate to the next-open plan", () => {
    const dataset = datasetWithGap();
    const snapshot = snapshotAt(dataset, 80);
    const costPolicy = { ...strategy, maxExecutionCostRiskFraction: 0.02 };
    const closeBased = evaluateParity(snapshot, undefined, costPolicy);
    const nextOpenBased = evaluateParity(snapshot, 105, costPolicy);

    expect(closeBased.diagnostics.rejectionStage).toBe("QUALIFIED");
    expect(nextOpenBased.diagnostics.rejectionStage).toBe("EXECUTION_COST");
    expect(nextOpenBased.plan?.entryPrice).toBe(105);
  });

  it("uses the same next-open plan for TP, SL, quantity, and historical PnL", () => {
    const dataset = datasetWithGap();
    const snapshot = snapshotAt(dataset, 80);
    const evaluation = evaluateParity(snapshot, dataset.candles["15m"][81].open);
    const trade = evaluateHistoricalTrade(dataset, 81, evaluation.candidate!, evaluation.plan!, {
      maxHoldHours: strategy.riskPolicy.maxHoldHours,
      takerFeeRate: strategy.takerFeeRate,
      slippageBps: strategy.slippageBps,
      evaluationEndTime: dataset.candles["15m"][82].closeTime,
    });

    expect(evaluation.plan).toMatchObject({
      entryPrice: 105,
      stopPrice: 110,
      takeProfitPrice: 95,
      quantity: 10,
    });
    expect(trade).not.toBeNull();
    expect(trade?.exitReason).toBe("TAKE_PROFIT");
    expect(trade?.theoreticalRiskUsdt).toBe(evaluation.plan?.theoreticalRiskUsdt);
    expect(trade?.entryPrice).toBeCloseTo(105 * (1 - 0.0002), 8);
    expect(trade?.exitPrice).toBeCloseTo(95 * (1 + 0.0002), 8);
  });

  it("wires the next-open plan through the production parity runner", () => {
    const dataset = datasetWithGap();
    const snapshot = snapshotAt(dataset, 80);
    const result = runProductionParityBacktest([dataset], {
      policy: { ...strategy, globalRegimeAlignment: false },
      candidateCaches: [new Map([[80, [scoredCandidate()]]])],
      evaluationStartTime: snapshot.sourceTimestamp,
      evaluationEndTime: dataset.candles["15m"][82].closeTime,
      emailObservationEnabled: false,
    });

    expect(result.counts.qualifiedCandidateCount).toBe(1);
    expect(result.counts.claimedSignalCount).toBe(1);
    expect(result.counts.paperTradeCount).toBe(1);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe("TAKE_PROFIT");
    expect(result.trades[0].theoreticalRiskUsdt).toBeCloseTo(50, 8);
    expect(result.trades[0].entryPrice).toBeCloseTo(105 * (1 - 0.0002), 8);
  });

  it("does not use next-candle high, low, or close for candidate information", () => {
    const original = datasetWithGap();
    const changedFuture = datasetWithGap({ high: 1_000, low: 1, close: 500 });
    const originalSnapshot = snapshotAt(original, 80);
    const changedSnapshot = snapshotAt(changedFuture, 80);

    expect(changedSnapshot).toEqual(originalSnapshot);

    const originalEvaluation = evaluateParity(originalSnapshot, 105);
    const changedEvaluation = evaluateParity(changedSnapshot, 105);
    expect(changedEvaluation.candidate).toEqual(originalEvaluation.candidate);
    expect(changedEvaluation.plan).toEqual(originalEvaluation.plan);
  });
});

function evaluateParity(
  snapshot: MarketSnapshot,
  executionPrice?: number,
  policy = strategy,
) {
  return evaluateCandidateFunnel({
    snapshot,
    strategy: policy,
    globalRegime: "BEAR",
    rankedCandidates: [scoredCandidate()],
    executionPrice,
  });
}

function datasetWithGap(futureOverrides: Partial<Candle> = {}): HistoricalDataset {
  const candles = Array.from({ length: 83 }, (_, index) => makeCandle(index, 100));
  candles[81] = {
    ...makeCandle(81, 105),
    open: 105,
    high: 106,
    low: 104,
    close: 105,
  };
  candles[82] = {
    ...makeCandle(82, 105),
    high: 106,
    low: 94,
    close: 100,
    ...futureOverrides,
  };
  return {
    symbol: instrument.symbol,
    instrument,
    candles: { "15m": candles },
    fundingRates: [],
  };
}

function makeCandle(index: number, price: number): Candle {
  const openTime = index * FIFTEEN_MINUTES;
  return {
    openTime,
    open: price,
    high: price + 1,
    low: price - 1,
    close: price,
    volume: 100,
    closeTime: openTime + FIFTEEN_MINUTES - 1,
  };
}

function scoredCandidate(): ScoredCandidate {
  const candidate: StrategyCandidate = {
    strategyFamily: "TREND",
    side: "SHORT",
    primaryTimeframe: "15m",
    confirmationTimeframes: ["1h", "4h"],
    entryPrice: 100,
    stopReferencePrice: 110,
    atr: 2,
    scoreComponents: {
      trendAlignment: 1,
      momentum: 1,
      structure: 1,
      liquidity: 1,
      volatility: 1,
      regimeFit: 1,
      dataQuality: 1,
    },
    marketRegime: "BEAR",
    regimeDependency: "HIGH",
    rationale: ["gap execution fixture"],
  };
  return scoreCandidate(candidate);
}
