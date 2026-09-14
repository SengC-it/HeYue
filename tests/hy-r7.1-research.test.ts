import { describe, expect, it } from "vitest";
import type { BacktestTrade } from "@/lib/backtest/types";
import {
  R71_B4_FROZEN_THRESHOLDS,
  R71_HYPOTHESIS_IDS,
  R71_OLD_FAILURE_SET,
  OosRunGuard,
  applyPITEpisodeFilters,
  calculateExpectedValue,
  calculateMfeMae,
  calculateProfitFactor,
  calculateResearchMetrics,
  isPITNextBarExecution,
  sourceTimeForEntry,
  assertPreRegisteredHypotheses,
} from "@/lib/research/r7-1";

function trade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    symbol: "BTCUSDT",
    side: "SHORT",
    strategyFamily: "TREND",
    entryTime: 1_000,
    exitTime: 2_000,
    score: 80,
    entryPrice: 100,
    exitPrice: 99,
    rMultiple: 1,
    pnlUsdt: 10,
    grossPnlUsdt: 12,
    feesUsdt: 1,
    fundingUsdt: -0.5,
    slippageUsdt: 0.5,
    theoreticalRiskUsdt: 10,
    exitReason: "TAKE_PROFIT",
    ...overrides,
  };
}

describe("HY-R7.1 research guardrails", () => {
  it("requires a closed-signal next-bar fill and rejects same-close execution", () => {
    expect(isPITNextBarExecution(1_000, 1_000 + 15 * 60 * 1000)).toBe(true);
    expect(isPITNextBarExecution(1_000, 1_000)).toBe(false);
    expect(sourceTimeForEntry(1_000 + 15 * 60 * 1000)).toBe(1_000);
  });

  it("keeps cost components reconcilable", () => {
    const metrics = calculateResearchMetrics([trade({ pnlUsdt: 10, grossPnlUsdt: 12, feesUsdt: 1, fundingUsdt: -0.5, slippageUsdt: 0.5 })]);
    expect(metrics.netPnlUsdt).toBe(10);
    expect(metrics.pricePnlBeforeExecutionCostsUsdt).toBe(12.5);
    expect(metrics.totalFeesUsdt + metrics.totalSlippageUsdt).toBe(1.5);
  });

  it("does not allow a second final-OOS execution", () => {
    const guard = new OosRunGuard();
    expect(guard.run(() => "once")).toBe("once");
    expect(() => guard.run(() => "twice")).toThrow("one-shot");
    expect(guard.runCount).toBe(1);
  });

  it("freezes the six hypothesis registry", () => {
    assertPreRegisteredHypotheses();
    expect(R71_HYPOTHESIS_IDS).toHaveLength(6);
    expect(() => assertPreRegisteredHypotheses([...R71_HYPOTHESIS_IDS, "H6"])).toThrow();
  });

  it("freezes B4 thresholds without optimizing them", () => {
    expect(R71_B4_FROZEN_THRESHOLDS.lowerPercentile).toBe(0.25);
    expect(R71_B4_FROZEN_THRESHOLDS.upperPercentile).toBe(0.75);
    expect(R71_B4_FROZEN_THRESHOLDS.bullish).toContain("0.25");
    expect(R71_B4_FROZEN_THRESHOLDS.bearish).toContain("0.75");
  });

  it("keeps the old failure set immutable and audit-only", () => {
    expect(R71_OLD_FAILURE_SET.count).toBe(37);
    expect(R71_OLD_FAILURE_SET.netPnlUsdt).toBe(-372.87426925);
    expect(Object.isFrozen(R71_OLD_FAILURE_SET)).toBe(true);
  });

  it("applies same-symbol cooldown using the decision timestamp", () => {
    const result = applyPITEpisodeFilters([
      { trade: trade({ entryTime: 100_000, exitTime: 110_000 }), sourceTime: 85_000 },
      { trade: trade({ entryTime: 100_000 + 8 * 60 * 60 * 1000, exitTime: 100_000 + 8 * 60 * 60 * 1000 + 1_000 }), sourceTime: 85_000 + 8 * 60 * 60 * 1000 },
    ], { sameSymbolCooldownHours: 12 });
    expect(result.trades).toHaveLength(1);
    expect(result.suppressedByCooldown).toBe(1);
  });

  it("applies post-stop-loss lockout only after the stop is known", () => {
    const result = applyPITEpisodeFilters([
      { trade: trade({ entryTime: 100_000, exitTime: 110_000, exitReason: "STOP" }), sourceTime: 85_000 },
      { trade: trade({ entryTime: 110_000 + 2 * 60 * 60 * 1000, exitTime: 120_000 + 2 * 60 * 60 * 1000 }), sourceTime: 110_000 + 2 * 60 * 60 * 1000 - 15_000 },
      { trade: trade({ entryTime: 110_000 + 50 * 60 * 60 * 1000, exitTime: 120_000 + 50 * 60 * 60 * 1000 }), sourceTime: 110_000 + 50 * 60 * 60 * 1000 - 15_000 },
    ], { postStopLossLockoutHours: 24 });
    expect(result.trades).toHaveLength(2);
    expect(result.suppressedByPostStopLossLockout).toBe(1);
  });

  it("reconciles EV, PF and drawdown", () => {
    const trades = [
      trade({ pnlUsdt: 20, rMultiple: 2, exitTime: 2_000 }),
      trade({ pnlUsdt: -10, rMultiple: -1, exitTime: 3_000 }),
    ];
    const metrics = calculateResearchMetrics(trades);
    const ev = calculateExpectedValue(trades);
    expect(calculateProfitFactor([20], [-10])).toBe(2);
    expect(metrics.expectancyUsdt).toBe(5);
    expect(ev.evUsdt).toBe(5);
    expect(metrics.maxDrawdownUsdt).toBe(10);
  });

  it("calculates directional MFE and MAE from the eligible path only", () => {
    const candles = [
      { openTime: 1_000, open: 100, high: 105, low: 98, close: 101, volume: 1, closeTime: 1_899 },
      { openTime: 1_900, open: 101, high: 104, low: 99, close: 100, volume: 1, closeTime: 2_799 },
    ];
    const result = calculateMfeMae(candles, trade({ side: "LONG", entryTime: 1_000, exitTime: 2_799, entryPrice: 100 }));
    expect(result?.favorableMove).toBeCloseTo(0.05, 10);
    expect(result?.adverseMove).toBeCloseTo(-0.02, 10);
  });
});
