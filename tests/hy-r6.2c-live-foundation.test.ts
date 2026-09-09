import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  B4_LIVE_RAW_BAR_REQUIREMENT,
  B4_LIVE_ROLLING_LOOKBACK,
  buildB4LiveObservation,
  empiricalPercentile,
  matureB4ShadowOutcomes,
} from "../lib/signal-engine";
import { B4ShadowEngine } from "../lib/signal-engine/b4-shadow";
import type {
  B4LiveBar,
  B4LiveHistory,
} from "../lib/signal-engine/b4-live-features";
import type { B4ShadowObservation } from "../lib/signal-engine/b4-shadow-types";
import { runB4ShadowSidecar } from "../lib/signal-engine/b4-shadow-sidecar";
import { readHyEnv } from "../lib/config";

const HOUR = 3_600_000;
const BASE_TIME = Date.parse("2025-01-01T00:00:00.000Z");

describe("HY-R6.2C B4 live feature foundation", () => {
  it("uses the frozen 720 strictly prior empirical percentile", () => {
    expect(empiricalPercentile(3, [1, 2, 3, 4])).toBe(0.75);
    expect(empiricalPercentile(0, [1, 2, 3, 4])).toBe(0);
    expect(empiricalPercentile(5, [1, 2, 3, 4])).toBe(1);
  });

  it("builds complete PIT-safe B4 features from aligned closed histories", () => {
    const history = createHistory(B4_LIVE_RAW_BAR_REQUIREMENT);
    const decisionTime = BASE_TIME + B4_LIVE_RAW_BAR_REQUIREMENT * HOUR;
    const result = buildB4LiveObservation(history, decisionTime);
    expect(result.status).toBe("READY");
    expect(result.observation.rolling_history_ready).toBe(true);
    expect(result.observation.market_data_complete).toBe(true);
    expect(result.observation.observation_closed).toBe(true);
    expect(result.observation.pit_available_at).toBe(
      new Date(BASE_TIME + (B4_LIVE_RAW_BAR_REQUIREMENT - 1) * HOUR + HOUR).toISOString(),
    );
    expect(result.historicalPrimitiveCount).toBe(B4_LIVE_ROLLING_LOOKBACK);
    expect(result.observation.funding_state).toMatchObject({ funding_rate: 0.0001 });
    expect(result.observation.mark_index_basis_state).toMatchObject({ mark_price: 102, index_price: 100 });
  });

  it("stops at warmup and does not shorten history after a gap", () => {
    const short = createHistory(20);
    const warmup = buildB4LiveObservation(short, BASE_TIME + 21 * HOUR);
    expect(warmup.status).toBe("WARMING_UP");
    expect(warmup.observation.market_data_complete).toBe(false);

    const gapped = createHistory(B4_LIVE_RAW_BAR_REQUIREMENT);
    gapped.priceBars = gapped.priceBars.filter((bar) => bar.openTime !== BASE_TIME + 100 * HOUR);
    const result = buildB4LiveObservation(gapped, BASE_TIME + B4_LIVE_RAW_BAR_REQUIREMENT * HOUR);
    expect(result.status).toBe("WARMING_UP");
    expect(result.observation.rolling_history_ready).toBe(false);
    expect(result.observation.price_percentile).toBeNull();
  });

  it("does not accept a still-open current bar", () => {
    const history = createHistory(B4_LIVE_RAW_BAR_REQUIREMENT);
    const result = buildB4LiveObservation(history, BASE_TIME + (B4_LIVE_RAW_BAR_REQUIREMENT - 1) * HOUR + HOUR - 1);
    expect(result.status).toBe("PIT_REJECTED");
    expect(result.observation.market_data_complete).toBe(false);
  });

  it("uses the durable primitive tail for incremental and unchanged evaluations", () => {
    const bootstrapHistory = createHistory(B4_LIVE_RAW_BAR_REQUIREMENT);
    const bootstrap = buildB4LiveObservation(
      bootstrapHistory,
      BASE_TIME + B4_LIVE_RAW_BAR_REQUIREMENT * HOUR,
    );
    expect(bootstrap.historyMode).toBe("BOOTSTRAP");

    const extended = createHistory(B4_LIVE_RAW_BAR_REQUIREMENT + 1);
    const tail = {
      ...extended,
      priceBars: extended.priceBars.slice(-2),
      premiumBars: extended.premiumBars.slice(-2),
      markBars: extended.markBars.slice(-2),
      indexBars: extended.indexBars.slice(-2),
      storedPrimitiveHistory: bootstrap.nextPrimitiveHistory,
    };
    const incremental = buildB4LiveObservation(
      tail,
      BASE_TIME + (B4_LIVE_RAW_BAR_REQUIREMENT + 1) * HOUR,
    );
    expect(incremental.historyMode).toBe("INCREMENTAL");
    expect(incremental.historicalPrimitiveCount).toBe(B4_LIVE_ROLLING_LOOKBACK);
    expect(incremental.nextPrimitiveHistory).toHaveLength(B4_LIVE_ROLLING_LOOKBACK + 1);

    const unchanged = buildB4LiveObservation(
      {
        ...bootstrapHistory,
        priceBars: bootstrapHistory.priceBars.slice(-2),
        premiumBars: bootstrapHistory.premiumBars.slice(-2),
        markBars: bootstrapHistory.markBars.slice(-2),
        indexBars: bootstrapHistory.indexBars.slice(-2),
        storedPrimitiveHistory: bootstrap.nextPrimitiveHistory,
      },
      BASE_TIME + B4_LIVE_RAW_BAR_REQUIREMENT * HOUR,
    );
    expect(unchanged.historyMode).toBe("UNCHANGED");
    expect(unchanged.historicalPrimitiveCount).toBe(B4_LIVE_ROLLING_LOOKBACK);
  });
});

describe("HY-R6.2C durable episode and maturity contracts", () => {
  it("deduplicates the same TRUE episode across cold-start sidecars and rearms after FALSE", async () => {
    const observation = completeObservation();
    const states = new Map<string, string | null>();
    const sync = async (value: B4ShadowObservation, direction: "BULLISH" | "BEARISH" | null) => {
      const previous = states.get(value.symbol) ?? null;
      states.set(value.symbol, direction);
      return direction !== null && previous !== direction;
    };
    const first = await runB4ShadowSidecar({ enabled: true, observations: [observation], syncEpisodeState: async (value, direction) => sync(value, direction) });
    const retry = await runB4ShadowSidecar({ enabled: true, observations: [observation], syncEpisodeState: async (value, direction) => sync(value, direction) });
    const reset = await runB4ShadowSidecar({ enabled: true, observations: [completeObservation({ price_percentile: 0.5, premium_change_percentile: 0.5 })], syncEpisodeState: async (value, direction) => sync(value, direction) });
    const rearmed = await runB4ShadowSidecar({ enabled: true, observations: [observation], syncEpisodeState: async (value, direction) => sync(value, direction) });
    expect(first.events).toHaveLength(1);
    expect(retry.events).toHaveLength(0);
    expect(reset.events).toHaveLength(0);
    expect(rearmed.events).toHaveLength(1);
    expect(retry.diagnostics.duplicatesSuppressed).toBe(1);
  });

  it("matures only due, closed and PIT-available horizons", async () => {
    const event = new B4ShadowEngine({ enabled: true }).evaluate(completeObservation()).event!;
    const persisted: number[] = [];
    const result = await matureB4ShadowOutcomes({
      events: [event],
      evaluatedAt: "2026-09-09T05:00:00.000Z",
      fetchFutureObservation: async (_event, horizon) => horizon <= 4 ? {
        timestamp: `2026-09-09T${String(horizon).padStart(2, "0")}:00:00.000Z`,
        pit_available_at: `2026-09-09T${String(horizon + 1).padStart(2, "0")}:00:00.000Z`,
        close_price: 101,
        high_price: 102,
        low_price: 99,
        observation_closed: true,
      } : null,
      persistOutcome: async (outcome) => { persisted.push(outcome.horizon_hours); },
    });
    expect(result.matured).toBe(2);
    expect(persisted).toEqual([1, 4]);
    expect(result.notDue).toBe(2);
  });

  it("keeps B4 containment canonical-only and the additive migration HY-scoped", () => {
    expect(readHyEnv("HY_B4_SHADOW_ENABLED", { CS_B4_SHADOW_ENABLED: "true" })).toBeUndefined();
    const migration = readFileSync(resolve(import.meta.dirname, "..", "supabase/migrations/20260909150000_hy_r62c_b4_live_shadow_foundation.sql"), "utf8");
    const tables = [...migration.matchAll(/create table public\.([a-z0-9_]+)/g)].map((match) => match[1]);
    expect(tables).toEqual(["hy_b4_shadow_feature_state", "hy_b4_shadow_runtime_state"]);
    expect(tables.every((table) => table.startsWith("hy_"))).toBe(true);
    expect(migration).toContain("hy_b4_shadow_transition_episode");
    expect(migration).toContain("on conflict (symbol) do nothing");
    expect(migration).toContain("hy_b4_shadow_runtime_disabled_consistent");
    expect(migration).toContain("alter table public.hy_b4_shadow_feature_state enable row level security");
    expect(migration).toContain("revoke all on table");
    expect(migration).not.toContain("hy_signal_events");
  });
});

function createHistory(count: number): B4LiveHistory {
  const bars = Array.from({ length: count }, (_, index) => {
    const openTime = BASE_TIME + index * HOUR;
    return {
      openTime,
      closeTime: openTime + HOUR - 1,
      close: 100 + index * 0.01,
      high: 101 + index * 0.01,
      low: 99 + index * 0.01,
    } satisfies B4LiveBar;
  });
  return {
    symbol: "BTCUSDT",
    priceBars: bars,
    premiumBars: bars.map((bar) => ({ ...bar, close: bar.close / 100_000, high: bar.high / 100_000, low: bar.low / 100_000 })),
    markBars: bars.map((bar) => ({ ...bar, close: 102, high: 103, low: 101 })),
    indexBars: bars.map((bar) => ({ ...bar, close: 100, high: 101, low: 99 })),
    fundingRates: [{ fundingTime: BASE_TIME + (count - 2) * HOUR, fundingRate: 0.0001 }],
  };
}

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
    volatility_bucket: "UNKNOWN",
    liquidity_bucket: "UNKNOWN",
    calendar_period: "2026-09",
    observation_closed: true,
    market_data_complete: true,
    rolling_history_ready: true,
    pit_safe: true,
    ...overrides,
  };
}
