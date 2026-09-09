import type { SupabaseClient } from "@supabase/supabase-js";
import {
  parseB4ShadowEvent,
  parseB4ShadowOutcome,
} from "@/lib/signal-engine";
import type {
  B4ShadowOutcome,
  B4ShadowSignalEvent,
} from "@/lib/signal-engine";

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
