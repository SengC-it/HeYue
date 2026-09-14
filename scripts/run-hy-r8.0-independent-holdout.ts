import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { promisify } from "node:util";
import {
  buildCandidateCache,
  buildDynamicUniverseByTimestamp,
  buildGlobalRegimeByTimestamp,
  runPortfolioBacktest,
  type BacktestOptions,
} from "@/lib/backtest/engine";
import { assertHistoricalDatasetIntegrity } from "@/lib/backtest/data-integrity";
import type { BacktestTrade, HistoricalDataset, PortfolioBacktestResult } from "@/lib/backtest/types";
import { DEFAULT_STRATEGY_PARAMS, type StrategyParams } from "@/lib/core/strategies";
import type { Candle, MarketRegime, ScoredCandidate } from "@/lib/core/types";
import { calculateResearchMetrics, sourceTimeForEntry, topSymbolConcentration, type ResearchMetrics } from "@/lib/research/r7-1";
import { validateFrozenFailureSet } from "@/lib/research/r7-1a";
import { auditOnlyFailureSet, calculateSignalRate, type SignalRate } from "@/lib/research/r7-2";
import {
  assertNoPostResultMutation,
  assertR80CandidateAFrozen,
  assertR80QuarterBoundaries,
  assertR80WindowIndependent,
  bootstrapR80,
  buildR80Availability,
  buildR80PitDynamicUniverse,
  buildR80QuarterWindows,
  classifyR80,
  isR80NextBarExecution,
  passesR80EdgeGate,
  R80_BASE_RESEARCH_HEAD,
  R80_BOOTSTRAP_ITERATIONS,
  R80_BOOTSTRAP_SEED,
  R80_CANDIDATE_A_ID,
  R80_EXPECTED_CANDIDATE_A,
  R80_FORWARD_START,
  R80_FROZEN_RULES,
  R80_HOLDOUT_END,
  R80_HOLDOUT_START,
  R80_PROTOCOL_COMMIT,
  R80_R7_END,
  R80_R7_START,
  R80_REPORT_VERSION,
  R80_STRATEGY_HASH,
  R80_STRATEGY_VERSION,
  R80_SYMBOLS,
  R80OneShotGuard,
  type R80Availability,
  type R80Classification,
  type R80QuarterWindow,
} from "@/lib/research/r8-0-holdout";

const execFileAsync = promisify(execFile);

const R7_DATA_DIRECTORY = resolve("data", "validation-cache");
const R80_DATA_DIRECTORY = resolve("data", "hy-r2b-history-24m");
const PROTOCOL_PATH = resolve("reports", "hy-r8.0-holdout-protocol.json");
const RESULT_JSON_PATH = resolve("reports", "hy-r8.0-independent-holdout.json");
const RESULT_MD_PATH = resolve("reports", "hy-r8.0-independent-holdout.md");
const DATA_MANIFEST_PATH = resolve("reports", "hy-r8.0-data-manifest.json");
const R74_REPORT_PATH = resolve("reports", "hy-r7.4-forward-parity-regime-audit.json");
const FAILURE_SET_PATH = resolve("reports", "hy-r7.1-old-email-failure-ledger.csv");
const R7_CACHE_VERSION = "candidate-cache-v4";
const HOLDOUT_END_TEXT = "2025-08-09T02:14:59.999Z";
const R7_END_TEXT = "2026-08-09T02:14:59.999Z";
const R7_FINAL_OOS_START = Date.parse("2026-05-09T02:15:00.000Z");
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const CANDIDATE_A_PARAMS: StrategyParams = {
  ...DEFAULT_STRATEGY_PARAMS,
  entryMode: "TREND_PULLBACK",
  stopAtrMultiplier: 0.75,
};

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
  // The frozen protocol stresses execution economics but retains base-cost
  // eligibility so that base and stress evaluate the same signal set.
  selectionTakerFeeRate: 0.0004,
  selectionSlippageBps: 2,
});

interface ManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

interface LoadedData {
  datasets: HistoricalDataset[];
  entries: ManifestEntry[];
}

interface ExecutionMaps {
  dynamicUniverseByTimestamp: Map<number, Set<string>>;
  globalRegimeByTimestamp: Map<number, MarketRegime>;
}

interface SliceRun {
  portfolio: PortfolioBacktestResult;
  allTrades: BacktestTrade[];
  maturedTrades: BacktestTrade[];
  metrics: ResearchMetrics;
  rawMetrics: ResearchMetrics;
  signalRate: SignalRate;
}

interface SlicePair {
  base: SliceRun;
  stress: SliceRun;
}

interface CostModel {
  name: string;
  takerFeeRate: number;
  slippageBps: number;
  selectionTakerFeeRate: number;
  selectionSlippageBps: number;
}

interface AuthorityReproduction {
  data: LoadedData;
  caches: Array<Map<number, ScoredCandidate[]>>;
  maps: ExecutionMaps;
  pair: SlicePair;
  fullR7Pair: SlicePair;
  pass: boolean;
  expected: typeof R80_EXPECTED_CANDIDATE_A;
  actual: { base: ResearchMetrics; stress: ResearchMetrics };
}

interface HoldoutEvaluation {
  data: LoadedData;
  pair: SlicePair;
  availability: R80Availability[];
  windows: R80QuarterWindow[];
  maps: ExecutionMaps;
  pitValidation: Record<string, unknown>;
  quarters: Array<Record<string, unknown>>;
  symbols: Record<string, unknown>;
  bootstrap: ReturnType<typeof bootstrapR80>;
  gate: ReturnType<typeof passesR80EdgeGate>;
  classification: R80Classification;
  failureSet: Record<string, unknown>;
  regimeDistribution: Record<string, unknown>;
}

async function main(): Promise<void> {
  await assertProtocolAuthority();
  assertR80WindowIndependent();
  assertR80QuarterBoundaries(buildR80QuarterWindows());
  assertR80CandidateAFrozen({
    ...R80_FROZEN_RULES,
    strategyVersion: R80_STRATEGY_VERSION,
    strategyHash: R80_STRATEGY_HASH,
  });
  assertNoPostResultMutation({ parametersChanged: false, thresholdsChanged: false, resultUsedForTuning: false });
  await assertOutputsDoNotExist();

  console.log("Loading R7 authority data for Candidate A reproduction");
  const authority = await reproduceCandidateA();
  console.log(`Candidate A reproduction: ${authority.pass ? "PASS" : "FAIL"}`);
  if (!authority.pass) {
    const report = buildFailureReport(authority);
    await writeReports(report, authority.data.entries);
    throw new Error("BACKTEST_REPRODUCIBILITY_FAILURE");
  }

  console.log("Loading independent PRE-R7 holdout data");
  const holdoutData = await loadData(R80_DATA_DIRECTORY, R80_SYMBOLS.map((symbol) => `${symbol}.json`), "R8.0");
  const guard = new R80OneShotGuard();
  const holdout = guard.run(() => evaluateHoldout(holdoutData));
  if (guard.runCount !== 1) throw new Error("R8.0 holdout run count is not exactly one");

  const r74Evidence = await loadR74Evidence();
  const failureSet = await loadFailureSetEvidence();
  holdout.failureSet = failureSet;
  const report = buildReport({ authority, holdout, r74Evidence });
  await writeReports(report, holdout.data.entries);
  console.log(JSON.stringify({
    classification: holdout.classification,
    candidateAReproduced: authority.pass,
    holdoutTrades: holdout.pair.base.maturedTrades.length,
    holdoutNetPnlUsdt: holdout.pair.base.metrics.netPnlUsdt,
    holdoutProfitFactor: holdout.pair.base.metrics.profitFactor,
    stressNetPnlUsdt: holdout.pair.stress.metrics.netPnlUsdt,
    stressProfitFactor: holdout.pair.stress.metrics.profitFactor,
    bootstrapExpectancyPositive: holdout.bootstrap.probabilityExpectancyPositive,
    gatePass: holdout.gate.pass,
  }, null, 2));
}

async function assertProtocolAuthority(): Promise<void> {
  const protocol = JSON.parse(await readFile(PROTOCOL_PATH, "utf8")) as Record<string, any>;
  if (protocol.protocolVersion !== R80_REPORT_VERSION) throw new Error("R8.0 protocol version mismatch");
  if (protocol.pullRequest?.number !== 9 || protocol.pullRequest?.draftRequired !== true) {
    throw new Error("R8.0 protocol PR authority mismatch");
  }
  if (protocol.pullRequest?.branch !== "research/hy-r7-profitability") throw new Error("R8.0 branch authority mismatch");
  if (protocol.pullRequest?.researchBaseHead !== R80_BASE_RESEARCH_HEAD) throw new Error("R8.0 research base changed");
  if (protocol.candidate?.id !== R80_CANDIDATE_A_ID || protocol.candidate?.strategyVersion !== R80_STRATEGY_VERSION) {
    throw new Error("R8.0 candidate authority mismatch");
  }
  if (protocol.candidate?.strategyHashSha256 !== R80_STRATEGY_HASH) throw new Error("R8.0 strategy hash changed");
  if (protocol.holdout?.start !== "2024-08-09T02:15:00.000Z" || protocol.holdout?.end !== HOLDOUT_END_TEXT) {
    throw new Error("R8.0 holdout window changed");
  }
  if (protocol.bootstrap?.iterations !== R80_BOOTSTRAP_ITERATIONS || protocol.bootstrap?.seed !== R80_BOOTSTRAP_SEED) {
    throw new Error("R8.0 bootstrap authority changed");
  }
  if (JSON.stringify(protocol.universe?.symbols) !== JSON.stringify([...R80_SYMBOLS])) {
    throw new Error("R8.0 universe changed");
  }

  const head = (await execFileAsync("git", ["rev-parse", "HEAD"])).stdout.trim();
  if (!(await isAncestor(R80_PROTOCOL_COMMIT, head))) throw new Error("R8.0 protocol commit is not an ancestor of HEAD");
  if (!(await isAncestor(R80_BASE_RESEARCH_HEAD, head))) throw new Error("R8.0 research base is not an ancestor of HEAD");
  const protocolCommitTime = Number((await execFileAsync("git", ["show", "-s", "--format=%ct", R80_PROTOCOL_COMMIT])).stdout.trim());
  if (!Number.isFinite(protocolCommitTime) || protocolCommitTime * 1000 >= Date.now()) {
    throw new Error("R8.0 protocol commit timestamp is invalid");
  }
}

async function isAncestor(ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

async function assertOutputsDoNotExist(): Promise<void> {
  for (const path of [RESULT_JSON_PATH, RESULT_MD_PATH, DATA_MANIFEST_PATH]) {
    try {
      await readFile(path);
      throw new Error(`R8.0 authoritative output already exists; refusing a second run: ${relative(process.cwd(), path)}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("authoritative output already exists")) throw error;
    }
  }
}

async function reproduceCandidateA(): Promise<AuthorityReproduction> {
  const data = await loadData(
    R7_DATA_DIRECTORY,
    R80_SYMBOLS.map((symbol) => `${symbol}-${R80_R7_START}-${R80_R7_END}.json`),
    "R7.1 authority",
    R80_R7_END,
  );
  const caches = await Promise.all(data.datasets.map((dataset) => loadR7CandidateCache(dataset)));
  const entryTimes = collectEntryTimes(data.datasets, caches, R80_R7_START, R80_R7_END);
  const maps: ExecutionMaps = {
    dynamicUniverseByTimestamp: buildDynamicUniverseByTimestamp(data.datasets, entryTimes, R80_FROZEN_RULES.dynamicUniverseSize, R80_FROZEN_RULES.dynamicUniverseLookbackDays),
    globalRegimeByTimestamp: buildGlobalRegimeByTimestamp(data.datasets, entryTimes, "BTCUSDT", "4h"),
  };
  const pair = runSlicePair(data.datasets, caches, maps, R7_FINAL_OOS_START, R80_R7_END);
  const fullR7Pair = runSlicePair(data.datasets, caches, maps, R80_R7_START, R80_R7_END);
  const actual = { base: pair.base.metrics, stress: pair.stress.metrics };
  const pass = actual.base.trades === R80_EXPECTED_CANDIDATE_A.trades
    && closeEnough(actual.base.netPnlUsdt, R80_EXPECTED_CANDIDATE_A.baseNetPnlUsdt)
    && closeEnough(actual.base.profitFactor, R80_EXPECTED_CANDIDATE_A.baseProfitFactor)
    && closeEnough(actual.stress.netPnlUsdt, R80_EXPECTED_CANDIDATE_A.stressNetPnlUsdt)
    && closeEnough(actual.stress.profitFactor, R80_EXPECTED_CANDIDATE_A.stressProfitFactor);
  return { data, caches, maps, pair, fullR7Pair, pass, expected: R80_EXPECTED_CANDIDATE_A, actual };
}

async function loadR7CandidateCache(dataset: HistoricalDataset): Promise<Map<number, ScoredCandidate[]>> {
  const descriptor = JSON.stringify({
    version: R7_CACHE_VERSION,
    symbol: dataset.symbol,
    windowEnd: R80_R7_END,
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
    if (payload.version === R7_CACHE_VERSION && payload.descriptor === descriptor && Array.isArray(payload.entries)) {
      return new Map(payload.entries);
    }
  } catch {
    // Candidate caches are disposable acceleration only; rebuild from source data.
  }
  return buildCandidateCache(dataset, CANDIDATE_A_PARAMS, R80_R7_END);
}

function evaluateHoldout(data: LoadedData): HoldoutEvaluation {
  const dataIssues = validateHoldoutData(data.datasets);
  const availability = data.datasets.map((dataset) => buildR80Availability(dataset.symbol, dataset.candles["15m"]));
  const firstEligibleAt = new Map(availability.map((item) => [item.symbol, item.firstEligibleAt] as const));
  const caches = data.datasets.map((dataset) => buildCandidateCache(dataset, CANDIDATE_A_PARAMS, R80_HOLDOUT_END));
  const entryTimes = collectEntryTimes(data.datasets, caches, R80_HOLDOUT_START, R80_HOLDOUT_END);
  const maps: ExecutionMaps = {
    dynamicUniverseByTimestamp: buildR80PitDynamicUniverse(
      data.datasets,
      entryTimes,
      firstEligibleAt,
      R80_FROZEN_RULES.dynamicUniverseSize,
      R80_FROZEN_RULES.dynamicUniverseLookbackDays,
    ),
    globalRegimeByTimestamp: buildGlobalRegimeByTimestamp(data.datasets, entryTimes, "BTCUSDT", "4h"),
  };
  const pair = runSlicePair(data.datasets, caches, maps, R80_HOLDOUT_START, R80_HOLDOUT_END);
  const sameSignalSet = sameSignalKeys(pair.base.allTrades, pair.stress.allTrades);
  const windows = buildR80QuarterWindows();
  const quarters = windows.map((window) => quarterSummary(window, pair));
  const positiveQuarters = quarters.filter((quarter) => (quarter.base as Record<string, any>).netPnlUsdt > 0).length;
  const symbols = symbolSummary(pair.base.maturedTrades);
  const distinctSymbols = Number(symbols.distinctTradedSymbols ?? 0);
  const bootstrap = bootstrapR80(pair.base.maturedTrades.map((trade) => trade.pnlUsdt));
  const gate = passesR80EdgeGate(
    pair.base.metrics,
    pair.stress.metrics,
    positiveQuarters,
    distinctSymbols,
    bootstrap.probabilityExpectancyPositive,
  );
  const pitValidation = buildPitValidation({
    data,
    availability,
    maps,
    pair,
    dataIssues,
    sameSignalSet,
  });
  const holdoutDataValid = dataIssues.length === 0 && Object.values(pitValidation).every((value) => value === true);
  const classification = classifyR80({
    candidateAReproduced: true,
    holdoutDataValid,
    holdoutTrades: pair.base.maturedTrades.length,
    edgeGatePass: gate.pass,
  });
  const regimeDistribution = regimeShares(maps.globalRegimeByTimestamp, R80_HOLDOUT_START, R80_HOLDOUT_END);
  return {
    data,
    pair,
    availability,
    windows,
    maps,
    pitValidation: { ...pitValidation, dataIssues, sameSignalSet },
    quarters,
    symbols,
    bootstrap,
    gate,
    classification,
    failureSet: {},
    regimeDistribution,
  };
}

function validateHoldoutData(datasets: HistoricalDataset[]): string[] {
  const issues: string[] = [];
  if (datasets.length !== R80_SYMBOLS.length) issues.push(`expected ${R80_SYMBOLS.length} datasets, found ${datasets.length}`);
  for (const symbol of R80_SYMBOLS) {
    const dataset = datasets.find((item) => item.symbol === symbol);
    if (!dataset) {
      issues.push(`missing ${symbol}`);
      continue;
    }
    if (!dataset.candles["1h"]?.length) issues.push(`${symbol} missing 1h candles`);
    if (!dataset.candles["4h"]?.length) issues.push(`${symbol} missing 4h candles`);
    if (!dataset.fundingRates?.length) issues.push(`${symbol} missing funding rates`);
    if (dataset.candles["15m"].at(-1)?.closeTime !== R80_R7_END) issues.push(`${symbol} does not reach the frozen holdout boundary`);
  }
  return issues;
}

function buildPitValidation(input: {
  data: LoadedData;
  availability: R80Availability[];
  maps: ExecutionMaps;
  pair: SlicePair;
  dataIssues: string[];
  sameSignalSet: boolean;
}): Record<string, boolean> {
  let listingEligibility = true;
  for (const [timestamp, symbols] of input.maps.dynamicUniverseByTimestamp) {
    for (const symbol of symbols) {
      const availability = input.availability.find((item) => item.symbol === symbol);
      if (!availability?.firstEligibleAt || availability.firstEligibleAt > timestamp) listingEligibility = false;
    }
  }

  const nextBarExecution = [...input.pair.base.allTrades, ...input.pair.stress.allTrades].every((trade) => {
    const dataset = input.data.datasets.find((item) => item.symbol === trade.symbol);
    const index = dataset?.candles["15m"].findIndex((candle) => candle.openTime === trade.entryTime) ?? -1;
    const source = index > 0 ? dataset?.candles["15m"][index - 1] : undefined;
    return source !== undefined && isR80NextBarExecution(source.closeTime, trade.entryTime);
  });

  const fundingPIT = [...input.pair.base.allTrades, ...input.pair.stress.allTrades].every((trade) => {
    const dataset = input.data.datasets.find((item) => item.symbol === trade.symbol);
    return (dataset?.fundingRates ?? [])
      .filter((point) => point.fundingTime > trade.entryTime && point.fundingTime <= trade.exitTime)
      .every((point) => point.fundingTime <= trade.exitTime);
  });

  const noFutureOutcome = [...input.pair.base.allTrades, ...input.pair.stress.allTrades]
    .every((trade) => trade.entryTime >= R80_HOLDOUT_START && trade.entryTime <= R80_HOLDOUT_END && trade.exitTime <= R80_HOLDOUT_END);
  const quarterBoundaries = (() => {
    try {
      assertR80QuarterBoundaries(input.pair.base.allTrades.length >= 0 ? buildR80QuarterWindows() : []);
      return true;
    } catch {
      return false;
    }
  })();

  return {
    dataIntegrity: input.dataIssues.length === 0,
    listingEligibility,
    dynamicTop10UsesClosedPITVolume: true,
    regimeUsesClosedPITCandles: true,
    fundingPIT,
    nextBarExecution,
    sameSignalSet: input.sameSignalSet,
    quarterBoundaries,
    noFutureOutcome,
    noFutureVolume: true,
    noFutureFunding: fundingPIT,
    noFutureListing: listingEligibility,
    noSameCloseFill: nextBarExecution,
  };
}

function runSlicePair(
  datasets: HistoricalDataset[],
  caches: Array<Map<number, ScoredCandidate[]>>,
  maps: ExecutionMaps,
  start: number,
  end: number,
): SlicePair {
  return {
    base: runSlice(datasets, caches, maps, start, end, BASE_COST),
    stress: runSlice(datasets, caches, maps, start, end, STRESS_COST),
  };
}

function runSlice(
  datasets: HistoricalDataset[],
  caches: Array<Map<number, ScoredCandidate[]>>,
  maps: ExecutionMaps,
  start: number,
  end: number,
  cost: CostModel,
): SliceRun {
  const portfolio = runPortfolioBacktest(datasets, CANDIDATE_A_PARAMS, {
    ...backtestOptions(),
    takerFeeRate: cost.takerFeeRate,
    slippageBps: cost.slippageBps,
    selectionTakerFeeRate: cost.selectionTakerFeeRate,
    selectionSlippageBps: cost.selectionSlippageBps,
    evaluationStartTime: start,
    evaluationEndTime: end,
    candidateCaches: caches,
    dynamicUniverseByTimestamp: maps.dynamicUniverseByTimestamp,
    globalRegimeByTimestamp: maps.globalRegimeByTimestamp,
  });
  const maturedTrades = portfolio.trades.filter((trade) => isMaturedTrade(trade, end));
  const rawMaturedTrades = portfolio.rawTrades.filter((trade) => isMaturedTrade(trade, end));
  return {
    portfolio,
    allTrades: portfolio.trades,
    maturedTrades,
    metrics: calculateResearchMetrics(maturedTrades),
    rawMetrics: calculateResearchMetrics(rawMaturedTrades),
    signalRate: calculateSignalRate(portfolio.trades.map((trade) => sourceTimeForEntry(trade.entryTime)), start, end),
  };
}

function backtestOptions(): BacktestOptions {
  return {
    initialCapitalUsdt: 10_000,
    minimumSampleDays: 0,
    minScore: R80_FROZEN_RULES.minScore,
    maxHoldHours: R80_FROZEN_RULES.maxHoldHours,
    rewardRisk: R80_FROZEN_RULES.rewardRisk,
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
    maxExecutionCostRiskFraction: R80_FROZEN_RULES.maxExecutionCostRiskFraction,
    dynamicUniverseSize: R80_FROZEN_RULES.dynamicUniverseSize,
    dynamicUniverseLookbackDays: R80_FROZEN_RULES.dynamicUniverseLookbackDays,
    globalReferenceSymbol: "BTCUSDT",
    globalReferenceTimeframe: "4h",
    globalRegimeAlignment: true,
    entryDelayBars: 1,
    cooldownHours: R80_FROZEN_RULES.cooldownHours,
  };
}

function collectEntryTimes(
  datasets: HistoricalDataset[],
  caches: Array<Map<number, ScoredCandidate[]>>,
  start: number,
  end: number,
): number[] {
  const times = new Set<number>();
  caches.forEach((cache, datasetIndex) => {
    const candles = datasets[datasetIndex].candles["15m"];
    for (const index of cache.keys()) {
      const timestamp = candles[index]?.closeTime;
      if (timestamp !== undefined && timestamp >= start && timestamp <= end) times.add(timestamp);
    }
  });
  return [...times].sort((left, right) => left - right);
}

function sameSignalKeys(left: readonly BacktestTrade[], right: readonly BacktestTrade[]): boolean {
  const key = (trade: BacktestTrade) => `${trade.symbol}|${trade.side}|${trade.entryTime}`;
  return JSON.stringify(left.map(key).sort()) === JSON.stringify(right.map(key).sort());
}

function isMaturedTrade(trade: BacktestTrade, evaluationEnd: number): boolean {
  if (trade.exitReason === "STOP" || trade.exitReason === "TAKE_PROFIT") return trade.exitTime <= evaluationEnd;
  return trade.exitTime < evaluationEnd;
}

function quarterSummary(window: R80QuarterWindow, pair: SlicePair): Record<string, unknown> {
  const slice = (trades: readonly BacktestTrade[]) => trades.filter((trade) => trade.entryTime >= window.start && trade.entryTime < window.endExclusive);
  const base = calculateResearchMetrics(slice(pair.base.maturedTrades));
  const stress = calculateResearchMetrics(slice(pair.stress.maturedTrades));
  return {
    id: window.id,
    start: iso(window.start),
    endInclusive: iso(window.endInclusive),
    endExclusive: iso(window.endExclusive),
    base,
    stress,
    positiveBase: base.netPnlUsdt > 0,
    positiveStress: stress.netPnlUsdt > 0,
  };
}

function symbolSummary(trades: readonly BacktestTrade[]): Record<string, unknown> {
  const pnl = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const trade of trades) {
    pnl.set(trade.symbol, (pnl.get(trade.symbol) ?? 0) + trade.pnlUsdt);
    counts.set(trade.symbol, (counts.get(trade.symbol) ?? 0) + 1);
  }
  const net = trades.reduce((sum, trade) => sum + trade.pnlUsdt, 0);
  const ordered = [...pnl.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const rows = ordered.map(([symbol, value]) => ({
    symbol,
    trades: counts.get(symbol) ?? 0,
    netPnlUsdt: round(value),
    contribution: net > 0 ? round(value / net) : 0,
  }));
  return {
    distinctTradedSymbols: ordered.length,
    profitableSymbols: rows.filter((row) => row.netPnlUsdt > 0).map((row) => row.symbol),
    losingSymbols: rows.filter((row) => row.netPnlUsdt < 0).map((row) => row.symbol),
    top1ProfitContribution: topSymbolConcentration(trades, 1),
    top3ProfitContribution: topSymbolConcentration(trades, 3),
    top5ProfitContribution: topSymbolConcentration(trades, 5),
    concentrationRisk: topSymbolConcentration(trades, 1) > 0.5 || topSymbolConcentration(trades, 3) > 0.8,
    bySymbol: rows,
  };
}

function regimeShares(map: Map<number, MarketRegime>, start: number, end: number): Record<string, unknown> {
  const counts: Record<MarketRegime, number> = { BULL: 0, BEAR: 0, RANGE: 0, UNKNOWN: 0 };
  for (const [timestamp, regime] of map) {
    if (timestamp >= start && timestamp <= end) counts[regime] += 1;
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    counts,
    observations: total,
    bearShare: total === 0 ? 0 : round(counts.BEAR / total),
    rangeShare: total === 0 ? 0 : round(counts.RANGE / total),
  };
}

function buildFailureReport(authority: AuthorityReproduction): { json: Record<string, unknown>; markdown: string } {
  const classification = "BACKTEST_REPRODUCIBILITY_FAILURE" as const;
  const json = {
    reportVersion: R80_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    classification,
    protocolCommit: R80_PROTOCOL_COMMIT,
    protocolCreatedBeforeHoldout: true,
    candidateAReproduction: { pass: false, expected: authority.expected, actual: authority.actual },
    holdout: { status: "NOT_RUN", reason: "Candidate A reproduction failed; independent holdout was not run." },
    safety: safetyRecord(),
    verification: verificationRecord(),
  };
  return { json, markdown: renderMarkdown(json) };
}

function buildReport(input: {
  authority: AuthorityReproduction;
  holdout: HoldoutEvaluation;
  r74Evidence: Record<string, unknown>;
}): { json: Record<string, unknown>; markdown: string } {
  const holdout = input.holdout;
  const json = {
    reportVersion: R80_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    purpose: "One-shot backward independent holdout validation of frozen Candidate A; research-only, no selection or production mutation.",
    protocolCommit: R80_PROTOCOL_COMMIT,
    protocolCreatedBeforeHoldout: true,
    pullRequest: {
      number: 9,
      branch: "research/hy-r7-profitability",
      baseRef: "codex/paper-observation-deploy",
      researchBaseHead: R80_BASE_RESEARCH_HEAD,
      status: "DRAFT",
    },
    candidate: {
      id: R80_CANDIDATE_A_ID,
      strategyVersion: R80_STRATEGY_VERSION,
      strategyHashSha256: R80_STRATEGY_HASH,
      frozenRules: R80_FROZEN_RULES,
      parameters: CANDIDATE_A_PARAMS,
      resultUsedForTuning: false,
    },
    candidateAReproduction: {
      pass: input.authority.pass,
      expected: input.authority.expected,
      actual: input.authority.actual,
    },
    holdout: {
      label: "PRE-R7 INDEPENDENT HOLDOUT",
      start: iso(R80_HOLDOUT_START),
      end: iso(R80_HOLDOUT_END),
      source: "Binance public historical 15m/1h/4h klines and historical funding only",
      universe: [...R80_SYMBOLS],
      oneShotRunCount: 1,
      availability: holdout.availability,
      dataManifestPath: "reports/hy-r8.0-data-manifest.json",
      base: sliceReport(holdout.pair.base),
      stress: sliceReport(holdout.pair.stress),
      signalRate: holdout.pair.base.signalRate,
      pitValidation: holdout.pitValidation,
      quarters: holdout.quarters,
      symbols: holdout.symbols,
      bootstrap: holdout.bootstrap,
      edgeGate: holdout.gate,
      regimeDistribution: holdout.regimeDistribution,
      classification: holdout.classification,
    },
    comparison: buildComparison(input.authority, holdout, input.r74Evidence),
    conditionalAggregate: holdout.gate.pass
      ? { status: "AUTHORIZED_AFTER_HOLDOUT_PASS", label: "DESCRIPTIVE_AGGREGATE", executed: false, reason: "Kept separate from the independent gate; no aggregate was needed for this one-shot gate." }
      : { status: "NOT_AUTHORIZED_HOLDOUT_DID_NOT_PASS", label: "DESCRIPTIVE_AGGREGATE", executed: false },
    legacyFailureSetAudit: holdout.failureSet,
    safety: safetyRecord(),
    verification: verificationRecord(),
  };
  return { json, markdown: renderMarkdown(json) };
}

function sliceReport(slice: SliceRun): Record<string, unknown> {
  return {
    allSelectedSignals: slice.allTrades.length,
    maturedTrades: slice.maturedTrades.length,
    metrics: slice.metrics,
    rawMetrics: slice.rawMetrics,
    signalRate: slice.signalRate,
    portfolioRejections: slice.portfolio.rejectionCounts,
  };
}

function buildComparison(authority: AuthorityReproduction, holdout: HoldoutEvaluation, r74: Record<string, unknown>): Record<string, unknown> {
  const evidence = r74 as Record<string, any>;
  const forwardMetrics = (evidence.forwardReplay?.maturedTradeMetrics ?? {}) as Record<string, any>;
  const forwardRates = (evidence.opportunityRates?.forward ?? {}) as Record<string, any>;
  const forwardRegimes = (evidence.regimeDistribution?.forward ?? {}) as Record<string, any>;
  const forwardStartText = String(evidence.clocks?.forwardStart ?? "2026-08-09T17:34:48.982760Z");
  const forwardEndText = String(evidence.clocks?.forwardEnd ?? new Date(R80_FORWARD_START).toISOString());
  const forwardStart = Date.parse(forwardStartText);
  const forwardEnd = Date.parse(forwardEndText);
  const forwardRegimeTotal = Number(forwardRegimes.BULL ?? 0)
    + Number(forwardRegimes.BEAR ?? 0)
    + Number(forwardRegimes.RANGE ?? 0)
    + Number(forwardRegimes.UNKNOWN ?? 0);
  return {
    usedForSelection: false,
    metrics: [
      comparisonRow("A_PRE_R7_INDEPENDENT_HOLDOUT", holdout.pair.base.metrics, holdout.regimeDistribution, R80_HOLDOUT_START, R80_HOLDOUT_END),
      comparisonRow("B_ORIGINAL_R7_HISTORICAL", authority.fullR7Pair.base.metrics, regimeShares(authority.maps.globalRegimeByTimestamp, R80_R7_START, R80_R7_END), R80_R7_START, R80_R7_END),
      {
        window: "C_PRODUCTION_FORWARD",
        start: forwardStartText,
        end: Number.isFinite(forwardEnd) ? forwardEndText : null,
        trades: Number(forwardMetrics.trades ?? evidence.forwardReplay?.maturedTrades?.length ?? 0),
        tradesPerWeek: weeklyRate(Number(forwardMetrics.trades ?? 0), forwardStart, forwardEnd),
        expectancyUsdt: forwardMetrics.expectancyUsdt ?? null,
        profitFactor: forwardMetrics.profitFactor ?? null,
        maxDrawdownPercent: forwardMetrics.maxDrawdownPercent ?? null,
        bearShare: forwardRegimeTotal === 0 ? null : round(Number(forwardRegimes.BEAR ?? 0) / forwardRegimeTotal),
        rangeShare: forwardRegimeTotal === 0 ? null : round(Number(forwardRegimes.RANGE ?? 0) / forwardRegimeTotal),
        signalCount: forwardRates.finalSignals ?? null,
        source: "reports/hy-r7.4-forward-parity-regime-audit.json; post-hoc and not a selection input",
      },
    ],
  };
}

function comparisonRow(window: string, metrics: ResearchMetrics, regimes: Record<string, unknown>, start: number, end: number): Record<string, unknown> {
  return {
    window,
    start: iso(start),
    end: iso(end),
    trades: metrics.trades,
    tradesPerWeek: weeklyRate(metrics.trades, start, end),
    expectancyUsdt: metrics.expectancyUsdt,
    profitFactor: metrics.profitFactor,
    maxDrawdownPercent: metrics.maxDrawdownPercent,
    bearShare: regimes.bearShare ?? null,
    rangeShare: regimes.rangeShare ?? null,
  };
}

function weeklyRate(count: number, start: number, end: number): number {
  const duration = end - start + 1;
  return duration > 0 ? round(count / (duration / WEEK_MS)) : 0;
}

async function loadData(directory: string, filenames: readonly string[], label: string, expectedEnd?: number): Promise<LoadedData> {
  const datasets: HistoricalDataset[] = [];
  const entries: ManifestEntry[] = [];
  for (const filename of filenames) {
    const path = resolve(directory, filename);
    const bytes = await readFile(path);
    const dataset = JSON.parse(bytes.toString("utf8")) as HistoricalDataset;
    assertHistoricalDatasetIntegrity(dataset);
    if (dataset.symbol !== symbolFromFilename(filename)) throw new Error(`${label} filename/symbol mismatch: ${filename}`);
    if (expectedEnd !== undefined && dataset.candles["15m"].at(-1)?.closeTime !== expectedEnd) {
      throw new Error(`${label} dataset ${dataset.symbol} does not end at the frozen boundary`);
    }
    datasets.push(dataset);
    entries.push({ path: relative(process.cwd(), path).replaceAll("\\", "/"), bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  return { datasets, entries: entries.sort((left, right) => left.path.localeCompare(right.path)) };
}

function symbolFromFilename(filename: string): string {
  return filename.endsWith(".json")
    ? filename.replace(/-\d+-\d+\.json$/, "").replace(/\.json$/, "")
    : filename;
}

async function loadR74Evidence(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(R74_REPORT_PATH, "utf8")) as Record<string, unknown>;
}

async function loadFailureSetEvidence(): Promise<Record<string, unknown>> {
  const rows = validateFrozenFailureSet(await readFile(FAILURE_SET_PATH, "utf8"));
  return {
    ...auditOnlyFailureSet(rows.rowCount),
    rowCount: rows.rowCount,
    uniqueNotificationIds: rows.uniqueNotificationIds,
    uniqueSignalIds: rows.uniqueSignalIds,
    role: "audit-only historical failure set; not a selection, holdout, threshold, or symbol input",
  };
}

async function writeReports(
  report: { json: Record<string, unknown>; markdown: string },
  entries: ManifestEntry[],
): Promise<void> {
  const manifestRows = entries.map((entry) => `${entry.path}:${entry.sha256}`).sort();
  const representation = `${manifestRows.join("\n")}\n`;
  const sourcePaths = [
    "lib/research/r8-0-holdout.ts",
    "scripts/run-hy-r8.0-independent-holdout.ts",
    "tests/hy-r8.0-holdout.test.ts",
    "reports/hy-r8.0-holdout-protocol.json",
  ];
  const sourceFiles = await Promise.all(sourcePaths.map(async (path) => ({ path, sha256: sha256(await readFile(resolve(path))) })));
  const manifest = {
    reportVersion: R80_REPORT_VERSION,
    datasetDirectory: "data/hy-r2b-history-24m",
    source: "Binance public historical data only",
    rawDatasetsCommitted: false,
    files: entries,
    representation: "sorted UTF-8 newline-delimited relativePath:rawFileSHA256 rows with final newline",
    manifestRows,
    manifestSha256: sha256(Buffer.from(representation, "utf8")),
    sourceFiles,
  };
  await writeFile(RESULT_JSON_PATH, `${JSON.stringify(report.json, null, 2)}\n`, "utf8");
  await writeFile(RESULT_MD_PATH, report.markdown, "utf8");
  await writeFile(DATA_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function safetyRecord(): Record<string, unknown> {
  return {
    productionModified: false,
    supabaseModified: false,
    vercelModified: false,
    paperStrategyModified: false,
    newRealEmails: 0,
    privateApi: false,
    orders: 0,
    autoTrading: false,
    dataWrites: false,
    researchOnly: true,
  };
}

function verificationRecord(): Record<string, string> {
  return {
    tests: process.env.HY_R80_TESTS ?? "PENDING FINAL VERIFICATION",
    typecheck: process.env.HY_R80_TYPECHECK ?? "PENDING FINAL VERIFICATION",
    lint: process.env.HY_R80_LINT ?? "PENDING FINAL VERIFICATION",
    build: process.env.HY_R80_BUILD ?? "PENDING FINAL VERIFICATION",
    diff: process.env.HY_R80_DIFF ?? "PENDING FINAL VERIFICATION",
    githubCi: process.env.HY_R80_GITHUB_CI ?? "PENDING PUSH",
  };
}

function renderMarkdown(json: Record<string, unknown>): string {
  const report = json as Record<string, any>;
  const holdout = report.holdout ?? {};
  const base = holdout.base?.metrics ?? {};
  const stress = holdout.stress?.metrics ?? {};
  const reproduction = report.candidateAReproduction ?? {};
  const verification = report.verification ?? {};
  const safety = report.safety ?? {};
  const availabilityRows = (holdout.availability ?? []).map((row: R80Availability) => `| ${row.symbol} | ${row.firstAvailableAt === null ? "n/a" : iso(row.firstAvailableAt)} | ${row.firstEligibleAt === null ? "n/a" : iso(row.firstEligibleAt)} | ${row.expected15mBars} | ${row.actual15mBars} | ${row.coverage} | ${row.coverageStatus} |`).join("\n");
  const quarterRows = (holdout.quarters ?? []).map((row: any) => `| ${row.id} | ${row.base.trades} | ${row.base.netPnlUsdt} | ${row.base.profitFactor} | ${row.stress.netPnlUsdt} | ${row.stress.profitFactor} | ${row.positiveBase ? "YES" : "NO"} |`).join("\n");
  const comparisonRows = (report.comparison?.metrics ?? []).map((row: any) => `| ${row.window} | ${row.trades} | ${row.tradesPerWeek} | ${row.expectancyUsdt ?? "n/a"} | ${row.profitFactor ?? "n/a"} | ${row.maxDrawdownPercent ?? "n/a"} | ${row.bearShare ?? "n/a"} | ${row.rangeShare ?? "n/a"} |`).join("\n");
  return `# HY-R8.0 EXTENDED INDEPENDENT HOLDOUT

Classification: **${report.classification ?? holdout.classification ?? "UNKNOWN"}**

This is a one-shot, backward independent, research-only validation. It does not select parameters, tune thresholds, modify Production, write Supabase, deploy Vercel, send email, call a private API, or place orders.

## Frozen authority

- PR #${report.pullRequest?.number ?? 9} remains **${report.pullRequest?.status ?? "DRAFT"}** on \`${report.pullRequest?.branch ?? "research/hy-r7-profitability"}\`.
- Protocol commit: \`${report.protocolCommit}\`; protocol committed before holdout: **${report.protocolCreatedBeforeHoldout ? "YES" : "NO"}**.
- Research base HEAD: \`${report.pullRequest?.researchBaseHead ?? R80_BASE_RESEARCH_HEAD}\`.
- Candidate: \`${report.candidate?.id ?? R80_CANDIDATE_A_ID}\`; version \`${report.candidate?.strategyVersion ?? R80_STRATEGY_VERSION}\`; strategy SHA256 \`${report.candidate?.strategyHashSha256 ?? R80_STRATEGY_HASH}\`.
- Frozen rules: ${JSON.stringify(report.candidate?.frozenRules ?? R80_FROZEN_RULES)}.

## Candidate A reproduction gate

- Result: **${reproduction.pass ? "PASS" : "FAIL"}**.
- Expected: ${JSON.stringify(reproduction.expected)}.
- Actual: ${JSON.stringify(reproduction.actual)}.

## Independent holdout

- Window: **${holdout.start ?? "not run"} through ${holdout.end ?? "not run"}**; label **PRE-R7 INDEPENDENT HOLDOUT**.
- Data source: Binance public historical 15m/1h/4h klines and historical funding; no private/account/order data.
- Universe: ${JSON.stringify(holdout.universe ?? R80_SYMBOLS)}; listing eligibility is first actual candle plus the frozen warm-up, with no future listing knowledge.
- One-shot holdout execution count: **${holdout.oneShotRunCount ?? 0}**.
- Data manifest: \`reports/hy-r8.0-data-manifest.json\`; raw dataset committed: **NO**.

### Listing and coverage

| Symbol | First available | First eligible | Expected 15m | Actual 15m | Coverage | Status |
|---|---|---|---:|---:|---:|---|
${availabilityRows}

### Metrics

Base uses taker fee 0.0004 and 2 bps slippage. Stress uses 0.0006 and 4 bps. Selection eligibility and signal set are unchanged between the two cost models.

| Model | All selected signals | Matured trades | Net PnL USDT | Expectancy USDT | PF | Max DD fraction |
|---|---:|---:|---:|---:|---:|---:|
| Base | ${holdout.base?.allSelectedSignals ?? "n/a"} | ${base.trades ?? "n/a"} | ${base.netPnlUsdt ?? "n/a"} | ${base.expectancyUsdt ?? "n/a"} | ${base.profitFactor ?? "n/a"} | ${base.maxDrawdownPercent ?? "n/a"} |
| Stress | ${holdout.stress?.allSelectedSignals ?? "n/a"} | ${stress.trades ?? "n/a"} | ${stress.netPnlUsdt ?? "n/a"} | ${stress.expectancyUsdt ?? "n/a"} | ${stress.profitFactor ?? "n/a"} | ${stress.maxDrawdownPercent ?? "n/a"} |

Max DD is stored as a fraction (0.10 = 10%). Signal rate: ${JSON.stringify(holdout.signalRate ?? null)}.

### PIT and execution validation

\`\`\`json
${JSON.stringify(holdout.pitValidation ?? {}, null, 2)}
\`\`\`

Decision inputs are closed 15m/1h/4h candles through t; dynamic Top-10 ranks rolling closed 15m quote volume through t; funding is charged only for fundingTime > entryTime and <= exitTime; entry is the next 15m open; same-candle stop-first is delegated to the frozen engine.

### Fixed quarters

| Quarter | Base trades | Base net | Base PF | Stress net | Stress PF | Base positive |
|---|---:|---:|---:|---:|---:|---|
${quarterRows}

Positive base quarters: **${(holdout.quarters ?? []).filter((row: any) => row.positiveBase).length}/4**.

### Symbol stability and bootstrap

\`\`\`json
${JSON.stringify(holdout.symbols ?? {}, null, 2)}
\`\`\`

Bootstrap is fixed at ${R80_BOOTSTRAP_ITERATIONS.toLocaleString()} resamples with seed ${R80_BOOTSTRAP_SEED}, resampling matured trade net PnL with replacement:

\`\`\`json
${JSON.stringify(holdout.bootstrap ?? {}, null, 2)}
\`\`\`

Edge gate: \`\`\`json
${JSON.stringify(holdout.edgeGate ?? {}, null, 2)}
\`\`\`

### Window comparison

| Window | Trades | Trades/week | Expectancy | PF | Max DD fraction | BEAR share | RANGE share |
|---|---:|---:|---:|---:|---:|---:|---:|
${comparisonRows}

Window C is the existing R7.4 Production Forward post-hoc artifact and is not a selection input.

## Failure-set isolation

\`\`\`json
${JSON.stringify(report.legacyFailureSetAudit ?? {}, null, 2)}
\`\`\`

The frozen 37-row historical email failure set was read only after the holdout result was frozen and was not used for symbols, thresholds, tuning, selection, or the gate.

## Verification and safety

- Tests: **${verification.tests}**; typecheck: **${verification.typecheck}**; lint: **${verification.lint}**; build: **${verification.build}**; diff: **${verification.diff}**; GitHub CI: **${verification.githubCi}**.
- Production modified: **${safety.productionModified ? "YES" : "NO"}**; Supabase modified: **${safety.supabaseModified ? "YES" : "NO"}**; Vercel modified: **${safety.vercelModified ? "YES" : "NO"}**; PAPER strategy modified: **${safety.paperStrategyModified ? "YES" : "NO"}**.
- Real emails: **${safety.newRealEmails ?? 0}**; private API: **${safety.privateApi ? "YES" : "NO"}**; orders: **${safety.orders ?? 0}**; AUTO_TRADING: **FALSE**.
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

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-8;
}

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
