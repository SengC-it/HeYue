import { describe, expect, it } from "vitest";
import { historicalDatasetIssues } from "../lib/backtest/data-integrity";
import { runBacktest } from "../lib/backtest/engine";
import { optimizerSelectionScore } from "../lib/backtest/optimizer";
import type { BacktestMetrics, HistoricalDataset } from "../lib/backtest/types";
import { scoreCandidate } from "../lib/core/scoring";
import { DEFAULT_STRATEGY_PARAMS } from "../lib/core/strategies";
import type { Candle, Instrument, StrategyCandidate } from "../lib/core/types";

const instrument: Instrument = {
  symbol: "BTCUSDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  contractType: "PERPETUAL",
  status: "TRADING",
  priceTick: 0.01,
  quantityStep: 0.001,
  minQuantity: 0.001,
};

describe("historical data integrity", () => {
  it("detects interval gaps and invalid OHLC values", () => {
    const candles = [makeCandle(0, 100), makeCandle(2, 100)];
    candles[1].high = 99;
    const issues = historicalDatasetIssues(dataset(candles));

    expect(issues.some((issue) => issue.includes("interval"))).toBe(true);
    expect(issues.some((issue) => issue.includes("OHLCV"))).toBe(true);
  });
});

describe("realistic backtest execution", () => {
  it("enters at the next candle open and fills a gap-through stop at the worse open", () => {
    const candles = Array.from({ length: 100 }, (_, index) => makeCandle(index, 100));
    candles[81] = { ...makeCandle(81, 101), high: 102, low: 100.5 };
    candles[82] = { ...makeCandle(82, 98), high: 98.5, low: 97.5 };
    const candidate = scoreCandidate(baseCandidate());

    const result = runBacktest(dataset(candles), DEFAULT_STRATEGY_PARAMS, {
      minimumSampleDays: 0,
      minScore: 0,
      evaluationStartTime: candles[80].closeTime,
      evaluationEndTime: candles[90].closeTime,
      riskPerTradeUsdt: 50,
      maxPositionNotionalUsdt: 10_000,
      singleSignalRiskCapUsdt: 50,
      dailyRiskBudgetUsdt: 600,
      candidateCache: new Map([[80, [candidate]]]),
      entryDelayBars: 1,
      slippageBps: 2,
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].entryTime).toBe(candles[81].openTime);
    expect(result.trades[0].entryPrice).toBeGreaterThan(101);
    expect(result.trades[0].exitReason).toBe("STOP");
    expect(result.trades[0].exitPrice).toBeLessThan(98);
  });
});

describe("optimizer selection", () => {
  it("scores variants from training metrics only", () => {
    const strongerTrain = optimizerSelectionScore({
      selectionEligible: true,
      train: metrics({ netPnlUsdt: 500, maxDrawdownPercent: 5 }),
    });
    const weakerTrain = optimizerSelectionScore({
      selectionEligible: true,
      train: metrics({ netPnlUsdt: 100, maxDrawdownPercent: 5 }),
    });

    expect(strongerTrain).toBeGreaterThan(weakerTrain);
  });
});

function dataset(candles: Candle[]): HistoricalDataset {
  return {
    symbol: instrument.symbol,
    instrument,
    candles: { "15m": candles },
    fundingRates: [],
  };
}

function makeCandle(index: number, price: number): Candle {
  const openTime = index * 15 * 60 * 1000;
  return {
    openTime,
    open: price,
    high: price + 1,
    low: price - 1,
    close: price,
    volume: 100,
    closeTime: openTime + 15 * 60 * 1000 - 1,
  };
}

function baseCandidate(): StrategyCandidate {
  return {
    strategyFamily: "TREND",
    side: "LONG",
    primaryTimeframe: "15m",
    confirmationTimeframes: [],
    entryPrice: 100,
    stopReferencePrice: 99,
    atr: 1,
    scoreComponents: {
      trendAlignment: 1,
      momentum: 1,
      structure: 1,
      liquidity: 1,
      volatility: 1,
      regimeFit: 1,
      dataQuality: 1,
    },
    marketRegime: "BULL",
    regimeDependency: "LOW",
    rationale: ["test"],
  };
}

function metrics(overrides: Partial<BacktestMetrics>): BacktestMetrics {
  return {
    sampleDays: 365,
    minimumSampleDays: 365,
    trades: 100,
    wins: 50,
    losses: 50,
    winRate: 50,
    netR: 0,
    netPnlUsdt: 0,
    grossProfitUsdt: 0,
    grossLossUsdt: 0,
    totalFeesUsdt: 0,
    totalFundingUsdt: 0,
    totalSlippageUsdt: 0,
    profitFactor: 1,
    maxDrawdownPercent: 0,
    maxDrawdownUsdt: 0,
    finalEquityUsdt: 10_000,
    initialCapitalUsdt: 10_000,
    eligible: true,
    ...overrides,
  };
}
