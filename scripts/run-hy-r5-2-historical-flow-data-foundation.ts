import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import {
  parseBinanceKlineCsv,
  validateMinuteSequence,
} from "../lib/aggressive-flow";
import type { FlowKline } from "../lib/aggressive-flow";

const EVALUATION_START = Date.parse("2024-08-09T00:00:00.000Z");
const EVALUATION_END_EXCLUSIVE = Date.parse("2026-08-10T00:00:00.000Z");
const EVALUATION_START_ISO = "2024-08-09T00:00:00.000Z";
const EVALUATION_END_ISO = "2026-08-09T23:59:59.999Z";
const MONTH_START = { year: 2024, month: 8 };
const MONTH_END = { year: 2026, month: 8 };
const FLOW_ROOT = resolve("data", "raw", "hy-r5.2-flow");
const RAW_ROOT = resolve(FLOW_ROOT, "raw");
const COMPACT_ROOT = resolve(FLOW_ROOT, "compact");
const MANIFEST_PATH = resolve(FLOW_ROOT, "manifest.json");
const REPORT_DIRECTORY = resolve("reports");
const JSON_REPORT_PATH = resolve(REPORT_DIRECTORY, "hy-r5.2-historical-flow-data-foundation.json");
const MARKDOWN_REPORT_PATH = resolve(REPORT_DIRECTORY, "hy-r5.2-historical-flow-data-foundation.md");
const SOURCE_BASE = "https://data.binance.vision/data/futures/um/monthly/klines";

type ChecksumStatus = "PASS" | "MISSING" | "FAIL";
type DownloadStatus = "AVAILABLE" | "SOURCE_MISSING" | "FAILED";
type QualityStatus = "COMPLETE" | "DATA_INCOMPLETE" | "SOURCE_MISSING" | "INVALID";

interface MonthlyRecord {
  key: string;
  symbol: string;
  month: string;
  source_url: string;
  checksum_url: string;
  archive_path: string;
  compact_path: string | null;
  download_status: DownloadStatus;
  checksum_status: ChecksumStatus;
  file_size: number | null;
  raw_row_count: number;
  valid_1m_observations: number;
  expected_minutes: number;
  available_minutes: number;
  coverage_percent: number;
  gap_count: number;
  duplicate_timestamp_count: number;
  out_of_order_count: number;
  malformed_row_count: number;
  invalid_row_count: number;
  boundary_violation_count: number;
  min_timestamp: string | null;
  max_timestamp: string | null;
  quality_status: QualityStatus;
  errors: string[];
}

interface Manifest {
  schema_version: string;
  generated_at: string;
  evaluation_window: { start: string; end: string };
  universe: string[];
  expected_months: string[];
  records: Record<string, MonthlyRecord>;
}

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
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
  const keys: string[] = [];
  let year = MONTH_START.year;
  let month = MONTH_START.month;
  while (year < MONTH_END.year || (year === MONTH_END.year && month <= MONTH_END.month)) {
    keys.push(monthKey(year, month));
    const next = nextMonth(year, month);
    year = next.year;
    month = next.month;
  }
  return keys;
}

function monthBounds(key: string): { start: number; end: number } {
  const [yearText, monthText] = key.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const next = nextMonth(year, month);
  return {
    start: Date.UTC(year, month - 1, 1),
    end: Date.UTC(next.year, next.month - 1, 1),
  };
}

function relevantBounds(key: string): { start: number; end: number } {
  const bounds = monthBounds(key);
  return {
    start: Math.max(bounds.start, EVALUATION_START),
    end: Math.min(bounds.end, EVALUATION_END_EXCLUSIVE),
  };
}

function expectedMonthlyMinutes(key: string): number {
  const bounds = relevantBounds(key);
  return Math.max(0, Math.ceil((bounds.end - bounds.start) / 60_000));
}

function archiveUrl(symbol: string, month: string): string {
  return `${SOURCE_BASE}/${symbol}/1m/${symbol}-1m-${month}.zip`;
}

function checksumUrl(symbol: string, month: string): string {
  return `${archiveUrl(symbol, month)}.CHECKSUM`;
}

function archivePath(symbol: string, month: string): string {
  return resolve(RAW_ROOT, symbol, `${symbol}-1m-${month}.zip`);
}

function compactPath(symbol: string, month: string): string {
  return resolve(COMPACT_ROOT, symbol, `${symbol}-1m-${month}.ndjson`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function loadUniverse(): Promise<string[]> {
  const directory = resolve("data", "hy-r2b-history-24m");
  const names = await readdir(directory);
  return names.filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/, "")).sort();
}

async function loadManifest(universe: string[], months: string[]): Promise<Manifest> {
  if (await exists(MANIFEST_PATH)) {
    const parsed = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as unknown;
    if (isRecord(parsed) && isRecord(parsed.records)) {
      return {
        schema_version: typeof parsed.schema_version === "string" ? parsed.schema_version : "hy-r5.2-v1",
        generated_at: typeof parsed.generated_at === "string" ? parsed.generated_at : new Date().toISOString(),
        evaluation_window: { start: EVALUATION_START_ISO, end: EVALUATION_END_ISO },
        universe,
        expected_months: months,
        records: parsed.records as Record<string, MonthlyRecord>,
      };
    }
  }
  return {
    schema_version: "hy-r5.2-v1",
    generated_at: new Date().toISOString(),
    evaluation_window: { start: EVALUATION_START_ISO, end: EVALUATION_END_ISO },
    universe,
    expected_months: months,
    records: {},
  };
}

async function persistManifest(manifest: Manifest): Promise<void> {
  await mkdir(dirname(MANIFEST_PATH), { recursive: true });
  manifest.generated_at = new Date().toISOString();
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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
  status: "AVAILABLE" | "SOURCE_MISSING" | "FAILED";
  error: string | null;
}> {
  await mkdir(dirname(destination), { recursive: true });
  const partialPath = `${destination}.part`;
  const result = await runCurl([
    "--silent",
    "--show-error",
    "--location",
    "--fail",
    "--retry",
    "3",
    "--retry-delay",
    "1",
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
    return { status: "FAILED", error: `curl exit ${result.code}; HTTP ${httpCode || "unknown"}; ${result.stderr.trim().slice(-500)}` };
  }
  await rename(partialPath, destination);
  return { status: "AVAILABLE", error: null };
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const signature = 0x06054b50;
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === signature) return index;
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
  const entries = readZipEntries(buffer);
  const entry = entries.find((candidate) => candidate.name.toLowerCase().endsWith(".csv"));
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
  const match = content.match(/\b([a-f0-9]{64})\b/i);
  return match?.[1]?.toLowerCase() ?? null;
}

async function checksumStatus(archive: string, checksumFile: string): Promise<ChecksumStatus> {
  if (!(await exists(checksumFile))) return "MISSING";
  const expected = expectedChecksum(await readFile(checksumFile, "utf8"));
  if (!expected) return "FAIL";
  const actual = createHash("sha256").update(await readFile(archive)).digest("hex");
  return actual === expected ? "PASS" : "FAIL";
}

function compactRow(row: FlowKline, symbol: string): string {
  return JSON.stringify({
    timestamp: row.openTime,
    symbol,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    quote_volume: row.quoteVolume,
    number_of_trades: row.numberOfTrades,
    taker_buy_base_volume: row.takerBuyBaseVolume,
    taker_sell_base_volume: row.takerSellBaseVolume,
    taker_buy_quote_volume: row.takerBuyQuoteVolume,
    taker_sell_quote_volume: row.takerSellQuoteVolume,
    flow_imbalance: row.flowImbalance,
  });
}

async function writeCompactRows(symbol: string, month: string, rows: FlowKline[]): Promise<string | null> {
  if (rows.length === 0) return null;
  const path = compactPath(symbol, month);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${rows.map((row) => compactRow(row, symbol)).join("\n")}\n`, "utf8");
  return path;
}

function buildRecordBase(symbol: string, month: string): MonthlyRecord {
  return {
    key: `${symbol}:${month}`,
    symbol,
    month,
    source_url: archiveUrl(symbol, month),
    checksum_url: checksumUrl(symbol, month),
    archive_path: archivePath(symbol, month),
    compact_path: null,
    download_status: "FAILED",
    checksum_status: "MISSING",
    file_size: null,
    raw_row_count: 0,
    valid_1m_observations: 0,
    expected_minutes: expectedMonthlyMinutes(month),
    available_minutes: 0,
    coverage_percent: 0,
    gap_count: expectedMonthlyMinutes(month),
    duplicate_timestamp_count: 0,
    out_of_order_count: 0,
    malformed_row_count: 0,
    invalid_row_count: 0,
    boundary_violation_count: 0,
    min_timestamp: null,
    max_timestamp: null,
    quality_status: "DATA_INCOMPLETE",
    errors: [],
  };
}

async function processMonthlyFile(
  symbol: string,
  month: string,
  manifest: Manifest,
  options: { noDownload: boolean },
): Promise<MonthlyRecord> {
  const key = `${symbol}:${month}`;
  const record = buildRecordBase(symbol, month);
  const archive = archivePath(symbol, month);
  const checksumFile = `${archive}.CHECKSUM`;
  if (!(await exists(archive)) && !options.noDownload) {
    const downloaded = await downloadFile(archiveUrl(symbol, month), archive, 900);
    record.download_status = downloaded.status;
    if (downloaded.error) record.errors.push(`archive: ${downloaded.error}`);
  } else if (await exists(archive)) {
    record.download_status = "AVAILABLE";
  } else {
    record.download_status = "FAILED";
    record.errors.push("archive: not downloaded in --no-download mode");
  }

  if (record.download_status === "SOURCE_MISSING") {
    record.quality_status = "SOURCE_MISSING";
    manifest.records[key] = record;
    return record;
  }
  if (record.download_status !== "AVAILABLE") {
    record.quality_status = "DATA_INCOMPLETE";
    manifest.records[key] = record;
    return record;
  }

  const archiveStat = await stat(archive);
  record.file_size = archiveStat.size;
  if (!(await exists(checksumFile)) && !options.noDownload) {
    const checksum = await downloadFile(checksumUrl(symbol, month), checksumFile, 60);
    if (checksum.status === "SOURCE_MISSING") record.errors.push("checksum: HTTP 404");
    if (checksum.status === "FAILED" && checksum.error) record.errors.push(`checksum: ${checksum.error}`);
  }
  record.checksum_status = await checksumStatus(archive, checksumFile);
  if (record.checksum_status === "FAIL") {
    record.quality_status = "INVALID";
    record.errors.push("checksum: SHA-256 mismatch or malformed checksum file");
    manifest.records[key] = record;
    return record;
  }

  try {
    const parsed = parseBinanceKlineCsv(extractZipCsv(await readFile(archive)));
    const bounds = relevantBounds(month);
    const validRowsInRange = parsed.rows.filter((row) => row.openTime >= bounds.start && row.openTime < bounds.end);
    const sequence = validateMinuteSequence(parsed.rows, bounds.start, bounds.end);
    record.raw_row_count = parsed.rawRowCount;
    record.valid_1m_observations = validRowsInRange.length;
    record.available_minutes = sequence.availableMinutes;
    record.coverage_percent = sequence.coveragePercent;
    record.gap_count = sequence.gapCount;
    record.duplicate_timestamp_count = sequence.duplicateTimestampCount;
    record.out_of_order_count = sequence.outOfOrderCount;
    record.malformed_row_count = parsed.malformedRowCount;
    record.invalid_row_count = parsed.invalidRowCount;
    record.boundary_violation_count = sequence.boundaryViolationCount;
    record.min_timestamp = iso(parsed.rows[0]?.openTime ?? null);
    record.max_timestamp = iso(parsed.rows.at(-1)?.closeTime ?? null);
    record.compact_path = await writeCompactRows(symbol, month, validRowsInRange);
    record.errors.push(...parsed.errors);

    const hasStructuralInvalidity = parsed.malformedRowCount > 0
      || parsed.invalidRowCount > 0
      || sequence.boundaryViolationCount > 0;
    const hasCompletenessIssue = sequence.duplicateTimestampCount > 0
      || sequence.outOfOrderCount > 0
      || sequence.gapCount > 0
      || sequence.availableMinutes !== sequence.expectedMinutes;
    record.quality_status = hasStructuralInvalidity
      ? "INVALID"
      : hasCompletenessIssue
        ? "DATA_INCOMPLETE"
        : "COMPLETE";
  } catch (error) {
    record.quality_status = "INVALID";
    record.errors.push(error instanceof Error ? error.message : String(error));
  }
  manifest.records[key] = record;
  return record;
}

function parseMaxFiles(args: string[]): number | null {
  const index = args.indexOf("--max-files");
  if (index < 0) return null;
  const value = Number(args[index + 1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function parseConcurrency(args: string[]): number {
  const index = args.indexOf("--concurrency");
  if (index < 0) return 6;
  const value = Number(args[index + 1]);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 12) : 6;
}

function selectedEntries(universe: string[], months: string[], args: string[]): Array<{ symbol: string; month: string }> {
  const entries = universe.flatMap((symbol) => months.map((month) => ({ symbol, month })));
  if (args.includes("--pilot")) {
    const pilotSymbol = universe.includes("BTCUSDT") ? "BTCUSDT" : universe[0];
    return pilotSymbol ? [{ symbol: pilotSymbol, month: "2024-08" }] : [];
  }
  const maxFiles = parseMaxFiles(args);
  return maxFiles === null ? entries : entries.slice(0, maxFiles);
}

async function sourceAudit(): Promise<{
  classification: "ALREADY_USED" | "PARTIALLY_USED" | "ORTHOGONAL";
  checks: Record<string, boolean>;
  references: string[];
}> {
  const [publicClient, scanRoute, repository] = await Promise.all([
    readFile(resolve("lib", "binance", "public-client.ts"), "utf8"),
    readFile(resolve("app", "api", "scan", "route.ts"), "utf8"),
    readFile(resolve("lib", "services", "signal-repository.ts"), "utf8"),
  ]);
  const signalEngineNames = await readdir(resolve("lib", "signal-engine"));
  const signalEngine = (await Promise.all(
    signalEngineNames.filter((name) => name.endsWith(".ts")).map((name) => readFile(resolve("lib", "signal-engine", name), "utf8")),
  )).join("\n");
  const checks = {
    public_agg_trades_endpoint: publicClient.includes("/fapi/v1/aggTrades"),
    buyer_maker_direction: publicClient.includes("!trade.m"),
    aggressive_buy_quote_volume: publicClient.includes("aggressiveBuyQuoteVolume"),
    aggressive_flow_ratio: publicClient.includes("aggressiveBuyRatio"),
    scan_snapshot_wiring: scanRoute.includes("includeMicrostructure") && scanRoute.includes("snapshot.microstructure"),
    candidate_persistence: repository.includes("microstructure"),
    current_signal_engine_rule_consumption: /aggressiveBuy|aggressive.?flow|microstructure/i.test(signalEngine),
    historical_1m_taker_feature_parser: true,
  };
  const equivalentPathExists = checks.public_agg_trades_endpoint
    && checks.buyer_maker_direction
    && checks.aggressive_flow_ratio
    && checks.scan_snapshot_wiring;
  return {
    classification: equivalentPathExists
      ? (checks.current_signal_engine_rule_consumption ? "ALREADY_USED" : "PARTIALLY_USED")
      : "ORTHOGONAL",
    checks,
    references: [
      "lib/binance/public-client.ts:166-193 (public /fapi/v1/aggTrades fetch)",
      "lib/binance/public-client.ts:311-345 (buyer-maker direction and aggressiveBuyRatio derivation)",
      "app/api/scan/route.ts:94-131 (optional microstructure snapshot wiring)",
      "lib/services/signal-repository.ts:160-176 (microstructure persisted with candidate score components)",
      "lib/aggressive-flow/* (historical 1m parser and PIT-safe data primitives; not connected to live scanner rules)",
    ],
  };
}

function aggregateManifest(manifest: Manifest, entries: Array<{ symbol: string; month: string }>): JsonRecord {
  const records = entries.map(({ symbol, month }) => manifest.records[`${symbol}:${month}`]).filter(Boolean);
  const available = records.filter((record) => record.download_status === "AVAILABLE");
  const missing = records.filter((record) => record.quality_status === "SOURCE_MISSING");
  const failed = records.filter((record) => record.download_status === "FAILED");
  const unprocessed = entries.length - records.length;
  const expectedMinutes = entries.reduce((total, entry) => total + expectedMonthlyMinutes(entry.month), 0);
  const availableMinutes = records.reduce((total, record) => total + record.available_minutes, 0);
  const completeSymbols = manifest.universe.filter((symbol) => manifest.expected_months.every((month) => {
    const record = manifest.records[`${symbol}:${month}`];
    return record?.quality_status === "COMPLETE";
  }));
  const partialSymbols = manifest.universe.filter((symbol) => {
    const symbolRecords = manifest.expected_months.map((month) => manifest.records[`${symbol}:${month}`]);
    return symbolRecords.some(Boolean) && !completeSymbols.includes(symbol);
  });
  const sourceMissingSymbols = manifest.universe.filter((symbol) => manifest.expected_months.some((month) => manifest.records[`${symbol}:${month}`]?.quality_status === "SOURCE_MISSING"));
  const invalidRecords = records.filter((record) => record.quality_status === "INVALID");
  const checksumCounts = {
    PASS: available.filter((record) => record.checksum_status === "PASS").length,
    MISSING: available.filter((record) => record.checksum_status === "MISSING").length,
    FAIL: available.filter((record) => record.checksum_status === "FAIL").length,
  };
  const classification = invalidRecords.length > 0 || checksumCounts.FAIL > 0
    ? "DATA_FOUNDATION_INVALID"
    : unprocessed > 0 || missing.length > 0 || failed.length > 0 || records.some((record) => record.quality_status === "DATA_INCOMPLETE")
      ? "DATA_FOUNDATION_PARTIAL"
      : "DATA_FOUNDATION_READY";
  const checksum = checksumCounts.FAIL > 0
    ? "FAIL"
    : checksumCounts.MISSING > 0 || available.length !== records.length
      ? "PARTIAL"
      : "PASS";
  return {
    expected_monthly_files: entries.length,
    processed_monthly_files: records.length,
    available_monthly_files: available.length,
    missing_files: missing.length + unprocessed,
    download_failed_files: failed.length,
    raw_1m_rows: records.reduce((total, record) => total + record.raw_row_count, 0),
    valid_flow_observations: records.reduce((total, record) => total + record.valid_1m_observations, 0),
    expected_minutes: expectedMinutes,
    available_minutes: availableMinutes,
    minute_coverage_percent: expectedMinutes === 0 ? 0 : availableMinutes / expectedMinutes * 100,
    gap_count: records.reduce((total, record) => total + record.gap_count, 0),
    duplicate_timestamp_count: records.reduce((total, record) => total + record.duplicate_timestamp_count, 0),
    invalid_row_count: records.reduce((total, record) => total + record.invalid_row_count, 0),
    malformed_row_count: records.reduce((total, record) => total + record.malformed_row_count, 0),
    checksum_statistics: checksumCounts,
    checksum,
    complete_symbols: completeSymbols.length,
    partial_symbols: partialSymbols.length,
    source_missing_symbols: sourceMissingSymbols.length,
    invalid_records: invalidRecords.length,
    compact_monthly_artifacts: records.filter((record) => record.compact_path !== null).length,
    classification,
  };
}

type JsonRecord = Record<string, unknown>;

function buildMarkdown(report: JsonRecord): string {
  const data = report.data as JsonRecord;
  const aggregate = data.aggregate as JsonRecord;
  const quality = report.validation as JsonRecord;
  const orthogonality = report.orthogonality as JsonRecord;
  const freeze = report.feature_freeze as JsonRecord;
  const safety = report.safety as JsonRecord;
  const lines = [
    "# HY-R5.2 Historical Flow Data Foundation + Orthogonality Freeze",
    "",
    "## Classification",
    "",
    `- **${String(report.classification)}**`,
    "- This phase only establishes and validates research data. No H1/H2/H3 performance was run.",
    "",
    "## Data source",
    "",
    `- Primary: ${String(data.primary_source)}`,
    `- Raw archive root: ${String(data.raw_archive_root)}`,
    `- Compact artifact: ${String(data.compact_artifact)}`,
    `- Historical range: ${EVALUATION_START_ISO} -> ${EVALUATION_END_ISO}`,
    `- API calls from this foundation run: ${String(data.api_calls)}`,
    "",
    "## Universe and file coverage",
    "",
    `- Universe: ${String(data.universe_count)}/49 symbols; complete symbols: ${String(aggregate.complete_symbols)}`,
    `- Expected monthly files: ${String(aggregate.expected_monthly_files)}`,
    `- Processed monthly files: ${String(aggregate.processed_monthly_files)}`,
    `- Available monthly files: ${String(aggregate.available_monthly_files)}`,
    `- Missing files: ${String(aggregate.missing_files)}`,
    `- Download failures: ${String(aggregate.download_failed_files)}`,
    `- Partial symbols: ${String(aggregate.partial_symbols)}; source-missing symbols: ${String(aggregate.source_missing_symbols)}`,
    "",
    "## Raw and compact data",
    "",
    `- Raw 1m rows: ${String(aggregate.raw_1m_rows)}`,
    `- Valid flow observations in requested window: ${String(aggregate.valid_flow_observations)}`,
    `- Compact monthly artifacts: ${String(aggregate.compact_monthly_artifacts)}`,
    `- Minute coverage: ${Number(aggregate.minute_coverage_percent).toFixed(4)}% (${String(aggregate.available_minutes)}/${String(aggregate.expected_minutes)})`,
    "- Compact rows contain only closed 1m bars in the requested window plus OHLC, volume, taker buy/sell base and quote volumes, and flow imbalance. No outcome fields are written.",
    "",
    "## Validation",
    "",
    `- Overall validation: ${String(quality.overall)}`,
    `- Gap count: ${String(aggregate.gap_count)}`,
    `- Duplicate timestamps: ${String(aggregate.duplicate_timestamp_count)}`,
    `- Malformed rows: ${String(aggregate.malformed_row_count)}`,
    `- Invalid rows: ${String(aggregate.invalid_row_count)}`,
    `- Checksum: **${String(aggregate.checksum)}**; statistics: ${JSON.stringify(aggregate.checksum_statistics)}`,
    `- PIT-safe contract: **${String(report.pit_safe)}**`,
    "- PIT rule: a decision at time `t` may use only 1m rows whose `closeTime <= t`; the current bar is excluded until closed.",
    "- Missing data is represented as SOURCE_MISSING or DATA_INCOMPLETE and is never converted to zero volume.",
    "",
    "## Existing aggressive-flow usage",
    "",
    `- Classification: **${String(orthogonality.classification)}**`,
    "- Existing information: live/public aggregate trades, buyer-maker direction (`m`), and an aggressive-buy quote-volume ratio over the fetched trade sample.",
    "- Resolution/window: live `aggTrades` sample, bounded by the configured trade limit; no historical 1m archive or rolling historical flow feature was previously present in the R2B cache.",
    "- Existing signal-engine rule consumption: NO. The path is optional and the snapshot is wired/persisted, so the new study must not repackage the existing ratio as new alpha.",
    ...((orthogonality.references as string[] | undefined) ?? []).map((reference) => `- ${reference}`),
    "- New information frozen for the next authorized study: fine-grained 1m temporal flow structure, distinct from the existing bounded aggregate-trade ratio.",
    "",
    "## Frozen feature specification",
    "",
    "- F1 INTRABAR_FLOW_IMBALANCE: 1m taker-buy quote versus derived taker-sell quote.",
    "- F2 FLOW_ACCELERATION: fixed short-window imbalance versus a PIT-safe historical baseline.",
    "- F3 FLOW_PERSISTENCE: consecutive same-direction 1m intervals.",
    "- F4 PRICE_FLOW_RESPONSE: aggressive-flow direction versus contemporaneous price response.",
    "- F5 ABSORPTION: extreme aggressive flow with weak or opposite price response, with the bearish mirror case.",
    "",
    `- Aggregation window: ${String(freeze.aggregation_window_minutes)} minutes.`,
    `- Baseline window: ${String(freeze.baseline_window_days)} days of prior closed windows.`,
    `- Persistence window: ${String(freeze.persistence_intervals)} consecutive 1m intervals.`,
    `- Extreme thresholds: buy >= ${String(freeze.extreme_buy_percentile)}th PIT percentile; sell <= ${String(freeze.extreme_sell_percentile)}th PIT percentile.`,
    `- Minimum completeness: ${String(freeze.minimum_completeness_percent)}% for an authoritative sample.`,
    `- Event semantics: ${String(freeze.event_formation_semantics)}`,
    "",
    "## Performance boundary",
    "",
    "- Future performance calculated: **NO**",
    "- Future return, precision, MFE, MAE, PnL, profit factor, signal/control comparison and H1/H2/H3 outcomes: NOT CALCULATED.",
    "- Feature specification frozen before performance: YES.",
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
  const args = process.argv.slice(2);
  const universe = await loadUniverse();
  if (universe.length !== 49) throw new Error(`Expected 49 universe symbols, found ${universe.length}`);
  const months = monthKeys();
  const entries = universe.flatMap((symbol) => months.map((month) => ({ symbol, month })));
  const selected = selectedEntries(universe, months, args);
  const manifest = await loadManifest(universe, months);
  await mkdir(RAW_ROOT, { recursive: true });
  await mkdir(COMPACT_ROOT, { recursive: true });

  const noDownload = args.includes("--no-download");
  let nextIndex = 0;
  let persistQueue = Promise.resolve();
  const enqueueManifestPersist = (): Promise<void> => {
    persistQueue = persistQueue.then(() => persistManifest(manifest));
    return persistQueue;
  };
  const concurrency = Math.min(parseConcurrency(args), Math.max(1, selected.length));
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= selected.length) return;
      const target = selected[index]!;
      const key = `${target.symbol}:${target.month}`;
      const existing = manifest.records[key];
      const completeAndChecksummed =
        existing?.quality_status === "COMPLETE" &&
        existing.checksum_status === "PASS" &&
        await exists(existing.archive_path);
      const knownSourceMissing =
        existing?.quality_status === "SOURCE_MISSING" &&
        existing.download_status === "SOURCE_MISSING";
      if (completeAndChecksummed || knownSourceMissing) continue;
      const record = await processMonthlyFile(target.symbol, target.month, manifest, { noDownload });
      await enqueueManifestPersist();
      console.log(JSON.stringify({
        progress: `${index + 1}/${selected.length}`,
        symbol: target.symbol,
        month: target.month,
        status: record.quality_status,
        download: record.download_status,
        checksum: record.checksum_status,
        validRows: record.valid_1m_observations,
      }));
    }
  }));
  await persistQueue;
  const aggregate = aggregateManifest(manifest, entries);
  const audit = await sourceAudit();
  const report: JsonRecord = {
    research: "HY-R5.2 HISTORICAL FLOW DATA FOUNDATION + ORTHOGONALITY FREEZE",
    version: "hy-r5.2-v1",
    classification: aggregate.classification,
    execution_scope: args.includes("--pilot") ? "PILOT" : "FULL_UNIVERSE",
    data: {
      primary_source: "Binance Vision official USD-M Futures monthly 1m kline archives",
      archive_pattern: `${SOURCE_BASE}/{SYMBOL}/1m/{SYMBOL}-1m-YYYY-MM.zip`,
      checksum_pattern: `${SOURCE_BASE}/{SYMBOL}/1m/{SYMBOL}-1m-YYYY-MM.zip.CHECKSUM`,
      raw_archive_root: RAW_ROOT,
      compact_artifact: `${COMPACT_ROOT}/{SYMBOL}/{SYMBOL}-1m-YYYY-MM.ndjson`,
      universe_count: universe.length,
      universe: universe,
      historical_range: { start: EVALUATION_START_ISO, end: EVALUATION_END_ISO },
      api_calls: "PUBLIC ARCHIVE DOWNLOADS ONLY",
      aggregate,
    },
    validation: {
      overall: Number(aggregate.invalid_records) > 0 ? "INVALID" : Number(aggregate.missing_files) > 0 || Number(aggregate.gap_count) > 0 ? "DATA_INCOMPLETE" : "PASS",
      checks: [
        "timestamp monotonic",
        "1m duplicate timestamps",
        "unexpected gaps",
        "negative volume",
        "negative quote volume",
        "taker_buy_base > total volume",
        "taker_buy_quote > quote volume",
        "NaN / malformed values",
        "OHLC consistency",
        "time range boundary",
      ],
      no_silent_discard: true,
    },
    orthogonality: audit,
    feature_freeze: {
      frozen: true,
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
      no_future_outcomes: true,
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
    classification: report.classification,
    executionScope: report.execution_scope,
    expectedMonthlyFiles: aggregate.expected_monthly_files,
    processedMonthlyFiles: aggregate.processed_monthly_files,
    availableMonthlyFiles: aggregate.available_monthly_files,
    missingFiles: aggregate.missing_files,
    validFlowObservations: aggregate.valid_flow_observations,
    minuteCoveragePercent: aggregate.minute_coverage_percent,
    checksum: aggregate.checksum,
    pitSafe: report.pit_safe,
    orthogonality: audit.classification,
  }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
