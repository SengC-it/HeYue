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
import type { Candle, MarketRegime, ScoredCandidate, Side } from "@/lib/core/types";

const SOURCE_SHA = "06d9d66b4a0574afeaa798f962a2aa26347de1b8";
const DATA_WINDOW_START = 1_754_705_700_000;
const DATA_WINDOW_END = 1_786_241_699_999;
const EMBARGO_HOURS = 48;
const INITIAL_CAPITAL_USDT = 10_000;
const RISK_PER_TRADE_USDT = 50;
const SINGLE_SIGNAL_CAP_USDT = 50;
const DAILY_RISK_BUDGET_USDT = 600;
const MAX_POSITION_NOTIONAL_USDT = 10_000;
const MAX_HOLD_HOURS = 48;
const REWARD_RISK = 2;
const TAKER_FEE_RATE = 0.0004;
const SELECTION_SLIPPAGE_BPS = 2;
const CANDIDATE_CACHE_VERSION = "candidate-cache-v4";
const REPORT_JSON = resolve("reports", "hy-r2-multi-regime-research.json");
const REPORT_MD = resolve("reports", "hy-r2-multi-regime-research.md");

const SCORE_THRESHOLDS = [70, 75, 80, 85];
const UNIVERSE_SIZES = [10, 20, 30];
const SLIPPAGE_BPS = [2, 5, 10];

type ResearchModelId = "A_BASELINE_SHORT" | "B_SYMMETRIC_TREND" | "C_LONG_ONLY" | "D_NO_GLOBAL_CONTROL";
type StageId = "full" | "train" | "validation" | "outOfSample";

interface ResearchModel {
  id: ResearchModelId;
  label: string;
  sideFilter?: Side;
  globalRegimeAlignment: boolean;
}

interface Stage {
  id: StageId;
  start: number;
  end: number;
  note: string;
}

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

interface ResearchConfig {
  model: ResearchModelId;
  threshold: number;
  universeSize: number;
}

interface CandidateCachePayload {
  version?: string;
  descriptor?: string;
  entries?: Array<[number, ScoredCandidate[]]>;
}

interface DatasetBundle {
  datasets: HistoricalDataset[];
  candidateCaches: Array<Map<number, ScoredCandidate[]>>;
  dynamicUniverses: Map<number, Map<number, Set<string>>>;
  globalRegime: Map<number, MarketRegime>;
  symbols: string[];
  entryTimes: number[];
}

const MODELS: ResearchModel[] = [
  {
    id: "A_BASELINE_SHORT",
    label: "A baseline: BEAR -> SHORT, BULL/RANGE -> NO TRADE",
    sideFilter: "SHORT",
    globalRegimeAlignment: true,
  },
  {
    id: "B_SYMMETRIC_TREND",
    label: "B symmetric trend: BULL -> LONG, BEAR -> SHORT, RANGE -> NO TRADE",
    globalRegimeAlignment: true,
  },
  {
    id: "C_LONG_ONLY",
    label: "C long-only: BULL -> LONG, BEAR/RANGE -> NO TRADE",
    sideFilter: "LONG",
    globalRegimeAlignment: true,
  },
  {
    id: "D_NO_GLOBAL_CONTROL",
    label: "D research control: local regime only, no BTC global alignment; not promotable",
    globalRegimeAlignment: false,
  },
];

async function main(): Promise<void> {
  const params: StrategyParams = {
    ...DEFAULT_STRATEGY_PARAMS,
    entryMode: "TREND_PULLBACK",
    stopAtrMultiplier: 0.75,
  };
  const stages = buildStages();
  const bundle = await loadBundle(params);
  const runCache = new Map<string, RunArtifact>();

  const run = (config: ResearchConfig, stage: Stage, slippageBps: number): RunArtifact => {
    const cacheKey = [config.model, config.threshold, config.universeSize, stage.id, stage.start, stage.end, slippageBps].join(":");
    const cached = runCache.get(cacheKey);
    if (cached) return cached;
    const model = MODELS.find((item) => item.id === config.model);
    if (!model) throw new Error(`Unknown research model ${config.model}`);
    const options: BacktestOptions = {
      initialCapitalUsdt: INITIAL_CAPITAL_USDT,
      minScore: config.threshold,
      maxHoldHours: MAX_HOLD_HOURS,
      minimumSampleDays: 0,
      singleSignalRiskCapUsdt: SINGLE_SIGNAL_CAP_USDT,
      dailyRiskBudgetUsdt: DAILY_RISK_BUDGET_USDT,
      dailyLossLimitUsdt: DAILY_RISK_BUDGET_USDT,
      // HY-R2 uses the explicit risk budget rather than an unregistered
      // position-count or email-cap hypothesis.
      maxConcurrentPositions: Number.MAX_SAFE_INTEGER,
      maxEmailsPerDay: Number.MAX_SAFE_INTEGER,
      maxEmailsPerScan: Number.MAX_SAFE_INTEGER,
      capitalFloorUsdt: 0,
      marginUsdt: 100,
      leverage: 20,
      takerFeeRate: TAKER_FEE_RATE,
      slippageBps,
      // Stress runs reprice the same eligible opportunities selected at 2 bps.
      selectionTakerFeeRate: TAKER_FEE_RATE,
      selectionSlippageBps: SELECTION_SLIPPAGE_BPS,
      entryDelayBars: 1,
      evaluationStartTime: stage.start,
      evaluationEndTime: stage.end,
      riskPerTradeUsdt: RISK_PER_TRADE_USDT,
      maxPositionNotionalUsdt: MAX_POSITION_NOTIONAL_USDT,
      rewardRisk: REWARD_RISK,
      cooldownHours: 24,
      maxExecutionCostRiskFraction: 0.1,
      strategyFamilies: ["TREND"],
      sideFilter: model.sideFilter,
      requireRegimeAlignment: true,
      dynamicUniverseByTimestamp: bundle.dynamicUniverses.get(config.universeSize),
      dynamicUniverseLookbackDays: 1,
      globalReferenceSymbol: "BTCUSDT",
      globalReferenceTimeframe: "4h",
      globalRegimeAlignment: model.globalRegimeAlignment,
      globalRegimeByTimestamp: bundle.globalRegime,
      candidateCaches: bundle.candidateCaches,
    };
    const result = runPortfolioBacktest(bundle.datasets, params, options);
    const artifact: RunArtifact = {
      metrics: summarizeTrades(result.trades, stage.start, stage.end, bundle.datasets),
      rawTradeCount: result.rawTrades.length,
      trades: result.trades,
    };
    runCache.set(cacheKey, artifact);
    return artifact;
  };

  const selectionMatrix = MODELS.flatMap((model) => SCORE_THRESHOLDS.flatMap((threshold) => UNIVERSE_SIZES.map((universeSize) => {
    const config = { model: model.id, threshold, universeSize } satisfies ResearchConfig;
    const train = run(config, stages.train, 5);
    const validation = run(config, stages.validation, 5);
    return {
      ...config,
      modelLabel: model.label,
      train: train.metrics,
      validation: validation.metrics,
      validationGate: validationGate(validation.metrics),
    };
  })));

  const selectedConfigs = MODELS.map((model) => {
    const candidates = selectionMatrix.filter((item) => item.model === model.id);
    const selected = [...candidates].sort(compareSelectionCandidates)[0];
    if (!selected) throw new Error(`No selection candidate for ${model.id}`);
    return {
      model: selected.model,
      modelLabel: selected.modelLabel,
      threshold: selected.threshold,
      universeSize: selected.universeSize,
      train: selected.train,
      validation: selected.validation,
      validationGate: selected.validationGate,
    };
  });

  const modelResults = selectedConfigs.map((selected) => {
    const config = {
      model: selected.model,
      threshold: selected.threshold,
      universeSize: selected.universeSize,
    } satisfies ResearchConfig;
    const stagesResult = Object.fromEntries((Object.keys(stages) as StageId[]).map((stageId) => [
      stageId,
      Object.fromEntries(SLIPPAGE_BPS.map((slippageBps) => {
        const artifact = run(config, stages[stageId], slippageBps);
        return [String(slippageBps), {
          metrics: artifact.metrics,
          rawTradeCount: artifact.rawTradeCount,
        }];
      })),
    ]));
    return {
      model: selected.model,
      modelLabel: selected.modelLabel,
      selectedThreshold: selected.threshold,
      selectedUniverseSize: selected.universeSize,
      selection: {
        train: selected.train,
        validation: selected.validation,
        validationGate: selected.validationGate,
      },
      stages: stagesResult,
    };
  });

  const bestObserved = [...modelResults]
    .sort((left, right) => compareOos(left.stages.outOfSample["5"].metrics, right.stages.outOfSample["5"].metrics))[0];
  if (!bestObserved) throw new Error("No observed model result");
  const bestConfig = {
    model: bestObserved.model,
    threshold: bestObserved.selectedThreshold,
    universeSize: bestObserved.selectedUniverseSize,
  } satisfies ResearchConfig;
  const bestOos = run(bestConfig, stages.outOfSample, 5);
  const bestBreakdowns = buildBestBreakdowns(bestOos.trades, stages.outOfSample, bundle.datasets);
  const folds = buildFoldResults(bestConfig, stages, run);
  const universeSensitivity = UNIVERSE_SIZES.map((universeSize) => {
    const artifact = run({ ...bestConfig, universeSize }, stages.outOfSample, 5);
    return { universeSize, metrics: artifact.metrics, rawTradeCount: artifact.rawTradeCount };
  });
  const promotionAssessment = assessPromotion(bestObserved, modelResults, folds);
  const report = buildReport({
    params,
    stages,
    bundle,
    selectionMatrix,
    selectedConfigs,
    modelResults,
    bestObserved,
    bestBreakdowns,
    folds,
    universeSensitivity,
    promotionAssessment,
  });

  await writeFile(REPORT_JSON, JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(REPORT_MD, buildMarkdown(report), "utf8");
  console.info(JSON.stringify({
    ok: true,
    status: report.status,
    classification: report.finalClassification,
    bestObservedModel: report.bestObservedModel,
    bestOos: report.bestObservedOos,
    reports: [REPORT_JSON, REPORT_MD],
  }, null, 2));
}

function buildStages(): Record<StageId, Stage> {
  const validationStart = addMonths(DATA_WINDOW_START, 6);
  const oosStart = addMonths(DATA_WINDOW_START, 9);
  const embargoMs = EMBARGO_HOURS * 60 * 60 * 1000;
  return {
    full: { id: "full", start: DATA_WINDOW_START, end: DATA_WINDOW_END, note: "Descriptive full-window result; not used for model selection." },
    train: { id: "train", start: DATA_WINDOW_START, end: validationStart - embargoMs, note: "First six months; selection input only." },
    validation: { id: "validation", start: validationStart, end: oosStart - embargoMs, note: "Middle three months after a 48h purge; selection input only." },
    outOfSample: { id: "outOfSample", start: oosStart, end: DATA_WINDOW_END, note: "Final three months after a 48h purge; held out from selection." },
  };
}

async function loadBundle(params: StrategyParams): Promise<DatasetBundle> {
  const names = (await readdir(resolve("data", "validation-cache")))
    .filter((name) => name.endsWith(`-${DATA_WINDOW_START}-${DATA_WINDOW_END}.json`))
    .sort();
  if (names.length < 40) throw new Error(`Expected a broad validation cohort, found only ${names.length} datasets`);
  const datasets: HistoricalDataset[] = [];
  for (const name of names) {
    const dataset = JSON.parse(await readFile(resolve("data", "validation-cache", name), "utf8")) as HistoricalDataset;
    assertHistoricalDatasetIntegrity(dataset);
    datasets.push(dataset);
  }
  const candidateCaches: Array<Map<number, ScoredCandidate[]>> = [];
  for (const dataset of datasets) {
    candidateCaches.push(await loadOrBuildCandidateCache(dataset, params));
  }
  const entryTimes = [...new Set(datasets.flatMap((dataset, index) => {
    const candles = dataset.candles["15m"];
    return [...candidateCaches[index].keys()]
      .map((candleIndex) => candles[candleIndex]?.closeTime)
      .filter((timestamp): timestamp is number => timestamp !== undefined);
  }))].sort((left, right) => left - right);
  const dynamicUniverses = new Map<number, Map<number, Set<string>>>();
  for (const universeSize of UNIVERSE_SIZES) {
    dynamicUniverses.set(universeSize, buildDynamicUniverseByTimestamp(datasets, entryTimes, universeSize, 1));
  }
  const globalRegime = buildGlobalRegimeByTimestamp(datasets, entryTimes, "BTCUSDT", "4h");
  return {
    datasets,
    candidateCaches,
    dynamicUniverses,
    globalRegime,
    symbols: datasets.map((dataset) => dataset.symbol),
    entryTimes,
  };
}

async function loadOrBuildCandidateCache(
  dataset: HistoricalDataset,
  params: StrategyParams,
): Promise<Map<number, ScoredCandidate[]>> {
  const paramsKey = JSON.stringify(params);
  const descriptor = JSON.stringify({
    version: CANDIDATE_CACHE_VERSION,
    symbol: dataset.symbol,
    windowEnd: DATA_WINDOW_END,
    params: paramsKey,
    dataFingerprint: historicalDatasetFingerprint(dataset),
  });
  const hash = createHash("sha256").update(descriptor).digest("hex").slice(0, 20);
  const cachePath = resolve("data", "candidate-cache", `${dataset.symbol}-${hash}.json`);
  try {
    const payload = JSON.parse(await readFile(cachePath, "utf8")) as CandidateCachePayload;
    if (payload.version === CANDIDATE_CACHE_VERSION && payload.descriptor === descriptor && Array.isArray(payload.entries)) {
      return new Map(payload.entries);
    }
  } catch {
    // Build below when an old or absent research cache is encountered.
  }
  return buildCandidateCache(dataset, params, DATA_WINDOW_END);
}

function buildFoldResults(
  config: ResearchConfig,
  stages: Record<StageId, Stage>,
  run: (config: ResearchConfig, stage: Stage, slippageBps: number) => RunArtifact,
): Array<{ id: string; start: string; end: string; metrics: SummaryMetrics; rawTradeCount: number }> {
  const quarterMs = Math.floor((stages.full.end - stages.full.start + 1) / 4);
  return Array.from({ length: 4 }, (_, index) => {
    const start = stages.full.start + index * quarterMs;
    const end = index === 3 ? stages.full.end : stages.full.start + (index + 1) * quarterMs - 1;
    const fold: Stage = { id: "full", start, end, note: "Chronological diagnostic fold." };
    const artifact = run(config, fold, 5);
    return {
      id: `q${index + 1}`,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      metrics: artifact.metrics,
      rawTradeCount: artifact.rawTradeCount,
    };
  });
}

function buildBestBreakdowns(
  trades: BacktestTrade[],
  stage: Stage,
  datasets: HistoricalDataset[],
): Record<string, Record<string, SummaryMetrics>> {
  const groups = (items: BacktestTrade[], key: (trade: BacktestTrade) => string): Record<string, BacktestTrade[]> => {
    const grouped: Record<string, BacktestTrade[]> = {};
    for (const item of items) {
      const group = key(item);
      grouped[group] ??= [];
      grouped[group].push(item);
    }
    return grouped;
  };
  const summarizeGroups = (grouped: Record<string, BacktestTrade[]>): Record<string, SummaryMetrics> => Object.fromEntries(
    Object.entries(grouped).sort(([left], [right]) => left.localeCompare(right)).map(([key, group]) => [
      key,
      summarizeTrades(group, stage.start, stage.end, datasets),
    ]),
  );
  return {
    byMonth: summarizeGroups(groups(trades, (trade) => monthKey(trade.exitTime))),
    bySymbol: summarizeGroups(groups(trades, (trade) => trade.symbol)),
    bySide: summarizeGroups(groups(trades, (trade) => trade.side)),
    byRegime: summarizeGroups(groups(trades, (trade) => trade.side === "LONG" ? "BULL" : "BEAR")),
    byScoreBucket: summarizeGroups(groups(trades, (trade) => scoreBucket(trade.score))),
  };
}

function summarizeTrades(
  trades: BacktestTrade[],
  start: number,
  end: number,
  datasets: HistoricalDataset[],
): SummaryMetrics {
  const orderedByExit = [...trades].sort((left, right) => left.exitTime - right.exitTime || left.entryTime - right.entryTime);
  const wins = trades.filter((trade) => trade.pnlUsdt > 0).length;
  const losses = trades.filter((trade) => trade.pnlUsdt < 0).length;
  const grossProfitUsdt = sum(trades.filter((trade) => trade.pnlUsdt > 0).map((trade) => trade.pnlUsdt));
  const grossLossUsdt = Math.abs(sum(trades.filter((trade) => trade.pnlUsdt < 0).map((trade) => trade.pnlUsdt)));
  const netPnlUsdt = sum(trades.map((trade) => trade.pnlUsdt));
  const netR = sum(trades.map((trade) => trade.rMultiple));
  const realizedDrawdown = drawdown(orderedByExit.map((trade) => trade.pnlUsdt));
  const mtmDrawdown = markToMarketDrawdown(trades, datasets);
  const lossTail = [...trades].sort((left, right) => left.pnlUsdt - right.pnlUsdt).slice(0, Math.max(1, Math.ceil(trades.length * 0.05)));
  const monthPnl = groupPnl(trades, (trade) => monthKey(trade.exitTime));
  const symbolPnl = groupPnl(trades, (trade) => trade.symbol);
  const absolutePnl = sum(trades.map((trade) => Math.abs(trade.pnlUsdt)));
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
    maxDrawdownUsdt: round(realizedDrawdown, 4),
    maxDrawdownPct: round(realizedDrawdown / INITIAL_CAPITAL_USDT * 100, 4),
    mtmDrawdownUsdt: round(mtmDrawdown, 4),
    mtmDrawdownPct: round(mtmDrawdown / INITIAL_CAPITAL_USDT * 100, 4),
    cvar95LossUsdt: round(lossTail.length === 0 ? 0 : -sum(lossTail.map((trade) => trade.pnlUsdt)) / lossTail.length, 4),
    cvar95LossR: round(lossTail.length === 0 ? 0 : -sum(lossTail.map((trade) => trade.rMultiple)) / lossTail.length, 6),
    averageRiskUsdt: round(average(trades.map((trade) => trade.theoreticalRiskUsdt)), 4),
    averageHoldingHours: round(average(trades.map((trade) => (trade.exitTime - trade.entryTime) / 3_600_000)), 4),
    totalFeesUsdt: round(sum(trades.map((trade) => trade.feesUsdt)), 4),
    totalSlippageUsdt: round(sum(trades.map((trade) => trade.slippageUsdt)), 4),
    totalFundingUsdt: round(sum(trades.map((trade) => trade.fundingUsdt)), 4),
    positiveMonths: [...monthPnl.values()].filter((value) => value > 0).length,
    totalMonths,
    symbolBreadth: new Set(trades.map((trade) => trade.symbol)).size,
    regimeBreadth: new Set(trades.map((trade) => trade.side === "LONG" ? "BULL" : "BEAR")).size,
    maxSymbolTradeConcentrationPct: round(maxShare(trades, (trade) => trade.symbol) * 100, 4),
    maxSymbolPnlConcentrationPct: round(maxAbsoluteShare(symbolPnl, absolutePnl) * 100, 4),
    maxMonthlyTradeConcentrationPct: round(maxShare(trades, (trade) => monthKey(trade.exitTime)) * 100, 4),
  };
}

function markToMarketDrawdown(trades: BacktestTrade[], datasets: HistoricalDataset[]): number {
  if (trades.length === 0) return 0;
  const bySymbol = new Map(datasets.map((dataset) => [dataset.symbol, dataset]));
  const equityChanges = new Map<number, { realized: number; mark: number }>();
  const addChange = (timestamp: number, realized: number, mark: number): void => {
    const current = equityChanges.get(timestamp) ?? { realized: 0, mark: 0 };
    current.realized += realized;
    current.mark += mark;
    equityChanges.set(timestamp, current);
  };
  for (const trade of trades) {
    const dataset = bySymbol.get(trade.symbol);
    if (!dataset) continue;
    const candles = dataset.candles["15m"];
    const direction = trade.side === "LONG" ? 1 : -1;
    const priceMove = (trade.exitPrice - trade.entryPrice) * direction;
    const quantity = Math.abs(priceMove) < 1e-12 ? 0 : Math.abs(trade.grossPnlUsdt / priceMove);
    const entryFeeShare = trade.feesUsdt * Math.abs(trade.entryPrice) / Math.max(1e-12, Math.abs(trade.entryPrice) + Math.abs(trade.exitPrice));
    const exitFeeShare = trade.feesUsdt - entryFeeShare;
    const entrySlippageShare = trade.slippageUsdt / 2;
    const notional = Math.abs(trade.entryPrice * quantity);
    let previousMark = -entryFeeShare - entrySlippageShare;
    addChange(trade.entryTime, 0, previousMark);
    const startIndex = lowerBoundOpenTime(candles, trade.entryTime);
    for (let index = startIndex; index < candles.length; index += 1) {
      const candle = candles[index];
      if (candle.closeTime >= trade.exitTime) break;
      const funding = (dataset.fundingRates ?? [])
        .filter((point) => point.fundingTime > trade.entryTime && point.fundingTime <= candle.closeTime)
        .reduce((total, point) => total - direction * notional * point.fundingRate, 0);
      const markGross = (candle.close - trade.entryPrice) * direction * quantity;
      const currentMark = markGross - entryFeeShare - entrySlippageShare + funding;
      addChange(candle.closeTime, 0, currentMark - previousMark);
      previousMark = currentMark;
    }
    // At the exit event the position leaves the MTM book and becomes realized.
    addChange(trade.exitTime, trade.pnlUsdt, -previousMark);
  }
  let equity = INITIAL_CAPITAL_USDT;
  let peak = equity;
  let maxDrawdown = 0;
  for (const timestamp of [...equityChanges.keys()].sort((left, right) => left - right)) {
    const change = equityChanges.get(timestamp);
    if (!change) continue;
    equity += change.realized + change.mark;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return maxDrawdown;
}

function assessPromotion(
  bestObserved: { model: ResearchModelId; selectedThreshold: number; selectedUniverseSize: number; stages: Record<string, Record<string, { metrics: SummaryMetrics }>> },
  modelResults: Array<{ model: ResearchModelId; stages: Record<string, Record<string, { metrics: SummaryMetrics }>> }>,
  folds: Array<{ metrics: SummaryMetrics }>,
): { finalClassification: string; bestRobustModel: string | null; recommendation: string; reasons: string[] } {
  const bestOos = bestObserved.stages.outOfSample["5"].metrics;
  const positiveFoldCount = folds.filter((fold) => fold.metrics.netPnlUsdt > 0).length;
  const stress = [2, 5, 10].map((slippage) => bestObserved.stages.outOfSample[String(slippage)].metrics);
  const hasPreferredSample = bestOos.trades >= 100;
  const robustCandidate = hasPreferredSample
    && bestOos.netPnlUsdt > 0
    && bestOos.profitFactor >= 1.2
    && bestOos.expectancyRPerTrade > 0
    && bestOos.maxDrawdownPct <= 30
    && positiveFoldCount >= 3
    && stress.every((metrics) => metrics.netPnlUsdt > 0 && metrics.profitFactor >= 1.1);
  const longMetrics = modelResults.find((result) => result.model === "C_LONG_ONLY")?.stages.outOfSample["5"].metrics;
  const shortMetrics = modelResults.find((result) => result.model === "A_BASELINE_SHORT")?.stages.outOfSample["5"].metrics;
  const longPass = longMetrics ? hasEdge(longMetrics) : false;
  const shortPass = shortMetrics ? hasEdge(shortMetrics) : false;
  let finalClassification: string;
  if (!hasPreferredSample) finalClassification = "INSUFFICIENT SAMPLE";
  else if (robustCandidate && longPass && shortPass) finalClassification = "ROBUST MULTI-REGIME EDGE FOUND";
  else if (robustCandidate && longPass && !shortPass) finalClassification = "LONG EDGE ONLY";
  else if (robustCandidate && shortPass && !longPass) finalClassification = "SHORT EDGE ONLY";
  else finalClassification = "NO ROBUST EDGE";
  const reasons = [
    `Best observed OOS sample at 5 bps: ${bestOos.trades} trades; preferred threshold is 100.`,
    `Best observed OOS net PnL ${formatNumber(bestOos.netPnlUsdt)} USDT, PF ${formatNumber(bestOos.profitFactor)}, expectancy ${formatNumber(bestOos.expectancyRPerTrade)} R/trade.`,
    `Positive chronological folds: ${positiveFoldCount}/${folds.length}.`,
    `Stress OOS net PnL at 2/5/10 bps: ${stress.map((metrics) => formatNumber(metrics.netPnlUsdt)).join(" / ")} USDT.`,
  ];
  return {
    finalClassification,
    bestRobustModel: robustCandidate ? bestObserved.model : null,
    recommendation: robustCandidate ? "RESEARCH CANDIDATE ONLY — requires separate ChatGPT acceptance before any strategy change" : "DO NOT PROMOTE — keep the existing PAPER strategy unchanged",
    reasons,
  };
}

function buildReport(input: {
  params: StrategyParams;
  stages: Record<StageId, Stage>;
  bundle: DatasetBundle;
  selectionMatrix: unknown[];
  selectedConfigs: unknown[];
  modelResults: unknown[];
  bestObserved: { model: ResearchModelId; selectedThreshold: number; selectedUniverseSize: number; stages: Record<string, Record<string, { metrics: SummaryMetrics }>> };
  bestBreakdowns: Record<string, Record<string, SummaryMetrics>>;
  folds: unknown[];
  universeSensitivity: unknown[];
  promotionAssessment: { finalClassification: string; bestRobustModel: string | null; recommendation: string; reasons: string[] };
}): Record<string, unknown> & { status: string; finalClassification: string; bestObservedModel: string; bestObservedOos: SummaryMetrics } {
  const bestOos = input.bestObserved.stages.outOfSample["5"].metrics;
  const modelAtOos = (id: ResearchModelId): SummaryMetrics | null => {
    const result = input.modelResults.find((item) => (item as { model?: string }).model === id) as { stages?: Record<string, Record<string, { metrics: SummaryMetrics }>> } | undefined;
    return result?.stages?.outOfSample?.["5"]?.metrics ?? null;
  };
  return {
    generatedAt: new Date().toISOString(),
    status: "COMPLETED",
    researchOnly: true,
    sourceSha: SOURCE_SHA,
    productionAnchor: {
      strategyVersion: "hy-paper-candidate-v2",
      strategyStage: "PAPER",
      currentSide: "SHORT",
      currentEntryMode: "TREND_PULLBACK",
      currentMinScore: 80,
      currentSupabaseProjectRef: "jfvbikivtpfjgfsnggiz",
      autoTrading: false,
      productionModified: false,
    },
    methodology: {
      models: MODELS,
      entrySemantics: "Signal uses a closed 15m candle N; fill is the next 15m OPEN (entryDelayBars=1); plan and fill share that entry price.",
      exitSemantics: "Stop-first intrabar; gap-through stop uses the worse open; max hold is 48h; no lookahead.",
      selection: "Threshold/universe selected on train then validation at 5 bps; final three months are held out OOS.",
      purging: `48h embargo between train/validation and validation/OOS; max hold ${MAX_HOLD_HOURS}h.`,
      costs: { takerFeeRate: TAKER_FEE_RATE, slippageBps: SLIPPAGE_BPS, selectionSlippageBps: SELECTION_SLIPPAGE_BPS, funding: "Actual cached funding observations; no synthetic fallback." },
      risk: { riskPerTradeUsdt: RISK_PER_TRADE_USDT, singleSignalCapUsdt: SINGLE_SIGNAL_CAP_USDT, dailyRiskBudgetUsdt: DAILY_RISK_BUDGET_USDT, maxPositionNotionalUsdt: MAX_POSITION_NOTIONAL_USDT, rewardRisk: REWARD_RISK, maxHoldHours: MAX_HOLD_HOURS, leverage: 20 },
      rangeHandling: "RANGE strategy is not built or evaluated; TREND_PULLBACK plus strict local alignment produces no RANGE opportunity. RANGE OPPORTUNITY GAP remains open.",
      mtmDrawdown: "15m close marks with fees/funding/slippage carried through the mark; gross quantity is inferred from the recorded trade gross PnL and filled entry/exit prices.",
      cvar95: "Average loss magnitude of the worst ceil(5%) trades; loss tail is reported as a positive magnitude.",
    },
    data: {
      window: { start: new Date(DATA_WINDOW_START).toISOString(), end: new Date(DATA_WINDOW_END).toISOString() },
      datasetCount: input.bundle.datasets.length,
      symbols: input.bundle.symbols,
      entryTimestampCount: input.bundle.entryTimes.length,
      candleCoverage: input.bundle.datasets.map((dataset) => ({ symbol: dataset.symbol, candles15m: dataset.candles["15m"].length, candles1h: dataset.candles["1h"]?.length ?? 0, candles4h: dataset.candles["4h"]?.length ?? 0, fundingRates: dataset.fundingRates?.length ?? 0 })),
      knownLimitations: [
        "The supplied cohort is not a complete historical Binance universe and can contain survivorship/availability bias.",
        "Dynamic top-10/top-20/top-30 ranking is limited to the supplied cohort; symbols absent from local cache are not represented.",
        "Legacy local candles use estimated close × base volume when quoteVolume is absent.",
        "This report is not an OOS claim for any parameter not selected without OOS labels; exploratory matrices are labeled as such.",
      ],
    },
    stages: Object.fromEntries(Object.entries(input.stages).map(([key, value]) => [key, { ...value, start: new Date(value.start).toISOString(), end: new Date(value.end).toISOString() }])),
    selectionMatrix: input.selectionMatrix,
    selectedConfigs: input.selectedConfigs,
    modelResults: input.modelResults,
    bestObservedModel: input.bestObserved.model,
    bestObservedConfig: { threshold: input.bestObserved.selectedThreshold, universeSize: input.bestObserved.selectedUniverseSize },
    bestObservedOos: bestOos,
    bestModelBreakdowns: input.bestBreakdowns,
    bestModelFolds: input.folds,
    bestModelUniverseSensitivityOos5bps: input.universeSensitivity,
    requiredComparison: {
      longResultOos5bps: modelAtOos("C_LONG_ONLY"),
      shortResultOos5bps: modelAtOos("A_BASELINE_SHORT"),
      regimeResultOos5bps: modelAtOos("B_SYMMETRIC_TREND"),
      controlResultOos5bps: modelAtOos("D_NO_GLOBAL_CONTROL"),
      slippageSensitivityBestObservedOos: Object.fromEntries(SLIPPAGE_BPS.map((slippage) => [String(slippage), input.bestObserved.stages.outOfSample[String(slippage)].metrics])),
      oosStability: input.folds,
    },
    finalClassification: input.promotionAssessment.finalClassification,
    promotionAssessment: input.promotionAssessment,
    productionAction: "NONE",
    supabaseModified: false,
    vercelDeployed: false,
    productionEnvModified: false,
    existingPaperStrategyModified: false,
    autoTrading: false,
    hyR2Started: true,
    stopAfterReport: true,
  };
}

function buildMarkdown(report: Record<string, unknown> & { finalClassification: string; bestObservedModel: string; bestObservedOos: SummaryMetrics }): string {
  const bestConfig = report.bestObservedConfig as { threshold: number; universeSize: number };
  const best = report.bestObservedOos;
  const comparison = report.requiredComparison as { longResultOos5bps: SummaryMetrics | null; shortResultOos5bps: SummaryMetrics | null; regimeResultOos5bps: SummaryMetrics | null; controlResultOos5bps: SummaryMetrics | null };
  const assessment = report.promotionAssessment as { recommendation: string; reasons: string[] };
  const lines = [
    "# HY-R2 Multi-Regime Profit Research",
    "",
    `- Status: **${report.status}**` ,
    `- Final classification: **${report.finalClassification}**`,
    `- Source SHA: \`${report.sourceSha}\``,
    `- Best observed model: **${report.bestObservedModel}**, threshold \`${bestConfig.threshold}\`, dynamic universe \`${bestConfig.universeSize}\``,
    "",
    "## Best observed held-out OOS at 5 bps",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Trades | ${best.trades} |`,
    `| Long / short | ${best.longTrades} / ${best.shortTrades} |`,
    `| Win rate | ${formatNumber(best.winRatePct)}% |`,
    `| Net PnL | ${formatNumber(best.netPnlUsdt)} USDT |`,
    `| Net R / expectancy | ${formatNumber(best.netR)} / ${formatNumber(best.expectancyRPerTrade)} R |`,
    `| Profit factor | ${formatNumber(best.profitFactor)} |`,
    `| Realized / MTM max DD | ${formatNumber(best.maxDrawdownUsdt)} / ${formatNumber(best.mtmDrawdownUsdt)} USDT |`,
    `| CVaR95 loss | ${formatNumber(best.cvar95LossUsdt)} USDT |`,
    `| Positive months | ${best.positiveMonths}/${best.totalMonths} |`,
    `| Symbol / regime breadth | ${best.symbolBreadth} / ${best.regimeBreadth} |`,
    "",
    "## Required model comparison",
    "",
    "| Model | OOS trades | Net PnL USDT | PF | Expectancy R |",
    "|---|---:|---:|---:|---:|",
    `| C long-only | ${comparison.longResultOos5bps?.trades ?? 0} | ${formatNumber(comparison.longResultOos5bps?.netPnlUsdt ?? 0)} | ${formatNumber(comparison.longResultOos5bps?.profitFactor ?? 0)} | ${formatNumber(comparison.longResultOos5bps?.expectancyRPerTrade ?? 0)} |`,
    `| A short baseline | ${comparison.shortResultOos5bps?.trades ?? 0} | ${formatNumber(comparison.shortResultOos5bps?.netPnlUsdt ?? 0)} | ${formatNumber(comparison.shortResultOos5bps?.profitFactor ?? 0)} | ${formatNumber(comparison.shortResultOos5bps?.expectancyRPerTrade ?? 0)} |`,
    `| B symmetric regime | ${comparison.regimeResultOos5bps?.trades ?? 0} | ${formatNumber(comparison.regimeResultOos5bps?.netPnlUsdt ?? 0)} | ${formatNumber(comparison.regimeResultOos5bps?.profitFactor ?? 0)} | ${formatNumber(comparison.regimeResultOos5bps?.expectancyRPerTrade ?? 0)} |`,
    `| D no-global control | ${comparison.controlResultOos5bps?.trades ?? 0} | ${formatNumber(comparison.controlResultOos5bps?.netPnlUsdt ?? 0)} | ${formatNumber(comparison.controlResultOos5bps?.profitFactor ?? 0)} | ${formatNumber(comparison.controlResultOos5bps?.expectancyRPerTrade ?? 0)} |`,
    "",
    "## Promotion assessment",
    "",
    `**${assessment.recommendation}.**`,
    "",
    ...assessment.reasons.map((reason) => `- ${reason}`),
    "",
    "## Safety and scope",
    "",
    "- No Vercel deployment, Production env change, Supabase migration/schema/data change, strategy activation, or private Binance API call was performed.",
    "- Existing Production strategy remains PAPER, `hy-paper-candidate-v2`, SHORT-only; `AUTO_TRADING=false`.",
    "- RANGE strategy was not built; this research records a RANGE opportunity gap only.",
    "- Full matrices, train/validation/OOS metrics, fold/month/symbol/side/regime/score-bucket breakdowns, and 2/5/10 bps sensitivity are in the JSON artifact.",
    "",
    "## Artifacts",
    "",
    `- [hy-r2-multi-regime-research.json](${REPORT_JSON})`,
    `- [hy-r2-multi-regime-research.md](${REPORT_MD})`,
    "",
  ];
  return lines.join("\n");
}

function validationGate(metrics: SummaryMetrics): boolean {
  return metrics.trades >= 20 && metrics.netPnlUsdt > 0 && metrics.profitFactor >= 1.1 && metrics.expectancyRPerTrade > 0;
}

function hasEdge(metrics: SummaryMetrics): boolean {
  return metrics.trades >= 100 && metrics.netPnlUsdt > 0 && metrics.profitFactor >= 1.2 && metrics.expectancyRPerTrade > 0;
}

function compareSelectionCandidates(
  left: { validation: SummaryMetrics; train: SummaryMetrics; validationGate: boolean },
  right: { validation: SummaryMetrics; train: SummaryMetrics; validationGate: boolean },
): number {
  const leftScore = selectionScore(left);
  const rightScore = selectionScore(right);
  return rightScore - leftScore || right.validation.netPnlUsdt - left.validation.netPnlUsdt || right.validation.trades - left.validation.trades;
}

function selectionScore(candidate: { validation: SummaryMetrics; train: SummaryMetrics; validationGate: boolean }): number {
  const stabilityBonus = candidate.train.netPnlUsdt > 0 ? 10_000 : 0;
  const gateBonus = candidate.validationGate ? 1_000_000 : 0;
  return gateBonus + stabilityBonus + candidate.validation.netPnlUsdt - candidate.validation.maxDrawdownUsdt;
}

function compareOos(left: SummaryMetrics, right: SummaryMetrics): number {
  return right.netPnlUsdt - left.netPnlUsdt || right.profitFactor - left.profitFactor || right.trades - left.trades;
}

function historicalDatasetFingerprint(dataset: HistoricalDataset): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(dataset.instrument));
  for (const timeframe of ["15m", "1h", "4h"] as const) {
    hash.update(timeframe);
    for (const candle of dataset.candles[timeframe] ?? []) {
      hash.update(`${candle.openTime},${candle.open},${candle.high},${candle.low},${candle.close},${candle.volume},${candle.quoteVolume ?? ""},${candle.closeTime};`);
    }
  }
  for (const point of dataset.fundingRates ?? []) hash.update(`${point.fundingTime},${point.fundingRate};`);
  return hash.digest("hex");
}

function addMonths(timestamp: number, months: number): number {
  const date = new Date(timestamp);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
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

function groupPnl<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of items) result.set(key(item), (result.get(key(item)) ?? 0) + ((item as BacktestTrade).pnlUsdt));
  return result;
}

function maxShare(items: BacktestTrade[], key: (item: BacktestTrade) => string): number {
  if (items.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return Math.max(...counts.values()) / items.length;
}

function maxAbsoluteShare(values: Map<string, number>, denominator: number): number {
  if (denominator <= 0 || values.size === 0) return 0;
  return Math.max(...[...values.values()].map((value) => Math.abs(value))) / denominator;
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
  if (score < 70) return "<70";
  if (score < 75) return "70-74.99";
  if (score < 80) return "75-79.99";
  if (score < 85) return "80-84.99";
  return "85+";
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

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : String(value);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
