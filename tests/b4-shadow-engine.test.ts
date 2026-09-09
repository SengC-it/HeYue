import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  B4_SHADOW_TABLE_NAMES,
  B4ShadowEngine,
  b4ShadowOutcomeCacheKey,
  calculateB4ShadowOutcome,
  isB4ShadowEnabled,
  selectPitSafeControlB,
} from "../lib/signal-engine";
import { B4_SHADOW_VERSION } from "../lib/signal-engine/b4-shadow-types";
import { createB4ShadowSignalEvent } from "../lib/services/b4-shadow-repository";
import type { B4ShadowObservation, B4ShadowSignalEvent } from "../lib/signal-engine";

const BASE_TIME = "2026-09-09T00:00:00.000Z";
const ONE_HOUR = 3_600_000;
const EVENT_ID = "11111111-1111-4111-8111-111111111111";

describe("HY-R6.1 B4 shadow engine", () => {
  it("maps frozen bullish B4 divergence to a LONG_WATCH shadow event", () => {
    const result = createEngine().evaluate(observation({ price_percentile: 0.25, premium_change_percentile: 0.75 }));
    expect(result.status).toBe("WOULD_HAVE_ALERTED");
    expect(result.event?.direction).toBe("BULLISH");
    expect(result.event?.alert_type).toBe("LONG_WATCH");
    expect(result.event?.shadow_status).toBe("WOULD_HAVE_ALERTED");
  });

  it("maps frozen bearish B4 divergence to a SHORT_WATCH shadow event", () => {
    const result = createEngine().evaluate(observation({ price_percentile: 0.75, premium_change_percentile: 0.25 }));
    expect(result.status).toBe("WOULD_HAVE_ALERTED");
    expect(result.event?.direction).toBe("BEARISH");
    expect(result.event?.alert_type).toBe("SHORT_WATCH");
  });

  it("does not form an event in the middle state", () => {
    const result = createEngine().evaluate(observation({ price_percentile: 0.5, premium_change_percentile: 0.5 }));
    expect(result.status).toBe("NO_SIGNAL");
    expect(result.event).toBeNull();
  });

  it("forms only on FALSE_TO_TRUE, suppresses TRUE_TO_TRUE, and resets on TRUE_TO_FALSE", () => {
    const engine = createEngine();
    const middle = observation({ price_percentile: 0.5, premium_change_percentile: 0.5 });
    const bullish = observation({ price_percentile: 0.2, premium_change_percentile: 0.8 });
    expect(engine.evaluate(middle).status).toBe("NO_SIGNAL");
    expect(engine.evaluate(bullish).status).toBe("WOULD_HAVE_ALERTED");
    expect(engine.evaluate(bullish).status).toBe("DUPLICATE_SUPPRESSED");
    expect(engine.evaluate(middle).status).toBe("NO_SIGNAL");
    expect(engine.evaluate(bullish).status).toBe("WOULD_HAVE_ALERTED");
  });

  it("fails closed for incomplete PIT, premium, market, and rolling history inputs", () => {
    const cases: Array<[Partial<B4ShadowObservation>, string]> = [
      [{ pit_available_at: "2026-09-09T02:00:00.000Z" }, "PIT_NOT_AVAILABLE"],
      [{ premium_value: null }, "B4_INPUT_INCOMPLETE"],
      [{ market_data_complete: false }, "MARKET_DATA_INCOMPLETE"],
      [{ rolling_history_ready: false }, "B4_INPUT_INCOMPLETE"],
    ];
    for (const [patch, reason] of cases) {
      const result = createEngine().evaluate(observation(patch));
      expect(result.event).toBeNull();
      expect(result.reason).toBe(reason);
    }
  });

  it("retains immutable Funding and Mark/Index event-time context", () => {
    const funding = { bucket: "POSITIVE", rate: 0.0002 };
    const basis = { bucket: "DISCOUNT", mark_price: 99, index_price: 100 };
    const result = createEngine().evaluate(observation({
      funding_state: funding,
      mark_index_basis_state: basis,
    }));
    expect(result.event?.funding_state).toEqual(funding);
    expect(result.event?.mark_index_basis_state).toEqual(basis);
    expect(Object.isFrozen(result.event)).toBe(true);
    expect(Object.isFrozen(result.event?.funding_state)).toBe(true);
  });

  it("matures only closed PIT-safe 1h and 4h outcomes", () => {
    const event = createEvent({ direction: "BULLISH" });
    const evaluatedAt = "2026-09-09T05:00:00.000Z";
    const oneHour = calculateB4ShadowOutcome(event, 1, {
      timestamp: "2026-09-09T01:00:00.000Z",
      pit_available_at: "2026-09-09T02:00:00.000Z",
      close_price: 101,
      high_price: 102,
      low_price: 99,
      observation_closed: true,
    }, evaluatedAt);
    const fourHour = calculateB4ShadowOutcome(event, 4, {
      timestamp: "2026-09-09T04:00:00.000Z",
      pit_available_at: "2026-09-09T05:00:00.000Z",
      close_price: 103,
      high_price: 104,
      low_price: 98,
      observation_closed: true,
    }, evaluatedAt);
    const early = calculateB4ShadowOutcome(event, 4, {
      timestamp: "2026-09-09T03:00:00.000Z",
      pit_available_at: "2026-09-09T04:00:00.000Z",
      close_price: 103,
      high_price: 104,
      low_price: 98,
      observation_closed: true,
    }, evaluatedAt);
    expect(oneHour?.outcome_status).toBe("MATURED");
    expect(fourHour?.outcome_status).toBe("MATURED");
    expect(early).toBeNull();
  });

  it("uses direction-aware bullish and bearish outcome semantics", () => {
    const bullish = createEvent({ direction: "BULLISH", event_id: EVENT_ID });
    const bearish = createEvent({ direction: "BEARISH", event_id: "22222222-2222-4222-8222-222222222222" });
    const future = {
      timestamp: "2026-09-09T01:00:00.000Z",
      pit_available_at: "2026-09-09T02:00:00.000Z",
      close_price: 101,
      high_price: 102,
      low_price: 99,
      observation_closed: true,
    };
    const bullishOutcome = calculateB4ShadowOutcome(bullish, 1, future, "2026-09-09T03:00:00.000Z")!;
    const bearishOutcome = calculateB4ShadowOutcome(bearish, 1, { ...future, close_price: 99 }, "2026-09-09T03:00:00.000Z")!;
    expect(bullishOutcome.signed_return).toBeGreaterThan(0);
    expect(bearishOutcome.signed_return).toBeGreaterThan(0);
    expect(b4ShadowOutcomeCacheKey(bullish, 1)).not.toBe(b4ShadowOutcomeCacheKey(bearish, 1));
  });

  it("selects only a PIT-safe Control B and excludes B4 feature strength", () => {
    const input = observation({
      funding_state: { bucket: "NEUTRAL" },
      mark_index_basis_state: { bucket: "NEUTRAL" },
    });
    const selected = selectPitSafeControlB(input, [
      {
        control_event_id: "future-control",
        symbol: "BTCUSDT",
        calendar_period: "2026-Q3",
        market_regime: "BULL",
        volatility_bucket: "NORMAL",
        liquidity_bucket: "LIQUID",
        funding_state: "bucket=NEUTRAL",
        mark_index_basis_state: "bucket=NEUTRAL",
        pit_available_at: "2026-09-09T02:00:00.000Z",
      },
      {
        control_event_id: "legal-control",
        symbol: "BTCUSDT",
        calendar_period: "2026-Q3",
        market_regime: "BULL",
        volatility_bucket: "NORMAL",
        liquidity_bucket: "LIQUID",
        funding_state: "bucket=NEUTRAL",
        mark_index_basis_state: "bucket=NEUTRAL",
        pit_available_at: "2026-09-09T01:00:00.000Z",
      },
    ]);
    expect(selected.status).toBe("AVAILABLE");
    expect(selected.control_event_id).toBe("legal-control");
    expect(selected.match_key).not.toContain("percentile");
  });

  it("reports CONTROL_UNAVAILABLE rather than deleting a signal", () => {
    const input = observation();
    const selected = selectPitSafeControlB(input, []);
    expect(selected.status).toBe("CONTROL_UNAVAILABLE");
    expect(selected.control_event_id).toBeNull();
  });

  it("defaults the feature flag to disabled and writes only the shadow table", async () => {
    expect(isB4ShadowEnabled({})).toBe(false);
    expect(isB4ShadowEnabled({ HY_B4_SHADOW_ENABLED: "false" })).toBe(false);
    expect(isB4ShadowEnabled({ HY_B4_SHADOW_ENABLED: "true" })).toBe(true);

    const event = createEvent();
    const tables: string[] = [];
    const client = {
      from(table: string) {
        return {
          insert(row: Record<string, unknown>) {
            tables.push(table);
            return {
              select() {
                return { async single() { return { data: row, error: null }; } };
              },
            };
          },
        };
      },
    } as unknown as SupabaseClient;
    await createB4ShadowSignalEvent(client, event);
    expect(tables).toEqual(["hy_shadow_signal_events"]);
  });
});

describe("HY-R6.1 safety and storage contracts", () => {
  it("declares the two new HY namespace tables with RLS and immutable events", () => {
    const migration = readFileSync(resolve(import.meta.dirname, "..", "supabase/migrations/20260909133000_hy_r61_b4_shadow_signal_engine.sql"), "utf8");
    const declaredTables = [...migration.matchAll(/create table public\.([a-z0-9_]+)/g)].map((match) => match[1]);
    expect(declaredTables).toEqual([...B4_SHADOW_TABLE_NAMES]);
    expect(declaredTables.every((name) => name.startsWith("hy_"))).toBe(true);
    expect(migration).toContain("alter table public.hy_shadow_signal_events enable row level security");
    expect(migration).toContain("hy_shadow_signal_events_immutable_trigger");
    expect(migration).toContain("revoke all on table");
    expect(migration).not.toMatch(/create table public\.hy_signal_events/);
  });

  it("keeps the shadow module free of email, private API, order, and PAPER wiring", () => {
    const source = readFileSync(resolve(import.meta.dirname, "..", "lib/signal-engine/b4-shadow.ts"), "utf8");
    const repository = readFileSync(resolve(import.meta.dirname, "..", "lib/services/b4-shadow-repository.ts"), "utf8");
    expect(source + repository).not.toMatch(/nodemailer|SMTP|hy_notifications|private.*api|create.?order|leverage/i);
    expect(source + repository).not.toContain("hy-paper-candidate-v2");
  });
});

function createEngine(): B4ShadowEngine {
  let nextId = 0;
  return new B4ShadowEngine({
    enabled: true,
    idFactory: () => `11111111-1111-4111-8111-${String(++nextId).padStart(12, "0")}`,
  });
}

function createEvent(overrides: Partial<B4ShadowSignalEvent> = {}): B4ShadowSignalEvent {
  const engine = new B4ShadowEngine({ enabled: true, idFactory: () => EVENT_ID });
  const result = engine.evaluate(observation({
    price_percentile: overrides.direction === "BEARISH" ? 0.8 : 0.2,
    premium_change_percentile: overrides.direction === "BEARISH" ? 0.2 : 0.8,
  }));
  return { ...result.event!, ...overrides };
}

function observation(overrides: Partial<B4ShadowObservation> = {}): B4ShadowObservation {
  return {
    symbol: "BTCUSDT",
    market_timestamp: BASE_TIME,
    decision_timestamp: "2026-09-09T01:00:00.000Z",
    pit_available_at: "2026-09-09T01:00:00.000Z",
    perpetual_price: 100,
    premium_value: 0.001,
    price_change_value: -0.01,
    premium_change_value: 0.02,
    price_percentile: 0.2,
    premium_change_percentile: 0.8,
    funding_state: { bucket: "NEUTRAL", rate: 0 },
    mark_index_basis_state: { bucket: "NEUTRAL", basis: 0 },
    mark_price: 100,
    index_price: 100,
    market_regime: "BULL",
    volatility_bucket: "NORMAL",
    liquidity_bucket: "LIQUID",
    calendar_period: "2026-Q3",
    observation_closed: true,
    market_data_complete: true,
    rolling_history_ready: true,
    pit_safe: true,
    ...overrides,
  };
}
