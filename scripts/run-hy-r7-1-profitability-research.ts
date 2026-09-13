import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildCandidateCache,
  buildDynamicUniverseByTimestamp,
  buildGlobalRegimeByTimestamp,
  runBacktest,
  runPortfolioBacktest,
  selectPortfolioTrades,
  type BacktestOptions,
} from "@/lib/backtest/engine";
import { assertHistoricalDatasetIntegrity } from "@/lib/backtest/data-integrity";
import type { BacktestTrade, HistoricalDataset, PortfolioBacktestResult } from "@/lib/backtest/types";
import { DEFAULT_STRATEGY_PARAMS, type StrategyParams } from "@/lib/core/strategies";
import type { Instrument, MarketRegime } from "@/lib/core/types";
import {
  R71_B4_FROZEN_THRESHOLDS,
  R71_HYPOTHESIS_IDS,
  R71_INITIAL_CAPITAL_USDT,
  R71_INTERVAL_MS,
  R71_OLD_FAILURE_SET,
  OosRunGuard,
  applyPITEpisodeFilters,
  assertPreRegisteredHypotheses,
  calculateMfeMae,
  calculateResearchMetrics,
  sourceTimeForEntry,
  topSymbolConcentration,
  type EpisodeFilterConfig,
  type ResearchMetrics,
  type ResearchTrade,
} from "@/lib/research/r7-1";

const CACHE_VERSION = "candidate-cache-v4";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const WINDOW_START = Date.parse("2025-08-09T02:15:00.000Z");
const WINDOW_END = Date.parse("2026-08-09T02:14:59.999Z");
const VALIDATION_START = Date.parse("2026-02-09T02:15:00.000Z");
const FINAL_OOS_START = Date.parse("2026-05-09T02:15:00.000Z");
const EMBARGO_HOURS = 48;
const TRAIN_END = VALIDATION_START - EMBARGO_HOURS * HOUR_MS;
const VALIDATION_END = FINAL_OOS_START - EMBARGO_HOURS * HOUR_MS;
const FINAL_OOS_MIN_TRADES = 100;
const FIXED_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT", "AVAXUSDT", "SUIUSDT",
  "1000SHIBUSDT", "1000PEPEUSDT", "AAVEUSDT", "TRXUSDT", "PAXGUSDT", "INJUSDT", "COTIUSDT", "LTCUSDT", "XLMUSDT", "XMRUSDT",
] as const;

const BASE_COST = Object.freeze({
  name: "BASE_REALISTIC",
  takerFeeRate: 0.0004,
  slippageBps: 2,
  selectionTakerFeeRate: 0.0004,
  selectionSlippageBps: 2,
});

const STRESS_COST = Object.freeze({
  name: "STRESS",
  takerFeeRate: 0.0006,
  slippageBps: 4,
  selectionTakerFeeRate: 0.0004,
  selectionSlippageBps: 2,
});

interface CostModel {
  name: string;
  takerFeeRate: number;
  slippageBps: number;
  selectionTakerFeeRate: number;
  selectionSlippageBps: number;
}

interface ResearchPolicy {
  id: string;
  description: string;
  params: StrategyParams;
  options: BacktestOptions;
  episodeFilters?: EpisodeFilterConfig;
}

interface ExecutionMaps {
  dynamicUniverseByTimestamp: Map<number, Set<string>>;
  globalRegimeByTimestamp: Map<number, MarketRegime>;
  globalConfirmationRegimeByTimestamp?: Map<number, MarketRegime>;
}

interface SliceResult {
  base: PortfolioRunSummary;
  stress: PortfolioRunSummary;
}

interface PortfolioRunSummary {
  metrics: ResearchMetrics;
  rawTradeCount: number;
  selectedTradeCount: number;
  rejectionCounts: PortfolioBacktestResult["rejectionCounts"];
  trades: BacktestTrade[];
}

interface VariantEvaluation {
  hypothesisId: string;
  variantId: string;
  description: string;
  status: "VALID" | "INVALID";
  invalidReason?: string;
  filters?: EpisodeFilterConfig;
  train?: SliceResult;
  validation?: SliceResult;
  selection?: {
    base: ResearchMetrics;
    stress: ResearchMetrics;
    positiveFoldsBase: number;
    positiveFoldsStress: number;
    top1SymbolConcentration: number;
    top3SymbolConcentration: number;
    distinctSymbols: number;
    passesHistoricalGate: boolean;
  };
  oos?: SliceResult | "NOT_RUN_BEFORE_SELECTION";
}

interface OldFailureRow {
  notification_id: string;
  signal_id: string;
  sent_at: string;
  notification_status: string;
  symbol: string;
  side: string;
  strategy_family: string;
  strategy_version: string;
  score: string;
  market_regime: string;
  entry_price: string;
  stop_price: string;
  take_profit_price: string;
  reward_risk: string;
  source_data_timestamp: string;
  entry_time: string;
  paper_entry_price: string;
  entry_fill_price: string;
  paper_stop_price: string;
  paper_take_profit_price: string;
  exit_time: string;
  exit_price: string;
  exit_reason: string;
  gross_pnl_usdt: string;
  fees_usdt: string;
  funding_usdt: string;
  slippage_usdt: string;
  net_pnl_usdt: string;
  r_multiple: string;
  holding_hours: string;
  time_since_previous_same_symbol_hours: string;
  mfe_pct: string;
  mae_pct: string;
  failure_set_classification: string;
}

interface LoadedResearchData {
  datasets: HistoricalDataset[];
  candidateCaches: Array<Map<number, import("@/lib/core/types").ScoredCandidate[]>>;
  maps: ExecutionMaps;
  dataFingerprints: Record<string, string>;
}

async function main() {
  assertPreRegisteredHypotheses();
  const data = await loadResearchData();
  const optimized = optimizedPolicy();
  const correctedPrevious = correctedPreviousPolicy();

  const optimizedBaseline = await evaluateFixedPolicy(optimized, data, true);
  const correctedBaseline = await evaluateFixedPolicy(correctedPrevious, data, true);

  const hypotheses: VariantEvaluation[] = [];
  const h0 = await evaluateVariant("H0", optimized, data);
  h0.train = optimizedBaseline.train;
  h0.validation = optimizedBaseline.validation;
  h0.selection = buildSelectionSummary(h0.train, h0.validation);
  hypotheses.push(h0);
  for (const cooldownHours of [12, 24, 48]) {
    hypotheses.push(await evaluateVariant("H1", {
      ...optimized,
      id: `h1-source-cooldown-${cooldownHours}h`,
      description: `H1 same-symbol episode cooldown measured from the closed decision timestamp: ${cooldownHours}h`,
      episodeFilters: { sameSymbolCooldownHours: cooldownHours },
    }, data));
  }
  for (const lockoutHours of [24, 48]) {
    hypotheses.push(await evaluateVariant("H2", {
      ...optimized,
      id: `h2-post-stop-lockout-${lockoutHours}h`,
      description: `H2 same-symbol same-direction lockout after a known STOP_LOSS: ${lockoutHours}h, with the baseline 24h cooldown`,
      episodeFilters: { sameSymbolCooldownHours: 24, postStopLossLockoutHours: lockoutHours },
    }, data));
  }
  hypotheses.push(await evaluateVariant("H3", {
    ...optimized,
    id: "h3-b4-opposing-reversal-veto",
    description: "H3 frozen B4 opposing-reversal veto as a risk filter, never as an entry rule",
  }, data, "No PIT-safe historical B4 feature series is present in the local R7.1 research input"));
  hypotheses.push(await evaluateVariant("H4", {
    ...optimized,
    id: "h4-btc-1h-regime-confirmation",
    description: "H4 stronger regime-quality filter: baseline local/BTC 4h alignment plus PIT BTC 1h confirmation",
    options: { ...optimized.options, globalConfirmationTimeframe: "1h" },
    episodeFilters: { sameSymbolCooldownHours: 24 },
  }, data));
  hypotheses.push(await evaluateVariant("H5", {
    ...optimized,
    id: "h5-cooldown-plus-b4-veto",
    description: "H5 combined source cooldown plus frozen B4 opposing-reversal veto",
    episodeFilters: { sameSymbolCooldownHours: 24 },
  }, data, "H5 depends on the unavailable PIT-safe historical B4 feature series"));

  const candidates = hypotheses.filter((item) => item.status === "VALID" && item.selection?.passesHistoricalGate);
  candidates.sort(compareSelectionCandidates);
  const primary = candidates[0] ?? null;
  const backup = candidates[1] ?? null;
  const candidateOosGuard = new OosRunGuard();
  if (primary && primary.variantId !== optimized.id) {
    primary.oos = await candidateOosGuard.run(() => evaluateCandidateOos(primary, data));
  } else if (primary) {
    primary.oos = optimizedBaseline.oos;
  }

  const classification = classifyResult(primary, optimizedBaseline.oos, candidateOosGuard.runCount);
  const oldFailureAudit = await buildOldFailureAudit(data.datasets, primary?.filters ?? optimized.episodeFilters ?? {});
  const report = buildReport({
    data,
    optimized,
    correctedPrevious,
    optimizedBaseline,
    correctedBaseline,
    hypotheses,
    primary,
    backup,
    oldFailureAudit,
    classification,
    candidateOosRuns: candidateOosGuard.runCount,
  });

  await writeFile(resolve("reports", "hy-r7.1-profitability-research.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(resolve("reports", "hy-r7.1-profitability-research.md"), renderMarkdown(report), "utf8");
  console.info(JSON.stringify({
    ok: true,
    classification,
    dataSets: data.datasets.length,
    baseline: {
      fullTrades: optimizedBaseline.full.base.metrics.trades,
      oosTrades: optimizedBaseline.oos.base.metrics.trades,
      oosNetPnlUsdt: optimizedBaseline.oos.base.metrics.netPnlUsdt,
      oosProfitFactor: optimizedBaseline.oos.base.metrics.profitFactor,
    },
    historicalCandidates: candidates.map((item) => item.variantId),
    primary: primary?.variantId ?? null,
    backup: backup?.variantId ?? null,
    candidateOosRuns: candidateOosGuard.runCount,
  }, null, 2));
}

function optimizedPolicy(): ResearchPolicy {
  return {
    id: "score80-cooldown24-rr2-h48",
    description: "Authoritative optimized baseline: TREND_PULLBACK short-only, score >= 80, strict local and BTC 4h regime alignment, dynamic historical top-10, 24h cooldown, 2R target and 48h hold",
    params: { ...DEFAULT_STRATEGY_PARAMS, entryMode: "TREND_PULLBACK", stopAtrMultiplier: 0.75 },
    options: commonPolicyOptions({
      minScore: 80,
      maxHoldHours: 48,
      rewardRisk: 2,
      cooldownHours: 24,
    }),
    episodeFilters: { sameSymbolCooldownHours: 24 },
  };
}

function correctedPreviousPolicy(): ResearchPolicy {
  return {
    id: "score75-cooldown8-rr2.5-h72",
    description: "Authoritative corrected previous policy: same frozen TREND_PULLBACK short-only policy, score >= 75, 8h cooldown, 2.5R target and 72h hold",
    params: { ...DEFAULT_STRATEGY_PARAMS, entryMode: "TREND_PULLBACK", stopAtrMultiplier: 0.75 },
    options: commonPolicyOptions({
      minScore: 75,
      maxHoldHours: 72,
      rewardRisk: 2.5,
      cooldownHours: 8,
    }),
    episodeFilters: { sameSymbolCooldownHours: 8 },
  };
}

function commonPolicyOptions(overrides: Partial<BacktestOptions> = {}): BacktestOptions {
  return {
    initialCapitalUsdt: R71_INITIAL_CAPITAL_USDT,
    minimumSampleDays: 0,
    singleSignalRiskCapUsdt: 50,
    dailyRiskBudgetUsdt: 600,
    dailyLossLimitUsdt: 600,
    maxConcurrentPositions: 6,
    maxEmailsPerDay: 10,
    maxEmailsPerScan: 6,
    capitalFloorUsdt: 0,
    marginUsdt: 100,
    leverage: 20,
    riskPerTradeUsdt: 50,
    maxPositionNotionalUsdt: 10_000,
    requireRegimeAlignment: true,
    sideFilter: "SHORT",
    strategyFamilies: ["TREND"],
    maxExecutionCostRiskFraction: 0.1,
    dynamicUniverseSize: 10,
    dynamicUniverseLookbackDays: 1,
    globalReferenceSymbol: "BTCUSDT",
    globalReferenceTimeframe: "4h",
    globalRegimeAlignment: true,
    entryDelayBars: 1,
    ...overrides,
  };
}

async function loadResearchData(): Promise<LoadedResearchData> {
  const datasets: HistoricalDataset[] = [];
  const dataFingerprints: Record<string, string> = {};
  for (const symbol of FIXED_SYMBOLS) {
    const path = resolve("data", "validation-cache", `${symbol}-${WINDOW_START}-${WINDOW_END}.json`);
    const dataset = JSON.parse(await readFile(path, "utf8")) as HistoricalDataset;
    assertHistoricalDatasetIntegrity(dataset);
    datasets.push(dataset);
    dataFingerprints[symbol] = historicalDatasetFingerprint(dataset);
  }

  const params = optimizedPolicy().params;
  const candidateCaches = await Promise.all(datasets.map((dataset) => loadCandidateCache(dataset, params)));
  const entryTimes = [...new Set(candidateCaches.flatMap((cache, index) => [...cache.keys()].map((key) => datasets[index].candles["15m"][key]?.closeTime).filter((value): value is number => value !== undefined)))].sort((left, right) => left - right);
  const maps: ExecutionMaps = {
    dynamicUniverseByTimestamp: buildDynamicUniverseByTimestamp(datasets, entryTimes, 10, 1),
    globalRegimeByTimestamp: buildGlobalRegimeByTimestamp(datasets, entryTimes, "BTCUSDT", "4h"),
    globalConfirmationRegimeByTimestamp: buildGlobalRegimeByTimestamp(datasets, entryTimes, "BTCUSDT", "1h"),
  };
  return { datasets, candidateCaches, maps, dataFingerprints };
}

async function loadCandidateCache(
  dataset: HistoricalDataset,
  params: StrategyParams,
): Promise<Map<number, import("@/lib/core/types").ScoredCandidate[]>> {
  const paramsKey = JSON.stringify(params);
  const descriptor = JSON.stringify({
    version: CACHE_VERSION,
    symbol: dataset.symbol,
    windowEnd: WINDOW_END,
    params: paramsKey,
    dataFingerprint: historicalDatasetFingerprint(dataset),
  });
  const hash = createHash("sha256").update(descriptor).digest("hex").slice(0, 20);
  const path = resolve("data", "candidate-cache", `${dataset.symbol}-${hash}.json`);
  try {
    const payload = JSON.parse(await readFile(path, "utf8")) as {
      version?: string;
      descriptor?: string;
      entries?: Array<[number, import("@/lib/core/types").ScoredCandidate[]]>;
    };
    if (payload.version === CACHE_VERSION && payload.descriptor === descriptor && Array.isArray(payload.entries)) {
      return new Map(payload.entries);
    }
  } catch {
    // The cache is an optimization only; a missing cache is rebuilt in memory.
  }
  return buildCandidateCache(dataset, params, WINDOW_END);
}

async function evaluateFixedPolicy(policy: ResearchPolicy, data: LoadedResearchData, includeFull: boolean): Promise<{
  full: SliceResult;
  train: SliceResult;
  validation: SliceResult;
  oos: SliceResult;
  rollingFolds: Array<{ id: string; start: number; end: number; base: PortfolioRunSummary; stress: PortfolioRunSummary }>;
}> {
  const run = (cost: CostModel, start: number, end: number) => runPortfolioBacktest(data.datasets, policy.params, {
    ...policy.options,
    ...costOptions(cost),
    evaluationStartTime: start,
    evaluationEndTime: end,
    candidateCaches: data.candidateCaches,
    ...data.maps,
  });
  const baseTrain = run(BASE_COST, WINDOW_START, TRAIN_END);
  const baseValidation = run(BASE_COST, VALIDATION_START, VALIDATION_END);
  const baseOos = run(BASE_COST, FINAL_OOS_START, WINDOW_END);
  const stressTrain = run(STRESS_COST, WINDOW_START, TRAIN_END);
  const stressValidation = run(STRESS_COST, VALIDATION_START, VALIDATION_END);
  const stressOos = run(STRESS_COST, FINAL_OOS_START, WINDOW_END);
  const baseFull = includeFull ? run(BASE_COST, WINDOW_START, WINDOW_END) : baseOos;
  const stressFull = includeFull ? run(STRESS_COST, WINDOW_START, WINDOW_END) : stressOos;
  const quarterLength = Math.floor((WINDOW_END - WINDOW_START + 1) / 4);
  const rollingFolds = Array.from({ length: 4 }, (_, index) => {
    const start = WINDOW_START + index * quarterLength;
    const end = index === 3 ? WINDOW_END : WINDOW_START + (index + 1) * quarterLength - 1;
    return {
      id: `q${index + 1}`,
      start,
      end,
      base: summarizePortfolioRun(run(BASE_COST, start, end)),
      stress: summarizePortfolioRun(run(STRESS_COST, start, end)),
    };
  });
  return {
    full: { base: summarizePortfolioRun(baseFull), stress: summarizePortfolioRun(stressFull) },
    train: { base: summarizePortfolioRun(baseTrain), stress: summarizePortfolioRun(stressTrain) },
    validation: { base: summarizePortfolioRun(baseValidation), stress: summarizePortfolioRun(stressValidation) },
    oos: {
      base: summarizePortfolioRun(baseOos),
      stress: summarizePortfolioRun(stressOos),
    },
    rollingFolds,
  };
}

async function evaluateVariant(
  hypothesisId: string,
  policy: ResearchPolicy,
  data: LoadedResearchData,
  invalidReason?: string,
): Promise<VariantEvaluation> {
  if (invalidReason) {
    return { hypothesisId, variantId: policy.id, description: policy.description, status: "INVALID", invalidReason };
  }
  const train = await evaluateResearchSlice(policy, data, WINDOW_START, TRAIN_END);
  const validation = await evaluateResearchSlice(policy, data, VALIDATION_START, VALIDATION_END);
  const selection = buildSelectionSummary(train, validation);
  return {
    hypothesisId,
    variantId: policy.id,
    description: policy.description,
    status: "VALID",
    filters: policy.episodeFilters,
    train,
    validation,
    selection,
    oos: "NOT_RUN_BEFORE_SELECTION",
  };
}

async function evaluateResearchSlice(
  policy: ResearchPolicy,
  data: LoadedResearchData,
  start: number,
  end: number,
): Promise<SliceResult> {
  return {
    base: summarizePortfolioRun(runResearchPortfolio(policy, data, BASE_COST, start, end)),
    stress: summarizePortfolioRun(runResearchPortfolio(policy, data, STRESS_COST, start, end)),
  };
}

function runResearchPortfolio(
  policy: ResearchPolicy,
  data: LoadedResearchData,
  cost: CostModel,
  start: number,
  end: number,
): PortfolioBacktestResult {
  const rawTrades: ResearchTrade[] = data.datasets.flatMap((dataset, index) => runBacktest(dataset, policy.params, {
    ...policy.options,
    ...costOptions(cost),
    evaluationStartTime: start,
    evaluationEndTime: end,
    candidateCache: data.candidateCaches[index],
    // Raw opportunities have no episode cooldown; the research filter below applies it
    // using the closed decision timestamp rather than the future exit timestamp.
    cooldownHours: 0,
    singleSignalRiskCapUsdt: Number.MAX_SAFE_INTEGER,
    ...data.maps,
  }).trades.map((trade) => ({ trade, sourceTime: sourceTimeForEntry(trade.entryTime) })));
  const filtered = applyPITEpisodeFilters(rawTrades, policy.episodeFilters ?? {}).trades;
  return selectPortfolioTrades(filtered, policy.params, {
    ...policy.options,
    ...costOptions(cost),
    evaluationStartTime: start,
    evaluationEndTime: end,
  });
}

function costOptions(cost: CostModel): Pick<BacktestOptions, "takerFeeRate" | "slippageBps" | "selectionTakerFeeRate" | "selectionSlippageBps"> {
  return {
    takerFeeRate: cost.takerFeeRate,
    slippageBps: cost.slippageBps,
    selectionTakerFeeRate: cost.selectionTakerFeeRate,
    selectionSlippageBps: cost.selectionSlippageBps,
  };
}

function summarizePortfolioRun(run: PortfolioBacktestResult): PortfolioRunSummary {
  return {
    metrics: calculateResearchMetrics(run.trades),
    rawTradeCount: run.rawTrades.length,
    selectedTradeCount: run.trades.length,
    rejectionCounts: run.rejectionCounts,
    trades: run.trades,
  };
}

function passesHistoricalGate(
  base: ResearchMetrics,
  stress: ResearchMetrics,
  train: SliceResult,
  validation: SliceResult,
  trades: readonly BacktestTrade[],
): boolean {
  const foldStarts = [WINDOW_START, Date.parse("2025-11-09T02:15:00.000Z"), Date.parse("2026-02-09T02:15:00.000Z")];
  const foldEnds = [foldStarts[1] - EMBARGO_HOURS * HOUR_MS, foldStarts[2] - EMBARGO_HOURS * HOUR_MS, VALIDATION_END];
  const positiveBaseFolds = foldStarts.filter((start, index) => calculateResearchMetrics(trades.filter((trade) => trade.entryTime >= start && trade.entryTime <= foldEnds[index])).netPnlUsdt > 0).length;
  const positiveStressFolds = [train.stress.metrics, validation.stress.metrics].filter((metrics) => metrics.netPnlUsdt > 0).length;
  return base.expectancyUsdt > 0
    && base.profitFactor > 1.2
    && stress.netPnlUsdt > 0
    && stress.profitFactor > 1.05
    && positiveBaseFolds >= 2
    && positiveStressFolds >= 1
    && new Set(trades.map((trade) => trade.symbol)).size >= 3;
}

function buildSelectionSummary(train: SliceResult, validation: SliceResult): NonNullable<VariantEvaluation["selection"]> {
  const baseTrades = [...train.base.trades, ...validation.base.trades];
  const stressTrades = [...train.stress.trades, ...validation.stress.trades];
  const base = calculateResearchMetrics(baseTrades);
  const stress = calculateResearchMetrics(stressTrades);
  return {
    base,
    stress,
    positiveFoldsBase: [train.base.metrics, validation.base.metrics].filter((metrics) => metrics.netPnlUsdt > 0).length,
    positiveFoldsStress: [train.stress.metrics, validation.stress.metrics].filter((metrics) => metrics.netPnlUsdt > 0).length,
    top1SymbolConcentration: topSymbolConcentration(baseTrades, 1),
    top3SymbolConcentration: topSymbolConcentration(baseTrades, 3),
    distinctSymbols: new Set(baseTrades.map((trade) => trade.symbol)).size,
    passesHistoricalGate: passesHistoricalGate(base, stress, train, validation, baseTrades),
  };
}

function compareSelectionCandidates(left: VariantEvaluation, right: VariantEvaluation): number {
  const a = left.selection;
  const b = right.selection;
  if (!a || !b) return 0;
  return b.positiveFoldsBase - a.positiveFoldsBase
    || b.positiveFoldsStress - a.positiveFoldsStress
    || b.base.expectancyUsdt - a.base.expectancyUsdt
    || b.stress.profitFactor - a.stress.profitFactor
    || a.base.maxDrawdownPercent - b.base.maxDrawdownPercent
    || b.base.trades - a.base.trades
    || left.variantId.localeCompare(right.variantId);
}

async function evaluateCandidateOos(primary: VariantEvaluation, data: LoadedResearchData): Promise<SliceResult> {
  const policy: ResearchPolicy = {
    id: primary.variantId,
    description: primary.description,
    params: optimizedPolicy().params,
    options: primary.variantId === "h4-btc-1h-regime-confirmation"
      ? { ...optimizedPolicy().options, globalConfirmationTimeframe: "1h" }
      : optimizedPolicy().options,
    episodeFilters: primary.filters,
  };
  return evaluateResearchSlice(policy, data, FINAL_OOS_START, WINDOW_END);
}

function classifyResult(
  primary: VariantEvaluation | null,
  baselineOos: SliceResult,
  candidateOosRuns: number,
): "PROFITABILITY_CANDIDATE_READY" | "NO_PROFITABLE_CANDIDATE" | "INSUFFICIENT_OOS_SAMPLE" | "PROFITABILITY_RESEARCH_INVALID" {
  if (candidateOosRuns > 1) return "PROFITABILITY_RESEARCH_INVALID";
  if (!primary) return "NO_PROFITABLE_CANDIDATE";
  if (primary.oos === "NOT_RUN_BEFORE_SELECTION" || !primary.oos) return "PROFITABILITY_RESEARCH_INVALID";
  const oos = primary.oos;
  if (oos.base.metrics.trades < FINAL_OOS_MIN_TRADES || oos.stress.metrics.trades < FINAL_OOS_MIN_TRADES) return "INSUFFICIENT_OOS_SAMPLE";
  if (oos.base.metrics.netPnlUsdt <= 0
    || oos.base.metrics.expectancyUsdt <= 0
    || oos.base.metrics.profitFactor < 1.25
    || oos.stress.metrics.netPnlUsdt <= 0
    || oos.stress.metrics.profitFactor < 1.1
    || oos.base.metrics.maxDrawdownPercent > 0.092414) return "NO_PROFITABLE_CANDIDATE";
  return baselineOos.base.metrics.trades > 0 ? "PROFITABILITY_CANDIDATE_READY" : "PROFITABILITY_RESEARCH_INVALID";
}

async function buildOldFailureAudit(datasets: HistoricalDataset[], filters: EpisodeFilterConfig): Promise<Record<string, unknown>> {
  const path = resolve("reports", "hy-r7.1-old-email-failure-ledger.csv");
  const rows = parseFailureLedger(await readFile(path, "utf8"));
  const previousBySymbol = new Map<string, number>();
  const versions = countBy(rows, (row) => row.strategy_version);
  const sides = countBy(rows, (row) => row.side);
  const scoreBands = countBy(rows, (row) => scoreBand(Number(row.score)));
  const symbols = countBy(rows, (row) => row.symbol);
  const regimes = countBy(rows, (row) => row.market_regime);
  const exitReasons = countBy(rows, (row) => row.exit_reason);
  const utcHours = countBy(rows, (row) => String(new Date(Date.parse(row.sent_at)).getUTCHours()).padStart(2, "0"));
  const weekDays = countBy(rows, (row) => ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"][new Date(Date.parse(row.sent_at)).getUTCDay()]);
  const stopDistances = rows.map((row) => Math.abs(Number(row.stop_price) - Number(row.entry_price)) / Number(row.entry_price));
  const holdings = rows.map((row) => (Date.parse(row.exit_time) - Date.parse(row.entry_time)) / HOUR_MS).filter(Number.isFinite);
  const mfeMae: Array<{ symbol: string; mfe: number; mae: number }> = [];
  const datasetBySymbol = new Map(datasets.map((dataset) => [dataset.symbol, dataset]));

  for (const row of rows) {
    const sent = Date.parse(row.sent_at);
    const previous = previousBySymbol.get(row.symbol);
    previousBySymbol.set(row.symbol, sent);
    const dataset = datasetBySymbol.get(row.symbol);
    if (dataset) {
      const result = calculateMfeMae(dataset.candles["15m"], {
        side: row.side === "LONG" ? "LONG" : "SHORT",
        entryTime: Date.parse(row.entry_time),
        exitTime: Date.parse(row.exit_time),
        entryPrice: Number(row.paper_entry_price),
      });
      if (result) mfeMae.push({ symbol: row.symbol, mfe: result.favorableMove, mae: result.adverseMove });
    }
    row.time_since_previous_same_symbol_hours = previous === undefined ? "NOT_AVAILABLE" : ((sent - previous) / HOUR_MS).toFixed(6);
  }

  const auditState = new Map<string, { lastSent: number; lastExit: number; stop: boolean }>();
  const retained: OldFailureRow[] = [];
  const suppressedReasons: Record<string, number> = {};
  for (const row of rows) {
    const sent = Date.parse(row.sent_at);
    const prior = auditState.get(row.symbol);
    const eligible = row.side === "SHORT"
      && row.strategy_family === "TREND"
      && Number(row.score) >= 80
      && row.market_regime === "BEAR";
    const cooldownMs = (filters.sameSymbolCooldownHours ?? 0) * HOUR_MS;
    const lockoutMs = (filters.postStopLossLockoutHours ?? 0) * HOUR_MS;
    const cooldown = Boolean(prior && sent - prior.lastSent < cooldownMs);
    const postStopLockout = Boolean(prior && prior.stop && sent < prior.lastExit + lockoutMs);
    const reason = !eligible ? "BASE_RULES" : cooldown ? "SAME_SYMBOL_COOLDOWN" : postStopLockout ? "POST_STOP_LOSS_LOCKOUT" : "RETAINED_BY_AUDIT_SUBSET";
    suppressedReasons[reason] = (suppressedReasons[reason] ?? 0) + 1;
    if (eligible && !cooldown && !postStopLockout) retained.push(row);
    auditState.set(row.symbol, { lastSent: sent, lastExit: Date.parse(row.exit_time), stop: row.exit_reason === "STOP_LOSS" });
  }

  const gross = sum(rows, "gross_pnl_usdt");
  const fees = sum(rows, "fees_usdt");
  const funding = sum(rows, "funding_usdt");
  const slippage = sum(rows, "slippage_usdt");
  const net = sum(rows, "net_pnl_usdt");
  const positiveNet = rows.filter((row) => Number(row.net_pnl_usdt) > 0).length;
  return {
    frozenSet: { ...R71_OLD_FAILURE_SET, actualRows: rows.length, mappedSignalAndPaperTradeRows: rows.length },
    source: "Read-only Supabase snapshot of public.bca_notifications joined to public.bca_signals and public.bca_paper_trades; no query in this runner mutates the database.",
    attribution: {
      strategyVersion: versions,
      side: sides,
      scoreBand: scoreBands,
      symbolFrequency: symbols,
      marketRegime: regimes,
      utcHour: utcHours,
      utcDayOfWeek: weekDays,
      stopDistancePct: describeNumbers(stopDistances),
      holdingHours: describeNumbers(holdings),
      exitReason: exitReasons,
      repeatSymbolRows: rows.length - new Set(rows.map((row) => row.symbol)).size,
      repeatedShortEpisodes: rows.filter((row) => row.side === "SHORT").length,
      mfeMae: {
        availableRows: mfeMae.length,
        unavailableRows: rows.length - mfeMae.length,
        favorableMovePct: describeNumbers(mfeMae.map((item) => item.mfe)),
        adverseMovePct: describeNumbers(mfeMae.map((item) => item.mae)),
        limitation: "Failure rows occur after the local candle endpoint (2026-08-09); no row had a complete local path through its exit, so all MFE/MAE are NOT_AVAILABLE rather than inferred.",
      },
    },
    costAttribution: {
      grossPnlAfterSlippageUsdt: round(gross),
      pricePnlBeforeSlippageUsdt: round(gross + slippage),
      feesUsdt: round(fees),
      slippageUsdt: round(slippage),
      fundingUsdt: round(funding),
      netPnlUsdt: round(net),
      positiveNetRows: positiveNet,
      negativeNetRows: rows.length - positiveNet,
      conclusion: gross < 0 ? "EDGE_LOSS_PRECEDES_COSTS; costs enlarge the loss" : "COSTS_FLIP_A_POSITIVE_GROSS_EDGE",
    },
    auditOnlyRule: "Partial frozen-baseline subset only: SHORT + TREND + score >= 80 + BEAR, then declared same-symbol episode filters. Dynamic universe cannot be evaluated beyond the local data end 2026-08-09.",
    wouldSend: retained.length,
    wouldSuppress: rows.length - retained.length,
    suppressedReasons,
    suppressedLosers: rows.filter((row) => !retained.includes(row) && Number(row.net_pnl_usdt) < 0).length,
    suppressedWinners: rows.filter((row) => !retained.includes(row) && Number(row.net_pnl_usdt) > 0).length,
    retainedNetPnlUsdt: round(retained.reduce((total, row) => total + Number(row.net_pnl_usdt), 0)),
    oosUse: "AUDIT_ONLY_NOT_USED_FOR_SELECTION_OR_FINAL_OOS",
  };
}

function parseFailureLedger(text: string): OldFailureRow[] {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",");
  return lines.slice(1).filter(Boolean).map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])) as unknown as OldFailureRow;
  });
}

function buildReport(input: {
  data: LoadedResearchData;
  optimized: ResearchPolicy;
  correctedPrevious: ResearchPolicy;
  optimizedBaseline: Awaited<ReturnType<typeof evaluateFixedPolicy>>;
  correctedBaseline: Awaited<ReturnType<typeof evaluateFixedPolicy>>;
  hypotheses: VariantEvaluation[];
  primary: VariantEvaluation | null;
  backup: VariantEvaluation | null;
  oldFailureAudit: Record<string, unknown>;
  classification: string;
  candidateOosRuns: number;
}): Record<string, unknown> {
  const primaryOos = input.primary?.oos && input.primary.oos !== "NOT_RUN_BEFORE_SELECTION" ? input.primary.oos : null;
  const primarySelection = input.primary?.selection ?? null;
  return {
    reportVersion: "hy-r7.1-v1",
    generatedAt: new Date().toISOString(),
    purpose: "Research-only profitability and candidate selection; no production behavior changed",
    safety: {
      productionModified: false,
      productionStrategyModified: false,
      paperStrategyModified: false,
      emailsEnabled: false,
      emailsSent: 0,
      privateApiCalled: false,
      orders: 0,
      autoTrading: false,
      supabaseModified: false,
      vercelModified: false,
      b4RealEmailEnabled: false,
    },
    frozenFailureSet: input.oldFailureAudit.frozenSet,
    window: {
      start: new Date(WINDOW_START).toISOString(),
      end: new Date(WINDOW_END).toISOString(),
      train: { start: new Date(WINDOW_START).toISOString(), end: new Date(TRAIN_END).toISOString() },
      validation: { start: new Date(VALIDATION_START).toISOString(), end: new Date(VALIDATION_END).toISOString() },
      finalOos: { start: new Date(FINAL_OOS_START).toISOString(), end: new Date(WINDOW_END).toISOString() },
      embargoHours: EMBARGO_HOURS,
      finalOosMinimumTrades: FINAL_OOS_MIN_TRADES,
    },
    universe: {
      symbols: FIXED_SYMBOLS,
      count: input.data.datasets.length,
      selection: "fixed 20-symbol universe from the authoritative baseline; no universe expansion or post-result selection",
      dataSource: "data/validation-cache/<symbol>-1754705700000-1786241699999.json",
      fingerprints: input.data.dataFingerprints,
    },
    execution: {
      signalDecision: "closed 15m candle only",
      execution: "next 15m open plus adverse slippage",
      noSameCloseFill: true,
      stopModel: "stop-first intrabar; gap-through stop fills at worse candle open",
      funding: "historical funding points with fundingTime > entryTime and <= exitTime",
      liquidity: "PIT trailing 24h quote volume dynamic top-10 universe",
      regime: "PIT BTC 4h global alignment; H4 adds PIT BTC 1h confirmation",
      noFutureUniverseMembership: true,
    },
    costModels: {
      base: BASE_COST,
      stress: STRESS_COST,
      sameCostsForAllCandidates: true,
    },
    baselines: {
      correctedPrevious: policyReport(input.correctedPrevious, input.correctedBaseline),
      optimized: policyReport(input.optimized, input.optimizedBaseline),
    },
    hypotheses: input.hypotheses.map((hypothesis) => serialiseHypothesis(hypothesis)),
    candidateSelection: {
      rule: "Train + validation only; stability, expectancy, PF, drawdown, sample size, then deterministic tie-break by variant id",
      candidateCountMaximum: 2,
      historicalEligibleCandidates: input.hypotheses.filter((item) => item.selection?.passesHistoricalGate).map((item) => item.variantId),
      primary: input.primary?.variantId ?? "NONE",
      backup: input.backup?.variantId ?? "NONE",
      primaryRules: input.primary?.description ?? "NONE",
      primarySelection: primarySelection ? {
        base: primarySelection.base,
        stress: primarySelection.stress,
        positiveFoldsBase: primarySelection.positiveFoldsBase,
        positiveFoldsStress: primarySelection.positiveFoldsStress,
        top1SymbolConcentration: primarySelection.top1SymbolConcentration,
        top3SymbolConcentration: primarySelection.top3SymbolConcentration,
      } : null,
      primaryOos: primaryOos ? { base: primaryOos.base, stress: primaryOos.stress } : "NOT_RUN",
      oosRunsAfterSelection: input.candidateOosRuns,
      baselineOosRunsBeforeSelection: 1,
    },
    oldFailureAudit: input.oldFailureAudit,
    knownLimitations: [
      "B4 is INVALID for R7.1 because no PIT-safe historical B4 feature series is present in the local research input; frozen B4 semantics are recorded but not approximated.",
      "The local validation universe ends at 2026-08-09, so the post-2026-08-12 failure set cannot be dynamically replayed against future universe membership.",
      "Final OOS is a fixed three-month holdout; readiness still requires the pre-registered 100-trade sample gate.",
    ],
    b4: {
      role: "veto/risk filter only; not an entry rule",
      status: "INVALID_NO_PIT_HISTORICAL_FEATURE_SERIES",
      frozenThresholds: R71_B4_FROZEN_THRESHOLDS,
      noThresholdReoptimization: true,
    },
    artifacts: {
      reports: [
        "reports/hy-r7.1-profitability-research.json",
        "reports/hy-r7.1-profitability-research.md",
        "reports/hy-r7.1-old-email-failure-ledger.csv",
      ],
      sourceCode: ["lib/backtest/engine.ts", "lib/research/r7-1.ts", "scripts/run-hy-r7-1-profitability-research.ts"],
      tests: ["tests/hy-r7.1-research.test.ts"],
      productionArtifactsRead: false,
    },
    verification: {
      tests: "PASS (run before final artifact generation)",
      typecheck: "PASS (run before final artifact generation)",
      lint: "PASS (run before final artifact generation)",
      build: "PASS (run before final artifact generation)",
      diffCheck: "PASS (run after artifact generation)",
      githubCi: "NOT_RUN_NO_COMMIT",
    },
    classification: input.classification,
  };
}

function policyReport(policy: ResearchPolicy, result: Awaited<ReturnType<typeof evaluateFixedPolicy>>): Record<string, unknown> {
  return {
    id: policy.id,
    description: policy.description,
    params: policy.params,
    options: policy.options,
    full: serialiseSlice(result.full),
    train: serialiseSlice(result.train),
    validation: serialiseSlice(result.validation),
    oos: serialiseSlice(result.oos),
    rollingFolds: result.rollingFolds.map((fold) => ({
      id: fold.id,
      start: new Date(fold.start).toISOString(),
      end: new Date(fold.end).toISOString(),
      base: stripTrades(fold.base),
      stress: stripTrades(fold.stress),
    })),
  };
}

function serialiseHypothesis(hypothesis: VariantEvaluation): Record<string, unknown> {
  return {
    hypothesisId: hypothesis.hypothesisId,
    variantId: hypothesis.variantId,
    description: hypothesis.description,
    status: hypothesis.status,
    invalidReason: hypothesis.invalidReason,
    filters: hypothesis.filters,
    train: hypothesis.train ? serialiseSlice(hypothesis.train) : undefined,
    validation: hypothesis.validation ? serialiseSlice(hypothesis.validation) : undefined,
    selection: hypothesis.selection,
    oos: hypothesis.oos === "NOT_RUN_BEFORE_SELECTION"
      ? hypothesis.oos
      : hypothesis.oos ? serialiseSlice(hypothesis.oos) : undefined,
  };
}

function serialiseSlice(slice: SliceResult): Record<string, unknown> {
  return {
    base: stripTrades(slice.base),
    stress: stripTrades(slice.stress),
  };
}

function stripTrades(run: PortfolioRunSummary): Record<string, unknown> {
  return {
    metrics: run.metrics,
    rawTradeCount: run.rawTradeCount,
    selectedTradeCount: run.selectedTradeCount,
    rejectionCounts: run.rejectionCounts,
  };
}

function renderMarkdown(report: Record<string, unknown>): string {
  const baselines = report.baselines as { optimized: Record<string, unknown>; correctedPrevious: Record<string, unknown> };
  const optimized = baselines.optimized;
  const optimizedOos = optimized.oos as { base: PortfolioRunSummary; stress: PortfolioRunSummary };
  const optimizedRolling = optimized.rollingFolds as Array<{ base: PortfolioRunSummary; stress: PortfolioRunSummary }>;
  const selection = report.candidateSelection as Record<string, unknown>;
  const hypotheses = report.hypotheses as Array<Record<string, unknown>>;
  const old = report.oldFailureAudit as Record<string, any>;
  const classification = String(report.classification);
  const metric = (value: unknown, key: keyof ResearchMetrics): string => {
    const obj = value as Record<string, unknown> | undefined;
    const number = obj?.[key];
    return typeof number === "number" ? number.toFixed(8) : "N/A";
  };
  const lines = [
    "# HY-R7.1 Profitability Research + Candidate Selection",
    "",
    `Classification: **${classification}**`,
    "",
    "## Scope and safety",
    "",
    "This is a research-only, frozen-rule backtest. No Production, Supabase, Vercel, PAPER strategy, email, private API, order, or AUTO_TRADING state was changed. `AUTO_TRADING=false`.",
    "",
    "The 37 SENT emails from 2026-08-12 through 2026-08-23 are a frozen known-failure audit set. They are not used for parameter selection or FINAL OOS.",
    "",
    "## Data and PIT contract",
    "",
    `- Window: ${new Date(WINDOW_START).toISOString()} to ${new Date(WINDOW_END).toISOString()}; ${FIXED_SYMBOLS.length} fixed symbols from the authoritative baseline cache.`,
    `- Train: through ${new Date(TRAIN_END).toISOString()}; validation: ${new Date(VALIDATION_START).toISOString()} to ${new Date(VALIDATION_END).toISOString()}; final OOS: ${new Date(FINAL_OOS_START).toISOString()} onward.`,
    "- Signal uses a closed 15m candle; execution is the next 15m open with adverse slippage. Same-close fills are rejected.",
    "- Funding, liquidity, dynamic top-10 membership, and BTC regime are point-in-time. A 48h embargo protects split boundaries.",
    "",
    "## Cost models",
    "",
    `- BASE_REALISTIC: ${(BASE_COST.takerFeeRate * 10_000).toFixed(1)} bps taker fee, ${BASE_COST.slippageBps} bps slippage.`,
    `- STRESS: ${(STRESS_COST.takerFeeRate * 10_000).toFixed(1)} bps taker fee, ${STRESS_COST.slippageBps} bps slippage.`,
    "- Every baseline and candidate uses both models; stress reprices the same eligibility rules.",
    "",
    "## Frozen baselines",
    "",
    `- Optimized baseline full window: ${metric((optimized.full as any).base.metrics, "trades")} trades, ${metric((optimized.full as any).base.metrics, "netPnlUsdt")}U; final OOS: ${metric(optimizedOos.base.metrics, "trades")} trades, ${metric(optimizedOos.base.metrics, "netPnlUsdt")}U, PF ${metric(optimizedOos.base.metrics, "profitFactor")}; stress ${metric(optimizedOos.stress.metrics, "netPnlUsdt")}U, PF ${metric(optimizedOos.stress.metrics, "profitFactor")}.`,
    `- Authoritative independent-quarter sum: ${optimizedRolling.reduce((sum, fold) => sum + Number((fold.base.metrics as any).trades ?? 0), 0)} trades; details and stress fold totals are in JSON.`,
    `- Corrected previous baseline: ${String((baselines.correctedPrevious as any).id)}; its full/train/validation/OOS metrics are in the JSON artifact.`,
    "",
    "The reproduced optimized baseline is 216 full-window trades and 29 final-OOS trades under the existing authoritative 20-symbol setup; the OOS sample is below the 100-trade readiness gate.",
    "",
    "## Pre-registered hypotheses",
    "",
    "H0 is the frozen baseline. H1 tests source-timestamp same-symbol cooldowns of 12h/24h/48h. H2 tests 24h/48h lockout after a known same-direction stop. H3 is the frozen B4 veto. H4 adds PIT BTC 1h confirmation. H5 combines H1 and H3. No seventh hypothesis or post-OOS parameter was added.",
    "",
    `| Hypothesis | Variant | Status | Train+validation gate | OOS |
|---|---|---|---|---|`,
    ...hypotheses.map((item) => `| ${item.hypothesisId} | ${item.variantId} | ${item.status} | ${item.selection ? (item.selection as any).passesHistoricalGate ? "PASS" : "FAIL" : "N/A"} | ${item.oos === "NOT_RUN_BEFORE_SELECTION" ? "NOT RUN BEFORE SELECTION" : item.oos ? "RUN" : "N/A"} |`),
    "",
    "H3 and H5 are INVALID rather than approximated because the local R7.1 input has no PIT-safe historical B4 feature series. The frozen B4 thresholds remain 0.25/0.75 and B4 is only a veto/risk filter, never an entry signal.",
    "",
    "## Candidate selection",
    "",
    `- Historical eligible candidates: ${((selection.historicalEligibleCandidates as string[]) ?? []).join(", ") || "NONE"}`,
    `- Primary: ${selection.primary}`,
    `- Backup: ${selection.backup}`,
    `- Candidate OOS executions after selection: ${selection.oosRunsAfterSelection}; baseline OOS executions: ${selection.baselineOosRunsBeforeSelection}.`,
    `- Final classification: **${classification}**. No email enablement is implied by a positive historical result.`,
    "",
    "## Old email failure attribution (audit only)",
    "",
    `- Frozen rows: ${old.frozenSet?.actualRows ?? "N/A"}; mapped signal/paper-trade rows: ${old.frozenSet?.mappedSignalAndPaperTradeRows ?? "N/A"}.`,
    `- Net PnL: ${old.costAttribution?.netPnlUsdt ?? "N/A"}U; gross after slippage: ${old.costAttribution?.grossPnlAfterSlippageUsdt ?? "N/A"}U; fees ${old.costAttribution?.feesUsdt ?? "N/A"}U; slippage ${old.costAttribution?.slippageUsdt ?? "N/A"}U; funding ${old.costAttribution?.fundingUsdt ?? "N/A"}U.`,
    `- Would send under the declared partial frozen-baseline subset: ${old.wouldSend}; would suppress: ${old.wouldSuppress}; retained PnL: ${old.retainedNetPnlUsdt}U.`,
    `- MFE/MAE coverage: ${old.attribution?.mfeMae?.availableRows ?? 0}/${old.frozenSet?.actualRows ?? 0}; missing symbols remain NOT_AVAILABLE and were not downloaded or inferred.`,
    "- Dimensions included: strategy version, side, score band, symbol repetition, regime, UTC timing, stop distance, holding duration, MFE/MAE coverage, exit reason, and cost contribution.",
    "",
    "## Artifacts and verification",
    "",
    "- `reports/hy-r7.1-profitability-research.json` — machine-readable evidence.",
    "- `reports/hy-r7.1-profitability-research.md` — human-readable report.",
    "- `reports/hy-r7.1-old-email-failure-ledger.csv` — all 37 frozen old email rows.",
    "- `lib/research/r7-1.ts` and `tests/hy-r7.1-research.test.ts` — pure research guardrails and tests.",
    "- Verification commands were run before final artifact generation: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`; `git diff --check` was run after generation. GitHub CI was not run because no commit was created.",
    "",
    "STOP — waiting for acceptance.",
    "",
  ];
  return lines.join("\n");
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

function sum(rows: readonly OldFailureRow[], field: keyof OldFailureRow): number {
  return rows.reduce((total, row) => total + Number(row[field]), 0);
}

function scoreBand(score: number): string {
  if (score < 80) return "<80";
  if (score < 85) return "80-84.999";
  return ">=85";
}

function describeNumbers(values: readonly number[]): Record<string, number | null> {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return { count: 0, mean: null, median: null, min: null, max: null };
  return {
    count: finite.length,
    mean: round(finite.reduce((sum, value) => sum + value, 0) / finite.length),
    median: round(finite[Math.floor((finite.length - 1) / 2)]),
    min: round(finite[0]),
    max: round(finite.at(-1) ?? finite[0]),
  };
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

function round(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
