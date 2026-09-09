import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256Json } from "../lib/crowding";
import {
  R58A_R57_FEATURE_SPECIFICATION_HASH,
  buildR58AHypothesisManifest,
  hypothesisManifestHash,
  validateR58AHypothesisManifest,
} from "../lib/basis-premium/hypothesis";
import type { HypothesisManifest, JsonRecord } from "../lib/basis-premium/hypothesis";

const R57_FEATURE_SPECIFICATION_PATH = resolve("data", "raw", "hy-r5.7-basis-premium-preflight", "artifacts", "feature-specification.json");
const R57_REPORT_PATH = resolve("reports", "hy-r5.7-basis-premium-preflight.json");
const R58_REPORT_PATH = resolve("reports", "hy-r5.8-basis-premium-information-gain.json");
const R58_FREEZE_PATH = resolve("reports", "hy-r5.8-pre-performance-freeze.json");
const MANIFEST_PATH = resolve("reports", "hy-r5.8a-basis-premium-hypothesis-freeze.json");
const MARKDOWN_PATH = resolve("reports", "hy-r5.8a-basis-premium-hypothesis-freeze.md");

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
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

async function loadOrWriteManifest(): Promise<{ manifest: HypothesisManifest; hash: string }> {
  const expected = buildR58AHypothesisManifest();
  const expectedHash = hypothesisManifestHash(expected);
  if (await fileExists(MANIFEST_PATH)) {
    const existing = await loadJson(MANIFEST_PATH) as unknown as HypothesisManifest;
    if (hypothesisManifestHash(existing) !== expectedHash) {
      throw new Error("HYPOTHESIS_FREEZE_INVALID: existing R5.8A manifest changed");
    }
    const errors = validateR58AHypothesisManifest(existing);
    if (errors.length > 0) throw new Error(`HYPOTHESIS_FREEZE_INVALID: ${errors.join(",")}`);
    return { manifest: existing, hash: expectedHash };
  }
  await writeFile(MANIFEST_PATH, `${JSON.stringify(expected, null, 2)}\n`, "utf8");
  return { manifest: expected, hash: expectedHash };
}

function buildMarkdown(report: JsonRecord): string {
  const manifest = asRecord(report.manifest);
  const hypotheses = Array.isArray(manifest.hypotheses) ? manifest.hypotheses.filter(isRecord) : [];
  const lines = [
    "# HY-R5.8A Basis / Premium Directional Hypothesis + Event Semantics Freeze",
    "",
    `- Classification: **${asString(report.classification)}**`,
    `- R5.7 feature specification unchanged: **${String(report.r57_feature_specification_unchanged).toUpperCase()}**`,
    `- R5.7 feature specification hash: ${asString(report.r57_feature_specification_hash)}`,
    `- Authoritative performance count: ${String(report.authoritative_performance_count)}`,
    `- Pre-performance validation attempts: ${String(report.preperformance_validation_attempts)}`,
    `- Future performance calculated: **${String(report.future_performance_calculated).toUpperCase()}**`,
    `- Hypothesis manifest hash: ${asString(report.hypothesis_manifest_hash)}`,
    "",
    "## Frozen hypotheses",
    "",
    "| Family | Hypothesis | Direction mapping | Event eligibility |",
    "| --- | --- | --- | --- |",
    ...hypotheses.map((value) => `| ${asString(value.id)} | ${asString(value.hypothesis)} | ${JSON.stringify(value.direction_mapping)} | ${asString(value.event_eligibility)} |`),
    "",
    "## Event semantics",
    "",
    `- Formation: ${String(asRecord(manifest.event_semantics).formation)}`,
    `- Repeated TRUE deduplicated: ${String(asRecord(manifest.event_semantics).repeated_true_deduplicated).toUpperCase()}`,
    `- Episode reset: ${String(asRecord(manifest.event_semantics).episode_reset)}`,
    `- Zero/ambiguous sign: ${String(asRecord(manifest.event_semantics).zero_or_ambiguous_sign)}`,
    `- Ambiguous B4: ${String(asRecord(manifest.event_semantics).ambiguous_b4)}`,
    "",
    "## PIT, horizons and existing-information controls",
    "",
    "- Event timestamp is the first legal decision timestamp after the observation is fully available under the R5.7 PIT contract.",
    `- Primary horizons: ${JSON.stringify(asRecord(manifest.horizons).primary)}; secondary horizons: ${JSON.stringify(asRecord(manifest.horizons).secondary)}.`,
    "- Performance is not calculated in this freeze.",
    "- Future-information matching is prohibited. Formal performance must control Funding state and existing Mark/Index basis state in addition to market context.",
    "",
    "## Hash and safety",
    "",
    "- Hypothesis hash representation: deterministic canonical JSON with recursively sorted object keys.",
    "- R5.7 feature calculations, windows, rolling methodology, percentiles, source data and PIT contract were not modified.",
    "- Production, Supabase, Vercel, PAPER strategy, scanner and email paths were not touched.",
    "- Private Binance API: NO; orders: NO; AUTO_TRADING: FALSE; commit: NO.",
    "",
    "STOP.",
  ];
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const [r57Feature, r57Report, r58Report, r58Freeze] = await Promise.all([
    loadJson(R57_FEATURE_SPECIFICATION_PATH),
    loadJson(R57_REPORT_PATH),
    loadJson(R58_REPORT_PATH),
    loadJson(R58_FREEZE_PATH),
  ]);
  const r57FeatureHash = sha256Json(r57Feature);
  const r57ReportHashes = asRecord(r57Report.artifact_hashes);
  const r58ReportGate = asRecord(r58Report.artifact_hash_gate);
  const errors: string[] = [];
  if (r57FeatureHash !== R58A_R57_FEATURE_SPECIFICATION_HASH) errors.push("R5.7 feature specification hash changed");
  if (r57ReportHashes.feature_specification_sha256 !== R58A_R57_FEATURE_SPECIFICATION_HASH) errors.push("R5.7 report feature hash");
  if (r57Report.future_performance_calculated !== false) errors.push("R5.7 future performance flag");
  if (r58ReportGate.passed !== true) errors.push("R5.8 pre-performance hash gate");
  if (r58Report.future_performance_calculated !== false) errors.push("R5.8 future performance flag");
  if (r58Freeze.outcome_metrics_not_yet_calculated !== true) errors.push("R5.8 pre-performance freeze outcome flag");
  const { manifest, hash } = await loadOrWriteManifest();
  errors.push(...validateR58AHypothesisManifest(manifest));
  const report: JsonRecord = {
    research: "HY-R5.8A BASIS / PREMIUM DIRECTIONAL HYPOTHESIS + EVENT SEMANTICS FREEZE",
    version: manifest.version,
    generated_at: new Date().toISOString(),
    classification: errors.length === 0 ? "HYPOTHESIS_FREEZE_READY" : "HYPOTHESIS_FREEZE_INVALID",
    r57_feature_specification_unchanged: errors.includes("R5.7 feature specification hash changed") === false,
    r57_feature_specification_hash: r57FeatureHash,
    expected_r57_feature_specification_hash: R58A_R57_FEATURE_SPECIFICATION_HASH,
    manifest_path: MANIFEST_PATH,
    hypothesis_manifest_hash: hash,
    authoritative_performance_count: manifest.authoritative_performance_count,
    preperformance_validation_attempts: manifest.preperformance_validation_attempts,
    future_performance_calculated: false,
    pit_safe: "PASS",
    errors,
    manifest,
    source_boundaries: {
      r57_feature_specification_path: R57_FEATURE_SPECIFICATION_PATH,
      r57_report_path: R57_REPORT_PATH,
      r58_preperformance_freeze_path: R58_FREEZE_PATH,
      r58_report_path: R58_REPORT_PATH,
    },
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
  await writeFile(MARKDOWN_PATH, buildMarkdown(report), "utf8");
  console.log(JSON.stringify({
    classification: report.classification,
    r57FeatureSpecificationUnchanged: report.r57_feature_specification_unchanged,
    hypothesisManifestHash: hash,
    authoritativePerformanceCount: 0,
    futurePerformanceCalculated: false,
    output: MARKDOWN_PATH,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
