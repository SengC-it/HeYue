import { sha256Json } from "../crowding";

export const R58A_R57_FEATURE_SPECIFICATION_HASH = "bbdaab9e4cba4c22e50471d538d808fca992e812aaff60a0fc3f70af6020cf51";
export const R58A_PRIMARY_HORIZONS = ["1h", "4h"] as const;
export const R58A_SECONDARY_HORIZONS = ["12h", "24h"] as const;

export type R58ADirection = "BULLISH" | "BEARISH";
export type R58APriceTrend = "UP" | "DOWN" | "AMBIGUOUS";
export type R58APremiumTrend = "UP" | "DOWN" | "AMBIGUOUS";
export type R58AEventState = "EVENT" | "NO_EVENT";

export interface HypothesisManifest {
  research: string;
  version: string;
  r57_feature_specification_hash: string;
  feature_specification_unchanged: boolean;
  authoritative_performance_count: number;
  preperformance_validation_attempts: number;
  future_performance_calculated: boolean;
  hypotheses: Array<{
    id: "B1" | "B2" | "B3" | "B4" | "B5";
    hypothesis: string;
    direction_mapping: JsonRecord;
    event_eligibility: string;
  }>;
  event_semantics: JsonRecord;
  horizons: JsonRecord;
  existing_information_controls: JsonRecord;
}

export type JsonRecord = Record<string, unknown>;

export function mapSignedMeanReversion(value: number): R58ADirection | null {
  if (!Number.isFinite(value) || value === 0) return null;
  return value > 0 ? "BEARISH" : "BULLISH";
}

export function mapRelativePremium(level: "HIGH" | "LOW" | "AMBIGUOUS"): R58ADirection | null {
  if (level === "HIGH") return "BEARISH";
  if (level === "LOW") return "BULLISH";
  return null;
}

export function mapDivergenceDirection(
  priceTrend: R58APriceTrend,
  premiumTrend: R58APremiumTrend,
): R58ADirection | null {
  if (priceTrend === "UP" && premiumTrend === "DOWN") return "BEARISH";
  if (priceTrend === "DOWN" && premiumTrend === "UP") return "BULLISH";
  return null;
}

export function eventFromTransition(previousEligible: boolean, currentEligible: boolean): boolean {
  return previousEligible === false && currentEligible === true;
}

export function isPitEventAvailable(observationStart: number, intervalMs: number, decisionTime: number): boolean {
  return Number.isFinite(observationStart)
    && Number.isFinite(intervalMs)
    && Number.isFinite(decisionTime)
    && observationStart + intervalMs <= decisionTime;
}

export function buildR58AHypothesisManifest(): HypothesisManifest {
  return {
    research: "HY-R5.8A BASIS / PREMIUM DIRECTIONAL HYPOTHESIS + EVENT SEMANTICS FREEZE",
    version: "hy-r5.8a-basis-premium-hypothesis-v1",
    r57_feature_specification_hash: R58A_R57_FEATURE_SPECIFICATION_HASH,
    feature_specification_unchanged: true,
    authoritative_performance_count: 0,
    preperformance_validation_attempts: 1,
    future_performance_calculated: false,
    hypotheses: [
      {
        id: "B1",
        hypothesis: "MEAN_REVERSION",
        direction_mapping: { positive_basis: "BEARISH", negative_basis: "BULLISH", zero_or_ambiguous: "NO_EVENT" },
        event_eligibility: "Use the R5.7 frozen B1 extreme methodology exactly; no continuation test.",
      },
      {
        id: "B2",
        hypothesis: "MEAN_REVERSION",
        direction_mapping: { positive_premium_extreme: "BEARISH", negative_premium_extreme: "BULLISH", zero_or_ambiguous: "NO_EVENT" },
        event_eligibility: "Use the R5.7 frozen B2 premium extreme methodology; Funding is not the direction source.",
      },
      {
        id: "B3",
        hypothesis: "DISLOCATION_REVERSION",
        direction_mapping: { positive_premium_sign: "BEARISH", negative_premium_sign: "BULLISH", zero_or_ambiguous: "NO_EVENT" },
        event_eligibility: "Use the R5.7 frozen premium change/acceleration expansion-compression methodology; no result-driven continuation relabeling.",
      },
      {
        id: "B4",
        hypothesis: "DIVERGENCE_REVERSAL",
        direction_mapping: {
          price_up_premium_down: "BEARISH",
          price_down_premium_up: "BULLISH",
          other_or_ambiguous: "NO_EVENT",
        },
        event_eligibility: "Only the R5.7 frozen price/premium divergence state forms an event.",
      },
      {
        id: "B5",
        hypothesis: "CROSS_SECTIONAL_MEAN_REVERSION",
        direction_mapping: { high_premium: "BEARISH", low_premium: "BULLISH", zero_or_ambiguous: "NO_EVENT" },
        event_eligibility: "Use the R5.7 PIT-safe same-timestamp active-universe ranking; missing or unavailable symbols do not rank.",
      },
    ],
    event_semantics: {
      formation: "FALSE_TO_TRUE_TRANSITION",
      repeated_true_deduplicated: true,
      episode_reset: "A false eligible observation resets the episode; a later false-to-true transition may create one new event.",
      continuous_true: "No repeated event per bar.",
      pit_event_timestamp: "The first legal decision timestamp after the current observation is fully available; for a 1h bar labeled by period start, open_time + 1h.",
      zero_or_ambiguous_sign: "NO_EVENT",
      ambiguous_b4: "NO_EVENT",
    },
    horizons: {
      primary: [...R58A_PRIMARY_HORIZONS],
      secondary: [...R58A_SECONDARY_HORIZONS],
      outcome_calculation_in_this_freeze: false,
    },
    existing_information_controls: {
      required: true,
      control_a: ["symbol", "calendar_period", "market_regime", "volatility_bucket", "liquidity_bucket"],
      control_b_additions: ["funding_state_bucket", "existing_mark_index_basis_state_bucket"],
      future_outcome_matching: false,
      b1_attribution: "Compare raw B1 against existing Mark/Index basis; do not credit the existing baseline as new alpha.",
    },
  };
}

export function hypothesisManifestHash(manifest: HypothesisManifest): string {
  return sha256Json(manifest);
}

export function validateR58AHypothesisManifest(manifest: HypothesisManifest): string[] {
  const errors: string[] = [];
  if (manifest.r57_feature_specification_hash !== R58A_R57_FEATURE_SPECIFICATION_HASH) errors.push("r57_feature_specification_hash");
  if (manifest.feature_specification_unchanged !== true) errors.push("feature_specification_unchanged");
  if (manifest.authoritative_performance_count !== 0) errors.push("authoritative_performance_count");
  if (manifest.preperformance_validation_attempts !== 1) errors.push("preperformance_validation_attempts");
  if (manifest.future_performance_calculated !== false) errors.push("future_performance_calculated");
  if (manifest.hypotheses.length !== 5) errors.push("hypotheses");
  if (manifest.event_semantics.formation !== "FALSE_TO_TRUE_TRANSITION") errors.push("event_formation");
  if (manifest.event_semantics.repeated_true_deduplicated !== true) errors.push("episode_dedup");
  if (typeof manifest.event_semantics.pit_event_timestamp !== "string") errors.push("pit_event_timestamp");
  if (manifest.horizons.outcome_calculation_in_this_freeze !== false) errors.push("outcome_calculation");
  if (manifest.existing_information_controls.required !== true) errors.push("existing_information_controls");
  return errors;
}
