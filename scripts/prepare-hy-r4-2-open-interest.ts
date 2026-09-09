import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

const DATA_DIR = join(process.cwd(), "data", "hy-r2b-history-24m");
const OUTPUT_DIR = join(process.cwd(), "data", "hy-r4.2-open-interest-24m");
const HISTORY_START = Date.parse("2024-08-09T00:00:00.000Z");
const HISTORY_END = Date.parse("2026-08-09T23:59:59.999Z");
const WARMUP_START = HISTORY_START - 30 * 24 * 60 * 60 * 1000;
const SOURCE_BASE =
  "https://data.binance.vision/data/futures/um/daily/metrics";
const REQUEST_CONCURRENCY = 12;
const REQUEST_RETRIES = 3;

interface HistoricalDataset {
  symbol: string;
  candles: Record<string, Array<{ openTime: number }>>;
}

interface OpenInterestPoint {
  timestamp: number;
  openInterest: number;
  openInterestValue: number;
}

interface OpenInterestCache {
  symbol: string;
  source: string;
  sourceInterval: "1h";
  coverageStart: string;
  coverageEnd: string;
  requestedDays: number;
  availableDays: number;
  missingDays: number;
  hourlyPoints: number;
  points: OpenInterestPoint[];
}

interface DailyResult {
  date: string;
  status: "READY" | "MISSING";
  points: OpenInterestPoint[];
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function utcDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function utcDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function listDates(startTime: number, endTime: number): string[] {
  const dates: string[] = [];
  for (let time = utcDayStart(startTime); time <= endTime; time += 24 * 60 * 60 * 1000) {
    dates.push(utcDate(time));
  }
  return dates;
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function parseCreateTime(value: string): number {
  const trimmed = value.trim();
  const normalized = trimmed.includes("T")
    ? trimmed
    : trimmed.replace(" ", "T") + "Z";
  return Date.parse(normalized);
}

function unzipFirstFile(archive: Buffer): string {
  const endOfCentralDirectory = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOfCentralDirectory < 0) {
    throw new Error("ZIP end-of-central-directory record not found");
  }
  const centralDirectoryOffset = archive.readUInt32LE(endOfCentralDirectory + 16);
  const entryCount = archive.readUInt16LE(endOfCentralDirectory + 10);
  let cursor = centralDirectoryOffset;

  for (let entry = 0; entry < entryCount; entry += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("ZIP central-directory entry not found");
    }
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? inflateRawSync(compressed) : compressed;
    return content.toString("utf8");
  }
  throw new Error("ZIP archive has no entries");
}

function parseMetricsCsv(csv: string): OpenInterestPoint[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) {
    return [];
  }
  const headers = lines[0].split(",");
  const timeIndex = headers.indexOf("create_time");
  const openInterestIndex = headers.indexOf("sum_open_interest");
  const openInterestValueIndex = headers.indexOf("sum_open_interest_value");
  if (timeIndex < 0 || openInterestIndex < 0 || openInterestValueIndex < 0) {
    throw new Error("Metrics CSV does not contain the required Open Interest columns");
  }

  const points: OpenInterestPoint[] = [];
  for (const line of lines.slice(1)) {
    const fields = line.split(",");
    const timestamp = parseCreateTime(fields[timeIndex] ?? "");
    const openInterest = Number(fields[openInterestIndex]);
    const openInterestValue = Number(fields[openInterestValueIndex]);
    if (
      !Number.isFinite(timestamp) ||
      timestamp < WARMUP_START ||
      timestamp > HISTORY_END ||
      timestamp % (60 * 60 * 1000) !== 0 ||
      !isFinitePositive(openInterest) ||
      !isFinitePositive(openInterestValue)
    ) {
      continue;
    }
    points.push({ timestamp, openInterest, openInterestValue });
  }
  return points;
}

async function downloadDaily(symbol: string, date: string): Promise<DailyResult> {
  const url = SOURCE_BASE + "/" + symbol + "/" + symbol + "-metrics-" + date + ".zip";
  let lastError: unknown;
  for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (response.status === 404) {
        return { date, status: "MISSING", points: [] };
      }
      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }
      const archive = Buffer.from(await response.arrayBuffer());
      return {
        date,
        status: "READY",
        points: parseMetricsCsv(unzipFirstFile(archive)),
      };
    } catch (error) {
      lastError = error;
      if (attempt < REQUEST_RETRIES) {
        await sleep(250 * attempt);
      }
    }
  }
  throw new Error(
    "Failed to download " + symbol + " " + date + ": " +
      (lastError instanceof Error ? lastError.message : String(lastError)),
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function consume(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => consume()),
  );
  return results;
}

async function loadSymbols(): Promise<string[]> {
  const files = (await readdir(DATA_DIR))
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();
  const symbols: string[] = [];
  for (const fileName of files) {
    const dataset = JSON.parse(
      await readFile(join(DATA_DIR, fileName), "utf8"),
    ) as HistoricalDataset;
    if (dataset.symbol && dataset.candles?.["15m"]?.length) {
      symbols.push(dataset.symbol);
    }
  }
  if (symbols.length !== 49) {
    throw new Error("Expected 49 HY-R2B datasets, found " + symbols.length);
  }
  return symbols;
}

function buildCache(
  symbol: string,
  dates: string[],
  dailyResults: DailyResult[],
): OpenInterestCache {
  const byTimestamp = new Map<number, OpenInterestPoint>();
  for (const result of dailyResults) {
    for (const point of result.points) {
      byTimestamp.set(point.timestamp, point);
    }
  }
  const points = [...byTimestamp.values()].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  const availableDays = dailyResults.filter((result) => result.status === "READY").length;
  return {
    symbol,
    source: SOURCE_BASE,
    sourceInterval: "1h",
    coverageStart: new Date(WARMUP_START).toISOString(),
    coverageEnd: new Date(HISTORY_END).toISOString(),
    requestedDays: dates.length,
    availableDays,
    missingDays: dates.length - availableDays,
    hourlyPoints: points.length,
    points,
  };
}

async function main(): Promise<void> {
  const symbols = await loadSymbols();
  const dates = listDates(WARMUP_START, HISTORY_END);
  await mkdir(OUTPUT_DIR, { recursive: true });

  let completedSymbols = 0;
  const summaries = await mapWithConcurrency(symbols, 2, async (symbol) => {
    const targetPath = join(OUTPUT_DIR, symbol + ".json");
    try {
      const cached = JSON.parse(await readFile(targetPath, "utf8")) as OpenInterestCache;
      if (
        cached.symbol === symbol &&
        cached.requestedDays === dates.length &&
        cached.coverageEnd === new Date(HISTORY_END).toISOString() &&
        cached.hourlyPoints > 0
      ) {
        completedSymbols += 1;
        console.log(
          "CACHED " +
            completedSymbols +
            "/" +
            symbols.length +
            " " +
            symbol +
            " points=" +
            cached.hourlyPoints,
        );
        return {
          symbol,
          status: "CACHED",
          availableDays: cached.availableDays,
          missingDays: cached.missingDays,
          hourlyPoints: cached.hourlyPoints,
        };
      }
    } catch {
      // Download when no complete cache exists.
    }

    const dailyResults = await mapWithConcurrency(
      dates,
      REQUEST_CONCURRENCY,
      (date) => downloadDaily(symbol, date),
    );
    const cache = buildCache(symbol, dates, dailyResults);
    await writeFile(targetPath, JSON.stringify(cache), "utf8");
    completedSymbols += 1;
    console.log(
      "READY " +
        completedSymbols +
        "/" +
        symbols.length +
        " " +
        symbol +
        " availableDays=" +
        cache.availableDays +
        " missingDays=" +
        cache.missingDays +
        " points=" +
        cache.hourlyPoints,
    );
    return {
      symbol,
      status: "READY",
      availableDays: cache.availableDays,
      missingDays: cache.missingDays,
      hourlyPoints: cache.hourlyPoints,
    };
  });

  const failed = summaries.filter((result) => result.status !== "READY" && result.status !== "CACHED");
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        symbols: symbols.length,
        requestedDays: dates.length,
        warmupStart: new Date(WARMUP_START).toISOString(),
        evaluationStart: new Date(HISTORY_START).toISOString(),
        evaluationEnd: new Date(HISTORY_END).toISOString(),
        failed,
        summaries,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
