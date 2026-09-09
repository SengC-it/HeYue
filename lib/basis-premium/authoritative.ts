import {
  R58_BASIS_PREMIUM_FAMILIES,
  R58_DIRECTIONS,
  R58_HORIZONS,
  type ExpectedHashMap,
  type HashGateResult,
  type JsonRecord,
} from "./information-gain";
import type { HypothesisManifest } from "./hypothesis";

export const R58B_EXPECTED_R57_HASHES: ExpectedHashMap = {
  coverage_matrix: "add14656788d11e4852840956895803c26c4eb8a10053c2e50d8bbadf9278447",
  schema_manifest: "17da39cd0ad500b21b2f1380bf526bdc1175738091f5b0ada05d0e73dcd3288a",
  feature_specification: "bbdaab9e4cba4c22e50471d538d808fca992e812aaff60a0fc3f70af6020cf51",
  dataset_manifest: "4a6c99a36df032f605b96a63dffda35beb2cce60679281368070da57480f8da0",
};

export const R58B_EXPECTED_R58A_HYPOTHESIS_HASH = "0b5a790a1783704fc5eb130c4d1fa65c865339e68232fa1b54af9012c58db0f3";
export const R58B_AUTHORITATIVE_PERFORMANCE_COUNT = 1;
export const R58B_CONTROL_A_DIMENSIONS = [
  "symbol",
  "calendar_period",
  "market_regime",
  "volatility_bucket",
  "liquidity_bucket",
] as const;
export const R58B_CONTROL_B_ADDITIONS = [
  "funding_state_bucket",
  "existing_mark_index_basis_state_bucket",
] as const;

export interface EventEligibilityAudit {
  id: string;
  status: "COMPLETE" | "SPECIFICATION_INCOMPLETE";
  missing_fields: string[];
  reason: string;
}

export type MatchingGate = "ROBUST_ELIGIBLE" | "CONDITIONAL_MAX" | "MATCHING_INADEQUATE_COMPONENT";

export interface PositiveClassificationInput {
  incrementalPositive: boolean;
  confidenceLowerBoundPositive: boolean;
  holmSignificant: boolean;
  matchingCoveragePercent: number;
  covariateBalanceAcceptable: boolean;
  meaningfulSample: boolean;
  stableAcrossQuarters: boolean;
  stableAcrossRegimes: boolean;
  largestSymbolShare: number;
}

export function verifyR58BHashGate(
  r57Gate: HashGateResult,
  r58aHypothesisHash: string,
): { passed: boolean; mismatches: string[] } {
  const mismatches = [...r57Gate.mismatches];
  if (!r57Gate.passed) mismatches.push("r57_artifact_hash_gate");
  if (r58aHypothesisHash !== R58B_EXPECTED_R58A_HYPOTHESIS_HASH) mismatches.push("r58a_hypothesis_manifest");
  return { passed: mismatches.length === 0, mismatches };
}

export function auditEventEligibility(manifest: HypothesisManifest): EventEligibilityAudit[] {
  return manifest.hypotheses.map((hypothesis) => ({
    id: hypothesis.id,
    status: "SPECIFICATION_INCOMPLETE",
    missing_fields: ["explicit_event_condition", "extreme_threshold_or_cutoff"],
    reason: `R5.8A references the R5.7 ${hypothesis.id} methodology but does not contain an executable event condition or fixed threshold/cutoff; adding one now would be post-freeze selection.`,
  }));
}

export function matchingGate(coveragePercent: number): MatchingGate {
  if (!Number.isFinite(coveragePercent) || coveragePercent < 60) return "MATCHING_INADEQUATE_COMPONENT";
  if (coveragePercent < 70) return "CONDITIONAL_MAX";
  return "ROBUST_ELIGIBLE";
}

export function robustPositiveGate(input: PositiveClassificationInput): boolean {
  return input.incrementalPositive
    && input.confidenceLowerBoundPositive
    && input.holmSignificant
    && matchingGate(input.matchingCoveragePercent) === "ROBUST_ELIGIBLE"
    && input.covariateBalanceAcceptable
    && input.meaningfulSample
    && input.stableAcrossQuarters
    && input.stableAcrossRegimes
    && input.largestSymbolShare <= 0.5;
}

export function conditionalPositiveGate(input: PositiveClassificationInput): boolean {
  return input.incrementalPositive
    && matchingGate(input.matchingCoveragePercent) === "CONDITIONAL_MAX"
    && input.covariateBalanceAcceptable;
}

export function negativeResultNoRescue(result: string): boolean {
  return result === "NO_INCREMENTAL_INFORMATION";
}

export function formalHolmTestIds(): string[] {
  return R58_BASIS_PREMIUM_FAMILIES.flatMap((family) => R58_DIRECTIONS.flatMap((direction) => R58_HORIZONS.map((horizon) => `${family}:${direction}:${horizon}`)));
}

export function formalHolmFamilySize(): number {
  return formalHolmTestIds().length;
}

export function emptyDirectionalMetric(family: string, direction: string, horizon: string): JsonRecord {
  return {
    family,
    direction,
    horizon,
    status: "RESEARCH_INVALID",
    eligible_events: 0,
    matched_events: 0,
    unmatched_events: 0,
    matching_coverage_percent: null,
    signal_precision: null,
    control_a_precision: null,
    control_b_precision: null,
    incremental_lift_vs_control_a: null,
    incremental_lift_vs_control_b: null,
    mean_directional_return_effect: null,
    median_directional_return_effect: null,
    mfe_effect: null,
    mae_effect: null,
    median_mfe: null,
    median_mae: null,
    confidence_interval_95: null,
    effect_size: null,
    raw_p_value: null,
    holm_adjusted_p_value: null,
  };
}
