import type { SupabaseClient } from "@supabase/supabase-js";
import { parseB4ShadowObservation } from "@/lib/signal-engine/b4-shadow-validation";
import type { B4ShadowObservation } from "@/lib/signal-engine/b4-shadow-types";

export const B4_CONTEXT_STAGING_TABLE = "hy_b4_shadow_context_staging" as const;
export const B4_CONTEXT_FINALIZED_TABLE = "hy_b4_shadow_context_finalized" as const;

export interface B4ShadowContextStageInput {
  contextGroupKey: string;
  marketTimestamp: string;
  expectedSymbols: readonly string[];
  observation: B4ShadowObservation;
  fourHourReturn: number;
  quoteVolumeMean: number;
  volatilityValue: number;
}

export interface B4ShadowFinalizedContext {
  status: "WAITING" | "FINALIZED";
  observations: B4ShadowObservation[];
}

export interface B4ShadowStagedContext {
  symbol: string;
  observation: B4ShadowObservation;
  quoteVolumeMean: number;
  fourHourReturn: number;
  volatilityValue: number;
}

export async function stageB4ShadowContext(
  supabase: SupabaseClient,
  input: B4ShadowContextStageInput,
): Promise<void> {
  const observation = parseB4ShadowObservation(input.observation);
  const fundingBucket = bucketFromState(observation.funding_state);
  const basisBucket = bucketFromState(observation.mark_index_basis_state);
  if (!fundingBucket || !basisBucket || observation.volatility_bucket === "UNKNOWN") {
    throw new Error("B4 context staging requires complete frozen buckets");
  }
  const { error } = await supabase.from(B4_CONTEXT_STAGING_TABLE).upsert({
    context_group_key: input.contextGroupKey,
    market_timestamp: input.marketTimestamp,
    symbol: observation.symbol,
    expected_symbols: [...new Set(input.expectedSymbols)].sort(),
    pit_available_at: observation.pit_available_at,
    reference_price: observation.perpetual_price,
    quote_volume_mean: input.quoteVolumeMean,
    four_hour_return: input.fourHourReturn,
    volatility_value: input.volatilityValue,
    volatility_bucket: observation.volatility_bucket,
    funding_bucket: fundingBucket,
    mark_index_basis_bucket: basisBucket,
    observation,
  }, { onConflict: "context_group_key,market_timestamp,symbol" });
  if (error) throw new Error(`Supabase B4 context staging failed: ${error.message}`);
}

export async function finalizeB4ShadowContext(
  supabase: SupabaseClient,
  input: { contextGroupKey: string; marketTimestamp: string; expectedSymbols: readonly string[] },
): Promise<B4ShadowFinalizedContext> {
  const existing = await getFinalizedB4ShadowContext(supabase, input);
  if (existing) return existing;
  const staged = await supabase
    .from(B4_CONTEXT_STAGING_TABLE)
    .select("*")
    .eq("context_group_key", input.contextGroupKey)
    .eq("market_timestamp", input.marketTimestamp)
    .order("symbol", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (staged.error) throw new Error(`Supabase B4 staging lookup failed: ${staged.error.message}`);
  if (!staged.data) return { status: "WAITING", observations: [] };
  const row = staged.data as Record<string, unknown>;
  const { data, error } = await supabase.rpc("hy_b4_shadow_stage_and_finalize", {
    p_context_group_key: input.contextGroupKey,
    p_market_timestamp: input.marketTimestamp,
    p_symbol: typeof row.symbol === "string" ? row.symbol : input.expectedSymbols[0] ?? "",
    p_expected_symbols: [...new Set(input.expectedSymbols)].sort(),
    p_observation: row.observation,
    p_pit_available_at: row.pit_available_at,
    p_reference_price: row.reference_price,
    p_quote_volume_mean: row.quote_volume_mean,
    p_four_hour_return: row.four_hour_return,
    p_volatility_value: row.volatility_value,
    p_volatility_bucket: row.volatility_bucket,
    p_funding_bucket: row.funding_bucket,
    p_mark_index_basis_bucket: row.mark_index_basis_bucket,
  });
  if (error) throw new Error(`Supabase B4 context finalize failed: ${error.message}`);
  return parseFinalizedResult(data);
}

/** Read durable staged rows before calling Binance. A returned row is already
 * safe to reuse for the same frozen universe/hour context. */
export async function getStagedB4ShadowContexts(
  supabase: SupabaseClient,
  input: { contextGroupKey: string; marketTimestamp: string; symbols: readonly string[] },
): Promise<Map<string, B4ShadowStagedContext>> {
  if (input.symbols.length === 0) return new Map();
  const { data, error } = await supabase
    .from(B4_CONTEXT_STAGING_TABLE)
    .select("symbol,observation,quote_volume_mean,four_hour_return,volatility_value")
    .eq("context_group_key", input.contextGroupKey)
    .eq("market_timestamp", input.marketTimestamp)
    .in("symbol", [...new Set(input.symbols)]);
  if (error) throw new Error(`Supabase B4 staged context lookup failed: ${error.message}`);
  return new Map((data ?? []).flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const symbol = typeof row.symbol === "string" ? row.symbol : null;
    const quoteVolumeMean = Number(row.quote_volume_mean);
    const fourHourReturn = Number(row.four_hour_return);
    const volatilityValue = Number(row.volatility_value);
    if (!symbol || !Number.isFinite(quoteVolumeMean) || !Number.isFinite(fourHourReturn) || !Number.isFinite(volatilityValue)) return [];
    return [[symbol, {
      symbol,
      observation: parseB4ShadowObservation(row.observation),
      quoteVolumeMean,
      fourHourReturn,
      volatilityValue,
    }] as const];
  }));
}

export async function getFinalizedB4ShadowContext(
  supabase: SupabaseClient,
  input: { contextGroupKey: string; marketTimestamp: string; expectedSymbols: readonly string[] },
): Promise<B4ShadowFinalizedContext | null> {
  const { data, error } = await supabase
    .from(B4_CONTEXT_FINALIZED_TABLE)
    .select("expected_symbols,context_rows")
    .eq("context_group_key", input.contextGroupKey)
    .eq("market_timestamp", input.marketTimestamp)
    .maybeSingle();
  if (error) throw new Error(`Supabase B4 finalized context lookup failed: ${error.message}`);
  if (!data) return null;
  const expectedSymbols = [...new Set(input.expectedSymbols)].sort();
  const storedSymbols = Array.isArray(data.expected_symbols)
    ? data.expected_symbols.filter((value): value is string => typeof value === "string").sort()
    : [];
  if (storedSymbols.length !== expectedSymbols.length
    || storedSymbols.some((value, index) => value !== expectedSymbols[index])) return null;
  return {
    status: "FINALIZED",
    observations: parseRows(data.context_rows),
  };
}

function parseFinalizedResult(value: unknown): B4ShadowFinalizedContext {
  if (!value || typeof value !== "object") throw new Error("B4 context finalize returned no result");
  const result = value as Record<string, unknown>;
  const status = result.status === "FINALIZED" ? "FINALIZED" : result.status === "WAITING" ? "WAITING" : null;
  if (!status) throw new Error("B4 context finalize returned invalid status");
  return { status, observations: status === "FINALIZED" ? parseRows(result.context_rows) : [] };
}

function parseRows(value: unknown): B4ShadowObservation[] {
  if (!Array.isArray(value)) throw new Error("B4 finalized context rows are invalid");
  return value.map((row) => parseB4ShadowObservation(row));
}

function bucketFromState(value: B4ShadowObservation["funding_state"]): string | null {
  const bucket = value && typeof value.bucket === "string" ? value.bucket : null;
  return bucket && bucket !== "UNKNOWN" ? bucket : null;
}
