import { describe, expect, it } from "vitest";
import {
  applyR75SharedCooldown,
  assertCandidateAReproduction,
  assertD1LocalRangeOnly,
  assertD2PitGlobalRange,
  assertForwardAuditIsNotSelectionInput,
  assertMaximumRangeCandidates,
  assertRangeReclaimFrozen,
  classifyR75,
  countScoreBand,
  passesR75SelectionGate,
  passesR75Throughput,
  rankR75SelectionRows,
  R75_AUTHORITATIVE_A,
  R75_CANDIDATE_E_ID,
  R75_D1_ID,
  R75_D2_ID,
  R75_RANGE_DEFAULTS,
  R75FinalOosRunGuard,
  R75CandidateEFreeze,
  selectHighestScorePerSymbolTimestamp,
} from "@/lib/research/r7-5-range-research";
import { DEFAULT_STRATEGY_PARAMS } from "@/lib/core/strategies";

describe("HY-R7.5 RANGE research guards", () => {
  it("reproduces the frozen Candidate A authority", () => {
    expect(() => assertCandidateAReproduction({
      trades: 29,
      netPnlUsdt: R75_AUTHORITATIVE_A.baseNetPnlUsdt,
      expectancyUsdt: 1,
      profitFactor: R75_AUTHORITATIVE_A.baseProfitFactor,
      maxDrawdownPercent: 0.03,
    }, {
      trades: 29,
      netPnlUsdt: R75_AUTHORITATIVE_A.stressNetPnlUsdt,
      expectancyUsdt: 1,
      profitFactor: R75_AUTHORITATIVE_A.stressProfitFactor,
      maxDrawdownPercent: 0.04,
    })).not.toThrow();
    expect(() => assertCandidateAReproduction({
      trades: 30,
      netPnlUsdt: R75_AUTHORITATIVE_A.baseNetPnlUsdt,
      expectancyUsdt: 1,
      profitFactor: R75_AUTHORITATIVE_A.baseProfitFactor,
      maxDrawdownPercent: 0.03,
    }, {
      trades: 29,
      netPnlUsdt: R75_AUTHORITATIVE_A.stressNetPnlUsdt,
      expectancyUsdt: 1,
      profitFactor: R75_AUTHORITATIVE_A.stressProfitFactor,
      maxDrawdownPercent: 0.04,
    })).toThrow("BACKTEST_REPRODUCIBILITY_FAILURE");
  });

  it("keeps RANGE_RECLAIM on the frozen production defaults", () => {
    expect(() => assertRangeReclaimFrozen({
      ...DEFAULT_STRATEGY_PARAMS,
      ...R75_RANGE_DEFAULTS,
      entryMode: "RANGE_RECLAIM",
      stopAtrMultiplier: 0.75,
    })).not.toThrow();
    expect(() => assertRangeReclaimFrozen({
      ...DEFAULT_STRATEGY_PARAMS,
      entryMode: "RANGE_RECLAIM",
      bollingerPeriod: 21,
      stopAtrMultiplier: 0.75,
    })).toThrow("Bollinger period");
  });

  it("enforces D1 local RANGE only and D2 PIT BTC RANGE without directional alignment", () => {
    expect(() => assertD1LocalRangeOnly({ localRegime: "RANGE", globalRegimeFilter: false })).not.toThrow();
    expect(() => assertD1LocalRangeOnly({ localRegime: "RANGE", globalRegimeFilter: true })).toThrow();
    expect(() => assertD2PitGlobalRange({ localRegime: "RANGE", globalRegime: "RANGE", usesDirectionalGlobalAlignment: false })).not.toThrow();
    expect(() => assertD2PitGlobalRange({ localRegime: "RANGE", globalRegime: "RANGE", usesDirectionalGlobalAlignment: true })).toThrow("directional");
    expect(() => assertD2PitGlobalRange({ localRegime: "RANGE", globalRegime: "BEAR", usesDirectionalGlobalAlignment: false })).toThrow();
  });

  it("keeps LONG and SHORT eligible and de-duplicates the higher score at one timestamp", () => {
    const selected = selectHighestScorePerSymbolTimestamp([
      { symbol: "BTCUSDT", sourceTimestamp: 1, score: 80, side: "LONG" },
      { symbol: "BTCUSDT", sourceTimestamp: 1, score: 81, side: "SHORT" },
      { symbol: "ETHUSDT", sourceTimestamp: 1, score: 80, side: "LONG" },
    ]);
    expect(selected).toHaveLength(2);
    expect(selected.find((event) => event.symbol === "BTCUSDT")?.side).toBe("SHORT");
    expect(new Set(selected.map((event) => event.side))).toEqual(new Set(["LONG", "SHORT"]));
  });

  it("limits the preregistered RANGE challenger set to D1 and D2", () => {
    expect(() => assertMaximumRangeCandidates([R75_D1_ID, R75_D2_ID])).not.toThrow();
    expect(() => assertMaximumRangeCandidates([R75_D1_ID, R75_D1_ID])).toThrow();
    expect(() => assertMaximumRangeCandidates([R75_D1_ID, R75_D2_ID, "D3"])).toThrow();
  });

  it("uses train + validation gates before throughput and never treats forward as selection", () => {
    const gate = passesR75SelectionGate({
      trades: 12,
      netPnlUsdt: 10,
      expectancyUsdt: 1,
      profitFactor: 1.2,
      maxDrawdownPercent: 0.05,
    }, {
      trades: 12,
      netPnlUsdt: 5,
      expectancyUsdt: 0.4,
      profitFactor: 1.05,
      maxDrawdownPercent: 0.06,
    }, 2, 3);
    expect(gate.pass).toBe(true);
    expect(passesR75Throughput(1, 100, 29, 100).pass).toBe(true);
    expect(() => assertForwardAuditIsNotSelectionInput({
      selectionDataset: "R7.1 authoritative 20-symbol validation-cache",
      forwardUsedForSelection: false,
    })).not.toThrow();
    expect(() => assertForwardAuditIsNotSelectionInput({
      selectionDataset: "R7.1 authoritative 20-symbol validation-cache",
      forwardUsedForSelection: true,
    })).toThrow();
  });

  it("runs each final OOS candidate once and freezes E before OOS", () => {
    const guard = new R75FinalOosRunGuard();
    expect(guard.run("D1", () => "done")).toBe("done");
    expect(() => guard.run("D1", () => "again")).toThrow("already executed");
    const freeze = new R75CandidateEFreeze();
    expect(() => freeze.assertFrozenBeforeOos()).toThrow("pre-registered");
    expect(freeze.freeze(R75_D1_ID)).toBe(R75_CANDIDATE_E_ID);
    expect(() => freeze.assertFrozenBeforeOos()).not.toThrow();
    expect(() => freeze.freeze(R75_D2_ID)).toThrow("already frozen");
  });

  it("enforces one shared 24h same-symbol cooldown", () => {
    const accepted = applyR75SharedCooldown([
      { symbol: "BTCUSDT", sourceTimestamp: 0, score: 80, side: "LONG" },
      { symbol: "BTCUSDT", sourceTimestamp: 2 * 60 * 60 * 1000, score: 99, side: "SHORT" },
      { symbol: "BTCUSDT", sourceTimestamp: 25 * 60 * 60 * 1000, score: 81, side: "SHORT" },
      { symbol: "ETHUSDT", sourceTimestamp: 2 * 60 * 60 * 1000, score: 80, side: "LONG" },
    ]);
    expect(accepted.map((event) => `${event.symbol}:${event.sourceTimestamp}`)).toEqual([
      "BTCUSDT:0",
      `ETHUSDT:${2 * 60 * 60 * 1000}`,
      `BTCUSDT:${25 * 60 * 60 * 1000}`,
    ]);
  });

  it("ranks profitability eligibility before throughput", () => {
    const rows = rankR75SelectionRows([
      { id: "high-throughput-loss", profitabilityEligible: false, stressProfitFactor: 0.8, baseExpectancy: -1, maxDrawdownPercent: 0.1, stabilityScore: 4, tradeCount: 500 },
      { id: "profitable-range", profitabilityEligible: true, stressProfitFactor: 1.1, baseExpectancy: 1, maxDrawdownPercent: 0.05, stabilityScore: 2, tradeCount: 29 },
    ]);
    expect(rows[0].id).toBe("profitable-range");
  });

  it("counts the future score-parity warning band without inventing candidates", () => {
    expect(countScoreBand([78.9, 79, 80.5, 81, 81.01])).toBe(3);
  });

  it("routes the allowed final classifications fail-closed", () => {
    expect(classifyR75({
      authoritativeCandidateAReproduced: false,
      selectedRange: false,
      selectedOosTradeCount: null,
      selectedDPass: false,
      selectedDThroughputPass: false,
      candidateEPass: false,
      candidateEThroughputPass: false,
    })).toBe("BACKTEST_REPRODUCIBILITY_FAILURE");
    expect(classifyR75({
      authoritativeCandidateAReproduced: true,
      selectedRange: true,
      selectedOosTradeCount: 10,
      selectedDPass: false,
      selectedDThroughputPass: false,
      candidateEPass: false,
      candidateEThroughputPass: false,
    })).toBe("INSUFFICIENT_RANGE_OOS_SAMPLE");
  });
});
