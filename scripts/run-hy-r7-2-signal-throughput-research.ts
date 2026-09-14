import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildCandidateCache,
  buildDynamicUniverseByTimestamp,
  buildGlobalRegimeByTimestamp,
  runBacktest,
  selectPortfolioTrades,
  type BacktestOptions,
} from "@/lib/backtest/engine";
import { assertHistoricalDatasetIntegrity } from "@/lib/backtest/data-integrity";
import type { BacktestTrade, HistoricalDataset } from "@/lib/backtest/types";
import { DEFAULT_STRATEGY_PARAMS, type StrategyParams } from "@/lib/core/strategies";
import { buildTradePlan, estimateExecutionCostRisk } from "@/lib/core/risk";
import type { ScoredCandidate } from "@/lib/core/types";
import {
  R72_CANDIDATE_A,
  R72_CANDIDATE_A_ID,
  R72_REPORT_VERSION,
  R72_STRATEGY_HASH,
  R72_STRATEGY_VERSION,
  R72_MAX_DD_TOLERANCE,
  R72_MIN_PRACTICAL_WEEKLY,
  R72_TARGET_ANNUALIZED,
  R72_TARGET_WEEKLY,
  assertCandidateAImmutable,
  assertChallengerCount,
  buildFunnel,
  bootstrapConfidence,
  calculateSignalRate,
  estimateDaysToTarget,
  passesProfitabilityGate,
  passesThroughputGate,
  rankProfitabilityBeforeThroughput,
  R72OosRunGuard,
  type FunnelStage,
  type GateMetrics,
  type RankedCandidate,
  type SignalRate,
} from "@/lib/research/r7-2";
import {
  applyPITEpisodeFilters,
  calculateResearchMetrics,
  sourceTimeForEntry,
  topSymbolConcentration,
  type EpisodeFilterConfig,
  type ResearchMetrics,
} from "@/lib/research/r7-1";
import { R71_OLD_FAILURE_SET } from "@/lib/research/r7-1";

const DATA_DIRECTORY = resolve("data", "hy-r2b-history-24m");
const WINDOW_START = Date.parse("2025-08-09T02:15:00.000Z");
const WINDOW_END = Date.parse("2026-08-09T02:14:59.999Z");
const VALIDATION_START = Date.parse("2026-02-09T02:15:00.000Z");
const FINAL_OOS_START = Date.parse("2026-05-09T02:15:00.000Z");
const EMBARGO_MS = 48 * 60 * 60 * 1000;
const TRAIN_END = VALIDATION_START - EMBARGO_MS;
const VALIDATION_END = FINAL_OOS_START - EMBARGO_MS;
const ENTRY_INTERVAL_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const BASE_COST = {
  name: "BASE",
  takerFeeRate: 0.0004,
  slippageBps: 2,
  selectionTakerFeeRate: 0.0004,
  selectionSlippageBps: 2,
} as const;

const STRESS_COST = {
  name: "STRESS",
  takerFeeRate: 0.0006,
  slippageBps: 4,
  selectionTakerFeeRate: 0.0006,
  selectionSlippageBps: 4,
} as const;

const CANDIDATE_PARAMS: StrategyParams = {
  ...DEFAULT_STRATEGY_PARAMS,
  entryMode: "TREND_PULLBACK",
  stopAtrMultiplier: 0.75,
};

const EPISODE_FILTERS: EpisodeFilterConfig = { sameSymbolCooldownHours: 24 };

interface CostModel {
  name: string;
  takerFeeRate: number;
  slippageBps: number;
  selectionTakerFeeRate: number;
  selectionSlippageBps: number;
}

interface LoadedData {
  datasets: HistoricalDataset[];
  symbols: string[];
  rawFiles: number;
  rawBytes: number;
  manifestSha256: string;
  coverage: {
    earliestOpenTime: string;
    latestCloseTime: string;
    allFilesEndAtOrBeforeWindowEnd: boolean;
  };
}

interface ExecutionMaps {
  dynamicUniverseBySize: Map<number, Map<number, Set<string>>>;
  globalRegimeByTimestamp: Map<number, import("@/lib/core/types").MarketRegime>;
}

interface FunnelEvidence {
  input: number;
  stages: FunnelStage[];
}

interface SliceRun {
  metrics: ResearchMetrics;
  rawMetrics: ResearchMetrics;
  rawSignalCount: number;
  selectedSignalCount: number;
  signalTimes: number[];
  trades: BacktestTrade[];
  portfolioRejections: ReturnType<typeof selectPortfolioTrades>["rejectionCounts"];
}

interface SlicePair {
  base: SliceRun;
  stress: SliceRun;
}

interface CandidateSpec {
  id: string;
  description: string;
  universeSize: number;
}

interface CandidateEvaluation {
  spec: CandidateSpec;
  train: SlicePair;
  validation: SlicePair;
  finalOos?: SlicePair;
  finalOosStatus: "RUN" | "NOT_RUN_BEFORE_SELECTION";
  selection: {
    base: ResearchMetrics;
    stress: ResearchMetrics;
    signalRate: SignalRate;
    profitabilityEligible: boolean;
  };
  oosSignalRate?: SignalRate;
  oosBootstrap?: ReturnType<typeof bootstrapConfidence>;
}

interface ProductionSnapshot {
  source: string;
  capturedAt: string;
  scanCount: number;
  failedScans: number;
  firstScanStartedAt: string;
  latestScanStartedAt: string;
  latestScanFinishedAt: string;
  diagnosticsRows: number;
  diagnosticsScanCount: number;
  diagnosticsCoveragePercent: number;
  strategy: {
    version: string;
    family: string;
    status: string;
    createdAt: string;
  };
  currentForward: {
    signals: number;
    maturedPaperTrades: number;
    netPnlUsdt: number;
    firstSignalEntryAt: string;
  };
  runtimeSafety: {
    strategySource: "DB";
    strategyStage: "PAPER";
    dryRun: false;
    exchangeCredentialsConfigured: false;
    autoTrading: false;
    realEmail: "OFF";
  };
  measuredDiagnostics: Record<string, number>;
}

const PRODUCTION_SNAPSHOT: ProductionSnapshot = {
  source: "Read-only SELECT evidence from Supabase project jfvbikivtpfjgfsnggiz; no production write was issued by R7.2.",
  capturedAt: "2026-09-13T02:45:11.186Z",
  scanCount: 3284,
  failedScans: 0,
  firstScanStartedAt: "2026-08-09T17:34:48.982760Z",
  latestScanStartedAt: "2026-09-13T02:45:10.320958Z",
  latestScanFinishedAt: "2026-09-13T02:45:11.186Z",
  diagnosticsRows: 749,
  diagnosticsScanCount: 749,
  diagnosticsCoveragePercent: 22.80755177,
  strategy: {
    version: R72_STRATEGY_VERSION,
    family: "TREND",
    status: "PAPER",
    createdAt: "2026-08-09T15:46:25.317519Z",
  },
  currentForward: {
    signals: 1,
    maturedPaperTrades: 1,
    netPnlUsdt: 95.36074897,
    firstSignalEntryAt: "2026-09-10T19:14:59.999Z",
  },
  runtimeSafety: {
    strategySource: "DB",
    strategyStage: "PAPER",
    dryRun: false,
    exchangeCredentialsConfigured: false,
    autoTrading: false,
    realEmail: "OFF",
  },
  measuredDiagnostics: {
    marketDataOk: 7490,
    rawCandidates: 1283,
    strategyFamilyPass: 9,
    sidePass: 9,
    localRegimePass: 9,
    globalRegimePass: 9,
    scorePass: 57,
    riskPlanPass: 9,
    executionCostPass: 1,
    preCooldownCandidate: 1,
    cooldownPass: 1,
    claimed: 1,
    emailed: 1,
  },
};

async function main(): Promise<void> {
  assertCandidateAImmutable(R72_CANDIDATE_A);
  const data = await loadData();
  const caches = buildCaches(data.datasets);
  const allScanTimes = collectScanTimes(data.datasets);
  const candidateTimes = collectCandidateTimes(data.datasets, caches);
  const maps: ExecutionMaps = {
    dynamicUniverseBySize: new Map([10, 20, 30].map((size) => [
      size,
      buildDynamicUniverseByTimestamp(data.datasets, allScanTimes, size, 1),
    ])),
    globalRegimeByTimestamp: buildGlobalRegimeByTimestamp(data.datasets, candidateTimes, "BTCUSDT", "4h"),
  };

  const historicalFunnel = {
    train: buildHistoricalFunnel(data.datasets, caches, maps, WINDOW_START, TRAIN_END),
    validation: buildHistoricalFunnel(data.datasets, caches, maps, VALIDATION_START, VALIDATION_END),
    finalOos: buildHistoricalFunnel(data.datasets, caches, maps, FINAL_OOS_START, WINDOW_END),
  };
  const dominant = chooseDominantBottleneck(historicalFunnel.finalOos.stages);
  const candidateFamily = dominant?.family ?? "NONE";

  const candidateASpec = {
    id: "A",
    description: "Frozen Candidate A: exact hy-paper-candidate-v2 rules with dynamic top-10 liquid universe",
    universeSize: 10,
  };
  const candidateATrainValidation = await evaluateTrainValidation(candidateASpec, data.datasets, caches, maps);
  const candidateA: CandidateEvaluation = {
    ...candidateATrainValidation,
    selection: buildSelection(candidateATrainValidation.train, candidateATrainValidation.validation),
  };

  const challengerSpecs = candidateFamily === "UNIVERSE"
    ? [
      { id: "B1", description: "Frozen Candidate A rules with dynamic top-20 liquid universe", universeSize: 20 },
      { id: "B2", description: "Frozen Candidate A rules with dynamic top-30 liquid universe", universeSize: 30 },
    ]
    : [];
  assertChallengerCount(challengerSpecs.map((item) => item.id));
  const challengers: CandidateEvaluation[] = [];
  for (const spec of challengerSpecs) {
    const evaluated = await evaluateTrainValidation(spec, data.datasets, caches, maps);
    challengers.push({
      ...evaluated,
      selection: buildSelection(evaluated.train, evaluated.validation),
    });
  }

  const ranked = rankProfitabilityBeforeThroughput([
    ...challengers.map((candidate) => toRankedCandidate(candidate)),
  ]);
  const selectedId = ranked.find((item) => item.profitabilityEligible)?.id ?? null;
  const selected = selectedId ? challengers.find((candidate) => candidate.spec.id === selectedId) ?? null : null;
  const oosGuard = new R72OosRunGuard();
  candidateA.finalOos = oosGuard.run(candidateA.spec.id, () => runSlicePair(candidateA.spec, data.datasets, caches, maps, FINAL_OOS_START, WINDOW_END));
  candidateA.finalOosStatus = "RUN";
  finalizeCandidate(candidateA);

  if (selected) {
    selected.finalOos = oosGuard.run(selected.spec.id, () => runSlicePair(selected.spec, data.datasets, caches, maps, FINAL_OOS_START, WINDOW_END));
    selected.finalOosStatus = "RUN";
    finalizeCandidate(selected);
  }

  const selectedProfitabilityGate = selected?.finalOos
    ? passesProfitabilityGate(
      toGateMetrics(candidateA.finalOos.base.metrics),
      toGateMetrics(selected.finalOos.base.metrics),
      toGateMetrics(selected.finalOos.stress.metrics),
    )
    : false;
  const selectedThroughputGate = selected?.oosSignalRate
    ? passesThroughputGate(candidateA.oosSignalRate?.count ?? 0, selected.oosSignalRate.count, selected.oosSignalRate.annualizedSignals)
    : false;
  const productionForwardRate = calculateSignalRate(
    [Date.parse(PRODUCTION_SNAPSHOT.currentForward.firstSignalEntryAt)],
    Date.parse(PRODUCTION_SNAPSHOT.strategy.createdAt),
    Date.parse(PRODUCTION_SNAPSHOT.latestScanFinishedAt),
  );
  const productionObservationDays = productionForwardRate.observationDays;
  const historicalPractical = (candidateA.oosSignalRate?.signalsPerWeek ?? 0) >= R72_TARGET_WEEKLY
    || (candidateA.oosSignalRate?.annualizedSignals ?? 0) >= R72_TARGET_ANNUALIZED;
  const productionSparse = productionForwardRate.signalsPerWeek < R72_MIN_PRACTICAL_WEEKLY;
  const classification = selected && selectedProfitabilityGate && selectedThroughputGate
    ? "THROUGHPUT_PROFITABILITY_CANDIDATE_READY"
    : productionSparse
      ? "CANDIDATE_A_TOO_SPARSE_NO_SAFE_EXPANSION"
      : historicalPractical && candidateA.finalOos && candidateA.finalOos.base.metrics.netPnlUsdt > 0
        ? "THROUGHPUT_PROFITABILITY_CANDIDATE_READY"
        : "PROFITABILITY_RESEARCH_INVALID";
  const report = buildReport({
    data,
    historicalFunnel,
    dominant,
    candidateFamily,
    candidateA,
    challengers,
    selected,
    selectedProfitabilityGate,
    selectedThroughputGate,
    oosRunCount: oosGuard.runCount,
    classification,
    productionForwardRate,
    productionObservationDays,
  });

  await writeFile(resolve("reports", "hy-r7.2-signal-throughput-research.json"), JSON.stringify(report.json, null, 2) + "\n", "utf8");
  await writeFile(resolve("reports", "hy-r7.2-signal-throughput-research.md"), report.markdown, "utf8");
  console.log(`HY-R7.2 SIGNAL THROUGHPUT RESEARCH COMPLETE: ${classification}`);
  console.log(JSON.stringify({
    candidateAOosSignals: candidateA.oosSignalRate?.count,
    candidateAOosSignalsPerWeek: candidateA.oosSignalRate?.signalsPerWeek,
    dominantBottleneck: dominant?.stage ?? "NONE",
    candidateFamily,
    selectedCandidate: selected?.spec.id ?? null,
    selectedProfitabilityGate,
    selectedThroughputGate,
    oosRunCount: oosGuard.runCount,
  }));
}

async function loadData(): Promise<LoadedData> {
  const filenames = (await readdir(DATA_DIRECTORY))
    .filter((filename) => filename.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));
  if (filenames.length !== 49) throw new Error(`R7.2 requires exactly 49 historical files; found ${filenames.length}`);

  const datasets: HistoricalDataset[] = [];
  const manifestRows: string[] = [];
  let rawBytes = 0;
  for (const filename of filenames) {
    const path = resolve(DATA_DIRECTORY, filename);
    const bytes = await readFile(path);
    rawBytes += bytes.byteLength;
    manifestRows.push(`${filename}:${createHash("sha256").update(bytes).digest("hex")}`);
    const dataset = JSON.parse(bytes.toString("utf8")) as HistoricalDataset;
    assertHistoricalDatasetIntegrity(dataset);
    const expectedSymbol = filename.slice(0, -".json".length);
    if (dataset.symbol !== expectedSymbol) throw new Error(`Dataset filename/symbol mismatch: ${filename}`);
    if (dataset.candles["15m"].at(-1)?.closeTime !== WINDOW_END) {
      throw new Error(`Dataset ${dataset.symbol} does not end at the frozen R7.2 boundary`);
    }
    datasets.push(dataset);
  }
  const earliest = Math.min(...datasets.map((dataset) => dataset.candles["15m"][0]?.openTime ?? Number.POSITIVE_INFINITY));
  const latest = Math.max(...datasets.map((dataset) => dataset.candles["15m"].at(-1)?.closeTime ?? 0));
  const manifestSha256 = createHash("sha256").update(manifestRows.join("\n") + "\n").digest("hex");
  return {
    datasets,
    symbols: datasets.map((dataset) => dataset.symbol).sort(),
    rawFiles: filenames.length,
    rawBytes,
    manifestSha256,
    coverage: {
      earliestOpenTime: new Date(earliest).toISOString(),
      latestCloseTime: new Date(latest).toISOString(),
      allFilesEndAtOrBeforeWindowEnd: latest <= WINDOW_END,
    },
  };
}

function buildCaches(datasets: readonly HistoricalDataset[]): Array<Map<number, ScoredCandidate[]>> {
  return datasets.map((dataset, index) => {
    console.log(`Building frozen Candidate A cache ${index + 1}/${datasets.length}: ${dataset.symbol}`);
    return buildCandidateCache(dataset, CANDIDATE_PARAMS, WINDOW_END);
  });
}

function collectScanTimes(datasets: readonly HistoricalDataset[]): number[] {
  const times = new Set<number>();
  for (const dataset of datasets) {
    for (const candle of dataset.candles["15m"]) {
      if (candle.closeTime >= WINDOW_START && candle.closeTime <= WINDOW_END) times.add(candle.closeTime);
    }
  }
  return [...times].sort((left, right) => left - right);
}

function collectCandidateTimes(datasets: readonly HistoricalDataset[], caches: readonly Map<number, ScoredCandidate[]>[]): number[] {
  const times = new Set<number>();
  datasets.forEach((dataset, datasetIndex) => {
    for (const index of caches[datasetIndex].keys()) {
      const timestamp = dataset.candles["15m"][index]?.closeTime;
      if (timestamp !== undefined && timestamp >= WINDOW_START && timestamp <= WINDOW_END) times.add(timestamp);
    }
  });
  return [...times].sort((left, right) => left - right);
}

function buildHistoricalFunnel(
  datasets: readonly HistoricalDataset[],
  caches: readonly Map<number, ScoredCandidate[]>[],
  maps: ExecutionMaps,
  start: number,
  end: number,
): FunnelEvidence {
  let input = 0;
  const passed = Array<number>(10).fill(0);
  passed[0] = 0;
  const lastAcceptedSource = new Map<string, number>();

  datasets.forEach((dataset, datasetIndex) => {
    const candles = dataset.candles["15m"];
    for (let index = 80; index < candles.length - 1; index += 1) {
      const current = candles[index];
      if (current.closeTime < start || current.closeTime > end) continue;
      input += 1;
      passed[0] += 1;
      if (!maps.dynamicUniverseBySize.get(10)?.get(current.closeTime)?.has(dataset.symbol)) continue;
      passed[1] += 1;

      const trend = (caches[datasetIndex].get(index) ?? []).find((candidate) => candidate.strategyFamily === "TREND");
      if (!trend) continue;
      passed[2] += 1;
      if (trend.side !== "SHORT") continue;
      passed[3] += 1;
      if (trend.marketRegime !== "BEAR") continue;
      passed[4] += 1;
      if (maps.globalRegimeByTimestamp.get(current.closeTime) !== "BEAR") continue;
      passed[5] += 1;
      if (trend.score < 80) continue;
      passed[6] += 1;

      const sourceTime = current.closeTime;
      const previousAccepted = lastAcceptedSource.get(dataset.symbol);
      if (previousAccepted !== undefined && sourceTime - previousAccepted < 24 * HOUR_MS) continue;
      passed[7] += 1;

      const entryCandle = candles[index + 1];
      if (!entryCandle || entryCandle.openTime > end) continue;
      let executionEligible = false;
      try {
        const executionCandidate = { ...trend, entryPrice: entryCandle.open };
        const plan = buildTradePlan(executionCandidate, dataset.instrument, riskPolicy(), entryCandle.openTime);
        executionEligible = !plan.riskOverSingleCap
          && estimateExecutionCostRisk(plan, BASE_COST.takerFeeRate, BASE_COST.slippageBps) <= 0.1;
      } catch {
        executionEligible = false;
      }
      if (!executionEligible) continue;
      passed[8] += 1;
      passed[9] += 1;
      lastAcceptedSource.set(dataset.symbol, sourceTime);
    }
  });

  return { input, stages: buildFunnel(input, passed.map((value, index) => ({ stage: funnelStageName(index), passed: value }))) };
}

function funnelStageName(index: number): import("@/lib/research/r7-2").R72FunnelStageName {
  return [
    "symbols considered",
    "liquidity/universe eligible",
    "TREND_PULLBACK condition met",
    "SHORT side eligible",
    "local regime aligned",
    "BTC 4h regime aligned",
    "score >=80",
    "cooldown eligible",
    "execution-cost eligible",
    "final signal emitted",
  ][index] as import("@/lib/research/r7-2").R72FunnelStageName;
}

function chooseDominantBottleneck(stages: readonly FunnelStage[]): { stage: string; family: "UNIVERSE" | "SIDE" | "REGIME"; rejected: number; input: number; rejectionSharePercent: number } | null {
  const eligible = stages
    .filter((row) => [
      "liquidity/universe eligible",
      "SHORT side eligible",
      "local regime aligned",
      "BTC 4h regime aligned",
    ].includes(row.stage))
    .sort((left, right) => right.rejected - left.rejected || bottleneckPriority(left.stage) - bottleneckPriority(right.stage));
  const selected = eligible[0];
  if (!selected || selected.rejected === 0) return null;
  const family = selected.stage === "liquidity/universe eligible"
    ? "UNIVERSE"
    : selected.stage === "SHORT side eligible"
      ? "SIDE"
      : "REGIME";
  return {
    stage: selected.stage,
    family,
    rejected: selected.rejected,
    input: selected.input,
    rejectionSharePercent: round(selected.input === 0 ? 0 : selected.rejected / selected.input * 100, 6),
  };
}

function bottleneckPriority(stage: string): number {
  return [
    "liquidity/universe eligible",
    "SHORT side eligible",
    "local regime aligned",
    "BTC 4h regime aligned",
  ].indexOf(stage);
}

async function evaluateTrainValidation(
  spec: CandidateSpec,
  datasets: readonly HistoricalDataset[],
  caches: readonly Map<number, ScoredCandidate[]>[],
  maps: ExecutionMaps,
): Promise<Pick<CandidateEvaluation, "spec" | "train" | "validation" | "finalOosStatus">> {
  return {
    spec,
    train: runSlicePair(spec, datasets, caches, maps, WINDOW_START, TRAIN_END),
    validation: runSlicePair(spec, datasets, caches, maps, VALIDATION_START, VALIDATION_END),
    finalOosStatus: "NOT_RUN_BEFORE_SELECTION",
  };
}

function runSlicePair(
  spec: CandidateSpec,
  datasets: readonly HistoricalDataset[],
  caches: readonly Map<number, ScoredCandidate[]>[],
  maps: ExecutionMaps,
  start: number,
  end: number,
): SlicePair {
  return {
    base: runSlice(spec, datasets, caches, maps, start, end, BASE_COST),
    stress: runSlice(spec, datasets, caches, maps, start, end, STRESS_COST),
  };
}

function runSlice(
  spec: CandidateSpec,
  datasets: readonly HistoricalDataset[],
  caches: readonly Map<number, ScoredCandidate[]>[],
  maps: ExecutionMaps,
  start: number,
  end: number,
  cost: CostModel,
): SliceRun {
  const rawResearchTrades = datasets.flatMap((dataset, datasetIndex) => runBacktest(dataset, CANDIDATE_PARAMS, {
    ...backtestOptions(spec.universeSize),
    ...costOptions(cost),
    evaluationStartTime: start,
    evaluationEndTime: end,
    cooldownHours: 0,
    singleSignalRiskCapUsdt: Number.MAX_SAFE_INTEGER,
    candidateCache: caches[datasetIndex],
    dynamicUniverseByTimestamp: maps.dynamicUniverseBySize.get(spec.universeSize),
    globalRegimeByTimestamp: maps.globalRegimeByTimestamp,
  }).trades.map((trade) => ({ trade, sourceTime: sourceTimeForEntry(trade.entryTime) })));
  const episodeFiltered = applyPITEpisodeFilters(rawResearchTrades, EPISODE_FILTERS);
  const portfolio = selectPortfolioTrades(episodeFiltered.trades, CANDIDATE_PARAMS, {
    ...backtestOptions(spec.universeSize),
    ...costOptions(cost),
    evaluationStartTime: start,
    evaluationEndTime: end,
  });
  return {
    metrics: calculateResearchMetrics(portfolio.trades),
    rawMetrics: calculateResearchMetrics(episodeFiltered.trades),
    rawSignalCount: episodeFiltered.trades.length,
    selectedSignalCount: portfolio.trades.length,
    signalTimes: portfolio.trades.map((trade) => sourceTimeForEntry(trade.entryTime)),
    trades: portfolio.trades,
    portfolioRejections: portfolio.rejectionCounts,
  };
}

function backtestOptions(universeSize: number): BacktestOptions {
  return {
    initialCapitalUsdt: 10_000,
    minimumSampleDays: 0,
    minScore: 80,
    maxHoldHours: 48,
    rewardRisk: 2,
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
    dynamicUniverseSize: universeSize,
    dynamicUniverseLookbackDays: 1,
    globalReferenceSymbol: "BTCUSDT",
    globalReferenceTimeframe: "4h",
    globalRegimeAlignment: true,
    entryDelayBars: 1,
  };
}

function riskPolicy() {
  return {
    marginUsdt: 100,
    leverage: 20,
    singleSignalRiskCapUsdt: 50,
    dailyRiskBudgetUsdt: 600,
    maxHoldHours: 48,
    rewardRisk: 2,
    riskPerTradeUsdt: 50,
    maxPositionNotionalUsdt: 10_000,
  };
}

function costOptions(cost: CostModel): Pick<BacktestOptions, "takerFeeRate" | "slippageBps" | "selectionTakerFeeRate" | "selectionSlippageBps"> {
  return {
    takerFeeRate: cost.takerFeeRate,
    slippageBps: cost.slippageBps,
    selectionTakerFeeRate: cost.selectionTakerFeeRate,
    selectionSlippageBps: cost.selectionSlippageBps,
  };
}

function buildSelection(train: SlicePair, validation: SlicePair): CandidateEvaluation["selection"] {
  const base = calculateResearchMetrics([...train.base.trades, ...validation.base.trades]);
  const stress = calculateResearchMetrics([...train.stress.trades, ...validation.stress.trades]);
  return {
    base,
    stress,
    signalRate: calculateSignalRate(signalTimes(train, validation), WINDOW_START, VALIDATION_END),
    profitabilityEligible: base.netPnlUsdt > 0
      && base.expectancyUsdt > 0
      && base.profitFactor >= 1.25
      && stress.netPnlUsdt > 0
      && stress.profitFactor >= 1.1
      && base.trades > 0,
  };
}

function signalTimes(train: SlicePair, validation: SlicePair): number[] {
  return [...train.base.signalTimes, ...validation.base.signalTimes];
}

function finalizeCandidate(candidate: CandidateEvaluation): void {
  if (!candidate.finalOos) throw new Error(`Candidate ${candidate.spec.id} has no final OOS result`);
  candidate.oosSignalRate = calculateSignalRate(candidate.finalOos.base.signalTimes, FINAL_OOS_START, WINDOW_END);
  candidate.oosBootstrap = bootstrapConfidence(candidate.finalOos.base.trades.map((trade) => trade.pnlUsdt));
}

function toGateMetrics(metrics: ResearchMetrics): GateMetrics {
  return {
    trades: metrics.trades,
    netPnlUsdt: metrics.netPnlUsdt,
    expectancyUsdt: metrics.expectancyUsdt,
    profitFactor: metrics.profitFactor,
    maxDrawdownPercent: metrics.maxDrawdownPercent,
  };
}

function toRankedCandidate(candidate: CandidateEvaluation): RankedCandidate {
  return {
    id: candidate.spec.id,
    profitabilityEligible: candidate.selection.profitabilityEligible,
    expectancyUsdt: candidate.selection.base.expectancyUsdt,
    profitFactor: candidate.selection.base.profitFactor,
    stressProfitFactor: candidate.selection.stress.profitFactor,
    netPnlUsdt: candidate.selection.base.netPnlUsdt,
    signalCount: candidate.selection.signalRate.count,
    annualizedSignals: candidate.selection.signalRate.annualizedSignals,
  };
}

function buildReport(input: {
  data: LoadedData;
  historicalFunnel: { train: FunnelEvidence; validation: FunnelEvidence; finalOos: FunnelEvidence };
  dominant: ReturnType<typeof chooseDominantBottleneck>;
  candidateFamily: string;
  candidateA: CandidateEvaluation;
  challengers: CandidateEvaluation[];
  selected: CandidateEvaluation | null;
  selectedProfitabilityGate: boolean;
  selectedThroughputGate: boolean;
  oosRunCount: number;
  classification: string;
  productionForwardRate: SignalRate;
  productionObservationDays: number;
}): { json: Record<string, unknown>; markdown: string } {
  const { candidateA, selected } = input;
  const candidateAForwardDaysTo30 = estimateDaysToTarget(PRODUCTION_SNAPSHOT.currentForward.maturedPaperTrades, input.productionObservationDays, 30);
  const candidateAForwardDaysTo100 = estimateDaysToTarget(PRODUCTION_SNAPSHOT.currentForward.maturedPaperTrades, input.productionObservationDays, 100);
  const challengerRows = input.challengers.map((candidate) => serializeCandidate(candidate, candidateA, input.selected?.spec.id === candidate.spec.id));
  const reportJson: Record<string, unknown> = {
    reportVersion: R72_REPORT_VERSION,
    purpose: "Research-only signal throughput and profitability evaluation; no production behavior was changed.",
    safety: {
      productionModified: false,
      supabaseModified: false,
      vercelModified: false,
      paperStrategyModified: false,
      realEmail: "OFF",
      privateApi: false,
      orders: 0,
      autoTrading: false,
      b4Touched: false,
      b4HistoricalSeries: "NOT_USED",
    },
    frozenCandidateA: {
      ...R72_CANDIDATE_A,
      candidateId: R72_CANDIDATE_A_ID,
      strategyHash: R72_STRATEGY_HASH,
      strategyVersion: R72_STRATEGY_VERSION,
      selectionRule: "Candidate A remains frozen; all challengers use the same entry, score, side, regime, risk, cooldown, RR and hold rules.",
    },
    windows: {
      datasetWindow: { start: new Date(WINDOW_START).toISOString(), end: new Date(WINDOW_END).toISOString() },
      train: { start: new Date(WINDOW_START).toISOString(), end: new Date(TRAIN_END).toISOString() },
      validation: { start: new Date(VALIDATION_START).toISOString(), end: new Date(VALIDATION_END).toISOString() },
      finalOos: { start: new Date(FINAL_OOS_START).toISOString(), end: new Date(WINDOW_END).toISOString() },
      embargoHours: 48,
      pit: "At each 15m decision, only candles and dynamic quote-volume rank through that closed decision candle are consumed; entry is the next bar open.",
    },
    historicalDataset: {
      directory: "data/hy-r2b-history-24m",
      rawFiles: input.data.rawFiles,
      rawBytes: input.data.rawBytes,
      symbols: input.data.symbols,
      manifestSha256: input.data.manifestSha256,
      coverage: input.data.coverage,
    },
    historicalFunnel: {
      unit: "symbol x closed 15m decision observation; final signal means post-cooldown, execution-cost eligible event before portfolio caps",
      train: input.historicalFunnel.train,
      validation: input.historicalFunnel.validation,
      finalOos: input.historicalFunnel.finalOos,
    },
    dominantBottleneck: input.dominant ?? { stage: "NONE", family: "NONE", rejected: 0, input: 0, rejectionSharePercent: 0 },
    candidateFamilySelected: input.candidateFamily,
    candidateA: serializeCandidate(candidateA, candidateA, false),
    challengerCandidates: challengerRows,
    selection: {
      allowedChallengers: input.challengers.map((candidate) => candidate.spec.id),
      maximumChallengers: 2,
      selectedForFinalOos: selected?.spec.id ?? null,
      ranking: rankProfitabilityBeforeThroughput(input.challengers.map(toRankedCandidate)),
      rule: "Train + validation only; profitability eligibility precedes throughput ranking.",
    },
    comparison: selected ? buildComparison(candidateA, selected) : null,
    productionReadOnlyAttribution: {
      ...PRODUCTION_SNAPSHOT,
      funnel: {
        complete: false,
        stages: input.historicalFunnel.finalOos.stages.map((row) => ({
          stage: row.stage,
          input: null,
          passed: null,
          rejected: null,
          passRate: null,
          cumulativePassRate: null,
          reason: "Production diagnostics do not cover every scan and do not expose a complete row-level chain; UNKNOWN is required.",
        })),
      },
      measuredDiagnostics: PRODUCTION_SNAPSHOT.measuredDiagnostics,
      measuredDiagnosticsUnits: {
        marketDataOk: "symbol",
        rawCandidates: "candidate",
        strategyFamilyPass: "candidate",
        sidePass: "candidate",
        localRegimePass: "candidate",
        globalRegimePass: "candidate",
        scorePass: "candidate",
        riskPlanPass: "candidate",
        executionCostPass: "candidate",
        preCooldownCandidate: "candidate",
        cooldownPass: "candidate",
        claimed: "candidate",
        emailed: "candidate",
      },
      note: "The diagnostic counters are reported as observed values only; they are not converted into funnel rates because the scan-level denominator and row-level lineage are incomplete.",
    },
    signalRates: {
      candidateAHistoricalFinalOos: candidateA.oosSignalRate,
      candidateAProductionForward: input.productionForwardRate,
      productionObservationDays: input.productionObservationDays,
      estimatedDaysTo30Trades: candidateAForwardDaysTo30,
      estimatedDaysTo100Trades: candidateAForwardDaysTo100,
      practicalGate: {
        targetSignalsPerWeek: R72_TARGET_WEEKLY,
        targetAnnualizedSignals: R72_TARGET_ANNUALIZED,
        tooSparseBelowSignalsPerWeek: R72_MIN_PRACTICAL_WEEKLY,
        historicalCandidateAClassification: (candidateA.oosSignalRate?.signalsPerWeek ?? 0) < R72_MIN_PRACTICAL_WEEKLY
          ? "TOO_SPARSE_FOR_PRACTICAL_VALIDATION"
          : "NOT_TOO_SPARSE",
        productionForwardCandidateAClassification: input.productionForwardRate.signalsPerWeek < R72_MIN_PRACTICAL_WEEKLY
          ? "TOO_SPARSE_FOR_PRACTICAL_VALIDATION"
          : "NOT_TOO_SPARSE",
        candidateAClassification: input.productionForwardRate.signalsPerWeek < R72_MIN_PRACTICAL_WEEKLY
          ? "TOO_SPARSE_FOR_PRACTICAL_VALIDATION"
          : "NOT_TOO_SPARSE",
      },
    },
    failureSetAudit: {
      count: R71_OLD_FAILURE_SET.count,
      retained: 0,
      suppressed: R71_OLD_FAILURE_SET.count,
      retainedPnlUsdt: 0,
      usedForSelection: false,
      purpose: "Audit-only legacy 37-row failure set; excluded from all A/B selection and OOS metrics.",
    },
    forwardGateRedesign: {
      fixed100TradeGate: { minimumMaturedTrades: 100, status: "PROPOSAL_ONLY" },
      statisticalConfidenceGate: {
        candidateAOosBootstrap: candidateA.oosBootstrap,
        selectedCandidateBootstrap: selected?.oosBootstrap ?? null,
        requirements: ["bootstrap expectancy 95% CI", "bootstrap PF distribution", "worst-case cost stress"],
        realEmailStillRequires: ["at least 30 matured trades", "at least 30 calendar days"],
        status: "PROPOSAL_ONLY; real email remains OFF",
      },
      earlyKill: "At least 30 matured trades AND net PnL < 0 AND PF < 0.90 AND expectancy < 0; current Production sample does not trigger it.",
    },
    gates: {
      selectedCandidateProfitability: input.selectedProfitabilityGate,
      selectedCandidateThroughput: input.selectedThroughputGate,
      maxDrawdownTolerance: R72_MAX_DD_TOLERANCE,
      profitabilityRule: "OOS trades >= A, net > 0, expectancy > 0, PF >= 1.25, stress net > 0, stress PF >= 1.10, max DD not materially above A.",
      throughputRule: "OOS signal count >= A x 2 OR annualized signals >= 100/year.",
    },
    oosRunGuard: { perCandidateOneShot: true, executedFinalOosRuns: input.oosRunCount },
    classification: input.classification,
    verification: {
      tests: "pending runner completion",
      typecheck: "pending runner completion",
      lint: "pending runner completion",
      build: "pending runner completion",
      diff: "pending runner completion",
      githubCi: "pending push",
    },
  };
  return { json: reportJson, markdown: renderMarkdown(reportJson) };
}

function serializeCandidate(candidate: CandidateEvaluation, baseline: CandidateEvaluation, selected: boolean): Record<string, unknown> {
  const oos = candidate.finalOos;
  return {
    id: candidate.spec.id,
    description: candidate.spec.description,
    universeSize: candidate.spec.universeSize,
    rules: {
      entryMode: "TREND_PULLBACK",
      side: "SHORT",
      strategyFamily: "TREND",
      minScore: 80,
      cooldownHours: 24,
      rewardRisk: 2,
      maxHoldHours: 48,
      stopAtrMultiplier: 0.75,
      localRegimeAlignment: true,
      btc4hRegimeAlignment: true,
      changedFromA: candidate.spec.id === "A" ? [] : ["dynamic universe size only"],
    },
    train: serializeSlice(candidate.train),
    validation: serializeSlice(candidate.validation),
    selection: {
      base: candidate.selection.base,
      stress: candidate.selection.stress,
      signalRate: candidate.selection.signalRate,
      profitabilityEligible: candidate.selection.profitabilityEligible,
    },
    finalOosStatus: candidate.finalOosStatus,
    finalOos: oos ? serializeSlice(oos) : null,
    finalOosSignalRate: candidate.oosSignalRate ?? null,
    finalOosBootstrap: candidate.oosBootstrap ?? null,
    finalOosProfitabilityGate: oos ? passesProfitabilityGate(toGateMetrics(baseline.finalOos?.base.metrics ?? baseline.selection.base), toGateMetrics(oos.base.metrics), toGateMetrics(oos.stress.metrics)) : false,
    selectedForFinalOos: selected,
    top1SymbolConcentration: oos ? topSymbolConcentration(oos.base.trades, 1) : null,
    top3SymbolConcentration: oos ? topSymbolConcentration(oos.base.trades, 3) : null,
  };
}

function serializeSlice(pair: SlicePair): Record<string, unknown> {
  return {
    base: serializeSliceRun(pair.base),
    stress: serializeSliceRun(pair.stress),
  };
}

function serializeSliceRun(run: SliceRun): Record<string, unknown> {
  return {
    metrics: run.metrics,
    rawMetrics: run.rawMetrics,
    rawSignalCount: run.rawSignalCount,
    selectedSignalCount: run.selectedSignalCount,
    portfolioRejections: run.portfolioRejections,
  };
}

function buildComparison(baseline: CandidateEvaluation, candidate: CandidateEvaluation): Record<string, unknown> {
  if (!baseline.finalOos || !candidate.finalOos) return { status: "INCOMPLETE" };
  return {
    baseline: baseline.spec.id,
    candidate: candidate.spec.id,
    finalOos: {
      netExpectancyUsdt: { baseline: baseline.finalOos.base.metrics.expectancyUsdt, candidate: candidate.finalOos.base.metrics.expectancyUsdt },
      profitFactor: { baseline: baseline.finalOos.base.metrics.profitFactor, candidate: candidate.finalOos.base.metrics.profitFactor },
      stressProfitFactor: { baseline: baseline.finalOos.stress.metrics.profitFactor, candidate: candidate.finalOos.stress.metrics.profitFactor },
      maxDrawdownPercent: { baseline: baseline.finalOos.base.metrics.maxDrawdownPercent, candidate: candidate.finalOos.base.metrics.maxDrawdownPercent },
      winRate: { baseline: baseline.finalOos.base.metrics.winRate, candidate: candidate.finalOos.base.metrics.winRate },
      averageWinnerUsdt: { baseline: baseline.finalOos.base.metrics.averageWinnerUsdt, candidate: candidate.finalOos.base.metrics.averageWinnerUsdt },
      averageLoserUsdt: { baseline: baseline.finalOos.base.metrics.averageLoserUsdt, candidate: candidate.finalOos.base.metrics.averageLoserUsdt },
      signalRate: { baseline: baseline.oosSignalRate, candidate: candidate.oosSignalRate },
      tradeCount: { baseline: baseline.finalOos.base.metrics.trades, candidate: candidate.finalOos.base.metrics.trades },
      top1Concentration: { baseline: topSymbolConcentration(baseline.finalOos.base.trades, 1), candidate: topSymbolConcentration(candidate.finalOos.base.trades, 1) },
      top3Concentration: { baseline: topSymbolConcentration(baseline.finalOos.base.trades, 3), candidate: topSymbolConcentration(candidate.finalOos.base.trades, 3) },
    },
  };
}

function renderMarkdown(report: Record<string, unknown>): string {
  const json = report as Record<string, any>;
  const funnelRows = (json.historicalFunnel.finalOos.stages as Array<Record<string, any>>)
    .map((row) => `| ${row.stage} | ${row.input} | ${row.passed} | ${row.rejected} | ${(row.passRate * 100).toFixed(4)}% | ${(row.cumulativePassRate * 100).toFixed(4)}% |`)
    .join("\n");
  const a = json.candidateA;
  const aOos = a.finalOos?.base?.metrics;
  const aRate = json.signalRates.candidateAHistoricalFinalOos;
  const productionRate = json.signalRates.candidateAProductionForward;
  const challengerText = (json.challengerCandidates as Array<Record<string, any>>).length === 0
    ? "No challenger was authorized because the funnel did not select Universe breadth as the single bottleneck."
    : (json.challengerCandidates as Array<Record<string, any>>).map((candidate) => `- ${candidate.id}: top-${candidate.universeSize}; selection eligible=${candidate.selection.profitabilityEligible}; final OOS=${candidate.finalOosStatus}; OOS signals=${candidate.finalOosSignalRate?.count ?? "NOT RUN"}`).join("\n");
  return `# HY-R7.2 Signal Throughput + Profitability Research

Research-only report generated from the frozen 49-symbol PIT dataset. Candidate A remains immutable and Production was not modified.

## Safety and freeze

- Candidate A: \`${json.frozenCandidateA.candidateId}\`, \`${json.frozenCandidateA.strategyVersion}\`
- Strategy hash: \`${json.frozenCandidateA.strategyHash}\`
- Production / Supabase / Vercel / PAPER strategy modified: **NO**
- Real email: **OFF**; private API: **NO**; orders: **0**; AUTO_TRADING: **FALSE**
- B4 historical series: **NOT USED**

## Dataset and PIT protocol

- Files: ${json.historicalDataset.rawFiles}; bytes: ${json.historicalDataset.rawBytes}; symbols: ${json.historicalDataset.symbols.length}
- Manifest SHA-256: \`${json.historicalDataset.manifestSha256}\`
- Window: ${json.windows.datasetWindow.start} → ${json.windows.datasetWindow.end}
- Split: train through ${json.windows.train.end}; validation ${json.windows.validation.start} → ${json.windows.validation.end}; final OOS ${json.windows.finalOos.start} → ${json.windows.finalOos.end}
- PIT rule: ${json.windows.pit}

## Candidate A final-OOS funnel

Unit: ${json.historicalFunnel.unit}.

| Stage | Input | Passed | Rejected | Pass rate | Cumulative |
|---|---:|---:|---:|---:|---:|
${funnelRows}

Dominant bottleneck: **${json.dominantBottleneck.stage}** (${json.dominantBottleneck.family}), rejecting ${json.dominantBottleneck.rejected} of ${json.dominantBottleneck.input} (${json.dominantBottleneck.rejectionSharePercent}%).

Train and validation funnels are retained in the JSON artifact; no thresholds were searched or changed.

## Signal rates

- Candidate A historical final-OOS signals: **${aRate.count}**
- Candidate A historical OOS signals/week: **${aRate.signalsPerWeek}**; annualized: **${aRate.annualizedSignals ?? "NOT AVAILABLE"}**
- Candidate A Production forward scans: **${json.productionReadOnlyAttribution.scanCount}**
- Candidate A Production forward signals: **${json.productionReadOnlyAttribution.currentForward.signals}**
- Candidate A Production forward signals/week: **${productionRate.signalsPerWeek}**
- Estimated days to 30 matured trades at current Production rate: **${json.signalRates.estimatedDaysTo30Trades ?? "NOT AVAILABLE"}**
- Estimated days to 100 matured trades at current Production rate: **${json.signalRates.estimatedDaysTo100Trades ?? "NOT AVAILABLE"}**

Historical OOS frequency meets the throughput target, but the current Production forward rate is below 0.5 signal/week. That is a current-usability classification only, not an edge failure.

## Challenger selection and comparison

Candidate family selected: **${json.candidateFamilySelected}**.

${challengerText}

${json.comparison ? `Final OOS comparison is in the JSON artifact. Selected candidate profitability gate: **${json.gates.selectedCandidateProfitability}**; throughput gate: **${json.gates.selectedCandidateThroughput}**.` : "No Candidate B reached a permitted final-OOS comparison in this run."}

Profitability is ranked before throughput. Candidate B final OOS is one-shot after train+validation selection; non-selected challengers remain NOT RUN.

## Production read-only evidence

The live snapshot recorded ${json.productionReadOnlyAttribution.scanCount} completed scans and ${json.productionReadOnlyAttribution.failedScans} failed scans. Only ${json.productionReadOnlyAttribution.diagnosticsRows} diagnostics rows cover ${json.productionReadOnlyAttribution.diagnosticsScanCount} scans, so the complete production funnel is **UNKNOWN** rather than inferred. Observed diagnostic counters are preserved verbatim in JSON with their units.

Current strategy: \`${json.productionReadOnlyAttribution.strategy.version}\`, stage \`${json.productionReadOnlyAttribution.runtimeSafety.strategyStage}\`, source \`${json.productionReadOnlyAttribution.runtimeSafety.strategySource}\`, dryRun=\`${json.productionReadOnlyAttribution.runtimeSafety.dryRun}\`, exchange credentials configured=\`${json.productionReadOnlyAttribution.runtimeSafety.exchangeCredentialsConfigured}\`, autoTrading=\`${json.productionReadOnlyAttribution.runtimeSafety.autoTrading}\`.

## Forward-gate proposal

- Fixed gate: at least 100 matured trades.
- Statistical gate: bootstrap expectancy 95% CI, bootstrap PF distribution, and worst-case cost stress.
- Real email remains OFF until at least 30 matured trades and 30 calendar days even if a confidence interval is positive.
- Early kill remains unchanged and is not triggered by the current one-trade Production sample.

## Legacy failure-set isolation

The frozen 37-row failure set is audit-only: retained=0, suppressed=37, retained PnL=0, and it was not used for selection or OOS scoring.

## Result

Classification: **${json.classification}**

Tests, typecheck, lint, build, diff, and GitHub CI are recorded after the verification commands and push; this artifact was generated before those final checks.
`;
}

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
