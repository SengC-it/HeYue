import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildCandidateCache,
  buildDynamicUniverseByTimestamp,
  buildGlobalRegimeByTimestamp,
  runPortfolioBacktest,
  type BacktestOptions,
} from "@/lib/backtest/engine";
import { assertHistoricalDatasetIntegrity } from "@/lib/backtest/data-integrity";
import type { BacktestTrade, HistoricalDataset } from "@/lib/backtest/types";
import { DEFAULT_STRATEGY_PARAMS, type StrategyParams } from "@/lib/core/strategies";
import type { Candle, MarketRegime, ScoredCandidate } from "@/lib/core/types";

const HISTORY_START = 1_723_169_699_999;
const HISTORY_END = 1_786_241_699_999;
const HISTORY_MONTHS = 24;
const EMBARGO_HOURS = 48;
const INITIAL_CAPITAL_USDT = 10_000;
const RISK_PER_TRADE_USDT = 50;
const SINGLE_SIGNAL_CAP_USDT = 50;
const DAILY_RISK_BUDGET_USDT = 600;
const MAX_POSITION_NOTIONAL_USDT = 10_000;
const MAX_HOLD_HOURS = 48;
const REWARD_RISK = 2;
const TAKER_FEE_RATE = 0.0004;
const BASELINE_SLIPPAGE_BPS = 2;
const OUTPUT_JSON = resolve("reports", "hy-r2b-frozen-short-oos-expansion.json");
const OUTPUT_MD = resolve("reports", "hy-r2b-frozen-short-oos-expansion.md");
const DATA_DIRECTORY = resolve("data", "hy-r2b-history-24m");
const CANDIDATE_CACHE_VERSION = "candidate-cache-v4";
const SLIPPAGE_BPS = [2, 5, 10];
const DATASET_COUNT_MINIMUM = 40;

type Stage = { id: string; start: number; end: number; note: string };

interface SummaryMetrics {
  trades: number;
  longTrades: number;
  shortTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  grossProfitUsdt: number;
  grossLossUsdt: number;
  profitFactor: number;
  netPnlUsdt: number;
  netR: number;
  expectancyRPerTrade: number;
  maxDrawdownUsdt: number;
  maxDrawdownPct: number;
  mtmDrawdownUsdt: number;
  mtmDrawdownPct: number;
  cvar95LossUsdt: number;
  cvar95LossR: number;
  averageRiskUsdt: number;
  averageHoldingHours: number;
  totalFeesUsdt: number;
  totalSlippageUsdt: number;
  totalFundingUsdt: number;
  positiveMonths: number;
  totalMonths: number;
  symbolBreadth: number;
  regimeBreadth: number;
  maxSymbolTradeConcentrationPct: number;
  maxSymbolPnlConcentrationPct: number;
  maxMonthlyTradeConcentrationPct: number;
}

interface RunArtifact {
  metrics: SummaryMetrics;
  rawTradeCount: number;
  trades: BacktestTrade[];
}

interface Bundle {
  datasets: HistoricalDataset[];
  candidateCaches: Array<Map<number, ScoredCandidate[]>>;
  dynamicUniverse: Map<number, Set<string>>;
  globalRegime: Map<number, MarketRegime>;
  tradeRegime: Map<string, MarketRegime>;
  symbols: string[];
  entryTimes: number[];
  availableByMonth: Array<{ month: string; symbolsAvailable: number; symbols: string[] }>;
}

interface CachePayload {
  version?: string;
  descriptor?: string;
  entries?: Array<[number, ScoredCandidate[]]>;
}

const FROZEN_PARAMS: StrategyParams = {
  ...DEFAULT_STRATEGY_PARAMS,
  entryMode: "TREND_PULLBACK",
  stopAtrMultiplier: 0.75,
};

async function main(): Promise<void> {
  const bundle = await loadBundle();
  const stages = buildStages();
  const runCache = new Map<string, RunArtifact>();
  const run = (stage: Stage, slippageBps: number): RunArtifact => {
    const key = `${stage.id}:${stage.start}:${stage.end}:${slippageBps}`;
    const cached = runCache.get(key);
    if (cached) return cached;
    const options: BacktestOptions = {
      initialCapitalUsdt: INITIAL_CAPITAL_USDT,
      minScore: 80,
      maxHoldHours: MAX_HOLD_HOURS,
      minimumSampleDays: 0,
      singleSignalRiskCapUsdt: SINGLE_SIGNAL_CAP_USDT,
      dailyRiskBudgetUsdt: DAILY_RISK_BUDGET_USDT,
      dailyLossLimitUsdt: Number.MAX_SAFE_INTEGER,
      maxConcurrentPositions: Number.MAX_SAFE_INTEGER,
      maxEmailsPerDay: Number.MAX_SAFE_INTEGER,
      maxEmailsPerScan: Number.MAX_SAFE_INTEGER,
      capitalFloorUsdt: 0,
      marginUsdt: 100,
      leverage: 20,
      takerFeeRate: TAKER_FEE_RATE,
      slippageBps,
      // Preserve the frozen eligibility sample during cost stress.
      selectionTakerFeeRate: TAKER_FEE_RATE,
      selectionSlippageBps: BASELINE_SLIPPAGE_BPS,
      entryDelayBars: 1,
      evaluationStartTime: stage.start,
      evaluationEndTime: stage.end,
      riskPerTradeUsdt: RISK_PER_TRADE_USDT,
      maxPositionNotionalUsdt: MAX_POSITION_NOTIONAL_USDT,
      rewardRisk: REWARD_RISK,
      cooldownHours: 24,
      maxExecutionCostRiskFraction: 0.1,
      strategyFamilies: ["TREND"],
      sideFilter: "SHORT",
      requireRegimeAlignment: true,
      dynamicUniverseByTimestamp: bundle.dynamicUniverse,
      dynamicUniverseLookbackDays: 1,
      globalReferenceSymbol: "BTCUSDT",
      globalReferenceTimeframe: "4h",
      globalRegimeAlignment: true,
      globalRegimeByTimestamp: bundle.globalRegime,
      candidateCaches: bundle.candidateCaches,
    };
    const result = runPortfolioBacktest(bundle.datasets, FROZEN_PARAMS, options);
    const artifact: RunArtifact = {
      metrics: summarizeTrades(result.trades, stage.start, stage.end, bundle.datasets),
      rawTradeCount: result.rawTrades.length,
      trades: result.trades,
    };
    runCache.set(key, artifact);
    return artifact;
  };

  const oosBySlippage = Object.fromEntries(SLIPPAGE_BPS.map((slippage) => {
    const artifact = run(stages.aggregateOos, slippage);
    return [String(slippage), { metrics: artifact.metrics, rawTradeCount: artifact.rawTradeCount }];
  }));
  const foldResults = stages.folds.map((fold) => {
    const artifacts = Object.fromEntries(SLIPPAGE_BPS.map((slippage) => {
      const artifact = run(fold, slippage);
      return [String(slippage), { metrics: artifact.metrics, rawTradeCount: artifact.rawTradeCount }];
    }));
    return {
      id: fold.id,
      start: new Date(fold.start).toISOString(),
      end: new Date(fold.end).toISOString(),
      note: fold.note,
      bySlippage: artifacts,
    };
  });
  const oosAt5 = run(stages.aggregateOos, 5);
  const robustness = Object.fromEntries(stages.robustness.map((stage) => {
    const artifact = run(stage, 5);
    return [stage.id, {
      start: new Date(stage.start).toISOString(),
      end: new Date(stage.end).toISOString(),
      metrics: artifact.metrics,
      rawTradeCount: artifact.rawTradeCount,
    }];
  }));
  const breakdowns = buildBreakdowns(oosAt5.trades, stages.aggregateOos, bundle);
  const largestSymbol = largestContribution(breakdowns.bySymbol);
  const largestMonth = largestContribution(breakdowns.byMonth);
  const classification = classify(oosBySlippage, foldResults, robustness);
  const report = {
    generatedAt: new Date().toISOString(),
    status: "COMPLETED",
    researchOnly: true,
    frozenModel: {
      id: "MODEL_A_BASELINE_SHORT",
      side: "SHORT",
      strategyFamily: "TREND",
      entryMode: "TREND_PULLBACK",
      minScore: 80,
      universe: "dynamic Top10",
      localRegimeAlignment: true,
      globalRegimeAlignment: true,
      globalReferenceSymbol: "BTCUSDT",
      globalReferenceTimeframe: "4h",
      cooldownHours: 24,
      rewardRisk: 2,
      maxHoldHours: 48,
      riskPerTradeUsdt: 50,
      singleSignalCapUsdt: 50,
      dailyRiskBudgetUsdt: 600,
      maxPositionNotionalUsdt: 10_000,
      leverage: 20,
      takerFeeRate: 0.0004,
      slippageBaselineBps: 2,
      maxExecutionCostRiskFraction: 0.1,
      parameterSearch: "NONE",
    },
    source: {
      productionBaselineSha: "06d9d66b4a0574afeaa798f962a2aa26347de1b8",
      productionStrategyVersion: "hy-paper-candidate-v2",
      productionStrategyStage: "PAPER",
      productionAutoTrading: false,
      currentWorkspaceHeadWasNotDeployed: true,
    },
    methodology: {
      historicalEvaluation: "Frozen model evaluated without fitting on the expanded window; no full-period parameter search.",
      executionSemantics: "Closed candle N information only; entry at N+1 OPEN; one TradePlan supplies entry/stop/TP/qty/notional/risk/cost/PnL.",
      exitSemantics: "Stop-first intrabar; gap-through stops fill at the worse open; max hold 48h.",
      walkForward: "Four chronological OOS folds; 48h purged boundary between adjacent folds. Aggregate OOS is one continuous run with state carried across the whole window.",
      costStress: "Same frozen eligibility sample selected at 2 bps, repriced at 2/5/10 bps; actual cached funding included.",
      portfolioControls: "Daily risk budget remains 600 USDT; no additional daily realized-loss gate, position-count hypothesis, or email-cap hypothesis is introduced.",
      rangeHandling: "No RANGE strategy was built or evaluated; RANGE remains an explicit opportunity gap.",
      mtmDrawdown: "15m close marks with cost/funding carry; quantity inferred from recorded gross PnL and filled entry/exit prices.",
      cvar95: "Average loss magnitude of the worst ceil(5%) trades.",
    },
    historicalCoverage: {
      evaluationStart: new Date(HISTORY_START).toISOString(),
      evaluationEnd: new Date(HISTORY_END).toISOString(),
      warmupStart: new Date(HISTORY_START - 14 * 86_400_000).toISOString(),
      reliableHistoryDays: round((HISTORY_END - HISTORY_START + 1) / 86_400_000, 4),
      requestedMonths: HISTORY_MONTHS,
      datasetCount: bundle.datasets.length,
      symbols: bundle.symbols,
      symbolsAvailablePerPeriod: bundle.availableByMonth,
      quoteVolumeSource: "Binance kline quoteVolume where available; no static current Top10 backfill.",
      listingDateLimitation: "The cohort is based on locally available/currently active USDT-M perpetual symbols; exchange listing-history metadata was not available, so survivorship and availability bias remain.",
      missingDataLimitation: "Only datasets passing OHLCV/funding monotonicity integrity checks were included; symbols begin at their first available historical candle and are not backfilled before listing.",
    },
    oos: {
      aggregateBySlippage: oosBySlippage,
      baseline2bps: oosBySlippage["2"],
      acceptance5bps: oosBySlippage["5"],
      stress10bps: oosBySlippage["10"],
      folds: foldResults,
      robustness,
      breakdowns,
      largestSymbolContribution: largestSymbol,
      largestMonthContribution: largestMonth,
    },
    acceptance: {
      preferredOosTrades: 100,
      strongEvidenceOosTrades: 150,
      oosTrades: oosAt5.metrics.trades,
      oosPf: oosAt5.metrics.profitFactor,
      oosExpectancyRPerTrade: oosAt5.metrics.expectancyRPerTrade,
      oosNetPnlUsdt: oosAt5.metrics.netPnlUsdt,
      positiveFoldsAt5bps: foldResults.filter((fold) => fold.bySlippage["5"].metrics.netPnlUsdt > 0).length,
      totalFolds: foldResults.length,
      positiveMonths: `${oosAt5.metrics.positiveMonths}/${oosAt5.metrics.totalMonths}`,
      largestSymbolContribution: largestSymbol,
      largestMonthContribution: largestMonth,
      classification,
      promotionRecommendation: classification === "ROBUST SHORT EDGE CONFIRMED"
        ? "RESEARCH CANDIDATE ONLY — separate ChatGPT acceptance is required before any strategy change"
        : "DO NOT PROMOTE — keep hy-paper-candidate-v2 unchanged",
    },
    productionAction: "NONE",
    productionModified: false,
    supabaseModified: false,
    vercelModified: false,
    productionEnvModified: false,
    strategyModified: false,
    autoTrading: false,
    hyR2ProductionStarted: false,
    stopAfterReport: true,
  };

  await writeFile(OUTPUT_JSON, JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(OUTPUT_MD, buildMarkdown(report), "utf8");
  console.info(JSON.stringify({
    ok: true,
    status: report.status,
    classification,
    historicalStart: report.historicalCoverage.evaluationStart,
    historicalEnd: report.historicalCoverage.evaluationEnd,
    datasetCount: report.historicalCoverage.datasetCount,
    oosAt5bps: oosAt5.metrics,
    reports: [OUTPUT_JSON, OUTPUT_MD],
  }, null, 2));
}

async function loadBundle(): Promise<Bundle> {
  const names = (await readdir(DATA_DIRECTORY)).filter((name) => name.endsWith(".json")).sort();
  if (names.length < DATASET_COUNT_MINIMUM) throw new Error(`Only ${names.length} expanded datasets are available`);
  const datasets: HistoricalDataset[] = [];
  for (const name of names) {
    const dataset = JSON.parse(await readFile(resolve(DATA_DIRECTORY, name), "utf8")) as HistoricalDataset;
    assertHistoricalDatasetIntegrity(dataset);
    if (dataset.candles["15m"].length < 80 || (dataset.candles["1h"]?.length ?? 0) < 80 || (dataset.candles["4h"]?.length ?? 0) < 80) {
      throw new Error(`Insufficient indicator history in ${dataset.symbol}`);
    }
    datasets.push(dataset);
  }
  if (!datasets.some((dataset) => dataset.symbol === "BTCUSDT")) throw new Error("BTCUSDT is required for global regime");
  const candidateCaches: Array<Map<number, ScoredCandidate[]>> = [];
  for (const dataset of datasets) candidateCaches.push(await loadCandidateCache(dataset));
  const entryTimes = [...new Set(datasets.flatMap((dataset, datasetIndex) => {
    const candles = dataset.candles["15m"];
    return [...candidateCaches[datasetIndex].keys()]
      .map((index) => candles[index]?.closeTime)
      .filter((timestamp): timestamp is number => timestamp !== undefined);
  }))].sort((left, right) => left - right);
  const dynamicUniverse = buildDynamicUniverseByTimestamp(datasets, entryTimes, 10, 1);
  const globalRegime = buildGlobalRegimeByTimestamp(datasets, entryTimes, "BTCUSDT", "4h");
  const tradeRegime = new Map<string, MarketRegime>();
  datasets.forEach((dataset, datasetIndex) => {
    const candles = dataset.candles["15m"];
    for (const index of candidateCaches[datasetIndex].keys()) {
      const entryTime = candles[index + 1]?.openTime;
      const sourceTime = candles[index]?.closeTime;
      const regime = sourceTime === undefined ? undefined : globalRegime.get(sourceTime);
      if (entryTime !== undefined && regime) tradeRegime.set(tradeKey(dataset.symbol, entryTime), regime);
    }
  });
  return {
    datasets,
    candidateCaches,
    dynamicUniverse,
    globalRegime,
    tradeRegime,
    symbols: datasets.map((dataset) => dataset.symbol),
    entryTimes,
    availableByMonth: buildAvailabilityByMonth(datasets),
  };
}

function buildStages(): { aggregateOos: Stage; folds: Stage[]; robustness: Stage[] } {
  const foldBoundaries = [0, 6, 12, 18, 24].map((months) => addMonths(HISTORY_START, months));
  const embargoMs = EMBARGO_HOURS * 3_600_000;
  const folds = Array.from({ length: 4 }, (_, index) => ({
    id: `oos-fold-${index + 1}`,
    start: foldBoundaries[index],
    end: index === 3 ? HISTORY_END : foldBoundaries[index + 1] - embargoMs,
    note: index === 0 ? "First chronological OOS fold." : "Chronological OOS fold after a 48h boundary purge.",
  }));
  const midpoint = addMonths(HISTORY_START, 12);
  const lastHalf = addMonths(HISTORY_START, 12);
  const lastQuarter = addMonths(HISTORY_START, 18);
  return {
    aggregateOos: { id: "aggregate-oos", start: HISTORY_START, end: HISTORY_END, note: "Continuous aggregate OOS; frozen model, no fitting." },
    folds,
    robustness: [
      { id: "first-half-oos", start: HISTORY_START, end: midpoint - embargoMs, note: "First 50% of the expanded OOS window." },
      { id: "second-half-oos", start: midpoint, end: HISTORY_END, note: "Second 50% of the expanded OOS window." },
      { id: "recent-50pct-oos", start: lastHalf, end: HISTORY_END, note: "Recent 50% robustness slice." },
      { id: "recent-25pct-oos", start: lastQuarter, end: HISTORY_END, note: "Recent 25% robustness slice." },
    ],
  };
}

function buildAvailabilityByMonth(datasets: HistoricalDataset[]): Array<{ month: string; symbolsAvailable: number; symbols: string[] }> {
  const months = monthKeysBetween(HISTORY_START, HISTORY_END);
  return months.map((month) => {
    const calendarStart = Date.parse(`${month}-01T00:00:00.000Z`);
    const calendarEnd = new Date(calendarStart);
    calendarEnd.setUTCMonth(calendarEnd.getUTCMonth() + 1);
    const start = Math.max(HISTORY_START, calendarStart);
    const end = Math.min(HISTORY_END, calendarEnd.getTime() - 1);
    const symbols = datasets
      .filter((dataset) => {
        const first = dataset.candles["15m"][0]?.openTime ?? Number.POSITIVE_INFINITY;
        const last = dataset.candles["15m"].at(-1)?.closeTime ?? 0;
        return first <= start && last >= end;
      })
      .map((dataset) => dataset.symbol)
      .sort();
    return { month, symbolsAvailable: symbols.length, symbols };
  });
}

async function loadCandidateCache(dataset: HistoricalDataset): Promise<Map<number, ScoredCandidate[]>> {
  const descriptor = JSON.stringify({
    version: CANDIDATE_CACHE_VERSION,
    symbol: dataset.symbol,
    windowEnd: HISTORY_END,
    params: JSON.stringify(FROZEN_PARAMS),
    dataFingerprint: historicalDatasetFingerprint(dataset),
  });
  const hash = createHash("sha256").update(descriptor).digest("hex").slice(0, 20);
  const cachePath = resolve("data", "candidate-cache", `${dataset.symbol}-${hash}.json`);
  try {
    const payload = JSON.parse(await readFile(cachePath, "utf8")) as CachePayload;
    if (payload.version === CANDIDATE_CACHE_VERSION && payload.descriptor === descriptor && Array.isArray(payload.entries)) return new Map(payload.entries);
  } catch {
    // Build in memory when the expanded research cache is absent.
  }
  return buildCandidateCache(dataset, FROZEN_PARAMS, HISTORY_END);
}

function buildBreakdowns(
  trades: BacktestTrade[],
  stage: Stage,
  bundle: Bundle,
): Record<string, Record<string, SummaryMetrics>> {
  const groupBy = (key: (trade: BacktestTrade) => string): Record<string, BacktestTrade[]> => {
    const result: Record<string, BacktestTrade[]> = {};
    for (const trade of trades) {
      const group = key(trade);
      result[group] ??= [];
      result[group].push(trade);
    }
    return result;
  };
  const summarizeGroups = (groups: Record<string, BacktestTrade[]>): Record<string, SummaryMetrics> => Object.fromEntries(
    Object.entries(groups).sort(([left], [right]) => left.localeCompare(right)).map(([key, group]) => [key, summarizeTrades(group, stage.start, stage.end, bundle.datasets)]),
  );
  const regime = (trade: BacktestTrade): string => bundle.tradeRegime.get(tradeKey(trade.symbol, trade.entryTime)) ?? "UNKNOWN";
  const monthGroups = groupBy((trade) => monthKey(trade.exitTime));
  const symbolGroups = groupBy((trade) => trade.symbol);
  const sideGroups = groupBy((trade) => trade.side);
  const regimeGroups = groupBy(regime);
  const scoreGroups = groupBy((trade) => scoreBucket(trade.score));
  for (const key of ["BULL", "BEAR", "RANGE", "UNKNOWN"]) regimeGroups[key] ??= [];
  for (const key of ["80-84.99", "85+"]) scoreGroups[key] ??= [];
  for (const key of monthKeysBetween(stage.start, stage.end)) monthGroups[key] ??= [];
  return {
    byMonth: summarizeGroups(monthGroups),
    bySymbol: summarizeGroups(symbolGroups),
    bySide: summarizeGroups(sideGroups),
    byBtcRegime: summarizeGroups(regimeGroups),
    byScoreBucket: summarizeGroups(scoreGroups),
  };
}

function summarizeTrades(trades: BacktestTrade[], start: number, end: number, datasets: HistoricalDataset[]): SummaryMetrics {
  const ordered = [...trades].sort((left, right) => left.exitTime - right.exitTime || left.entryTime - right.entryTime);
  const wins = trades.filter((trade) => trade.pnlUsdt > 0).length;
  const losses = trades.filter((trade) => trade.pnlUsdt < 0).length;
  const grossProfitUsdt = sum(trades.filter((trade) => trade.pnlUsdt > 0).map((trade) => trade.pnlUsdt));
  const grossLossUsdt = Math.abs(sum(trades.filter((trade) => trade.pnlUsdt < 0).map((trade) => trade.pnlUsdt)));
  const netPnlUsdt = sum(trades.map((trade) => trade.pnlUsdt));
  const netR = sum(trades.map((trade) => trade.rMultiple));
  const lossesBySeverity = [...trades].sort((left, right) => left.pnlUsdt - right.pnlUsdt).slice(0, Math.max(1, Math.ceil(trades.length * 0.05)));
  const monthlyPnl = groupPnl(trades, (trade) => monthKey(trade.exitTime));
  const symbolPnl = groupPnl(trades, (trade) => trade.symbol);
  const absPnl = sum(trades.map((trade) => Math.abs(trade.pnlUsdt)));
  const totalMonths = monthKeysBetween(start, end).length;
  return {
    trades: trades.length,
    longTrades: trades.filter((trade) => trade.side === "LONG").length,
    shortTrades: trades.filter((trade) => trade.side === "SHORT").length,
    wins,
    losses,
    winRatePct: round(trades.length === 0 ? 0 : wins / trades.length * 100, 4),
    grossProfitUsdt: round(grossProfitUsdt, 4),
    grossLossUsdt: round(grossLossUsdt, 4),
    profitFactor: grossLossUsdt === 0 ? (grossProfitUsdt > 0 ? 999 : 0) : round(grossProfitUsdt / grossLossUsdt, 4),
    netPnlUsdt: round(netPnlUsdt, 4),
    netR: round(netR, 4),
    expectancyRPerTrade: round(trades.length === 0 ? 0 : netR / trades.length, 6),
    maxDrawdownUsdt: round(drawdown(ordered.map((trade) => trade.pnlUsdt)), 4),
    maxDrawdownPct: round(drawdown(ordered.map((trade) => trade.pnlUsdt)) / INITIAL_CAPITAL_USDT * 100, 4),
    mtmDrawdownUsdt: round(markToMarketDrawdown(trades, datasets), 4),
    mtmDrawdownPct: round(markToMarketDrawdown(trades, datasets) / INITIAL_CAPITAL_USDT * 100, 4),
    cvar95LossUsdt: round(lossesBySeverity.length === 0 ? 0 : -sum(lossesBySeverity.map((trade) => trade.pnlUsdt)) / lossesBySeverity.length, 4),
    cvar95LossR: round(lossesBySeverity.length === 0 ? 0 : -sum(lossesBySeverity.map((trade) => trade.rMultiple)) / lossesBySeverity.length, 6),
    averageRiskUsdt: round(average(trades.map((trade) => trade.theoreticalRiskUsdt)), 4),
    averageHoldingHours: round(average(trades.map((trade) => (trade.exitTime - trade.entryTime) / 3_600_000)), 4),
    totalFeesUsdt: round(sum(trades.map((trade) => trade.feesUsdt)), 4),
    totalSlippageUsdt: round(sum(trades.map((trade) => trade.slippageUsdt)), 4),
    totalFundingUsdt: round(sum(trades.map((trade) => trade.fundingUsdt)), 4),
    positiveMonths: [...monthlyPnl.values()].filter((value) => value > 0).length,
    totalMonths,
    symbolBreadth: new Set(trades.map((trade) => trade.symbol)).size,
    regimeBreadth: new Set(trades.map((trade) => trade.side === "LONG" ? "BULL" : "BEAR")).size,
    maxSymbolTradeConcentrationPct: round(maxTradeShare(trades, (trade) => trade.symbol) * 100, 4),
    maxSymbolPnlConcentrationPct: round(maxAbsoluteShare(symbolPnl, absPnl) * 100, 4),
    maxMonthlyTradeConcentrationPct: round(maxTradeShare(trades, (trade) => monthKey(trade.exitTime)) * 100, 4),
  };
}

function markToMarketDrawdown(trades: BacktestTrade[], datasets: HistoricalDataset[]): number {
  if (trades.length === 0) return 0;
  const bySymbol = new Map(datasets.map((dataset) => [dataset.symbol, dataset]));
  const changes = new Map<number, { realized: number; markDelta: number }>();
  const add = (timestamp: number, realized: number, markDelta: number): void => {
    const current = changes.get(timestamp) ?? { realized: 0, markDelta: 0 };
    current.realized += realized;
    current.markDelta += markDelta;
    changes.set(timestamp, current);
  };
  for (const trade of trades) {
    const dataset = bySymbol.get(trade.symbol);
    if (!dataset) continue;
    const candles = dataset.candles["15m"];
    const direction = trade.side === "LONG" ? 1 : -1;
    const priceMove = (trade.exitPrice - trade.entryPrice) * direction;
    const quantity = Math.abs(priceMove) < 1e-12 ? 0 : Math.abs(trade.grossPnlUsdt / priceMove);
    const entryFee = trade.feesUsdt * Math.abs(trade.entryPrice) / Math.max(1e-12, Math.abs(trade.entryPrice) + Math.abs(trade.exitPrice));
    const entrySlippage = trade.slippageUsdt / 2;
    const notional = Math.abs(trade.entryPrice * quantity);
    let previousMark = -entryFee - entrySlippage;
    add(trade.entryTime, 0, previousMark);
    for (let index = lowerBoundOpenTime(candles, trade.entryTime); index < candles.length; index += 1) {
      const candle = candles[index];
      if (candle.closeTime >= trade.exitTime) break;
      const funding = (dataset.fundingRates ?? [])
        .filter((point) => point.fundingTime > trade.entryTime && point.fundingTime <= candle.closeTime)
        .reduce((total, point) => total - direction * notional * point.fundingRate, 0);
      const currentMark = (candle.close - trade.entryPrice) * direction * quantity - entryFee - entrySlippage + funding;
      add(candle.closeTime, 0, currentMark - previousMark);
      previousMark = currentMark;
    }
    add(trade.exitTime, trade.pnlUsdt, -previousMark);
  }
  let equity = INITIAL_CAPITAL_USDT;
  let peak = equity;
  let max = 0;
  for (const timestamp of [...changes.keys()].sort((left, right) => left - right)) {
    const change = changes.get(timestamp);
    if (!change) continue;
    equity += change.realized + change.markDelta;
    peak = Math.max(peak, equity);
    max = Math.max(max, peak - equity);
  }
  return max;
}

function classify(
  oosBySlippage: Record<string, { metrics: SummaryMetrics }>,
  folds: Array<{ bySlippage: Record<string, { metrics: SummaryMetrics }> }>,
  robustness: Record<string, { metrics: SummaryMetrics }>,
): "ROBUST SHORT EDGE CONFIRMED" | "SHORT EDGE WEAK / UNSTABLE" | "INSUFFICIENT SAMPLE" | "NO ROBUST EDGE" {
  const oos = oosBySlippage["5"].metrics;
  const positiveFolds = folds.filter((fold) => fold.bySlippage["5"].metrics.netPnlUsdt > 0).length;
  const recent = robustness["recent-50pct-oos"].metrics;
  if (oos.trades < 100) return "INSUFFICIENT SAMPLE";
  if (oos.netPnlUsdt > 0 && oos.profitFactor >= 1.2 && oos.expectancyRPerTrade > 0 && oosBySlippage["10"].metrics.netPnlUsdt > 0 && positiveFolds >= 3 && recent.netPnlUsdt > 0) return "ROBUST SHORT EDGE CONFIRMED";
  if (oos.netPnlUsdt > 0 || oos.profitFactor >= 1) return "SHORT EDGE WEAK / UNSTABLE";
  return "NO ROBUST EDGE";
}

function buildMarkdown(report: {
  status: string;
  source: { productionBaselineSha: string };
  historicalCoverage: { evaluationStart: string; evaluationEnd: string; reliableHistoryDays: number; datasetCount: number };
  frozenModel: { minScore: number; universe: string };
  oos: { acceptance5bps: { metrics: SummaryMetrics }; aggregateBySlippage: Record<string, { metrics: SummaryMetrics }>; largestSymbolContribution: Contribution; largestMonthContribution: Contribution; robustness: Record<string, { metrics: SummaryMetrics }> };
  acceptance: { classification: string; promotionRecommendation: string; positiveFoldsAt5bps: number; totalFolds: number };
}): string {
  const oos = report.oos.acceptance5bps.metrics;
  const symbol = report.oos.largestSymbolContribution;
  const month = report.oos.largestMonthContribution;
  return [
    "# HY-R2B Frozen Short OOS Expansion",
    "",
    `- Status: **${report.status}**`,
    `- Classification: **${report.acceptance.classification}**`,
    `- Frozen model: SHORT / TREND / TREND_PULLBACK / score >= ${report.frozenModel.minScore} / ${report.frozenModel.universe}`,
    `- Production baseline SHA: \`${report.source.productionBaselineSha}\``,
    `- Historical evaluation: ${report.historicalCoverage.evaluationStart} -> ${report.historicalCoverage.evaluationEnd} (${report.historicalCoverage.reliableHistoryDays} days; ${report.historicalCoverage.datasetCount} datasets)`,
    "",
    "## Aggregate OOS at 5 bps",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Trades | ${oos.trades} |`,
    `| Wins / losses | ${oos.wins} / ${oos.losses} |`,
    `| Win rate | ${format(oos.winRatePct)}% |`,
    `| PF | ${format(oos.profitFactor)} |`,
    `| Net PnL | ${format(oos.netPnlUsdt)} USDT |`,
    `| Net R / expectancy | ${format(oos.netR)} / ${format(oos.expectancyRPerTrade)} R/trade |`,
    `| Max DD / MTM DD | ${format(oos.maxDrawdownUsdt)} / ${format(oos.mtmDrawdownUsdt)} USDT |`,
    `| CVaR95 loss | ${format(oos.cvar95LossUsdt)} USDT |`,
    `| Positive months | ${oos.positiveMonths}/${oos.totalMonths} |`,
    `| Symbol breadth | ${oos.symbolBreadth} |`,
    `| Largest symbol | ${symbol.key} (${format(symbol.metrics.netPnlUsdt)} USDT; ${format(symbol.shareOfAbsolutePnlPct)}% abs-PnL share) |`,
    `| Largest month | ${month.key} (${format(month.metrics.netPnlUsdt)} USDT; ${format(month.shareOfAbsolutePnlPct)}% abs-PnL share) |`,
    "",
    "## Slippage sensitivity",
    "",
    "| Slippage | Trades | PF | Net PnL USDT |",
    "|---:|---:|---:|---:|",
    ...[2, 5, 10].map((bps) => {
      const metrics = report.oos.aggregateBySlippage[String(bps)].metrics;
      return `| ${bps} bps | ${metrics.trades} | ${format(metrics.profitFactor)} | ${format(metrics.netPnlUsdt)} |`;
    }),
    "",
    `Positive folds at 5 bps: ${report.acceptance.positiveFoldsAt5bps}/${report.acceptance.totalFolds}.`,
    `Promotion: **${report.acceptance.promotionRecommendation}.**`,
    "",
    "## Scope and safety",
    "",
    "- No parameter search, Production modification, Vercel action, Supabase action, env change, strategy activation, commit, or private Binance API call.",
    "- AUTO_TRADING remains FALSE; the existing PAPER strategy remains unchanged.",
    "- RANGE was not built; its opportunity gap remains explicitly untested.",
    "- Full fold/month/symbol/BTC-regime/score-bucket breakdowns and availability table are in the JSON report.",
    "",
    `- [hy-r2b-frozen-short-oos-expansion.json](${OUTPUT_JSON})`,
    `- [hy-r2b-frozen-short-oos-expansion.md](${OUTPUT_MD})`,
    "",
  ].join("\n");
}

interface Contribution {
  key: string;
  metrics: SummaryMetrics;
  shareOfAbsolutePnlPct: number;
}

function largestContribution(groups: Record<string, SummaryMetrics>): Contribution {
  const denominator = sum(Object.values(groups).map((metrics) => Math.abs(metrics.netPnlUsdt)));
  const entries = Object.entries(groups).filter(([, metrics]) => metrics.trades > 0);
  const [key, metrics] = [...entries].sort(([, left], [, right]) => right.netPnlUsdt - left.netPnlUsdt)[0] ?? ["NONE", emptyMetrics(0)];
  return { key, metrics, shareOfAbsolutePnlPct: round(denominator <= 0 ? 0 : Math.abs(metrics.netPnlUsdt) / denominator * 100, 4) };
}

function emptyMetrics(totalMonths: number): SummaryMetrics {
  return {
    trades: 0, longTrades: 0, shortTrades: 0, wins: 0, losses: 0, winRatePct: 0,
    grossProfitUsdt: 0, grossLossUsdt: 0, profitFactor: 0, netPnlUsdt: 0, netR: 0,
    expectancyRPerTrade: 0, maxDrawdownUsdt: 0, maxDrawdownPct: 0, mtmDrawdownUsdt: 0,
    mtmDrawdownPct: 0, cvar95LossUsdt: 0, cvar95LossR: 0, averageRiskUsdt: 0,
    averageHoldingHours: 0, totalFeesUsdt: 0, totalSlippageUsdt: 0, totalFundingUsdt: 0,
    positiveMonths: 0, totalMonths, symbolBreadth: 0, regimeBreadth: 0,
    maxSymbolTradeConcentrationPct: 0, maxSymbolPnlConcentrationPct: 0, maxMonthlyTradeConcentrationPct: 0,
  };
}

function historicalDatasetFingerprint(dataset: HistoricalDataset): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(dataset.instrument));
  for (const timeframe of ["15m", "1h", "4h"] as const) {
    hash.update(timeframe);
    for (const candle of dataset.candles[timeframe] ?? []) hash.update(`${candle.openTime},${candle.open},${candle.high},${candle.low},${candle.close},${candle.volume},${candle.quoteVolume ?? ""},${candle.closeTime};`);
  }
  for (const point of dataset.fundingRates ?? []) hash.update(`${point.fundingTime},${point.fundingRate};`);
  return hash.digest("hex");
}

function addMonths(timestamp: number, months: number): number {
  const date = new Date(timestamp);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
}

function groupPnl<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of items) {
    const trade = item as BacktestTrade;
    result.set(key(item), (result.get(key(item)) ?? 0) + trade.pnlUsdt);
  }
  return result;
}

function maxTradeShare(trades: BacktestTrade[], key: (trade: BacktestTrade) => string): number {
  if (trades.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const trade of trades) counts.set(key(trade), (counts.get(key(trade)) ?? 0) + 1);
  return Math.max(...counts.values()) / trades.length;
}

function maxAbsoluteShare(values: Map<string, number>, denominator: number): number {
  return denominator <= 0 || values.size === 0 ? 0 : Math.max(...[...values.values()].map((value) => Math.abs(value))) / denominator;
}

function drawdown(changes: number[]): number {
  let equity = INITIAL_CAPITAL_USDT;
  let peak = equity;
  let max = 0;
  for (const change of changes) {
    equity += change;
    peak = Math.max(peak, equity);
    max = Math.max(max, peak - equity);
  }
  return max;
}

function monthKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

function monthKeysBetween(start: number, end: number): string[] {
  const first = new Date(start);
  const cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
  const last = new Date(end);
  const keys: string[] = [];
  while (cursor <= last) {
    keys.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

function scoreBucket(score: number): string {
  return score < 85 ? "80-84.99" : "85+";
}

function tradeKey(symbol: string, entryTime: number): string {
  return `${symbol}:${entryTime}`;
}

function lowerBoundOpenTime(candles: Candle[], openTime: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].openTime < openTime) low = middle + 1;
    else high = middle;
  }
  return low;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function format(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : String(value);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
