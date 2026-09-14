export const R74_INTERVAL_MS = 15 * 60 * 1000;

export type R74Classification =
  | "BACKTEST_REPRODUCIBILITY_FAILURE"
  | "IMPLEMENTATION_PARITY_FAILURE"
  | "MARKET_REGIME_DRIFT_CONFIRMED"
  | "INSUFFICIENT_FORWARD_REPLAY_EVIDENCE";

export interface ParityMetric {
  compared: number;
  exact: number;
  mismatch: number;
  matchPercent: number;
}

export function compareParity<T>(
  expected: readonly T[],
  actual: readonly T[],
  equals: (left: T, right: T) => boolean,
): ParityMetric {
  const compared = Math.max(expected.length, actual.length);
  const exact = expected.length === actual.length && expected.every((value, index) => equals(value, actual[index]));
  return {
    compared,
    exact: exact ? 1 : 0,
    mismatch: exact ? 0 : 1,
    matchPercent: exact ? 100 : 0,
  };
}

export function compareStringArrays(expected: readonly string[], actual: readonly string[], ordered = true): boolean {
  if (ordered) {
    return expected.length === actual.length && expected.every((value, index) => value === actual[index]);
  }
  const left = [...expected].sort();
  const right = [...actual].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function metricFromBooleans(values: readonly boolean[]): ParityMetric {
  const exact = values.filter(Boolean).length;
  const mismatch = values.length - exact;
  return {
    compared: values.length,
    exact,
    mismatch,
    matchPercent: values.length === 0 ? 0 : round(exact / values.length * 100, 6),
  };
}

export function scanSourceTimestamp(scanStartedAt: string): number {
  const timestamp = Date.parse(scanStartedAt);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid scan timestamp: ${scanStartedAt}`);
  return Math.floor(timestamp / R74_INTERVAL_MS) * R74_INTERVAL_MS - 1;
}

export function latestClosed15mTimestamp(now: number): number {
  if (!Number.isFinite(now)) throw new Error("now must be finite");
  return Math.floor(now / R74_INTERVAL_MS) * R74_INTERVAL_MS - 1;
}

export function forwardObservationStart(strategyCreatedAt: string, firstCompletedScanAt: string): string {
  const strategyTime = Date.parse(strategyCreatedAt);
  const scanTime = Date.parse(firstCompletedScanAt);
  if (!Number.isFinite(strategyTime) || !Number.isFinite(scanTime)) {
    throw new Error("strategyCreatedAt and firstCompletedScanAt must be valid timestamps");
  }
  return new Date(Math.max(strategyTime, scanTime)).toISOString();
}

export function driftRatio(forwardRate: number, historicalRate: number): number | null {
  if (!Number.isFinite(forwardRate) || !Number.isFinite(historicalRate) || historicalRate === 0) return null;
  return round(forwardRate / historicalRate, 8);
}

export function assertPITNextBar(sourceTimestamp: number, entryOpenTime: number): void {
  // `sourceTimestamp` is the closeTime of the decision candle. Binance's
  // closeTime is the last millisecond of that candle, so the next bar opens
  // exactly one millisecond later.
  if (entryOpenTime !== sourceTimestamp + 1) {
    throw new Error(`PIT next-bar violation: source=${sourceTimestamp}, entry=${entryOpenTime}`);
  }
}

export function classifyR74(input: {
  authoritativeReproduced: boolean;
  evidenceComplete: boolean;
  diagnosticsParityPercent: number;
  hypeAnchorMatches: boolean;
  replayQualifiedSignals: number;
  productionQualifiedSignals: number;
  replayFinalSignals: number;
  productionFinalSignals: number;
  forwardOpportunityMateriallyLower: boolean;
  forwardRegimeMateriallyLower: boolean;
}): R74Classification {
  if (!input.authoritativeReproduced) return "BACKTEST_REPRODUCIBILITY_FAILURE";
  if (!input.evidenceComplete) return "INSUFFICIENT_FORWARD_REPLAY_EVIDENCE";

  const parityPass = input.diagnosticsParityPercent >= 99
    && input.hypeAnchorMatches
    && input.replayQualifiedSignals <= Math.max(5, input.productionQualifiedSignals + 2)
    && input.replayFinalSignals <= Math.max(5, input.productionFinalSignals + 2);
  if (!parityPass && (input.replayQualifiedSignals > input.productionQualifiedSignals + 2
    || input.replayFinalSignals > input.productionFinalSignals + 2)) {
    return "IMPLEMENTATION_PARITY_FAILURE";
  }
  if (parityPass && input.forwardOpportunityMateriallyLower && input.forwardRegimeMateriallyLower) {
    return "MARKET_REGIME_DRIFT_CONFIRMED";
  }
  return "INSUFFICIENT_FORWARD_REPLAY_EVIDENCE";
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
