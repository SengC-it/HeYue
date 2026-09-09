import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import type { Candle, FundingRatePoint } from "../lib/core/types";
import {
  R55_CROWDING_FAMILIES,
  R55_DIRECTIONS,
  R55_FROZEN_EVALUATION_SPEC,
  R55_HORIZONS,
  binaryPairedInference,
  classifyC1Direction,
  classifyC2Direction,
  crowdingMatchKey,
  sha256Json,
} from "../lib/crowding";
import type {
  CrowdingDirection,
  CrowdingFamily,
  CrowdingHorizon,
} from "../lib/crowding";
import {
  holmAdjust,
  matchNearestWithoutReplacement,
  summarizeNumeric,
} from "../lib/aggressive-flow";
import type { MatchablePoint } from "../lib/aggressive-flow";

type JsonRecord = Record<string, unknown>;
type VolatilityBucket = "LOW" | "MEDIUM" | "HIGH";
type LiquidityBucket = "LOW" | "MEDIUM" | "HIGH";
type MarketRegime = "UP" | "DOWN" | "RANGE";

const EVALUATION_START = Date.parse("2024-08-09T00:00:00.000Z");
const EVALUATION_END_EXCLUSIVE = Date.parse("2026-08-10T00:00:00.000Z");
const EVALUATION_START_ISO = "2024-08-09T00:00:00.000Z";
const EVALUATION_END_ISO = "2026-08-09T23:59:59.999Z";
const FORMAL_EVENT_END_EXCLUSIVE = EVALUATION_END_EXCLUSIVE - 24 * 60 * 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const FIFTEEN_MINUTES_MS = 15 * 60_000;
const BASELINE_BUCKETS = 672;
const OUTCOME_BARS: Record<CrowdingHorizon, number> = {
  "1h": 4,
  "4h": 16,
  "12h": 48,
  "24h": 96,
};
const FUNDING_WINDOW_MS = 30 * 24 * 60 * 60_000;
const FUNDING_MIN_PRIOR_POINTS = 30;
const FUNDING_LOW_PERCENTILE = 0.05;
const FUNDING_HIGH_PERCENTILE = 0.95;
const EXPECTED_UNIVERSE_COUNT = 49;
const EXPECTED_HASHES = {
  coverage_matrix: "0f8214d88487754e123478b8be3b7f46fe7bfd9e90dbef7343b66b2c10a8513c",
  schema_manifest: "8aa7ff4dc001244e0e5b9cd45850f7fcd57a0f9b82715e135f58e5bdd98db3b8",
  feature_specification: "cebe6cfe2afac8cc548299911352b30e102f5a31690af1160e3a7714d3b77911",
  dataset_manifest: "e4ac51e05372399372768600cddd5f1303280e6b376df76e4b0139eaa080fdd6",
} as const;

const DATA_DIRECTORY = resolve("data", "hy-r2b-history-24m");
const CROWDING_ARTIFACT_DIRECTORY = resolve("data", "raw", "hy-r5.4b-crowding", "artifacts");
const COMPACT_DIRECTORY = resolve("data", "raw", "hy-r5.4b-crowding", "compact");
const COVERAGE_MATRIX_PATH = resolve(CROWDING_ARTIFACT_DIRECTORY, "coverage-matrix.json");
const SCHEMA_MANIFEST_PATH = resolve(CROWDING_ARTIFACT_DIRECTORY, "schema-manifest.json");
const FEATURE_SPECIFICATION_PATH = resolve(CROWDING_ARTIFACT_DIRECTORY, "feature-specification.json");
const DATASET_MANIFEST_PATH = resolve(CROWDING_ARTIFACT_DIRECTORY, "dataset-manifest.json");
const ARTIFACT_HASHES_PATH = resolve(CROWDING_ARTIFACT_DIRECTORY, "artifact-hashes.json");
const FOUNDATION_REPORT_PATH = resolve("reports", "hy-r5.4b-crowding-data-foundation.json");
const FREEZE_MANIFEST_PATH = resolve("reports", "hy-r5.5-pre-performance-freeze.json");
const JSON_REPORT_PATH = resolve("reports", "hy-r5.5-crowding-information-gain.json");
const MARKDOWN_REPORT_PATH = resolve("reports", "hy-r5.5-crowding-information-gain.md");
const RUNNER_SOURCE_PATHS = [
  "scripts/run-hy-r5-5-crowding-information-gain.ts",
  "lib/crowding/information-gain.ts",
  "lib/crowding/foundation.ts",
  "lib/crowding/types.ts",
  "lib/aggressive-flow/information-gain.ts",
] as const;

interface CoverageMatrix {
  schema_version: string;
  historical_range: { start: string; end: string };
  universe: string[];
  symbols: Array<JsonRecord & { symbol: string }>;
  aggregate_month_matrix: JsonRecord[];
  aggregate_quarter_matrix: JsonRecord[];
}

interface SchemaManifest extends JsonRecord {
  schema_version: string;
  canonical_headers: string[];
}

interface FeatureSpecification extends JsonRecord {
  schema_version: string;
  specification_hash_generated_before_performance: boolean;
  c1_c4_unchanged: boolean;
  specification: JsonRecord;
}

interface CompactArtifact {
  relative_path: string;
  rows: number;
  bytes: number;
  sha256: string;
}

interface DatasetManifest {
  schema_version: string;
  historical_range: { start: string; end: string };
  universe: string[];
  row_schema: string[];
  prohibited_columns: string[];
  compact_artifacts: CompactArtifact[];
}

interface FoundationReport extends JsonRecord {
  classification: string;
  historical_range: { start: string; end: string };
  universe: string[];
  universe_count: number;
  data: {
    raw_rows: number;
    parsed_rows: number;
    valid_positioning_observations: number;
    rejected_rows: number;
    listing_adjusted_expected_observations: number;
    adjusted_coverage_percent: number;
    missing_observations: number;
    compact_rows: number;
  };
  coverage: JsonRecord;
  pit_safe: string;
  c1_c4_specification_unchanged: boolean;
  performance: JsonRecord;
}

interface FrozenInputs {
  coverage: CoverageMatrix;
  schema: SchemaManifest;
  feature: FeatureSpecification;
  dataset: DatasetManifest;
  artifactHashes: JsonRecord;
  foundation: FoundationReport;
  actualHashes: Record<keyof typeof EXPECTED_HASHES, string>;
}

interface HistoricalDataset {
  symbol: string;
  candles: { "15m": Candle[] };
  fundingRates: FundingRatePoint[];
}

interface CompactRow {
  symbol: string;
  timestamp: number;
  pit_available_at: number;
  lifecycle_id: string;
  top_trader_position_ratio: number;
  top_trader_account_ratio: number;
  global_account_ratio: number;
  open_interest: number;
  open_interest_value: number;
  top_trader_position_percentile: number | null;
  top_trader_account_percentile: number | null;
  global_account_percentile: number | null;
  top_vs_global_divergence: number;
  oi_change: number | null;
  c1_absolute_crowding: boolean | null;
  c2_crowding_divergence: boolean | null;
  c3_oi_crowding_buildup: boolean | null;
  c4_crowding_unwind: boolean | null;
  feature_eligibility: { c1: boolean; c2: boolean; c3: boolean; c4: boolean };
}

interface CandleArrays {
  candles: Candle[];
  priorContiguous: Uint32Array;
  futureContiguous: Uint32Array;
  logSquaredPrefix: Float64Array;
  quoteVolumePrefix: Float64Array;
}

interface MarketContext {
  marketRegime: MarketRegime;
  volatilityBucket: VolatilityBucket;
  liquidityBucket: LiquidityBucket;
  return24h: number;
  return7d: number;
  realizedVolatility24h: number;
  quoteVolume24h: number;
}

interface BasePoint extends MatchablePoint {
  symbol: string;
  month: string;
  quarter: string;
  marketRegime: MarketRegime;
  volatilityBucket: VolatilityBucket;
  liquidityBucket: LiquidityBucket;
  candleIndex: number;
  referencePrice: number;
}

interface AnalysisPoint extends BasePoint {
  lifecycleId: string;
  topVsGlobalDivergence: number;
  featureEligible: { c1: boolean; c2: boolean; c3: boolean; c4: boolean };
  c1AbsoluteCrowding: boolean;
  c2CrowdingDivergence: boolean;
  c3OiCrowdingBuildup: boolean;
  c4CrowdingUnwind: boolean;
  c1Side: CrowdingDirection | null;
  c4Side: CrowdingDirection | null;
  oiChange: number | null;
  anyEvent: boolean;
  allFeatureEligible: boolean;
}

interface FundingPoint extends BasePoint {
  direction: CrowdingDirection;
  fundingRate: number;
  historicalPercentile: number;
}

interface HorizonOutcome {
  futurePrice: number;
  rawReturn: number;
  directionalReturn: number;
  maxFavorableMove: number;
  maxAdverseMove: number;
  realizedVolatility: number;
}

type OutcomeBundle = Record<CrowdingHorizon, HorizonOutcome>;

interface GroupAccumulator {
  n: number;
  sum: number;
}

interface MatchPopulationSummary {
  eventCount: number;
  matchedControlCount: number;
  unmatchedEventCount: number;
  distancesMs: number[];
}

interface FamilySummary {
  total: MatchPopulationSummary;
  byDirection: Record<CrowdingDirection, MatchPopulationSummary>;
}

interface DataCounters {
  compactRows: number;
  compactHashVerified: number;
  aligned15mSlots: number;
  outcomeCompleteSlots: number;
  allFeatureEligibleSlots: number;
  controlSlots: number;
  symbolsProcessed: number;
  latestOutcomeCompleteDecisionTime: number | null;
}

interface ComparisonAccumulatorSet {
  byDirection: Record<CrowdingDirection, Record<CrowdingHorizon, MetricAccumulator>>;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function iso(time: number | null): string | null {
  return time === null ? null : new Date(time).toISOString();
}

function round(value: number | null, digits = 8): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function monthKey(time: number): string {
  return new Date(time).toISOString().slice(0, 7);
}

function quarterKey(time: number): string {
  const date = new Date(time);
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

function emptyMatchSummary(): MatchPopulationSummary {
  return { eventCount: 0, matchedControlCount: 0, unmatchedEventCount: 0, distancesMs: [] };
}

function emptyFamilySummary(): FamilySummary {
  return {
    total: emptyMatchSummary(),
    byDirection: { BULLISH: emptyMatchSummary(), BEARISH: emptyMatchSummary() },
  };
}

function buildFamilySummaries(): Record<CrowdingFamily, FamilySummary> {
  return Object.fromEntries(R55_CROWDING_FAMILIES.map((family) => [family, emptyFamilySummary()])) as Record<CrowdingFamily, FamilySummary>;
}

function addMatchSummary(
  target: MatchPopulationSummary,
  eventCount: number,
  pairs: Array<{ distanceMs: number }>,
): void {
  target.eventCount += eventCount;
  target.matchedControlCount += pairs.length;
  target.unmatchedEventCount += eventCount - pairs.length;
  target.distancesMs.push(...pairs.map((pair) => pair.distanceMs));
}

function summarizeValues(values: number[]): JsonRecord {
  const summary = summarizeNumeric(values);
  return {
    n: summary.n,
    mean: round(summary.mean),
    median: round(summary.median),
    min: round(summary.min),
    max: round(summary.max),
  };
}

function summarizeDistances(values: number[]): JsonRecord {
  let maximum: number | null = null;
  for (const value of values) maximum = maximum === null ? value : Math.max(maximum, value);
  return {
    n: values.length,
    mean_ms: round(values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length, 3),
    median_ms: round(summarizeNumeric(values).median, 3),
    max_ms: maximum,
  };
}

function summarizeMatchPopulation(summary: MatchPopulationSummary): JsonRecord {
  return {
    event_count: summary.eventCount,
    matched_control_count: summary.matchedControlCount,
    unmatched_event_count: summary.unmatchedEventCount,
    matching_coverage_percent: summary.eventCount === 0 ? null : round(summary.matchedControlCount / summary.eventCount * 100, 6),
    match_distance: summarizeDistances(summary.distancesMs),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function loadJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function loadFrozenInputs(): Promise<FrozenInputs> {
  const [coverage, schema, feature, dataset, artifactHashes, foundation] = await Promise.all([
    loadJson<CoverageMatrix>(COVERAGE_MATRIX_PATH),
    loadJson<SchemaManifest>(SCHEMA_MANIFEST_PATH),
    loadJson<FeatureSpecification>(FEATURE_SPECIFICATION_PATH),
    loadJson<DatasetManifest>(DATASET_MANIFEST_PATH),
    loadJson<JsonRecord>(ARTIFACT_HASHES_PATH),
    loadJson<FoundationReport>(FOUNDATION_REPORT_PATH),
  ]);
  const actualHashes = {
    coverage_matrix: sha256Json(coverage),
    schema_manifest: sha256Json(schema),
    feature_specification: sha256Json(feature),
    dataset_manifest: sha256Json(dataset),
  } as const;
  const mismatches = Object.entries(EXPECTED_HASHES)
    .filter(([name, expected]) => actualHashes[name as keyof typeof actualHashes] !== expected)
    .map(([name]) => name);
  const artifactHashMismatches = Object.entries(EXPECTED_HASHES)
    .filter(([name, expected]) => String(artifactHashes[`${name}_hash`]) !== expected)
    .map(([name]) => name);
  if (mismatches.length > 0 || artifactHashMismatches.length > 0) {
    throw new Error(`RESEARCH_INVALID: frozen artifact hash mismatch; computed=${mismatches.join(",") || "none"}; manifest=${artifactHashMismatches.join(",") || "none"}`);
  }
  if (coverage.historical_range.start !== EVALUATION_START_ISO || coverage.historical_range.end !== EVALUATION_END_ISO) {
    throw new Error("RESEARCH_INVALID: coverage historical range changed");
  }
  if (dataset.universe.length !== EXPECTED_UNIVERSE_COUNT || coverage.universe.length !== EXPECTED_UNIVERSE_COUNT) {
    throw new Error("RESEARCH_INVALID: frozen universe is not 49/49");
  }
  if (JSON.stringify([...dataset.universe].sort()) !== JSON.stringify([...coverage.universe].sort())) {
    throw new Error("RESEARCH_INVALID: coverage and dataset universes differ");
  }
  if (feature.specification_hash_generated_before_performance !== true
    || feature.c1_c4_unchanged !== true
    || foundation.pit_safe !== "PASS"
    || foundation.c1_c4_specification_unchanged !== true
    || foundation.classification !== "CROWDING_FOUNDATION_READY") {
    throw new Error("RESEARCH_INVALID: R5.4B frozen PIT/specification gate is not PASS");
  }
  if (dataset.prohibited_columns.some((column) => ["future_return", "future_label", "mfe", "mae", "pnl"].includes(column)) === false) {
    throw new Error("RESEARCH_INVALID: dataset manifest does not carry the expected outcome prohibition");
  }
  return { coverage, schema, feature, dataset, artifactHashes, foundation, actualHashes };
}

async function runnerSourceHash(): Promise<string> {
  const hash = createHash("sha256");
  for (const sourcePath of RUNNER_SOURCE_PATHS) {
    hash.update(sourcePath);
    hash.update("\0");
    hash.update(await readFile(resolve(sourcePath), "utf8"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function createOrLoadFreezeManifest(
  inputs: FrozenInputs,
  sourceHash: string,
): Promise<{ manifest: JsonRecord; hash: string }> {
  if (await exists(JSON_REPORT_PATH) || await exists(MARKDOWN_REPORT_PATH)) {
    throw new Error("PERFORMANCE_ALREADY_COMPLETED: refusing to rerun HY-R5.5 authoritative performance");
  }
  const universe = [...inputs.dataset.universe].sort();
  if (await exists(FREEZE_MANIFEST_PATH)) {
    const existing = await loadJson<JsonRecord>(FREEZE_MANIFEST_PATH);
    const hashes = isRecord(existing.frozen_artifact_hashes) ? existing.frozen_artifact_hashes : null;
    if (existing.version !== R55_FROZEN_EVALUATION_SPEC.version
      || existing.experiment_count !== 1
      || existing.features_frozen_before_performance !== "YES"
      || existing.post_result_tuning !== "NO"
      || existing.outcome_metrics_not_yet_calculated !== true
      || JSON.stringify(existing.universe) !== JSON.stringify(universe)
      || String(hashes?.coverage_matrix) !== EXPECTED_HASHES.coverage_matrix
      || String(hashes?.schema_manifest) !== EXPECTED_HASHES.schema_manifest
      || String(hashes?.feature_specification) !== EXPECTED_HASHES.feature_specification
      || String(hashes?.dataset_manifest) !== EXPECTED_HASHES.dataset_manifest
      || existing.runner_source_hash !== sourceHash) {
      throw new Error("RESEARCH_INVALID: existing HY-R5.5 pre-performance freeze does not match frozen inputs");
    }
    return { manifest: existing, hash: sha256Json(existing) };
  }
  const manifest: JsonRecord = {
    research: "HY-R5.5 FROZEN CROWDING INFORMATION GAIN",
    version: R55_FROZEN_EVALUATION_SPEC.version,
    created_at: new Date().toISOString(),
    immutable: true,
    historical_range: { start: EVALUATION_START_ISO, end: EVALUATION_END_ISO },
    formal_event_end_exclusive: iso(FORMAL_EVENT_END_EXCLUSIVE),
    universe,
    universe_count: universe.length,
    frozen_artifact_paths: {
      coverage_matrix: COVERAGE_MATRIX_PATH,
      schema_manifest: SCHEMA_MANIFEST_PATH,
      feature_specification: FEATURE_SPECIFICATION_PATH,
      dataset_manifest: DATASET_MANIFEST_PATH,
    },
    frozen_artifact_hashes: EXPECTED_HASHES,
    artifact_hash_method: "SHA-256 of canonical stable JSON with recursively sorted object keys",
    frozen_dataset_contract: {
      expected_observations: inputs.foundation.data.listing_adjusted_expected_observations,
      valid_positioning_observations: inputs.foundation.data.valid_positioning_observations,
      adjusted_coverage_percent: inputs.foundation.data.adjusted_coverage_percent,
      pit_safe: inputs.foundation.pit_safe,
      source_manifest_hash: EXPECTED_HASHES.dataset_manifest,
    },
    feature_specification_hash: EXPECTED_HASHES.feature_specification,
    c1_c4_specification_unchanged: true,
    evaluation_specification: R55_FROZEN_EVALUATION_SPEC,
    matched_control_policy: {
      fields: R55_FROZEN_EVALUATION_SPEC.control_match_fields,
      no_future_outcome_matching: true,
      controls_without_replacement_within_each_test: true,
      control_pool_excludes_all_crowding_event_timestamps: true,
      no_broad_market_match_field: true,
    },
    outcome_definitions: {
      reference_price: "completed 15m candle close for crowding; first 15m candle open at or after funding time for descriptive Funding comparator",
      horizon_bars: OUTCOME_BARS,
      return: "future close / reference price - 1; directional return negates the raw return for BEARISH",
      mfe: "maximum future high/low favorable excursion from reference price across future 15m candles only",
      mae: "maximum future high/low adverse excursion from reference price across future 15m candles only",
      completeness: "all four horizons require contiguous future 15m candles through 24h",
      no_future_feature_values: true,
    },
    direction_policy: R55_FROZEN_EVALUATION_SPEC.crowding_direction,
    comparison_policy: {
      funding_only: "R4.1 frozen 30-day prior-only <=5% / >=95% funding detector, descriptive common-outcome alignment",
      oi_only: R55_FROZEN_EVALUATION_SPEC.c3_oi_only_definition,
      aggregate_market_context: "the matched non-event context control is the aggregate-context baseline; no separate context alpha is created",
      taker_ratio: "excluded from C1-C4 and not credited as crowding alpha",
    },
    statistical_policy: {
      seed: R55_FROZEN_EVALUATION_SPEC.fixed_random_seed,
      bootstrap_replicates: R55_FROZEN_EVALUATION_SPEC.bootstrap_replicates,
      permutation_replicates: R55_FROZEN_EVALUATION_SPEC.permutation_replicates,
      confidence_level: R55_FROZEN_EVALUATION_SPEC.confidence_level,
      primary_statistic: "paired precision difference: event success minus matched-control success",
      multiple_testing: R55_FROZEN_EVALUATION_SPEC.multiple_testing,
      primary_test_count: 40,
    },
    classification_policy: {
      robust: "at least 100 paired events, positive 1h and 4h precision lift with positive bootstrap lower bounds and Holm-adjusted p<=0.05, stable quarter/regime groups, and largest symbol share<=50%",
      conditional: "at least 30 paired events with positive predeclared effect and Holm-adjusted p<=0.20",
      otherwise: "NO_INCREMENTAL_INFORMATION",
    },
    experiment_count: 1,
    features_frozen_before_performance: "YES",
    post_result_tuning: "NO",
    outcome_metrics_not_yet_calculated: true,
    runner_source_paths: RUNNER_SOURCE_PATHS,
    runner_source_hash: sourceHash,
  };
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(FREEZE_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const reloaded = await loadJson<JsonRecord>(FREEZE_MANIFEST_PATH);
  if (sha256Json(reloaded) !== sha256Json(manifest)) throw new Error("RESEARCH_INVALID: freeze manifest write was not deterministic");
  return { manifest: reloaded, hash: sha256Json(reloaded) };
}

function buildCandleArrays(candlesInput: Candle[]): CandleArrays {
  const candles = [...candlesInput].sort((left, right) => left.openTime - right.openTime);
  if (candles.length === 0) throw new Error("RESEARCH_INVALID: empty 15m price history");
  const priorContiguous = new Uint32Array(candles.length);
  const futureContiguous = new Uint32Array(candles.length);
  const logSquaredPrefix = new Float64Array(candles.length + 1);
  const quoteVolumePrefix = new Float64Array(candles.length + 1);
  priorContiguous[0] = 1;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]!;
    if (![candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.closeTime].every(Number.isFinite)
      || candle.close <= 0 || candle.open <= 0 || candle.high <= 0 || candle.low <= 0) {
      throw new Error(`RESEARCH_INVALID: malformed price candle at index ${index}`);
    }
    const quoteVolume = finiteNumber(candle.quoteVolume);
    if (quoteVolume === null || quoteVolume < 0) throw new Error("RESEARCH_INVALID: missing quote volume in frozen price dataset");
    const previous = candles[index - 1];
    priorContiguous[index] = index > 0 && previous && candle.openTime - previous.openTime === FIFTEEN_MINUTES_MS
      ? (priorContiguous[index - 1] ?? 1) + 1
      : 1;
    const logReturn = previous && previous.close > 0 ? Math.log(candle.close / previous.close) : 0;
    logSquaredPrefix[index + 1] = logSquaredPrefix[index]! + logReturn ** 2;
    quoteVolumePrefix[index + 1] = quoteVolumePrefix[index]! + quoteVolume;
  }
  futureContiguous[candles.length - 1] = 1;
  for (let index = candles.length - 2; index >= 0; index -= 1) {
    const current = candles[index]!;
    const next = candles[index + 1]!;
    futureContiguous[index] = next.openTime - current.openTime === FIFTEEN_MINUTES_MS
      ? (futureContiguous[index + 1] ?? 1) + 1
      : 1;
  }
  return { candles, priorContiguous, futureContiguous, logSquaredPrefix, quoteVolumePrefix };
}

function lowerBoundPit(candles: Candle[], pitAvailableAt: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const boundary = candles[middle]!.closeTime + 1;
    if (boundary >= pitAvailableAt) high = middle;
    else low = middle + 1;
  }
  return low;
}

function lowerBoundOpenTime(candles: Candle[], time: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle]!.openTime >= time) high = middle;
    else low = middle + 1;
  }
  return low;
}

function contextAt(arrays: CandleArrays, candleIndex: number): MarketContext | null {
  if ((arrays.priorContiguous[candleIndex] ?? 0) < BASELINE_BUCKETS + 1) return null;
  const current = arrays.candles[candleIndex];
  const dayReference = arrays.candles[candleIndex - 96];
  const weekReference = arrays.candles[candleIndex - BASELINE_BUCKETS];
  if (!current || !dayReference || !weekReference || dayReference.close <= 0 || weekReference.close <= 0) return null;
  const return24h = current.close / dayReference.close - 1;
  const return7d = current.close / weekReference.close - 1;
  const realizedVolatility24h = Math.sqrt(
    arrays.logSquaredPrefix[candleIndex + 1]! - arrays.logSquaredPrefix[candleIndex - 95]!,
  );
  const quoteVolume24h = arrays.quoteVolumePrefix[candleIndex + 1]! - arrays.quoteVolumePrefix[candleIndex - 95]!;
  const marketRegime: MarketRegime = return24h >= 0.01 && return7d >= 0.02
    ? "UP"
    : return24h <= -0.01 && return7d <= -0.02
      ? "DOWN"
      : "RANGE";
  const volatilityBucket: VolatilityBucket = realizedVolatility24h < 0.02
    ? "LOW"
    : realizedVolatility24h < 0.05
      ? "MEDIUM"
      : "HIGH";
  const liquidityBucket: LiquidityBucket = quoteVolume24h < 1_000_000
    ? "LOW"
    : quoteVolume24h < 10_000_000
      ? "MEDIUM"
      : "HIGH";
  return { marketRegime, volatilityBucket, liquidityBucket, return24h, return7d, realizedVolatility24h, quoteVolume24h };
}

function parseCompactRow(line: string, symbol: string): CompactRow {
  const value = JSON.parse(line) as JsonRecord;
  const feature = value.feature_eligibility;
  if (typeof value.symbol !== "string" || value.symbol !== symbol || !isRecord(feature)) {
    throw new Error(`RESEARCH_INVALID: malformed compact row for ${symbol}`);
  }
  const timestamp = finiteNumber(value.timestamp);
  const pitAvailableAt = finiteNumber(value.pit_available_at);
  const requiredNumbers = [
    value.top_trader_position_ratio,
    value.top_trader_account_ratio,
    value.global_account_ratio,
    value.open_interest,
    value.open_interest_value,
    value.top_vs_global_divergence,
  ].map(finiteNumber);
  if (timestamp === null || pitAvailableAt === null || typeof value.lifecycle_id !== "string"
    || requiredNumbers.some((number) => number === null)
    || ![feature.c1, feature.c2, feature.c3, feature.c4].every((flag) => typeof flag === "boolean")) {
    throw new Error(`RESEARCH_INVALID: incomplete compact row for ${symbol}`);
  }
  const percentile = (field: string): number | null => {
    const raw = value[field];
    return raw === null ? null : finiteNumber(raw);
  };
  const booleanOrNull = (field: string): boolean | null => {
    const raw = value[field];
    return raw === null ? null : typeof raw === "boolean" ? raw : null;
  };
  const oiChange = value.oi_change === null ? null : finiteNumber(value.oi_change);
  if (value.oi_change !== null && oiChange === null) throw new Error(`RESEARCH_INVALID: malformed OI change for ${symbol}`);
  return {
    symbol,
    timestamp,
    pit_available_at: pitAvailableAt,
    lifecycle_id: value.lifecycle_id,
    top_trader_position_ratio: requiredNumbers[0]!,
    top_trader_account_ratio: requiredNumbers[1]!,
    global_account_ratio: requiredNumbers[2]!,
    open_interest: requiredNumbers[3]!,
    open_interest_value: requiredNumbers[4]!,
    top_trader_position_percentile: percentile("top_trader_position_percentile"),
    top_trader_account_percentile: percentile("top_trader_account_percentile"),
    global_account_percentile: percentile("global_account_percentile"),
    top_vs_global_divergence: requiredNumbers[5]!,
    oi_change: oiChange,
    c1_absolute_crowding: booleanOrNull("c1_absolute_crowding"),
    c2_crowding_divergence: booleanOrNull("c2_crowding_divergence"),
    c3_oi_crowding_buildup: booleanOrNull("c3_oi_crowding_buildup"),
    c4_crowding_unwind: booleanOrNull("c4_crowding_unwind"),
    feature_eligibility: {
      c1: feature.c1 as boolean,
      c2: feature.c2 as boolean,
      c3: feature.c3 as boolean,
      c4: feature.c4 as boolean,
    },
  };
}

async function readCompactRowsForSymbol(
  symbol: string,
  artifact: CompactArtifact,
  arrays: CandleArrays,
): Promise<Map<number, CompactRow>> {
  const path = resolve(artifact.relative_path);
  const stream = createReadStream(path);
  const hash = createHash("sha256");
  stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const selected = new Map<number, CompactRow>();
  let rowCount = 0;
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    rowCount += 1;
    const row = parseCompactRow(line, symbol);
    if (row.pit_available_at !== row.timestamp + FIVE_MINUTES_MS) {
      throw new Error(`RESEARCH_INVALID: PIT availability changed for ${symbol}`);
    }
    const candleIndex = lowerBoundPit(arrays.candles, row.pit_available_at);
    const candle = arrays.candles[candleIndex];
    if (!candle) continue;
    if (row.timestamp < candle.openTime || row.timestamp >= candle.openTime + FIFTEEN_MINUTES_MS) continue;
    const existing = selected.get(candleIndex);
    if (!existing || row.timestamp > existing.timestamp) selected.set(candleIndex, row);
  }
  const actualHash = hash.digest("hex");
  if (rowCount !== artifact.rows || actualHash !== artifact.sha256) {
    throw new Error(`RESEARCH_INVALID: compact artifact changed for ${symbol}`);
  }
  return selected;
}

function buildAnalysisPoints(
  symbol: string,
  selected: Map<number, CompactRow>,
  arrays: CandleArrays,
): AnalysisPoint[] {
  const points: AnalysisPoint[] = [];
  const ordered = [...selected.entries()].sort(([left], [right]) => left - right);
  let previousSelected: { candleIndex: number; lifecycleId: string; c1Side: CrowdingDirection | null } | null = null;
  for (const [candleIndex, row] of ordered) {
    const candle = arrays.candles[candleIndex];
    if (!candle) continue;
    const c1Side = classifyC1Direction({
      topTraderPositionPercentile: row.top_trader_position_percentile,
      topTraderAccountPercentile: row.top_trader_account_percentile,
      globalAccountPercentile: row.global_account_percentile,
    });
    const c4Side = previousSelected
      && previousSelected.candleIndex === candleIndex - 1
      && previousSelected.lifecycleId === row.lifecycle_id
      ? previousSelected.c1Side
      : null;
    previousSelected = { candleIndex, lifecycleId: row.lifecycle_id, c1Side };
    const decisionTime = candle.closeTime + 1;
    const context = contextAt(arrays, candleIndex);
    if (decisionTime < EVALUATION_START || decisionTime >= FORMAL_EVENT_END_EXCLUSIVE || context === null) continue;
    if ((arrays.futureContiguous[candleIndex] ?? 0) < OUTCOME_BARS["24h"] + 1) continue;
    const c1 = row.c1_absolute_crowding === true;
    const c2 = row.c2_crowding_divergence === true;
    const c3 = row.c3_oi_crowding_buildup === true;
    const c4 = row.c4_crowding_unwind === true;
    const featureEligible = row.feature_eligibility;
    const point: AnalysisPoint = {
      time: decisionTime,
      matchKey: crowdingMatchKey({
        symbol,
        time: decisionTime,
        marketRegime: context.marketRegime,
        volatilityBucket: context.volatilityBucket,
        liquidityBucket: context.liquidityBucket,
      }),
      symbol,
      month: monthKey(decisionTime),
      quarter: quarterKey(decisionTime),
      marketRegime: context.marketRegime,
      volatilityBucket: context.volatilityBucket,
      liquidityBucket: context.liquidityBucket,
      candleIndex,
      referencePrice: candle.close,
      lifecycleId: row.lifecycle_id,
      topVsGlobalDivergence: row.top_vs_global_divergence,
      featureEligible,
      c1AbsoluteCrowding: c1,
      c2CrowdingDivergence: c2,
      c3OiCrowdingBuildup: c3,
      c4CrowdingUnwind: c4,
      c1Side,
      c4Side,
      oiChange: row.oi_change,
      anyEvent: c1 || c2 || c3 || c4,
      allFeatureEligible: featureEligible.c1 && featureEligible.c2 && featureEligible.c3 && featureEligible.c4,
    };
    points.push(point);
  }
  return points;
}

function eventForFamily(point: AnalysisPoint, family: CrowdingFamily): boolean {
  if (family === "C1") return point.featureEligible.c1 && point.c1AbsoluteCrowding;
  if (family === "C2") return point.featureEligible.c2 && point.c2CrowdingDivergence;
  if (family === "C3") return point.featureEligible.c3 && point.c3OiCrowdingBuildup;
  return point.featureEligible.c4 && point.c4CrowdingUnwind;
}

function directionForFamily(point: AnalysisPoint, family: CrowdingFamily): CrowdingDirection | null {
  if (family === "C1" || family === "C3") return point.c1Side;
  if (family === "C2") return classifyC2Direction(point.topVsGlobalDivergence);
  return point.c4Side;
}

function outcomeFor(
  point: BasePoint,
  direction: CrowdingDirection,
  arrays: CandleArrays,
  cache: Map<string, OutcomeBundle | null>,
): OutcomeBundle | null {
  const cacheKey = `${point.candleIndex}|${point.referencePrice}|${direction}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  if ((arrays.futureContiguous[point.candleIndex] ?? 0) < OUTCOME_BARS["24h"] + 1 || point.referencePrice <= 0) {
    cache.set(cacheKey, null);
    return null;
  }
  const outcomes = {} as OutcomeBundle;
  let maximumHigh = Number.NEGATIVE_INFINITY;
  let minimumLow = Number.POSITIVE_INFINITY;
  let realizedVariance = 0;
  for (let offset = 1; offset <= OUTCOME_BARS["24h"]; offset += 1) {
    const previous = arrays.candles[point.candleIndex + offset - 1];
    const current = arrays.candles[point.candleIndex + offset];
    if (!previous || !current || current.openTime - previous.openTime !== FIFTEEN_MINUTES_MS) {
      cache.set(cacheKey, null);
      return null;
    }
    maximumHigh = Math.max(maximumHigh, current.high);
    minimumLow = Math.min(minimumLow, current.low);
    if (previous.close > 0 && current.close > 0) realizedVariance += Math.log(current.close / previous.close) ** 2;
    if ((Object.values(OUTCOME_BARS) as number[]).includes(offset)) {
      const horizon = (R55_HORIZONS as readonly CrowdingHorizon[]).find((name) => OUTCOME_BARS[name] === offset);
      if (!horizon) continue;
      const futurePrice = current.close;
      const rawReturn = futurePrice / point.referencePrice - 1;
      const favorableMove = direction === "BULLISH"
        ? maximumHigh / point.referencePrice - 1
        : 1 - minimumLow / point.referencePrice;
      const adverseMove = direction === "BULLISH"
        ? 1 - minimumLow / point.referencePrice
        : maximumHigh / point.referencePrice - 1;
      outcomes[horizon] = {
        futurePrice,
        rawReturn,
        directionalReturn: direction === "BULLISH" ? rawReturn : -rawReturn,
        maxFavorableMove: Math.max(0, favorableMove),
        maxAdverseMove: Math.max(0, adverseMove),
        realizedVolatility: Math.sqrt(realizedVariance),
      };
    }
  }
  cache.set(cacheKey, outcomes);
  return outcomes;
}

class MetricAccumulator {
  public readonly precisionDifferences: number[] = [];
  private readonly eventReturns: number[] = [];
  private readonly eventMfe: number[] = [];
  private readonly eventMae: number[] = [];
  private readonly quarterGroups = new Map<string, GroupAccumulator>();
  private readonly regimeGroups = new Map<string, GroupAccumulator>();
  private readonly symbolCounts = new Map<string, number>();
  private readonly matchDistances: number[] = [];
  private eventSuccessCount = 0;
  private controlSuccessCount = 0;
  public eventCount = 0;
  public pairCount = 0;

  public constructor(
    public readonly testId: string,
    public readonly family: string,
    public readonly direction: CrowdingDirection,
    public readonly horizon: CrowdingHorizon,
  ) {}

  public recordPopulation(points: BasePoint[]): void {
    this.eventCount += points.length;
    for (const point of points) {
      this.symbolCounts.set(point.symbol, (this.symbolCounts.get(point.symbol) ?? 0) + 1);
    }
  }

  public addPair(
    event: BasePoint,
    control: BasePoint,
    eventOutcome: HorizonOutcome,
    controlOutcome: HorizonOutcome,
    distanceMs: number,
  ): void {
    const eventSuccess = eventOutcome.directionalReturn > 0;
    const controlSuccess = controlOutcome.directionalReturn > 0;
    this.eventSuccessCount += eventSuccess ? 1 : 0;
    this.controlSuccessCount += controlSuccess ? 1 : 0;
    this.precisionDifferences.push((eventSuccess ? 1 : 0) - (controlSuccess ? 1 : 0));
    this.eventReturns.push(eventOutcome.directionalReturn);
    this.eventMfe.push(eventOutcome.maxFavorableMove);
    this.eventMae.push(eventOutcome.maxAdverseMove);
    this.matchDistances.push(distanceMs);
    this.pairCount += 1;
    for (const [groups, key] of [[this.quarterGroups, event.quarter], [this.regimeGroups, event.marketRegime]] as const) {
      const current = groups.get(key) ?? { n: 0, sum: 0 };
      current.n += 1;
      current.sum += (eventSuccess ? 1 : 0) - (controlSuccess ? 1 : 0);
      groups.set(key, current);
    }
  }

  private stability(groups: Map<string, GroupAccumulator>): JsonRecord {
    const values = [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([group, value]) => ({ group, n: value.n, incremental_lift: round(value.sum / value.n), positive: value.sum / value.n > 0 }));
    const eligible = values.filter((value) => value.n >= 30);
    const positive = eligible.filter((value) => value.positive).length;
    return {
      groups: values,
      eligible_group_count: eligible.length,
      positive_group_count: positive,
      positive_group_fraction: eligible.length === 0 ? null : round(positive / eligible.length, 6),
      stable: eligible.length >= R55_FROZEN_EVALUATION_SPEC.robust_gate.minimum_stability_groups
        && positive / eligible.length >= R55_FROZEN_EVALUATION_SPEC.robust_gate.minimum_positive_group_fraction,
    };
  }

  private concentration(): JsonRecord {
    const ordered = [...this.symbolCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const [largestSymbol, largestCount] = ordered[0] ?? ["NONE", 0];
    return {
      total_events: this.eventCount,
      unique_symbols: this.symbolCounts.size,
      largest_symbol: largestSymbol,
      largest_symbol_count: largestCount,
      largest_symbol_share: this.eventCount === 0 ? null : round(largestCount / this.eventCount, 6),
      by_symbol: Object.fromEntries(ordered),
    };
  }

  public toJson(inference: ReturnType<typeof binaryPairedInference> | null, adjustedPValue: number | null): JsonRecord {
    const coverage = this.eventCount === 0 ? null : this.pairCount / this.eventCount * 100;
    const ciWidth = inference?.ci95 === null || inference?.ci95 === undefined
      ? null
      : inference.ci95.upper - inference.ci95.lower;
    return {
      test_id: this.testId,
      family: this.family,
      direction: this.direction,
      horizon: this.horizon,
      event_count: this.eventCount,
      matched_control_count: this.pairCount,
      unmatched_event_count: Math.max(0, this.eventCount - this.pairCount),
      matching_coverage_percent: round(coverage, 6),
      signal_precision: this.pairCount === 0 ? null : round(this.eventSuccessCount / this.pairCount, 8),
      control_precision: this.pairCount === 0 ? null : round(this.controlSuccessCount / this.pairCount, 8),
      incremental_lift: round(inference?.observed ?? (this.pairCount === 0 ? null : this.precisionDifferences.reduce((sum, value) => sum + value, 0) / this.pairCount)),
      average_directional_return: round(summarizeNumeric(this.eventReturns).mean),
      median_directional_return: round(summarizeNumeric(this.eventReturns).median),
      max_favorable_move: round(summarizeNumeric(this.eventMfe).max),
      median_max_favorable_move: round(summarizeNumeric(this.eventMfe).median),
      average_max_favorable_move: round(summarizeNumeric(this.eventMfe).mean),
      max_adverse_move: round(summarizeNumeric(this.eventMae).max),
      median_max_adverse_move: round(summarizeNumeric(this.eventMae).median),
      average_max_adverse_move: round(summarizeNumeric(this.eventMae).mean),
      directional_return_summary: summarizeValues(this.eventReturns),
      favorable_move_summary: summarizeValues(this.eventMfe),
      adverse_move_summary: summarizeValues(this.eventMae),
      confidence_interval_95: inference?.ci95 === null ? null : inference?.ci95 ?? null,
      ci_width: round(ciWidth),
      p_value: inference?.pValue ?? null,
      holm_adjusted_p_value: adjustedPValue,
      effect_size: inference?.effectSize ?? null,
      bootstrap_replicates: inference?.bootstrapReplicates ?? 0,
      permutation_replicates: inference?.permutationReplicates ?? 0,
      match_distance: summarizeDistances(this.matchDistances),
      stability: {
        quarter: this.stability(this.quarterGroups),
        regime: this.stability(this.regimeGroups),
      },
      symbol_concentration: this.concentration(),
    };
  }
}

function createMetricAccumulators(prefix: string, family: string): ComparisonAccumulatorSet {
  const byDirection = {} as Record<CrowdingDirection, Record<CrowdingHorizon, MetricAccumulator>>;
  for (const direction of R55_DIRECTIONS) {
    byDirection[direction] = {} as Record<CrowdingHorizon, MetricAccumulator>;
    for (const horizon of R55_HORIZONS) {
      byDirection[direction][horizon] = new MetricAccumulator(`${prefix}:${direction}:${horizon}`, family, direction, horizon);
    }
  }
  return { byDirection };
}

function addPairToAccumulator(
  accumulator: MetricAccumulator,
  event: BasePoint,
  control: BasePoint,
  eventBundle: OutcomeBundle | null,
  controlBundle: OutcomeBundle | null,
  horizon: CrowdingHorizon,
  distanceMs: number,
): void {
  const eventOutcome = eventBundle?.[horizon];
  const controlOutcome = controlBundle?.[horizon];
  if (!eventOutcome || !controlOutcome) return;
  accumulator.addPair(event, control, eventOutcome, controlOutcome, distanceMs);
}

function processCrowdingSymbol(
  points: AnalysisPoint[],
  arrays: CandleArrays,
  families: Record<CrowdingFamily, FamilySummary>,
  primary: Record<CrowdingFamily, ComparisonAccumulatorSet>,
  c3OiIncremental: ComparisonAccumulatorSet,
  c3OiOnly: ComparisonAccumulatorSet,
  counters: DataCounters,
): void {
  const controlPool = points.filter((point) => point.allFeatureEligible && !point.anyEvent);
  counters.controlSlots += controlPool.length;
  const outcomeCache = new Map<string, OutcomeBundle | null>();
  for (const family of R55_CROWDING_FAMILIES) {
    const events = points.filter((point) => eventForFamily(point, family));
    const totalMatch = matchNearestWithoutReplacement(events, controlPool);
    addMatchSummary(families[family].total, events.length, totalMatch.pairs);
    for (const direction of R55_DIRECTIONS) {
      const directionalEvents = events.filter((point) => {
        return directionForFamily(point, family) === direction;
      });
      for (const horizon of R55_HORIZONS) {
        accumulatorFor(primary[family], direction, horizon).recordPopulation(directionalEvents);
      }
      const match = matchNearestWithoutReplacement(directionalEvents, controlPool);
      addMatchSummary(families[family].byDirection[direction], directionalEvents.length, match.pairs);
      for (const pair of match.pairs) {
        const eventBundle = outcomeFor(pair.event, direction, arrays, outcomeCache);
        const controlBundle = outcomeFor(pair.control, direction, arrays, outcomeCache);
        for (const horizon of R55_HORIZONS) {
          addPairToAccumulator(accumulatorFor(primary[family], direction, horizon), pair.event, pair.control, eventBundle, controlBundle, horizon, pair.distanceMs);
        }
      }
    }
    if (family === "C3") {
      const oiOnly = points.filter((point) => point.allFeatureEligible
        && point.oiChange !== null
        && point.oiChange > 0
        && !point.c1AbsoluteCrowding
        && !point.anyEvent);
      for (const direction of R55_DIRECTIONS) {
        const c3Events = events.filter((point) => point.c1Side === direction);
        const direct = matchNearestWithoutReplacement(c3Events, oiOnly);
        for (const horizon of R55_HORIZONS) {
          accumulatorFor(c3OiIncremental, direction, horizon).recordPopulation(c3Events);
        }
        for (const pair of direct.pairs) {
          const eventBundle = outcomeFor(pair.event, direction, arrays, outcomeCache);
          const oiBundle = outcomeFor(pair.control, direction, arrays, outcomeCache);
          for (const horizon of R55_HORIZONS) {
            addPairToAccumulator(accumulatorFor(c3OiIncremental, direction, horizon), pair.event, pair.control, eventBundle, oiBundle, horizon, pair.distanceMs);
          }
        }
        const selectedOi = direct.pairs.map((pair) => pair.control);
        const selectedOiTimes = new Set(selectedOi.map((point) => point.time));
        const oiControls = controlPool.filter((point) => !selectedOiTimes.has(point.time));
        const oiControlMatch = matchNearestWithoutReplacement(selectedOi, oiControls);
        for (const horizon of R55_HORIZONS) {
          accumulatorFor(c3OiOnly, direction, horizon).recordPopulation(selectedOi);
        }
        for (const pair of oiControlMatch.pairs) {
          const oiBundle = outcomeFor(pair.event, direction, arrays, outcomeCache);
          const controlBundle = outcomeFor(pair.control, direction, arrays, outcomeCache);
          for (const horizon of R55_HORIZONS) {
            addPairToAccumulator(accumulatorFor(c3OiOnly, direction, horizon), pair.event, pair.control, oiBundle, controlBundle, horizon, pair.distanceMs);
          }
        }
      }
    }
  }
}
function accumulatorFor(set: ComparisonAccumulatorSet, direction: CrowdingDirection, horizon: CrowdingHorizon): MetricAccumulator {
  return set.byDirection[direction][horizon];
}

function buildFundingEvents(dataset: HistoricalDataset, arrays: CandleArrays): FundingPoint[] {
  const fundingPoints = dataset.fundingRates
    .filter((point) => finiteNumber(point.fundingTime) !== null && finiteNumber(point.fundingRate) !== null)
    .sort((left, right) => left.fundingTime - right.fundingTime);
  const events: FundingPoint[] = [];
  let windowStart = 0;
  for (let index = 0; index < fundingPoints.length; index += 1) {
    const point = fundingPoints[index]!;
    while (windowStart < index && fundingPoints[windowStart]!.fundingTime < point.fundingTime - FUNDING_WINDOW_MS) windowStart += 1;
    if (point.fundingTime < EVALUATION_START || point.fundingTime >= EVALUATION_END_EXCLUSIVE) continue;
    const prior = fundingPoints.slice(windowStart, index);
    if (prior.length < FUNDING_MIN_PRIOR_POINTS) continue;
    const percentile = prior.filter((candidate) => candidate.fundingRate <= point.fundingRate) .length / prior.length;
    const direction: CrowdingDirection | null = percentile <= FUNDING_LOW_PERCENTILE
      ? "BULLISH"
      : percentile >= FUNDING_HIGH_PERCENTILE
        ? "BEARISH"
        : null;
    if (direction === null) continue;
    const candleIndex = lowerBoundOpenTime(arrays.candles, point.fundingTime);
    const candle = arrays.candles[candleIndex];
    const context = contextAt(arrays, candleIndex);
    if (!candle || context === null || candleIndex >= arrays.candles.length || (arrays.futureContiguous[candleIndex] ?? 0) < OUTCOME_BARS["24h"] + 1) continue;
    const eventTime = candle.openTime;
    events.push({
      time: eventTime,
      matchKey: crowdingMatchKey({
        symbol: dataset.symbol,
        time: eventTime,
        marketRegime: context.marketRegime,
        volatilityBucket: context.volatilityBucket,
        liquidityBucket: context.liquidityBucket,
      }),
      symbol: dataset.symbol,
      month: monthKey(eventTime),
      quarter: quarterKey(eventTime),
      marketRegime: context.marketRegime,
      volatilityBucket: context.volatilityBucket,
      liquidityBucket: context.liquidityBucket,
      candleIndex,
      referencePrice: candle.open,
      direction,
      fundingRate: point.fundingRate,
      historicalPercentile: percentile,
    });
  }
  return events;
}

function processFundingSymbol(
  events: FundingPoint[],
  controlPool: AnalysisPoint[],
  arrays: CandleArrays,
  fundingAccumulators: ComparisonAccumulatorSet,
  fundingCounts: { events: number; matched: number },
): void {
  const eventTimes = new Set(events.map((event) => event.time));
  const controls = controlPool.filter((point) => !eventTimes.has(point.time));
  const outcomeCache = new Map<string, OutcomeBundle | null>();
  for (const direction of R55_DIRECTIONS) {
    const directionalEvents = events.filter((event) => event.direction === direction);
    for (const horizon of R55_HORIZONS) {
      const accumulator = fundingAccumulators.byDirection[direction][horizon];
      accumulator.recordPopulation(directionalEvents);
    }
    const match = matchNearestWithoutReplacement(directionalEvents, controls);
    fundingCounts.events += directionalEvents.length;
    fundingCounts.matched += match.pairs.length;
    for (const pair of match.pairs) {
      const eventBundle = outcomeFor(pair.event, direction, arrays, outcomeCache);
      const controlBundle = outcomeFor(pair.control, direction, arrays, outcomeCache);
      for (const horizon of R55_HORIZONS) {
        addPairToAccumulator(fundingAccumulators.byDirection[direction][horizon], pair.event, pair.control, eventBundle, controlBundle, horizon, pair.distanceMs);
      }
    }
  }
}

function familyToJson(
  families: Record<CrowdingFamily, FamilySummary>,
  primary: Record<CrowdingFamily, ComparisonAccumulatorSet>,
  primaryResults: Map<string, JsonRecord>,
): JsonRecord {
  const output: JsonRecord = {};
  for (const family of R55_CROWDING_FAMILIES) {
    const value = families[family];
    const byDirection: JsonRecord = {};
    for (const direction of R55_DIRECTIONS) {
      const metrics: JsonRecord = {};
      for (const horizon of R55_HORIZONS) {
        metrics[horizon] = primaryResults.get(primary[family].byDirection[direction][horizon].testId) ?? {};
      }
      byDirection[direction.toLowerCase()] = {
        population: summarizeMatchPopulation(value.byDirection[direction]),
        by_horizon: metrics,
      };
    }
    output[family] = {
      population: {
        total: summarizeMatchPopulation(value.total),
        by_direction: byDirection,
      },
      definition: family === "C1"
        ? "ABSOLUTE_CROWDING"
        : family === "C2"
          ? "CROWDING_DIVERGENCE"
          : family === "C3"
            ? "OI_CROWDING_BUILDUP"
            : "CROWDING_UNWIND",
    };
  }
  return output;
}

function comparisonToJson(
  set: ComparisonAccumulatorSet,
  results: Map<string, JsonRecord>,
): JsonRecord {
  const output: JsonRecord = {};
  for (const direction of R55_DIRECTIONS) {
    output[direction.toLowerCase()] = Object.fromEntries(R55_HORIZONS.map((horizon) => [
      horizon,
      results.get(set.byDirection[direction][horizon].testId) ?? {},
    ]));
  }
  return output;
}

function primaryClassification(
  metrics: JsonRecord[],
): { classification: "ROBUST_INCREMENTAL_INFORMATION" | "CONDITIONAL_INFORMATION_ONLY" | "NO_INCREMENTAL_INFORMATION"; best: string; candidates: JsonRecord[] } {
  const byPair = new Map<string, JsonRecord[]>();
  for (const metric of metrics) {
    if (metric.family === "C3_OI_INCREMENTAL") continue;
    const key = `${String(metric.family)}:${String(metric.direction)}`;
    const list = byPair.get(key) ?? [];
    list.push(metric);
    byPair.set(key, list);
  }
  const robustCandidates: JsonRecord[] = [];
  const conditionalCandidates: JsonRecord[] = [];
  for (const [key, values] of byPair) {
    const primary = values.filter((value) => value.horizon === "1h" || value.horizon === "4h");
    const positivePrimary = primary.filter((value) => Number(value.incremental_lift) > 0
      && Number((value.confidence_interval_95 as JsonRecord | null)?.lower) > 0
      && Number(value.holm_adjusted_p_value) <= 0.05
      && (value.stability as JsonRecord).quarter !== undefined
      && ((value.stability as JsonRecord).quarter as JsonRecord).stable === true
      && ((value.stability as JsonRecord).regime as JsonRecord).stable === true
      && Number(((value.symbol_concentration as JsonRecord).largest_symbol_share ?? 1)) <= 0.5);
    for (const value of positivePrimary) {
      if (positivePrimary.length >= R55_FROZEN_EVALUATION_SPEC.robust_gate.minimum_positive_primary_horizon_count
        && Number(value.matched_control_count) >= R55_FROZEN_EVALUATION_SPEC.robust_gate.minimum_events) {
        robustCandidates.push({ ...value, candidate_key: key });
      }
    }
    for (const value of values) {
      if (Number(value.incremental_lift) > 0
        && Number(value.matched_control_count) >= R55_FROZEN_EVALUATION_SPEC.conditional_gate.minimum_events
        && Number(value.holm_adjusted_p_value) <= R55_FROZEN_EVALUATION_SPEC.conditional_gate.adjusted_p_value) {
        conditionalCandidates.push({ ...value, candidate_key: key });
      }
    }
  }
  if (robustCandidates.length > 0) {
    robustCandidates.sort((left, right) => Number(right.incremental_lift) - Number(left.incremental_lift));
    return { classification: "ROBUST_INCREMENTAL_INFORMATION", best: String(robustCandidates[0]!.test_id), candidates: robustCandidates };
  }
  if (conditionalCandidates.length > 0) {
    conditionalCandidates.sort((left, right) => Number(right.incremental_lift) - Number(left.incremental_lift));
    return { classification: "CONDITIONAL_INFORMATION_ONLY", best: String(conditionalCandidates[0]!.test_id), candidates: conditionalCandidates };
  }
  return { classification: "NO_INCREMENTAL_INFORMATION", best: "NONE", candidates: [] };
}

function safetyBoundary(): JsonRecord {
  return {
    production_modified: false,
    supabase_production_modified: false,
    vercel_modified: false,
    paper_strategy_modified: false,
    scanner_modified: false,
    emails_sent: 0,
    private_binance_api_called: false,
    orders_sent: false,
    position_management_used: false,
    auto_trading: false,
    commit_created: false,
  };
}

function metricRows(results: Map<string, JsonRecord>): JsonRecord[] {
  return [...results.values()].sort((left, right) => String(left.test_id).localeCompare(String(right.test_id)));
}

function buildMarkdown(report: JsonRecord): string {
  const data = report.data as JsonRecord;
  const governance = report.governance as JsonRecord;
  const frozen = report.frozen_inputs as JsonRecord;
  const families = report.crowding_families as JsonRecord;
  const statistics = report.statistics as JsonRecord;
  const conclusion = report.conclusion as JsonRecord;
  const lines = [
    "# HY-R5.5 Frozen Crowding Information Gain",
    "",
    `- Classification: **${String(report.classification)}**`,
    `- Historical range: ${String(data.historical_range_start)} -> ${String(data.historical_range_end)}`,
    `- Universe: ${String(data.universe_count)}/49`,
    `- Frozen R5.4B PIT coverage: ${String(data.frozen_adjusted_coverage_percent)}% (${String(data.frozen_valid_positioning_observations)}/${String(data.frozen_expected_observations)})`,
    `- Outcome-complete aligned 15m slots: ${String(data.outcome_complete_slots)}`,
    `- PIT-safe: **${String(report.pit_safe)}**`,
    `- Experiment count: **${String(governance.experiment_count)}**`,
    `- Features frozen before performance: **${String(governance.features_frozen_before_performance)}**`,
    `- Post-result tuning: **${String(governance.post_result_tuning)}**`,
    "",
    "## Frozen gate",
    "",
    `- Pre-performance freeze: ${String(frozen.freeze_manifest_path)}`,
    `- Pre-performance freeze hash: ${String(frozen.freeze_manifest_hash)}`,
    `- Coverage matrix SHA-256: ${String((frozen.artifact_hashes as JsonRecord).coverage_matrix)}`,
    `- Schema manifest SHA-256: ${String((frozen.artifact_hashes as JsonRecord).schema_manifest)}`,
    `- Feature specification SHA-256: ${String((frozen.artifact_hashes as JsonRecord).feature_specification)}`,
    `- Dataset manifest SHA-256: ${String((frozen.artifact_hashes as JsonRecord).dataset_manifest)}`,
    `- Runner/source hash: ${String(frozen.runner_source_hash)}`,
    "- Hash representation: canonical stable JSON with recursively sorted object keys.",
    "- C1-C4 specification and taker exclusion were checked before outcome calculation.",
    "",
    "## Data and PIT alignment",
    "",
    `- Compact rows read: ${String(data.compact_rows)}; compact artifact hashes verified: ${String(data.compact_artifacts_hash_verified)}`,
    `- Aligned 15m slots: ${String(data.aligned_15m_slots)}; formal outcome slots: ${String(data.outcome_complete_slots)}`,
    `- Outcome-complete cutoff: ${String(data.outcome_complete_cutoff)}`,
    "- One latest PIT-safe 5m row per completed 15m slot; no forward fill, interpolation, or shortened history.",
    "- Context uses only current/prior completed candles. Outcomes use only subsequent contiguous candles.",
    "",
    "## C1-C4 population and matched controls",
    "",
    "| Family | Total events | Total controls | Coverage |",
    "| --- | ---: | ---: | ---: |",
  ];
  for (const family of R55_CROWDING_FAMILIES) {
    const value = families[family] as JsonRecord;
    const total = ((value.population as JsonRecord).total as JsonRecord);
    lines.push(`| ${family} ${String(value.definition)} | ${String(total.event_count)} | ${String(total.matched_control_count)} | ${total.matching_coverage_percent === null ? "n/a" : `${String(round(Number(total.matching_coverage_percent), 2))}%`} |`);
  }
  lines.push(
    "",
    "## Directional precision-lift results",
    "",
    "The primary effect is signal precision minus matched-control precision. Returns and excursions are descriptive reminder-quality metrics, not PnL optimization.",
    "",
    "| Family | Direction | Horizon | Events | Controls | Coverage | Signal precision | Control precision | Lift | 95% CI | Holm p | Avg return | Median return | Avg MFE | Avg MAE |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const family of R55_CROWDING_FAMILIES) {
    const value = families[family] as JsonRecord;
    const byDirection = value.population as JsonRecord;
    for (const direction of R55_DIRECTIONS) {
      const directionValue = (byDirection.by_direction as JsonRecord)[direction.toLowerCase()] as JsonRecord;
      const metrics = directionValue.by_horizon as JsonRecord;
      for (const horizon of R55_HORIZONS) {
        const metric = metrics[horizon] as JsonRecord;
        const ci = metric.confidence_interval_95 as JsonRecord | null;
        lines.push(`| ${family} | ${direction} | ${horizon} | ${String(metric.event_count)} | ${String(metric.matched_control_count)} | ${metric.matching_coverage_percent === null ? "n/a" : `${String(round(Number(metric.matching_coverage_percent), 2))}%`} | ${String(metric.signal_precision ?? "n/a")} | ${String(metric.control_precision ?? "n/a")} | ${String(metric.incremental_lift ?? "n/a")} | ${ci ? `[${String(round(Number(ci.lower), 6))}, ${String(round(Number(ci.upper), 6))}]` : "n/a"} | ${String(metric.holm_adjusted_p_value ?? "n/a")} | ${String(metric.average_directional_return ?? "n/a")} | ${String(metric.median_directional_return ?? "n/a")} | ${String(metric.average_max_favorable_move ?? "n/a")} | ${String(metric.average_max_adverse_move ?? "n/a")} |`);
      }
    }
  }
  const oiComparison = report.c3_oi_comparison as JsonRecord;
  lines.push(
    "",
    "## C3 OI-only comparison",
    "",
    `- Definition: ${String(oiComparison.definition)}`,
    "- Full C3 is compared with matched non-event context controls; OI-only is compared with its own matched non-event controls; incremental C3-vs-OI is paired directly.",
    "",
    "| Direction | Horizon | C3 full lift | OI-only lift | C3 incremental vs OI |",
    "| --- | --- | ---: | ---: | ---: |",
  );
  const oiByDirection = oiComparison.by_direction as JsonRecord;
  for (const direction of R55_DIRECTIONS) {
    const value = oiByDirection[direction.toLowerCase()] as JsonRecord;
    const full = ((families.C3 as JsonRecord).population as JsonRecord).by_direction as JsonRecord;
    const fullMetric = ((full[direction.toLowerCase()] as JsonRecord).by_horizon as JsonRecord);
    const incremental = value.incremental_vs_oi as JsonRecord;
    const oiOnly = value.oi_only_vs_control as JsonRecord;
    for (const horizon of R55_HORIZONS) {
      lines.push(`| ${direction} | ${horizon} | ${String((fullMetric[horizon] as JsonRecord).incremental_lift ?? "n/a")} | ${String((oiOnly[horizon] as JsonRecord).incremental_lift ?? "n/a")} | ${String((incremental[horizon] as JsonRecord).incremental_lift ?? "n/a")} |`);
    }
  }
  const funding = report.comparison as JsonRecord;
  lines.push(
    "",
    "## Existing comparator context",
    "",
    `- Funding-only frozen detector events: ${String(funding.funding_only_event_count)}; matched events: ${String(funding.funding_only_matched_count)}.`,
    "- Aggregate market context is represented by the non-event matched-control baseline; it is not treated as a separate alpha signal.",
    `- Taker ratio used as crowding alpha: ${String(funding.taker_ratio_used_as_crowding)}`,
    "",
    "## Statistics, stability and conclusion",
    "",
    `- Primary tests: ${String(statistics.primary_test_count)}; Holm significant at 0.05: ${String(statistics.holm_significant_count)}; seed: ${String(statistics.seed)}; bootstrap/permutation: ${String(statistics.bootstrap_replicates)}/${String(statistics.permutation_replicates)}.`,
    `- Best robust/conditional candidate: ${String(conclusion.best_candidate)}`,
    `- Stable across quarters: ${String(conclusion.stable_across_quarters)}`,
    `- Stable across regimes: ${String(conclusion.stable_across_regimes)}`,
    `- Largest symbol concentration among reviewed primary metrics: ${String(conclusion.largest_symbol_concentration)}`,
    "- No result-driven percentile, direction, symbol, quarter, regime, or C5+ selection was performed.",
    "- No PnL, profit factor, Sharpe, account PnL, or trading optimization was used.",
    "",
    "## Safety boundary",
    "",
    "- Production, Supabase, Vercel, PAPER strategy, scanner, email, private Binance API, orders, position management: unchanged/not used.",
    "- AUTO_TRADING: **FALSE**",
    "",
    "STOP.",
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const inputs = await loadFrozenInputs();
  if (await exists(JSON_REPORT_PATH) && !(await exists(MARKDOWN_REPORT_PATH))) {
    const existingReport = await loadJson<JsonRecord>(JSON_REPORT_PATH);
    await writeFile(MARKDOWN_REPORT_PATH, buildMarkdown(existingReport), "utf8");
    console.log(JSON.stringify({ output: MARKDOWN_REPORT_PATH, performance_recomputed: false }, null, 2));
    return;
  }
  const sourceHash = await runnerSourceHash();
  const freeze = await createOrLoadFreezeManifest(inputs, sourceHash);
  const families = buildFamilySummaries();
  const primary = Object.fromEntries(R55_CROWDING_FAMILIES.map((family) => [family, createMetricAccumulators(`R55:${family}`, family)])) as Record<CrowdingFamily, ComparisonAccumulatorSet>;
  const c3OiIncremental = createMetricAccumulators("R55:C3:OI_INCREMENTAL", "C3_OI_INCREMENTAL");
  const c3OiOnly = createMetricAccumulators("R55:C3:OI_ONLY", "C3_OI_ONLY");
  const funding = createMetricAccumulators("R55:FUNDING_ONLY", "FUNDING_ONLY");
  const fundingCounts = { events: 0, matched: 0 };
  const counters: DataCounters = {
    compactRows: 0,
    compactHashVerified: 0,
    aligned15mSlots: 0,
    outcomeCompleteSlots: 0,
    allFeatureEligibleSlots: 0,
    controlSlots: 0,
    symbolsProcessed: 0,
    latestOutcomeCompleteDecisionTime: null,
  };
  for (const symbol of inputs.dataset.universe) {
    const dataset = await loadJson<HistoricalDataset>(resolve(DATA_DIRECTORY, `${symbol}.json`));
    if (dataset.symbol !== symbol || !Array.isArray(dataset.candles?.["15m"]) || !Array.isArray(dataset.fundingRates)) {
      throw new Error(`RESEARCH_INVALID: malformed frozen historical dataset ${symbol}`);
    }
    const arrays = buildCandleArrays(dataset.candles["15m"]);
    const artifact = inputs.dataset.compact_artifacts.find((entry) => entry.relative_path.endsWith(`/${symbol}.jsonl`) || entry.relative_path.endsWith(`\\${symbol}.jsonl`));
    if (!artifact) throw new Error(`RESEARCH_INVALID: missing compact artifact manifest entry for ${symbol}`);
    const selected = await readCompactRowsForSymbol(symbol, artifact, arrays);
    counters.compactRows += artifact.rows;
    counters.compactHashVerified += 1;
    counters.aligned15mSlots += selected.size;
    const points = buildAnalysisPoints(symbol, selected, arrays);
    counters.outcomeCompleteSlots += points.length;
    counters.allFeatureEligibleSlots += points.filter((point) => point.allFeatureEligible).length;
    const latest = points.at(-1)?.time ?? null;
    if (latest !== null && (counters.latestOutcomeCompleteDecisionTime === null || latest > counters.latestOutcomeCompleteDecisionTime)) counters.latestOutcomeCompleteDecisionTime = latest;
    processCrowdingSymbol(points, arrays, families, primary, c3OiIncremental, c3OiOnly, counters);
    const controlPool = points.filter((point) => point.allFeatureEligible && !point.anyEvent);
    const fundingEvents = buildFundingEvents(dataset, arrays);
    processFundingSymbol(fundingEvents, controlPool, arrays, funding, fundingCounts);
    counters.symbolsProcessed += 1;
    console.log(`HY-R5.5 ${symbol}: compact=${artifact.rows} aligned=${selected.size} outcomes=${points.length} funding=${fundingEvents.length}`);
  }
  const primaryAccumulators = [
    ...R55_CROWDING_FAMILIES.flatMap((family) => R55_DIRECTIONS.flatMap((direction) => R55_HORIZONS.map((horizon) => primary[family].byDirection[direction][horizon]))),
    ...R55_DIRECTIONS.flatMap((direction) => R55_HORIZONS.map((horizon) => c3OiIncremental.byDirection[direction][horizon])),
  ];
  const inferences = new Map<string, ReturnType<typeof binaryPairedInference>>();
  for (const accumulator of primaryAccumulators) {
    inferences.set(accumulator.testId, binaryPairedInference(
      accumulator.precisionDifferences,
      R55_FROZEN_EVALUATION_SPEC.fixed_random_seed,
      R55_FROZEN_EVALUATION_SPEC.bootstrap_replicates,
      R55_FROZEN_EVALUATION_SPEC.permutation_replicates,
    ));
  }
  const pValues = primaryAccumulators.map((accumulator) => ({
    id: accumulator.testId,
    pValue: inferences.get(accumulator.testId)?.pValue ?? null,
  }));
  const adjusted = holmAdjust(pValues);
  const primaryResults = new Map<string, JsonRecord>();
  const primaryMetricRows: JsonRecord[] = [];
  for (const accumulator of primaryAccumulators) {
    const inference = inferences.get(accumulator.testId)!;
    const result = accumulator.toJson(inference, adjusted[accumulator.testId] ?? null);
    primaryResults.set(accumulator.testId, result);
    primaryMetricRows.push(result);
  }
  const fundingResults = new Map<string, JsonRecord>();
  for (const accumulator of R55_DIRECTIONS.flatMap((direction) => R55_HORIZONS.map((horizon) => funding.byDirection[direction][horizon]))) {
    fundingResults.set(accumulator.testId, accumulator.toJson(null, null));
  }
  const conclusion = primaryClassification(primaryMetricRows);
  const primaryCrowdingRows = primaryMetricRows.filter((row) => String(row.family) !== "C3_OI_INCREMENTAL");
  const significantCount = primaryMetricRows.filter((row) => typeof row.holm_adjusted_p_value === "number" && Number(row.holm_adjusted_p_value) <= 0.05).length;
  const concentrationValues = primaryCrowdingRows
    .map((row) => Number(((row.symbol_concentration as JsonRecord).largest_symbol_share ?? 0)))
    .filter(Number.isFinite);
  const stableQuarters = primaryCrowdingRows.some((row) => (((row.stability as JsonRecord).quarter as JsonRecord).stable === true));
  const stableRegimes = primaryCrowdingRows.some((row) => (((row.stability as JsonRecord).regime as JsonRecord).stable === true));
  const c3OiOutput: JsonRecord = {
    definition: R55_FROZEN_EVALUATION_SPEC.c3_oi_only_definition,
    candidate_counts: Object.fromEntries(R55_DIRECTIONS.map((direction) => [
      direction.toLowerCase(), c3OiOnly.byDirection[direction]["1h"].eventCount,
    ])),
    by_direction: Object.fromEntries(R55_DIRECTIONS.map((direction) => [
      direction.toLowerCase(), {
        incremental_vs_oi: Object.fromEntries(R55_HORIZONS.map((horizon) => [horizon, primaryResults.get(c3OiIncremental.byDirection[direction][horizon].testId) ?? {}])),
        oi_only_vs_control: Object.fromEntries(R55_HORIZONS.map((horizon) => [horizon, c3OiOnly.byDirection[direction][horizon].toJson(null, null)])),
      },
    ])),
  };
  const report: JsonRecord = {
    research: "HY-R5.5 FROZEN CROWDING INFORMATION GAIN",
    version: R55_FROZEN_EVALUATION_SPEC.version,
    generated_at: new Date().toISOString(),
    classification: conclusion.classification,
    pit_safe: "PASS",
    data: {
      historical_range_start: EVALUATION_START_ISO,
      historical_range_end: EVALUATION_END_ISO,
      universe_count: inputs.dataset.universe.length,
      universe: inputs.dataset.universe,
      frozen_expected_observations: inputs.foundation.data.listing_adjusted_expected_observations,
      frozen_valid_positioning_observations: inputs.foundation.data.valid_positioning_observations,
      frozen_adjusted_coverage_percent: inputs.foundation.data.adjusted_coverage_percent,
      frozen_gap_count: inputs.foundation.coverage.gap_count,
      compact_rows: counters.compactRows,
      compact_artifacts_hash_verified: counters.compactHashVerified,
      aligned_15m_slots: counters.aligned15mSlots,
      outcome_complete_slots: counters.outcomeCompleteSlots,
      all_feature_eligible_slots: counters.allFeatureEligibleSlots,
      control_slots: counters.controlSlots,
      symbols_processed: counters.symbolsProcessed,
      outcome_complete_cutoff: iso(counters.latestOutcomeCompleteDecisionTime),
      event_resolution: R55_FROZEN_EVALUATION_SPEC.event_resolution,
      no_forward_fill: true,
    },
    governance: {
      experiment_count: 1,
      features_frozen_before_performance: "YES",
      post_result_tuning: "NO",
      c1_c4_specification_unchanged: true,
      taker_ratio_excluded: true,
      future_outcome_metrics_calculated_only_after_hash_gate: true,
      no_result_after_combination: true,
    },
    frozen_inputs: {
      freeze_manifest_path: FREEZE_MANIFEST_PATH,
      freeze_manifest_hash: freeze.hash,
      artifact_hashes: EXPECTED_HASHES,
      artifact_paths: {
        coverage_matrix: COVERAGE_MATRIX_PATH,
        schema_manifest: SCHEMA_MANIFEST_PATH,
        feature_specification: FEATURE_SPECIFICATION_PATH,
        dataset_manifest: DATASET_MANIFEST_PATH,
      },
      artifact_hash_method: "SHA-256 of canonical stable JSON with recursively sorted object keys",
      feature_specification_hash: EXPECTED_HASHES.feature_specification,
      runner_source_paths: RUNNER_SOURCE_PATHS,
      runner_source_hash: sourceHash,
      actual_hash_gate: inputs.actualHashes,
    },
    crowding_families: familyToJson(families, primary, primaryResults),
    c3_oi_comparison: c3OiOutput,
    comparison: {
      funding_only_definition: "R4.1 frozen 30-day prior-only funding extreme detector",
      funding_only_event_count: fundingCounts.events,
      funding_only_matched_count: fundingCounts.matched,
      funding_only: comparisonToJson(funding, fundingResults),
      aggregate_market_context: "matched non-event context controls; no separate market-context alpha",
      taker_ratio_used_as_crowding: false,
      existing_aggregate_flow: "R5.3 flow research is closed and is not credited to C1-C4",
    },
    statistics: {
      primary_test_count: primaryMetricRows.length,
      holm_significant_count: significantCount,
      seed: R55_FROZEN_EVALUATION_SPEC.fixed_random_seed,
      bootstrap_replicates: R55_FROZEN_EVALUATION_SPEC.bootstrap_replicates,
      permutation_replicates: R55_FROZEN_EVALUATION_SPEC.permutation_replicates,
      confidence_level: R55_FROZEN_EVALUATION_SPEC.confidence_level,
      primary_statistic: "paired precision difference: event success minus matched-control success",
      multiple_testing: R55_FROZEN_EVALUATION_SPEC.multiple_testing,
      primary_precision_tests: primaryMetricRows,
    },
    stability: {
      stable_across_quarters: stableQuarters,
      stable_across_regimes: stableRegimes,
      largest_symbol_concentration: concentrationValues.length === 0 ? null : Math.max(...concentrationValues),
      no_single_symbol_or_quarter_selection: true,
    },
    conclusion: {
      classification: conclusion.classification,
      best_candidate: conclusion.best,
      candidate_count: conclusion.candidates.length,
      candidates: conclusion.candidates,
      stable_across_quarters: stableQuarters,
      stable_across_regimes: stableRegimes,
      largest_symbol_concentration: concentrationValues.length === 0 ? null : Math.max(...concentrationValues),
    },
    primary_metric_rows: primaryMetricRows,
    safety: safetyBoundary(),
  };
  await writeFile(JSON_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(MARKDOWN_REPORT_PATH, buildMarkdown(report), "utf8");
  console.log(JSON.stringify({
    classification: report.classification,
    primaryTests: primaryMetricRows.length,
    compactRows: counters.compactRows,
    aligned15mSlots: counters.aligned15mSlots,
    outcomeCompleteSlots: counters.outcomeCompleteSlots,
    output: JSON_REPORT_PATH,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
