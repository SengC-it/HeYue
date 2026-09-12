import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { BinancePublicClient } from "../lib/binance/public-client";
import {
  beginB4ShadowObservation,
  markB4ShadowDisabled,
  parseRuntimeState,
} from "../lib/services/b4-shadow-runtime-repository";
import { collectB4ShadowBatch } from "../lib/services/b4-shadow-collector";
import { B4ShadowEngine, runB4ShadowSidecar } from "../lib/signal-engine";
import type { B4ShadowObservation } from "../lib/signal-engine/b4-shadow-types";
import { b4ShadowHttpStatus } from "../app/api/b4-shadow/collect/route";
import type { ServerConfig } from "../lib/config";

const ROOT = resolve(import.meta.dirname, "..");
const R62C_MIGRATION = resolve(ROOT, "supabase/migrations/20260912130659_hy_r62c_b4_live_shadow_foundation.sql");
const R61_MIGRATION = resolve(ROOT, "supabase/migrations/20260909132405_hy_r61_b4_shadow_signal_engine.sql");
const HOTFIX_MIGRATION_PATH = resolveHotfixMigrationPath();
const HOTFIX_MIGRATION = readFileSync(HOTFIX_MIGRATION_PATH, "utf8");
const FIXTURE_PATH = resolve(ROOT, "tests/fixtures/hy-r6.2d1-b4-outcome-free-events.json");

describe("HY-R6.2D.1 persistence and runtime remediation", () => {
  it("keeps the applied R6.2C body unchanged and locks the additive hotfix", () => {
    const r62cBody = readFileSync(R62C_MIGRATION, "utf8").replace(/\r\n/g, "\n");
    expect(createHash("sha256").update(r62cBody).digest("hex").toUpperCase())
      .toBe("9E4C4BAC906EC90DF89C2430BFB5AC0818B7E2B7E58C45FDC84D2E234713C461");
    expect(readFileSync(R62C_MIGRATION, "utf8")).toContain("create table public.hy_b4_shadow_runtime_state");
    expect(readFileSync(R62C_MIGRATION, "utf8")).not.toContain("observation_started_at");
    expect(HOTFIX_MIGRATION).toContain("add column if not exists observation_started_at timestamptz");
    expect(HOTFIX_MIGRATION).toContain("v_control_event_id::text");
    expect(HOTFIX_MIGRATION).toContain("pit_available_at >= v_observation_started_at");
    expect(HOTFIX_MIGRATION).toContain("create or replace function public.hy_b4_shadow_begin_observation");
    expect(HOTFIX_MIGRATION).toContain("create or replace function public.hy_b4_shadow_mark_disabled");
    expect(HOTFIX_MIGRATION).toMatch(/security definer[\s\S]*set search_path = public, pg_temp/);
    expect(HOTFIX_MIGRATION).not.toMatch(/^\s*create table public\./m);

    const scheduler = readFileSync(resolve(ROOT, "supabase/b4-shadow-scheduler.sql"), "utf8");
    expect(scheduler).toContain("timeout_milliseconds := 60000");
    for (const batch of [0, 1, 2, 3, 4]) expect(scheduler).toContain(`b4-shadow/collect?batch=${batch}`);
    expect(scheduler).toContain("'5 * * * *'");
    expect(scheduler).toContain("'9 * * * *'");
  });

  it("keeps BANK and TAO bullish fixtures outcome-free and event-time only", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
      outcomeFree: boolean;
      observations: B4ShadowObservation[];
    };
    expect(fixture.outcomeFree).toBe(true);
    expect(fixture.observations.map((value) => value.symbol)).toEqual(["BANKUSDT", "TAOUSDT"]);
    expect(JSON.stringify(fixture)).not.toMatch(/future_price|future_return|mfe|mae|profit|outcome_status/i);
    for (const [index, observation] of fixture.observations.entries()) {
      const result = new B4ShadowEngine({
        enabled: true,
        idFactory: () => `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
      }).evaluate(observation);
      expect(result.status).toBe("WOULD_HAVE_ALERTED");
      expect(result.direction).toBe("BULLISH");
      expect(result.event?.alert_type).toBe("LONG_WATCH");
    }
  });

  it("classifies sidecar persistence failure as FAILED with a surfaced error", async () => {
    const observation = (JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
      observations: B4ShadowObservation[];
    }).observations[0];
    const result = await runB4ShadowSidecar({
      enabled: true,
      observations: [observation],
      persistAndTransition: async () => {
        throw new Error("synthetic persistence failure");
      },
    });
    expect(result.status).toBe("FAILED");
    expect(result.diagnostics.status).toBe("FAILED");
    expect(result.diagnostics.lastError).toBe("synthetic persistence failure");
    expect(result.errors).toEqual([{ symbol: "BANKUSDT", message: "synthetic persistence failure" }]);
    expect(b4ShadowHttpStatus("FAILED")).toBe(503);
    expect(b4ShadowHttpStatus("FINALIZED")).toBe(200);
  });

  it("starts and disables the observation epoch through service-role RPCs", async () => {
    const calls: string[] = [];
    const supabase = {
      rpc: async (name: string) => {
        calls.push(name);
        return name === "hy_b4_shadow_begin_observation"
          ? { data: "2026-09-12T13:30:00.000Z", error: null }
          : { data: null, error: null };
      },
    } as unknown as SupabaseClient;
    await expect(beginB4ShadowObservation(supabase, "2026-09-12T13:30:00.000Z"))
      .resolves.toBe("2026-09-12T13:30:00.000Z");
    await expect(markB4ShadowDisabled(supabase)).resolves.toBeUndefined();
    expect(calls).toEqual(["hy_b4_shadow_begin_observation", "hy_b4_shadow_mark_disabled"]);
    expect(parseRuntimeState({
      enabled: false,
      status: "DISABLED",
      observation_started_at: null,
    })).toMatchObject({ enabled: false, status: "DISABLED", observationStartedAt: null });
  });

  it("excludes a pre-observation bar before any universe or context work", async () => {
    const supabase = {
      rpc: async (name: string) => name === "hy_b4_shadow_begin_observation"
        ? { data: "2026-09-12T13:45:00.000Z", error: null }
        : { data: null, error: null },
    } as unknown as SupabaseClient;
    let universeCalls = 0;
    const client = {
      getUniverse: async () => {
        universeCalls += 1;
        throw new Error("pre-observation must not fetch the universe");
      },
    } as unknown as BinancePublicClient;
    const result = await collectB4ShadowBatch({
      client,
      supabase,
      config: { HY_SCAN_BATCH_SIZE: 10 } as unknown as ServerConfig,
      batchNumber: 0,
      now: Date.parse("2026-09-12T13:45:00.000Z"),
    });
    expect(result.status).toBe("PRE_OBSERVATION");
    expect(result.eventsGenerated).toBe(0);
    expect(result.stagedSymbols).toEqual([]);
    expect(result.observationStartedAt).toBe("2026-09-12T13:45:00.000Z");
    expect(universeCalls).toBe(0);
  });
});

describe("HY-R6.2D.1 disposable PostgreSQL contract", () => {
  it.skipIf(!process.env.HY_TEST_POSTGRES_URL || process.env.HY_TEST_POSTGRES_EPHEMERAL !== "true")(
    "executes schema, hotfix, atomic event persistence, and durable disable", () => {
      const databaseUrl = process.env.HY_TEST_POSTGRES_URL!;
      psql(databaseUrl, ["--command", "drop schema public cascade; create schema public; grant all on schema public to public;"]);
      psql(databaseUrl, ["--command", "create extension if not exists pgcrypto;"]);
      psql(databaseUrl, ["--command", "do $roles$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if; if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if; if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if; end $roles$;"]);
      psql(databaseUrl, ["--file", R61_MIGRATION]);
      psql(databaseUrl, ["--file", R62C_MIGRATION]);
      psql(databaseUrl, ["--file", HOTFIX_MIGRATION_PATH]);

      expect(query(databaseUrl, "select relrowsecurity::text from pg_class where relname = 'hy_shadow_signal_events';")).toBe("true");
      expect(query(databaseUrl, "select relrowsecurity::text from pg_class where relname = 'hy_b4_shadow_runtime_state';")).toBe("true");
      expect(query(databaseUrl, "select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.hy_shadow_signal_events'::regclass and attname = 'control_event_id';"))
        .toBe("text");
      expect(query(databaseUrl, "select public.hy_b4_shadow_begin_observation('2026-09-12T13:30:00Z');"))
        .toContain("2026-09-12 13:30:00");

      const controlEventId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      psql(databaseUrl, ["--command", `insert into public.hy_b4_shadow_control_candidates (control_event_id, symbol, market_timestamp, pit_available_at, reference_price, calendar_period, market_regime, volatility_bucket, liquidity_bucket, funding_bucket, mark_index_basis_bucket, source) values ('${controlEventId}', 'BANKUSDT', '2026-09-12T13:00:00Z', '2026-09-12T14:00:00Z', 100, '2026-Q3', 'RANGE', 'NORMAL', 'HIGH', 'NEUTRAL', 'NEUTRAL', 'B4_NON_EVENT');`]);
      psql(databaseUrl, ["--command", "insert into public.hy_b4_shadow_control_candidates (control_event_id, symbol, market_timestamp, pit_available_at, reference_price, calendar_period, market_regime, volatility_bucket, liquidity_bucket, funding_bucket, mark_index_basis_bucket, source) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'TAOUSDT', '2026-09-12T12:00:00Z', '2026-09-12T13:00:00Z', 200, '2026-Q3', 'RANGE', 'NORMAL', 'HIGH', 'NEUTRAL', 'NEUTRAL', 'B4_NON_EVENT');"]);

      const failedEvent = eventPayload("BANKUSDT", 100, "11111111-1111-4111-8111-111111111111", "episode-failed");
      psql(databaseUrl, ["--command", "create or replace function public.hy_test_fail_claim() returns trigger language plpgsql as $$ begin raise exception 'synthetic atomicity failure'; end; $$; create trigger hy_test_fail_claim before insert on public.hy_b4_shadow_control_claims for each row execute function public.hy_test_fail_claim();"]);
      expect(() => psql(databaseUrl, ["--command", `select public.hy_b4_shadow_transition_and_insert(${jsonSql(failedEvent)});`])).toThrow();
      expect(query(databaseUrl, "select count(*)::text from public.hy_shadow_signal_events;")).toBe("0");
      expect(query(databaseUrl, "select count(*)::text from public.hy_b4_shadow_feature_state;")).toBe("0");
      psql(databaseUrl, ["--command", "drop trigger hy_test_fail_claim on public.hy_b4_shadow_control_claims; drop function public.hy_test_fail_claim();"]);

      const success = JSON.parse(query(databaseUrl, `select public.hy_b4_shadow_transition_and_insert(${jsonSql(failedEvent)});`)) as Record<string, unknown>;
      expect(success.result).toBe("NEW_EVENT");
      expect(success.control_status).toBe("AVAILABLE");
      expect(query(databaseUrl, "select count(*)::text from public.hy_shadow_signal_events;")).toBe("1");
      expect(query(databaseUrl, "select count(*)::text from public.hy_b4_shadow_control_claims;")).toBe("1");
      expect(query(databaseUrl, "select control_event_id from public.hy_shadow_signal_events;")).toBe(controlEventId);
      expect(query(databaseUrl, "select count(*)::text from public.hy_b4_shadow_control_candidates where pit_available_at < '2026-09-12T13:30:00Z' and control_event_id not in (select control_event_id from public.hy_b4_shadow_control_claims);")).toBe("1");

      const noControl = eventPayload("TAOUSDT", 200, "22222222-2222-4222-8222-222222222222", "episode-null-control");
      const nullControl = JSON.parse(query(databaseUrl, `select public.hy_b4_shadow_transition_and_insert(${jsonSql(noControl)});`)) as Record<string, unknown>;
      expect(nullControl.result).toBe("NEW_EVENT");
      expect(nullControl.control_event_id).toBeNull();
      expect(query(databaseUrl, "select count(*)::text from public.hy_shadow_signal_events;")).toBe("2");

      const preObservation = eventPayload("BANKUSDT", 100, "33333333-3333-4333-8333-333333333333", "episode-pre-observation", {
        market_timestamp: "2026-09-12T12:00:00.000Z",
        pit_available_at: "2026-09-12T13:00:00.000Z",
        created_at: "2026-09-12T13:00:00.000Z",
      });
      const preResult = JSON.parse(query(databaseUrl, `select public.hy_b4_shadow_transition_and_insert(${jsonSql(preObservation)});`)) as Record<string, unknown>;
      expect(preResult.result).toBe("PRE_OBSERVATION");
      expect(query(databaseUrl, "select count(*)::text from public.hy_shadow_signal_events;")).toBe("2");

      psql(databaseUrl, ["--command", "select public.hy_b4_shadow_mark_disabled();"]);
      expect(query(databaseUrl, "select enabled::text || '|' || status || '|' || coalesce(observation_started_at::text, 'NULL') from public.hy_b4_shadow_runtime_state where singleton_key = 'B4';"))
        .toMatch(/^false\|DISABLED\|NULL$/);
      expect(query(databaseUrl, "select count(*)::text from public.hy_shadow_signal_events;")).toBe("2");
    }, 30_000,
  );
});

function resolveHotfixMigrationPath(): string {
  const file = readdirSync(resolve(ROOT, "supabase/migrations"))
    .find((name) => /^202609\d+_hy_r62d1_b4_persistence_runtime_hotfix\.sql$/.test(name));
  if (!file) throw new Error("B4 persistence hotfix migration not found");
  return resolve(ROOT, "supabase/migrations", file);
}

function psql(databaseUrl: string, args: string[]): string {
  try {
    return execFileSync("psql", ["--dbname", databaseUrl, "--set", "ON_ERROR_STOP=1", ...args], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("disposable PostgreSQL contract command failed");
  }
}

function query(databaseUrl: string, sql: string): string {
  return psql(databaseUrl, ["--tuples-only", "--no-align", "--command", sql]).trim();
}

function jsonSql(value: Record<string, unknown>): string {
  return `$hy_event$${JSON.stringify(value)}$hy_event$::jsonb`;
}

function eventPayload(
  symbol: string,
  price: number,
  eventId: string,
  episodeKey: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    event_id: eventId,
    episode_key: episodeKey,
    experiment: "HY-R6.1",
    version: "hy-b4-shadow-v1",
    created_at: "2026-09-12T15:00:00.000Z",
    market_timestamp: "2026-09-12T14:00:00.000Z",
    pit_available_at: "2026-09-12T15:00:00.000Z",
    symbol,
    direction: "BULLISH",
    alert_type: "LONG_WATCH",
    family: "B4",
    hypothesis: "DIVERGENCE_REVERSAL",
    feature_version: "hy-r5.7-basis-premium-frozen-v1",
    cutoff_version: "hy-r5.8a1-basis-premium-event-cutoff-v1",
    perpetual_price: price,
    premium_value: 0.001,
    price_change_value: -0.01,
    premium_change_value: 0.02,
    price_percentile: 0.2,
    premium_change_percentile: 0.8,
    funding_state: { bucket: "NEUTRAL", rate: 0 },
    mark_index_basis_state: { bucket: "NEUTRAL", basis_bps: 0 },
    market_regime: "RANGE",
    volatility_bucket: "NORMAL",
    liquidity_bucket: "HIGH",
    calendar_period: "2026-Q3",
    data_completeness: "COMPLETE",
    pit_status: "PASS",
    dedup_state: "NEW_FALSE_TO_TRUE",
    shadow_status: "WOULD_HAVE_ALERTED",
    ...overrides,
  };
}
