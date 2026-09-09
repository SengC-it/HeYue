import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256Json } from "../lib/crowding";
import {
  R58B_AUTHORITATIVE_PERFORMANCE_COUNT,
  R58B_CONTROL_A_DIMENSIONS,
  R58B_CONTROL_B_ADDITIONS,
  R58B_EXPECTED_R57_HASHES,
  R58B_EXPECTED_R58A_HYPOTHESIS_HASH,
  auditEventEligibility,
  emptyDirectionalMetric,
  formalHolmFamilySize,
  formalHolmTestIds,
  verifyR58BHashGate,
} from "../lib/basis-premium/authoritative";
import {
  R58_DIRECTIONS,
  R58_HORIZONS,
  R58_STATISTICAL_POLICY,
  verifyExpectedArtifactHashes,
} from "../lib/basis-premium/information-gain";
import {
  hypothesisManifestHash,
  validateR58AHypothesisManifest,
} from "../lib/basis-premium/hypothesis";
import type {
  ExpectedHashMap,
  HashGateResult,
  JsonRecord,
} from "../lib/basis-premium/information-gain";
import type { HypothesisManifest } from "../lib/basis-premium/hypothesis";

const R57_ARTIFACT_ROOT = resolve("data", "raw", "hy-r5.7-basis-premium-preflight", "artifacts");
const R57_REPORT_PATH = resolve("reports", "hy-r5.7-basis-premium-preflight.json");
const R57_COVERAGE_PATH = resolve(R57_ARTIFACT_ROOT, "coverage-matrix.json");
const R57_SCHEMA_PATH = resolve(R57_ARTIFACT_ROOT, "schema-manifest.json");
const R57_FEATURE_PATH = resolve(R57_ARTIFACT_ROOT, "feature-specification.json");
const R57_DATASET_PATH = resolve(R57_ARTIFACT_ROOT, "dataset-manifest.json");
const R57_ARTIFACT_HASHES_PATH = resolve(R57_ARTIFACT_ROOT, "artifact-hashes.json");
const R58_REPORT_PATH = resolve("reports", "hy-r5.8-basis-premium-information-gain.json");
const R58_FREEZE_PATH = resolve("reports", "hy-r5.8-pre-performance-freeze.json");
const R58A_MANIFEST_PATH = resolve("reports", "hy-r5.8a-basis-premium-hypothesis-freeze.json");
const R58B_FREEZE_PATH = resolve("reports", "hy-r5.8b-pre-performance-freeze.json");
const R58B_JSON_PATH = resolve("reports", "hy-r5.8b-basis-premium-information-gain.json");
const R58B_MARKDOWN_PATH = resolve("reports", "hy-r5.8b-basis-premium-information-gain.md");

const HISTORY_RANGE = {
  start: "2024-08-09T00:00:00.000Z",
  end: "2026-08-09T23:59:59.999Z",
} as const;
const EXPECTED_UNIVERSE = 49;
const EXPECTED_RESOLUTION = "1h";
const SOURCE_PATHS = [
  "scripts/run-hy-r5-8b-basis-premium-information-gain.ts",
  "lib/basis-premium/authoritative.ts",
  "lib/basis-premium/information-gain.ts",
  "lib/basis-premium/hypothesis.ts",
] as const;
const MATCHING_IMPLEMENTATION_PATH = "lib/basis-premium/information-gain.ts";
const OUTCOME_IMPLEMENTATION_PATH = "lib/basis-premium/authoritative.ts";
const STATISTICAL_IMPLEMENTATION_PATH = "lib/basis-premium/information-gain.ts";

interface FrozenInputs {
  coverage: JsonRecord;
  schema: JsonRecord;
  feature: JsonRecord;
  dataset: JsonRecord;
  artifactHashes: JsonRecord;
  r57Report: JsonRecord;
  r58Report: JsonRecord;
  r58Freeze: JsonRecord;
  r58aManifest: HypothesisManifest;
  r57HashGate: HashGateResult;
  hashGate: {
    passed: boolean;
    mismatches: string[];
    r57: HashGateResult;
    r58a: {
      expected: string;
      computed: string;
      passed: boolean;
      mismatches: string[];
    };
  };
  gateErrors: string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function loadJson(path: string): Promise<JsonRecord> {
  return asRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
}

async function rawFileHash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(resolve(path))).digest("hex");
}

async function sourceHash(): Promise<string> {
  const hash = createHash("sha256");
  for (const path of SOURCE_PATHS) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(resolve(path), "utf8"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function matchesExpectedRange(value: unknown): boolean {
  const range = asRecord(value);
  return range.start === HISTORY_RANGE.start && range.end === HISTORY_RANGE.end;
}

function sameStringArray(left: unknown, right: unknown): boolean {
  return sha256Json(left) === sha256Json(right);
}

function reportArtifactHashErrors(r57Report: JsonRecord): string[] {
  const reportHashes = asRecord(r57Report.artifact_hashes);
  const errors: string[] = [];
  for (const name of Object.keys(R58B_EXPECTED_R57_HASHES) as Array<keyof ExpectedHashMap>) {
    if (reportHashes[`${name}_sha256`] !== R58B_EXPECTED_R57_HASHES[name]) {
      errors.push(`r57_report:${name}`);
    }
  }
  return errors;
}

async function loadFrozenInputs(): Promise<FrozenInputs> {
  const [coverage, schema, feature, dataset, artifactHashes, r57Report, r58Report, r58Freeze, r58aManifestRecord] = await Promise.all([
    loadJson(R57_COVERAGE_PATH),
    loadJson(R57_SCHEMA_PATH),
    loadJson(R57_FEATURE_PATH),
    loadJson(R57_DATASET_PATH),
    loadJson(R57_ARTIFACT_HASHES_PATH),
    loadJson(R57_REPORT_PATH),
    loadJson(R58_REPORT_PATH),
    loadJson(R58_FREEZE_PATH),
    loadJson(R58A_MANIFEST_PATH),
  ]);
  const computed: Partial<ExpectedHashMap> = {
    coverage_matrix: sha256Json(coverage),
    schema_manifest: sha256Json(schema),
    feature_specification: sha256Json(feature),
    dataset_manifest: sha256Json(dataset),
  };
  const r57HashGate = verifyExpectedArtifactHashes(R58B_EXPECTED_R57_HASHES, computed, artifactHashes);
  const r58aManifest = r58aManifestRecord as unknown as HypothesisManifest;
  const r58aComputedHash = hypothesisManifestHash(r58aManifest);
  const r58aMismatches: string[] = [];
  if (r58aComputedHash !== R58B_EXPECTED_R58A_HYPOTHESIS_HASH) r58aMismatches.push("r58a_hypothesis_manifest:computed");
  const r58aValidationErrors = validateR58AHypothesisManifest(r58aManifest);
  r58aMismatches.push(...r58aValidationErrors.map((value) => `r58a_manifest:${value}`));
  const hashGate = verifyR58BHashGate(r57HashGate, r58aComputedHash);
  const gateErrors = [
    ...hashGate.mismatches,
    ...r58aMismatches,
    ...reportArtifactHashErrors(r57Report),
  ];
  const datasetUniverse = asArray(dataset.universe);
  const reportUniverse = asArray(r57Report.universe);
  const coverageUniverse = asArray(coverage.universe);
  if (datasetUniverse.length !== EXPECTED_UNIVERSE) gateErrors.push("dataset_universe");
  if (reportUniverse.length !== EXPECTED_UNIVERSE) gateErrors.push("r57_report_universe");
  if (coverageUniverse.length !== EXPECTED_UNIVERSE) gateErrors.push("coverage_universe");
  if (!sameStringArray(datasetUniverse, reportUniverse) || !sameStringArray(datasetUniverse, coverageUniverse)) gateErrors.push("frozen_universe_mismatch");
  if (asString(dataset.selected_resolution) !== EXPECTED_RESOLUTION) gateErrors.push("dataset_resolution");
  if (asString(coverage.selected_resolution) !== EXPECTED_RESOLUTION) gateErrors.push("coverage_resolution");
  if (asString(r57Report.selected_resolution) !== EXPECTED_RESOLUTION) gateErrors.push("r57_report_resolution");
  if (!matchesExpectedRange(dataset.historical_range)) gateErrors.push("dataset_historical_range");
  if (!matchesExpectedRange(coverage.historical_range)) gateErrors.push("coverage_historical_range");
  if (!matchesExpectedRange(r57Report.historical_range)) gateErrors.push("r57_report_historical_range");
  if (asString(r57Report.pit_safe) !== "PASS") gateErrors.push("r57_pit_safe");
  if (r57Report.b1_b5_frozen !== true) gateErrors.push("r57_b1_b5_frozen");
  if (r57Report.future_performance_calculated !== false) gateErrors.push("r57_future_performance");
  if (r58Report.future_performance_calculated !== false) gateErrors.push("r58_future_performance");
  if (asRecord(r58Report.governance).outcome_metrics_not_calculated !== true) gateErrors.push("r58_outcome_metrics");
  if (r58Freeze.outcome_metrics_not_yet_calculated !== true) gateErrors.push("r58_preperformance_freeze");
  if (r58aManifestRecord.future_performance_calculated !== false) gateErrors.push("r58a_future_performance");
  if (r58aManifestRecord.authoritative_performance_count !== 0) gateErrors.push("r58a_authoritative_count");
  return {
    coverage,
    schema,
    feature,
    dataset,
    artifactHashes,
    r57Report,
    r58Report,
    r58Freeze,
    r58aManifest,
    r57HashGate,
    hashGate: {
      passed: hashGate.passed && r58aMismatches.length === 0,
      mismatches: gateErrors,
      r57: r57HashGate,
      r58a: {
        expected: R58B_EXPECTED_R58A_HYPOTHESIS_HASH,
        computed: r58aComputedHash,
        passed: r58aMismatches.length === 0,
        mismatches: r58aMismatches,
      },
    },
    gateErrors,
  };
}

function buildEmptyDirectionalMetrics(): JsonRecord {
  const byFamily: JsonRecord = {};
  for (const family of ["B1", "B2", "B3", "B4", "B5"]) {
    const byDirection: JsonRecord = {};
    for (const direction of R58_DIRECTIONS) {
      byDirection[direction] = Object.fromEntries(
        R58_HORIZONS.map((horizon) => [horizon, emptyDirectionalMetric(family, direction, horizon)]),
      );
    }
    byFamily[family] = {
      event_count: 0,
      eligible_events: 0,
      formal_test_included: false,
      status: "RESEARCH_INVALID",
      by_direction_and_horizon: byDirection,
    };
  }
  return {
    status: "NOT_RUN",
    formal_test_count: formalHolmFamilySize(),
    formal_test_ids: formalHolmTestIds(),
    tests_executed: 0,
    by_family: byFamily,
  };
}

function buildEmptyMatching(): JsonRecord {
  return {
    status: "NOT_ASSESSED_BEFORE_EVENT_GATE",
    control_a_dimensions: [...R58B_CONTROL_A_DIMENSIONS],
    control_b_additions: [...R58B_CONTROL_B_ADDITIONS],
    coverage_gate: {
      robust_minimum_percent: 70,
      conditional_minimum_percent: 60,
      below_conditional_status: "MATCHING_INADEQUATE_COMPONENT",
    },
    by_family: Object.fromEntries(["B1", "B2", "B3", "B4", "B5"].map((family) => [family, {
      eligible_events: 0,
      matched_events: 0,
      unmatched_events: 0,
      coverage_percent: null,
      matching_gate: "NOT_ASSESSED",
      covariate_balance: null,
    }])),
    covariate_balance_fields: [
      "symbol",
      "calendar_period",
      "market_regime",
      "volatility_bucket",
      "liquidity_bucket",
      "funding_state_bucket",
      "existing_mark_index_basis_state_bucket",
      "feature_strength",
    ],
    balance_metric: "total_variation_or_frozen_equivalent; not assessed because no valid event population existed",
  };
}

function buildFreezeExpected(
  inputs: FrozenInputs,
  sourceHashValue: string,
  matchingHash: string,
  outcomeHash: string,
  statisticalHash: string,
): JsonRecord {
  return {
    research: "HY-R5.8B AUTHORITATIVE BASIS / PREMIUM INFORMATION GAIN",
    version: "hy-r5.8b-basis-premium-v1",
    immutable: true,
    authoritative_performance_count: R58B_AUTHORITATIVE_PERFORMANCE_COUNT,
    outcome_metrics_not_yet_calculated: true,
    historical_range: HISTORY_RANGE,
    universe: asArray(inputs.dataset.universe),
    resolution: EXPECTED_RESOLUTION,
    frozen_artifact_hashes: {
      ...R58B_EXPECTED_R57_HASHES,
      r58a_hypothesis_manifest: R58B_EXPECTED_R58A_HYPOTHESIS_HASH,
    },
    hypothesis_manifest_path: R58A_MANIFEST_PATH,
    hypothesis_manifest_hash: R58B_EXPECTED_R58A_HYPOTHESIS_HASH,
    runner_source_paths: SOURCE_PATHS,
    runner_source_hash: sourceHashValue,
    matching_implementation_path: MATCHING_IMPLEMENTATION_PATH,
    matching_implementation_hash: matchingHash,
    outcome_implementation_path: OUTCOME_IMPLEMENTATION_PATH,
    outcome_implementation_hash: outcomeHash,
    statistical_implementation_path: STATISTICAL_IMPLEMENTATION_PATH,
    statistical_implementation_hash: statisticalHash,
    control_policy: {
      control_a: [...R58B_CONTROL_A_DIMENSIONS],
      control_b: [...R58B_CONTROL_A_DIMENSIONS, ...R58B_CONTROL_B_ADDITIONS],
      no_future_outcome_matching: true,
      b1_existing_mark_index_attribution_required: true,
      b2_b3_funding_control_required: true,
    },
    statistical_policy: R58_STATISTICAL_POLICY,
    event_policy: {
      formation: "FALSE_TO_TRUE_TRANSITION",
      repeated_true_deduplicated: true,
      zero_or_ambiguous: "NO_EVENT",
      exact_r58a_directions_reused: true,
      executable_condition_required_before_outcome: true,
    },
    no_result_driven_rescue: true,
    artifact_paths: {
      r57_report: R57_REPORT_PATH,
      coverage_matrix: R57_COVERAGE_PATH,
      schema_manifest: R57_SCHEMA_PATH,
      feature_specification: R57_FEATURE_PATH,
      dataset_manifest: R57_DATASET_PATH,
      r57_artifact_hashes: R57_ARTIFACT_HASHES_PATH,
      r58_report: R58_REPORT_PATH,
      r58_preperformance_freeze: R58_FREEZE_PATH,
      r58a_manifest: R58A_MANIFEST_PATH,
    },
    hash_representation: "R5.7 artifacts and R5.8A manifest: SHA-256 of canonical stable JSON with recursively sorted object keys; implementation/source hashes: SHA-256 of raw UTF-8 file bytes with source path delimiters for the combined source hash.",
  };
}

async function createOrLoadFreeze(
  inputs: FrozenInputs,
  sourceHashValue: string,
  matchingHash: string,
  outcomeHash: string,
  statisticalHash: string,
): Promise<{ manifest: JsonRecord; hash: string }> {
  const expected = buildFreezeExpected(inputs, sourceHashValue, matchingHash, outcomeHash, statisticalHash);
  if (await fileExists(R58B_FREEZE_PATH)) {
    const existing = await loadJson(R58B_FREEZE_PATH);
    const mismatches = Object.keys(expected).filter((key) => sha256Json(existing[key]) !== sha256Json(expected[key]));
    if (mismatches.length > 0) {
      throw new Error(`RESEARCH_INVALID: R5.8B pre-performance freeze changed: ${mismatches.join(",")}`);
    }
    if (existing.immutable !== true) throw new Error("RESEARCH_INVALID: R5.8B freeze is not immutable");
    return { manifest: existing, hash: sha256Json(existing) };
  }
  const manifest = {
    ...expected,
    created_at: new Date().toISOString(),
  };
  await writeFile(R58B_FREEZE_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const reloaded = await loadJson(R58B_FREEZE_PATH);
  if (sha256Json(reloaded) !== sha256Json(manifest)) throw new Error("RESEARCH_INVALID: R5.8B freeze write was not deterministic");
  return { manifest: reloaded, hash: sha256Json(reloaded) };
}

function buildInvalidReport(
  inputs: FrozenInputs,
  sourceHashValue: string,
  matchingHash: string,
  outcomeHash: string,
  statisticalHash: string,
  freeze: { manifest: JsonRecord; hash: string },
  eventAudit: ReturnType<typeof auditEventEligibility>,
): JsonRecord {
  const coverage = asRecord(inputs.r57Report.coverage);
  const data = asRecord(inputs.r57Report.data);
  const primaryReason = eventAudit.length === 5
    ? "R5.7/R5.8A do not freeze executable B1-B5 event conditions and fixed thresholds/cutoffs; selecting them now would be post-freeze and result-driven. No future outcome was calculated."
    : "The frozen event-eligibility audit did not produce the required five B1-B5 specifications; no future outcome was calculated.";
  const gateReason = inputs.gateErrors.length > 0 ? ` Frozen-input gate errors: ${inputs.gateErrors.join(", ")}.` : "";
  return {
    research: "HY-R5.8B AUTHORITATIVE BASIS / PREMIUM INFORMATION GAIN",
    version: "hy-r5.8b-basis-premium-v1",
    generated_at: new Date().toISOString(),
    classification: "RESEARCH_INVALID",
    review_blocked: true,
    reason: `${primaryReason}${gateReason}`,
    all_five_frozen_hashes_verified: inputs.hashGate.passed,
    hash_gate: inputs.hashGate,
    historical_range: HISTORY_RANGE,
    universe: asArray(inputs.dataset.universe),
    resolution: EXPECTED_RESOLUTION,
    authoritative_performance_count: R58B_AUTHORITATIVE_PERFORMANCE_COUNT,
    executed_future_outcome_count: 0,
    post_result_tuning: "NO",
    pit_safe: inputs.gateErrors.includes("r57_pit_safe") ? "FAIL" : "PASS",
    event_eligibility: {
      status: "SPECIFICATION_INCOMPLETE",
      audit: eventAudit,
      excluded_from_formal_tests: eventAudit.map((value) => value.id),
    },
    hypotheses: inputs.r58aManifest.hypotheses,
    frozen_inputs: {
      r57_artifact_paths: {
        coverage_matrix: R57_COVERAGE_PATH,
        schema_manifest: R57_SCHEMA_PATH,
        feature_specification: R57_FEATURE_PATH,
        dataset_manifest: R57_DATASET_PATH,
        artifact_hashes: R57_ARTIFACT_HASHES_PATH,
        r57_report: R57_REPORT_PATH,
      },
      r58a_manifest_path: R58A_MANIFEST_PATH,
      r58a_manifest_hash: R58B_EXPECTED_R58A_HYPOTHESIS_HASH,
      r57_hashes: R58B_EXPECTED_R57_HASHES,
      runner_source_paths: SOURCE_PATHS,
      runner_source_hash: sourceHashValue,
      matching_implementation_path: MATCHING_IMPLEMENTATION_PATH,
      matching_implementation_hash: matchingHash,
      outcome_implementation_path: OUTCOME_IMPLEMENTATION_PATH,
      outcome_implementation_hash: outcomeHash,
      statistical_implementation_path: STATISTICAL_IMPLEMENTATION_PATH,
      statistical_implementation_hash: statisticalHash,
      pre_performance_freeze_path: R58B_FREEZE_PATH,
      pre_performance_freeze_hash: freeze.hash,
      pre_performance_freeze: freeze.manifest,
    },
    r57_context: {
      selected_resolution: asString(inputs.r57Report.selected_resolution),
      joint_listing_aware_coverage_percent: asNumber(coverage.listing_aware_coverage_percent),
      joint_expected_observations: asNumber(coverage.joint_expected_observations),
      joint_valid_observations: asNumber(coverage.joint_valid_observations),
      joint_missing_observations: asNumber(coverage.joint_missing_observations),
      joint_available_symbols: asNumber(coverage.joint_available_symbols),
      worst_symbol: coverage.worst_symbol,
      worst_symbol_coverage_percent: asNumber(coverage.worst_symbol_coverage_percent),
      worst_quarter: coverage.worst_quarter,
      worst_quarter_coverage_percent: asNumber(coverage.worst_quarter_coverage_percent),
      future_outcomes_not_used: true,
      inherited_data_sections: Object.keys(data),
    },
    controls: {
      control_a: {
        dimensions: [...R58B_CONTROL_A_DIMENSIONS],
        future_outcome_matching: false,
      },
      control_b: {
        dimensions: [...R58B_CONTROL_A_DIMENSIONS, ...R58B_CONTROL_B_ADDITIONS],
        funding_controlled: true,
        existing_mark_index_controlled: true,
        future_outcome_matching: false,
      },
      b1_attribution: "Raw B1 versus existing Mark/Index basis is required; not run because event eligibility is incomplete.",
      b2_b3_attribution: "Raw premium versus Funding-controlled effects are required; not run because event eligibility is incomplete.",
      b4_attribution: "Only the frozen divergence is allowed; not run because event eligibility is incomplete.",
      b5_population: "Only same-timestamp ACTIVE, data-complete, PIT-available symbols may rank; not run because event eligibility is incomplete.",
    },
    metrics: buildEmptyDirectionalMetrics(),
    matching: buildEmptyMatching(),
    balance: {
      status: "NOT_ASSESSED",
      required_fields: [
        "symbol",
        "calendar_period",
        "market_regime",
        "volatility_bucket",
        "liquidity_bucket",
        "funding_state_bucket",
        "existing_mark_index_basis_state_bucket",
        "feature_strength",
      ],
      metric: "total_variation_or_frozen_equivalent",
      severe_imbalance: false,
    },
    statistics: {
      status: "NOT_RUN",
      formal_holm_family_test_count: formalHolmFamilySize(),
      formal_holm_family_test_ids: formalHolmTestIds(),
      tests_executed: 0,
      paired_bootstrap_replicates: R58_STATISTICAL_POLICY.bootstrap_replicates,
      permutation_replicates: R58_STATISTICAL_POLICY.permutation_replicates,
      seed: R58_STATISTICAL_POLICY.seed,
      confidence_level: R58_STATISTICAL_POLICY.confidence_level,
      multiple_testing: R58_STATISTICAL_POLICY.multiple_testing,
      holm_significant_positive_tests: 0,
      holm_significant_non_positive_tests: 0,
      deterministic_statistics: true,
    },
    stability: {
      status: "NOT_ASSESSED",
      quarters: [],
      regimes: [],
      symbols: [],
      largest_symbol_concentration_percent: null,
      largest_quarter_contribution_percent: null,
      positive_quarter_ratio: null,
      regime_effect_direction: null,
    },
    best_new_information: {
      phenomenon: "NONE",
      effect: null,
      confidence_interval_95: null,
      matching_coverage_percent: null,
    },
    attribution: {
      funding_attributable_findings: "NOT ASSESSED; B2/B3 require Funding-controlled outcome comparison.",
      existing_mark_index_attributable_findings: "NOT ASSESSED; B1 requires explicit incremental attribution.",
      no_result_driven_rescue: true,
    },
    future_performance_calculated: false,
    safety: {
      production_modified: false,
      supabase_production_modified: false,
      vercel_modified: false,
      paper_strategy_modified: false,
      scanner_modified: false,
      emails_sent: 0,
      private_api_called: false,
      orders_called: false,
      position_management_called: false,
      auto_trading: false,
      commit_created: false,
    },
  };
}

function metricFor(report: JsonRecord, family: string, direction: string, horizon: string): JsonRecord {
  const metrics = asRecord(report.metrics);
  const byFamily = asRecord(metrics.by_family);
  const familyRecord = asRecord(byFamily[family]);
  const byDirection = asRecord(familyRecord.by_direction_and_horizon);
  const directionRecord = asRecord(byDirection[direction]);
  return asRecord(directionRecord[horizon]);
}

function displayMetric(value: unknown): string {
  return value === null || value === undefined ? "N/A (RESEARCH_INVALID)" : String(value);
}

function buildMarkdown(report: JsonRecord): string {
  const hashGate = asRecord(report.hash_gate);
  const frozen = asRecord(report.frozen_inputs);
  const statistics = asRecord(report.statistics);
  const r57 = asRecord(report.r57_context);
  const matching = asRecord(report.matching);
  const balance = asRecord(report.balance);
  const stability = asRecord(report.stability);
  const best = asRecord(report.best_new_information);
  const lines = [
    "# HY-R5.8B Authoritative Basis / Premium Information Gain",
    "",
    `- Classification: **${asString(report.classification)}**`,
    `- Review blocked: **${String(report.review_blocked).toUpperCase()}**`,
    `- Reason: ${asString(report.reason)}`,
    "",
    "## Pre-performance freeze and hash gate",
    "",
    `- All five frozen hashes verified: **${String(report.all_five_frozen_hashes_verified).toUpperCase()}**`,
    `- R5.7 hash gate: **${String(asRecord(hashGate.r57).passed).toUpperCase()}**`,
    `- R5.8A hypothesis hash gate: **${String(asRecord(hashGate.r58a).passed).toUpperCase()}**`,
    `- R5.7 coverage matrix hash: ${R58B_EXPECTED_R57_HASHES.coverage_matrix}`,
    `- R5.7 schema manifest hash: ${R58B_EXPECTED_R57_HASHES.schema_manifest}`,
    `- R5.7 feature specification hash: ${R58B_EXPECTED_R57_HASHES.feature_specification}`,
    `- R5.7 dataset manifest hash: ${R58B_EXPECTED_R57_HASHES.dataset_manifest}`,
    `- R5.8A hypothesis manifest hash: ${R58B_EXPECTED_R58A_HYPOTHESIS_HASH}`,
    `- Pre-performance freeze path: ${String(frozen.pre_performance_freeze_path)}`,
    `- Pre-performance freeze hash: ${String(frozen.pre_performance_freeze_hash)}`,
    `- Runner/source hash: ${String(frozen.runner_source_hash)}`,
    `- Matching implementation hash: ${String(frozen.matching_implementation_hash)}`,
    `- Outcome implementation hash: ${String(frozen.outcome_implementation_hash)}`,
    `- Statistical implementation hash: ${String(frozen.statistical_implementation_hash)}`,
    "- The freeze was written before any future outcome. It is immutable and no outcome was generated.",
    "",
    "## Authoritative scope",
    "",
    `- Historical range: ${HISTORY_RANGE.start} -> ${HISTORY_RANGE.end}`,
    `- Universe: ${asArray(report.universe).length}/49`,
    `- Resolution: ${String(report.resolution)}`,
    `- Authoritative performance count: ${String(report.authoritative_performance_count)}`,
    `- Executed future outcome count: ${String(report.executed_future_outcome_count)}`,
    `- Post-result tuning: ${String(report.post_result_tuning)}`,
    `- PIT-safe: ${String(report.pit_safe)}`,
    `- R5.7 listing-aware joint coverage: ${displayMetric(r57.joint_listing_aware_coverage_percent)}%`,
    `- R5.7 expected/valid/missing observations: ${displayMetric(r57.joint_expected_observations)} / ${displayMetric(r57.joint_valid_observations)} / ${displayMetric(r57.joint_missing_observations)}`,
    "",
    "## Frozen event eligibility",
    "",
    "The five R5.8A direction mappings and FALSE→TRUE episode rule are retained exactly. The R5.7 feature specification does not provide executable event conditions and fixed thresholds/cutoffs, so all formal directional tests are excluded before outcome generation.",
    "",
    "| Family | Missing pre-frozen requirement | Status |",
    "| --- | --- | --- |",
    ...asArray(asRecord(report.event_eligibility).audit).filter(isRecord).map((value) => `| ${asString(value.id)} | ${asArray(value.missing_fields).join(", ")} | ${asString(value.status)} |`),
    "",
    "## Required directional metrics",
    "",
    "All required B1–B5 × bullish/bearish × 1h/4h/12h/24h cells remain present for Holm-family completeness. Values are not estimable because the event gate is invalid; this is not an empirical negative information-gain result.",
    "",
    "| Family | Direction | Horizon | Eligible | Matched | Coverage | Signal precision | Control A | Control B | Lift vs A | Lift vs B | Mean effect | Median effect | MFE effect | MAE effect |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...["B1", "B2", "B3", "B4", "B5"].flatMap((family) => R58_DIRECTIONS.flatMap((direction) => R58_HORIZONS.map((horizon) => {
      const metric = metricFor(report, family, direction, horizon);
      return `| ${family} | ${direction} | ${horizon} | ${displayMetric(metric.eligible_events)} | ${displayMetric(metric.matched_events)} | ${displayMetric(metric.matching_coverage_percent)} | ${displayMetric(metric.signal_precision)} | ${displayMetric(metric.control_a_precision)} | ${displayMetric(metric.control_b_precision)} | ${displayMetric(metric.incremental_lift_vs_control_a)} | ${displayMetric(metric.incremental_lift_vs_control_b)} | ${displayMetric(metric.mean_directional_return_effect)} | ${displayMetric(metric.median_directional_return_effect)} | ${displayMetric(metric.mfe_effect)} | ${displayMetric(metric.mae_effect)} |`;
    }))),
    "",
    "## Controls, matching and statistics",
    "",
    `- Control A: ${R58B_CONTROL_A_DIMENSIONS.join(", ")}.`,
    `- Control B adds: ${R58B_CONTROL_B_ADDITIONS.join(", ")}.`,
    "- B1 Mark/Index attribution and B2/B3 Funding-controlled attribution are required but were not run.",
    `- Matching status: ${String(matching.status)}; robust gate >=70%; conditional maximum 60–<70%; below 60% = MATCHING_INADEQUATE_COMPONENT.`,
    `- Covariate balance status: ${String(balance.status)}; fields include symbol, calendar, regime, volatility, liquidity, Funding, Mark/Index and feature strength.`,
    `- Holm family: ${String(statistics.formal_holm_family_test_count)} fixed IDs; tests executed: ${String(statistics.tests_executed)}; bootstrap/permutation: ${String(statistics.paired_bootstrap_replicates)}/${String(statistics.permutation_replicates)}; seed: ${String(statistics.seed)}.`,
    `- Holm-significant positive tests: ${String(statistics.holm_significant_positive_tests)}; non-positive tests: ${String(statistics.holm_significant_non_positive_tests)}.`,
    "",
    "## Stability and conclusion",
    "",
    `- Best new-information phenomenon: ${String(best.phenomenon)}`,
    `- Best effect: ${displayMetric(best.effect)}`,
    `- Best 95% CI: ${displayMetric(best.confidence_interval_95)}`,
    `- Best matching coverage: ${displayMetric(best.matching_coverage_percent)}`,
    `- Stable across quarters: ${String(stability.status)}`,
    `- Stable across regimes: ${String(stability.status)}`,
    `- Largest symbol concentration: ${displayMetric(stability.largest_symbol_concentration_percent)}`,
    `- Funding-attributable findings: ${String(asRecord(report.attribution).funding_attributable_findings)}`,
    `- Existing Mark/Index-attributable findings: ${String(asRecord(report.attribution).existing_mark_index_attributable_findings)}`,
    "- Classification is RESEARCH_INVALID, not NO_INCREMENTAL_INFORMATION: performance was not executed because the pre-frozen event semantics are incomplete.",
    "",
    "## Safety",
    "",
    "- Production modified: NO",
    "- Supabase Production modified: NO",
    "- Vercel modified: NO",
    "- PAPER strategy modified: NO",
    "- Emails sent: 0",
    "- Private API called: NO",
    "- AUTO_TRADING: FALSE",
    "- Commit created: NO",
    "",
    "STOP.",
  ];
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  if (await fileExists(R58B_JSON_PATH) || await fileExists(R58B_MARKDOWN_PATH)) {
    throw new Error("PERFORMANCE_ALREADY_COMPLETED: refusing to rerun HY-R5.8B authoritative study");
  }
  const [inputs, sourceHashValue, matchingHash, outcomeHash, statisticalHash] = await Promise.all([
    loadFrozenInputs(),
    sourceHash(),
    rawFileHash(MATCHING_IMPLEMENTATION_PATH),
    rawFileHash(OUTCOME_IMPLEMENTATION_PATH),
    rawFileHash(STATISTICAL_IMPLEMENTATION_PATH),
  ]);
  const freeze = await createOrLoadFreeze(inputs, sourceHashValue, matchingHash, outcomeHash, statisticalHash);
  const eventAudit = auditEventEligibility(inputs.r58aManifest);
  const report = buildInvalidReport(inputs, sourceHashValue, matchingHash, outcomeHash, statisticalHash, freeze, eventAudit);
  await writeFile(R58B_JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(R58B_MARKDOWN_PATH, buildMarkdown(report), "utf8");
  console.log(JSON.stringify({
    classification: report.classification,
    allFiveFrozenHashesVerified: report.all_five_frozen_hashes_verified,
    authoritativePerformanceCount: report.authoritative_performance_count,
    executedFutureOutcomeCount: report.executed_future_outcome_count,
    eventEligibility: report.event_eligibility,
    futurePerformanceCalculated: report.future_performance_calculated,
    output: R58B_JSON_PATH,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
