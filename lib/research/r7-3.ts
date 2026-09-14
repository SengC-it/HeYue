import type { ScoredCandidate } from "@/lib/core/types";

export const R73_REPORT_VERSION = "hy-r7.3-v1";
export const R73_CANDIDATE_A_ID = "HY-R7-FORWARD-CANDIDATE-A";
export const R73_C1_ID = "HY-R7-BREAKOUT-CANDIDATE-C1";
export const R73_C2_ID = "HY-R7-COMBINED-CANDIDATE-C2";
export const R73_STRATEGY_VERSION = "hy-paper-candidate-v2";
export const R73_STRATEGY_HASH = "3c3df714d4e5768a4393e523b331b70f239e5c07b963e5bdada7442d69a27918";
export const R73_BREAKOUT_DEFAULTS = Object.freeze({
  breakoutPeriod: 20,
  breakoutVolumeRatio: 1.15,
});

export const R73_AUTHORITATIVE_A_OOS = Object.freeze({
  trades: 29,
  baseNetPnlUsdt: 469.31166529,
  baseProfitFactor: 1.59999141,
  stressNetPnlUsdt: 400.66533784,
  stressProfitFactor: 1.48858398,
});

export interface R73MetricLike {
  trades: number;
  netPnlUsdt: number;
  expectancyUsdt: number;
  profitFactor: number;
  maxDrawdownPercent: number;
}

export interface R73CandidateRankRow {
  id: string;
  profitabilityEligible: boolean;
  stressProfitFactor: number;
  expectancyUsdt: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  stabilityScore: number;
  signalCount: number;
  annualizedSignals: number | null;
}

export interface RejectionStageCount {
  rejectionStage: string;
  count: number;
  sharePercent: number;
}

export interface FunnelCounterEvidence {
  units: Record<string, string>;
  hasRowLineage: boolean;
}

export function assertBreakoutDefaults(params: {
  breakoutPeriod: number;
  breakoutVolumeRatio: number;
}): void {
  if (params.breakoutPeriod !== R73_BREAKOUT_DEFAULTS.breakoutPeriod) {
    throw new Error("R7.3 breakoutPeriod must remain the frozen default");
  }
  if (params.breakoutVolumeRatio !== R73_BREAKOUT_DEFAULTS.breakoutVolumeRatio) {
    throw new Error("R7.3 breakoutVolumeRatio must remain the frozen default");
  }
}

export function mergeCandidatesAtObservation(
  candidateGroups: readonly (readonly ScoredCandidate[])[],
): ScoredCandidate[] {
  const candidates = candidateGroups.flatMap((group) => group);
  if (candidates.length === 0) return [];
  const ordered = [...candidates].sort((left, right) => (
    right.score - left.score
    || candidateFamilyPriority(left.strategyFamily) - candidateFamilyPriority(right.strategyFamily)
    || left.side.localeCompare(right.side)
  ));
  return [ordered[0]];
}

export function mergeCandidateCaches(
  candidateCaches: readonly (ReadonlyMap<number, readonly ScoredCandidate[]>)[],
): Map<number, ScoredCandidate[]> {
  const indices = new Set<number>();
  for (const cache of candidateCaches) {
    for (const index of cache.keys()) indices.add(index);
  }
  const merged = new Map<number, ScoredCandidate[]>();
  for (const index of [...indices].sort((left, right) => left - right)) {
    const candidates = mergeCandidatesAtObservation(candidateCaches.map((cache) => cache.get(index) ?? []));
    if (candidates.length > 0) merged.set(index, candidates);
  }
  return merged;
}

export function matchesAuthoritativeCandidateA(
  base: R73MetricLike,
  stress: R73MetricLike,
  tolerance = 1e-6,
): boolean {
  return Math.abs(base.trades - R73_AUTHORITATIVE_A_OOS.trades) <= tolerance
    && Math.abs(base.netPnlUsdt - R73_AUTHORITATIVE_A_OOS.baseNetPnlUsdt) <= tolerance
    && Math.abs(base.profitFactor - R73_AUTHORITATIVE_A_OOS.baseProfitFactor) <= tolerance
    && Math.abs(stress.netPnlUsdt - R73_AUTHORITATIVE_A_OOS.stressNetPnlUsdt) <= tolerance
    && Math.abs(stress.profitFactor - R73_AUTHORITATIVE_A_OOS.stressProfitFactor) <= tolerance;
}

export function assertAuthoritativeCandidateA(
  base: R73MetricLike,
  stress: R73MetricLike,
  tolerance = 1e-6,
): void {
  if (!matchesAuthoritativeCandidateA(base, stress, tolerance)) {
    throw new Error("BACKTEST_REPRODUCIBILITY_FAILURE: frozen R7.1A Candidate A did not reproduce");
  }
}

export function passesR73SelectionGate(
  base: R73MetricLike,
  stress: R73MetricLike,
  positiveBaseFolds: number,
): boolean {
  return base.netPnlUsdt > 0
    && base.expectancyUsdt > 0
    && base.profitFactor >= 1.2
    && stress.netPnlUsdt > 0
    && stress.profitFactor >= 1.05
    && positiveBaseFolds >= 2;
}

export function passesR73FinalProfitabilityGate(
  baseline: R73MetricLike,
  candidate: R73MetricLike,
  stressCandidate: R73MetricLike,
): boolean {
  return candidate.trades >= baseline.trades
    && candidate.netPnlUsdt > 0
    && candidate.expectancyUsdt > 0
    && candidate.profitFactor >= 1.25
    && stressCandidate.netPnlUsdt > 0
    && stressCandidate.profitFactor >= 1.1
    && candidate.maxDrawdownPercent <= baseline.maxDrawdownPercent + 0.092414;
}

export function passesR73ThroughputGate(
  candidateSignalCount: number,
  candidateAnnualizedSignals: number | null,
  requiredSignalCount: number,
  requiredAnnualizedSignals: number,
): boolean {
  return candidateSignalCount >= requiredSignalCount
    || (candidateAnnualizedSignals !== null && candidateAnnualizedSignals >= requiredAnnualizedSignals);
}

export function rankR73Candidates(candidates: readonly R73CandidateRankRow[]): R73CandidateRankRow[] {
  return [...candidates].sort((left, right) => (
    Number(right.profitabilityEligible) - Number(left.profitabilityEligible)
    || right.stressProfitFactor - left.stressProfitFactor
    || right.expectancyUsdt - left.expectancyUsdt
    || right.profitFactor - left.profitFactor
    || left.maxDrawdownPercent - right.maxDrawdownPercent
    || right.stabilityScore - left.stabilityScore
    || right.signalCount - left.signalCount
    || (right.annualizedSignals ?? -Infinity) - (left.annualizedSignals ?? -Infinity)
    || left.id.localeCompare(right.id)
  ));
}

export function aggregateRejectionStages(stages: readonly string[]): RejectionStageCount[] {
  const counts = new Map<string, number>();
  for (const stage of stages) counts.set(stage, (counts.get(stage) ?? 0) + 1);
  const total = stages.length;
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([rejectionStage, count]) => ({
      rejectionStage,
      count,
      sharePercent: round(total === 0 ? 0 : count / total * 100, 6),
    }));
}

export function canCalculateConditionalFunnelRates(evidence: FunnelCounterEvidence): boolean {
  const units = Object.values(evidence.units);
  return evidence.hasRowLineage
    && units.length > 0
    && new Set(units).size === 1;
}

function candidateFamilyPriority(family: ScoredCandidate["strategyFamily"]): number {
  return family === "TREND" ? 0 : family === "BREAKOUT" ? 1 : 2;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
