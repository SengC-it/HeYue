import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { createInterface } from "node:readline";

import type { Candle } from "../lib/core/types";
import {
  binaryPairedInference,
  classifyC1Direction,
  crowdingMatchKey,
  derivePITSafePrimitives,
  expected5mTimestamps,
  lifecycleIdAtTimestamp,
  parseBinanceMetricsCsv,
  sha256Json,
} from "../lib/crowding";
import type { CrowdingMetricsObservation, LifecycleInterval, PrimitiveOutputRow } from "../lib/crowding";
import { matchNearestWithoutReplacement } from "../lib/aggressive-flow";
import type { MatchablePoint, MatchPair } from "../lib/aggressive-flow";
import {
  crowdingStrength,
  crowdingStrengthBucket,
  distributionTotalVariation,
  R56_BOOTSTRAP_REPLICATES,
  R56_DISCOVERY_CI95,
  R56_DISCOVERY_LIFT,
  R56_HOLDOUT_START_ISO,
  R56_PERMUTATION_REPLICATES,
  R56_SELECTED_PHENOMENON,
  classifyHoldout,
  weekKey,
} from "../lib/crowding/holdout";
import type { HoldoutClassification } from "../lib/crowding/holdout";

type JsonRecord = Record<string, unknown>;
type MarketRegime = "UP" | "DOWN" | "RANGE";
type VolatilityBucket = "LOW" | "MEDIUM" | "HIGH";
type LiquidityBucket = "LOW" | "MEDIUM" | "HIGH";

const DAY_MS = 24 * 60 * 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const FIFTEEN_MINUTES_MS = 15 * 60_000;
const HOLDOUT_START = Date.parse(R56_HOLDOUT_START_ISO);
const METRICS_WINDOW = 288;
const CONTEXT_WINDOW = 672;
const OUTCOME_BARS_4H = 16;
const EXPECTED_DISCOVERY_HASHES = {
  coverage_matrix: "0f8214d88487754e123478b8be3b7f46fe7bfd9e90dbef7343b66b2c10a8513c",
  schema_manifest: "8aa7ff4dc001244e0e5b9cd45850f7fcd57a0f9b82715e135f58e5bdd98db3b8",
  feature_specification: "cebe6cfe2afac8cc548299911352b30e102f5a31690af1160e3a7714d3b77911",
  dataset_manifest: "e4ac51e05372399372768600cddd5f1303280e6b376df76e4b0139eaa080fdd6",
} as const;
const HOLDOUT_MANIFEST_PATH = resolve("data", "raw", "hy-r5.6-holdout", "dataset-manifest.json");
const DISCOVERY_FREEZE_PATH = resolve("reports", "hy-r5.5-pre-performance-freeze.json");
const DISCOVERY_ARTIFACT_ROOT = resolve("data", "raw", "hy-r5.4b-crowding", "artifacts");
const FREEZE_PATH = resolve("reports", "hy-r5.6-pre-confirmation-freeze.json");
const JSON_REPORT_PATH = resolve("reports", "hy-r5.6-independent-crowding-confirmation.json");
const MARKDOWN_REPORT_PATH = resolve("reports", "hy-r5.6-independent-crowding-confirmation.md");
const R56_SOURCE_PATHS = [
  "scripts/run-hy-r5-6-independent-crowding-confirmation.ts",
  "lib/crowding/holdout.ts",
  "lib/crowding/information-gain.ts",
] as const;
const MATCHING_IMPLEMENTATION_PATH = "lib/aggressive-flow/information-gain.ts";

interface HoldoutManifest {
  schema_version: string;
  selected_phenomenon: string;
  discovery_range: { start: string; end: string };
  holdout_range: { start: string; end: string; end_exclusive: string; latest_complete_official_metrics_day: string };
  universe: string[];
  files: {
    metrics_warmup: MetricFileEntry[];
    metrics_holdout: MetricFileEntry[];
    prices: PriceFileEntry[];
  };
  source_policy: JsonRecord;
  pit_warmup: JsonRecord;
}

interface MetricFileEntry {
  symbol: string;
  date: string;
  path: string;
  source_url: string;
  sha256: string;
  bytes: number;
  raw_rows: number;
  parsed_rows: number;
  schema_headers: string[];
}

interface PriceFileEntry {
  symbol: string;
  path: string;
  source: string;
  timeframe: "15m";
  start: string;
  end_exclusive: string;
  sha256: string;
  bytes: number;
  rows: number;
  first_open_time: number | null;
  last_open_time: number | null;
  missing_15m_cadence: number;
}

interface DiscoveryFreeze extends JsonRecord {
  universe: string[];
  historical_range: { start: string; end: string };
  frozen_artifact_hashes: Record<string, string>;
  feature_specification_hash: string;
  c1_c4_specification_unchanged: boolean;
  evaluation_specification: JsonRecord;
  matched_control_policy: JsonRecord;
}

interface CoverageSymbol {
  symbol: string;
  lifecycle_intervals: Array<{
    id: string;
    kind: string;
    start: string;
    end: string;
    source: string;
  }>;
}

interface CoverageMatrix {
  universe: string[];
  symbols: CoverageSymbol[];
}

interface MetricRow extends CrowdingMetricsObservation {
  lifecycleId: string;
}

interface FeatureRow {
  timestamp: number;
  pitAvailableAt: number;
  lifecycleId: string;
  topTraderPositionPercentile: number | null;
  topTraderAccountPercentile: number | null;
  globalAccountPercentile: number | null;
  topVsGlobalDivergence: number;
  c1AbsoluteCrowding: boolean;
  c2CrowdingDivergence: boolean;
  c3OiCrowdingBuildup: boolean;
  c4CrowdingUnwind: boolean;
  featureEligibility: PrimitiveOutputRow["featureEligibility"];
  c1Side: "BULLISH" | "BEARISH" | null;
  crowdingStrength: number | null;
  anyEvent: boolean;
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
}

interface AnalysisPoint extends MatchablePoint {
  symbol: string;
  decisionTimestamp: number;
  month: string;
  quarter: string;
  week: string;
  marketRegime: MarketRegime;
  volatilityBucket: VolatilityBucket;
  liquidityBucket: LiquidityBucket;
  crowdingStrength: number;
  crowdingStrengthBucket: string;
  candleIndex: number;
  referencePrice: number;
  lifecycleId: string;
  c1Side: "BULLISH" | "BEARISH" | null;
  c1AbsoluteCrowding: boolean;
  anyEvent: boolean;
  allFeatureEligible: boolean;
}

interface Outcome4H {
  futurePrice: number;
  directionalReturn: number;
  maxFavorableMove: number;
  maxAdverseMove: number;
}

interface MetricSummary {
  n: number;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

interface PairedEvaluation {
  eventCount: number;
  matchedEvents: number;
  unmatchedEvents: number;
  coveragePercent: number | null;
  eventSuccesses: number;
  controlSuccesses: number;
  signalPrecision: number | null;
  controlPrecision: number | null;
  incrementalLift: number | null;
  ci95: { lower: number; upper: number } | null;
  averageDirectionalReturnEffect: number | null;
  medianDirectionalReturnEffect: number | null;
  mfeEffect: number | null;
  maeEffect: number | null;
  eventReturns: MetricSummary;
  controlReturns: MetricSummary;
  eventMfe: MetricSummary;
  controlMfe: MetricSummary;
  eventMae: MetricSummary;
  controlMae: MetricSummary;
  inference: ReturnType<typeof binaryPairedInference>;
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function monthKey(timestamp: number): string {
  return iso(timestamp).slice(0, 7);
}

function quarterKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

function round(value: number | null, digits = 8): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
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

function unzipFirstFile(archive: Buffer): string {
  const endOfCentralDirectory = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOfCentralDirectory < 0) throw new Error("ZIP end-of-central-directory record not found");
  const entryCount = archive.readUInt16LE(endOfCentralDirectory + 10);
  const centralDirectoryOffset = archive.readUInt32LE(endOfCentralDirectory + 16);
  let cursor = centralDirectoryOffset;
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error("ZIP central-directory entry not found");
    const compressionMethod = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    const content = compressionMethod === 8 ? inflateRawSync(compressed) : compressed;
    return content.toString("utf8");
  }
  throw new Error("ZIP archive has no entries");
}

function intervalsFromCoverage(coverage: CoverageMatrix): Map<string, LifecycleInterval[]> {
  return new Map(coverage.symbols.map((entry) => [
    entry.symbol,
    entry.lifecycle_intervals.map((interval) => ({
      id: interval.id,
      kind: interval.kind === "RELAUNCHED" ? "RELAUNCHED" : interval.kind === "DELISTED" ? "DELISTED" : "ACTIVE",
      startTime: Date.parse(interval.start),
      endTimeExclusive: Date.parse(interval.end),
      source: interval.source,
    })),
  ]));
}

async function loadFrozenInputs(): Promise<{ discovery: DiscoveryFreeze; coverage: CoverageMatrix; feature: JsonRecord; manifest: HoldoutManifest; manifestHash: string }> {
  const [discovery, coverage, feature, manifest] = await Promise.all([
    loadJson<DiscoveryFreeze>(DISCOVERY_FREEZE_PATH),
    loadJson<CoverageMatrix>(resolve(DISCOVERY_ARTIFACT_ROOT, "coverage-matrix.json")),
    loadJson<JsonRecord>(resolve(DISCOVERY_ARTIFACT_ROOT, "feature-specification.json")),
    loadJson<HoldoutManifest>(HOLDOUT_MANIFEST_PATH),
  ]);
  const artifactPaths = {
    coverage_matrix: resolve(DISCOVERY_ARTIFACT_ROOT, "coverage-matrix.json"),
    schema_manifest: resolve(DISCOVERY_ARTIFACT_ROOT, "schema-manifest.json"),
    feature_specification: resolve(DISCOVERY_ARTIFACT_ROOT, "feature-specification.json"),
    dataset_manifest: resolve(DISCOVERY_ARTIFACT_ROOT, "dataset-manifest.json"),
  } as const;
  const actualHashes = {
    coverage_matrix: sha256Json(coverage),
    schema_manifest: sha256Json(await loadJson<JsonRecord>(artifactPaths.schema_manifest)),
    feature_specification: sha256Json(feature),
    dataset_manifest: sha256Json(await loadJson<JsonRecord>(artifactPaths.dataset_manifest)),
  } as const;
  for (const [name, expected] of Object.entries(EXPECTED_DISCOVERY_HASHES)) {
    if (actualHashes[name as keyof typeof actualHashes] !== expected) throw new Error(`RESEARCH_INVALID: discovery ${name} hash changed`);
    if (discovery.frozen_artifact_hashes[name] !== expected) throw new Error(`RESEARCH_INVALID: discovery freeze ${name} hash changed`);
  }
  if (discovery.feature_specification_hash !== EXPECTED_DISCOVERY_HASHES.feature_specification
    || discovery.c1_c4_specification_unchanged !== true
    || feature.specification_hash_generated_before_performance !== true
    || feature.c1_c4_unchanged !== true) {
    throw new Error("RESEARCH_INVALID: R5.5 feature specification is not frozen");
  }
  if (manifest.schema_version !== "hy-r5.6-holdout-v1"
    || manifest.selected_phenomenon !== R56_SELECTED_PHENOMENON
    || manifest.holdout_range.start !== R56_HOLDOUT_START_ISO
    || manifest.discovery_range.end !== "2026-08-09T23:59:59.999Z"
    || JSON.stringify([...manifest.universe].sort()) !== JSON.stringify([...discovery.universe].sort())) {
    throw new Error("RESEARCH_INVALID: holdout manifest is not locked to the approved discovery universe/range");
  }
  return { discovery, coverage, feature, manifest, manifestHash: sha256Json(manifest) };
}

async function sourceHash(paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(resolve(path), "utf8"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function createOrLoadFreeze(
  discovery: DiscoveryFreeze,
  manifest: HoldoutManifest,
  manifestHash: string,
  runnerHash: string,
  matchingHash: string,
): Promise<{ freeze: JsonRecord; hash: string }> {
  if (await exists(JSON_REPORT_PATH) || await exists(MARKDOWN_REPORT_PATH)) {
    throw new Error("CONFIRMATION_ALREADY_COMPLETED: refusing to rerun HY-R5.6 authoritative holdout performance");
  }
  if (await exists(FREEZE_PATH)) {
    const existing = await loadJson<JsonRecord>(FREEZE_PATH);
    if (existing.experiment_count !== 1
      || existing.selected_phenomenon !== R56_SELECTED_PHENOMENON
      || existing.discovery_lift !== R56_DISCOVERY_LIFT
      || existing.r5_6_source_hash !== runnerHash
      || existing.matching_implementation_hash !== matchingHash
      || existing.holdout_dataset_manifest_hash !== manifestHash
      || existing.features_frozen_before_outcomes !== "YES"
      || existing.post_result_tuning !== "NO") {
      throw new Error("RESEARCH_INVALID: existing R5.6 pre-confirmation freeze does not match inputs");
    }
    return { freeze: existing, hash: sha256Json(existing) };
  }
  const freeze: JsonRecord = {
    research: "HY-R5.6 INDEPENDENT CROWDING HOLDOUT CONFIRMATION",
    version: "hy-r5.6-v1",
    created_at: new Date().toISOString(),
    immutable: true,
    experiment_count: 1,
    selected_phenomenon: R56_SELECTED_PHENOMENON,
    discovery_range: discovery.historical_range ?? manifest.discovery_range,
    holdout_range: manifest.holdout_range,
    discovery_lift: R56_DISCOVERY_LIFT,
    discovery_ci95: R56_DISCOVERY_CI95,
    discovery_feature_specification_hash: EXPECTED_DISCOVERY_HASHES.feature_specification,
    discovery_artifact_hashes: EXPECTED_DISCOVERY_HASHES,
    r5_6_source_paths: R56_SOURCE_PATHS,
    r5_6_source_hash: runnerHash,
    matching_implementation_path: MATCHING_IMPLEMENTATION_PATH,
    matching_implementation_hash: matchingHash,
    holdout_dataset_manifest_path: HOLDOUT_MANIFEST_PATH,
    holdout_dataset_manifest_hash: manifestHash,
    holdout_dataset_manifest_hash_method: "SHA-256 of canonical stable JSON with recursively sorted object keys",
    features_frozen_before_outcomes: "YES",
    post_result_tuning: "NO",
    no_r5_5_discovery_compact_rows: true,
    no_r5_5_discovery_outcomes: true,
    no_threshold_window_percentile_symbol_regime_or_horizon_changes: true,
    hypothesis: {
      id: "HOLDOUT-H1",
      statement: "C1 bullish crowding event has positive incremental directional precision versus exactly matched controls in the independent holdout",
      primary_metric: "4h signal precision minus matched-control precision",
      success_gate: "lift > 0, 95% CI lower bound > 0, matching coverage >= 60%, no obvious single-symbol/single-week driver, PIT-safe",
    },
    frozen_method: {
      c1_definition: "BULLISH when any P1/P2/P3 prior-history percentile >=95 and none <=5; ambiguous sides excluded from directional metric",
      percentile_window_observations: 288,
      percentile_history: "strictly prior observations within the same lifecycle interval",
      event_resolution: "latest PIT-safe 5m observation in each completed 15m price slot; no forward fill",
      reference_price: "completed 15m candle close",
      decision_timestamp: "completed candle close + 1ms",
      context: "exact R5.5 prior/current completed-candle context: 24h/7d regime, 24h realized volatility, 24h quote-volume liquidity",
      match_fields: ["symbol", "calendar_month", "market_regime", "volatility_bucket", "liquidity_bucket"],
      control_selection: "nearest timestamp in exact key, deterministic earlier-time tie break, without replacement",
      control_pool: "all four frozen feature eligibilities true and no C1-C4 event",
      no_outcome_matching: true,
      outcome_horizon: "4h = 16 future contiguous 15m candles",
      bootstrap_replicates: R56_BOOTSTRAP_REPLICATES,
      permutation_replicates: R56_PERMUTATION_REPLICATES,
      seed: 5606,
      concentration_gate_percent: 50,
      regime_stability_minimum_pairs: 5,
    },
    outcome_metrics_not_yet_calculated: true,
  };
  await writeFile(FREEZE_PATH, `${JSON.stringify(freeze, null, 2)}\n`, "utf8");
  const reloaded = await loadJson<JsonRecord>(FREEZE_PATH);
  if (sha256Json(reloaded) !== sha256Json(freeze)) throw new Error("RESEARCH_INVALID: freeze manifest was not deterministic");
  return { freeze: reloaded, hash: sha256Json(reloaded) };
}

async function readMetricRows(manifest: HoldoutManifest, intervalsBySymbol: Map<string, LifecycleInterval[]>): Promise<{
  rowsBySymbol: Map<string, MetricRow[]>;
  fileCounters: JsonRecord;
  coverage: JsonRecord[];
}> {
  const allEntries = [...manifest.files.metrics_warmup, ...manifest.files.metrics_holdout];
  const rowsBySymbol = new Map<string, MetricRow[]>();
  let rawRows = 0;
  let parsedRows = 0;
  let validRows = 0;
  let rejectedRows = 0;
  for (const entry of allEntries) {
    const bytes = await readFile(resolve(entry.path));
    if (sha256Bytes(bytes) !== entry.sha256) throw new Error(`RESEARCH_INVALID: holdout metrics file changed ${entry.path}`);
    const csv = unzipFirstFile(bytes);
    const parsed = parseBinanceMetricsCsv(csv, { expectedSymbol: entry.symbol });
    rawRows += entry.raw_rows;
    parsedRows += parsed.observations.length;
    rejectedRows += Math.max(0, entry.raw_rows - parsed.observations.length);
    if (parsed.observations.length !== entry.parsed_rows) throw new Error(`RESEARCH_INVALID: metrics row count changed ${entry.path}`);
    for (const observation of parsed.observations) {
      const lifecycleId = lifecycleIdAtTimestamp(observation.timestamp, intervalsBySymbol.get(entry.symbol) ?? []);
      if (lifecycleId === null) continue;
      validRows += 1;
      const list = rowsBySymbol.get(entry.symbol) ?? [];
      list.push({ ...observation, lifecycleId });
      rowsBySymbol.set(entry.symbol, list);
    }
  }
  const holdoutStart = HOLDOUT_START;
  const holdoutEnd = Date.parse(manifest.holdout_range.end_exclusive);
  const coverage: JsonRecord[] = [];
  for (const symbol of manifest.universe) {
    const intervals = intervalsBySymbol.get(symbol) ?? [];
    const expected = expected5mTimestamps(intervals, holdoutStart, holdoutEnd).length;
    const list = [...new Map((rowsBySymbol.get(symbol) ?? []).map((row) => [row.timestamp, row])).values()]
      .sort((left, right) => left.timestamp - right.timestamp);
    rowsBySymbol.set(symbol, list);
    const holdoutRows = list.filter((row) => row.timestamp >= holdoutStart && row.timestamp < holdoutEnd);
    const observed = new Set(holdoutRows.map((row) => row.timestamp));
    const expectedTimestamps = expected5mTimestamps(intervals, holdoutStart, holdoutEnd);
    const missing = expectedTimestamps.filter((timestamp) => !observed.has(timestamp));
    let gapRuns = 0;
    for (let index = 0; index < missing.length; index += 1) {
      if (index === 0 || missing[index]! - missing[index - 1]! !== FIVE_MINUTES_MS) gapRuns += 1;
    }
    coverage.push({
      symbol,
      expected,
      valid: holdoutRows.length,
      coverage_percent: expected === 0 ? null : round(holdoutRows.length / expected * 100, 6),
      missing: missing.length,
      gap_runs: gapRuns,
    });
  }
  return {
    rowsBySymbol,
    fileCounters: {
      files: allEntries.length,
      raw_rows: rawRows,
      parsed_rows: parsedRows,
      valid_lifecycle_rows: validRows,
      rejected_rows: rejectedRows,
      warmup_files: manifest.files.metrics_warmup.length,
      holdout_files: manifest.files.metrics_holdout.length,
    },
    coverage,
  };
}

function buildFeatureRows(rows: MetricRow[]): FeatureRow[] {
  const byLifecycle = new Map<string, MetricRow[]>();
  for (const row of rows) {
    const list = byLifecycle.get(row.lifecycleId) ?? [];
    list.push(row);
    byLifecycle.set(row.lifecycleId, list);
  }
  const output: FeatureRow[] = [];
  for (const [lifecycleId, lifecycleRows] of byLifecycle) {
    const ordered = [...new Map(lifecycleRows.map((row) => [row.timestamp, row])).values()]
      .sort((left, right) => left.timestamp - right.timestamp);
    const primitives = derivePITSafePrimitives(ordered.map((row) => ({
      timestamp: row.timestamp,
      topTraderPositionRatio: row.topTraderPositionRatio,
      topTraderAccountRatio: row.topTraderAccountRatio,
      globalAccountRatio: row.globalAccountRatio,
      openInterest: row.openInterest,
    })), METRICS_WINDOW);
    for (let index = 0; index < ordered.length; index += 1) {
      const row = ordered[index]!;
      const primitive = primitives[index]!;
      const c1Side = classifyC1Direction({
        topTraderPositionPercentile: primitive.topTraderPositionPercentile,
        topTraderAccountPercentile: primitive.topTraderAccountPercentile,
        globalAccountPercentile: primitive.globalAccountPercentile,
      });
      const anyEvent = primitive.c1AbsoluteCrowding
        || primitive.c2CrowdingDivergence
        || primitive.c3OiCrowdingBuildup
        || primitive.c4CrowdingUnwind;
      output.push({
        timestamp: row.timestamp,
        pitAvailableAt: row.timestamp + FIVE_MINUTES_MS,
        lifecycleId,
        topTraderPositionPercentile: primitive.topTraderPositionPercentile,
        topTraderAccountPercentile: primitive.topTraderAccountPercentile,
        globalAccountPercentile: primitive.globalAccountPercentile,
        topVsGlobalDivergence: primitive.topVsGlobalDivergence,
        c1AbsoluteCrowding: primitive.c1AbsoluteCrowding,
        c2CrowdingDivergence: primitive.c2CrowdingDivergence,
        c3OiCrowdingBuildup: primitive.c3OiCrowdingBuildup,
        c4CrowdingUnwind: primitive.c4CrowdingUnwind,
        featureEligibility: primitive.featureEligibility,
        c1Side,
        crowdingStrength: crowdingStrength([
          primitive.topTraderPositionPercentile,
          primitive.topTraderAccountPercentile,
          primitive.globalAccountPercentile,
        ]),
        anyEvent,
      });
    }
  }
  return output.sort((left, right) => left.timestamp - right.timestamp);
}

function buildCandleArrays(input: Candle[]): CandleArrays {
  const candles = [...input].sort((left, right) => left.openTime - right.openTime);
  if (candles.length === 0) throw new Error("RESEARCH_INVALID: empty holdout price history");
  const priorContiguous = new Uint32Array(candles.length);
  const futureContiguous = new Uint32Array(candles.length);
  const logSquaredPrefix = new Float64Array(candles.length + 1);
  const quoteVolumePrefix = new Float64Array(candles.length + 1);
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]!;
    if (![candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.closeTime].every(Number.isFinite)
      || candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0) {
      throw new Error(`RESEARCH_INVALID: malformed price candle ${index}`);
    }
    if (candle.quoteVolume === undefined || !Number.isFinite(candle.quoteVolume) || candle.quoteVolume < 0) {
      throw new Error("RESEARCH_INVALID: quote volume is required for the frozen context definition");
    }
    const previous = candles[index - 1];
    priorContiguous[index] = previous && candle.openTime - previous.openTime === FIFTEEN_MINUTES_MS
      ? (priorContiguous[index - 1] ?? 1) + 1
      : 1;
    const logReturn = previous && previous.close > 0 ? Math.log(candle.close / previous.close) : 0;
    logSquaredPrefix[index + 1] = logSquaredPrefix[index]! + logReturn ** 2;
    quoteVolumePrefix[index + 1] = quoteVolumePrefix[index]! + candle.quoteVolume;
  }
  futureContiguous[candles.length - 1] = 1;
  for (let index = candles.length - 2; index >= 0; index -= 1) {
    futureContiguous[index] = candles[index + 1]!.openTime - candles[index]!.openTime === FIFTEEN_MINUTES_MS
      ? (futureContiguous[index + 1] ?? 1) + 1
      : 1;
  }
  return { candles, priorContiguous, futureContiguous, logSquaredPrefix, quoteVolumePrefix };
}

function contextAt(arrays: CandleArrays, candleIndex: number): MarketContext | null {
  if ((arrays.priorContiguous[candleIndex] ?? 0) < CONTEXT_WINDOW + 1) return null;
  const current = arrays.candles[candleIndex];
  const dayReference = arrays.candles[candleIndex - 96];
  const weekReference = arrays.candles[candleIndex - CONTEXT_WINDOW];
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
  return { marketRegime, volatilityBucket, liquidityBucket };
}

function lowerBoundPit(candles: Candle[], pitAvailableAt: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle]!.closeTime + 1 >= pitAvailableAt) high = middle;
    else low = middle + 1;
  }
  return low;
}

function buildAnalysisPoints(symbol: string, features: FeatureRow[], arrays: CandleArrays, holdoutEnd: number): AnalysisPoint[] {
  const selectedByCandle = new Map<number, FeatureRow>();
  for (const feature of features) {
    const candleIndex = lowerBoundPit(arrays.candles, feature.pitAvailableAt);
    const candle = arrays.candles[candleIndex];
    if (!candle || feature.timestamp < candle.openTime || feature.timestamp >= candle.openTime + FIFTEEN_MINUTES_MS) continue;
    const existing = selectedByCandle.get(candleIndex);
    if (!existing || feature.timestamp > existing.timestamp) selectedByCandle.set(candleIndex, feature);
  }
  const points: AnalysisPoint[] = [];
  for (const [candleIndex, feature] of selectedByCandle) {
    const candle = arrays.candles[candleIndex];
    if (!candle) continue;
    const decisionTimestamp = candle.closeTime + 1;
    if (decisionTimestamp < HOLDOUT_START || decisionTimestamp >= holdoutEnd) continue;
    if ((arrays.futureContiguous[candleIndex] ?? 0) < OUTCOME_BARS_4H + 1) continue;
    const context = contextAt(arrays, candleIndex);
    if (!context || feature.crowdingStrength === null || !feature.featureEligibility.c1) continue;
    const matchKey = crowdingMatchKey({
      symbol,
      time: decisionTimestamp,
      marketRegime: context.marketRegime,
      volatilityBucket: context.volatilityBucket,
      liquidityBucket: context.liquidityBucket,
    });
    points.push({
      time: decisionTimestamp,
      matchKey,
      symbol,
      decisionTimestamp,
      month: monthKey(decisionTimestamp),
      quarter: quarterKey(decisionTimestamp),
      week: weekKey(decisionTimestamp),
      marketRegime: context.marketRegime,
      volatilityBucket: context.volatilityBucket,
      liquidityBucket: context.liquidityBucket,
      crowdingStrength: feature.crowdingStrength,
      crowdingStrengthBucket: crowdingStrengthBucket(feature.crowdingStrength),
      candleIndex,
      referencePrice: candle.close,
      lifecycleId: feature.lifecycleId,
      c1Side: feature.c1Side,
      c1AbsoluteCrowding: feature.c1AbsoluteCrowding,
      anyEvent: feature.anyEvent,
      allFeatureEligible: feature.featureEligibility.c1
        && feature.featureEligibility.c2
        && feature.featureEligibility.c3
        && feature.featureEligibility.c4,
    });
  }
  return points.sort((left, right) => left.time - right.time);
}

function outcome4H(point: AnalysisPoint, arrays: CandleArrays): Outcome4H {
  let maximumHigh = Number.NEGATIVE_INFINITY;
  let minimumLow = Number.POSITIVE_INFINITY;
  for (let offset = 1; offset <= OUTCOME_BARS_4H; offset += 1) {
    const current = arrays.candles[point.candleIndex + offset];
    const previous = arrays.candles[point.candleIndex + offset - 1];
    if (!current || !previous || current.openTime - previous.openTime !== FIFTEEN_MINUTES_MS) {
      throw new Error("RESEARCH_INVALID: non-contiguous 4h outcome");
    }
    maximumHigh = Math.max(maximumHigh, current.high);
    minimumLow = Math.min(minimumLow, current.low);
  }
  const futurePrice = arrays.candles[point.candleIndex + OUTCOME_BARS_4H]!.close;
  const rawReturn = futurePrice / point.referencePrice - 1;
  const bullish = point.c1Side === "BULLISH";
  return {
    futurePrice,
    directionalReturn: bullish ? rawReturn : -rawReturn,
    maxFavorableMove: Math.max(0, bullish ? maximumHigh / point.referencePrice - 1 : 1 - minimumLow / point.referencePrice),
    maxAdverseMove: Math.max(0, bullish ? 1 - minimumLow / point.referencePrice : maximumHigh / point.referencePrice - 1),
  };
}

function numericSummary(values: number[]): MetricSummary {
  if (values.length === 0) return { n: 0, mean: null, median: null, min: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  return {
    n: values.length,
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    median: round(median),
    min: round(sorted[0]!),
    max: round(sorted.at(-1)!),
  };
}

function pairedEvaluation(pairs: Array<MatchPair<AnalysisPoint, AnalysisPoint>>, arraysBySymbol: Map<string, CandleArrays>): PairedEvaluation {
  const eventReturns: number[] = [];
  const controlReturns: number[] = [];
  const eventMfe: number[] = [];
  const controlMfe: number[] = [];
  const eventMae: number[] = [];
  const controlMae: number[] = [];
  const differences: number[] = [];
  let eventSuccesses = 0;
  let controlSuccesses = 0;
  for (const pair of pairs) {
    const eventArrays = arraysBySymbol.get(pair.event.symbol);
    const controlArrays = arraysBySymbol.get(pair.control.symbol);
    if (!eventArrays || !controlArrays) throw new Error("RESEARCH_INVALID: missing price arrays for matched pair");
    const event = outcome4H(pair.event, eventArrays);
    const control = outcome4H(pair.control, controlArrays);
    const eventSuccess = event.directionalReturn > 0;
    const controlSuccess = control.directionalReturn > 0;
    eventSuccesses += eventSuccess ? 1 : 0;
    controlSuccesses += controlSuccess ? 1 : 0;
    differences.push((eventSuccess ? 1 : 0) - (controlSuccess ? 1 : 0));
    eventReturns.push(event.directionalReturn);
    controlReturns.push(control.directionalReturn);
    eventMfe.push(event.maxFavorableMove);
    controlMfe.push(control.maxFavorableMove);
    eventMae.push(event.maxAdverseMove);
    controlMae.push(control.maxAdverseMove);
  }
  const inference = binaryPairedInference(differences, 5606, R56_BOOTSTRAP_REPLICATES, R56_PERMUTATION_REPLICATES);
  const meanDifference = (left: number[], right: number[]): number | null => left.length === 0 ? null : round(
    left.reduce((sum, value) => sum + value, 0) / left.length - right.reduce((sum, value) => sum + value, 0) / right.length,
  );
  const medianDifference = (left: number[], right: number[]): number | null => {
    const first = numericSummary(left).median;
    const second = numericSummary(right).median;
    return first === null || second === null ? null : round(first - second);
  };
  return {
    eventCount: pairs.length,
    matchedEvents: pairs.length,
    unmatchedEvents: 0,
    coveragePercent: null,
    eventSuccesses,
    controlSuccesses,
    signalPrecision: pairs.length === 0 ? null : round(eventSuccesses / pairs.length),
    controlPrecision: pairs.length === 0 ? null : round(controlSuccesses / pairs.length),
    incrementalLift: inference.observed === null ? null : round(inference.observed),
    ci95: inference.ci95 === null ? null : { lower: round(inference.ci95.lower)!, upper: round(inference.ci95.upper)! },
    averageDirectionalReturnEffect: meanDifference(eventReturns, controlReturns),
    medianDirectionalReturnEffect: medianDifference(eventReturns, controlReturns),
    mfeEffect: meanDifference(eventMfe, controlMfe),
    maeEffect: meanDifference(eventMae, controlMae),
    eventReturns: numericSummary(eventReturns),
    controlReturns: numericSummary(controlReturns),
    eventMfe: numericSummary(eventMfe),
    controlMfe: numericSummary(controlMfe),
    eventMae: numericSummary(eventMae),
    controlMae: numericSummary(controlMae),
    inference,
  };
}

function counts(values: string[]): JsonRecord {
  const countMap = new Map<string, number>();
  for (const value of values) countMap.set(value, (countMap.get(value) ?? 0) + 1);
  const total = values.length;
  return Object.fromEntries([...countMap.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, count]) => [key, { count, share_percent: round(total === 0 ? null : count / total * 100, 6) }]));
}

function dimensionValues(points: AnalysisPoint[], dimension: string): string[] {
  return points.map((point) => {
    if (dimension === "symbol") return point.symbol;
    if (dimension === "month") return point.month;
    if (dimension === "quarter") return point.quarter;
    if (dimension === "week") return point.week;
    if (dimension === "market_regime") return point.marketRegime;
    if (dimension === "volatility_bucket") return point.volatilityBucket;
    if (dimension === "liquidity_bucket") return point.liquidityBucket;
    return point.crowdingStrengthBucket;
  });
}

function matchingAudit(events: AnalysisPoint[], pairs: Array<MatchPair<AnalysisPoint, AnalysisPoint>>, unmatched: AnalysisPoint[]): JsonRecord {
  const matchedEvents = pairs.map((pair) => pair.event);
  const matchedControls = pairs.map((pair) => pair.control);
  const dimensions = ["symbol", "quarter", "month", "week", "market_regime", "volatility_bucket", "liquidity_bucket", "crowding_strength"];
  return Object.fromEntries(dimensions.map((dimension) => {
    const allValues = dimensionValues(events, dimension);
    const matchedValues = dimensionValues(matchedEvents, dimension);
    const unmatchedValues = dimensionValues(unmatched, dimension);
    const controlValues = dimensionValues(matchedControls, dimension);
    return [dimension, {
      all_event_population: counts(allValues),
      matched_event_population: counts(matchedValues),
      unmatched_event_population: counts(unmatchedValues),
      matched_control_population: counts(controlValues),
      matched_event_vs_control_total_variation: round(distributionTotalVariation(matchedValues, controlValues), 8),
      all_event_vs_matched_event_total_variation: round(distributionTotalVariation(allValues, matchedValues), 8),
      matched_event_vs_unmatched_event_total_variation: round(distributionTotalVariation(matchedValues, unmatchedValues), 8),
    }];
  }));
}

function groupLift(pairs: Array<MatchPair<AnalysisPoint, AnalysisPoint>>, arraysBySymbol: Map<string, CandleArrays>, key: (point: AnalysisPoint) => string): JsonRecord[] {
  const groups = new Map<string, { n: number; sum: number }>();
  for (const pair of pairs) {
    const event = outcome4H(pair.event, arraysBySymbol.get(pair.event.symbol)!);
    const control = outcome4H(pair.control, arraysBySymbol.get(pair.control.symbol)!);
    const name = key(pair.event);
    const current = groups.get(name) ?? { n: 0, sum: 0 };
    current.n += 1;
    current.sum += (event.directionalReturn > 0 ? 1 : 0) - (control.directionalReturn > 0 ? 1 : 0);
    groups.set(name, current);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([group, value]) => ({
    group,
    pairs: value.n,
    lift: round(value.sum / value.n),
    positive: value.sum / value.n > 0,
  }));
}

function concentration(points: AnalysisPoint[], key: (point: AnalysisPoint) => string): JsonRecord {
  const values = points.map(key);
  const distribution = counts(values);
  const first = Object.entries(distribution)[0];
  return {
    total: values.length,
    largest_group: first?.[0] ?? null,
    largest_count: first ? (first[1] as JsonRecord).count : 0,
    largest_share_percent: first ? (first[1] as JsonRecord).share_percent : null,
    distribution,
  };
}

function stableAcrossRegimes(groups: JsonRecord[]): "YES" | "NO" | "INSUFFICIENT" {
  const eligible = groups.filter((group) => Number(group.pairs) >= 5);
  if (eligible.length < 2) return "INSUFFICIENT";
  const total = eligible.reduce((sum, group) => sum + Number(group.pairs), 0);
  const largestShare = Math.max(...eligible.map((group) => Number(group.pairs))) / total;
  const positive = eligible.filter((group) => group.positive === true).length;
  return largestShare <= 0.8 && positive >= Math.ceil(eligible.length / 2) ? "YES" : "NO";
}

async function loadPriceArrays(manifest: HoldoutManifest): Promise<Map<string, CandleArrays>> {
  const arraysBySymbol = new Map<string, CandleArrays>();
  for (const entry of manifest.files.prices) {
    const bytes = await readFile(resolve(entry.path));
    if (sha256Bytes(bytes) !== entry.sha256) throw new Error(`RESEARCH_INVALID: holdout price file changed ${entry.path}`);
    const payload = JSON.parse(bytes.toString("utf8")) as { candles?: Candle[]; symbol?: string };
    if (payload.symbol !== entry.symbol || !Array.isArray(payload.candles)) throw new Error(`RESEARCH_INVALID: malformed price file ${entry.path}`);
    arraysBySymbol.set(entry.symbol, buildCandleArrays(payload.candles));
  }
  return arraysBySymbol;
}

function buildMarkdown(report: JsonRecord): string {
  const primary = report.primary_hypothesis as JsonRecord;
  const holdout = report.holdout as JsonRecord;
  const matching = report.matching as JsonRecord;
  const secondary = report.secondary_metrics as JsonRecord;
  const concentration = report.concentration as JsonRecord;
  const safety = report.safety as JsonRecord;
  const lines = [
    "# HY-R5.6 Independent Crowding Holdout Confirmation",
    "",
    "This is a preregistered, single-hypothesis, time-out-of-sample confirmation of the frozen HY-R5.5 `R55:C1:BULLISH:4h` phenomenon.",
    "",
    "## Locked scope",
    "",
    `- Discovery phenomenon: \`${String(report.discovery_phenomenon)}\`.`,
    `- Discovery lift: ${String(report.discovery_lift)}; discovery 95% CI: [${String((report.discovery_ci95 as number[])[0])}, ${String((report.discovery_ci95 as number[])[1])}].`,
    `- Holdout: ${String(holdout.start)} → ${String(holdout.end)}; official complete metrics day: ${String(holdout.latest_complete_official_metrics_day)}.`,
    "- One experiment only. C2/C3/C4 and other directions/horizons were not reselected or performance-ranked.",
    "- R5.5 compact rows and R5.5 discovery outcomes were not read; only public raw metrics and public futures candles were used.",
    "",
    "## Data and PIT validation",
    "",
    `- Raw metrics files: ${String((holdout.metrics as JsonRecord).files)}; raw rows: ${String((holdout.metrics as JsonRecord).raw_rows)}; parsed rows: ${String((holdout.metrics as JsonRecord).parsed_rows)}; lifecycle-valid rows: ${String((holdout.metrics as JsonRecord).valid_lifecycle_rows)}.`,
    `- Holdout analysis observations: ${String(holdout.observations)}; price files: ${String(holdout.price_files)}.`,
    `- PIT: ${String(report.pit_safe)}. Metrics availability is timestamp + 5 minutes; each decision consumes the latest available row in its completed 15m slot. Features use prior/current data only; outcomes use later candles only.`,
    `- Post-result tuning: ${String(report.post_result_tuning)}.`,
    "",
    "## Primary hypothesis",
    "",
    `- Eligible C1 bullish events: ${String(primary.eligible_events)}; matched events: ${String(primary.matched_events)}; matching coverage: ${String(primary.matching_coverage_percent)}%.`,
    `- 4h signal precision: ${String(primary.signal_precision)}; matched-control precision: ${String(primary.matched_control_precision)}; incremental lift: ${String(primary.incremental_lift)}.`,
    `- 95% CI: ${primary.ci95 === null ? "n/a" : `[${String((primary.ci95 as JsonRecord).lower)}, ${String((primary.ci95 as JsonRecord).upper)}]`}.`,
    `- Bootstrap/permutation: ${String(primary.bootstrap_replicates)}/${String(primary.permutation_replicates)}; seed: ${String(primary.seed)}.`,
    `- Classification: **${String(report.classification)}**.`,
    "",
    "## Matching audit",
    "",
    `- Control protocol: ${String(matching.protocol)}. Outcome matching: ${String(matching.outcome_matching)}.`,
    `- Unmatched events: ${String(matching.unmatched_events)}.`,
    `- Regime stability: ${String(matching.stable_across_regimes)}.`,
    "- Full matched/unmatched distributions and total-variation imbalances are in the JSON report under `matching.covariate_audit`.",
    "",
    "## Secondary descriptive effects",
    "",
    `- Average directional return effect: ${String(secondary.average_directional_return_effect)}; median effect: ${String(secondary.median_directional_return_effect)}.`,
    `- MFE effect: ${String(secondary.mfe_effect)}; MAE effect: ${String(secondary.mae_effect)}.`,
    "- Secondary effects cannot override the primary precision-lift gate.",
    "",
    "## Concentration and stability",
    "",
    `- Largest symbol concentration: ${String((concentration.symbol as JsonRecord).largest_share_percent)}%.`,
    `- Largest week concentration: ${String((concentration.week as JsonRecord).largest_share_percent)}%.`,
    `- Stable across regimes: ${String(matching.stable_across_regimes)}.`,
    "",
    "## Frozen artifact hashes",
    "",
    "- The pre-confirmation freeze records the R5.5 feature-specification hash, R5.6 runner/source hash, matching implementation hash, and holdout dataset-manifest hash before outcomes were computed.",
    `- Freeze: \`${String(report.pre_confirmation_freeze_path)}\`; hash: \`${String(report.pre_confirmation_freeze_hash)}\`.`,
    "",
    "## Safety boundary",
    "",
    `- Production modified: ${String(safety.production_modified)}; Supabase Production modified: ${String(safety.supabase_production_modified)}; Vercel modified: ${String(safety.vercel_modified)}.`,
    `- PAPER strategy modified: ${String(safety.paper_strategy_modified)}; emails sent: ${String(safety.emails_sent)}; private API called: ${String(safety.private_api_called)}; AUTO_TRADING: ${String(safety.auto_trading)}.`,
    "",
    "STOP.",
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const inputs = await loadFrozenInputs();
  const runnerHash = await sourceHash(R56_SOURCE_PATHS);
  const matchingHash = await sha256File(resolve(MATCHING_IMPLEMENTATION_PATH));
  const freezeResult = await createOrLoadFreeze(inputs.discovery, inputs.manifest, inputs.manifestHash, runnerHash, matchingHash);
  const intervalsBySymbol = intervalsFromCoverage(inputs.coverage);
  const metricData = await readMetricRows(inputs.manifest, intervalsBySymbol);
  const arraysBySymbol = await loadPriceArrays(inputs.manifest);
  const holdoutEnd = Date.parse(inputs.manifest.holdout_range.end_exclusive);
  const points: AnalysisPoint[] = [];
  const pointCounts: JsonRecord[] = [];
  for (const symbol of inputs.manifest.universe) {
    const rows = metricData.rowsBySymbol.get(symbol) ?? [];
    const features = buildFeatureRows(rows);
    const arrays = arraysBySymbol.get(symbol);
    if (!arrays) throw new Error(`RESEARCH_INVALID: missing price arrays for ${symbol}`);
    const symbolPoints = buildAnalysisPoints(symbol, features, arrays, holdoutEnd);
    points.push(...symbolPoints);
    pointCounts.push({ symbol, feature_rows: features.length, analysis_observations: symbolPoints.length });
  }
  const events = points.filter((point) => point.c1AbsoluteCrowding && point.c1Side === "BULLISH");
  const controls = points.filter((point) => point.allFeatureEligible && !point.anyEvent);
  const matchResult = matchNearestWithoutReplacement(events, controls);
  const pairs = matchResult.pairs;
  const primary = pairedEvaluation(pairs, arraysBySymbol);
  primary.eventCount = events.length;
  primary.unmatchedEvents = matchResult.unmatched.length;
  primary.coveragePercent = events.length === 0 ? null : round(pairs.length / events.length * 100, 6);
  const regimeGroups = groupLift(pairs, arraysBySymbol, (point) => point.marketRegime);
  const weekGroups = groupLift(pairs, arraysBySymbol, (point) => point.week);
  const stableRegimes = stableAcrossRegimes(regimeGroups);
  const symbolConcentration = concentration(events, (point) => point.symbol);
  const weekConcentration = concentration(events, (point) => point.week);
  const classification: HoldoutClassification = classifyHoldout({
    eligibleEvents: events.length,
    matchedEvents: pairs.length,
    matchingCoveragePercent: primary.coveragePercent,
    incrementalLift: primary.incrementalLift,
    ciLower: primary.ci95?.lower ?? null,
    ciUpper: primary.ci95?.upper ?? null,
    largestSymbolPercent: (symbolConcentration.largest_share_percent as number | null),
    largestWeekPercent: (weekConcentration.largest_share_percent as number | null),
    stableAcrossRegimes: stableRegimes,
    pitSafe: true,
    postResultTuning: false,
  });
  const report: JsonRecord = {
    research: "HY-R5.6 INDEPENDENT CROWDING HOLDOUT CONFIRMATION",
    version: "hy-r5.6-v1",
    generated_at: new Date().toISOString(),
    discovery_phenomenon: R56_SELECTED_PHENOMENON,
    discovery_lift: R56_DISCOVERY_LIFT,
    discovery_ci95: R56_DISCOVERY_CI95,
    holdout: {
      start: inputs.manifest.holdout_range.start,
      end: inputs.manifest.holdout_range.end,
      end_exclusive: inputs.manifest.holdout_range.end_exclusive,
      latest_complete_official_metrics_day: inputs.manifest.holdout_range.latest_complete_official_metrics_day,
      observations: points.length,
      universe: inputs.manifest.universe,
      price_files: inputs.manifest.files.prices.length,
      metrics: metricData.fileCounters,
      coverage_by_symbol: metricData.coverage,
      point_counts_by_symbol: pointCounts,
    },
    governance: {
      experiment_count: 1,
      rules_unchanged: "YES",
      c1_c4_specification_unchanged: true,
      post_result_tuning: "NO",
      no_other_candidate_selection: true,
      no_r5_5_discovery_compact_rows: true,
      no_r5_5_discovery_outcomes: true,
    },
    pit_safe: "PASS",
    primary_hypothesis: {
      id: "HOLDOUT-H1",
      statement: "C1 bullish crowding event has positive incremental directional precision versus matched controls",
      eligible_events: events.length,
      matched_events: pairs.length,
      unmatched_events: matchResult.unmatched.length,
      matching_coverage_percent: primary.coveragePercent,
      signal_precision: primary.signalPrecision,
      matched_control_precision: primary.controlPrecision,
      incremental_lift: primary.incrementalLift,
      ci95: primary.ci95,
      bootstrap_replicates: R56_BOOTSTRAP_REPLICATES,
      permutation_replicates: R56_PERMUTATION_REPLICATES,
      seed: 5606,
      inference: primary.inference,
    },
    secondary_metrics: {
      average_directional_return_effect: primary.averageDirectionalReturnEffect,
      median_directional_return_effect: primary.medianDirectionalReturnEffect,
      mfe_effect: primary.mfeEffect,
      mae_effect: primary.maeEffect,
      event_directional_return: primary.eventReturns,
      matched_control_directional_return: primary.controlReturns,
      event_mfe: primary.eventMfe,
      matched_control_mfe: primary.controlMfe,
      event_mae: primary.eventMae,
      matched_control_mae: primary.controlMae,
      horizon: "4h",
      outcome_definition: "directional return is raw return for bullish C1; future 16 contiguous 15m candles only",
    },
    matching: {
      protocol: "exact R5.5 key: symbol + calendar month + market regime + volatility bucket + liquidity bucket; nearest timestamp, earlier tie break, without replacement",
      outcome_matching: "NONE",
      control_pool: "all C1-C4 feature eligibilities true and no C1-C4 event",
      control_pool_size: controls.length,
      unmatched_events: matchResult.unmatched.length,
      stable_across_regimes: stableRegimes,
      regime_groups: regimeGroups,
      week_groups: weekGroups,
      covariate_audit: matchingAudit(events, pairs, matchResult.unmatched),
    },
    concentration: {
      symbol: symbolConcentration,
      week: weekConcentration,
    },
    classification,
    pre_confirmation_freeze_path: FREEZE_PATH,
    pre_confirmation_freeze_hash: freezeResult.hash,
    hash_evidence: {
      discovery_feature_specification_hash: EXPECTED_DISCOVERY_HASHES.feature_specification,
      discovery_artifact_hashes: EXPECTED_DISCOVERY_HASHES,
      r5_6_source_hash: runnerHash,
      matching_implementation_hash: matchingHash,
      holdout_dataset_manifest_hash: inputs.manifestHash,
      holdout_dataset_manifest_path: HOLDOUT_MANIFEST_PATH,
      representation: "discovery artifacts canonical stable JSON; matching/source files raw UTF-8 bytes with path separators in source hash; holdout manifest canonical stable JSON",
    },
    safety: {
      production_modified: "NO",
      supabase_production_modified: "NO",
      vercel_modified: "NO",
      paper_strategy_modified: "NO",
      emails_sent: 0,
      private_api_called: "NO",
      order_api_called: "NO",
      auto_trading: "FALSE",
      live_scanner_integrated: "NO",
      deploy_executed: "NO",
    },
  };
  await writeFile(JSON_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(MARKDOWN_REPORT_PATH, buildMarkdown(report), "utf8");
  console.log(JSON.stringify({
    classification,
    holdout: `${inputs.manifest.holdout_range.start} -> ${inputs.manifest.holdout_range.end}`,
    observations: points.length,
    eligibleEvents: events.length,
    matchedEvents: pairs.length,
    coveragePercent: primary.coveragePercent,
    lift: primary.incrementalLift,
    ci95: primary.ci95,
    runnerHash,
    matchingHash,
    holdoutManifestHash: inputs.manifestHash,
    freezeHash: freezeResult.hash,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
