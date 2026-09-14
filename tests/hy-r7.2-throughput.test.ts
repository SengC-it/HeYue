import { describe, expect, it } from "vitest";
import {
  R72_CANDIDATE_A,
  R72_MAX_CHALLENGERS,
  assertCandidateAImmutable,
  assertChallengerCount,
  assertFunnelAccounting,
  auditOnlyFailureSet,
  bootstrapConfidence,
  buildFunnel,
  calculateSignalRate,
  estimateDaysToTarget,
  passesProfitabilityGate,
  passesThroughputGate,
  rankProfitabilityBeforeThroughput,
  R72OosRunGuard,
} from "@/lib/research/r7-2";

describe("HY-R7.2 throughput research guardrails", () => {
  it("keeps funnel counts fully reconciled", () => {
    const funnel = buildFunnel(100, [
      { stage: "symbols considered", passed: 100 },
      { stage: "liquidity/universe eligible", passed: 20 },
      { stage: "TREND_PULLBACK condition met", passed: 10 },
      { stage: "SHORT side eligible", passed: 8 },
      { stage: "local regime aligned", passed: 6 },
      { stage: "BTC 4h regime aligned", passed: 4 },
      { stage: "score >=80", passed: 3 },
      { stage: "cooldown eligible", passed: 2 },
      { stage: "execution-cost eligible", passed: 1 },
      { stage: "final signal emitted", passed: 1 },
    ]);
    assertFunnelAccounting(funnel);
    expect(funnel.at(-1)?.rejected).toBe(0);
    expect(funnel[1].cumulativePassRate).toBe(0.2);
  });

  it("rejects any mutation of Candidate A's frozen contract", () => {
    expect(() => assertCandidateAImmutable(R72_CANDIDATE_A)).not.toThrow();
    expect(() => assertCandidateAImmutable({ ...R72_CANDIDATE_A, score: 79 })).toThrow("score");
  });

  it("allows each candidate's final OOS run only once", () => {
    const guard = new R72OosRunGuard();
    expect(guard.run("A", () => "first")).toBe("first");
    expect(() => guard.run("A", () => "second")).toThrow("already executed");
    expect(guard.run("B1", () => "separate")).toBe("separate");
    expect(guard.runCount).toBe(2);
  });

  it("keeps the legacy failure set audit-only", () => {
    expect(auditOnlyFailureSet(37)).toEqual({ rows: 37, retained: 0, suppressed: 37, usedForSelection: false });
    expect(() => auditOnlyFailureSet(36)).toThrow();
  });

  it("calculates signal throughput and annualized rate from event timestamps", () => {
    const day = 24 * 60 * 60 * 1000;
    const rate = calculateSignalRate([0, day, 3 * day], 0, 4 * day);
    expect(rate.count).toBe(3);
    expect(rate.signalsPerDay).toBe(0.75);
    expect(rate.signalsPerWeek).toBe(5.25);
    expect(rate.annualizedSignals).toBe(273.9375);
    expect(rate.medianDaysBetweenSignals).toBe(1.5);
    expect(estimateDaysToTarget(3, 4, 30)).toBe(40);
  });

  it("enforces the throughput gate without changing profitability rules", () => {
    expect(passesThroughputGate(10, 20, 99.9)).toBe(true);
    expect(passesThroughputGate(10, 19, 100)).toBe(true);
    expect(passesThroughputGate(10, 19, 99.9)).toBe(false);
    expect(R72_MAX_CHALLENGERS).toBe(2);
  });

  it("limits challengers to two unique pre-registered candidates", () => {
    expect(() => assertChallengerCount(["B1", "B2"])).not.toThrow();
    expect(() => assertChallengerCount(["B1", "B2", "B3"])).toThrow();
    expect(() => assertChallengerCount(["B1", "B1"])).toThrow();
  });

  it("ranks profitability before throughput", () => {
    const ranked = rankProfitabilityBeforeThroughput([
      { id: "frequent", profitabilityEligible: false, expectancyUsdt: 100, profitFactor: 3, stressProfitFactor: 2, netPnlUsdt: 1_000, signalCount: 100, annualizedSignals: 100 },
      { id: "robust", profitabilityEligible: true, expectancyUsdt: 10, profitFactor: 1.5, stressProfitFactor: 1.2, netPnlUsdt: 100, signalCount: 10, annualizedSignals: 10 },
    ]);
    expect(ranked.map((candidate) => candidate.id)).toEqual(["robust", "frequent"]);
    expect(passesProfitabilityGate(
      { trades: 10, netPnlUsdt: 100, expectancyUsdt: 10, profitFactor: 1.5, maxDrawdownPercent: 0.05 },
      { trades: 10, netPnlUsdt: 120, expectancyUsdt: 12, profitFactor: 1.3, maxDrawdownPercent: 0.06 },
      { trades: 10, netPnlUsdt: 100, expectancyUsdt: 10, profitFactor: 1.1, maxDrawdownPercent: 0.06 },
    )).toBe(true);
  });

  it("produces deterministic confidence distributions for a frozen sample", () => {
    const first = bootstrapConfidence([10, 10, -5], 100, 72);
    const second = bootstrapConfidence([10, 10, -5], 100, 72);
    expect(first).toEqual(second);
    expect(first.expectancyUsdt.sampleCount).toBe(3);
    expect(first.profitFactor.p025).not.toBeNull();
  });
});
