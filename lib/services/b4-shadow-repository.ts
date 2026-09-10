import type { SupabaseClient } from "@supabase/supabase-js";
import {
  parseB4ShadowEvent,
  parseB4ShadowOutcome,
} from "@/lib/signal-engine/b4-shadow-validation";
import type {
  B4ShadowOutcome,
  B4ShadowSignalEvent,
  B4ShadowControlObservation,
} from "@/lib/signal-engine/b4-shadow-types";
import { b4ShadowContextValue } from "@/lib/signal-engine/b4-shadow";
import type { B4ShadowAtomicResult } from "@/lib/signal-engine/b4-shadow-sidecar";

const B4_EVENT_TABLE = "hy_shadow_signal_events";
const B4_OUTCOME_TABLE = "hy_shadow_signal_outcomes";
const B4_CONTROL_TABLE = "hy_b4_shadow_control_candidates";

export interface B4ShadowAtomicTransitionResult {
  result: B4ShadowAtomicResult;
  event_id: string | null;
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
  if (result !== "NEW_EVENT" && result !== "DUPLICATE_TRUE" && result !== "RESET_FALSE"
    && result !== "STALE_OBSERVATION" && result !== "SAME_BAR_RETRY" && result !== "INVARIANT_FAILURE") {
    throw new Error("Supabase B4 atomic transition returned an invalid result");
  }
  return { result, event_id: typeof eventId === "string" ? eventId : null };
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

export async function listB4ShadowSignalEventsForMaturity(
  supabase: SupabaseClient,
  evaluatedAt: string,
  limit = 5_000,
): Promise<B4ShadowSignalEvent[]> {
  const pageSize = Math.min(100, Math.max(1, limit));
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; rows.length < limit; offset += pageSize) {
    const { data, error } = await supabase
      .from(B4_EVENT_TABLE)
      .select("*")
      .lte("market_timestamp", evaluatedAt)
      .order("market_timestamp", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`Supabase B4 maturity event lookup failed: ${error.message}`);
    const page = (data ?? []) as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  const events = rows.slice(0, limit).map((row) => parseB4ShadowEvent(row));
  const pending = new Map<string, Set<number>>(
    events.map((event) => [event.event_id, new Set([1, 4, 12, 24])]),
  );
  for (let offset = 0; offset < events.length; offset += 100) {
    const ids = events.slice(offset, offset + 100).map((event) => event.event_id);
    const { data, error } = await supabase
      .from(B4_OUTCOME_TABLE)
      .select("event_id,horizon_hours")
      .in("event_id", ids);
    if (error) throw new Error(`Supabase B4 maturity outcome lookup failed: ${error.message}`);
    for (const row of data ?? []) {
      const eventId = typeof row.event_id === "string" ? row.event_id : null;
      const horizon = Number(row.horizon_hours);
      if (eventId && pending.has(eventId)) pending.get(eventId)?.delete(horizon);
    }
  }
  return events.map((event) => ({
    ...event,
    pending_horizons: [...(pending.get(event.event_id) ?? new Set<number>())]
      .filter((value): value is 1 | 4 | 12 | 24 => value === 1 || value === 4 || value === 12 || value === 24),
  }));
}

export async function listB4ShadowControlCandidates(
  supabase: SupabaseClient,
  symbols: readonly string[],
  decisionTime: string,
): Promise<B4ShadowControlObservation[]> {
  if (symbols.length === 0) return [];
  const { data, error } = await supabase
    .from(B4_CONTROL_TABLE)
    .select("*")
    .in("symbol", [...new Set(symbols)])
    .lte("pit_available_at", decisionTime)
    .order("pit_available_at", { ascending: false })
    .limit(5_000);
  if (error) throw new Error(`Supabase B4 control candidate lookup failed: ${error.message}`);
  return (data ?? []).flatMap((row) => {
    if (typeof row.control_event_id !== "string" || typeof row.symbol !== "string"
      || typeof row.calendar_period !== "string" || typeof row.market_regime !== "string"
      || typeof row.volatility_bucket !== "string" || typeof row.liquidity_bucket !== "string"
      || typeof row.funding_state !== "string" || typeof row.mark_index_basis_state !== "string"
      || typeof row.pit_available_at !== "string") return [];
    return [{
      control_event_id: row.control_event_id,
      symbol: row.symbol,
      calendar_period: row.calendar_period,
      market_regime: row.market_regime,
      volatility_bucket: row.volatility_bucket,
      liquidity_bucket: row.liquidity_bucket,
      funding_state: row.funding_state,
      mark_index_basis_state: row.mark_index_basis_state,
      pit_available_at: row.pit_available_at,
      market_timestamp: typeof row.market_timestamp === "string" ? row.market_timestamp : undefined,
      reference_price: typeof row.reference_price === "number" ? row.reference_price : Number(row.reference_price),
    } satisfies B4ShadowControlObservation];
  });
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
      funding_state: b4ShadowContextValue(observation.funding_state),
      mark_index_basis_state: b4ShadowContextValue(observation.mark_index_basis_state),
      source: "B4_NON_EVENT",
    }, { onConflict: "symbol,market_timestamp" });
  if (error) throw new Error(`Supabase B4 control candidate persistence failed: ${error.message}`);
}
