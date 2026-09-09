import type { Candle } from "../core/types";
import type {
  LiquidityFeature,
  LiquidityFeatureInput,
  LiquidityHistoryPoint,
  LiquidityVolumeSource,
  QuoteVolumeObservation,
} from "./types";

const DEFAULT_PERCENTILE_WINDOW = 42;
const DEFAULT_MINIMUM_HISTORY = 42;
const BARS_PER_DAY = 24;

export function calculate24hQuoteVolume(
  candles: Candle[],
  asOf: number,
  bars = BARS_PER_DAY,
): QuoteVolumeObservation {
  const eligible = candles
    .filter((candle) => isUsableCandle(candle) && candle.closeTime <= asOf)
    .sort((left, right) => left.closeTime - right.closeTime)
    .slice(-bars);
  if (eligible.length === 0) {
    return {
      quote_volume_24h: null,
      sample_count_24h: 0,
      volume_source: "BLOCKED",
      source_timestamp: null,
      pit_safe: true,
    };
  }

  let quoteVolumeBars = 0;
  let fallbackBars = 0;
  const quoteVolume = eligible.reduce((total, candle) => {
    if (Number.isFinite(candle.quoteVolume) && candle.quoteVolume! >= 0) {
      quoteVolumeBars += 1;
      return total + candle.quoteVolume!;
    }
    fallbackBars += 1;
    return total + candle.close * candle.volume;
  }, 0);
  const volume_source: LiquidityVolumeSource = quoteVolumeBars > 0 && fallbackBars > 0
    ? "MIXED"
    : quoteVolumeBars > 0 ? "QUOTE_VOLUME" : "CLOSE_TIMES_VOLUME";
  return {
    quote_volume_24h: Number.isFinite(quoteVolume) ? quoteVolume : null,
    sample_count_24h: eligible.length,
    volume_source,
    source_timestamp: eligible.at(-1)?.closeTime ?? null,
    pit_safe: true,
  };
}

export function calculateLiquidityFeature(input: LiquidityFeatureInput): LiquidityFeature {
  const percentileWindow = input.percentile_window ?? DEFAULT_PERCENTILE_WINDOW;
  const minimumHistory = Math.min(
    input.minimum_history_samples ?? DEFAULT_MINIMUM_HISTORY,
    percentileWindow,
  );
  const history = input.history.filter(isUsableHistoryPoint);
  const eligibleHistory = history.filter((point) => point.timestamp <= input.as_of);
  const futureHistoryPoints = history.length - eligibleHistory.length;
  const historicalValues = eligibleHistory
    .slice(-percentileWindow)
    .map((point) => point.quote_volume_24h);
  const quoteVolume = finiteNonNegative(input.quote_volume_24h) ? input.quote_volume_24h : null;
  const enoughSamples = input.sample_count_24h >= BARS_PER_DAY;
  const enoughHistory = historicalValues.length >= minimumHistory;
  const usable = quoteVolume !== null && enoughSamples && enoughHistory;
  const volumePercentile = usable
    ? percentileRank(historicalValues, quoteVolume)
    : null;
  const coverageScore = Math.min(100, input.sample_count_24h / BARS_PER_DAY * 100);
  const liquidityScore = volumePercentile === null
    ? null
    : round(clamp(volumePercentile * 0.8 + coverageScore * 0.2));
  return {
    symbol: input.symbol,
    timestamp: new Date(input.as_of).toISOString(),
    quote_volume_24h: quoteVolume,
    volume_percentile: volumePercentile === null ? null : round(volumePercentile),
    liquidity_score: liquidityScore,
    status: liquidityStatus(liquidityScore),
    sample_count_24h: input.sample_count_24h,
    history_sample_count: historicalValues.length,
    volume_source: quoteVolume === null ? "BLOCKED" : input.volume_source,
    future_history_points_ignored: futureHistoryPoints,
    source_timestamp: new Date(input.source_timestamp ?? input.as_of).toISOString(),
    pit_safe: true,
  };
}

function percentileRank(values: number[], current: number): number {
  const observations = [...values, current];
  return observations.filter((value) => value <= current).length / observations.length * 100;
}

function liquidityStatus(score: number | null): LiquidityFeature["status"] {
  if (score === null) return "BLOCKED";
  if (score >= 75) return "STRONG";
  if (score >= 40) return "NORMAL";
  return "WEAK";
}

function isUsableCandle(candle: Candle): boolean {
  return [
    candle.closeTime,
    candle.close,
    candle.volume,
  ].every(Number.isFinite) && candle.close > 0 && candle.volume >= 0;
}

function isUsableHistoryPoint(point: LiquidityHistoryPoint): boolean {
  return Number.isFinite(point.timestamp)
    && Number.isFinite(point.quote_volume_24h)
    && point.quote_volume_24h >= 0;
}

function finiteNonNegative(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
