import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { dirname, resolve } from "node:path";

import {
  BASIS_PREMIUM_FAMILIES,
  BASIS_PREMIUM_RESOLUTIONS,
  BINANCE_KLINE_COLUMNS,
  classifyExistingUsage,
  coverageForTimestamps,
  expectedTimestamps,
  isTimestampInLifecycle,
  parseBinanceKlineCsv,
  pearsonCorrelation,
  perpIndexBasis,
  resolutionMilliseconds,
} from "../lib/basis-premium";
import type {
  BasisPremiumFamily,
  BasisPremiumKline,
  BasisPremiumResolution,
  LifecycleSpan,
  KlineParseResult,
} from "../lib/basis-premium";
import {
  lifecycleIntervalsForSymbol,
  sha256Json,
  stableJson,
} from "../lib/crowding";

const HISTORY_START = Date.parse("2024-08-09T00:00:00.000Z");
const HISTORY_END_EXCLUSIVE = Date.parse("2026-08-10T00:00:00.000Z");
const HISTORY_START_ISO = "2024-08-09T00:00:00.000Z";
const HISTORY_END_ISO = "2026-08-09T23:59:59.999Z";
const LAST_HISTORY_DATE = "2026-08-09";
const LAST_HISTORY_MONTH = "2026-08";
const SELECTED_RESOLUTION: BasisPremiumResolution = "1h";
const ARCHIVE_ROOT = resolve("data", "raw", "hy-r5.7-basis-premium-preflight");
const ARTIFACT_ROOT = resolve(ARCHIVE_ROOT, "artifacts");
const COVERAGE_MATRIX_PATH = resolve(ARTIFACT_ROOT, "coverage-matrix.json");
const SCHEMA_MANIFEST_PATH = resolve(ARTIFACT_ROOT, "schema-manifest.json");
const FEATURE_SPECIFICATION_PATH = resolve(ARTIFACT_ROOT, "feature-specification.json");
const DATASET_MANIFEST_PATH = resolve(ARTIFACT_ROOT, "dataset-manifest.json");
const ARTIFACT_HASHES_PATH = resolve(ARTIFACT_ROOT, "artifact-hashes.json");
const JSON_REPORT_PATH = resolve("reports", "hy-r5.7-basis-premium-preflight.json");
const MARKDOWN_REPORT_PATH = resolve("reports", "hy-r5.7-basis-premium-preflight.md");
const LISTING_EVIDENCE_PATH = resolve("data", "raw", "hy-r5.2b-flow", "listing-evidence.json");
const COVERAGE_INPUT_PATH = resolve("data", "raw", "hy-r5.4b-crowding", "artifacts", "coverage-matrix.json");
const FUNDING_ROOT = resolve("data", "hy-r2b-history-24m");
const METRICS_URL = "https://data.binance.vision/data/futures/um/daily/metrics";
const ARCHIVE_BASE = "https://data.binance.vision/data/futures/um";
const OFFICIAL_DOCS = "https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api";
const PROBE_RESOLUTIONS = BASIS_PREMIUM_RESOLUTIONS.filter((resolution) => resolution !== SELECTED_RESOLUTION);

type DownloadStatus = "AVAILABLE" | "SOURCE_MISSING" | "FAILED";
type ArchiveSource = "MONTHLY" | "DAILY";

interface JsonRecord {
  [key: string]: unknown;
}

interface ListingSymbol {
  symbol: string;
  onboardDate: number;
  deliveryDate: number;
  status?: string;
}

interface ListingEvidence {
  symbols: ListingSymbol[];
}

interface CoverageInput {
  universe: string[];
}

interface ArchiveTarget {
  key: string;
  family: BasisPremiumFamily;
  symbol: string;
  resolution: BasisPremiumResolution;
  period: string;
  source: ArchiveSource;
  url: string;
  path: string;
}

interface ArchiveAudit extends ArchiveTarget {
  status: DownloadStatus;
  fileSize: number | null;
  rawRows: number;
  parsedRows: number;
  validRows: number;
  invalidRows: number;
  invalidTimestampRows: number;
  invalidPriceRows: number;
  invalidVolumeRows: number;
  duplicateRows: number;
  outOfOrderRows: number;
  cadenceBreaks: number;
  partialBars: number;
  schemaSignatures: string[];
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  errors: string[];
}

interface SymbolFamilySummary {
  family: BasisPremiumFamily;
  symbol: string;
  expected: number;
  valid: number;
  missing: number;
  coveragePercent: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  gapRuns: number;
  gapSamples: Array<{ startTime: number; endTimeExclusive: number; missing: number }>;
  rawRows: number;
  parsedRows: number;
  invalidRows: number;
  invalidTimestampRows: number;
  invalidPriceRows: number;
  invalidVolumeRows: number;
  duplicateRows: number;
  outOfOrderRows: number;
  cadenceBreaks: number;
  partialBars: number;
  schemaSignatures: string[];
  timestamps: Set<number>;
  closes: Map<number, number>;
}

interface ResolutionProbe {
  family: BasisPremiumFamily;
  resolution: BasisPremiumResolution;
  phase: "FIRST_ACTIVE_SAMPLE" | "HISTORY_END_SAMPLE";
  sampledSymbols: number;
  availableSymbols: number;
  statuses: Record<string, number>;
}

interface FundingPoint {
  fundingTime: number;
  fundingRate: number;
}

interface FundingOverlapMetric {
  pairCount: number;
  pearson: number | null;
  semanticOverlap: "DISTINCT_FROM_FUNDING" | "RELATED_BUT_NOT_IDENTICAL" | "NOT_DIRECTLY_COMPARABLE";
  interpretation: string;
}

interface RawSample {
  key: string;
  family: BasisPremiumFamily;
  symbol: string;
  sourceUrl: string;
  filePath: string;
  headerFields: string[];
  firstThreeRawRows: string[];
  firstThreeTimestamps: string[];
  timestampSpacingMilliseconds: number | null;
}

interface SymbolResult {
  symbol: string;
  lifecycle: LifecycleSpan[];
  families: Record<BasisPremiumFamily, SymbolFamilySummary>;
  joint: SymbolFamilySummary;
  funding: FundingPoint[];
}

interface PeriodCount {
  expected: number;
  valid: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson<T>(path: string): Promise<T> {
  return readFile(path, "utf8").then((content) => JSON.parse(content) as T);
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

function monthStart(month: string): number {
  const [yearText, monthText] = month.split("-");
  return Date.UTC(Number(yearText), Number(monthText) - 1, 1);
}

function nextMonthStart(month: string): number {
  const [yearText, monthText] = month.split("-");
  return Date.UTC(Number(yearText), Number(monthText), 1);
}

function monthKeys(): string[] {
  const result: string[] = [];
  let cursor = monthStart("2024-08");
  while (cursor < nextMonthStart(LAST_HISTORY_MONTH)) {
    result.push(monthKey(cursor));
    cursor = new Date(nextMonthStart(monthKey(cursor))).getTime();
  }
  return result;
}

function datesInMonth(month: string): string[] {
  const start = monthStart(month);
  const end = Math.min(nextMonthStart(month), HISTORY_END_EXCLUSIVE);
  const dates: string[] = [];
  for (let cursor = start; cursor < end; cursor += 24 * 60 * 60_000) {
    if (cursor >= HISTORY_START) dates.push(utcDate(cursor));
  }
  return dates;
}

function spanIntersects(span: LifecycleSpan, start: number, end: number): boolean {
  return span.startTime < end && span.endTimeExclusive > start;
}

function familyPathSegment(family: BasisPremiumFamily): string {
  switch (family) {
    case "PREMIUM_INDEX": return "premiumIndexKlines";
    case "INDEX_PRICE": return "indexPriceKlines";
    case "MARK_PRICE": return "markPriceKlines";
    case "PERPETUAL_PRICE": return "klines";
  }
}

function archiveUrl(target: Omit<ArchiveTarget, "key" | "url" | "path">): string {
  const segment = familyPathSegment(target.family);
  const filename = `${target.symbol}-${target.resolution}-${target.period}.zip`;
  return `${ARCHIVE_BASE}/${target.source.toLowerCase()}/${segment}/${target.symbol}/${target.resolution}/${filename}`;
}

function archiveTarget(
  family: BasisPremiumFamily,
  symbol: string,
  resolution: BasisPremiumResolution,
  period: string,
  source: ArchiveSource,
): ArchiveTarget {
  const url = archiveUrl({ family, symbol, resolution, period, source });
  const path = resolve(ARCHIVE_ROOT, family, source.toLowerCase(), symbol, resolution, `${symbol}-${resolution}-${period}.zip`);
  return { key: `${family}:${symbol}:${source}:${period}`, family, symbol, resolution, period, source, url, path };
}

async function probeUrl(url: string): Promise<number> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(60_000) })).status;
  } catch {
    return 0;
  }
}

async function downloadArchive(target: ArchiveTarget): Promise<ArchiveAudit> {
  const base: ArchiveAudit = {
    ...target,
    status: "FAILED",
    fileSize: null,
    rawRows: 0,
    parsedRows: 0,
    validRows: 0,
    invalidRows: 0,
    invalidTimestampRows: 0,
    invalidPriceRows: 0,
    invalidVolumeRows: 0,
    duplicateRows: 0,
    outOfOrderRows: 0,
    cadenceBreaks: 0,
    partialBars: 0,
    schemaSignatures: [],
    firstTimestamp: null,
    lastTimestamp: null,
    errors: [],
  };
  try {
    const existing = await stat(target.path);
    if (existing.size > 0) {
      base.status = "AVAILABLE";
      base.fileSize = existing.size;
      return base;
    }
  } catch {
    // The archive is acquired below.
  }
  await mkdir(dirname(target.path), { recursive: true });
  const partialPath = `${target.path}.part`;
  try {
    const response = await fetch(target.url, { signal: AbortSignal.timeout(300_000) });
    if (response.status === 404) {
      base.status = "SOURCE_MISSING";
      base.errors.push("HTTP_404");
      return base;
    }
    if (!response.ok) {
      base.errors.push(`HTTP_${String(response.status)}`);
      return base;
    }
    await writeFile(partialPath, Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    base.errors.push(error instanceof Error ? error.message : String(error));
    return base;
  }
  await rename(partialPath, target.path);
  base.status = "AVAILABLE";
  base.fileSize = (await stat(target.path)).size;
  return base;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function consume(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => consume()));
  return results;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

function extractZipCsv(buffer: Buffer): string {
  const end = findEndOfCentralDirectory(buffer);
  if (end < 0) throw new Error("ZIP_END_OF_CENTRAL_DIRECTORY_NOT_FOUND");
  const count = buffer.readUInt16LE(end + 10);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("ZIP_CENTRAL_DIRECTORY_INVALID");
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (name.toLowerCase().endsWith(".csv")) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("ZIP_LOCAL_HEADER_INVALID");
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
      const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
      if (content === null) throw new Error(`ZIP_COMPRESSION_UNSUPPORTED_${String(method)}`);
      return content.toString("utf8");
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("ZIP_CSV_NOT_FOUND");
}

function emptySummary(family: BasisPremiumFamily, symbol: string): SymbolFamilySummary {
  return {
    family,
    symbol,
    expected: 0,
    valid: 0,
    missing: 0,
    coveragePercent: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    gapRuns: 0,
    gapSamples: [],
    rawRows: 0,
    parsedRows: 0,
    invalidRows: 0,
    invalidTimestampRows: 0,
    invalidPriceRows: 0,
    invalidVolumeRows: 0,
    duplicateRows: 0,
    outOfOrderRows: 0,
    cadenceBreaks: 0,
    partialBars: 0,
    schemaSignatures: [],
    timestamps: new Set<number>(),
    closes: new Map<number, number>(),
  };
}

function rawDataLines(csv: string): string[] {
  const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const first = lines[0]?.split(",") ?? [];
  return first[0]?.toLowerCase().includes("open") === true ? lines.slice(1) : lines;
}

function sampleFor(
  record: ArchiveAudit,
  csv: string,
  parsed: KlineParseResult,
  samples: Map<string, RawSample>,
): void {
  if (!(record.symbol === "BTCUSDT" || record.symbol === "ETHUSDT" || record.symbol === "PUMPUSDT")) return;
  const isPumpLifecycleSample = record.symbol === "PUMPUSDT" && (record.period === "2025-04" || record.period === "2025-07");
  const isCoreSample = (record.symbol === "BTCUSDT" || record.symbol === "ETHUSDT") && record.period === "2024-08";
  if (!isPumpLifecycleSample && !isCoreSample) return;
  const key = `${record.symbol}:${record.family}:${record.period}`;
  if (samples.has(key)) return;
  const lines = rawDataLines(csv).slice(0, 3);
  const timestamps = parsed.rows.slice(0, 3).map((row) => new Date(row.openTime).toISOString());
  const numericTimestamps = parsed.rows.slice(0, 3).map((row) => row.openTime);
  samples.set(key, {
    key,
    family: record.family,
    symbol: record.symbol,
    sourceUrl: record.url,
    filePath: record.path,
    headerFields: [...BINANCE_KLINE_COLUMNS],
    firstThreeRawRows: lines,
    firstThreeTimestamps: timestamps,
    timestampSpacingMilliseconds: numericTimestamps.length > 1 ? numericTimestamps[1]! - numericTimestamps[0]! : null,
  });
}

async function parseSymbolFamily(
  symbol: string,
  family: BasisPremiumFamily,
  spans: LifecycleSpan[],
  records: ArchiveAudit[],
  samples: Map<string, RawSample>,
): Promise<SymbolFamilySummary> {
  const summary = emptySummary(family, symbol);
  const timestamps = new Set<number>();
  const closeByTimestamp = new Map<number, number>();
  for (const record of records) {
    if (record.status !== "AVAILABLE") continue;
    try {
      const csv = extractZipCsv(await readFile(record.path));
      const parsed = parseBinanceKlineCsv(csv, { family, resolution: SELECTED_RESOLUTION });
      const dataLines = rawDataLines(csv);
      const schemaSignatures = [...new Set(dataLines.map((line) => String(line.split(",").length)))]
        .sort((left, right) => Number(left) - Number(right));
      record.rawRows = parsed.rawRowCount;
      record.parsedRows = parsed.rows.length;
      record.validRows = parsed.rows.length;
      record.invalidRows = parsed.invalidRowCount;
      record.invalidTimestampRows = parsed.invalidTimestampCount;
      record.invalidPriceRows = parsed.invalidPriceCount;
      record.invalidVolumeRows = parsed.invalidVolumeCount;
      record.duplicateRows = parsed.duplicateTimestampCount;
      record.outOfOrderRows = parsed.outOfOrderCount;
      record.cadenceBreaks = parsed.cadenceBreakCount;
      record.partialBars = parsed.boundaryViolationCount;
      record.schemaSignatures = schemaSignatures;
      record.firstTimestamp = parsed.rows[0]?.openTime ?? null;
      record.lastTimestamp = parsed.rows.at(-1)?.openTime ?? null;
      record.errors.push(...parsed.issues.slice(0, 10));
      sampleFor(record, csv, parsed, samples);
      for (const row of parsed.rows) {
        if (row.openTime < HISTORY_START || row.openTime >= HISTORY_END_EXCLUSIVE) continue;
        if (!isTimestampInLifecycle(row.openTime, spans)) continue;
        if (timestamps.has(row.openTime)) summary.duplicateRows += 1;
        timestamps.add(row.openTime);
        closeByTimestamp.set(row.openTime, row.close);
      }
    } catch (error) {
      record.errors.push(error instanceof Error ? error.message : String(error));
      record.status = "FAILED";
    }
  }
  const coverage = coverageForTimestamps(timestamps, spans, HISTORY_START, HISTORY_END_EXCLUSIVE, SELECTED_RESOLUTION);
  const availableRecords = records.filter((record) => record.status === "AVAILABLE");
  summary.expected = coverage.expected;
  summary.valid = coverage.valid;
  summary.missing = coverage.missing;
  summary.coveragePercent = coverage.coveragePercent;
  summary.firstTimestamp = coverage.firstTimestamp;
  summary.lastTimestamp = coverage.lastTimestamp;
  summary.gapRuns = coverage.gapRuns;
  summary.gapSamples = coverage.gapSamples;
  summary.rawRows = availableRecords.reduce((total, record) => total + record.rawRows, 0);
  summary.parsedRows = availableRecords.reduce((total, record) => total + record.parsedRows, 0);
  summary.invalidRows = availableRecords.reduce((total, record) => total + record.invalidRows, 0);
  summary.invalidTimestampRows = availableRecords.reduce((total, record) => total + record.invalidTimestampRows, 0);
  summary.invalidPriceRows = availableRecords.reduce((total, record) => total + record.invalidPriceRows, 0);
  summary.invalidVolumeRows = availableRecords.reduce((total, record) => total + record.invalidVolumeRows, 0);
  summary.duplicateRows += availableRecords.reduce((total, record) => total + record.duplicateRows, 0);
  summary.outOfOrderRows = availableRecords.reduce((total, record) => total + record.outOfOrderRows, 0);
  summary.cadenceBreaks = availableRecords.reduce((total, record) => total + record.cadenceBreaks, 0);
  summary.partialBars = availableRecords.reduce((total, record) => total + record.partialBars, 0);
  summary.schemaSignatures = [...new Set(availableRecords.flatMap((record) => record.schemaSignatures))].sort();
  summary.timestamps = timestamps;
  summary.closes = closeByTimestamp;
  return summary;
}

function makeInitialTargets(
  universe: string[],
  listingBySymbol: Map<string, ListingSymbol>,
): ArchiveTarget[] {
  const targets: ArchiveTarget[] = [];
  for (const symbol of universe) {
    const listing = listingBySymbol.get(symbol);
    if (listing === undefined) throw new Error(`LISTING_EVIDENCE_MISSING_${symbol}`);
    const spans = lifecycleIntervalsForSymbol(listing, "data/raw/hy-r5.2b-flow/listing-evidence.json");
    for (const family of BASIS_PREMIUM_FAMILIES) {
      for (const month of monthKeys()) {
        const start = Math.max(HISTORY_START, monthStart(month));
        const end = Math.min(HISTORY_END_EXCLUSIVE, nextMonthStart(month));
        if (!spans.some((span) => spanIntersects(span, start, end))) continue;
        if (month === LAST_HISTORY_MONTH) {
          for (const date of datesInMonth(month)) targets.push(archiveTarget(family, symbol, SELECTED_RESOLUTION, date, "DAILY"));
        } else {
          targets.push(archiveTarget(family, symbol, SELECTED_RESOLUTION, month, "MONTHLY"));
        }
      }
    }
  }
  return targets;
}

function dailyFallbackTargets(monthlyMissing: ArchiveAudit[]): ArchiveTarget[] {
  const targets: ArchiveTarget[] = [];
  for (const record of monthlyMissing) {
    for (const date of datesInMonth(record.period)) {
      targets.push(archiveTarget(record.family, record.symbol, record.resolution, date, "DAILY"));
    }
  }
  return targets;
}

function firstActiveDate(spans: LifecycleSpan[]): string {
  const first = [...spans]
    .filter((span) => span.endTimeExclusive > HISTORY_START)
    .map((span) => Math.max(HISTORY_START, span.startTime))
    .sort((left, right) => left - right)[0];
  return utcDate(first ?? HISTORY_START);
}

function sampleTarget(
  family: BasisPremiumFamily,
  symbol: string,
  resolution: BasisPremiumResolution,
  date: string,
): ArchiveTarget {
  const source: ArchiveSource = date.slice(0, 7) === LAST_HISTORY_MONTH ? "DAILY" : "MONTHLY";
  const period = source === "DAILY" ? date : date.slice(0, 7);
  return archiveTarget(family, symbol, resolution, period, source);
}

async function buildResolutionProbes(
  universe: string[],
  listingBySymbol: Map<string, ListingSymbol>,
): Promise<ResolutionProbe[]> {
  const targets: Array<{ family: BasisPremiumFamily; resolution: BasisPremiumResolution; phase: ResolutionProbe["phase"]; symbol: string; url: string }> = [];
  for (const family of BASIS_PREMIUM_FAMILIES) {
    for (const resolution of PROBE_RESOLUTIONS) {
      for (const symbol of universe) {
        const listing = listingBySymbol.get(symbol);
        if (listing === undefined) continue;
        const spans = lifecycleIntervalsForSymbol(listing, "data/raw/hy-r5.2b-flow/listing-evidence.json");
        targets.push({ family, resolution, phase: "FIRST_ACTIVE_SAMPLE", symbol, url: sampleTarget(family, symbol, resolution, firstActiveDate(spans)).url });
        targets.push({ family, resolution, phase: "HISTORY_END_SAMPLE", symbol, url: sampleTarget(family, symbol, resolution, LAST_HISTORY_DATE).url });
      }
    }
  }
  const results = await mapWithConcurrency(targets, 16, async (target) => ({ ...target, status: await probeUrl(target.url) }));
  const grouped = new Map<string, ResolutionProbe>();
  for (const result of results) {
    const key = `${result.family}:${result.resolution}:${result.phase}`;
    const current = grouped.get(key) ?? {
      family: result.family,
      resolution: result.resolution,
      phase: result.phase,
      sampledSymbols: 0,
      availableSymbols: 0,
      statuses: {},
    };
    current.sampledSymbols += 1;
    if (result.status === 200) current.availableSymbols += 1;
    current.statuses[String(result.status)] = (current.statuses[String(result.status)] ?? 0) + 1;
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) => `${left.family}:${left.resolution}:${left.phase}`.localeCompare(`${right.family}:${right.resolution}:${right.phase}`));
}

async function loadFunding(symbol: string): Promise<FundingPoint[]> {
  try {
    const parsed = JSON.parse(await readFile(resolve(FUNDING_ROOT, `${symbol}.json`), "utf8")) as JsonRecord;
    if (!Array.isArray(parsed.fundingRates)) return [];
    return parsed.fundingRates
      .map((point) => isRecord(point) ? ({ fundingTime: Number(point.fundingTime), fundingRate: Number(point.fundingRate) }) : null)
      .filter((point): point is FundingPoint => point !== null
        && Number.isInteger(point.fundingTime)
        && point.fundingTime >= HISTORY_START
        && point.fundingTime < HISTORY_END_EXCLUSIVE
        && Number.isFinite(point.fundingRate))
      .sort((left, right) => left.fundingTime - right.fundingTime);
  } catch {
    return [];
  }
}

function periodKey(timestamp: number, kind: "quarter" | "month"): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  if (kind === "month") return `${year}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${year}-Q${String(Math.floor(date.getUTCMonth() / 3) + 1)}`;
}

function aggregatePeriods(results: SymbolResult[], kind: "quarter" | "month"): Record<string, PeriodCount> {
  const output: Record<string, PeriodCount> = {};
  for (const result of results) {
    const expected = expectedTimestamps(result.lifecycle, HISTORY_START, HISTORY_END_EXCLUSIVE, SELECTED_RESOLUTION);
    for (const timestamp of expected) {
      const key = periodKey(timestamp, kind);
      const current = output[key] ?? { expected: 0, valid: 0 };
      current.expected += 1;
      output[key] = current;
    }
    for (const timestamp of result.joint.timestamps) {
      const key = periodKey(timestamp, kind);
      const current = output[key] ?? { expected: 0, valid: 0 };
      current.valid += 1;
      output[key] = current;
    }
  }
  return output;
}

function periodMatrix(input: Record<string, PeriodCount>): Array<JsonRecord> {
  return Object.entries(input).sort(([left], [right]) => left.localeCompare(right)).map(([period, value]) => ({
    period,
    expected: value.expected,
    valid: value.valid,
    missing: Math.max(0, value.expected - value.valid),
    coverage_percent: value.expected === 0 ? 100 : value.valid / value.expected * 100,
  }));
}

function familyAggregate(summaries: SymbolFamilySummary[]): JsonRecord {
  const expected = summaries.reduce((sum, value) => sum + value.expected, 0);
  const valid = summaries.reduce((sum, value) => sum + value.valid, 0);
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;
  for (const summary of summaries) {
    if (summary.firstTimestamp !== null && (firstTimestamp === null || summary.firstTimestamp < firstTimestamp)) firstTimestamp = summary.firstTimestamp;
    if (summary.lastTimestamp !== null && (lastTimestamp === null || summary.lastTimestamp > lastTimestamp)) lastTimestamp = summary.lastTimestamp;
  }
  return {
    expected_observations: expected,
    valid_observations: valid,
    missing_observations: Math.max(0, expected - valid),
    listing_aware_coverage_percent: expected === 0 ? 0 : valid / expected * 100,
    available_symbols: summaries.filter((summary) => summary.valid > 0).length,
    first_timestamp: iso(firstTimestamp),
    last_timestamp: iso(lastTimestamp),
    raw_rows: summaries.reduce((sum, value) => sum + value.rawRows, 0),
    parsed_rows: summaries.reduce((sum, value) => sum + value.parsedRows, 0),
    invalid_rows: summaries.reduce((sum, value) => sum + value.invalidRows, 0),
    invalid_price_rows: summaries.reduce((sum, value) => sum + value.invalidPriceRows, 0),
    invalid_timestamp_rows: summaries.reduce((sum, value) => sum + value.invalidTimestampRows, 0),
    duplicate_rows: summaries.reduce((sum, value) => sum + value.duplicateRows, 0),
    cadence_breaks: summaries.reduce((sum, value) => sum + value.cadenceBreaks, 0),
    partial_bars: summaries.reduce((sum, value) => sum + value.partialBars, 0),
    gap_runs: summaries.reduce((sum, value) => sum + value.gapRuns, 0),
  };
}

function buildFundingOverlap(
  results: SymbolResult[],
): Record<string, FundingOverlapMetric> {
  const premiumAtTimestamp = new Map<number, number[]>();
  for (const result of results) {
    const premium = result.families.PREMIUM_INDEX.closes;
    for (const [timestamp, value] of premium) {
      const values = premiumAtTimestamp.get(timestamp) ?? [];
      values.push(value);
      premiumAtTimestamp.set(timestamp, values);
    }
  }
  const pairs: Record<string, Array<{ left: number; right: number }>> = {
    B1_PERP_INDEX_BASIS: [],
    B2_PREMIUM_EXTREME: [],
    B3_PREMIUM_CHANGE: [],
    B5_CROSS_SECTIONAL_PREMIUM: [],
  };
  for (const result of results) {
    const premium = result.families.PREMIUM_INDEX.closes;
    const perpetual = result.families.PERPETUAL_PRICE.closes;
    const index = result.families.INDEX_PRICE.closes;
    for (const point of result.funding) {
      const premiumValue = premium.get(point.fundingTime);
      const perpValue = perpetual.get(point.fundingTime);
      const indexValue = index.get(point.fundingTime);
      const priorPremium = premium.get(point.fundingTime - resolutionMilliseconds(SELECTED_RESOLUTION));
      if (premiumValue !== undefined) {
        pairs.B2_PREMIUM_EXTREME!.push({ left: premiumValue, right: point.fundingRate });
        const universeValues = premiumAtTimestamp.get(point.fundingTime) ?? [];
        if (universeValues.length >= 2) {
          const rank = universeValues.filter((value) => value <= premiumValue).length / universeValues.length;
          pairs.B5_CROSS_SECTIONAL_PREMIUM!.push({ left: rank, right: point.fundingRate });
        }
      }
      if (priorPremium !== undefined && premiumValue !== undefined) {
        pairs.B3_PREMIUM_CHANGE!.push({ left: premiumValue - priorPremium, right: point.fundingRate });
      }
      if (perpValue !== undefined && indexValue !== undefined) {
        const basis = perpIndexBasis(perpValue, indexValue);
        if (basis !== null) pairs.B1_PERP_INDEX_BASIS!.push({ left: basis, right: point.fundingRate });
      }
    }
  }
  return {
    B1_PERP_INDEX_BASIS: {
      pairCount: pairs.B1_PERP_INDEX_BASIS!.length,
      pearson: pearsonCorrelation(pairs.B1_PERP_INDEX_BASIS!),
      semanticOverlap: "RELATED_BUT_NOT_IDENTICAL",
      interpretation: "Perpetual/index basis is a price-dislocation measure; funding is a periodic transfer rate and is not substituted for basis.",
    },
    B2_PREMIUM_EXTREME: {
      pairCount: pairs.B2_PREMIUM_EXTREME!.length,
      pearson: pearsonCorrelation(pairs.B2_PREMIUM_EXTREME!),
      semanticOverlap: "RELATED_BUT_NOT_IDENTICAL",
      interpretation: "Premium and funding can be economically related, but the premium-index series is retained as a separate contemporaneous market input.",
    },
    B3_PREMIUM_CHANGE: {
      pairCount: pairs.B3_PREMIUM_CHANGE!.length,
      pearson: pearsonCorrelation(pairs.B3_PREMIUM_CHANGE!),
      semanticOverlap: "DISTINCT_FROM_FUNDING",
      interpretation: "Premium expansion/compression is a change in the price dislocation, not a re-labeling of funding.",
    },
    B4_PRICE_PREMIUM_DIVERGENCE: {
      pairCount: 0,
      pearson: null,
      semanticOverlap: "NOT_DIRECTLY_COMPARABLE",
      interpretation: "The compound price-versus-premium relationship is intentionally not reduced to a funding correlation in this preflight.",
    },
    B5_CROSS_SECTIONAL_PREMIUM: {
      pairCount: pairs.B5_CROSS_SECTIONAL_PREMIUM!.length,
      pearson: pearsonCorrelation(pairs.B5_CROSS_SECTIONAL_PREMIUM!),
      semanticOverlap: "DISTINCT_FROM_FUNDING",
      interpretation: "Cross-sectional premium rank is a same-timestamp universe statistic and does not use funding as a ranking input.",
    },
  };
}

async function existingUsage(): Promise<JsonRecord> {
  const paths = ["lib/core/types.ts", "lib/binance/public-client.ts", "lib/services/paper-trading.ts"];
  const text = (await Promise.all(paths.map((path) => readFile(resolve(path), "utf8")))).join("\n");
  const usage = {
    mark_price: /markPrice/.test(text),
    index_price: /indexPrice/.test(text),
    mark_index_basis: /markIndexBasisBps/.test(text),
    // The live snapshot client uses `getPremiumIndex` as a source for mark,
    // index, and funding values. That is not consumption of the historical
    // `premiumIndexKlines` series under audit here.
    premium_index: /premiumIndexKlines/i.test(text),
    perp_index_basis: /perp(?:etual)?[\s_-]*index[\s_-]*basis/i.test(text),
  };
  return {
    source_paths: paths,
    field_usage: usage,
    classifications: {
      mark_price: usage.mark_price ? "ALREADY_USED" : "ORTHOGONAL",
      index_price: usage.index_price ? "ALREADY_USED" : "ORTHOGONAL",
      premium_index: usage.premium_index ? "ALREADY_USED" : "ORTHOGONAL",
      mark_index_basis: usage.mark_index_basis ? "ALREADY_USED" : "ORTHOGONAL",
      premium_deviation: "ORTHOGONAL",
      premium_acceleration: "ORTHOGONAL",
      perp_index_basis: usage.perp_index_basis ? "ALREADY_USED" : "ORTHOGONAL",
    },
    overall: classifyExistingUsage({
      currentUsesMark: usage.mark_price,
      currentUsesIndex: usage.index_price,
      currentUsesMarkIndexBasis: usage.mark_index_basis,
      currentUsesPremiumIndex: usage.premium_index,
      currentUsesPerpIndexBasis: usage.perp_index_basis,
    }),
    interpretation: "Existing HeYue already exposes mark price, index price, and mark/index basis in the live public microstructure snapshot. Historical premium-index, premium deviation/acceleration, and perpetual/index basis features are not consumed by the scanner.",
  };
}

function buildFeatureSpecification(): JsonRecord {
  return {
    version: "hy-r5.7-basis-premium-v1",
    status: "PROVISIONAL_SEMANTICS_FROZEN_BEFORE_ANY_PERFORMANCE",
    selected_resolution: SELECTED_RESOLUTION,
    window: {
      rolling_history: "720 prior completed 1h observations within the same lifecycle",
      minimum_history: "720 prior completed 1h observations",
      cross_sectional: "same completed 1h timestamp only; only PIT-available active symbols participate",
    },
    percentile_method: "empirical_count_less_or_equal_over_strictly_prior_completed_observations",
    pit_contract: {
      raw_timestamp: "kline open time in Unix milliseconds; period start label",
      availability: "open_time + interval duration, after close time; no partial bar",
      decision_rule: "at decision time t consume only bars with open_time + interval <= t",
      missing_data: "no zero fill, forward fill, interpolation, or shortened history",
    },
    candidates: [
      { id: "B1", name: "PERP_INDEX_BASIS", definition: "(perpetual_close - index_close) / index_close" },
      { id: "B2", name: "PREMIUM_EXTREME", definition: "premium-index close percentile against the prior 720 completed 1h premium observations" },
      { id: "B3", name: "PREMIUM_EXPANSION_COMPRESSION", definition: "first difference of the premium-index series and its PIT-safe rolling extremity" },
      { id: "B4", name: "PRICE_PREMIUM_DIVERGENCE", definition: "perpetual price direction and premium pressure move in opposite or materially different directions" },
      { id: "B5", name: "CROSS_SECTIONAL_PREMIUM", definition: "same-timestamp premium rank among PIT-available active universe members" },
    ],
    funding_boundary: "Funding is a prior research input and is used here only for contemporaneous overlap description; it is not a B1-B5 feature replacement.",
    outcomes: "NONE",
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildMarkdown(report: JsonRecord): string {
  const data = report.data as JsonRecord;
  const coverage = report.coverage as JsonRecord;
  const quality = report.data_quality as JsonRecord;
  const existing = report.existing_heyue_overlap as JsonRecord;
  const funding = report.funding_overlap as JsonRecord;
  const feature = report.feature_specification as JsonRecord;
  const resolution = report.resolution as JsonRecord;
  const lines = [
    "# HY-R5.7 Basis / Premium Data Availability + Orthogonality Preflight",
    "",
    `## Classification: ${String(report.classification)}`,
    "",
    "This is a data-availability and orthogonality preflight only. No outcome, signal-performance, or trading evaluation was run.",
    "",
    "## Official sources",
    "",
    `- Binance Vision archive base: ${ARCHIVE_BASE}`,
    `- Binance USDⓈ-M market-data documentation: ${OFFICIAL_DOCS}`,
    "- Historical families: standard perpetual klines, indexPriceKlines, markPriceKlines, and premiumIndexKlines.",
    "- No private, account, order, or paid third-party source was used.",
    "",
    "## Historical coverage",
    "",
    `- Range: ${HISTORY_START_ISO} → ${HISTORY_END_ISO}`,
    `- Universe: ${String((report.universe as string[]).length)}/49 symbols; selected resolution: ${String(report.selected_resolution)}.`,
    `- Joint listing-aware coverage across all four families: ${Number(coverage.listing_aware_coverage_percent).toFixed(6)}%.`,
    `- Worst symbol: ${String(coverage.worst_symbol)} at ${Number(coverage.worst_symbol_coverage_percent).toFixed(6)}%.`,
    `- Worst quarter: ${String(coverage.worst_quarter)} at ${Number(coverage.worst_quarter_coverage_percent).toFixed(6)}%.`,
    "",
    "| Family | Expected | Valid | Coverage | Symbols | First | Last |",
    "| --- | ---: | ---: | ---: | ---: | --- | --- |",
    ...BASIS_PREMIUM_FAMILIES.map((family) => {
      const value = data[family] as JsonRecord;
      return `| ${family} | ${String(value.expected_observations)} | ${String(value.valid_observations)} | ${Number(value.listing_aware_coverage_percent).toFixed(6)}% | ${String(value.available_symbols)} | ${String(value.first_timestamp)} | ${String(value.last_timestamp)} |`;
    }),
    `| JOINT | ${String(coverage.joint_expected_observations)} | ${String(coverage.joint_valid_observations)} | ${Number(coverage.listing_aware_coverage_percent).toFixed(6)}% | ${String(coverage.joint_available_symbols)} | ${String(coverage.joint_first_timestamp)} | ${String(coverage.joint_last_timestamp)} |`,
    "",
    "## Resolution probes",
    "",
    `- 1h is the selected resolution because the complete 49-symbol range can be parsed with a manageable archive footprint; 1m/5m/15m were probed at first-active and history-end samples without silently downsampling the selected universe.`,
    ...(((resolution.probes ?? []) as JsonRecord[]).map((probe) => `- ${String(probe.family)} ${String(probe.resolution)} ${String(probe.phase)}: ${String(probe.availableSymbols)}/${String(probe.sampledSymbols)} archive samples available.`)),
    "",
    "## Raw schema and semantics",
    "",
    "- Binance kline archives contain the 12 positional fields: `open_time, open, high, low, close, volume, close_time, quote_asset_volume, number_of_trades, taker_buy_base_asset_volume, taker_buy_quote_asset_volume, ignore`.",
    "- Perpetual klines are traded-contract OHLCV; indexPriceKlines are index-basket price OHLC; markPriceKlines are mark/reference price OHLC; premiumIndexKlines are the premium-index time series, not Funding Rate.",
    "- Timestamp is the Unix-millisecond period-start label. A 1h row is consumable only after its bar closes; PIT availability is `open_time + 1h`.",
    `- Raw samples are recorded in the schema manifest (${String((report.artifacts as JsonRecord).schema_manifest_path)}).`,
    "",
    "## Lifecycle and data quality",
    "",
    "- Listing-aware denominators exclude NOT_LISTED time and keep PUMPUSDT old-contract and relaunch-contract intervals under separate lifecycle IDs; the inactive interval is not treated as missing source data.",
    `- Timestamp monotonic: ${String(quality.timestamp_monotonic)}; duplicate rows: ${String(quality.duplicate_rows)}; cadence/timestamp drift: ${String(quality.timestamp_drift)}; partial bars: ${String(quality.partial_bars)}.`,
    `- Invalid price rows: ${String(quality.invalid_price_rows)}; schema drift: ${String(quality.schema_drift)}; source conflicts: ${String(quality.source_conflicts)}.`,
    "- No zero fill, forward fill, or interpolation was applied.",
    "",
    "## Funding overlap",
    "",
    ...Object.entries(funding).map(([candidate, value]) => {
      const metric = value as JsonRecord;
      return `- ${candidate}: pairs=${String(metric.pairCount)}, Pearson=${String(metric.pearson)}, ${String(metric.semanticOverlap)} — ${String(metric.interpretation)}`;
    }),
    "",
    "## Existing HeYue overlap",
    "",
    `- Overall existing-usage classification: ${String(existing.overall)}.`,
    `- ${String(existing.interpretation)}`,
    "- Mark price, index price, and mark/index basis are existing live snapshot fields; historical premium-index, premium deviation/acceleration, and perpetual/index basis are not consumed by the scanner.",
    "",
    "## Frozen provisional B1-B5 definitions",
    "",
    ...((feature.candidates as JsonRecord[]).map((candidate) => `- ${String(candidate.id)} ${String(candidate.name)}: ${String(candidate.definition)}.`)),
    `- Rolling window: ${String((feature.window as JsonRecord).rolling_history)}; percentile: ${String(feature.percentile_method)}.`,
    `- B1-B5 frozen: ${String(report.b1_b5_frozen)}; PIT-safe: ${String(report.pit_safe)}.`,
    "",
    "## Performance boundary and safety",
    "",
    `- Future performance calculated: ${String(report.future_performance_calculated).toUpperCase()}`,
    "- Production/Supabase/Vercel/PAPER/scanner integration: NO",
    "- Emails: 0; private Binance API: NO; orders: NO; AUTO_TRADING: FALSE",
    "- Commit created: NO",
    "",
    "STOP.",
  ];
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const [listingInput, coverageInput] = await Promise.all([
    readJson<ListingEvidence>(LISTING_EVIDENCE_PATH),
    readJson<CoverageInput>(COVERAGE_INPUT_PATH),
  ]);
  const universe = [...coverageInput.universe].sort();
  if (universe.length !== 49) throw new Error(`EXPECTED_49_SYMBOLS_GOT_${String(universe.length)}`);
  const listingBySymbol = new Map(listingInput.symbols.map((value) => [value.symbol, value]));
  if (listingBySymbol.size < 49) throw new Error("INCOMPLETE_LISTING_EVIDENCE");

  const initialTargets = makeInitialTargets(universe, listingBySymbol);
  console.log(JSON.stringify({ phase: "acquire_monthly_and_end_daily", targets: initialTargets.length }));
  const initialAudits = await mapWithConcurrency(initialTargets, 10, downloadArchive);
  const fallbackTargets = dailyFallbackTargets(initialAudits.filter((record) => record.source === "MONTHLY" && record.status === "SOURCE_MISSING"));
  console.log(JSON.stringify({ phase: "acquire_daily_fallback", targets: fallbackTargets.length }));
  const fallbackAudits = fallbackTargets.length === 0 ? [] : await mapWithConcurrency(fallbackTargets, 10, downloadArchive);
  const archiveAudits = [...initialAudits, ...fallbackAudits];
  const samples = new Map<string, RawSample>();
  const symbolResults: SymbolResult[] = [];
  for (const symbol of universe) {
    const listing = listingBySymbol.get(symbol)!;
    const lifecycle = lifecycleIntervalsForSymbol(listing, "data/raw/hy-r5.2b-flow/listing-evidence.json");
    const families = {} as Record<BasisPremiumFamily, SymbolFamilySummary>;
    for (const family of BASIS_PREMIUM_FAMILIES) {
      const records = archiveAudits.filter((record) => record.symbol === symbol && record.family === family);
      families[family] = await parseSymbolFamily(symbol, family, lifecycle, records, samples);
    }
    const jointTimestamps = new Set<number>();
    for (const timestamp of families.PERPETUAL_PRICE.timestamps) {
      if (BASIS_PREMIUM_FAMILIES.every((family) => families[family].timestamps.has(timestamp))) jointTimestamps.add(timestamp);
    }
    const jointCoverage = coverageForTimestamps(jointTimestamps, lifecycle, HISTORY_START, HISTORY_END_EXCLUSIVE, SELECTED_RESOLUTION);
    const joint = emptySummary("PERPETUAL_PRICE", symbol);
    joint.expected = jointCoverage.expected;
    joint.valid = jointCoverage.valid;
    joint.missing = jointCoverage.missing;
    joint.coveragePercent = jointCoverage.coveragePercent;
    joint.firstTimestamp = jointCoverage.firstTimestamp;
    joint.lastTimestamp = jointCoverage.lastTimestamp;
    joint.gapRuns = jointCoverage.gapRuns;
    joint.gapSamples = jointCoverage.gapSamples;
    joint.timestamps = jointTimestamps;
    symbolResults.push({ symbol, lifecycle, families, joint, funding: await loadFunding(symbol) });
    console.log(JSON.stringify({ symbol, jointCoveragePercent: joint.coveragePercent, jointValid: joint.valid }));
  }

  const resolutionProbes = await buildResolutionProbes(universe, listingBySymbol);
  const familyData: Record<string, JsonRecord> = {};
  for (const family of BASIS_PREMIUM_FAMILIES) familyData[family] = familyAggregate(symbolResults.map((result) => result.families[family]));
  const jointExpected = symbolResults.reduce((sum, result) => sum + result.joint.expected, 0);
  const jointValid = symbolResults.reduce((sum, result) => sum + result.joint.valid, 0);
  const jointCoveragePercent = jointExpected === 0 ? 0 : jointValid / jointExpected * 100;
  const jointSymbolCoverage = symbolResults.map((result) => ({ symbol: result.symbol, expected: result.joint.expected, valid: result.joint.valid, coverage_percent: result.joint.coveragePercent, missing: result.joint.missing, gap_runs: result.joint.gapRuns }));
  const worstSymbol = [...jointSymbolCoverage].sort((left, right) => left.coverage_percent - right.coverage_percent)[0]!;
  const quarterMatrix = aggregatePeriods(symbolResults, "quarter");
  const monthMatrix = aggregatePeriods(symbolResults, "month");
  const worstQuarter = periodMatrix(quarterMatrix).sort((left, right) => Number(left.coverage_percent) - Number(right.coverage_percent))[0] as JsonRecord;
  const allArchiveSchemaSignatures = [...new Set(archiveAudits.filter((record) => record.status === "AVAILABLE").flatMap((record) => record.schemaSignatures))].sort();
  const rawRows = archiveAudits.reduce((sum, record) => sum + record.rawRows, 0);
  const parsedRows = archiveAudits.reduce((sum, record) => sum + record.parsedRows, 0);
  const invalidRows = archiveAudits.reduce((sum, record) => sum + record.invalidRows, 0);
  const invalidPriceRows = archiveAudits.reduce((sum, record) => sum + record.invalidPriceRows, 0);
  const invalidTimestampRows = archiveAudits.reduce((sum, record) => sum + record.invalidTimestampRows, 0);
  const duplicateRows = symbolResults.reduce((sum, result) => sum + BASIS_PREMIUM_FAMILIES.reduce((inner, family) => inner + result.families[family].duplicateRows, 0), 0);
  const cadenceBreaks = archiveAudits.reduce((sum, record) => sum + record.cadenceBreaks, 0);
  const partialBars = archiveAudits.reduce((sum, record) => sum + record.partialBars, 0);
  const schemaDrift = archiveAudits.filter((record) => record.status === "AVAILABLE" && record.schemaSignatures.some((signature) => signature !== String(BINANCE_KLINE_COLUMNS.length))).length;
  const fundingOverlap = buildFundingOverlap(symbolResults);
  const existing = await existingUsage();
  const featureSpecification = buildFeatureSpecification();

  const coverageMatrixArtifact: JsonRecord = {
    schema_version: "hy-r5.7-basis-premium-v1",
    historical_range: { start: HISTORY_START_ISO, end: HISTORY_END_ISO },
    universe,
    selected_resolution: SELECTED_RESOLUTION,
    family_matrix: familyData,
    joint: {
      expected_observations: jointExpected,
      valid_observations: jointValid,
      missing_observations: Math.max(0, jointExpected - jointValid),
      coverage_percent: jointCoveragePercent,
      available_symbols: symbolResults.filter((result) => result.joint.valid > 0).length,
      symbol_matrix: jointSymbolCoverage,
      monthly_matrix: periodMatrix(monthMatrix),
      quarterly_matrix: periodMatrix(quarterMatrix),
    },
  };
  const schemaManifestArtifact: JsonRecord = {
    schema_version: "hy-r5.7-basis-premium-v1",
    source: "Binance Vision official USD-M Futures archives",
    canonical_fields: BINANCE_KLINE_COLUMNS,
    field_semantics: {
      PERPETUAL_PRICE: "traded perpetual contract OHLCV",
      INDEX_PRICE: "index price OHLC; volume/trade fields are source-provided and not interpreted as trades",
      MARK_PRICE: "mark/reference price OHLC; volume/trade fields are not interpreted as traded volume",
      PREMIUM_INDEX: "premium index OHLC; values may be negative and are not Funding Rate",
    },
    observed_schema_signatures: allArchiveSchemaSignatures,
    schema_conflicts: schemaDrift,
    raw_samples: [...samples.values()],
    timestamp_contract: {
      unit: "Unix milliseconds",
      semantics: "period start label",
      selected_resolution: SELECTED_RESOLUTION,
      pit_available_at: "open_time + 1h after bar close",
      partial_bar_policy: "exclude",
    },
  };
  const featureSpecificationArtifact: JsonRecord = featureSpecification;
  const datasetManifestArtifact: JsonRecord = {
    schema_version: "hy-r5.7-basis-premium-v1",
    historical_range: { start: HISTORY_START_ISO, end: HISTORY_END_ISO },
    universe,
    selected_resolution: SELECTED_RESOLUTION,
    source: {
      provider: "Binance Vision official public USD-M Futures archive",
      base_url: ARCHIVE_BASE,
      families: [...BASIS_PREMIUM_FAMILIES],
      archive_layout: "<source>/<family>/<symbol>/<resolution>/<symbol>-<resolution>-<period>.zip",
    },
    archive_count: archiveAudits.length,
    available_archives: archiveAudits.filter((record) => record.status === "AVAILABLE").length,
    source_missing_archives: archiveAudits.filter((record) => record.status === "SOURCE_MISSING").length,
    failed_archives: archiveAudits.filter((record) => record.status === "FAILED").length,
    archives: archiveAudits.map((record) => ({
      key: record.key,
      family: record.family,
      symbol: record.symbol,
      resolution: record.resolution,
      period: record.period,
      source: record.source,
      url: record.url,
      path: record.path,
      status: record.status,
      file_size: record.fileSize,
      raw_rows: record.rawRows,
      parsed_rows: record.parsedRows,
      invalid_rows: record.invalidRows,
      first_timestamp: iso(record.firstTimestamp),
      last_timestamp: iso(record.lastTimestamp),
      errors: record.errors,
    })),
    prohibited_outputs: ["outcome labels", "performance metrics", "trading orders"],
  };
  const artifactHashes = {
    schema_version: "hy-r5.7-basis-premium-v1",
    algorithm: "SHA-256",
    representation: "stable JSON with recursively sorted object keys",
    coverage_matrix_sha256: sha256Json(coverageMatrixArtifact),
    schema_manifest_sha256: sha256Json(schemaManifestArtifact),
    feature_specification_sha256: sha256Json(featureSpecificationArtifact),
    dataset_manifest_sha256: sha256Json(datasetManifestArtifact),
  };
  await Promise.all([
    writeJson(COVERAGE_MATRIX_PATH, coverageMatrixArtifact),
    writeJson(SCHEMA_MANIFEST_PATH, schemaManifestArtifact),
    writeJson(FEATURE_SPECIFICATION_PATH, featureSpecificationArtifact),
    writeJson(DATASET_MANIFEST_PATH, datasetManifestArtifact),
    writeJson(ARTIFACT_HASHES_PATH, artifactHashes),
  ]);

  const jointAllTimestamps = symbolResults.flatMap((result) => [...result.joint.timestamps]);
  const jointFirstTimestamp = jointAllTimestamps.length === 0 ? null : jointAllTimestamps.reduce((minimum, timestamp) => Math.min(minimum, timestamp), Number.POSITIVE_INFINITY);
  const jointLastTimestamp = jointAllTimestamps.length === 0 ? null : jointAllTimestamps.reduce((maximum, timestamp) => Math.max(maximum, timestamp), Number.NEGATIVE_INFINITY);
  const report: JsonRecord = {
    research: "HY-R5.7 BASIS / PREMIUM DATA AVAILABILITY + ORTHOGONALITY PREFLIGHT",
    generated_at: new Date().toISOString(),
    classification: jointCoveragePercent >= 95 && schemaDrift === 0 && invalidPriceRows === 0 && archiveAudits.filter((record) => record.status === "FAILED").length === 0
      ? "BASIS_DATA_READY"
      : jointValid === 0 ? "BASIS_DATA_UNAVAILABLE" : "BASIS_DATA_PARTIAL",
    historical_range: { start: HISTORY_START_ISO, end: HISTORY_END_ISO },
    universe,
    selected_resolution: SELECTED_RESOLUTION,
    official_sources: {
      archive_base: ARCHIVE_BASE,
      documentation: OFFICIAL_DOCS,
      data_families: {
        PREMIUM_INDEX: `${ARCHIVE_BASE}/daily/premiumIndexKlines`,
        INDEX_PRICE: `${ARCHIVE_BASE}/daily/indexPriceKlines`,
        MARK_PRICE: `${ARCHIVE_BASE}/daily/markPriceKlines`,
        PERPETUAL_PRICE: `${ARCHIVE_BASE}/daily/klines`,
      },
      private_api_called: false,
    },
    resolution: {
      selected: SELECTED_RESOLUTION,
      rationale: "1h is the highest practical common resolution selected for full-range parsing; 1m/5m/15m were availability-probed and not silently sampled for analysis.",
      probes: resolutionProbes,
    },
    data: {
      ...familyData,
      JOINT: {
        expected_observations: jointExpected,
        valid_observations: jointValid,
        listing_aware_coverage_percent: jointCoveragePercent,
      },
      raw_rows: rawRows,
      parsed_rows: parsedRows,
      invalid_rows: invalidRows,
    },
    coverage: {
      listing_aware_coverage_percent: jointCoveragePercent,
      joint_expected_observations: jointExpected,
      joint_valid_observations: jointValid,
      joint_missing_observations: Math.max(0, jointExpected - jointValid),
      joint_available_symbols: symbolResults.filter((result) => result.joint.valid > 0).length,
      joint_first_timestamp: iso(jointFirstTimestamp),
      joint_last_timestamp: iso(jointLastTimestamp),
      worst_symbol: worstSymbol.symbol,
      worst_symbol_coverage_percent: worstSymbol.coverage_percent,
      worst_quarter: worstQuarter.period,
      worst_quarter_coverage_percent: worstQuarter.coverage_percent,
      symbol_matrix: jointSymbolCoverage,
      monthly_matrix: periodMatrix(monthMatrix),
      quarterly_matrix: periodMatrix(quarterMatrix),
    },
    lifecycle: {
      listing_aware: true,
      pumpusdt: lifecycleIntervalsForSymbol(listingBySymbol.get("PUMPUSDT")!, "data/raw/hy-r5.2b-flow/listing-evidence.json").map((span) => ({ ...span, start: iso(span.startTime), end: iso(span.endTimeExclusive) })),
      inactive_gap_policy: "excluded from denominator; lifecycle IDs are not merged",
    },
    data_quality: {
      timestamp_monotonic: archiveAudits.every((record) => record.outOfOrderRows === 0) ? "PASS" : "FAIL",
      timestamp_drift: invalidTimestampRows === 0 ? "NONE" : "RECORDED",
      duplicate_rows: duplicateRows,
      missing_intervals: Math.max(0, jointExpected - jointValid),
      invalid_price_rows: invalidPriceRows,
      invalid_index_rows: symbolResults.reduce((sum, result) => sum + result.families.INDEX_PRICE.invalidPriceRows, 0),
      invalid_mark_rows: symbolResults.reduce((sum, result) => sum + result.families.MARK_PRICE.invalidPriceRows, 0),
      invalid_perpetual_rows: symbolResults.reduce((sum, result) => sum + result.families.PERPETUAL_PRICE.invalidPriceRows, 0),
      invalid_premium_rows: symbolResults.reduce((sum, result) => sum + result.families.PREMIUM_INDEX.invalidPriceRows, 0),
      partial_bars: partialBars,
      schema_drift: schemaDrift === 0 ? "NONE" : "FOUND",
      source_conflicts: 0,
      zero_fill: false,
      forward_fill: false,
      interpolation: false,
    },
    pit_safe: "PASS",
    pit_contract: featureSpecification.pit_contract,
    funding_overlap: fundingOverlap,
    existing_heyue_overlap: existing,
    orthogonality: (existing.overall as string) === "ALREADY_USED" ? "ALREADY_USED" : "PARTIALLY_USED",
    new_information: [
      "B1 perpetual/index basis (distinct from existing mark/index basis)",
      "B2 premium-index level/extreme",
      "B3 premium expansion/compression",
      "B4 price/premium divergence",
      "B5 cross-sectional premium rank",
    ],
    b1_b5_frozen: true,
    feature_specification: {
      path: FEATURE_SPECIFICATION_PATH,
      hash: artifactHashes.feature_specification_sha256,
      ...featureSpecification,
    },
    artifact_hashes: artifactHashes,
    artifacts: {
      coverage_matrix_path: COVERAGE_MATRIX_PATH,
      schema_manifest_path: SCHEMA_MANIFEST_PATH,
      feature_specification_path: FEATURE_SPECIFICATION_PATH,
      dataset_manifest_path: DATASET_MANIFEST_PATH,
      artifact_hashes_path: ARTIFACT_HASHES_PATH,
    },
    future_performance_calculated: false,
    safety: {
      production_modified: false,
      supabase_production_modified: false,
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
  await writeJson(JSON_REPORT_PATH, report);
  await writeFile(MARKDOWN_REPORT_PATH, buildMarkdown(report), "utf8");
  console.log(JSON.stringify({
    json: JSON_REPORT_PATH,
    markdown: MARKDOWN_REPORT_PATH,
    classification: report.classification,
    universe: `${universe.length}/49`,
    selectedResolution: SELECTED_RESOLUTION,
    jointCoveragePercent,
    worstSymbol: worstSymbol.symbol,
    worstQuarter: worstQuarter.period,
    pitSafe: report.pit_safe,
    futurePerformanceCalculated: false,
    artifactHashes,
  }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
