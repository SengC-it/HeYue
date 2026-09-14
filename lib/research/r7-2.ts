export const R72_REPORT_VERSION = "hy-r7.2-v1";
export const R72_CANDIDATE_A_ID = "HY-R7-FORWARD-CANDIDATE-A";
export const R72_STRATEGY_VERSION = "hy-paper-candidate-v2";
export const R72_STRATEGY_HASH = "3c3df714d4e5768a4393e523b331b70f239e5c07b963e5bdada7442d69a27918";
export const R72_MAX_CHALLENGERS = 2;
export const R72_MIN_PRACTICAL_WEEKLY = 0.5;
export const R72_TARGET_WEEKLY = 2;
export const R72_TARGET_ANNUALIZED = 100;
export const R72_MAX_DD_TOLERANCE = 0.092414;

export const R72_CANDIDATE_A = Object.freeze({
  candidateId: R72_CANDIDATE_A_ID,
  strategyVersion: R72_STRATEGY_VERSION,
  strategyHash: R72_STRATEGY_HASH,
  entryMode: "TREND_PULLBACK",
  score: 80,
  cooldownHours: 24,
  rewardRisk: 2,
  maxHoldHours: 48,
  stopAtrMultiplier: 0.75,
  sideFilter: "SHORT",
  strategyFamily: "TREND",
  requireRegimeAlignment: true,
  globalReferenceSymbol: "BTCUSDT",
  globalReferenceTimeframe: "4h",
  globalRegimeAlignment: true,
  maxExecutionCostRiskFraction: 0.1,
});

export const R72_FUNNEL_STAGES = [
  "symbols considered",
  "liquidity/universe eligible",
  "TREND_PULLBACK condition met",
  "SHORT side eligible",
  "local regime aligned",
  "BTC 4h regime aligned",
  "score >=80",
  "cooldown eligible",
  "execution-cost eligible",
  "final signal emitted",
] as const;

export type R72FunnelStageName = typeof R72_FUNNEL_STAGES[number];

export interface FunnelStage {
  stage: R72FunnelStageName;
  input: number;
  passed: number;
  rejected: number;
  passRate: number;
  cumulativePassRate: number;
}

export interface StagePass {
  stage: R72FunnelStageName;
  passed: number;
}

export function buildFunnel(initialInput: number, stages: readonly StagePass[]): FunnelStage[] {
  if (!Number.isInteger(initialInput) || initialInput < 0) {
    throw new Error("Funnel initial input must be a non-negative integer");
  }
  if (stages.length !== R72_FUNNEL_STAGES.length) {
    throw new Error("Funnel must contain the complete R7.2 stage registry");
  }

  let input = initialInput;
  const result = stages.map((item, index) => {
    if (item.stage !== R72_FUNNEL_STAGES[index]) {
      throw new Error(`Unexpected funnel stage at index ${index}`);
    }
    if (!Number.isInteger(item.passed) || item.passed < 0 || item.passed > input) {
      throw new Error(`Invalid passed count for funnel stage ${item.stage}`);
    }
    const row: FunnelStage = {
      stage: item.stage,
      input,
      passed: item.passed,
      rejected: input - item.passed,
      passRate: round(input === 0 ? 0 : item.passed / input, 8),
      cumulativePassRate: round(initialInput === 0 ? 0 : item.passed / initialInput, 8),
    };
    input = item.passed;
    return row;
  });
  assertFunnelAccounting(result);
  return result;
}

export function assertFunnelAccounting(stages: readonly FunnelStage[]): void {
  if (stages.length !== R72_FUNNEL_STAGES.length) {
    throw new Error("Funnel accounting requires every registered stage");
  }
  let previousPassed: number | undefined;
  let initialInput: number | undefined;
  for (const [index, row] of stages.entries()) {
    if (row.stage !== R72_FUNNEL_STAGES[index]) throw new Error("Funnel stage order changed");
    if (row.input < 0 || row.passed < 0 || row.passed > row.input) throw new Error("Funnel count is invalid");
    if (row.rejected !== row.input - row.passed) throw new Error("Funnel rejected count is not reconciled");
    if (previousPassed !== undefined && row.input !== previousPassed) throw new Error("Funnel stage inputs do not chain");
    if (initialInput === undefined) initialInput = row.input;
    if (row.cumulativePassRate < 0 || row.cumulativePassRate > 1) throw new Error("Funnel cumulative rate is invalid");
    previousPassed = row.passed;
  }
}

export interface SignalRate {
  count: number;
  uniqueSignalTimestamps: number;
  observationDays: number;
  signalsPerDay: number;
  signalsPerWeek: number;
  medianDaysBetweenSignals: number | null;
  p90DaysBetweenSignals: number | null;
  p95DaysBetweenSignals: number | null;
  annualizedSignals: number | null;
}

export function calculateSignalRate(signalTimestamps: readonly number[], startTime: number, endTime: number): SignalRate {
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) {
    throw new Error("Signal-rate observation window is invalid");
  }
  const ordered = [...new Set(signalTimestamps.filter(Number.isFinite))].sort((left, right) => left - right);
  const observationDays = (endTime - startTime) / DAY_MS;
  const signalsPerDay = observationDays > 0 ? signalTimestamps.length / observationDays : 0;
  const gaps = ordered.slice(1).map((timestamp, index) => (timestamp - ordered[index]) / DAY_MS);
  return {
    count: signalTimestamps.length,
    uniqueSignalTimestamps: ordered.length,
    observationDays: round(observationDays),
    signalsPerDay: round(signalsPerDay),
    signalsPerWeek: round(signalsPerDay * 7),
    medianDaysBetweenSignals: quantileOrNull(gaps, 0.5),
    p90DaysBetweenSignals: quantileOrNull(gaps, 0.9),
    p95DaysBetweenSignals: quantileOrNull(gaps, 0.95),
    annualizedSignals: observationDays > 0 ? round(signalTimestamps.length / observationDays * 365.25) : null,
  };
}

export function estimateDaysToTarget(currentCount: number, observationDays: number, targetCount: number): number | null {
  if (currentCount <= 0 || observationDays <= 0 || targetCount <= 0) return null;
  return round(targetCount / (currentCount / observationDays));
}

export function assertCandidateAImmutable(candidate: {
  candidateId: string;
  strategyVersion: string;
  strategyHash: string;
  entryMode: string;
  score: number;
  cooldownHours: number;
  rewardRisk: number;
  maxHoldHours: number;
  stopAtrMultiplier: number;
  sideFilter: string;
  strategyFamily: string;
  requireRegimeAlignment: boolean;
  globalReferenceSymbol: string;
  globalReferenceTimeframe: string;
  globalRegimeAlignment: boolean;
  maxExecutionCostRiskFraction: number;
}): void {
  const expected = R72_CANDIDATE_A;
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (candidate[key] !== expected[key]) throw new Error(`Candidate A frozen field changed: ${key}`);
  }
}

export class R72OosRunGuard {
  private readonly runIds = new Set<string>();

  get runCount(): number {
    return this.runIds.size;
  }

  run<T>(candidateId: string, operation: () => T): T {
    if (this.runIds.has(candidateId)) throw new Error(`Final OOS already executed for ${candidateId}`);
    this.runIds.add(candidateId);
    return operation();
  }
}

export function assertChallengerCount(candidateIds: readonly string[]): void {
  if (candidateIds.length > R72_MAX_CHALLENGERS || new Set(candidateIds).size !== candidateIds.length) {
    throw new Error("R7.2 allows at most two unique challenger candidates");
  }
}

export function auditOnlyFailureSet(rowCount: number): {
  rows: number;
  retained: number;
  suppressed: number;
  usedForSelection: false;
} {
  if (rowCount !== 37) throw new Error("R7.2 failure-set audit must remain the frozen 37-row set");
  return { rows: rowCount, retained: 0, suppressed: rowCount, usedForSelection: false };
}

export interface GateMetrics {
  trades: number;
  netPnlUsdt: number;
  expectancyUsdt: number;
  profitFactor: number;
  maxDrawdownPercent: number;
}

export function passesProfitabilityGate(
  baseline: GateMetrics,
  candidate: GateMetrics,
  stressCandidate: GateMetrics,
): boolean {
  return candidate.trades >= baseline.trades
    && candidate.netPnlUsdt > 0
    && candidate.expectancyUsdt > 0
    && candidate.profitFactor >= 1.25
    && stressCandidate.netPnlUsdt > 0
    && stressCandidate.profitFactor >= 1.1
    && candidate.maxDrawdownPercent <= baseline.maxDrawdownPercent + R72_MAX_DD_TOLERANCE;
}

export function passesThroughputGate(
  baselineSignalCount: number,
  candidateSignalCount: number,
  candidateAnnualizedSignals: number | null,
): boolean {
  return candidateSignalCount >= baselineSignalCount * 2
    || (candidateAnnualizedSignals !== null && candidateAnnualizedSignals >= R72_TARGET_ANNUALIZED);
}

export interface RankedCandidate {
  id: string;
  profitabilityEligible: boolean;
  expectancyUsdt: number;
  profitFactor: number;
  stressProfitFactor: number;
  netPnlUsdt: number;
  signalCount: number;
  annualizedSignals: number | null;
}

export function rankProfitabilityBeforeThroughput(candidates: readonly RankedCandidate[]): RankedCandidate[] {
  return [...candidates].sort((left, right) => (
    Number(right.profitabilityEligible) - Number(left.profitabilityEligible)
    || right.expectancyUsdt - left.expectancyUsdt
    || right.profitFactor - left.profitFactor
    || right.stressProfitFactor - left.stressProfitFactor
    || right.netPnlUsdt - left.netPnlUsdt
    || right.signalCount - left.signalCount
    || (right.annualizedSignals ?? -Infinity) - (left.annualizedSignals ?? -Infinity)
    || left.id.localeCompare(right.id)
  ));
}

export interface BootstrapDistribution {
  sampleCount: number;
  iterations: number;
  seed: number;
  p025: number | null;
  median: number | null;
  p975: number | null;
}

export interface BootstrapConfidence {
  expectancyUsdt: BootstrapDistribution;
  profitFactor: BootstrapDistribution;
}

export function bootstrapConfidence(
  pnlValues: readonly number[],
  iterations = 2000,
  seed = 7_201,
): BootstrapConfidence {
  if (pnlValues.length === 0) {
    return { expectancyUsdt: emptyBootstrap(iterations, seed), profitFactor: emptyBootstrap(iterations, seed) };
  }
  const means: number[] = [];
  const profitFactors: number[] = [];
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
    means.push(sum / pnlValues.length);
    profitFactors.push(loss === 0 ? (profit > 0 ? 999 : 0) : profit / loss);
  }
  return {
    expectancyUsdt: distribution(means, pnlValues.length, iterations, seed),
    profitFactor: distribution(profitFactors, pnlValues.length, iterations, seed),
  };
}

export function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function quantileOrNull(values: readonly number[], probability: number): number | null {
  if (values.length === 0) return null;
  return round(quantile(values, probability));
}

function quantile(values: readonly number[], probability: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function nextRandom(state: number): number {
  return (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
}

function emptyBootstrap(iterations: number, seed: number): BootstrapDistribution {
  return { sampleCount: 0, iterations, seed, p025: null, median: null, p975: null };
}

function distribution(values: readonly number[], sampleCount: number, iterations: number, seed: number): BootstrapDistribution {
  return {
    sampleCount,
    iterations,
    seed,
    p025: round(quantile(values, 0.025)),
    median: round(quantile(values, 0.5)),
    p975: round(quantile(values, 0.975)),
  };
}
