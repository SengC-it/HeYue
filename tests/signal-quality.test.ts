import { describe, expect, it } from "vitest";
import {
  createSignalQualityState,
  defaultSignalQualityPolicy,
  optimizeSignalOutputs,
} from "../lib/signal-quality";
import type {
  MarketStatusCode,
  SignalEngineScores,
  SignalEngineSignal,
} from "../lib/signal-engine";
import type { SignalType } from "../lib/signal-intelligence/types";

describe("HY-R4.12 signal quality optimization", () => {
  it("filters directional outputs using existing status, risk, confidence, and opportunity fields", () => {
    const state = createSignalQualityState();
    const result = optimizeSignalOutputs([
      signal("LONG_WATCH", "2026-09-05T00:00:00.000Z", {
        marketStatus: "RANGE",
      }),
      signal("SHORT_WATCH", "2026-09-05T00:00:00.000Z", {
        marketStatus: "TREND_DOWN",
        risk: 50,
      }),
      signal("LONG_WATCH", "2026-09-05T00:00:00.000Z", {
        risk: 30,
        confidence: 80,
        opportunity: 85,
        marketStatus: "TREND_UP",
      }),
    ], state);

    expect(result.signals.map((item) => item.signal_type)).toEqual(["LONG_WATCH"]);
    expect(result.filtered.map((item) => item.reason)).toEqual([
      "DIRECTIONAL_STATUS_MISMATCH",
      "DIRECTIONAL_RISK_TOO_HIGH",
    ]);
  });

  it("keeps material risk warnings and filters low-materiality risk noise", () => {
    const state = createSignalQualityState();
    const result = optimizeSignalOutputs([
      signal("RISK_WARNING", "2026-09-05T00:00:00.000Z", {
        risk: 40,
        reasons: ["REGIME_CONFLICT"],
      }),
      signal("RISK_WARNING", "2026-09-05T00:00:00.000Z", {
        risk: 40,
        reasons: ["HIGH_VOLATILITY"],
      }),
    ], state);

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.event.reason_codes).toContain("HIGH_VOLATILITY");
    expect(result.filtered[0]?.reason).toBe("RISK_NOT_MATERIAL");
  });

  it("deduplicates risk and directional alerts while allowing score escalation", () => {
    const state = createSignalQualityState();
    const first = optimizeSignalOutputs([
      signal("LONG_WATCH", "2026-09-05T00:00:00.000Z", {
        risk: 30,
        confidence: 80,
        opportunity: 85,
        marketStatus: "TREND_UP",
      }),
      signal("RISK_WARNING", "2026-09-05T00:00:00.000Z", {
        risk: 60,
        reasons: ["HIGH_VOLATILITY"],
      }),
    ], state);
    const duplicate = optimizeSignalOutputs([
      signal("LONG_WATCH", "2026-09-05T04:00:00.000Z", {
        risk: 30,
        confidence: 80,
        opportunity: 85,
        marketStatus: "TREND_UP",
      }),
      signal("RISK_WARNING", "2026-09-05T04:00:00.000Z", {
        risk: 61,
        reasons: ["HIGH_VOLATILITY"],
      }),
    ], state);
    const escalation = optimizeSignalOutputs([
      signal("LONG_WATCH", "2026-09-05T08:00:00.000Z", {
        risk: 30,
        confidence: 80,
        opportunity: 96,
        marketStatus: "TREND_UP",
      }),
      signal("RISK_WARNING", "2026-09-05T08:00:00.000Z", {
        risk: 72,
        reasons: ["HIGH_VOLATILITY"],
      }),
    ], state);

    expect(first.signals).toHaveLength(2);
    expect(duplicate.signals).toHaveLength(0);
    expect(duplicate.filtered.every((item) => item.reason === "DUPLICATE_WITHIN_COOLDOWN")).toBe(true);
    expect(escalation.signals).toHaveLength(2);
  });

  it("publishes a stable market status only on change or after the heartbeat", () => {
    const state = createSignalQualityState();
    const first = optimizeSignalOutputs([
      signal("MARKET_STATUS", "2026-09-05T00:00:00.000Z", { marketStatus: "RANGE" }),
    ], state);
    const repeated = optimizeSignalOutputs([
      signal("MARKET_STATUS", "2026-09-05T04:00:00.000Z", { marketStatus: "RANGE" }),
    ], state);
    const changed = optimizeSignalOutputs([
      signal("MARKET_STATUS", "2026-09-05T08:00:00.000Z", { marketStatus: "TREND_UP" }),
    ], state);
    const heartbeat = optimizeSignalOutputs([
      signal("MARKET_STATUS", "2026-09-06T09:00:00.000Z", { marketStatus: "TREND_UP" }),
    ], state);

    expect(first.signals).toHaveLength(1);
    expect(repeated.signals).toHaveLength(0);
    expect(repeated.filtered[0]?.reason).toBe("STATUS_HEARTBEAT_SUPPRESSED");
    expect(changed.signals).toHaveLength(1);
    expect(heartbeat.signals).toHaveLength(1);
  });

  it("does not require or calculate any feature outside the existing signal payload", () => {
    expect(Object.keys(defaultSignalQualityPolicy).sort()).toEqual([
      "directional_cooldown_ms",
      "directional_max_risk_score",
      "directional_min_confidence",
      "directional_min_opportunity_score",
      "escalation_delta",
      "risk_warning_cooldown_ms",
      "risk_warning_min_risk_score",
      "status_heartbeat_ms",
    ]);
  });
});

function signal(
  signalType: SignalType,
  createdAt: string,
  overrides: {
    marketStatus?: MarketStatusCode;
    risk?: number;
    confidence?: number;
    opportunity?: number;
    reasons?: string[];
  } = {},
): SignalEngineSignal {
  const opportunity = overrides.opportunity ?? 70;
  const risk = overrides.risk ?? 40;
  const confidence = overrides.confidence ?? 60;
  const marketStatus = overrides.marketStatus
    ?? (signalType === "LONG_WATCH" ? "TREND_UP" : signalType === "SHORT_WATCH" ? "TREND_DOWN" : "RANGE");
  const scores: SignalEngineScores = {
    market_condition_score: 70,
    signal_quality_score: 70,
    risk_level_score: risk,
    confidence,
    long_opportunity_score: opportunity,
    short_opportunity_score: opportunity,
    long_evidence_count: 3,
    short_evidence_count: 3,
    market_status: marketStatus,
    risk_reason_codes: overrides.reasons ?? ["HIGH_VOLATILITY"],
    pit_safe: true,
    breakdown: {
      market_condition: {},
      signal_quality: {},
      risk_level: {},
    },
  };
  return {
    event: {
      id: signalType + createdAt,
      symbol: "BTCUSDT",
      signal_type: signalType,
      created_at: createdAt,
      market_regime: signalType === "LONG_WATCH" ? "BULL" : signalType === "SHORT_WATCH" ? "BEAR" : "RANGE",
      quality_score: opportunity,
      risk_score: risk,
      confidence,
      reason_codes: overrides.reasons ?? ["HIGH_VOLATILITY"],
      human_explanation: "人工观察",
      reference_price: 100,
      status: "CREATED",
    },
    feature_snapshot: null,
    signal_type: signalType,
    opportunity_score: opportunity,
    alert_level: "B",
    scores,
  };
}
