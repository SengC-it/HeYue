import { sha256Json } from "../crowding";
import {
  makeExistingInformationMatchKey,
  type MatchablePoint,
} from "./information-gain";
import {
  R58C_CONTAMINATED_WINDOW,
  R59_CLEAN_DISCOVERY_WINDOW,
  R59_RESERVED_HOLDOUT,
} from "./clean-window";

export const R510A_EXPERIMENT_ID = "HY-R5.10A";
export const R510A_CANDIDATE = "B4 PRICE_PREMIUM_DIVERGENCE";
export const R510A_PRIMARY_HYPOTHESIS = "H-B4-1H-POOLED";
export const R510A_PRIMARY_METRIC = "POOLED_DIRECTIONAL_1H_INCREMENTAL_PRECISION";
export const R510A_RESOLUTION = "1h" as const;
export const R510A_INTERVAL_MS = 3_600_000;
export const R510A_ROLLING_HISTORY = 720;
export const R510A_PRE_TREATMENT_TV_THRESHOLD = 0.20;
export const R510A_MINIMUM_SAMPLE = {
  pooled: 1_000,
  bullish: 300,
  bearish: 300,
} as const;
export const R510A_MATCHING_COVERAGE_MINIMUM = {
  pooled: 70,
  bullish: 60,
  bearish: 60,
} as const;
export const R510A_MATCH_FIELDS = [
  "symbol",
  "calendar_period",
  "market_regime",
  "volatility_bucket",
  "liquidity_bucket",
  "funding_bucket",
  "mark_index_basis_bucket",
] as const;

export const R510A_SECONDARY_HYPOTHESES = [
  "B4_BULLISH_1H",
  "B4_BEARISH_1H",
  "B4_POOLED_4H",
  "B4_BULLISH_4H",
  "B4_BEARISH_4H",
] as const;

export type R510AClassification =
  | "HOLDOUT_PROTOCOL_READY"
  | "HOLDOUT_DATA_NOT_READY"
  | "HOLDOUT_MATCHING_NOT_READY"
  | "HOLDOUT_PROTOCOL_INVALID";

export type R510AFundingBucket = "NEGATIVE" | "NEUTRAL" | "POSITIVE";

export interface R510AFundingObservation {
  fundingTime: number;
  fundingRate: number;
  pitAvailableAt?: number;
  fundingIntervalHours?: number;
}

export interface R510AFundingMapping {
  observation: R510AFundingObservation | null;
  bucket: R510AFundingBucket | null;
  status: "COMPLETE" | "CONTROL_DATA_INCOMPLETE";
}

export interface R510ASampleGateInput {
  pooled: number;
  bullish: number;
  bearish: number;
}

export interface R510ACoverageGateInput {
  pooled: number;
  bullish: number;
  bearish: number;
}

/**
 * R5.9B froze five Funding bands. R5.10A keeps those boundaries and collapses
 * them into the protocol's required three signed control buckets.
 */
export function bucketFundingR510A(rate: number | null): R510AFundingBucket | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  if (rate <= -0.0003 || rate < -0.00005) return "NEGATIVE";
  if (rate <= 0.00005) return "NEUTRAL";
  return "POSITIVE";
}

export function mapFundingAtDecision(
  observations: R510AFundingObservation[],
  decisionTime: number,
): R510AFundingMapping {
  if (!Number.isFinite(decisionTime)) return { observation: null, bucket: null, status: "CONTROL_DATA_INCOMPLETE" };
  let low = 0;
  let high = observations.length - 1;
  let selected: R510AFundingObservation | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = observations[middle]!;
    const availableAt = candidate.pitAvailableAt ?? candidate.fundingTime;
    if (candidate.fundingTime <= decisionTime && availableAt <= decisionTime) {
      selected = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const bucket = selected === null ? null : bucketFundingR510A(selected.fundingRate);
  return {
    observation: selected,
    bucket,
    status: selected !== null && bucket !== null ? "COMPLETE" : "CONTROL_DATA_INCOMPLETE",
  };
}

export function existingInformationMatchKey(input: {
  symbol: string;
  calendarPeriod: string;
  marketRegime: string;
  volatilityBucket: string;
  liquidityBucket: string;
  fundingBucket: string;
  markIndexBasisBucket: string;
}): string {
  return makeExistingInformationMatchKey(input);
}

export function featureStrengthIsExcludedFromMatching(fields: readonly string[] = R510A_MATCH_FIELDS): boolean {
  return !fields.some((field) => field === "feature_strength" || field === "b4_feature_strength");
}

export function featureStrengthAuditIsNotBalanceGate(): boolean {
  return true;
}

export function preTreatmentBalancePass(
  maxTotalVariation: number | null,
  threshold = R510A_PRE_TREATMENT_TV_THRESHOLD,
): boolean {
  return maxTotalVariation !== null
    && Number.isFinite(maxTotalVariation)
    && Number.isFinite(threshold)
    && maxTotalVariation <= threshold;
}

export function minimumSampleGate(input: R510ASampleGateInput): boolean {
  return input.pooled >= R510A_MINIMUM_SAMPLE.pooled
    && input.bullish >= R510A_MINIMUM_SAMPLE.bullish
    && input.bearish >= R510A_MINIMUM_SAMPLE.bearish;
}

export function matchingCoverageGate(input: R510ACoverageGateInput): boolean {
  return input.pooled >= R510A_MATCHING_COVERAGE_MINIMUM.pooled
    && input.bullish >= R510A_MATCHING_COVERAGE_MINIMUM.bullish
    && input.bearish >= R510A_MATCHING_COVERAGE_MINIMUM.bearish;
}

export function pooledMatchingCoveragePercent(matched: number, eligible: number): number | null {
  return eligible > 0 ? matched / eligible * 100 : null;
}

export function assertB4Only(candidate: string): void {
  if (candidate !== "B4") throw new Error("B4_ONLY_GUARD_FAILED");
}

export function assertR510AHoldoutRange(start: number, endExclusive: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(endExclusive) || endExclusive <= start) {
    throw new Error("HOLDOUT_RANGE_INVALID");
  }
  if (start !== R59_RESERVED_HOLDOUT.start) throw new Error("HOLDOUT_START_NOT_RESERVED");
  if (start < R58C_CONTAMINATED_WINDOW.endExclusive && endExclusive > R58C_CONTAMINATED_WINDOW.start) {
    throw new Error("CONTAMINATED_WINDOW_FORBIDDEN");
  }
}

export function rejectHistoricalR510AWindow(start: number, endExclusive: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(endExclusive) || endExclusive <= start) {
    throw new Error("HOLDOUT_RANGE_INVALID");
  }
  if (start < R58C_CONTAMINATED_WINDOW.endExclusive && endExclusive > R58C_CONTAMINATED_WINDOW.start) {
    throw new Error("CONTAMINATED_WINDOW_FORBIDDEN");
  }
  if (start >= R59_CLEAN_DISCOVERY_WINDOW.start && endExclusive <= R59_CLEAN_DISCOVERY_WINDOW.endExclusive) {
    throw new Error("DISCOVERY_WINDOW_FORBIDDEN");
  }
}

export function outcomeWindowIsLocked(classification: R510AClassification): boolean {
  return classification === "HOLDOUT_PROTOCOL_READY";
}

export function assertAllowedR510AClassification(value: string): asserts value is R510AClassification {
  if (![
    "HOLDOUT_PROTOCOL_READY",
    "HOLDOUT_DATA_NOT_READY",
    "HOLDOUT_MATCHING_NOT_READY",
    "HOLDOUT_PROTOCOL_INVALID",
  ].includes(value)) throw new Error("R510A_CLASSIFICATION_INVALID");
}

export function protocolManifestHash(protocol: unknown, hypothesis: unknown): string {
  return sha256Json({ protocol, hypothesis });
}

export function isMatchablePoint(value: MatchablePoint): boolean {
  return Number.isFinite(value.time) && value.matchKey.length > 0;
}
