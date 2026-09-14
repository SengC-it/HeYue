import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildCandidateCache,
  buildDynamicUniverseByTimestamp,
  buildGlobalRegimeByTimestamp,
  runPortfolioBacktest,
  selectPortfolioTrades,
  type BacktestOptions,
} from "@/lib/backtest/engine";
import { assertHistoricalDatasetIntegrity } from "@/lib/backtest/data-integrity";
import type { BacktestTrade, HistoricalDataset } from "@/lib/backtest/types";
import { DEFAULT_STRATEGY_PARAMS, type StrategyParams } from "@/lib/core/strategies";
import type { MarketRegime, ScoredCandidate } from "@/lib/core/types";
import {
  aggregateRejectionStages,
  assertAuthoritativeCandidateA,
  assertBreakoutDefaults,
  canCalculateConditionalFunnelRates,
  mergeCandidateCaches,
  passesR73FinalProfitabilityGate,
  passesR73SelectionGate,
  passesR73ThroughputGate,
  rankR73Candidates,
  R73_AUTHORITATIVE_A_OOS,
  R73_C1_ID,
  R73_C2_ID,
  R73_CANDIDATE_A_ID,
  R73_BREAKOUT_DEFAULTS,
  R73_REPORT_VERSION,
  R73_STRATEGY_HASH,
  R73_STRATEGY_VERSION,
  type R73CandidateRankRow,
} from "@/lib/research/r7-3";
import {
  calculateResearchMetrics,
  sourceTimeForEntry,
  topSymbolConcentration,
  type ResearchMetrics,
} from "@/lib/research/r7-1";
import { calculateSignalRate, bootstrapConfidence, type SignalRate } from "@/lib/research/r7-2";

const DATA_DIRECTORY = resolve("data", "validation-cache");
const R71A_REPORT_PATH = resolve("reports", "hy-r7.1a-candidate-adjudication.json");
const R71A_PRODUCTION_PATH = resolve("reports", "hy-r7.1a-production-evidence.json");
const R72_REPORT_PATH = resolve("reports", "hy-r7.2-signal-throughput-research.json");
const R72_REPORT_MD_PATH = resolve("reports", "hy-r7.2-signal-throughput-research.md");
const OUTPUT_JSON_PATH = resolve("reports", "hy-r7.3-breakout-candidate-research.json");
const OUTPUT_MD_PATH = resolve("reports", "hy-r7.3-breakout-candidate-research.md");

const WINDOW_START = Date.parse("2025-08-09T02:15:00.000Z");
const WINDOW_END = Date.parse("2026-08-09T02:14:59.999Z");
const VALIDATION_START = Date.parse("2026-02-09T02:15:00.000Z");
const FINAL_OOS_START = Date.parse("2026-05-09T02:15:00.000Z");
const EMBARGO_MS = 48 * 60 * 60 * 1000;
const TRAIN_END = VALIDATION_START - EMBARGO_MS;
const VALIDATION_END = FINAL_OOS_START - EMBARGO_MS;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CACHE_VERSION = "candidate-cache-v4";

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
  // R7.1A's frozen selection policy used BASE selection costs even when
  // evaluating the stress execution-cost scenario. Keep that parity exact.
  selectionTakerFeeRate: 0.0004,
  selectionSlippageBps: 2,
});

const CANDIDATE_A_PARAMS: StrategyParams = {
  ...DEFAULT_STRATEGY_PARAMS,
  entryMode: "TREND_PULLBACK",
  stopAtrMultiplier: 0.75,
};

const C1_PARAMS: StrategyParams = {
  ...DEFAULT_STRATEGY_PARAMS,
  entryMode: "BREAKOUT_RETEST",
  stopAtrMultiplier: 0.75,
};

interface CostModel {
  name: string;
  takerFeeRate: number;
  slippageBps: number;
  selectionTakerFeeRate: number;
  selectionSlippageBps: number;
}

type CandidateKind = "A" | "C1" | "C2";

interface CandidateSpec {
  id: string;
  kind: CandidateKind;
  description: string;
  params: StrategyParams;
  strategyFamilies: Array<"TREND" | "BREAKOUT" | "MEAN_REVERSION">;
  throughputTarget: { minimumOosSignals: number; minimumAnnualizedSignals: number };
}

interface ExecutionMaps {
  dynamicUniverseByTimestamp: Map<number, Set<string>>;
  globalRegimeByTimestamp: Map<number, MarketRegime>;
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

interface CandidateEvaluation {
  spec: CandidateSpec;
  train: SlicePair;
  validation: SlicePair;
  selection: {
    base: ResearchMetrics;
    stress: ResearchMetrics;
    positiveBaseFolds: number;
    positiveStressFolds: number;
    stabilityScore: number;
    signalRate: SignalRate;
    profitabilityEligible: boolean;
  };
  finalOos: SlicePair | null;
  finalOosStatus: "RUN" | "NOT_RUN_BEFORE_SELECTION";
  finalOosProfitabilityGate: boolean;
  finalOosThroughputGate: boolean;
  oosSignalRate: SignalRate | null;
  oosBootstrap: ReturnType<typeof bootstrapConfidence> | null;
  selectedForFinalOos: boolean;
}

interface ProductionDiagnosticsEvidence {
  capturedAt: string;
  source: string;
  diagnosticsRows: number;
  diagnosticsScanRuns: number;
  symbolObservations: number;
  rejectionStageCounts: ReturnType<typeof aggregateRejectionStages>;
  latest: {
    scanRunId: string;
    createdAt: string;
    strategyVersion: string;
    globalRegime: string;
    deepUniverseSize: number;
    deepUniverseSymbolCount: number;
    symbolObservationCount: number;
    filterFunnel: Record<string, unknown>;
  };
  counterSemantics: {
    conditionalRatesAllowed: boolean;
    reason: string;
    sourceLocations: Record<string, string>;
  };
}

const PRODUCTION_DIAGNOSTICS: ProductionDiagnosticsEvidence = {
  capturedAt: "2026-09-13T09:45:09.015895Z",
  source: "Read-only SELECT from public.hy_scan_diagnostics in Supabase project jfvbikivtpfjgfsnggiz; no write was issued.",
  diagnosticsRows: 775,
  diagnosticsScanRuns: 775,
  symbolObservations: 7750,
  rejectionStageCounts: [
    { rejectionStage: "NO_RAW_CANDIDATE", count: 6421, sharePercent: 82.851613 },
    { rejectionStage: "SCORE", count: 1272, sharePercent: 16.412903 },
    { rejectionStage: "SIDE", count: 48, sharePercent: 0.619355 },
    { rejectionStage: "EXECUTION_COST", count: 8, sharePercent: 0.103226 },
    { rejectionStage: "QUALIFIED", count: 1, sharePercent: 0.012903 },
  ],
  latest: {
    scanRunId: "9c9ae725-2e00-4c4b-a50f-8dedd1a9c394",
    createdAt: "2026-09-13T09:45:09.015895Z",
    strategyVersion: "hy-paper-candidate-v2",
    globalRegime: "RANGE",
    deepUniverseSize: 10,
    deepUniverseSymbolCount: 10,
    symbolObservationCount: 10,
    filterFunnel: {
      measurement: "count",
      marketDataOk: 10,
      rawCandidates: 0,
      scorePass: 0,
      strategyFamilyPass: 0,
      sidePass: 0,
      localRegimePass: 0,
      globalRegimePass: 0,
      riskPlanPass: 0,
      singleRiskCapPass: 0,
      executionCostPass: 0,
      preCooldownCandidate: 0,
      cooldownPass: 0,
      claimed: 0,
      emailed: 0,
    },
  },
  counterSemantics: {
    conditionalRatesAllowed: false,
    reason: "Counters are candidate-level measurements, not a shared row-lineage chain; symbol_diagnostics.rejectionStage is the mutually exclusive denominator.",
    sourceLocations: {
      initialization: "lib/core/candidate-funnel.ts:evaluateCandidateFunnel:baseCounts",
      stageCounts: "lib/core/candidate-funnel.ts:evaluateCandidateFunnel:scoreCandidates/sideCandidates/familyCandidates/localRegimeCandidates/globalRegimeCandidates",
      riskAndCost: "lib/core/candidate-funnel.ts:evaluateCandidateFunnel:buildTradePlan + riskOverSingleCap + estimateExecutionCostRisk",
      cooldown: "lib/core/candidate-funnel.ts:recordCooldownResult increments cooldownPass only on pass",
      aggregation: "lib/core/candidate-funnel.ts:addFilterFunnel sums candidate counts into scan telemetry",
      persistence: "lib/services/signal-repository.ts:saveScanDiagnostics persists filter_funnel and symbol_diagnostics",
    },
  },
};

async function main(): Promise<void> {
  assertBreakoutDefaults(C1_PARAMS);
  const data = await loadResearchData();
  const candidates = buildCandidateSpecs();

  const evaluations = new Map<CandidateKind, CandidateEvaluation>();
  for (const spec of candidates) {
    console.log(`Running ${spec.id} train + validation research`);
    evaluations.set(spec.kind, evaluateTrainValidation(spec, data));
  }

  const challengers = candidates.filter((spec) => spec.kind !== "A");
  const challengerRanks = rankR73Candidates(challengers.map((spec) => {
    const evaluation = evaluations.get(spec.kind);
    if (!evaluation) throw new Error(`Missing evaluation for ${spec.id}`);
    return toRankRow(evaluation);
  }));
  const selectedId = challengerRanks.find((row) => row.profitabilityEligible)?.id ?? null;
  const selectedKind = candidates.find((spec) => spec.id === selectedId)?.kind ?? null;

  const oosRunIds = new Set<CandidateKind>();
  const candidateA = requireEvaluation(evaluations, "A");
  runFinalOosOnce(candidateA, data, oosRunIds, true);
  const selected = selectedKind ? requireEvaluation(evaluations, selectedKind) : null;
  if (selected) runFinalOosOnce(selected, data, oosRunIds, true);

  console.log(JSON.stringify({
    authoritativeAActual: {
      base: candidateA.finalOos!.base.metrics,
      stress: candidateA.finalOos!.stress.metrics,
    },
    authoritativeAExpected: R73_AUTHORITATIVE_A_OOS,
  }, null, 2));
  assertAuthoritativeCandidateA(candidateA.finalOos!.base.metrics, candidateA.finalOos!.stress.metrics);
  if (selected) finalizeCandidateGates(candidateA, selected);
  const selectedProfitabilityGate = selected?.finalOosProfitabilityGate ?? false;
  const selectedThroughputGate = selected?.finalOosThroughputGate ?? false;
  const classification = selectedProfitabilityGate && selectedThroughputGate
    ? "NEW_FORWARD_CANDIDATE_READY"
    : "NO_HIGHER_THROUGHPUT_PROFITABLE_ALTERNATIVE";

  const r71a = JSON.parse(await readFile(R71A_REPORT_PATH, "utf8")) as Record<string, any>;
  const r72 = JSON.parse(await readFile(R72_REPORT_PATH, "utf8")) as Record<string, any>;
  const production = JSON.parse(await readFile(R71A_PRODUCTION_PATH, "utf8")) as Record<string, any>;
  if (r71a.forwardCandidate?.candidateId !== R73_CANDIDATE_A_ID || r71a.forwardCandidate?.strategyHash !== R73_STRATEGY_HASH) {
    throw new Error("R7.1A frozen Candidate A evidence identity changed");
  }
  const report = buildReport({
    data,
    production,
    candidateA,
    candidates: [...evaluations.values()],
    selected,
    selectedId,
    challengerRanks,
    oosRunCount: oosRunIds.size,
    classification,
  });

  await reconcileR72Report(r72, candidateA, PRODUCTION_DIAGNOSTICS);
  await writeFile(OUTPUT_JSON_PATH, `${JSON.stringify(report.json, null, 2)}\n`, "utf8");
  await writeFile(OUTPUT_MD_PATH, report.markdown, "utf8");
  console.log(JSON.stringify({
    classification,
    authoritativeAReproduced: true,
    candidateA: summarizeEvaluation(candidateA),
    selected: selected?.spec.id ?? null,
    selectedProfitabilityGate,
    selectedThroughputGate,
    oosRunCount: oosRunIds.size,
  }, null, 2));
}

function buildCandidateSpecs(): CandidateSpec[] {
  return [
    {
      id: R73_CANDIDATE_A_ID,
      kind: "A",
      description: "Frozen R7.1A Candidate A; authoritative baseline only.",
      params: CANDIDATE_A_PARAMS,
      strategyFamilies: ["TREND"],
      throughputTarget: { minimumOosSignals: 0, minimumAnnualizedSignals: 0 },
    },
    {
      id: R73_C1_ID,
      kind: "C1",
      description: "Pre-registered BREAKOUT_RETEST short-only candidate using frozen production defaults.",
      params: C1_PARAMS,
      strategyFamilies: ["BREAKOUT"],
      throughputTarget: { minimumOosSignals: R73_AUTHORITATIVE_A_OOS.trades, minimumAnnualizedSignals: 100 },
    },
    {
      id: R73_C2_ID,
      kind: "C2",
      description: "Pre-registered union of frozen Candidate A and C1 with one shared cooldown and portfolio policy.",
      params: CANDIDATE_A_PARAMS,
      strategyFamilies: ["TREND", "BREAKOUT"],
      throughputTarget: { minimumOosSignals: R73_AUTHORITATIVE_A_OOS.trades * 2, minimumAnnualizedSignals: 200 },
    },
  ];
}

async function loadResearchData(): Promise<{
  datasets: HistoricalDataset[];
  caches: Record<CandidateKind, Array<Map<number, ScoredCandidate[]>>>;
  mapsByCandidate: Record<CandidateKind, ExecutionMaps>;
  symbols: string[];
  rawFiles: number;
  manifestSha256: string;
  coverage: { earliestOpenTime: string; latestCloseTime: string; authoritativeSelection: true };
}> {
  const datasets: HistoricalDataset[] = [];
  const manifestRows: string[] = [];
  for (const symbol of FIXED_SYMBOLS) {
    const path = resolve(DATA_DIRECTORY, `${symbol}-${WINDOW_START}-${WINDOW_END}.json`);
    const bytes = await readFile(path);
    manifestRows.push(`${symbol}-${WINDOW_START}-${WINDOW_END}.json:${createHash("sha256").update(bytes).digest("hex")}`);
    const dataset = JSON.parse(bytes.toString("utf8")) as HistoricalDataset;
    assertHistoricalDatasetIntegrity(dataset);
    if (dataset.symbol !== symbol) throw new Error(`R7.3 dataset filename/symbol mismatch: ${symbol}`);
    if (dataset.candles["15m"].at(-1)?.closeTime !== WINDOW_END) {
      throw new Error(`R7.3 dataset ${symbol} does not end at the frozen R7.1 boundary`);
    }
    datasets.push(dataset);
  }

  const aCaches = await Promise.all(datasets.map((dataset) => loadAuthoritativeCache(dataset)));
  const c1Caches = datasets.map((dataset, index) => {
    console.log(`Building frozen C1 cache ${index + 1}/${datasets.length}: ${dataset.symbol}`);
    return buildCandidateCache(dataset, C1_PARAMS, WINDOW_END);
  });
  const c2Caches = datasets.map((_, index) => mergeCandidateCaches([aCaches[index], c1Caches[index]]));
  const earliest = Math.min(...datasets.map((dataset) => dataset.candles["15m"][0]?.openTime ?? Number.POSITIVE_INFINITY));
  const latest = Math.max(...datasets.map((dataset) => dataset.candles["15m"].at(-1)?.closeTime ?? 0));
  return {
    datasets,
    caches: { A: aCaches, C1: c1Caches, C2: c2Caches },
    mapsByCandidate: {
      A: buildExecutionMaps(datasets, aCaches),
      C1: buildExecutionMaps(datasets, c1Caches),
      C2: buildExecutionMaps(datasets, c2Caches),
    },
    symbols: [...FIXED_SYMBOLS],
    rawFiles: datasets.length,
    manifestSha256: createHash("sha256").update(manifestRows.join("\n") + "\n").digest("hex"),
    coverage: {
      earliestOpenTime: new Date(earliest).toISOString(),
      latestCloseTime: new Date(latest).toISOString(),
      authoritativeSelection: true,
    },
  };
}

function buildExecutionMaps(
  datasets: HistoricalDataset[],
  caches: Array<Map<number, ScoredCandidate[]>>,
): ExecutionMaps {
  const entryTimes = [...new Set(caches.flatMap((cache, index) => [...cache.keys()]
    .map((key) => datasets[index]?.candles["15m"][key]?.closeTime)
    .filter((value): value is number => value !== undefined)))].sort((left, right) => left - right);
  return {
    dynamicUniverseByTimestamp: buildDynamicUniverseByTimestamp(datasets, entryTimes, 10, 1),
    globalRegimeByTimestamp: buildGlobalRegimeByTimestamp(datasets, entryTimes, "BTCUSDT", "4h"),
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
  const hash = createHash("sha256").update(descriptor).digest("hex").slice(0, 20);
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
    // Rebuilding the immutable cache is allowed; it does not change the dataset.
  }
  return buildCandidateCache(dataset, CANDIDATE_A_PARAMS, WINDOW_END);
}

function evaluateTrainValidation(spec: CandidateSpec, data: Awaited<ReturnType<typeof loadResearchData>>): CandidateEvaluation {
  const train = runSlicePair(spec, data, WINDOW_START, TRAIN_END);
  const validation = runSlicePair(spec, data, VALIDATION_START, VALIDATION_END);
  const baseTrades = [...train.base.trades, ...validation.base.trades];
  const stressTrades = [...train.stress.trades, ...validation.stress.trades];
  const base = calculateResearchMetrics(baseTrades);
  const stress = calculateResearchMetrics(stressTrades);
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
      stabilityScore: positiveBaseFolds + positiveStressFolds,
      signalRate: calculateSignalRate(
        [...train.base.signalTimes, ...validation.base.signalTimes],
        WINDOW_START,
        VALIDATION_END,
      ),
      profitabilityEligible: spec.kind === "A"
        ? false
        : passesR73SelectionGate(base, stress, positiveBaseFolds),
    },
    finalOos: null,
    finalOosStatus: "NOT_RUN_BEFORE_SELECTION",
    finalOosProfitabilityGate: false,
    finalOosThroughputGate: false,
    oosSignalRate: null,
    oosBootstrap: null,
    selectedForFinalOos: false,
  };
}

function runFinalOosOnce(
  evaluation: CandidateEvaluation,
  data: Awaited<ReturnType<typeof loadResearchData>>,
  runIds: Set<CandidateKind>,
  selected: boolean,
): void {
  if (runIds.has(evaluation.spec.kind)) throw new Error(`R7.3 final OOS already executed for ${evaluation.spec.id}`);
  runIds.add(evaluation.spec.kind);
  evaluation.finalOos = runSlicePair(evaluation.spec, data, FINAL_OOS_START, WINDOW_END);
  evaluation.finalOosStatus = "RUN";
  evaluation.selectedForFinalOos = selected;
  evaluation.oosSignalRate = calculateSignalRate(evaluation.finalOos.base.signalTimes, FINAL_OOS_START, WINDOW_END);
  evaluation.oosBootstrap = bootstrapConfidence(evaluation.finalOos.base.trades.map((trade) => trade.pnlUsdt));
}

function finalizeCandidateGates(candidateA: CandidateEvaluation, candidate: CandidateEvaluation): void {
  if (!candidate.finalOos || !candidateA.finalOos || !candidate.oosSignalRate) return;
  candidate.finalOosProfitabilityGate = passesR73FinalProfitabilityGate(
    candidateA.finalOos.base.metrics,
    candidate.finalOos.base.metrics,
    candidate.finalOos.stress.metrics,
  );
  candidate.finalOosThroughputGate = passesR73ThroughputGate(
    candidate.oosSignalRate.count,
    candidate.oosSignalRate.annualizedSignals,
    candidate.spec.throughputTarget.minimumOosSignals,
    candidate.spec.throughputTarget.minimumAnnualizedSignals,
  );
}

function runSlicePair(
  spec: CandidateSpec,
  data: Awaited<ReturnType<typeof loadResearchData>>,
  start: number,
  end: number,
): SlicePair {
  return {
    base: runSlice(spec, data, start, end, BASE_COST),
    stress: runSlice(spec, data, start, end, STRESS_COST),
  };
}

function runSlice(
  spec: CandidateSpec,
  data: Awaited<ReturnType<typeof loadResearchData>>,
  start: number,
  end: number,
  cost: CostModel,
): SliceRun {
  const portfolio = runPortfolioBacktest(data.datasets, spec.params, {
    ...backtestOptions(spec),
    ...costOptions(cost),
    evaluationStartTime: start,
    evaluationEndTime: end,
    candidateCaches: data.caches[spec.kind],
    ...data.mapsByCandidate[spec.kind],
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
    strategyFamilies: spec.strategyFamilies,
    maxExecutionCostRiskFraction: 0.1,
    dynamicUniverseSize: 10,
    dynamicUniverseLookbackDays: 1,
    globalReferenceSymbol: "BTCUSDT",
    globalReferenceTimeframe: "4h",
    globalRegimeAlignment: true,
    entryDelayBars: 1,
    cooldownHours: 24,
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

function toRankRow(evaluation: CandidateEvaluation): R73CandidateRankRow {
  return {
    id: evaluation.spec.id,
    profitabilityEligible: evaluation.selection.profitabilityEligible,
    stressProfitFactor: evaluation.selection.stress.profitFactor,
    expectancyUsdt: evaluation.selection.base.expectancyUsdt,
    profitFactor: evaluation.selection.base.profitFactor,
    maxDrawdownPercent: evaluation.selection.base.maxDrawdownPercent,
    stabilityScore: evaluation.selection.stabilityScore,
    signalCount: evaluation.selection.signalRate.count,
    annualizedSignals: evaluation.selection.signalRate.annualizedSignals,
  };
}

function requireEvaluation(evaluations: Map<CandidateKind, CandidateEvaluation>, kind: CandidateKind): CandidateEvaluation {
  const evaluation = evaluations.get(kind);
  if (!evaluation) throw new Error(`Missing R7.3 evaluation for ${kind}`);
  return evaluation;
}

function summarizeEvaluation(evaluation: CandidateEvaluation): Record<string, unknown> {
  return {
    id: evaluation.spec.id,
    selection: evaluation.selection,
    finalOosStatus: evaluation.finalOosStatus,
    finalOos: evaluation.finalOos ? {
      base: evaluation.finalOos.base.metrics,
      stress: evaluation.finalOos.stress.metrics,
    } : null,
    oosSignalRate: evaluation.oosSignalRate,
    finalOosProfitabilityGate: evaluation.finalOosProfitabilityGate,
    finalOosThroughputGate: evaluation.finalOosThroughputGate,
  };
}

function buildReport(input: {
  data: Awaited<ReturnType<typeof loadResearchData>>;
  production: Record<string, any>;
  candidateA: CandidateEvaluation;
  candidates: CandidateEvaluation[];
  selected: CandidateEvaluation | null;
  selectedId: string | null;
  challengerRanks: R73CandidateRankRow[];
  oosRunCount: number;
  classification: string;
}): { json: Record<string, unknown>; markdown: string } {
  const { candidateA, selected } = input;
  for (const candidate of input.candidates) {
    if (candidate.spec.kind === "A") continue;
    if (candidate.finalOos) finalizeCandidateGates(candidateA, candidate);
  }
  const authoritativeRate = candidateA.oosSignalRate;
  const reportJson: Record<string, unknown> = {
    reportVersion: R73_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    purpose: "R7.2 reconciliation plus preregistered BREAKOUT_RETEST C1/C2 research; no production behavior was changed.",
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
    },
    frozenCandidateA: {
      candidateId: R73_CANDIDATE_A_ID,
      strategyVersion: R73_STRATEGY_VERSION,
      strategyHash: R73_STRATEGY_HASH,
      entryMode: "TREND_PULLBACK",
      side: "SHORT",
      strategyFamily: "TREND",
      minScore: 80,
      cooldownHours: 24,
      rewardRisk: 2,
      maxHoldHours: 48,
      stopAtrMultiplier: 0.75,
      localRegimeAlignment: true,
      globalRegimeAlignment: true,
      globalReferenceSymbol: "BTCUSDT",
      globalReferenceTimeframe: "4h",
      dynamicUniverse: "top10",
      unchanged: true,
    },
    windows: {
      dataset: { start: new Date(WINDOW_START).toISOString(), end: new Date(WINDOW_END).toISOString() },
      train: { start: new Date(WINDOW_START).toISOString(), end: new Date(TRAIN_END).toISOString() },
      validation: { start: new Date(VALIDATION_START).toISOString(), end: new Date(VALIDATION_END).toISOString() },
      finalOos: { start: new Date(FINAL_OOS_START).toISOString(), end: new Date(WINDOW_END).toISOString() },
      embargoHours: 48,
      pit: "Only closed 15m data through the decision timestamp is consumed; execution is next-bar open.",
    },
    authoritativeSelectionDataset: {
      source: "R7.1 authoritative 20-symbol validation-cache",
      directory: "data/validation-cache",
      symbols: input.data.symbols,
      rawFiles: input.data.rawFiles,
      manifestSha256: input.data.manifestSha256,
      coverage: input.data.coverage,
      selectionUses49SymbolReplay: false,
    },
    authoritativeCandidateA: {
      candidateId: R73_CANDIDATE_A_ID,
      source: "reports/hy-r7.1a-candidate-adjudication.json plus same-run reproduction",
      metrics: {
        oos: candidateA.finalOos!.base.metrics,
        stress: candidateA.finalOos!.stress.metrics,
      },
      expectedFrozenMetrics: R73_AUTHORITATIVE_A_OOS,
      exactReproduction: true,
      signalRate: authoritativeRate,
      bootstrap: candidateA.oosBootstrap,
    },
    a49SensitivityReplay: {
      source: "reports/hy-r7.2-signal-throughput-research.json; retained read-only",
      label: "A49_SENSITIVITY_REPLAY",
      authoritativeCandidate: false,
      selectionEligible: false,
      metrics: {
        oosTrades: 31,
        oosNetPnlUsdt: 516.82431928,
        oosProfitFactor: 1.62010391,
      },
      selectionRole: "Sensitivity only after authoritative 20-symbol selection; cannot overwrite Candidate A.",
    },
    productionDiagnostics: PRODUCTION_DIAGNOSTICS,
    productionRuntime: {
      source: "reports/hy-r7.1a-production-evidence.json",
      strategyVersion: input.production.strategy?.version ?? R73_STRATEGY_VERSION,
      strategyFamily: input.production.strategy?.strategyFamily ?? "TREND",
      status: input.production.strategy?.status ?? "PAPER",
      strategyCreatedAt: input.production.strategy?.createdAt ?? "2026-08-09T15:46:25.317519Z",
      strategyStage: "PAPER",
      strategySource: "DB",
      dryRun: false,
      exchangeCredentialsConfigured: false,
      autoTrading: false,
      realEmail: "OFF",
    },
    candidateSelection: {
      candidateIds: [R73_C1_ID, R73_C2_ID],
      rule: "Train + validation only; net > 0, expectancy > 0, PF >= 1.20, stress net > 0, stress PF >= 1.05, and at least 2 positive base folds.",
      ranking: input.challengerRanks,
      selectedForFinalOos: input.selectedId,
      nonSelectedFinalOos: input.candidates.filter((candidate) => candidate.spec.kind !== "A" && !candidate.finalOos).map((candidate) => candidate.spec.id),
      selectionDataset: "R7.1 authoritative 20-symbol validation-cache",
    },
    candidates: input.candidates.map((candidate) => serializeCandidate(candidate, candidateA)),
    bestCandidate: selected?.spec.id ?? R73_CANDIDATE_A_ID,
    comparison: selected ? buildComparison(candidateA, selected) : null,
    gates: {
      finalProfitability: "net > 0, expectancy > 0, PF >= 1.25, stress net > 0, stress PF >= 1.10, trades >= A, drawdown within approved tolerance",
      C1Throughput: "OOS signals >= 29 OR annualized >= 100",
      C2Throughput: "OOS signals >= 58 OR annualized >= 200",
      throughputEvaluatedAfterProfitability: true,
    },
    finalOosRunGuard: {
      perCandidateOneShot: true,
      executedCandidateIds: input.candidates.filter((candidate) => candidate.finalOos).map((candidate) => candidate.spec.id),
      runCount: input.oosRunCount,
    },
    artifacts: {
      updated: ["reports/hy-r7.2-signal-throughput-research.json", "reports/hy-r7.2-signal-throughput-research.md"],
      created: ["reports/hy-r7.3-breakout-candidate-research.json", "reports/hy-r7.3-breakout-candidate-research.md"],
      selectionSource: "data/validation-cache/<fixed-symbol>-1754705700000-1786241699999.json",
      historicalR71AReport: "reports/hy-r7.1a-candidate-adjudication.json",
    },
    verification: {
      tests: process.env.HY_R73_TESTS ?? "pending final verification",
      typecheck: process.env.HY_R73_TYPECHECK ?? "pending final verification",
      lint: process.env.HY_R73_LINT ?? "pending final verification",
      build: process.env.HY_R73_BUILD ?? "pending final verification",
      diff: process.env.HY_R73_DIFF ?? "pending final verification",
      githubCi: process.env.HY_R73_GITHUB_CI ?? "pending push",
      authoritativeAReproductionTolerance: "1e-6 absolute metric tolerance; exact expected values matched",
    },
    classification: input.classification,
  };
  return { json: reportJson, markdown: renderMarkdown(reportJson) };
}

function serializeCandidate(candidate: CandidateEvaluation, candidateA: CandidateEvaluation): Record<string, unknown> {
  const oos = candidate.finalOos;
  const rules = candidate.spec.kind === "A"
    ? {
      entryMode: "TREND_PULLBACK",
      side: "SHORT",
      strategyFamily: "TREND",
      changedFromA: [],
    }
    : candidate.spec.kind === "C1"
      ? {
        entryMode: "BREAKOUT_RETEST",
        side: "SHORT",
        strategyFamily: "BREAKOUT",
        breakoutPeriod: R73_BREAKOUT_DEFAULTS.breakoutPeriod,
        breakoutVolumeRatio: R73_BREAKOUT_DEFAULTS.breakoutVolumeRatio,
        changedFromA: ["entry pattern/family only"],
      }
      : {
        entryMode: "TREND_PULLBACK OR BREAKOUT_RETEST",
        side: "SHORT",
        strategyFamily: "TREND + BREAKOUT",
        breakoutPeriod: R73_BREAKOUT_DEFAULTS.breakoutPeriod,
        breakoutVolumeRatio: R73_BREAKOUT_DEFAULTS.breakoutVolumeRatio,
        changedFromA: ["union of A and C1 entries; shared cooldown and portfolio policy"],
      };
  return {
    id: candidate.spec.id,
    kind: candidate.spec.kind,
    description: candidate.spec.description,
    rules: {
      ...rules,
      minScore: 80,
      cooldownHours: 24,
      rewardRisk: 2,
      maxHoldHours: 48,
      stopAtrMultiplier: 0.75,
      localRegimeAlignment: true,
      globalRegimeAlignment: true,
      dynamicUniverse: "top10",
      noDoubleOpen: candidate.spec.kind === "C2",
    },
    train: serializeSlice(candidate.train),
    validation: serializeSlice(candidate.validation),
    selection: {
      base: candidate.selection.base,
      stress: candidate.selection.stress,
      positiveBaseFolds: candidate.selection.positiveBaseFolds,
      positiveStressFolds: candidate.selection.positiveStressFolds,
      stabilityScore: candidate.selection.stabilityScore,
      signalRate: candidate.selection.signalRate,
      profitabilityEligible: candidate.selection.profitabilityEligible,
    },
    finalOosStatus: candidate.finalOosStatus,
    finalOos: oos ? serializeSlice(oos) : null,
    finalOosSignalRate: candidate.oosSignalRate,
    finalOosBootstrap: candidate.oosBootstrap,
    finalOosProfitabilityGate: candidate.finalOosProfitabilityGate,
    finalOosThroughputGate: candidate.finalOosThroughputGate,
    selectedForFinalOos: candidate.selectedForFinalOos,
    top1SymbolConcentration: oos ? topSymbolConcentration(oos.base.trades, 1) : null,
    top3SymbolConcentration: oos ? topSymbolConcentration(oos.base.trades, 3) : null,
    comparedAgainst: candidate.spec.kind === "A" ? null : candidateA.spec.id,
  };
}

function serializeSlice(pair: SlicePair): Record<string, unknown> {
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

function buildComparison(candidateA: CandidateEvaluation, candidate: CandidateEvaluation): Record<string, unknown> {
  if (!candidateA.finalOos || !candidate.finalOos) return { status: "INCOMPLETE" };
  return {
    baseline: candidateA.spec.id,
    candidate: candidate.spec.id,
    finalOos: {
      tradeCount: { baseline: candidateA.finalOos.base.metrics.trades, candidate: candidate.finalOos.base.metrics.trades },
      netPnlUsdt: { baseline: candidateA.finalOos.base.metrics.netPnlUsdt, candidate: candidate.finalOos.base.metrics.netPnlUsdt },
      expectancyUsdt: { baseline: candidateA.finalOos.base.metrics.expectancyUsdt, candidate: candidate.finalOos.base.metrics.expectancyUsdt },
      profitFactor: { baseline: candidateA.finalOos.base.metrics.profitFactor, candidate: candidate.finalOos.base.metrics.profitFactor },
      stressProfitFactor: { baseline: candidateA.finalOos.stress.metrics.profitFactor, candidate: candidate.finalOos.stress.metrics.profitFactor },
      maxDrawdownPercent: { baseline: candidateA.finalOos.base.metrics.maxDrawdownPercent, candidate: candidate.finalOos.base.metrics.maxDrawdownPercent },
      signalRate: { baseline: candidateA.oosSignalRate, candidate: candidate.oosSignalRate },
    },
  };
}

async function reconcileR72Report(
  report: Record<string, any>,
  candidateA: CandidateEvaluation,
  diagnostics: ProductionDiagnosticsEvidence,
): Promise<void> {
  const previousCandidateA = report.candidateA;
  const authoritativeRate = candidateA.oosSignalRate;
  report.reportReconciliation = {
    version: "hy-r7.3-reconciled",
    purpose: "Correct authority labeling without changing R7.2 sensitivity calculations.",
    authoritativeCandidateA: "R7.1A 20-symbol final OOS; 29 trades / 469.31166529 USDT / PF 1.59999141.",
    a49SensitivityReplay: "Former R7.2 candidateA is retained only as A49_SENSITIVITY_REPLAY; 31 trades / 516.82431928 USDT / PF 1.62010391.",
    universeShare: "STRUCTURAL_UNIVERSE_SELECTION_SHARE; actionable=false; not an entry-family bottleneck.",
    selectionDataset: "R7.1 authoritative 20-symbol validation-cache; 49-symbol replay is sensitivity-only.",
  };
  report.authoritativeCandidateA = {
    candidateId: R73_CANDIDATE_A_ID,
    source: "reports/hy-r7.1a-candidate-adjudication.json",
    authoritative: true,
    finalOos: {
      base: candidateA.finalOos!.base.metrics,
      stress: candidateA.finalOos!.stress.metrics,
    },
    signalRate: authoritativeRate,
  };
  report.a49SensitivityReplay = {
    ...(previousCandidateA ?? {}),
    id: "A49_SENSITIVITY_REPLAY",
    candidateId: "A49_SENSITIVITY_REPLAY",
    label: "A49_SENSITIVITY_REPLAY",
    authoritative: false,
    selectionEligible: false,
    selectionRole: "Sensitivity only; cannot overwrite R7.1A Candidate A.",
  };
  report.candidateA = report.a49SensitivityReplay;
  report.historicalFunnel = {
    ...report.historicalFunnel,
    role: "SENSITIVITY_ONLY_NOT_SELECTION_EVIDENCE",
  };
  report.dominantBottleneck = {
    ...(report.dominantBottleneck ?? {}),
    classification: "STRUCTURAL_UNIVERSE_SELECTION_SHARE",
    actionable: false,
    rationale: "Top-10 within the 49-symbol replay naturally excludes approximately 39/49 observations; this is not an actionable entry-family bottleneck.",
  };
  report.candidateFamilySelected = "NONE_ENTRY_FAMILY_SELECTED";
  report.candidateSelection = {
    ...(report.candidateSelection ?? {}),
    authoritativeDataset: "R7.1 20-symbol validation-cache",
    sensitivityDataset: "R7.2 49-symbol replay",
    B1: "REJECTED_TRAIN_VALIDATION_PROFITABILITY_GATE",
    B2: "REJECTED_TRAIN_VALIDATION_PROFITABILITY_GATE",
    doNotResearchFurther: ["B1", "B2", "A49_SENSITIVITY_REPLAY"],
  };
  report.productionReadOnlyAttribution = {
    ...(report.productionReadOnlyAttribution ?? {}),
    latestSymbolDiagnostics: diagnostics,
  };
  report.signalRates = {
    ...(report.signalRates ?? {}),
    candidateAHistoricalFinalOos: authoritativeRate,
    a49SensitivityReplay: report.signalRates?.candidateAHistoricalFinalOos ?? null,
  };
  await writeFile(R72_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(R72_REPORT_MD_PATH, renderReconciledR72Markdown(report), "utf8");
}

function renderReconciledR72Markdown(report: Record<string, any>): string {
  const a = report.authoritativeCandidateA;
  const a49 = report.a49SensitivityReplay;
  const b1 = (report.challengerCandidates ?? []).find((row: any) => row.id === "B1");
  const b2 = (report.challengerCandidates ?? []).find((row: any) => row.id === "B2");
  const stages = report.historicalFunnel?.finalOos?.stages ?? [];
  const rows = stages.map((row: any) => `| ${row.stage} | ${row.input} | ${row.passed} | ${row.rejected} |`).join("\n");
  const counts = report.productionReadOnlyAttribution?.latestSymbolDiagnostics?.rejectionStageCounts ?? [];
  const countRows = counts.map((row: any) => `| ${row.rejectionStage} | ${row.count} | ${row.sharePercent}% |`).join("\n");
  return `# HY-R7.2 Signal Throughput + Profitability Research (R7.3 reconciled)

This report preserves the R7.2 49-symbol replay as sensitivity evidence and restores R7.1A as the only authoritative Candidate A.

## Authority correction

- Authoritative Candidate A: **${a.candidateId}**, R7.1A 20-symbol dataset; ${a.finalOos.base.trades} OOS trades, ${a.finalOos.base.netPnlUsdt} USDT, PF ${a.finalOos.base.profitFactor}.
- Former R7.2 Candidate A: **A49_SENSITIVITY_REPLAY** only; ${a49.finalOos.base.metrics.trades} trades, ${a49.finalOos.base.metrics.netPnlUsdt} USDT, PF ${a49.finalOos.base.metrics.profitFactor}.
- The 49-symbol replay cannot overwrite, select, or mutate Candidate A.

## 49-symbol sensitivity funnel

| Stage | Input | Passed | Rejected |
|---|---:|---:|---:|
${rows}

  The former 79.591837% universe share is **STRUCTURAL_UNIVERSE_SELECTION_SHARE**, actionable=false. It reflects top-10 selection inside a 49-symbol replay, not an actionable entry-family bottleneck.
  No further B1/B2/A49 research is authorized; B1=${b1?.selection?.profitabilityEligible ? "eligible" : "REJECTED"}, B2=${b2?.selection?.profitabilityEligible ? "eligible" : "REJECTED"} by train+validation profitability evidence.

## Production read-only rejection-stage evidence

| Rejection stage | Count | Share of symbol observations |
|---|---:|---:|
${countRows}

Counters are candidate-level and non-sequential. Conditional pass rates are not calculated; the mutually exclusive denominator is \`symbol_diagnostics[].rejectionStage\`. Source: \`lib/core/candidate-funnel.ts:evaluateCandidateFunnel\`, \`recordCooldownResult\`, and \`addFilterFunnel\`.

## Safety

Production / Supabase / Vercel / PAPER strategy modified: **NO**. Real email: **OFF**. Private API: **NO**. Orders: **0**. AUTO_TRADING: **FALSE**.

Reconciled by HY-R7.3; no historical sensitivity result was recalculated.
`;
}

function renderMarkdown(report: Record<string, unknown>): string {
  const json = report as Record<string, any>;
  const a = json.authoritativeCandidateA;
  const c1 = (json.candidates as Array<Record<string, any>>).find((row) => row.kind === "C1");
  const c2 = (json.candidates as Array<Record<string, any>>).find((row) => row.kind === "C2");
  if (!c1 || !c2) throw new Error("R7.3 report requires both C1 and C2 candidate rows");
  const selectionRows = [c1, c2].map((row) => `| ${row.id} | ${row.selection.base.netPnlUsdt} | ${row.selection.base.expectancyUsdt} | ${row.selection.base.profitFactor} | ${row.selection.stress.netPnlUsdt} | ${row.selection.stress.profitFactor} | ${row.selection.positiveBaseFolds} | ${row.selection.profitabilityEligible ? "PASS" : "REJECTED"} |`).join("\n");
  const rejectionRows = (json.productionDiagnostics.rejectionStageCounts as Array<Record<string, any>>).map((row) => `| ${row.rejectionStage} | ${row.count} | ${row.sharePercent}% |`).join("\n");
  const oosRows = [c1, c2].map((row) => `| ${row.id} | ${row.finalOosStatus} | ${row.finalOos?.base?.metrics?.trades ?? "NOT RUN"} | ${row.finalOos?.base?.metrics?.netPnlUsdt ?? "NOT RUN"} | ${row.finalOos?.base?.metrics?.profitFactor ?? "NOT RUN"} | ${row.finalOosProfitabilityGate ? "PASS" : "NO"} | ${row.finalOosThroughputGate ? "PASS" : "NO"} |`).join("\n");
  return `# HY-R7.3 R7.2 Reconciliation + Breakout Candidate Research

Classification: **${json.classification}**

Research-only artifact. No Production, Supabase, Vercel, PAPER strategy, email, private API, or order state was changed.

## Frozen authority and PIT dataset

- Authoritative Candidate A: \`${a.candidateId}\`; exact R7.1A reproduction: **${a.exactReproduction ? "YES" : "NO"}**.
- A OOS: **${a.metrics.oos.trades} trades**, **${a.metrics.oos.netPnlUsdt} USDT**, PF **${a.metrics.oos.profitFactor}**; stress **${a.metrics.stress.netPnlUsdt} USDT**, PF **${a.metrics.stress.profitFactor}**.
- Selection dataset: **20 fixed symbols** from \`data/validation-cache\`; 49-symbol R7.2 data is sensitivity-only.
- PIT: closed 15m decision data through t; next-bar open execution; 48h embargo between train/validation/final OOS.
- Candidate A hash: \`${json.frozenCandidateA.strategyHash}\` (unchanged).

## A49 relabeling

R7.2’s 31-trade / 516.82431928 USDT / PF 1.62010391 replay is explicitly **A49_SENSITIVITY_REPLAY**. It is not authoritative A and is not used for selection.

## Production diagnostics (read-only)

Rows: **${json.productionDiagnostics.diagnosticsRows}**; scan runs: **${json.productionDiagnostics.diagnosticsScanRuns}**; symbol observations: **${json.productionDiagnostics.symbolObservations}**.

| rejectionStage | Count | Share |
|---|---:|---:|
${rejectionRows}

Primary throughput limiter: **ENTRY PATTERN SCARCITY** (NO_RAW_CANDIDATE is largest). Secondary limiter: **SCORE FILTER**. Score was not lowered. Candidate-level filter counters are non-sequential; conditional rates are intentionally **not calculated**. Latest diagnostics remain \`${json.productionDiagnostics.latest.strategyVersion}\`, global regime \`${json.productionDiagnostics.latest.globalRegime}\`, deep universe ${json.productionDiagnostics.latest.deepUniverseSize}.

## Pre-registered candidate selection

Selection gate: net > 0, expectancy > 0, PF >= 1.20, stress net > 0, stress PF >= 1.05, and at least 2 positive base folds. Profitability is ranked before throughput.

| Candidate | Selection net | Expectancy | PF | Stress net | Stress PF | Positive base folds | Gate |
|---|---:|---:|---:|---:|---:|---:|---|
${selectionRows}

- C1 defaults are frozen \`BREAKOUT_RETEST\`, breakoutPeriod=20, breakoutVolumeRatio=1.15; no optimization was performed.
- C2 is the union of A and C1 with one 24h same-symbol cooldown, shared portfolio caps, and higher-score de-duplication at the same symbol/timestamp.

## Final OOS (one-shot after selection)

| Candidate | Status | OOS trades | OOS net | OOS PF | Profitability | Throughput |
|---|---|---:|---:|---:|---|---|
${oosRows}

${json.bestCandidate === json.frozenCandidateA.candidateId ? "Neither preregistered challenger passed the selection gate; Candidate A remains the only frozen forward candidate." : `Selected candidate: **${json.bestCandidate}**.`}

## Bootstrap and decision

Bootstrap confidence is present for every actual final-OOS run. No final OOS was run for a rejected challenger. Classification is limited to the R7.3 allowed set and is **${json.classification}**.

## Verification and safety

- Tests: **${json.verification.tests}**
- Typecheck: **${json.verification.typecheck}**
- Lint: **${json.verification.lint}**
- Build: **${json.verification.build}**
- Diff: **${json.verification.diff}**
- GitHub CI: **${json.verification.githubCi}**
- Production modified: **NO**; Supabase modified: **NO**; Vercel modified: **NO**; PAPER strategy modified: **NO**.
- Real email: **OFF**; private API: **NO**; orders: **0**; AUTO_TRADING: **FALSE**.

Reports updated: \`reports/hy-r7.2-signal-throughput-research.{json,md}\`.
`;
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
