import { buildTradePlan, estimateExecutionCostRisk } from "@/lib/core/risk";
import { passesEmpiricalScoreCalibration, rankCandidates, type ScoreCalibrationModel } from "@/lib/core/scoring";
import { generateCandidates, type StrategyParams } from "@/lib/core/strategies";
import { classifyRegime } from "@/lib/core/market-regime";
import type { Candle, FundingRatePoint, MarketRegime, MarketSnapshot, ScoredCandidate, Side, StrategyCandidate, TradePlan } from "@/lib/core/types";
import type {
  BacktestMetrics,
  BacktestResult,
  BacktestTrade,
  HistoricalDataset,
  PortfolioBacktestResult,
} from "./types";

const DEFAULT_TAKER_FEE_RATE = 0.0004;
const DEFAULT_SLIPPAGE_BPS = 2;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export interface BacktestOptions {
  initialCapitalUsdt?: number;
  minScore?: number;
  maxHoldHours?: number;
  minimumSampleDays?: number;
  singleSignalRiskCapUsdt?: number;
  dailyRiskBudgetUsdt?: number;
  dailyLossLimitUsdt?: number;
  maxConcurrentPositions?: number;
  maxEmailsPerDay?: number;
  maxEmailsPerScan?: number;
  capitalFloorUsdt?: number;
  marginUsdt?: number;
  leverage?: number;
  takerFeeRate?: number;
  slippageBps?: number;
  selectionTakerFeeRate?: number;
  selectionSlippageBps?: number;
  entryDelayBars?: number;
  evaluationStartTime?: number;
  evaluationEndTime?: number;
  riskPerTradeUsdt?: number;
  maxPositionNotionalUsdt?: number;
  rewardRisk?: number;
  cooldownHours?: number;
  maxExecutionCostRiskFraction?: number;
  entryIntervalHours?: number;
  candidateCache?: Map<number, ScoredCandidate[]>;
  candidateCaches?: Array<Map<number, ScoredCandidate[]>>;
  scoreCalibration?: ScoreCalibrationModel;
  sideFilter?: Side;
  strategyFamilies?: Array<"TREND" | "BREAKOUT" | "MEAN_REVERSION">;
  requireRegimeAlignment?: boolean;
  dynamicUniverseSize?: number;
  dynamicUniverseLookbackDays?: number;
  globalReferenceSymbol?: string;
  globalReferenceTimeframe?: "1h" | "4h";
  globalConfirmationTimeframe?: "1h" | "4h";
  globalRegimeAlignment?: boolean;
  dynamicUniverseByTimestamp?: Map<number, Set<string>>;
  globalRegimeByTimestamp?: Map<number, MarketRegime>;
  globalConfirmationRegimeByTimestamp?: Map<number, MarketRegime>;
}

export function runBacktest(
  dataset: HistoricalDataset,
  params: StrategyParams,
  options: BacktestOptions = {},
): BacktestResult {
  const initialCapitalUsdt = options.initialCapitalUsdt ?? 10_000;
  const maxHoldHours = options.maxHoldHours ?? 72;
  const minScore = options.minScore ?? 0;
  const minimumSampleDays = options.minimumSampleDays ?? 365;
  const riskCap = options.singleSignalRiskCapUsdt ?? 100;
  const dailyRiskBudgetUsdt = options.dailyRiskBudgetUsdt ?? 600;
  const marginUsdt = options.marginUsdt ?? 100;
  const leverage = options.leverage ?? 20;
  const takerFeeRate = options.takerFeeRate ?? DEFAULT_TAKER_FEE_RATE;
  const slippageBps = options.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const selectionTakerFeeRate = options.selectionTakerFeeRate ?? takerFeeRate;
  const selectionSlippageBps = options.selectionSlippageBps ?? slippageBps;
  const entryDelayBars = Math.max(0, Math.floor(options.entryDelayBars ?? 1));
  const cooldownMs = Math.max(0, options.cooldownHours ?? 0) * 60 * 60 * 1000;
  const entryIntervalMs = options.entryIntervalHours && options.entryIntervalHours > 0
    ? options.entryIntervalHours * 60 * 60 * 1000
    : undefined;
  const candles = dataset.candles["15m"];
  const evaluationStartTime = options.evaluationStartTime ?? candlesStart(candles);
  const evaluationEndTime = options.evaluationEndTime ?? Number.POSITIVE_INFINITY;
  const trades: BacktestTrade[] = [];
  let nextAllowedEntryTime = evaluationStartTime;
  const firstIndex = Math.max(params.emaSlow + 5, 80, lowerBound(candles, evaluationStartTime));
  const candidateIndices = options.candidateCache
    ? [...options.candidateCache.keys()].sort((left, right) => left - right)
    : undefined;
  let candidateCursor = candidateIndices ? lowerBoundNumber(candidateIndices, firstIndex) : 0;
  let index = firstIndex;
  const lastEvaluableIndex = lastIndexAtOrBefore(candles, evaluationEndTime);
  const advanceTo = (nextIndex: number) => {
    if (candidateIndices) {
      candidateCursor = lowerBoundNumber(candidateIndices, nextIndex);
    } else {
      index = nextIndex;
    }
  };

  while (candidateIndices
    ? candidateCursor < candidateIndices.length
    : index < Math.min(candles.length - 1, lastEvaluableIndex)) {
    if (candidateIndices) index = candidateIndices[candidateCursor];
    if (index >= Math.min(candles.length - 1, lastEvaluableIndex) || candles[index].closeTime > evaluationEndTime) break;
    const current = candles[index];
    if (current.closeTime < nextAllowedEntryTime) {
      advanceTo(index + 1);
      continue;
    }
    const dynamicUniverse = options.dynamicUniverseByTimestamp?.get(current.closeTime);
    if (dynamicUniverse && !dynamicUniverse.has(dataset.symbol)) {
      advanceTo(index + 1);
      continue;
    }
    if (entryIntervalMs && (current.closeTime + 1) % entryIntervalMs !== 0) {
      advanceTo(index + 1);
      continue;
    }
    const rankedCandidates = options.candidateCache
      ? options.candidateCache.get(index) ?? []
      : rankCandidates(generateCandidates(snapshotAt(dataset, index), params));
    const candidate = rankedCandidates.filter((item) => isAllowedCandidate(item, options))[0];

    if (!candidate || candidate.score < minScore) {
      advanceTo(index + 1);
      continue;
    }
    if (
      options.scoreCalibration
      && !passesEmpiricalScoreCalibration(options.scoreCalibration, candidate.score, candidate.strategyFamily)
    ) {
      advanceTo(index + 1);
      continue;
    }
    if (options.globalRegimeAlignment) {
      const globalRegime = options.globalRegimeByTimestamp?.get(current.closeTime);
      const confirmationRegime = options.globalConfirmationRegimeByTimestamp?.get(current.closeTime);
      if (
        !globalRegime
        || !isGlobalRegimeAligned(candidate.side, globalRegime)
        || (options.globalConfirmationTimeframe !== undefined
          && (!confirmationRegime || !isGlobalRegimeAligned(candidate.side, confirmationRegime)))
      ) {
        advanceTo(index + 1);
        continue;
      }
    }

    const entryIndex = index + entryDelayBars;
    const entryCandle = candles[entryIndex];
    if (!entryCandle || entryCandle.openTime > evaluationEndTime) {
      advanceTo(index + 1);
      continue;
    }
    const executionCandidate = {
      ...candidate,
      entryPrice: entryCandle.open,
    };

    let plan: TradePlan;
    try {
      plan = buildTradePlan(executionCandidate, dataset.instrument, {
        marginUsdt,
        leverage,
        singleSignalRiskCapUsdt: riskCap,
        dailyRiskBudgetUsdt,
        maxHoldHours,
        rewardRisk: options.rewardRisk,
        riskPerTradeUsdt: options.riskPerTradeUsdt,
        maxPositionNotionalUsdt: options.maxPositionNotionalUsdt,
      }, entryCandle.openTime);
    } catch {
      advanceTo(index + 1);
      continue;
    }
    if (plan.riskOverSingleCap) {
      advanceTo(index + 1);
      continue;
    }
    if (
      options.maxExecutionCostRiskFraction !== undefined
      && estimateExecutionCostRisk(plan, selectionTakerFeeRate, selectionSlippageBps) > options.maxExecutionCostRiskFraction
    ) {
      advanceTo(index + 1);
      continue;
    }

    const trade = evaluateTrade(dataset, entryIndex, executionCandidate, plan, {
      maxHoldHours,
      takerFeeRate,
      slippageBps,
      evaluationEndTime,
    });
    if (!trade) {
      // A slice ending between two candle closes cannot value this entry
      // without borrowing a candle after the evaluation boundary.
      advanceTo(index + 1);
      continue;
    }
    trades.push(trade);
    nextAllowedEntryTime = trade.exitTime + cooldownMs;
    advanceTo(findIndexAtOrAfter(candles, trade.exitTime) + 1);
  }

  const metrics = summarizeMetrics(dataset, trades, {
    initialCapitalUsdt,
    minimumSampleDays,
    evaluationStartTime,
    evaluationEndTime,
  });
  return { params, metrics, trades };
}

export function buildCandidateCache(
  dataset: HistoricalDataset,
  params: StrategyParams,
  evaluationEndTime = Number.POSITIVE_INFINITY,
): Map<number, ScoredCandidate[]> {
  const candles = dataset.candles["15m"];
  const cache = new Map<number, ScoredCandidate[]>();
  const startIndex = Math.max(params.emaSlow + 5, 80);
  for (let index = startIndex; index < candles.length - 1 && candles[index].closeTime <= evaluationEndTime; index += 1) {
    const snapshot = snapshotAt(dataset, index);
    const rankedCandidates = rankCandidates(generateCandidates(snapshot, params));
    if (rankedCandidates.length > 0) cache.set(index, rankedCandidates);
  }
  return cache;
}

export function runPortfolioBacktest(
  datasets: HistoricalDataset[],
  params: StrategyParams,
  options: BacktestOptions = {},
): PortfolioBacktestResult {
  const preparedOptions = preparePortfolioFilters(datasets, options);
  const rawTrades = datasets.flatMap((dataset, index) => runBacktest(dataset, params, {
    ...preparedOptions,
    candidateCache: options.candidateCaches?.[index],
    // Portfolio limits are applied once, after all symbols are merged. This
    // keeps a large-stop trade from disappearing before the portfolio sees it.
    singleSignalRiskCapUsdt: Number.MAX_SAFE_INTEGER,
  }).trades).sort(byEntryTime);
  return selectPortfolioTrades(rawTrades, params, preparedOptions);
}

function preparePortfolioFilters(
  datasets: HistoricalDataset[],
  options: BacktestOptions,
): BacktestOptions {
  const entryTimes = collectEntryTimes(datasets, options.candidateCaches);
  const dynamicUniverseByTimestamp = options.dynamicUniverseByTimestamp
    ?? (options.dynamicUniverseSize !== undefined
      ? buildDynamicUniverseByTimestamp(
        datasets,
        entryTimes,
        options.dynamicUniverseSize,
        options.dynamicUniverseLookbackDays ?? 30,
      )
      : undefined);
  const globalRegimeByTimestamp = options.globalRegimeByTimestamp
    ?? (options.globalRegimeAlignment
      ? buildGlobalRegimeByTimestamp(
        datasets,
        entryTimes,
        options.globalReferenceSymbol ?? "BTCUSDT",
        options.globalReferenceTimeframe ?? "4h",
      )
      : undefined);
  const globalConfirmationRegimeByTimestamp = options.globalConfirmationRegimeByTimestamp
    ?? (options.globalRegimeAlignment && options.globalConfirmationTimeframe
      ? buildGlobalRegimeByTimestamp(
        datasets,
        entryTimes,
        options.globalReferenceSymbol ?? "BTCUSDT",
        options.globalConfirmationTimeframe,
      )
      : undefined);

  return {
    ...options,
    dynamicUniverseByTimestamp,
    globalRegimeByTimestamp,
    globalConfirmationRegimeByTimestamp,
  };
}

function collectEntryTimes(
  datasets: HistoricalDataset[],
  candidateCaches?: Array<Map<number, ScoredCandidate[]>>,
): number[] {
  const times = new Set<number>();
  datasets.forEach((dataset, datasetIndex) => {
    const candles = dataset.candles["15m"];
    const candidateCache = candidateCaches?.[datasetIndex];
    if (candidateCache) {
      for (const index of candidateCache.keys()) {
        const closeTime = candles[index]?.closeTime;
        if (closeTime !== undefined) times.add(closeTime);
      }
      return;
    }
    for (let index = 80; index < candles.length - 1; index += 1) {
      times.add(candles[index].closeTime);
    }
  });
  return [...times].sort((left, right) => left - right);
}

function buildDynamicUniverseByTimestamp(
  datasets: HistoricalDataset[],
  entryTimes: number[],
  requestedSize: number,
  lookbackDays: number,
): Map<number, Set<string>> {
  const universeSize = Math.max(1, Math.floor(requestedSize));
  const lookbackMs = Math.max(1, lookbackDays) * 24 * 60 * 60 * 1000;
  const prefixes = datasets.map((dataset) => ({
    dataset,
    prefix: quoteVolumePrefix(dataset.candles["15m"]),
  }));
  const result = new Map<number, Set<string>>();

  for (const timestamp of entryTimes) {
    const ranked = prefixes.map(({ dataset, prefix }) => ({
      symbol: dataset.symbol,
      quoteVolume: rollingQuoteVolume(dataset.candles["15m"], prefix, timestamp, lookbackMs),
    })).sort((left, right) => right.quoteVolume - left.quoteVolume || left.symbol.localeCompare(right.symbol));
    result.set(timestamp, new Set(ranked.slice(0, universeSize).map((item) => item.symbol)));
  }
  return result;
}

function buildGlobalRegimeByTimestamp(
  datasets: HistoricalDataset[],
  entryTimes: number[],
  referenceSymbol: string,
  timeframe: "1h" | "4h",
): Map<number, MarketRegime> {
  const reference = datasets.find((dataset) => dataset.symbol === referenceSymbol);
  if (!reference) {
    throw new Error(`Global regime reference symbol ${referenceSymbol} is not present in the validation universe`);
  }
  const candles = reference.candles[timeframe] ?? [];
  return new Map(entryTimes.map((timestamp) => {
    const end = upperBound(candles, timestamp);
    return [timestamp, classifyRegime(candles.slice(0, end).slice(-250))];
  }));
}

function quoteVolumePrefix(candles: Candle[]): number[] {
  const prefix = [0];
  for (const candle of candles) {
    const quoteVolume = Math.max(0, candle.close * candle.volume);
    prefix.push(prefix[prefix.length - 1] + quoteVolume);
  }
  return prefix;
}

function rollingQuoteVolume(
  candles: Candle[],
  prefix: number[],
  timestamp: number,
  lookbackMs: number,
): number {
  const endIndex = lastIndexAtOrBefore(candles, timestamp);
  if (endIndex < 0) return 0;
  const startIndex = lowerBound(candles, timestamp - lookbackMs);
  return Math.max(0, prefix[endIndex + 1] - prefix[startIndex]);
}

function isGlobalRegimeAligned(side: Side, regime: MarketRegime): boolean {
  return (side === "LONG" && regime === "BULL") || (side === "SHORT" && regime === "BEAR");
}

export function selectPortfolioTrades(
  rawTrades: BacktestTrade[],
  params: StrategyParams,
  options: BacktestOptions = {},
): PortfolioBacktestResult {
  const initialCapitalUsdt = options.initialCapitalUsdt ?? 10_000;
  const maxConcurrentPositions = Math.max(1, Math.floor(options.maxConcurrentPositions ?? 6));
  const singleSignalRiskCapUsdt = options.singleSignalRiskCapUsdt ?? 100;
  const dailyRiskBudgetUsdt = options.dailyRiskBudgetUsdt ?? 600;
  const dailyLossLimitUsdt = options.dailyLossLimitUsdt ?? dailyRiskBudgetUsdt;
  const maxEmailsPerDay = options.maxEmailsPerDay ?? 10;
  const maxEmailsPerScan = options.maxEmailsPerScan ?? 6;
  const capitalFloorUsdt = options.capitalFloorUsdt ?? 0;

  const selectedTrades: BacktestTrade[] = [];
  const activeTrades: BacktestTrade[] = [];
  const dailyRisk = new Map<string, number>();
  const dailyRealizedPnl = new Map<string, number>();
  const dailyEmails = new Map<string, number>();
  const scanEmails = new Map<number, number>();
  const rejectionCounts = {
    maxConcurrentPositions: 0,
    singleSignalRisk: 0,
    dailyRiskBudget: 0,
    dailyLossLimit: 0,
    emailCap: 0,
    capitalFloor: 0,
  };
  let realizedEquity = initialCapitalUsdt;

  for (const trade of rawTrades) {
    const remainingActive: BacktestTrade[] = [];
    for (const active of activeTrades) {
      if (active.exitTime <= trade.entryTime) {
        realizedEquity += active.pnlUsdt;
        const exitDay = utcDay(active.exitTime);
        dailyRealizedPnl.set(exitDay, (dailyRealizedPnl.get(exitDay) ?? 0) + active.pnlUsdt);
      } else {
        remainingActive.push(active);
      }
    }
    activeTrades.splice(0, activeTrades.length, ...remainingActive);

    const entryDay = utcDay(trade.entryTime);
    const scanBucket = Math.floor(trade.entryTime / FIFTEEN_MINUTES_MS);
    const risk = trade.theoreticalRiskUsdt;
    if (activeTrades.length >= maxConcurrentPositions) {
      rejectionCounts.maxConcurrentPositions += 1;
      continue;
    }
    if (risk > singleSignalRiskCapUsdt) {
      rejectionCounts.singleSignalRisk += 1;
      continue;
    }
    if ((dailyRisk.get(entryDay) ?? 0) + risk > dailyRiskBudgetUsdt) {
      rejectionCounts.dailyRiskBudget += 1;
      continue;
    }
    const realizedLossToday = Math.min(0, dailyRealizedPnl.get(entryDay) ?? 0);
    if (-realizedLossToday + risk > dailyLossLimitUsdt) {
      rejectionCounts.dailyLossLimit += 1;
      continue;
    }
    if (
      (dailyEmails.get(entryDay) ?? 0) >= maxEmailsPerDay
      || (scanEmails.get(scanBucket) ?? 0) >= maxEmailsPerScan
    ) {
      rejectionCounts.emailCap += 1;
      continue;
    }
    if (realizedEquity - risk < capitalFloorUsdt) {
      rejectionCounts.capitalFloor += 1;
      continue;
    }

    selectedTrades.push(trade);
    activeTrades.push(trade);
    dailyRisk.set(entryDay, (dailyRisk.get(entryDay) ?? 0) + risk);
    dailyEmails.set(entryDay, (dailyEmails.get(entryDay) ?? 0) + 1);
    scanEmails.set(scanBucket, (scanEmails.get(scanBucket) ?? 0) + 1);
  }

  const first = options.evaluationStartTime ?? rawTrades[0]?.entryTime ?? 0;
  const last = options.evaluationEndTime ?? rawTrades.at(-1)?.exitTime ?? first;
  const metrics = summarizeTradeMetrics(selectedTrades, {
    initialCapitalUsdt,
    minimumSampleDays: options.minimumSampleDays ?? 365,
    evaluationStartTime: Number.isFinite(first) ? first : 0,
    evaluationEndTime: last,
  });
  const rawMetrics = summarizeTradeMetrics(rawTrades, {
    initialCapitalUsdt,
    minimumSampleDays: options.minimumSampleDays ?? 365,
    evaluationStartTime: Number.isFinite(first) ? first : 0,
    evaluationEndTime: last,
  });

  return {
    params,
    metrics,
    rawMetrics,
    rawTrades,
    trades: selectedTrades,
    rejectionCounts,
  };
}

function isAllowedCandidate(
  candidate: StrategyCandidate,
  options: BacktestOptions,
): boolean {
  if (options.sideFilter && candidate.side !== options.sideFilter) return false;
  if (options.strategyFamilies && !options.strategyFamilies.includes(candidate.strategyFamily)) return false;
  if (!options.requireRegimeAlignment) return true;

  if (candidate.strategyFamily === "MEAN_REVERSION") {
    return candidate.marketRegime === "RANGE" || candidate.marketRegime === "UNKNOWN";
  }
  return candidate.side === "LONG"
    ? candidate.marketRegime === "BULL"
    : candidate.marketRegime === "BEAR";
}

function snapshotAt(dataset: HistoricalDataset, index: number): MarketSnapshot {
  const primary = dataset.candles["15m"];
  const sourceTimestamp = primary[index].closeTime;
  const asOf = (candles: Candle[] | undefined) => {
    if (!candles || candles.length === 0) return [];
    const end = upperBound(candles, sourceTimestamp);
    return candles.slice(Math.max(0, end - 250), end);
  };

  return {
    instrument: {
      ...dataset.instrument,
      // Historical scoring must use information available at this timestamp,
      // not the download-time 24h ticker attached to the instrument.
      quoteVolume24h: rollingQuoteVolumeAtIndex(primary, index, 96),
    },
    tickerPrice: primary[index].close,
    candles: {
      "15m": asOf(primary),
      "1h": asOf(dataset.candles["1h"]),
      "4h": asOf(dataset.candles["4h"]),
    },
    sourceTimestamp,
  };
}

function evaluateTrade(
  dataset: HistoricalDataset,
  entryIndex: number,
  candidate: ReturnType<typeof rankCandidates>[number],
  plan: TradePlan,
  options: {
    maxHoldHours: number;
    takerFeeRate: number;
    slippageBps: number;
    evaluationEndTime: number;
  },
): BacktestTrade | null {
  const candles = dataset.candles["15m"];
  const entry = candles[entryIndex];
  const deadline = Math.min(
    entry.openTime + options.maxHoldHours * 60 * 60 * 1000,
    options.evaluationEndTime,
  );

  for (let index = entryIndex; index < candles.length; index += 1) {
    const candle = candles[index];
    // Only use a fully closed candle inside the evaluation window. This keeps
    // train/OOS results from borrowing a future candle at the boundary.
    if (candle.closeTime > deadline) break;

    const stopHit = candidate.side === "LONG" ? candle.low <= plan.stopPrice : candle.high >= plan.stopPrice;
    const takeProfitHit = candidate.side === "LONG"
      ? candle.high >= plan.takeProfitPrice
      : candle.low <= plan.takeProfitPrice;

    // OHLC data does not reveal the intrabar path; stop-first is conservative.
    if (stopHit) {
      return tradeResult(dataset, candidate, plan, entry, candle, stopFillPrice(candidate.side, candle, plan.stopPrice), "STOP", options);
    }
    if (takeProfitHit) {
      return tradeResult(dataset, candidate, plan, entry, candle, plan.takeProfitPrice, "TAKE_PROFIT", options);
    }
  }

  const lastIndex = Math.min(candles.length - 1, lastIndexAtOrBefore(candles, deadline));
  if (lastIndex <= entryIndex) return null;
  const exit = candles[lastIndex];
  const reason = exit.closeTime >= deadline ? "TIME_LIMIT" : "DATA_END";
  return tradeResult(dataset, candidate, plan, entry, exit, exit.close, reason, options);
}

function tradeResult(
  dataset: HistoricalDataset,
  candidate: ReturnType<typeof rankCandidates>[number],
  plan: TradePlan,
  entry: Candle,
  exit: Candle,
  rawExitPrice: number,
  exitReason: BacktestTrade["exitReason"],
  options: {
    takerFeeRate: number;
    slippageBps: number;
  },
): BacktestTrade {
  const direction = candidate.side === "LONG" ? 1 : -1;
  const slippageRate = options.slippageBps / 10_000;
  const entryFillPrice = adverseFill(entry.open, direction, slippageRate, "entry");
  const exitFillPrice = adverseFill(rawExitPrice, direction, slippageRate, "exit");
  const quantity = plan.quantity;
  const grossPnlUsdt = (exitFillPrice - entryFillPrice) * direction * quantity;
  const feesUsdt = (Math.abs(entryFillPrice * quantity) + Math.abs(exitFillPrice * quantity)) * options.takerFeeRate;
  const fundingUsdt = calculateFunding(
    dataset.fundingRates ?? [],
    entry.openTime,
    exit.closeTime,
    entryFillPrice * quantity,
    direction,
  );
  const rawGrossPnlUsdt = (rawExitPrice - entry.open) * direction * quantity;
  const slippageUsdt = Math.max(0, rawGrossPnlUsdt - grossPnlUsdt);
  const pnlUsdt = grossPnlUsdt - feesUsdt + fundingUsdt;
  const rMultiple = plan.theoreticalRiskUsdt === 0 ? 0 : pnlUsdt / plan.theoreticalRiskUsdt;

  return {
    symbol: dataset.symbol,
    side: candidate.side,
    strategyFamily: candidate.strategyFamily,
    entryTime: entry.openTime,
    exitTime: exit.closeTime,
    score: candidate.score,
    entryPrice: entryFillPrice,
    exitPrice: exitFillPrice,
    rMultiple,
    pnlUsdt,
    grossPnlUsdt,
    feesUsdt,
    fundingUsdt,
    slippageUsdt,
    theoreticalRiskUsdt: plan.theoreticalRiskUsdt,
    exitReason,
  };
}

function adverseFill(
  price: number,
  direction: number,
  slippageRate: number,
  phase: "entry" | "exit",
): number {
  const signedSlippage = phase === "entry" ? direction : -direction;
  return price * (1 + signedSlippage * slippageRate);
}

function stopFillPrice(side: Side, candle: Candle, stopPrice: number): number {
  return side === "LONG"
    ? Math.min(candle.open, stopPrice)
    : Math.max(candle.open, stopPrice);
}

function rollingQuoteVolumeAtIndex(candles: Candle[], index: number, periods: number): number {
  let total = 0;
  const start = Math.max(0, index - periods + 1);
  for (let candleIndex = start; candleIndex <= index; candleIndex += 1) {
    const candle = candles[candleIndex];
    total += candle.close * candle.volume;
  }
  return total;
}

function calculateFunding(
  fundingRates: FundingRatePoint[],
  entryTime: number,
  exitTime: number,
  notionalUsdt: number,
  direction: number,
): number {
  return fundingRates
    .filter((point) => point.fundingTime > entryTime && point.fundingTime <= exitTime)
    .reduce((total, point) => total - direction * notionalUsdt * point.fundingRate, 0);
}

function summarizeMetrics(
  dataset: HistoricalDataset,
  trades: BacktestTrade[],
  input: {
    initialCapitalUsdt: number;
    minimumSampleDays: number;
    evaluationStartTime?: number;
    evaluationEndTime?: number;
  },
): BacktestMetrics {
  const first = input.evaluationStartTime ?? dataset.candles["15m"][0]?.openTime ?? 0;
  const last = input.evaluationEndTime !== undefined && Number.isFinite(input.evaluationEndTime)
    ? input.evaluationEndTime
    : dataset.candles["15m"].at(-1)?.closeTime ?? first;
  return summarizeTradeMetrics(trades, {
    initialCapitalUsdt: input.initialCapitalUsdt,
    minimumSampleDays: input.minimumSampleDays,
    evaluationStartTime: first,
    evaluationEndTime: last,
  });
}

function summarizeTradeMetrics(
  trades: BacktestTrade[],
  input: {
    initialCapitalUsdt: number;
    minimumSampleDays: number;
    evaluationStartTime: number;
    evaluationEndTime: number;
  },
): BacktestMetrics {
  const sampleDays = Math.max(0, (input.evaluationEndTime - input.evaluationStartTime) / 86_400_000);
  const ordered = [...trades].sort((left, right) => left.exitTime - right.exitTime || left.entryTime - right.entryTime);
  let equity = input.initialCapitalUsdt;
  let peakEquity = equity;
  let maxDrawdownUsdt = 0;
  for (const trade of ordered) {
    equity += trade.pnlUsdt;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peakEquity - equity);
  }
  const wins = trades.filter((trade) => trade.pnlUsdt > 0).length;
  const losses = trades.filter((trade) => trade.pnlUsdt < 0).length;
  const grossProfitUsdt = trades.filter((trade) => trade.pnlUsdt > 0).reduce((total, trade) => total + trade.pnlUsdt, 0);
  const grossLossUsdt = Math.abs(trades.filter((trade) => trade.pnlUsdt < 0).reduce((total, trade) => total + trade.pnlUsdt, 0));
  const netPnlUsdt = trades.reduce((total, trade) => total + trade.pnlUsdt, 0);
  const maxDrawdownPercent = input.initialCapitalUsdt === 0 ? 0 : maxDrawdownUsdt / input.initialCapitalUsdt * 100;

  return {
    sampleDays: round(sampleDays, 2),
    minimumSampleDays: input.minimumSampleDays,
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length === 0 ? 0 : round(wins / trades.length * 100, 2),
    netR: round(trades.reduce((total, trade) => total + trade.rMultiple, 0), 4),
    netPnlUsdt: round(netPnlUsdt, 4),
    grossProfitUsdt: round(grossProfitUsdt, 4),
    grossLossUsdt: round(grossLossUsdt, 4),
    totalFeesUsdt: round(trades.reduce((total, trade) => total + trade.feesUsdt, 0), 4),
    totalFundingUsdt: round(trades.reduce((total, trade) => total + trade.fundingUsdt, 0), 4),
    totalSlippageUsdt: round(trades.reduce((total, trade) => total + trade.slippageUsdt, 0), 4),
    profitFactor: grossLossUsdt === 0 ? (grossProfitUsdt > 0 ? 999 : 0) : round(grossProfitUsdt / grossLossUsdt, 4),
    maxDrawdownPercent: round(maxDrawdownPercent, 4),
    maxDrawdownUsdt: round(maxDrawdownUsdt, 4),
    finalEquityUsdt: round(equity, 4),
    initialCapitalUsdt: input.initialCapitalUsdt,
    eligible: sampleDays >= input.minimumSampleDays && maxDrawdownPercent <= 30,
  };
}

function upperBound(candles: Candle[], closeTime: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].closeTime <= closeTime) low = middle + 1;
    else high = middle;
  }
  return low;
}

function lowerBound(candles: Candle[], closeTime: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].closeTime < closeTime) low = middle + 1;
    else high = middle;
  }
  return low;
}

function lowerBoundNumber(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function candlesStart(candles: Candle[]): number {
  return candles[0]?.openTime ?? 0;
}

function byEntryTime(left: BacktestTrade, right: BacktestTrade): number {
  return left.entryTime - right.entryTime || right.score - left.score || left.symbol.localeCompare(right.symbol);
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function findIndexAtOrAfter(candles: HistoricalDataset["candles"]["15m"], timestamp: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].closeTime < timestamp) low = middle + 1;
    else high = middle;
  }
  return low >= candles.length ? candles.length - 1 : low;
}

function lastIndexAtOrBefore(candles: HistoricalDataset["candles"]["15m"], timestamp: number): number {
  let low = 0;
  let high = candles.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].closeTime <= timestamp) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
