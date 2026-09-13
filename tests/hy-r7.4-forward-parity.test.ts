import { describe, expect, it } from "vitest";
import {
  assertPITNextBar,
  classifyR74,
  compareStringArrays,
  driftRatio,
  forwardObservationStart,
  latestClosed15mTimestamp,
  metricFromBooleans,
  scanSourceTimestamp,
} from "@/lib/research/r7-4-forward-parity";
import { R73_AUTHORITATIVE_A_OOS } from "@/lib/research/r7-3";

const BASE_CLASSIFICATION_INPUT = {
  authoritativeReproduced: true,
  evidenceComplete: true,
  diagnosticsParityPercent: 100,
  hypeAnchorMatches: true,
  replayQualifiedSignals: 1,
  productionQualifiedSignals: 1,
  replayFinalSignals: 1,
  productionFinalSignals: 1,
  forwardOpportunityMateriallyLower: false,
  forwardRegimeMateriallyLower: false,
};

describe("HY-R7.4 forward parity and regime drift guardrails", () => {
  it("keeps the frozen Candidate A authority as the replay prerequisite", () => {
    expect(R73_AUTHORITATIVE_A_OOS.trades).toBe(29);
    expect(R73_AUTHORITATIVE_A_OOS.baseNetPnlUsdt).toBe(469.31166529);
    expect(R73_AUTHORITATIVE_A_OOS.baseProfitFactor).toBe(1.59999141);
    expect(R73_AUTHORITATIVE_A_OOS.stressNetPnlUsdt).toBe(400.66533784);
    expect(R73_AUTHORITATIVE_A_OOS.stressProfitFactor).toBe(1.48858398);
  });

  it("maps a Production scan to the exact closed 15m source candle", () => {
    expect(scanSourceTimestamp("2026-09-10T19:15:04.865Z")).toBe(
      Date.parse("2026-09-10T19:14:59.999Z"),
    );
  });

  it("requires next-bar execution and rejects future or same-candle execution", () => {
    const sourceTimestamp = Date.parse("2026-09-10T19:14:59.999Z");
    expect(() => assertPITNextBar(sourceTimestamp, Date.parse("2026-09-10T19:15:00.000Z"))).not.toThrow();
    expect(() => assertPITNextBar(sourceTimestamp, sourceTimestamp)).toThrow("PIT next-bar violation");
    expect(() => assertPITNextBar(sourceTimestamp, Date.parse("2026-09-10T19:30:00.000Z"))).toThrow("PIT next-bar violation");
  });

  it("uses a closed-candle boundary for the latest available decision", () => {
    expect(latestClosed15mTimestamp(Date.parse("2026-09-13T15:45:00.000Z"))).toBe(
      Date.parse("2026-09-13T15:44:59.999Z"),
    );
  });

  it("starts forward observation at the later production clock", () => {
    expect(forwardObservationStart(
      "2026-08-09T15:46:25.317519Z",
      "2026-08-09T17:34:48.982760Z",
    )).toBe("2026-08-09T17:34:48.982Z");
  });

  it("compares parity arrays with explicit order semantics", () => {
    expect(compareStringArrays(["BTCUSDT", "ETHUSDT"], ["BTCUSDT", "ETHUSDT"])).toBe(true);
    expect(compareStringArrays(["BTCUSDT", "ETHUSDT"], ["ETHUSDT", "BTCUSDT"])).toBe(false);
    expect(compareStringArrays(["BTCUSDT", "ETHUSDT"], ["ETHUSDT", "BTCUSDT"], false)).toBe(true);
    expect(metricFromBooleans([true, false, true])).toEqual({ compared: 3, exact: 2, mismatch: 1, matchPercent: 66.666667 });
  });

  it("keeps the HYPE anchor and drift denominator fail-closed", () => {
    expect(compareStringArrays(["HYPEUSDT"], ["HYPEUSDT"], false)).toBe(true);
    expect(driftRatio(0.02, 0)).toBeNull();
    expect(driftRatio(0.01, 0.02)).toBe(0.5);
  });

  it("fails closed when authoritative reproduction or evidence is missing", () => {
    expect(classifyR74({ ...BASE_CLASSIFICATION_INPUT, authoritativeReproduced: false })).toBe("BACKTEST_REPRODUCIBILITY_FAILURE");
    expect(classifyR74({ ...BASE_CLASSIFICATION_INPUT, evidenceComplete: false })).toBe("INSUFFICIENT_FORWARD_REPLAY_EVIDENCE");
    expect(classifyR74({ ...BASE_CLASSIFICATION_INPUT, hypeAnchorMatches: false })).toBe("INSUFFICIENT_FORWARD_REPLAY_EVIDENCE");
  });

  it("distinguishes implementation parity failure from confirmed regime drift", () => {
    expect(classifyR74({
      ...BASE_CLASSIFICATION_INPUT,
      replayQualifiedSignals: 8,
      productionQualifiedSignals: 1,
    })).toBe("IMPLEMENTATION_PARITY_FAILURE");
    expect(classifyR74({
      ...BASE_CLASSIFICATION_INPUT,
      forwardOpportunityMateriallyLower: true,
      forwardRegimeMateriallyLower: true,
    })).toBe("MARKET_REGIME_DRIFT_CONFIRMED");
    expect(classifyR74(BASE_CLASSIFICATION_INPUT)).toBe("INSUFFICIENT_FORWARD_REPLAY_EVIDENCE");
  });
});
