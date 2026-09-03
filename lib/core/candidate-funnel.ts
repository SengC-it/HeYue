import { classifyRegime } from "@/lib/core/market-regime";
import { buildTradePlan, estimateExecutionCostRisk } from "@/lib/core/risk";
import { rankCandidates } from "@/lib/core/scoring";
import {
  passesGlobalRegimeFilter,
  passesLocalRegimeFilter,
  type RuntimeStrategyPolicy,
} from "@/lib/core/runtime-strategy";
import { generateCandidates } from "@/lib/core/strategies";
import type {
  Instrument,
  MarketRegime,
  MarketSnapshot,
  ScoredCandidate,
  StrategyCandidate,
  TradePlan,
} from "@/lib/core/types";

export const rejectionStageValues = [
  "MARKET_DATA",
  "NO_RAW_CANDIDATE",
  "SCORE",
  "SIDE",
  "STRATEGY_FAMILY",
  "LOCAL_REGIME",
  "GLOBAL_REGIME",
  "RISK_PLAN",
  "SINGLE_RISK_CAP",
  "EXECUTION_COST",
  "COOLDOWN",
  "CLAIM_REJECTED",
  "EMAIL_NOT_ALLOWED",
  "QUALIFIED",
] as const;

export type RejectionStage = typeof rejectionStageValues[number];
export type DiagnosticFinalStatus = "REJECTED" | "QUALIFIED" | "CLAIMED" | "EMAILED";
export type MarketDataFailureReason = "FETCH_ERROR" | "INSUFFICIENT_HISTORY";
export type DeliveryStatus =
  | "NOT_APPLICABLE"
  | "NOT_ALLOWED"
  | "DUPLICATE_NOTIFICATION"
  | "SKIPPED_DRY_RUN"
  | "SENT"
  | "FAILED";

export interface PerSymbolDiagnostics {
  symbol: string;
  universeRank: number | null;
  quoteVolume24h: number | null;
  marketDataOk: boolean;
  marketDataFailureReason: MarketDataFailureReason | null;
  marketDataError: string | null;
  history15mCount: number | null;
  history1hCount: number | null;
  history4hCount: number | null;
  rawCandidateCount: number;
  topRawScore: number | null;
  topRawSide: ScoredCandidate["side"] | null;
  topRawStrategyFamily: ScoredCandidate["strategyFamily"] | null;
  marketRegime: MarketRegime | null;
  scorePass: boolean;
  sidePass: boolean;
  strategyFamilyPass: boolean;
  localRegimePass: boolean;
  globalRegimePass: boolean;
  riskPlanPass: boolean;
  singleRiskCapPass: boolean;
  executionCostPass: boolean;
  cooldownPass: boolean | null;
  claimed: boolean | null;
  emailed: boolean | null;
  deliveryStatus: DeliveryStatus;
  finalStatus: DiagnosticFinalStatus;
  rejectionStage: RejectionStage;
}

export interface FilterFunnelTelemetry {
  /** Values are counts; the units map below prevents symbol/candidate mixing. */
  measurement: "count";
  units: {
    marketDataOk: "symbol";
    rawCandidates: "candidate";
    scorePass: "candidate";
    sidePass: "candidate";
    strategyFamilyPass: "candidate";
    localRegimePass: "candidate";
    globalRegimePass: "candidate";
    riskPlanPass: "candidate";
    singleRiskCapPass: "candidate";
    executionCostPass: "candidate";
    preCooldownCandidate: "candidate";
    cooldownPass: "candidate";
    claimed: "candidate";
    emailed: "candidate";
  };
  marketDataOk: number;
  rawCandidates: number;
  scorePass: number;
  sidePass: number;
  strategyFamilyPass: number;
  localRegimePass: number;
  globalRegimePass: number;
  riskPlanPass: number;
  singleRiskCapPass: number;
  executionCostPass: number;
  preCooldownCandidate: number;
  cooldownPass: number;
  claimed: number;
  emailed: number;
}

export interface CandidateFunnelEvaluation {
  candidate: ScoredCandidate | null;
  plan: TradePlan | null;
  diagnostics: PerSymbolDiagnostics;
  counts: Omit<FilterFunnelTelemetry, "measurement" | "units">;
  evaluationError?: string;
}

export interface CandidateFunnelInput {
  snapshot: MarketSnapshot;
  strategy: RuntimeStrategyPolicy;
  globalRegime?: MarketRegime;
  /** Test seam; production callers leave this unset so ranking stays centralized. */
  rankedCandidates?: ScoredCandidate[];
}

export function createEmptyFilterFunnel(): FilterFunnelTelemetry {
  return {
    measurement: "count",
    units: {
      marketDataOk: "symbol",
      rawCandidates: "candidate",
      scorePass: "candidate",
      sidePass: "candidate",
      strategyFamilyPass: "candidate",
      localRegimePass: "candidate",
      globalRegimePass: "candidate",
      riskPlanPass: "candidate",
      singleRiskCapPass: "candidate",
      executionCostPass: "candidate",
      preCooldownCandidate: "candidate",
      cooldownPass: "candidate",
      claimed: "candidate",
      emailed: "candidate",
    },
    marketDataOk: 0,
    rawCandidates: 0,
    scorePass: 0,
    sidePass: 0,
    strategyFamilyPass: 0,
    localRegimePass: 0,
    globalRegimePass: 0,
    riskPlanPass: 0,
    singleRiskCapPass: 0,
    executionCostPass: 0,
    preCooldownCandidate: 0,
    cooldownPass: 0,
    claimed: 0,
    emailed: 0,
  };
}

export function addFilterFunnel(
  target: FilterFunnelTelemetry,
  counts: Partial<Omit<FilterFunnelTelemetry, "measurement" | "units">>,
): void {
  for (const key of Object.keys(target.units) as Array<keyof FilterFunnelTelemetry["units"]>) {
    const value = counts[key];
    if (typeof value === "number") {
      target[key] += value;
    }
  }
}

export function recordCooldownResult(
  telemetry: FilterFunnelTelemetry,
  diagnostic: PerSymbolDiagnostics,
  passed: boolean,
): void {
  diagnostic.cooldownPass = passed;
  if (passed) {
    telemetry.cooldownPass += 1;
    return;
  }
  diagnostic.finalStatus = "REJECTED";
  diagnostic.rejectionStage = "COOLDOWN";
}

/**
 * Replays the production selection pipeline in explicit stages. The first
 * local/global-regime candidate is selected before risk and cost checks,
 * matching the legacy `rankedCandidates.find(...)` behavior exactly.
 */
export function evaluateCandidateFunnel(input: CandidateFunnelInput): CandidateFunnelEvaluation {
  const { snapshot, strategy } = input;
  const history15mCount = snapshot.candles["15m"]?.length ?? 0;
  const history1hCount = snapshot.candles["1h"]?.length ?? 0;
  const history4hCount = snapshot.candles["4h"]?.length ?? 0;
  const requiredPrimaryHistory = Math.max(strategy.params.emaSlow + 5, 80);
  const marketDataOk = history15mCount >= requiredPrimaryHistory;
  const marketRegime = classifyRegime(snapshot.candles["4h"] ?? snapshot.candles["1h"] ?? []);
  const rankedCandidates = input.rankedCandidates
    ?? rankCandidates(generateCandidates(snapshot, strategy.params));

  const baseCounts = {
    marketDataOk: marketDataOk ? 1 : 0,
    rawCandidates: rankedCandidates.length,
    scorePass: 0,
    sidePass: 0,
    strategyFamilyPass: 0,
    localRegimePass: 0,
    globalRegimePass: 0,
    riskPlanPass: 0,
    singleRiskCapPass: 0,
    executionCostPass: 0,
    preCooldownCandidate: 0,
    cooldownPass: 0,
    claimed: 0,
    emailed: 0,
  };
  const diagnostics = baseDiagnostics(snapshot.instrument, {
    marketDataOk,
    marketDataFailureReason: marketDataOk ? null : "INSUFFICIENT_HISTORY",
    history15mCount,
    history1hCount,
    history4hCount,
    rawCandidateCount: rankedCandidates.length,
    topRawScore: rankedCandidates[0]?.score ?? null,
    topRawSide: rankedCandidates[0]?.side ?? null,
    topRawStrategyFamily: rankedCandidates[0]?.strategyFamily ?? null,
    marketRegime,
  });

  if (!marketDataOk) {
    diagnostics.rejectionStage = "MARKET_DATA";
    return { candidate: null, plan: null, diagnostics, counts: baseCounts };
  }
  if (rankedCandidates.length === 0) {
    diagnostics.rejectionStage = "NO_RAW_CANDIDATE";
    return { candidate: null, plan: null, diagnostics, counts: baseCounts };
  }

  const scoreCandidates = rankedCandidates.filter((candidate) => candidate.score >= strategy.minScore);
  baseCounts.scorePass = scoreCandidates.length;
  diagnostics.scorePass = scoreCandidates.length > 0;
  if (scoreCandidates.length === 0) {
    diagnostics.rejectionStage = "SCORE";
    return { candidate: null, plan: null, diagnostics, counts: baseCounts };
  }

  const sideCandidates = strategy.sideFilter
    ? scoreCandidates.filter((candidate) => candidate.side === strategy.sideFilter)
    : scoreCandidates;
  baseCounts.sidePass = sideCandidates.length;
  diagnostics.sidePass = sideCandidates.length > 0;
  if (sideCandidates.length === 0) {
    diagnostics.rejectionStage = "SIDE";
    return { candidate: null, plan: null, diagnostics, counts: baseCounts };
  }

  const familyCandidates = strategy.strategyFamily
    ? sideCandidates.filter((candidate) => candidate.strategyFamily === strategy.strategyFamily)
    : sideCandidates;
  baseCounts.strategyFamilyPass = familyCandidates.length;
  diagnostics.strategyFamilyPass = familyCandidates.length > 0;
  if (familyCandidates.length === 0) {
    diagnostics.rejectionStage = "STRATEGY_FAMILY";
    return { candidate: null, plan: null, diagnostics, counts: baseCounts };
  }

  const localRegimeCandidates = familyCandidates.filter((candidate) => passesLocalRegimeFilter(candidate, strategy));
  baseCounts.localRegimePass = localRegimeCandidates.length;
  diagnostics.localRegimePass = localRegimeCandidates.length > 0;
  if (localRegimeCandidates.length === 0) {
    diagnostics.rejectionStage = "LOCAL_REGIME";
    return { candidate: null, plan: null, diagnostics, counts: baseCounts };
  }

  const globalRegimeCandidates = localRegimeCandidates.filter((candidate) => passesGlobalRegimeFilter(candidate, strategy, input.globalRegime));
  baseCounts.globalRegimePass = globalRegimeCandidates.length;
  diagnostics.globalRegimePass = globalRegimeCandidates.length > 0;
  if (globalRegimeCandidates.length === 0) {
    diagnostics.rejectionStage = "GLOBAL_REGIME";
    return { candidate: null, plan: null, diagnostics, counts: baseCounts };
  }

  // This is deliberately the first candidate after the pre-risk filters. It
  // preserves the old selection expression instead of trying a lower-ranked
  // candidate after a risk or execution-cost rejection.
  const selected = globalRegimeCandidates[0];
  const repriced = { ...selected, entryPrice: snapshot.tickerPrice };
  let plan: TradePlan;
  try {
    plan = buildTradePlan(repriced, snapshot.instrument, strategy.riskPolicy, snapshot.sourceTimestamp);
  } catch (error) {
    diagnostics.rejectionStage = "RISK_PLAN";
    return { candidate: null, plan: null, diagnostics, counts: baseCounts, evaluationError: errorMessage(error) };
  }
  baseCounts.riskPlanPass = 1;
  diagnostics.riskPlanPass = true;

  if (plan.riskOverSingleCap) {
    diagnostics.rejectionStage = "SINGLE_RISK_CAP";
    return { candidate: null, plan, diagnostics, counts: baseCounts };
  }
  baseCounts.singleRiskCapPass = 1;
  diagnostics.singleRiskCapPass = true;

  if (
    strategy.maxExecutionCostRiskFraction !== undefined
    && estimateExecutionCostRisk(plan, strategy.takerFeeRate, strategy.slippageBps) > strategy.maxExecutionCostRiskFraction
  ) {
    diagnostics.rejectionStage = "EXECUTION_COST";
    return { candidate: null, plan, diagnostics, counts: baseCounts };
  }
  baseCounts.executionCostPass = 1;
  diagnostics.executionCostPass = true;
  baseCounts.preCooldownCandidate = 1;
  diagnostics.finalStatus = "QUALIFIED";
  diagnostics.rejectionStage = "QUALIFIED";
  return { candidate: repriced, plan, diagnostics, counts: baseCounts };
}

export function createMarketDataFailureDiagnostics(
  instrument: Instrument,
  reason: MarketDataFailureReason,
  error: string | null = null,
): PerSymbolDiagnostics {
  return baseDiagnostics(instrument, {
    marketDataOk: false,
    marketDataFailureReason: reason,
    marketDataError: error,
    history15mCount: null,
    history1hCount: null,
    history4hCount: null,
    rawCandidateCount: 0,
    topRawScore: null,
    topRawSide: null,
    topRawStrategyFamily: null,
    marketRegime: null,
  });
}

export function findTopRejectionStage(diagnostics: PerSymbolDiagnostics[]): RejectionStage | null {
  const counts = new Map<RejectionStage, number>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.finalStatus !== "REJECTED") continue;
    counts.set(diagnostic.rejectionStage, (counts.get(diagnostic.rejectionStage) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || rejectionStageValues.indexOf(left[0]) - rejectionStageValues.indexOf(right[0]))
    .at(0)?.[0] ?? null;
}

function baseDiagnostics(
  instrument: Instrument,
  values: Pick<PerSymbolDiagnostics, "marketDataOk" | "marketDataFailureReason" | "history15mCount" | "history1hCount" | "history4hCount" | "rawCandidateCount" | "topRawScore" | "topRawSide" | "topRawStrategyFamily" | "marketRegime"> & Partial<Pick<PerSymbolDiagnostics, "marketDataError">>,
): PerSymbolDiagnostics {
  return {
    symbol: instrument.symbol,
    universeRank: instrument.universeRank ?? null,
    quoteVolume24h: instrument.quoteVolume24h ?? null,
    marketDataOk: values.marketDataOk,
    marketDataFailureReason: values.marketDataFailureReason,
    marketDataError: values.marketDataError ?? null,
    history15mCount: values.history15mCount,
    history1hCount: values.history1hCount,
    history4hCount: values.history4hCount,
    rawCandidateCount: values.rawCandidateCount,
    topRawScore: values.topRawScore,
    topRawSide: values.topRawSide,
    topRawStrategyFamily: values.topRawStrategyFamily,
    marketRegime: values.marketRegime,
    scorePass: false,
    sidePass: false,
    strategyFamilyPass: false,
    localRegimePass: false,
    globalRegimePass: false,
    riskPlanPass: false,
    singleRiskCapPass: false,
    executionCostPass: false,
    cooldownPass: null,
    claimed: null,
    emailed: null,
    deliveryStatus: "NOT_APPLICABLE",
    finalStatus: "REJECTED",
    rejectionStage: "MARKET_DATA",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
