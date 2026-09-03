import {
  buildDynamicUniverseByTimestamp,
  buildGlobalRegimeByTimestamp,
  evaluateHistoricalTrade,
  snapshotAt,
} from "@/lib/backtest/engine";
import type { BacktestTrade, HistoricalDataset } from "@/lib/backtest/types";
import {
  evaluateCandidateFunnel,
  type DeliveryStatus,
} from "@/lib/core/candidate-funnel";
import { zonedDateString } from "@/lib/core/time";
import type { RuntimeStrategyPolicy } from "@/lib/core/runtime-strategy";
import type { MarketRegime, ScoredCandidate, TradePlan } from "@/lib/core/types";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export interface ProductionParityBacktestOptions {
  policy: RuntimeStrategyPolicy;
  candidateCaches?: Array<Map<number, ScoredCandidate[]>>;
  evaluationStartTime: number;
  evaluationEndTime: number;
  dynamicUniverseSize?: number;
  dynamicUniverseLookbackDays?: number;
  dynamicUniverseByTimestamp?: Map<number, Set<string>>;
  globalRegimeByTimestamp?: Map<number, MarketRegime>;
  maxEmailsPerDay?: number;
  maxEmailsPerScan?: number;
  budgetTimezone?: string;
  emailObservationEnabled?: boolean;
  dryRun?: boolean;
}

export interface ProductionParityCounts {
  qualifiedCandidateCount: number;
  claimedSignalCount: number;
  paperTradeCount: number;
  emailAllowedCount: number;
  emailDeliveredEquivalentCount: number;
}

export interface ProductionParityRejectionCounts {
  cooldown: number;
  rejectedLowerScore: number;
  singleSignalRiskCap: number;
  dailyRiskBudget: number;
}

export type ProductionClaimStatus =
  | "CREATED"
  | "REPLACED"
  | "REJECTED_COOLDOWN"
  | "REJECTED_LOWER_SCORE"
  | "SINGLE_RISK_CAP"
  | "BUDGET_BLOCKED";

export interface ProductionClaimInput {
  symbol: string;
  sourceTimestamp: number;
  score: number;
  riskUsdt: number;
  validUntil: number;
  paperTrade?: BacktestTrade | null;
}

export interface ProductionClaimOutcome {
  status: ProductionClaimStatus;
  claimed: boolean;
  paperTradeCreated: boolean;
  riskDeltaUsdt: number;
  emailAllowed: boolean;
  emailDeliveredEquivalent: boolean;
  deliveryStatus: DeliveryStatus;
}

interface ActiveClaim {
  score: number;
  riskUsdt: number;
  sourceTimestamp: number;
  validUntil: number;
  paperTrade?: BacktestTrade | null;
}

interface PaperSample {
  trade: BacktestTrade | null;
  cancelled: boolean;
}

export interface ProductionParityBacktestResult {
  trades: BacktestTrade[];
  counts: ProductionParityCounts;
  rejectionCounts: ProductionParityRejectionCounts;
  deliveryStatusCounts: Record<DeliveryStatus, number>;
}

export interface ProductionClaimSimulatorOptions {
  cooldownHours: number;
  singleSignalRiskCapUsdt: number;
  dailyRiskBudgetUsdt: number;
  maxEmailsPerDay: number;
  maxEmailsPerScan: number;
  budgetTimezone?: string;
  emailObservationEnabled?: boolean;
  dryRun?: boolean;
}

/**
 * Models the claim boundary used by the production signal flow without
 * applying research-only portfolio gates such as concurrent positions or
 * realized-loss stops.
 */
export class ProductionClaimSimulator {
  private readonly options: ProductionClaimSimulatorOptions;
  private readonly activeClaims = new Map<string, ActiveClaim>();
  private readonly lastSignalSourceTimestamp = new Map<string, number>();
  private readonly dailyRisk = new Map<string, number>();
  private readonly dailyEmailCount = new Map<string, number>();
  private readonly scanEmailCount = new Map<number, number>();
  private readonly paperSamples: PaperSample[] = [];
  private readonly counts: ProductionParityCounts = {
    qualifiedCandidateCount: 0,
    claimedSignalCount: 0,
    paperTradeCount: 0,
    emailAllowedCount: 0,
    emailDeliveredEquivalentCount: 0,
  };
  private readonly rejectionCounts: ProductionParityRejectionCounts = {
    cooldown: 0,
    rejectedLowerScore: 0,
    singleSignalRiskCap: 0,
    dailyRiskBudget: 0,
  };
  private readonly deliveryStatusCounts: Record<DeliveryStatus, number> = {
    NOT_APPLICABLE: 0,
    NOT_ALLOWED: 0,
    DUPLICATE_NOTIFICATION: 0,
    SKIPPED_DRY_RUN: 0,
    SENT: 0,
    FAILED: 0,
  };

  constructor(options: ProductionClaimSimulatorOptions) {
    this.options = options;
  }

  recordQualifiedCandidate(): void {
    this.counts.qualifiedCandidateCount += 1;
  }

  claim(input: ProductionClaimInput): ProductionClaimOutcome {
    const previousSourceTimestamp = this.lastSignalSourceTimestamp.get(input.symbol);
    const cooldownMs = Math.max(0, this.options.cooldownHours) * 60 * 60 * 1000;
    if (
      previousSourceTimestamp !== undefined
      && input.sourceTimestamp >= previousSourceTimestamp
      && input.sourceTimestamp - previousSourceTimestamp < cooldownMs
    ) {
      this.rejectionCounts.cooldown += 1;
      return this.outcome("REJECTED_COOLDOWN", 0, false, false, false, "NOT_APPLICABLE");
    }

    let active = this.activeClaims.get(input.symbol);
    if (active && input.sourceTimestamp >= active.validUntil) {
      this.activeClaims.delete(input.symbol);
      active = undefined;
    }

    if (active && input.score <= active.score) {
      this.rejectionCounts.rejectedLowerScore += 1;
      return this.outcome("REJECTED_LOWER_SCORE", 0, false, false, false, "NOT_APPLICABLE");
    }

    if (input.riskUsdt > this.options.singleSignalRiskCapUsdt) {
      this.rejectionCounts.singleSignalRiskCap += 1;
      return this.outcome("SINGLE_RISK_CAP", 0, false, false, false, "NOT_APPLICABLE");
    }

    const riskDeltaUsdt = Math.max(input.riskUsdt - (active?.riskUsdt ?? 0), 0);
    const budgetDate = zonedDateString(input.sourceTimestamp, this.options.budgetTimezone ?? "Asia/Shanghai");
    if ((this.dailyRisk.get(budgetDate) ?? 0) + riskDeltaUsdt > this.options.dailyRiskBudgetUsdt) {
      this.rejectionCounts.dailyRiskBudget += 1;
      // The production function persists BUDGET_BLOCKED as a signal row, so
      // it also participates in the source-timestamp cooldown lookup.
      this.lastSignalSourceTimestamp.set(input.symbol, input.sourceTimestamp);
      return this.outcome("BUDGET_BLOCKED", riskDeltaUsdt, false, false, false, "NOT_APPLICABLE");
    }

    if (active?.paperTrade && active.paperTrade.exitTime > input.sourceTimestamp) {
      const sample = this.paperSamples.find((candidate) => candidate.trade === active?.paperTrade);
      if (sample) sample.cancelled = true;
    }

    this.activeClaims.set(input.symbol, {
      score: input.score,
      riskUsdt: input.riskUsdt,
      sourceTimestamp: input.sourceTimestamp,
      validUntil: input.validUntil,
      paperTrade: input.paperTrade,
    });
    this.lastSignalSourceTimestamp.set(input.symbol, input.sourceTimestamp);
    this.dailyRisk.set(budgetDate, (this.dailyRisk.get(budgetDate) ?? 0) + riskDeltaUsdt);
    this.counts.claimedSignalCount += 1;
    this.counts.paperTradeCount += 1;
    this.paperSamples.push({ trade: input.paperTrade ?? null, cancelled: false });

    const scanBucket = Math.floor(input.sourceTimestamp / FIFTEEN_MINUTES_MS);
    const emailAllowed = this.emailAllowed(budgetDate, scanBucket);
    let deliveryStatus: DeliveryStatus = "NOT_ALLOWED";
    let emailDeliveredEquivalent = false;
    if (emailAllowed) {
      this.counts.emailAllowedCount += 1;
      this.dailyEmailCount.set(budgetDate, (this.dailyEmailCount.get(budgetDate) ?? 0) + 1);
      this.scanEmailCount.set(scanBucket, (this.scanEmailCount.get(scanBucket) ?? 0) + 1);
      this.counts.emailDeliveredEquivalentCount += 1;
      emailDeliveredEquivalent = true;
      deliveryStatus = this.options.dryRun ? "SKIPPED_DRY_RUN" : "SENT";
    }

    return this.outcome(
      active ? "REPLACED" : "CREATED",
      riskDeltaUsdt,
      true,
      true,
      emailAllowed,
      deliveryStatus,
      emailDeliveredEquivalent,
    );
  }

  result(): ProductionParityBacktestResult {
    const trades = this.paperSamples
      .filter((sample) => !sample.cancelled && sample.trade !== null)
      .map((sample) => sample.trade as BacktestTrade)
      .sort((left, right) => left.exitTime - right.exitTime || left.entryTime - right.entryTime);
    return {
      trades,
      counts: { ...this.counts },
      rejectionCounts: { ...this.rejectionCounts },
      deliveryStatusCounts: { ...this.deliveryStatusCounts },
    };
  }

  private emailAllowed(budgetDate: string, scanBucket: number): boolean {
    if (this.options.emailObservationEnabled === false) return false;
    return (this.dailyEmailCount.get(budgetDate) ?? 0) < this.options.maxEmailsPerDay
      && (this.scanEmailCount.get(scanBucket) ?? 0) < this.options.maxEmailsPerScan;
  }

  private outcome(
    status: ProductionClaimStatus,
    riskDeltaUsdt: number,
    claimed: boolean,
    paperTradeCreated: boolean,
    emailAllowed: boolean,
    deliveryStatus: DeliveryStatus,
    emailDeliveredEquivalent = false,
  ): ProductionClaimOutcome {
    this.deliveryStatusCounts[deliveryStatus] += 1;
    return {
      status,
      claimed,
      paperTradeCreated,
      riskDeltaUsdt,
      emailAllowed,
      emailDeliveredEquivalent,
      deliveryStatus,
    };
  }
}

export function runProductionParityBacktest(
  datasets: HistoricalDataset[],
  options: ProductionParityBacktestOptions,
): ProductionParityBacktestResult {
  const entryTimes = collectEntryTimes(datasets, options.candidateCaches);
  const dynamicUniverse = options.dynamicUniverseByTimestamp
    ?? (options.dynamicUniverseSize !== undefined
      ? buildDynamicUniverseByTimestamp(
        datasets,
        entryTimes,
        options.dynamicUniverseSize,
        options.dynamicUniverseLookbackDays ?? 1,
      )
      : undefined);
  const globalRegime = options.globalRegimeByTimestamp
    ?? (options.policy.globalRegimeAlignment
      ? buildGlobalRegimeByTimestamp(
        datasets,
        entryTimes,
        options.policy.globalReferenceSymbol,
        options.policy.globalReferenceTimeframe,
      )
      : undefined);
  const opportunities: Array<{
    dataset: HistoricalDataset;
    index: number;
    sourceTimestamp: number;
    candidate: ScoredCandidate;
    plan: TradePlan;
    paperTrade: BacktestTrade | null;
  }> = [];

  datasets.forEach((dataset, datasetIndex) => {
    const candles = dataset.candles["15m"];
    const candidateCache = options.candidateCaches?.[datasetIndex];
    const indices = candidateCache
      ? [...candidateCache.keys()].sort((left, right) => left - right)
      : Array.from({ length: Math.max(0, candles.length - 81) }, (_, offset) => offset + 80);
    for (const index of indices) {
      const candle = candles[index];
      const entryCandle = candles[index + 1];
      if (
        !candle
        || !entryCandle
        || entryCandle.openTime > options.evaluationEndTime
        || candle.closeTime < options.evaluationStartTime
        || candle.closeTime > options.evaluationEndTime
      ) continue;
      if (dynamicUniverse && !dynamicUniverse.get(candle.closeTime)?.has(dataset.symbol)) continue;

      const snapshot = snapshotAt(dataset, index);
      const evaluation = evaluateCandidateFunnel({
        snapshot,
        strategy: options.policy,
        globalRegime: globalRegime?.get(candle.closeTime),
        rankedCandidates: candidateCache?.get(index),
      });
      if (!evaluation.candidate || !evaluation.plan) continue;

      opportunities.push({
        dataset,
        index,
        sourceTimestamp: candle.closeTime,
        candidate: evaluation.candidate,
        plan: evaluation.plan,
        paperTrade: evaluateHistoricalTrade(dataset, index + 1, evaluation.candidate, evaluation.plan, {
          maxHoldHours: options.policy.riskPolicy.maxHoldHours,
          takerFeeRate: options.policy.takerFeeRate,
          slippageBps: options.policy.slippageBps,
          evaluationEndTime: options.evaluationEndTime,
        }),
      });
    }
  });

  opportunities.sort((left, right) =>
    left.sourceTimestamp - right.sourceTimestamp
    || right.candidate.score - left.candidate.score
    || left.dataset.symbol.localeCompare(right.dataset.symbol));

  const simulator = new ProductionClaimSimulator({
    cooldownHours: options.policy.cooldownHours,
    singleSignalRiskCapUsdt: options.policy.riskPolicy.singleSignalRiskCapUsdt,
    dailyRiskBudgetUsdt: options.policy.riskPolicy.dailyRiskBudgetUsdt,
    maxEmailsPerDay: options.maxEmailsPerDay ?? 10,
    maxEmailsPerScan: options.maxEmailsPerScan ?? 6,
    budgetTimezone: options.budgetTimezone,
    emailObservationEnabled: options.emailObservationEnabled,
    dryRun: options.dryRun,
  });
  for (const opportunity of opportunities) {
    simulator.recordQualifiedCandidate();
    simulator.claim({
      symbol: opportunity.dataset.symbol,
      sourceTimestamp: opportunity.sourceTimestamp,
      score: opportunity.candidate.score,
      riskUsdt: opportunity.plan.theoreticalRiskUsdt,
      validUntil: opportunity.plan.validUntil,
      paperTrade: opportunity.paperTrade,
    });
  }
  return simulator.result();
}

function collectEntryTimes(
  datasets: HistoricalDataset[],
  candidateCaches?: Array<Map<number, ScoredCandidate[]>>,
): number[] {
  const timestamps = new Set<number>();
  datasets.forEach((dataset, datasetIndex) => {
    const candles = dataset.candles["15m"];
    const cache = candidateCaches?.[datasetIndex];
    if (cache) {
      for (const index of cache.keys()) {
        const timestamp = candles[index]?.closeTime;
        if (timestamp !== undefined) timestamps.add(timestamp);
      }
      return;
    }
    for (let index = 80; index < candles.length - 1; index += 1) {
      timestamps.add(candles[index].closeTime);
    }
  });
  return [...timestamps].sort((left, right) => left - right);
}
