import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  B4_SHADOW_UNIVERSE_HASH,
  B4_SHADOW_UNIVERSE_MANIFEST,
  B4_SHADOW_UNIVERSE_SYMBOLS,
  B4_SHADOW_UNIVERSE_VERSION,
  activeB4ShadowSymbolsAt,
  b4CrossSectionalPercentile,
  b4ShadowClosedHourTimestamp,
  b4ShadowContextGroupKey,
  b4ShadowBatchSymbols,
  calculateB4FourHourReturn,
  calculateB4ShadowControlOutcome,
  classifyB4LiquidityPercentile,
  isB4ShadowSymbolActive,
  matureB4ShadowControlOutcomes,
  resolveB4ShadowUniverse,
} from "../lib/signal-engine";
import type { Instrument } from "../lib/core/types";
import type { B4ShadowControlEvent } from "../lib/signal-engine/b4-shadow-types";
import { b4CollectorBatchCount } from "../lib/services/b4-shadow-collector";

const HOUR = 3_600_000;
const ROOT = resolve(import.meta.dirname, "..");

describe("HY-R6.2C.3 frozen measurement protocol", () => {
  it("matches R5.10A average-rank liquidity, ties, and unavailable singleton", () => {
    expect(b4CrossSectionalPercentile(200, [100, 200, 300])).toBe(0.5);
    expect(classifyB4LiquidityPercentile(b4CrossSectionalPercentile(200, [100, 200, 300]))).toBe("NORMAL");
    expect(b4CrossSectionalPercentile(200, [100, 200, 200, 300])).toBe(0.5);
    expect(b4CrossSectionalPercentile(100, [100])).toBeNull();
    expect(b4CrossSectionalPercentile(200, [100, 200, 300])).not.toBe(2 / 3);
  });

  it("uses the closed 1h t versus t-4h primitive and rejects a 4h pair", () => {
    const hourly = Array.from({ length: 5 }, (_, index) => ({
      openTime: index * HOUR,
      closeTime: (index + 1) * HOUR - 1,
      close: 100 + index * 2,
      high: 101 + index * 2,
      low: 99 + index * 2,
    }));
    expect(calculateB4FourHourReturn(hourly)).toBeCloseTo(108 / 100 - 1, 12);
    expect(calculateB4FourHourReturn([
      { ...hourly[0], closeTime: 4 * HOUR - 1 },
      { ...hourly[4], openTime: 4 * HOUR, closeTime: 8 * HOUR - 1 },
    ])).toBeNull();
  });

  it("locks the 49-symbol R5.10A universe and lifecycle completeness", () => {
    expect(B4_SHADOW_UNIVERSE_VERSION).toBe("hy-b4-shadow-universe-v1");
    expect(B4_SHADOW_UNIVERSE_SYMBOLS).toHaveLength(49);
    expect(B4_SHADOW_UNIVERSE_MANIFEST.universeHash).toBe(B4_SHADOW_UNIVERSE_HASH);
    expect(B4_SHADOW_UNIVERSE_MANIFEST.sourceCommit).toBe("7bb10067df78a1d7cb11e6ab06643fb44dc8e400");
    const timestamp = Date.parse("2026-08-20T00:00:00.000Z");
    expect(activeB4ShadowSymbolsAt(timestamp)).toHaveLength(49);
    expect(isB4ShadowSymbolActive("PUMPUSDT", Date.parse("2025-06-20T00:00:00.000Z"))).toBe(false);
    expect(isB4ShadowSymbolActive("PUMPUSDT", Date.parse("2025-08-01T00:00:00.000Z"))).toBe(true);
    const live = B4_SHADOW_UNIVERSE_SYMBOLS.map(instrument);
    expect(resolveB4ShadowUniverse(live, timestamp).status).toBe("READY");
    expect(resolveB4ShadowUniverse(live.slice(1), timestamp)).toMatchObject({
      status: "CONTEXT_INCOMPLETE",
      symbols: B4_SHADOW_UNIVERSE_SYMBOLS,
      instruments: [],
    });
  });

  it("uses one closed-hour context identity across 15-minute boundaries and batches", () => {
    const first = Date.parse("2026-09-09T09:00:00.000Z");
    const firstRetry = b4ShadowClosedHourTimestamp(Date.parse("2026-09-09T09:15:00.000Z"));
    const secondRetry = b4ShadowClosedHourTimestamp(Date.parse("2026-09-09T09:59:00.000Z"));
    expect(firstRetry).toBe(first - HOUR);
    expect(secondRetry).toBe(first - HOUR);
    expect(b4ShadowContextGroupKey(firstRetry)).toBe(b4ShadowContextGroupKey(secondRetry));
    expect(b4ShadowContextGroupKey(first)).toContain(B4_SHADOW_UNIVERSE_VERSION);
    const batches = Array.from({ length: b4CollectorBatchCount(10) }, (_, batch) =>
      b4ShadowBatchSymbols(B4_SHADOW_UNIVERSE_SYMBOLS, batch, 10)).flat();
    expect(batches).toEqual(B4_SHADOW_UNIVERSE_SYMBOLS);
    expect(new Set(batches).size).toBe(49);
  });

  it("calculates Control-B from the control timestamp and matched direction", () => {
    const control = controlEvent({ direction: "BEARISH", pending_horizons: [1] });
    const future = {
      timestamp: "2026-09-09T01:00:00.000Z",
      pit_available_at: "2026-09-09T02:00:00.000Z",
      close_price: 95,
      high_price: 97,
      low_price: 90,
      observation_closed: true,
      path: [{
        timestamp: "2026-09-09T01:00:00.000Z",
        pit_available_at: "2026-09-09T02:00:00.000Z",
        close_price: 95,
        high_price: 97,
        low_price: 90,
        observation_closed: true,
      }],
    };
    const outcome = calculateB4ShadowControlOutcome(control, 1, future, "2026-09-09T02:00:00.000Z");
    expect(outcome).toMatchObject({
      control_event_id: control.control_event_id,
      direction: "BEARISH",
      reference_price: 100,
      future_price: 95,
    });
    expect(outcome?.signed_return).toBeCloseTo(100 / 95 - 1, 12);
    expect(outcome?.max_favorable_move).toBeCloseTo(100 / 90 - 1, 12);
    expect(outcome?.max_adverse_move).toBeCloseTo(100 / 97 - 1, 12);
  });

  it("matures Control-B with the control timestamp as the future origin", async () => {
    const control = controlEvent({ pending_horizons: [1] });
    let requestedOrigin = "";
    const result = await matureB4ShadowControlOutcomes({
      controls: [control],
      evaluatedAt: "2026-09-09T02:00:00.000Z",
      fetchFutureObservation: async (value) => {
        requestedOrigin = value.market_timestamp;
        return {
          timestamp: "2026-09-09T01:00:00.000Z",
          pit_available_at: "2026-09-09T02:00:00.000Z",
          close_price: 101,
          high_price: 102,
          low_price: 99,
          observation_closed: true,
          path: [{
            timestamp: "2026-09-09T01:00:00.000Z",
            pit_available_at: "2026-09-09T02:00:00.000Z",
            close_price: 101,
            high_price: 102,
            low_price: 99,
            observation_closed: true,
          }],
        };
      },
      persistOutcome: async () => undefined,
    });
    expect(result.matured).toBe(1);
    expect(requestedOrigin).toBe(control.market_timestamp);
  });

  it("records real feature-only R5 provenance and all required outcome-free classes", () => {
    const fixture = JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures/hy-research-freezes/r6.2c-b4-feature-parity.json"), "utf8")) as {
      sourceCommit: string;
      sourceRunnerBlobSha256: string;
      sourceCutoffBlobSha256: string;
      sourceFeatureSpecificationHash: string;
      outcomeFree: boolean;
      samples: Array<{ input: { priorPriceChanges: number[]; priorPremiumChanges: number[] }; expected: { direction: string | null } }>;
    };
    expect(fixture.sourceCommit).toBe("7bb10067df78a1d7cb11e6ab06643fb44dc8e400");
    expect(fixture.sourceRunnerBlobSha256).toBe("5dc0672ecc60a8b68299237a2d9a534f1c05f317");
    expect(fixture.sourceCutoffBlobSha256).toBe("6ec0c67651332a1bf8e56beaed0411d7970f4856");
    expect(fixture.sourceFeatureSpecificationHash).toBe("bbdaab9e4cba4c22e50471d538d808fca992e812aaff60a0fc3f70af6020cf51");
    expect(fixture.outcomeFree).toBe(true);
    expect(fixture.samples).toHaveLength(5);
    expect(fixture.samples.every((sample) => sample.input.priorPriceChanges.length === 720 && sample.input.priorPremiumChanges.length === 720)).toBe(true);
    expect(fixture.samples.some((sample) => sample.expected.direction === "BULLISH")).toBe(true);
    expect(fixture.samples.some((sample) => sample.expected.direction === "BEARISH")).toBe(true);
    expect(fixture.samples.some((sample) => sample.expected.direction === null)).toBe(true);
  });

  it("keeps R5 context and release safety artifacts outcome-free", () => {
    const context = JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures/hy-research-freezes/r5.10a-b4-context-parity.json"), "utf8"));
    expect(context.sourceCommit).toBe("7bb10067df78a1d7cb11e6ab06643fb44dc8e400");
    expect(context.outcomeFree).toBe(true);
    expect(context.sample.fourHourReturns).toHaveLength(49);
    expect(context.sample.quoteVolumePeers).toHaveLength(49);
    expect(context.sample.expected.matchKey).toContain("BTCUSDT|");
    const route = readFileSync(resolve(ROOT, "app/api/scan/route.ts"), "utf8");
    const collector = readFileSync(resolve(ROOT, "app/api/b4-shadow/collect/route.ts"), "utf8");
    const collectorService = readFileSync(resolve(ROOT, "lib/services/b4-shadow-collector.ts"), "utf8");
    expect(route).not.toContain("HY_B4_SHADOW_ENABLED");
    expect(route).not.toContain("runB4ShadowSidecar");
    expect(collectorService).toContain("b4ShadowClosedHourTimestamp");
    expect(collectorService).toContain("getB4LiveHistory");
    expect(collectorService).toContain("getStagedB4ShadowContexts");
    expect(collectorService).toContain("lastEvaluatedClosedBar");
    expect(collectorService).not.toContain("HY_TOP_SYMBOLS");
    expect(collectorService).not.toContain("sendSignalEmail");
    expect(collectorService).not.toContain("getDepth");
    expect(collectorService).not.toContain("getAggTrades");
  });

  it("defines pending-pair starvation protection and read-only R6.3 readiness", () => {
    const migration = readFileSync(resolve(ROOT, "supabase/migrations/20260912130659_hy_r62c_b4_live_shadow_foundation.sql"), "utf8");
    expect(migration).toContain("hy_b4_shadow_pending_signal_maturity");
    expect(migration).toContain("hy_b4_shadow_pending_control_maturity");
    expect(migration).toContain("hy_b4_shadow_metric_readiness");
    expect(migration).toContain("future_performance_not_calculated");
    expect(migration).toContain("hy_b4_shadow_control_outcomes");
    expect(migration).toContain("claim.direction = v_direction");
    expect(migration).toContain("primary key (control_event_id, direction, horizon_hours)");
    expect(migration).toMatch(/limit greatest\(1, least\(coalesce\(p_limit, 100\), 5000\)\)/g);
    expect(migration).not.toContain("claimed_by_event_id");
    expect(migration).toContain("revoke all on function");
    expect(migration).toContain("set search_path = public, pg_temp");
    const scheduler = readFileSync(resolve(ROOT, "supabase/b4-shadow-scheduler.sql"), "utf8");
    expect(scheduler).toContain("DO NOT APPLY");
    expect(scheduler).toContain("b4-shadow/collect?batch=");
  });
});

function instrument(symbol: string): Instrument {
  return {
    symbol,
    baseAsset: symbol.replace(/USDT$/, ""),
    quoteAsset: "USDT",
    contractType: "PERPETUAL",
    status: "TRADING",
    priceTick: 0.01,
    quantityStep: 0.001,
  };
}

function controlEvent(overrides: Partial<B4ShadowControlEvent> = {}): B4ShadowControlEvent {
  return {
    control_event_id: "11111111-1111-4111-8111-111111111111",
    direction: "BULLISH",
    event_id: "22222222-2222-4222-8222-222222222222",
    symbol: "BTCUSDT",
    market_timestamp: "2026-09-09T00:00:00.000Z",
    pit_available_at: "2026-09-09T01:00:00.000Z",
    reference_price: 100,
    pending_horizons: [1, 4, 12, 24],
    ...overrides,
  };
}
