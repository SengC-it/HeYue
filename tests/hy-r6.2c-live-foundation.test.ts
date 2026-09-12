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
import {
  b4CrossSectionalPercentile,
  calculateB4FourHourReturn,
  calculateB4Volatility,
  classifyB4BasisBucket,
  classifyB4FundingBucket,
  classifyB4LiquidityPercentile,
  classifyB4MarketRegime,
} from "../lib/signal-engine";
import { getLastClosedB4BarCloseTime } from "../lib/binance/public-client";
import { persistB4ShadowEventAndTransition } from "../lib/services/b4-shadow-repository";

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

  it("keeps a complete 722-bar bootstrap ready when Binance also returns the open bar", () => {
    const history = createHistory(B4_LIVE_RAW_BAR_REQUIREMENT);
    const openBar = {
      openTime: BASE_TIME + B4_LIVE_RAW_BAR_REQUIREMENT * HOUR,
      closeTime: BASE_TIME + (B4_LIVE_RAW_BAR_REQUIREMENT + 1) * HOUR,
      close: 107,
      high: 108,
      low: 106,
    } satisfies B4LiveBar;
    const result = buildB4LiveObservation({
      ...history,
      priceBars: [...history.priceBars, openBar],
      premiumBars: [...history.premiumBars, openBar],
      markBars: [...history.markBars, openBar],
      indexBars: [...history.indexBars, openBar],
      fundingRates: [{ fundingTime: BASE_TIME + 720 * HOUR, fundingRate: 0.0001 }],
    }, BASE_TIME + B4_LIVE_RAW_BAR_REQUIREMENT * HOUR + 1);
    expect(result.status).toBe("READY");
    expect(result.alignedBarCount).toBe(B4_LIVE_RAW_BAR_REQUIREMENT);
    expect(result.historicalPrimitiveCount).toBe(B4_LIVE_ROLLING_LOOKBACK);
  });

  it("retains funding context when the latest valid event is older than three hours", () => {
    const history = createHistory(B4_LIVE_RAW_BAR_REQUIREMENT);
    history.fundingRates = [{ fundingTime: BASE_TIME + 716 * HOUR, fundingRate: 0.0002 }];
    const result = buildB4LiveObservation(history, BASE_TIME + B4_LIVE_RAW_BAR_REQUIREMENT * HOUR);
    expect(result.status).toBe("READY");
    expect(result.observation.funding_state).toMatchObject({ funding_rate: 0.0002 });
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

  it("keeps a TRUE episode armed through incomplete data", () => {
    const engine = new B4ShadowEngine({ enabled: true });
    const bullish = completeObservation({ market_timestamp: "2026-09-09T00:00:00.000Z" });
    expect(engine.evaluate(bullish).event).not.toBeNull();
    expect(engine.evaluate({ ...bullish, market_data_complete: false }).status).toBe("DATA_INCOMPLETE");
    expect(engine.evaluate(bullish).status).toBe("DUPLICATE_SUPPRESSED");
  });

  it("uses the exact frozen context boundaries without B4 strength", () => {
    expect(classifyB4FundingBucket(-0.00005)).toBe("NEUTRAL");
    expect(classifyB4FundingBucket(0.00005)).toBe("NEUTRAL");
    expect(classifyB4FundingBucket(-0.00005001)).toBe("NEGATIVE");
    expect(classifyB4FundingBucket(0.00005001)).toBe("POSITIVE");
    expect(classifyB4BasisBucket(-0.0005)).toBe("EXTREME_NEGATIVE");
    expect(classifyB4BasisBucket(-0.0001)).toBe("NEGATIVE");
    expect(classifyB4BasisBucket(0)).toBe("NEUTRAL");
    expect(classifyB4BasisBucket(0.0001)).toBe("POSITIVE");
    expect(classifyB4BasisBucket(0.0005)).toBe("EXTREME_POSITIVE");
    expect(classifyB4LiquidityPercentile(0.33)).toBe("LOW");
    expect(classifyB4LiquidityPercentile(0.66)).toBe("NORMAL");
    expect(classifyB4LiquidityPercentile(0.67)).toBe("HIGH");
    expect(calculateB4Volatility(Array.from({ length: 25 }, (_, index) => ({
      openTime: index * HOUR,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
      closeTime: (index + 1) * HOUR - 1,
    })))).toMatchObject({ bucket: "LOW", value: 0 });
    expect(b4CrossSectionalPercentile(2, [1, 2, 3])).toBeCloseTo(0.5, 12);
    expect(classifyB4MarketRegime([0.005, 0.005])).toBe("RANGE");
    expect(classifyB4MarketRegime([-0.005, -0.005])).toBe("RANGE");
    expect(calculateB4FourHourReturn(Array.from({ length: 5 }, (_, index) => ({
      openTime: index * HOUR,
      closeTime: (index + 1) * HOUR - 1,
      open: 100,
      high: 101 + index,
      low: 99,
      close: 100 + index * 1.5,
      volume: 1,
    })))).toBeCloseTo(0.06, 12);
    expect(calculateB4FourHourReturn([
      { openTime: 0, closeTime: 4 * HOUR - 1, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { openTime: 4 * HOUR, closeTime: 8 * HOUR - 1, open: 100, high: 106, low: 99, close: 106, volume: 1 },
    ])).toBeNull();
  });

  it("keeps research and live frozen arithmetic deterministic", () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/hy-research-freezes/r6.2c-b4-feature-parity.json"), "utf8")) as {
      samples: Array<{
        symbol: string;
        timestamp: string;
        input: ParityInput;
        expected: ParityExpected;
      }>;
    };
    for (const sample of fixture.samples) {
      const bars = reconstructParityBars(sample.input, Date.parse(sample.timestamp));
      const live = buildB4LiveObservation({
        symbol: sample.symbol,
        ...bars,
        fundingRates: [{ fundingTime: Date.parse(sample.timestamp), fundingRate: 0, pitAvailableAt: Date.parse(sample.timestamp) }],
      }, Date.parse(sample.timestamp) + HOUR);
      expect(live.observation.price_change_value).toBeCloseTo(sample.expected.priceChange, 12);
      expect(live.observation.premium_change_value).toBeCloseTo(sample.expected.premiumChange, 12);
      expect(live.observation.price_percentile).toBe(sample.expected.pricePercentile);
      expect(live.observation.premium_change_percentile).toBe(sample.expected.premiumChangePercentile);
    }
  });

  it("uses an explicit closed-bar boundary and independent funding window", () => {
    const decisionTime = Date.parse("2026-09-10T10:30:00.000Z");
    expect(new Date(getLastClosedB4BarCloseTime(decisionTime)).toISOString()).toBe("2026-09-10T09:59:59.999Z");
    const clientSource = readFileSync(resolve(import.meta.dirname, "..", "lib/binance/public-client.ts"), "utf8");
    expect(clientSource).toContain("endTime: String(lastClosedBarCloseTime)");
    expect(clientSource).toContain("decisionTime - 24 * INTERVAL_MS[\"1h\"]");
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
        path: Array.from({ length: horizon }, (_, index) => ({
          timestamp: `2026-09-09T${String(index + 1).padStart(2, "0")}:00:00.000Z`,
          pit_available_at: `2026-09-09T${String(index + 2).padStart(2, "0")}:00:00.000Z`,
          close_price: 101,
          high_price: 102,
          low_price: 99,
          observation_closed: true,
        })),
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
    expect(tables).toEqual([
      "hy_b4_shadow_feature_state",
      "hy_b4_shadow_runtime_state",
      "hy_b4_shadow_control_candidates",
      "hy_b4_shadow_control_claims",
      "hy_b4_shadow_control_outcomes",
      "hy_b4_shadow_context_staging",
      "hy_b4_shadow_context_finalized",
    ]);
    expect(tables.every((table) => table.startsWith("hy_"))).toBe(true);
    expect(migration).toContain("hy_b4_shadow_transition_episode");
    expect(migration).toContain("hy_b4_shadow_transition_and_insert");
    expect(migration).toContain("hy_b4_shadow_upsert_feature_state");
    expect(migration).toContain("hy_b4_shadow_control_candidates");
    expect(migration).toContain("STALE_OBSERVATION");
    expect(migration).toContain("B4 same-bar transition invariant failure");
    expect(migration).toContain("set search_path = public, pg_temp");
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("on conflict (symbol) do nothing");
    expect(migration).toContain("hy_b4_shadow_runtime_disabled_consistent");
    expect(migration).toContain("alter table public.hy_b4_shadow_feature_state enable row level security");
    expect(migration).toContain("revoke all on table");
    expect(migration).not.toContain("hy_signal_events");
  });

  it("keeps the PAPER scanner independent and exposes a dedicated B4 collector", () => {
    const route = readFileSync(resolve(import.meta.dirname, "..", "app/api/scan/route.ts"), "utf8");
    const collector = readFileSync(resolve(import.meta.dirname, "..", "app/api/b4-shadow/collect/route.ts"), "utf8");
    expect(route).toContain("runtimeConfig.HY_MICROSTRUCTURE_ENABLED");
    expect(route).not.toContain("runB4ShadowSidecar");
    expect(route).not.toContain("finalizeB4ShadowContext");
    expect(collector).toContain("collectB4ShadowBatch");
    expect(collector).toContain("x-cron-secret");
    expect(collector).not.toContain("sendSignalEmail");
  });

  it("uses one RPC boundary for an atomic event transition", async () => {
    const event = new B4ShadowEngine({ enabled: true }).evaluate(completeObservation()).event!;
    let rpcCalls = 0;
    let fromCalls = 0;
    const client = {
      rpc(name: string) {
        rpcCalls += 1;
        expect(name).toBe("hy_b4_shadow_transition_and_insert");
      return Promise.resolve({ data: {
        result: "NEW_EVENT",
        event_id: event.event_id,
        control_status: "CONTROL_UNAVAILABLE",
        control_event_id: null,
        control_match_key: event.control_match_key,
      }, error: null });
      },
      from() {
        fromCalls += 1;
        throw new Error("atomic path must not use direct table ordering");
      },
    } as unknown as import("@supabase/supabase-js").SupabaseClient;
    await expect(persistB4ShadowEventAndTransition(client, event)).resolves.toMatchObject({ result: "NEW_EVENT" });
    expect(rpcCalls).toBe(1);
    expect(fromCalls).toBe(0);
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
      quoteVolume: 1_000_000,
    } satisfies B4LiveBar;
  });
  return {
    symbol: "BTCUSDT",
    priceBars: bars,
    premiumBars: bars.map((bar) => ({ ...bar, close: bar.close / 100_000, high: bar.high / 100_000, low: bar.low / 100_000 })),
    markBars: bars.map((bar) => ({ ...bar, close: 102, high: 103, low: 101 })),
    indexBars: bars.map((bar) => ({ ...bar, close: 100, high: 101, low: 99 })),
    fundingRates: [{ fundingTime: BASE_TIME + (count - 2) * HOUR, fundingRate: 0.0001, pitAvailableAt: BASE_TIME + (count - 2) * HOUR }],
  };
}

function reconstructParityBars(
  input: ParityInput,
  currentTimestamp: number,
): Pick<B4LiveHistory, "priceBars" | "premiumBars" | "markBars" | "indexBars"> {
  const priceValues = [100];
  for (const change of input.priorPriceChanges) priceValues.push(priceValues.at(-1)! * (1 + change));
  const priceScale = input.previousPrice / priceValues.at(-1)!;
  const prices = priceValues.map((value) => value * priceScale).concat(input.currentPrice);
  const premiumValues = [0];
  for (const change of input.priorPremiumChanges) premiumValues.push(premiumValues.at(-1)! + change);
  const premiumShift = input.previousPremium - premiumValues.at(-1)!;
  const premiums = premiumValues.map((value) => value + premiumShift).concat(input.currentPremium);
  const makeBars = (values: readonly number[], positive: boolean): B4LiveBar[] => values.map((close, index) => {
    const openTime = currentTimestamp - (values.length - 1 - index) * HOUR;
    return {
      openTime,
      closeTime: openTime + HOUR - 1,
      close,
      high: positive ? close * 1.001 : close,
      low: positive ? close * 0.999 : close,
    };
  });
  const priceBars = makeBars(prices, true);
  const premiumBars = makeBars(premiums, false);
  const markBars = makeBars(prices.map(() => 100), true);
  const indexBars = makeBars(prices.map(() => 100), true);
  return { priceBars, premiumBars, markBars, indexBars };
}

interface ParityInput {
  previousPrice: number;
  currentPrice: number;
  previousPremium: number;
  currentPremium: number;
  priorPriceChanges: number[];
  priorPremiumChanges: number[];
}

interface ParityExpected {
  priceChange: number;
  premiumChange: number;
  pricePercentile: number;
  premiumChangePercentile: number;
  direction: "BULLISH" | "BEARISH" | null;
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
    market_regime: "UP",
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
