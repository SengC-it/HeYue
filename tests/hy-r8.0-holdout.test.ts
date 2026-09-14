import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/core/types";
import {
  assertNoPostResultMutation,
  assertR80CandidateAFrozen,
  assertR80QuarterBoundaries,
  assertR80WindowIndependent,
  bootstrapR80,
  buildR80Availability,
  buildR80PitDynamicUniverse,
  buildR80QuarterWindows,
  classifyR80,
  isR80NextBarExecution,
  passesR80EdgeGate,
  R80_BASE_RESEARCH_HEAD,
  R80_CANDIDATE_A_ID,
  R80_FROZEN_RULES,
  R80_HOLDOUT_END,
  R80_HOLDOUT_START,
  R80_BOOTSTRAP_SEED,
  R80_MIN_TRADES,
  R80_PROTOCOL_COMMIT,
  R80_R7_START,
  R80_STRATEGY_HASH,
  R80_STRATEGY_VERSION,
  R80OneShotGuard,
  rollingQuoteVolumePIT,
} from "@/lib/research/r8-0-holdout";

function candle(openTime: number, quoteVolume: number): Candle {
  return {
    openTime,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: quoteVolume / 100,
    quoteVolume,
    closeTime: openTime + 15 * 60 * 1000 - 1,
  };
}

describe("HY-R8.0 frozen holdout guards", () => {
  it("freezes Candidate A and the protocol ancestry", () => {
    expect(R80_CANDIDATE_A_ID).toBe("HY-R7-FORWARD-CANDIDATE-A");
    expect(R80_PROTOCOL_COMMIT).toHaveLength(40);
    expect(R80_BASE_RESEARCH_HEAD).toHaveLength(40);
    expect(R80_BOOTSTRAP_SEED).toBe(8_052_024);
    expect(() => assertR80CandidateAFrozen({
      ...R80_FROZEN_RULES,
      strategyVersion: R80_STRATEGY_VERSION,
      strategyHash: R80_STRATEGY_HASH,
    })).not.toThrow();
    expect(() => assertR80CandidateAFrozen({
      ...R80_FROZEN_RULES,
      strategyVersion: R80_STRATEGY_VERSION,
      strategyHash: "changed",
    })).toThrow("strategyHash");
  });

  it("keeps the independent holdout strictly before R7", () => {
    expect(R80_HOLDOUT_END).toBeLessThan(R80_R7_START);
    expect(() => assertR80WindowIndependent()).not.toThrow();
    expect(() => assertR80WindowIndependent(R80_R7_START, R80_R7_START + 1, R80_R7_START)).toThrow("overlaps");
  });

  it("computes PIT listing eligibility and coverage without future listing knowledge", () => {
    const start = R80_HOLDOUT_START;
    const candles = Array.from({ length: 84 }, (_, index) => candle(start - 80 * 900_000 + index * 900_000, 1));
    const availability = buildR80Availability("TESTUSDT", candles);
    expect(availability.firstAvailableAt).toBe(candles[0].openTime);
    expect(availability.firstEligibleAt).toBe(candles[80].closeTime);
    expect(availability.eligibleInHoldout).toBe(true);
    expect(availability.actual15mBars).toBe(4);
    expect(availability.coverageStatus).toBe("PARTIAL");
  });

  it("uses only closed candles for PIT rolling volume and excludes an ineligible symbol", () => {
    const t0 = R80_HOLDOUT_START;
    const first = candle(t0 - 24 * 60 * 60 * 1000, 10);
    const current = candle(t0, 20);
    const future = candle(t0 + 15 * 60 * 1000, 10_000);
    expect(rollingQuoteVolumePIT([first, current, future], current.closeTime, 1)).toBe(20);

    const datasets = [
      { symbol: "ELIGIBLE", candles: { "15m": [current, future] } },
      { symbol: "NOT_YET_LISTED", candles: { "15m": [current, future] } },
    ];
    const universe = buildR80PitDynamicUniverse(
      datasets,
      [current.closeTime],
      new Map([
        ["ELIGIBLE", current.closeTime],
        ["NOT_YET_LISTED", current.closeTime + 1],
      ]),
      10,
      1,
    );
    expect([...(universe.get(current.closeTime) ?? [])]).toEqual(["ELIGIBLE"]);
  });

  it("uses next-bar execution and rejects same-close fills", () => {
    const sourceClose = 1_000_000;
    expect(isR80NextBarExecution(sourceClose, sourceClose + 1)).toBe(true);
    expect(isR80NextBarExecution(sourceClose, sourceClose)).toBe(false);
    expect(isR80NextBarExecution(sourceClose, sourceClose + 15 * 60 * 1000)).toBe(false);
  });

  it("keeps four quarter boundaries contiguous and immutable", () => {
    const windows = buildR80QuarterWindows();
    expect(windows).toHaveLength(4);
    expect(windows[0].start).toBe(R80_HOLDOUT_START);
    expect(windows[0].endExclusive).toBe(Date.parse("2024-11-07T14:15:00.000Z"));
    expect(windows[1].endExclusive).toBe(Date.parse("2025-02-06T02:15:00.000Z"));
    expect(windows[2].endExclusive).toBe(Date.parse("2025-05-07T14:15:00.000Z"));
    expect(windows.at(-1)?.endExclusive).toBe(R80_HOLDOUT_END + 1);
    expect(windows.slice(1).every((window, index) => window.start === windows[index].endExclusive)).toBe(true);
    expect(() => assertR80QuarterBoundaries(windows)).not.toThrow();
    expect(() => assertR80QuarterBoundaries(windows.map((window, index) => index === 0
      ? { ...window, endExclusive: window.endExclusive + 1, endInclusive: window.endInclusive + 1 }
      : window))).toThrow("boundary changed");
  });

  it("requires the complete immutable 75-trade edge gate", () => {
    const base = { trades: R80_MIN_TRADES, netPnlUsdt: 1, expectancyUsdt: 1, profitFactor: 1.2, maxDrawdownPercent: 0.1 };
    const stress = { trades: R80_MIN_TRADES, netPnlUsdt: 1, expectancyUsdt: 1, profitFactor: 1.1, maxDrawdownPercent: 0.1 };
    expect(passesR80EdgeGate(base, stress, 3, 6, 0.95).pass).toBe(true);
    expect(passesR80EdgeGate({ ...base, trades: R80_MIN_TRADES - 1 }, stress, 4, 8, 1).maturedTradesPass).toBe(false);
    expect(passesR80EdgeGate(base, stress, 3, 6, 0.9499).pass).toBe(false);
  });

  it("makes bootstrap deterministic and enforces the 10,000 iteration floor", () => {
    const values = [10, 5, -2, -1, 3];
    const first = bootstrapR80(values);
    const second = bootstrapR80(values);
    expect(first).toEqual(second);
    expect(first.expectancyUsdt.iterations).toBe(10_000);
    expect(() => bootstrapR80(values, 9_999)).toThrow("10,000");
  });

  it("classifies reproduction and sample failures before profitability", () => {
    expect(classifyR80({ candidateAReproduced: false, holdoutDataValid: true, holdoutTrades: 100, edgeGatePass: true }))
      .toBe("BACKTEST_REPRODUCIBILITY_FAILURE");
    expect(classifyR80({ candidateAReproduced: true, holdoutDataValid: false, holdoutTrades: 100, edgeGatePass: true }))
      .toBe("HOLDOUT_DATA_INVALID");
    expect(classifyR80({ candidateAReproduced: true, holdoutDataValid: true, holdoutTrades: 74, edgeGatePass: true }))
      .toBe("INSUFFICIENT_HOLDOUT_SAMPLE");
    expect(classifyR80({ candidateAReproduced: true, holdoutDataValid: true, holdoutTrades: 75, edgeGatePass: false }))
      .toBe("EXTENDED_INDEPENDENT_EDGE_FAIL");
  });

  it("marks the one-shot run before the operation and forbids reruns", () => {
    const guard = new R80OneShotGuard();
    expect(() => guard.run(() => { throw new Error("holdout failed"); })).toThrow("holdout failed");
    expect(guard.runCount).toBe(1);
    expect(() => guard.run(() => "rerun")).toThrow("one-shot");
  });

  it("rejects any post-result parameter, threshold, or tuning mutation", () => {
    expect(() => assertNoPostResultMutation({ parametersChanged: false, thresholdsChanged: false, resultUsedForTuning: false })).not.toThrow();
    expect(() => assertNoPostResultMutation({ parametersChanged: true, thresholdsChanged: false, resultUsedForTuning: false })).toThrow("post-result");
  });
});
