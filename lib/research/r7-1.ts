import type { Candle, Side } from "@/lib/core/types";
import type { BacktestTrade } from "@/lib/backtest/types";

export const R71_INTERVAL_MS = 15 * 60 * 1000;
export const R71_INITIAL_CAPITAL_USDT = 10_000;

export const R71_OLD_FAILURE_SET = Object.freeze({
  count: 37,
  start: "2026-08-12T00:00:00.000Z",
  endExclusive: "2026-08-24T00:00:00.000Z",
  netPnlUsdt: -372.87426925,
  profitFactor: 0.656914905250825,
});

export const R71_B4_FROZEN_THRESHOLDS = Object.freeze({
  lowerPercentile: 0.25,
  upperPercentile: 0.75,
  bullish: "price percentile <= 0.25 AND premium-change percentile >= 0.75",
  bearish: "price percentile >= 0.75 AND premium-change percentile <= 0.25",
});

export const R71_HYPOTHESIS_IDS = Object.freeze(["H0", "H1", "H2", "H3", "H4", "H5"] as const);

export interface ResearchMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnlUsdt: number;
  expectancyUsdt: number;
  netR: number;
  profitFactor: number;
  maxDrawdownUsdt: number;
  maxDrawdownPercent: number;
  averageWinnerUsdt: number;
  averageLoserUsdt: number;
  totalFeesUsdt: number;
  totalFundingUsdt: number;
  totalSlippageUsdt: number;
  grossPnlUsdt: number;
  pricePnlBeforeExecutionCostsUsdt: number;
  finalEquityUsdt: number;
}

export interface ResearchTrade {
  trade: BacktestTrade;
  sourceTime: number;
}

export interface EpisodeFilterConfig {
  sameSymbolCooldownHours?: number;
  postStopLossLockoutHours?: number;
}

export interface EpisodeFilterResult {
  trades: BacktestTrade[];
  suppressedByCooldown: number;
  suppressedByPostStopLossLockout: number;
}

export interface MfeMae {
  favorableMove: number;
  adverseMove: number;
  candleCount: number;
}

export function assertPreRegisteredHypotheses(ids: readonly string[] = R71_HYPOTHESIS_IDS): void {
  const unique = new Set(ids);
  if (ids.length > 6 || unique.size !== ids.length || ids.some((id) => !R71_HYPOTHESIS_IDS.includes(id as typeof R71_HYPOTHESIS_IDS[number]))) {
    throw new Error("R7.1 hypothesis registry exceeds or changes the six pre-registered hypotheses");
  }
}

export function calculateResearchMetrics(
  trades: readonly BacktestTrade[],
  initialCapitalUsdt = R71_INITIAL_CAPITAL_USDT,
): ResearchMetrics {
  const ordered = [...trades].sort((left, right) => left.exitTime - right.exitTime || left.entryTime - right.entryTime);
  let equity = initialCapitalUsdt;
  let peak = equity;
  let maxDrawdownUsdt = 0;
  for (const trade of ordered) {
    equity += trade.pnlUsdt;
    peak = Math.max(peak, equity);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peak - equity);
  }

  const wins = trades.filter((trade) => trade.pnlUsdt > 0);
  const losses = trades.filter((trade) => trade.pnlUsdt < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnlUsdt, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnlUsdt, 0));
  const netPnlUsdt = trades.reduce((sum, trade) => sum + trade.pnlUsdt, 0);

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round(trades.length === 0 ? 0 : wins.length / trades.length, 6),
    netPnlUsdt: round(netPnlUsdt, 8),
    expectancyUsdt: round(trades.length === 0 ? 0 : netPnlUsdt / trades.length, 8),
    netR: round(trades.reduce((sum, trade) => sum + trade.rMultiple, 0), 8),
    profitFactor: round(calculateProfitFactor(wins.map((trade) => trade.pnlUsdt), losses.map((trade) => trade.pnlUsdt)), 8),
    maxDrawdownUsdt: round(maxDrawdownUsdt, 8),
    maxDrawdownPercent: round(initialCapitalUsdt === 0 ? 0 : maxDrawdownUsdt / initialCapitalUsdt, 8),
    averageWinnerUsdt: round(wins.length === 0 ? 0 : grossProfit / wins.length, 8),
    averageLoserUsdt: round(losses.length === 0 ? 0 : losses.reduce((sum, trade) => sum + trade.pnlUsdt, 0) / losses.length, 8),
    totalFeesUsdt: round(trades.reduce((sum, trade) => sum + trade.feesUsdt, 0), 8),
    totalFundingUsdt: round(trades.reduce((sum, trade) => sum + trade.fundingUsdt, 0), 8),
    totalSlippageUsdt: round(trades.reduce((sum, trade) => sum + trade.slippageUsdt, 0), 8),
    grossPnlUsdt: round(trades.reduce((sum, trade) => sum + trade.grossPnlUsdt, 0), 8),
    pricePnlBeforeExecutionCostsUsdt: round(trades.reduce((sum, trade) => sum + trade.grossPnlUsdt + trade.slippageUsdt, 0), 8),
    finalEquityUsdt: round(equity, 8),
  };
}

export function calculateProfitFactor(positiveValues: readonly number[], negativeValues: readonly number[]): number {
  const profit = positiveValues.reduce((sum, value) => sum + Math.max(0, value), 0);
  const loss = Math.abs(negativeValues.reduce((sum, value) => sum + Math.min(0, value), 0));
  return loss === 0 ? (profit > 0 ? 999 : 0) : profit / loss;
}

export function calculateExpectedValue(trades: readonly BacktestTrade[]): {
  winRate: number;
  lossRate: number;
  averageWinnerUsdt: number;
  averageLoserUsdt: number;
  evUsdt: number;
  actualMeanNetPnlUsdt: number;
} {
  const metrics = calculateResearchMetrics(trades);
  const lossRate = trades.length === 0 ? 0 : metrics.losses / trades.length;
  const evUsdt = metrics.winRate * metrics.averageWinnerUsdt - lossRate * Math.abs(metrics.averageLoserUsdt);
  return {
    winRate: metrics.winRate,
    lossRate: round(lossRate, 8),
    averageWinnerUsdt: metrics.averageWinnerUsdt,
    averageLoserUsdt: metrics.averageLoserUsdt,
    evUsdt: round(evUsdt, 8),
    actualMeanNetPnlUsdt: metrics.expectancyUsdt,
  };
}

export function applyPITEpisodeFilters(
  researchTrades: readonly ResearchTrade[],
  config: EpisodeFilterConfig,
): EpisodeFilterResult {
  const cooldownMs = Math.max(0, config.sameSymbolCooldownHours ?? 0) * 60 * 60 * 1000;
  const lockoutMs = Math.max(0, config.postStopLossLockoutHours ?? 0) * 60 * 60 * 1000;
  const lastAcceptedSource = new Map<string, number>();
  const lockoutUntil = new Map<string, number>();
  const lastSide = new Map<string, Side>();
  const accepted: BacktestTrade[] = [];
  let suppressedByCooldown = 0;
  let suppressedByPostStopLossLockout = 0;

  const ordered = [...researchTrades].sort((left, right) => (
    left.sourceTime - right.sourceTime
    || right.trade.score - left.trade.score
    || left.trade.symbol.localeCompare(right.trade.symbol)
  ));
  for (const item of ordered) {
    const previousSource = lastAcceptedSource.get(item.trade.symbol);
    if (previousSource !== undefined && item.sourceTime - previousSource < cooldownMs) {
      suppressedByCooldown += 1;
      continue;
    }
    const until = lockoutUntil.get(item.trade.symbol) ?? 0;
    if (item.sourceTime < until && lastSide.get(item.trade.symbol) === item.trade.side) {
      suppressedByPostStopLossLockout += 1;
      continue;
    }

    accepted.push(item.trade);
    lastAcceptedSource.set(item.trade.symbol, item.sourceTime);
    lastSide.set(item.trade.symbol, item.trade.side);
    if (item.trade.exitReason === "STOP" && lockoutMs > 0) {
      lockoutUntil.set(item.trade.symbol, item.trade.exitTime + lockoutMs);
    } else {
      lockoutUntil.delete(item.trade.symbol);
    }
  }
  return { trades: accepted, suppressedByCooldown, suppressedByPostStopLossLockout };
}

export function sourceTimeForEntry(entryTime: number, intervalMs = R71_INTERVAL_MS): number {
  return entryTime - intervalMs;
}

export function isPITNextBarExecution(sourceTime: number, entryTime: number, intervalMs = R71_INTERVAL_MS): boolean {
  return Number.isFinite(sourceTime)
    && Number.isFinite(entryTime)
    && entryTime === sourceTime + intervalMs;
}

export function calculateMfeMae(
  candles: readonly Candle[],
  trade: Pick<BacktestTrade, "side" | "entryTime" | "exitTime" | "entryPrice">,
): MfeMae | null {
  const path = candles.filter((candle) => candle.openTime >= trade.entryTime && candle.closeTime <= trade.exitTime);
  if (path.length === 0 || trade.entryPrice <= 0) return null;
  if (trade.side === "LONG") {
    return {
      favorableMove: Math.max(...path.map((candle) => candle.high / trade.entryPrice - 1)),
      adverseMove: Math.min(...path.map((candle) => candle.low / trade.entryPrice - 1)),
      candleCount: path.length,
    };
  }
  return {
    favorableMove: Math.max(...path.map((candle) => 1 - candle.low / trade.entryPrice)),
    adverseMove: Math.min(...path.map((candle) => 1 - candle.high / trade.entryPrice)),
    candleCount: path.length,
  };
}

export function topSymbolConcentration(trades: readonly BacktestTrade[], topN: number): number {
  const net = trades.reduce((sum, trade) => sum + trade.pnlUsdt, 0);
  if (net <= 0 || trades.length === 0) return 0;
  const bySymbol = new Map<string, number>();
  for (const trade of trades) bySymbol.set(trade.symbol, (bySymbol.get(trade.symbol) ?? 0) + trade.pnlUsdt);
  return round([...bySymbol.values()].sort((left, right) => right - left).slice(0, topN).reduce((sum, value) => sum + value, 0) / net, 8);
}

export class OosRunGuard {
  private hasRun = false;

  get runCount(): number {
    return this.hasRun ? 1 : 0;
  }

  run<T>(operation: () => T): T {
    if (this.hasRun) throw new Error("R7.1 FINAL OOS candidate evaluation is one-shot");
    this.hasRun = true;
    return operation();
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
