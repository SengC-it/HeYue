import type { SupabaseClient } from "@supabase/supabase-js";
import {
  alertDeliveryInputSchema,
  signalFeedbackInputSchema,
  signalFeatureInputSchema,
  signalIntelligenceEventInputSchema,
  signalReplayInputSchema,
} from "@/lib/signal-intelligence/validation";
import type {
  AlertDelivery,
  AlertDeliveryInput,
  SignalFeedback,
  SignalFeedbackInput,
  SignalFeatureInput,
  SignalFeatureSnapshot,
  SignalIntelligenceEvent,
  SignalIntelligenceEventInput,
  SignalReplay,
  SignalReplayInput,
} from "@/lib/signal-intelligence/types";

export async function createSignalIntelligenceEvent(
  supabase: SupabaseClient,
  input: SignalIntelligenceEventInput,
): Promise<SignalIntelligenceEvent> {
  const row = omitUndefined(signalIntelligenceEventInputSchema.parse(input));
  return insertOne<SignalIntelligenceEvent>(
    supabase,
    "hy_signal_intelligence_events",
    row,
    "signal intelligence event",
  );
}

export async function createSignalFeatureSnapshot(
  supabase: SupabaseClient,
  input: SignalFeatureInput,
): Promise<SignalFeatureSnapshot> {
  const row = omitUndefined(signalFeatureInputSchema.parse(input));
  return insertOne<SignalFeatureSnapshot>(
    supabase,
    "hy_signal_features",
    row,
    "signal feature snapshot",
  );
}

export async function createAlertDelivery(
  supabase: SupabaseClient,
  input: AlertDeliveryInput,
): Promise<AlertDelivery> {
  const parsed = alertDeliveryInputSchema.parse({
    ...input,
    idempotency_key: input.idempotency_key
      ?? [input.signal_id, input.channel ?? "EMAIL", input.email].join(":"),
  });
  const row = omitUndefined(parsed);
  return insertOne<AlertDelivery>(
    supabase,
    "hy_alert_delivery",
    row,
    "alert delivery",
  );
}

export async function createSignalReplay(
  supabase: SupabaseClient,
  input: SignalReplayInput,
): Promise<SignalReplay> {
  const row = omitUndefined(signalReplayInputSchema.parse(input));
  return insertOne<SignalReplay>(
    supabase,
    "hy_signal_replays",
    row,
    "signal replay",
  );
}

export async function createSignalFeedback(
  supabase: SupabaseClient,
  input: SignalFeedbackInput,
): Promise<SignalFeedback> {
  const row = omitUndefined(signalFeedbackInputSchema.parse(input));
  return insertOne<SignalFeedback>(
    supabase,
    "hy_signal_feedback",
    row,
    "signal feedback",
  );
}

async function insertOne<T>(
  supabase: SupabaseClient,
  table: string,
  row: Record<string, unknown>,
  label: string,
): Promise<T> {
  const { data, error } = await supabase
    .from(table)
    .insert(row)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error("Supabase " + label + " insert failed: " + (error?.message ?? "empty response"));
  }
  return data as T;
}

function omitUndefined(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== undefined),
  );
}
