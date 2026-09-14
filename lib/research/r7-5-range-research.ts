import type { StrategyParams } from "@/lib/core/strategies";
import type { MarketRegime, Side } from "@/lib/core/types";

export const R75_REPORT_VERSION = "hy-r7.5-v1";
export const R75_BASE_RESEARCH_HEAD = "31a1f53a2cae599a962b27c39cd03bea9396b1b0";
export const R75_CANDIDATE_A_ID = "HY-R7-FORWARD-CANDIDATE-A";
export const R75_D1_ID = "HY-R7-RANGE-CANDIDATE-D1";
export const R75_D2_ID = "HY-R7-RANGE-CANDIDATE-D2";
export const R75_CANDIDATE_E_ID = "HY-R7-MULTI-REGIME-CANDIDATE-E";
export const R75_STRATEGY_VERSION = "hy-paper-candidate-v2";
export const R75_STRATEGY_HASH = "3c3df714d4e5768a4393e523b331b70f239e5c07b963e5bdada7442d69a27918";

export const R75_AUTHORITATIVE_A = Object.freeze({
  trades: 29,
  baseNetPnlUsdt: 469.31166529,
  baseProfitFactor: 1.59999141,
  stressNetPnlUsdt: 400.66533784,
  stressProfitFactor: 1.48858398,
});

export const R75_RANGE_DEFAULTS = Object.freeze({
  entryMode: "RANGE_RECLAIM",
  strategyFamily: "MEAN_REVERSION",
  bollingerPeriod: 20,
  bollingerDeviation: 2,
  rsiPeriod: 14,
  meanReversionRsiLow: 35,
  meanReversionRsiHigh: 65,
});

export const R75_COMMON_SETTINGS = Object.freeze({
  minScore: 80,
  cooldownHours: 24,
  rewardRisk: 2,
  maxHoldHours: 48,
  stopAtrMultiplier: 0.75,
  dynamicUniverseSize: 10,
  dynamicUniverseLookbackDays: 1,
  riskPerTradeUsdt: 50,
  singleSignalRiskCapUsdt: 50,
  dailyRiskBudgetUsdt: 600,
  maxPositionNotionalUsdt: 10_000,
  leverage: 20,
  marginUsdt: 100,
  maxConcurrentPositions: 6,
  maxExecutionCostRiskFraction: 0.1,
});

export const R75_FORWARD_START = "2026-08-09T17:34:48.982760Z";
export const R75_FINAL_OOS_MIN_TRADES = 29;
export const R75_E_MIN_TRADES = 58;
export const R75_MATERIAL_DEGRADATION_FRACTION = 0.75;

export type R75CandidateId = typeof R75_D1_ID | typeof R75_D2_ID;

export interface R75MetricLike {
  trades: number;
  netPnlUsdt: number;
  expectancyUsdt: number;
  profitFactor: number;
  maxDrawdownPercent: number;
}

export interface R75GateResult {
  netPositive: boolean;
  expectancyPositive: boolean;
  profitFactorPass: boolean;
  stressNetPositive: boolean;
  stressProfitFactorPass: boolean;
  positiveBaseFoldsPass: boolean;
  symbolBreadthPass: boolean;
  pass: boolean;
}

export interface R75FinalGateResult {
  netPositive: boolean;
  expectancyPositive: boolean;
  profitFactorPass: boolean;
  stressNetPositive: boolean;
  stressProfitFactorPass: boolean;
  maxDrawdownPass: boolean;
  samplePass: boolean;
  pass: boolean;
}

export interface R75ThroughputResult {
  countPass: boolean;
  annualizedPass: boolean;
  pass: boolean;
}

export interface R75ScoredEvent {
  symbol: string;
  sourceTimestamp: number;
  score: number;
  side: Side;
}

export function assertCandidateAReproduction(
  base: R75MetricLike,
  stress: R75MetricLike,
  tolerance = 1e-6,
): void {
  const matches = Math.abs(base.trades - R75_AUTHORITATIVE_A.trades) <= tolerance
    && Math.abs(base.netPnlUsdt - R75_AUTHORITATIVE_A.baseNetPnlUsdt) <= tolerance
    && Math.abs(base.profitFactor - R75_AUTHORITATIVE_A.baseProfitFactor) <= tolerance
    && Math.abs(stress.netPnlUsdt - R75_AUTHORITATIVE_A.stressNetPnlUsdt) <= tolerance
    && Math.abs(stress.profitFactor - R75_AUTHORITATIVE_A.stressProfitFactor) <= tolerance;
  if (!matches) throw new Error("BACKTEST_REPRODUCIBILITY_FAILURE: frozen Candidate A did not reproduce");
}

export function assertRangeReclaimFrozen(params: StrategyParams): void {
  const expected = R75_RANGE_DEFAULTS;
  if (params.entryMode !== expected.entryMode) throw new Error("RANGE_RECLAIM entry mode changed");
  if (params.bollingerPeriod !== expected.bollingerPeriod) throw new Error("RANGE_RECLAIM Bollinger period changed");
  if (params.bollingerDeviation !== expected.bollingerDeviation) throw new Error("RANGE_RECLAIM Bollinger deviation changed");
  if (params.rsiPeriod !== expected.rsiPeriod) throw new Error("RANGE_RECLAIM RSI period changed");
  if (params.meanReversionRsiLow !== expected.meanReversionRsiLow) throw new Error("RANGE_RECLAIM RSI low changed");
  if (params.meanReversionRsiHigh !== expected.meanReversionRsiHigh) throw new Error("RANGE_RECLAIM RSI high changed");
  if (params.stopAtrMultiplier !== R75_COMMON_SETTINGS.stopAtrMultiplier) throw new Error("RANGE_RECLAIM stop ATR changed");
}

export function assertD1LocalRangeOnly(input: {
  localRegime: MarketRegime;
  globalRegimeFilter: boolean;
}): void {
  if (input.localRegime !== "RANGE") throw new Error("D1 requires local RANGE");
  if (input.globalRegimeFilter) throw new Error("D1 must not add a global regime filter");
}

export function assertD2PitGlobalRange(input: {
  localRegime: MarketRegime;
  globalRegime: MarketRegime;
  usesDirectionalGlobalAlignment: boolean;
}): void {
  if (input.localRegime !== "RANGE" || input.globalRegime !== "RANGE") {
    throw new Error("D2 requires local and PIT BTC 4h RANGE");
  }
  if (input.usesDirectionalGlobalAlignment) {
    throw new Error("D2 must not use directional globalRegimeAlignment");
  }
}

export function passesR75SelectionGate(
  base: R75MetricLike,
  stress: R75MetricLike,
  positiveBaseFolds: number,
  distinctSymbols: number,
): R75GateResult {
  const result = {
    netPositive: base.netPnlUsdt > 0,
    expectancyPositive: base.expectancyUsdt > 0,
    profitFactorPass: base.profitFactor >= 1.2,
    stressNetPositive: stress.netPnlUsdt > 0,
    stressProfitFactorPass: stress.profitFactor >= 1.05,
    positiveBaseFoldsPass: positiveBaseFolds >= 2,
    symbolBreadthPass: distinctSymbols >= 3,
    pass: false,
  };
  result.pass = [
    result.netPositive,
    result.expectancyPositive,
    result.profitFactorPass,
    result.stressNetPositive,
    result.stressProfitFactorPass,
    result.positiveBaseFoldsPass,
    result.symbolBreadthPass,
  ].every(Boolean);
  return result;
}

export function passesR75FinalGate(
  base: R75MetricLike,
  stress: R75MetricLike,
  minimumTrades = R75_FINAL_OOS_MIN_TRADES,
): R75FinalGateResult {
  const result = {
    netPositive: base.netPnlUsdt > 0,
    expectancyPositive: base.expectancyUsdt > 0,
    profitFactorPass: base.profitFactor >= 1.25,
    stressNetPositive: stress.netPnlUsdt > 0,
    stressProfitFactorPass: stress.profitFactor >= 1.1,
    maxDrawdownPass: base.maxDrawdownPercent <= 0.1,
    samplePass: base.trades >= minimumTrades,
    pass: false,
  };
  result.pass = [
    result.netPositive,
    result.expectancyPositive,
    result.profitFactorPass,
    result.stressNetPositive,
    result.stressProfitFactorPass,
    result.maxDrawdownPass,
    result.samplePass,
  ].every(Boolean);
  return result;
}

export function passesR75Throughput(
  count: number,
  annualizedSignals: number | null,
  minimumCount: number,
  minimumAnnualized: number,
): R75ThroughputResult {
  const result = {
    countPass: count >= minimumCount,
    annualizedPass: annualizedSignals !== null && annualizedSignals >= minimumAnnualized,
    pass: false,
  };
  result.pass = result.countPass || result.annualizedPass;
  return result;
}

export function riskAdjustedPerformance(metrics: R75MetricLike): number {
  return metrics.expectancyUsdt / (1 + Math.max(0, metrics.maxDrawdownPercent));
}

export function passesCandidateEPortfolioGate(
  base: R75MetricLike,
  stress: R75MetricLike,
  candidateA: R75MetricLike,
): { final: R75FinalGateResult; riskAdjustedPass: boolean; pass: boolean } {
  const final = passesR75FinalGate(base, stress, R75_E_MIN_TRADES);
  const riskAdjustedPass = riskAdjustedPerformance(base)
    >= riskAdjustedPerformance(candidateA) * R75_MATERIAL_DEGRADATION_FRACTION;
  return { final, riskAdjustedPass, pass: final.pass && riskAdjustedPass };
}

export function rankR75SelectionRows<T extends {
  id: string;
  profitabilityEligible: boolean;
  stressProfitFactor: number;
  baseExpectancy: number;
  maxDrawdownPercent: number;
  stabilityScore: number;
  tradeCount: number;
}>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => (
    Number(right.profitabilityEligible) - Number(left.profitabilityEligible)
    || right.stressProfitFactor - left.stressProfitFactor
    || right.baseExpectancy - left.baseExpectancy
    || left.maxDrawdownPercent - right.maxDrawdownPercent
    || right.stabilityScore - left.stabilityScore
    || right.tradeCount - left.tradeCount
    || left.id.localeCompare(right.id)
  ));
}

export function assertMaximumRangeCandidates(ids: readonly string[]): void {
  const allowed = new Set([R75_D1_ID, R75_D2_ID]);
  if (ids.length > 2 || new Set(ids).size !== ids.length || ids.some((id) => !allowed.has(id))) {
    throw new Error("R7.5 permits only the pre-registered D1 and D2 RANGE candidates");
  }
}

export class R75FinalOosRunGuard {
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

export class R75CandidateEFreeze {
  private selectedRangeId: R75CandidateId | null = null;

  freeze(selectedRangeId: string): string {
    if (this.selectedRangeId !== null) throw new Error("Candidate E was already frozen");
    if (selectedRangeId !== R75_D1_ID && selectedRangeId !== R75_D2_ID) {
      throw new Error("Candidate E must reference the selected D1 or D2 before final OOS");
    }
    this.selectedRangeId = selectedRangeId;
    return R75_CANDIDATE_E_ID;
  }

  assertFrozenBeforeOos(): void {
    if (this.selectedRangeId === null) throw new Error("Candidate E must be pre-registered before any D final OOS");
  }

  get selected(): R75CandidateId | null {
    return this.selectedRangeId;
  }
}

export function selectHighestScorePerSymbolTimestamp<T extends R75ScoredEvent>(events: readonly T[]): T[] {
  const selected = new Map<string, T>();
  for (const event of events) {
    const key = `${event.symbol}:${event.sourceTimestamp}`;
    const previous = selected.get(key);
    if (!previous || event.score > previous.score || (event.score === previous.score && event.side < previous.side)) {
      selected.set(key, event);
    }
  }
  return [...selected.values()].sort((left, right) => (
    left.sourceTimestamp - right.sourceTimestamp
    || left.symbol.localeCompare(right.symbol)
  ));
}

export function applyR75SharedCooldown<T extends R75ScoredEvent>(
  events: readonly T[],
  cooldownHours = R75_COMMON_SETTINGS.cooldownHours,
): T[] {
  const cooldownMs = Math.max(0, cooldownHours) * 60 * 60 * 1000;
  const accepted: T[] = [];
  const lastBySymbol = new Map<string, number>();
  const ordered = [...selectHighestScorePerSymbolTimestamp(events)].sort((left, right) => (
    left.sourceTimestamp - right.sourceTimestamp
    || right.score - left.score
    || left.symbol.localeCompare(right.symbol)
  ));
  for (const event of ordered) {
    const previous = lastBySymbol.get(event.symbol);
    if (previous !== undefined && event.sourceTimestamp - previous < cooldownMs) continue;
    accepted.push(event);
    lastBySymbol.set(event.symbol, event.sourceTimestamp);
  }
  return accepted.sort((left, right) => left.sourceTimestamp - right.sourceTimestamp || left.symbol.localeCompare(right.symbol));
}

export function assertForwardAuditIsNotSelectionInput(input: {
  selectionDataset: string;
  forwardUsedForSelection: boolean;
}): void {
  if (input.forwardUsedForSelection) throw new Error("Forward audit data cannot be used for selection");
  if (!input.selectionDataset.includes("20-symbol")) throw new Error("R7.5 selection must name the authoritative 20-symbol dataset");
}

export function countScoreBand(scores: readonly number[], lower = 79, upper = 81): number {
  return scores.filter((score) => score >= lower && score <= upper).length;
}

export function classifyR75(input: {
  authoritativeCandidateAReproduced: boolean;
  selectedRange: boolean;
  selectedOosTradeCount: number | null;
  selectedDPass: boolean;
  selectedDThroughputPass: boolean;
  candidateEPass: boolean;
  candidateEThroughputPass: boolean;
}): "MULTI_REGIME_FORWARD_CANDIDATE_READY" | "RANGE_CANDIDATE_PROFITABLE_BUT_PORTFOLIO_FAIL" | "NO_RANGE_PROFITABLE_CANDIDATE" | "INSUFFICIENT_RANGE_OOS_SAMPLE" | "BACKTEST_REPRODUCIBILITY_FAILURE" | "PROFITABILITY_RESEARCH_INVALID" {
  if (!input.authoritativeCandidateAReproduced) return "BACKTEST_REPRODUCIBILITY_FAILURE";
  if (!input.selectedRange) return "NO_RANGE_PROFITABLE_CANDIDATE";
  if ((input.selectedOosTradeCount ?? 0) < R75_FINAL_OOS_MIN_TRADES) return "INSUFFICIENT_RANGE_OOS_SAMPLE";
  if (!input.selectedDPass || !input.selectedDThroughputPass) return "NO_RANGE_PROFITABLE_CANDIDATE";
  if (!input.candidateEPass || !input.candidateEThroughputPass) return "RANGE_CANDIDATE_PROFITABLE_BUT_PORTFOLIO_FAIL";
  return "MULTI_REGIME_FORWARD_CANDIDATE_READY";
}

export function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
