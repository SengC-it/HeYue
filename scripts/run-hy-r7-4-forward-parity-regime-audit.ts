import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildCandidateCache,
  buildDynamicUniverseByTimestamp,
  buildGlobalRegimeByTimestamp,
  evaluateHistoricalTrade,
  runPortfolioBacktest,
  snapshotAt,
} from "@/lib/backtest/engine";
import { assertHistoricalDatasetIntegrity } from "@/lib/backtest/data-integrity";
import type { BacktestTrade, HistoricalDataset } from "@/lib/backtest/types";
import {
  evaluateCandidateFunnel,
  type CandidateFunnelEvaluation,
} from "@/lib/core/candidate-funnel";
import {
  createRuntimeStrategyPolicy,
  type RuntimeStrategyPolicy,
} from "@/lib/core/runtime-strategy";
import { DEFAULT_STRATEGY_PARAMS } from "@/lib/core/strategies";
import type { Candle, MarketRegime, ScoredCandidate, TradePlan } from "@/lib/core/types";
import { ProductionClaimSimulator } from "@/lib/backtest/production-parity";
import {
  assertPITNextBar,
  classifyR74,
  compareStringArrays,
  driftRatio,
  latestClosed15mTimestamp,
  metricFromBooleans,
  scanSourceTimestamp,
  type ParityMetric,
} from "@/lib/research/r7-4-forward-parity";
import { calculateResearchMetrics } from "@/lib/research/r7-1";

const HISTORICAL_START = Date.parse("2026-05-09T02:15:00.000Z");
const HISTORICAL_END = Date.parse("2026-08-09T02:14:59.999Z");
const HISTORICAL_BOUNDARY_TEXT = "2026-08-09T02:15:00.000Z";
const FORWARD_START = Date.parse("2026-08-09T17:34:48.982760Z");
const FORWARD_START_TEXT = "2026-08-09T17:34:48.982760Z";
const FIRST_PRODUCTION_SCAN = "2026-08-09T17:34:48.982760Z";
const STRATEGY_CREATED_AT = "2026-08-09T15:46:25.317519Z";
const STRATEGY_VERSION = "hy-paper-candidate-v2";
const CANDIDATE_ID = "HY-R7-FORWARD-CANDIDATE-A";
const RESEARCH_BASE_HEAD = "f09fa1de91d26a8559abd54dec30337166bb935a";
const PR_BASE_HEAD_OBSERVED = "aa983c3aa4fd1cd8fed2e4d88fffea2c4a88b320";
const EXPECTED_STRATEGY_HASH = "3c3df714d4e5768a4393e523b331b70f239e5c07b963e5bdada7442d69a27918";
const EXPECTED_OOS = {
  trades: 29,
  baseNetPnlUsdt: 469.31166529,
  baseProfitFactor: 1.59999141,
  stressNetPnlUsdt: 400.66533784,
  stressProfitFactor: 1.48858398,
};
const PRODUCTION_DIAGNOSTICS_PATH = resolve(".tmp-r74", "production-diagnostics.json");
const PRODUCTION_SCAN_RUNS_PATH = resolve(".tmp-r74", "production-scan-runs.json");
const PRODUCTION_ACTUAL_PATH = resolve(".tmp-r74", "production-actual.json");
const VERIFICATION_PATH = resolve(".tmp-r74", "verification.json");
const FORWARD_DATA_DIRECTORY = resolve(".tmp-r74", "market-data");
const HISTORICAL_DATA_DIRECTORY = resolve("data", "validation-cache");
const FORWARD_SYMBOLS = [
  "龙虾USDT", "牛来USDT", "ARBUSDT", "BNBUSDT", "BTCUSDT", "BULLAUSDT", "DASHUSDT",
  "DOGEUSDT", "ETHUSDT", "HYPEUSDT", "IOSTUSDT", "LABUSDT", "LSKUSDT", "MARSCOINUSDT",
  "NEARUSDT", "RAYSOLUSDT", "SOLUSDT", "SOPHUSDT", "SUIUSDT", "UNIUSDT", "USELESSUSDT",
  "VTHOUSDT", "VVVUSDT", "WLDUSDT", "XRPUSDT", "ZECUSDT",
];
const HISTORICAL_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT", "AVAXUSDT", "SUIUSDT",
  "1000SHIBUSDT", "1000PEPEUSDT", "AAVEUSDT", "TRXUSDT", "PAXGUSDT", "INJUSDT", "COTIUSDT", "LTCUSDT", "XLMUSDT", "XMRUSDT",
];

interface ProductionSymbolRow {
  symbol: string;
  rejectionStage: string;
  rawCandidateCount: number;
  topRawScore: number | null;
  claimed: boolean | null;
}

interface ProductionDiagnosticScan {
  scanRunId: string;
  createdAt: string;
  globalRegime: MarketRegime | null;
  deepUniverseSize: number;
  deepUniverseSymbols: string[];
  symbols: ProductionSymbolRow[];
}

interface ScanRunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  candidate_count: number;
  emailed_count: number;
  universe_size: number;
  scanned_symbols: number;
  created_at: string;
}

interface ProductionSignalRow {
  id: string;
  scan_run_id: string;
  signal_key: string;
  symbol: string;
  side: string;
  score: string;
  market_regime: string;
  source_data_timestamp: string;
  created_at: string;
  status: string;
}

interface ProductionTradeRow {
  id: string;
  signal_id: string;
  symbol: string;
  side: string;
  entry_time: string;
  exit_time: string | null;
  status: string;
  exit_reason: string | null;
  net_pnl_usdt: string | null;
  r_multiple: string | null;
}

interface ProductionNotificationRow {
  id: string;
  signal_id: string;
  channel: string;
  status: string;
  sent_at: string | null;
  subject: string;
  created_at: string;
}

interface ProductionActualFixture {
  signals: ProductionSignalRow[];
  trades: ProductionTradeRow[];
  notifications: ProductionNotificationRow[];
  scanAgg: Array<{ status: string; count: number; first_started_at: string; last_started_at: string }>;
}

interface VerificationRecord {
  tests: string;
  typecheck: string;
  lint: string;
  build: string;
  diff: string;
  githubCi: string;
}

interface ObservationStats {
  observations: number;
  rawCandidates: number;
  scorePassCandidates: number;
  bearAlignedCandidates: number;
  executionCostEligible: number;
  qualifiedCandidates: number;
  finalSignals: number;
  regimeCounts: Record<MarketRegime, number>;
}

interface ReplayEvent {
  sourceTimestamp: number;
  entryTime: number;
  symbol: string;
  side: "LONG" | "SHORT";
  score: number;
  marketRegime: MarketRegime;
  plan: TradePlan;
  paperTrade: BacktestTrade | null;
}

interface ReplayRun {
  stats: ObservationStats;
  finalEvents: ReplayEvent[];
  allQualifiedEvents: ReplayEvent[];
  trades: BacktestTrade[];
  maturedTrades: BacktestTrade[];
  incompleteObservations: string[];
  pitViolations: string[];
}

interface ReplayEvaluation {
  dataset: HistoricalDataset;
  index: number;
  snapshot: ReturnType<typeof snapshotAt>;
  result: CandidateFunnelEvaluation;
  entryCandle: Candle;
  globalRegime: MarketRegime;
}

interface ParityScanResult {
  scanRunId: string;
  sourceTimestamp: number;
  timestampMappingValid: boolean;
  universeMatch: boolean;
  globalRegimeMatch: boolean;
  rawCandidateMatch: boolean;
  rejectionStageMatch: boolean;
  scoreMatch: boolean;
  qualifiedCandidateMatch: boolean;
  claimedSignalMatch: boolean;
  offlineRawSymbols: string[];
  productionRawSymbols: string[];
  offlineQualifiedSymbols: string[];
  productionQualifiedSymbols: string[];
  offlineClaimedSymbols: string[];
  productionClaimedSymbols: string[];
}

interface DataLoadResult {
  datasets: HistoricalDataset[];
  manifestRows: string[];
}

async function main(): Promise<void> {
  const policy = frozenPolicy();
  const verification = await loadVerification();
  const historical = await loadHistoricalData();
  const baseline = reproduceAuthoritativeOos(historical.datasets, policy);
  const baselinePass = isAuthoritativeReproduction(baseline);
  if (!baselinePass) {
    await writeReports({
      policy,
      baseline,
      baselinePass,
      forwardEnd: null,
      forward: null,
      historicalRates: null,
      parity: null,
      production: null,
      classification: "BACKTEST_REPRODUCIBILITY_FAILURE",
      dataManifestRows: historical.manifestRows,
      missingEvidence: ["Authoritative Candidate A OOS reproduction failed; forward replay was not run."],
      verification,
    });
    throw new Error("BACKTEST_REPRODUCIBILITY_FAILURE");
  }

  const forward = await loadForwardData();
  const forwardEnd = determineForwardEnd(forward.datasets);
  const productionScans = await loadProductionScans();
  const production = await loadProductionActual();
  const allForwardTimes = decisionTimes(forward.datasets, FORWARD_START, forwardEnd);
  const allHistoricalTimes = decisionTimes(historical.datasets, HISTORICAL_START, HISTORICAL_END);
  const forwardGlobalRegimes = buildGlobalRegimeMap(forward.datasets, allForwardTimes);
  const historicalGlobalRegimes = buildGlobalRegimeMap(historical.datasets, allHistoricalTimes);
  const forwardReplay = runCounterfactual(forward.datasets, allForwardTimes, forwardEnd, forwardGlobalRegimes, policy);
  const historicalReplay = runCounterfactual(historical.datasets, allHistoricalTimes, HISTORICAL_END, historicalGlobalRegimes, policy);
  const parity = compareProductionParity(productionScans, forward.datasets, forwardGlobalRegimes, policy);
  // The release gate is defined by the operational outputs, not by the
  // descriptive score/universe diagnostics.  Keep the latter visible in the
  // report, but require both qualified and claimed parity for classification.
  const diagnosticsParityPercent = Math.min(
    parity.metrics.qualifiedCandidate.matchPercent,
    parity.metrics.claimedSignal.matchPercent,
  );
  const hypeAnchorMatches = parity.hypeAnchorMatches;
  const missingEvidence = [
    ...forwardReplay.incompleteObservations,
    ...forwardReplay.pitViolations,
    ...parity.missingEvidence,
  ];
  const historicalRates = opportunityRateSummary(historicalReplay.stats);
  const forwardRates = opportunityRateSummary(forwardReplay.stats);
  // Candidate A's environment-sensitive opportunity is the BEAR-aligned
  // funnel and its final signal rate. Raw and score-pass rates remain in the
  // report as controls; they must not be described as lower when they are not.
  const forwardOpportunityMateriallyLower = isMateriallyLower(
    forwardRates.bearAlignedRate,
    historicalRates.bearAlignedRate,
  ) && isMateriallyLower(forwardRates.finalSignalRate, historicalRates.finalSignalRate);
  const forwardRegimeMateriallyLower = isMateriallyLower(
    share(forwardReplay.stats.regimeCounts.BEAR, allForwardTimes.length),
    share(historicalReplay.stats.regimeCounts.BEAR, allHistoricalTimes.length),
  );
  const evidenceComplete = missingEvidence.length === 0
    && parity.timestampMapping.compared > 0
    && parity.timestampMapping.mismatch === 0;
  const classification = classifyR74({
    authoritativeReproduced: baselinePass,
    evidenceComplete,
    diagnosticsParityPercent,
    hypeAnchorMatches,
    replayQualifiedSignals: forwardReplay.allQualifiedEvents.length,
    productionQualifiedSignals: parity.productionQualifiedCount,
    replayFinalSignals: forwardReplay.finalEvents.length,
    productionFinalSignals: production.signals.length,
    forwardOpportunityMateriallyLower,
    forwardRegimeMateriallyLower,
  });
  await writeReports({
    policy,
    baseline,
    baselinePass,
    forwardEnd,
    forward: {
      replay: forwardReplay,
      rates: forwardRates,
      start: FORWARD_START_TEXT,
      end: new Date(forwardEnd).toISOString(),
      days: (forwardEnd - FORWARD_START) / 86_400_000,
      globalRegimeCounts: forwardReplay.stats.regimeCounts,
    },
    historicalRates: {
      ...historicalRates,
      globalRegimeCounts: historicalReplay.stats.regimeCounts,
      days: (HISTORICAL_END - HISTORICAL_START) / 86_400_000,
    },
    parity,
    production,
    classification,
    dataManifestRows: [...historical.manifestRows, ...forward.manifestRows],
    missingEvidence,
    forwardOpportunityMateriallyLower,
    forwardRegimeMateriallyLower,
    verification,
  });
  console.log(JSON.stringify({
    ok: true,
    baselinePass,
    forwardStart: new Date(FORWARD_START).toISOString(),
    forwardEnd: new Date(forwardEnd).toISOString(),
    diagnosticsScansCompared: parity.scanCount,
    parity: parity.summary,
    hypeAnchorMatches,
    replayQualified: forwardReplay.allQualifiedEvents.length,
    replayFinalSignals: forwardReplay.finalEvents.length,
    productionSignals: production.signals.length,
    replayMaturedTrades: forwardReplay.maturedTrades.length,
    classification,
  }, null, 2));
}

function frozenPolicy(): RuntimeStrategyPolicy {
  const policy = createRuntimeStrategyPolicy({
    version: STRATEGY_VERSION,
    entryMode: "TREND_PULLBACK",
    stopAtrMultiplier: 0.75,
    minScore: 80,
    sideFilter: "SHORT",
    strategyFamily: "TREND",
    requireRegimeAlignment: true,
    riskPolicy: {
      marginUsdt: 100,
      leverage: 20,
      singleSignalRiskCapUsdt: 50,
      dailyRiskBudgetUsdt: 600,
      maxHoldHours: 48,
      rewardRisk: 2,
      riskPerTradeUsdt: 50,
      maxPositionNotionalUsdt: 10_000,
    },
    cooldownHours: 24,
    maxExecutionCostRiskFraction: 0.1,
    takerFeeRate: 0.0004,
    slippageBps: 2,
    globalRegimeAlignment: true,
    globalReferenceSymbol: "BTCUSDT",
    globalReferenceTimeframe: "4h",
  });
  if (JSON.stringify(policy.params) !== JSON.stringify({ ...DEFAULT_STRATEGY_PARAMS, entryMode: "TREND_PULLBACK", stopAtrMultiplier: 0.75 })) {
    throw new Error("Candidate A strategy parameters are not frozen");
  }
  return policy;
}

function reproduceAuthoritativeOos(datasets: HistoricalDataset[], policy: RuntimeStrategyPolicy): {
  base: ReturnType<typeof runBacktestSummary>;
  stress: ReturnType<typeof runBacktestSummary>;
} {
  const caches = datasets.map((dataset) => buildCandidateCache(dataset, policy.params, HISTORICAL_END));
  const entryTimes = [...new Set(caches.flatMap((cache, index) => [...cache.keys()]
    .map((key) => datasets[index].candles["15m"][key]?.closeTime)
    .filter((value): value is number => value !== undefined)))].sort((left, right) => left - right);
  const dynamicUniverseByTimestamp = buildDynamicUniverseByTimestamp(datasets, entryTimes, 10, 1);
  const globalRegimeByTimestamp = buildGlobalRegimeByTimestamp(datasets, entryTimes, "BTCUSDT", "4h");
  const base = runBacktestSummary(datasets, policy, caches, dynamicUniverseByTimestamp, globalRegimeByTimestamp, {
    takerFeeRate: 0.0004,
    slippageBps: 2,
    selectionTakerFeeRate: 0.0004,
    selectionSlippageBps: 2,
  });
  const stress = runBacktestSummary(datasets, policy, caches, dynamicUniverseByTimestamp, globalRegimeByTimestamp, {
    takerFeeRate: 0.0006,
    slippageBps: 4,
    selectionTakerFeeRate: 0.0004,
    selectionSlippageBps: 2,
  });
  return { base, stress };
}

function runBacktestSummary(
  datasets: HistoricalDataset[],
  policy: RuntimeStrategyPolicy,
  caches: Array<Map<number, ScoredCandidate[]>>,
  dynamicUniverseByTimestamp: Map<number, Set<string>>,
  globalRegimeByTimestamp: Map<number, MarketRegime>,
  costs: { takerFeeRate: number; slippageBps: number; selectionTakerFeeRate: number; selectionSlippageBps: number },
) {
  const result = runPortfolioBacktest(datasets, policy.params, {
    ...backtestOptions(policy),
    ...costs,
    evaluationStartTime: HISTORICAL_START,
    evaluationEndTime: HISTORICAL_END,
    candidateCaches: caches,
    dynamicUniverseByTimestamp,
    globalRegimeByTimestamp,
  });
  const metrics = calculateResearchMetrics(result.trades);
  return {
    trades: metrics.trades,
    netPnlUsdt: metrics.netPnlUsdt,
    profitFactor: metrics.profitFactor,
    metrics,
  };
}

function backtestOptions(policy: RuntimeStrategyPolicy) {
  return {
    initialCapitalUsdt: 10_000,
    minimumSampleDays: 0,
    minScore: policy.minScore,
    maxHoldHours: policy.riskPolicy.maxHoldHours,
    rewardRisk: policy.riskPolicy.rewardRisk,
    singleSignalRiskCapUsdt: policy.riskPolicy.singleSignalRiskCapUsdt,
    dailyRiskBudgetUsdt: policy.riskPolicy.dailyRiskBudgetUsdt,
    dailyLossLimitUsdt: policy.riskPolicy.dailyRiskBudgetUsdt,
    maxConcurrentPositions: 6,
    maxEmailsPerDay: 10,
    maxEmailsPerScan: 6,
    capitalFloorUsdt: 0,
    marginUsdt: policy.riskPolicy.marginUsdt,
    leverage: policy.riskPolicy.leverage,
    riskPerTradeUsdt: policy.riskPolicy.riskPerTradeUsdt,
    maxPositionNotionalUsdt: policy.riskPolicy.maxPositionNotionalUsdt,
    requireRegimeAlignment: policy.requireRegimeAlignment,
    sideFilter: policy.sideFilter,
    strategyFamilies: policy.strategyFamily ? [policy.strategyFamily] : undefined,
    maxExecutionCostRiskFraction: policy.maxExecutionCostRiskFraction,
    dynamicUniverseSize: 10,
    dynamicUniverseLookbackDays: 1,
    globalReferenceSymbol: policy.globalReferenceSymbol,
    globalReferenceTimeframe: policy.globalReferenceTimeframe,
    globalRegimeAlignment: policy.globalRegimeAlignment,
    entryDelayBars: 1,
    cooldownHours: policy.cooldownHours,
  };
}

function isAuthoritativeReproduction(baseline: ReturnType<typeof reproduceAuthoritativeOos>): boolean {
  return baseline.base.trades === EXPECTED_OOS.trades
    && closeEnough(baseline.base.netPnlUsdt, EXPECTED_OOS.baseNetPnlUsdt)
    && closeEnough(baseline.base.profitFactor, EXPECTED_OOS.baseProfitFactor)
    && closeEnough(baseline.stress.netPnlUsdt, EXPECTED_OOS.stressNetPnlUsdt)
    && closeEnough(baseline.stress.profitFactor, EXPECTED_OOS.stressProfitFactor);
}

function closeEnough(left: number, right: number, tolerance = 1e-6): boolean {
  return Math.abs(left - right) <= tolerance;
}

async function loadHistoricalData(): Promise<DataLoadResult> {
  const datasets: HistoricalDataset[] = [];
  const manifestRows: string[] = [];
  for (const symbol of HISTORICAL_SYMBOLS) {
    const fileName = `${symbol}-1754705700000-1786241699999.json`;
    const path = resolve(HISTORICAL_DATA_DIRECTORY, fileName);
    const bytes = await readFile(path);
    const dataset = JSON.parse(bytes.toString("utf8")) as HistoricalDataset;
    assertHistoricalDatasetIntegrity(dataset);
    datasets.push(dataset);
    manifestRows.push(`${path}:${sha256(bytes)}`);
  }
  return { datasets, manifestRows };
}

async function loadForwardData(): Promise<DataLoadResult> {
  const datasets: HistoricalDataset[] = [];
  const manifestRows: string[] = [];
  for (const symbol of FORWARD_SYMBOLS) {
    const path = resolve(FORWARD_DATA_DIRECTORY, `${symbol}.json`);
    const bytes = await readFile(path);
    const dataset = JSON.parse(bytes.toString("utf8")) as HistoricalDataset;
    assertHistoricalDatasetIntegrity(dataset);
    datasets.push(dataset);
    manifestRows.push(`${path}:${sha256(bytes)}`);
  }
  return { datasets, manifestRows };
}

function determineForwardEnd(datasets: HistoricalDataset[]): number {
  const btc = datasets.find((dataset) => dataset.symbol === "BTCUSDT");
  if (!btc) throw new Error("BTCUSDT is required for the forward clock");
  const dataEnd = btc.candles["15m"].at(-1)?.closeTime;
  if (dataEnd === undefined) throw new Error("BTCUSDT has no forward 15m data");
  return Math.min(dataEnd, latestClosed15mTimestamp(Date.now()));
}

function decisionTimes(datasets: HistoricalDataset[], start: number, end: number): number[] {
  const reference = datasets.find((dataset) => dataset.symbol === "BTCUSDT");
  if (!reference) throw new Error("BTCUSDT is required for decision timestamps");
  return reference.candles["15m"]
    .filter((candle, index, candles) => candle.closeTime >= start && candle.closeTime <= end && Boolean(candles[index + 1]))
    .map((candle) => candle.closeTime);
}

function buildGlobalRegimeMap(datasets: HistoricalDataset[], timestamps: number[]): Map<number, MarketRegime> {
  return buildGlobalRegimeByTimestamp(datasets, timestamps, "BTCUSDT", "4h");
}

function runCounterfactual(
  datasets: HistoricalDataset[],
  timestamps: number[],
  evaluationEnd: number,
  globalRegimes: Map<number, MarketRegime>,
  policy: RuntimeStrategyPolicy,
): ReplayRun {
  const stats: ObservationStats = {
    observations: 0,
    rawCandidates: 0,
    scorePassCandidates: 0,
    bearAlignedCandidates: 0,
    executionCostEligible: 0,
    qualifiedCandidates: 0,
    finalSignals: 0,
    regimeCounts: { BULL: 0, BEAR: 0, RANGE: 0, UNKNOWN: 0 },
  };
  const allQualifiedEvents: ReplayEvent[] = [];
  const incompleteObservations: string[] = [];
  const pitViolations: string[] = [];
  const claimableByTimestamp = new Map<number, ReplayEvent[]>();

  for (const timestamp of timestamps) {
    const globalRegime = globalRegimes.get(timestamp) ?? "UNKNOWN";
    stats.regimeCounts[globalRegime] += 1;
    const dynamicUniverse = rankUniverseAtTimestamp(datasets, timestamp, 10);
    for (const dataset of datasets) {
      const evaluation = evaluateAtTimestamp(dataset, timestamp, globalRegime, policy);
      if (!evaluation) continue;
      stats.observations += 1;
      stats.rawCandidates += evaluation.result.diagnostics.rawCandidateCount;
      stats.scorePassCandidates += evaluation.result.counts.scorePass;
      stats.bearAlignedCandidates += evaluation.result.counts.globalRegimePass;
      stats.executionCostEligible += evaluation.result.counts.executionCostPass;
      if (!evaluation.result.candidate || !evaluation.result.plan) continue;
      if (!dynamicUniverse.has(dataset.symbol)) continue;
      stats.qualifiedCandidates += 1;
      const event: ReplayEvent = {
        sourceTimestamp: timestamp,
        entryTime: evaluation.entryCandle.openTime,
        symbol: dataset.symbol,
        side: evaluation.result.candidate.side,
        score: evaluation.result.candidate.score,
        marketRegime: evaluation.result.candidate.marketRegime,
        plan: evaluation.result.plan,
        paperTrade: evaluateHistoricalTrade(dataset, evaluation.index + 1, evaluation.result.candidate, evaluation.result.plan, {
          maxHoldHours: policy.riskPolicy.maxHoldHours,
          takerFeeRate: policy.takerFeeRate,
          slippageBps: policy.slippageBps,
          evaluationEndTime: evaluationEnd,
        }),
      };
      allQualifiedEvents.push(event);
      const list = claimableByTimestamp.get(timestamp) ?? [];
      list.push(event);
      claimableByTimestamp.set(timestamp, list);
    }
  }

  const simulator = new ProductionClaimSimulator({
    cooldownHours: policy.cooldownHours,
    singleSignalRiskCapUsdt: policy.riskPolicy.singleSignalRiskCapUsdt,
    dailyRiskBudgetUsdt: policy.riskPolicy.dailyRiskBudgetUsdt,
    maxEmailsPerDay: 10,
    maxEmailsPerScan: 6,
    emailObservationEnabled: false,
    dryRun: true,
  });
  const finalEvents: ReplayEvent[] = [];
  for (const timestamp of [...claimableByTimestamp.keys()].sort((left, right) => left - right)) {
    const events = claimableByTimestamp.get(timestamp)!.sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol));
    for (const event of events) {
      simulator.recordQualifiedCandidate();
      const outcome = simulator.claim({
        symbol: event.symbol,
        sourceTimestamp: event.sourceTimestamp,
        score: event.score,
        riskUsdt: event.plan.theoreticalRiskUsdt,
        validUntil: event.plan.validUntil,
        paperTrade: event.paperTrade,
      });
      if (outcome.claimed) finalEvents.push(event);
    }
  }
  stats.finalSignals = finalEvents.length;
  const trades = simulator.result().trades;
  const maturedTrades = trades.filter((trade) => isMaturedTrade(trade, evaluationEnd));
  for (const timestamp of timestamps) {
    for (const dataset of datasets) {
      const index = indexForClose(dataset.candles["15m"], timestamp);
      if (index === null) continue;
      const entry = dataset.candles["15m"][index + 1];
      if (!entry) {
        incompleteObservations.push(`${dataset.symbol}@${new Date(timestamp).toISOString()}:missing next bar`);
        continue;
      }
      try {
        assertPITNextBar(timestamp, entry.openTime);
      } catch (error) {
        pitViolations.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return { stats, finalEvents, allQualifiedEvents, trades, maturedTrades, incompleteObservations, pitViolations };
}

function evaluateAtTimestamp(
  dataset: HistoricalDataset,
  timestamp: number,
  globalRegime: MarketRegime,
  policy: RuntimeStrategyPolicy,
): ReplayEvaluation | null {
  const index = indexForClose(dataset.candles["15m"], timestamp);
  if (index === null || index < 80) return null;
  const entryCandle = dataset.candles["15m"][index + 1];
  if (!entryCandle) return null;
  const snapshot = snapshotAt(dataset, index);
  const result = evaluateCandidateFunnel({
    snapshot,
    strategy: policy,
    globalRegime,
    executionPrice: entryCandle.open,
  });
  return { dataset, index, snapshot, result, entryCandle, globalRegime };
}

function rankUniverseAtTimestamp(datasets: HistoricalDataset[], timestamp: number, size: number): Set<string> {
  const ranked = datasets.map((dataset) => {
    const candles = dataset.candles["15m"];
    const end = lastIndexAtOrBefore(candles, timestamp);
    if (end < 0) return { symbol: dataset.symbol, quoteVolume: 0, available: false };
    const start = Math.max(0, end - 95);
    const quoteVolume = candles.slice(start, end + 1).reduce((total, candle) => total + (candle.quoteVolume ?? candle.close * candle.volume), 0);
    return { symbol: dataset.symbol, quoteVolume, available: true };
  }).filter((item) => item.available)
    .sort((left, right) => right.quoteVolume - left.quoteVolume || left.symbol.localeCompare(right.symbol));
  return new Set(ranked.slice(0, size).map((item) => item.symbol));
}

function compareProductionParity(
  scans: ProductionDiagnosticScan[],
  datasets: HistoricalDataset[],
  globalRegimes: Map<number, MarketRegime>,
  policy: RuntimeStrategyPolicy,
) {
  const parityRows: ParityScanResult[] = [];
  const missingEvidence: string[] = [];
  const claimSimulator = new ProductionClaimSimulator({
    cooldownHours: policy.cooldownHours,
    singleSignalRiskCapUsdt: policy.riskPolicy.singleSignalRiskCapUsdt,
    dailyRiskBudgetUsdt: policy.riskPolicy.dailyRiskBudgetUsdt,
    maxEmailsPerDay: 10,
    maxEmailsPerScan: 6,
    emailObservationEnabled: false,
    dryRun: true,
  });
  let productionQualifiedCount = 0;
  for (const scan of scans.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))) {
    const scanRun = scan as ProductionDiagnosticScan & { startedAt?: string; status?: string };
    const startedAt = scanRun.startedAt ?? scan.createdAt;
    const sourceTimestamp = scanSourceTimestamp(startedAt);
    const timestampMappingValid = Number.isFinite(sourceTimestamp)
      && datasets.some((dataset) => indexForClose(dataset.candles["15m"], sourceTimestamp) !== null);
    if (!timestampMappingValid) missingEvidence.push(`${scan.scanRunId}:no exact source candle for ${sourceTimestamp}`);
    const globalRegime = globalRegimes.get(sourceTimestamp) ?? "UNKNOWN";
    const productionRawSymbols = scan.symbols.filter((row) => row.rawCandidateCount > 0).map((row) => row.symbol).sort();
    const productionQualifiedSymbols = scan.symbols.filter((row) => row.rejectionStage === "QUALIFIED").map((row) => row.symbol).sort();
    const productionClaimedSymbols = scan.symbols.filter((row) => row.claimed === true).map((row) => row.symbol).sort();
    productionQualifiedCount += productionQualifiedSymbols.length;
    const offlineEvaluations = scan.deepUniverseSymbols.map((symbol) => {
      const dataset = datasets.find((candidate) => candidate.symbol === symbol);
      return dataset ? evaluateAtTimestamp(dataset, sourceTimestamp, globalRegime, policy) : null;
    }).filter((value): value is ReplayEvaluation => value !== null);
    const offlineRawSymbols = offlineEvaluations.filter((item) => item.result.diagnostics.rawCandidateCount > 0).map((item) => item.dataset.symbol).sort();
    const offlineQualified = offlineEvaluations.filter((item) => item.result.candidate && item.result.plan)
      .sort((left, right) => right.result.candidate!.score - left.result.candidate!.score || left.dataset.symbol.localeCompare(right.dataset.symbol));
    const offlineQualifiedSymbols = offlineQualified.map((item) => item.dataset.symbol).sort();
    const offlineClaimedSymbols: string[] = [];
    for (const item of offlineQualified) {
      claimSimulator.recordQualifiedCandidate();
      const outcome = claimSimulator.claim({
        symbol: item.dataset.symbol,
        sourceTimestamp,
        score: item.result.candidate!.score,
        riskUsdt: item.result.plan!.theoreticalRiskUsdt,
        validUntil: item.result.plan!.validUntil,
      });
      if (outcome.claimed) offlineClaimedSymbols.push(item.dataset.symbol);
    }
    const rejectionStageMatch = scan.symbols.every((productionRow) => {
      const offline = offlineEvaluations.find((item) => item.dataset.symbol === productionRow.symbol);
      return offline !== undefined && offline.result.diagnostics.rejectionStage === productionRow.rejectionStage;
    });
    const scoreMatch = scan.symbols.filter((row) => row.rawCandidateCount > 0).every((productionRow) => {
      const offline = offlineEvaluations.find((item) => item.dataset.symbol === productionRow.symbol);
      return offline !== undefined && closeEnough(offline.result.diagnostics.topRawScore ?? NaN, productionRow.topRawScore ?? NaN, 0.0015);
    });
    parityRows.push({
      scanRunId: scan.scanRunId,
      sourceTimestamp,
      timestampMappingValid,
      universeMatch: compareStringArrays(scan.deepUniverseSymbols, rankUniverseArray(datasets, sourceTimestamp, 10)),
      globalRegimeMatch: scan.globalRegime === globalRegime,
      rawCandidateMatch: compareStringArrays(productionRawSymbols, offlineRawSymbols, false),
      rejectionStageMatch,
      scoreMatch,
      qualifiedCandidateMatch: compareStringArrays(productionQualifiedSymbols, offlineQualifiedSymbols, false),
      claimedSignalMatch: compareStringArrays(productionClaimedSymbols, offlineClaimedSymbols, false),
      offlineRawSymbols,
      productionRawSymbols,
      offlineQualifiedSymbols,
      productionQualifiedSymbols,
      offlineClaimedSymbols: offlineClaimedSymbols.sort(),
      productionClaimedSymbols,
    });
  }
  const metrics = {
    universe: metricFromBooleans(parityRows.map((row) => row.universeMatch)),
    globalRegime: metricFromBooleans(parityRows.map((row) => row.globalRegimeMatch)),
    rawCandidate: metricFromBooleans(parityRows.map((row) => row.rawCandidateMatch)),
    rejectionStage: metricFromBooleans(parityRows.map((row) => row.rejectionStageMatch)),
    score: metricFromBooleans(parityRows.map((row) => row.scoreMatch)),
    qualifiedCandidate: metricFromBooleans(parityRows.map((row) => row.qualifiedCandidateMatch)),
    claimedSignal: metricFromBooleans(parityRows.map((row) => row.claimedSignalMatch)),
  };
  const summary = [metrics.universe, metrics.globalRegime, metrics.rawCandidate, metrics.qualifiedCandidate, metrics.claimedSignal];
  const summaryOverallMatchPercent = summary.length === 0 ? 0 : summary.reduce((total, metric) => total + metric.matchPercent, 0) / summary.length;
  const hypeScan = parityRows.find((row) => row.sourceTimestamp === Date.parse("2026-09-10T19:14:59.999Z"));
  const hypeAnchorMatches = Boolean(hypeScan?.offlineClaimedSymbols.includes("HYPEUSDT"))
    && Boolean(hypeScan?.productionClaimedSymbols.includes("HYPEUSDT"));
  if (!hypeAnchorMatches) missingEvidence.push("HYPEUSDT SHORT production anchor did not match the same claimed decision episode");
  return {
    scanCount: parityRows.length,
    rows: parityRows,
    metrics,
    summary,
    summaryOverallMatchPercent,
    hypeAnchorMatches,
    productionQualifiedCount,
    timestampMapping: metricFromBooleans(parityRows.map((row) => row.timestampMappingValid)),
    missingEvidence,
    productionActualSignalCount: 0,
  };
}

function rankUniverseArray(datasets: HistoricalDataset[], timestamp: number, size: number): string[] {
  const ranked = datasets.map((dataset) => {
    const candles = dataset.candles["15m"];
    const end = lastIndexAtOrBefore(candles, timestamp);
    const quoteVolume = end < 0 ? 0 : candles.slice(Math.max(0, end - 95), end + 1)
      .reduce((total, candle) => total + (candle.quoteVolume ?? candle.close * candle.volume), 0);
    return { symbol: dataset.symbol, quoteVolume, available: end >= 0 };
  }).filter((item) => item.available)
    .sort((left, right) => right.quoteVolume - left.quoteVolume || left.symbol.localeCompare(right.symbol));
  return ranked.slice(0, size).map((item) => item.symbol);
}

function opportunityRateSummary(stats: ObservationStats) {
  return {
    denominatorObservations: stats.observations,
    rawCandidates: stats.rawCandidates,
    scorePassCandidates: stats.scorePassCandidates,
    bearAlignedCandidates: stats.bearAlignedCandidates,
    executionCostEligible: stats.executionCostEligible,
    qualifiedCandidates: stats.qualifiedCandidates,
    finalSignals: stats.finalSignals,
    rawCandidateRate: rate(stats.rawCandidates, stats.observations),
    scorePassRate: rate(stats.scorePassCandidates, stats.observations),
    bearAlignedRate: rate(stats.bearAlignedCandidates, stats.observations),
    executionCostRate: rate(stats.executionCostEligible, stats.observations),
    finalSignalRate: rate(stats.finalSignals, stats.observations),
  };
}

function rate(count: number, denominator: number): number {
  return denominator === 0 ? 0 : count / denominator;
}

function share(count: number, denominator: number): number {
  return denominator === 0 ? 0 : count / denominator;
}

function isMateriallyLower(forward: number, historical: number): boolean {
  return historical > 0 && forward < historical * 0.75;
}

function isMaturedTrade(trade: BacktestTrade, evaluationEnd: number): boolean {
  if (trade.exitReason === "STOP" || trade.exitReason === "TAKE_PROFIT") return trade.exitTime <= evaluationEnd;
  return trade.exitTime < evaluationEnd;
}

function indexForClose(candles: Candle[], timestamp: number): number | null {
  const index = candles.findIndex((candle) => candle.closeTime === timestamp);
  return index < 0 ? null : index;
}

function lastIndexAtOrBefore(candles: Candle[], timestamp: number): number {
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

async function loadProductionScans(): Promise<ProductionDiagnosticScan[]> {
  const diagnostics = JSON.parse(await readFile(PRODUCTION_DIAGNOSTICS_PATH, "utf8")) as { scans: ProductionDiagnosticScan[] };
  const scanRuns = parseSupabaseJson<ScanRunRow[]>(await readFile(PRODUCTION_SCAN_RUNS_PATH, "utf8"));
  const byId = new Map(scanRuns.map((row) => [row.id, row]));
  return diagnostics.scans.map((scan) => {
    const run = byId.get(scan.scanRunId);
    if (!run) throw new Error(`Missing scan run fixture for ${scan.scanRunId}`);
    if (run.status !== "COMPLETED") throw new Error(`Production diagnostics scan ${scan.scanRunId} is not completed`);
    return Object.assign(scan, { startedAt: run.started_at, status: run.status });
  });
}

async function loadProductionActual(): Promise<ProductionActualFixture> {
  return parseSupabaseJson<ProductionActualFixture>(await readFile(PRODUCTION_ACTUAL_PATH, "utf8"));
}

async function loadVerification(): Promise<VerificationRecord | null> {
  try {
    return JSON.parse(await readFile(VERIFICATION_PATH, "utf8")) as VerificationRecord;
  } catch {
    return null;
  }
}

function parseSupabaseJson<T>(bytes: Buffer | string): T {
  const outer = typeof bytes === "string" ? JSON.parse(bytes) as unknown : JSON.parse(bytes.toString("utf8")) as unknown;
  if (Array.isArray(outer)) return outer as T;
  if (isRecord(outer) && typeof outer.result === "string") {
    let result: unknown;
    try {
      result = JSON.parse(outer.result);
    } catch {
      result = null;
    }
    if (isRecord(result) && typeof result.result === "string") return extractTaggedJson<T>(result.result);
    return extractTaggedJson<T>(outer.result);
  }
  if (isRecord(outer) && "signals" in outer) return outer as T;
  throw new Error("Unsupported Supabase fixture wrapper");
}

function extractTaggedJson<T>(value: string): T {
  const start = value.indexOf("[");
  const end = value.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("Supabase fixture does not contain JSON array");
  return JSON.parse(value.slice(start, end + 1)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeReports(input: ReportInput): Promise<void> {
  const report = buildReport(input);
  await writeFile(resolve("reports", "hy-r7.4-forward-parity-regime-audit.json"), `${JSON.stringify(report.json, null, 2)}\n`, "utf8");
  await writeFile(resolve("reports", "hy-r7.4-forward-parity-regime-audit.md"), report.markdown, "utf8");
}

interface ReportInput {
  policy: RuntimeStrategyPolicy;
  baseline: ReturnType<typeof reproduceAuthoritativeOos>;
  baselinePass: boolean;
  forwardEnd: number | null;
  forward: {
    replay: ReplayRun;
    rates: ReturnType<typeof opportunityRateSummary>;
    start: string;
    end: string;
    days: number;
    globalRegimeCounts: Record<MarketRegime, number>;
  } | null;
  historicalRates: (ReturnType<typeof opportunityRateSummary> & {
    globalRegimeCounts: Record<MarketRegime, number>;
    days: number;
  }) | null;
  parity: ReturnType<typeof compareProductionParity> | null;
  production: ProductionActualFixture | null;
  classification: string;
  dataManifestRows: string[];
  missingEvidence: string[];
  verification?: VerificationRecord | null;
  forwardOpportunityMateriallyLower?: boolean;
  forwardRegimeMateriallyLower?: boolean;
}

function buildReport(input: ReportInput): { json: Record<string, unknown>; markdown: string } {
  const dataManifestRows = [...input.dataManifestRows].sort();
  const dataManifestSha256 = createHash("sha256").update(`${dataManifestRows.join("\n")}\n`).digest("hex");
  const productionSignals = input.production?.signals ?? [];
  const productionTrades = input.production?.trades ?? [];
  const productionNotifications = input.production?.notifications ?? [];
  const forwardReplay = input.forward?.replay ?? null;
  const parity = input.parity;
  const json: Record<string, unknown> = {
    reportVersion: "hy-r7.4-v1",
    generatedAt: new Date().toISOString(),
    purpose: "Frozen Candidate A forward parity and regime drift audit; no strategy search or production mutation.",
    pullRequest: {
      number: 9,
      branch: "research/hy-r7-profitability",
      baseRef: "codex/paper-observation-deploy",
      baseHead: PR_BASE_HEAD_OBSERVED,
      researchBaselineHead: RESEARCH_BASE_HEAD,
      status: "DRAFT",
    },
    candidate: {
      id: CANDIDATE_ID,
      strategyVersion: STRATEGY_VERSION,
      strategyHash: EXPECTED_STRATEGY_HASH,
      parameters: input.policy,
      frozen: true,
    },
    authoritativeBaseline: {
      expected: EXPECTED_OOS,
      reproduced: input.baseline,
      pass: input.baselinePass,
    },
    clocks: {
      historicalOosEnd: HISTORICAL_BOUNDARY_TEXT,
      strategyCreatedAt: STRATEGY_CREATED_AT,
      firstCompletedProductionScanAt: FIRST_PRODUCTION_SCAN,
      forwardStart: FORWARD_START_TEXT,
      forwardEnd: input.forwardEnd === null ? null : new Date(input.forwardEnd).toISOString(),
      forwardCalendarDays: input.forward?.days ?? null,
      sourceTimestampRule: "floor(scan started_at / 15m) * 15m - 1ms; decision uses closed 15m candle; entry uses next 15m open",
    },
    productionActual: {
      completedScans: input.production?.scanAgg.filter((row) => row.status === "COMPLETED").reduce((total, row) => total + row.count, 0) ?? null,
      failedScans: input.production?.scanAgg.filter((row) => row.status !== "COMPLETED").reduce((total, row) => total + row.count, 0) ?? null,
      forwardSignals: productionSignals,
      forwardTrades: productionTrades,
      maturedTrades: productionTrades.filter((trade) => trade.status === "TAKE_PROFIT" || trade.status === "STOP_LOSS"),
      actualNotifications: productionNotifications.map(({ id, signal_id, channel, status, sent_at, subject, created_at }) => ({ id, signal_id, channel, status, sent_at, subject, created_at })),
      newRealEmails: 0,
    },
    parity: parity ? {
      scanCountCompared: parity.scanCount,
      metrics: parity.metrics,
      summaryOverallMatchPercent: parity.summaryOverallMatchPercent,
      hypeAnchorMatches: parity.hypeAnchorMatches,
      timestampMapping: parity.timestampMapping,
      productionQualifiedCount: parity.productionQualifiedCount,
      rows: parity.rows,
    } : null,
    forwardReplay: forwardReplay ? {
      qualifiedSignalCount: forwardReplay.allQualifiedEvents.length,
      finalSignalCount: forwardReplay.finalEvents.length,
      finalSignals: forwardReplay.finalEvents.map(replayEventSummary),
      maturedTrades: forwardReplay.maturedTrades,
      maturedTradeMetrics: calculateResearchMetrics(forwardReplay.maturedTrades),
      incompleteObservations: forwardReplay.incompleteObservations,
      pitViolations: forwardReplay.pitViolations,
    } : null,
    opportunityRates: {
      historicalOos: input.historicalRates ? ratePayload(input.historicalRates) : null,
      forward: input.forward ? ratePayload(input.forward.rates) : null,
      driftRatios: input.forward && input.historicalRates ? {
        rawCandidateRate: driftRatio(input.forward.rates.rawCandidateRate, input.historicalRates.rawCandidateRate),
        scorePassRate: driftRatio(input.forward.rates.scorePassRate, input.historicalRates.scorePassRate),
        bearRegimeShare: driftRatio(
          share(input.forward.globalRegimeCounts.BEAR, input.forward.replay.stats.regimeCounts.BEAR + input.forward.replay.stats.regimeCounts.BULL + input.forward.replay.stats.regimeCounts.RANGE + input.forward.replay.stats.regimeCounts.UNKNOWN),
          share(input.historicalRates.globalRegimeCounts.BEAR, totalRegimeCount(input.historicalRates.globalRegimeCounts)),
        ),
        finalSignalRate: driftRatio(input.forward.rates.finalSignalRate, input.historicalRates.finalSignalRate),
      } : null,
    },
    regimeDistribution: {
      historicalOos: input.historicalRates?.globalRegimeCounts ?? null,
      forward: input.forward?.globalRegimeCounts ?? null,
      historicalBearShare: input.historicalRates ? share(input.historicalRates.globalRegimeCounts.BEAR, totalRegimeCount(input.historicalRates.globalRegimeCounts)) : null,
      forwardBearShare: input.forward ? share(input.forward.globalRegimeCounts.BEAR, totalRegimeCount(input.forward.globalRegimeCounts)) : null,
      candidateATradeableRegimeShare: input.forward && input.forward.rates.scorePassCandidates > 0
        ? input.forward.rates.bearAlignedCandidates / input.forward.rates.scorePassCandidates
        : 0,
    },
    evidence: {
      dataSources: ["data/validation-cache frozen R7.1 authority", ".tmp-r74/market-data Binance public historical klines/funding", ".tmp-r74/production-diagnostics.json read-only Supabase snapshot", ".tmp-r74/production-scan-runs.json read-only Supabase snapshot"],
      dataManifestRows,
      dataManifestSha256,
      dataManifestRepresentation: "UTF-8 deterministic newline-delimited path:raw-file-SHA256 rows, sorted lexicographically",
      noRawDatasetSubmitted: true,
      missingEvidence: input.missingEvidence,
    },
    safety: {
      productionModified: false,
      supabaseModified: false,
      vercelModified: false,
      paperStrategyModified: false,
      realEmailsSent: 0,
      privateApiCalled: false,
      orders: 0,
      autoTrading: false,
      strategySearch: false,
    },
    decision: {
      productionParity: parity
        && Math.min(parity.metrics.qualifiedCandidate.matchPercent, parity.metrics.claimedSignal.matchPercent) >= 99
        && parity.hypeAnchorMatches
        ? "PASS"
        : "FAIL",
      forwardOpportunityMateriallyLower: input.forwardOpportunityMateriallyLower ?? false,
      forwardRegimeMateriallyLower: input.forwardRegimeMateriallyLower ?? false,
      classification: input.classification,
    },
    verification: input.verification ?? { tests: "pending", typecheck: "pending", lint: "pending", build: "pending", diff: "pending", githubCi: "pending push" },
  };
  return { json, markdown: renderMarkdown(json) };
}

function ratePayload(value: ReturnType<typeof opportunityRateSummary>) {
  return value;
}

function replayEventSummary(event: ReplayEvent): Record<string, unknown> {
  return {
    sourceTimestamp: new Date(event.sourceTimestamp).toISOString(),
    entryTime: new Date(event.entryTime).toISOString(),
    symbol: event.symbol,
    side: event.side,
    score: event.score,
    regime: event.marketRegime,
  };
}

function totalRegimeCount(counts: Record<MarketRegime, number>): number {
  return counts.BULL + counts.BEAR + counts.RANGE + counts.UNKNOWN;
}

function renderMarkdown(report: Record<string, unknown>): string {
  const baseline = report.authoritativeBaseline as { expected: typeof EXPECTED_OOS; reproduced: { base: { trades: number; netPnlUsdt: number; profitFactor: number }; stress: { netPnlUsdt: number; profitFactor: number } }; pass: boolean };
  const clocks = report.clocks as Record<string, unknown>;
  const parity = report.parity as { scanCountCompared: number; metrics: Record<string, ParityMetric>; summaryOverallMatchPercent: number; hypeAnchorMatches: boolean; timestampMapping: ParityMetric } | null;
  const forward = report.forwardReplay as { qualifiedSignalCount: number; finalSignalCount: number; maturedTrades: BacktestTrade[]; incompleteObservations: string[]; pitViolations: string[] } | null;
  const actual = report.productionActual as { completedScans: number | null; failedScans: number | null; forwardSignals: ProductionSignalRow[]; forwardTrades: ProductionTradeRow[]; actualNotifications: ProductionNotificationRow[]; newRealEmails: number };
  const rates = report.opportunityRates as { historicalOos: ReturnType<typeof opportunityRateSummary> | null; forward: ReturnType<typeof opportunityRateSummary> | null; driftRatios: Record<string, number | null> | null };
  const regimes = report.regimeDistribution as Record<string, unknown>;
  const evidence = report.evidence as { missingEvidence: string[]; dataManifestSha256: string; dataManifestRows: string[] };
  const decision = report.decision as Record<string, unknown>;
  const verification = report.verification as { tests: string; typecheck: string; lint: string; build: string; diff: string; githubCi: string };
  const lines = [
    "# HY-R7.4 Forward Parity + Regime Drift Audit",
    "",
    "本报告仅审计冻结的 Candidate A；没有参数搜索、Production 写入、部署或邮件发送。所有 forward replay 使用公开 Binance 市场数据，决策只读 closed 15m candle，执行价为下一根 15m open。",
    "",
    "## 1. Frozen authority",
    "",
    `- Candidate: ${CANDIDATE_ID}; strategy: ${STRATEGY_VERSION}; strategy SHA256: ${EXPECTED_STRATEGY_HASH}`,
    `- Reproduction gate: **${baseline.pass ? "PASS" : "FAIL"}**; base: ${baseline.reproduced.base.trades} trades / ${baseline.reproduced.base.netPnlUsdt} USDT / PF ${baseline.reproduced.base.profitFactor}; stress: ${baseline.reproduced.stress.netPnlUsdt} USDT / PF ${baseline.reproduced.stress.profitFactor}. Expected 29 / 469.31166529 / 1.59999141 and 400.66533784 / 1.48858398.`,
    `- Historical OOS boundary: ${clocks.historicalOosEnd}`,
    `- Forward observation start: ${clocks.forwardStart} (= max(strategy created_at ${clocks.strategyCreatedAt}, first completed scan ${clocks.firstCompletedProductionScanAt}))`,
    `- Forward end: ${clocks.forwardEnd}; calendar days: ${clocks.forwardCalendarDays}`,
    "",
    "## 2. Production parity window",
    "",
    parity ? `- Scans compared: ${parity.scanCountCompared}; aggregate parity average: ${formatPercent(parity.summaryOverallMatchPercent)}; timestamp mapping: ${formatMetric(parity.timestampMapping)}; HYPE anchor: **${parity.hypeAnchorMatches ? "MATCH" : "MISMATCH"}**.` : "- Not run because the authoritative reproduction gate failed.",
    ...(parity ? Object.entries(parity.metrics).map(([name, value]) => `- ${name}: ${formatMetric(value)}`) : []),
    "- Each scan also records exact universe order, global regime, raw symbols, rejection stages, raw scores, qualified symbols, and claimed symbols in the JSON artifact.",
    "",
    "## 3. Forward counterfactual",
    "",
    forward ? `- Qualified candidates: ${forward.qualifiedSignalCount}; final claimed replay signals: ${forward.finalSignalCount}; Production forward signals: ${actual.forwardSignals.length}.` : "- Not run.",
    forward ? `- Replay matured trades: ${forward.maturedTrades.length}; Production forward paper trades: ${actual.forwardTrades.length}.` : "",
    forward && forward.incompleteObservations.length > 0 ? `- Incomplete observations: ${forward.incompleteObservations.length}` : "- Incomplete observations: 0",
    forward && forward.pitViolations.length > 0 ? `- PIT violations: ${forward.pitViolations.length}` : "- PIT violations: 0",
    "",
    "## 4. Regime distribution and opportunity rates",
    "",
    `- Historical OOS global regimes: ${JSON.stringify(regimes.historicalOos)}; BEAR share: ${formatPercent(Number(regimes.historicalBearShare) * 100)}.`,
    `- Forward global regimes: ${JSON.stringify(regimes.forward)}; BEAR share: ${formatPercent(Number(regimes.forwardBearShare) * 100)}.`,
    `- Candidate A tradeable BEAR-aligned share among score-pass candidates: ${formatPercent(Number(regimes.candidateATradeableRegimeShare) * 100)}.`,
    rates.historicalOos ? `- Historical rates (denominator ${rates.historicalOos.denominatorObservations} symbol-observations): raw ${formatRate(rates.historicalOos.rawCandidateRate)}, score>=80 ${formatRate(rates.historicalOos.scorePassRate)}, BEAR-aligned ${formatRate(rates.historicalOos.bearAlignedRate)}, execution-cost eligible ${formatRate(rates.historicalOos.executionCostRate)}, final ${formatRate(rates.historicalOos.finalSignalRate)}.` : "- Historical rates: not run.",
    rates.forward ? `- Forward rates (denominator ${rates.forward.denominatorObservations} symbol-observations): raw ${formatRate(rates.forward.rawCandidateRate)}, score>=80 ${formatRate(rates.forward.scorePassRate)}, BEAR-aligned ${formatRate(rates.forward.bearAlignedRate)}, execution-cost eligible ${formatRate(rates.forward.executionCostRate)}, final ${formatRate(rates.forward.finalSignalRate)}.` : "- Forward rates: not run.",
    rates.driftRatios ? `- Drift ratios (forward / historical): ${JSON.stringify(rates.driftRatios)}.` : "- Drift ratios: not run.",
    "- Material opportunity-drift rule: BEAR-aligned candidate rate and final signal rate must each be at least 25% below Historical OOS; raw and score-pass rates are reported separately.",
    "",
    "## 5. Actual Production evidence",
    "",
    `- Completed scans: ${actual.completedScans ?? "NOT AVAILABLE"}; failed scans: ${actual.failedScans ?? "NOT AVAILABLE"}; forward signals: ${actual.forwardSignals.length}; paper trades: ${actual.forwardTrades.length}; read-only notification rows: ${actual.actualNotifications.length}; newly sent real emails: ${actual.newRealEmails}.`,
    "- The HYPE historical SENT notification remains historical evidence; this audit did not send a notification.",
    "",
    "## 6. Evidence and classification",
    "",
    `- Data manifest SHA256: ${evidence.dataManifestSha256} (sorted UTF-8 path:raw-file-SHA256 rows; no raw dataset is included).`,
    `- Missing evidence / fail-closed reasons: ${evidence.missingEvidence.length === 0 ? "NONE" : evidence.missingEvidence.join(" | ")}`,
    `- Production parity: ${String(decision.productionParity)}; forward opportunity materially lower: ${String(decision.forwardOpportunityMateriallyLower)}; forward regime materially lower: ${String(decision.forwardRegimeMateriallyLower)}.`,
    `- Classification: **${String(decision.classification)}**.`,
    "",
    "## 7. Safety",
    "",
    "- Production modified: NO; Supabase modified: NO; Vercel modified: NO; PAPER strategy modified: NO; strategy search: NO; private API: NO; orders: 0; AUTO_TRADING: FALSE; real emails: 0.",
    "",
    "## 8. Verification",
    "",
    `- Tests: ${verification.tests}; typecheck: ${verification.typecheck}; lint: ${verification.lint}; build: ${verification.build}; diff: ${verification.diff}; GitHub CI: ${verification.githubCi}.`,
    "",
  ];
  return `${lines.filter((line) => line !== undefined).join("\n").trimEnd()}\n`;
}

function formatMetric(metric: ParityMetric): string {
  return `${metric.exact}/${metric.compared} exact, ${metric.mismatch} mismatch (${formatPercent(metric.matchPercent)})`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(3)}%`;
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(6)}%`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
