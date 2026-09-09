import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createAlertDelivery,
  createSignalFeedback,
  createSignalFeatureSnapshot,
  createSignalIntelligenceEvent,
  createSignalReplay,
} from "../lib/services/signal-intelligence-repository";
import {
  alertDeliveryInputSchema,
  signalFeedbackInputSchema,
  signalFeatureInputSchema,
  signalIntelligenceEventInputSchema,
  signalReplayInputSchema,
} from "../lib/signal-intelligence/validation";
import { signalIntelligenceTableNames } from "../lib/signal-intelligence/types";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const REFERENCE_TIME = "2026-09-05T00:00:00.000Z";

describe("HY-R4.7 signal intelligence validation", () => {
  it("accepts the four signal types and bounded event scores", () => {
    for (const signal_type of ["LONG_WATCH", "SHORT_WATCH", "RISK_WARNING", "MARKET_STATUS"] as const) {
      const event = signalIntelligenceEventInputSchema.parse({
        symbol: "BTCUSDT",
        signal_type,
        market_regime: "BULL",
        quality_score: 70,
        risk_score: 30,
        confidence: 80,
        reason_codes: ["TEST_REASON"],
        human_explanation: "Human-readable observation.",
        reference_price: 100,
      });

      expect(event.signal_type).toBe(signal_type);
      expect(event.status).toBe("CREATED");
    }

    expect(() => signalIntelligenceEventInputSchema.parse({
      symbol: "BTCUSDT",
      signal_type: "BUY",
      market_regime: "BULL",
      quality_score: 70,
      risk_score: 30,
      confidence: 80,
      reason_codes: [],
      human_explanation: "Invalid type.",
      reference_price: 100,
    })).toThrow();
  });

  it("rejects non-finite or out-of-range scores", () => {
    const base = {
      symbol: "BTCUSDT",
      signal_type: "LONG_WATCH" as const,
      market_regime: "BULL" as const,
      quality_score: 70,
      risk_score: 30,
      confidence: 80,
      reason_codes: ["TEST_REASON"],
      human_explanation: "Human-readable observation.",
      reference_price: 100,
    };

    expect(() => signalIntelligenceEventInputSchema.parse({ ...base, quality_score: 101 })).toThrow();
    expect(() => signalIntelligenceEventInputSchema.parse({ ...base, risk_score: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("requires immutable PIT-safe features and traded feedback direction", () => {
    const features = signalFeatureInputSchema.parse(featureInput());
    expect(features.pit_safe).toBe(true);
    expect(() => signalFeatureInputSchema.parse({ ...featureInput(), pit_safe: false })).toThrow();

    expect(() => signalFeedbackInputSchema.parse({
      signal_id: EVENT_ID,
      user_action: "TRADED",
      rating: 4,
    })).toThrow();
    expect(signalFeedbackInputSchema.parse({
      signal_id: EVENT_ID,
      user_action: "TRADED",
      manual_direction: "LONG",
      rating: 4,
    }).manual_direction).toBe("LONG");
  });

  it("accepts replay placeholders without allowing unsafe PIT values", () => {
    const replay = signalReplayInputSchema.parse({
      signal_id: EVENT_ID,
      reference_timestamp: REFERENCE_TIME,
    });

    expect(replay.pit_safe).toBe(true);
    expect(replay.replay_status).toBe("PENDING");
    expect(() => signalReplayInputSchema.parse({
      signal_id: EVENT_ID,
      reference_timestamp: REFERENCE_TIME,
      pit_safe: false,
    })).toThrow();
  });
});

describe("HY-R4.7 signal intelligence repository", () => {
  it("writes only the new intelligence tables and derives delivery idempotency", async () => {
    const stub = createSupabaseStub();

    await createSignalIntelligenceEvent(stub.client, eventInput());
    await createSignalFeatureSnapshot(stub.client, featureInput());
    await createAlertDelivery(stub.client, {
      signal_id: EVENT_ID,
      email: "reviewer@example.com",
    });
    await createSignalReplay(stub.client, {
      signal_id: EVENT_ID,
      reference_timestamp: REFERENCE_TIME,
    });
    await createSignalFeedback(stub.client, {
      signal_id: EVENT_ID,
      user_action: "WATCHED",
      rating: 5,
    });

    expect(stub.tables).toEqual([
      "hy_signal_intelligence_events",
      "hy_signal_features",
      "hy_alert_delivery",
      "hy_signal_replays",
      "hy_signal_feedback",
    ]);
    expect(stub.rows[2].idempotency_key).toBe(
      EVENT_ID + ":EMAIL:reviewer@example.com",
    );
  });

  it("validates before touching Supabase", async () => {
    const stub = createSupabaseStub();

    await expect(createSignalIntelligenceEvent(stub.client, {
      ...eventInput(),
      quality_score: 200,
    })).rejects.toThrow();

    expect(stub.tables).toEqual([]);
  });
});

describe("HY-R4.7 migration contract", () => {
  it("declares only new hy_ tables and leaves existing hy_signal_events untouched", () => {
    const migrationPath = resolve(
      import.meta.dirname,
      "..",
      "supabase/migrations/20260905090000_hy_r47_signal_intelligence.sql",
    );
    const migration = readFileSync(migrationPath, "utf8");
    const declaredTables = [...migration.matchAll(/create table public\.([a-z0-9_]+)/g)]
      .map((match) => match[1]);

    expect(declaredTables).toEqual(signalIntelligenceTableNames);
    expect(declaredTables.every((name) => name.startsWith("hy_"))).toBe(true);
    expect(migration).not.toContain("alter table public.hy_signal_events");
    expect(migration).not.toContain("drop table public.hy_signal_events");
    expect(migration).toContain("alter table public.hy_signal_intelligence_events enable row level security");
    expect(migration).toContain("revoke all on table");
    expect(migration).toContain("grant select, insert on table public.hy_signal_features to service_role");
    expect(migration).toContain("hy_signal_features_immutable_trigger");
  });

  it("declares the required fields and lifecycle values", () => {
    const migrationPath = resolve(
      import.meta.dirname,
      "..",
      "supabase/migrations/20260905090000_hy_r47_signal_intelligence.sql",
    );
    const migration = readFileSync(migrationPath, "utf8");

    for (const field of [
      "signal_type",
      "quality_score",
      "risk_score",
      "confidence",
      "reason_codes",
      "human_explanation",
      "reference_price",
      "funding_state",
      "open_interest_state",
      "liquidity_state",
      "future_4h_price",
      "future_12h_price",
      "future_24h_price",
      "return_4h",
      "return_12h",
      "return_24h",
      "max_favorable_move",
      "max_adverse_move",
      "user_action",
      "manual_direction",
    ]) {
      expect(migration).toContain(field);
    }

    for (const status of ["CREATED", "DELIVERED", "EXPIRED", "EVALUATED", "DISMISSED"]) {
      expect(migration).toContain("'" + status + "'");
    }
  });
});

function eventInput() {
  return {
    id: EVENT_ID,
    symbol: "BTCUSDT",
    signal_type: "LONG_WATCH" as const,
    created_at: REFERENCE_TIME,
    market_regime: "BULL" as const,
    quality_score: 72,
    risk_score: 28,
    confidence: 81,
    reason_codes: ["TEST_REASON"],
    human_explanation: "Human-readable observation.",
    reference_price: 100,
    status: "CREATED" as const,
  };
}

function featureInput() {
  return {
    signal_id: EVENT_ID,
    trend: { regime: "BULL" },
    momentum: { value: 0.5 },
    volume: { ratio: 1.2 },
    volatility: { percentile: 0.4 },
    funding_state: { percentile: 0.1 },
    open_interest_state: { change: 0.02 },
    liquidity_state: { status: "OK" },
    market_breadth: { advancing: 0.6 },
    captured_at: REFERENCE_TIME,
    pit_safe: true as const,
    snapshot_hash: "snapshot-hash",
  };
}

function createSupabaseStub() {
  const tables: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const client = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          tables.push(table);
          rows.push(row);
          return {
            select() {
              return {
                async single() {
                  return {
                    data: {
                      id: row.id ?? EVENT_ID,
                      created_at: row.created_at ?? REFERENCE_TIME,
                      ...row,
                    },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  return { client, tables, rows };
}
