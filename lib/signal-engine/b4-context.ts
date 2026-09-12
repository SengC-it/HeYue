export interface B4ContextCandle {
  openTime: number;
  closeTime: number;
  close: number;
  high: number;
  low: number;
  open?: number;
  volume?: number;
  quoteVolume?: number;
}

export type B4FundingBucket = "NEGATIVE" | "NEUTRAL" | "POSITIVE";
export type B4BasisBucket = "EXTREME_NEGATIVE" | "NEGATIVE" | "NEUTRAL" | "POSITIVE" | "EXTREME_POSITIVE";
export type B4VolatilityBucket = "LOW" | "NORMAL" | "HIGH";
export type B4LiquidityBucket = "LOW" | "NORMAL" | "HIGH";
export type B4MarketRegime = "UP" | "DOWN" | "RANGE" | "UNKNOWN";

export const B4_FUNDING_NEGATIVE_BOUNDARY = -0.00005 as const;
export const B4_FUNDING_POSITIVE_BOUNDARY = 0.00005 as const;
export const B4_BASIS_EXTREME_BOUNDARY = 0.0005 as const;
export const B4_VOLATILITY_LOW_BOUNDARY = 0.005 as const;
export const B4_VOLATILITY_HIGH_BOUNDARY = 0.015 as const;
export const B4_LIQUIDITY_LOW_BOUNDARY = 0.33 as const;
export const B4_LIQUIDITY_HIGH_BOUNDARY = 0.66 as const;
export const B4_REGIME_DOWN_BOUNDARY = -0.005 as const;
export const B4_REGIME_UP_BOUNDARY = 0.005 as const;
export const B4_CONTEXT_INTERVAL_MS = 3_600_000 as const;

/** Frozen R5.10A funding bucket. Boundary values remain NEUTRAL. */
export function classifyB4FundingBucket(fundingRate: number): B4FundingBucket {
  if (!Number.isFinite(fundingRate)) throw new Error("funding rate must be finite");
  if (fundingRate < B4_FUNDING_NEGATIVE_BOUNDARY) return "NEGATIVE";
  if (fundingRate > B4_FUNDING_POSITIVE_BOUNDARY) return "POSITIVE";
  return "NEUTRAL";
}

/** Frozen R5.10A basis bucket. The input is the ratio mark / index - 1. */
export function classifyB4BasisBucket(basis: number): B4BasisBucket {
  if (!Number.isFinite(basis)) throw new Error("basis must be finite");
  if (basis <= -B4_BASIS_EXTREME_BOUNDARY) return "EXTREME_NEGATIVE";
  if (basis < 0) return "NEGATIVE";
  if (basis === 0) return "NEUTRAL";
  if (basis < B4_BASIS_EXTREME_BOUNDARY) return "POSITIVE";
  return "EXTREME_POSITIVE";
}

export interface B4VolatilityContext {
  value: number | null;
  bucket: B4VolatilityBucket | "UNKNOWN";
}

/** R5.10A: RMS of the last 24 complete log returns, not absolute returns. */
export function calculateB4Volatility(candles: readonly B4ContextCandle[]): B4VolatilityContext {
  const closed = candles
    .filter((candle) => Number.isFinite(candle.openTime)
      && Number.isFinite(candle.closeTime)
      && candle.closeTime < candle.openTime + B4_CONTEXT_INTERVAL_MS
      && candle.close > 0)
    .sort((left, right) => left.openTime - right.openTime);
  const recent = closed.slice(-25);
  if (recent.length !== 25 || !isContiguous(recent)) return { value: null, bucket: "UNKNOWN" };
  const returns = recent.slice(1).map((current, index) => Math.log(current.close / recent[index].close));
  if (returns.some((value) => !Number.isFinite(value))) return { value: null, bucket: "UNKNOWN" };
  const value = Math.sqrt(returns.reduce((sum, current) => sum + current ** 2, 0) / returns.length);
  return {
    value,
    bucket: classifyB4VolatilityValue(value),
  };
}

export function classifyB4VolatilityValue(value: number): B4VolatilityBucket {
  if (!Number.isFinite(value) || value < 0) throw new Error("volatility must be finite");
  return value < B4_VOLATILITY_LOW_BOUNDARY
    ? "LOW"
    : value < B4_VOLATILITY_HIGH_BOUNDARY ? "NORMAL" : "HIGH";
}

export function classifyB4Volatility(candles: readonly B4ContextCandle[]): B4VolatilityContext["bucket"] {
  return calculateB4Volatility(candles).bucket;
}

/** Mean of the last 24 complete hourly quote-asset volumes. */
export function meanB4QuoteVolume(candles: readonly B4ContextCandle[]): number | null {
  const closed = candles
    .filter((candle) => Number.isFinite(candle.openTime)
      && Number.isFinite(candle.closeTime)
      && candle.closeTime < candle.openTime + B4_CONTEXT_INTERVAL_MS
      && Number.isFinite(candle.quoteVolume)
      && (candle.quoteVolume ?? 0) >= 0)
    .sort((left, right) => left.openTime - right.openTime)
    .slice(-24);
  if (closed.length !== 24 || !isContiguous(closed)) return null;
  const value = closed.reduce((sum, candle) => sum + (candle.quoteVolume ?? 0), 0) / closed.length;
  return Number.isFinite(value) ? value : null;
}

/**
 * Exact R5.10A cross-sectional percentile. Ties receive their average
 * (competition) rank, so the result is stable when multiple symbols share a
 * quote-volume value. A one-symbol cross-section has no percentile meaning.
 */
export function b4CrossSectionalPercentile(value: number, peerValues: readonly number[]): number | null {
  if (!Number.isFinite(value) || peerValues.length < 2 || peerValues.some((item) => !Number.isFinite(item))) return null;
  const less = peerValues.filter((item) => item < value).length;
  const equal = peerValues.filter((item) => item === value).length;
  const rank = equal > 0 ? less + (equal + 1) / 2 : less + 1;
  return (rank - 1) / (peerValues.length - 1);
}

export function classifyB4LiquidityPercentile(percentile: number | null): B4LiquidityBucket | "UNKNOWN" {
  if (percentile === null || !Number.isFinite(percentile)) return "UNKNOWN";
  if (percentile <= B4_LIQUIDITY_LOW_BOUNDARY) return "LOW";
  if (percentile <= B4_LIQUIDITY_HIGH_BOUNDARY) return "NORMAL";
  return "HIGH";
}

/**
 * R5.10A four-hour return from five contiguous complete 1h candles.
 *
 * Passing a pair of 4h candles is intentionally rejected: timeframe is not
 * carried by Candle, so the one-hour spacing is the explicit contract.
 */
export function calculateB4FourHourReturn(candles: readonly B4ContextCandle[]): number | null {
  const closed = candles
    .filter((candle) => Number.isFinite(candle.openTime)
      && Number.isFinite(candle.closeTime)
      && candle.closeTime < candle.openTime + B4_CONTEXT_INTERVAL_MS
      && Number.isFinite(candle.close)
      && candle.close > 0)
    .sort((left, right) => left.openTime - right.openTime)
    .slice(-5);
  if (closed.length !== 5 || !isContiguous(closed)) return null;
  return closed[4].close / closed[0].close - 1;
}

/** R5.10A same-timestamp cross-sectional market regime. */
export function classifyB4MarketRegime(fourHourReturns: readonly number[]): B4MarketRegime {
  if (fourHourReturns.length === 0 || fourHourReturns.some((value) => !Number.isFinite(value))) return "UNKNOWN";
  const sorted = [...fourHourReturns].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  if (median > B4_REGIME_UP_BOUNDARY) return "UP";
  if (median < B4_REGIME_DOWN_BOUNDARY) return "DOWN";
  return "RANGE";
}

export function isNormalB4Context(value: string): boolean {
  return value !== "UNKNOWN" && value.trim().length > 0;
}

function isContiguous(candles: readonly B4ContextCandle[], intervalMs: number = B4_CONTEXT_INTERVAL_MS): boolean {
  return candles.every((candle, index) => index === 0 || candle.openTime === candles[index - 1].openTime + intervalMs);
}
