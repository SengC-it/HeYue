import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  B4ShadowEngine,
  buildB4ShadowObservationFromSnapshot,
  getB4ShadowHealthDiagnostics,
  runB4ShadowSidecar,
} from "../lib/signal-engine";
import {
  createB4ShadowSignalEvent,
  createB4ShadowSignalOutcome,
} from "../lib/services/b4-shadow-repository";
import type { B4ShadowObservation, B4ShadowOutcome, B4ShadowSignalEvent } from "../lib/signal-engine";
import type { MarketSnapshot } from "../lib/core/types";

const EVENT_ID = "33333333-3333-4333-8333-333333333333";

describe("HY-R6.2A sidecar and retry isolation", () => {
  it("does no evaluation, persistence, or other side effects when the flag is false", async () => {
    let persisted = 0;
    const result = await runB4ShadowSidecar({
      enabled: false,
      observations: [completeObservation()],
      persistEvent: async () => { persisted += 1; },
    });
    expect(result.status).toBe("DISABLED");
    expect(result.events).toHaveLength(0);
    expect(result.diagnostics.conditionsEvaluated).toBe(0);
    expect(result.diagnostics.eventsGenerated).toBe(0);
    expect(persisted).toBe(0);
  });

  it("runs as an isolated sidecar and records generated events without email side effects", async () => {
    const persisted: B4ShadowSignalEvent[] = [];
    const result = await runB4ShadowSidecar({
      enabled: true,
      observations: [
        completeObservation({ price_percentile: 0.5, premium_change_percentile: 0.5 }),
        completeObservation(),
      ],
      persistEvent: async (event) => { persisted.push(event); },
    });
    expect(result.status).toBe("READY");
    expect(result.events).toHaveLength(1);
    expect(persisted).toHaveLength(1);
    expect(result.diagnostics.longWatch).toBe(1);
    expect(result.diagnostics.emailSent).toBe(0);
  });

  it("degrades instead of failing the PAPER scanner when a sidecar observation is malformed", async () => {
    const result = await runB4ShadowSidecar({
      enabled: true,
      observations: [{ symbol: "BROKEN" } as unknown as B4ShadowObservation],
    });
    expect(result.status).toBe("DEGRADED");
    expect(result.events).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
  });

  it("keeps the existing snapshot path fail-closed until B4 rolling Premium data exists", () => {
    const snapshot: MarketSnapshot = {
      instrument: {
        symbol: "BTCUSDT",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        contractType: "PERPETUAL",
        status: "TRADING",
        priceTick: 0.01,
        quantityStep: 0.001,
      },
      tickerPrice: 100,
      candles: {},
      sourceTimestamp: Date.parse("2026-09-09T00:00:00.000Z"),
      microstructure: {
        depthUpdateId: 1,
        depthTimestamp: 1,
        bestBidPrice: 99,
        bestAskPrice: 101,
        bidAskSpreadBps: 200,
        topBidNotional: 1000,
        topAskNotional: 1000,
        orderBookImbalance: 0,
        aggregateTradeCount: 1,
        aggregateTradeQuoteVolume: 100,
        aggressiveBuyQuoteVolume: 50,
        aggressiveBuyRatio: 0.5,
        markPrice: 100,
        indexPrice: 100,
        markIndexBasisBps: 0,
        fundingRate: 0,
        nextFundingTime: Date.parse("2026-09-09T08:00:00.000Z"),
        openInterest: 100,
        sourceTimestamp: Date.parse("2026-09-09T00:00:00.000Z"),
      },
    };
    const observation = buildB4ShadowObservationFromSnapshot(snapshot, Date.parse("2026-09-09T01:00:00.000Z"));
    expect(observation.premium_value).toBeNull();
    expect(observation.rolling_history_ready).toBe(false);
    expect(observation.market_data_complete).toBe(false);
  });

  it("uses a deterministic default event identity for retry-safe inserts", () => {
    const first = new B4ShadowEngine({ enabled: true }).evaluate(completeObservation());
    const second = new B4ShadowEngine({ enabled: true }).evaluate(completeObservation());
    expect(first.event?.event_id).toBe(second.event?.event_id);
    expect(first.event?.episode_key).toBe(second.event?.episode_key);
  });

  it("returns disabled health telemetry without evaluating when the flag is false", () => {
    const diagnostics = getB4ShadowHealthDiagnostics(false);
    expect(diagnostics).toMatchObject({
      enabled: false,
      status: "DISABLED",
      version: "hy-b4-shadow-v1",
      emailSent: 0,
    });
  });
});

describe("HY-R6.2A repository idempotency and migration audit", () => {
  it("returns the canonical existing event on an episode-key conflict", async () => {
    const event = new B4ShadowEngine({ enabled: true }).evaluate(completeObservation()).event!;
    const stub = createIdempotencyStub(event, null);
    const first = await createB4ShadowSignalEvent(stub.client, event);
    const second = await createB4ShadowSignalEvent(stub.client, event);
    expect(first.event_id).toBe(second.event_id);
    expect(stub.insertCount).toBe(2);
    expect(stub.lookupCount).toBe(1);
  });

  it("uses event_id plus horizon as the canonical outcome identity", async () => {
    const event = new B4ShadowEngine({ enabled: true }).evaluate(completeObservation()).event!;
    const outcome: B4ShadowOutcome = {
      event_id: event.event_id,
      direction: event.direction,
      horizon_hours: 1,
      future_observation_timestamp: "2026-09-09T01:00:00.000Z",
      future_available_at: "2026-09-09T02:00:00.000Z",
      future_price: 101,
      signed_return: 0.01,
      max_favorable_move: 0.02,
      max_adverse_move: -0.01,
      pit_safe: true,
      outcome_status: "MATURED",
      calculation_version: "hy-b4-shadow-v1",
    };
    const stub = createIdempotencyStub(null, outcome);
    const first = await createB4ShadowSignalOutcome(stub.client, outcome);
    const second = await createB4ShadowSignalOutcome(stub.client, outcome);
    expect(first.event_id).toBe(second.event_id);
    expect(stub.lookupCount).toBe(1);
  });

  it("audits only new HY shadow tables, unique identities, RLS, and no client secret exposure", () => {
    const migration = readFileSync(resolve(import.meta.dirname, "..", "supabase/migrations/20260909132405_hy_r61_b4_shadow_signal_engine.sql"), "utf8");
    expect(migration).toContain("unique (episode_key)");
    expect(migration).toContain("unique (event_id, horizon_hours)");
    expect(migration).toContain("alter table public.hy_shadow_signal_events enable row level security");
    expect(migration).toContain("revoke all on table");
    expect(migration).not.toMatch(/create table public\.(?!hy_shadow_signal_)[a-z0-9_]+/);

    const browserPage = readFileSync(resolve(import.meta.dirname, "..", "app/page.tsx"), "utf8");
    const repository = readFileSync(resolve(import.meta.dirname, "..", "lib/services/b4-shadow-repository.ts"), "utf8");
    expect(browserPage).not.toContain("b4-shadow-repository");
    expect(repository).not.toMatch(/NEXT_PUBLIC|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY/);
  });

  it("keeps the scanner route PAPER path and email path independent of the shadow sidecar", () => {
    const route = readFileSync(resolve(import.meta.dirname, "..", "app/api/scan/route.ts"), "utf8");
    expect(route).toContain("HY_B4_SHADOW_ENABLED");
    expect(route).toContain("runB4ShadowSidecar");
    expect(route).toContain("runtimeConfig.HY_MICROSTRUCTURE_ENABLED || runtimeConfig.HY_B4_SHADOW_ENABLED");
    expect(route).toContain("createPaperTrade");
    expect(route).toContain("sendSignalEmail");
    expect(route).not.toContain("hy-paper-candidate-v2");
  });
});

function completeObservation(overrides: Partial<B4ShadowObservation> = {}): B4ShadowObservation {
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
    funding_state: { bucket: "NEUTRAL", rate: 0 },
    mark_index_basis_state: { bucket: "NEUTRAL", basis_bps: 0 },
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

function createIdempotencyStub(
  event: B4ShadowSignalEvent | null,
  outcome: B4ShadowOutcome | null,
) {
  let eventInsertCount = 0;
  let outcomeInsertCount = 0;
  let lookupCount = 0;
  const client = {
    from(table: string) {
      return {
        insert() {
          if (table === "hy_shadow_signal_events") eventInsertCount += 1;
          else outcomeInsertCount += 1;
          return {
            select() {
              return {
                async single() {
                  const isConflict = table === "hy_shadow_signal_events"
                    ? eventInsertCount > 1
                    : outcomeInsertCount > 1;
                  return isConflict
                    ? { data: null, error: { code: "23505", message: "duplicate" } }
                    : { data: event ?? outcome, error: null };
                },
              };
            },
          };
        },
        select() {
          return {
            eq() {
              lookupCount += 1;
              return {
                eq() {
                  return {
                    async single() { return { data: event ?? outcome, error: null }; },
                  };
                },
                async single() { return { data: event ?? outcome, error: null }; },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return {
    client,
    get insertCount() { return eventInsertCount + outcomeInsertCount; },
    get lookupCount() { return lookupCount; },
  };
}
