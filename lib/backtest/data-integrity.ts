import type { Candle, Timeframe } from "@/lib/core/types";
import type { HistoricalDataset } from "./types";

const INTERVAL_MS: Record<Timeframe, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
};

export function historicalDatasetIssues(dataset: HistoricalDataset): string[] {
  const issues: string[] = [];
  if (!dataset.symbol || dataset.instrument.symbol !== dataset.symbol) {
    issues.push("symbol does not match instrument.symbol");
  }

  for (const timeframe of ["15m", "1h", "4h"] as const) {
    const candles = dataset.candles[timeframe];
    if (!candles) continue;
    issues.push(...candleSeriesIssues(timeframe, candles, INTERVAL_MS[timeframe]));
  }

  const fundingRates = dataset.fundingRates ?? [];
  for (let index = 0; index < fundingRates.length; index += 1) {
    const point = fundingRates[index];
    if (!Number.isFinite(point.fundingTime) || !Number.isFinite(point.fundingRate)) {
      issues.push(`funding[${index}] contains a non-finite value`);
    }
    if (index > 0 && point.fundingTime <= fundingRates[index - 1].fundingTime) {
      issues.push(`funding[${index}] is not strictly increasing`);
    }
  }

  return issues;
}

export function assertHistoricalDatasetIntegrity(dataset: HistoricalDataset): void {
  const issues = historicalDatasetIssues(dataset);
  if (issues.length > 0) {
    throw new Error(`Invalid historical dataset ${dataset.symbol}: ${issues.slice(0, 5).join("; ")}`);
  }
}

function candleSeriesIssues(timeframe: Timeframe, candles: Candle[], intervalMs: number): string[] {
  const issues: string[] = [];
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const values = [candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.volume, candle.closeTime];
    if (values.some((value) => !Number.isFinite(value))) {
      issues.push(`${timeframe}[${index}] contains a non-finite value`);
      continue;
    }
    if (
      candle.open <= 0
      || candle.high < Math.max(candle.open, candle.close)
      || candle.low > Math.min(candle.open, candle.close)
      || candle.low <= 0
      || candle.volume < 0
      || candle.closeTime <= candle.openTime
    ) {
      issues.push(`${timeframe}[${index}] violates OHLCV invariants`);
    }
    if (index > 0) {
      const delta = candle.openTime - candles[index - 1].openTime;
      if (delta !== intervalMs) {
        issues.push(`${timeframe}[${index}] interval is ${delta}ms; expected ${intervalMs}ms`);
      }
    }
  }
  return issues;
}
