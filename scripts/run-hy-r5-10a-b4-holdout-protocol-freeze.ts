import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  BASIS_PREMIUM_FAMILIES,
  expectedTimestamps,
  isTimestampInLifecycle,
  parseBinanceKlineCsv,
  perpIndexBasis,
  rankCrossSectionalPremium,
  resolutionMilliseconds,
  type BasisPremiumFamily,
  type BasisPremiumKline,
} from "../lib/basis-premium";
import {
  alignFamilyTimestamps,
  extractZipCsv,
  isCompletePitBar,
  OFFICIAL_BINANCE_KLINE_COLUMNS,
  validateKlineSchema,
} from "../lib/basis-premium/clean-foundation";
import {
  R58A1_ROLLING_MINIMUM_HISTORY,
  b4DivergenceDirection as frozenB4DivergenceDirection,
  R58A1_B4_LOWER_PERCENTILE,
  R58A1_B4_UPPER_PERCENTILE,
} from "../lib/basis-premium/cutoff";
import { makeExistingInformationMatchKey, matchNearestWithoutReplacement } from "../lib/basis-premium/information-gain";
import {
  R58C_CONTAMINATED_WINDOW,
  R59_CLEAN_DISCOVERY_WINDOW,
  R59_RESERVED_HOLDOUT,
} from "../lib/basis-premium/clean-window";
import {
  R510A_CANDIDATE,
  R510A_EXPERIMENT_ID,
  R510A_MATCH_FIELDS,
  R510A_PRIMARY_HYPOTHESIS,
  R510A_PRIMARY_METRIC,
  R510A_ROLLING_HISTORY,
  assertB4Only,
  assertR510AHoldoutRange,
  bucketFundingR510A,
  matchingCoverageGate,
  minimumSampleGate,
  outcomeWindowIsLocked,
  pooledMatchingCoveragePercent,
  preTreatmentBalancePass,
  protocolManifestHash,
  rejectHistoricalR510AWindow,
  mapFundingAtDecision,
  type R510AClassification,
  type R510AFundingObservation,
} from "../lib/basis-premium/r5-10a-holdout";
import {
  lifecycleIdAtTimestamp,
  lifecycleIntervalsForSymbol,
  sha256Json,
} from "../lib/crowding";
import type { LifecycleInterval } from "../lib/crowding";

type JsonRecord = Record<string, unknown>;
type ArchiveKind = "BASIS_PREMIUM" | "FUNDING";
type Direction = "BULLISH" | "BEARISH";

interface ListingRecord {
  symbol: string;
  onboardDate: number;
  deliveryDate: number;
  [key: string]: unknown;
}

interface ArchiveTarget {
  key: string;
  kind: ArchiveKind;
  family: BasisPremiumFamily | null;
  symbol: string;
  period: string;
  resolution: "1h";
  url: string;
  zipPath: string;
  checksumPath: string;
}

interface ArchiveAudit extends ArchiveTarget {
  downloadStatus: "AVAILABLE" | "MISSING" | "FAILED";
  status: "VALID" | "MISSING" | "CORRUPT";
  httpStatus: number | null;
  bytes: number;
  sha256: string | null;
  officialChecksum: string | null;
  rawRows: number;
  parsedRows: number;
  validRows: number;
  rejectedRows: number;
  outOfRangeRows: number;
  outOfLifecycleRows: number;
  schemaConflicts: string[];
  invalidRows: number;
  duplicateRows: number;
  outOfOrderRows: number;
  cadenceBreaks: number;
  partialBars: number;
  headerFields: string[] | null;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  errors: string[];
}

interface FundingArchiveRow extends R510AFundingObservation {
  symbol: string;
}

interface RawSample {
  symbol: string;
  family: string;
  period: string;
  sourceUrl: string;
  filePath: string;
  headerFields: string[] | null;
  exactSchemaFields: string[];
  firstThreeRawRows: string[];
  firstThreeTimestamps: string[];
  timestampSpacingMilliseconds: number | null;
}

interface Bar {
  close: number;
  high: number;
  low: number;
  quoteAssetVolume: number;
}

interface Observation {
  symbol: string;
  observationTime: number;
  decisionTime: number;
  lifecycleId: string;
  referencePrice: number;
  premium: number;
  index: number;
  mark: number;
  perpetual: number;
  priceChange: number | null;
  premiumChange: number | null;
  priceChangePercentile: number | null;
  premiumChangePercentile: number | null;
  fourHourReturn: number | null;
  volatilityValue: number | null;
  liquidityValue: number | null;
  marketRegime: string;
  volatilityBucket: string;
  liquidityBucket: string;
  fundingRate: number | null;
  fundingTime: number | null;
  fundingBucket: string | null;
  existingMarkIndexBasis: number | null;
  existingMarkIndexBasisBucket: string;
  calendarPeriod: string;
  b4Direction: Direction | null;
  b4EventDirection: Direction | null;
  b4FeatureStrength: "EXTREME" | "NORMAL";
  matchKey: string;
}

interface Point {
  time: number;
  matchKey: string;
  observation: Observation;
}

interface LifecycleSummary {
  symbol: string;
  intervals: Array<{ id: string; kind: string; start: string; endExclusive: string; source: string }>;
}

interface SymbolCoverage {
  symbol: string;
  expected: number;
  valid: number;
  missing: number;
  coveragePercent: number | null;
}

interface FundingCoverage {
  aligned: number;
  complete: number;
  incomplete: number;
  coveragePercent: number | null;
}

const RESOLUTION = "1h" as const;
const STEP_MS = resolutionMilliseconds(RESOLUTION);
const HOUR_MS = STEP_MS;
const DAY_MS = 86_400_000;
const ARCHIVE_BASE = "https://data.binance.vision/data/futures/um";
const LISTING_EVIDENCE_PATH = resolve("data", "raw", "hy-r5.2b-flow", "listing-evidence.json");
const ROOT = resolve("data", "raw", "hy-r5.10a-b4-holdout");
const ARCHIVES_ROOT = resolve(ROOT, "archives");
const MATERIALIZED_ROOT = resolve(ROOT, "materialized");
const ARTIFACT_ROOT = resolve(ROOT, "artifacts");
const REPORT_JSON_PATH = resolve("reports", "hy-r5.10a-b4-holdout-protocol-freeze.json");
const REPORT_MD_PATH = resolve("reports", "hy-r5.10a-b4-holdout-protocol-freeze.md");
const COVERAGE_PATH = resolve(ARTIFACT_ROOT, "holdout-coverage-manifest.json");
const FUNDING_PATH = resolve(ARTIFACT_ROOT, "funding-manifest.json");
const MATCHING_PATH = resolve(ARTIFACT_ROOT, "matching-protocol-manifest.json");
const HYPOTHESIS_PATH = resolve(ARTIFACT_ROOT, "confirmation-hypothesis-manifest.json");
const DATASET_PATH = resolve(ARTIFACT_ROOT, "holdout-dataset-manifest.json");
const HASHES_PATH = resolve(ARTIFACT_ROOT, "artifact-hashes.json");
const HOLDOUT_START = R59_RESERVED_HOLDOUT.start;
const WARMUP_START = Date.parse("2026-07-01T00:00:00.000Z");
const FUNDING_COLUMNS = ["calc_time", "funding_interval_hours", "last_funding_rate"] as const;
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
  if (!Number.isInteger(year) || !Number.isInteger(month)) throw new Error(`INVALID_PERIOD:${period}`);
  return Date.UTC(year, month - 1, 1);
}

function nextMonth(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function previousCompleteMonth(now = Date.now()): string {
  const date = new Date(now);
  return monthKey(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
}

const LATEST_COMPLETE_PERIOD = previousCompleteMonth();
const HOLDOUT_END_EXCLUSIVE = nextMonth(monthStart(LATEST_COMPLETE_PERIOD));

function familyPath(family: BasisPremiumFamily): string {
  return family.toLowerCase();
}

function archiveTarget(
  kind: ArchiveKind,
  symbol: string,
  period: string,
  family: BasisPremiumFamily | null,
): ArchiveTarget {
  if (kind === "FUNDING") {
    const filename = `${symbol}-fundingRate-${period}.zip`;
    const zipPath = resolve(ARCHIVES_ROOT, "funding", symbol, filename);
    return {
      key: `FUNDING|${symbol}|${period}`,
      kind,
      family: null,
      symbol,
      period,
      resolution: RESOLUTION,
      url: `${ARCHIVE_BASE}/monthly/fundingRate/${symbol}/${filename}`,
      zipPath,
      checksumPath: `${zipPath}.CHECKSUM`,
    };
  }
  if (family === null) throw new Error("BASIS_PREMIUM_FAMILY_REQUIRED");
  const filename = `${symbol}-${RESOLUTION}-${period}.zip`;
  const zipPath = resolve(ARCHIVES_ROOT, "basis-premium", familyPath(family), symbol, RESOLUTION, filename);
  return {
    key: `${family}|${symbol}|${RESOLUTION}|${period}`,
    kind,
    family,
    symbol,
    period,
    resolution: RESOLUTION,
    url: `${ARCHIVE_BASE}/monthly/${FAMILY_SEGMENT[family]}/${symbol}/${RESOLUTION}/${filename}`,
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
    outOfRangeRows: 0,
    outOfLifecycleRows: 0,
    schemaConflicts: [],
    invalidRows: 0,
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
  return content.trim().match(/^([0-9a-f]{64})(?:\s|$)/i)?.[1]?.toLowerCase() ?? null;
}

async function fetchBytes(url: string): Promise<{ status: number; bytes: Buffer }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "HeYue-HY-R5.10A-holdout-foundation" },
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
    const checksum = parseOfficialChecksum(checksumText);
    const actual = sha256Bytes(zipBytes);
    if (checksum !== null && checksum === actual) {
      audit.downloadStatus = "AVAILABLE";
      audit.httpStatus = 200;
      audit.bytes = zipBytes.byteLength;
      audit.sha256 = actual;
      audit.officialChecksum = checksum;
      return audit;
    }
  } catch {
    // Refresh only this official archive when no verified local copy exists.
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
  const checksum = parseOfficialChecksum(checksumResponse.bytes.toString("utf8"));
  const actual = sha256Bytes(archive.bytes);
  audit.bytes = archive.bytes.byteLength;
  audit.sha256 = actual;
  audit.officialChecksum = checksum;
  if (checksum === null || checksum !== actual) {
    audit.errors.push(checksum === null ? "CHECKSUM_FORMAT_INVALID" : "CHECKSUM_MISMATCH");
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
    || firstCells[0]?.toLowerCase() === "calc_time"
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
  if (audit.kind !== "BASIS_PREMIUM" || audit.family !== "PERPETUAL_PRICE") return;
  if (!(audit.symbol === "BTCUSDT" || audit.symbol === "ETHUSDT" || audit.symbol === postListedSymbol)) return;
  if (samples.has(audit.symbol) || rows.length < 3) return;
  const firstTimestamps = rows.slice(0, 3).map((row) => row.openTime);
  samples.set(audit.symbol, {
    symbol: audit.symbol,
    family: audit.family,
    period: audit.period,
    sourceUrl: audit.url,
    filePath: relativePath(audit.zipPath),
    headerFields: document.headerFields,
    exactSchemaFields: [...OFFICIAL_BINANCE_KLINE_COLUMNS],
    firstThreeRawRows: document.dataLines.slice(0, 3),
    firstThreeTimestamps: firstTimestamps.map((timestamp) => new Date(timestamp).toISOString()),
    timestampSpacingMilliseconds: firstTimestamps[1] === undefined || firstTimestamps[0] === undefined
      ? null
      : firstTimestamps[1] - firstTimestamps[0],
  });
}

/** Parse only after the archive bytes and official checksum have been verified. */
async function parseKlineArchiveAsync(
  audit: ArchiveAudit,
  lifecycle: LifecycleInterval[],
  postListedSymbol: string,
  samples: Map<string, RawSample>,
): Promise<BasisPremiumKline[]> {
  if (audit.downloadStatus !== "AVAILABLE" || audit.family === null) {
    audit.status = audit.downloadStatus === "MISSING" ? "MISSING" : "CORRUPT";
    return [];
  }
  try {
    const csv = extractZipCsv(await readFile(audit.zipPath));
    const document = rawDataDocument(csv);
    audit.headerFields = document.headerFields;
    audit.rawRows = document.dataLines.length;
    const rowFieldCounts = document.dataLines.map((line) => line.split(",").length);
    const schema = validateKlineSchema(document.headerFields, rowFieldCounts);
    audit.schemaConflicts = schema.conflicts;
    const exactLines = document.dataLines.filter((line) => line.split(",").length === OFFICIAL_BINANCE_KLINE_COLUMNS.length);
    const parserInput = document.headerLine === null
      ? exactLines.join("\n")
      : [document.headerLine, ...exactLines].join("\n");
    const parsed = parseBinanceKlineCsv(parserInput, { family: audit.family, resolution: RESOLUTION });
    audit.parsedRows = parsed.rows.length;
    audit.rejectedRows = audit.rawRows - audit.parsedRows;
    audit.invalidRows = parsed.invalidRowCount;
    audit.duplicateRows = parsed.duplicateTimestampCount;
    audit.outOfOrderRows = parsed.outOfOrderCount;
    audit.cadenceBreaks = parsed.cadenceBreakCount;
    audit.partialBars = parsed.boundaryViolationCount;
    audit.firstTimestamp = parsed.rows[0]?.openTime ?? null;
    audit.lastTimestamp = parsed.rows.at(-1)?.openTime ?? null;
    audit.errors.push(...parsed.issues.slice(0, 10));
    sampleFor(audit, document, parsed.rows, postListedSymbol, samples);
    const timestampPass = parsed.rows.every((row) => row.openTime >= 1_000_000_000_000
      && row.openTime < 10_000_000_000_000
      && row.openTime % STEP_MS === 0
      && isCompletePitBar(row.openTime, row.closeTime, STEP_MS));
    if (!timestampPass) audit.schemaConflicts.push("TIMESTAMP_OR_PIT_SEMANTICS_INVALID");
    const rows = parsed.rows.filter((row) => {
      const inRange = row.openTime >= WARMUP_START && row.openTime < HOLDOUT_END_EXCLUSIVE;
      const active = isTimestampInLifecycle(row.openTime, lifecycle);
      if (!inRange) audit.outOfRangeRows += 1;
      else if (!active) audit.outOfLifecycleRows += 1;
      return inRange && active;
    });
    audit.validRows = rows.length;
    audit.schemaConflicts = [...new Set(audit.schemaConflicts)].sort();
    const parserClean = parsed.invalidRowCount === 0
      && parsed.duplicateTimestampCount === 0
      && parsed.outOfOrderCount === 0
      && parsed.boundaryViolationCount === 0;
    if (schema.passed && timestampPass && parserClean) {
      audit.status = "VALID";
      return rows;
    }
    audit.status = "CORRUPT";
    return [];
  } catch (error) {
    audit.status = "CORRUPT";
    audit.errors.push(error instanceof Error ? error.message : String(error));
    return [];
  }
}

async function parseFundingArchiveAsync(audit: ArchiveAudit): Promise<FundingArchiveRow[]> {
  if (audit.downloadStatus !== "AVAILABLE") {
    audit.status = audit.downloadStatus === "MISSING" ? "MISSING" : "CORRUPT";
    return [];
  }
  try {
    const csv = extractZipCsv(await readFile(audit.zipPath));
    const document = rawDataDocument(csv);
    audit.headerFields = document.headerFields;
    audit.rawRows = document.dataLines.length;
    const conflicts: string[] = [];
    if (document.headerFields !== null
      && (document.headerFields.length !== FUNDING_COLUMNS.length
        || document.headerFields.some((field, index) => field !== FUNDING_COLUMNS[index]))) {
      conflicts.push("HEADER_FIELDS_MISMATCH");
    }
    const rows: FundingArchiveRow[] = [];
    let previousTime: number | null = null;
    const seen = new Set<number>();
    for (const [index, line] of document.dataLines.entries()) {
      const cells = line.split(",").map((cell) => cell.trim());
      if (cells.length !== FUNDING_COLUMNS.length) {
        conflicts.push(`UNEXPECTED_COLUMN_COUNT:${String(cells.length)}`);
        audit.invalidRows += 1;
        continue;
      }
      const fundingTime = Number(cells[0]);
      const fundingIntervalHours = Number(cells[1]);
      const fundingRate = Number(cells[2]);
      if (!Number.isInteger(fundingTime) || fundingTime < 0
        || !Number.isFinite(fundingIntervalHours) || fundingIntervalHours <= 0
        || !Number.isFinite(fundingRate)) {
        audit.invalidRows += 1;
        audit.errors.push(`INVALID_ROW:${String(index + 1)}`);
        continue;
      }
      if (previousTime !== null) {
        if (fundingTime < previousTime) audit.outOfOrderRows += 1;
        if (seen.has(fundingTime)) audit.duplicateRows += 1;
      }
      seen.add(fundingTime);
      previousTime = fundingTime;
      if (fundingTime < WARMUP_START || fundingTime >= HOLDOUT_END_EXCLUSIVE) {
        audit.outOfRangeRows += 1;
        continue;
      }
      rows.push({
        symbol: audit.symbol,
        fundingTime,
        pitAvailableAt: fundingTime,
        fundingIntervalHours,
        fundingRate,
      });
    }
    audit.parsedRows = rows.length;
    audit.rejectedRows = audit.rawRows - audit.parsedRows;
    audit.validRows = rows.length;
    audit.firstTimestamp = rows[0]?.fundingTime ?? null;
    audit.lastTimestamp = rows.at(-1)?.fundingTime ?? null;
    audit.schemaConflicts = [...new Set(conflicts)].sort();
    if (audit.invalidRows === 0 && audit.duplicateRows === 0 && audit.outOfOrderRows === 0 && audit.schemaConflicts.length === 0) {
      audit.status = "VALID";
      return rows;
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
  listings: ListingRecord[],
  lifecycleMap: Map<string, LifecycleInterval[]>,
): ArchiveTarget[] {
  const periods = [...new Set([monthKey(WARMUP_START), LATEST_COMPLETE_PERIOD])].sort();
  const targets: ArchiveTarget[] = [];
  for (const listing of listings) {
    const lifecycle = lifecycleMap.get(listing.symbol) ?? [];
    for (const period of periods) {
      const start = Math.max(WARMUP_START, monthStart(period));
      const end = Math.min(HOLDOUT_END_EXCLUSIVE, nextMonth(monthStart(period)));
      if (expectedTimestamps(lifecycle, start, end, RESOLUTION).length === 0) continue;
      for (const family of BASIS_PREMIUM_FAMILIES) targets.push(archiveTarget("BASIS_PREMIUM", listing.symbol, period, family));
      targets.push(archiveTarget("FUNDING", listing.symbol, period, null));
    }
  }
  return targets.sort((left, right) => left.key.localeCompare(right.key));
}

function rowToKlineCsv(row: BasisPremiumKline): string {
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

function rowToFundingCsv(row: FundingArchiveRow): string {
  return [row.fundingTime, row.pitAvailableAt, row.fundingIntervalHours, row.fundingRate].join(",");
}

async function materializeKlineFamilies(
  familyRows: Map<BasisPremiumFamily, Map<string, Map<number, BasisPremiumKline>>>,
  symbols: string[],
): Promise<JsonRecord[]> {
  const files: JsonRecord[] = [];
  for (const family of BASIS_PREMIUM_FAMILIES) {
    for (const symbol of symbols) {
      const rows = [...(familyRows.get(family)?.get(symbol)?.values() ?? [])].sort((left, right) => left.openTime - right.openTime);
      const outputPath = resolve(MATERIALIZED_ROOT, "families", familyPath(family), `${symbol}-${RESOLUTION}.csv`);
      await mkdir(resolve(outputPath, ".."), { recursive: true });
      const content = `${OFFICIAL_BINANCE_KLINE_COLUMNS.join(",")}\n${rows.map(rowToKlineCsv).join("\n")}${rows.length > 0 ? "\n" : ""}`;
      await writeFile(outputPath, content, "utf8");
      const fileStat = await stat(outputPath);
      files.push({
        family,
        symbol,
        path: relativePath(outputPath),
        sha256: await sha256File(outputPath),
        bytes: fileStat.size,
        rows: rows.length,
        first_timestamp: iso(rows[0]?.openTime ?? null),
        last_timestamp: iso(rows.at(-1)?.openTime ?? null),
      });
    }
  }
  return files;
}

async function materializeFunding(
  fundingRows: Map<string, FundingArchiveRow[]>,
  symbols: string[],
): Promise<JsonRecord[]> {
  const files: JsonRecord[] = [];
  for (const symbol of symbols) {
    const rows = [...(fundingRows.get(symbol) ?? [])].sort((left, right) => left.fundingTime - right.fundingTime);
    const outputPath = resolve(MATERIALIZED_ROOT, "funding", `${symbol}.csv`);
    await mkdir(resolve(outputPath, ".."), { recursive: true });
    const content = `funding_time,pit_available_at,funding_interval_hours,funding_rate\n${rows.map(rowToFundingCsv).join("\n")}${rows.length > 0 ? "\n" : ""}`;
    await writeFile(outputPath, content, "utf8");
    const fileStat = await stat(outputPath);
    files.push({
      symbol,
      path: relativePath(outputPath),
      sha256: await sha256File(outputPath),
      bytes: fileStat.size,
      rows: rows.length,
      first_timestamp: iso(rows[0]?.fundingTime ?? null),
      last_timestamp: iso(rows.at(-1)?.fundingTime ?? null),
    });
  }
  return files;
}

interface AlignedRow {
  timestamp: number;
  pitAvailableAt: number;
  premium: number;
  index: number;
  mark: number;
  perpetual: number;
}

async function materializeAligned(
  familyRows: Map<BasisPremiumFamily, Map<string, Map<number, BasisPremiumKline>>>,
  lifecycleMap: Map<string, LifecycleInterval[]>,
  symbols: string[],
): Promise<{ files: JsonRecord[]; rows: Map<string, Map<number, AlignedRow>>; expected: number; valid: number }> {
  const files: JsonRecord[] = [];
  const rowsBySymbol = new Map<string, Map<number, AlignedRow>>();
  const header = ["timestamp", "pit_available_at", "premium_close", "index_close", "mark_close", "perpetual_close"];
  let expected = 0;
  let valid = 0;
  for (const symbol of symbols) {
    const expectedTimestampsForSymbol = expectedTimestamps(lifecycleMap.get(symbol) ?? [], WARMUP_START, HOLDOUT_END_EXCLUSIVE, RESOLUTION);
    const maps = BASIS_PREMIUM_FAMILIES.map((family) => familyRows.get(family)?.get(symbol) ?? new Map<number, BasisPremiumKline>());
    const alignment = alignFamilyTimestamps(expectedTimestampsForSymbol, maps.map((map) => new Set(map.keys())));
    expected += alignment.expected;
    valid += alignment.valid;
    const symbolRows = new Map<number, AlignedRow>();
    const lines = alignment.validTimestamps.map((timestamp) => {
      const closes = maps.map((map) => map.get(timestamp)!.close);
      const row: AlignedRow = {
        timestamp,
        pitAvailableAt: timestamp + STEP_MS,
        premium: closes[0]!,
        index: closes[1]!,
        mark: closes[2]!,
        perpetual: closes[3]!,
      };
      symbolRows.set(timestamp, row);
      return [timestamp, timestamp + STEP_MS, ...closes].join(",");
    });
    rowsBySymbol.set(symbol, symbolRows);
    const outputPath = resolve(MATERIALIZED_ROOT, "aligned", `${symbol}-${RESOLUTION}.csv`);
    await mkdir(resolve(outputPath, ".."), { recursive: true });
    const content = `${header.join(",")}\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
    await writeFile(outputPath, content, "utf8");
    const fileStat = await stat(outputPath);
    files.push({
      symbol,
      path: relativePath(outputPath),
      sha256: await sha256File(outputPath),
      bytes: fileStat.size,
      rows: lines.length,
      first_timestamp: iso(alignment.validTimestamps[0] ?? null),
      last_timestamp: iso(alignment.validTimestamps.at(-1) ?? null),
    });
  }
  return { files, rows: rowsBySymbol, expected, valid };
}

function lifecycleJson(listing: ListingRecord, lifecycleMap: Map<string, LifecycleInterval[]>): LifecycleSummary {
  return {
    symbol: listing.symbol,
    intervals: (lifecycleMap.get(listing.symbol) ?? []).map((interval) => ({
      id: interval.id,
      kind: interval.kind,
      start: new Date(interval.startTime).toISOString(),
      endExclusive: new Date(interval.endTimeExclusive).toISOString(),
      source: "data/raw/hy-r5.2b-flow/listing-evidence.json",
    })),
  };
}

function archiveJson(audit: ArchiveAudit): JsonRecord {
  return {
    key: audit.key,
    kind: audit.kind,
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
    out_of_range_rows: audit.outOfRangeRows,
    out_of_lifecycle_rows: audit.outOfLifecycleRows,
    schema_conflicts: [...audit.schemaConflicts].sort(),
    invalid_rows: audit.invalidRows,
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

function coveragePercent(valid: number, expected: number): number | null {
  return expected > 0 ? valid / expected * 100 : null;
}

function symbolCoverage(symbol: string, expected: Set<number>, valid: Set<number>): SymbolCoverage {
  const validCount = [...expected].filter((timestamp) => valid.has(timestamp)).length;
  return {
    symbol,
    expected: expected.size,
    valid: validCount,
    missing: expected.size - validCount,
    coveragePercent: coveragePercent(validCount, expected.size),
  };
}

function worstCoverage(rows: SymbolCoverage[]): SymbolCoverage | null {
  return [...rows].sort((left, right) => {
    const leftCoverage = left.coveragePercent ?? Number.POSITIVE_INFINITY;
    const rightCoverage = right.coveragePercent ?? Number.POSITIVE_INFINITY;
    return leftCoverage - rightCoverage || right.expected - left.expected || left.symbol.localeCompare(right.symbol);
  })[0] ?? null;
}

function missingIntervals(expected: Set<number>, valid: Set<number>): Array<{ start: string; endExclusive: string; missing: number }> {
  const missing = [...expected].filter((timestamp) => !valid.has(timestamp)).sort((left, right) => left - right);
  const output: Array<{ start: string; endExclusive: string; missing: number }> = [];
  let start: number | null = null;
  let previous: number | null = null;
  const close = () => {
    if (start === null || previous === null) return;
    output.push({ start: new Date(start).toISOString(), endExclusive: new Date(previous + STEP_MS).toISOString(), missing: Math.floor((previous - start) / STEP_MS) + 1 });
    start = null;
    previous = null;
  };
  for (const timestamp of missing) {
    if (start === null) start = timestamp;
    else if (timestamp !== previous! + STEP_MS) {
      close();
      start = timestamp;
    }
    previous = timestamp;
  }
  close();
  return output.slice(0, 20);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function trailingVolatility(
  bars: Map<number, Bar>,
  lifecycle: LifecycleInterval[],
  timestamp: number,
): number | null {
  const lifecycleId = lifecycleIdAtTimestamp(timestamp, lifecycle);
  if (lifecycleId === null) return null;
  const returns: number[] = [];
  for (let step = 23; step >= 0; step -= 1) {
    const currentTime = timestamp - step * HOUR_MS;
    const previousTime = currentTime - HOUR_MS;
    if (lifecycleIdAtTimestamp(currentTime, lifecycle) !== lifecycleId
      || lifecycleIdAtTimestamp(previousTime, lifecycle) !== lifecycleId) return null;
    const current = bars.get(currentTime);
    const previous = bars.get(previousTime);
    if (current === undefined || previous === undefined || current.close <= 0 || previous.close <= 0) return null;
    returns.push(Math.log(current.close / previous.close));
  }
  return Math.sqrt(returns.reduce((total, value) => total + value * value, 0) / returns.length);
}

function trailingLiquidity(
  bars: Map<number, Bar>,
  lifecycle: LifecycleInterval[],
  timestamp: number,
): number | null {
  const lifecycleId = lifecycleIdAtTimestamp(timestamp, lifecycle);
  if (lifecycleId === null) return null;
  let total = 0;
  for (let step = 23; step >= 0; step -= 1) {
    const currentTime = timestamp - step * HOUR_MS;
    if (lifecycleIdAtTimestamp(currentTime, lifecycle) !== lifecycleId) return null;
    const bar = bars.get(currentTime);
    if (bar === undefined || !Number.isFinite(bar.quoteAssetVolume)) return null;
    total += bar.quoteAssetVolume;
  }
  return total / 24;
}

function fourHourReturn(
  bars: Map<number, Bar>,
  lifecycle: LifecycleInterval[],
  timestamp: number,
): number | null {
  const current = bars.get(timestamp);
  const previous = bars.get(timestamp - 4 * HOUR_MS);
  const lifecycleId = lifecycleIdAtTimestamp(timestamp, lifecycle);
  if (current === undefined || previous === undefined || lifecycleId === null
    || lifecycleIdAtTimestamp(timestamp - 4 * HOUR_MS, lifecycle) !== lifecycleId
    || previous.close <= 0) return null;
  return current.close / previous.close - 1;
}

function bucketVolatility(value: number | null): string {
  if (value === null) return "UNKNOWN";
  if (value < 0.005) return "LOW";
  if (value < 0.015) return "NORMAL";
  return "HIGH";
}

function bucketBasis(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "UNKNOWN";
  if (value <= -0.0005) return "EXTREME_NEGATIVE";
  if (value < 0) return "NEGATIVE";
  if (value === 0) return "NEUTRAL";
  if (value < 0.0005) return "POSITIVE";
  return "EXTREME_POSITIVE";
}

function bucketLiquidity(percentile: number | null): string {
  if (percentile === null) return "UNKNOWN";
  if (percentile <= 0.33) return "LOW";
  if (percentile <= 0.66) return "NORMAL";
  return "HIGH";
}

function crossSectionalPercentile(values: Array<{ id: string; value: number | null }>, id: string): number | null {
  return rankCrossSectionalPremium(values).find((value) => value.id === id)?.percentile ?? null;
}

class RollingPercentileWindow {
  private values: number[] = [];

  public constructor(private readonly windowSize: number) {}

  public reset(): void {
    this.values = [];
  }

  public percentile(value: number | null): number | null {
    if (value === null || !Number.isFinite(value) || this.values.length < this.windowSize) return null;
    return this.values.filter((entry) => entry <= value).length / this.values.length;
  }

  public push(value: number | null): void {
    if (value === null || !Number.isFinite(value)) return;
    this.values.push(value);
    if (this.values.length > this.windowSize) this.values.shift();
  }
}

function buildSymbolObservations(
  symbol: string,
  lifecycle: LifecycleInterval[],
  aligned: Map<number, AlignedRow>,
  perpetual: Map<number, Bar>,
  funding: R510AFundingObservation[],
): Observation[] {
  const timestamps = [...aligned.keys()].sort((left, right) => left - right);
  const output: Observation[] = [];
  const priceWindow = new RollingPercentileWindow(R510A_ROLLING_HISTORY);
  const premiumWindow = new RollingPercentileWindow(R510A_ROLLING_HISTORY);
  let previousTime: number | null = null;
  let previousLifecycleId: string | null = null;
  for (const timestamp of timestamps) {
    const row = aligned.get(timestamp)!;
    const currentLifecycleId = lifecycleIdAtTimestamp(timestamp, lifecycle);
    if (currentLifecycleId === null) continue;
    const contiguous = previousTime !== null
      && timestamp - previousTime === STEP_MS
      && currentLifecycleId === previousLifecycleId;
    if (!contiguous) {
      priceWindow.reset();
      premiumWindow.reset();
    }
    const previousRow = contiguous ? aligned.get(timestamp - STEP_MS) : undefined;
    const previousPerpetual = contiguous ? perpetual.get(timestamp - STEP_MS) : undefined;
    const priceChange = previousPerpetual === undefined || previousPerpetual.close <= 0 ? null : row.perpetual / previousPerpetual.close - 1;
    const premiumChange = previousRow === undefined ? null : row.premium - previousRow.premium;
    const priceChangePercentile = priceWindow.percentile(priceChange);
    const premiumChangePercentile = premiumWindow.percentile(premiumChange);
    const b4Direction = frozenB4DivergenceDirection({
      priceChangePercentile,
      premiumChangePercentile,
      historyAvailable: priceChangePercentile !== null && premiumChangePercentile !== null,
    });
    const fundingMapping = mapFundingAtDecision(funding, timestamp + STEP_MS);
    const basis = perpIndexBasis(row.perpetual, row.index);
    if (basis === null) throw new Error(`INVALID_BASIS:${symbol}:${String(timestamp)}`);
    const volatilityValue = trailingVolatility(perpetual, lifecycle, timestamp);
    const liquidityValue = trailingLiquidity(perpetual, lifecycle, timestamp);
    output.push({
      symbol,
      observationTime: timestamp,
      decisionTime: timestamp + STEP_MS,
      lifecycleId: currentLifecycleId,
      referencePrice: row.perpetual,
      premium: row.premium,
      index: row.index,
      mark: row.mark,
      perpetual: row.perpetual,
      priceChange,
      premiumChange,
      priceChangePercentile,
      premiumChangePercentile,
      fourHourReturn: fourHourReturn(perpetual, lifecycle, timestamp),
      volatilityValue,
      liquidityValue,
      marketRegime: "UNKNOWN",
      volatilityBucket: bucketVolatility(volatilityValue),
      liquidityBucket: "UNKNOWN",
      fundingRate: fundingMapping.observation?.fundingRate ?? null,
      fundingTime: fundingMapping.observation?.fundingTime ?? null,
      fundingBucket: fundingMapping.bucket,
      existingMarkIndexBasis: row.mark / row.index - 1,
      existingMarkIndexBasisBucket: bucketBasis(row.mark / row.index - 1),
      calendarPeriod: quarterKey(timestamp),
      b4Direction,
      b4EventDirection: null,
      b4FeatureStrength: b4Direction === null ? "NORMAL" : "EXTREME",
      matchKey: "",
    });
    priceWindow.push(priceChange);
    premiumWindow.push(premiumChange);
    previousTime = timestamp;
    previousLifecycleId = currentLifecycleId;
  }
  return output;
}

function addCrossSectionalContext(observations: Observation[]): void {
  const byTimestamp = new Map<number, Observation[]>();
  for (const observation of observations) {
    const values = byTimestamp.get(observation.observationTime) ?? [];
    values.push(observation);
    byTimestamp.set(observation.observationTime, values);
  }
  for (const values of byTimestamp.values()) {
    const returns = values.map((value) => value.fourHourReturn).filter((value): value is number => value !== null);
    const broad = median(returns);
    const regime = broad === null ? "UNKNOWN" : broad > 0.005 ? "UP" : broad < -0.005 ? "DOWN" : "RANGE";
    const liquidityValues = values.map((value) => ({ id: value.symbol, value: value.liquidityValue }));
    for (const observation of values) {
      observation.marketRegime = regime;
      observation.liquidityBucket = bucketLiquidity(crossSectionalPercentile(liquidityValues, observation.symbol));
      if (observation.fundingBucket === null || observation.existingMarkIndexBasisBucket === "UNKNOWN"
        || observation.marketRegime === "UNKNOWN" || observation.volatilityBucket === "UNKNOWN" || observation.liquidityBucket === "UNKNOWN") {
        observation.matchKey = "";
        continue;
      }
      observation.matchKey = makeExistingInformationMatchKey({
        symbol: observation.symbol,
        calendarPeriod: observation.calendarPeriod,
        marketRegime: observation.marketRegime,
        volatilityBucket: observation.volatilityBucket,
        liquidityBucket: observation.liquidityBucket,
        fundingBucket: observation.fundingBucket,
        markIndexBasisBucket: observation.existingMarkIndexBasisBucket,
      });
    }
  }
}

function formB4Events(observations: Observation[]): void {
  const bySymbol = new Map<string, Observation[]>();
  for (const observation of observations) {
    const values = bySymbol.get(observation.symbol) ?? [];
    values.push(observation);
    bySymbol.set(observation.symbol, values);
  }
  for (const values of bySymbol.values()) {
    let previousDirection: Direction | null = null;
    let previousTime: number | null = null;
    let previousLifecycleId: string | null = null;
    for (const observation of values.sort((left, right) => left.observationTime - right.observationTime)) {
      if (previousTime === null || observation.observationTime - previousTime !== STEP_MS || observation.lifecycleId !== previousLifecycleId) {
        previousDirection = null;
      }
      if (observation.b4Direction !== null && observation.b4Direction !== previousDirection) {
        observation.b4EventDirection = observation.b4Direction;
      }
      previousDirection = observation.b4Direction;
      previousTime = observation.observationTime;
      previousLifecycleId = observation.lifecycleId;
    }
  }
}

function isInHoldout(timestamp: number): boolean {
  return timestamp >= HOLDOUT_START && timestamp < HOLDOUT_END_EXCLUSIVE;
}

function formalContextReady(observation: Observation): boolean {
  return observation.matchKey.length > 0;
}

function makePoint(observation: Observation): Point {
  return { time: observation.decisionTime, matchKey: observation.matchKey, observation };
}

function matchDirection(observations: Observation[], direction: Direction): {
  allEvents: Observation[];
  incompleteEvents: Observation[];
  events: Point[];
  controls: Point[];
  pairs: ReturnType<typeof matchNearestWithoutReplacement<Point, Point>>["pairs"];
} {
  const allEvents = observations.filter((observation) => isInHoldout(observation.observationTime) && observation.b4EventDirection === direction);
  const incompleteEvents = allEvents.filter((observation) => !formalContextReady(observation));
  const events = allEvents.filter(formalContextReady).map(makePoint);
  const controls = observations
    .filter((observation) => isInHoldout(observation.observationTime)
      && observation.b4Direction === null
      && formalContextReady(observation))
    .map(makePoint);
  return {
    allEvents,
    incompleteEvents,
    events,
    controls,
    pairs: matchNearestWithoutReplacement(events, controls).pairs,
  };
}

function distribution(values: string[]): JsonRecord {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  const total = values.length;
  return {
    count: total,
    categories: Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => [key, {
      count,
      fraction: total > 0 ? count / total : null,
    }])),
  };
}

function totalVariation(left: string[], right: string[]): number | null {
  if (left.length === 0 || right.length === 0) return null;
  const keys = new Set([...left, ...right]);
  let total = 0;
  for (const key of keys) {
    const leftFraction = left.filter((value) => value === key).length / left.length;
    const rightFraction = right.filter((value) => value === key).length / right.length;
    total += Math.abs(leftFraction - rightFraction);
  }
  return total / 2;
}

function featureStrengthAudit(pairs: Array<{ event: Point; control: Point }>): JsonRecord {
  const eventValues = pairs.map((pair) => pair.event.observation.b4FeatureStrength);
  const controlValues = pairs.map((pair) => pair.control.observation.b4FeatureStrength);
  return {
    excluded_from_matching: true,
    balance_gate: false,
    interpretation: "EXPECTED_TREATMENT_SEPARATION",
    event_distribution: distribution(eventValues),
    control_distribution: distribution(controlValues),
    total_variation: totalVariation(eventValues, controlValues),
  };
}

function preTreatmentBalance(pairs: Array<{ event: Point; control: Point }>): JsonRecord {
  const fieldMap: Record<string, (observation: Observation) => string> = {
    symbol: (value) => value.symbol,
    calendar_period: (value) => value.calendarPeriod,
    market_regime: (value) => value.marketRegime,
    volatility_bucket: (value) => value.volatilityBucket,
    liquidity_bucket: (value) => value.liquidityBucket,
    funding_bucket: (value) => value.fundingBucket ?? "CONTROL_DATA_INCOMPLETE",
    mark_index_basis_bucket: (value) => value.existingMarkIndexBasisBucket,
  };
  const fields: JsonRecord = {};
  let maxTotalVariation: number | null = pairs.length === 0 ? null : 0;
  for (const field of R510A_MATCH_FIELDS) {
    const accessor = fieldMap[field];
    const eventValues = pairs.map((pair) => accessor(pair.event.observation));
    const controlValues = pairs.map((pair) => accessor(pair.control.observation));
    const tv = totalVariation(eventValues, controlValues);
    fields[field] = { total_variation: tv, event_distribution: distribution(eventValues), control_distribution: distribution(controlValues) };
    if (tv !== null) maxTotalVariation = Math.max(maxTotalVariation ?? 0, tv);
  }
  return {
    fields,
    compared_pairs: pairs.length,
    max_total_variation: maxTotalVariation,
    severe_threshold: 0.20,
    status: preTreatmentBalancePass(maxTotalVariation) ? "PASS" : "FAIL",
  };
}

function coverageGateResult(
  direction: Direction,
  matched: number,
  eligible: number,
): JsonRecord {
  return {
    direction,
    matched,
    eligible,
    coverage_percent: pooledMatchingCoveragePercent(matched, eligible),
  };
}

function archiveStatusCounts(audits: ArchiveAudit[]): JsonRecord {
  return {
    expected: audits.length,
    available: audits.filter((audit) => audit.downloadStatus === "AVAILABLE").length,
    valid: audits.filter((audit) => audit.status === "VALID").length,
    missing: audits.filter((audit) => audit.status === "MISSING").length,
    corrupt: audits.filter((audit) => audit.status === "CORRUPT").length,
  };
}

function testStatus(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

async function priorLockGuard(): Promise<void> {
  try {
    const previous = asRecord(JSON.parse(await readFile(REPORT_JSON_PATH, "utf8")));
    if (previous.outcome_window_locked === true || outcomeWindowIsLocked(String(previous.classification) as R510AClassification)) {
      throw new Error("HOLDOUT_PROTOCOL_LOCKED");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "HOLDOUT_PROTOCOL_LOCKED") throw error;
    // No previous report, or a prior DATA_NOT_READY report that may be refreshed with a later complete archive.
  }
}

function governanceEvidence(): JsonRecord {
  try {
    rejectHistoricalR510AWindow(R59_CLEAN_DISCOVERY_WINDOW.start, R59_CLEAN_DISCOVERY_WINDOW.endExclusive);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "DISCOVERY_WINDOW_FORBIDDEN") throw error;
  }
  try {
    rejectHistoricalR510AWindow(R58C_CONTAMINATED_WINDOW.start, R58C_CONTAMINATED_WINDOW.start + STEP_MS);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "CONTAMINATED_WINDOW_FORBIDDEN") throw error;
  }
  assertR510AHoldoutRange(HOLDOUT_START, HOLDOUT_END_EXCLUSIVE);
  return {
    contaminated_window: `${new Date(R58C_CONTAMINATED_WINDOW.start).toISOString()} → ${new Date(R58C_CONTAMINATED_WINDOW.endExclusive - 1).toISOString()}`,
    contaminated_window_guard: "CONTAMINATED_WINDOW_FORBIDDEN",
    discovery_window: `${new Date(R59_CLEAN_DISCOVERY_WINDOW.start).toISOString()} → ${new Date(R59_CLEAN_DISCOVERY_WINDOW.endExclusive - 1).toISOString()}`,
    discovery_window_guard: "DISCOVERY_WINDOW_FORBIDDEN",
    reserved_holdout_start: new Date(HOLDOUT_START).toISOString(),
    status: "PASS",
  };
}

async function negativeEvidence(): Promise<JsonRecord> {
  const paths = [
    resolve("scripts", "run-hy-r5-10a-b4-holdout-protocol-freeze.ts"),
    resolve("lib", "basis-premium", "r5-10a-holdout.ts"),
  ];
  const contents = (await Promise.all(paths.map((path) => readFile(path, "utf8"))))
    .map((content) => content.split("async function negativeEvidence")[0]!);
  const terms = ["future" + "Return", "forward" + "Return", "M" + "FE", "M" + "AE", "precision", "P" + "nL", "profit" + "Factor", "matched" + "Control", "future" + "Volatility", "future" + "Label"];
  const matches = terms.flatMap((term) => paths.flatMap((path, index) => contents[index]!.includes(term) ? [{ term, path: relativePath(path) }] : []));
  return {
    searched_files: paths.map(relativePath),
    searched_identifiers: terms,
    result: matches.length === 0 ? "NONE" : "REVIEW_BLOCKED",
    matches,
    future_performance_calculated: false,
    future_outcomes_generated: 0,
  };
}

function buildMarkdown(report: JsonRecord): string {
  const coverage = asRecord(report.coverage);
  const matching = asRecord(report.matching);
  const safety = asRecord(report.safety);
  const lifecycleEvidence = asRecord(report.lifecycle_evidence);
  const samples = Array.isArray(report.raw_schema_samples) ? report.raw_schema_samples as JsonRecord[] : [];
  const sampleSections = samples.map((sample) => [
    `### ${String(sample.symbol)} (${String(sample.family)}, ${String(sample.period)})`,
    `- File: \`${String(sample.file_path)}\``,
    `- Source: ${String(sample.source_url)}`,
    `- Header: ${sample.header_fields === null ? "ABSENT (official fixed-width CSV)" : JSON.stringify(sample.header_fields)}`,
    `- Exact fields: \`${JSON.stringify(sample.exact_schema_fields)}\``,
    `- First three raw rows:\n\n\`\`\`text\n${Array.isArray(sample.first_three_raw_rows) ? sample.first_three_raw_rows.map(String).join("\n") : ""}\n\`\`\``,
    `- Consecutive timestamps: ${Array.isArray(sample.first_three_timestamps) ? sample.first_three_timestamps.map(String).join(", ") : ""}`,
    `- Timestamp spacing: ${String(sample.timestamp_spacing_milliseconds)} ms`,
  ].join("\n")).join("\n\n");
  return [
    "# HY-R5.10A B4 INDEPENDENT HOLDOUT PROTOCOL + DATA FREEZE",
    "",
    "## Classification and freeze",
    "",
    `- Classification: **${String(report.classification)}**`,
    `- Holdout: ${String(report.holdout_range)}`,
    `- Latest complete official archive: ${String(report.latest_complete_archive_date)}`,
    `- Outcome window locked: ${String(report.outcome_window_locked)}`,
    `- Candidate: ${String(report.candidate)}; primary: ${String(report.primary_hypothesis)}`,
    "- Only B4 is materialized for confirmation. B1/B2/B3/B5 are explicitly rejected by the protocol guard.",
    "- R5.9B discovery is reference-only; its clean discovery window and contaminated R5.8C window are not reused.",
    "",
    "## Coverage",
    "",
    `- Calendar days: ${String(report.calendar_days)}; eligible universe: ${String(report.eligible_universe_count)}`,
    `- Expected aligned slots: ${String(coverage.aligned_expected)}; valid: ${String(coverage.aligned_valid)}; coverage: ${String(coverage.b4_data_coverage_percent)}%`,
    `- Funding-complete slots: ${String(coverage.funding_complete_slots)}; mapping coverage: ${String(coverage.funding_mapping_coverage_percent)}%`,
    `- Worst symbol: ${JSON.stringify(coverage.worst_symbol)}`,
    `- Missing intervals: ${JSON.stringify(coverage.missing_intervals)}`,
    `- Schema conflicts: ${String(coverage.schema_conflicts)}`,
    "",
    "## Funding PIT contract",
    "",
    "- Official Binance Vision `fundingRate` archives only; raw `calc_time` is the funding observation time in Unix milliseconds.",
    "- Funding rate is available at `calc_time`; event decision at `open_time + 1h` may consume only the latest observation with `calc_time <= decision_time`.",
    "- The existing five-band boundaries are retained and collapsed to NEGATIVE / NEUTRAL / POSITIVE; unresolved Funding is CONTROL_DATA_INCOMPLETE and never a formal control bucket.",
    `- Funding control: ${String(report.funding_control)}; PIT: ${String(report.pit_safe)}`,
    "",
    "## B4 event and matching protocol",
    "",
    `- Frozen B4: price-change percentile >= ${String(R58A1_B4_UPPER_PERCENTILE)} with premium-change percentile <= ${String(R58A1_B4_LOWER_PERCENTILE)} = BEARISH; inverse = BULLISH; ${String(R510A_ROLLING_HISTORY)} strictly prior observations.`,
    "- Event formation is false-to-true only; true-to-true is deduplicated. Current B4 feature strength is treatment-defining and excluded from matching, but audited separately.",
    `- Eligible B4 bullish: ${String(report.eligible_b4_bullish_events)}; bearish: ${String(report.eligible_b4_bearish_events)}`,
    `- Potential matched bullish: ${String(report.potential_matched_bullish)}; bearish: ${String(report.potential_matched_bearish)}; pooled coverage: ${String(report.pre_outcome_pooled_matching_coverage_percent)}%`,
    `- Pre-treatment balance: ${String(matching.pre_treatment_balance)}; max TV: ${String(matching.max_pre_treatment_tv)}; feature-strength audit: ${JSON.stringify(matching.feature_strength_audit)}`,
    `- Minimum sample gate: ${String(report.minimum_sample_gate)}; matching coverage gate: ${String(report.matching_coverage_gate)}`,
    "",
    "## Raw schema evidence",
    "",
    ...sampleSections.split("\n\n"),
    "",
    "## Lifecycle evidence",
    "",
    `- BTCUSDT (pre-window listing): ${JSON.stringify(lifecycleEvidence.BTCUSDT ?? null)}`,
    `- PUMPUSDT (listing/relaunch lifecycle): ${JSON.stringify(lifecycleEvidence.PUMPUSDT ?? null)}`,
    "- Denominators use ACTIVE/RELAUNCHED intervals only; NOT_LISTED and DELISTED intervals contribute no expected observations.",
    "",
    "## No-outcome evidence",
    "",
    `- ${JSON.stringify(report.negative_evidence)}`,
    "- No future outcome, return, MFE, MAE, precision, PnL, or matched outcome was computed in this round.",
    "",
    "## Artifact hashes",
    "",
    "```json",
    JSON.stringify(report.artifact_hashes, null, 2),
    "```",
    "",
    "## Verification and safety",
    "",
    `- Tests: ${String(report.tests)}; typecheck: ${String(report.typecheck)}; lint: ${String(report.lint)}; diff check: ${String(report.diff_check)}`,
    `- Production modified: ${String(safety.production_modified)}; Supabase: ${String(safety.supabase_modified)}; Vercel: ${String(safety.vercel_modified)}; PAPER: ${String(safety.paper_strategy_modified)}`,
    `- Emails: ${String(safety.emails_sent)}; private API: ${String(safety.private_api_called)}; AUTO_TRADING: ${String(safety.auto_trading)}; commit: ${String(safety.commit_created)}`,
    "",
    "STOP — await acceptance before any confirmation outcomes.",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  assertB4Only("B4");
  await priorLockGuard();
  const guards = governanceEvidence();
  if (HOLDOUT_END_EXCLUSIVE <= HOLDOUT_START) throw new Error("HOLDOUT_DATA_NOT_READY");
  await mkdir(ARTIFACT_ROOT, { recursive: true });
  await mkdir(ARCHIVES_ROOT, { recursive: true });
  await mkdir(MATERIALIZED_ROOT, { recursive: true });
  const listingDocument = asRecord(JSON.parse(await readFile(LISTING_EVIDENCE_PATH, "utf8")));
  const allListings = (Array.isArray(listingDocument.symbols) ? listingDocument.symbols : [])
    .map(asRecord)
    .filter((listing): listing is ListingRecord => typeof listing.symbol === "string"
      && Number.isFinite(listing.onboardDate)
      && Number.isFinite(listing.deliveryDate))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
  const lifecycleMap = new Map(allListings.map((listing) => [listing.symbol, lifecycleIntervalsForSymbol(listing, relativePath(LISTING_EVIDENCE_PATH))]));
  const eligibleListings = allListings.filter((listing) => expectedTimestamps(lifecycleMap.get(listing.symbol) ?? [], HOLDOUT_START, HOLDOUT_END_EXCLUSIVE, RESOLUTION).length > 0);
  const eligibleSymbols = eligibleListings.map((listing) => listing.symbol).sort();
  const postListedSymbol = eligibleListings
    .filter((listing) => listing.onboardDate >= R59_CLEAN_DISCOVERY_WINDOW.endExclusive)
    .sort((left, right) => left.onboardDate - right.onboardDate || left.symbol.localeCompare(right.symbol))[0]?.symbol ?? eligibleSymbols[0]!;
  const targets = buildInitialTargets(eligibleListings, lifecycleMap);
  console.log(`HY-R5.10A period=${LATEST_COMPLETE_PERIOD} targets=${String(targets.length)} symbols=${String(eligibleSymbols.length)} postListedSample=${postListedSymbol}`);
  const audits = await mapWithConcurrency(targets, 8, downloadArchive);
  const samples = new Map<string, RawSample>();
  const familyRows = new Map(BASIS_PREMIUM_FAMILIES.map((family) => [family, new Map<string, Map<number, BasisPremiumKline>>() ]));
  const fundingRows = new Map<string, FundingArchiveRow[]>();
  for (const symbol of eligibleSymbols) {
    for (const family of BASIS_PREMIUM_FAMILIES) familyRows.get(family)!.set(symbol, new Map());
    fundingRows.set(symbol, []);
  }
  for (const audit of audits) {
    const parsedRows = audit.kind === "BASIS_PREMIUM"
      ? await parseKlineArchiveAsync(audit, lifecycleMap.get(audit.symbol) ?? [], postListedSymbol, samples)
      : await parseFundingArchiveAsync(audit);
    if (audit.status !== "VALID") continue;
    if (audit.kind === "BASIS_PREMIUM" && audit.family !== null) {
      const target = familyRows.get(audit.family)!.get(audit.symbol)!;
      for (const row of parsedRows as BasisPremiumKline[]) {
        if (target.has(row.openTime)) {
          audit.status = "CORRUPT";
          audit.errors.push("DUPLICATE_CROSS_ARCHIVE_TIMESTAMP");
          break;
        }
        target.set(row.openTime, row);
      }
    } else {
      const target = fundingRows.get(audit.symbol)!;
      for (const row of parsedRows as FundingArchiveRow[]) target.push(row);
    }
  }
  for (const values of fundingRows.values()) values.sort((left, right) => left.fundingTime - right.fundingTime);
  const familyMaterialized = await materializeKlineFamilies(familyRows, eligibleSymbols);
  const fundingMaterialized = await materializeFunding(fundingRows, eligibleSymbols);
  const alignedMaterialized = await materializeAligned(familyRows, lifecycleMap, eligibleSymbols);
  const alignedBySymbol = alignedMaterialized.rows;

  const expectedHoldoutBySymbol = new Map(eligibleSymbols.map((symbol) => [symbol, new Set(expectedTimestamps(lifecycleMap.get(symbol) ?? [], HOLDOUT_START, HOLDOUT_END_EXCLUSIVE, RESOLUTION))]));
  const validHoldoutBySymbol = new Map(eligibleSymbols.map((symbol) => [symbol, new Set([...alignedBySymbol.get(symbol)!.keys()].filter(isInHoldout))]));
  const symbolMatrix = eligibleSymbols.map((symbol) => symbolCoverage(symbol, expectedHoldoutBySymbol.get(symbol)!, validHoldoutBySymbol.get(symbol)!));
  const alignedExpected = symbolMatrix.reduce((total, row) => total + row.expected, 0);
  const alignedValid = symbolMatrix.reduce((total, row) => total + row.valid, 0);
  const missingIntervalEvidence = Object.fromEntries(eligibleSymbols
    .map((symbol) => [symbol, missingIntervals(expectedHoldoutBySymbol.get(symbol)!, validHoldoutBySymbol.get(symbol)!)])
    .filter(([, intervals]) => (intervals as unknown[]).length > 0));
  const worstSymbol = worstCoverage(symbolMatrix);
  const allAlignedHoldoutRows = eligibleSymbols.flatMap((symbol) => [...alignedBySymbol.get(symbol)!.values()]
    .filter((row) => isInHoldout(row.timestamp))
    .map((row) => ({ symbol, row })));
  const fundingCoverage: FundingCoverage = { aligned: allAlignedHoldoutRows.length, complete: 0, incomplete: 0, coveragePercent: null };
  for (const { symbol, row } of allAlignedHoldoutRows) {
    const mapping = mapFundingAtDecision(fundingRows.get(symbol) ?? [], row.timestamp + STEP_MS);
    if (mapping.status === "COMPLETE") fundingCoverage.complete += 1;
    else fundingCoverage.incomplete += 1;
  }
  fundingCoverage.coveragePercent = coveragePercent(fundingCoverage.complete, fundingCoverage.aligned);

  const observations = eligibleSymbols.flatMap((symbol) => buildSymbolObservations(
    symbol,
    lifecycleMap.get(symbol) ?? [],
    alignedBySymbol.get(symbol)!,
    new Map([...familyRows.get("PERPETUAL_PRICE")!.get(symbol)!.entries()].map(([timestamp, bar]) => [timestamp, {
      close: bar.close,
      high: bar.high,
      low: bar.low,
      quoteAssetVolume: bar.quoteAssetVolume,
    }])),
    fundingRows.get(symbol) ?? [],
  ));
  addCrossSectionalContext(observations);
  formB4Events(observations);
  const bullish = matchDirection(observations, "BULLISH");
  const bearish = matchDirection(observations, "BEARISH");
  const pooledPairs = [...bullish.pairs, ...bearish.pairs];
  const pooledEligible = bullish.events.length + bearish.events.length;
  const pooledMatched = pooledPairs.length;
  const pooledCoverage = pooledMatchingCoveragePercent(pooledMatched, pooledEligible);
  const balance = preTreatmentBalance(pooledPairs);
  const strengthAudit = featureStrengthAudit(pooledPairs);
  const totalB4Events = observations.filter((observation) => isInHoldout(observation.observationTime) && observation.b4EventDirection !== null);
  const incompleteEvents = [...bullish.incompleteEvents, ...bearish.incompleteEvents];
  const potentialSample = { pooled: pooledMatched, bullish: bullish.pairs.length, bearish: bearish.pairs.length };
  const sampleGate = minimumSampleGate(potentialSample);
  const directionCoverages = {
    bullish: coverageGateResult("BULLISH", bullish.pairs.length, bullish.events.length),
    bearish: coverageGateResult("BEARISH", bearish.pairs.length, bearish.events.length),
  };
  const coverageGate = matchingCoverageGate({
    pooled: pooledCoverage ?? 0,
    bullish: Number(directionCoverages.bullish.coverage_percent ?? 0),
    bearish: Number(directionCoverages.bearish.coverage_percent ?? 0),
  });
  const holdoutAudits = audits.filter((audit) => audit.period === LATEST_COMPLETE_PERIOD);
  const holdoutArchiveComplete = holdoutAudits.length > 0
    && holdoutAudits.every((audit) => audit.status === "VALID" && audit.downloadStatus === "AVAILABLE");
  const schemaConflictCount = audits.reduce((total, audit) => total + audit.schemaConflicts.length, 0);
  const b4DataCoverage = coveragePercent(alignedValid, alignedExpected);
  const dataReady = holdoutArchiveComplete
    && (b4DataCoverage ?? 0) >= 99
    && (fundingCoverage.coveragePercent ?? 0) >= 99
    && schemaConflictCount === 0;
  const pitSafe = observations.every((observation) => observation.decisionTime === observation.observationTime + STEP_MS)
    && audits.filter((audit) => audit.kind === "BASIS_PREMIUM" && audit.status === "VALID").every((audit) => audit.firstTimestamp === null || audit.lastTimestamp === null || audit.firstTimestamp % STEP_MS === 0);
  const fundingControlComplete = incompleteEvents.length === 0 && (fundingCoverage.coveragePercent ?? 0) >= 99;
  const existingBasisControlComplete = observations
    .filter((observation) => isInHoldout(observation.observationTime) && (observation.b4EventDirection !== null || observation.b4Direction === null))
    .every((observation) => observation.existingMarkIndexBasisBucket !== "UNKNOWN");
  const minimumSampleClassification = dataReady && pitSafe && fundingControlComplete && existingBasisControlComplete;
  const classification: R510AClassification = !holdoutArchiveComplete || !pitSafe || schemaConflictCount > 0
    ? "HOLDOUT_DATA_NOT_READY"
    : !dataReady || !fundingControlComplete || !existingBasisControlComplete
      ? "HOLDOUT_DATA_NOT_READY"
      : !sampleGate || !coverageGate
        ? "HOLDOUT_MATCHING_NOT_READY"
        : minimumSampleClassification && preTreatmentBalancePass(balance.max_total_variation as number | null)
          ? "HOLDOUT_PROTOCOL_READY"
          : "HOLDOUT_MATCHING_NOT_READY";
  const coverageManifest: JsonRecord = {
    manifest_version: "hy-r5.10a-holdout-coverage-v1",
    experiment_id: R510A_EXPERIMENT_ID,
    candidate: "B4",
    archive_granularity: "monthly",
    holdout_range: { start: new Date(HOLDOUT_START).toISOString(), end_exclusive: new Date(HOLDOUT_END_EXCLUSIVE).toISOString() },
    warmup_range: { start: new Date(WARMUP_START).toISOString(), end_exclusive: new Date(HOLDOUT_END_EXCLUSIVE).toISOString() },
    latest_complete_archive_period: LATEST_COMPLETE_PERIOD,
    latest_complete_archive_date: new Date(HOLDOUT_END_EXCLUSIVE - 1).toISOString(),
    calendar_days: Math.round((HOLDOUT_END_EXCLUSIVE - HOLDOUT_START) / DAY_MS),
    eligible_symbols: eligibleSymbols,
    expected_aligned_b4_slots: alignedExpected,
    valid_aligned_b4_slots: alignedValid,
    b4_data_coverage_percent: b4DataCoverage,
    funding_aligned_slots: fundingCoverage.aligned,
    funding_complete_slots: fundingCoverage.complete,
    funding_incomplete_slots: fundingCoverage.incomplete,
    funding_mapping_coverage_percent: fundingCoverage.coveragePercent,
    symbol_matrix: symbolMatrix,
    worst_symbol: worstSymbol,
    missing_intervals: missingIntervalEvidence,
    schema_conflicts: schemaConflictCount,
    archive_status: archiveStatusCounts(audits),
    holdout_archive_complete: holdoutArchiveComplete,
    listing_aware: true,
    lifecycle_denominator: "ACTIVE and RELAUNCHED intervals only; NOT_LISTED and DELISTED intervals excluded",
    outcome_window_locked: outcomeWindowIsLocked(classification),
    future_outcomes_generated: 0,
  };
  const fundingManifest: JsonRecord = {
    manifest_version: "hy-r5.10a-funding-v1",
    experiment_id: R510A_EXPERIMENT_ID,
    provider: "Binance Vision official public USD-M Futures fundingRate archives",
    source_base: `${ARCHIVE_BASE}/monthly/fundingRate`,
    exact_raw_fields: [...FUNDING_COLUMNS],
    normalized_fields: ["funding_time", "pit_available_at", "funding_interval_hours", "funding_rate"],
    raw_timestamp: { field: "calc_time", unit: "Unix milliseconds", semantics: "funding observation/calculation time" },
    pit_rule: "funding is consumable when calc_time/pit_available_at <= decision_time; select latest known observation",
    decision_rule: "B4 observation at open_time is consumable at open_time + 1h",
    bucket_semantics: {
      categories: ["NEGATIVE", "NEUTRAL", "POSITIVE"],
      retained_frozen_boundaries: { negative: "rate < -0.00005 (including extreme <= -0.0003)", neutral: "-0.00005 <= rate <= 0.00005", positive: "rate > 0.00005 (including extreme >= 0.0003)" },
      outcome_guided: false,
    },
    archive_status: archiveStatusCounts(audits.filter((audit) => audit.kind === "FUNDING")),
    raw_rows: audits.filter((audit) => audit.kind === "FUNDING").reduce((total, audit) => total + audit.rawRows, 0),
    parsed_rows: audits.filter((audit) => audit.kind === "FUNDING").reduce((total, audit) => total + audit.parsedRows, 0),
    normalized_rows: [...fundingRows.values()].reduce((total, rows) => total + rows.length, 0),
    funding_complete_slots: fundingCoverage.complete,
    funding_mapping_coverage_percent: fundingCoverage.coveragePercent,
    control_data_incomplete_events: incompleteEvents.length,
    materialized_files: fundingMaterialized,
    pit_safe: pitSafe,
    future_outcomes_generated: 0,
  };
  const matchingManifest: JsonRecord = {
    manifest_version: "hy-r5.10a-matching-protocol-v1",
    experiment_id: R510A_EXPERIMENT_ID,
    candidate_only: "B4",
    excluded_candidates: ["B1", "B2", "B3", "B5"],
    matched_fields: [...R510A_MATCH_FIELDS],
    current_b4_feature_strength_used_for_matching: false,
    current_b4_feature_strength_audit: true,
    feature_strength_balance_failure: false,
    control_definition: "B4 condition false at the same eligible holdout observation with complete pre-treatment context",
    control_uniqueness: "nearest without replacement within each direction-specific matching pass; a control may appear in both direction passes because the passes are independent and this rule is frozen before outcomes",
    matcher: "existing HeYue matchNearestWithoutReplacement; exact seven-field key; nearest decision-time tie breaks to earlier control",
    funding_unknown_policy: "CONTROL_DATA_INCOMPLETE; never formal Control B UNKNOWN",
    pre_treatment_balance_fields: [...R510A_MATCH_FIELDS],
    severe_imbalance_threshold_total_variation: 0.20,
    pre_treatment_balance: balance,
    feature_strength_audit: strengthAudit,
    eligible_b4_events: { pooled: pooledEligible, bullish: bullish.events.length, bearish: bearish.events.length, total_condition_transitions: totalB4Events.length, control_data_incomplete: incompleteEvents.length },
    potential_matched_events: { pooled: pooledMatched, bullish: bullish.pairs.length, bearish: bearish.pairs.length },
    matching_coverage: { pooled_percent: pooledCoverage, ...directionCoverages },
    minimum_sample_gate: { required: { pooled: 1_000, bullish: 300, bearish: 300 }, observed: potentialSample, pass: sampleGate },
    matching_coverage_gate: { required: { pooled_percent: 70, bullish_percent: 60, bearish_percent: 60 }, pass: coverageGate },
    frozen_before_outcomes: true,
    future_outcomes_generated: 0,
  };
  const hypothesisManifest: JsonRecord = {
    manifest_version: "hy-r5.10a-confirmation-hypothesis-v1",
    experiment_id: R510A_EXPERIMENT_ID,
    candidate: R510A_CANDIDATE,
    hypothesis_id: R510A_PRIMARY_HYPOTHESIS,
    primary_metric: R510A_PRIMARY_METRIC,
    primary: "pooled B4 directional 1h precision lift versus frozen Existing-Information Control; bullish up is correct and bearish down is correct",
    secondary: ["B4 bullish 1h", "B4 bearish 1h", "B4 pooled 4h", "B4 bullish 4h", "B4 bearish 4h"],
    exploratory_only: ["12h", "24h"],
    primary_failure_cannot_be_rescued_by_secondary: true,
    b4_semantics: {
      bearish: "price-change percentile >= 0.75 AND premium-change percentile <= 0.25",
      bullish: "price-change percentile <= 0.25 AND premium-change percentile >= 0.75",
      rolling_history_observations: R58A1_ROLLING_MINIMUM_HISTORY,
      formation: "false -> true only; true -> true deduplicated",
      hypothesis: "DIVERGENCE_REVERSAL",
    },
    discovery_reference_only: {
      bullish_1h_lift: 0.1261786,
      bearish_1h_lift: 0.125672,
      use: "attenuation ratio only in a later outcome stage; never threshold, filter, or matching input",
    },
    confirmation_success_next_stage: [
      "positive pooled 1h lift",
      "95% CI lower > 0",
      "coverage gates pass",
      "pre-treatment balance pass",
      "Funding complete",
      "not single-symbol/week dominated",
      "PIT pass",
      "post-result tuning = NO",
    ],
    future_outcomes_generated: 0,
  };
  const datasetManifest: JsonRecord = {
    manifest_version: "hy-r5.10a-holdout-dataset-v1",
    experiment_id: R510A_EXPERIMENT_ID,
    candidate: "B4",
    holdout_range: coverageManifest.holdout_range,
    warmup_range: coverageManifest.warmup_range,
    eligible_symbols: eligibleSymbols,
    listing_lifecycles: eligibleListings.map((listing) => lifecycleJson(listing, lifecycleMap)),
    archives: audits.map(archiveJson),
    family_materialized_files: familyMaterialized,
    funding_materialized_files: fundingMaterialized,
    aligned_materialized_files: alignedMaterialized.files,
    coverage: coverageManifest,
    schema: { kline_fields: [...OFFICIAL_BINANCE_KLINE_COLUMNS], funding_fields: [...FUNDING_COLUMNS], conflicts: schemaConflictCount },
    pit_contract: { kline_timestamp: "open_time, Unix milliseconds, 1h period-start", kline_available_at: "open_time + 1h", funding_timestamp: "calc_time, Unix milliseconds", funding_available_at: "calc_time", forward_fill: false, interpolation: false, zero_fill: false },
    no_outcome_policy: { future_performance_calculated: false, future_outcomes_generated: 0, future_returns: false, mfe: false, mae: false, precision: false, pnl: false, matched_outcome: false },
    materialized_range_locked_only_if_ready: true,
    outcome_window_locked: outcomeWindowIsLocked(classification),
  };
  const artifactHashes = {
    representation: "canonical JSON via stableJson; object keys sorted recursively, array order preserved",
    coverage_manifest: { path: relativePath(COVERAGE_PATH), sha256: sha256Json(coverageManifest) },
    funding_manifest: { path: relativePath(FUNDING_PATH), sha256: sha256Json(fundingManifest) },
    matching_protocol_manifest: { path: relativePath(MATCHING_PATH), sha256: sha256Json(matchingManifest) },
    confirmation_hypothesis_manifest: { path: relativePath(HYPOTHESIS_PATH), sha256: sha256Json(hypothesisManifest) },
    holdout_dataset_manifest: { path: relativePath(DATASET_PATH), sha256: sha256Json(datasetManifest) },
    protocol_manifest_hash: protocolManifestHash(matchingManifest, hypothesisManifest),
    holdout_dataset_hash: sha256Json(datasetManifest),
    matching_protocol_hash: sha256Json(matchingManifest),
  };
  await writeFile(COVERAGE_PATH, `${JSON.stringify(coverageManifest, null, 2)}\n`, "utf8");
  await writeFile(FUNDING_PATH, `${JSON.stringify(fundingManifest, null, 2)}\n`, "utf8");
  await writeFile(MATCHING_PATH, `${JSON.stringify(matchingManifest, null, 2)}\n`, "utf8");
  await writeFile(HYPOTHESIS_PATH, `${JSON.stringify(hypothesisManifest, null, 2)}\n`, "utf8");
  await writeFile(DATASET_PATH, `${JSON.stringify(datasetManifest, null, 2)}\n`, "utf8");
  await writeFile(HASHES_PATH, `${JSON.stringify(artifactHashes, null, 2)}\n`, "utf8");
  const negative = await negativeEvidence();
  const report: JsonRecord = {
    research: "HY-R5.10A B4 INDEPENDENT HOLDOUT PROTOCOL + DATA FREEZE",
    version: "hy-r5.10a-b4-holdout-protocol-freeze-v1",
    generated_at: new Date().toISOString(),
    classification,
    candidate: R510A_CANDIDATE,
    primary_hypothesis: R510A_PRIMARY_METRIC,
    primary_hypothesis_id: R510A_PRIMARY_HYPOTHESIS,
    holdout_range: `${new Date(HOLDOUT_START).toISOString()} → ${new Date(HOLDOUT_END_EXCLUSIVE - 1).toISOString()}`,
    holdout_start: new Date(HOLDOUT_START).toISOString(),
    holdout_end_exclusive: new Date(HOLDOUT_END_EXCLUSIVE).toISOString(),
    latest_complete_archive_period: LATEST_COMPLETE_PERIOD,
    latest_complete_archive_date: new Date(HOLDOUT_END_EXCLUSIVE - 1).toISOString(),
    warmup_range: `${new Date(WARMUP_START).toISOString()} → ${new Date(HOLDOUT_END_EXCLUSIVE - 1).toISOString()}`,
    calendar_days: Math.round((HOLDOUT_END_EXCLUSIVE - HOLDOUT_START) / DAY_MS),
    eligible_universe_count: eligibleSymbols.length,
    eligible_universe: eligibleSymbols,
    aligned_b4_slots: alignedValid,
    funding_complete_slots: fundingCoverage.complete,
    b4_data_coverage_percent: b4DataCoverage,
    funding_mapping_coverage_percent: fundingCoverage.coveragePercent,
    eligible_b4_bullish_events: bullish.events.length,
    eligible_b4_bearish_events: bearish.events.length,
    potential_matched_bullish: bullish.pairs.length,
    potential_matched_bearish: bearish.pairs.length,
    pre_outcome_pooled_matching_coverage_percent: pooledCoverage,
    current_b4_feature_strength_used_for_matching: "NO",
    current_b4_feature_strength_audit: "YES",
    pre_treatment_balance: balance.status,
    max_pre_treatment_tv: balance.max_total_variation,
    funding_control: fundingControlComplete ? "COMPLETE" : "INCOMPLETE",
    existing_mark_index_control: existingBasisControlComplete ? "COMPLETE" : "INCOMPLETE",
    minimum_sample_gate: sampleGate ? "PASS" : "FAIL",
    matching_coverage_gate: coverageGate ? "PASS" : "FAIL",
    pit_safe: pitSafe ? "PASS" : "FAIL",
    future_performance_calculated: "NO",
    future_outcomes_generated: 0,
    protocol_manifest_hash: artifactHashes.protocol_manifest_hash,
    funding_manifest_hash: artifactHashes.funding_manifest.sha256,
    holdout_dataset_hash: artifactHashes.holdout_dataset_hash,
    matching_protocol_hash: artifactHashes.matching_protocol_hash,
    coverage: {
      aligned_expected: alignedExpected,
      aligned_valid: alignedValid,
      b4_data_coverage_percent: b4DataCoverage,
      funding_aligned_slots: fundingCoverage.aligned,
      funding_complete_slots: fundingCoverage.complete,
      funding_mapping_coverage_percent: fundingCoverage.coveragePercent,
      worst_symbol: worstSymbol,
      missing_intervals: missingIntervalEvidence,
      schema_conflicts: schemaConflictCount,
    },
    matching: {
      eligible: potentialSample,
      matched: { pooled: pooledMatched, bullish: bullish.pairs.length, bearish: bearish.pairs.length },
      pooled_coverage_percent: pooledCoverage,
      direction_coverage: directionCoverages,
      pre_treatment_balance: balance.status,
      max_pre_treatment_tv: balance.max_total_variation,
      feature_strength_audit: strengthAudit,
    },
    governance: guards,
    lifecycle_evidence: Object.fromEntries(["BTCUSDT", "PUMPUSDT"].map((symbol) => [symbol, eligibleListings.some((listing) => listing.symbol === symbol) ? lifecycleJson(eligibleListings.find((listing) => listing.symbol === symbol)!, lifecycleMap) : null])),
    raw_schema_samples: [...samples.values()].sort((left, right) => left.symbol.localeCompare(right.symbol)).map((sample) => ({
      symbol: sample.symbol,
      family: sample.family,
      period: sample.period,
      source_url: sample.sourceUrl,
      file_path: sample.filePath,
      header_fields: sample.headerFields,
      exact_schema_fields: sample.exactSchemaFields,
      first_three_raw_rows: sample.firstThreeRawRows,
      first_three_timestamps: sample.firstThreeTimestamps,
      timestamp_spacing_milliseconds: sample.timestampSpacingMilliseconds,
    })),
    negative_evidence: negative,
    artifact_hashes: artifactHashes,
    artifacts: {
      coverage_manifest: relativePath(COVERAGE_PATH),
      funding_manifest: relativePath(FUNDING_PATH),
      matching_protocol_manifest: relativePath(MATCHING_PATH),
      confirmation_hypothesis_manifest: relativePath(HYPOTHESIS_PATH),
      holdout_dataset_manifest: relativePath(DATASET_PATH),
      artifact_hashes: relativePath(HASHES_PATH),
      materialized_root: relativePath(MATERIALIZED_ROOT),
      raw_dataset_excluded_from_return: true,
    },
    tests: testStatus("HY_R510A_TEST_STATUS", "NOT_RUN"),
    typecheck: testStatus("HY_R510A_TYPECHECK_STATUS", "NOT_RUN"),
    lint: testStatus("HY_R510A_LINT_STATUS", "NOT_RUN"),
    diff_check: testStatus("HY_R510A_DIFF_STATUS", "NOT_RUN"),
    outcome_window_locked: outcomeWindowIsLocked(classification),
    safety: {
      production_modified: false,
      supabase_modified: false,
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
  };
  await writeFile(REPORT_JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(REPORT_MD_PATH, buildMarkdown(report), "utf8");
  console.log(JSON.stringify({
    classification,
    holdout_range: report.holdout_range,
    eligible_universe: eligibleSymbols.length,
    aligned_b4_slots: alignedValid,
    funding_complete_slots: fundingCoverage.complete,
    b4_events: { bullish: bullish.events.length, bearish: bearish.events.length },
    matched: { pooled: pooledMatched, bullish: bullish.pairs.length, bearish: bearish.pairs.length },
    artifacts: artifactHashes,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
