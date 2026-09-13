import { describe, expect, it } from "vitest";
import type { ScoredCandidate } from "@/lib/core/types";
import {
  aggregateRejectionStages,
  assertAuthoritativeCandidateA,
  assertBreakoutDefaults,
  canCalculateConditionalFunnelRates,
  mergeCandidateCaches,
  passesR73FinalProfitabilityGate,
  passesR73SelectionGate,
  passesR73ThroughputGate,
  rankR73Candidates,
  R73_AUTHORITATIVE_A_OOS,
  R73_BREAKOUT_DEFAULTS,
} from "@/lib/research/r7-3";

function candidate(overrides: Partial<ScoredCandidate> = {}): ScoredCandidate {
  return {
    strategyFamily: "TREND",
    side: "SHORT",
    primaryTimeframe: "15m",
    confirmationTimeframes: ["1h", "4h"],
    entryPrice: 100,
    stopReferencePrice: 101,
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
    marketRegime: "BEAR",
    regimeDependency: "HIGH",
    rationale: ["test"],
    score: 80,
    ...overrides,
  };
}

describe("HY-R7.3 reconciliation and breakout guardrails", () => {
  it("requires the frozen breakout defaults", () => {
    expect(R73_BREAKOUT_DEFAULTS).toEqual({ breakoutPeriod: 20, breakoutVolumeRatio: 1.15 });
    expect(() => assertBreakoutDefaults(R73_BREAKOUT_DEFAULTS)).not.toThrow();
    expect(() => assertBreakoutDefaults({ breakoutPeriod: 21, breakoutVolumeRatio: 1.15 })).toThrow();
  });

  it("reproduces the authoritative R7.1A Candidate A metrics within tolerance", () => {
    expect(() => assertAuthoritativeCandidateA(
      { trades: 29, netPnlUsdt: 469.31166529, expectancyUsdt: 16.18, profitFactor: 1.59999141, maxDrawdownPercent: 0.03 },
      { trades: 29, netPnlUsdt: 400.66533784, expectancyUsdt: 13.81, profitFactor: 1.48858398, maxDrawdownPercent: 0.04 },
    )).not.toThrow();
    expect(R73_AUTHORITATIVE_A_OOS.trades).toBe(29);
    expect(() => assertAuthoritativeCandidateA(
      { trades: 31, netPnlUsdt: 516.82431928, expectancyUsdt: 16, profitFactor: 1.62010391, maxDrawdownPercent: 0.02 },
      { trades: 20, netPnlUsdt: 643.37792938, expectancyUsdt: 32, profitFactor: 2.57592303, maxDrawdownPercent: 0.03 },
    )).toThrow("BACKTEST_REPRODUCIBILITY_FAILURE");
  });

  it("keeps the 49-symbol result from overwriting Candidate A", () => {
    expect(R73_AUTHORITATIVE_A_OOS.trades).not.toBe(31);
    expect(R73_AUTHORITATIVE_A_OOS.baseNetPnlUsdt).not.toBe(516.82431928);
  });

  it("de-duplicates C2 to the higher score at one symbol/timestamp", () => {
    const merged = mergeCandidateCaches([
      new Map([[1, [candidate({ score: 82, strategyFamily: "TREND" })]]]),
      new Map([[1, [candidate({ score: 87, strategyFamily: "BREAKOUT" })]]]),
    ]);
    expect(merged.get(1)).toHaveLength(1);
    expect(merged.get(1)?.[0].score).toBe(87);
    expect(merged.get(1)?.[0].strategyFamily).toBe("BREAKOUT");
  });

  it("uses the frozen C2 tie-break without double opening", () => {
    const merged = mergeCandidateCaches([
      new Map([[1, [candidate({ score: 80, strategyFamily: "TREND" })]]]),
      new Map([[1, [candidate({ score: 80, strategyFamily: "BREAKOUT" })]]]),
    ]);
    expect(merged.get(1)).toHaveLength(1);
    expect(merged.get(1)?.[0].strategyFamily).toBe("TREND");
  });

  it("applies the profitability-first selection gate", () => {
    expect(passesR73SelectionGate(
      { trades: 10, netPnlUsdt: 1, expectancyUsdt: 0.1, profitFactor: 1.2, maxDrawdownPercent: 0.1 },
      { trades: 10, netPnlUsdt: 1, expectancyUsdt: 0.1, profitFactor: 1.05, maxDrawdownPercent: 0.1 },
      2,
    )).toBe(true);
    expect(rankR73Candidates([
      { id: "high-throughput", profitabilityEligible: false, stressProfitFactor: 3, expectancyUsdt: 100, profitFactor: 3, maxDrawdownPercent: 0.2, stabilityScore: 4, signalCount: 100, annualizedSignals: 400 },
      { id: "profitable", profitabilityEligible: true, stressProfitFactor: 1.1, expectancyUsdt: 2, profitFactor: 1.25, maxDrawdownPercent: 0.05, stabilityScore: 2, signalCount: 10, annualizedSignals: 40 },
    ]).map((row) => row.id)).toEqual(["profitable", "high-throughput"]);
  });

  it("enforces final profitability before throughput", () => {
    expect(passesR73FinalProfitabilityGate(
      { trades: 29, netPnlUsdt: 469, expectancyUsdt: 16, profitFactor: 1.59, maxDrawdownPercent: 0.04 },
      { trades: 30, netPnlUsdt: 1, expectancyUsdt: 0.03, profitFactor: 1.25, maxDrawdownPercent: 0.05 },
      { trades: 30, netPnlUsdt: 1, expectancyUsdt: 0.03, profitFactor: 1.1, maxDrawdownPercent: 0.05 },
    )).toBe(true);
    expect(passesR73ThroughputGate(28, 99, 29, 100)).toBe(false);
    expect(passesR73ThroughputGate(29, 100, 29, 100)).toBe(true);
  });

  it("aggregates mutually exclusive rejection stages", () => {
    expect(aggregateRejectionStages(["NO_RAW_CANDIDATE", "SCORE", "NO_RAW_CANDIDATE"])).toEqual([
      { rejectionStage: "NO_RAW_CANDIDATE", count: 2, sharePercent: 66.666667 },
      { rejectionStage: "SCORE", count: 1, sharePercent: 33.333333 },
    ]);
  });

  it("blocks conditional rates for non-sequential candidate counters", () => {
    const actualProductionEvidence = {
      units: {
        rawCandidates: "candidate",
        scorePass: "candidate",
        sidePass: "candidate",
        strategyFamilyPass: "candidate",
      },
      hasRowLineage: false,
    };
    expect(canCalculateConditionalFunnelRates(actualProductionEvidence)).toBe(false);
    expect(canCalculateConditionalFunnelRates({
      units: { first: "observation", second: "observation" },
      hasRowLineage: true,
    })).toBe(true);
  });
});
