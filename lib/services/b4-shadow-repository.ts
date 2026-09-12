import type { SupabaseClient } from "@supabase/supabase-js";
import {
  parseB4ShadowControlOutcome,
  parseB4ShadowEvent,
  parseB4ShadowOutcome,
} from "@/lib/signal-engine/b4-shadow-validation";
import type {
  B4ShadowControlEvent,
  B4ShadowControlOutcome,
  B4ShadowOutcome,
  B4ShadowSignalEvent,
} from "@/lib/signal-engine/b4-shadow-types";
import { b4ShadowContextValue } from "@/lib/signal-engine/b4-shadow";
import type { B4ShadowAtomicResult } from "@/lib/signal-engine/b4-shadow-sidecar";

const B4_EVENT_TABLE = "hy_shadow_signal_events";
const B4_OUTCOME_TABLE = "hy_shadow_signal_outcomes";
const B4_CONTROL_TABLE = "hy_b4_shadow_control_candidates";
const B4_CONTROL_CLAIMS_TABLE = "hy_b4_shadow_control_claims";
const B4_CONTROL_OUTCOME_TABLE = "hy_b4_shadow_control_outcomes";

export interface B4ShadowAtomicTransitionResult {
  result: B4ShadowAtomicResult;
  event_id: string | null;
  control_status: B4ShadowSignalEvent["control_status"];
  control_event_id: string | null;
  control_match_key: string;
}

/**
 * Shadow-only persistence. This repository has no delivery or execution
 * dependency; callers must explicitly choose the shadow tables.
 */
export async function createB4ShadowSignalEvent(
  supabase: SupabaseClient,
  input: B4ShadowSignalEvent,
): Promise<B4ShadowSignalEvent> {
  const row = parseB4ShadowEvent(input);
  const tableRow = row as unknown as Record<string, unknown>;
  const { data, error } = await supabase
    .from("hy_shadow_signal_events")
    .insert(tableRow)
    .select("*")
    .single();
  if (!error && data) return data as B4ShadowSignalEvent;
  if (error?.code === "23505") {
    const { data: existing, error: lookupError } = await supabase
      .from("hy_shadow_signal_events")
      .select("*")
      .eq("episode_key", row.episode_key)
      .single();
    if (!lookupError && existing) return existing as B4ShadowSignalEvent;
  }
  throw new Error(`Supabase B4 shadow signal event insert failed: ${error?.message ?? "empty response"}`);
}

/**
 * Canonical B4 event boundary. The database RPC locks the durable symbol row,
 * validates the closed-bar monotonic contract, inserts the event when the
 * episode changes, and updates the episode in one transaction.
 */
export async function persistB4ShadowEventAndTransition(
  supabase: SupabaseClient,
  input: B4ShadowSignalEvent,
): Promise<B4ShadowAtomicTransitionResult> {
  const row = parseB4ShadowEvent(input) as unknown as Record<string, unknown>;
  const { data, error } = await supabase.rpc("hy_b4_shadow_transition_and_insert", {
    p_event: row,
  });
  if (error) throw new Error(`Supabase B4 atomic transition failed: ${error.message}`);
  if (!data || typeof data !== "object") throw new Error("Supabase B4 atomic transition returned no result");
  const result = (data as Record<string, unknown>).result;
  const eventId = (data as Record<string, unknown>).event_id;
  const controlStatus = (data as Record<string, unknown>).control_status;
  const controlEventId = (data as Record<string, unknown>).control_event_id;
  const controlMatchKey = (data as Record<string, unknown>).control_match_key;
  if (result !== "NEW_EVENT" && result !== "DUPLICATE_TRUE" && result !== "RESET_FALSE"
    && result !== "STALE_OBSERVATION" && result !== "SAME_BAR_RETRY" && result !== "INVARIANT_FAILURE") {
    throw new Error("Supabase B4 atomic transition returned an invalid result");
  }
  if (controlStatus !== "AVAILABLE" && controlStatus !== "CONTROL_UNAVAILABLE") {
    throw new Error("Supabase B4 atomic transition returned an invalid control status");
  }
  if (typeof controlMatchKey !== "string" || controlMatchKey.length === 0) {
    throw new Error("Supabase B4 atomic transition returned no control match key");
  }
  return {
    result,
    event_id: typeof eventId === "string" ? eventId : null,
    control_status: controlStatus,
    control_event_id: typeof controlEventId === "string" ? controlEventId : null,
    control_match_key: controlMatchKey,
  };
}

export async function createB4ShadowSignalOutcome(
  supabase: SupabaseClient,
  input: B4ShadowOutcome,
): Promise<B4ShadowOutcome> {
  const row = parseB4ShadowOutcome(input);
  const tableRow = row as unknown as Record<string, unknown>;
  const { data, error } = await supabase
    .from("hy_shadow_signal_outcomes")
    .insert(tableRow)
    .select("*")
    .single();
  if (!error && data) return data as B4ShadowOutcome;
  if (error?.code === "23505") {
    const { data: existing, error: lookupError } = await supabase
      .from("hy_shadow_signal_outcomes")
      .select("*")
      .eq("event_id", row.event_id)
      .eq("horizon_hours", row.horizon_hours)
      .single();
    if (!lookupError && existing) return existing as B4ShadowOutcome;
  }
  throw new Error(`Supabase B4 shadow signal outcome insert failed: ${error?.message ?? "empty response"}`);
}

export async function createB4ShadowControlOutcome(
  supabase: SupabaseClient,
  input: B4ShadowControlOutcome,
): Promise<B4ShadowControlOutcome> {
  const row = parseB4ShadowControlOutcome(input);
  const { data, error } = await supabase
    .from(B4_CONTROL_OUTCOME_TABLE)
    .insert(row as unknown as Record<string, unknown>)
    .select("*")
    .single();
  if (!error && data) return data as B4ShadowControlOutcome;
  if (error?.code === "23505") {
    const { data: existing, error: lookupError } = await supabase
      .from(B4_CONTROL_OUTCOME_TABLE)
      .select("*")
      .eq("control_event_id", row.control_event_id)
      .eq("direction", row.direction)
      .eq("horizon_hours", row.horizon_hours)
      .single();
    if (!lookupError && existing) return existing as B4ShadowControlOutcome;
  }
  throw new Error(`Supabase B4 control outcome insert failed: ${error?.message ?? "empty response"}`);
}

export async function listB4ShadowSignalEventsForMaturity(
  supabase: SupabaseClient,
  evaluatedAt: string,
  limit = 5_000,
): Promise<B4ShadowSignalEvent[]> {
  const { data, error } = await supabase.rpc("hy_b4_shadow_pending_signal_maturity", {
    p_evaluated_at: evaluatedAt,
    p_limit: Math.min(5_000, Math.max(1, limit)),
  });
  if (error) throw new Error(`Supabase B4 pending maturity lookup failed: ${error.message}`);
  const pending = new Map<string, Set<1 | 4 | 12 | 24>>();
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const eventId = typeof row.event_id === "string" ? row.event_id : null;
    const horizon = Number(row.horizon_hours);
    if (!eventId || !isOutcomeHorizon(horizon)) continue;
    const horizons = pending.get(eventId) ?? new Set<1 | 4 | 12 | 24>();
    horizons.add(horizon);
    pending.set(eventId, horizons);
  }
  return (await fetchEventsByIds(supabase, [...pending.keys()])).map((event) => ({
    ...event,
    pending_horizons: [...(pending.get(event.event_id) ?? [])],
  }));
}

export async function listB4ShadowControlEventsForMaturity(
  supabase: SupabaseClient,
  evaluatedAt: string,
  limit = 5_000,
): Promise<B4ShadowControlEvent[]> {
  const { data, error } = await supabase.rpc("hy_b4_shadow_pending_control_maturity", {
    p_evaluated_at: evaluatedAt,
    p_limit: Math.min(5_000, Math.max(1, limit)),
  });
  if (error) throw new Error(`Supabase B4 pending control maturity lookup failed: ${error.message}`);
  const controls = new Map<string, B4ShadowControlEvent>();
  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    const controlEventId = stringValue(raw.control_event_id);
    const direction = raw.direction === "BULLISH" || raw.direction === "BEARISH" ? raw.direction : null;
    const eventId = stringValue(raw.event_id);
    const symbol = stringValue(raw.symbol);
    const marketTimestamp = stringValue(raw.market_timestamp);
    const pitAvailableAt = stringValue(raw.pit_available_at);
    const referencePrice = Number(raw.reference_price);
    const horizon = Number(raw.horizon_hours);
    if (!controlEventId || !direction || !eventId || !symbol || !marketTimestamp || !pitAvailableAt
      || !Number.isFinite(referencePrice) || referencePrice <= 0 || !isOutcomeHorizon(horizon)) continue;
    const key = `${controlEventId}|${direction}`;
    const current = controls.get(key) ?? {
      control_event_id: controlEventId,
      direction,
      event_id: eventId,
      symbol,
      market_timestamp: marketTimestamp,
      pit_available_at: pitAvailableAt,
      reference_price: referencePrice,
      pending_horizons: [],
    };
    current.pending_horizons = [...new Set([...(current.pending_horizons ?? []), horizon])]
      .filter(isOutcomeHorizon);
    controls.set(key, current);
  }
  return [...controls.values()];
}

export interface B4ShadowMetricReadiness {
  eligible_events: number;
  matched_events: number;
  matching_coverage: number | null;
  signal_1h_precision: number | null;
  control_1h_precision: number | null;
  incremental_precision_lift: number | null;
  bullish_count: number;
  bearish_count: number;
  future_performance_not_calculated: true;
}

export async function getB4ShadowMetricReadiness(
  supabase: SupabaseClient,
): Promise<B4ShadowMetricReadiness> {
  const { data, error } = await supabase.rpc("hy_b4_shadow_metric_readiness");
  if (error) throw new Error(`Supabase B4 metric readiness lookup failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") throw new Error("Supabase B4 metric readiness returned no row");
  const value = row as Record<string, unknown>;
  if (value.future_performance_not_calculated !== true) throw new Error("B4 metric readiness future flag is invalid");
  return {
    eligible_events: integerValue(value.eligible_events),
    matched_events: integerValue(value.matched_events),
    matching_coverage: nullableNumber(value.matching_coverage),
    signal_1h_precision: nullableNumber(value.signal_1h_precision),
    control_1h_precision: nullableNumber(value.control_1h_precision),
    incremental_precision_lift: nullableNumber(value.incremental_precision_lift),
    bullish_count: integerValue(value.bullish_count),
    bearish_count: integerValue(value.bearish_count),
    future_performance_not_calculated: true,
  };
}

/** Persist only complete, non-event PIT observations for future Control-B. */
export async function persistB4ShadowControlCandidate(
  supabase: SupabaseClient,
  observation: import("@/lib/signal-engine/b4-shadow-types").B4ShadowObservation,
): Promise<void> {
  if (!observation.market_data_complete || !observation.rolling_history_ready || !observation.pit_safe
    || !observation.observation_closed || observation.funding_state === null
    || observation.mark_index_basis_state === null || observation.market_regime === "UNKNOWN"
    || observation.volatility_bucket === "UNKNOWN"
    || observation.liquidity_bucket === "UNKNOWN") return;
  const { error } = await supabase
    .from(B4_CONTROL_TABLE)
    .upsert({
      symbol: observation.symbol,
      market_timestamp: observation.market_timestamp,
      pit_available_at: observation.pit_available_at,
      reference_price: observation.perpetual_price,
      calendar_period: observation.calendar_period,
      market_regime: observation.market_regime,
      volatility_bucket: observation.volatility_bucket,
      liquidity_bucket: observation.liquidity_bucket,
      funding_bucket: b4ShadowContextValue(observation.funding_state),
      mark_index_basis_bucket: b4ShadowContextValue(observation.mark_index_basis_state),
      source: "B4_NON_EVENT",
    }, { onConflict: "symbol,market_timestamp" });
  if (error) throw new Error(`Supabase B4 control candidate persistence failed: ${error.message}`);
}

async function fetchEventsByIds(
  supabase: SupabaseClient,
  eventIds: readonly string[],
): Promise<B4ShadowSignalEvent[]> {
  const events: B4ShadowSignalEvent[] = [];
  for (let offset = 0; offset < eventIds.length; offset += 100) {
    const ids = eventIds.slice(offset, offset + 100);
    const { data, error } = await supabase.from(B4_EVENT_TABLE).select("*").in("event_id", ids);
    if (error) throw new Error(`Supabase B4 maturity event lookup failed: ${error.message}`);
    events.push(...(data ?? []).map((row) => parseB4ShadowEvent(row)));
  }
  return events.sort((left, right) => left.market_timestamp.localeCompare(right.market_timestamp)
    || left.event_id.localeCompare(right.event_id));
}

function isOutcomeHorizon(value: number): value is 1 | 4 | 12 | 24 {
  return value === 1 || value === 4 || value === 12 || value === 24;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integerValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  const parsed = Number(value);
  return value === null || value === undefined || !Number.isFinite(parsed) ? null : parsed;
}
