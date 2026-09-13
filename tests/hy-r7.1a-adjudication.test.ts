import { describe, expect, it } from "vitest";
import {
  R71A_CANDIDATE_ID,
  calculateForwardMetrics,
  canonicalJson,
  classifyForwardGate,
  parseCsv,
  sha256CanonicalJson,
  validateFrozenFailureSet,
} from "@/lib/research/r7-1a";

describe("HY-R7.1A evidence freeze guardrails", () => {
  it("canonicalizes object key order before hashing", () => {
    expect(canonicalJson({ z: 2, a: { d: true, c: 1 } })).toBe('{"a":{"c":1,"d":true},"z":2}');
    expect(sha256CanonicalJson({ a: 1, b: 2 })).toBe(sha256CanonicalJson({ b: 2, a: 1 }));
  });

  it("requires the exact frozen 37-row audit set", () => {
    const csv = [
      "notification_id,signal_id,notification_status,failure_set_classification",
      "n1,s1,SENT,KNOWN_FAILURE_AUDIT",
    ].join("\n");
    expect(parseCsv(csv)).toHaveLength(1);
    expect(() => validateFrozenFailureSet(csv)).toThrow("exactly 37");
  });

  it("does not treat one positive trade as a completed forward gate", () => {
    const metrics = calculateForwardMetrics([{
      symbol: "HYPEUSDT",
      side: "SHORT",
      strategyFamily: "TREND",
      strategyVersion: "hy-paper-candidate-v2",
      entryTime: "2026-09-10T19:14:59.999Z",
      exitTime: "2026-09-10T23:59:59.999Z",
      status: "TAKE_PROFIT",
      netPnlUsdt: 95.36074897,
      rMultiple: 1.90725694,
      exitReason: "TAKE_PROFIT",
    }]);
    const gate = classifyForwardGate({ calendarDays: 35, metrics });
    expect(metrics.maturedTrades).toBe(1);
    expect(metrics.netPnlUsdt).toBe(95.36074897);
    expect(metrics.profitFactor).toBeNull();
    expect(gate.maturedTradesRequirementMet).toBe(false);
    expect(gate.gateStatus).toBe("OPEN_INSUFFICIENT_SAMPLE");
    expect(R71A_CANDIDATE_ID).toBe("HY-R7-FORWARD-CANDIDATE-A");
  });

  it("implements the preregistered early-kill rule without tuning", () => {
    const metrics = calculateForwardMetrics([
      {
        symbol: "BTCUSDT", side: "SHORT", strategyFamily: "TREND", strategyVersion: "hy-paper-candidate-v2",
        entryTime: "2026-08-10T00:00:00.000Z", exitTime: "2026-08-10T01:00:00.000Z", status: "STOP_LOSS",
        netPnlUsdt: -1, rMultiple: -1, exitReason: "STOP_LOSS",
      },
    ]);
    const gate = classifyForwardGate({ calendarDays: 30, metrics });
    expect(gate.earlyKill).toBe(false);
    expect(gate.gateStatus).toBe("OPEN_INSUFFICIENT_SAMPLE");
  });
});
