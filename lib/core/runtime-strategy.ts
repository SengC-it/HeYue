import { DEFAULT_STRATEGY_PARAMS, type EntryMode, type StrategyParams } from "./strategies";
import type { MarketRegime, RiskPolicy, ScoredCandidate, Side, StrategyCandidate, Timeframe } from "./types";
import { z } from "zod";

export interface RuntimeStrategyPolicy {
  version: string;
  params: StrategyParams;
  minScore: number;
  sideFilter?: Side;
  strategyFamily?: StrategyCandidate["strategyFamily"];
  requireRegimeAlignment: boolean;
  riskPolicy: RiskPolicy;
  cooldownHours: number;
  maxExecutionCostRiskFraction?: number;
  takerFeeRate: number;
  slippageBps: number;
  globalRegimeAlignment: boolean;
  globalReferenceSymbol: string;
  globalReferenceTimeframe: Extract<Timeframe, "1h" | "4h">;
}

export interface RuntimeStrategyPolicyInput {
  version: string;
  entryMode: EntryMode;
  stopAtrMultiplier: number;
  minScore: number;
  sideFilter: Side | "BOTH";
  strategyFamily: StrategyCandidate["strategyFamily"] | "ALL";
  requireRegimeAlignment: boolean;
  riskPolicy: RiskPolicy;
  cooldownHours: number;
  maxExecutionCostRiskFraction?: number;
  takerFeeRate: number;
  slippageBps: number;
  globalRegimeAlignment?: boolean;
  globalReferenceSymbol?: string;
  globalReferenceTimeframe?: Extract<Timeframe, "1h" | "4h">;
}

const runtimeStrategyPolicySchema = z.object({
  version: z.string().min(1),
  params: z.object({
    entryMode: z.enum(["DEFAULT", "TREND_PULLBACK", "BREAKOUT_RETEST", "RANGE_RECLAIM"]).optional(),
    emaFast: z.number().positive(),
    emaSlow: z.number().positive(),
    rsiPeriod: z.number().positive(),
    atrPeriod: z.number().positive(),
    stopAtrMultiplier: z.number().positive(),
    breakoutPeriod: z.number().positive(),
    breakoutVolumeRatio: z.number().positive(),
    meanReversionRsiLow: z.number().positive(),
    meanReversionRsiHigh: z.number().positive(),
    bollingerPeriod: z.number().positive(),
    bollingerDeviation: z.number().positive(),
  }),
  minScore: z.number().min(0).max(100),
  sideFilter: z.enum(["LONG", "SHORT"]).optional(),
  strategyFamily: z.enum(["TREND", "BREAKOUT", "MEAN_REVERSION"]).optional(),
  requireRegimeAlignment: z.boolean(),
  riskPolicy: z.object({
    marginUsdt: z.number().positive(),
    leverage: z.number().positive(),
    singleSignalRiskCapUsdt: z.number().positive(),
    dailyRiskBudgetUsdt: z.number().positive(),
    maxHoldHours: z.number().positive(),
    rewardRisk: z.number().positive().optional(),
    riskPerTradeUsdt: z.number().positive().optional(),
    maxPositionNotionalUsdt: z.number().positive().optional(),
  }),
  cooldownHours: z.number().nonnegative(),
  maxExecutionCostRiskFraction: z.number().nonnegative().optional(),
  takerFeeRate: z.number().nonnegative(),
  slippageBps: z.number().nonnegative(),
  globalRegimeAlignment: z.boolean().default(false),
  globalReferenceSymbol: z.string().min(1).default("BTCUSDT"),
  globalReferenceTimeframe: z.enum(["1h", "4h"]).default("4h"),
});

export function parseRuntimeStrategyPolicy(
  value: unknown,
  expectedVersion?: string,
): RuntimeStrategyPolicy {
  const policy = runtimeStrategyPolicySchema.parse(value) as RuntimeStrategyPolicy;
  if (expectedVersion && policy.version !== expectedVersion) {
    throw new Error(`Strategy policy version mismatch: expected ${expectedVersion}, got ${policy.version}`);
  }
  return policy;
}

export function createRuntimeStrategyPolicy(
  input: RuntimeStrategyPolicyInput,
): RuntimeStrategyPolicy {
  return {
    version: input.version,
    params: {
      ...DEFAULT_STRATEGY_PARAMS,
      entryMode: input.entryMode,
      stopAtrMultiplier: input.stopAtrMultiplier,
    },
    minScore: input.minScore,
    sideFilter: input.sideFilter === "BOTH" ? undefined : input.sideFilter,
    strategyFamily: input.strategyFamily === "ALL" ? undefined : input.strategyFamily,
    requireRegimeAlignment: input.requireRegimeAlignment,
    riskPolicy: input.riskPolicy,
    cooldownHours: input.cooldownHours,
    maxExecutionCostRiskFraction: input.maxExecutionCostRiskFraction,
    takerFeeRate: input.takerFeeRate,
    slippageBps: input.slippageBps,
    globalRegimeAlignment: input.globalRegimeAlignment ?? false,
    globalReferenceSymbol: input.globalReferenceSymbol ?? "BTCUSDT",
    globalReferenceTimeframe: input.globalReferenceTimeframe ?? "4h",
  };
}

export function passesGlobalRegimeFilter(
  candidate: ScoredCandidate,
  policy: RuntimeStrategyPolicy,
  globalRegime: MarketRegime | undefined,
): boolean {
  if (!policy.globalRegimeAlignment) return true;
  if (!globalRegime) return false;
  return candidate.side === "LONG" ? globalRegime === "BULL" : globalRegime === "BEAR";
}

export function passesRuntimeCandidateFilter(
  candidate: ScoredCandidate,
  policy: RuntimeStrategyPolicy,
): boolean {
  if (policy.sideFilter && candidate.side !== policy.sideFilter) return false;
  if (policy.strategyFamily && candidate.strategyFamily !== policy.strategyFamily) return false;
  return passesLocalRegimeFilter(candidate, policy);
}

export function passesLocalRegimeFilter(
  candidate: ScoredCandidate,
  policy: RuntimeStrategyPolicy,
): boolean {
  if (!policy.requireRegimeAlignment) return true;

  if (candidate.strategyFamily === "MEAN_REVERSION") {
    return candidate.marketRegime === "RANGE" || candidate.marketRegime === "UNKNOWN";
  }
  return candidate.side === "LONG"
    ? candidate.marketRegime === "BULL"
    : candidate.marketRegime === "BEAR";
}
