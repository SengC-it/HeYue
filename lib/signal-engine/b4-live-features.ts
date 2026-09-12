import {
  B4_SHADOW_INTERVAL_MS,
  B4_SHADOW_VERSION,
  type B4ShadowContextState,
  type B4ShadowObservation,
} from "./b4-shadow-types";
import { classifyB4BasisBucket, classifyB4FundingBucket } from "./b4-context";

/** R5.7 frozen rolling history size for each B4 primitive. */
export const B4_LIVE_ROLLING_LOOKBACK = 720 as const;
/** One extra raw bar is needed for the first historical difference. */
export const B4_LIVE_RAW_BAR_REQUIREMENT = B4_LIVE_ROLLING_LOOKBACK + 2;

export interface B4LiveBar {
  openTime: number;
  closeTime: number;
  close: number;
  high: number;
  low: number;
  quoteVolume?: number;
}

export interface B4LivePrimitive {
  openTime: number;
  priceChange: number;
  premiumChange: number;
}

export interface B4LiveFundingPoint {
  fundingTime: number;
  fundingRate: number;
  pitAvailableAt?: number;
}

export interface B4LiveHistory {
  symbol: string;
  priceBars: readonly B4LiveBar[];
  premiumBars: readonly B4LiveBar[];
  markBars: readonly B4LiveBar[];
  indexBars: readonly B4LiveBar[];
  fundingRates: readonly B4LiveFundingPoint[];
  /** Durable tail from the previous closed-bar evaluation, when available. */
  storedPrimitiveHistory?: readonly B4LivePrimitive[];
}

export interface B4LiveContext {
  marketRegime: string;
  volatilityBucket: string;
  liquidityBucket: string;
  fundingBucket?: string;
  markIndexBasisBucket?: string;
  volatilityValue?: number | null;
  liquidityPercentile?: number | null;
}

export type B4LiveFeatureStatus = "READY" | "WARMING_UP" | "DATA_INCOMPLETE" | "PIT_REJECTED";

export interface B4LiveFeatureResult {
  status: B4LiveFeatureStatus;
  observation: B4ShadowObservation;
  alignedBarCount: number;
  historicalPrimitiveCount: number;
  nextPrimitiveHistory: readonly B4LivePrimitive[];
  historyMode: "BOOTSTRAP" | "INCREMENTAL" | "UNCHANGED" | "GAP";
}

/**
 * Build the frozen B4 observation from public, closed 1h histories.
 *
 * Percentiles intentionally use only the 720 primitive observations strictly
 * before the current primitive. Missing or non-contiguous data never gets
 * filled, shortened, or interpolated.
 */
export function buildB4LiveObservation(
  input: B4LiveHistory,
  decisionTime = Date.now(),
  context: B4LiveContext = {
    marketRegime: "UNKNOWN",
    volatilityBucket: "UNKNOWN",
    liquidityBucket: "UNKNOWN",
  },
): B4LiveFeatureResult {
  const aligned = alignClosedBars(input, decisionTime);
  const rawPrimitives = aligned.flatMap((bar, index) => {
    if (index === 0) return [];
    const previous = aligned[index - 1];
    const priceChange = bar.price.close / previous.price.close - 1;
    const premiumChange = bar.premium.close - previous.premium.close;
    return Number.isFinite(priceChange) && Number.isFinite(premiumChange)
      ? [{ openTime: bar.price.openTime, priceChange, premiumChange }]
      : [];
  });
  const current = aligned.at(-1);
  const previous = aligned.at(-2);
  const currentPrimitive = rawPrimitives.at(-1);
  const stored = (input.storedPrimitiveHistory ?? [])
    .filter((item) => Number.isFinite(item.openTime)
      && Number.isFinite(item.priceChange)
      && Number.isFinite(item.premiumChange))
    .sort((left, right) => left.openTime - right.openTime);
  const storedLast = stored.at(-1);
  let historyMode: B4LiveFeatureResult["historyMode"] = "BOOTSTRAP";
  let history = rawPrimitives.slice(-B4_LIVE_ROLLING_LOOKBACK - 1, -1);
  let nextPrimitiveHistory = rawPrimitives.slice(-B4_LIVE_ROLLING_LOOKBACK - 1);
  if (storedLast && currentPrimitive) {
    if (currentPrimitive.openTime === storedLast.openTime) {
      historyMode = "UNCHANGED";
      history = stored.slice(-B4_LIVE_ROLLING_LOOKBACK - 1, -1);
      nextPrimitiveHistory = stored.slice(-B4_LIVE_ROLLING_LOOKBACK - 1);
    } else if (currentPrimitive.openTime === storedLast.openTime + B4_SHADOW_INTERVAL_MS
      && previous?.price.openTime === storedLast.openTime) {
      historyMode = "INCREMENTAL";
      history = stored.slice(-B4_LIVE_ROLLING_LOOKBACK);
      nextPrimitiveHistory = [...stored, currentPrimitive].slice(-B4_LIVE_ROLLING_LOOKBACK - 1);
    } else {
      historyMode = "GAP";
      history = [];
      nextPrimitiveHistory = stored.slice(-B4_LIVE_ROLLING_LOOKBACK - 1);
    }
  }
  const marketTimestamp = current ? new Date(current.price.openTime).toISOString() : new Date(0).toISOString();
  const pitAvailableAt = current
    ? new Date(current.price.openTime + B4_SHADOW_INTERVAL_MS).toISOString()
    : new Date(0).toISOString();
  const decisionTimestamp = new Date(decisionTime).toISOString();
  const funding = latestFundingAt(input.fundingRates, decisionTime);
  const markPrice = current?.mark.close ?? null;
  const indexPrice = current?.index.close ?? null;
  const latestRawOpenTime = Math.max(
    ...[input.priceBars, input.premiumBars, input.markBars, input.indexBars]
      .flatMap((bars) => bars.map((bar) => bar.openTime)),
    0,
  );
  // Binance may include the currently open bar even when the requested window
  // is bounded to the last closed boundary. It is intentionally ignored when
  // the required closed bootstrap window is present. A short/incomplete window
  // remains PIT-rejected so a premature response cannot be treated as ready.
  const hasUnclosedRawBar = aligned.length < B4_LIVE_RAW_BAR_REQUIREMENT
    && latestRawOpenTime + B4_SHADOW_INTERVAL_MS > decisionTime;
  const basis = markPrice !== null && indexPrice !== null && indexPrice > 0
    ? markPrice / indexPrice - 1
    : null;
  const complete = current !== undefined
    && previous !== undefined
    && current.mark !== undefined
    && current.index !== undefined
    && history.length === B4_LIVE_ROLLING_LOOKBACK
    && currentPrimitive !== undefined
    && funding !== null
    && Number.isFinite(current.price.close)
    && Number.isFinite(current.premium.close)
    && [current.mark.close, current.index.close].every((value) => Number.isFinite(value) && value > 0);
  const pitSafe = !hasUnclosedRawBar
    && current !== undefined
    && current.price.openTime + B4_SHADOW_INTERVAL_MS <= decisionTime
    && current.price.closeTime < current.price.openTime + B4_SHADOW_INTERVAL_MS
    && Number.isFinite(Date.parse(marketTimestamp))
    && Number.isFinite(Date.parse(pitAvailableAt));
  const calendar = current ? new Date(current.price.openTime) : new Date(0);
  const calendarPeriod = current
    ? `${calendar.getUTCFullYear()}-Q${Math.floor(calendar.getUTCMonth() / 3) + 1}`
    : "UNKNOWN";
  const observation: B4ShadowObservation = {
    symbol: input.symbol,
    market_timestamp: marketTimestamp,
    decision_timestamp: decisionTimestamp,
    pit_available_at: pitAvailableAt,
    perpetual_price: current?.price.close ?? 0,
    premium_value: current?.premium.close ?? null,
    price_change_value: currentPrimitive?.priceChange ?? null,
    premium_change_value: currentPrimitive?.premiumChange ?? null,
    price_percentile: currentPrimitive && history.length === B4_LIVE_ROLLING_LOOKBACK
      ? empiricalPercentile(currentPrimitive.priceChange, history.map((item) => item.priceChange))
      : null,
    premium_change_percentile: currentPrimitive && history.length === B4_LIVE_ROLLING_LOOKBACK
      ? empiricalPercentile(currentPrimitive.premiumChange, history.map((item) => item.premiumChange))
      : null,
    funding_state: funding === null ? null : {
      bucket: context.fundingBucket ?? classifyB4FundingBucket(funding.fundingRate),
      funding_rate: funding.fundingRate,
      funding_time: funding.fundingTime,
      pit_available_at: funding.pitAvailableAt ?? funding.fundingTime,
    },
    mark_index_basis_state: markPrice === null || indexPrice === null
      ? null
      : {
        bucket: context.markIndexBasisBucket
          ?? (basis === null ? "UNKNOWN" : classifyB4BasisBucket(basis)),
        mark_price: markPrice,
        index_price: indexPrice,
        basis_bps: basis === null ? null : basis * 10_000,
      },
    mark_price: markPrice,
    index_price: indexPrice,
    market_regime: context.marketRegime,
    volatility_bucket: context.volatilityBucket,
    liquidity_bucket: context.liquidityBucket,
    calendar_period: calendarPeriod,
    volatility_value: context.volatilityValue ?? null,
    liquidity_percentile: context.liquidityPercentile ?? null,
    observation_closed: pitSafe,
    market_data_complete: complete,
    rolling_history_ready: history.length === B4_LIVE_ROLLING_LOOKBACK,
    pit_safe: pitSafe,
  };
  return {
    status: !pitSafe ? "PIT_REJECTED" : history.length < B4_LIVE_ROLLING_LOOKBACK ? "WARMING_UP" : !complete ? "DATA_INCOMPLETE" : "READY",
    observation,
    alignedBarCount: aligned.length,
    historicalPrimitiveCount: history.length,
    nextPrimitiveHistory,
    historyMode,
  };
}

export function empiricalPercentile(value: number, priorValues: readonly number[]): number | null {
  if (!Number.isFinite(value) || priorValues.length === 0 || priorValues.some((item) => !Number.isFinite(item))) return null;
  return priorValues.filter((item) => item <= value).length / priorValues.length;
}

function alignClosedBars(input: B4LiveHistory, decisionTime: number): Array<{
  price: B4LiveBar;
  premium: B4LiveBar;
  mark: B4LiveBar;
  index: B4LiveBar;
}> {
  const priceByTime = usableBars(input.priceBars, decisionTime, true);
  const premiumByTime = usableBars(input.premiumBars, decisionTime, false);
  const markByTime = usableBars(input.markBars, decisionTime, true);
  const indexByTime = usableBars(input.indexBars, decisionTime, true);
  const timestamps = [...priceByTime.keys()]
    .filter((timestamp) => premiumByTime.has(timestamp) && markByTime.has(timestamp) && indexByTime.has(timestamp))
    .sort((left, right) => left - right);
  const contiguous: Array<{
    price: B4LiveBar;
    premium: B4LiveBar;
    mark: B4LiveBar;
    index: B4LiveBar;
  }> = [];
  for (const timestamp of timestamps) {
    const last = contiguous.at(-1);
    if (last && timestamp !== last.price.openTime + B4_SHADOW_INTERVAL_MS) break;
    const price = priceByTime.get(timestamp);
    const premium = premiumByTime.get(timestamp);
    const mark = markByTime.get(timestamp);
    const index = indexByTime.get(timestamp);
    if (!price || !premium || !mark || !index) break;
    contiguous.push({ price, premium, mark, index });
  }
  return contiguous.slice(-B4_LIVE_RAW_BAR_REQUIREMENT);
}

function usableBars(
  bars: readonly B4LiveBar[],
  decisionTime: number,
  requirePositive: boolean,
): Map<number, B4LiveBar> {
  return new Map(
    bars
      .filter((bar) => Number.isFinite(bar.openTime)
        && Number.isFinite(bar.closeTime)
        && bar.closeTime < bar.openTime + B4_SHADOW_INTERVAL_MS
        && bar.openTime + B4_SHADOW_INTERVAL_MS <= decisionTime
        && Number.isFinite(bar.close)
        && Number.isFinite(bar.high)
        && Number.isFinite(bar.low)
        && (!requirePositive || (bar.close > 0 && bar.high > 0 && bar.low > 0)))
      .sort((left, right) => left.openTime - right.openTime)
      .map((bar) => [bar.openTime, bar] as const),
  );
}

function latestFundingAt(
  points: readonly B4LiveFundingPoint[],
  decisionTime: number,
): B4LiveFundingPoint | null {
  return points
    .filter((point) => point.fundingTime <= decisionTime
      && (point.pitAvailableAt ?? point.fundingTime) <= decisionTime
      && Number.isFinite(point.fundingRate))
    .sort((left, right) => right.fundingTime - left.fundingTime)[0] ?? null;
}

export function b4LiveFundingContext(
  funding: B4LiveFundingPoint | null,
): B4ShadowContextState | null {
  return funding === null ? null : {
    bucket: classifyB4FundingBucket(funding.fundingRate),
    funding_rate: funding.fundingRate,
    funding_time: funding.fundingTime,
    pit_available_at: funding.pitAvailableAt ?? funding.fundingTime,
  };
}

export const B4_LIVE_CONTRACT = {
  version: B4_SHADOW_VERSION,
  interval: "1h",
  rawBarRequirement: B4_LIVE_RAW_BAR_REQUIREMENT,
  rollingLookback: B4_LIVE_ROLLING_LOOKBACK,
  priceChange: "perpetual close[t] / close[t-1] - 1",
  premiumChange: "premium-index close[t] - close[t-1]",
  percentile: "count(prior completed values <= current) / 720",
  eventAvailability: "open_time + 1h",
} as const;
