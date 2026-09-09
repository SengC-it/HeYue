import { sha256Json } from "../crowding";
import { eventFromTransition } from "./hypothesis";

export const R58A1_R57_FEATURE_SPECIFICATION_HASH = "bbdaab9e4cba4c22e50471d538d808fca992e812aaff60a0fc3f70af6020cf51";
export const R58A1_R58A_HYPOTHESIS_MANIFEST_HASH = "0b5a790a1783704fc5eb130c4d1fa65c865339e68232fa1b54af9012c58db0f3";
export const R58A1_ROLLING_MINIMUM_HISTORY = 720;
export const R58A1_B1_B2_B3_UPPER_PERCENTILE = 0.95;
export const R58A1_B1_B2_B3_LOWER_PERCENTILE = 0.05;
export const R58A1_B4_UPPER_PERCENTILE = 0.75;
export const R58A1_B4_LOWER_PERCENTILE = 0.25;
export const R58A1_B5_UPPER_PERCENTILE = 0.9;
export const R58A1_B5_LOWER_PERCENTILE = 0.1;

export type CutoffDirection = "BULLISH" | "BEARISH";

export interface SignedExtremeInput {
  value: number | null;
  rollingPercentile: number | null;
  historyAvailable: boolean;
}

export interface DivergenceInput {
  priceChangePercentile: number | null;
  premiumChangePercentile: number | null;
  historyAvailable: boolean;
}

export interface CrossSectionalRank {
  id: string;
  value: number;
  rank: number;
  percentile: number | null;
}

export interface CrossSectionalValue {
  id: string;
  value: number | null;
}

function finite(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

export function hasFrozenRollingHistory(observationCount: number, minimumHistory = R58A1_ROLLING_MINIMUM_HISTORY): boolean {
  return Number.isInteger(observationCount)
    && observationCount >= minimumHistory
    && minimumHistory > 0;
}

export function signedExtremeDirection(input: SignedExtremeInput): CutoffDirection | null {
  if (!input.historyAvailable || !finite(input.value) || !finite(input.rollingPercentile)) return null;
  if (input.value > 0 && input.rollingPercentile >= R58A1_B1_B2_B3_UPPER_PERCENTILE) return "BEARISH";
  if (input.value < 0 && input.rollingPercentile <= R58A1_B1_B2_B3_LOWER_PERCENTILE) return "BULLISH";
  return null;
}

export function b1BasisDirection(input: SignedExtremeInput): CutoffDirection | null {
  return signedExtremeDirection(input);
}

export function b2PremiumDirection(input: SignedExtremeInput): CutoffDirection | null {
  return signedExtremeDirection(input);
}

export function b3SignedExpansionDirection(input: SignedExtremeInput): CutoffDirection | null {
  return signedExtremeDirection(input);
}

export function b4DivergenceDirection(input: DivergenceInput): CutoffDirection | null {
  if (!input.historyAvailable || !finite(input.priceChangePercentile) || !finite(input.premiumChangePercentile)) return null;
  if (input.priceChangePercentile >= R58A1_B4_UPPER_PERCENTILE
    && input.premiumChangePercentile <= R58A1_B4_LOWER_PERCENTILE) return "BEARISH";
  if (input.priceChangePercentile <= R58A1_B4_LOWER_PERCENTILE
    && input.premiumChangePercentile >= R58A1_B4_UPPER_PERCENTILE) return "BULLISH";
  return null;
}

export function averageRankPercentile(rank: number, sampleSize: number): number | null {
  if (!Number.isFinite(rank) || !Number.isFinite(sampleSize) || sampleSize < 2 || rank < 1 || rank > sampleSize) return null;
  return (rank - 1) / (sampleSize - 1);
}

export function rankCrossSectionalPremium(values: CrossSectionalValue[]): CrossSectionalRank[] {
  const valid = values
    .filter((value) => finite(value.value))
    .map((value) => ({ id: value.id, value: value.value as number }));
  if (valid.length < 2) return valid.map((value) => ({ ...value, rank: 1, percentile: null }));
  const sorted = [...valid].sort((left, right) => left.value - right.value || left.id.localeCompare(right.id));
  const output: CrossSectionalRank[] = [];
  for (let index = 0; index < sorted.length;) {
    let end = index + 1;
    while (end < sorted.length && sorted[end].value === sorted[index].value) end += 1;
    const rank = (index + 1 + end) / 2;
    const percentile = averageRankPercentile(rank, sorted.length);
    for (let current = index; current < end; current += 1) {
      output.push({ id: sorted[current].id, value: sorted[current].value, rank, percentile });
    }
    index = end;
  }
  return output.sort((left, right) => left.id.localeCompare(right.id));
}

export function b5CrossSectionalDirection(percentile: number | null, sampleSize: number): CutoffDirection | null {
  if (!finite(percentile) || sampleSize < 2) return null;
  if (percentile >= R58A1_B5_UPPER_PERCENTILE) return "BEARISH";
  if (percentile <= R58A1_B5_LOWER_PERCENTILE) return "BULLISH";
  return null;
}

export function cutoffEventFromTransition(previousEligible: boolean, currentEligible: boolean): boolean {
  return eventFromTransition(previousEligible, currentEligible);
}

export function directionalCutoffEvent(
  previousDirection: CutoffDirection | null,
  currentDirection: CutoffDirection | null,
  direction: CutoffDirection,
): boolean {
  return cutoffEventFromTransition(previousDirection === direction, currentDirection === direction);
}

export function pitEventTimestamp(observationStart: number, intervalMs: number): number | null {
  if (!Number.isFinite(observationStart) || !Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  return observationStart + intervalMs;
}

export function isPitEventAvailable(observationStart: number, intervalMs: number, decisionTime: number): boolean {
  const availableAt = pitEventTimestamp(observationStart, intervalMs);
  return availableAt !== null && Number.isFinite(decisionTime) && availableAt <= decisionTime;
}

export function buildR58A1CutoffManifest(): Record<string, unknown> {
  return {
    research: "HY-R5.8A.1 EXACT BASIS/PREMIUM EVENT CUTOFF FREEZE",
    version: "hy-r5.8a1-basis-premium-event-cutoff-v1",
    immutable: true,
    frozen_input_hashes: {
      r57_feature_specification: R58A1_R57_FEATURE_SPECIFICATION_HASH,
      r58a_hypothesis_manifest: R58A1_R58A_HYPOTHESIS_MANIFEST_HASH,
    },
    unchanged_contracts: {
      feature_calculations: true,
      rolling_windows: "R5.7 frozen rolling window and minimum history; 720 prior completed 1h observations where applicable",
      source_data: true,
      pit_contract: true,
      direction_semantics: true,
      event_dedup_semantics: true,
    },
    general_percentile_rule: {
      distribution: "R5.7 PIT-safe rolling distribution of prior completed observations",
      full_sample_percentile: false,
      future_data: false,
      lookback_reselected: false,
      insufficient_frozen_history: "NO_EVENT",
      minimum_history: R58A1_ROLLING_MINIMUM_HISTORY,
    },
    cutoffs: {
      B1: {
        name: "PERP_INDEX_BASIS",
        bearish: { raw_basis: "> 0", rolling_percentile: ">= 0.95" },
        bullish: { raw_basis: "< 0", rolling_percentile: "<= 0.05" },
        other: "NO_EVENT",
      },
      B2: {
        name: "PREMIUM_EXTREME",
        bearish: { premium: "> 0", rolling_percentile: ">= 0.95" },
        bullish: { premium: "< 0", rolling_percentile: "<= 0.05" },
        other: "NO_EVENT",
      },
      B3: {
        name: "PREMIUM_EXPANSION_COMPRESSION",
        signed_primitive: "R5.7 frozen premium change/acceleration expansion-compression primitive; no new formula",
        bearish: { signed_expansion: "> 0", rolling_percentile: ">= 0.95" },
        bullish: { signed_expansion: "< 0", rolling_percentile: "<= 0.05" },
        unavailable_signed_primitive: "SPECIFICATION_INCOMPATIBLE",
        other: "NO_EVENT",
      },
      B4: {
        name: "PRICE_PREMIUM_DIVERGENCE",
        bearish: { price_change_percentile: ">= 0.75", premium_change_percentile: "<= 0.25" },
        bullish: { price_change_percentile: "<= 0.25", premium_change_percentile: ">= 0.75" },
        other: "NO_EVENT",
      },
      B5: {
        name: "CROSS_SECTIONAL_PREMIUM",
        population: "same-timestamp ACTIVE, complete, PIT-available symbols only",
        bearish: { cross_sectional_percentile: ">= 0.90" },
        bullish: { cross_sectional_percentile: "<= 0.10" },
        other: "NO_EVENT",
      },
    },
    b5_tie_method: {
      method: "average_rank",
      deterministic_secondary_order: "symbol ascending",
      percentile: "(rank - 1) / (N - 1)",
      n_less_than_two: "NO_EVENT",
    },
    event_formation: {
      rule: "FALSE_TO_TRUE_TRANSITION",
      repeated_true: "NO_NEW_EVENT",
      true_to_false: "EPISODE_RESET",
      direction_state: "Bullish and bearish conditions are maintained independently; mutually exclusive cutoffs allow at most one direction per observation.",
      zero_or_ambiguous: "NO_EVENT",
    },
    pit_event_timing: {
      raw_timestamp: "1h observation open time / period-start label",
      availability: "open_time + interval duration after the observation is complete",
      event_timestamp: "open_time + 1h for the frozen 1h observation",
      decision_rule: "Only observations with open_time + interval <= decision time may form an event.",
    },
    missing_data: {
      required_primitive_missing: "NO_EVENT / DATA_INCOMPLETE",
      forward_fill: false,
      zero_fill: false,
      interpolation: false,
      future_observation_fill: false,
    },
    outcome_boundary: {
      future_outcomes_generated: 0,
      authoritative_performance_executions: 0,
      outcome_metrics_calculated: false,
      historical_event_counts_used_for_cutoff_selection: false,
    },
    governance: {
      preperformance_validation_attempts: 2,
      performance_lock: "NOT_TRIGGERED",
      auto_trading: false,
    },
  };
}

export function cutoffManifestHash(manifest: Record<string, unknown>): string {
  return sha256Json(manifest);
}
