import { describe, expect, it } from "vitest";
import {
  createEmptyFilterFunnel,
  evaluateCandidateFunnel,
  recordCooldownResult,
} from "../lib/core/candidate-funnel";
import { passesGlobalRegimeFilter, passesRuntimeCandidateFilter, createRuntimeStrategyPolicy } from "../lib/core/runtime-strategy";
import { rankCandidates, scoreCandidate } from "../lib/core/scoring";
import type { Instrument, MarketSnapshot, ScoredCandidate, StrategyCandidate } from "../lib/core/types";

const instrument: Instrument = {
  symbol: "BTCUSDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  contractType: "PERPETUAL",
  status: "TRADING",
  priceTick: 0.1,
  quantityStep: 0.001,
  minQuantity: 0.001,
  quoteVolume24h: 1_000_000,
  universeRank: 1,
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

describe("candidate filter funnel", () => {
  it.each([
    ["score", { scoreComponents: halfComponents() }, "SCORE"],
    ["side", { side: "LONG", marketRegime: "BULL" }, "SIDE"],
    ["family", { strategyFamily: "BREAKOUT" }, "STRATEGY_FAMILY"],
    ["local regime", { marketRegime: "RANGE" }, "LOCAL_REGIME"],
  ] as const)("records %s rejection", (_name, overrides, stage) => {
    const result = evaluateCandidateFunnel({
      snapshot: snapshot(),
      strategy,
      globalRegime: "BEAR",
      rankedCandidates: [scoredCandidate(overrides)],
    });

    expect(result.candidate).toBeNull();
    expect(result.diagnostics.rejectionStage).toBe(stage);
  });

  it("records a global-regime rejection after the local filters pass", () => {
    const result = evaluateCandidateFunnel({
      snapshot: snapshot(),
      strategy,
      globalRegime: "RANGE",
      rankedCandidates: [scoredCandidate()],
    });

    expect(result.diagnostics.localRegimePass).toBe(true);
    expect(result.diagnostics.rejectionStage).toBe("GLOBAL_REGIME");
    expect(result.counts.globalRegimePass).toBe(0);
  });

  it("records single-risk-cap and execution-cost rejections", () => {
    const riskPolicy = { ...strategy, riskPolicy: { ...strategy.riskPolicy, singleSignalRiskCapUsdt: 5, riskPerTradeUsdt: undefined } };
    const riskResult = evaluateCandidateFunnel({
      snapshot: snapshot(),
      strategy: riskPolicy,
      globalRegime: "BEAR",
      rankedCandidates: [scoredCandidate({ stopReferencePrice: 110 })],
    });
    expect(riskResult.diagnostics.rejectionStage).toBe("SINGLE_RISK_CAP");

    const costResult = evaluateCandidateFunnel({
      snapshot: snapshot(),
      strategy,
      globalRegime: "BEAR",
      rankedCandidates: [scoredCandidate({ stopReferencePrice: 100.1, atr: 0.1 })],
    });
    expect(costResult.diagnostics.rejectionStage).toBe("EXECUTION_COST");
  });

  it("records qualified candidates before cooldown and then records cooldown rejection", () => {
    const result = evaluateCandidateFunnel({
      snapshot: snapshot(),
      strategy,
      globalRegime: "BEAR",
      rankedCandidates: [scoredCandidate()],
    });
    const telemetry = createEmptyFilterFunnel();

    expect(result.diagnostics.rejectionStage).toBe("QUALIFIED");
    expect(result.diagnostics.deliveryStatus).toBe("NOT_APPLICABLE");
    expect(result.counts.preCooldownCandidate).toBe(1);
    recordCooldownResult(telemetry, result.diagnostics, false);

    expect(telemetry.cooldownPass).toBe(0);
    expect(result.diagnostics.rejectionStage).toBe("COOLDOWN");
    expect(result.diagnostics.finalStatus).toBe("REJECTED");
  });

  it("preserves the old rankedCandidates.find selection semantics", () => {
    const raw = [
      baseCandidate({ entryPrice: 100, stopReferencePrice: 105, scoreComponents: fullComponents() }),
      baseCandidate({ entryPrice: 101, stopReferencePrice: 106, scoreComponents: fullComponents(), rationale: ["lower ranked"] }),
    ];
    const ranked = rankCandidates(raw);
    const legacy = ranked.find((candidate) =>
      passesRuntimeCandidateFilter(candidate, strategy)
      && passesGlobalRegimeFilter(candidate, strategy, "BEAR"));
    const result = evaluateCandidateFunnel({
      snapshot: snapshot(),
      strategy,
      globalRegime: "BEAR",
      rankedCandidates: ranked,
    });

    expect(result.candidate?.entryPrice).toBe(legacy ? snapshot().tickerPrice : undefined);
    expect(result.candidate?.rationale).toEqual(legacy?.rationale);
  });
});

function snapshot(): MarketSnapshot {
  const candles = Array.from({ length: 80 }, (_, index) => ({
    openTime: index * 900_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
    closeTime: (index + 1) * 900_000 - 1,
  }));
  return {
    instrument,
    tickerPrice: 100,
    candles: { "15m": candles, "1h": candles, "4h": candles },
    sourceTimestamp: candles.at(-1)!.closeTime,
  };
}

function scoredCandidate(overrides: Partial<StrategyCandidate> = {}): ScoredCandidate {
  return scoreCandidate(baseCandidate(overrides));
}

function baseCandidate(overrides: Partial<StrategyCandidate> = {}): StrategyCandidate {
  return {
    strategyFamily: "TREND",
    side: "SHORT",
    primaryTimeframe: "15m",
    confirmationTimeframes: ["1h", "4h"],
    entryPrice: 100,
    stopReferencePrice: 105,
    atr: 2,
    scoreComponents: fullComponents(),
    marketRegime: "BEAR",
    regimeDependency: "HIGH",
    rationale: ["funnel fixture"],
    ...overrides,
  };
}

function fullComponents() {
  return {
    trendAlignment: 1,
    momentum: 1,
    structure: 1,
    liquidity: 1,
    volatility: 1,
    regimeFit: 1,
    dataQuality: 1,
  };
}

function halfComponents() {
  return {
    trendAlignment: 0.5,
    momentum: 0.5,
    structure: 0.5,
    liquidity: 0.5,
    volatility: 0.5,
    regimeFit: 0.5,
    dataQuality: 0.5,
  };
}
