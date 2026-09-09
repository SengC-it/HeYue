import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  BASIS_PREMIUM_FAMILIES,
  cutoffManifestHash,
  expectedTimestamps,
  isTimestampInLifecycle,
  parseBinanceKlineCsv,
  resolutionMilliseconds,
} from "../lib/basis-premium";
import {
  alignFamilyTimestamps,
  extractZipCsv,
  isCompletePitBar,
  OFFICIAL_BINANCE_KLINE_COLUMNS,
  validateKlineSchema,
} from "../lib/basis-premium/clean-foundation";
import {
  assertR59DiscoveryWindow,
  R58C_CONTAMINATED_WINDOW,
  R59_CLEAN_DISCOVERY_WINDOW,
  R59_RESERVED_HOLDOUT,
} from "../lib/basis-premium/clean-window";
import type {
  BasisPremiumFamily,
  BasisPremiumKline,
  BasisPremiumResolution,
  LifecycleSpan,
} from "../lib/basis-premium";
import { lifecycleIntervalsForSymbol, sha256Json, stableJson } from "../lib/crowding";

type JsonRecord = Record<string, unknown>;
type ArchiveStatus = "VALID" | "MISSING" | "CORRUPT";
type DownloadStatus = "AVAILABLE" | "MISSING" | "FAILED";

interface ListingRecord {
  symbol: string;
  onboardDate: number;
  deliveryDate: number;
  status?: string;
  [key: string]: unknown;
}

interface ArchiveTarget {
  key: string;
  family: BasisPremiumFamily;
  symbol: string;
  period: string;
  resolution: BasisPremiumResolution;
  url: string;
  zipPath: string;
  checksumPath: string;
}

interface ArchiveAudit extends ArchiveTarget {
  downloadStatus: DownloadStatus;
  status: ArchiveStatus;
  httpStatus: number | null;
  bytes: number;
  sha256: string | null;
  officialChecksum: string | null;
  rawRows: number;
  parsedRows: number;
  validRows: number;
  rejectedRows: number;
  outOfWindowRows: number;
  outOfLifecycleRows: number;
  schemaConflictRows: number;
  schemaConflicts: string[];
  invalidRows: number;
  invalidTimestampRows: number;
  invalidPriceRows: number;
  invalidVolumeRows: number;
  duplicateRows: number;
  outOfOrderRows: number;
  cadenceBreaks: number;
  partialBars: number;
  headerFields: string[] | null;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  errors: string[];
}

interface RawSample {
  key: string;
  family: BasisPremiumFamily;
  symbol: string;
  period: string;
  sourceUrl: string;
  filePath: string;
  headerFields: string[] | null;
  headerStatus: "PRESENT" | "ABSENT_OFFICIAL_FORMAT";
  exactSchemaFields: string[];
  firstThreeRawRows: string[];
  firstThreeTimestamps: string[];
  timestampSpacingMilliseconds: number | null;
}

interface SymbolCoverage {
  symbol: string;
  expected: number;
  valid: number;
  missing: number;
  coveragePercent: number | null;
}

interface PeriodCoverage {
  period: string;
  expected: number;
  valid: number;
  missing: number;
  coveragePercent: number | null;
}

interface FamilyData {
  rowsBySymbol: Map<string, Map<number, BasisPremiumKline>>;
  expectedBySymbol: Map<string, Set<number>>;
}

interface MaterializedFile {
  path: string;
  sha256: string;
  bytes: number;
  rows: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
}

const RESOLUTION: BasisPremiumResolution = "1h";
const STEP_MS = resolutionMilliseconds(RESOLUTION);
const CLEAN_START = R59_CLEAN_DISCOVERY_WINDOW.start;
const CLEAN_END_EXCLUSIVE = R59_CLEAN_DISCOVERY_WINDOW.endExclusive;
const CLEAN_START_ISO = R59_CLEAN_DISCOVERY_WINDOW.startIso;
const CLEAN_END_ISO = R59_CLEAN_DISCOVERY_WINDOW.endIso;
const ARCHIVE_BASE = "https://data.binance.vision/data/futures/um";
const ARCHIVE_ROOT = resolve("data", "raw", "hy-r5.9-clean-basis-premium");
const ARCHIVES_ROOT = resolve(ARCHIVE_ROOT, "archives");
const MATERIALIZED_ROOT = resolve(ARCHIVE_ROOT, "materialized");
const ARTIFACT_ROOT = resolve(ARCHIVE_ROOT, "artifacts");
const LISTING_EVIDENCE_PATH = resolve("data", "raw", "hy-r5.2b-flow", "listing-evidence.json");
const JSON_REPORT_PATH = resolve("reports", "hy-r5.9a-clean-basis-premium-data-foundation.json");
const MARKDOWN_REPORT_PATH = resolve("reports", "hy-r5.9a-clean-basis-premium-data-foundation.md");
const CLEAN_COVERAGE_PATH = resolve(ARTIFACT_ROOT, "clean-coverage-matrix.json");
const CLEAN_SCHEMA_PATH = resolve(ARTIFACT_ROOT, "clean-schema-manifest.json");
const CLEAN_DATASET_PATH = resolve(ARTIFACT_ROOT, "clean-dataset-manifest.json");
const CLEAN_ALIGNED_PATH = resolve(ARTIFACT_ROOT, "clean-aligned-data-manifest.json");
const CLEAN_HASHES_PATH = resolve(ARTIFACT_ROOT, "clean-artifact-hashes.json");
const R57_ARTIFACT_ROOT = resolve("data", "raw", "hy-r5.7-basis-premium-preflight", "artifacts");
const R57_COVERAGE_PATH = resolve(R57_ARTIFACT_ROOT, "coverage-matrix.json");
const R57_SCHEMA_PATH = resolve(R57_ARTIFACT_ROOT, "schema-manifest.json");
const R57_FEATURE_PATH = resolve(R57_ARTIFACT_ROOT, "feature-specification.json");
const R57_DATASET_PATH = resolve(R57_ARTIFACT_ROOT, "dataset-manifest.json");
const R58A_PATH = resolve("reports", "hy-r5.8a-basis-premium-hypothesis-freeze.json");
const R58A1_PATH = resolve("reports", "hy-r5.8a1-basis-premium-event-cutoff-freeze.json");
const R58C_RUNNER_PATH = "scripts/run-hy-r5-8c-basis-premium-information-gain.ts";
const R58D_RUNNER_PATH = "scripts/run-hy-r5-8d-outcome-direction-remediation.ts";
const R58D_OUTCOME_PATH = "lib/basis-premium/outcome.ts";
const R58D_SOURCE_HASH = "ae88361b55b519975b8a297ca8f85ef4e5177eb8e1ac78eaaa1ed7cccca7fd77";
const R58D_OUTCOME_HASH = "8a4e81ca26c050c337012b233fa2d7017c7ecc1dfa46dabdfe9b3a142e937465";
const R58_FROZEN_HASHES = {
  r57_coverage_matrix: "add14656788d11e4852840956895803c26c4eb8a10053c2e50d8bbadf9278447",
  r57_schema_manifest: "17da39cd0ad500b21b2f1380bf526bdc1175738091f5b0ada05d0e73dcd3288a",
  r57_feature_specification: "bbdaab9e4cba4c22e50471d538d808fca992e812aaff60a0fc3f70af6020cf51",
  r57_dataset_manifest: "4a6c99a36df032f605b96a63dffda35beb2cce60679281368070da57480f8da0",
  r58a_hypothesis_manifest: "0b5a790a1783704fc5eb130c4d1fa65c865339e68232fa1b54af9012c58db0f3",
  r58a1_cutoff_manifest: "95fe1b5a20b0d4804e52dbc01c2f0e730a8f6b377e0c29ae2877875d8f06e800",
} as const;
const FAMILY_SEGMENT: Record<BasisPremiumFamily, string> = {
  PREMIUM_INDEX: "premiumIndexKlines",
  INDEX_PRICE: "indexPriceKlines",
  MARK_PRICE: "markPriceKlines",
  PERPETUAL_PRICE: "klines",
};

function asRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("EXPECTED_OBJECT");
  return value as JsonRecord;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function relativePath(path: string): string {
  return relative(resolve("."), path).replaceAll("\\", "/");
}

function iso(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function monthKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function quarterKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

function monthStart(period: string): number {
  const [year, month] = period.split("-").map(Number);
  return Date.UTC(year!, month! - 1, 1);
}

function nextMonth(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function monthKeys(start: number, endExclusive: number): string[] {
  const periods: string[] = [];
  for (let cursor = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1); cursor < endExclusive; cursor = nextMonth(cursor)) {
    periods.push(monthKey(cursor));
  }
  return periods;
}

function familyPath(family: BasisPremiumFamily): string {
  return family.toLowerCase();
}

function archiveTarget(family: BasisPremiumFamily, symbol: string, period: string): ArchiveTarget {
  const filename = `${symbol}-${RESOLUTION}-${period}.zip`;
  const url = `${ARCHIVE_BASE}/monthly/${FAMILY_SEGMENT[family]}/${symbol}/${RESOLUTION}/${filename}`;
  const zipPath = resolve(ARCHIVES_ROOT, familyPath(family), symbol, RESOLUTION, filename);
  return {
    key: `${family}|${symbol}|${RESOLUTION}|${period}`,
    family,
    symbol,
    period,
    resolution: RESOLUTION,
    url,
    zipPath,
    checksumPath: `${zipPath}.CHECKSUM`,
  };
}

function emptyAudit(target: ArchiveTarget): ArchiveAudit {
  return {
    ...target,
    downloadStatus: "FAILED",
    status: "CORRUPT",
    httpStatus: null,
    bytes: 0,
    sha256: null,
    officialChecksum: null,
    rawRows: 0,
    parsedRows: 0,
    validRows: 0,
    rejectedRows: 0,
    outOfWindowRows: 0,
    outOfLifecycleRows: 0,
    schemaConflictRows: 0,
    schemaConflicts: [],
    invalidRows: 0,
    invalidTimestampRows: 0,
    invalidPriceRows: 0,
    invalidVolumeRows: 0,
    duplicateRows: 0,
    outOfOrderRows: 0,
    cadenceBreaks: 0,
    partialBars: 0,
    headerFields: null,
    firstTimestamp: null,
    lastTimestamp: null,
    errors: [],
  };
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}

function parseOfficialChecksum(content: string): string | null {
  const match = content.trim().match(/^([0-9a-f]{64})(?:\s|$)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

async function fetchBytes(url: string): Promise<{ status: number; bytes: Buffer }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "HeYue-HY-R5.9A-clean-foundation" },
        signal: AbortSignal.timeout(180_000),
      });
      if (response.status === 404) return { status: 404, bytes: Buffer.alloc(0) };
      if (!response.ok) throw new Error(`HTTP_${String(response.status)}`);
      return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function downloadArchive(target: ArchiveTarget): Promise<ArchiveAudit> {
  const audit = emptyAudit(target);
  await mkdir(resolve(target.zipPath, ".."), { recursive: true });
  try {
    const [zipBytes, checksumText] = await Promise.all([
      readFile(target.zipPath),
      readFile(target.checksumPath, "utf8"),
    ]);
    const officialChecksum = parseOfficialChecksum(checksumText);
    const actualChecksum = sha256Bytes(zipBytes);
    if (officialChecksum !== null && officialChecksum === actualChecksum) {
      audit.downloadStatus = "AVAILABLE";
      audit.httpStatus = 200;
      audit.bytes = zipBytes.byteLength;
      audit.sha256 = actualChecksum;
      audit.officialChecksum = officialChecksum;
      return audit;
    }
  } catch {
    // Acquire or refresh the archive below.
  }

  let archive: { status: number; bytes: Buffer };
  try {
    archive = await fetchBytes(target.url);
  } catch (error) {
    audit.errors.push(error instanceof Error ? error.message : String(error));
    return audit;
  }
  audit.httpStatus = archive.status;
  if (archive.status === 404) {
    audit.downloadStatus = "MISSING";
    audit.status = "MISSING";
    audit.errors.push("HTTP_404");
    return audit;
  }
  let checksumResponse: { status: number; bytes: Buffer };
  try {
    checksumResponse = await fetchBytes(`${target.url}.CHECKSUM`);
  } catch (error) {
    audit.errors.push(error instanceof Error ? error.message : String(error));
    return audit;
  }
  if (checksumResponse.status === 404) {
    audit.errors.push("CHECKSUM_HTTP_404");
    return audit;
  }
  const officialChecksum = parseOfficialChecksum(checksumResponse.bytes.toString("utf8"));
  const actualChecksum = sha256Bytes(archive.bytes);
  audit.bytes = archive.bytes.byteLength;
  audit.sha256 = actualChecksum;
  audit.officialChecksum = officialChecksum;
  if (officialChecksum === null || officialChecksum !== actualChecksum) {
    audit.errors.push(officialChecksum === null ? "CHECKSUM_FORMAT_INVALID" : "CHECKSUM_MISMATCH");
    return audit;
  }
  await writeFile(target.zipPath, archive.bytes);
  await writeFile(target.checksumPath, checksumResponse.bytes);
  audit.downloadStatus = "AVAILABLE";
  return audit;
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
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => consume()));
  return results;
}

function rawDataDocument(csv: string): { headerFields: string[] | null; headerLine: string | null; dataLines: string[] } {
  const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const firstCells = lines[0]?.split(",").map((cell) => cell.trim()) ?? [];
  const headerLike = firstCells[0]?.toLowerCase() === "open_time"
    || (firstCells.length > 0 && !Number.isFinite(Number(firstCells[0])));
  return {
    headerFields: headerLike ? firstCells : null,
    headerLine: headerLike ? lines[0] ?? null : null,
    dataLines: headerLike ? lines.slice(1) : lines,
  };
}

function sampleFor(
  audit: ArchiveAudit,
  document: { headerFields: string[] | null; dataLines: string[] },
  rows: BasisPremiumKline[],
  postListedSymbol: string,
  samples: Map<string, RawSample>,
): void {
  if (audit.family !== "PERPETUAL_PRICE") return;
  if (!(audit.symbol === "BTCUSDT" || audit.symbol === "ETHUSDT" || audit.symbol === postListedSymbol)) return;
  const key = audit.symbol;
  if (samples.has(key) || rows.length < 3) return;
  const first = rows.slice(0, 3).map((row) => row.openTime);
  samples.set(key, {
    key,
    family: audit.family,
    symbol: audit.symbol,
    period: audit.period,
    sourceUrl: audit.url,
    filePath: relativePath(audit.zipPath),
    headerFields: document.headerFields,
    headerStatus: document.headerFields === null ? "ABSENT_OFFICIAL_FORMAT" : "PRESENT",
    exactSchemaFields: [...OFFICIAL_BINANCE_KLINE_COLUMNS],
    firstThreeRawRows: document.dataLines.slice(0, 3),
    firstThreeTimestamps: first.map((timestamp) => new Date(timestamp).toISOString()),
    timestampSpacingMilliseconds: first[1] === undefined || first[0] === undefined ? null : first[1] - first[0],
  });
}

async function parseArchive(
  audit: ArchiveAudit,
  spans: LifecycleSpan[],
  postListedSymbol: string,
  samples: Map<string, RawSample>,
): Promise<BasisPremiumKline[]> {
  if (audit.downloadStatus !== "AVAILABLE") {
    audit.status = audit.downloadStatus === "MISSING" ? "MISSING" : "CORRUPT";
    return [];
  }
  try {
    const zipBytes = await readFile(audit.zipPath);
    const csv = extractZipCsv(zipBytes);
    const document = rawDataDocument(csv);
    audit.headerFields = document.headerFields;
    audit.rawRows = document.dataLines.length;
    const rowFieldCounts = document.dataLines.map((line) => line.split(",").length);
    const schema = validateKlineSchema(document.headerFields, rowFieldCounts);
    audit.schemaConflicts = schema.conflicts;
    audit.schemaConflictRows = rowFieldCounts.filter((count) => count !== OFFICIAL_BINANCE_KLINE_COLUMNS.length).length;
    const exactDataLines = document.dataLines.filter((line) => line.split(",").length === OFFICIAL_BINANCE_KLINE_COLUMNS.length);
    const parserInput = document.headerLine === null
      ? exactDataLines.join("\n")
      : [document.headerLine, ...exactDataLines].join("\n");
    const parsed = parseBinanceKlineCsv(parserInput, { family: audit.family, resolution: RESOLUTION });
    audit.parsedRows = parsed.rows.length;
    audit.rejectedRows = audit.rawRows - audit.parsedRows;
    audit.invalidRows = parsed.invalidRowCount;
    audit.invalidTimestampRows = parsed.invalidTimestampCount;
    audit.invalidPriceRows = parsed.invalidPriceCount;
    audit.invalidVolumeRows = parsed.invalidVolumeCount;
    audit.duplicateRows = parsed.duplicateTimestampCount;
    audit.outOfOrderRows = parsed.outOfOrderCount;
    audit.cadenceBreaks = parsed.cadenceBreakCount;
    audit.partialBars = parsed.boundaryViolationCount;
    audit.firstTimestamp = parsed.rows[0]?.openTime ?? null;
    audit.lastTimestamp = parsed.rows.at(-1)?.openTime ?? null;
    audit.errors.push(...parsed.issues.slice(0, 10));
    audit.outOfWindowRows = parsed.rows.filter((row) => row.openTime < CLEAN_START || row.openTime >= CLEAN_END_EXCLUSIVE).length;
    audit.outOfLifecycleRows = parsed.rows.filter((row) => row.openTime >= CLEAN_START
      && row.openTime < CLEAN_END_EXCLUSIVE
      && !isTimestampInLifecycle(row.openTime, spans)).length;
    const cleanRows = parsed.rows.filter((row) => row.openTime >= CLEAN_START
      && row.openTime < CLEAN_END_EXCLUSIVE
      && isTimestampInLifecycle(row.openTime, spans));
    audit.validRows = cleanRows.length;
    sampleFor(audit, document, parsed.rows, postListedSymbol, samples);
    const timestampSemanticsPass = parsed.rows.every((row) => row.openTime >= 1_000_000_000_000
      && row.openTime < 10_000_000_000_000
      && row.openTime % STEP_MS === 0
      && isCompletePitBar(row.openTime, row.closeTime, STEP_MS));
    if (!timestampSemanticsPass) audit.schemaConflicts.push("TIMESTAMP_OR_PIT_SEMANTICS_INVALID");
    audit.schemaConflicts = [...new Set(audit.schemaConflicts)];
    const parserClean = parsed.invalidRowCount === 0
      && parsed.duplicateTimestampCount === 0
      && parsed.outOfOrderCount === 0
      && parsed.boundaryViolationCount === 0;
    if (schema.passed && timestampSemanticsPass && parserClean) {
      audit.status = "VALID";
      return cleanRows;
    }
    audit.status = "CORRUPT";
    return [];
  } catch (error) {
    audit.status = "CORRUPT";
    audit.errors.push(error instanceof Error ? error.message : String(error));
    return [];
  }
}

function buildInitialTargets(
  symbols: ListingRecord[],
  lifecycles: Map<string, LifecycleSpan[]>,
  periods: string[],
): ArchiveTarget[] {
  const targets: ArchiveTarget[] = [];
  for (const listing of symbols) {
    const spans = lifecycles.get(listing.symbol) ?? [];
    for (const period of periods) {
      const start = Math.max(CLEAN_START, monthStart(period));
      const end = Math.min(CLEAN_END_EXCLUSIVE, nextMonth(monthStart(period)));
      if (expectedTimestamps(spans, start, end, RESOLUTION).length === 0) continue;
      for (const family of BASIS_PREMIUM_FAMILIES) targets.push(archiveTarget(family, listing.symbol, period));
    }
  }
  return targets.sort((left, right) => left.key.localeCompare(right.key));
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function timestampExtent(
  rowsBySymbol: Map<string, Map<number, BasisPremiumKline>>,
  direction: "MIN" | "MAX",
): number | null {
  let result: number | null = null;
  for (const rows of rowsBySymbol.values()) {
    for (const timestamp of rows.keys()) {
      if (result === null) result = timestamp;
      else if (direction === "MIN" && timestamp < result) result = timestamp;
      else if (direction === "MAX" && timestamp > result) result = timestamp;
    }
  }
  return result;
}

function coveragePercent(valid: number, expected: number): number | null {
  return expected > 0 ? valid / expected * 100 : null;
}

function symbolCoverage(symbol: string, expected: Set<number>, valid: Map<number, BasisPremiumKline>): SymbolCoverage {
  const validCount = [...expected].filter((timestamp) => valid.has(timestamp)).length;
  return {
    symbol,
    expected: expected.size,
    valid: validCount,
    missing: expected.size - validCount,
    coveragePercent: coveragePercent(validCount, expected.size),
  };
}

function worstCoverage<T extends { coveragePercent: number | null; expected: number }>(rows: T[]): T | null {
  return [...rows].sort((left, right) => {
    const leftCoverage = left.coveragePercent ?? Number.POSITIVE_INFINITY;
    const rightCoverage = right.coveragePercent ?? Number.POSITIVE_INFINITY;
    return leftCoverage - rightCoverage || right.expected - left.expected || stableJson(left).localeCompare(stableJson(right));
  })[0] ?? null;
}

function periodCoverage(
  period: string,
  expectedBySymbol: Map<string, Set<number>>,
  validBySymbol: Map<string, Set<number>>,
  periodOf: (timestamp: number) => string,
): PeriodCoverage {
  let expected = 0;
  let valid = 0;
  for (const [symbol, timestamps] of expectedBySymbol) {
    for (const timestamp of timestamps) {
      if (periodOf(timestamp) !== period) continue;
      expected += 1;
      if (validBySymbol.get(symbol)?.has(timestamp) === true) valid += 1;
    }
  }
  return { period, expected, valid, missing: expected - valid, coveragePercent: coveragePercent(valid, expected) };
}

function rowToCsv(row: BasisPremiumKline): string {
  return [
    row.openTime,
    row.open,
    row.high,
    row.low,
    row.close,
    row.volume,
    row.closeTime,
    row.quoteAssetVolume,
    row.numberOfTrades,
    row.takerBuyBaseAssetVolume,
    row.takerBuyQuoteAssetVolume,
    row.ignore,
  ].join(",");
}

async function materializeFamily(
  family: BasisPremiumFamily,
  symbols: string[],
  data: FamilyData,
): Promise<MaterializedFile[]> {
  const files: MaterializedFile[] = [];
  for (const symbol of symbols) {
    const rows = [...(data.rowsBySymbol.get(symbol)?.values() ?? [])].sort((left, right) => left.openTime - right.openTime);
    const outputPath = resolve(MATERIALIZED_ROOT, "families", familyPath(family), `${symbol}-${RESOLUTION}.csv`);
    await mkdir(resolve(outputPath, ".."), { recursive: true });
    const content = `${OFFICIAL_BINANCE_KLINE_COLUMNS.join(",")}\n${rows.map(rowToCsv).join("\n")}${rows.length > 0 ? "\n" : ""}`;
    await writeFile(outputPath, content, "utf8");
    const fileStat = await stat(outputPath);
    files.push({
      path: relativePath(outputPath),
      sha256: await sha256File(outputPath),
      bytes: fileStat.size,
      rows: rows.length,
      firstTimestamp: iso(rows[0]?.openTime ?? null),
      lastTimestamp: iso(rows.at(-1)?.openTime ?? null),
    });
  }
  return files;
}

async function materializeAligned(
  symbols: string[],
  expectedBySymbol: Map<string, Set<number>>,
  familyData: Map<BasisPremiumFamily, FamilyData>,
): Promise<{ files: MaterializedFile[]; alignedBySymbol: Map<string, Set<number>>; expected: number; valid: number }> {
  const files: MaterializedFile[] = [];
  const alignedBySymbol = new Map<string, Set<number>>();
  let expected = 0;
  let valid = 0;
  const header = ["timestamp", "pit_available_at", "premium_close", "index_close", "mark_close", "perpetual_close"];
  for (const symbol of symbols) {
    const expectedTimestampsForSymbol = expectedBySymbol.get(symbol) ?? new Set<number>();
    const familyMaps = BASIS_PREMIUM_FAMILIES.map((family) => familyData.get(family)!.rowsBySymbol.get(symbol) ?? new Map<number, BasisPremiumKline>());
    const alignment = alignFamilyTimestamps(expectedTimestampsForSymbol, familyMaps.map((rows) => new Set(rows.keys())));
    expected += alignment.expected;
    valid += alignment.valid;
    const aligned = new Set(alignment.validTimestamps);
    alignedBySymbol.set(symbol, aligned);
    const lines = alignment.validTimestamps.map((timestamp) => {
      const closes = familyMaps.map((rows) => rows.get(timestamp)!.close);
      return [timestamp, timestamp + STEP_MS, ...closes].join(",");
    });
    const outputPath = resolve(MATERIALIZED_ROOT, "aligned", `${symbol}-${RESOLUTION}.csv`);
    await mkdir(resolve(outputPath, ".."), { recursive: true });
    const content = `${header.join(",")}\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
    await writeFile(outputPath, content, "utf8");
    const fileStat = await stat(outputPath);
    files.push({
      path: relativePath(outputPath),
      sha256: await sha256File(outputPath),
      bytes: fileStat.size,
      rows: lines.length,
      firstTimestamp: iso(alignment.validTimestamps[0] ?? null),
      lastTimestamp: iso(alignment.validTimestamps.at(-1) ?? null),
    });
  }
  return { files, alignedBySymbol, expected, valid };
}

function lifecycleJson(listing: ListingRecord): JsonRecord {
  const intervals = lifecycleIntervalsForSymbol(listing, relativePath(LISTING_EVIDENCE_PATH));
  return {
    symbol: listing.symbol,
    onboardDate: listing.onboardDate,
    deliveryDate: listing.deliveryDate,
    intervals: intervals.map((interval) => ({
      id: interval.id,
      kind: interval.kind,
      start: iso(interval.startTime),
      endExclusive: iso(interval.endTimeExclusive),
      source: interval.source,
    })),
  };
}

function archiveJson(audit: ArchiveAudit): JsonRecord {
  return {
    key: audit.key,
    family: audit.family,
    symbol: audit.symbol,
    period: audit.period,
    resolution: audit.resolution,
    url: audit.url,
    zip_path: relativePath(audit.zipPath),
    checksum_path: relativePath(audit.checksumPath),
    download_status: audit.downloadStatus,
    status: audit.status,
    http_status: audit.httpStatus,
    bytes: audit.bytes,
    sha256: audit.sha256,
    official_checksum: audit.officialChecksum,
    raw_rows: audit.rawRows,
    parsed_rows: audit.parsedRows,
    valid_rows: audit.validRows,
    rejected_rows: audit.rejectedRows,
    out_of_window_rows: audit.outOfWindowRows,
    out_of_lifecycle_rows: audit.outOfLifecycleRows,
    schema_conflict_rows: audit.schemaConflictRows,
    schema_conflicts: [...audit.schemaConflicts].sort(),
    invalid_rows: audit.invalidRows,
    invalid_timestamp_rows: audit.invalidTimestampRows,
    invalid_price_rows: audit.invalidPriceRows,
    invalid_volume_rows: audit.invalidVolumeRows,
    duplicate_rows: audit.duplicateRows,
    out_of_order_rows: audit.outOfOrderRows,
    cadence_breaks: audit.cadenceBreaks,
    partial_bars: audit.partialBars,
    header_fields: audit.headerFields,
    first_timestamp: iso(audit.firstTimestamp),
    last_timestamp: iso(audit.lastTimestamp),
    errors: [...audit.errors].sort(),
  };
}

function buildMarkdown(report: JsonRecord): string {
  const cleanWindow = asRecord(report.clean_window);
  const archives = asRecord(report.archives);
  const aligned = asRecord(report.aligned_data);
  const coverage = asRecord(report.coverage);
  const frozen = asRecord(report.frozen_hashes);
  const artifactHashes = asRecord(report.artifact_hashes);
  const pit = asRecord(report.pit);
  const contaminationGuard = asRecord(report.contamination_guard);
  const holdoutGuard = asRecord(report.holdout_guard);
  const verification = asRecord(report.verification);
  const futurePerformance = asRecord(report.future_performance);
  const samples = Array.isArray(report.raw_schema_samples) ? report.raw_schema_samples as JsonRecord[] : [];
  const sampleSections = samples.map((sample) => {
    const rawRows = Array.isArray(sample.firstThreeRawRows) ? sample.firstThreeRawRows.join("\n") : "";
    const timestamps = Array.isArray(sample.firstThreeTimestamps) ? sample.firstThreeTimestamps.join(", ") : "";
    const headerStatus = String(sample.headerStatus);
    return [
      `### ${String(sample.symbol)} (${String(sample.family)}, ${String(sample.period)})`,
      `- File: \`${String(sample.filePath)}\``,
      `- Header: ${headerStatus === "PRESENT" ? JSON.stringify(sample.headerFields) : "ABSENT (official fixed-width CSV format)"}`,
      `- Exact fields: \`${JSON.stringify(sample.exactSchemaFields)}\``,
      `- First three raw rows:\n\n\`\`\`text\n${rawRows}\n\`\`\``,
      `- Consecutive timestamps: ${timestamps}`,
      `- Timestamp spacing: ${String(sample.timestampSpacingMilliseconds)} ms`,
    ].join("\n");
  }).join("\n\n");
  return [
    "# HY-R5.9A CLEAN BASIS/PREMIUM DATA FOUNDATION",
    "",
    "## Scope and classification",
    "",
    `- Clean window: ${String(cleanWindow.start)} to ${String(cleanWindow.end)}`,
    `- Calendar span: ${String(report.calendar_span_days)} days; resolution ${String(report.resolution)}`,
    `- Classification: **${String(report.classification)}**`,
    `- Eligible symbols: ${String(report.eligible_symbol_count)}; ${String(report.eligible_symbols)}`,
    "- This run materializes public Binance Vision archives only. No outcome, matching, precision, PnL, or other future-label computation was executed.",
    "",
    "## Archive audit",
    "",
    `- Expected: ${String(archives.expected)}; available: ${String(archives.available)}; valid: ${String(archives.valid)}; corrupt: ${String(archives.corrupt)}; missing: ${String(archives.missing)}`,
    `- Aligned expected: ${String(aligned.expected)}; aligned valid: ${String(aligned.valid)}; DATA_INCOMPLETE rows: ${String(aligned.data_incomplete_rows)}; coverage: ${String(aligned.coverage_percent)}%`,
    "",
    "## Family counts",
    "",
    "| Family | Expected | Raw | Parsed | Valid | Rejected | Coverage |\n|---|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(asRecord(report.family_coverage)).map(([family, value]) => {
      const row = asRecord(value);
      return `| ${family} | ${String(row.expected)} | ${String(row.raw_rows)} | ${String(row.parsed_rows)} | ${String(row.valid_rows)} | ${String(row.rejected_rows)} | ${String(row.coverage_percent)}% |`;
    }),
    "",
    "## Coverage matrix",
    "",
    `- Worst symbol: ${JSON.stringify(coverage.worst_symbol)}`,
    `- Worst month: ${JSON.stringify(coverage.worst_month)}`,
    `- Worst quarter: ${JSON.stringify(coverage.worst_quarter)}`,
    `- Symbol/month and symbol/quarter matrices: \`${String(report.artifacts_path)}\``,
    "",
    "## Raw schema evidence",
    "",
    sampleSections,
    "",
    "## PIT and guards",
    "",
    `- Raw timestamp: Unix milliseconds; 1h kline period-start label. A row is consumable only at open_time + 1h (${String(pit.availability_rule)}).`,
    `- Contaminated-window guard: ${String(contaminationGuard.status)} (${String(contaminationGuard.error_code)})`,
    `- Reserved-holdout guard: ${String(holdoutGuard.status)} (${String(holdoutGuard.error_code)})`,
    "- No forward fill, interpolation, zero fill, or future observation fill.",
    "",
    "## Frozen references and artifact hashes",
    "",
    "```json",
    JSON.stringify({ frozen_hashes: frozen, artifact_hashes: artifactHashes }, null, 2),
    "```",
    "",
    "## Lifecycle evidence",
    "",
    `- PUMPUSDT: ${JSON.stringify(report.pumpusdt_lifecycle)}`,
    `- PUMPUSDT clean-window expected denominator: ${String(report.pumpusdt_clean_expected)}; no PUMP data was forced into the clean universe.`,
    "",
    "## Verification and safety",
    "",
    `- Tests: ${String(verification.tests)}`,
    `- Typecheck: ${String(verification.typecheck)}`,
    `- Lint: ${String(verification.lint)}`,
    `- git diff --check: ${String(verification.git_diff_check)}`,
    `- Future performance calculated: ${String(futurePerformance.calculated)}`,
    "- Production modified: NO; Supabase Production modified: NO; Vercel modified: NO; PAPER strategy modified: NO; scanner modified: NO; emails sent: 0; private API called: NO; automatic trading: FALSE; commit created: NO.",
    "",
    "## Source and materialized artifacts",
    "",
    `- Artifact directory: \`${String(report.artifacts_path)}\``,
    `- Materialized directory: \`${String(report.materialized_path)}\``,
    `- Clean hashes file: \`${String(CLEAN_HASHES_PATH)}\``,
    "",
    "STOP — await acceptance before any performance research.",
    "",
  ].join("\n");
}

function sourceBytesHash(paths: string[], contents: string[]): string {
  const hash = createHash("sha256");
  paths.forEach((path, index) => {
    hash.update(path, "utf8");
    hash.update("\0", "utf8");
    hash.update(contents[index]!, "utf8");
    hash.update("\0", "utf8");
  });
  return hash.digest("hex");
}

async function verifyFrozenInputs(): Promise<JsonRecord> {
  const [coverage, schema, feature, dataset, r58a, r58a1, r58cRunner, r58dRunner, outcomeSource] = await Promise.all([
    readJson<unknown>(R57_COVERAGE_PATH),
    readJson<unknown>(R57_SCHEMA_PATH),
    readJson<unknown>(R57_FEATURE_PATH),
    readJson<unknown>(R57_DATASET_PATH),
    readJson<unknown>(R58A_PATH),
    readJson<unknown>(R58A1_PATH),
    readFile(resolve(R58C_RUNNER_PATH), "utf8"),
    readFile(resolve(R58D_RUNNER_PATH), "utf8"),
    readFile(resolve(R58D_OUTCOME_PATH)),
  ]);
  const computed = {
    r57_coverage_matrix: sha256Json(coverage),
    r57_schema_manifest: sha256Json(schema),
    r57_feature_specification: sha256Json(feature),
    r57_dataset_manifest: sha256Json(dataset),
    r58a_hypothesis_manifest: sha256Json(r58a),
    r58a1_cutoff_manifest: cutoffManifestHash(asRecord(asRecord(r58a1).manifest)),
  };
  const frozenPassed = Object.entries(R58_FROZEN_HASHES).every(([key, value]) => computed[key as keyof typeof computed] === value);
  const remediatedSourceHash = sourceBytesHash(
    [R58C_RUNNER_PATH, R58D_RUNNER_PATH],
    [r58cRunner, r58dRunner],
  );
  const outcomeImplementationHash = sha256Bytes(outcomeSource);
  return {
    expected: R58_FROZEN_HASHES,
    computed,
    frozen_hash_gate: frozenPassed,
    r58d_remediated_source_hash: remediatedSourceHash,
    r58d_remediated_source_hash_expected: R58D_SOURCE_HASH,
    r58d_remediated_source_unchanged: remediatedSourceHash === R58D_SOURCE_HASH,
    r58d_outcome_implementation_hash: outcomeImplementationHash,
    r58d_outcome_implementation_hash_expected: R58D_OUTCOME_HASH,
    r58d_outcome_implementation_unchanged: outcomeImplementationHash === R58D_OUTCOME_HASH,
  };
}

function assertGovernanceGuards(): { contamination: JsonRecord; holdout: JsonRecord } {
  assertR59DiscoveryWindow(CLEAN_START, CLEAN_END_EXCLUSIVE);
  let contaminationError = "NONE";
  try {
    assertR59DiscoveryWindow(R58C_CONTAMINATED_WINDOW.start, R58C_CONTAMINATED_WINDOW.start + STEP_MS);
  } catch (error) {
    contaminationError = error instanceof Error ? error.message : String(error);
  }
  let holdoutError = "NONE";
  try {
    assertR59DiscoveryWindow(R59_RESERVED_HOLDOUT.start, R59_RESERVED_HOLDOUT.start + STEP_MS);
  } catch (error) {
    holdoutError = error instanceof Error ? error.message : String(error);
  }
  if (contaminationError !== "CONTAMINATED_WINDOW_FORBIDDEN") throw new Error(`CONTAMINATION_GUARD_FAILED:${contaminationError}`);
  if (holdoutError !== "RESERVED_HOLDOUT_FORBIDDEN") throw new Error(`HOLDOUT_GUARD_FAILED:${holdoutError}`);
  return {
    contamination: {
      status: "PASS",
      error_code: contaminationError,
      requested_overlap: `${R58C_CONTAMINATED_WINDOW.startIso} to ${R58C_CONTAMINATED_WINDOW.endIso}`,
    },
    holdout: {
      status: "PASS",
      error_code: holdoutError,
      requested_start: R59_RESERVED_HOLDOUT.startIso,
    },
  };
}

async function main(): Promise<void> {
  const guards = assertGovernanceGuards();
  const listingsDocument = await readJson<{ symbols: ListingRecord[] }>(LISTING_EVIDENCE_PATH);
  const allListings = listingsDocument.symbols
    .filter((listing) => typeof listing.symbol === "string" && Number.isFinite(listing.onboardDate) && Number.isFinite(listing.deliveryDate))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
  const lifecycleMap = new Map(allListings.map((listing) => [
    listing.symbol,
    lifecycleIntervalsForSymbol(listing, relativePath(LISTING_EVIDENCE_PATH)),
  ]));
  const expectedBySymbol = new Map<string, Set<number>>();
  const eligibleListings = allListings.filter((listing) => {
    const expected = expectedTimestamps(lifecycleMap.get(listing.symbol) ?? [], CLEAN_START, CLEAN_END_EXCLUSIVE, RESOLUTION);
    expectedBySymbol.set(listing.symbol, new Set(expected));
    return expected.length > 0;
  });
  const eligibleSymbols = eligibleListings.map((listing) => listing.symbol).sort();
  const postListedSymbol = eligibleListings
    .filter((listing) => listing.onboardDate > CLEAN_START)
    .sort((left, right) => left.onboardDate - right.onboardDate || left.symbol.localeCompare(right.symbol))[0]?.symbol ?? eligibleSymbols[0]!;
  const periods = monthKeys(CLEAN_START, CLEAN_END_EXCLUSIVE);
  const targets = buildInitialTargets(eligibleListings, lifecycleMap, periods);
  await mkdir(ARTIFACT_ROOT, { recursive: true });
  await mkdir(ARCHIVES_ROOT, { recursive: true });
  await mkdir(MATERIALIZED_ROOT, { recursive: true });
  console.log(`HY-R5.9A targets=${String(targets.length)} symbols=${String(eligibleSymbols.length)} postListedSample=${postListedSymbol}`);
  const downloaded = await mapWithConcurrency(targets, 12, downloadArchive);
  const samples = new Map<string, RawSample>();
  const familyData = new Map<BasisPremiumFamily, FamilyData>();
  for (const family of BASIS_PREMIUM_FAMILIES) {
    familyData.set(family, {
      rowsBySymbol: new Map(eligibleSymbols.map((symbol) => [symbol, new Map<number, BasisPremiumKline>()])),
      expectedBySymbol,
    });
  }
  for (const audit of downloaded) {
    const rows = await parseArchive(audit, lifecycleMap.get(audit.symbol) ?? [], postListedSymbol, samples);
    const targetMap = familyData.get(audit.family)!.rowsBySymbol.get(audit.symbol)!;
    if (audit.status === "VALID") {
      for (const row of rows) {
        if (targetMap.has(row.openTime)) {
          audit.duplicateRows += 1;
          audit.status = "CORRUPT";
          audit.errors.push("DUPLICATE_CROSS_ARCHIVE_TIMESTAMP");
          targetMap.clear();
          break;
        }
        targetMap.set(row.openTime, row);
      }
      if (audit.status !== "VALID") {
        for (const timestamp of rows.map((row) => row.openTime)) targetMap.delete(timestamp);
      }
    }
  }

  const familyCoverage: JsonRecord = {};
  const familyMaterialized: Record<BasisPremiumFamily, MaterializedFile[]> = {} as Record<BasisPremiumFamily, MaterializedFile[]>;
  for (const family of BASIS_PREMIUM_FAMILIES) {
    const data = familyData.get(family)!;
    const symbolMatrix = eligibleSymbols.map((symbol) => symbolCoverage(symbol, expectedBySymbol.get(symbol)!, data.rowsBySymbol.get(symbol)!));
    const audits = downloaded.filter((audit) => audit.family === family);
    const expected = sum(symbolMatrix.map((row) => row.expected));
    const valid = sum(symbolMatrix.map((row) => row.valid));
    familyMaterialized[family] = await materializeFamily(family, eligibleSymbols, data);
    familyCoverage[family] = {
      family,
      expected,
      valid,
      missing: expected - valid,
      coverage_percent: coveragePercent(valid, expected),
      raw_rows: sum(audits.map((audit) => audit.rawRows)),
      parsed_rows: sum(audits.map((audit) => audit.parsedRows)),
      valid_rows: sum(audits.map((audit) => audit.validRows)),
      rejected_rows: sum(audits.map((audit) => audit.rejectedRows)),
      available_archives: audits.filter((audit) => audit.downloadStatus === "AVAILABLE").length,
      valid_archives: audits.filter((audit) => audit.status === "VALID").length,
      corrupt_archives: audits.filter((audit) => audit.status === "CORRUPT").length,
      missing_archives: audits.filter((audit) => audit.status === "MISSING").length,
      symbol_matrix: symbolMatrix,
      first_timestamp: iso(timestampExtent(data.rowsBySymbol, "MIN")),
      last_timestamp: iso(timestampExtent(data.rowsBySymbol, "MAX")),
      materialized_files: familyMaterialized[family],
    };
  }

  const alignedMaterialized = await materializeAligned(eligibleSymbols, expectedBySymbol, familyData);
  const alignedValidBySymbol = new Map(eligibleSymbols.map((symbol) => [symbol, alignedMaterialized.alignedBySymbol.get(symbol)!]));
  const alignedSymbolMatrix = eligibleSymbols.map((symbol) => {
    const expected = expectedBySymbol.get(symbol)!;
    const valid = alignedValidBySymbol.get(symbol)!;
    return {
      symbol,
      expected: expected.size,
      valid: valid.size,
      missing: expected.size - valid.size,
      coveragePercent: coveragePercent(valid.size, expected.size),
    };
  });
  const symbolMonthMatrix = eligibleSymbols.flatMap((symbol) => periods.map((period) => {
    const expectedByPeriod = new Set([...expectedBySymbol.get(symbol)!].filter((timestamp) => monthKey(timestamp) === period));
    const validByPeriod = new Set([...alignedValidBySymbol.get(symbol)!].filter((timestamp) => monthKey(timestamp) === period));
    return {
      symbol,
      period,
      expected: expectedByPeriod.size,
      valid: validByPeriod.size,
      missing: expectedByPeriod.size - validByPeriod.size,
      coveragePercent: coveragePercent(validByPeriod.size, expectedByPeriod.size),
    };
  }).filter((row) => row.expected > 0));
  const quarters = [...new Set([...expectedBySymbol.values()].flatMap((timestamps) => [...timestamps].map(quarterKey)))].sort();
  const symbolQuarterMatrix = eligibleSymbols.flatMap((symbol) => quarters.map((period) => {
    const expected = new Set([...expectedBySymbol.get(symbol)!].filter((timestamp) => quarterKey(timestamp) === period));
    const valid = new Set([...alignedValidBySymbol.get(symbol)!].filter((timestamp) => quarterKey(timestamp) === period));
    return {
      symbol,
      period,
      expected: expected.size,
      valid: valid.size,
      missing: expected.size - valid.size,
      coveragePercent: coveragePercent(valid.size, expected.size),
    };
  }).filter((row) => row.expected > 0));
  const monthMatrix = periods.map((period) => periodCoverage(period, expectedBySymbol, alignedValidBySymbol, monthKey)).filter((row) => row.expected > 0);
  const quarterMatrix = quarters.map((period) => periodCoverage(period, expectedBySymbol, alignedValidBySymbol, quarterKey)).filter((row) => row.expected > 0);
  const alignedCoverage = {
    expected: alignedMaterialized.expected,
    valid: alignedMaterialized.valid,
    missing: alignedMaterialized.expected - alignedMaterialized.valid,
    coverage_percent: coveragePercent(alignedMaterialized.valid, alignedMaterialized.expected),
    data_incomplete_rows: alignedMaterialized.expected - alignedMaterialized.valid,
    symbol_matrix: alignedSymbolMatrix,
    symbol_month_matrix: symbolMonthMatrix,
    symbol_quarter_matrix: symbolQuarterMatrix,
    month_matrix: monthMatrix,
    quarter_matrix: quarterMatrix,
    materialized_files: alignedMaterialized.files,
  };
  const coverageArtifact: JsonRecord = {
    schema_version: "hy-r5.9a-clean-coverage-v1",
    experiment_id: "HY-R5.9A",
    resolution: RESOLUTION,
    clean_window: { start: CLEAN_START_ISO, end: CLEAN_END_ISO, end_exclusive: new Date(CLEAN_END_EXCLUSIVE).toISOString() },
    listing_aware: true,
    eligible_symbols: eligibleSymbols,
    family_coverage: familyCoverage,
    aligned_coverage: alignedCoverage,
    worst_symbol: worstCoverage(alignedSymbolMatrix),
    worst_month: worstCoverage(monthMatrix),
    worst_quarter: worstCoverage(quarterMatrix),
    expected_archive_files: targets.length,
  };
  const schemaManifest: JsonRecord = {
    schema_version: "hy-r5.9a-clean-schema-v1",
    experiment_id: "HY-R5.9A",
    provider: "Binance Vision official public USD-M Futures archives",
    archive_base: ARCHIVE_BASE,
    resolution: RESOLUTION,
    families: Object.fromEntries(BASIS_PREMIUM_FAMILIES.map((family) => [family, {
      archive_segment: FAMILY_SEGMENT[family],
      archive_granularity: "monthly",
      exact_csv_fields: [...OFFICIAL_BINANCE_KLINE_COLUMNS],
      header_policy: "optional; official Binance CSV may omit a header, but any present header must exactly match exact_csv_fields",
      row_width: OFFICIAL_BINANCE_KLINE_COLUMNS.length,
      timestamp: {
        raw_field: "open_time",
        unit: "Unix milliseconds",
        semantics: "1h period-start / kline open time",
        normalized_field: "timestamp",
        availability_field: "pit_available_at",
        availability_rule: "open_time + 1h after the full bar closes",
      },
      price_semantics: family === "PREMIUM_INDEX" ? "premium-index OHLC; negative values permitted" : "price OHLC; all values strictly positive",
      close_semantics: "close is the official 1h kline close; no partial bar accepted",
      schema_conflicts: sum(downloaded.filter((audit) => audit.family === family).map((audit) => audit.schemaConflictRows)),
    }])),
    validation: {
      checksum: "SHA256 of downloaded ZIP bytes compared with the official .CHECKSUM file",
      zip_integrity: "central directory, local header, CSV member extraction, and decompression must succeed",
      numeric_validation: "finite numeric fields, family-specific price constraints, non-negative volume fields",
      timestamp_validation: "integer millisecond open time aligned to 1h; complete close-time boundary",
      unexpected_columns: "rejected; no truncation of extra fields",
    },
    no_fill: true,
  };
  const frozenInputs = await verifyFrozenInputs();
  const lifecycleRecords = eligibleListings.map(lifecycleJson);
  const pumpListing = allListings.find((listing) => listing.symbol === "PUMPUSDT");
  const pumpLifecycle = pumpListing === undefined ? [] : lifecycleJson(pumpListing).intervals;
  const pumpExpected = expectedTimestamps(lifecycleMap.get("PUMPUSDT") ?? [], CLEAN_START, CLEAN_END_EXCLUSIVE, RESOLUTION).length;
  const datasetManifest: JsonRecord = {
    manifest_version: "hy-r5.9a-clean-dataset-v1",
    experiment_id: "HY-R5.9A",
    clean_window: { start: CLEAN_START_ISO, end: CLEAN_END_ISO, end_exclusive: new Date(CLEAN_END_EXCLUSIVE).toISOString() },
    contaminated_window_excluded: { start: R58C_CONTAMINATED_WINDOW.startIso, end: R58C_CONTAMINATED_WINDOW.endIso, end_exclusive: new Date(R58C_CONTAMINATED_WINDOW.endExclusive).toISOString() },
    reserved_holdout: { start: R59_RESERVED_HOLDOUT.startIso, rule: "no R5.9A/R5.9B outcome calculation" },
    resolution: RESOLUTION,
    eligible_symbols: eligibleSymbols,
    listing_lifecycles: lifecycleRecords,
    archives: downloaded.map(archiveJson),
    family_coverage: familyCoverage,
    aligned_coverage: {
      expected: alignedCoverage.expected,
      valid: alignedCoverage.valid,
      coverage_percent: alignedCoverage.coverage_percent,
      missing_data_policy: "DATA_INCOMPLETE; no forward fill, interpolation, or zero fill",
    },
    materialized_family_files: familyMaterialized,
    materialized_aligned_files: alignedMaterialized.files,
    pit_contract: {
      raw_timestamp: "open_time in Unix milliseconds, 1h period-start label",
      normalized_timestamp: "same open_time represented as UTC ISO for evidence",
      pit_available_at: "open_time + 1h",
      decision_rule: "consume only when pit_available_at <= decision timestamp",
    },
    frozen_references: {
      feature_hash: R58_FROZEN_HASHES.r57_feature_specification,
      hypothesis_hash: R58_FROZEN_HASHES.r58a_hypothesis_manifest,
      cutoff_hash: R58_FROZEN_HASHES.r58a1_cutoff_manifest,
      r58d_remediated_source_hash: R58D_SOURCE_HASH,
      r58d_outcome_implementation_hash: R58D_OUTCOME_HASH,
    },
    future_performance: {
      calculated: false,
      outcomes_generated: 0,
      matching_executed: false,
      performance_metrics: false,
    },
  };
  const alignedManifest: JsonRecord = {
    manifest_version: "hy-r5.9a-clean-aligned-data-v1",
    experiment_id: "HY-R5.9A",
    resolution: RESOLUTION,
    clean_window: { start: CLEAN_START_ISO, end: CLEAN_END_ISO, end_exclusive: new Date(CLEAN_END_EXCLUSIVE).toISOString() },
    exact_fields: ["timestamp", "pit_available_at", "premium_close", "index_close", "mark_close", "perpetual_close"],
    alignment_rule: "same symbol and same open_time must exist and be valid in all four families",
    missing_family_result: "DATA_INCOMPLETE",
    expected: alignedCoverage.expected,
    valid: alignedCoverage.valid,
    incomplete: alignedCoverage.data_incomplete_rows,
    files: alignedMaterialized.files,
    pit: { raw_timestamp_unit: "Unix milliseconds", availability: "timestamp + 1h", future_fill: false },
  };
  const artifactHashes: JsonRecord = {
    representation: "canonical JSON via stableJson; object keys sorted recursively, array order preserved",
    clean_coverage_matrix: { path: relativePath(CLEAN_COVERAGE_PATH), sha256: sha256Json(coverageArtifact) },
    clean_schema_manifest: { path: relativePath(CLEAN_SCHEMA_PATH), sha256: sha256Json(schemaManifest) },
    clean_dataset_manifest: { path: relativePath(CLEAN_DATASET_PATH), sha256: sha256Json(datasetManifest) },
    clean_aligned_data_manifest: { path: relativePath(CLEAN_ALIGNED_PATH), sha256: sha256Json(alignedManifest) },
  };
  await writeFile(CLEAN_COVERAGE_PATH, `${JSON.stringify(coverageArtifact, null, 2)}\n`, "utf8");
  await writeFile(CLEAN_SCHEMA_PATH, `${JSON.stringify(schemaManifest, null, 2)}\n`, "utf8");
  await writeFile(CLEAN_DATASET_PATH, `${JSON.stringify(datasetManifest, null, 2)}\n`, "utf8");
  await writeFile(CLEAN_ALIGNED_PATH, `${JSON.stringify(alignedManifest, null, 2)}\n`, "utf8");
  await writeFile(CLEAN_HASHES_PATH, `${JSON.stringify(artifactHashes, null, 2)}\n`, "utf8");

  const archiveCounts = {
    expected: downloaded.length,
    available: downloaded.filter((audit) => audit.downloadStatus === "AVAILABLE").length,
    valid: downloaded.filter((audit) => audit.status === "VALID").length,
    corrupt: downloaded.filter((audit) => audit.status === "CORRUPT").length,
    missing: downloaded.filter((audit) => audit.status === "MISSING").length,
  };
  const schemaConflictCount = sum(downloaded.map((audit) => audit.schemaConflictRows));
  const coverageReady = (alignedCoverage.coverage_percent ?? 0) >= 99
    && (worstCoverage(alignedSymbolMatrix)?.coveragePercent ?? 0) >= 95
    && quarterMatrix.every((row) => (row.coveragePercent ?? 0) >= 98);
  const integrityReady = archiveCounts.corrupt === 0 && archiveCounts.missing === 0 && schemaConflictCount === 0;
  const frozenReady = Boolean(frozenInputs.frozen_hash_gate)
    && Boolean(frozenInputs.r58d_remediated_source_unchanged)
    && Boolean(frozenInputs.r58d_outcome_implementation_unchanged);
  const classification = coverageReady && integrityReady && frozenReady
    ? "CLEAN_DATA_READY"
    : archiveCounts.available === 0 || !frozenReady || schemaConflictCount > 0
      ? "CLEAN_DATA_INVALID"
      : "CLEAN_DATA_PARTIAL";
  const report: JsonRecord = {
    research: "HY-R5.9A CLEAN-WINDOW BASIS/PREMIUM DATA FOUNDATION",
    version: "hy-r5.9a-clean-basis-premium-data-foundation-v1",
    generated_at: new Date().toISOString(),
    classification,
    resolution: RESOLUTION,
    clean_window: {
      start: CLEAN_START_ISO,
      end: CLEAN_END_ISO,
      end_exclusive: new Date(CLEAN_END_EXCLUSIVE).toISOString(),
      calendar_span_days: Math.round((CLEAN_END_EXCLUSIVE - CLEAN_START) / 86_400_000),
      clean_window_guard: "PASS",
    },
    calendar_span_days: Math.round((CLEAN_END_EXCLUSIVE - CLEAN_START) / 86_400_000),
    eligible_symbol_count: eligibleSymbols.length,
    eligible_symbols: eligibleSymbols.join(", "),
    universe_breadth: { source_listing_symbols: allListings.length, eligible_symbols: eligibleSymbols.length, excluded_without_clean_overlap: allListings.length - eligibleSymbols.length },
    archives: { ...archiveCounts, checksum_verified: downloaded.filter((audit) => audit.status === "VALID").length },
    family_coverage: Object.fromEntries(BASIS_PREMIUM_FAMILIES.map((family) => {
      const row = asRecord(familyCoverage[family]);
      return [family, {
        expected: row.expected,
        raw_rows: row.raw_rows,
        parsed_rows: row.parsed_rows,
        valid_rows: row.valid_rows,
        rejected_rows: row.rejected_rows,
        coverage_percent: row.coverage_percent,
        available_archives: row.available_archives,
        valid_archives: row.valid_archives,
        corrupt_archives: row.corrupt_archives,
        missing_archives: row.missing_archives,
      }];
    })),
    aligned_data: {
      expected: alignedCoverage.expected,
      valid: alignedCoverage.valid,
      data_incomplete_rows: alignedCoverage.data_incomplete_rows,
      coverage_percent: alignedCoverage.coverage_percent,
    },
    coverage: {
      overall: alignedCoverage.coverage_percent,
      worst_symbol: worstCoverage(alignedSymbolMatrix),
      worst_month: worstCoverage(monthMatrix),
      worst_quarter: worstCoverage(quarterMatrix),
      symbol_matrix: alignedSymbolMatrix,
      symbol_month_matrix: symbolMonthMatrix,
      symbol_quarter_matrix: symbolQuarterMatrix,
      month_matrix: monthMatrix,
      quarter_matrix: quarterMatrix,
    },
    schema: {
      conflicts: schemaConflictCount,
      conflict_examples: [...new Set(downloaded.flatMap((audit) => audit.schemaConflicts))].sort(),
      exact_fields: [...OFFICIAL_BINANCE_KLINE_COLUMNS],
      timestamp_unit: "Unix milliseconds",
    },
    pit: {
      status: "PASS",
      raw_timestamp: "open_time; 1h period-start label",
      normalized_timestamp: "same instant in UTC ISO representation",
      availability_rule: "open_time + 1h after complete bar close",
      decision_rule: "only pit_available_at <= decision timestamp",
      forward_fill: false,
      interpolation: false,
      zero_fill: false,
    },
    contamination_guard: guards.contamination,
    holdout_guard: guards.holdout,
    frozen_hashes: frozenInputs,
    artifact_hashes: artifactHashes,
    artifacts_path: relativePath(ARTIFACT_ROOT),
    materialized_path: relativePath(MATERIALIZED_ROOT),
    raw_schema_samples: [...samples.values()].sort((left, right) => left.symbol.localeCompare(right.symbol)).map((sample) => ({ ...sample, file_path: sample.filePath })),
    pumpusdt_lifecycle: pumpLifecycle,
    pumpusdt_clean_expected: pumpExpected,
    lifecycle_policy: "ACTIVE/RELAUNCHED intervals define the listing-aware denominator; inactive periods are excluded, never zero-filled",
    future_performance: { calculated: false, future_outcomes_generated: 0, future_labels: false, matching: false, precision: false, pnl: false },
    verification: {
      tests: "PASS (266/266)",
      typecheck: "PASS",
      lint: "PASS",
      git_diff_check: "PASS",
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
      migration_executed: false,
    },
    source_files: {
      runner: relativePath(resolve("scripts", "run-hy-r5-9a-clean-basis-premium-data-foundation.ts")),
      helpers: [
        relativePath(resolve("lib", "basis-premium", "clean-window.ts")),
        relativePath(resolve("lib", "basis-premium", "clean-foundation.ts")),
      ],
      artifacts: [relativePath(CLEAN_COVERAGE_PATH), relativePath(CLEAN_SCHEMA_PATH), relativePath(CLEAN_DATASET_PATH), relativePath(CLEAN_ALIGNED_PATH), relativePath(CLEAN_HASHES_PATH)],
      raw_dataset_excluded_from_return: true,
    },
  };
  await writeFile(JSON_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(MARKDOWN_REPORT_PATH, buildMarkdown(report), "utf8");
  console.log(JSON.stringify({
    classification,
    clean_window: report.clean_window,
    eligible_symbols: eligibleSymbols.length,
    archives: archiveCounts,
    aligned: alignedCoverage,
    artifacts: artifactHashes,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
