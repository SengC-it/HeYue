export type OutcomeDirection = "BULLISH" | "BEARISH";

export interface DirectionalOutcomeCacheIdentity {
  symbol: string;
  timestamp: number;
  direction: OutcomeDirection;
  horizon: string;
}

/**
 * Outcome cache identity must retain direction.  The same symbol and event
 * time can be evaluated in both directions, and those outcomes are not
 * interchangeable.
 */
export function directionalOutcomeCacheKey(identity: DirectionalOutcomeCacheIdentity): string {
  return `${identity.symbol}|${String(identity.timestamp)}|${identity.direction}|${identity.horizon}`;
}

export interface OutcomeBar {
  close: number;
  high: number;
  low: number;
}

export interface DirectionalOutcome {
  futurePrice: number;
  directionalReturn: number;
  maxFavorableMove: number;
  maxAdverseMove: number;
}

export function calculateDirectionalOutcome(input: {
  observationTime: number;
  referencePrice: number;
  direction: OutcomeDirection;
  horizonHours: number;
  bars: Map<number, OutcomeBar>;
}): DirectionalOutcome | null {
  const { observationTime, referencePrice, direction, horizonHours, bars } = input;
  if (!Number.isFinite(observationTime) || !Number.isFinite(referencePrice) || referencePrice <= 0
    || !Number.isInteger(horizonHours) || horizonHours <= 0) return null;
  let futurePrice: number | null = null;
  let maxFavorableMove = Number.NEGATIVE_INFINITY;
  let maxAdverseMove = Number.POSITIVE_INFINITY;
  for (let step = 1; step <= horizonHours; step += 1) {
    const bar = bars.get(observationTime + step * 3_600_000);
    if (bar === undefined || !Number.isFinite(bar.close) || !Number.isFinite(bar.high) || !Number.isFinite(bar.low)
      || bar.close <= 0 || bar.high <= 0 || bar.low <= 0) return null;
    futurePrice = bar.close;
    if (direction === "BULLISH") {
      maxFavorableMove = Math.max(maxFavorableMove, bar.high / referencePrice - 1);
      maxAdverseMove = Math.min(maxAdverseMove, bar.low / referencePrice - 1);
    } else {
      maxFavorableMove = Math.max(maxFavorableMove, referencePrice / bar.low - 1);
      maxAdverseMove = Math.min(maxAdverseMove, referencePrice / bar.high - 1);
    }
  }
  if (futurePrice === null) return null;
  const directionalReturn = direction === "BULLISH"
    ? futurePrice / referencePrice - 1
    : referencePrice / futurePrice - 1;
  return { futurePrice, directionalReturn, maxFavorableMove, maxAdverseMove };
}
