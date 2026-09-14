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
import type { BacktestTrade, HistoricalDataset, PortfolioBacktestResult } from "@/lib/backtest/types";
import { classifyRegime } from "@/lib/core/market-regime";
import { DEFAULT_STRATEGY_PARAMS, type StrategyParams } from "@/lib/core/strategies";
import type { Candle, MarketRegime, ScoredCandidate } from "@/lib/core/types";
import {
  calculateResearchMetrics,
  calculateMfeMae,
  sourceTimeForEntry,
  topSymbolConcentration,
  type ResearchMetrics,
} from "@/lib/research/r7-1";
import { validateFrozenFailureSet } from "@/lib/research/r7-1a";
import { bootstrapConfidence, calculateSignalRate, type SignalRate } from "@/lib/research/r7-2";
import { R73_AUTHORITATIVE_A_OOS } from "@/lib/research/r7-3";
import {
  assertCandidateAReproduction,
  assertD1LocalRangeOnly,
  assertD2PitGlobalRange,
  assertForwardAuditIsNotSelectionInput,
  assertMaximumRangeCandidates,
  assertRangeReclaimFrozen,
  classifyR75,
  countScoreBand,
  passesCandidateEPortfolioGate,
  passesR75FinalGate,
  passesR75SelectionGate,
  passesR75Throughput,
  rankR75SelectionRows,
  R75_AUTHORITATIVE_A,
  R75_BASE_RESEARCH_HEAD,
  R75_CANDIDATE_A_ID,
  R75_CANDIDATE_E_ID,
  R75_COMMON_SETTINGS,
  R75_D1_ID,
  R75_D2_ID,
  R75_FORWARD_START,
  R75_RANGE_DEFAULTS,
  R75_REPORT_VERSION,
  R75_STRATEGY_HASH,
  R75_STRATEGY_VERSION,
  R75CandidateEFreeze,
  R75FinalOosRunGuard,
} from "@/lib/research/r7-5-range-research";

const DATA_DIRECTORY = resolve("data", "validation-cache");
const FORWARD_DATA_DIRECTORY = resolve(".tmp-r74", "market-data");
const OUTPUT_JSON_PATH = resolve("reports", "hy-r7.5-range-regime-research.json");
const OUTPUT_MD_PATH = resolve("reports", "hy-r7.5-range-regime-research.md");
const OUTPUT_MANIFEST_PATH = resolve("reports", "hy-r7.5-range-research-manifest.json");
const R71A_REPORT_PATH = resolve("reports", "hy-r7.1a-candidate-adjudication.json");
const R74_REPORT_PATH = resolve("reports", "hy-r7.4-forward-parity-regime-audit.json");
const FAILURE_SET_PATH = resolve("reports", "hy-r7.1-old-email-failure-ledger.csv");

const WINDOW_START = Date.parse("2025-08-09T02:15:00.000Z");
const WINDOW_END = Date.parse("2026-08-09T02:14:59.999Z");
const VALIDATION_START = Date.parse("2026-02-09T02:15:00.000Z");
const FINAL_OOS_START = Date.parse("2026-05-09T02:15:00.000Z");
const EMBARGO_MS = 48 * 60 * 60 * 1000;
const TRAIN_END = VALIDATION_START - EMBARGO_MS;
const VALIDATION_END = FINAL_OOS_START - EMBARGO_MS;
const CACHE_VERSION = "candidate-cache-v4";
const HOUR_MS = 60 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

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
  // Keep the existing R7 frozen convention: stress execution economics are
  // stressed, while the execution-cost eligibility check uses base costs.
  selectionTakerFeeRate: 0.0004,
  selectionSlippageBps: 2,
});

const CANDIDATE_A_PARAMS: StrategyParams = {
  ...DEFAULT_STRATEGY_PARAMS,
  entryMode: "TREND_PULLBACK",
  stopAtrMultiplier: 0.75,
};

const RANGE_PARAMS: StrategyParams = {
  ...DEFAULT_STRATEGY_PARAMS,
  entryMode: "RANGE_RECLAIM",
  stopAtrMultiplier: 0.75,
};

type CandidateKind = "A" | "D1" | "D2" | "E";

interface CostModel {
  name: string;
  takerFeeRate: number;
  slippageBps: number;
  selectionTakerFeeRate: number;
  selectionSlippageBps: number;
}

interface CandidateSpec {
  id: string;
  kind: CandidateKind;
  description: string;
  params: StrategyParams;
  strategyFamilies: Array<"TREND" | "BREAKOUT" | "MEAN_REVERSION">;
  minimumOosSignals: number;
  minimumAnnualizedSignals: number;
}

interface ExecutionMaps {
  dynamicUniverseByTimestamp: Map<number, Set<string>>;
  globalRegimeByTimestamp: Map<number, MarketRegime>;
}

interface ResearchContext {
  datasets: HistoricalDataset[];
  caches: Array<Map<number, ScoredCandidate[]>>;
  maps: ExecutionMaps;
}

interface SliceRun {
  metrics: ResearchMetrics;
  rawMetrics: ResearchMetrics;
  rawSignalCount: number;
  selectedSignalCount: number;
  signalTimes: number[];
  trades: BacktestTrade[];
  portfolioRejections: PortfolioBacktestResult["rejectionCounts"];
}

interface SlicePair {
  base: SliceRun;
  stress: SliceRun;
}

interface CandidateEvaluation {
  spec: CandidateSpec;
  train: SlicePair;
  validation: SlicePair;
  selection: {
    base: ResearchMetrics;
    stress: ResearchMetrics;
    positiveBaseFolds: number;
    positiveStressFolds: number;
    distinctSymbols: number;
    stabilityScore: number;
    signalRate: SignalRate;
    gate: ReturnType<typeof passesR75SelectionGate>;
  };
  finalOos: SlicePair | null;
  finalOosGate: ReturnType<typeof passesR75FinalGate> | null;
  finalOosThroughput: ReturnType<typeof passesR75Throughput> | null;
  finalOosSignalRate: SignalRate | null;
  finalOosBootstrap: ReturnType<typeof bootstrapConfidence> | null;
  selectedForFinalOos: boolean;
}

interface ForwardAuditSummary {
  status: "RUN" | "NOT_RUN";
  reason?: string;
  start: string;
  end: string | null;
  calendarDays: number | null;
  candidateId: string | null;
  wouldHaveSignals: number | null;
  longSignals: number | null;
  shortSignals: number | null;
  symbols: string[];
  signalsPerWeek: number | null;
  estimatedMaturedTrades: number | null;
  hypotheticalPaperPnlUsdt: number | null;
  hypotheticalPaperMetrics: ResearchMetrics | null;
  stressHypotheticalPaperPnlUsdt: number | null;
  score79To81RawCandidateCount: number | null;
}

interface ForwardAudit extends ForwardAuditSummary {
  candidateE: ForwardAuditSummary | null;
  postHocAudit: true;
  independentValidation: false;
}

async function main(): Promise<void> {
  assertRangeReclaimFrozen(RANGE_PARAMS);
  assertMaximumRangeCandidates([R75_D1_ID, R75_D2_ID]);
  assertForwardAuditIsNotSelectionInput({
    selectionDataset: "R7.1 authoritative 20-symbol validation-cache",
    forwardUsedForSelection: false,
  });

  const historical = await loadHistoricalData();
  const candidateA = buildCandidateSpec("A");
  const candidateAContext: ResearchContext = {
    datasets: historical.datasets,
    caches: historical.aCaches,
    maps: historical.aMaps,
  };

  // This is the mandatory frozen-authority gate. No RANGE cache is built
  // until Candidate A has reproduced the R7.1A final OOS metrics.
  console.log("Reproducing frozen Candidate A before RANGE research");
  const candidateAOos = runSlicePair(candidateA, candidateAContext, FINAL_OOS_START, WINDOW_END);
  assertCandidateAReproduction(candidateAOos.base.metrics, candidateAOos.stress.metrics);
  const candidateAReproduction = {
    pass: true,
    expected: R75_AUTHORITATIVE_A,
    actual: { base: candidateAOos.base.metrics, stress: candidateAOos.stress.metrics },
  };

  const rangeCaches = historical.datasets.map((dataset, index) => {
    console.log(`Building frozen RANGE_RECLAIM cache ${index + 1}/${historical.datasets.length}: ${dataset.symbol}`);
    return buildCandidateCache(dataset, RANGE_PARAMS, WINDOW_END);
  });
  const rangeMaps = buildExecutionMaps(historical.datasets, rangeCaches);
  const d1Context: ResearchContext = {
    datasets: historical.datasets,
    caches: rangeCaches,
    maps: rangeMaps,
  };
  const d2Caches = rangeCaches.map((cache, datasetIndex) => filterByGlobalRange(
    cache,
    historical.datasets[datasetIndex],
    rangeMaps.globalRegimeByTimestamp,
  ));
  const d2Context: ResearchContext = {
    datasets: historical.datasets,
    caches: d2Caches,
    maps: rangeMaps,
  };

  const d1 = evaluateSelection(buildCandidateSpec("D1"), d1Context);
  const d2 = evaluateSelection(buildCandidateSpec("D2"), d2Context);
  const rangeCandidates = [d1, d2];
  const selectionRanking = rankR75SelectionRows(rangeCandidates.map(toSelectionRow));
  const selectedId = selectionRanking.find((row) => row.profitabilityEligible)?.id ?? null;
  const selected = rangeCandidates.find((candidate) => candidate.spec.id === selectedId) ?? null;

  let selectedD: CandidateEvaluation | null = null;
  let candidateE: CandidateEvaluation | null = null;
  let eFreeze: R75CandidateEFreeze | null = null;
  const oosGuard = new R75FinalOosRunGuard();
  if (selected) {
    // Candidate E is frozen before either selected D* or E final OOS is run.
    eFreeze = new R75CandidateEFreeze();
    eFreeze.freeze(selected.spec.id);
    const selectedContext = selected.spec.kind === "D1" ? d1Context : d2Context;
    selectedD = oosGuard.run(selected.spec.id, () => {
      const finalOos = runSlicePair(selected.spec, selectedContext, FINAL_OOS_START, WINDOW_END);
      return attachFinalOos(selected, finalOos, true);
    });

    const eContext = buildCandidateEContext(historical.datasets, historical.aCaches, selectedContext.caches);
    candidateE = oosGuard.run(R75_CANDIDATE_E_ID, () => {
      const finalOos = runSlicePair(buildCandidateSpec("E"), eContext, FINAL_OOS_START, WINDOW_END);
      return attachFinalOos(candidateEEvaluationFor(finalOos), finalOos, true);
    });
  }

  const forwardAudit = selected
    ? await runForwardAudit(selected.spec, selected.spec.kind === "D1" ? "D1" : "D2", selectedId, eFreeze)
    : notRunForwardAudit("No D1/D2 candidate passed train + validation selection; no D*/E forward audit was authorized.");

  const dFinalPass = Boolean(selectedD?.finalOosGate?.pass);
  const dFinalThroughputPass = Boolean(selectedD?.finalOosThroughput?.pass);
  const eFinalPortfolio = selectedD && candidateE
    ? passesCandidateEPortfolioGate(candidateE.finalOos!.base.metrics, candidateE.finalOos!.stress.metrics, candidateAOos.base.metrics)
    : null;
  const eFinalThroughputPass = Boolean(candidateE?.finalOosThroughput?.pass);
  const classification = classifyR75({
    authoritativeCandidateAReproduced: candidateAReproduction.pass,
    selectedRange: Boolean(selected),
    selectedOosTradeCount: selectedD?.finalOos?.base.metrics.trades ?? null,
    selectedDPass: dFinalPass,
    selectedDThroughputPass: dFinalThroughputPass,
    candidateEPass: Boolean(eFinalPortfolio?.pass),
    candidateEThroughputPass: eFinalThroughputPass,
  });

  const r74Evidence = await loadR74Evidence();
  const failureSet = await loadFailureSetEvidence();
  const report = buildReport({
    historical,
    candidateAOos,
    candidateAReproduction,
    candidates: rangeCandidates,
    selected,
    selectedD,
    candidateE,
    eFreeze,
    eFinalPortfolio,
    selectionRanking,
    oosGuard,
    forwardAudit,
    r74Evidence,
    failureSet,
    classification,
  });
  await writeReports(report, historical.manifestRows);
  console.log(JSON.stringify({
    classification,
    candidateAReproduced: candidateAReproduction.pass,
    d1: summarizeCandidate(d1),
    d2: summarizeCandidate(d2),
    selected: selected?.spec.id ?? null,
    candidateE: candidateE ? summarizeCandidate(candidateE) : null,
    finalOosRuns: oosGuard.runCount,
  }, null, 2));
}

function buildCandidateSpec(kind: CandidateKind): CandidateSpec {
  if (kind === "A") {
    return {
      id: R75_CANDIDATE_A_ID,
      kind,
      description: "Frozen R7.1A Candidate A; baseline reproduction only.",
      params: CANDIDATE_A_PARAMS,
      strategyFamilies: ["TREND"],
      minimumOosSignals: 0,
      minimumAnnualizedSignals: 0,
    };
  }
  if (kind === "D1") {
    return {
      id: R75_D1_ID,
      kind,
      description: "RANGE_RECLAIM with local RANGE only; LONG + SHORT; no BTC directional filter.",
      params: RANGE_PARAMS,
      strategyFamilies: ["MEAN_REVERSION"],
      minimumOosSignals: 29,
      minimumAnnualizedSignals: 100,
    };
  }
  if (kind === "D2") {
    return {
      id: R75_D2_ID,
      kind,
      description: "D1 plus PIT BTCUSDT 4h global RANGE; no directional globalRegimeAlignment.",
      params: RANGE_PARAMS,
      strategyFamilies: ["MEAN_REVERSION"],
      minimumOosSignals: 29,
      minimumAnnualizedSignals: 100,
    };
  }
  return {
    id: R75_CANDIDATE_E_ID,
    kind: "E",
    description: "Frozen Candidate A in BEAR plus selected D* in RANGE, shared caps and cooldown.",
    params: RANGE_PARAMS,
    strategyFamilies: ["TREND", "MEAN_REVERSION"],
    minimumOosSignals: 58,
    minimumAnnualizedSignals: 200,
  };
}

async function loadHistoricalData(): Promise<{
  datasets: HistoricalDataset[];
  aCaches: Array<Map<number, ScoredCandidate[]>>;
  aMaps: ExecutionMaps;
  symbols: string[];
  rawFiles: number;
  manifestRows: string[];
  manifestSha256: string;
  coverage: { earliestOpenTime: string; latestCloseTime: string; authoritativeSelection: true };
}> {
  const datasets: HistoricalDataset[] = [];
  const manifestRows: string[] = [];
  for (const symbol of FIXED_SYMBOLS) {
    const filename = `${symbol}-${WINDOW_START}-${WINDOW_END}.json`;
    const path = resolve(DATA_DIRECTORY, filename);
    const bytes = await readFile(path);
    const dataset = JSON.parse(bytes.toString("utf8")) as HistoricalDataset;
    assertHistoricalDatasetIntegrity(dataset);
    if (dataset.symbol !== symbol) throw new Error(`R7.5 dataset filename/symbol mismatch: ${symbol}`);
    if (dataset.candles["15m"].at(-1)?.closeTime !== WINDOW_END) {
      throw new Error(`R7.5 dataset ${symbol} does not end at the frozen R7.1 boundary`);
    }
    datasets.push(dataset);
    manifestRows.push(`${filename}:${sha256(bytes)}`);
  }
  const aCaches = await Promise.all(datasets.map((dataset) => loadAuthoritativeCache(dataset)));
  const aMaps = buildExecutionMaps(datasets, aCaches);
  const earliest = Math.min(...datasets.map((dataset) => dataset.candles["15m"][0]?.openTime ?? Number.POSITIVE_INFINITY));
  const latest = Math.max(...datasets.map((dataset) => dataset.candles["15m"].at(-1)?.closeTime ?? 0));
  return {
    datasets,
    aCaches,
    aMaps,
    symbols: [...FIXED_SYMBOLS],
    rawFiles: datasets.length,
    manifestRows: [...manifestRows].sort(),
    manifestSha256: sha256(Buffer.from(`${[...manifestRows].sort().join("\n")}\n`, "utf8")),
    coverage: {
      earliestOpenTime: new Date(earliest).toISOString(),
      latestCloseTime: new Date(latest).toISOString(),
      authoritativeSelection: true,
    },
  };
}

async function loadAuthoritativeCache(dataset: HistoricalDataset): Promise<Map<number, ScoredCandidate[]>> {
  const descriptor = JSON.stringify({
    version: CACHE_VERSION,
    symbol: dataset.symbol,
    windowEnd: WINDOW_END,
    params: JSON.stringify(CANDIDATE_A_PARAMS),
    dataFingerprint: historicalDatasetFingerprint(dataset),
  });
  const hash = sha256(Buffer.from(descriptor, "utf8")).slice(0, 20);
  const path = resolve("data", "candidate-cache", `${dataset.symbol}-${hash}.json`);
  try {
    const payload = JSON.parse(await readFile(path, "utf8")) as {
      version?: string;
      descriptor?: string;
      entries?: Array<[number, ScoredCandidate[]]>;
    };
    if (payload.version === CACHE_VERSION && payload.descriptor === descriptor && Array.isArray(payload.entries)) {
      return new Map(payload.entries);
    }
  } catch {
    // The cache is disposable research acceleration; rebuilding does not
    // mutate the authoritative dataset or Production state.
  }
  return buildCandidateCache(dataset, CANDIDATE_A_PARAMS, WINDOW_END);
}

function buildExecutionMaps(
  datasets: HistoricalDataset[],
  caches: Array<Map<number, ScoredCandidate[]>>,
): ExecutionMaps {
  const entryTimes = [...new Set(caches.flatMap((cache, index) => [...cache.keys()]
    .map((key) => datasets[index]?.candles["15m"][key]?.closeTime)
    .filter((value): value is number => value !== undefined)))].sort((left, right) => left - right);
  return {
    dynamicUniverseByTimestamp: buildDynamicUniverseByTimestamp(datasets, entryTimes, R75_COMMON_SETTINGS.dynamicUniverseSize, R75_COMMON_SETTINGS.dynamicUniverseLookbackDays),
    globalRegimeByTimestamp: buildGlobalRegimeByTimestamp(datasets, entryTimes, "BTCUSDT", "4h"),
  };
}

function filterByGlobalRange(
  cache: Map<number, ScoredCandidate[]>,
  dataset: HistoricalDataset,
  globalRegimes: Map<number, MarketRegime>,
): Map<number, ScoredCandidate[]> {
  const filtered = new Map<number, ScoredCandidate[]>();
  for (const [index, candidates] of cache.entries()) {
    const timestamp = dataset.candles["15m"][index]?.closeTime;
    if (timestamp !== undefined && globalRegimes.get(timestamp) === "RANGE") filtered.set(index, candidates);
  }
  return filtered;
}

function evaluateSelection(spec: CandidateSpec, context: ResearchContext): CandidateEvaluation {
  if (spec.kind === "D1") assertD1LocalRangeOnly({ localRegime: "RANGE", globalRegimeFilter: false });
  if (spec.kind === "D2") assertD2PitGlobalRange({ localRegime: "RANGE", globalRegime: "RANGE", usesDirectionalGlobalAlignment: false });
  const train = runSlicePair(spec, context, WINDOW_START, TRAIN_END);
  const validation = runSlicePair(spec, context, VALIDATION_START, VALIDATION_END);
  const baseTrades = [...train.base.trades, ...validation.base.trades];
  const stressTrades = [...train.stress.trades, ...validation.stress.trades];
  const base = calculateResearchMetrics(baseTrades);
  const stress = calculateResearchMetrics(stressTrades);
  const distinctSymbols = new Set(baseTrades.map((trade) => trade.symbol)).size;
  const positiveBaseFolds = [train.base.metrics, validation.base.metrics].filter((metrics) => metrics.netPnlUsdt > 0).length;
  const positiveStressFolds = [train.stress.metrics, validation.stress.metrics].filter((metrics) => metrics.netPnlUsdt > 0).length;
  return {
    spec,
    train,
    validation,
    selection: {
      base,
      stress,
      positiveBaseFolds,
      positiveStressFolds,
      distinctSymbols,
      stabilityScore: positiveBaseFolds + positiveStressFolds,
      signalRate: calculateSignalRate([...train.base.signalTimes, ...validation.base.signalTimes], WINDOW_START, VALIDATION_END),
      gate: passesR75SelectionGate(base, stress, positiveBaseFolds, distinctSymbols),
    },
    finalOos: null,
    finalOosGate: null,
    finalOosThroughput: null,
    finalOosSignalRate: null,
    finalOosBootstrap: null,
    selectedForFinalOos: false,
  };
}

function runSlicePair(spec: CandidateSpec, context: ResearchContext, start: number, end: number): SlicePair {
  return {
    base: runSlice(spec, context, start, end, BASE_COST),
    stress: runSlice(spec, context, start, end, STRESS_COST),
  };
}

function runSlice(
  spec: CandidateSpec,
  context: ResearchContext,
  start: number,
  end: number,
  cost: CostModel,
): SliceRun {
  const portfolio = runPortfolioBacktest(context.datasets, spec.params, {
    ...backtestOptions(spec),
    ...costOptions(cost),
    evaluationStartTime: start,
    evaluationEndTime: end,
    candidateCaches: context.caches,
    ...context.maps,
  });
  return {
    metrics: calculateResearchMetrics(portfolio.trades),
    rawMetrics: calculateResearchMetrics(portfolio.rawTrades),
    rawSignalCount: portfolio.rawTrades.length,
    selectedSignalCount: portfolio.trades.length,
    signalTimes: portfolio.trades.map((trade) => sourceTimeForEntry(trade.entryTime)),
    trades: portfolio.trades,
    portfolioRejections: portfolio.rejectionCounts,
  };
}

function backtestOptions(spec: CandidateSpec): BacktestOptions {
  const candidateA = spec.kind === "A";
  return {
    initialCapitalUsdt: 10_000,
    minimumSampleDays: 0,
    minScore: R75_COMMON_SETTINGS.minScore,
    maxHoldHours: R75_COMMON_SETTINGS.maxHoldHours,
    rewardRisk: R75_COMMON_SETTINGS.rewardRisk,
    singleSignalRiskCapUsdt: R75_COMMON_SETTINGS.singleSignalRiskCapUsdt,
    dailyRiskBudgetUsdt: R75_COMMON_SETTINGS.dailyRiskBudgetUsdt,
    dailyLossLimitUsdt: R75_COMMON_SETTINGS.dailyRiskBudgetUsdt,
    maxConcurrentPositions: R75_COMMON_SETTINGS.maxConcurrentPositions,
    maxEmailsPerDay: 10,
    maxEmailsPerScan: 6,
    capitalFloorUsdt: 0,
    marginUsdt: R75_COMMON_SETTINGS.marginUsdt,
    leverage: R75_COMMON_SETTINGS.leverage,
    riskPerTradeUsdt: R75_COMMON_SETTINGS.riskPerTradeUsdt,
    maxPositionNotionalUsdt: R75_COMMON_SETTINGS.maxPositionNotionalUsdt,
    requireRegimeAlignment: true,
    sideFilter: candidateA ? "SHORT" : undefined,
    strategyFamilies: spec.strategyFamilies,
    maxExecutionCostRiskFraction: R75_COMMON_SETTINGS.maxExecutionCostRiskFraction,
    dynamicUniverseSize: R75_COMMON_SETTINGS.dynamicUniverseSize,
    dynamicUniverseLookbackDays: R75_COMMON_SETTINGS.dynamicUniverseLookbackDays,
    globalReferenceSymbol: "BTCUSDT",
    globalReferenceTimeframe: "4h",
    globalRegimeAlignment: candidateA,
    entryDelayBars: 1,
    cooldownHours: R75_COMMON_SETTINGS.cooldownHours,
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

function attachFinalOos(
  evaluation: CandidateEvaluation,
  finalOos: SlicePair,
  selected: boolean,
): CandidateEvaluation {
  const finalOosGate = evaluation.spec.kind === "E"
    ? passesR75FinalGate(finalOos.base.metrics, finalOos.stress.metrics, 58)
    : passesR75FinalGate(finalOos.base.metrics, finalOos.stress.metrics, 29);
  return {
    ...evaluation,
    finalOos,
    finalOosGate,
    finalOosThroughput: passesR75Throughput(
      finalOos.base.selectedSignalCount,
      calculateSignalRate(finalOos.base.signalTimes, FINAL_OOS_START, WINDOW_END).annualizedSignals,
      evaluation.spec.minimumOosSignals,
      evaluation.spec.minimumAnnualizedSignals,
    ),
    finalOosSignalRate: calculateSignalRate(finalOos.base.signalTimes, FINAL_OOS_START, WINDOW_END),
    finalOosBootstrap: bootstrapConfidence(finalOos.base.trades.map((trade) => trade.pnlUsdt)),
    selectedForFinalOos: selected,
  };
}

function candidateEEvaluationFor(finalOos: SlicePair): CandidateEvaluation {
  return {
    spec: buildCandidateSpec("E"),
    train: emptySlicePair(),
    validation: emptySlicePair(),
    selection: {
      base: emptyMetrics(),
      stress: emptyMetrics(),
      positiveBaseFolds: 0,
      positiveStressFolds: 0,
      distinctSymbols: 0,
      stabilityScore: 0,
      signalRate: emptySignalRate(),
      gate: passesR75SelectionGate(emptyMetrics(), emptyMetrics(), 0, 0),
    },
    finalOos,
    finalOosGate: null,
    finalOosThroughput: null,
    finalOosSignalRate: null,
    finalOosBootstrap: null,
    selectedForFinalOos: true,
  };
}

function buildCandidateEContext(
  datasets: HistoricalDataset[],
  aCaches: Array<Map<number, ScoredCandidate[]>>,
  selectedRangeCaches: Array<Map<number, ScoredCandidate[]>>,
): ResearchContext {
  const allCaches = datasets.map((dataset, datasetIndex) => {
    const merged = new Map<number, ScoredCandidate[]>();
    const indices = new Set<number>([
      ...aCaches[datasetIndex].keys(),
      ...selectedRangeCaches[datasetIndex].keys(),
    ]);
    for (const index of indices) {
      const timestamp = dataset.candles["15m"][index]?.closeTime;
      if (timestamp === undefined) continue;
      // Candidate A is retained only in its original BEAR-aligned regime;
      // the selected range candidate is retained only in BTC global RANGE.
      const aCandidates = aCaches[datasetIndex].get(index)?.filter((candidate) => candidate.side === "SHORT") ?? [];
      const rangeCandidates = selectedRangeCaches[datasetIndex].get(index) ?? [];
      // The regime is resolved below after the shared map is available. Keep
      // both families here only temporarily; the second pass applies the
      // mutually exclusive E routing.
      merged.set(index, [...aCandidates, ...rangeCandidates]);
    }
    return merged;
  });
  const maps = buildExecutionMaps(datasets, allCaches);
  const routedCaches = datasets.map((dataset, datasetIndex) => {
    const routed = new Map<number, ScoredCandidate[]>();
    for (const index of allCaches[datasetIndex].keys()) {
      const timestamp = dataset.candles["15m"][index]?.closeTime;
      if (timestamp === undefined) continue;
      const globalRegime = maps.globalRegimeByTimestamp.get(timestamp);
      const aCandidates = aCaches[datasetIndex].get(index)?.filter((candidate) => candidate.side === "SHORT") ?? [];
      const rangeCandidates = selectedRangeCaches[datasetIndex].get(index) ?? [];
      if (globalRegime === "BEAR" && aCandidates.length > 0) routed.set(index, [aCandidates[0]]);
      if (globalRegime === "RANGE" && rangeCandidates.length > 0) routed.set(index, [rangeCandidates[0]]);
    }
    return routed;
  });
  const routedMaps = buildExecutionMaps(datasets, routedCaches);
  return { datasets, caches: routedCaches, maps: routedMaps };
}

function emptySlicePair(): SlicePair {
  return { base: emptySliceRun(), stress: emptySliceRun() };
}

function emptySliceRun(): SliceRun {
  return {
    metrics: emptyMetrics(),
    rawMetrics: emptyMetrics(),
    rawSignalCount: 0,
    selectedSignalCount: 0,
    signalTimes: [],
    trades: [],
    portfolioRejections: {
      maxConcurrentPositions: 0,
      singleSignalRisk: 0,
      dailyRiskBudget: 0,
      dailyLossLimit: 0,
      emailCap: 0,
      capitalFloor: 0,
    },
  };
}

function emptyMetrics(): ResearchMetrics {
  return calculateResearchMetrics([]);
}

function emptySignalRate(): SignalRate {
  return calculateSignalRate([], WINDOW_START, VALIDATION_END);
}

function toSelectionRow(candidate: CandidateEvaluation): {
  id: string;
  profitabilityEligible: boolean;
  stressProfitFactor: number;
  baseExpectancy: number;
  maxDrawdownPercent: number;
  stabilityScore: number;
  tradeCount: number;
} {
  return {
    id: candidate.spec.id,
    profitabilityEligible: candidate.selection.gate.pass,
    stressProfitFactor: candidate.selection.stress.profitFactor,
    baseExpectancy: candidate.selection.base.expectancyUsdt,
    maxDrawdownPercent: candidate.selection.base.maxDrawdownPercent,
    stabilityScore: candidate.selection.stabilityScore,
    tradeCount: candidate.selection.base.trades,
  };
}

function summarizeCandidate(candidate: CandidateEvaluation): Record<string, unknown> {
  return {
    id: candidate.spec.id,
    selection: {
      base: candidate.selection.base,
      stress: candidate.selection.stress,
      distinctSymbols: candidate.selection.distinctSymbols,
      positiveBaseFolds: candidate.selection.positiveBaseFolds,
      positiveStressFolds: candidate.selection.positiveStressFolds,
      gate: candidate.selection.gate,
    },
    finalOosStatus: candidate.finalOos ? "RUN" : "NOT_RUN_BEFORE_SELECTION",
    finalOos: candidate.finalOos ? { base: candidate.finalOos.base.metrics, stress: candidate.finalOos.stress.metrics } : null,
    finalOosGate: candidate.finalOosGate,
    finalOosThroughput: candidate.finalOosThroughput,
  };
}

async function runForwardAudit(
  selectedSpec: CandidateSpec,
  selectedKind: "D1" | "D2",
  selectedId: string | null,
  eFreeze: R75CandidateEFreeze | null,
): Promise<ForwardAudit> {
  if (!eFreeze || !selectedId) throw new Error("Forward audit requires Candidate E preregistration");
  eFreeze.assertFrozenBeforeOos();
  const forward = await loadForwardData();
  const forwardEnd = determineForwardEnd(forward.datasets);
  if (forwardEnd < Date.parse(R75_FORWARD_START)) {
    return notRunForwardAudit("Forward fixture ends before the frozen R7.4 observation start.");
  }
  const aCaches = forward.datasets.map((dataset) => buildCandidateCache(dataset, CANDIDATE_A_PARAMS, forwardEnd));
  const rangeCaches = forward.datasets.map((dataset) => buildCandidateCache(dataset, RANGE_PARAMS, forwardEnd));
  const rangeMaps = buildExecutionMaps(forward.datasets, rangeCaches);
  const selectedRangeCaches = selectedKind === "D1"
    ? rangeCaches
    : rangeCaches.map((cache, index) => filterByGlobalRange(cache, forward.datasets[index], rangeMaps.globalRegimeByTimestamp));
  const selectedContext: ResearchContext = {
    datasets: forward.datasets,
    caches: selectedRangeCaches,
    maps: buildExecutionMaps(forward.datasets, selectedRangeCaches),
  };
  const dRun = runSlicePair(selectedSpec, selectedContext, Date.parse(R75_FORWARD_START), forwardEnd);
  const eContext = buildCandidateEContext(forward.datasets, aCaches, selectedRangeCaches);
  const eRun = runSlicePair(buildCandidateSpec("E"), eContext, Date.parse(R75_FORWARD_START), forwardEnd);
  const dRawScores = [...(selectedKind === "D1" ? rangeCaches : selectedRangeCaches).flatMap((cache) => [...cache.values()].flat())]
    .map((candidate) => candidate.score);
  const eRawScores = [...eContext.caches.flatMap((cache) => [...cache.values()].flat())].map((candidate) => candidate.score);
  const dSummary = summarizeForwardRun(selectedSpec.id, dRun, forwardEnd, dRawScores);
  const eSummary = summarizeForwardRun(R75_CANDIDATE_E_ID, eRun, forwardEnd, eRawScores);
  return {
    ...dSummary,
    candidateE: eSummary,
    postHocAudit: true,
    independentValidation: false,
  };
}

function summarizeForwardRun(
  candidateId: string,
  run: SlicePair,
  forwardEnd: number,
  rawScores: number[],
): ForwardAuditSummary {
  const matured = run.base.trades.filter((trade) => isMaturedTrade(trade, forwardEnd));
  const paperMetrics = calculateResearchMetrics(matured);
  const rate = calculateSignalRate(run.base.trades.map((trade) => sourceTimeForEntry(trade.entryTime)), Date.parse(R75_FORWARD_START), forwardEnd);
  return {
    status: "RUN",
    reason: undefined,
    start: R75_FORWARD_START,
    end: new Date(forwardEnd).toISOString(),
    calendarDays: (forwardEnd - Date.parse(R75_FORWARD_START)) / (24 * HOUR_MS),
    candidateId,
    wouldHaveSignals: run.base.trades.length,
    longSignals: run.base.trades.filter((trade) => trade.side === "LONG").length,
    shortSignals: run.base.trades.filter((trade) => trade.side === "SHORT").length,
    symbols: [...new Set(run.base.trades.map((trade) => trade.symbol))].sort(),
    signalsPerWeek: rate.signalsPerWeek,
    estimatedMaturedTrades: matured.length,
    hypotheticalPaperPnlUsdt: paperMetrics.netPnlUsdt,
    hypotheticalPaperMetrics: paperMetrics,
    stressHypotheticalPaperPnlUsdt: calculateResearchMetrics(run.stress.trades.filter((trade) => isMaturedTrade(trade, forwardEnd))).netPnlUsdt,
    score79To81RawCandidateCount: countScoreBand(rawScores),
  };
}

function notRunForwardAudit(reason: string): ForwardAudit {
  return {
    status: "NOT_RUN",
    reason,
    start: R75_FORWARD_START,
    end: null,
    calendarDays: null,
    candidateId: null,
    wouldHaveSignals: null,
    longSignals: null,
    shortSignals: null,
    symbols: [],
    signalsPerWeek: null,
    estimatedMaturedTrades: null,
    hypotheticalPaperPnlUsdt: null,
    hypotheticalPaperMetrics: null,
    stressHypotheticalPaperPnlUsdt: null,
    score79To81RawCandidateCount: null,
    candidateE: null,
    postHocAudit: true,
    independentValidation: false,
  };
}

async function loadForwardData(): Promise<{ datasets: HistoricalDataset[] }> {
  const entries = await readdir(FORWARD_DATA_DIRECTORY, { withFileTypes: true });
  const datasets: HistoricalDataset[] = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name))) {
    const dataset = JSON.parse(await readFile(resolve(FORWARD_DATA_DIRECTORY, entry.name), "utf8")) as HistoricalDataset;
    assertHistoricalDatasetIntegrity(dataset);
    datasets.push(dataset);
  }
  if (!datasets.some((dataset) => dataset.symbol === "BTCUSDT")) throw new Error("Forward audit requires BTCUSDT");
  return { datasets };
}

function determineForwardEnd(datasets: HistoricalDataset[]): number {
  const btc = datasets.find((dataset) => dataset.symbol === "BTCUSDT");
  const end = btc?.candles["15m"].at(-1)?.closeTime;
  if (end === undefined) throw new Error("Forward BTCUSDT has no closed 15m endpoint");
  return end;
}

function buildReport(input: {
  historical: Awaited<ReturnType<typeof loadHistoricalData>>;
  candidateAOos: SlicePair;
  candidateAReproduction: Record<string, unknown>;
  candidates: CandidateEvaluation[];
  selected: CandidateEvaluation | null;
  selectedD: CandidateEvaluation | null;
  candidateE: CandidateEvaluation | null;
  eFreeze: R75CandidateEFreeze | null;
  eFinalPortfolio: ReturnType<typeof passesCandidateEPortfolioGate> | null;
  selectionRanking: Array<{ id: string; profitabilityEligible: boolean; stressProfitFactor: number; baseExpectancy: number; maxDrawdownPercent: number; stabilityScore: number; tradeCount: number }>;
  oosGuard: R75FinalOosRunGuard;
  forwardAudit: ForwardAudit;
  r74Evidence: Record<string, unknown>;
  failureSet: Record<string, unknown>;
  classification: string;
}): { json: Record<string, unknown>; markdown: string; manifest: Record<string, unknown> } {
  const selectedDAttribution = input.selectedD?.finalOos ? buildAttribution(input.selectedD.finalOos, input.historical.datasets, input.selectedD.spec.id) : null;
  const candidateEAttribution = input.candidateE?.finalOos ? buildAttribution(input.candidateE.finalOos, input.historical.datasets, input.candidateE.spec.id) : null;
  const selectedDFinalOos = input.selectedD?.finalOos;
  const candidateEFinalOos = input.candidateE?.finalOos;
  const finalOosRuns = input.selectedD && input.candidateE
    ? [input.selectedD.spec.id, input.candidateE.spec.id]
    : [];
  const json: Record<string, unknown> = {
    reportVersion: R75_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    purpose: "R7.5 frozen RANGE regime profitability research; research-only, no Production behavior or strategy parameters were changed.",
    pullRequest: {
      number: 9,
      branch: "research/hy-r7-profitability",
      baseResearchHead: R75_BASE_RESEARCH_HEAD,
      status: "DRAFT",
    },
    frozenAuthority: {
      candidateA: {
        candidateId: R75_CANDIDATE_A_ID,
        strategyVersion: R75_STRATEGY_VERSION,
        strategyHash: R75_STRATEGY_HASH,
        finalOosExpected: R75_AUTHORITATIVE_A,
        exactReproduction: input.candidateAReproduction,
      },
      r74Authorization: "MARKET_REGIME_DRIFT_CONFIRMED; RANGE share rose from 44.457% historical to 48.001% forward and final signal rate materially declined.",
      baseResearchHeadFrozen: true,
    },
    windows: {
      historicalDataset: { start: new Date(WINDOW_START).toISOString(), end: new Date(WINDOW_END).toISOString() },
      train: { start: new Date(WINDOW_START).toISOString(), end: new Date(TRAIN_END).toISOString() },
      validation: { start: new Date(VALIDATION_START).toISOString(), end: new Date(VALIDATION_END).toISOString() },
      finalOos: { start: new Date(FINAL_OOS_START).toISOString(), end: new Date(WINDOW_END).toISOString() },
      embargoHours: 48,
      forwardAudit: { start: R75_FORWARD_START, source: "R7.4 frozen forward snapshot; audit only" },
      pit: "Only closed 15m data through decision timestamp t; execution is next 15m bar open. Global BTC 4h regime is calculated from candles available through t.",
    },
    authoritativeSelectionDataset: {
      source: "R7.1 authoritative 20-symbol historical validation-cache",
      directory: "data/validation-cache",
      symbols: input.historical.symbols,
      rawFiles: input.historical.rawFiles,
      manifestRows: input.historical.manifestRows,
      manifestSha256: input.historical.manifestSha256,
      selectionUses49SymbolDataset: false,
      selectionUsesForwardData: false,
    },
    frozenRangeContract: {
      ...R75_RANGE_DEFAULTS,
      side: "LONG + SHORT",
      localRegime: "RANGE required",
      dynamicUniverse: "Top-10",
      commonSettings: R75_COMMON_SETTINGS,
      baseCosts: BASE_COST,
      stressCosts: STRESS_COST,
      noParameterSearch: true,
      noNewIndicators: true,
    },
    candidates: input.candidates.map((candidate) => serializeCandidate(candidate, input.selectedD, input.historical.datasets)),
    selection: {
      candidateIds: [R75_D1_ID, R75_D2_ID],
      maxCandidateGuard: true,
      rule: "Train + validation only: net > 0, expectancy > 0, PF >= 1.20, stress net > 0, stress PF >= 1.05, positive base folds >= 2, and at least 3 distinct symbols.",
      rankingRule: "Only profitability-eligible candidates are actionable; sort by stress PF, base expectancy, lower max DD, stability, trade count.",
      ranking: input.selectionRanking,
      selectedRangeCandidate: input.selected?.spec.id ?? null,
      rejectedCandidatesNotRunFinalOos: input.candidates.filter((candidate) => !candidate.finalOos).map((candidate) => candidate.spec.id),
      freezeBeforeOos: Boolean(input.eFreeze),
    },
    candidateAReproduction: {
      ...input.candidateAReproduction,
      finalOos: serializeSlicePair(input.candidateAOos),
      expectedFromR7_3: R73_AUTHORITATIVE_A_OOS,
    },
    selectedRangeFinalOos: input.selectedD && selectedDFinalOos ? {
      candidateId: input.selectedD.spec.id,
      status: "RUN_ONCE_AFTER_SELECTION",
      result: serializeSlicePair(selectedDFinalOos),
      gate: input.selectedD.finalOosGate,
      throughput: input.selectedD.finalOosThroughput,
      signalRate: input.selectedD.finalOosSignalRate,
      bootstrap: input.selectedD.finalOosBootstrap,
      attribution: selectedDAttribution,
      concentration: concentration(selectedDFinalOos.base.trades),
    } : { candidateId: null, status: "NOT_RUN_BEFORE_SELECTION" },
    candidateE: input.candidateE && candidateEFinalOos ? {
      candidateId: R75_CANDIDATE_E_ID,
      preregistration: {
        frozenBeforeSelectedDFinalOos: Boolean(input.eFreeze),
        selectedRangeCandidate: input.eFreeze?.selected ?? null,
        rules: "Candidate A for BEAR, selected D* for RANGE, shared 24h same-symbol cooldown, shared portfolio caps/daily budget, one highest-score candidate per symbol/timestamp, no double open.",
      },
      finalOos: {
        status: "RUN_ONCE_AFTER_PREREGISTRATION",
        result: serializeSlicePair(candidateEFinalOos),
        gate: input.candidateE.finalOosGate,
        portfolioGate: input.eFinalPortfolio,
        throughput: input.candidateE.finalOosThroughput,
        signalRate: input.candidateE.finalOosSignalRate,
        bootstrap: input.candidateE.finalOosBootstrap,
        attribution: candidateEAttribution,
        concentration: concentration(candidateEFinalOos.base.trades),
      },
    } : { candidateId: R75_CANDIDATE_E_ID, status: "NOT_RUN_NO_RANGE_SELECTION" },
    forwardAudit: input.forwardAudit,
    scoreParityWarning: {
      source: "reports/hy-r7.4-forward-parity-regime-audit.json",
      r74RawScoreExactParity: input.r74Evidence.rawScoreParity,
      r74QualifiedScoreParity: input.r74Evidence.qualifiedScoreParity,
      productionScoreParityRequiredBeforeActivation: Boolean(input.selectedD?.finalOosGate?.pass),
      forwardReplayCandidatesScore79To81: input.forwardAudit.score79To81RawCandidateCount,
      futureDeploymentBlocker: Boolean(input.selectedD?.finalOosGate?.pass),
    },
    attributionRequirements: {
      selectionD1D2RegimeImpact: input.candidates.map((candidate) => ({
        candidateId: candidate.spec.id,
        regimeImpact: (serializeCandidate(candidate, input.selectedD, input.historical.datasets).selection as Record<string, unknown>).regimeImpact,
      })),
      selectedD: selectedDAttribution,
      candidateE: candidateEAttribution,
      noSideDeletion: true,
      localRangeOnlyForD: true,
      globalRangeUsesPITBTC4h: true,
    },
    old37EmailFailureSetAudit: input.failureSet,
    artifacts: {
      sourceFiles: ["lib/research/r7-5-range-research.ts", "scripts/run-hy-r7-5-range-regime-research.ts"],
      testFiles: ["tests/hy-r7.5-range-regime-research.test.ts"],
      reportFiles: ["reports/hy-r7.5-range-regime-research.json", "reports/hy-r7.5-range-regime-research.md"],
      manifestFile: "reports/hy-r7.5-range-research-manifest.json",
      frozenInputs: ["reports/hy-r7.1a-candidate-adjudication.json", "reports/hy-r7.4-forward-parity-regime-audit.json"],
      noRawDatasetSubmitted: true,
    },
    finalOosRunGuard: {
      perCandidateOneShot: true,
      executedCandidateIds: finalOosRuns,
      runCount: input.oosGuard.runCount,
    },
    safety: {
      productionModified: false,
      supabaseModified: false,
      vercelModified: false,
      paperStrategyModified: false,
      strategyParametersChanged: false,
      realEmailsSent: 0,
      privateApiCalled: false,
      orders: 0,
      autoTrading: false,
      b4Touched: false,
      forwardUsedForSelection: false,
    },
    verification: {
      tests: process.env.HY_R75_TESTS ?? "pending final verification",
      typecheck: process.env.HY_R75_TYPECHECK ?? "pending final verification",
      lint: process.env.HY_R75_LINT ?? "pending final verification",
      build: process.env.HY_R75_BUILD ?? "pending final verification",
      diff: process.env.HY_R75_DIFF ?? "pending final verification",
      githubCi: process.env.HY_R75_GITHUB_CI ?? "pending push",
    },
    classification: input.classification,
  };
  const manifest = {
    manifestVersion: "hy-r7.5-data-manifest-v1",
    generatedAt: json.generatedAt,
    frozenBaseResearchHead: R75_BASE_RESEARCH_HEAD,
    historicalDataset: {
      representation: "UTF-8 newline-delimited sorted filename:raw-file-SHA256 rows",
      sha256: input.historical.manifestSha256,
      rows: input.historical.manifestRows,
    },
    sourceAndTestHashes: "populated when the runner writes the artifact; raw market datasets are not included",
  };
  return { json, markdown: renderMarkdown(json), manifest };
}

function serializeCandidate(candidate: CandidateEvaluation, selectedD: CandidateEvaluation | null, datasets: HistoricalDataset[]): Record<string, unknown> {
  const selectionTrades = [...candidate.train.base.trades, ...candidate.validation.base.trades];
  return {
    id: candidate.spec.id,
    description: candidate.spec.description,
    rules: {
      entryMode: "RANGE_RECLAIM",
      strategyFamily: "MEAN_REVERSION",
      side: "LONG + SHORT",
      localRegime: "RANGE",
      globalRegime: candidate.spec.kind === "D2" ? "PIT BTCUSDT 4h RANGE" : "NONE",
      globalRegimeAlignment: false,
      noDirectionalGlobalRegimeAlignment: true,
      noParameterSearch: true,
      noNewIndicators: true,
    },
    train: serializeSlicePair(candidate.train),
    validation: serializeSlicePair(candidate.validation),
    selection: {
      base: candidate.selection.base,
      stress: candidate.selection.stress,
      positiveBaseFolds: candidate.selection.positiveBaseFolds,
      positiveStressFolds: candidate.selection.positiveStressFolds,
      distinctSymbols: candidate.selection.distinctSymbols,
      stabilityScore: candidate.selection.stabilityScore,
      signalRate: candidate.selection.signalRate,
      gate: candidate.selection.gate,
      long: calculateResearchMetrics(selectionTrades.filter((trade) => trade.side === "LONG")),
      short: calculateResearchMetrics(selectionTrades.filter((trade) => trade.side === "SHORT")),
      regimeImpact: buildRegimeImpact(datasets, selectionTrades, WINDOW_START, VALIDATION_END, candidate.spec.id),
    },
    finalOosStatus: candidate.finalOos ? "RUN" : "NOT_RUN_BEFORE_SELECTION",
    finalOos: candidate.finalOos ? serializeSlicePair(candidate.finalOos) : null,
    finalOosGate: candidate.finalOosGate,
    finalOosThroughput: candidate.finalOosThroughput,
    finalOosSignalRate: candidate.finalOosSignalRate,
    finalOosBootstrap: candidate.finalOosBootstrap,
    selectedForFinalOos: candidate.selectedForFinalOos,
    comparedAgainst: selectedD && candidate.spec.kind !== "D1" && candidate.spec.kind !== "D2" ? R75_CANDIDATE_A_ID : null,
    historicalDatasetSymbols: datasets.map((dataset) => dataset.symbol),
  };
}

function serializeSlicePair(pair: SlicePair | null): Record<string, unknown> | null {
  if (!pair) return null;
  return { base: serializeSliceRun(pair.base), stress: serializeSliceRun(pair.stress) };
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

function buildAttribution(pair: SlicePair, datasets: HistoricalDataset[], candidateId: string): Record<string, unknown> {
  const baseTrades = pair.base.trades;
  const sourceTimes = baseTrades.map((trade) => decisionTimestampForTrade(trade));
  const globalMap = buildGlobalRegimeByTimestamp(datasets, sourceTimes, "BTCUSDT", "4h");
  const globalRegimeCounts: Record<MarketRegime, number> = { BULL: 0, BEAR: 0, RANGE: 0, UNKNOWN: 0 };
  const signalsByGlobalRegime: Record<MarketRegime, number> = { BULL: 0, BEAR: 0, RANGE: 0, UNKNOWN: 0 };
  const pnlByGlobalRegime: Record<MarketRegime, number> = { BULL: 0, BEAR: 0, RANGE: 0, UNKNOWN: 0 };
  for (const regime of globalMap.values()) globalRegimeCounts[regime] += 1;
  for (const trade of baseTrades) {
    const regime = globalMap.get(decisionTimestampForTrade(trade)) ?? "UNKNOWN";
    signalsByGlobalRegime[regime] += 1;
    pnlByGlobalRegime[regime] += trade.pnlUsdt;
  }
  const localRange = countLocalRangeObservations(datasets, FINAL_OOS_START, WINDOW_END);
  const totalObservations = countDecisionObservations(datasets, FINAL_OOS_START, WINDOW_END);
  return {
    candidateId,
    localRangeObservations: localRange,
    totalDecisionObservations: totalObservations,
    localRangeShare: totalObservations === 0 ? 0 : localRange / totalObservations,
    btcGlobalRegimeDistribution: globalRegimeCounts,
    signalsByGlobalRegime,
    pnlByGlobalRegime: roundRecord(pnlByGlobalRegime),
    long: calculateResearchMetrics(baseTrades.filter((trade) => trade.side === "LONG")),
    short: calculateResearchMetrics(baseTrades.filter((trade) => trade.side === "SHORT")),
    all: calculateResearchMetrics(baseTrades),
    mfeMae: calculateMfeMaeSummary(baseTrades, datasets),
  };
}

function buildRegimeImpact(
  datasets: HistoricalDataset[],
  trades: BacktestTrade[],
  start: number,
  end: number,
  candidateId: string,
): Record<string, unknown> {
  const btc = datasets.find((dataset) => dataset.symbol === "BTCUSDT");
  const timestamps = btc?.candles["15m"]
    .filter((candle, index, candles) => candle.closeTime >= start && candle.closeTime <= end && Boolean(candles[index + 1]))
    .map((candle) => candle.closeTime) ?? [];
  const globalMap = buildGlobalRegimeByTimestamp(datasets, timestamps, "BTCUSDT", "4h");
  const globalRegimeCounts: Record<MarketRegime, number> = { BULL: 0, BEAR: 0, RANGE: 0, UNKNOWN: 0 };
  const signalsByGlobalRegime: Record<MarketRegime, number> = { BULL: 0, BEAR: 0, RANGE: 0, UNKNOWN: 0 };
  const pnlByGlobalRegime: Record<MarketRegime, number> = { BULL: 0, BEAR: 0, RANGE: 0, UNKNOWN: 0 };
  for (const regime of globalMap.values()) globalRegimeCounts[regime] += 1;
  for (const trade of trades) {
    const regime = globalMap.get(decisionTimestampForTrade(trade)) ?? "UNKNOWN";
    signalsByGlobalRegime[regime] += 1;
    pnlByGlobalRegime[regime] += trade.pnlUsdt;
  }
  return {
    candidateId,
    window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    localRangeObservations: countLocalRangeObservations(datasets, start, end),
    totalDecisionObservations: timestamps.length * datasets.length,
    btcGlobalRegimeDistribution: globalRegimeCounts,
    signalsByGlobalRegime,
    pnlByGlobalRegime: roundRecord(pnlByGlobalRegime),
    conclusion: "D1 observes local RANGE without a BTC directional filter; D2 is the explicit PIT BTC 4h RANGE restriction. The D1 distribution is descriptive attribution, not a D3 search or a post-hoc rule change.",
  };
}

function decisionTimestampForTrade(trade: BacktestTrade): number {
  // The engine executes on the next 15m open. The immediately preceding
  // closed candle ends one millisecond before that open, which is the PIT
  // decision timestamp used by the global-regime map.
  return trade.entryTime - 1;
}

function calculateMfeMaeSummary(trades: BacktestTrade[], datasets: HistoricalDataset[]): Record<string, number | null> {
  const values = trades.map((trade) => {
    const dataset = datasets.find((candidate) => candidate.symbol === trade.symbol);
    return dataset ? calculateMfeMae(dataset.candles["15m"], trade) : null;
  }).filter((value): value is NonNullable<typeof value> => value !== null);
  return {
    sample: values.length,
    averageFavorableMove: values.length === 0 ? null : values.reduce((sum, value) => sum + value.favorableMove, 0) / values.length,
    averageAdverseMove: values.length === 0 ? null : values.reduce((sum, value) => sum + value.adverseMove, 0) / values.length,
  };
}

function concentration(trades: BacktestTrade[]): Record<string, unknown> {
  const profitableSymbols = [...new Set(trades.filter((trade) => trade.pnlUsdt > 0).map((trade) => trade.symbol))].sort();
  return {
    top1ProfitContribution: topSymbolConcentration(trades, 1),
    top3ProfitContribution: topSymbolConcentration(trades, 3),
    distinctSymbols: new Set(trades.map((trade) => trade.symbol)).size,
    distinctProfitableSymbols: profitableSymbols.length,
    profitableSymbols,
    concentrationRisk: profitableSymbols.length <= 1 && trades.length > 0 ? "CONCENTRATION_RISK" : "NONE",
  };
}

function countDecisionObservations(datasets: HistoricalDataset[], start: number, end: number): number {
  return datasets.reduce((sum, dataset) => sum + dataset.candles["15m"].filter((candle, index, candles) => (
    candle.closeTime >= start && candle.closeTime <= end && Boolean(candles[index + 1])
  )).length, 0);
}

function countLocalRangeObservations(datasets: HistoricalDataset[], start: number, end: number): number {
  let count = 0;
  for (const dataset of datasets) {
    const primary = dataset.candles["15m"];
    const fourHour = dataset.candles["4h"] ?? [];
    for (let index = 0; index < primary.length - 1; index += 1) {
      const timestamp = primary[index].closeTime;
      if (timestamp < start || timestamp > end) continue;
      const endIndex = upperBoundCloseTime(fourHour, timestamp);
      if (classifyRegime(fourHour.slice(0, endIndex).slice(-250)) === "RANGE") count += 1;
    }
  }
  return count;
}

function upperBoundCloseTime(candles: Candle[], timestamp: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].closeTime <= timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function roundRecord(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Math.round(value * 1e8) / 1e8]));
}

async function loadR74Evidence(): Promise<Record<string, unknown>> {
  const report = JSON.parse(await readFile(R74_REPORT_PATH, "utf8")) as Record<string, any>;
  return {
    rawScoreParity: report.parity?.metrics?.score ?? null,
    qualifiedScoreParity: report.parity?.metrics?.qualifiedCandidate ?? null,
    source: "reports/hy-r7.4-forward-parity-regime-audit.json",
  };
}

async function loadFailureSetEvidence(): Promise<Record<string, unknown>> {
  const rows = validateFrozenFailureSet(await readFile(FAILURE_SET_PATH, "utf8"));
  return {
    rows: rows.rowCount,
    uniqueNotificationIds: rows.uniqueNotificationIds,
    uniqueSignalIds: rows.uniqueSignalIds,
    usedForSelection: false,
    role: "audit-only historical failure set; not a selection or OOS input",
  };
}

async function writeReports(
  report: { json: Record<string, unknown>; markdown: string; manifest: Record<string, unknown> },
  dataManifestRows: string[],
): Promise<void> {
  const sourceAndTestPaths = [
    resolve("lib", "research", "r7-5-range-research.ts"),
    resolve("scripts", "run-hy-r7-5-range-regime-research.ts"),
    resolve("tests", "hy-r7.5-range-regime-research.test.ts"),
  ];
  const sourceAndTestHashes = [] as string[];
  for (const path of sourceAndTestPaths) {
    const bytes = await readFile(path);
    sourceAndTestHashes.push(`${path}:${sha256(bytes)}`);
  }
  report.manifest.sourceAndTestHashes = sourceAndTestHashes.sort();
  report.manifest.dataManifestRows = dataManifestRows;
  await writeFile(OUTPUT_JSON_PATH, `${JSON.stringify(report.json, null, 2)}\n`, "utf8");
  await writeFile(OUTPUT_MD_PATH, report.markdown, "utf8");
  await writeFile(OUTPUT_MANIFEST_PATH, `${JSON.stringify(report.manifest, null, 2)}\n`, "utf8");
}

function renderMarkdown(json: Record<string, unknown>): string {
  const report = json as Record<string, any>;
  const a = report.candidateAReproduction;
  const candidates = report.candidates as Array<Record<string, any>>;
  const selectionRows = candidates.map((candidate) => `| ${candidate.id} | ${candidate.selection.base.netPnlUsdt} | ${candidate.selection.base.expectancyUsdt} | ${candidate.selection.base.profitFactor} | ${candidate.selection.stress.netPnlUsdt} | ${candidate.selection.stress.profitFactor} | ${candidate.selection.positiveBaseFolds} | ${candidate.selection.distinctSymbols} | ${candidate.selection.gate.pass ? "PASS" : "REJECTED"} |`).join("\n");
  const selected = report.selectedRangeFinalOos;
  const selectedE = report.candidateE;
  return `# HY-R7.5 RANGE REGIME RESEARCH

Classification: **${report.classification}**

Research-only artifact. No Production, Supabase, Vercel, PAPER strategy, scheduler, email, private API, or order state was changed.

## Frozen authority and Candidate A reproduction

- PR #${report.pullRequest.number}; branch \`${report.pullRequest.branch}\`; frozen base research HEAD \`${report.pullRequest.baseResearchHead}\`; PR remains **${report.pullRequest.status}**.
- Candidate A: \`${report.frozenAuthority.candidateA.candidateId}\`, strategy \`${report.frozenAuthority.candidateA.strategyVersion}\`, SHA256 \`${report.frozenAuthority.candidateA.strategyHash}\`.
- Reproduction gate: **${a.pass ? "PASS" : "FAIL"}**; base ${a.actual.base.trades} trades / ${a.actual.base.netPnlUsdt} USDT / PF ${a.actual.base.profitFactor}; stress ${a.actual.stress.netPnlUsdt} USDT / PF ${a.actual.stress.profitFactor}.
- Expected authority: 29 trades / 469.31166529 USDT / PF 1.59999141; stress 400.66533784 USDT / PF 1.48858398.

## PIT windows and frozen RANGE contract

- Dataset: ${report.windows.historicalDataset.start} through ${report.windows.historicalDataset.end}.
- Train: ${report.windows.train.start} through ${report.windows.train.end}; validation: ${report.windows.validation.start} through ${report.windows.validation.end}; final OOS: ${report.windows.finalOos.start} through ${report.windows.finalOos.end}.
- 48-hour embargo is preserved. Only closed 15m candles through decision time t are consumed; execution is next-bar open.
- RANGE_RECLAIM / MEAN_REVERSION / LONG + SHORT; local regime RANGE is required. Frozen Bollinger=${report.frozenRangeContract.bollingerPeriod}/${report.frozenRangeContract.bollingerDeviation}; RSI=${report.frozenRangeContract.rsiPeriod}, thresholds ${report.frozenRangeContract.meanReversionRsiLow}/${report.frozenRangeContract.meanReversionRsiHigh}.
- No parameter search and no new indicators. Common settings: minScore 80, cooldown 24h, RR 2, max hold 48h, stop ATR 0.75, top-10 universe, risk 50 USDT/trade, daily budget 600, leverage 20.

## Train + validation selection (no final OOS for rejected candidates)

| Candidate | Base net | Base expectancy | Base PF | Stress net | Stress PF | Positive base folds | Distinct symbols | Gate |
|---|---:|---:|---:|---:|---:|---:|---:|---|
${selectionRows}

- D1 is local-RANGE-only and does not use a BTC global filter.
- D2 uses a PIT BTCUSDT 4h RANGE filter and does not use directional \`globalRegimeAlignment\`.
- Selection attribution (train + validation, before any Final OOS): ${JSON.stringify(report.attributionRequirements.selectionD1D2RegimeImpact)}. This is the required D1 answer on whether BTC global regime changes local-RANGE outcomes; it is descriptive and does not authorize D3.
- Selection ranking is profitability-first, then stress PF, base expectancy, lower drawdown, stability, and trade count. Selected: **${report.selection.selectedRangeCandidate ?? "NONE"}**.
- Rejected candidates were not run in Final OOS: ${JSON.stringify(report.selection.rejectedCandidatesNotRunFinalOos)}.

## Selected RANGE Final OOS

${selected.status === "RUN_ONCE_AFTER_SELECTION" ? `- Candidate: **${selected.candidateId}**; one-shot status: **${selected.status}**.
- Base: ${selected.result.base.metrics.trades} trades / ${selected.result.base.metrics.netPnlUsdt} USDT / expectancy ${selected.result.base.metrics.expectancyUsdt} / PF ${selected.result.base.metrics.profitFactor}.
- Stress: ${selected.result.stress.metrics.trades} trades / ${selected.result.stress.metrics.netPnlUsdt} USDT / PF ${selected.result.stress.metrics.profitFactor}.
- Profitability gate: **${selected.gate.pass ? "PASS" : "FAIL"}**; throughput: **${selected.throughput.pass ? "PASS" : "FAIL"}** (${selected.signalRate.count} signals; annualized ${selected.signalRate.annualizedSignals ?? "n/a"}).
- LONG: ${selected.attribution.long.trades} trades / ${selected.attribution.long.netPnlUsdt} USDT / PF ${selected.attribution.long.profitFactor}; SHORT: ${selected.attribution.short.trades} trades / ${selected.attribution.short.netPnlUsdt} USDT / PF ${selected.attribution.short.profitFactor}.
- BTC global regimes: ${JSON.stringify(selected.attribution.btcGlobalRegimeDistribution)}; signals by global regime: ${JSON.stringify(selected.attribution.signalsByGlobalRegime)}; PnL by global regime: ${JSON.stringify(selected.attribution.pnlByGlobalRegime)}.
- Concentration: top-1 ${selected.concentration.top1ProfitContribution}; top-3 ${selected.concentration.top3ProfitContribution}; profitable symbols ${selected.concentration.distinctProfitableSymbols}; **${selected.concentration.concentrationRisk}**.
- Bootstrap (informational): ${JSON.stringify(selected.bootstrap)}.` : "No D1/D2 passed train + validation; selected D* Final OOS was not run."}

## Candidate E and portfolio combination

${selectedE.status !== "NOT_RUN_NO_RANGE_SELECTION" ? `- Candidate E was preregistered before selected D* OOS: **${selectedE.preregistration.frozenBeforeSelectedDFinalOos ? "YES" : "NO"}**; selected range=${selectedE.preregistration.selectedRangeCandidate}.
- Rules: frozen Candidate A in BEAR, selected D* in RANGE, shared 24h same-symbol cooldown and portfolio caps, same symbol/timestamp highest-score de-duplication, no double open.
- Base: ${selectedE.finalOos.result.base.metrics.trades} trades / ${selectedE.finalOos.result.base.metrics.netPnlUsdt} USDT / PF ${selectedE.finalOos.result.base.metrics.profitFactor}; stress ${selectedE.finalOos.result.stress.metrics.netPnlUsdt} USDT / PF ${selectedE.finalOos.result.stress.metrics.profitFactor}.
- Portfolio gate: **${selectedE.finalOos.portfolioGate?.pass ? "PASS" : "FAIL"}**; throughput: **${selectedE.finalOos.throughput.pass ? "PASS" : "FAIL"}**.
- LONG: ${selectedE.finalOos.attribution.long.trades} trades; SHORT: ${selectedE.finalOos.attribution.short.trades} trades; bootstrap: ${JSON.stringify(selectedE.finalOos.bootstrap)}.` : "Candidate E was not run because no RANGE candidate passed selection."}

## Forward audit (post-hoc, not independent validation)

- Window: ${report.forwardAudit.start} to ${report.forwardAudit.end ?? "not run"}; status **${report.forwardAudit.status}**.
- ${report.forwardAudit.status === "RUN" ? `Frozen ${report.forwardAudit.candidateId} would have produced ${report.forwardAudit.wouldHaveSignals} signals (${report.forwardAudit.longSignals} LONG / ${report.forwardAudit.shortSignals} SHORT), ${report.forwardAudit.signalsPerWeek} per week, ${report.forwardAudit.estimatedMaturedTrades} estimated matured trades, hypothetical paper PnL ${report.forwardAudit.hypotheticalPaperPnlUsdt} USDT; symbols: ${report.forwardAudit.symbols.join(", ") || "none"}.` : report.forwardAudit.reason}
- This is explicitly **POST-HOC AUDIT / NOT INDEPENDENT VALIDATION** and was not used for selection, thresholds, or OOS gates.

## Score parity warning

- R7.4 raw score exact parity: ${JSON.stringify(report.scoreParityWarning.r74RawScoreExactParity)}; qualified score parity: ${JSON.stringify(report.scoreParityWarning.r74QualifiedScoreParity)}.
- Forward replay raw candidate scores in 79–81: **${report.scoreParityWarning.forwardReplayCandidatesScore79To81 ?? "not run"}**.
- Production score parity required before activation: **${report.scoreParityWarning.productionScoreParityRequiredBeforeActivation ? "YES" : "NO / NOT APPLICABLE"}**.

## Data, attribution, and audit boundaries

- Selection dataset: **20 symbols only**; 49-symbol replay, forward data, and the frozen 37-row email failure set were not selection inputs.
- Local RANGE observations in selected final OOS: ${selected.attribution?.localRangeObservations ?? "not run"}; BTC global regime distribution and PnL attribution are retained without deleting losing sides.
- Failure-set audit: ${report.old37EmailFailureSetAudit.rows} rows, used for selection: **NO**.
- Data manifest SHA256: \`${report.authoritativeSelectionDataset.manifestSha256}\`; representation: sorted UTF-8 \`filename:raw-file-SHA256\` rows. No raw dataset is submitted.

## Verification and safety

- Tests: **${report.verification.tests}**
- Typecheck: **${report.verification.typecheck}**; lint: **${report.verification.lint}**; build: **${report.verification.build}**; diff: **${report.verification.diff}**; GitHub CI: **${report.verification.githubCi}**.
- Production modified: **NO**; Supabase modified: **NO**; Vercel modified: **NO**; PAPER strategy modified: **NO**; real emails: **0**; private API: **NO**; orders: **0**; AUTO_TRADING: **FALSE**.
- Final classification: **${report.classification}**.
`;
}

function isMaturedTrade(trade: BacktestTrade, evaluationEnd: number): boolean {
  if (trade.exitReason === "STOP" || trade.exitReason === "TAKE_PROFIT") return trade.exitTime <= evaluationEnd;
  return trade.exitTime < evaluationEnd;
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

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
