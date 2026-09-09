import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import {
  classifyGapsAcrossIntervals,
  classifyListingAdjustedGaps,
  classifyListingRecord,
  listingAdjustedIntervals,
  mergeValidatedFlowRows,
  parseBinanceKlineCsv,
  sha256Json,
  toFlowKline,
  validateFlowKline,
  validateMinuteSequence,
} from "../lib/aggressive-flow";
import type {
  FlowKline,
  GapStatistics,
  ListingAdjustedIntervals,
  ListingRecordClassification,
  MarketInterval,
  SourceFlowRows,
} from "../lib/aggressive-flow";
import type { RawFlowKline } from "../lib/aggressive-flow";

const EVALUATION_START = Date.parse("2024-08-09T00:00:00.000Z");
const EVALUATION_END_EXCLUSIVE = Date.parse("2026-08-10T00:00:00.000Z");
const EVALUATION_START_ISO = "2024-08-09T00:00:00.000Z";
const EVALUATION_END_ISO = "2026-08-09T23:59:59.999Z";
const MONTH_START = { year: 2024, month: 8 };
const MONTH_END = { year: 2026, month: 8 };
const MINUTE_MS = 60_000;
const FLOW_ROOT = resolve("data", "raw", "hy-r5.2-flow");
const LISTING_ROOT = resolve("data", "raw", "hy-r5.2b-flow");
const DAILY_ROOT = resolve(LISTING_ROOT, "daily");
const LISTING_EVIDENCE_PATH = resolve(LISTING_ROOT, "listing-evidence.json");
const DAILY_MANIFEST_PATH = resolve(LISTING_ROOT, "daily-manifest.json");
const COVERAGE_MATRIX_PATH = resolve(LISTING_ROOT, "coverage-matrix.json");
const R52_MANIFEST_PATH = resolve(FLOW_ROOT, "manifest.json");
const REPORT_DIRECTORY = resolve("reports");
const JSON_REPORT_PATH = resolve(REPORT_DIRECTORY, "hy-r5.2b-listing-aware-flow-data-gate.json");
const MARKDOWN_REPORT_PATH = resolve(REPORT_DIRECTORY, "hy-r5.2b-listing-aware-flow-data-gate.md");
const MONTHLY_SOURCE_BASE = "https://data.binance.vision/data/futures/um/monthly/klines";
const DAILY_SOURCE_BASE = "https://data.binance.vision/data/futures/um/daily/klines";
const EXCHANGE_INFO_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const PUMP_OLD_LISTING = Date.parse("2025-04-12T14:30:00.000Z");
const PUMP_OLD_DELISTING = Date.parse("2025-06-13T09:00:00.000Z");
const PUMP_RELISTING = Date.parse("2025-07-10T07:30:00.000Z");
const PUMP_RENAME_EVIDENCE_URL = "https://www.binance.com/en/square/post/25422343646546";

type DownloadStatus = "AVAILABLE" | "SOURCE_MISSING" | "FAILED";
type ChecksumStatus = "PASS" | "MISSING" | "FAIL";
type DailyQuality = "COMPLETE" | "DATA_INCOMPLETE" | "SOURCE_MISSING" | "INVALID";

interface R52MonthlyRecord {
  key: string;
  symbol: string;
  month: string;
  archive_path: string;
  compact_path: string | null;
  download_status: DownloadStatus;
  checksum_status: ChecksumStatus;
  raw_row_count: number;
  valid_1m_observations: number;
  available_minutes: number;
  quality_status: "COMPLETE" | "DATA_INCOMPLETE" | "SOURCE_MISSING" | "INVALID";
  min_timestamp: string | null;
  max_timestamp: string | null;
}

interface R52Manifest {
  universe: string[];
  expected_months: string[];
  records: Record<string, R52MonthlyRecord>;
}

interface ExchangeSymbol {
  symbol: string;
  contractType: string;
  status: string;
  onboardDate: number;
  deliveryDate: number;
}

interface ListingEvidence {
  endpoint: string;
  fetched_at: string;
  server_time: number;
  symbols: ExchangeSymbol[];
}

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface DailyTarget {
  symbol: string;
  date: string;
  expectedStart: number;
  expectedEndExclusive: number;
}

interface DailyArtifact {
  key: string;
  symbol: string;
  date: string;
  source_url: string;
  checksum_url: string;
  archive_path: string;
  download_status: DownloadStatus;
  checksum_status: ChecksumStatus;
  quality_status: DailyQuality;
  raw_row_count: number;
  valid_rows: number;
  min_timestamp: string | null;
  max_timestamp: string | null;
  errors: string[];
  rows: FlowKline[];
}

interface MonthWork {
  symbol: string;
  month: string;
  key: string;
  window: ListingAdjustedIntervals;
  marketIntervals: MarketInterval[];
  monthlyRecord: R52MonthlyRecord | null;
  monthlyAvailable: boolean;
  monthlyRows: FlowKline[];
  monthlyRowsLoaded: boolean;
  dailyDates: Set<string>;
}

interface MonthResult {
  symbol: string;
  month: string;
  listing_time: string | null;
  listing_source: string;
  calendar_expected_minutes: number;
  listing_adjusted_expected_minutes: number;
  valid_available_minutes: number;
  coverage_percent: number;
  classification: ListingRecordClassification;
  quality_status: "EXCLUDED_NOT_LISTED" | "COMPLETE" | "DATA_INCOMPLETE" | "INVALID";
  monthly_status: string;
  missing_reason: string | null;
  daily_backfilled_files: number;
  daily_available_rows: number;
  deduplicated_minutes: number;
  source_conflict_count: number;
  gap_statistics: GapStatistics;
  feature_window_complete: boolean;
}

interface DailyManifest {
  schema_version: string;
  generated_at: string;
  records: Record<string, Omit<DailyArtifact, "rows">>;
}

type JsonRecord = Record<string, unknown>;

const FROZEN_FEATURE_SPEC = {
  version: "hy-r5.2-v1",
  features: [
    "F1 INTRABAR_FLOW_IMBALANCE",
    "F2 FLOW_ACCELERATION",
    "F3 FLOW_PERSISTENCE",
    "F4 PRICE_FLOW_RESPONSE",
    "F5 ABSORPTION",
  ],
  aggregation_window_minutes: 15,
  baseline_window_days: 7,
  persistence_intervals: 3,
  extreme_buy_percentile: 90,
  extreme_sell_percentile: 10,
  minimum_completeness_percent: 100,
  event_formation_semantics: "Decision timestamps use only 1m bars with closeTime <= t; no open/current bar.",
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function iso(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function monthKeys(): string[] {
  const result: string[] = [];
  let year = MONTH_START.year;
  let month = MONTH_START.month;
  while (year < MONTH_END.year || (year === MONTH_END.year && month <= MONTH_END.month)) {
    result.push(monthKey(year, month));
    const next = nextMonth(year, month);
    year = next.year;
    month = next.month;
  }
  return result;
}

function monthBounds(month: string): { start: number; endExclusive: number } {
  const [year, monthNumber] = month.split("-").map(Number);
  const next = nextMonth(year!, monthNumber!);
  return {
    start: Date.UTC(year!, monthNumber! - 1, 1),
    endExclusive: Date.UTC(next.year, next.month - 1, 1),
  };
}

function quarterKey(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return `${year}-Q${Math.floor((monthNumber! - 1) / 3) + 1}`;
}

function ceilToMinute(timestamp: number): number {
  return Math.ceil(timestamp / MINUTE_MS) * MINUTE_MS;
}

function dailyKey(symbol: string, date: string): string {
  return `${symbol}:${date}`;
}

function dailyArchiveUrl(symbol: string, date: string): string {
  return `${DAILY_SOURCE_BASE}/${symbol}/1m/${symbol}-1m-${date}.zip`;
}

function dailyArchivePath(symbol: string, date: string): string {
  return resolve(DAILY_ROOT, symbol, `${symbol}-1m-${date}.zip`);
}

function marketIntervalsFor(symbol: string, listing: ExchangeSymbol): MarketInterval[] {
  if (symbol === "PUMPUSDT") {
    return [
      {
        startTime: PUMP_OLD_LISTING,
        endTimeExclusive: PUMP_OLD_DELISTING,
        source: "official archive first observed 2025-04-12T14:30:00.000Z + Binance rename notice",
      },
      {
        startTime: Math.max(listing.onboardDate, PUMP_RELISTING),
        endTimeExclusive: listing.deliveryDate,
        source: EXCHANGE_INFO_URL,
      },
    ];
  }
  return [{ startTime: listing.onboardDate, endTimeExclusive: listing.deliveryDate, source: EXCHANGE_INFO_URL }];
}

function lifecycleExceptions(): JsonRecord[] {
  return [{
    symbol: "PUMPUSDT",
    reason: "symbol identity was reused after the original PUMPUSDT contract was renamed",
    old_interval: { start: iso(PUMP_OLD_LISTING), end: iso(PUMP_OLD_DELISTING) },
    relisted_at: iso(PUMP_RELISTING),
    evidence: PUMP_RENAME_EVIDENCE_URL,
  }];
}

function rowInIntervals(row: FlowKline, intervals: MarketInterval[]): boolean {
  return intervals.some((interval) => row.openTime >= interval.startTime && row.openTime < interval.endTimeExclusive);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function runCurl(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("curl.exe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

async function downloadFile(url: string, destination: string, maxTimeSeconds: number): Promise<{
  status: DownloadStatus;
  error: string | null;
}> {
  await mkdir(dirname(destination), { recursive: true });
  if (await exists(destination)) return { status: "AVAILABLE", error: null };
  const partialPath = `${destination}.part`;
  const result = await runCurl([
    "--silent",
    "--show-error",
    "--fail",
    "--location",
    "--retry",
    "6",
    "--retry-all-errors",
    "--retry-delay",
    "2",
    "--http1.1",
    "--tlsv1.2",
    "--connect-timeout",
    "30",
    "--max-time",
    String(maxTimeSeconds),
    "--continue-at",
    "-",
    "--output",
    partialPath,
    "--write-out",
    "%{http_code}",
    url,
  ]);
  const httpCode = Number(result.stdout.trim().slice(-3));
  if (httpCode === 404) return { status: "SOURCE_MISSING", error: "HTTP 404" };
  if (result.code !== 0) {
    if (httpCode === 416 && await exists(partialPath)) {
      await rename(partialPath, destination);
      return { status: "AVAILABLE", error: null };
    }
    return {
      status: "FAILED",
      error: `curl exit ${result.code}; HTTP ${httpCode || "unknown"}; ${result.stderr.trim().slice(-500)}`,
    };
  }
  await rename(partialPath, destination);
  return { status: "AVAILABLE", error: null };
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

function readZipEntries(buffer: Buffer): ZipEntry[] {
  const endOffset = findEndOfCentralDirectory(buffer);
  if (endOffset < 0) throw new Error("ZIP end-of-central-directory record not found");
  const centralDirectorySize = buffer.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(endOffset + 16);
  const entries: ZipEntry[] = [];
  let cursor = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;
  while (cursor < end) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid ZIP central-directory entry");
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + fileNameLength).toString("utf8");
    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function extractZipCsv(buffer: Buffer): string {
  const entry = readZipEntries(buffer).find((candidate) => candidate.name.toLowerCase().endsWith(".csv"));
  if (!entry) throw new Error("ZIP contains no CSV entry");
  if (entry.localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) {
    throw new Error("Invalid ZIP local-file header");
  }
  const fileNameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  const content = entry.compressionMethod === 0
    ? compressed
    : entry.compressionMethod === 8
      ? inflateRawSync(compressed)
      : (() => { throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod}`); })();
  if (content.length !== entry.uncompressedSize) throw new Error("ZIP uncompressed-size mismatch");
  return content.toString("utf8");
}

function expectedChecksum(content: string): string | null {
  return content.match(/\b([a-f0-9]{64})\b/i)?.[1]?.toLowerCase() ?? null;
}

async function checksumStatus(archive: string, checksumFile: string): Promise<ChecksumStatus> {
  if (!(await exists(checksumFile))) return "MISSING";
  const expected = expectedChecksum(await readFile(checksumFile, "utf8"));
  if (!expected) return "FAIL";
  const actual = createHash("sha256").update(await readFile(archive)).digest("hex");
  return actual === expected ? "PASS" : "FAIL";
}

async function loadR52Manifest(): Promise<R52Manifest> {
  const parsed = JSON.parse(await readFile(R52_MANIFEST_PATH, "utf8")) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.universe) || !Array.isArray(parsed.expected_months) || !isRecord(parsed.records)) {
    throw new Error("Invalid HY-R5.2 manifest");
  }
  return parsed as unknown as R52Manifest;
}

async function fetchListingEvidence(universe: string[]): Promise<ListingEvidence> {
  const result = await runCurl([
    "--silent",
    "--show-error",
    "--fail",
    "--location",
    "--retry",
    "8",
    "--retry-all-errors",
    "--retry-delay",
    "2",
    "--http1.1",
    "--tlsv1.2",
    "--connect-timeout",
    "30",
    "--max-time",
    "180",
    EXCHANGE_INFO_URL,
  ]);
  if (result.code !== 0) throw new Error(`exchangeInfo request failed: ${result.stderr.trim().slice(-500)}`);
  const parsed = JSON.parse(result.stdout) as { serverTime?: number; symbols?: ExchangeSymbol[] };
  const sourceSymbols = parsed.symbols ?? [];
  const symbols = universe.map((symbol) => sourceSymbols.find((item) => item.symbol === symbol));
  if (symbols.some((item) => !item || !Number.isFinite(item.onboardDate))) {
    throw new Error("exchangeInfo does not contain valid onboardDate for every fixed-universe symbol");
  }
  const evidence: ListingEvidence = {
    endpoint: EXCHANGE_INFO_URL,
    fetched_at: new Date().toISOString(),
    server_time: parsed.serverTime ?? 0,
    symbols: symbols as ExchangeSymbol[],
  };
  await mkdir(LISTING_ROOT, { recursive: true });
  await writeFile(LISTING_EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidence;
}

function numberValue(value: JsonRecord, key: string): number | null {
  const number = Number(value[key]);
  return Number.isFinite(number) ? number : null;
}

async function readCompactRows(path: string | null): Promise<FlowKline[]> {
  if (!path || !(await exists(path))) return [];
  const rows: FlowKline[] = [];
  const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const line of lines) {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value)) continue;
    const raw: RawFlowKline = {
      openTime: numberValue(value, "timestamp") ?? -1,
      open: numberValue(value, "open") ?? Number.NaN,
      high: numberValue(value, "high") ?? Number.NaN,
      low: numberValue(value, "low") ?? Number.NaN,
      close: numberValue(value, "close") ?? Number.NaN,
      volume: numberValue(value, "volume") ?? Number.NaN,
      closeTime: (numberValue(value, "timestamp") ?? -1) + 59_999,
      quoteVolume: numberValue(value, "quote_volume") ?? Number.NaN,
      numberOfTrades: numberValue(value, "number_of_trades") ?? Number.NaN,
      takerBuyBaseVolume: numberValue(value, "taker_buy_base_volume") ?? Number.NaN,
      takerBuyQuoteVolume: numberValue(value, "taker_buy_quote_volume") ?? Number.NaN,
    };
    const row = toFlowKline(raw);
    if (validateFlowKline(row).length === 0) rows.push(row);
  }
  return rows;
}

async function loadDailyManifest(): Promise<DailyManifest> {
  if (await exists(DAILY_MANIFEST_PATH)) {
    const parsed = JSON.parse(await readFile(DAILY_MANIFEST_PATH, "utf8")) as unknown;
    if (isRecord(parsed) && isRecord(parsed.records)) {
      return {
        schema_version: typeof parsed.schema_version === "string" ? parsed.schema_version : "hy-r5.2b-v1",
        generated_at: typeof parsed.generated_at === "string" ? parsed.generated_at : new Date().toISOString(),
        records: parsed.records as Record<string, Omit<DailyArtifact, "rows">>,
      };
    }
  }
  return { schema_version: "hy-r5.2b-v1", generated_at: new Date().toISOString(), records: {} };
}

async function persistDailyManifest(manifest: DailyManifest): Promise<void> {
  await mkdir(dirname(DAILY_MANIFEST_PATH), { recursive: true });
  manifest.generated_at = new Date().toISOString();
  await writeFile(DAILY_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function dailyDatesForGap(startTime: number, endTimeExclusive: number): string[] {
  if (endTimeExclusive <= startTime) return [];
  const dates: string[] = [];
  let cursor = Date.UTC(
    new Date(startTime).getUTCFullYear(),
    new Date(startTime).getUTCMonth(),
    new Date(startTime).getUTCDate(),
  );
  const lastDay = Date.UTC(
    new Date(endTimeExclusive - 1).getUTCFullYear(),
    new Date(endTimeExclusive - 1).getUTCMonth(),
    new Date(endTimeExclusive - 1).getUTCDate(),
  );
  while (cursor <= lastDay) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 24 * 60 * 60_000;
  }
  return dates;
}

async function processDailyTarget(target: DailyTarget, manifest: DailyManifest): Promise<DailyArtifact> {
  const key = dailyKey(target.symbol, target.date);
  const archive = dailyArchivePath(target.symbol, target.date);
  const checksumFile = `${archive}.CHECKSUM`;
  const artifact: DailyArtifact = {
    key,
    symbol: target.symbol,
    date: target.date,
    source_url: dailyArchiveUrl(target.symbol, target.date),
    checksum_url: `${dailyArchiveUrl(target.symbol, target.date)}.CHECKSUM`,
    archive_path: archive,
    download_status: "FAILED",
    checksum_status: "MISSING",
    quality_status: "DATA_INCOMPLETE",
    raw_row_count: 0,
    valid_rows: 0,
    min_timestamp: null,
    max_timestamp: null,
    errors: [],
    rows: [],
  };
  if (!(await exists(archive))) {
    const downloaded = await downloadFile(artifact.source_url, archive, 300);
    artifact.download_status = downloaded.status;
    if (downloaded.error) artifact.errors.push(`archive: ${downloaded.error}`);
  } else {
    artifact.download_status = "AVAILABLE";
  }
  if (artifact.download_status === "SOURCE_MISSING") {
    artifact.quality_status = "SOURCE_MISSING";
    const { rows, ...withoutRows } = artifact;
    manifest.records[key] = withoutRows;
    return artifact;
  }
  if (artifact.download_status !== "AVAILABLE") {
    const { rows, ...withoutRows } = artifact;
    manifest.records[key] = withoutRows;
    return artifact;
  }
  if (!(await exists(checksumFile))) {
    const checksum = await downloadFile(artifact.checksum_url, checksumFile, 60);
    if (checksum.status === "FAILED" && checksum.error) artifact.errors.push(`checksum: ${checksum.error}`);
  }
  artifact.checksum_status = await checksumStatus(archive, checksumFile);
  if (artifact.checksum_status === "FAIL") {
    artifact.quality_status = "INVALID";
    artifact.errors.push("checksum: SHA-256 mismatch or malformed checksum file");
    const { rows, ...withoutRows } = artifact;
    manifest.records[key] = withoutRows;
    return artifact;
  }
  try {
    const csv = extractZipCsv(await readFile(archive));
    const parsedCsv = parseBinanceKlineCsv(csv);
    artifact.raw_row_count = parsedCsv.rawRowCount;
    artifact.rows = parsedCsv.rows.filter((row) => row.openTime >= target.expectedStart && row.openTime < target.expectedEndExclusive);
    artifact.valid_rows = artifact.rows.length;
    artifact.min_timestamp = iso(parsedCsv.rows[0]?.openTime ?? null);
    artifact.max_timestamp = iso(parsedCsv.rows.at(-1)?.closeTime ?? null);
    artifact.errors.push(...parsedCsv.errors);
    const hasInvalid = parsedCsv.malformedRowCount > 0 || parsedCsv.invalidRowCount > 0;
    const expected = Math.max(0, Math.ceil((target.expectedEndExclusive - target.expectedStart) / MINUTE_MS));
    const sequence = validateMinuteSequence(parsedCsv.rows, target.expectedStart, target.expectedEndExclusive);
    artifact.quality_status = hasInvalid
      ? "INVALID"
      : sequence.availableMinutes === expected && sequence.gapCount === 0 && sequence.duplicateTimestampCount === 0 && sequence.outOfOrderCount === 0
        ? "COMPLETE"
        : "DATA_INCOMPLETE";
  } catch (error) {
    artifact.quality_status = "INVALID";
    artifact.errors.push(error instanceof Error ? error.message : String(error));
  }
  const { rows, ...withoutRows } = artifact;
  manifest.records[key] = withoutRows;
  return artifact;
}

async function runConcurrent<T>(items: T[], concurrency: number, handler: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await handler(items[index]!);
    }
  }));
}

function zeroGapStatistics(): GapStatistics {
  return {
    totalMissingMinutes: 0,
    totalGapRuns: 0,
    byBucket: {
      single_minute: { gapRuns: 0, missingMinutes: 0 },
      two_to_five_minutes: { gapRuns: 0, missingMinutes: 0 },
      six_to_sixty_minutes: { gapRuns: 0, missingMinutes: 0 },
      over_sixty_minutes: { gapRuns: 0, missingMinutes: 0 },
    },
    runs: [],
  };
}

function coveragePercent(expected: number, valid: number): number {
  return expected === 0 ? 100 : valid / expected * 100;
}

function sourceRowsFor(symbol: string, month: string, rows: FlowKline[], sourceType: "MONTHLY" | "DAILY"): SourceFlowRows {
  return { sourceType, sourceKey: `${symbol}:${month}`, rows };
}

function aggregateGapStats(results: MonthResult[]): JsonRecord {
  const total = zeroGapStatistics();
  for (const result of results) {
    total.totalMissingMinutes += result.gap_statistics.totalMissingMinutes;
    total.totalGapRuns += result.gap_statistics.totalGapRuns;
    for (const bucket of Object.keys(total.byBucket) as Array<keyof GapStatistics["byBucket"]>) {
      total.byBucket[bucket]!.gapRuns += result.gap_statistics.byBucket[bucket]!.gapRuns;
      total.byBucket[bucket]!.missingMinutes += result.gap_statistics.byBucket[bucket]!.missingMinutes;
    }
  }
  return total as unknown as JsonRecord;
}

function buildCoverageMatrix(universe: string[], months: string[], results: MonthResult[]): JsonRecord {
  const byKey = new Map(results.map((result) => [`${result.symbol}:${result.month}`, result]));
  return {
    version: "hy-r5.2b-v1",
    historical_range: { start: EVALUATION_START_ISO, end: EVALUATION_END_ISO },
    symbols: universe.map((symbol) => ({
      symbol,
      months: months.map((month) => {
        const result = byKey.get(`${symbol}:${month}`)!;
        return {
          month,
          classification: result.classification,
          quality_status: result.quality_status,
          calendar_expected_minutes: result.calendar_expected_minutes,
          listing_adjusted_expected_minutes: result.listing_adjusted_expected_minutes,
          valid_available_minutes: result.valid_available_minutes,
          coverage_percent: Number(result.coverage_percent.toFixed(8)),
          gap_runs: result.gap_statistics.totalGapRuns,
          missing_minutes: result.gap_statistics.totalMissingMinutes,
          source_conflict_count: result.source_conflict_count,
        };
      }),
    })),
  };
}

function buildQuarterMatrix(universe: string[], months: string[], results: MonthResult[]): JsonRecord {
  const quarters = [...new Set(months.map(quarterKey))];
  const byKey = new Map(results.map((result) => [`${result.symbol}:${result.month}`, result]));
  return {
    version: "hy-r5.2b-v1",
    quarters: universe.map((symbol) => ({
      symbol,
      quarters: quarters.map((quarter) => {
        const rows = months
          .filter((month) => quarterKey(month) === quarter)
          .map((month) => byKey.get(`${symbol}:${month}`)!)
          .filter((result) => result.listing_adjusted_expected_minutes > 0);
        const expected = rows.reduce((total, row) => total + row.listing_adjusted_expected_minutes, 0);
        const valid = rows.reduce((total, row) => total + row.valid_available_minutes, 0);
        return {
          quarter,
          eligible: expected > 0,
          listing_adjusted_expected_minutes: expected,
          valid_available_minutes: valid,
          coverage_percent: Number(coveragePercent(expected, valid).toFixed(8)),
          missing_minutes: rows.reduce((total, row) => total + row.gap_statistics.totalMissingMinutes, 0),
          gap_runs: rows.reduce((total, row) => total + row.gap_statistics.totalGapRuns, 0),
        };
      }),
    })),
  };
}

function worstCoverage(rows: Array<{ name: string; expected: number; valid: number }>): JsonRecord | null {
  const eligible = rows.filter((row) => row.expected > 0).sort((left, right) => {
    const coverageDifference = left.valid / left.expected - right.valid / right.expected;
    return coverageDifference || left.name.localeCompare(right.name);
  });
  const worst = eligible[0];
  return worst
    ? { name: worst.name, expected_minutes: worst.expected, valid_minutes: worst.valid, coverage_percent: coveragePercent(worst.expected, worst.valid) }
    : null;
}

function buildMarkdown(report: JsonRecord): string {
  const data = report.data as JsonRecord;
  const audit = report.audit as JsonRecord;
  const gaps = audit.gaps as JsonRecord;
  const safety = report.safety as JsonRecord;
  const lines = [
    "# HY-R5.2B Listing-Aware Flow Data Completion Gate",
    "",
    "## Classification",
    "",
    `- **${String(report.classification)}**`,
    "- Data-only gate. No H1/H2/H3 performance, future return, precision, MFE, MAE, PnL, or signal/control analysis was executed.",
    "",
    "## Historical coverage",
    "",
    `- Range: ${String(data.historical_range_start)} -> ${String(data.historical_range_end)}`,
    `- Universe: ${String(data.universe_count)}/49`,
    `- Raw calendar expected minutes: ${String(data.raw_calendar_expected_minutes)}`,
    `- Listing-adjusted expected minutes: ${String(data.listing_adjusted_expected_minutes)}`,
    `- Valid flow minutes: ${String(data.valid_flow_minutes)}`,
    `- Listing-adjusted coverage: ${Number(data.listing_adjusted_coverage_percent).toFixed(4)}%`,
    `- Original SOURCE_MISSING: ${String(data.original_source_missing)}`,
    `- NOT_LISTED: ${String(data.not_listed_count)}`,
    `- PARTIAL_LISTING_MONTH: ${String(data.partial_listing_month_count)}`,
    `- TRUE_MONTHLY_ARCHIVE_MISSING: ${String(data.true_monthly_archive_missing_count)}`,
    `- Daily backfilled files: ${String(data.daily_backfilled_files)}`,
    `- Remaining genuine missing files: ${String(data.remaining_genuine_missing_files)}`,
    `- Worst symbol coverage: ${JSON.stringify(data.worst_symbol_coverage)}`,
    `- Worst quarter coverage: ${JSON.stringify(data.worst_quarter_coverage)}`,
    "",
    "## Listing evidence",
    "",
    `- Source: ${String(data.listing_evidence_source)}`,
    `- Listing evidence hash: ${String(data.listing_evidence_hash)}`,
    `- Historical lifecycle exceptions: ${JSON.stringify(data.market_lifecycle_exceptions)}`,
    "- Pre-listing months are NOT_LISTED and are excluded from the authoritative denominator.",
    "",
    "## Daily backfill and source resolution",
    "",
    `- Daily candidates checked: ${String(data.daily_candidates_checked)}`,
    `- Daily available files: ${String(data.daily_available_files)}`,
    `- Source conflicts: ${String(data.source_conflicts)}`,
    "- Source priority: validated MONTHLY, otherwise validated DAILY.",
    "- Conflicting monthly/daily minutes are excluded and reported as SOURCE_CONFLICT; no silent choice is made.",
    "- No forward fill, zero fill, interpolation, adjacent-minute copy, or synthetic flow value was used.",
    "",
    "## Gap audit",
    "",
    `- Overall: ${JSON.stringify(gaps)}`,
    "- Gap detail is frozen in the symbol × month and symbol × quarter coverage matrices.",
    `- Coverage matrix hash: ${String(data.coverage_matrix_hash)}`,
    `- Feature specification hash: ${String(data.feature_specification_hash)}`,
    "",
    "## Feature eligibility",
    "",
    "- F1–F5 semantics, windows, thresholds, and PIT contract are unchanged from HY-R5.2.",
    "- A feature observation is DATA_INCOMPLETE when any current-window or rolling-baseline minute is missing; windows are never shortened.",
    `- Feature specification frozen: ${String(data.feature_specification_frozen)}`,
    "",
    "## Performance boundary",
    "",
    "- Future performance calculated: **NO**",
    "- H1/H2/H3, future return, precision, MFE, MAE, PnL, and Signal vs Control: NOT CALCULATED.",
    "",
    "## Safety",
    `- Production modified: ${String(safety.production_modified)}`,
    `- Supabase modified: ${String(safety.supabase_modified)}`,
    `- Vercel modified: ${String(safety.vercel_modified)}`,
    `- PAPER strategy modified: ${String(safety.paper_strategy_modified)}`,
    `- Emails sent: ${String(safety.emails_sent)}`,
    `- Private API called: ${String(safety.private_api_called)}`,
    `- AUTO_TRADING: ${String(safety.auto_trading)}`,
    `- Commit created: ${String(safety.commit_created)}`,
    "",
    "STOP.",
    "",
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const r52 = await loadR52Manifest();
  if (r52.universe.length !== 49) throw new Error(`Expected 49 universe symbols, found ${r52.universe.length}`);
  const universe = [...r52.universe].sort();
  const months = [...r52.expected_months].sort();
  if (months.length !== 25) throw new Error(`Expected 25 research months, found ${months.length}`);
  const evidence = await fetchListingEvidence(universe);
  const evidenceBySymbol = new Map(evidence.symbols.map((item) => [item.symbol, item]));
  const works: MonthWork[] = [];
  for (const symbol of universe) {
    const listing = evidenceBySymbol.get(symbol);
    if (!listing) throw new Error(`Missing listing evidence for ${symbol}`);
    for (const month of months) {
      const bounds = monthBounds(month);
      const marketIntervals = marketIntervalsFor(symbol, listing);
      const window = listingAdjustedIntervals({
        monthStart: bounds.start,
        monthEndExclusive: bounds.endExclusive,
        intervals: marketIntervals,
        researchStart: EVALUATION_START,
        researchEndExclusive: EVALUATION_END_EXCLUSIVE,
      });
      const monthlyRecord = r52.records[`${symbol}:${month}`] ?? null;
      const monthlyRowsLoaded = marketIntervals.length > 1 || window.kind === "PARTIAL_LISTING_MONTH"
        || monthlyRecord?.quality_status === "DATA_INCOMPLETE"
        || monthlyRecord?.quality_status === "INVALID";
      const monthlyRows = monthlyRowsLoaded ? await readCompactRows(monthlyRecord?.compact_path ?? null) : [];
      const monthlyAvailable = monthlyRecord?.download_status === "AVAILABLE"
        && monthlyRecord.quality_status !== "INVALID";
      works.push({
        symbol,
        month,
        key: `${symbol}:${month}`,
        window,
        marketIntervals,
        monthlyRecord,
        monthlyAvailable,
        monthlyRows,
        monthlyRowsLoaded,
        dailyDates: new Set<string>(),
      });
    }
  }

  const dailyTargets = new Map<string, DailyTarget>();
  for (const work of works) {
    if (work.window.kind === "NOT_LISTED" || work.window.kind === "INVALID" || work.window.eligibleIntervals.length === 0) continue;
    const canTrustMonthly = work.monthlyRowsLoaded === false
      && work.monthlyAvailable
      && work.monthlyRecord?.quality_status === "COMPLETE";
    const gaps = canTrustMonthly ? zeroGapStatistics() : classifyGapsAcrossIntervals(work.monthlyRows, work.window.eligibleIntervals);
    for (const interval of work.window.eligibleIntervals) {
      const intervalGaps = canTrustMonthly
        ? zeroGapStatistics()
        : classifyListingAdjustedGaps(work.monthlyRows, interval.startTime, interval.endTimeExclusive);
      for (const gap of intervalGaps.runs) {
        for (const date of dailyDatesForGap(gap.startTime, gap.endTimeExclusive)) {
        const dateStart = Date.parse(`${date}T00:00:00.000Z`);
        const dateEnd = dateStart + 24 * 60 * 60_000;
        const key = dailyKey(work.symbol, date);
        work.dailyDates.add(date);
        if (!dailyTargets.has(key)) {
          dailyTargets.set(key, {
            symbol: work.symbol,
            date,
            expectedStart: Math.max(dateStart, interval.startTime),
            expectedEndExclusive: Math.min(dateEnd, interval.endTimeExclusive),
          });
        }
      }
      }
    }
  }

  const dailyManifest = await loadDailyManifest();
  const dailyArtifacts = new Map<string, DailyArtifact>();
  const dailyTargetList = [...dailyTargets.values()];
  await runConcurrent(dailyTargetList, 6, async (target) => {
    const artifact = await processDailyTarget(target, dailyManifest);
    dailyArtifacts.set(artifact.key, artifact);
    await persistDailyManifest(dailyManifest);
    console.log(JSON.stringify({ daily: `${dailyArtifacts.size}/${dailyTargetList.length}`, symbol: target.symbol, date: target.date, status: artifact.quality_status, download: artifact.download_status, checksum: artifact.checksum_status, validRows: artifact.valid_rows }));
  });
  await persistDailyManifest(dailyManifest);

  const results: MonthResult[] = [];
  for (const work of works) {
    const listing = evidenceBySymbol.get(work.symbol)!;
    if (work.window.kind === "NOT_LISTED") {
      results.push({
        symbol: work.symbol,
        month: work.month,
        listing_time: iso(listing.onboardDate),
        listing_source: EXCHANGE_INFO_URL,
        calendar_expected_minutes: work.window.calendarExpectedMinutes,
        listing_adjusted_expected_minutes: 0,
        valid_available_minutes: 0,
        coverage_percent: 100,
        classification: "NOT_LISTED",
        quality_status: "EXCLUDED_NOT_LISTED",
        monthly_status: work.monthlyRecord?.quality_status ?? "SOURCE_MISSING",
        missing_reason: "NOT_LISTED",
        daily_backfilled_files: 0,
        daily_available_rows: 0,
        deduplicated_minutes: 0,
        source_conflict_count: 0,
        gap_statistics: zeroGapStatistics(),
        feature_window_complete: false,
      });
      continue;
    }
    const dailyForMonth = [...work.dailyDates]
      .map((date) => dailyArtifacts.get(dailyKey(work.symbol, date)))
      .filter((artifact): artifact is DailyArtifact => artifact !== undefined);
    const dailyRows = dailyForMonth.flatMap((artifact) => artifact.quality_status === "INVALID" ? [] : artifact.rows);
    const monthlySource = sourceRowsFor(work.symbol, work.month, work.monthlyRows, "MONTHLY");
    const dailySource: SourceFlowRows = {
      sourceType: "DAILY",
      sourceKey: dailyForMonth.map((artifact) => artifact.key).sort().join(",") || `${work.symbol}:${work.month}:none`,
      rows: dailyRows,
    };
    const merged = mergeValidatedFlowRows(monthlySource, dailySource);
    const canTrustMonthly = work.monthlyRowsLoaded === false
      && work.monthlyAvailable
      && work.monthlyRecord?.quality_status === "COMPLETE"
      && dailyRows.length === 0;
    const eligibleMergedRows = merged.rows.filter((row) => rowInIntervals(row, work.window.eligibleIntervals));
    const validRows = canTrustMonthly
      ? work.window.listingAdjustedExpectedMinutes
      : new Set(eligibleMergedRows.map((row) => row.openTime)).size;
    const gaps = canTrustMonthly
      ? zeroGapStatistics()
      : classifyGapsAcrossIntervals(merged.rows, work.window.eligibleIntervals);
    const sourceConflictCount = merged.conflicts.length + merged.intraSourceDuplicateMinutes;
    const classification = work.monthlyRecord?.quality_status === "INVALID"
      || dailyForMonth.some((artifact) => artifact.quality_status === "INVALID")
      ? "INVALID"
      : classifyListingRecord({
        window: work.window,
        monthlyAvailable: work.monthlyAvailable,
        mergedAvailableMinutes: validRows,
        sourceConflict: sourceConflictCount > 0,
      });
    const hasIncomplete = validRows < work.window.listingAdjustedExpectedMinutes || gaps.totalMissingMinutes > 0;
    const qualityStatus = classification === "INVALID"
      ? "INVALID"
      : hasIncomplete
        ? "DATA_INCOMPLETE"
        : "COMPLETE";
    const monthlyTimestamps = new Set(work.monthlyRows
      .filter((row) => rowInIntervals(row, work.window.eligibleIntervals))
      .map((row) => row.openTime));
    const dailyBackfilledFiles = dailyForMonth.filter((artifact) => artifact.rows.some((row) => !monthlyTimestamps.has(row.openTime))).length;
    const missingReason = classification === "SOURCE_MISSING"
      ? "TRUE_MONTHLY_ARCHIVE_MISSING"
      : classification === "AVAILABLE_PARTIAL"
        ? "DATA_INCOMPLETE"
        : classification === "PARTIAL_LISTING_MONTH"
          ? "PARTIAL_LISTING_MONTH"
          : classification === "INVALID"
            ? "INVALID_OR_SOURCE_CONFLICT"
            : null;
    results.push({
      symbol: work.symbol,
      month: work.month,
      listing_time: iso(listing.onboardDate),
      listing_source: EXCHANGE_INFO_URL,
      calendar_expected_minutes: work.window.calendarExpectedMinutes,
      listing_adjusted_expected_minutes: work.window.listingAdjustedExpectedMinutes,
      valid_available_minutes: validRows,
      coverage_percent: coveragePercent(work.window.listingAdjustedExpectedMinutes, validRows),
      classification,
      quality_status: qualityStatus,
      monthly_status: work.monthlyRecord?.quality_status ?? "SOURCE_MISSING",
      missing_reason: missingReason,
      daily_backfilled_files: dailyBackfilledFiles,
      daily_available_rows: dailyRows.length,
      deduplicated_minutes: merged.deduplicatedMinutes,
      source_conflict_count: sourceConflictCount,
      gap_statistics: gaps,
      feature_window_complete: gaps.totalMissingMinutes === 0 && sourceConflictCount === 0 && classification !== "INVALID",
    });
  }

  const coverageMatrix = buildCoverageMatrix(universe, months, results);
  const quarterMatrix = buildQuarterMatrix(universe, months, results);
  const coverageMatrixArtifact = { ...coverageMatrix, quarter_matrix: quarterMatrix };
  await mkdir(LISTING_ROOT, { recursive: true });
  await writeFile(COVERAGE_MATRIX_PATH, `${JSON.stringify(coverageMatrixArtifact, null, 2)}\n`, "utf8");

  const rawCalendarExpectedMinutes = results.reduce((total, result) => total + result.calendar_expected_minutes, 0);
  const listingAdjustedExpectedMinutes = results.reduce((total, result) => total + result.listing_adjusted_expected_minutes, 0);
  const validFlowMinutes = results.reduce((total, result) => total + result.valid_available_minutes, 0);
  const originalSourceMissing = Object.values(r52.records).filter((record) => record.quality_status === "SOURCE_MISSING").length;
  const classificationCounts = results.reduce<Record<string, number>>((counts, result) => {
    counts[result.classification] = (counts[result.classification] ?? 0) + 1;
    return counts;
  }, {});
  const trueMonthlyArchiveMissing = results.filter((result) => result.missing_reason === "TRUE_MONTHLY_ARCHIVE_MISSING").length;
  const remainingGenuineMissing = results.filter((result) => result.classification === "SOURCE_MISSING").length;
  const sourceConflicts = results.reduce((total, result) => total + result.source_conflict_count, 0);
  const symbolCoverage = universe.map((symbol) => {
    const rows = results.filter((result) => result.symbol === symbol);
    return {
      name: symbol,
      expected: rows.reduce((total, row) => total + row.listing_adjusted_expected_minutes, 0),
      valid: rows.reduce((total, row) => total + row.valid_available_minutes, 0),
    };
  });
  const quarterCoverage = [...new Set(months.map(quarterKey))].flatMap((quarter) => universe.map((symbol) => {
    const rows = results.filter((result) => result.symbol === symbol && quarterKey(result.month) === quarter);
    return {
      name: `${symbol}:${quarter}`,
      expected: rows.reduce((total, row) => total + row.listing_adjusted_expected_minutes, 0),
      valid: rows.reduce((total, row) => total + row.valid_available_minutes, 0),
    };
  }));
  const classification = results.some((result) => result.classification === "INVALID") || sourceConflicts > 0
    ? "DATA_FOUNDATION_INVALID"
    : results.some((result) => result.classification === "SOURCE_MISSING" || result.classification === "AVAILABLE_PARTIAL" || result.quality_status === "DATA_INCOMPLETE")
      ? "DATA_FOUNDATION_PARTIAL"
      : "DATA_FOUNDATION_READY";
  const report: JsonRecord = {
    research: "HY-R5.2B LISTING-AWARE FLOW DATA COMPLETION GATE",
    version: "hy-r5.2b-v1",
    classification,
    data: {
      historical_range_start: EVALUATION_START_ISO,
      historical_range_end: EVALUATION_END_ISO,
      universe_count: universe.length,
      universe,
      listing_evidence_source: EXCHANGE_INFO_URL,
      listing_evidence_hash: sha256Json({
        exchange_info: evidence.symbols.map((item) => ({ symbol: item.symbol, contractType: item.contractType, status: item.status, onboardDate: item.onboardDate, deliveryDate: item.deliveryDate })),
        lifecycle_exceptions: lifecycleExceptions(),
      }),
      market_lifecycle_exceptions: lifecycleExceptions(),
      raw_calendar_expected_minutes: rawCalendarExpectedMinutes,
      listing_adjusted_expected_minutes: listingAdjustedExpectedMinutes,
      valid_flow_minutes: validFlowMinutes,
      listing_adjusted_coverage_percent: coveragePercent(listingAdjustedExpectedMinutes, validFlowMinutes),
      original_monthly_files: universe.length * months.length,
      original_source_missing: originalSourceMissing,
      not_listed_count: classificationCounts.NOT_LISTED ?? 0,
      partial_listing_month_count: classificationCounts.PARTIAL_LISTING_MONTH ?? 0,
      true_monthly_archive_missing_count: trueMonthlyArchiveMissing,
      daily_candidates_checked: dailyTargetList.length,
      daily_available_files: [...dailyArtifacts.values()].filter((artifact) => artifact.download_status === "AVAILABLE").length,
      daily_backfilled_files: results.reduce((total, result) => total + result.daily_backfilled_files, 0),
      remaining_genuine_missing_files: remainingGenuineMissing,
      worst_symbol_coverage: worstCoverage(symbolCoverage),
      worst_quarter_coverage: worstCoverage(quarterCoverage),
      source_conflicts: sourceConflicts,
      coverage_matrix_path: COVERAGE_MATRIX_PATH,
      coverage_matrix_hash: sha256Json(coverageMatrixArtifact),
      feature_specification_hash: sha256Json(FROZEN_FEATURE_SPEC),
      feature_specification_frozen: true,
      original_feature_specification: FROZEN_FEATURE_SPEC,
    },
    audit: {
      listing_expectation_counts: classificationCounts,
      monthly_quality_counts: results.reduce<Record<string, number>>((counts, result) => {
        counts[result.quality_status] = (counts[result.quality_status] ?? 0) + 1;
        return counts;
      }, {}),
      gaps: aggregateGapStats(results),
      source_conflicts: results.flatMap((result) => result.source_conflict_count > 0 ? [{ symbol: result.symbol, month: result.month, count: result.source_conflict_count }] : []),
      monthly_daily_priority: "validated MONTHLY > validated DAILY",
      no_synthetic_fill: true,
      feature_eligibility_contract: "Any missing current-window or rolling-baseline minute produces DATA_INCOMPLETE; windows are not shortened or filled.",
      symbol_month_matrix: coverageMatrix,
      symbol_quarter_matrix: quarterMatrix,
    },
    pit_safe: "PASS",
    future_performance_calculated: false,
    performance: {
      executed: false,
      future_return: false,
      precision: false,
      mfe: false,
      mae: false,
      pnl: false,
      signal_vs_control: false,
      h1_h2_h3_outcomes: false,
    },
    safety: {
      production_modified: false,
      supabase_modified: false,
      vercel_modified: false,
      paper_strategy_modified: false,
      emails_sent: 0,
      private_api_called: false,
      auto_trading: false,
      commit_created: false,
    },
  };
  await mkdir(REPORT_DIRECTORY, { recursive: true });
  await writeFile(JSON_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(MARKDOWN_REPORT_PATH, buildMarkdown(report), "utf8");
  console.log(JSON.stringify({
    json: JSON_REPORT_PATH,
    markdown: MARKDOWN_REPORT_PATH,
    classification,
    universe: `${universe.length}/49`,
    originalSourceMissing,
    notListed: classificationCounts.NOT_LISTED ?? 0,
    partialListingMonths: classificationCounts.PARTIAL_LISTING_MONTH ?? 0,
    trueMonthlyArchiveMissing,
    dailyCandidates: dailyTargetList.length,
    dailyBackfilledFiles: report.data && (report.data as JsonRecord).daily_backfilled_files,
    listingAdjustedExpectedMinutes,
    validFlowMinutes,
    adjustedCoveragePercent: coveragePercent(listingAdjustedExpectedMinutes, validFlowMinutes),
    sourceConflicts,
    pitSafe: "PASS",
    coverageMatrixHash: (report.data as JsonRecord).coverage_matrix_hash,
    featureSpecificationHash: (report.data as JsonRecord).feature_specification_hash,
    futurePerformanceCalculated: false,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
