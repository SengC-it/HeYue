import type { RuntimeStrategyPolicy } from "@/lib/core/runtime-strategy";
import { parseRuntimeStrategyPolicy } from "@/lib/core/runtime-strategy";
import {
  passesStrategyApprovalGate,
  type StrategyApprovalGate,
} from "@/lib/core/strategy-approval";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function loadApprovedStrategyPolicy(
  supabase: SupabaseClient,
  configuredPolicy: RuntimeStrategyPolicy,
  gate: StrategyApprovalGate,
  stage: "PAPER" | "ACTIVE" = "ACTIVE",
): Promise<RuntimeStrategyPolicy> {
  const { data, error } = await supabase
    .from("hy_strategy_versions")
    .select("version, strategy_family, parameters, metrics, status")
    .eq("version", configuredPolicy.version)
    .eq("status", stage)
    .maybeSingle();
  if (error) throw new Error(`Supabase strategy lookup failed: ${error.message}`);
  if (!data) throw new Error(`No ${stage} strategy version found for ${configuredPolicy.version}`);
  if (!passesStrategyApprovalGate(data.metrics, gate)) {
    throw new Error(`Strategy version ${configuredPolicy.version} failed the approval gate`);
  }

  const parameters = asRecord(data.parameters);
  if (!parameters?.runtime) {
    throw new Error(`Strategy version ${configuredPolicy.version} has no runtime policy payload`);
  }
  return parseRuntimeStrategyPolicy(parameters.runtime, configuredPolicy.version);
}

export async function activateStrategyVersion(
  supabase: SupabaseClient,
  input: { version: string; targetStatus: "PAPER" | "ACTIVE"; gate: StrategyApprovalGate },
): Promise<unknown> {
  const { data, error } = await supabase.rpc("hy_promote_strategy_version", {
    p_version: input.version,
    p_target_status: input.targetStatus,
    p_min_profit_factor: input.gate.minProfitFactor,
    p_min_oos_signals: input.gate.minOutOfSampleSignals,
    p_max_drawdown_percent: input.gate.maxDrawdownPercent,
  });
  if (error) throw new Error(`Supabase strategy promotion failed: ${error.message}`);
  return data;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
