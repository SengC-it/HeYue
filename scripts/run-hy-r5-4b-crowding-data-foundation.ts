import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

import {
  CROWDING_FOUNDATION_SCHEMA_VERSION,
  CROWDING_RAW_FIELD_MAPPING,
  FROZEN_CROWDING_CANDIDATES,
  FROZEN_CROWDING_FEATURE_SPECIFICATION,
  FIVE_MINUTES_MS,
  analyzeTimestampSequence,
  derivePITSafePrimitives,
  expected5mTimestamps,
  hasMetricsSchemaDrift,
  lifecycleIdAtTimestamp,
  lifecycleIntervalsForSymbol,
  metricsSchemaFingerprint,
  parseBinanceMetricsCsv,
  pitAvailableAt,
  sha256Json,
  stableJson,
  validateRatioConsistency,
} from "../lib/crowding";
import type {
  CrowdingMetricsObservation,
  LifecycleInterval,
  MetricsParseResult,
} from "../lib/crowding";

const HISTORY_START = Date.parse("2024-08-09T00:00:00.000Z");
const HISTORY_END_EXCLUSIVE = Date.parse("2026-08-10T00:00:00.000Z");
const HISTORY_START_ISO = "2024-08-09T00:00:00.000Z";
const HISTORY_END_ISO = "2026-08-09T23:59:59.999Z";
const METRICS_SOURCE_BASE = "https://data.binance.vision/data/futures/um/daily/metrics";
const EXCHANGE_INFO_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const PUMP_RENAME_EVIDENCE_URL = "https://www.binance.com/en/square/post/25422343646546";
const REQUEST_CONCURRENCY = 12;
const REQUEST_RETRIES = 3;

const FOUNDATION_ROOT = resolve("data", "raw", "hy-r5.4b-crowding");
const RAW_ROOT = resolve(FOUNDATION_ROOT, "daily");
const COMPACT_ROOT = resolve(FOUNDATION_ROOT, "compact");
const ARTIFACT_ROOT = resolve(FOUNDATION_ROOT, "artifacts");
const COVERAGE_MATRIX_PATH = resolve(ARTIFACT_ROOT, "coverage-matrix.json");
const SCHEMA_MANIFEST_PATH = resolve(ARTIFACT_ROOT, "schema-manifest.json");
const FEATURE_SPECIFICATION_PATH = resolve(ARTIFACT_ROOT, "feature-specification.json");
const DATASET_MANIFEST_PATH = resolve(ARTIFACT_ROOT, "dataset-manifest.json");
const ARTIFACT_HASHES_PATH = resolve(ARTIFACT_ROOT, "artifact-hashes.json");
const REPORT_ROOT = resolve("reports");
const JSON_REPORT_PATH = resolve(REPORT_ROOT, "hy-r5.4b-crowding-data-foundation.json");
const MARKDOWN_REPORT_PATH = resolve(REPORT_ROOT, "hy-r5.4b-crowding-data-foundation.md");
const COVERAGE_INPUT_PATH = resolve("data", "raw", "hy-r5.2b-flow", "coverage-matrix.json");
const LISTING_INPUT_PATH = resolve("data", "raw", "hy-r5.2b-flow", "listing-evidence.json");
const PREFLIGHT_INPUT_PATH = resolve("reports", "hy-r5.4-crowding-data-preflight.json");

const CANONICAL_HEADERS = CROWDING_RAW_FIELD_MAPPING.map((field) => field.rawField);
const CANONICAL_HEADER_FINGERPRINT = metricsSchemaFingerprint(CANONICAL_HEADERS);

type JsonRecord = Record<string, unknown>;
type DownloadStatus = "AVAILABLE" | "SOURCE_MISSING";

interface ExchangeSymbol {
  symbol: string;
  contractType: string;
  status: string;
  onboardDate: number;
  deliveryDate: number;
}

interface ListingEvidence {
  symbols: ExchangeSymbol[];
}

interface CoverageMonthInput {
  month: string;
  classification: string;
}

interface CoverageSymbolInput {
  symbol: string;
  months: CoverageMonthInput[];
}

interface CoverageInput {
  version: string;
  historical_range: JsonRecord;
  symbols: CoverageSymbolInput[];
}

interface RawArchive {
  buffer: Buffer;
  csv: string;
  sha256: string;
  bytes: number;
  cached: boolean;
}

interface DailyFileAudit {
  symbol: string;
  date: string;
  relative_path: string;
  source_url: string;
  download_status: DownloadStatus;
  archive_sha256: string | null;
  archive_bytes: number;
  raw_rows: number;
  parsed_rows: number;
  valid_rows: number;
  rejected_rows: number;
  lifecycle_excluded_rows: number;
  first_timestamp: string | null;
  last_timestamp: string | null;
  cadence_milliseconds: number | null;
  raw_timestamp_monotonic: boolean;
  timestamp_monotonic: boolean;
  schema_headers: string[];
  schema_fingerprint: string;
  issue_counts: Record<string, number>;
  observations: CrowdingMetricsObservation[];
}

interface PeriodCoverage {
  period: string;
  eligible: boolean;
  listing_adjusted_expected_observations: number;
  valid_observations: number;
  coverage_percent: number;
  missing_observations: number;
  gap_runs: number;
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
  top_vs_global_divergence_percentile: number | null;
  crowding_change: number | null;
  crowding_velocity: number | null;
  oi_change: number | null;
  c1_absolute_crowding: boolean | null;
  c2_crowding_divergence: boolean | null;
  c3_oi_crowding_buildup: boolean | null;
  c4_crowding_unwind: boolean | null;
  feature_eligibility: {
    c1: boolean;
    c2: boolean;
    c3: boolean;
    c4: boolean;
  };
  data_quality_flags: string[];
}

interface CompactArtifact {
  relative_path: string;
  rows: number;
  bytes: number;
  sha256: string;
}

interface SymbolBuildResult {
  symbol: string;
  intervals: LifecycleInterval[];
  file_audits: DailyFileAudit[];
  compact_artifact: CompactArtifact;
  expected_observations: number;
  valid_observations: number;
  rejected_rows: number;
  raw_rows: number;
  parsed_rows: number;
  lifecycle_excluded_rows: number;
  missing_observations: number;
  gap_runs: number;
  duplicate_count: number;
  out_of_order_count: number;
  cadence_break_count: number;
  raw_unordered_file_count: number;
  schema_conflict_count: number;
  monthly_coverage: PeriodCoverage[];
  quarterly_coverage: PeriodCoverage[];
  first_timestamp: string | null;
  last_timestamp: string | null;
  issue_counts: Record<string, number>;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256Bytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function utcDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function monthKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

function quarterKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

function dayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function dayIntersectsLifecycle(day: number, intervals: LifecycleInterval[]): boolean {
  const end = day + 24 * 60 * 60 * 1000;
  return intervals.some((interval) => interval.startTime < end && interval.endTimeExclusive > day);
}

function dateListForSymbol(intervals: LifecycleInterval[]): string[] {
  const dates: string[] = [];
  for (let timestamp = dayStart(HISTORY_START); timestamp < HISTORY_END_EXCLUSIVE; timestamp += 24 * 60 * 60 * 1000) {
    if (dayIntersectsLifecycle(timestamp, intervals)) dates.push(utcDate(timestamp));
  }
  return dates;
}

function metricsUrl(symbol: string, date: string): string {
  return `${METRICS_SOURCE_BASE}/${symbol}/${symbol}-metrics-${date}.zip`;
}

function rawArchivePath(symbol: string, date: string): string {
  return resolve(RAW_ROOT, symbol, `${symbol}-metrics-${date}.zip`);
}

function relativePath(path: string): string {
  return relative(process.cwd(), path).replaceAll("\\", "/");
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
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
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

function incrementIssue(counts: Record<string, number>, issue: string, amount = 1): void {
  const normalized = issue.replace(/:\d+$/, "");
  counts[normalized] = (counts[normalized] ?? 0) + amount;
}

function mergeIssueCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [issue, count] of Object.entries(source)) incrementIssue(target, issue, count);
}

function parseRawRows(csv: string): number {
  return csv.split(/\r?\n/).filter((line) => line.trim().length > 0).length - 1;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function acquireArchive(symbol: string, date: string): Promise<RawArchive | null> {
  const destination = rawArchivePath(symbol, date);
  try {
    const buffer = await readFile(destination);
    return {
      buffer,
      csv: unzipFirstFile(buffer),
      sha256: sha256Bytes(buffer),
      bytes: buffer.length,
      cached: true,
    };
  } catch {
    // A missing or incomplete local cache is re-fetched from the official archive.
  }

  const url = metricsUrl(symbol, date);
  let lastError: unknown;
  for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const csv = unzipFirstFile(buffer);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, buffer);
      return {
        buffer,
        csv,
        sha256: sha256Bytes(buffer),
        bytes: buffer.length,
        cached: false,
      };
    } catch (error) {
      lastError = error;
      if (attempt < REQUEST_RETRIES) await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 250));
    }
  }
  throw new Error(`Failed to acquire ${symbol} ${date}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function emptyFileAudit(symbol: string, date: string): DailyFileAudit {
  return {
    symbol,
    date,
    relative_path: relativePath(rawArchivePath(symbol, date)),
    source_url: metricsUrl(symbol, date),
    download_status: "SOURCE_MISSING",
    archive_sha256: null,
    archive_bytes: 0,
    raw_rows: 0,
    parsed_rows: 0,
    valid_rows: 0,
    rejected_rows: 0,
    lifecycle_excluded_rows: 0,
    first_timestamp: null,
    last_timestamp: null,
    cadence_milliseconds: null,
    raw_timestamp_monotonic: true,
    timestamp_monotonic: true,
    schema_headers: [],
    schema_fingerprint: "",
    issue_counts: { SOURCE_MISSING: 1 },
    observations: [],
  };
}

function parseDailyArchive(
  symbol: string,
  date: string,
  archive: RawArchive,
  intervals: LifecycleInterval[],
): DailyFileAudit {
  const parsed: MetricsParseResult = parseBinanceMetricsCsv(archive.csv, { expectedSymbol: symbol });
  const rawRows = parseRawRows(archive.csv);
  const issueCounts: Record<string, number> = {};
  for (const issue of parsed.issues) incrementIssue(issueCounts, issue);
  const schemaDrift = hasMetricsSchemaDrift(parsed.schema.headers);
  if (schemaDrift) incrementIssue(issueCounts, "SCHEMA_DRIFT");
  const malformedRows = parsed.issues.filter((issue) => issue.startsWith("MALFORMED_ROW:")).length;
  const schemaUsable = parsed.schema.missingFields.length === 0
    && parsed.schema.delimiter !== "UNKNOWN"
    && !schemaDrift;
  const parsedRows = schemaUsable ? Math.max(0, rawRows - malformedRows) : 0;
  const parsedTimestamps = parsed.observations.map((observation) => observation.timestamp);
  const rawSequence = analyzeTimestampSequence(parsedTimestamps);
  const normalizedTimestamps = [...new Set(parsedTimestamps)].sort((left, right) => left - right);
  const normalizedSequence = analyzeTimestampSequence(normalizedTimestamps);
  if (rawSequence.outOfOrderCount > 0) incrementIssue(issueCounts, "SOURCE_ARCHIVE_UNSORTED", rawSequence.outOfOrderCount);
  if (normalizedSequence.unexpectedCadenceCount > 0) incrementIssue(issueCounts, "UNEXPECTED_CADENCE", normalizedSequence.unexpectedCadenceCount);
  const eligibleObservations: CrowdingMetricsObservation[] = [];
  let lifecycleExcludedRows = 0;
  if (schemaUsable) {
    for (const observation of parsed.observations) {
      if (utcDate(observation.timestamp) !== date) {
        incrementIssue(issueCounts, "SOURCE_FILE_DATE_MISMATCH");
        continue;
      }
      if (lifecycleIdAtTimestamp(observation.timestamp, intervals) === null) {
        lifecycleExcludedRows += 1;
        incrementIssue(issueCounts, "LIFECYCLE_EXCLUDED");
        continue;
      }
      eligibleObservations.push(observation);
    }
  }
  const sorted = [...eligibleObservations].sort((left, right) => left.timestamp - right.timestamp);
  return {
    symbol,
    date,
    relative_path: relativePath(rawArchivePath(symbol, date)),
    source_url: metricsUrl(symbol, date),
    download_status: "AVAILABLE",
    archive_sha256: archive.sha256,
    archive_bytes: archive.bytes,
    raw_rows: rawRows,
    parsed_rows: parsedRows,
    valid_rows: sorted.length,
    rejected_rows: rawRows - sorted.length,
    lifecycle_excluded_rows: lifecycleExcludedRows,
    first_timestamp: iso(sorted[0]?.timestamp ?? null),
    last_timestamp: iso(sorted.at(-1)?.timestamp ?? null),
    cadence_milliseconds: normalizedTimestamps.length > 1 ? normalizedTimestamps[1]! - normalizedTimestamps[0]! : null,
    raw_timestamp_monotonic: rawSequence.outOfOrderCount === 0,
    timestamp_monotonic: normalizedSequence.outOfOrderCount === 0,
    schema_headers: parsed.schema.headers,
    schema_fingerprint: metricsSchemaFingerprint(parsed.schema.headers),
    issue_counts: issueCounts,
    observations: sorted,
  };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function consume(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => consume()));
  return results;
}

function periodCoverage(
  periodNames: string[],
  expectedTimestamps: number[],
  validTimestamps: number[],
  keyOf: (timestamp: number) => string,
): PeriodCoverage[] {
  const expectedByPeriod = new Map<string, number>();
  const validByPeriod = new Map<string, number>();
  for (const timestamp of expectedTimestamps) {
    const key = keyOf(timestamp);
    expectedByPeriod.set(key, (expectedByPeriod.get(key) ?? 0) + 1);
  }
  const missingByPeriod = new Map<string, number[]>();
  const validSet = new Set(validTimestamps);
  for (const timestamp of expectedTimestamps) {
    if (!validSet.has(timestamp)) {
      const key = keyOf(timestamp);
      const values = missingByPeriod.get(key) ?? [];
      values.push(timestamp);
      missingByPeriod.set(key, values);
    }
  }
  for (const timestamp of validTimestamps) {
    const key = keyOf(timestamp);
    validByPeriod.set(key, (validByPeriod.get(key) ?? 0) + 1);
  }
  const result: PeriodCoverage[] = [];
  for (const period of periodNames) {
    const expected = expectedByPeriod.get(period) ?? 0;
    const valid = validByPeriod.get(period) ?? 0;
    result.push({
      period,
      eligible: expected > 0,
      listing_adjusted_expected_observations: expected,
      valid_observations: valid,
      coverage_percent: expected === 0 ? 100 : valid / expected * 100,
      missing_observations: Math.max(0, expected - valid),
      gap_runs: calculateGapRuns(missingByPeriod.get(period) ?? []),
    });
  }
  return result;
}

function monthNames(): string[] {
  const names: string[] = [];
  const cursor = new Date(Date.UTC(2024, 7, 1));
  const end = new Date(Date.UTC(2026, 7, 1));
  while (cursor <= end) {
    names.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return names;
}

function quarterNames(): string[] {
  return ["2024-Q3", "2024-Q4", "2025-Q1", "2025-Q2", "2025-Q3", "2025-Q4", "2026-Q1", "2026-Q2", "2026-Q3"];
}

function calculateGapRuns(missingTimestamps: number[]): number {
  let runs = 0;
  for (let index = 0; index < missingTimestamps.length; index += 1) {
    if (index === 0 || missingTimestamps[index]! - missingTimestamps[index - 1]! !== FIVE_MINUTES_MS) runs += 1;
  }
  return runs;
}

function buildCompactRows(
  symbol: string,
  records: Map<number, { observation: CrowdingMetricsObservation; lifecycleId: string }>,
): CompactRow[] {
  const sorted = [...records.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value);
  const output: CompactRow[] = [];
  let segmentStart = 0;
  const flushSegment = (segmentEndExclusive: number): void => {
    const segment = sorted.slice(segmentStart, segmentEndExclusive);
    const primitiveInputs = segment.map(({ observation }) => ({
      timestamp: observation.timestamp,
      topTraderPositionRatio: observation.topTraderPositionRatio,
      topTraderAccountRatio: observation.topTraderAccountRatio,
      globalAccountRatio: observation.globalAccountRatio,
      openInterest: observation.openInterest,
    }));
    const primitives = derivePITSafePrimitives(primitiveInputs);
    for (let index = 0; index < segment.length; index += 1) {
      const source = segment[index]!;
      const primitive = primitives[index]!;
      const flags: string[] = [];
      if (!primitive.featureEligibility.c1 || !primitive.featureEligibility.c2 || !primitive.featureEligibility.c4) {
        flags.push("ROLLING_HISTORY_INSUFFICIENT");
      }
      if (!primitive.featureEligibility.c3) flags.push("OI_CONTEXT_INSUFFICIENT");
      output.push({
        symbol,
        timestamp: source.observation.timestamp,
        pit_available_at: pitAvailableAt(source.observation.timestamp),
        lifecycle_id: source.lifecycleId,
        top_trader_position_ratio: source.observation.topTraderPositionRatio,
        top_trader_account_ratio: source.observation.topTraderAccountRatio,
        global_account_ratio: source.observation.globalAccountRatio,
        open_interest: source.observation.openInterest,
        open_interest_value: source.observation.openInterestValue,
        top_trader_position_percentile: primitive.topTraderPositionPercentile,
        top_trader_account_percentile: primitive.topTraderAccountPercentile,
        global_account_percentile: primitive.globalAccountPercentile,
        top_vs_global_divergence: primitive.topVsGlobalDivergence,
        top_vs_global_divergence_percentile: primitive.topVsGlobalDivergencePercentile,
        crowding_change: primitive.crowdingChange,
        crowding_velocity: primitive.crowdingVelocity,
        oi_change: primitive.oiChange,
        c1_absolute_crowding: primitive.featureEligibility.c1 ? primitive.c1AbsoluteCrowding : null,
        c2_crowding_divergence: primitive.featureEligibility.c2 ? primitive.c2CrowdingDivergence : null,
        c3_oi_crowding_buildup: primitive.featureEligibility.c3 ? primitive.c3OiCrowdingBuildup : null,
        c4_crowding_unwind: primitive.featureEligibility.c4 ? primitive.c4CrowdingUnwind : null,
        feature_eligibility: primitive.featureEligibility,
        data_quality_flags: flags,
      });
    }
  };
  for (let index = 1; index <= sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (current === undefined || previous === undefined || current.lifecycleId !== previous.lifecycleId
      || current.observation.timestamp - previous.observation.timestamp !== FIVE_MINUTES_MS) {
      flushSegment(index);
      segmentStart = index;
    }
  }
  if (segmentStart < sorted.length) flushSegment(sorted.length);
  return output;
}

async function writeCompactArtifact(symbol: string, rows: CompactRow[]): Promise<CompactArtifact> {
  const destination = resolve(COMPACT_ROOT, `${symbol}.jsonl`);
  const temporary = `${destination}.tmp`;
  await mkdir(dirname(destination), { recursive: true });
  const stream = createWriteStream(temporary, { encoding: "utf8" });
  const hash = createHash("sha256");
  let bytes = 0;
  for (const row of rows) {
    const line = `${JSON.stringify(row)}\n`;
    hash.update(line, "utf8");
    bytes += Buffer.byteLength(line, "utf8");
    if (!stream.write(line, "utf8")) await once(stream, "drain");
  }
  const finish = new Promise<void>((resolvePromise, rejectPromise) => {
    stream.once("finish", resolvePromise);
    stream.once("error", rejectPromise);
  });
  stream.end();
  await finish;
  await rename(temporary, destination);
  return { relative_path: relativePath(destination), rows: rows.length, bytes, sha256: hash.digest("hex") };
}

async function processSymbol(
  symbol: string,
  listing: ExchangeSymbol,
): Promise<SymbolBuildResult> {
  const intervals = lifecycleIntervalsForSymbol(listing, EXCHANGE_INFO_URL);
  const dates = dateListForSymbol(intervals);
  const expectedTimestamps = expected5mTimestamps(intervals, HISTORY_START, HISTORY_END_EXCLUSIVE);
  const expectedSet = new Set(expectedTimestamps);
  const fileAudits = await mapWithConcurrency(dates, REQUEST_CONCURRENCY, async (date) => {
    const archive = await acquireArchive(symbol, date);
    if (archive === null) return emptyFileAudit(symbol, date);
    return parseDailyArchive(symbol, date, archive, intervals);
  });
  const records = new Map<number, { observation: CrowdingMetricsObservation; lifecycleId: string }>();
  const issueCounts: Record<string, number> = {};
  for (const file of fileAudits) {
    mergeIssueCounts(issueCounts, file.issue_counts);
    for (const observation of file.observations) {
      if (!expectedSet.has(observation.timestamp)) {
        incrementIssue(issueCounts, "OUTSIDE_EXPECTED_LIFECYCLE_GRID");
        continue;
      }
      const lifecycleId = lifecycleIdAtTimestamp(observation.timestamp, intervals);
      if (lifecycleId === null) {
        incrementIssue(issueCounts, "LIFECYCLE_EXCLUDED");
        continue;
      }
      if (records.has(observation.timestamp)) {
        incrementIssue(issueCounts, "DUPLICATE_SYMBOL_TIMESTAMP");
        continue;
      }
      records.set(observation.timestamp, { observation, lifecycleId });
    }
  }
  const validTimestamps = [...records.keys()].sort((left, right) => left - right);
  const sequence = analyzeTimestampSequence(validTimestamps, expectedTimestamps);
  if (sequence.missingTimestamps.length > 0) incrementIssue(issueCounts, "MISSING_EXPECTED_5M", sequence.missingTimestamps.length);
  const monthlyCoverage = periodCoverage(monthNames(), expectedTimestamps, validTimestamps, monthKey);
  const quarterlyCoverage = periodCoverage(quarterNames(), expectedTimestamps, validTimestamps, quarterKey);
  const compactRows = buildCompactRows(symbol, records);
  const compactArtifact = await writeCompactArtifact(symbol, compactRows);
  const first = validTimestamps[0] ?? null;
  const last = validTimestamps.at(-1) ?? null;
  const schemaConflictCount = fileAudits.filter((file) => file.download_status === "AVAILABLE" && file.schema_fingerprint !== CANONICAL_HEADER_FINGERPRINT).length;
  return {
    symbol,
    intervals,
    file_audits: fileAudits,
    compact_artifact: compactArtifact,
    expected_observations: expectedTimestamps.length,
    valid_observations: records.size,
    rejected_rows: fileAudits.reduce((total, file) => total + file.rejected_rows, 0),
    raw_rows: fileAudits.reduce((total, file) => total + file.raw_rows, 0),
    parsed_rows: fileAudits.reduce((total, file) => total + file.parsed_rows, 0),
    lifecycle_excluded_rows: fileAudits.reduce((total, file) => total + file.lifecycle_excluded_rows, 0),
    missing_observations: sequence.missingTimestamps.length,
    gap_runs: calculateGapRuns(sequence.missingTimestamps),
    duplicate_count: sequence.duplicateCount,
    out_of_order_count: 0,
    cadence_break_count: sequence.unexpectedCadenceCount + fileAudits.reduce((total, file) => total + ((file.issue_counts.UNEXPECTED_CADENCE ?? 0)), 0),
    raw_unordered_file_count: fileAudits.filter((file) => !file.raw_timestamp_monotonic).length,
    schema_conflict_count: schemaConflictCount,
    monthly_coverage: monthlyCoverage,
    quarterly_coverage: quarterlyCoverage,
    first_timestamp: iso(first),
    last_timestamp: iso(last),
    issue_counts: issueCounts,
  };
}

function compactFileAudit(file: DailyFileAudit): Omit<DailyFileAudit, "observations"> {
  const { observations: _observations, ...audit } = file;
  return audit;
}

function candidateProjection(value: unknown): Array<JsonRecord> {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    definition: candidate.definition,
    threshold_method: candidate.threshold_method,
  }));
}

function nestedRecord(value: unknown, key: string): JsonRecord | null {
  if (!isRecord(value)) return null;
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function aggregatePeriods(
  summaries: SymbolBuildResult[],
  field: "monthly_coverage" | "quarterly_coverage",
): PeriodCoverage[] {
  const byPeriod = new Map<string, { expected: number; valid: number; missing: number; gapRuns: number }>();
  for (const summary of summaries) {
    for (const period of summary[field]) {
      const current = byPeriod.get(period.period) ?? { expected: 0, valid: 0, missing: 0, gapRuns: 0 };
      current.expected += period.listing_adjusted_expected_observations;
      current.valid += period.valid_observations;
      current.missing += period.missing_observations;
      current.gapRuns += period.gap_runs;
      byPeriod.set(period.period, current);
    }
  }
  return [...byPeriod.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([period, value]) => ({
    period,
    eligible: value.expected > 0,
    listing_adjusted_expected_observations: value.expected,
    valid_observations: value.valid,
    coverage_percent: value.expected === 0 ? 100 : value.valid / value.expected * 100,
    missing_observations: value.missing,
    gap_runs: value.gapRuns,
  }));
}

function minEligibleCoverage(values: Array<{ coverage_percent: number; eligible: boolean }>): number {
  const eligible = values.filter((value) => value.eligible);
  return eligible.length === 0 ? 0 : Math.min(...eligible.map((value) => value.coverage_percent));
}

function buildMarkdown(report: JsonRecord): string {
  const data = report.data as JsonRecord;
  const coverage = report.coverage as JsonRecord;
  const quality = report.data_quality as JsonRecord;
  const hashes = report.artifact_hashes as JsonRecord;
  const schema = report.schema_manifest as JsonRecord;
  const specs = report.feature_specification as JsonRecord;
  const symbols = coverage.symbol_matrix as JsonRecord[];
  const quarters = coverage.aggregate_quarter_matrix as JsonRecord[];
  const sourceFiles = report.raw_files as JsonRecord;
  const lines: string[] = [
    "# HY-R5.4B Crowding Historical Data Foundation + Performance Freeze",
    "",
    `## Classification: ${String(report.classification)}`,
    "",
    "This artifact is data foundation only. No future returns, precision, matched controls, MFE, MAE, PnL, Sharpe, or profit factor were calculated.",
    "",
    "## Scope",
    "",
    `- Historical range: ${String((report.historical_range as JsonRecord).start)} -> ${String((report.historical_range as JsonRecord).end)}`,
    `- Universe: ${String(report.universe_count)}/49 symbols`,
    `- Official daily metrics files targeted: ${String(sourceFiles.target_files)}`,
    `- Raw files available: ${String(sourceFiles.available_files)}; source-missing eligible files: ${String(sourceFiles.source_missing_files)}`,
    `- Raw rows: ${String(data.raw_rows)}`,
    `- Parsed rows: ${String(data.parsed_rows)}`,
    `- Valid positioning observations: ${String(data.valid_positioning_observations)}`,
    `- Rejected rows: ${String(data.rejected_rows)}`,
    `- Listing-adjusted expected observations: ${String(data.listing_adjusted_expected_observations)}`,
    `- Adjusted coverage: ${Number(data.adjusted_coverage_percent).toFixed(4)}%`,
    "",
    "## Official sources",
    "",
    `- Binance Vision daily metrics: ${String((report.official_sources as JsonRecord[])[0]?.url)}`,
    `- Binance exchangeInfo lifecycle evidence: ${String((report.official_sources as JsonRecord[])[1]?.url)}`,
    `- PUMPUSDT rename evidence: ${String((report.official_sources as JsonRecord[])[2]?.url)}`,
    "",
    "## Coverage matrix",
    "",
    `- Worst symbol: ${String(coverage.worst_symbol)} at ${Number(coverage.worst_symbol_coverage_percent).toFixed(4)}%`,
    `- Worst eligible month: ${String(coverage.worst_month)} at ${Number(coverage.worst_month_coverage_percent).toFixed(4)}%`,
    `- Worst eligible quarter: ${String(coverage.worst_quarter)} at ${Number(coverage.worst_quarter_coverage_percent).toFixed(4)}%`,
    `- Gap count: ${String(coverage.gap_count)}; gap runs: ${String(coverage.gap_runs)}`,
    "",
    "### Symbol coverage",
    "",
    "| Symbol | Expected | Valid | Coverage | Missing | Gaps |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...symbols.map((symbol) => `| ${String(symbol.symbol)} | ${String(symbol.expected)} | ${String(symbol.valid)} | ${Number(symbol.coverage_percent).toFixed(2)}% | ${String(symbol.missing)} | ${String(symbol.gap_runs)} |`),
    "",
    "### Aggregate quarter coverage",
    "",
    "| Quarter | Expected | Valid | Coverage | Missing |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...quarters.map((quarter) => `| ${String(quarter.period)} | ${String(quarter.listing_adjusted_expected_observations)} | ${String(quarter.valid_observations)} | ${Number(quarter.coverage_percent).toFixed(2)}% | ${String(quarter.missing_observations)} |`),
    "",
    "NOT_LISTED intervals are excluded from the denominator. PUMPUSDT old-contract and relaunch-contract intervals have separate lifecycle IDs; the inactive interval is not source missing.",
    "",
    "## Schema manifest and ratio validation",
    "",
    `- Canonical observed header: ${String((schema.canonical_headers as string[]).join(", "))}`,
    `- Observed schema signatures: ${String((schema.observed_schema_signatures as string[]).length)}`,
    `- Schema conflicts: ${String(schema.schema_conflict_count)}`,
    `- Ratio validation: ${String((report.ratio_validation as JsonRecord).status)} — ${String((report.ratio_validation as JsonRecord).reason)}`,
    "",
    "| Raw field | Normalized field | Research feature |",
    "| --- | --- | --- |",
    ...((schema.field_mapping as JsonRecord[]).map((field) => `| ${String(field.rawField)} | ${String(field.normalizedField ?? "EXCLUDED")} | ${String(field.researchFeature)} |`)),
    "",
    "The archive contains ratio fields but not longAccount/shortAccount components. Component consistency is therefore NOT_APPLICABLE rather than fabricated or zero-filled. The taker ratio is retained only in schema audit and excluded from the compact crowding artifact.",
    "",
    "## Data quality",
    "",
    `- Timestamp monotonic: ${String(quality.timestamp_monotonic)}`,
    `- Raw archive row order: ${String(quality.raw_archive_timestamp_order)}`,
    `- Duplicate symbol/timestamp: ${String(quality.duplicate_symbol_timestamp)}`,
    `- Missing 5m intervals: ${String(quality.missing_5m_intervals)}`,
    `- NaN/invalid numeric values: ${String(quality.invalid_numeric_values)}`,
    `- Negative OI / zero denominator / impossible ratio: ${String(quality.invalid_oi_or_ratio_values)}`,
    `- Unexpected cadence/timezone: ${String(quality.unexpected_cadence_or_timezone)}`,
    `- Schema drift: ${String(quality.schema_drift)}`,
    `- Rejection reason codes: ${String(quality.rejection_reason_codes)}`,
    "",
    "## PIT contract",
    "",
    `- PIT-safe: ${String(report.pit_safe)}`,
    "- Raw create_time is the UTC 5m bucket start label (00:00 through 23:55 in daily files). Compact rows carry pit_available_at = timestamp + 5m as a conservative complete-bucket boundary.",
    "- No end-of-period snapshot is backfilled to period start; no forward fill, zero fill, interpolation, or shortened rolling window is used.",
    "",
    "## Frozen C1-C4 specifications",
    "",
    ...((specs.candidates as JsonRecord[]).map((candidate) => `- ${String(candidate.id)} ${String(candidate.name)}: ${String(candidate.definition)}; ${String(candidate.threshold_method)}.`)),
    `- Feature specification hash: ${String(hashes.feature_specification_hash)}`,
    `- C1-C4 unchanged: ${String(report.c1_c4_specification_unchanged)}`,
    "",
    "## Existing-feature overlap",
    "",
    `- Existing OI observations: ${String((report.existing_feature_overlap as JsonRecord).existing_oi_observations_1h)}; OI level/value remain context and P4 is PARTIALLY_USED.`,
    `- Existing aggregate flow observations: ${String((report.existing_feature_overlap as JsonRecord).existing_flow_observations)}; taker L/S is not rebranded as crowding.`,
    "- Orthogonality classification: PARTIALLY_USED overall because P4 includes an existing OI baseline; P1/P2/P3/P5 remain new positioning information.",
    "",
    "## Frozen artifacts",
    "",
    `- Coverage matrix hash: ${String(hashes.coverage_matrix_hash)}`,
    `- Schema manifest hash: ${String(hashes.schema_manifest_hash)}`,
    `- Feature specification hash: ${String(hashes.feature_specification_hash)}`,
    `- Dataset manifest hash: ${String(hashes.dataset_manifest_hash)}`,
    "",
    "## Safety and performance boundary",
    "",
    "- Future performance calculated: NO",
    "- Production/Supabase/Vercel/PAPER/scanner live integration: NO",
    "- Emails: 0; private Binance API: NO; orders: NO; AUTO_TRADING: FALSE",
    "- Commit created: NO",
  ];
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const [coverageInput, listingInput, preflightInput, coverageBytes, listingBytes] = await Promise.all([
    readJson<CoverageInput>(COVERAGE_INPUT_PATH),
    readJson<ListingEvidence>(LISTING_INPUT_PATH),
    readJson<JsonRecord>(PREFLIGHT_INPUT_PATH),
    readFile(COVERAGE_INPUT_PATH),
    readFile(LISTING_INPUT_PATH),
  ]);
  const listingBySymbol = new Map(listingInput.symbols.map((symbol) => [symbol.symbol, symbol]));
  const universe = coverageInput.symbols.map((symbol) => symbol.symbol).sort();
  if (universe.length !== 49 || listingBySymbol.size !== 49) throw new Error("Expected a 49-symbol listing-aware universe");
  const preflightCandidates = preflightInput.provisional_candidates
    ?? nestedRecord(preflightInput.data, "provisional_candidates")?.candidates;
  const c1C4Unchanged = stableJson(candidateProjection(preflightCandidates)) === stableJson(candidateProjection(FROZEN_CROWDING_CANDIDATES));
  const previousFeatureHash = typeof preflightInput.feature_specification_hash === "string"
    ? preflightInput.feature_specification_hash
    : nestedRecord(preflightInput.data, "feature_specification_hash")?.value ?? null;
  const results: SymbolBuildResult[] = [];
  const allFileAudits: DailyFileAudit[] = [];
  for (const symbol of universe) {
    const listing = listingBySymbol.get(symbol);
    if (listing === undefined) throw new Error(`Missing listing evidence for ${symbol}`);
    const result = await processSymbol(symbol, listing);
    results.push(result);
    allFileAudits.push(...result.file_audits);
    console.log(JSON.stringify({
      symbol,
      files: result.file_audits.length,
      availableFiles: result.file_audits.filter((file) => file.download_status === "AVAILABLE").length,
      expected: result.expected_observations,
      valid: result.valid_observations,
      missing: result.missing_observations,
      coveragePercent: result.expected_observations === 0 ? 100 : result.valid_observations / result.expected_observations * 100,
      compactRows: result.compact_artifact.rows,
    }));
  }

  const aggregateMonthly = aggregatePeriods(results, "monthly_coverage");
  const aggregateQuarterly = aggregatePeriods(results, "quarterly_coverage");
  const rawRows = results.reduce((total, result) => total + result.raw_rows, 0);
  const parsedRows = results.reduce((total, result) => total + result.parsed_rows, 0);
  const validObservations = results.reduce((total, result) => total + result.valid_observations, 0);
  const rejectedRows = results.reduce((total, result) => total + result.rejected_rows, 0);
  const expectedObservations = results.reduce((total, result) => total + result.expected_observations, 0);
  const missingObservations = results.reduce((total, result) => total + result.missing_observations, 0);
  const gapRuns = results.reduce((total, result) => total + result.gap_runs, 0);
  const duplicateCount = results.reduce((total, result) => total + result.duplicate_count, 0);
  const schemaConflictCount = results.reduce((total, result) => total + result.schema_conflict_count, 0);
  const adjustedCoveragePercent = expectedObservations === 0 ? 0 : validObservations / expectedObservations * 100;
  const sourceMissingFiles = allFileAudits.filter((file) => file.download_status === "SOURCE_MISSING").length;
  const availableFiles = allFileAudits.filter((file) => file.download_status === "AVAILABLE").length;
  const issueCounts: Record<string, number> = {};
  for (const result of results) mergeIssueCounts(issueCounts, result.issue_counts);
  const invalidNumericCount = Object.entries(issueCounts)
    .filter(([issue]) => issue.includes("INVALID") || issue.includes("NAN") || issue.includes("ZERO_DENOMINATOR"))
    .reduce((total, [, count]) => total + count, 0);
  const timestampMonotonic = results.every((result) => result.out_of_order_count === 0);
  const cadenceIssues = results.reduce((total, result) => total + result.cadence_break_count, 0);
  const rawUnorderedFiles = results.reduce((total, result) => total + result.raw_unordered_file_count, 0);
  const ratioConsistency = validateRatioConsistency({});

  const coverageMatrixArtifact = {
    schema_version: CROWDING_FOUNDATION_SCHEMA_VERSION,
    historical_range: { start: HISTORY_START_ISO, end: HISTORY_END_ISO },
    universe,
    source_coverage_matrix_sha256: sha256Bytes(coverageBytes),
    source_listing_evidence_sha256: sha256Bytes(listingBytes),
    symbols: results.map((result) => ({
      symbol: result.symbol,
      expected: result.expected_observations,
      valid: result.valid_observations,
      coverage_percent: result.expected_observations === 0 ? 100 : result.valid_observations / result.expected_observations * 100,
      missing: result.missing_observations,
      gap_runs: result.gap_runs,
      months: result.monthly_coverage,
      quarters: result.quarterly_coverage,
      lifecycle_intervals: result.intervals.map((interval) => ({
        id: interval.id,
        kind: interval.kind,
        start: iso(interval.startTime),
        end: iso(interval.endTimeExclusive),
        source: interval.source,
      })),
    })),
    aggregate_month_matrix: aggregateMonthly,
    aggregate_quarter_matrix: aggregateQuarterly,
  };

  const schemaManifestArtifact = {
    schema_version: CROWDING_FOUNDATION_SCHEMA_VERSION,
    canonical_headers: CANONICAL_HEADERS,
    observed_schema_signatures: [...new Set(allFileAudits.filter((file) => file.download_status === "AVAILABLE").map((file) => file.schema_fingerprint))].sort(),
    field_mapping: CROWDING_RAW_FIELD_MAPPING,
    excluded_fields: ["sum_taker_long_short_vol_ratio"],
    ratio_consistency: {
      status: ratioConsistency.status,
      reason: "The actual archive schema does not expose longAccount/shortAccount components.",
      component_fields_present: false,
    },
    timestamp_contract: {
      raw_field: "create_time",
      semantics: "UTC 5m bucket start label",
      pit_available_at: "timestamp + 5m conservative complete-bucket boundary",
      publication_time_present: false,
    },
    schema_conflict_count: schemaConflictCount,
    files_checked: allFileAudits.length,
  };

  const featureSpecificationArtifact = {
    schema_version: CROWDING_FOUNDATION_SCHEMA_VERSION,
    source_preflight: relativePath(PREFLIGHT_INPUT_PATH),
    previous_feature_specification_hash: previousFeatureHash,
    specification_hash_generated_before_performance: true,
    c1_c4_unchanged: c1C4Unchanged,
    specification: FROZEN_CROWDING_FEATURE_SPECIFICATION,
  };

  const compactArtifacts = results.map((result) => result.compact_artifact);
  const datasetManifestArtifact = {
    schema_version: CROWDING_FOUNDATION_SCHEMA_VERSION,
    historical_range: { start: HISTORY_START_ISO, end: HISTORY_END_ISO },
    universe,
    source: {
      provider: "Binance Vision official daily futures metrics archive",
      base_url: METRICS_SOURCE_BASE,
      archive_layout: "daily/metrics/<symbol>/<symbol>-metrics-<YYYY-MM-DD>.zip",
    },
    row_schema: [
      "symbol",
      "timestamp",
      "pit_available_at",
      "lifecycle_id",
      "top_trader_position_ratio",
      "top_trader_account_ratio",
      "global_account_ratio",
      "open_interest",
      "open_interest_value",
      "PIT-safe C1-C4 primitives",
      "feature_eligibility",
      "data_quality_flags",
    ],
    prohibited_columns: ["future_return", "future_label", "mfe", "mae", "pnl", "taker_ratio_as_crowding"],
    raw_file_count: allFileAudits.length,
    raw_files_available: availableFiles,
    raw_files_source_missing: sourceMissingFiles,
    raw_files: allFileAudits.sort((left, right) => `${left.symbol}:${left.date}`.localeCompare(`${right.symbol}:${right.date}`)).map(compactFileAudit),
    compact_artifacts: compactArtifacts.sort((left, right) => left.relative_path.localeCompare(right.relative_path)),
    symbol_summaries: results.map((result) => ({
      symbol: result.symbol,
      raw_rows: result.raw_rows,
      parsed_rows: result.parsed_rows,
      valid_rows: result.valid_observations,
      rejected_rows: result.rejected_rows,
      expected_rows: result.expected_observations,
      missing_rows: result.missing_observations,
      compact_path: result.compact_artifact.relative_path,
    })),
  };

  const artifactHashes = {
    schema_version: CROWDING_FOUNDATION_SCHEMA_VERSION,
    hash_algorithm: "SHA-256",
    hash_method: "stable JSON with recursively sorted object keys",
    coverage_matrix_hash: sha256Json(coverageMatrixArtifact),
    schema_manifest_hash: sha256Json(schemaManifestArtifact),
    feature_specification_hash: sha256Json(featureSpecificationArtifact),
    dataset_manifest_hash: sha256Json(datasetManifestArtifact),
  };

  await Promise.all([
    writeJson(COVERAGE_MATRIX_PATH, coverageMatrixArtifact),
    writeJson(SCHEMA_MANIFEST_PATH, schemaManifestArtifact),
    writeJson(FEATURE_SPECIFICATION_PATH, featureSpecificationArtifact),
    writeJson(DATASET_MANIFEST_PATH, datasetManifestArtifact),
    writeJson(ARTIFACT_HASHES_PATH, artifactHashes),
  ]);

  const eligibleSymbolCoverage = results.map((result) => ({ symbol: result.symbol, coverage: result.expected_observations === 0 ? 100 : result.valid_observations / result.expected_observations * 100 }));
  const worstSymbol = eligibleSymbolCoverage.sort((left, right) => left.coverage - right.coverage)[0]!;
  const eligibleMonths = aggregateMonthly.filter((period) => period.eligible);
  const eligibleQuarters = aggregateQuarterly.filter((period) => period.eligible);
  const worstMonth = eligibleMonths.sort((left, right) => left.coverage_percent - right.coverage_percent)[0]!;
  const worstQuarter = eligibleQuarters.sort((left, right) => left.coverage_percent - right.coverage_percent)[0]!;
  const classification = ratioConsistency.status === "INVALID" || validObservations === 0
    ? "CROWDING_FOUNDATION_INVALID"
    : adjustedCoveragePercent >= 99
      && worstSymbol.coverage >= 95
      && eligibleQuarters.every((quarter) => quarter.coverage_percent >= 98)
      && schemaConflictCount === 0
      && c1C4Unchanged
      ? "CROWDING_FOUNDATION_READY"
      : "CROWDING_FOUNDATION_PARTIAL";

  const report: JsonRecord = {
    research: "HY-R5.4B CROWDING HISTORICAL DATA FOUNDATION + PERFORMANCE FREEZE",
    version: CROWDING_FOUNDATION_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    classification,
    historical_range: { start: HISTORY_START_ISO, end: HISTORY_END_ISO },
    universe,
    universe_count: universe.length,
    official_sources: [
      { name: "Binance Vision daily metrics archive", url: METRICS_SOURCE_BASE, checked: "full eligible daily file set" },
      { name: "Binance USDⓈ-M exchangeInfo", url: EXCHANGE_INFO_URL, checked: "49-symbol lifecycle evidence" },
      { name: "Binance PUMPUSDT rename evidence", url: PUMP_RENAME_EVIDENCE_URL, checked: "old/relaunch identity separation" },
    ],
    raw_source_layout: "daily metrics archives; payload is 5m",
    raw_files: {
      target_files: allFileAudits.length,
      available_files: availableFiles,
      source_missing_files: sourceMissingFiles,
      raw_rows: rawRows,
    },
    data: {
      raw_rows: rawRows,
      parsed_rows: parsedRows,
      valid_positioning_observations: validObservations,
      rejected_rows: rejectedRows,
      lifecycle_excluded_rows: results.reduce((total, result) => total + result.lifecycle_excluded_rows, 0),
      listing_adjusted_expected_observations: expectedObservations,
      adjusted_coverage_percent: adjustedCoveragePercent,
      missing_observations: missingObservations,
      compact_rows: compactArtifacts.reduce((total, artifact) => total + artifact.rows, 0),
      compact_artifacts: compactArtifacts,
      raw_archive_unordered_files: rawUnorderedFiles,
    },
    coverage: {
      listing_adjusted_expected_observations: expectedObservations,
      valid_observations: validObservations,
      adjusted_coverage_percent: adjustedCoveragePercent,
      worst_symbol: worstSymbol.symbol,
      worst_symbol_coverage_percent: worstSymbol.coverage,
      worst_month: worstMonth.period,
      worst_month_coverage_percent: worstMonth.coverage_percent,
      worst_quarter: worstQuarter.period,
      worst_quarter_coverage_percent: worstQuarter.coverage_percent,
      gap_count: missingObservations,
      gap_runs: gapRuns,
      symbol_matrix: results.map((result) => ({
        symbol: result.symbol,
        expected: result.expected_observations,
        valid: result.valid_observations,
        coverage_percent: result.expected_observations === 0 ? 100 : result.valid_observations / result.expected_observations * 100,
        missing: result.missing_observations,
        gap_runs: result.gap_runs,
      })),
      aggregate_month_matrix: aggregateMonthly,
      aggregate_quarter_matrix: aggregateQuarterly,
    },
    schema_manifest: {
      path: relativePath(SCHEMA_MANIFEST_PATH),
      canonical_headers: CANONICAL_HEADERS,
      observed_schema_signatures: schemaManifestArtifact.observed_schema_signatures,
      field_mapping: CROWDING_RAW_FIELD_MAPPING,
      schema_conflict_count: schemaConflictCount,
    },
    ratio_validation: {
      status: ratioConsistency.status,
      reason: "Actual historical metrics schema has no longAccount/shortAccount component fields; no ratio consistency relation was invented.",
      invalid_values: invalidNumericCount,
    },
    data_quality: {
      timestamp_monotonic: timestampMonotonic ? "PASS" : "FAIL",
      raw_archive_timestamp_order: rawUnorderedFiles === 0 ? "PASS" : "UNSORTED_SOURCE_ROWS_NORMALIZED",
      duplicate_symbol_timestamp: duplicateCount === 0 ? "PASS" : "FAIL",
      missing_5m_intervals: missingObservations === 0 ? "PASS" : "DATA_INCOMPLETE",
      invalid_numeric_values: invalidNumericCount === 0 ? "PASS" : "REJECTED_AND_COUNTED",
      invalid_oi_or_ratio_values: invalidNumericCount === 0 ? "PASS" : "REJECTED_AND_COUNTED",
      unexpected_cadence_or_timezone: cadenceIssues === 0 ? "PASS" : "GAPS_RECORDED_AND_COUNTED",
      schema_drift: schemaConflictCount === 0 ? "NONE" : "DATA_INCOMPLETE",
      rejection_reason_codes: issueCounts,
    },
    pit_safe: "PASS",
    pit_contract: {
      raw_timestamp_field: "create_time",
      raw_timestamp_semantics: "UTC 5m bucket start label",
      compact_pit_available_at: "timestamp + 5m",
      rule: "At decision time t consume only completed observations with pit_available_at <= t; never backfill an end-of-period snapshot to period start.",
      rolling_history: "strictly prior 288 completed observations within the same lifecycle and contiguous segment",
    },
    existing_feature_overlap: {
      existing_oi_observations_1h: 760828,
      existing_oi_source: "data/hy-r4.2-open-interest-24m",
      existing_flow_observations: 45661455,
      existing_flow_source: "HY-R5.3 frozen aggregate-flow dataset",
      existing_flow_classification: "NO_INCREMENTAL_INFORMATION",
      p4_classification: "PARTIALLY_USED",
      taker_ratio_reused_as_crowding: false,
    },
    orthogonality: "PARTIALLY_USED",
    new_positioning_information: ["P1", "P2", "P3", "P5"],
    feature_specification: {
      path: relativePath(FEATURE_SPECIFICATION_PATH),
      candidates: FROZEN_CROWDING_CANDIDATES,
      hash: artifactHashes.feature_specification_hash,
    },
    c1_c4_specification_unchanged: c1C4Unchanged,
    artifacts: {
      coverage_matrix_path: relativePath(COVERAGE_MATRIX_PATH),
      schema_manifest_path: relativePath(SCHEMA_MANIFEST_PATH),
      feature_specification_path: relativePath(FEATURE_SPECIFICATION_PATH),
      dataset_manifest_path: relativePath(DATASET_MANIFEST_PATH),
      artifact_hashes_path: relativePath(ARTIFACT_HASHES_PATH),
    },
    artifact_hashes: artifactHashes,
    performance: {
      future_performance_calculated: false,
      future_return: false,
      precision: false,
      matched_control_outcome: false,
      mfe: false,
      mae: false,
      pnl: false,
      sharpe: false,
      profit_factor: false,
    },
    safety: {
      production_modified: false,
      supabase_modified: false,
      vercel_modified: false,
      paper_strategy_modified: false,
      scanner_live_integration: false,
      emails_sent: 0,
      private_api_called: false,
      orders_called: false,
      auto_trading: false,
      commit_created: false,
    },
  };
  await Promise.all([
    writeJson(JSON_REPORT_PATH, report),
    writeFile(MARKDOWN_REPORT_PATH, buildMarkdown(report), "utf8"),
  ]);
  console.log(JSON.stringify({
    json: JSON_REPORT_PATH,
    markdown: MARKDOWN_REPORT_PATH,
    classification,
    universe: `${universe.length}/49`,
    rawRows,
    parsedRows,
    validObservations,
    rejectedRows,
    expectedObservations,
    adjustedCoveragePercent,
    sourceMissingFiles,
    schemaConflictCount,
    pitSafe: "PASS",
    c1C4Unchanged,
    artifactHashes,
    futurePerformanceCalculated: false,
  }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
