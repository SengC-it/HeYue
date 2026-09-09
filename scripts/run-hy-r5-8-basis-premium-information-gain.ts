import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  sha256Json,
} from "../lib/crowding";
import {
  R58_BASIS_PREMIUM_FAMILIES,
  R58_DIRECTIONS,
  R58_HORIZONS,
  R58_STATISTICAL_POLICY,
  buildHypothesisManifest,
  validateExperimentGovernance,
  verifyExpectedArtifactHashes,
} from "../lib/basis-premium/information-gain";
import type {
  ExpectedHashMap,
  HashGateResult,
  HypothesisStatus,
  JsonRecord,
} from "../lib/basis-premium/information-gain";

const EXPECTED_R57_HASHES: ExpectedHashMap = {
  coverage_matrix: "add14656788d11e4852840956895803c26c4eb8a10053c2e50d8bbadf9278447",
  schema_manifest: "17da39cd0ad500b21b2f1380bf526bdc1175738091f5b0ada05d0e73dcd3288a",
  feature_specification: "bbdaab9e4cba4c22e50471d538d808fca992e812aaff60a0fc3f70af6020cf51",
  dataset_manifest: "4a6c99a36df032f605b96a63dffda35beb2cce60679281368070da57480f8da0",
};

const R57_ARTIFACT_ROOT = resolve("data", "raw", "hy-r5.7-basis-premium-preflight", "artifacts");
const R57_REPORT_PATH = resolve("reports", "hy-r5.7-basis-premium-preflight.json");
const COVERAGE_MATRIX_PATH = resolve(R57_ARTIFACT_ROOT, "coverage-matrix.json");
const SCHEMA_MANIFEST_PATH = resolve(R57_ARTIFACT_ROOT, "schema-manifest.json");
const FEATURE_SPECIFICATION_PATH = resolve(R57_ARTIFACT_ROOT, "feature-specification.json");
const DATASET_MANIFEST_PATH = resolve(R57_ARTIFACT_ROOT, "dataset-manifest.json");
const ARTIFACT_HASHES_PATH = resolve(R57_ARTIFACT_ROOT, "artifact-hashes.json");
const FREEZE_MANIFEST_PATH = resolve("reports", "hy-r5.8-pre-performance-freeze.json");
const JSON_REPORT_PATH = resolve("reports", "hy-r5.8-basis-premium-information-gain.json");
const MARKDOWN_REPORT_PATH = resolve("reports", "hy-r5.8-basis-premium-information-gain.md");
const HISTORY_START = "2024-08-09T00:00:00.000Z";
const HISTORY_END = "2026-08-09T23:59:59.999Z";
const EXPECTED_UNIVERSE = 49;
const RUNNER_SOURCE_PATHS = [
  "scripts/run-hy-r5-8-basis-premium-information-gain.ts",
  "lib/basis-premium/information-gain.ts",
  "lib/basis-premium/types.ts",
  "lib/basis-premium/parser.ts",
  "lib/basis-premium/features.ts",
  "lib/basis-premium/coverage.ts",
] as const;

interface FrozenInputs {
  coverage: JsonRecord;
  schema: JsonRecord;
  feature: JsonRecord;
  dataset: JsonRecord;
  artifactHashes: JsonRecord;
  r57Report: JsonRecord;
  gate: HashGateResult;
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

async function loadJson(path: string): Promise<JsonRecord> {
  return asRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sourceHash(): Promise<string> {
  const hash = createHash("sha256");
  for (const path of RUNNER_SOURCE_PATHS) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(resolve(path), "utf8"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function rawFileHash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(resolve(path))).digest("hex");
}

async function loadFrozenInputs(): Promise<FrozenInputs> {
  const [coverage, schema, feature, dataset, artifactHashes, r57Report] = await Promise.all([
    loadJson(COVERAGE_MATRIX_PATH),
    loadJson(SCHEMA_MANIFEST_PATH),
    loadJson(FEATURE_SPECIFICATION_PATH),
    loadJson(DATASET_MANIFEST_PATH),
    loadJson(ARTIFACT_HASHES_PATH),
    loadJson(R57_REPORT_PATH),
  ]);
  const computed: Partial<ExpectedHashMap> = {
    coverage_matrix: sha256Json(coverage),
    schema_manifest: sha256Json(schema),
    feature_specification: sha256Json(feature),
    dataset_manifest: sha256Json(dataset),
  };
  const gate = verifyExpectedArtifactHashes(EXPECTED_R57_HASHES, computed, artifactHashes);
  const gateErrors = [...gate.mismatches];
  const range = asRecord(coverage.historical_range);
  const universe = Array.isArray(dataset.universe) ? dataset.universe : [];
  const r57Universe = Array.isArray(r57Report.universe) ? r57Report.universe : [];
  if (range.start !== HISTORY_START || range.end !== HISTORY_END) gateErrors.push("historical_range");
  if (asString(dataset.selected_resolution) !== "1h" || asString(coverage.selected_resolution) !== "1h") gateErrors.push("resolution");
  if (universe.length !== EXPECTED_UNIVERSE || r57Universe.length !== EXPECTED_UNIVERSE) gateErrors.push("universe");
  if (asString(r57Report.pit_safe) !== "PASS") gateErrors.push("r57_pit_safe");
  if (r57Report.b1_b5_frozen !== true) gateErrors.push("r57_b1_b5_frozen");
  if (r57Report.future_performance_calculated !== false) gateErrors.push("r57_future_performance");
  return { coverage, schema, feature, dataset, artifactHashes, r57Report, gate, gateErrors };
}

function emptyMetric(family: string, direction: string, horizon: string): JsonRecord {
  return {
    family,
    direction,
    horizon,
    status: "SPECIFICATION_INCOMPLETE",
    formal_test_included: false,
    event_count: 0,
    matched_events: 0,
    unmatched_events: 0,
    matching_coverage_percent: null,
    signal_precision: null,
    control_a_precision: null,
    control_b_precision: null,
    incremental_lift_vs_control_a: null,
    incremental_lift_vs_existing_information_control: null,
    average_directional_return_effect: null,
    median_directional_return_effect: null,
    mfe_effect: null,
    mae_effect: null,
    median_mfe: null,
    median_mae: null,
  };
}

function buildMetrics(hypotheses: HypothesisStatus[]): JsonRecord {
  const byFamily: JsonRecord = {};
  for (const hypothesis of hypotheses) {
    byFamily[hypothesis.id] = {
      status: hypothesis.directional_semantics,
      formal_test_included: hypothesis.formal_test_included,
      event_count: 0,
      eligible_events: 0,
      matched_events: 0,
      unmatched_events: 0,
      matching_coverage_percent: null,
      by_direction_and_horizon: R58_DIRECTIONS.flatMap((direction) => R58_HORIZONS.map((horizon) => emptyMetric(hypothesis.id, direction, horizon))),
    };
  }
  return byFamily;
}

function buildInvalidReport(
  inputs: FrozenInputs,
  hypotheses: HypothesisStatus[],
  sourceHashValue: string,
  matchingHash: string,
  freezeManifest: JsonRecord | null,
  freezeHash: string | null,
  reason: string,
): JsonRecord {
  const coverage = asRecord(inputs.r57Report.coverage);
  const data = asRecord(inputs.r57Report.data);
  const existing = asRecord(inputs.r57Report.existing_heyue_overlap);
  const funding = asRecord(inputs.r57Report.funding_overlap);
  const returnValues: JsonRecord = {};
  for (const family of R58_BASIS_PREMIUM_FAMILIES) {
    returnValues[family] = {
      status: "SPECIFICATION_INCOMPLETE",
      event_count: 0,
      incremental_vs_existing_baseline: { "1h": null, "4h": null, "12h": null, "24h": null },
      formal_test_excluded: true,
    };
  }
  return {
    research: "HY-R5.8 FROZEN BASIS / PREMIUM INFORMATION GAIN",
    version: "hy-r5.8-basis-premium-v1",
    generated_at: new Date().toISOString(),
    classification: "RESEARCH_INVALID",
    review_blocked: true,
    reason,
    artifact_hash_gate: inputs.gate,
    historical_range: { start: HISTORY_START, end: HISTORY_END },
    universe: Array.isArray(inputs.dataset.universe) ? inputs.dataset.universe : [],
    resolution: "1h",
    data_availability: {
      inherited_from_r57: true,
      joint_listing_aware_coverage_percent: asNumber(coverage.listing_aware_coverage_percent),
      joint_expected_observations: asNumber(coverage.joint_expected_observations),
      joint_valid_observations: asNumber(coverage.joint_valid_observations),
      future_outcomes_not_used: true,
    },
    governance: {
      experiment_count: 1,
      features_frozen_before_performance: "YES",
      post_result_tuning: "NO",
      directional_semantics_gate: "FAIL",
      outcome_metrics_not_calculated: true,
    },
    frozen_inputs: {
      artifact_paths: {
        coverage_matrix: COVERAGE_MATRIX_PATH,
        schema_manifest: SCHEMA_MANIFEST_PATH,
        feature_specification: FEATURE_SPECIFICATION_PATH,
        dataset_manifest: DATASET_MANIFEST_PATH,
        artifact_hashes: ARTIFACT_HASHES_PATH,
        r57_report: R57_REPORT_PATH,
      },
      expected_hashes: EXPECTED_R57_HASHES,
      computed_hashes: inputs.gate.computed,
      manifest_hashes: inputs.gate.manifest,
      hash_representation: "SHA-256 of canonical stable JSON with recursively sorted object keys",
      pre_performance_freeze_path: FREEZE_MANIFEST_PATH,
      pre_performance_freeze_hash: freezeHash,
      pre_performance_freeze: freezeManifest,
      runner_source_paths: RUNNER_SOURCE_PATHS,
      runner_source_hash: sourceHashValue,
      matching_implementation_path: "lib/basis-premium/information-gain.ts",
      matching_implementation_hash: matchingHash,
    },
    hypotheses,
    controls: {
      control_a: {
        dimensions: ["symbol", "calendar_period", "market_regime", "volatility_bucket", "liquidity_bucket"],
        future_outcome_matching: false,
      },
      control_b: {
        dimensions: ["funding_state_bucket", "mark_index_basis_state_bucket", "control_a_dimensions"],
        future_outcome_matching: false,
      },
    },
    metrics: {
      formal_tests: buildMetrics(hypotheses),
      summary: returnValues,
      note: "All B1-B5 formal directional tests were excluded before outcome calculation because R5.7 did not freeze directional semantics.",
    },
    matching: {
      by_family: Object.fromEntries(R58_BASIS_PREMIUM_FAMILIES.map((family) => [family, {
        eligible_events: 0,
        matched_events: 0,
        unmatched_events: 0,
        coverage_percent: null,
        covariate_balance: null,
        status: "SPECIFICATION_INCOMPLETE",
      }])),
    },
    statistics: {
      primary_test_count: 0,
      holm_significant_positive_tests: 0,
      holm_significant_non_positive_tests: 0,
      seed: R58_STATISTICAL_POLICY.seed,
      bootstrap_replicates: R58_STATISTICAL_POLICY.bootstrap_replicates,
      permutation_replicates: R58_STATISTICAL_POLICY.permutation_replicates,
      confidence_level: R58_STATISTICAL_POLICY.confidence_level,
      multiple_testing: R58_STATISTICAL_POLICY.multiple_testing,
      status: "NOT_RUN",
    },
    stability: {
      stable_across_quarters: "NOT_ASSESSED",
      stable_across_regimes: "NOT_ASSESSED",
      largest_symbol_concentration_percent: null,
      status: "NOT_RUN",
    },
    attribution: {
      funding: {
        source: "R5.7 contemporaneous-only overlap artifact",
        formal_outcome_attribution: "NOT_RUN",
        values: funding,
      },
      existing_mark_index: {
        source: existing,
        formal_b1_incremental_attribution: "NOT_RUN",
      },
      new_information: asRecord(inputs.r57Report).new_information ?? [],
    },
    r57_context: {
      family_data: data,
      existing_overlap: existing,
      orthogonality: inputs.r57Report.orthogonality,
    },
    future_performance_calculated: false,
    safety: {
      production_modified: false,
      supabase_production_modified: false,
      vercel_modified: false,
      paper_strategy_modified: false,
      emails_sent: 0,
      private_api_called: false,
      orders_called: false,
      auto_trading: false,
      commit_created: false,
    },
  };
}

function buildMarkdown(report: JsonRecord): string {
  const gate = asRecord(report.artifact_hash_gate);
  const frozen = asRecord(report.frozen_inputs);
  const governance = asRecord(report.governance);
  const stats = asRecord(report.statistics);
  const hypotheses = Array.isArray(report.hypotheses) ? report.hypotheses as JsonRecord[] : [];
  const metrics = asRecord(report.metrics);
  const lines = [
    "# HY-R5.8 Frozen Basis / Premium Information Gain",
    "",
    `- Classification: **${asString(report.classification)}**`,
    `- Review blocked: **${String(report.review_blocked).toUpperCase()}**`,
    `- Reason: ${asString(report.reason)}`,
    "",
    "## Pre-performance hash gate",
    "",
    `- Passed: **${String(gate.passed).toUpperCase()}**`,
    `- Expected/computed artifact hashes: ${JSON.stringify(gate.expected)} / ${JSON.stringify(gate.computed)}`,
    `- Freeze manifest: ${String(frozen.pre_performance_freeze_path)}`,
    `- Freeze hash: ${String(frozen.pre_performance_freeze_hash)}`,
    `- Runner/source hash: ${String(frozen.runner_source_hash)}`,
    `- Matching implementation hash: ${String(frozen.matching_implementation_hash)}`,
    "- Hash representation: SHA-256 of canonical stable JSON with recursively sorted object keys.",
    "",
    "## Authoritative scope",
    "",
    `- Historical range: ${HISTORY_START} -> ${HISTORY_END}`,
    `- Universe: ${String((report.universe as unknown[]).length)}/49`,
    `- Resolution: ${String(report.resolution)}`,
    `- Experiment count: ${String(governance.experiment_count)}`,
    `- B1-B5 frozen before performance: ${String(governance.features_frozen_before_performance)}`,
    `- Post-result tuning: ${String(governance.post_result_tuning)}`,
    `- Future performance calculated: ${String(report.future_performance_calculated).toUpperCase()}`,
    "",
    "## Frozen hypothesis audit",
    "",
    "| Family | Frozen definition | Direction semantics | Formal test |",
    "| --- | --- | --- | --- |",
    ...hypotheses.map((value) => `| ${asString(value.id)} ${asString(value.name)} | ${asString(value.frozen_definition)} | ${asString(value.directional_semantics)} | ${String(value.formal_test_included).toUpperCase()} |`),
    "",
    "No post-result direction, continuation/reversal, threshold, horizon, symbol, quarter, regime, or B6+ selection was made.",
    "",
    "## Controls and metrics",
    "",
    "- Control A dimensions: symbol, calendar period, market regime, volatility bucket, liquidity bucket.",
    "- Control B adds PIT-safe Funding state/bucket and existing Mark/Index basis state/bucket.",
    "- Matching, future outcomes, precision, return, MFE, MAE, and Holm tests were not run because all formal directional phenomena were excluded at the frozen-semantics gate.",
    `- Formal tests: ${String(stats.primary_test_count)}; Holm-significant positive: ${String(stats.holm_significant_positive_tests)}; non-positive: ${String(stats.holm_significant_non_positive_tests)}.`,
    `- Statistical policy remains frozen at ${String(stats.bootstrap_replicates)}/${String(stats.permutation_replicates)} replicates with ${String(stats.multiple_testing)} correction if a valid pre-registered directional specification is supplied in a separately governed study.`,
    `- Metrics status: ${String(metrics.note)}`,
    "",
    "## Attribution boundary",
    "",
    "- Funding was not credited as new information; only R5.7 contemporaneous overlap is carried forward.",
    "- B1 raw effect versus existing Mark/Index effect was not estimated because no valid frozen direction existed.",
    "- R5.7 existing overlap remains PARTIALLY_USED; this does not establish incremental performance.",
    "",
    "## Safety",
    "",
    "- Production: unchanged; Supabase: unchanged; Vercel: unchanged; PAPER strategy: unchanged.",
    "- Emails: 0; private Binance API: NO; orders: NO; AUTO_TRADING: FALSE; commit: NO.",
    "",
    "STOP.",
  ];
  return `${lines.join("\n")}\n`;
}

async function writeReport(report: JsonRecord): Promise<void> {
  await writeFile(JSON_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(MARKDOWN_REPORT_PATH, buildMarkdown(report), "utf8");
}

async function createOrLoadFreezeManifest(
  inputs: FrozenInputs,
  hypotheses: HypothesisStatus[],
  sourceHashValue: string,
  matchingHash: string,
): Promise<{ manifest: JsonRecord; hash: string }> {
  const expected = {
    version: "hy-r5.8-basis-premium-v1",
    experiment_count: 1,
    features_frozen_before_performance: "YES",
    post_result_tuning: "NO",
    historical_range: { start: HISTORY_START, end: HISTORY_END },
    universe: inputs.dataset.universe,
    resolution: "1h",
    frozen_artifact_hashes: EXPECTED_R57_HASHES,
    feature_specification_hash: EXPECTED_R57_HASHES.feature_specification,
    hypothesis_manifest: hypotheses,
    runner_source_hash: sourceHashValue,
    matching_implementation_hash: matchingHash,
    outcome_metrics_not_yet_calculated: true,
  } as JsonRecord;
  if (await fileExists(FREEZE_MANIFEST_PATH)) {
    const existing = await loadJson(FREEZE_MANIFEST_PATH);
    const mismatches = [
      "version",
      "experiment_count",
      "features_frozen_before_performance",
      "post_result_tuning",
      "historical_range",
      "universe",
      "resolution",
      "frozen_artifact_hashes",
      "feature_specification_hash",
      "hypothesis_manifest",
      "runner_source_hash",
      "matching_implementation_hash",
      "outcome_metrics_not_yet_calculated",
    ].filter((key) => sha256Json(existing[key]) !== sha256Json(expected[key]));
    if (mismatches.length > 0) throw new Error(`RESEARCH_INVALID: pre-performance freeze changed: ${mismatches.join(",")}`);
    return { manifest: existing, hash: sha256Json(existing) };
  }
  await writeFile(FREEZE_MANIFEST_PATH, `${JSON.stringify({
    research: "HY-R5.8 FROZEN BASIS / PREMIUM INFORMATION GAIN",
    created_at: new Date().toISOString(),
    immutable: true,
    ...expected,
    artifact_paths: {
      coverage_matrix: COVERAGE_MATRIX_PATH,
      schema_manifest: SCHEMA_MANIFEST_PATH,
      feature_specification: FEATURE_SPECIFICATION_PATH,
      dataset_manifest: DATASET_MANIFEST_PATH,
    },
    artifact_hash_method: "SHA-256 of canonical stable JSON with recursively sorted object keys",
    control_policy: {
      control_a: ["symbol", "calendar_period", "market_regime", "volatility_bucket", "liquidity_bucket"],
      control_b: ["funding_state_bucket", "mark_index_basis_state_bucket", "control_a_dimensions"],
      no_future_outcome_matching: true,
    },
    statistical_policy: R58_STATISTICAL_POLICY,
    direction_policy: "R5.7 frozen directional semantics are required; absent semantics are SPECIFICATION_INCOMPLETE and excluded.",
  }, null, 2)}\n`, "utf8");
  const manifest = await loadJson(FREEZE_MANIFEST_PATH);
  return { manifest, hash: sha256Json(manifest) };
}

async function main(): Promise<void> {
  if (await fileExists(JSON_REPORT_PATH) || await fileExists(MARKDOWN_REPORT_PATH)) {
    throw new Error("PERFORMANCE_ALREADY_COMPLETED: refusing to rerun HY-R5.8 authoritative study");
  }
  const [inputs, sourceHashValue, matchingHash] = await Promise.all([
    loadFrozenInputs(),
    sourceHash(),
    rawFileHash("lib/basis-premium/information-gain.ts"),
  ]);
  const hypotheses = buildHypothesisManifest(inputs.feature);
  const governanceErrors = validateExperimentGovernance({
    experiment_count: 1,
    features_frozen_before_performance: "YES",
    post_result_tuning: "NO",
  });
  if (!inputs.gate.passed || inputs.gateErrors.length > 0 || governanceErrors.length > 0) {
    const report = buildInvalidReport(
      inputs,
      hypotheses,
      sourceHashValue,
      matchingHash,
      null,
      null,
      `Pre-performance gate failed: ${[...inputs.gateErrors, ...governanceErrors].join(",")}`,
    );
    await writeReport(report);
    console.log(JSON.stringify({ classification: report.classification, futurePerformanceCalculated: false, output: JSON_REPORT_PATH }, null, 2));
    return;
  }
  const freeze = await createOrLoadFreezeManifest(inputs, hypotheses, sourceHashValue, matchingHash);
  const incomplete = hypotheses.filter((value) => value.directional_semantics === "SPECIFICATION_INCOMPLETE");
  if (incomplete.length === 0) {
    throw new Error("RESEARCH_INVALID: R5.8 formal engine is fail-closed until direction semantics are independently governed; no post-freeze semantics may be invented");
  }
  const report = buildInvalidReport(
    inputs,
    hypotheses,
    sourceHashValue,
    matchingHash,
    freeze.manifest,
    freeze.hash,
    "R5.7 frozen feature definitions do not explicitly specify bullish/bearish, continuation/reversal, or event-formation semantics for B1-B5; all formal directional tests are excluded before any future outcome is calculated.",
  );
  await writeReport(report);
  console.log(JSON.stringify({
    classification: report.classification,
    artifactHashesVerified: inputs.gate.passed,
    hypothesesIncomplete: incomplete.map((value) => value.id),
    futurePerformanceCalculated: false,
    output: JSON_REPORT_PATH,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
