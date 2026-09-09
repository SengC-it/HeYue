import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BinancePublicClient, mapWithConcurrency } from "@/lib/binance/public-client";
import type { HistoricalDataset } from "@/lib/backtest/types";

const CURRENT_WINDOW_END = 1_786_241_699_999;
const HISTORY_MONTHS = 24;
const WARMUP_DAYS = 14;
const OUTPUT_DIRECTORY = resolve("data", "hy-r2b-history-24m");

async function main(): Promise<void> {
  const files = (await readdir(resolve("data", "validation-cache")))
    .filter((name) => name.endsWith(`-1754705700000-${CURRENT_WINDOW_END}.json`))
    .sort();
  if (files.length < 40) throw new Error(`Expected the existing broad cohort, found ${files.length} symbols`);

  const historyEnd = CURRENT_WINDOW_END;
  const historyStart = addMonths(historyEnd, -HISTORY_MONTHS);
  const warmupStart = historyStart - WARMUP_DAYS * 86_400_000;
  const output = resolve(OUTPUT_DIRECTORY);
  await mkdir(output, { recursive: true });
  const client = new BinancePublicClient("https://fapi.binance.com", undefined, 40);
  const results = await mapWithConcurrency(files, 2, async (fileName) => {
    const existing = JSON.parse(await readFile(resolve("data", "validation-cache", fileName), "utf8")) as HistoricalDataset;
    const symbol = existing.symbol;
    const targetPath = resolve(output, `${symbol}.json`);
    try {
      const cached = JSON.parse(await readFile(targetPath, "utf8")) as HistoricalDataset;
      if (
        cached.candles["15m"].at(-1)?.closeTime === historyEnd
        && (cached.candles["15m"].length ?? 0) > 1
        && (cached.candles["1h"]?.length ?? 0) > 1
        && (cached.candles["4h"]?.length ?? 0) > 1
      ) {
        return {
          symbol,
          status: "CACHED",
          first15m: cached.candles["15m"][0]?.openTime ?? null,
          last15m: cached.candles["15m"].at(-1)?.closeTime ?? null,
          candles15m: cached.candles["15m"].length,
          candles1h: cached.candles["1h"]?.length ?? 0,
          candles4h: cached.candles["4h"]?.length ?? 0,
          fundingRates: cached.fundingRates?.length ?? 0,
          path: targetPath,
        };
      }
    } catch {
      // Download below when no complete local cache exists.
    }
    try {
      const [candles15m, candles1h, candles4h, fundingRates] = await Promise.all([
        client.getCandlesRange(symbol, "15m", warmupStart, historyEnd),
        client.getCandlesRange(symbol, "1h", warmupStart, historyEnd),
        client.getCandlesRange(symbol, "4h", warmupStart, historyEnd),
        client.getFundingRatesRange(symbol, historyStart, historyEnd),
      ]);
      const dataset: HistoricalDataset = {
        symbol,
        instrument: existing.instrument,
        candles: { "15m": candles15m, "1h": candles1h, "4h": candles4h },
        fundingRates,
      };
      await writeFile(targetPath, JSON.stringify(dataset), "utf8");
      return {
        symbol,
        status: "READY",
        first15m: candles15m[0]?.openTime ?? null,
        last15m: candles15m.at(-1)?.closeTime ?? null,
        candles15m: candles15m.length,
        candles1h: candles1h.length,
        candles4h: candles4h.length,
        fundingRates: fundingRates.length,
        path: targetPath,
      };
    } catch (error) {
      return {
        symbol,
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
        path: targetPath,
      };
    }
  });

  const failed = results.filter((result) => result.status === "FAILED");
  console.info(JSON.stringify({
    ok: failed.length === 0,
    historyStart: new Date(historyStart).toISOString(),
    historyEnd: new Date(historyEnd).toISOString(),
    warmupStart: new Date(warmupStart).toISOString(),
    requestedSymbols: files.length,
    readySymbols: results.length - failed.length,
    failed,
    results,
  }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

function addMonths(timestamp: number, months: number): number {
  const date = new Date(timestamp);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
