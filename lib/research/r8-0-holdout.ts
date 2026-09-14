import { quoteVolumeForCandle } from "@/lib/backtest/volume";
import type { Candle } from "@/lib/core/types";

export const R80_REPORT_VERSION = "hy-r8.0-v1";
export const R80_PROTOCOL_COMMIT = "3e28d6179d6903c24b18b304c82f492997329bba";
export const R80_BASE_RESEARCH_HEAD = "f02dc98eb48701cf9eff43f9ff91c69fc1b9888c";
export const R80_CANDIDATE_A_ID = "HY-R7-FORWARD-CANDIDATE-A";
export const R80_STRATEGY_VERSION = "hy-paper-candidate-v2";
export const R80_STRATEGY_HASH = "3c3df714d4e5768a4393e523b331b70f239e5c07b963e5bdada7442d69a27918";
export const R80_INTERVAL_MS = 15 * 60 * 1000;
export const R80_HOLDOUT_START = Date.parse("2024-08-09T02:15:00.000Z");
export const R80_HOLDOUT_END = Date.parse("2025-08-09T02:14:59.999Z");
export const R80_R7_START = Date.parse("2025-08-09T02:15:00.000Z");
export const R80_R7_END = Date.parse("2026-08-09T02:14:59.999Z");
export const R80_FORWARD_START = Date.parse("2026-08-09T17:34:48.982760Z");
export const R80_BOOTSTRAP_ITERATIONS = 10_000;
export const R80_BOOTSTRAP_SEED = 8_052_024;
export const R80_MIN_TRADES = 75;

export const R80_SYMBOLS = Object.freeze([
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "LINKUSDT",
  "AVAXUSDT",
  "SUIUSDT",
  "1000SHIBUSDT",
  "1000PEPEUSDT",
  "AAVEUSDT",
  "TRXUSDT",
  "PAXGUSDT",
  "INJUSDT",
  "COTIUSDT",
  "LTCUSDT",
  "XLMUSDT",
  "XMRUSDT",
] as const);

export const R80_FROZEN_RULES = Object.freeze({
  entryMode: "TREND_PULLBACK",
  side: "SHORT",
  strategyFamily: "TREND",
  minScore: 80,
  cooldownHours: 24,
  rewardRisk: 2,
  maxHoldHours: 48,
  stopAtrMultiplier: 0.75,
  dynamicUniverseSize: 10,
  dynamicUniverseLookbackDays: 1,
  localRegimeAlignment: true,
  btc4hRegimeAlignment: true,
  globalReferenceSymbol: "BTCUSDT",
  globalReferenceTimeframe: "4h",
  baseTakerFeeRate: 0.0004,
  baseSlippageBps: 2,
  stressTakerFeeRate: 0.0006,
  stressSlippageBps: 4,
  maxExecutionCostRiskFraction: 0.1,
  funding: "PIT historical actual funding",
});

export const R80_EXPECTED_CANDIDATE_A = Object.freeze({
  trades: 29,
  baseNetPnlUsdt: 469.31166529,
  baseProfitFactor: 1.59999141,
  stressNetPnlUsdt: 400.66533784,
  stressProfitFactor: 1.48858398,
});

export type R80Classification =
  | "EXTENDED_INDEPENDENT_EDGE_PASS"
  | "EXTENDED_INDEPENDENT_EDGE_FAIL"
  | "INSUFFICIENT_HOLDOUT_SAMPLE"
  | "HOLDOUT_DATA_INVALID"
  | "BACKTEST_REPRODUCIBILITY_FAILURE"
  | "PROFITABILITY_RESEARCH_INVALID";

export interface R80MetricLike {
  trades: number;
  netPnlUsdt: number;
  expectancyUsdt: number;
  profitFactor: number;
  maxDrawdownPercent: number;
}

export interface R80Availability {
  symbol: string;
  firstAvailableAt: number | null;
  firstEligibleAt: number | null;
  expected15mBars: number;
  actual15mBars: number;
  coverage: number;
  coverageStatus: "FULL" | "PARTIAL" | "NONE";
  eligibleInHoldout: boolean;
}

export interface R80QuarterWindow {
  id: "Q1" | "Q2" | "Q3" | "Q4";
  start: number;
  endInclusive: number;
  endExclusive: number;
}

export interface R80GateResult {
  maturedTradesPass: boolean;
  netPnlPass: boolean;
  expectancyPass: boolean;
  profitFactorPass: boolean;
  stressNetPass: boolean;
  stressProfitFactorPass: boolean;
  maxDrawdownPass: boolean;
  positiveQuartersPass: boolean;
  symbolBreadthPass: boolean;
  bootstrapExpectancyPass: boolean;
  pass: boolean;
}

export interface R80BootstrapDistribution {
  sampleCount: number;
  iterations: number;
  seed: number;
  p025: number | null;
  median: number | null;
  p975: number | null;
}

export interface R80BootstrapSummary {
  expectancyUsdt: R80BootstrapDistribution;
  profitFactor: R80BootstrapDistribution;
  probabilityExpectancyPositive: number;
  probabilityProfitFactorGreaterThanOne: number;
  probabilityProfitFactorAtLeastOnePointTwo: number;
}

export function assertR80CandidateAFrozen(input: Record<string, unknown>): void {
  const expected: Record<string, unknown> = {
    ...R80_FROZEN_RULES,
    strategyVersion: R80_STRATEGY_VERSION,
    strategyHash: R80_STRATEGY_HASH,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (input[key] !== value) throw new Error(`Candidate A frozen field changed: ${key}`);
  }
}

export function assertR80WindowIndependent(
  holdoutStart = R80_HOLDOUT_START,
  holdoutEnd = R80_HOLDOUT_END,
  r7Start = R80_R7_START,
): void {
  if (!Number.isFinite(holdoutStart) || !Number.isFinite(holdoutEnd) || holdoutStart > holdoutEnd) {
    throw new Error("R8.0 holdout window is invalid");
  }
  if (holdoutEnd >= r7Start) throw new Error("R8.0 holdout overlaps the R7 research window");
}

export function buildR80Availability(
  symbol: string,
  candles: readonly Candle[],
  start = R80_HOLDOUT_START,
  end = R80_HOLDOUT_END,
  warmupBars = 80,
): R80Availability {
  const expected15mBars = Math.floor((end - start) / R80_INTERVAL_MS) + 1;
  const actual15mBars = candles.filter((candle) => candle.openTime >= start && candle.openTime <= end).length;
  const firstAvailableAt = candles[0]?.openTime ?? null;
  const firstEligibleAt = candles.length > warmupBars ? candles[warmupBars].closeTime : null;
  return {
    symbol,
    firstAvailableAt,
    firstEligibleAt,
    expected15mBars,
    actual15mBars,
    coverage: expected15mBars === 0 ? 0 : round(actual15mBars / expected15mBars),
    coverageStatus: actual15mBars === expected15mBars ? "FULL" : actual15mBars > 0 ? "PARTIAL" : "NONE",
    eligibleInHoldout: firstEligibleAt !== null && firstEligibleAt <= end,
  };
}

export function rollingQuoteVolumePIT(
  candles: readonly Candle[],
  timestamp: number,
  lookbackDays: number,
): number {
  const lookbackMs = Math.max(1, lookbackDays) * 24 * 60 * 60 * 1000;
  const endIndex = lastIndexAtOrBefore(candles, timestamp);
  if (endIndex < 0) return 0;
  const startIndex = lowerBound(candles, timestamp - lookbackMs);
  let total = 0;
  for (let index = startIndex; index <= endIndex; index += 1) total += quoteVolumeForCandle(candles[index]);
  return Math.max(0, total);
}

export function buildR80PitDynamicUniverse(
  datasets: ReadonlyArray<{ symbol: string; candles: { "15m": Candle[] } }>,
  entryTimes: readonly number[],
  firstEligibleAt: ReadonlyMap<string, number | null>,
  requestedSize = 10,
  lookbackDays = 1,
): Map<number, Set<string>> {
  const universeSize = Math.max(1, Math.floor(requestedSize));
  const orderedTimes = [...new Set(entryTimes)].sort((left, right) => left - right);
  const result = new Map<number, Set<string>>();
  for (const timestamp of orderedTimes) {
    const ranked = datasets
      .filter((dataset) => {
        const eligibleAt = firstEligibleAt.get(dataset.symbol);
        return eligibleAt !== null && eligibleAt !== undefined && eligibleAt <= timestamp;
      })
      .map((dataset) => ({
        symbol: dataset.symbol,
        quoteVolume: rollingQuoteVolumePIT(dataset.candles["15m"], timestamp, lookbackDays),
      }))
      .sort((left, right) => right.quoteVolume - left.quoteVolume || left.symbol.localeCompare(right.symbol));
    result.set(timestamp, new Set(ranked.slice(0, universeSize).map((item) => item.symbol)));
  }
  return result;
}

export function buildR80QuarterWindows(
  start = R80_HOLDOUT_START,
  end = R80_HOLDOUT_END,
): R80QuarterWindow[] {
  if (start !== R80_HOLDOUT_START || end !== R80_HOLDOUT_END) {
    throw new Error("R8.0 quarter boundaries are frozen to the protocol holdout window");
  }
  const endExclusives = [
    Date.parse("2024-11-07T14:15:00.000Z"),
    Date.parse("2025-02-06T02:15:00.000Z"),
    Date.parse("2025-05-07T14:15:00.000Z"),
    end + 1,
  ] as const;
  const ids = ["Q1", "Q2", "Q3", "Q4"] as const;
  return ids.map((id, index) => {
    const quarterStart = index === 0 ? start : endExclusives[index - 1];
    const endExclusive = endExclusives[index];
    return { id, start: quarterStart, endInclusive: endExclusive - 1, endExclusive };
  });
}

export function assertR80QuarterBoundaries(windows: readonly R80QuarterWindow[]): void {
  const expected = buildR80QuarterWindows();
  if (windows.length !== expected.length) throw new Error("R8.0 quarter count changed");
  windows.forEach((window, index) => {
    const authority = expected[index];
    if (
      window.id !== authority.id
      || window.start !== authority.start
      || window.endInclusive !== authority.endInclusive
      || window.endExclusive !== authority.endExclusive
    ) {
      throw new Error(`R8.0 ${authority.id} boundary changed`);
    }
  });
}

export function isR80NextBarExecution(sourceCloseTime: number, entryOpenTime: number): boolean {
  return Number.isFinite(sourceCloseTime)
    && Number.isFinite(entryOpenTime)
    && entryOpenTime === sourceCloseTime + 1;
}

export function passesR80EdgeGate(
  base: R80MetricLike,
  stress: R80MetricLike,
  positiveQuarters: number,
  distinctSymbols: number,
  bootstrapProbabilityExpectancyPositive: number,
): R80GateResult {
  const result: R80GateResult = {
    maturedTradesPass: base.trades >= R80_MIN_TRADES,
    netPnlPass: base.netPnlUsdt > 0,
    expectancyPass: base.expectancyUsdt > 0,
    profitFactorPass: base.profitFactor >= 1.2,
    stressNetPass: stress.netPnlUsdt > 0,
    stressProfitFactorPass: stress.profitFactor >= 1.1,
    maxDrawdownPass: base.maxDrawdownPercent <= 0.1,
    positiveQuartersPass: positiveQuarters >= 3,
    symbolBreadthPass: distinctSymbols >= 6,
    bootstrapExpectancyPass: bootstrapProbabilityExpectancyPositive >= 0.95,
    pass: false,
  };
  result.pass = Object.entries(result)
    .filter(([key]) => key !== "pass")
    .every(([, value]) => value === true);
  return result;
}

export class R80OneShotGuard {
  private started = false;

  get runCount(): number {
    return this.started ? 1 : 0;
  }

  run<T>(operation: () => T): T {
    if (this.started) throw new Error("R8.0 holdout is one-shot and has already started");
    this.started = true;
    return operation();
  }
}

export function bootstrapR80(
  pnlValues: readonly number[],
  iterations = R80_BOOTSTRAP_ITERATIONS,
  seed = R80_BOOTSTRAP_SEED,
): R80BootstrapSummary {
  if (!Number.isInteger(iterations) || iterations < 10_000) throw new Error("R8.0 bootstrap requires at least 10,000 iterations");
  if (pnlValues.some((value) => !Number.isFinite(value))) throw new Error("R8.0 bootstrap input contains a non-finite PnL");
  if (pnlValues.length === 0) {
    const empty = emptyDistribution(iterations, seed);
    return {
      expectancyUsdt: empty,
      profitFactor: empty,
      probabilityExpectancyPositive: 0,
      probabilityProfitFactorGreaterThanOne: 0,
      probabilityProfitFactorAtLeastOnePointTwo: 0,
    };
  }

  const means: number[] = [];
  const profitFactors: number[] = [];
  let positiveExpectancy = 0;
  let profitFactorGreaterThanOne = 0;
  let profitFactorAtLeastOnePointTwo = 0;
  let state = seed >>> 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    let profit = 0;
    let loss = 0;
    for (let draw = 0; draw < pnlValues.length; draw += 1) {
      state = nextRandom(state);
      const value = pnlValues[Math.floor((state / 0x1_0000_0000) * pnlValues.length)];
      sum += value;
      if (value > 0) profit += value;
      if (value < 0) loss -= value;
    }
    const mean = sum / pnlValues.length;
    const profitFactor = loss === 0 ? (profit > 0 ? 999 : 0) : profit / loss;
    means.push(mean);
    profitFactors.push(profitFactor);
    if (mean > 0) positiveExpectancy += 1;
    if (profitFactor > 1) profitFactorGreaterThanOne += 1;
    if (profitFactor >= 1.2) profitFactorAtLeastOnePointTwo += 1;
  }
  return {
    expectancyUsdt: distribution(means, pnlValues.length, iterations, seed),
    profitFactor: distribution(profitFactors, pnlValues.length, iterations, seed),
    probabilityExpectancyPositive: round(positiveExpectancy / iterations),
    probabilityProfitFactorGreaterThanOne: round(profitFactorGreaterThanOne / iterations),
    probabilityProfitFactorAtLeastOnePointTwo: round(profitFactorAtLeastOnePointTwo / iterations),
  };
}

export function classifyR80(input: {
  candidateAReproduced: boolean;
  holdoutDataValid: boolean;
  holdoutTrades: number;
  edgeGatePass: boolean;
}): R80Classification {
  if (!input.candidateAReproduced) return "BACKTEST_REPRODUCIBILITY_FAILURE";
  if (!input.holdoutDataValid) return "HOLDOUT_DATA_INVALID";
  if (input.holdoutTrades < R80_MIN_TRADES) return "INSUFFICIENT_HOLDOUT_SAMPLE";
  if (input.edgeGatePass) return "EXTENDED_INDEPENDENT_EDGE_PASS";
  return "EXTENDED_INDEPENDENT_EDGE_FAIL";
}

export function assertNoPostResultMutation(input: {
  parametersChanged: boolean;
  thresholdsChanged: boolean;
  resultUsedForTuning: boolean;
}): void {
  if (input.parametersChanged || input.thresholdsChanged || input.resultUsedForTuning) {
    throw new Error("R8.0 forbids post-result parameter or threshold mutation");
  }
}

export function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function nextRandom(state: number): number {
  return (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
}

function distribution(
  values: readonly number[],
  sampleCount: number,
  iterations: number,
  seed: number,
): R80BootstrapDistribution {
  return {
    sampleCount,
    iterations,
    seed,
    p025: round(quantile(values, 0.025)),
    median: round(quantile(values, 0.5)),
    p975: round(quantile(values, 0.975)),
  };
}

function emptyDistribution(iterations: number, seed: number): R80BootstrapDistribution {
  return { sampleCount: 0, iterations, seed, p025: null, median: null, p975: null };
}

function quantile(values: readonly number[], probability: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function lowerBound(candles: readonly Candle[], openTime: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].openTime < openTime) low = middle + 1;
    else high = middle;
  }
  return low;
}

function lastIndexAtOrBefore(candles: readonly Candle[], closeTime: number): number {
  let low = 0;
  let high = candles.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].closeTime <= closeTime) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}
