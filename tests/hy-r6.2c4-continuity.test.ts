import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Instrument } from "../lib/core/types";
import { BinancePublicClient } from "../lib/binance/public-client";
import {
  B4_LIVE_CONTEXT_RAW_BAR_REQUIREMENT,
  B4_LIVE_RAW_BAR_REQUIREMENT,
  B4_LIVE_ROLLING_LOOKBACK,
  B4_SHADOW_INTERVAL_MS,
  B4_SHADOW_UNIVERSE_SYMBOLS,
  buildB4LiveObservation,
} from "../lib/signal-engine";
import type { B4LiveBar, B4LiveHistory, B4LivePrimitive } from "../lib/signal-engine/b4-live-features";
import { collectB4ShadowBatch } from "../lib/services/b4-shadow-collector";
import type { B4ShadowFeatureState } from "../lib/services/b4-shadow-runtime-repository";
import type { ServerConfig } from "../lib/config";

const HOUR = B4_SHADOW_INTERVAL_MS;
const TARGET_T = Date.parse("2026-09-10T12:00:00.000Z");
const NOW_T = Date.parse("2026-09-10T13:00:00.000Z");

describe("HY-R6.2C.4 incremental context continuity", () => {
  it("keeps context complete across three continuous collector hours", async () => {
    const client = new FakeB4Client(TARGET_T);
    const supabase = new FakeB4Supabase();
    const config = {
      HY_SCAN_BATCH_SIZE: B4_SHADOW_UNIVERSE_SYMBOLS.length,
      HY_REQUEST_CONCURRENCY: B4_SHADOW_UNIVERSE_SYMBOLS.length,
    } as unknown as ServerConfig;

    const bootstrap = await collectHour(client, supabase, config, NOW_T);
    expectRun(bootstrap.result, "bootstrap");
    expect(bootstrap.result.networkFetches).toBe(B4_SHADOW_UNIVERSE_SYMBOLS.length);
    expect(bootstrap.requests).toHaveLength(B4_SHADOW_UNIVERSE_SYMBOLS.length);
    expect(bootstrap.requests.every((request) => request.limit === B4_LIVE_RAW_BAR_REQUIREMENT)).toBe(true);
    expect(bootstrap.result.stagedSymbols).toHaveLength(B4_SHADOW_UNIVERSE_SYMBOLS.length);
    expect(supabase.finalizedContexts).toHaveLength(1);
    assertCompleteContext(supabase, bootstrap.contextGroupKey);

    const incremental = await collectHour(client, supabase, config, NOW_T + HOUR);
    expectRun(incremental.result, "incremental T+1");
    expect(incremental.result.networkFetches).toBe(B4_SHADOW_UNIVERSE_SYMBOLS.length);
    expect(incremental.requests).toHaveLength(B4_SHADOW_UNIVERSE_SYMBOLS.length);
    expect(incremental.requests.every((request) => request.limit === B4_LIVE_CONTEXT_RAW_BAR_REQUIREMENT)).toBe(true);
    expect(incremental.result.stagedSymbols).toHaveLength(B4_SHADOW_UNIVERSE_SYMBOLS.length);
    expect(supabase.finalizedContexts).toHaveLength(2);
    assertIncrementalFeatures(incremental);
    assertCompleteContext(supabase, incremental.contextGroupKey);

    const nextIncremental = await collectHour(client, supabase, config, NOW_T + 2 * HOUR);
    expectRun(nextIncremental.result, "incremental T+2");
    expect(nextIncremental.result.networkFetches).toBe(B4_SHADOW_UNIVERSE_SYMBOLS.length);
    expect(nextIncremental.requests).toHaveLength(B4_SHADOW_UNIVERSE_SYMBOLS.length);
    expect(nextIncremental.requests.every((request) => request.limit === B4_LIVE_CONTEXT_RAW_BAR_REQUIREMENT)).toBe(true);
    expect(nextIncremental.result.stagedSymbols).toHaveLength(B4_SHADOW_UNIVERSE_SYMBOLS.length);
    expect(supabase.finalizedContexts).toHaveLength(3);
    assertIncrementalFeatures(nextIncremental);
    assertCompleteContext(supabase, nextIncremental.contextGroupKey);

    expect(supabase.featureStates.size).toBe(B4_SHADOW_UNIVERSE_SYMBOLS.length);
    expect([...supabase.featureStates.values()].every(
      (state) => state.rollingPrimitives.length === B4_LIVE_ROLLING_LOOKBACK + 1,
    )).toBe(true);
    expect(client.futureObservationCalls).toBe(0);
    expect(supabase.rpcCalls.some((name) => /order|leverage|position/i.test(name))).toBe(false);
    expect(bootstrap.result.emailsSent).toBe(0);
    expect(incremental.result.emailsSent).toBe(0);
    expect(nextIncremental.result.emailsSent).toBe(0);
  });
});

function expectRun(
  result: Awaited<ReturnType<typeof collectB4ShadowBatch>>,
  label: string,
): void {
  expect(result.status, label).toBe("FINALIZED");
  expect(result.expectedSymbols, label).toBe(B4_SHADOW_UNIVERSE_SYMBOLS.length);
  expect(result.batchCount, label).toBe(1);
  expect(result.errors, label).toEqual([]);
  expect(result.eventsGenerated, label).toBe(0);
  expect(result.emailsSent, label).toBe(0);
}

function assertIncrementalFeatures(run: CollectedHour): void {
  expect(run.priorFeatureStates.size).toBe(B4_SHADOW_UNIVERSE_SYMBOLS.length);
  for (const request of run.requests) {
    const prior = run.priorFeatureStates.get(request.symbol);
    expect(prior).toBeDefined();
    const rebuilt = buildB4LiveObservation({
      ...request.history,
      storedPrimitiveHistory: prior?.rollingPrimitives,
    }, request.decisionTime);
    expect(rebuilt.historyMode, request.symbol).toBe("INCREMENTAL");
    expect(rebuilt.status, request.symbol).toBe("READY");
    expect(rebuilt.historicalPrimitiveCount, request.symbol).toBe(B4_LIVE_ROLLING_LOOKBACK);
    expect(rebuilt.observation.rolling_history_ready, request.symbol).toBe(true);
    expect(rebuilt.observation.observation_closed, request.symbol).toBe(true);
    expect(rebuilt.observation.pit_safe, request.symbol).toBe(true);
  }
}

function assertCompleteContext(supabase: FakeB4Supabase, contextGroupKey: string): void {
  const rows = supabase.stagedRows.filter((row) => row.context_group_key === contextGroupKey);
  expect(rows).toHaveLength(B4_SHADOW_UNIVERSE_SYMBOLS.length);
  for (const row of rows) {
    expect(row.quote_volume_mean).not.toBeNull();
    expect(Number.isFinite(row.quote_volume_mean)).toBe(true);
    expect(row.four_hour_return).not.toBeNull();
    expect(Number.isFinite(row.four_hour_return)).toBe(true);
    expect(row.volatility_value).not.toBeNull();
    expect(Number.isFinite(row.volatility_value)).toBe(true);
  }
}

async function collectHour(
  client: FakeB4Client,
  supabase: FakeB4Supabase,
  config: ServerConfig,
  now: number,
): Promise<CollectedHour> {
  const priorFeatureStates = new Map(
    [...supabase.featureStates.entries()].map(([symbol, state]) => [symbol, cloneFeatureState(state)] as const),
  );
  const requestStart = client.requests.length;
  const result = await collectB4ShadowBatch({
    client: client as unknown as BinancePublicClient,
    supabase: supabase as unknown as SupabaseClient,
    config,
    batchNumber: 0,
    now,
  });
  const contextGroupKey = result.contextGroupKey;
  return {
    result,
    contextGroupKey,
    priorFeatureStates,
    requests: client.requests.slice(requestStart),
  };
}

interface CollectedHour {
  result: Awaited<ReturnType<typeof collectB4ShadowBatch>>;
  contextGroupKey: string;
  priorFeatureStates: Map<string, B4ShadowFeatureState>;
  requests: B4HistoryRequest[];
}

interface B4HistoryRequest {
  symbol: string;
  decisionTime: number;
  limit: number;
  history: B4LiveHistory;
}

class FakeB4Client {
  readonly requests: B4HistoryRequest[] = [];
  futureObservationCalls = 0;
  private readonly bars: B4LiveBar[];
  private readonly instruments: Instrument[];

  constructor(targetTimestamp: number) {
    const firstOpenTime = targetTimestamp - 721 * HOUR;
    this.bars = Array.from({ length: 724 }, (_, index) => {
      const openTime = firstOpenTime + index * HOUR;
      const close = 100;
      return {
        openTime,
        closeTime: openTime + HOUR - 1,
        close,
        high: close + 1,
        low: close - 1,
        quoteVolume: 1_000_000,
      } satisfies B4LiveBar;
    });
    this.instruments = B4_SHADOW_UNIVERSE_SYMBOLS.map((symbol, index) => ({
      symbol,
      baseAsset: symbol.replace(/USDT$/, ""),
      quoteAsset: "USDT",
      contractType: "PERPETUAL",
      status: "TRADING",
      priceTick: 0.01,
      quantityStep: 0.001,
      universeRank: index + 1,
    }));
  }

  async getUniverse(): Promise<Instrument[]> {
    return this.instruments;
  }

  async getB4LiveHistory(symbol: string, decisionTime: number, limit: number): Promise<B4LiveHistory> {
    const lastClosedOpenTime = decisionTime - HOUR;
    const priceBars = this.bars.filter((bar) => bar.openTime <= lastClosedOpenTime).slice(-limit);
    const history: B4LiveHistory = {
      symbol,
      priceBars,
      premiumBars: priceBars.map((bar) => ({ ...bar, close: 0.001, high: 0.001, low: 0.001 })),
      markBars: priceBars.map((bar) => ({ ...bar, close: 101, high: 102, low: 100 })),
      indexBars: priceBars.map((bar) => ({ ...bar, close: 100, high: 101, low: 99 })),
      fundingRates: [{
        fundingTime: lastClosedOpenTime,
        fundingRate: 0.0001,
        pitAvailableAt: lastClosedOpenTime,
      }],
    };
    this.requests.push({ symbol, decisionTime, limit, history });
    return history;
  }

  async getClosedB4FutureObservation(): Promise<never> {
    this.futureObservationCalls += 1;
    throw new Error("future observation must not be requested for this no-event fixture");
  }
}

type StageRow = {
  context_group_key: string;
  market_timestamp: string;
  symbol: string;
  expected_symbols: string[];
  pit_available_at: string;
  reference_price: number;
  quote_volume_mean: number;
  four_hour_return: number;
  volatility_value: number;
  volatility_bucket: string;
  funding_bucket: string;
  mark_index_basis_bucket: string;
  observation: Record<string, unknown>;
};

type FinalizedRow = {
  context_group_key: string;
  market_timestamp: string;
  expected_symbols: string[];
  context_rows: Record<string, unknown>[];
};

type QueryResult = { data: unknown; error: null };

class FakeB4Supabase {
  readonly stagedRows: StageRow[] = [];
  readonly finalizedContexts: FinalizedRow[] = [];
  readonly featureStates = new Map<string, B4ShadowFeatureState>();
  readonly rpcCalls: string[] = [];
  private observationStartedAt: string | null = null;

  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }

  async rpc(name: string, args: Record<string, unknown>): Promise<QueryResult> {
    this.rpcCalls.push(name);
    if (name === "hy_b4_shadow_begin_observation") {
      this.observationStartedAt ??= String(args.p_started_at);
      return { data: this.observationStartedAt, error: null };
    }
    if (name === "hy_b4_shadow_upsert_feature_state") {
      const symbol = String(args.p_symbol);
      this.featureStates.set(symbol, {
        symbol,
        version: "hy-b4-shadow-v1",
        currentDirection: null,
        lastEvaluatedClosedBar: typeof args.p_last_evaluated_closed_bar === "string"
          ? args.p_last_evaluated_closed_bar
          : null,
        currentEpisodeKey: null,
        rollingPrimitives: clonePrimitives(args.p_rolling_primitives),
      });
      return { data: null, error: null };
    }
    if (name === "hy_b4_shadow_stage_and_finalize") {
      const groupKey = String(args.p_context_group_key);
      const marketTimestamp = String(args.p_market_timestamp);
      const expectedSymbols = [...(args.p_expected_symbols as string[])].sort();
      const rows = this.stagedRows
        .filter((row) => row.context_group_key === groupKey && row.market_timestamp === marketTimestamp)
        .sort((left, right) => left.symbol.localeCompare(right.symbol));
      if (rows.length !== expectedSymbols.length) {
        return { data: { status: "WAITING", context_rows: [] }, error: null };
      }
      const contextRows = rows.map((row) => ({
        ...row.observation,
        market_regime: "RANGE",
        liquidity_percentile: 0.5,
        liquidity_bucket: "NORMAL",
      }));
      const finalized: FinalizedRow = {
        context_group_key: groupKey,
        market_timestamp: marketTimestamp,
        expected_symbols: expectedSymbols,
        context_rows: contextRows,
      };
      this.finalizedContexts.push(finalized);
      return { data: { status: "FINALIZED", context_rows: contextRows }, error: null };
    }
    if (name === "hy_b4_shadow_pending_signal_maturity" || name === "hy_b4_shadow_pending_control_maturity") {
      return { data: [], error: null };
    }
    if (name === "hy_b4_shadow_transition_episode") return { data: false, error: null };
    return { data: null, error: null };
  }

  read(query: FakeQuery, single: boolean): QueryResult {
    const rows = this.rowsFor(query);
    return { data: single ? rows[0] ?? null : rows, error: null };
  }

  write(table: string, value: unknown): void {
    if (table === "hy_b4_shadow_context_staging") {
      const row = value as StageRow;
      const index = this.stagedRows.findIndex((current) => current.context_group_key === row.context_group_key
        && current.market_timestamp === row.market_timestamp
        && current.symbol === row.symbol);
      if (index >= 0) this.stagedRows[index] = row;
      else this.stagedRows.push(row);
    }
  }

  private rowsFor(query: FakeQuery): unknown[] {
    if (query.table === "hy_b4_shadow_feature_state") {
      return [...this.featureStates.values()].map((state) => ({
        symbol: state.symbol,
        last_evaluated_closed_bar: state.lastEvaluatedClosedBar,
        rolling_primitives: state.rollingPrimitives,
      })).filter((row) => query.matches(row));
    }
    if (query.table === "hy_b4_shadow_context_staging") {
      return this.stagedRows.filter((row) => query.matches(row));
    }
    if (query.table === "hy_b4_shadow_context_finalized") {
      return this.finalizedContexts.filter((row) => query.matches(row));
    }
    return [];
  }
}

class FakeQuery {
  readonly equals = new Map<string, unknown>();
  readonly memberships = new Map<string, unknown[]>();

  constructor(
    private readonly db: FakeB4Supabase,
    readonly table: string,
  ) {}

  select(): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.equals.set(column, value);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.memberships.set(column, values);
    return this;
  }

  order(): this {
    return this;
  }

  limit(): this {
    return this;
  }

  upsert(value: unknown): Promise<QueryResult> {
    this.db.write(this.table, value);
    return Promise.resolve({ data: null, error: null });
  }

  insert(value: unknown): this {
    this.db.write(this.table, value);
    return this;
  }

  maybeSingle(): Promise<QueryResult> {
    return Promise.resolve(this.db.read(this, true));
  }

  single(): Promise<QueryResult> {
    return Promise.resolve(this.db.read(this, true));
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.db.read(this, false)).then(onfulfilled, onrejected);
  }

  matches(row: Record<string, unknown>): boolean {
    for (const [column, value] of this.equals) {
      if (row[column] !== value) return false;
    }
    for (const [column, values] of this.memberships) {
      if (!values.includes(row[column])) return false;
    }
    return true;
  }
}

function cloneFeatureState(state: B4ShadowFeatureState): B4ShadowFeatureState {
  return {
    ...state,
    rollingPrimitives: clonePrimitives(state.rollingPrimitives),
  };
}

function clonePrimitives(value: unknown): B4LivePrimitive[] {
  return Array.isArray(value)
    ? value.map((item) => ({
      openTime: Number((item as Record<string, unknown>).openTime),
      priceChange: Number((item as Record<string, unknown>).priceChange),
      premiumChange: Number((item as Record<string, unknown>).premiumChange),
    }))
    : [];
}
