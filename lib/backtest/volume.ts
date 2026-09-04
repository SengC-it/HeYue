import type { Candle } from "@/lib/core/types";

export type HistoricalVolumeSource =
  | "BINANCE_QUOTE_VOLUME"
  | "ESTIMATED_CLOSE_X_BASE_VOLUME"
  | "MIXED_WITH_FALLBACK";

export function quoteVolumeForCandle(candle: Candle): number {
  if (Number.isFinite(candle.quoteVolume) && (candle.quoteVolume ?? 0) >= 0) {
    return candle.quoteVolume as number;
  }
  return Math.max(0, candle.close * candle.volume);
}

export function volumeSourceForCandles(candles: Candle[]): HistoricalVolumeSource {
  const hasQuoteVolume = candles.some((candle) => Number.isFinite(candle.quoteVolume) && (candle.quoteVolume ?? 0) >= 0);
  const hasFallback = candles.some((candle) => !Number.isFinite(candle.quoteVolume) || (candle.quoteVolume ?? 0) < 0);
  if (hasQuoteVolume && hasFallback) return "MIXED_WITH_FALLBACK";
  return hasQuoteVolume ? "BINANCE_QUOTE_VOLUME" : "ESTIMATED_CLOSE_X_BASE_VOLUME";
}

export function volumeSourceForDatasets(candlesByDataset: Candle[][]): HistoricalVolumeSource {
  const sources = new Set(candlesByDataset.map(volumeSourceForCandles));
  if (sources.size === 0) return "ESTIMATED_CLOSE_X_BASE_VOLUME";
  if (sources.size > 1 || sources.has("MIXED_WITH_FALLBACK")) return "MIXED_WITH_FALLBACK";
  return sources.values().next().value as HistoricalVolumeSource;
}
