export const R58_BASIS_PREMIUM_FAMILIES = ["B1", "B2", "B3", "B4", "B5"] as const;
export type R58BasisPremiumFamily = (typeof R58_BASIS_PREMIUM_FAMILIES)[number];

export const R58_DIRECTIONS = ["BULLISH", "BEARISH"] as const;
export type R58Direction = (typeof R58_DIRECTIONS)[number];

export const R58_HORIZONS = ["1h", "4h", "12h", "24h"] as const;
export type R58Horizon = (typeof R58_HORIZONS)[number];

export const R58_STATISTICAL_POLICY = {
  seed: 5801,
  bootstrap_replicates: 2_000,
  permutation_replicates: 2_000,
  confidence_level: 0.95,
  multiple_testing: "Holm",
} as const;

export type JsonRecord = Record<string, unknown>;

export interface ExpectedHashMap {
  coverage_matrix: string;
  schema_manifest: string;
  feature_specification: string;
  dataset_manifest: string;
}
export interface HashGateResult {
  passed: boolean;
  mismatches: string[];
  expected: ExpectedHashMap;
  computed: Partial<ExpectedHashMap>;
  manifest: Partial<ExpectedHashMap>;
}

export interface HypothesisStatus {
  id: R58BasisPremiumFamily;
  name: string;
  frozen_definition: string;
  directional_semantics: "EXPLICIT" | "SPECIFICATION_INCOMPLETE";
  formal_test_included: boolean;
  reason: string;
}

export interface MatchablePoint {
  time: number;
  matchKey: string;
}

export interface MatchPair<TEvent, TControl> {
  event: TEvent;
  control: TControl;
  distanceMs: number;
}

export interface CovariateBalance {
  compared_pairs: number;
  exact_match_count: number;
  exact_match_fraction: number | null;
  fields: Record<string, { matched: number; compared: number; balance: number | null }>;
}

const DIRECTIONAL_KEYS = new Set([
  "bullish",
  "bearish",
  "direction",
  "direction_semantics",
  "event_formation",
  "continuation",
  "reversal",
]);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function verifyExpectedArtifactHashes(
  expected: ExpectedHashMap,
  computed: Partial<ExpectedHashMap>,
  manifest: JsonRecord,
): HashGateResult {
  const mismatches: string[] = [];
  for (const name of Object.keys(expected) as Array<keyof ExpectedHashMap>) {
    if (computed[name] !== expected[name]) mismatches.push(`${name}:computed`);
    if (manifest[`${name}_sha256`] !== expected[name]) mismatches.push(`${name}:manifest`);
  }
  return { passed: mismatches.length === 0, mismatches, expected, computed, manifest: {
    coverage_matrix: typeof manifest.coverage_matrix_sha256 === "string" ? manifest.coverage_matrix_sha256 : undefined,
    schema_manifest: typeof manifest.schema_manifest_sha256 === "string" ? manifest.schema_manifest_sha256 : undefined,
    feature_specification: typeof manifest.feature_specification_sha256 === "string" ? manifest.feature_specification_sha256 : undefined,
    dataset_manifest: typeof manifest.dataset_manifest_sha256 === "string" ? manifest.dataset_manifest_sha256 : undefined,
  } };
}

export function buildHypothesisManifest(featureSpecification: JsonRecord): HypothesisStatus[] {
  const candidates = Array.isArray(featureSpecification.candidates)
    ? featureSpecification.candidates.filter(isRecord)
    : [];
  return R58_BASIS_PREMIUM_FAMILIES.map((id) => {
    const candidate = candidates.find((value) => value.id === id);
    const name = typeof candidate?.name === "string" ? candidate.name : id;
    const definition = typeof candidate?.definition === "string" ? candidate.definition : "NOT AVAILABLE";
    const hasExplicitDirection = candidate !== undefined
      && Object.keys(candidate).some((key) => DIRECTIONAL_KEYS.has(key));
    return {
      id,
      name,
      frozen_definition: definition,
      directional_semantics: hasExplicitDirection ? "EXPLICIT" : "SPECIFICATION_INCOMPLETE",
      formal_test_included: hasExplicitDirection,
      reason: hasExplicitDirection
        ? "The frozen specification contains explicit directional semantics."
        : "R5.7 froze a feature definition but no explicit bullish/bearish, continuation/reversal, or event-formation semantics; selecting one after outcomes would be result-driven.",
    };
  });
}

export function validateExperimentGovernance(value: JsonRecord): string[] {
  const errors: string[] = [];
  if (value.experiment_count !== 1) errors.push("experiment_count");
  if (value.features_frozen_before_performance !== "YES") errors.push("features_frozen_before_performance");
  if (value.post_result_tuning !== "NO") errors.push("post_result_tuning");
  return errors;
}

export function makeExistingInformationMatchKey(input: {
  symbol: string;
  calendarPeriod: string;
  marketRegime: string;
  volatilityBucket: string;
  liquidityBucket: string;
  fundingBucket: string;
  markIndexBasisBucket: string;
}): string {
  return [
    input.symbol,
    input.calendarPeriod,
    input.marketRegime,
    input.volatilityBucket,
    input.liquidityBucket,
    input.fundingBucket,
    input.markIndexBasisBucket,
  ].join("|");
}

export function matchNearestWithoutReplacement<TEvent extends MatchablePoint, TControl extends MatchablePoint>(
  events: TEvent[],
  controls: TControl[],
): { pairs: MatchPair<TEvent, TControl>[]; unmatched: TEvent[] } {
  const byKey = new Map<string, TControl[]>();
  for (const control of controls) {
    const values = byKey.get(control.matchKey) ?? [];
    values.push(control);
    byKey.set(control.matchKey, values);
  }
  for (const values of byKey.values()) values.sort((left, right) => left.time - right.time);
  const used = new Set<TControl>();
  const pairs: MatchPair<TEvent, TControl>[] = [];
  const unmatched: TEvent[] = [];
  for (const event of [...events].sort((left, right) => left.time - right.time)) {
    let selected: TControl | null = null;
    let selectedDistance = Number.POSITIVE_INFINITY;
    for (const candidate of byKey.get(event.matchKey) ?? []) {
      if (used.has(candidate)) continue;
      const distance = Math.abs(candidate.time - event.time);
      if (distance < selectedDistance || (distance === selectedDistance && candidate.time < (selected?.time ?? Number.POSITIVE_INFINITY))) {
        selected = candidate;
        selectedDistance = distance;
      }
    }
    if (selected === null) unmatched.push(event);
    else {
      used.add(selected);
      pairs.push({ event, control: selected, distanceMs: selectedDistance });
    }
  }
  return { pairs, unmatched };
}

export function summarizeCovariateBalance<TEvent extends JsonRecord, TControl extends JsonRecord>(
  pairs: Array<{ event: TEvent; control: TControl }>,
  fields: string[],
): CovariateBalance {
  const fieldResults: CovariateBalance["fields"] = {};
  let exactMatchCount = 0;
  for (const field of fields) {
    let matched = 0;
    for (const pair of pairs) {
      if (pair.event[field] === pair.control[field]) matched += 1;
    }
    fieldResults[field] = {
      matched,
      compared: pairs.length,
      balance: pairs.length === 0 ? null : matched / pairs.length,
    };
  }
  for (const pair of pairs) {
    if (fields.every((field) => pair.event[field] === pair.control[field])) exactMatchCount += 1;
  }
  return {
    compared_pairs: pairs.length,
    exact_match_count: exactMatchCount,
    exact_match_fraction: pairs.length === 0 ? null : exactMatchCount / pairs.length,
    fields: fieldResults,
  };
}

export function b1IncrementalAttribution(rawEffect: number | null, existingMarkIndexEffect: number | null): JsonRecord {
  return {
    raw_b1_effect: rawEffect,
    existing_mark_index_effect: existingMarkIndexEffect,
    incremental_over_existing_mark_index: rawEffect === null || existingMarkIndexEffect === null
      ? null
      : rawEffect - existingMarkIndexEffect,
  };
}

export function classifyFundingOverlap(input: { correlation: number | null; semantic: string }): string {
  if (input.correlation === null) return "NOT_DIRECTLY_COMPARABLE";
  if (input.semantic === "DISTINCT_FROM_FUNDING") return "DISTINCT_FROM_FUNDING";
  return "RELATED_BUT_NOT_IDENTICAL";
}

export function isPitAvailable(observationStart: number, intervalMs: number, decisionTime: number): boolean {
  return finite(observationStart) && finite(intervalMs) && finite(decisionTime)
    ? observationStart + intervalMs <= decisionTime
    : false;
}

export function holmAdjustR58(pValues: Array<{ id: string; pValue: number | null }>): Record<string, number | null> {
  const adjusted: Record<string, number | null> = Object.fromEntries(pValues.map((value) => [value.id, null]));
  const valid = pValues
    .filter((value): value is { id: string; pValue: number } => value.pValue !== null && Number.isFinite(value.pValue))
    .sort((left, right) => left.pValue - right.pValue || left.id.localeCompare(right.id));
  let runningMaximum = 0;
  valid.forEach((value, index) => {
    runningMaximum = Math.max(runningMaximum, Math.min(1, (valid.length - index) * value.pValue));
    adjusted[value.id] = runningMaximum;
  });
  return adjusted;
}
