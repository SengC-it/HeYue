import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256Json } from "../lib/crowding";
import { R58B_EXPECTED_R57_HASHES } from "../lib/basis-premium/authoritative";
import {
  verifyExpectedArtifactHashes,
} from "../lib/basis-premium/information-gain";
import {
  hypothesisManifestHash,
  validateR58AHypothesisManifest,
} from "../lib/basis-premium/hypothesis";
import {
  R58A1_R57_FEATURE_SPECIFICATION_HASH,
  R58A1_R58A_HYPOTHESIS_MANIFEST_HASH,
  buildR58A1CutoffManifest,
  cutoffManifestHash,
} from "../lib/basis-premium/cutoff";
import type { ExpectedHashMap, JsonRecord } from "../lib/basis-premium/information-gain";
import type { HypothesisManifest } from "../lib/basis-premium/hypothesis";

const R57_ARTIFACT_ROOT = resolve("data", "raw", "hy-r5.7-basis-premium-preflight", "artifacts");
const R57_COVERAGE_PATH = resolve(R57_ARTIFACT_ROOT, "coverage-matrix.json");
const R57_SCHEMA_PATH = resolve(R57_ARTIFACT_ROOT, "schema-manifest.json");
const R57_FEATURE_PATH = resolve(R57_ARTIFACT_ROOT, "feature-specification.json");
const R57_DATASET_PATH = resolve(R57_ARTIFACT_ROOT, "dataset-manifest.json");
const R57_ARTIFACT_HASHES_PATH = resolve(R57_ARTIFACT_ROOT, "artifact-hashes.json");
const R57_REPORT_PATH = resolve("reports", "hy-r5.7-basis-premium-preflight.json");
const R58A_MANIFEST_PATH = resolve("reports", "hy-r5.8a-basis-premium-hypothesis-freeze.json");
const R58B_REPORT_PATH = resolve("reports", "hy-r5.8b-basis-premium-information-gain.json");
const R58B_FREEZE_PATH = resolve("reports", "hy-r5.8b-pre-performance-freeze.json");
const CUTOFF_REPORT_PATH = resolve("reports", "hy-r5.8a1-basis-premium-event-cutoff-freeze.json");
const CUTOFF_MARKDOWN_PATH = resolve("reports", "hy-r5.8a1-basis-premium-event-cutoff-freeze.md");
const SOURCE_PATHS = [
  "scripts/run-hy-r5-8a1-basis-premium-event-cutoff-freeze.ts",
  "lib/basis-premium/cutoff.ts",
] as const;

interface FrozenInputs {
  coverage: JsonRecord;
  schema: JsonRecord;
  feature: JsonRecord;
  dataset: JsonRecord;
  r57Report: JsonRecord;
  r58aManifest: HypothesisManifest;
  r58bReport: JsonRecord;
  r58bFreeze: JsonRecord;
  r57Gate: ReturnType<typeof verifyExpectedArtifactHashes>;
  r58aHash: string;
  r58aValidationErrors: string[];
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

async function rawSourceHash(): Promise<string> {
  const hash = createHash("sha256");
  for (const path of SOURCE_PATHS) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(resolve(path), "utf8"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function allSameArray(left: unknown, right: unknown): boolean {
  return sha256Json(left) === sha256Json(right);
}

async function loadFrozenInputs(): Promise<FrozenInputs> {
  const [coverage, schema, feature, dataset, artifactHashes, r57Report, r58aRecord, r58bReport, r58bFreeze] = await Promise.all([
    loadJson(R57_COVERAGE_PATH),
    loadJson(R57_SCHEMA_PATH),
    loadJson(R57_FEATURE_PATH),
    loadJson(R57_DATASET_PATH),
    loadJson(R57_ARTIFACT_HASHES_PATH),
    loadJson(R57_REPORT_PATH),
    loadJson(R58A_MANIFEST_PATH),
    loadJson(R58B_REPORT_PATH),
    loadJson(R58B_FREEZE_PATH),
  ]);
  const computed: Partial<ExpectedHashMap> = {
    coverage_matrix: sha256Json(coverage),
    schema_manifest: sha256Json(schema),
    feature_specification: sha256Json(feature),
    dataset_manifest: sha256Json(dataset),
  };
  const r57Gate = verifyExpectedArtifactHashes(R58B_EXPECTED_R57_HASHES, computed, artifactHashes);
  const r58aManifest = r58aRecord as unknown as HypothesisManifest;
  const r58aHash = hypothesisManifestHash(r58aManifest);
  const r58aValidationErrors = validateR58AHypothesisManifest(r58aManifest);
  const gateErrors = [...r57Gate.mismatches];
  if (r58aHash !== R58A1_R58A_HYPOTHESIS_MANIFEST_HASH) gateErrors.push("r58a_hypothesis_hash");
  gateErrors.push(...r58aValidationErrors.map((value) => `r58a_manifest:${value}`));
  const r57Universe = asArray(r57Report.universe);
  const datasetUniverse = asArray(dataset.universe);
  const coverageUniverse = asArray(coverage.universe);
  if (r57Universe.length !== 49 || datasetUniverse.length !== 49 || coverageUniverse.length !== 49) gateErrors.push("universe_count");
  if (!allSameArray(r57Universe, datasetUniverse) || !allSameArray(r57Universe, coverageUniverse)) gateErrors.push("universe_changed");
  if (asString(r57Report.selected_resolution) !== "1h" || asString(dataset.selected_resolution) !== "1h" || asString(coverage.selected_resolution) !== "1h") gateErrors.push("resolution_changed");
  if (r57Report.pit_safe !== "PASS") gateErrors.push("pit_not_pass");
  if (r57Report.future_performance_calculated !== false) gateErrors.push("r57_future_outcome");
  if (r58bReport.executed_future_outcome_count !== 0 || r58bReport.future_performance_calculated !== false) gateErrors.push("r58b_future_outcome");
  if (r58bReport.all_five_frozen_hashes_verified !== true) gateErrors.push("r58b_hash_gate");
  if (r58bFreeze.immutable !== true || r58bFreeze.outcome_metrics_not_yet_calculated !== true) gateErrors.push("r58b_freeze_state");
  return {
    coverage,
    schema,
    feature,
    dataset,
    r57Report,
    r58aManifest,
    r58bReport,
    r58bFreeze,
    r57Gate,
    r58aHash,
    r58aValidationErrors,
    gateErrors,
  };
}

function buildFrozenManifest(sourceHash: string): Record<string, unknown> {
  return {
    ...buildR58A1CutoffManifest(),
    source_lock: {
      paths: SOURCE_PATHS,
      sha256: sourceHash,
      representation: "raw UTF-8 source bytes with path and NUL delimiters",
    },
  };
}

async function loadOrBuildManifest(sourceHash: string): Promise<{ manifest: Record<string, unknown>; hash: string; existingReport: JsonRecord | null }> {
  const expected = buildFrozenManifest(sourceHash);
  if (await fileExists(CUTOFF_REPORT_PATH)) {
    const report = await loadJson(CUTOFF_REPORT_PATH);
    const existing = asRecord(report.manifest);
    const existingHash = cutoffManifestHash(existing);
    if (existingHash !== asString(report.cutoff_manifest_hash)) throw new Error("CUTOFF_FREEZE_INVALID: stored manifest hash does not match manifest bytes");
    if (existingHash !== cutoffManifestHash(expected)) throw new Error("CUTOFF_FREEZE_INVALID: existing cutoff manifest changed");
    return { manifest: existing, hash: existingHash, existingReport: report };
  }
  return { manifest: expected, hash: cutoffManifestHash(expected), existingReport: null };
}

function format(value: unknown): string {
  return value === null || value === undefined || value === "" ? "N/A" : String(value);
}

function buildMarkdown(
  report: JsonRecord,
  inputs: FrozenInputs,
  manifest: Record<string, unknown>,
  manifestHash: string,
  sourceHash: string,
): string {
  const gate = asRecord(report.verification);
  const cutoffs = asRecord(manifest.cutoffs);
  const b1 = asRecord(cutoffs.B1);
  const b2 = asRecord(cutoffs.B2);
  const b3 = asRecord(cutoffs.B3);
  const b4 = asRecord(cutoffs.B4);
  const b5 = asRecord(cutoffs.B5);
  const governance = asRecord(manifest.governance);
  const lines = [
    "# HY-R5.8A.1 Exact Basis/Premium Event Cutoff Freeze",
    "",
    `- Classification: **${asString(report.classification)}**`,
    `- R5.7 feature hash unchanged: **${String(report.r57_feature_hash_unchanged).toUpperCase()}**`,
    `- R5.8A hypothesis hash unchanged: **${String(report.r58a_hypothesis_hash_unchanged).toUpperCase()}**`,
    `- PIT-safe: **${asString(report.pit_safe)}**`,
    `- Cutoff manifest hash: ${manifestHash}`,
    `- Source hash: ${sourceHash}`,
    "",
    "## Exact frozen cutoffs",
    "",
    `- B1 bearish: raw basis > 0 AND PIT-safe rolling percentile >= 0.95; bullish: raw basis < 0 AND percentile <= 0.05.`,
    `- B2 bearish: premium > 0 AND PIT-safe rolling percentile >= 0.95; bullish: premium < 0 AND percentile <= 0.05.`,
    `- B3 bearish: signed expansion > 0 AND PIT-safe rolling percentile >= 0.95; bullish: signed expansion < 0 AND percentile <= 0.05. Unavailable signed primitive: SPECIFICATION_INCOMPATIBLE.`,
    `- B4 bearish: price-change percentile >= 0.75 AND premium-change percentile <= 0.25; bullish: price-change percentile <= 0.25 AND premium-change percentile >= 0.75.`,
    `- B5 bearish: contemporaneous cross-sectional percentile >= 0.90; bullish: <= 0.10.`,
    `- B5 ties: average rank; deterministic symbol-ascending secondary order; percentile = (rank - 1) / (N - 1); N < 2 = NO_EVENT.`,
    "",
    "## Governance and PIT",
    "",
    `- Pre-performance validation attempts: ${format(governance.preperformance_validation_attempts)}`,
    `- Authoritative performance executions: ${format(governance.authoritative_performance_executions)}`,
    `- Future outcomes generated: ${format(governance.future_outcomes_generated)}`,
    `- Performance lock: ${format(governance.performance_lock)}`,
    "- General percentile: only the R5.7 PIT-safe rolling distribution of prior completed observations; insufficient history = NO_EVENT.",
    "- Event formation: FALSE_TO_TRUE_TRANSITION; repeated TRUE is deduplicated; TRUE→FALSE resets the episode.",
    "- PIT event time: only after the 1h observation is complete; for a period-start label, open_time + 1h.",
    "- Missing required primitive: NO_EVENT / DATA_INCOMPLETE. No forward fill, zero fill, interpolation or future fill.",
    "- Zero/ambiguous values and non-divergent combinations: NO_EVENT.",
    "",
    "## Verification evidence",
    "",
    `- R5.7 four-artifact hash gate: ${String(asRecord(gate.r57_hash_gate).passed).toUpperCase()}`,
    `- R5.8A hypothesis manifest hash: ${inputs.r58aHash}`,
    `- R5.8B executed future outcomes: ${format(inputs.r58bReport.executed_future_outcome_count)}`,
    `- R5.8B future performance calculated: ${String(inputs.r58bReport.future_performance_calculated).toUpperCase()}`,
    `- Frozen source paths: ${JSON.stringify(SOURCE_PATHS)}`,
    `- B1 manifest: ${JSON.stringify(b1)}`,
    `- B2 manifest: ${JSON.stringify(b2)}`,
    `- B3 manifest: ${JSON.stringify(b3)}`,
    `- B4 manifest: ${JSON.stringify(b4)}`,
    `- B5 manifest: ${JSON.stringify(b5)}`,
    "",
    "## Prohibited boundary",
    "",
    "- No future return/direction/volatility, precision, MFE, MAE, matched-control outcome, PnL, profit-factor or Sharpe computation was called.",
    "- Production: unchanged; Supabase Production: unchanged; Vercel: unchanged; PAPER strategy: unchanged.",
    "- Scanner: unchanged; emails: 0; private API: NO; orders: NO; AUTO_TRADING: FALSE; commit: NO.",
    "",
    "STOP.",
  ];
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  if (await fileExists(CUTOFF_MARKDOWN_PATH) && !await fileExists(CUTOFF_REPORT_PATH)) {
    throw new Error("CUTOFF_FREEZE_INVALID: markdown exists without the cutoff manifest report");
  }
  const [inputs, sourceHash] = await Promise.all([loadFrozenInputs(), rawSourceHash()]);
  const frozenManifest = await loadOrBuildManifest(sourceHash);
  const r57FeatureHash = sha256Json(inputs.feature);
  const r57HashGate = inputs.r57Gate;
  const r58aHashUnchanged = inputs.r58aHash === R58A1_R58A_HYPOTHESIS_MANIFEST_HASH && inputs.r58aValidationErrors.length === 0;
  const ready = inputs.gateErrors.length === 0
    && r57FeatureHash === R58A1_R57_FEATURE_SPECIFICATION_HASH
    && r58aHashUnchanged
    && inputs.r57Report.pit_safe === "PASS"
    && inputs.r58bReport.executed_future_outcome_count === 0;
  const report: JsonRecord = {
    research: "HY-R5.8A.1 EXACT BASIS/PREMIUM EVENT CUTOFF FREEZE",
    version: "hy-r5.8a1-basis-premium-event-cutoff-v1",
    generated_at: new Date().toISOString(),
    classification: ready ? "CUTOFF_FREEZE_READY" : "CUTOFF_FREEZE_INVALID",
    r57_feature_hash_unchanged: r57FeatureHash === R58A1_R57_FEATURE_SPECIFICATION_HASH,
    r57_feature_hash: r57FeatureHash,
    r58a_hypothesis_hash_unchanged: r58aHashUnchanged,
    r58a_hypothesis_hash: inputs.r58aHash,
    cutoff_manifest_hash: frozenManifest.hash,
    cutoff_manifest_path: CUTOFF_REPORT_PATH,
    pit_safe: inputs.r57Report.pit_safe === "PASS" ? "PASS" : "FAIL",
    historical_range: asRecord(inputs.r57Report.historical_range),
    universe: asArray(inputs.r57Report.universe),
    resolution: inputs.r57Report.selected_resolution,
    preperformance_validation_attempts: 2,
    authoritative_performance_executions: 0,
    future_outcomes_generated: 0,
    performance_lock: "NOT_TRIGGERED",
    no_outcome_computation: true,
    no_historical_event_count_tuning: true,
    verification: {
      r57_hash_gate: r57HashGate,
      r57_four_hashes_exact: r57HashGate.passed,
      r58a_manifest_validation_errors: inputs.r58aValidationErrors,
      r58b_gate_errors: inputs.gateErrors,
      r58b_future_outcomes: inputs.r58bReport.executed_future_outcome_count,
      source_hash: sourceHash,
      source_paths: SOURCE_PATHS,
    },
    manifest: frozenManifest.manifest,
    safety: {
      production_modified: false,
      supabase_production_modified: false,
      vercel_modified: false,
      paper_strategy_modified: false,
      scanner_modified: false,
      emails_sent: 0,
      private_api_called: false,
      orders_called: false,
      auto_trading: false,
      commit_created: false,
    },
  };
  if (frozenManifest.existingReport !== null) {
    if (asString(frozenManifest.existingReport.cutoff_manifest_hash) !== frozenManifest.hash) throw new Error("CUTOFF_FREEZE_INVALID: report hash changed");
  } else {
    await writeFile(CUTOFF_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const reloaded = await loadJson(CUTOFF_REPORT_PATH);
    if (asString(reloaded.cutoff_manifest_hash) !== frozenManifest.hash || cutoffManifestHash(asRecord(reloaded.manifest)) !== frozenManifest.hash) {
      throw new Error("CUTOFF_FREEZE_INVALID: cutoff manifest write was not deterministic");
    }
  }
  if (!await fileExists(CUTOFF_MARKDOWN_PATH)) {
    await writeFile(CUTOFF_MARKDOWN_PATH, buildMarkdown(report, inputs, frozenManifest.manifest, frozenManifest.hash, sourceHash), "utf8");
  }
  console.log(JSON.stringify({
    classification: report.classification,
    r57FeatureHashUnchanged: report.r57_feature_hash_unchanged,
    r58aHypothesisHashUnchanged: report.r58a_hypothesis_hash_unchanged,
    cutoffManifestHash: frozenManifest.hash,
    preperformanceValidationAttempts: report.preperformance_validation_attempts,
    authoritativePerformanceExecutions: report.authoritative_performance_executions,
    futureOutcomesGenerated: report.future_outcomes_generated,
    performanceLock: report.performance_lock,
    output: CUTOFF_REPORT_PATH,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
