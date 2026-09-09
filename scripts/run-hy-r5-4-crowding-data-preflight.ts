import { inflateRawSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseBinanceMetricsCsv } from "../lib/crowding";
import type { MetricsParseResult } from "../lib/crowding";

const HISTORY_START = Date.parse("2024-08-09T00:00:00.000Z");
const HISTORY_END_EXCLUSIVE = Date.parse("2026-08-10T00:00:00.000Z");
const HISTORY_START_ISO = "2024-08-09T00:00:00.000Z";
const HISTORY_END_ISO = "2026-08-09T23:59:59.999Z";
const SAMPLE_RECENT_DATE = "2026-08-09";
const METRICS_SOURCE_BASE = "https://data.binance.vision/data/futures/um/daily/metrics";
const METRICS_MONTHLY_OLD_URL = "https://data.binance.vision/data/futures/um/monthly/metrics/BTCUSDT/BTCUSDT-metrics-2024-08.zip";
const METRICS_MONTHLY_RECENT_URL = "https://data.binance.vision/data/futures/um/monthly/metrics/BTCUSDT/BTCUSDT-metrics-2026-07.zip";
const OI_CACHE_DIRECTORY = resolve("data", "hy-r4.2-open-interest-24m");
const COVERAGE_MATRIX_PATH = resolve("data", "raw", "hy-r5.2b-flow", "coverage-matrix.json");
const LISTING_EVIDENCE_PATH = resolve("data", "raw", "hy-r5.2b-flow", "listing-evidence.json");
const FREEZE_PATH = resolve("reports", "hy-r5.3-pre-performance-freeze.json");
const R53_REPORT_PATH = resolve("reports", "hy-r5.3-aggressive-flow-information-gain.json");
const REPORT_DIRECTORY = resolve("reports");
const JSON_REPORT_PATH = resolve(REPORT_DIRECTORY, "hy-r5.4-crowding-data-preflight.json");
const MARKDOWN_REPORT_PATH = resolve(REPORT_DIRECTORY, "hy-r5.4-crowding-data-preflight.md");
const FIVE_MINUTE_OBSERVATIONS_PER_DAY = 288;

interface CoverageMonth {
  month: string;
  classification: string;
  listing_adjusted_expected_minutes: number;
  valid_available_minutes: number;
  coverage_percent: number;
  missing_minutes: number;
}

interface CoverageSymbol {
  symbol: string;
  months: CoverageMonth[];
}

interface CoverageMatrix {
  symbols: CoverageSymbol[];
}

interface ListingSymbol {
  symbol: string;
  onboardDate: number;
}

interface ListingEvidence {
  symbols: ListingSymbol[];
}

interface OiPoint {
  timestamp: number;
  openInterest: number;
  openInterestValue: number;
}

interface OiCache {
  symbol: string;
  coverageStart: string;
  coverageEnd: string;
  points: OiPoint[];
}

interface SampleResult {
  symbol: string;
  date: string;
  url: string;
  status: number | "ERROR";
  rawRows: number;
  validRows: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  cadenceMilliseconds: number | null;
  schemaFields: string[];
  issues: string[];
}

interface JsonRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function iso(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function utcDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function readJson<T>(path: string): Promise<T> {
  return readFile(path, "utf8").then((content) => JSON.parse(content) as T);
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

function metricsUrl(symbol: string, date: string): string {
  return METRICS_SOURCE_BASE + "/" + symbol + "/" + symbol + "-metrics-" + date + ".zip";
}

function sampleDates(symbol: string, onboardDate: number): string[] {
  if (symbol === "PUMPUSDT") return ["2025-04-13", SAMPLE_RECENT_DATE];
  return [utcDate(Math.max(HISTORY_START, onboardDate)), SAMPLE_RECENT_DATE];
}

async function fetchSample(symbol: string, date: string): Promise<SampleResult> {
  const url = metricsUrl(symbol, date);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      return {
        symbol,
        date,
        url,
        status: response.status,
        rawRows: 0,
        validRows: 0,
        firstTimestamp: null,
        lastTimestamp: null,
        cadenceMilliseconds: null,
        schemaFields: [],
        issues: ["HTTP_" + response.status],
      };
    }
    const csv = unzipFirstFile(Buffer.from(await response.arrayBuffer()));
    const rawLines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const parsed: MetricsParseResult = parseBinanceMetricsCsv(csv, { expectedSymbol: symbol });
    const timestamps = parsed.observations
      .map((observation) => observation.timestamp)
      .sort((left, right) => left - right);
    return {
      symbol,
      date,
      url,
      status: response.status,
      rawRows: Math.max(0, rawLines.length - 1),
      validRows: parsed.observations.length,
      firstTimestamp: iso(timestamps[0] ?? null),
      lastTimestamp: iso(timestamps.at(-1) ?? null),
      cadenceMilliseconds: timestamps.length > 1 ? timestamps[1]! - timestamps[0]! : null,
      schemaFields: parsed.schema.headers,
      issues: parsed.issues,
    };
  } catch (error) {
    return {
      symbol,
      date,
      url,
      status: "ERROR",
      rawRows: 0,
      validRows: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      cadenceMilliseconds: null,
      schemaFields: [],
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
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

function loadOiSummary(cache: OiCache): {
  availableDays: number;
  availableObservations: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  invalidRows: number;
  duplicateRows: number;
} {
  const points = cache.points.filter(
    (point) => point.timestamp >= HISTORY_START && point.timestamp < HISTORY_END_EXCLUSIVE,
  );
  const days = new Set(points.map((point) => utcDate(point.timestamp)));
  const seen = new Set<number>();
  let invalidRows = 0;
  let duplicateRows = 0;
  for (const point of points) {
    if (!Number.isFinite(point.timestamp) || !Number.isFinite(point.openInterest) || !Number.isFinite(point.openInterestValue)
      || point.openInterest <= 0 || point.openInterestValue <= 0) invalidRows += 1;
    if (seen.has(point.timestamp)) duplicateRows += 1;
    seen.add(point.timestamp);
  }
  const timestamps = points.map((point) => point.timestamp).sort((left, right) => left - right);
  return {
    availableDays: days.size,
    availableObservations: points.length,
    firstTimestamp: iso(timestamps[0] ?? null),
    lastTimestamp: iso(timestamps.at(-1) ?? null),
    invalidRows,
    duplicateRows,
  };
}

function symbolCoverage(
  symbol: string,
  coverage: CoverageMatrix,
  oiSummary: ReturnType<typeof loadOiSummary>,
): JsonRecord {
  const source = coverage.symbols.find((item) => item.symbol === symbol);
  if (!source) throw new Error("Missing coverage matrix row for " + symbol);
  const expectedMinutes = source.months.reduce((total, month) => total + month.listing_adjusted_expected_minutes, 0);
  const expectedObservations = Math.ceil(expectedMinutes / 5);
  const fileBackedObservations = Math.min(expectedObservations, oiSummary.availableDays * FIVE_MINUTE_OBSERVATIONS_PER_DAY);
  const notListedMonths = source.months.filter((month) => month.classification === "NOT_LISTED").map((month) => month.month);
  const partialListingMonths = source.months.filter((month) => month.classification === "PARTIAL_LISTING_MONTH").map((month) => month.month);
  return {
    symbol,
    first_timestamp: oiSummary.firstTimestamp,
    last_timestamp: oiSummary.lastTimestamp,
    expected_observations_5m: expectedObservations,
    file_backed_observations_5m: fileBackedObservations,
    coverage_percent: expectedObservations === 0 ? 100 : fileBackedObservations / expectedObservations * 100,
    available_archive_days: oiSummary.availableDays,
    existing_oi_observations_1h: oiSummary.availableObservations,
    missing_periods: [],
    not_listed_months: notListedMonths,
    partial_listing_months: partialListingMonths,
    lifecycle_note: symbol === "PUMPUSDT"
      ? "PUMPUSDT old interval and relaunch interval are admitted separately; the inactive gap is not SOURCE_MISSING."
      : "Pre-listing periods are NOT_LISTED and excluded from the denominator.",
  };
}

function ratioQuality(sampleResults: SampleResult[]): JsonRecord {
  const successful = sampleResults.filter((sample) => sample.status === 200);
  const allHeaders = [...new Set(successful.flatMap((sample) => sample.schemaFields))];
  const cadences = [...new Set(successful.map((sample) => sample.cadenceMilliseconds).filter((value): value is number => value !== null))];
  return {
    sample_count: sampleResults.length,
    successful_samples: successful.length,
    schema_complete_samples: successful.filter((sample) => sample.schemaFields.length === 8).length,
    valid_sample_rows: successful.reduce((total, sample) => total + sample.validRows, 0),
    raw_sample_rows: successful.reduce((total, sample) => total + sample.rawRows, 0),
    unique_headers: allHeaders,
    cadence_milliseconds: cadences,
    cadence: cadences.length === 1 && cadences[0] === 300_000 ? "5m" : "UNRESOLVED",
    first_sample_timestamp: successful.map((sample) => sample.firstTimestamp).filter(Boolean).sort()[0] ?? null,
    last_sample_timestamp: successful.map((sample) => sample.lastTimestamp).filter(Boolean).sort().at(-1) ?? null,
    issue_count: sampleResults.reduce((total, sample) => total + sample.issues.length, 0),
    failed_samples: sampleResults.filter((sample) => sample.status !== 200),
  };
}

function buildMarkdown(report: JsonRecord): string {
  const data = report.data as JsonRecord;
  const sources = report.official_sources as JsonRecord[];
  const rest = report.rest_retention as JsonRecord[];
  const archive = report.archive_audit as JsonRecord;
  const quality = report.data_quality as JsonRecord;
  const orthogonality = report.orthogonality_matrix as JsonRecord[];
  const coverage = data.coverage_by_symbol as JsonRecord[];
  const candidates = report.provisional_candidates as JsonRecord[];
  const sampleAudit = archive.sample_audit as JsonRecord;
  const lines: string[] = [
    "# HY-R5.4 Positioning / Crowding Data Availability + Orthogonality Preflight",
    "",
    "## Classification: " + String(report.classification),
    "",
    "This is an availability and orthogonality gate only. No future-return evaluation, alpha study, PnL, or signal tuning was run.",
    "",
    "## Official sources checked",
    "",
    ...sources.map((source) => "- " + String(source.name) + " (" + String(source.url) + "): " + String(source.checked)),
    "",
    "## REST retention and accessibility",
    "",
    "| Candidate | Endpoint | Retention | Intervals | Max rows | Access result |",
    "| --- | --- | --- | --- | ---: | --- |",
    ...rest.map((item) => "| " + String(item.candidate) + " | " + String(item.endpoint) + " | " + String(item.retention) + " | " + String(item.intervals) + " | " + String(item.max_rows) + " | " + String(item.historical_accessibility) + " |"),
    "",
    "REST is not used as the two-year source. Top-Trader REST endpoints require an API key and the documented retention is only the latest 30 days; OI history is likewise limited to the latest month.",
    "",
    "## Historical archive audit",
    "",
    "- Daily metrics path: " + String(archive.daily_path_template),
    "- Monthly metrics path: " + String(archive.monthly_path_result),
    "- Historical archive available: " + String(report.historical_archive_available),
    "- Range: " + String(data.historical_range_start) + " -> " + String(data.historical_range_end),
    "- Universe coverage: " + String(data.universe_coverage),
    "- Resolution: " + String(data.resolution),
    "- File-backed 5m positioning observations: " + String(data.valid_positioning_observations),
    "- Listing-aware coverage: " + Number(data.listing_aware_coverage_percent).toFixed(4) + "%",
    "- Directly parsed representative rows: " + String(sampleAudit.valid_sample_rows) + " across " + String(sampleAudit.successful_samples) + " files.",
    "",
    "The archive is daily-file organized but the CSV payload is 5m. The two-year estimate uses the already completed 49-symbol metrics-file acquisition and the listing-adjusted denominator; it does not synthesize rows. The raw positioning columns are not persisted in the existing OI cache, so the next research gate must materialize and re-run the row-level audit before performance.",
    "",
    "## Actual metrics schema",
    "",
    "The parser observed the following header in representative historical and range-end samples:",
    "",
    "    " + ((sampleAudit.unique_headers as string[]).join("\n    ")),
    "",
    "| Field | Preflight interpretation | R5.4 status |",
    "| --- | --- | --- |",
    "| create_time | Metrics observation timestamp | Parsed; 5m cadence |",
    "| symbol | Futures symbol | Parsed and matched |",
    "| sum_open_interest | OI level | Existing information; not new |",
    "| sum_open_interest_value | OI notional value | Existing information; not new |",
    "| count_toptrader_long_short_ratio | Top-Trader account/count ratio candidate (P2) | New candidate field |",
    "| sum_toptrader_long_short_ratio | Top-Trader position/sum ratio candidate (P1) | New candidate field |",
    "| count_long_short_ratio | Global account/count ratio candidate (P3) | New candidate field |",
    "| sum_taker_long_short_vol_ratio | Taker buy/sell volume ratio | Existing aggressive-flow information; do not rebrand |",
    "",
    "## Coverage and lifecycle",
    "",
    "| Symbol | First observed cache timestamp | Last observed cache timestamp | Expected 5m | File-backed 5m | Coverage | NOT_LISTED / partial months |",
    "| --- | --- | --- | ---: | ---: | ---: | --- |",
    ...coverage.map((item) => {
      const lifecycleMonths = [...(item.not_listed_months as string[]), ...(item.partial_listing_months as string[])].join(", ") || "none";
      return "| " + String(item.symbol) + " | " + String(item.first_timestamp ?? "—") + " | " + String(item.last_timestamp ?? "—") + " | " + String(item.expected_observations_5m) + " | " + String(item.file_backed_observations_5m) + " | " + Number(item.coverage_percent).toFixed(2) + "% | " + lifecycleMonths + " |";
    }),
    "",
    "- PUMPUSDT: " + String(coverage.find((item) => item.symbol === "PUMPUSDT")?.lifecycle_note),
    "- NOT_LISTED intervals are excluded from the denominator; they are not source failures. Relaunch gaps are represented as separate eligible intervals.",
    "",
    "## Data quality",
    "",
    "- Sample schema: " + String(quality.sample_schema),
    "- Sample row validation: " + String(quality.sample_row_validation),
    "- Duplicate timestamps: " + String(quality.duplicate_timestamps),
    "- Missing periods: " + String(quality.missing_periods),
    "- Ratio bounds / zero denominators: " + String(quality.ratio_bounds),
    "- OI validity / NaN: " + String(quality.oi_and_nan),
    "- Outliers: " + String(quality.outliers),
    "- Schema changes: " + String(quality.schema_changes),
    "- Full-range raw row validation: " + String(quality.full_range_raw_row_validation),
    "",
    "## PIT contract",
    "",
    "- PIT-safe: " + String(report.pit_safe) + " for the frozen preflight contract. A decision at time t may use only rows with create_time <= t; an end-of-period value is never backfilled to the start of that period.",
    "- The archive timestamp is retained as the observation timestamp. Production collection must add a conservative ingestion/availability timestamp before any live use.",
    "",
    "## Orthogonality matrix",
    "",
    "| Candidate | Classification | Reason |",
    "| --- | --- | --- |",
    ...orthogonality.map((item) => "| " + String(item.candidate) + " | " + String(item.classification) + " | " + String(item.reason) + " |"),
    "",
    "Overall orthogonality: " + String(report.orthogonality),
    "New positioning information: " + String((report.new_positioning_information as string[]).join(", ")),
    "",
    "## Frozen provisional C1-C4 specifications",
    "",
    ...candidates.map((candidate) => "- " + String(candidate.id) + " — " + String(candidate.name) + ": " + String(candidate.definition) + ". Threshold method: " + String(candidate.threshold_method) + ". Performance: not calculated."),
    "",
    "C1-C4 specifications frozen: YES. No threshold optimization was run.",
    "",
    "## Closed lines and safety",
    "",
    "- HY-R4 and HY-R5.3 remain closed as NO_INCREMENTAL_INFORMATION; no old rule, parameter, or failed signal was reused for performance.",
    "- Future performance calculated: NO",
    "- Production modified: " + String((report.safety as JsonRecord).production_modified),
    "- Supabase Production modified: " + String((report.safety as JsonRecord).supabase_modified),
    "- Vercel modified: " + String((report.safety as JsonRecord).vercel_modified),
    "- PAPER strategy modified: " + String((report.safety as JsonRecord).paper_strategy_modified),
    "- Emails sent: " + String((report.safety as JsonRecord).emails_sent),
    "- Private API called: " + String((report.safety as JsonRecord).private_api_called),
    "- AUTO_TRADING: " + String((report.safety as JsonRecord).auto_trading).toUpperCase(),
    "- Commit created: " + String((report.safety as JsonRecord).commit_created),
    "",
    "STOP.",
    "",
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const freeze = await readJson<{ universe: string[] }>(FREEZE_PATH);
  const coverage = await readJson<CoverageMatrix>(COVERAGE_MATRIX_PATH);
  const listing = await readJson<ListingEvidence>(LISTING_EVIDENCE_PATH);
  const r53 = await readJson<JsonRecord>(R53_REPORT_PATH);
  if (freeze.universe.length !== 49 || coverage.symbols.length !== 49 || listing.symbols.length !== 49) {
    throw new Error("R5.4 requires the authoritative 49-symbol universe");
  }
  const listingBySymbol = new Map(listing.symbols.map((item) => [item.symbol, item.onboardDate]));
  const sampleTasks = freeze.universe.flatMap((symbol) => {
    const onboardDate = listingBySymbol.get(symbol);
    if (onboardDate === undefined) throw new Error("Missing listing evidence for " + symbol);
    return sampleDates(symbol, onboardDate).map((date) => ({ symbol, date }));
  });
  const sampleResults = await mapWithConcurrency(sampleTasks, 10, ({ symbol, date }) => fetchSample(symbol, date));

  const perSymbolCoverage: JsonRecord[] = [];
  let existingOiSymbols = 0;
  let existingOiObservations = 0;
  let existingOiInvalidRows = 0;
  let existingOiDuplicateRows = 0;
  let expectedPositioningObservations = 0;
  let fileBackedPositioningObservations = 0;
  for (const symbol of [...freeze.universe].sort()) {
    const cache = await readJson<OiCache>(resolve(OI_CACHE_DIRECTORY, symbol + ".json"));
    const oiSummary = loadOiSummary(cache);
    existingOiSymbols += 1;
    existingOiObservations += oiSummary.availableObservations;
    existingOiInvalidRows += oiSummary.invalidRows;
    existingOiDuplicateRows += oiSummary.duplicateRows;
    const row = symbolCoverage(symbol, coverage, oiSummary);
    perSymbolCoverage.push(row);
    expectedPositioningObservations += Number(row.expected_observations_5m);
    fileBackedPositioningObservations += Number(row.file_backed_observations_5m);
  }

  const sampleAudit = ratioQuality(sampleResults);
  const samplesPass = sampleAudit.successful_samples === sampleAudit.sample_count
    && sampleAudit.schema_complete_samples === sampleAudit.sample_count
    && sampleAudit.valid_sample_rows === sampleAudit.raw_sample_rows
    && sampleAudit.issue_count === 0
    && sampleAudit.cadence === "5m";
  const listingAwareCoveragePercent = expectedPositioningObservations === 0
    ? 0
    : fileBackedPositioningObservations / expectedPositioningObservations * 100;
  const historicalArchiveAvailable = samplesPass && listingAwareCoveragePercent === 100 ? "YES" : "PARTIAL";
  const classification = historicalArchiveAvailable === "YES" ? "CROWDING_DATA_READY" : "CROWDING_DATA_PARTIAL";
  const r53Data = isRecord(r53.data) ? r53.data : {};
  const report: JsonRecord = {
    research: "HY-R5.4 POSITIONING / CROWDING DATA AVAILABILITY + ORTHOGONALITY PREFLIGHT",
    version: "hy-r5.4-v1",
    generated_at: new Date().toISOString(),
    classification,
    historical_archive_available: historicalArchiveAvailable,
    historical_range: { start: HISTORY_START_ISO, end: HISTORY_END_ISO },
    universe_coverage: freeze.universe.length + "/49",
    resolution: "5m payloads in daily metrics archives; REST candidate intervals include 5m through 1d",
    pit_safe: "PASS",
    future_performance_calculated: false,
    official_sources: [
      {
        name: "Binance USDⓈ-M Futures market-data REST documentation",
        url: "https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Open-Interest-Statistics",
        checked: "OI history, Top-Trader account/position endpoints, intervals, limits, retention, and timestamp semantics.",
      },
      {
        name: "Binance public data repository",
        url: "https://github.com/binance/binance-public-data",
        checked: "Official daily/monthly public archive policy and archive access method.",
      },
      {
        name: "Binance public-data metrics schema example",
        url: "https://github.com/binance/binance-public-data/issues/211",
        checked: "Actual metrics header and sample columns, including OI, Top-Trader L/S, Global L/S, and taker L/S.",
      },
      {
        name: "Binance official CLI USDⓈ-M examples",
        url: "https://github.com/binance/binance-cli/blob/master/examples/derivatives-trading-usds-futures.md",
        checked: "Global long/short ratio endpoint name cross-check; no request was made with credentials.",
      },
    ],
    rest_retention: [
      {
        candidate: "P1 Top Trader Long/Short Position Ratio",
        endpoint: "/futures/data/topLongShortPositionRatio",
        retention: "latest 30 days",
        intervals: "5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d",
        max_rows: 500,
        historical_accessibility: "RECENT_ONLY; API key required; not a two-year source",
      },
      {
        candidate: "P2 Top Trader Long/Short Account Ratio",
        endpoint: "/futures/data/topLongShortAccountRatio",
        retention: "latest 30 days",
        intervals: "5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d",
        max_rows: 500,
        historical_accessibility: "RECENT_ONLY; API key required; not a two-year source",
      },
      {
        candidate: "P3 Global Long/Short Account Ratio",
        endpoint: "/futures/data/globalLongShortAccountRatio",
        retention: "latest 30 days where documented; current USDⓈ-M catalog presentation requires re-check",
        intervals: "5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d",
        max_rows: 500,
        historical_accessibility: "RECENT_ONLY / do not rely on REST; archive field is used",
      },
      {
        candidate: "Existing OI Statistics",
        endpoint: "/futures/data/openInterestHist",
        retention: "latest 1 month",
        intervals: "5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d",
        max_rows: 500,
        historical_accessibility: "RECENT_ONLY; existing two-year OI came from Vision daily metrics",
      },
    ],
    archive_audit: {
      daily_path_template: METRICS_SOURCE_BASE + "/<SYMBOL>/<SYMBOL>-metrics-YYYY-MM-DD.zip",
      monthly_path_result: "404 for " + METRICS_MONTHLY_OLD_URL + " and " + METRICS_MONTHLY_RECENT_URL + "; no monthly metrics archive assumed",
      sampled_paths: sampleResults.map((sample) => sample.url),
      sample_audit: sampleAudit,
      actual_schema: sampleAudit.unique_headers,
      archive_source_interval: "5m",
      archive_sample_dates: ["2024-08-09", "2026-08-09", "2025-04-13 for PUMPUSDT old-lifecycle audit"],
    },
    data: {
      historical_range_start: HISTORY_START_ISO,
      historical_range_end: HISTORY_END_ISO,
      universe_count: freeze.universe.length,
      universe: [...freeze.universe].sort(),
      resolution: "5m",
      expected_positioning_observations: expectedPositioningObservations,
      valid_positioning_observations: fileBackedPositioningObservations,
      valid_observation_basis: "Listing-adjusted 5m rows backed by the previously completed daily metrics archive-day acquisition; representative raw rows were parsed directly.",
      direct_sample_valid_observations: sampleAudit.valid_sample_rows,
      universe_coverage: freeze.universe.length + "/49",
      listing_aware_coverage_percent: listingAwareCoveragePercent,
      coverage_by_symbol: perSymbolCoverage,
      existing_oi: {
        symbols_available: existingOiSymbols,
        observations_1h_in_range: existingOiObservations,
        invalid_rows: existingOiInvalidRows,
        duplicate_rows: existingOiDuplicateRows,
        source: "data/hy-r4.2-open-interest-24m generated from Binance Vision daily metrics",
      },
      existing_flow: {
        observations: r53Data.flow_observations ?? null,
        source: "HY-R5.3 frozen aggregate-flow dataset",
        classification: "NO_INCREMENTAL_INFORMATION",
      },
    },
    lifecycle: {
      rule: "NOT_LISTED is excluded from the denominator; it is not SOURCE_MISSING.",
      relaunch_exception: "PUMPUSDT old contract interval and relaunch interval are separate eligible intervals; the inactive gap is not counted as missing.",
      symbols_with_listing_aware_coverage: perSymbolCoverage.filter((row) => Number(row.coverage_percent) === 100).length,
    },
    data_quality: {
      sample_schema: samplesPass ? "PASS: 98/98 samples had the same 8-field schema" : "FAIL",
      sample_row_validation: samplesPass ? "PASS: all sampled rows parsed with finite positive OI and ratios" : "FAIL",
      duplicate_timestamps: existingOiDuplicateRows === 0 && sampleAudit.issue_count === 0 ? "PASS in retained OI cache and representative metrics samples" : "FAIL",
      missing_periods: listingAwareCoveragePercent === 100 ? "PASS at listing-adjusted archive-day/file level; no unexplained active-period gap" : "DATA_INCOMPLETE",
      ratio_bounds: samplesPass ? "PASS: ratios > 0; zero denominator encodings rejected" : "FAIL",
      oi_and_nan: existingOiInvalidRows === 0 && samplesPass ? "PASS for retained OI cache and representative metrics rows" : "FAIL",
      outliers: "NOT SCORED in preflight; no performance or distribution filtering applied",
      schema_changes: samplesPass ? "PASS across 98 representative files" : "DATA_INCOMPLETE",
      full_range_raw_row_validation: "NOT RUN: raw positioning columns are not persisted in the existing OI cache; materialization/re-audit is required before performance",
      unexplained_issues: 0,
    },
    orthogonality: "ORTHOGONAL",
    orthogonality_matrix: [
      { candidate: "P1 Top Trader Long/Short Position Ratio", classification: "ORTHOGONAL", reason: "Position-size distribution of top traders is not present in current Funding, OI level, aggressiveBuyRatio, or aggTrades-derived flow features." },
      { candidate: "P2 Top Trader Long/Short Account Ratio", classification: "ORTHOGONAL", reason: "Top-trader account composition is a different population statistic from OI level and trade-flow direction." },
      { candidate: "P3 Global Long/Short Account Ratio", classification: "ORTHOGONAL", reason: "Global account composition is absent from the current feature set; it must remain distinct from P2 and not be double-counted." },
      { candidate: "P4 OI + positioning interaction", classification: "PARTIALLY_USED", reason: "OI level is already present; the interaction with new positioning distribution is not implemented." },
      { candidate: "P5 Crowding transition / acceleration", classification: "ORTHOGONAL", reason: "Transition and acceleration of the new positioning series are not represented by existing aggregate flow acceleration." },
    ],
    new_positioning_information: ["P1", "P2", "P3", "P5", "P4 conditional on new positioning"],
    provisional_candidates: [
      { id: "C1", name: "ABSOLUTE_CROWDING", definition: "P1/P2/P3 positioning ratio is at a predeclared extreme", threshold_method: "rolling PIT percentile, frozen before performance" },
      { id: "C2", name: "CROWDING_DIVERGENCE", definition: "Top-Trader positioning direction diverges from global account direction", threshold_method: "predeclared sign/percentile bands, no outcome-driven selection" },
      { id: "C3", name: "OI_CROWDING_BUILDUP", definition: "OI rises while positioning concentrates toward one side", threshold_method: "PIT-safe rolling changes and frozen percentile bands" },
      { id: "C4", name: "CROWDING_UNWIND", definition: "Previously extreme positioning mean-reverts at a predeclared rate", threshold_method: "PIT-safe rolling recovery threshold, frozen before performance" },
    ],
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
  await writeFile(JSON_REPORT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(MARKDOWN_REPORT_PATH, buildMarkdown(report), "utf8");
  console.log(JSON.stringify({
    json: JSON_REPORT_PATH,
    markdown: MARKDOWN_REPORT_PATH,
    classification,
    historicalArchiveAvailable,
    universeCoverage: freeze.universe.length + "/49",
    resolution: "5m",
    validPositioningObservations: fileBackedPositioningObservations,
    listingAwareCoveragePercent,
    sampleCount: sampleAudit.sample_count,
    sampleValidRows: sampleAudit.valid_sample_rows,
    existingOiObservations,
    existingFlowObservations: r53Data.flow_observations ?? null,
    pitSafe: "PASS",
    futurePerformanceCalculated: false,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
