import type { SupabaseClient } from "@supabase/supabase-js";
import { B4_SHADOW_VERSION, type B4ShadowDirection, type B4ShadowSignalEvent } from "@/lib/signal-engine/b4-shadow-types";
import type { B4ShadowHealthDiagnostics, B4ShadowSidecarStatus } from "@/lib/signal-engine/b4-shadow-sidecar";
import type { B4LivePrimitive } from "@/lib/signal-engine/b4-live-features";

export const B4_SHADOW_RUNTIME_TABLE = "hy_b4_shadow_runtime_state" as const;
export const B4_SHADOW_FEATURE_STATE_TABLE = "hy_b4_shadow_feature_state" as const;

export interface B4ShadowRuntimeState {
  enabled: boolean;
  version: typeof B4_SHADOW_VERSION;
  status: B4ShadowSidecarStatus;
  observationStartedAt: string | null;
  lastEvaluationAt: string | null;
  lastClosedBarEvaluated: string | null;
  warmupReady: boolean;
  eligibleSymbols: string[];
  conditionsEvaluated: number;
  eventsGenerated: number;
  longWatch: number;
  shortWatch: number;
  duplicatesSuppressed: number;
  dataIncomplete: number;
  pitFailures: number;
  lastError: string | null;
  emailSent: 0;
}

export interface B4ShadowFeatureState {
  symbol: string;
  version: typeof B4_SHADOW_VERSION;
  currentDirection: B4ShadowDirection | null;
  lastEvaluatedClosedBar: string | null;
  currentEpisodeKey: string | null;
  rollingPrimitives: B4LivePrimitive[];
}

export async function getB4ShadowFeatureStates(
  supabase: SupabaseClient,
  symbols: readonly string[],
): Promise<Map<string, B4ShadowFeatureState>> {
  if (symbols.length === 0) return new Map();
  const { data, error } = await supabase
    .from(B4_SHADOW_FEATURE_STATE_TABLE)
    .select("*")
    .in("symbol", [...new Set(symbols)]);
  if (error) throw new Error(`Supabase B4 feature state lookup failed: ${error.message}`);
  return new Map((data ?? []).map((row) => {
    const parsed = parseFeatureState(row as Record<string, unknown>);
    return [parsed.symbol, parsed] as const;
  }));
}

export async function upsertB4ShadowFeatureState(
  supabase: SupabaseClient,
  state: {
    symbol: string;
    lastEvaluatedClosedBar: string | null;
    rollingPrimitives: readonly B4LivePrimitive[];
  },
): Promise<void> {
  const { error } = await supabase.rpc("hy_b4_shadow_upsert_feature_state", {
    p_symbol: state.symbol,
    p_version: B4_SHADOW_VERSION,
    p_last_evaluated_closed_bar: state.lastEvaluatedClosedBar,
    p_rolling_primitives: state.rollingPrimitives,
  });
  if (error) throw new Error(`Supabase B4 feature state upsert failed: ${error.message}`);
}

/**
 * Atomically advance the per-symbol episode state in Postgres. The SQL
 * function locks the symbol row, so cold starts and concurrent cron retries
 * cannot form two events for one TRUE episode.
 */
export async function claimB4ShadowEpisode(
  supabase: SupabaseClient,
  event: Pick<B4ShadowSignalEvent, "symbol" | "direction" | "market_timestamp" | "episode_key" | "version">,
): Promise<boolean> {
  return transitionB4ShadowEpisode(supabase, {
    symbol: event.symbol,
    direction: event.direction,
    marketTimestamp: event.market_timestamp,
    episodeKey: event.episode_key,
    version: event.version,
  });
}

export async function transitionB4ShadowEpisode(
  supabase: SupabaseClient,
  input: {
    symbol: string;
    direction: B4ShadowDirection | null;
    marketTimestamp: string;
    episodeKey: string | null;
    version?: typeof B4_SHADOW_VERSION;
  },
): Promise<boolean> {
  const { data, error } = await supabase.rpc("hy_b4_shadow_transition_episode", {
    p_symbol: input.symbol,
    p_direction: input.direction,
    p_closed_bar: input.marketTimestamp,
    p_episode_key: input.episodeKey,
    p_version: input.version ?? B4_SHADOW_VERSION,
  });
  if (error) throw new Error(`Supabase B4 episode transition failed: ${error.message}`);
  return data === true || data === "true";
}

/**
 * Start a durable B4 observation epoch. Postgres preserves an already-active
 * epoch so concurrent hourly batches cannot move the cutoff backwards.
 */
export async function beginB4ShadowObservation(
  supabase: SupabaseClient,
  startedAt = new Date().toISOString(),
): Promise<string> {
  const { data, error } = await supabase.rpc("hy_b4_shadow_begin_observation", {
    p_started_at: startedAt,
  });
  if (error) throw new Error(`Supabase B4 observation epoch start failed: ${error.message}`);
  const value = Array.isArray(data) ? data[0] : data;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("Supabase B4 observation epoch start returned no timestamp");
  }
  return value;
}

/** Disable B4 durably while retaining counters and failure evidence. */
export async function markB4ShadowDisabled(supabase: SupabaseClient): Promise<void> {
  const { error } = await supabase.rpc("hy_b4_shadow_mark_disabled");
  if (error) throw new Error(`Supabase B4 durable disable failed: ${error.message}`);
}

export async function upsertB4ShadowRuntimeState(
  supabase: SupabaseClient,
  diagnostics: B4ShadowHealthDiagnostics,
  input: { lastClosedBarEvaluated?: string | null; lastError?: string | null } = {},
): Promise<void> {
  const row = {
    singleton_key: "B4",
    enabled: diagnostics.enabled,
    version: diagnostics.version,
    status: diagnostics.status,
    last_evaluation_at: diagnostics.lastEvaluatedAt,
    last_closed_bar_evaluated: input.lastClosedBarEvaluated ?? null,
    warmup_ready: diagnostics.status === "READY",
    eligible_symbols: diagnostics.eligibleSymbols,
    conditions_evaluated: diagnostics.conditionsEvaluated,
    events_generated: diagnostics.eventsGenerated,
    long_watch: diagnostics.longWatch,
    short_watch: diagnostics.shortWatch,
    duplicates_suppressed: diagnostics.duplicatesSuppressed,
    data_incomplete: diagnostics.dataIncomplete,
    pit_failures: diagnostics.pitFailures,
    last_error: input.lastError ?? null,
    email_sent: 0,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase
    .from(B4_SHADOW_RUNTIME_TABLE)
    .upsert(row, { onConflict: "singleton_key" });
  if (error) throw new Error(`Supabase B4 runtime state upsert failed: ${error.message}`);
}

export async function getB4ShadowRuntimeState(
  supabase: SupabaseClient,
): Promise<B4ShadowRuntimeState | null> {
  const { data, error } = await supabase
    .from(B4_SHADOW_RUNTIME_TABLE)
    .select("*")
    .eq("singleton_key", "B4")
    .maybeSingle();
  if (error) throw new Error(`Supabase B4 runtime state lookup failed: ${error.message}`);
  return data ? parseRuntimeState(data as Record<string, unknown>) : null;
}

export function parseRuntimeState(row: Record<string, unknown>): B4ShadowRuntimeState {
  const enabled = row.enabled === true;
  return {
    enabled,
    version: B4_SHADOW_VERSION,
    status: enabled && parseStatus(row.status) === "DISABLED" ? "WARMING_UP" : parseStatus(row.status),
    observationStartedAt: stringOrNull(row.observation_started_at),
    lastEvaluationAt: stringOrNull(row.last_evaluation_at),
    lastClosedBarEvaluated: stringOrNull(row.last_closed_bar_evaluated),
    warmupReady: row.warmup_ready === true,
    eligibleSymbols: stringArray(row.eligible_symbols),
    conditionsEvaluated: integerOrZero(row.conditions_evaluated),
    eventsGenerated: integerOrZero(row.events_generated),
    longWatch: integerOrZero(row.long_watch),
    shortWatch: integerOrZero(row.short_watch),
    duplicatesSuppressed: integerOrZero(row.duplicates_suppressed),
    dataIncomplete: integerOrZero(row.data_incomplete),
    pitFailures: integerOrZero(row.pit_failures),
    lastError: stringOrNull(row.last_error),
    emailSent: 0,
  };
}

function parseFeatureState(row: Record<string, unknown>): B4ShadowFeatureState {
  const currentDirection = row.current_direction === "BULLISH" || row.current_direction === "BEARISH"
    ? row.current_direction
    : null;
  const rollingPrimitives = Array.isArray(row.rolling_primitives)
    ? row.rolling_primitives.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      const openTime = typeof value.openTime === "number" ? value.openTime : Number(value.openTime);
      const priceChange = typeof value.priceChange === "number" ? value.priceChange : Number(value.priceChange);
      const premiumChange = typeof value.premiumChange === "number" ? value.premiumChange : Number(value.premiumChange);
      return Number.isFinite(openTime) && Number.isFinite(priceChange) && Number.isFinite(premiumChange)
        ? [{ openTime, priceChange, premiumChange }]
        : [];
    })
    : [];
  return {
    symbol: typeof row.symbol === "string" ? row.symbol : "",
    version: B4_SHADOW_VERSION,
    currentDirection,
    lastEvaluatedClosedBar: stringOrNull(row.last_evaluated_closed_bar),
    currentEpisodeKey: stringOrNull(row.current_episode_key),
    rollingPrimitives,
  };
}

function parseStatus(value: unknown): B4ShadowSidecarStatus {
  return value === "READY" || value === "DEGRADED" || value === "FAILED" || value === "WARMING_UP"
    ? value
    : "DISABLED";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").sort() : [];
}

function integerOrZero(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}
