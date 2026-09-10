import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  b4CrossSectionalPercentile,
  b4ShadowContextValue,
  b4ShadowControlMatchKey,
  calculateB4ShadowOutcome,
  calculateB4Volatility,
  classifyB4BasisBucket,
  classifyB4FundingBucket,
  classifyB4LiquidityPercentile,
  classifyB4MarketRegime,
  classifyB4VolatilityValue,
  meanB4QuoteVolume,
} from "../lib/signal-engine";
import { B4_SHADOW_MATCH_FIELDS, B4ShadowEngine } from "../lib/signal-engine/b4-shadow";
import { runB4ShadowSidecar } from "../lib/signal-engine/b4-shadow-sidecar";
import type { B4ShadowObservation } from "../lib/signal-engine/b4-shadow-types";

const HOUR = 3_600_000;

describe("HY-R6.2C.2 frozen Control-B and live parity", () => {
  it("locks funding, five-level basis, volatility, liquidity, and regime boundaries", () => {
    expect(classifyB4FundingBucket(-0.00005)).toBe("NEUTRAL");
    expect(classifyB4FundingBucket(0.00005)).toBe("NEUTRAL");
    expect(classifyB4BasisBucket(-0.0005)).toBe("EXTREME_NEGATIVE");
    expect(classifyB4BasisBucket(-0.00001)).toBe("NEGATIVE");
    expect(classifyB4BasisBucket(0)).toBe("NEUTRAL");
    expect(classifyB4BasisBucket(0.00001)).toBe("POSITIVE");
    expect(classifyB4BasisBucket(0.0005)).toBe("EXTREME_POSITIVE");
    expect(classifyB4VolatilityValue(0.005)).toBe("NORMAL");
    expect(classifyB4VolatilityValue(0.015)).toBe("HIGH");
    expect(calculateB4Volatility(candlesWithHourlyCloses(0.0051)).bucket).toBe("NORMAL");
    expect(calculateB4Volatility(candlesWithHourlyCloses(0.0151)).bucket).toBe("HIGH");
    expect(meanB4QuoteVolume(candlesWithHourlyQuoteVolumes())).toBe(12.5);
    expect(b4CrossSectionalPercentile(33, Array.from({ length: 100 }, (_, i) => i + 1))).toBe(0.33);
    expect(classifyB4LiquidityPercentile(0.33)).toBe("LOW");
    expect(classifyB4LiquidityPercentile(0.66)).toBe("NORMAL");
    expect(classifyB4MarketRegime([0.005, 0.005])).toBe("RANGE");
    expect(classifyB4MarketRegime([-0.005, -0.005])).toBe("RANGE");
    expect(classifyB4MarketRegime([0.006, 0.007, 0.008])).toBe("UP");
  });

  it("matches the outcome-free R5.10A context fixture", () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/hy-research-freezes/r5.10a-b4-context-parity.json"), "utf8")) as {
      sample: {
        symbol: string;
        timestamp: string;
        fourHourReturns: number[];
        volatilityValue: number;
        quoteVolumePeers: number[];
        quoteVolumeMean: number;
        fundingRate: number;
        basis: number;
        expected: Record<string, string | number>;
      };
    };
    const s = fixture.sample;
    const percentile = b4CrossSectionalPercentile(s.quoteVolumeMean, s.quoteVolumePeers)!;
    const key = [
      s.symbol,
      s.expected.calendarPeriod,
      classifyB4MarketRegime(s.fourHourReturns),
      "NORMAL",
      classifyB4LiquidityPercentile(percentile),
      classifyB4FundingBucket(s.fundingRate),
      classifyB4BasisBucket(s.basis),
    ].join("|");
    expect(key).toBe(s.expected.matchKey);
    expect(s.timestamp).toContain("2026-07");
    expect(s.expected.volatilityBucket).toBe("NORMAL");
  });

  it("uses only the seven bucket match fields and ignores raw values", () => {
    expect(B4_SHADOW_MATCH_FIELDS).toEqual([
      "symbol",
      "calendar_period",
      "market_regime",
      "volatility_bucket",
      "liquidity_bucket",
      "funding_bucket",
      "mark_index_basis_bucket",
    ]);
    const base = {
      symbol: "BTCUSDT",
      calendar_period: "2026-Q3",
      market_regime: "RANGE",
      volatility_bucket: "NORMAL",
      liquidity_bucket: "HIGH",
      funding_state: { bucket: "NEUTRAL", funding_rate: 0.00001, funding_time: 1 },
      mark_index_basis_state: { bucket: "POSITIVE", mark_price: 101, index_price: 100, basis_bps: 10 },
    } as const;
    const changed = {
      ...base,
      funding_state: { bucket: "NEUTRAL", funding_rate: -0.00001, funding_time: 2 },
      mark_index_basis_state: { bucket: "POSITIVE", mark_price: 110, index_price: 100, basis_bps: 1000 },
    } as const;
    expect(b4ShadowControlMatchKey(base)).toBe(b4ShadowControlMatchKey(changed));
    expect(b4ShadowContextValue(base.funding_state)).toBe("NEUTRAL");
    expect(b4ShadowContextValue(base.mark_index_basis_state)).toBe("POSITIVE");
  });

  it("fails closed until the finalized full-universe context supplies every bucket", () => {
    const result = new B4ShadowEngine({ enabled: true }).evaluate(observation({
      market_regime: "UNKNOWN",
      liquidity_bucket: "UNKNOWN",
      volatility_bucket: "UNKNOWN",
      volatility_value: null,
      liquidity_percentile: null,
    }));
    expect(result.status).toBe("DATA_INCOMPLETE");
    expect(result.reason).toBe("B4_INPUT_INCOMPLETE");
  });

  it("never reuses a claimed control and preserves an unavailable control result", () => {
    const input = observation();
    const migration = readFileSync(resolve(import.meta.dirname, "..", "supabase/migrations/20260909150000_hy_r62c_b4_live_shadow_foundation.sql"), "utf8");
    expect(migration).toContain("unique (claimed_by_event_id)");
    expect(migration).toContain("claimed_by_event_id is null");
    expect(migration).toContain("for update skip locked");
    expect(migration).toContain("unique (symbol, market_timestamp)");
    const event = new B4ShadowEngine({ enabled: true }).evaluate(input).event!;
    expect(event.control_status).toBe("CONTROL_UNAVAILABLE");
    expect(event.control_event_id).toBeNull();
  });

  it("fails closed when batches disagree on the frozen universe", () => {
    const migration = readFileSync(resolve(import.meta.dirname, "..", "supabase/migrations/20260909150000_hy_r62c_b4_live_shadow_foundation.sql"), "utf8");
    expect(migration).toContain("expected_symbols <> v_expected");
    expect(migration).toContain("A context group is one frozen universe snapshot");
  });

  it("uses the exact horizon and complete direction-aware path for MFE/MAE", () => {
    const event = new B4ShadowEngine({ enabled: true }).evaluate(observation()).event!;
    const path = [1, 2, 3, 4].map((hour) => ({
      timestamp: `2026-09-09T0${hour}:00:00.000Z`,
      pit_available_at: `2026-09-09T0${hour + 1}:00:00.000Z`,
      close_price: 100 + hour,
      high_price: hour === 2 ? 110 : 101 + hour,
      low_price: hour === 3 ? 90 : 99,
      observation_closed: true,
    }));
    const outcome = calculateB4ShadowOutcome(event, 4, {
      timestamp: "2026-09-09T04:00:00.000Z",
      pit_available_at: "2026-09-09T05:00:00.000Z",
      close_price: 104,
      high_price: 105,
      low_price: 95,
      observation_closed: true,
      path,
    }, "2026-09-09T06:00:00.000Z");
    expect(outcome?.max_favorable_move).toBeCloseTo(0.1, 12);
    expect(outcome?.max_adverse_move).toBeCloseTo(-0.1, 12);
    expect(calculateB4ShadowOutcome(event, 4, {
      timestamp: "2026-09-09T05:00:00.000Z",
      pit_available_at: "2026-09-09T06:00:00.000Z",
      close_price: 105,
      high_price: 106,
      low_price: 94,
      observation_closed: true,
      path: [...path, { ...path[3], timestamp: "2026-09-09T05:00:00.000Z" }],
    }, "2026-09-09T07:00:00.000Z")).toBeNull();
  });

  it("counts only database NEW_EVENT results and uses DB control fields", async () => {
    const input = observation();
    const event = new B4ShadowEngine({ enabled: true }).evaluate(input).event!;
    let call = 0;
    const result = await runB4ShadowSidecar({
      enabled: true,
      observations: [input],
      persistAndTransition: async () => call++ === 0
        ? { result: "NEW_EVENT", control_status: "AVAILABLE", control_event_id: "db-control", control_match_key: "db-key" }
        : { result: "DUPLICATE_TRUE", control_status: "CONTROL_UNAVAILABLE", control_event_id: null, control_match_key: event.control_match_key },
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].control_event_id).toBe("db-control");
    expect(result.diagnostics.eventsGenerated).toBe(1);
    expect(result.diagnostics.longWatch).toBe(1);
  });
});

function candlesWithHourlyCloses(rate: number) {
  return Array.from({ length: 25 }, (_, index) => ({
    openTime: index * HOUR,
    closeTime: (index + 1) * HOUR - 1,
    open: 100,
    high: Math.exp(rate * index) * 101,
    low: Math.exp(rate * index) * 99,
    close: 100 * Math.exp(rate * index),
    volume: 1,
  }));
}

function candlesWithHourlyQuoteVolumes() {
  return Array.from({ length: 24 }, (_, index) => ({
    openTime: index * HOUR,
    closeTime: (index + 1) * HOUR - 1,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
    quoteVolume: index + 1,
  }));
}

function observation(overrides: Partial<B4ShadowObservation> = {}): B4ShadowObservation {
  return {
    symbol: "BTCUSDT",
    market_timestamp: "2026-09-09T00:00:00.000Z",
    decision_timestamp: "2026-09-09T01:00:00.000Z",
    pit_available_at: "2026-09-09T01:00:00.000Z",
    perpetual_price: 100,
    premium_value: 0.001,
    price_change_value: -0.01,
    premium_change_value: 0.02,
    price_percentile: 0.2,
    premium_change_percentile: 0.8,
    funding_state: { bucket: "NEUTRAL", funding_rate: 0, funding_time: 0 },
    mark_index_basis_state: { bucket: "NEUTRAL", mark_price: 100, index_price: 100, basis_bps: 0 },
    mark_price: 100,
    index_price: 100,
    market_regime: "RANGE",
    volatility_bucket: "NORMAL",
    liquidity_bucket: "HIGH",
    volatility_value: 0.01,
    liquidity_percentile: 0.75,
    calendar_period: "2026-Q3",
    observation_closed: true,
    market_data_complete: true,
    rolling_history_ready: true,
    pit_safe: true,
    ...overrides,
  };
}
