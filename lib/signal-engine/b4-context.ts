import type { Candle, MarketRegime } from "@/lib/core/types";

export type B4FundingBucket = "NEGATIVE" | "NEUTRAL" | "POSITIVE";
export type B4BasisBucket = "DISCOUNT" | "NEUTRAL" | "PREMIUM";
export type B4VolatilityBucket = "LOW" | "NORMAL" | "HIGH";
export type B4LiquidityBucket = "ILLIQUID" | "LIQUID" | "DEEP";

const FUNDING_NEUTRAL_THRESHOLD = 0.0001;
const BASIS_NEUTRAL_THRESHOLD_BPS = 2;

/** Deterministic event-time funding context; this is not a signal cutoff. */
export function classifyB4FundingBucket(fundingRate: number): B4FundingBucket {
  if (!Number.isFinite(fundingRate)) throw new Error("funding rate must be finite");
  if (fundingRate > FUNDING_NEUTRAL_THRESHOLD) return "POSITIVE";
  if (fundingRate < -FUNDING_NEUTRAL_THRESHOLD) return "NEGATIVE";
  return "NEUTRAL";
}

/** Deterministic mark/index basis context; this is not a signal cutoff. */
export function classifyB4BasisBucket(basisBps: number): B4BasisBucket {
  if (!Number.isFinite(basisBps)) throw new Error("basis must be finite");
  if (basisBps > BASIS_NEUTRAL_THRESHOLD_BPS) return "PREMIUM";
  if (basisBps < -BASIS_NEUTRAL_THRESHOLD_BPS) return "DISCOUNT";
  return "NEUTRAL";
}

/** Bucket recent closed 1h returns without using any future candle. */
export function classifyB4Volatility(candles: readonly Candle[]): B4VolatilityBucket {
  const closed = candles
    .filter((candle) => Number.isFinite(candle.close) && candle.close > 0)
    .sort((left, right) => left.openTime - right.openTime);
  const returns: number[] = [];
  for (let index = 1; index < closed.length; index += 1) {
    const value = closed[index].close / closed[index - 1].close - 1;
    if (Number.isFinite(value)) returns.push(Math.abs(value));
  }
  const recent = returns.slice(-24);
  if (recent.length === 0) return "NORMAL";
  const averageAbsoluteReturn = recent.reduce((total, value) => total + value, 0) / recent.length;
  if (averageAbsoluteReturn >= 0.02) return "HIGH";
  if (averageAbsoluteReturn <= 0.005) return "LOW";
  return "NORMAL";
}

/** 24h quote-volume context supplied by the public exchange ticker. */
export function classifyB4Liquidity(quoteVolume24h: number | undefined): B4LiquidityBucket {
  if (!Number.isFinite(quoteVolume24h) || (quoteVolume24h ?? 0) <= 0) return "ILLIQUID";
  if ((quoteVolume24h ?? 0) >= 100_000_000) return "DEEP";
  if ((quoteVolume24h ?? 0) >= 10_000_000) return "LIQUID";
  return "ILLIQUID";
}

export function isNormalB4Context(value: string): boolean {
  return value !== "UNKNOWN" && value.trim().length > 0;
}

export type B4MarketRegime = MarketRegime | string;
