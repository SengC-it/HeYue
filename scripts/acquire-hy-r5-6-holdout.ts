import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { spawn } from "node:child_process";

import { mapWithConcurrency, parseKline } from "../lib/binance/public-client";
import type { Candle } from "../lib/core/types";
import { parseBinanceMetricsCsv, sha256Json } from "../lib/crowding";

const DAY_MS = 24 * 60 * 60_000;
const HOLDOUT_START = Date.parse("2026-08-10T00:00:00.000Z");
const METRICS_WARMUP_START = HOLDOUT_START - DAY_MS;
const PRICE_WARMUP_START = HOLDOUT_START - 7 * DAY_MS;
const METRICS_SOURCE_BASE = "https://data.binance.vision/data/futures/um/daily/metrics";
const PRICE_SOURCE = "https://fapi.binance.com/fapi/v1/klines";
const OUTPUT_ROOT = resolve("data", "raw", "hy-r5.6-holdout");
const METRICS_ROOT = resolve(OUTPUT_ROOT, "metrics");
const PRICE_ROOT = resolve(OUTPUT_ROOT, "prices");
const MANIFEST_PATH = resolve(OUTPUT_ROOT, "dataset-manifest.json");
const DISCOVERY_FREEZE_PATH = resolve("reports", "hy-r5.5-pre-performance-freeze.json");

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

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function utcDate(timestamp: number): string {
  return iso(timestamp).slice(0, 10);
}

function metricsUrl(symbol: string, date: string): string {
  return `${METRICS_SOURCE_BASE}/${symbol}/${symbol}-metrics-${date}.zip`;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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

function parseMetricFile(symbol: string, date: string, path: string, sourceUrl: string, bytes: Buffer): MetricFileEntry {
  const csv = unzipFirstFile(bytes);
  const parsed = parseBinanceMetricsCsv(csv, { expectedSymbol: symbol });
  const rawRows = Math.max(0, csv.split(/\r?\n/).filter((line) => line.trim().length > 0).length - 1);
  if (parsed.schema.missingFields.length > 0 || parsed.schema.delimiter === "UNKNOWN") {
    throw new Error(`Invalid metrics schema for ${symbol} ${date}`);
  }
  return {
    symbol,
    date,
    path,
    source_url: sourceUrl,
    sha256: sha256Bytes(bytes),
    bytes: bytes.length,
    raw_rows: rawRows,
    parsed_rows: parsed.observations.length,
    schema_headers: parsed.schema.headers,
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

async function loadUniverse(): Promise<string[]> {
  const freeze = JSON.parse(await readFile(DISCOVERY_FREEZE_PATH, "utf8")) as { universe?: unknown };
  if (!Array.isArray(freeze.universe) || !freeze.universe.every((value): value is string => typeof value === "string")) {
    throw new Error("R5.5 freeze does not contain a valid universe");
  }
  return [...freeze.universe].sort();
}

async function fetchArchive(symbol: string, date: string): Promise<Buffer> {
  const url = metricsUrl(symbol, date);
  return runCurl(["--fail", "--silent", "--show-error", "--location", "--max-time", "60", url]);
}

async function archiveEntry(symbol: string, date: string, targetRoot: string): Promise<MetricFileEntry> {
  const path = resolve(targetRoot, symbol, `${symbol}-metrics-${date}.zip`);
  let bytes: Buffer;
  if (await exists(path)) bytes = await readFile(path);
  else {
    bytes = await fetchArchive(symbol, date);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  return parseMetricFile(symbol, date, path, metricsUrl(symbol, date), bytes);
}

async function archiveAvailable(symbol: string, date: string): Promise<boolean> {
  try {
    await runCurl(["--fail", "--silent", "--show-error", "--location", "--head", "--max-time", "30", metricsUrl(symbol, date)]);
    return true;
  } catch {
    return false;
  }
}

async function latestCompleteDate(universe: string[]): Promise<string> {
  const latestCandidate = Date.parse(`${utcDate(Date.now() - DAY_MS)}T00:00:00.000Z`);
  for (let offset = 0; offset < 31; offset += 1) {
    const timestamp = latestCandidate - offset * DAY_MS;
    if (timestamp < HOLDOUT_START) break;
    const date = utcDate(timestamp);
    const availability = await mapWithConcurrency(universe, 8, async (symbol) => archiveAvailable(symbol, date));
    if (availability.every(Boolean)) return date;
  }
  throw new Error("No complete official Binance metrics day is available after the holdout start");
}

function dateRange(startInclusive: number, endInclusive: number): string[] {
  const dates: string[] = [];
  for (let timestamp = startInclusive; timestamp <= endInclusive; timestamp += DAY_MS) dates.push(utcDate(timestamp));
  return dates;
}

function countMissingCadence(candles: Candle[]): number {
  let missing = 0;
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index]!.openTime - candles[index - 1]!.openTime !== 15 * 60_000) missing += 1;
  }
  return missing;
}

async function acquirePrices(universe: string[], endExclusive: number): Promise<PriceFileEntry[]> {
  return mapWithConcurrency(universe, 3, async (symbol) => {
    const candles = await getCandlesRangeWithCurl(symbol, PRICE_WARMUP_START, endExclusive);
    if (candles.length === 0) throw new Error(`No public futures price data for ${symbol}`);
    const payload = {
      symbol,
      source: PRICE_SOURCE,
      timeframe: "15m" as const,
      start: iso(PRICE_WARMUP_START),
      end_exclusive: iso(endExclusive),
      candles,
    };
    const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const path = resolve(PRICE_ROOT, `${symbol}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return {
      symbol,
      path,
      source: PRICE_SOURCE,
      timeframe: "15m" as const,
      start: payload.start,
      end_exclusive: payload.end_exclusive,
      sha256: sha256Bytes(bytes),
      bytes: bytes.length,
      rows: candles.length,
      first_open_time: candles[0]?.openTime ?? null,
      last_open_time: candles.at(-1)?.openTime ?? null,
      missing_15m_cadence: countMissingCadence(candles),
    };
  });
}

async function getCandlesRangeWithCurl(symbol: string, startTime: number, endTime: number): Promise<Candle[]> {
  const candles = new Map<number, Candle>();
  let cursor = startTime;
  let page = 0;
  while (cursor <= endTime && page < 100) {
    const url = new URL(PRICE_SOURCE);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", "15m");
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(endTime));
    url.searchParams.set("limit", "1500");
    const raw = JSON.parse((await runCurl(["--fail", "--silent", "--show-error", "--location", "--max-time", "60", url.toString()])).toString("utf8")) as unknown[][];
    if (raw.length === 0) break;
    for (const row of raw) {
      const candle = parseKline(row);
      if (candle.openTime >= startTime && candle.closeTime <= endTime) candles.set(candle.openTime, candle);
    }
    const lastOpenTime = Number(raw.at(-1)?.[0]);
    if (!Number.isFinite(lastOpenTime) || lastOpenTime < cursor || raw.length < 1500) break;
    cursor = lastOpenTime + 15 * 60_000;
    page += 1;
  }
  return [...candles.values()].sort((left, right) => left.openTime - right.openTime);
}

function runCurl(args: string[]): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("curl.exe", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(stdout));
      else rejectPromise(new Error(`curl exit ${String(code)}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
  });
}

async function main(): Promise<void> {
  if (await exists(MANIFEST_PATH)) {
    console.log(JSON.stringify({ manifest: MANIFEST_PATH, reused: true }, null, 2));
    return;
  }
  const universe = await loadUniverse();
  const latestDate = await latestCompleteDate(universe);
  const holdoutEndExclusive = Date.parse(`${latestDate}T00:00:00.000Z`) + DAY_MS;
  const metricDates = dateRange(METRICS_WARMUP_START, holdoutEndExclusive - DAY_MS);
  const warmupDate = utcDate(METRICS_WARMUP_START);
  const warmupSourceRoot = resolve("data", "raw", "hy-r5.4b-crowding", "daily");
  const warmupRoot = resolve(METRICS_ROOT, "warmup");
  const holdoutRoot = resolve(METRICS_ROOT, "holdout");

  const warmupEntries = await mapWithConcurrency(universe, 8, async (symbol) => {
    const source = resolve(warmupSourceRoot, symbol, `${symbol}-metrics-${warmupDate}.zip`);
    const target = resolve(warmupRoot, symbol, `${symbol}-metrics-${warmupDate}.zip`);
    await mkdir(dirname(target), { recursive: true });
    if (!(await exists(target))) {
      if (await exists(source)) await copyFile(source, target);
      else {
        const bytes = await fetchArchive(symbol, warmupDate);
        await writeFile(target, bytes);
      }
    }
    const bytes = await readFile(target);
    return parseMetricFile(symbol, warmupDate, target, metricsUrl(symbol, warmupDate), bytes);
  });

  const holdoutDates = metricDates.filter((date) => date >= utcDate(HOLDOUT_START));
  const holdoutEntries = await mapWithConcurrency(
    universe.flatMap((symbol) => holdoutDates.map((date) => ({ symbol, date }))),
    8,
    async ({ symbol, date }) => archiveEntry(symbol, date, holdoutRoot),
  );
  const priceEndExclusive = holdoutEndExclusive + 4 * 60 * 60_000;
  const priceEntries = await acquirePrices(universe, priceEndExclusive);
  const manifest = {
    schema_version: "hy-r5.6-holdout-v1",
    research: "HY-R5.6 INDEPENDENT CROWDING HOLDOUT CONFIRMATION",
    selected_phenomenon: "R55:C1:BULLISH:4h",
    discovery_range: {
      start: "2024-08-09T00:00:00.000Z",
      end: "2026-08-09T23:59:59.999Z",
    },
    holdout_range: {
      start: iso(HOLDOUT_START),
      end: iso(holdoutEndExclusive - 1),
      end_exclusive: iso(holdoutEndExclusive),
      latest_complete_official_metrics_day: latestDate,
    },
    universe,
    source_policy: {
      metrics_provider: "Binance Vision official daily futures metrics archive",
      metrics_base_url: METRICS_SOURCE_BASE,
      price_provider: "Binance public USDⓈ-M futures klines endpoint",
      price_source: PRICE_SOURCE,
      private_api: false,
      discovery_compact_rows_used: false,
      discovery_outcomes_used: false,
    },
    pit_warmup: {
      metrics_start: iso(METRICS_WARMUP_START),
      metrics_end_exclusive: iso(HOLDOUT_START),
      price_start: iso(PRICE_WARMUP_START),
      price_end_exclusive: iso(priceEndExclusive),
      metrics_availability: "raw 5m observation timestamp + 5m conservative PIT availability",
      price_availability: "closed 15m candle only",
    },
    files: {
      metrics_warmup: warmupEntries.sort((left, right) => left.symbol.localeCompare(right.symbol)),
      metrics_holdout: holdoutEntries.sort((left, right) => left.symbol.localeCompare(right.symbol) || left.date.localeCompare(right.date)),
      prices: priceEntries.sort((left, right) => left.symbol.localeCompare(right.symbol)),
    },
  };
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    manifest: MANIFEST_PATH,
    manifest_hash: sha256Json(manifest),
    latest_complete_metrics_day: latestDate,
    universe: universe.length,
    metrics_warmup_files: warmupEntries.length,
    metrics_holdout_files: holdoutEntries.length,
    price_files: priceEntries.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
