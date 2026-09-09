export const R56_SELECTED_PHENOMENON = "R55:C1:BULLISH:4h";
export const R56_HOLDOUT_START_ISO = "2026-08-10T00:00:00.000Z";
export const R56_DISCOVERY_LIFT = 0.01399186;
export const R56_DISCOVERY_CI95 = [0.012112412430531752, 0.015875492487993498] as const;
export const R56_BOOTSTRAP_REPLICATES = 2_000;
export const R56_PERMUTATION_REPLICATES = 2_000;

export type HoldoutClassification =
  | "CONFIRMED_INCREMENTAL_INFORMATION"
  | "WEAK_CONFIRMATION"
  | "NOT_CONFIRMED"
  | "INSUFFICIENT_CONFIRMATION_SAMPLE"
  | "MATCHING_INADEQUATE"
  | "RESEARCH_INVALID";

export function weekKey(timestamp: number): string {
  const date = new Date(timestamp);
  const dayFromMonday = (date.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - dayFromMonday,
  ));
  return monday.toISOString().slice(0, 10);
}

export function crowdingStrength(percentiles: Array<number | null>): number | null {
  const values = percentiles.filter((value): value is number => value !== null && Number.isFinite(value));
  return values.length === percentiles.length && values.length > 0
    ? Math.max(...values.map((value) => Math.abs(value - 50)))
    : null;
}

export function crowdingStrengthBucket(strength: number | null): string {
  if (strength === null || !Number.isFinite(strength)) return "UNKNOWN";
  if (strength < 10) return "00-10";
  if (strength < 20) return "10-20";
  if (strength < 30) return "20-30";
  if (strength < 40) return "30-40";
  return "40-50";
}

export function distributionTotalVariation(left: string[], right: string[]): number | null {
  if (left.length === 0 || right.length === 0) return null;
  const keys = new Set([...left, ...right]);
  let total = 0;
  for (const key of keys) {
    const leftShare = left.filter((value) => value === key).length / left.length;
    const rightShare = right.filter((value) => value === key).length / right.length;
    total += Math.abs(leftShare - rightShare);
  }
  return total / 2;
}

export interface HoldoutGateInput {
  eligibleEvents: number;
  matchedEvents: number;
  matchingCoveragePercent: number | null;
  incrementalLift: number | null;
  ciLower: number | null;
  ciUpper: number | null;
  largestSymbolPercent: number | null;
  largestWeekPercent: number | null;
  stableAcrossRegimes: "YES" | "NO" | "INSUFFICIENT";
  pitSafe: boolean;
  postResultTuning: boolean;
}

export function classifyHoldout(input: HoldoutGateInput): HoldoutClassification {
  if (!input.pitSafe || input.postResultTuning) return "RESEARCH_INVALID";
  if (input.eligibleEvents === 0 || input.matchedEvents < 30 || input.ciLower === null || input.ciUpper === null) {
    return "INSUFFICIENT_CONFIRMATION_SAMPLE";
  }
  if (input.matchingCoveragePercent === null || input.matchingCoveragePercent < 60) {
    return "MATCHING_INADEQUATE";
  }
  if (input.incrementalLift === null) return "INSUFFICIENT_CONFIRMATION_SAMPLE";
  const positiveConcentration = input.largestSymbolPercent !== null
    && input.largestSymbolPercent <= 50
    && input.largestWeekPercent !== null
    && input.largestWeekPercent <= 50;
  if (
    input.incrementalLift > 0
    && input.ciLower > 0
    && positiveConcentration
    && input.stableAcrossRegimes === "YES"
  ) {
    return "CONFIRMED_INCREMENTAL_INFORMATION";
  }
  if (input.incrementalLift > 0) return "WEAK_CONFIRMATION";
  return "NOT_CONFIRMED";
}
