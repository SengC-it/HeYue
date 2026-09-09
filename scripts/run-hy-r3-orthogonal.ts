import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { atr, closes, ema } from "@/lib/core/indicators";
import { classifyRegime } from "@/lib/core/market-regime";
import { scoreCandidate } from "@/lib/core/scoring";
import { DEFAULT_STRATEGY_PARAMS, type StrategyParams } from "@/lib/core/strategies";
import type { Candle, MarketRegime, ScoredCandidate, Side } from "@/lib/core/types";
import {
  buildGlobalRegimeByTimestamp,
  runPortfolioBacktest,
  type BacktestOptions,
} from "@/lib/backtest/engine";
import { assertHistoricalDatasetIntegrity } from "@/lib/backtest/data-integrity";
import type { BacktestTrade, HistoricalDataset } from "@/lib/backtest/types";
import { quoteVolumeForCandle, volumeSourceForDatasets } from "@/lib/backtest/volume";

const SOURCE_SHA = "06d9d66b4a0574afeaa798f962a2aa26347de1b8";
const HISTORY_START = 1_723_169_699_999;
const HISTORY_END = 1_786_241_699_999;
const EMBARGO_HOURS = 48;
const DYNAMIC_UNIVERSE_SIZE = 10;
const DYNAMIC_UNIVERSE_LOOKBACK_DAYS = 1;
const INITIAL_CAPITAL_USDT = 10_000;
const RISK_PER_TRADE_USDT = 50;
const SINGLE_SIGNAL_CAP_USDT = 50;
const DAILY_RISK_BUDGET_USDT = 600;
const MAX_POSITION_NOTIONAL_USDT = 10_000;
const MAX_HOLD_HOURS = 48;
const REWARD_RISK = 2;
const TAKER_FEE_RATE = 0.0004;
const BASELINE_SLIPPAGE_BPS = 2;
const STOP_ATR_MULTIPLIER = 0.75;
const FIXED_BREAKOUT_VOLUME_RATIO = 1.15;
const REPORT_JSON = resolve("reports", "hy-r3-orthogonal-edge-discovery.json");
const REPORT_MD = resolve("reports", "hy-r3-orthogonal-edge-discovery.md");
const DATA_DIRECTORY = resolve("data", "hy-r2b-history-24m");
const MINIMUM_DATASETS = 40;
const SLIPPAGE_BPS = [2, 5, 10] as const;

type FamilyId = "A_MOMENTUM_BREAKOUT" | "B_COMPRESSION_BREAKOUT" | "C_RELATIVE_STRENGTH";
type StageId = "discovery" | "validation" | "lockedConfirmation";

interface ResearchConfig {
  id: string;
  family: FamilyId;
  side: Side;
  params: Record<string, number>;
}

interface Stage {
  id: StageId;
  start: number;
  end: number;
  note: string;
}

interface TimeframeFeatures {
  candles: Candle[];
  ema20: Array<number | null>;
}

interface DatasetContext {
  dataset: HistoricalDataset;
  primary: Candle[];
  oneHour: TimeframeFeatures;
  fourHour: TimeframeFeatures;
  closeIndexByTime: Map<number, number>;
  openIndexByTime: Map<number, number>;
  atr14: Array<number | null>;
  trendByLookback: Map<number, { fast: Array<number | null>; slow: Array<number | null> }>;
  previousHighByPeriod: Map<number, Array<number | null>>;
  previousLowByPeriod: Map<number, Array<number | null>>;
  previousQuoteAverageByPeriod: Map<number, Array<number | null>>;
  previousTrueRangeAverageByPeriod: Map<number, Array<number | null>>;
  bandwidthByPeriod: Map<number, Array<number | null>>;
  quoteVolumePrefix: number[];
  logReturnPrefix: number[];
  logReturnSquarePrefix: number[];
  localRegimeByCloseTime: Map<number, MarketRegime>;
}

interface Bundle {
  datasets: HistoricalDataset[];
  contexts: DatasetContext[];
  contextBySymbol: Map<string, DatasetContext>;
  symbols: string[];
  entryTimes: number[];
  dynamicUniverse: Map<number, Set<string>>;
  globalRegime: Map<number, MarketRegime>;
  availableByMonth: Array<{ month: string; symbolsAvailable: number; symbols: string[] }>;
  volumeSource: string;
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
  rawTradeCount: number;
  trades: BacktestTrade[];
  selectionMetrics: SummaryMetrics;
}

interface BreakdownReport {
  byMonth: Record<string, SummaryMetrics>;
  bySymbol: Record<string, SummaryMetrics>;
  bySide: Record<string, SummaryMetrics>;
  byBtcRegime: Record<string, SummaryMetrics>;
}

interface StageReport {
  start: string;
  end: string;
  metrics: SummaryMetrics;
  rawTradeCount: number;
  breakdowns: BreakdownReport;
}

interface ExperimentBase {
  config: ResearchConfig;
  discovery: RunArtifact;
  validation: RunArtifact;
}

interface ExperimentSummary {
  config: ResearchConfig;
  discovery: SummaryMetrics;
  validation: SummaryMetrics;
  validationGate: boolean;
  neighborCount: number;
  positiveNeighborCount: number;
  positiveNeighborRatePct: number;
  neighborMeanValidationExpectancyR: number;
  stablePlateau: boolean;
  selectionScore: number;
}

interface Contribution {
  key: string;
  metrics: SummaryMetrics;
  shareOfAbsolutePnlPct: number;
}

const BACKTEST_PARAMS: StrategyParams = { ...DEFAULT_STRATEGY_PARAMS, entryMode: "DEFAULT" };

async function main(): Promise<void> {
  const stages = buildStages();
  const bundle = await loadBundle();
  const configs = buildResearchConfigs();
  const experimentBases: ExperimentBase[] = [];

  console.info(JSON.stringify({
    phase: "DISCOVERY_VALIDATION",
    configurationCount: configs.length,
    discovery: formatStage(stages.discovery),
    validation: formatStage(stages.validation),
  }));

  for (const config of configs) {
    const candidateCaches = buildCandidateCaches(bundle, config);
    const discovery = runWithCaches(bundle, config, stages.discovery, BASELINE_SLIPPAGE_BPS, candidateCaches);
    const validation = runWithCaches(bundle, config, stages.validation, BASELINE_SLIPPAGE_BPS, candidateCaches);
    experimentBases.push({ config, discovery, validation });
    console.info(JSON.stringify({
      phase: "CONFIGURATION_COMPLETE",
      id: config.id,
      family: config.family,
      side: config.side,
      discoveryTrades: discovery.selectionMetrics.trades,
      validationTrades: validation.selectionMetrics.trades,
      validationPf: validation.selectionMetrics.profitFactor,
      validationNetPnlUsdt: validation.selectionMetrics.netPnlUsdt,
    }));
  }

  const experimentSummaries = enrichExperiments(experimentBases);
  const selectedSummary = [...experimentSummaries].sort(compareSelectionCandidates)[0];
  if (!selectedSummary) throw new Error("No research configuration was evaluated");
  const selectedBase = experimentBases.find((item) => item.config.id === selectedSummary.config.id);
  if (!selectedBase) throw new Error("Selected configuration has no run artifacts");

  console.info(JSON.stringify({
    phase: "MODEL_FROZEN",
    selected: selectedSummary.config,
    validationGate: selectedSummary.validationGate,
    stablePlateau: selectedSummary.stablePlateau,
  }));

  const familyResults = [];
  for (const family of familyIds()) {
    const familyExperiments = experimentSummaries.filter((item) => item.config.family === family);
    const bestOverall = [...familyExperiments].sort(compareSelectionCandidates)[0];
    if (!bestOverall) throw new Error("No candidate for family " + family);
    const bySide = {} as Record<Side, { candidate: ExperimentSummary; discovery: StageReport; validation: StageReport }>;
    for (const side of ["LONG", "SHORT"] as const) {
      const sideCandidate = [...familyExperiments]
        .filter((item) => item.config.side === side)
        .sort(compareSelectionCandidates)[0];
      if (!sideCandidate) throw new Error("No " + side + " candidate for family " + family);
      const sideBase = experimentBases.find((item) => item.config.id === sideCandidate.config.id);
      if (!sideBase) throw new Error("No run artifacts for " + sideCandidate.config.id);
      bySide[side] = {
        candidate: sideCandidate,
        discovery: buildStageReport(sideBase.discovery, stages.discovery, bundle),
        validation: buildStageReport(sideBase.validation, stages.validation, bundle),
      };
    }
    familyResults.push({
      family,
      label: familyLabel(family),
      configurationCount: familyExperiments.length,
      bestOverall,
      bySide,
    });
  }

  const selectedCaches = buildCandidateCaches(bundle, selectedSummary.config);
  const lockedBySlippage = Object.fromEntries(SLIPPAGE_BPS.map((slippageBps) => {
    const artifact = runWithCaches(bundle, selectedSummary.config, stages.lockedConfirmation, slippageBps, selectedCaches);
    return [String(slippageBps), buildStageReport(artifact, stages.lockedConfirmation, bundle)];
  })) as Record<string, StageReport>;
  const lockedAt5 = lockedBySlippage["5"];
  const lockedAt10 = lockedBySlippage["10"];
  if (!lockedAt5 || !lockedAt10) throw new Error("Locked cost sensitivity runs are incomplete");

  const selectedDiscovery = buildStageReport(selectedBase.discovery, stages.discovery, bundle);
  const selectedValidation = buildStageReport(selectedBase.validation, stages.validation, bundle);
  const largestSymbol = largestContribution(lockedAt5.breakdowns.bySymbol);
  const largestMonth = largestContribution(lockedAt5.breakdowns.byMonth);
  const acceptance = evaluateConfirmation(selectedSummary, lockedAt5, lockedAt10, largestSymbol, largestMonth);
  const classification = classifyResult(selectedSummary, lockedAt5.metrics, acceptance);

  const report = {
    generatedAt: new Date().toISOString(),
    status: "COMPLETED",
    researchOnly: true,
    finalClassification: classification,
    source: {
      productionBaselineSha: SOURCE_SHA,
      historyDirectory: DATA_DIRECTORY,
      historicalDataSource: "Existing HY-R2B Binance public kline/funding cache; no private API.",
      currentProductionBaseline: {
        strategyVersion: "hy-paper-candidate-v2",
        strategyStage: "PAPER",
        side: "SHORT",
        entryMode: "TREND_PULLBACK",
        minScore: 80,
        dynamicUniverse: "Top10",
        oosTrades: 460,
        fiveBpsProfitFactor: 1.0115,
        fiveBpsNetPnlUsdt: 181.5556,
        tenBpsProfitFactor: 0.9324,
      },
    },
    historicalCoverage: {
      evaluationStart: new Date(HISTORY_START).toISOString(),
      evaluationEnd: new Date(HISTORY_END).toISOString(),
      reliableHistoryDays: round((HISTORY_END - HISTORY_START + 1) / 86_400_000, 4),
      datasetCount: bundle.datasets.length,
      symbols: bundle.symbols,
      quoteVolumeSource: bundle.volumeSource,
      dynamicUniverse: {
        size: DYNAMIC_UNIVERSE_SIZE,
        lookbackDays: DYNAMIC_UNIVERSE_LOOKBACK_DAYS,
        ranking: "Trailing quote volume available at each signal timestamp; unavailable/not-yet-listed datasets excluded.",
      },
      symbolsAvailablePerMonth: bundle.availableByMonth,
    },
    preregisteredSplit: {
      rule: "60% Discovery / 20% Validation / 20% Locked Confirmation by elapsed historical time.",
      embargoHoursBetweenStages: EMBARGO_HOURS,
      discovery: formatStage(stages.discovery),
      validation: formatStage(stages.validation),
      lockedConfirmation: formatStage(stages.lockedConfirmation),
      lockedConfirmationWasNotReadBeforeSelection: true,
      lockedConfirmationRunsAfterFreeze: 3,
      noConfirmationDrivenRetuning: true,
    },
    researchSpace: {
      familyCount: 3,
      familyDefinitions: researchSpaceDefinitions(),
      directionTreatment: "LONG and SHORT are evaluated independently for every family; no direction is inferred from Locked Confirmation.",
      scoreEligibility: "NONE — candidate score is descriptive only; score threshold is not a research dimension.",
      totalConfigurations: configs.length,
      totalParameterCombinationsByFamily: {
        A_MOMENTUM_BREAKOUT: 16,
        B_COMPRESSION_BREAKOUT: 16,
        C_RELATIVE_STRENGTH: 12,
      },
      searchSpaceControl: "No brute-force search; each family uses at most three parameter dimensions and at most two pre-registered values per dimension.",
    },
    experimentCount: {
      configurations: configs.length,
      discoveryBacktestRuns: configs.length,
      validationBacktestRuns: configs.length,
      lockedConfirmationModelRuns: 3,
      totalBacktestRuns: configs.length * 2 + 3,
      interpretation: "The three Locked runs are pre-declared 2/5/10 bps repricings of one frozen candidate, not additional model searches.",
    },
    candidateExperiments: experimentSummaries,
    familyResults,
    selectedFrozenCandidate: {
      ...selectedSummary,
      discovery: selectedDiscovery,
      validation: selectedValidation,
      selectionInput: "Discovery and Validation only; Locked Confirmation metrics were unavailable to the selector.",
    },
    lockedConfirmation: {
      selectedConfig: selectedSummary.config,
      bySlippage: lockedBySlippage,
      acceptanceBar: acceptance,
      largestSymbolContribution: largestSymbol,
      largestMonthContribution: largestMonth,
    },
    comparisonBaseline: {
      model: "TREND_PULLBACK SHORT score80 dynamic Top10",
      oosTrades: 460,
      fiveBpsProfitFactor: 1.0115,
      fiveBpsNetPnlUsdt: 181.5556,
      tenBpsProfitFactor: 0.9324,
      significantOutperformanceRule: "Selected Locked 5 bps PF >= baseline PF + 0.15, expectancy >= baseline expectancy + 0.02 R/trade, and net PnL/trade >= baseline net PnL/trade.",
    },
    executionSemantics: {
      signal: "Closed candle N or earlier only.",
      execution: "N+1 OPEN.",
      tradePlan: "The same risk plan supplies entry, stop, take-profit, quantity, notional, risk, fees, slippage, funding and PnL.",
      intrabar: "Stop-first; gap-through stop fills at the worse open.",
      maxHoldHours: MAX_HOLD_HOURS,
      stopAtrMultiplier: STOP_ATR_MULTIPLIER,
      noLookahead: true,
    },
    costs: {
      takerFeeRate: TAKER_FEE_RATE,
      slippageBps: [...SLIPPAGE_BPS],
      funding: "Cached funding rates included when present; no synthetic funding.",
    },
    riskFramework: {
      riskPerTradeUsdt: RISK_PER_TRADE_USDT,
      singleSignalRiskCapUsdt: SINGLE_SIGNAL_CAP_USDT,
      dailyRiskBudgetUsdt: DAILY_RISK_BUDGET_USDT,
      maxPositionNotionalUsdt: MAX_POSITION_NOTIONAL_USDT,
      leverage: 20,
      rewardRisk: REWARD_RISK,
      cooldownHours: 24,
      maxExecutionCostRiskFraction: 0.1,
      extraDailyLossGate: "NONE",
    },
    limitations: [
      "The 49-symbol cohort is the existing locally available/currently active USDT-M perpetual cohort; historical delistings and exchange listing metadata were not available.",
      "Symbols are not backfilled before their first available candle; dynamic Top10 is PIT-safe within the available cohort but survivorship and availability bias remain.",
      "RANGE-specific strategy architecture was not researched in this round.",
      "No live order-book, spread, market-impact or liquidation simulation is included; 2/5/10 bps are deterministic execution-cost sensitivities.",
    ],
    productionAction: "NONE",
    productionModified: false,
    supabaseModified: false,
    vercelModified: false,
    productionEnvModified: false,
    schedulerModified: false,
    strategyModified: false,
    autoTrading: false,
    hyR2Started: false,
    hyR3ProductionStarted: false,
    stopAfterReport: true,
  };

  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(REPORT_JSON, JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(REPORT_MD, buildMarkdown({
    classification,
    historicalCoverage: report.historicalCoverage,
    experimentCount: report.experimentCount,
    preregisteredSplit: report.preregisteredSplit,
    familyResults,
    selectedSummary,
    selectedValidation,
    lockedBySlippage,
    acceptance,
    largestSymbol,
    largestMonth,
  }), "utf8");

  console.info(JSON.stringify({
    ok: true,
    status: report.status,
    classification,
    selected: selectedSummary.config,
    validation: selectedValidation.metrics,
    lockedConfirmation: lockedAt5.metrics,
    fiveBpsProfitFactor: lockedAt5.metrics.profitFactor,
    tenBpsProfitFactor: lockedAt10.metrics.profitFactor,
    reports: [REPORT_JSON, REPORT_MD],
  }, null, 2));
}

function buildStages(): Record<StageId, Stage> {
  const elapsed = HISTORY_END - HISTORY_START;
  const discoveryBoundary = HISTORY_START + Math.round(elapsed * 0.6);
  const validationBoundary = HISTORY_START + Math.round(elapsed * 0.8);
  const embargoMs = EMBARGO_HOURS * 3_600_000;
  return {
    discovery: {
      id: "discovery",
      start: HISTORY_START,
      end: discoveryBoundary - embargoMs,
      note: "Pre-registered first 60%; used to propose candidates and assess early stability.",
    },
    validation: {
      id: "validation",
      start: discoveryBoundary,
      end: validationBoundary - embargoMs,
      note: "Pre-registered next 20%; used for family/direction/finite-parameter selection.",
    },
    lockedConfirmation: {
      id: "lockedConfirmation",
      start: validationBoundary,
      end: HISTORY_END,
      note: "Pre-registered final 20%; read only after the candidate was frozen.",
    },
  };
}

function buildResearchConfigs(): ResearchConfig[] {
  const configs: ResearchConfig[] = [];
  for (const side of ["LONG", "SHORT"] as const) {
    for (const breakoutLookbackBars of [32, 64]) {
      for (const volumeRatioThreshold of [1.2, 1.6]) {
        for (const trendLookbackBars of [48, 96]) {
          configs.push({
            id: "A-" + side + "-L" + breakoutLookbackBars + "-V" + volumeRatioThreshold + "-T" + trendLookbackBars,
            family: "A_MOMENTUM_BREAKOUT",
            side,
            params: { breakoutLookbackBars, volumeRatioThreshold, trendLookbackBars },
          });
        }
      }
    }
  }
  for (const side of ["LONG", "SHORT"] as const) {
    for (const compressionLookbackBars of [32, 64]) {
      for (const bandwidthMaxPct of [0.025, 0.04]) {
        for (const expansionRangeRatio of [1.2, 1.5]) {
          configs.push({
            id: "B-" + side + "-C" + compressionLookbackBars + "-W" + bandwidthMaxPct + "-X" + expansionRangeRatio,
            family: "B_COMPRESSION_BREAKOUT",
            side,
            params: { compressionLookbackBars, bandwidthMaxPct, expansionRangeRatio },
          });
        }
      }
    }
  }
  for (const side of ["LONG", "SHORT"] as const) {
    for (const momentumLookbackBars of [16, 32, 64]) {
      for (const volatilityWindowBars of [32, 64]) {
        configs.push({
          id: "C-" + side + "-R" + momentumLookbackBars + "-V" + volatilityWindowBars,
          family: "C_RELATIVE_STRENGTH",
          side,
          params: { momentumLookbackBars, volatilityWindowBars },
        });
      }
    }
  }
  return configs;
}

function familyIds(): FamilyId[] {
  return ["A_MOMENTUM_BREAKOUT", "B_COMPRESSION_BREAKOUT", "C_RELATIVE_STRENGTH"];
}

function familyLabel(family: FamilyId): string {
  if (family === "A_MOMENTUM_BREAKOUT") return "Family A — Momentum Breakout";
  if (family === "B_COMPRESSION_BREAKOUT") return "Family B — Volatility Compression Breakout";
  return "Family C — Cross-Sectional Relative Strength";
}

function researchSpaceDefinitions(): Record<FamilyId, Record<string, unknown>> {
  return {
    A_MOMENTUM_BREAKOUT: {
      coreParameters: {
        breakoutLookbackBars: [32, 64],
        volumeRatioThreshold: [1.2, 1.6],
        trendLookbackBars: [48, 96],
      },
      fixedSemantics: "Current 15m close breaks the prior high/low, current quote volume exceeds the prior-window average, 15m EMA trend and 1h EMA20 confirm direction, local 4h regime and BTC 4h regime align.",
    },
    B_COMPRESSION_BREAKOUT: {
      coreParameters: {
        compressionLookbackBars: [32, 64],
        bandwidthMaxPct: [0.025, 0.04],
        expansionRangeRatio: [1.2, 1.5],
      },
      fixedSemantics: "Prior candle is Bollinger-bandwidth compressed; current 15m candle expands true range, breaks the prior channel and exceeds fixed 1.15x quote-volume average; trend and regime controls match Family A.",
    },
    C_RELATIVE_STRENGTH: {
      coreParameters: {
        momentumLookbackBars: [16, 32, 64],
        volatilityWindowBars: [32, 64],
        rankCount: [1],
      },
      fixedSemantics: "At each signal close, rank only the PIT-safe dynamic Top10 by volatility-normalized trailing return; strongest is LONG and weakest is SHORT, one selected asset per side/timestamp, without BTC regime gating.",
    },
  };
}

async function loadBundle(): Promise<Bundle> {
  const names = (await readdir(DATA_DIRECTORY)).filter((name) => name.endsWith(".json")).sort();
  if (names.length < MINIMUM_DATASETS) throw new Error("Only " + names.length + " historical datasets are available");
  const datasets: HistoricalDataset[] = [];
  for (const name of names) {
    const dataset = JSON.parse(await readFile(resolve(DATA_DIRECTORY, name), "utf8")) as HistoricalDataset;
    assertHistoricalDatasetIntegrity(dataset);
    const primary = dataset.candles["15m"];
    if (primary.length < 80 || (dataset.candles["1h"]?.length ?? 0) < 80 || (dataset.candles["4h"]?.length ?? 0) < 80) {
      throw new Error("Insufficient indicator history in " + dataset.symbol);
    }
    if ((primary.at(-1)?.closeTime ?? 0) < HISTORY_END) {
      throw new Error("Dataset " + dataset.symbol + " does not reach the requested history end");
    }
    datasets.push(dataset);
  }
  if (!datasets.some((dataset) => dataset.symbol === "BTCUSDT")) throw new Error("BTCUSDT is required");

  const contexts = datasets.map(buildDatasetContext);
  const entryTimes = [...new Set(contexts.flatMap((context) => {
    const start = Math.max(80, 96, 64);
    return context.primary
      .slice(start, -1)
      .map((candle) => candle.closeTime)
      .filter((timestamp) => timestamp >= HISTORY_START && timestamp <= HISTORY_END);
  }))].sort((left, right) => left - right);
  const dynamicUniverse = buildPitSafeDynamicUniverse(contexts, entryTimes);
  const globalRegime = buildGlobalRegimeByTimestamp(datasets, entryTimes, "BTCUSDT", "4h");
  const contextBySymbol = new Map(contexts.map((context) => [context.dataset.symbol, context]));
  return {
    datasets,
    contexts,
    contextBySymbol,
    symbols: contexts.map((context) => context.dataset.symbol).sort(),
    entryTimes,
    dynamicUniverse,
    globalRegime,
    availableByMonth: buildAvailabilityByMonth(datasets),
    volumeSource: volumeSourceForDatasets(datasets.map((dataset) => dataset.candles["15m"])),
  };
}

function buildDatasetContext(dataset: HistoricalDataset): DatasetContext {
  const primary = dataset.candles["15m"];
  const oneHour = buildTimeframeFeatures(dataset.candles["1h"] ?? []);
  const fourHour = buildTimeframeFeatures(dataset.candles["4h"] ?? []);
  const periods = [16, 32, 48, 64, 96];
  const trendLookbacks = [48, 96];
  const closeIndexByTime = new Map(primary.map((candle, index) => [candle.closeTime, index]));
  const openIndexByTime = new Map(primary.map((candle, index) => [candle.openTime, index]));
  const quoteVolumes = primary.map(quoteVolumeForCandle);
  const trueRanges = primary.map((candle, index) => index === 0
    ? candle.high - candle.low
    : Math.max(candle.high - candle.low, Math.abs(candle.high - primary[index - 1].close), Math.abs(candle.low - primary[index - 1].close)));
  const logReturns = primary.map((candle, index) => index === 0 ? 0 : Math.log(candle.close / primary[index - 1].close));
  const localRegimeByCloseTime = new Map<number, MarketRegime>();
  const fourHourCandles = fourHour.candles;
  for (let index = 0; index < fourHourCandles.length; index += 1) {
    localRegimeByCloseTime.set(
      fourHourCandles[index].closeTime,
      classifyRegime(fourHourCandles.slice(Math.max(0, index + 1 - 250), index + 1)),
    );
  }
  return {
    dataset,
    primary,
    oneHour,
    fourHour,
    closeIndexByTime,
    openIndexByTime,
    atr14: atr(primary, 14),
    trendByLookback: new Map(trendLookbacks.map((lookback) => {
      const fastPeriod = Math.max(8, Math.floor(lookback / 4));
      return [lookback, { fast: ema(closes(primary), fastPeriod), slow: ema(closes(primary), lookback) }];
    })),
    previousHighByPeriod: new Map(periods.map((period) => [period, previousExtreme(primary, period, "high")])),
    previousLowByPeriod: new Map(periods.map((period) => [period, previousExtreme(primary, period, "low")])),
    previousQuoteAverageByPeriod: new Map(periods.map((period) => [period, previousAverage(quoteVolumes, period)])),
    previousTrueRangeAverageByPeriod: new Map(periods.map((period) => [period, previousAverage(trueRanges, period)])),
    bandwidthByPeriod: new Map([32, 64].map((period) => [period, bollingerBandwidth(primary, period)])),
    quoteVolumePrefix: prefix(quoteVolumes),
    logReturnPrefix: prefix(logReturns),
    logReturnSquarePrefix: prefix(logReturns.map((value) => value ** 2)),
    localRegimeByCloseTime,
  };
}

function buildTimeframeFeatures(candles: Candle[]): TimeframeFeatures {
  return { candles, ema20: ema(closes(candles), 20) };
}

function buildPitSafeDynamicUniverse(contexts: DatasetContext[], entryTimes: number[]): Map<number, Set<string>> {
  const lookbackMs = DYNAMIC_UNIVERSE_LOOKBACK_DAYS * 86_400_000;
  return new Map(entryTimes.map((timestamp) => {
    const ranked = contexts
      .map((context) => {
        const candles = context.primary;
        const lastIndex = lastIndexAtOrBefore(candles, timestamp);
        const firstOpen = candles[0]?.openTime ?? Number.POSITIVE_INFINITY;
        const lastClose = candles.at(-1)?.closeTime ?? 0;
        if (lastIndex < 0 || firstOpen > timestamp || lastClose < timestamp) return null;
        const firstIndex = lowerBoundCloseTime(candles, timestamp - lookbackMs);
        return {
          symbol: context.dataset.symbol,
          quoteVolume: context.quoteVolumePrefix[lastIndex + 1] - context.quoteVolumePrefix[firstIndex],
        };
      })
      .filter((item): item is { symbol: string; quoteVolume: number } => item !== null)
      .sort((left, right) => right.quoteVolume - left.quoteVolume || left.symbol.localeCompare(right.symbol));
    return [timestamp, new Set(ranked.slice(0, DYNAMIC_UNIVERSE_SIZE).map((item) => item.symbol))];
  }));
}

function buildCandidateCaches(bundle: Bundle, config: ResearchConfig): Array<Map<number, ScoredCandidate[]>> {
  if (config.family === "C_RELATIVE_STRENGTH") return buildRelativeStrengthCaches(bundle, config);
  return bundle.contexts.map((context) => buildDirectionalCache(context, config));
}

function buildDirectionalCache(context: DatasetContext, config: ResearchConfig): Map<number, ScoredCandidate[]> {
  const cache = new Map<number, ScoredCandidate[]>();
  const period = config.family === "A_MOMENTUM_BREAKOUT"
    ? config.params.breakoutLookbackBars
    : config.params.compressionLookbackBars;
  const minimumIndex = Math.max(96, period, config.family === "A_MOMENTUM_BREAKOUT" ? config.params.trendLookbackBars : 48);
  for (let index = minimumIndex; index < context.primary.length - 1; index += 1) {
    const candidate = buildDirectionalCandidate(context, index, config);
    if (candidate) cache.set(index, [candidate]);
  }
  return cache;
}

function buildDirectionalCandidate(context: DatasetContext, index: number, config: ResearchConfig): ScoredCandidate | null {
  const current = context.primary[index];
  const currentAtr = context.atr14[index];
  if (!current || currentAtr === null || currentAtr <= 0) return null;
  const period = config.family === "A_MOMENTUM_BREAKOUT"
    ? config.params.breakoutLookbackBars
    : config.params.compressionLookbackBars;
  const priorHigh = context.previousHighByPeriod.get(period)?.[index] ?? null;
  const priorLow = context.previousLowByPeriod.get(period)?.[index] ?? null;
  const priorQuoteAverage = context.previousQuoteAverageByPeriod.get(period)?.[index] ?? null;
  if (priorHigh === null || priorLow === null || priorQuoteAverage === null || priorQuoteAverage <= 0) return null;
  const quoteVolumeRatio = quoteVolumeForCandle(current) / priorQuoteAverage;
  const trendLookback = config.family === "A_MOMENTUM_BREAKOUT" ? config.params.trendLookbackBars : 48;
  const trendPass = directionTrendPass(context, index, config.side, trendLookback, current.closeTime);
  if (!trendPass) return null;

  let signal = false;
  let momentumScore = 0;
  let rationale: string[] = [];
  if (config.family === "A_MOMENTUM_BREAKOUT") {
    signal = config.side === "LONG"
      ? current.close > priorHigh && quoteVolumeRatio >= config.params.volumeRatioThreshold
      : current.close < priorLow && quoteVolumeRatio >= config.params.volumeRatioThreshold;
    const breakoutDistance = config.side === "LONG" ? current.close - priorHigh : priorLow - current.close;
    momentumScore = clamp01(breakoutDistance / Math.max(currentAtr, 1e-12));
    rationale = [
      "Current 15m close breaks the prior " + period + "-bar " + (config.side === "LONG" ? "high" : "low"),
      "Quote-volume ratio " + quoteVolumeRatio.toFixed(2) + "x meets the pre-registered threshold",
      "15m/" + trendLookback + "-bar EMA trend and 1h EMA20 confirm direction",
    ];
  } else {
    const priorBandwidth = context.bandwidthByPeriod.get(period)?.[index - 1] ?? null;
    const priorTrueRangeAverage = context.previousTrueRangeAverageByPeriod.get(period)?.[index] ?? null;
    if (priorBandwidth === null || priorTrueRangeAverage === null || priorTrueRangeAverage <= 0) return null;
    const currentTrueRange = trueRangeAt(context.primary, index);
    const expansionRatio = currentTrueRange / priorTrueRangeAverage;
    const breakout = config.side === "LONG" ? current.close > priorHigh : current.close < priorLow;
    signal = priorBandwidth <= config.params.bandwidthMaxPct
      && expansionRatio >= config.params.expansionRangeRatio
      && quoteVolumeRatio >= FIXED_BREAKOUT_VOLUME_RATIO
      && breakout;
    momentumScore = clamp01(expansionRatio / 2);
    rationale = [
      "Prior " + period + "-bar Bollinger bandwidth " + priorBandwidth.toFixed(4) + " is compressed",
      "Current true-range expansion " + expansionRatio.toFixed(2) + "x and quote-volume " + quoteVolumeRatio.toFixed(2) + "x",
      "Current 15m close breaks the prior compression channel in the confirmed direction",
    ];
  }
  if (!signal) return null;

  const stopReferencePrice = config.side === "LONG"
    ? Math.min(...context.primary.slice(Math.max(0, index - 5), index + 1).map((candle) => candle.low)) - currentAtr * STOP_ATR_MULTIPLIER
    : Math.max(...context.primary.slice(Math.max(0, index - 5), index + 1).map((candle) => candle.high)) + currentAtr * STOP_ATR_MULTIPLIER;
  const regime = localRegimeAt(context, current.closeTime);
  const breakoutDistance = config.side === "LONG" ? current.close - priorHigh : priorLow - current.close;
  return scoreCandidate({
    strategyFamily: "BREAKOUT",
    side: config.side,
    primaryTimeframe: "15m",
    confirmationTimeframes: ["1h", "4h"],
    entryPrice: current.close,
    stopReferencePrice,
    atr: currentAtr,
    marketRegime: regime,
    regimeDependency: "HIGH",
    scoreComponents: {
      trendAlignment: 1,
      momentum: momentumScore,
      structure: clamp01(1 - Math.abs(breakoutDistance) / (currentAtr * 2)),
      liquidity: liquidityScore(rollingQuoteVolume(context, index, 96)),
      volatility: volatilityScore(currentAtr / current.close),
      regimeFit: regimeFit(config.side, regime),
      dataQuality: clamp01((index + context.oneHour.candles.length + context.fourHour.candles.length) / 700),
    },
    rationale,
  });
}

function buildRelativeStrengthCaches(bundle: Bundle, config: ResearchConfig): Array<Map<number, ScoredCandidate[]>> {
  const caches = bundle.contexts.map(() => new Map<number, ScoredCandidate[]>());
  const lookback = config.params.momentumLookbackBars;
  const volatilityWindow = config.params.volatilityWindowBars;
  const minimumIndex = Math.max(96, lookback, volatilityWindow);
  for (const timestamp of bundle.entryTimes) {
    const universe = bundle.dynamicUniverse.get(timestamp);
    if (!universe || universe.size === 0) continue;
    const ranked: Array<{ contextIndex: number; candleIndex: number; normalizedMomentum: number }> = [];
    bundle.contexts.forEach((context, contextIndex) => {
      if (!universe.has(context.dataset.symbol)) return;
      const candleIndex = context.closeIndexByTime.get(timestamp);
      if (candleIndex === undefined || candleIndex < minimumIndex) return;
      const current = context.primary[candleIndex].close;
      const past = context.primary[candleIndex - lookback]?.close;
      const volatility = rollingLogVolatility(context, candleIndex, volatilityWindow);
      if (past === undefined || past <= 0 || volatility <= 0) return;
      const trailingReturn = current / past - 1;
      const normalizedMomentum = trailingReturn / (volatility * Math.sqrt(lookback));
      if (Number.isFinite(normalizedMomentum)) ranked.push({ contextIndex, candleIndex, normalizedMomentum });
    });
    ranked.sort((left, right) => right.normalizedMomentum - left.normalizedMomentum
      || bundle.contexts[left.contextIndex].dataset.symbol.localeCompare(bundle.contexts[right.contextIndex].dataset.symbol));
    const selected = config.side === "LONG" ? ranked[0] : ranked.at(-1);
    if (!selected) continue;
    const context = bundle.contexts[selected.contextIndex];
    const candidate = buildRelativeStrengthCandidate(context, selected.candleIndex, config.side, selected.normalizedMomentum);
    if (candidate) caches[selected.contextIndex].set(selected.candleIndex, [candidate]);
  }
  return caches;
}

function buildRelativeStrengthCandidate(context: DatasetContext, index: number, side: Side, normalizedMomentum: number): ScoredCandidate | null {
  const current = context.primary[index];
  const currentAtr = context.atr14[index];
  if (!current || currentAtr === null || currentAtr <= 0) return null;
  const stopReferencePrice = side === "LONG"
    ? Math.min(...context.primary.slice(Math.max(0, index - 5), index + 1).map((candle) => candle.low)) - currentAtr * STOP_ATR_MULTIPLIER
    : Math.max(...context.primary.slice(Math.max(0, index - 5), index + 1).map((candle) => candle.high)) + currentAtr * STOP_ATR_MULTIPLIER;
  const regime = localRegimeAt(context, current.closeTime);
  const directionQuality = side === "LONG" ? clamp01(0.5 + normalizedMomentum / 6) : clamp01(0.5 - normalizedMomentum / 6);
  return scoreCandidate({
    strategyFamily: "BREAKOUT",
    side,
    primaryTimeframe: "15m",
    confirmationTimeframes: ["1h", "4h"],
    entryPrice: current.close,
    stopReferencePrice,
    atr: currentAtr,
    marketRegime: regime,
    regimeDependency: "MEDIUM",
    scoreComponents: {
      trendAlignment: clamp01(Math.abs(normalizedMomentum) / 3),
      momentum: directionQuality,
      structure: 0.8,
      liquidity: liquidityScore(rollingQuoteVolume(context, index, 96)),
      volatility: volatilityScore(currentAtr / current.close),
      regimeFit: 0.5,
      dataQuality: clamp01((index + context.oneHour.candles.length + context.fourHour.candles.length) / 700),
    },
    rationale: [
      "Selected as the " + (side === "LONG" ? "strongest" : "weakest") + " asset in the PIT-safe dynamic Top10",
      "Volatility-normalized cross-sectional momentum z-score " + normalizedMomentum.toFixed(3),
      "No future universe membership or future return is used",
    ],
  });
}

function directionTrendPass(context: DatasetContext, index: number, side: Side, lookback: number, sourceTime: number): boolean {
  const trend = context.trendByLookback.get(lookback);
  if (!trend) return false;
  const fast = trend.fast[index];
  const slow = trend.slow[index];
  const oneHourIndex = lastIndexAtOrBefore(context.oneHour.candles, sourceTime);
  const oneHourClose = oneHourIndex < 0 ? undefined : context.oneHour.candles[oneHourIndex]?.close;
  const oneHourEma = oneHourIndex < 0 ? null : context.oneHour.ema20[oneHourIndex];
  if (fast === null || slow === null || oneHourClose === undefined || oneHourEma === null) return false;
  return side === "LONG"
    ? context.primary[index].close > fast && fast > slow && oneHourClose > oneHourEma
    : context.primary[index].close < fast && fast < slow && oneHourClose < oneHourEma;
}

function localRegimeAt(context: DatasetContext, sourceTime: number): MarketRegime {
  const index = lastIndexAtOrBefore(context.fourHour.candles, sourceTime);
  if (index < 0) return "UNKNOWN";
  return context.localRegimeByCloseTime.get(context.fourHour.candles[index].closeTime) ?? "UNKNOWN";
}

function runWithCaches(
  bundle: Bundle,
  config: ResearchConfig,
  stage: Stage,
  slippageBps: number,
  candidateCaches: Array<Map<number, ScoredCandidate[]>>,
): RunArtifact {
  const options: BacktestOptions = {
    initialCapitalUsdt: INITIAL_CAPITAL_USDT,
    minScore: 0,
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
    strategyFamilies: ["BREAKOUT"],
    sideFilter: config.side,
    requireRegimeAlignment: config.family !== "C_RELATIVE_STRENGTH",
    dynamicUniverseByTimestamp: bundle.dynamicUniverse,
    dynamicUniverseLookbackDays: DYNAMIC_UNIVERSE_LOOKBACK_DAYS,
    globalReferenceSymbol: "BTCUSDT",
    globalReferenceTimeframe: "4h",
    globalRegimeAlignment: config.family !== "C_RELATIVE_STRENGTH",
    globalRegimeByTimestamp: bundle.globalRegime,
    candidateCaches,
  };
  const result = runPortfolioBacktest(bundle.datasets, BACKTEST_PARAMS, options);
  return {
    rawTradeCount: result.rawTrades.length,
    trades: result.trades,
    selectionMetrics: summarizeTrades(result.trades, stage.start, stage.end, bundle, false),
  };
}

function enrichExperiments(experimentBases: ExperimentBase[]): ExperimentSummary[] {
  return experimentBases.map((base) => {
    const neighbors = experimentBases.filter((other) => parameterDistance(base.config, other.config) === 1);
    const positiveNeighborCount = neighbors.filter((neighbor) => neighbor.validation.selectionMetrics.netPnlUsdt > 0).length;
    const positiveNeighborRate = neighbors.length === 0 ? 0 : positiveNeighborCount / neighbors.length;
    const neighborMean = average(neighbors.map((neighbor) => neighbor.validation.selectionMetrics.expectancyRPerTrade));
    const validationGate = passesValidationGate(base.validation.selectionMetrics);
    const stablePlateau = validationGate && neighbors.length >= 2 && positiveNeighborRate >= 0.5 && neighborMean > 0;
    const selectionScore = (stablePlateau ? 1_000_000 : 0)
      + (validationGate ? 100_000 : 0)
      + neighborMean * 1_000
      + base.validation.selectionMetrics.expectancyRPerTrade * 500
      + base.discovery.selectionMetrics.expectancyRPerTrade * 100
      + (base.validation.selectionMetrics.profitFactor - 1) * 5;
    return {
      config: base.config,
      discovery: base.discovery.selectionMetrics,
      validation: base.validation.selectionMetrics,
      validationGate,
      neighborCount: neighbors.length,
      positiveNeighborCount,
      positiveNeighborRatePct: round(positiveNeighborRate * 100, 4),
      neighborMeanValidationExpectancyR: round(neighborMean, 6),
      stablePlateau,
      selectionScore: round(selectionScore, 6),
    };
  });
}

function passesValidationGate(metrics: SummaryMetrics): boolean {
  return metrics.trades >= 20
    && metrics.profitFactor >= 1.05
    && metrics.expectancyRPerTrade > 0
    && metrics.netPnlUsdt > 0;
}

function parameterDistance(left: ResearchConfig, right: ResearchConfig): number {
  if (left.family !== right.family || left.side !== right.side) return Number.POSITIVE_INFINITY;
  const keys = Object.keys(left.params);
  if (keys.length !== Object.keys(right.params).length) return Number.POSITIVE_INFINITY;
  return keys.reduce((distance, key) => distance + (left.params[key] === right.params[key] ? 0 : 1), 0);
}

function compareSelectionCandidates(left: ExperimentSummary, right: ExperimentSummary): number {
  return right.selectionScore - left.selectionScore
    || right.validation.profitFactor - left.validation.profitFactor
    || right.validation.trades - left.validation.trades
    || left.config.id.localeCompare(right.config.id);
}

function buildStageReport(artifact: RunArtifact, stage: Stage, bundle: Bundle): StageReport {
  return {
    start: new Date(stage.start).toISOString(),
    end: new Date(stage.end).toISOString(),
    metrics: summarizeTrades(artifact.trades, stage.start, stage.end, bundle, true),
    rawTradeCount: artifact.rawTradeCount,
    breakdowns: buildBreakdowns(artifact.trades, stage, bundle),
  };
}

function buildBreakdowns(trades: BacktestTrade[], stage: Stage, bundle: Bundle): BreakdownReport {
  const groupBy = (key: (trade: BacktestTrade) => string): Record<string, BacktestTrade[]> => {
    const groups: Record<string, BacktestTrade[]> = {};
    for (const trade of trades) {
      const group = key(trade);
      groups[group] ??= [];
      groups[group].push(trade);
    }
    return groups;
  };
  const summarizeGroups = (groups: Record<string, BacktestTrade[]>): Record<string, SummaryMetrics> => Object.fromEntries(
    Object.entries(groups)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, group]) => [key, summarizeTrades(group, stage.start, stage.end, bundle, false)]),
  );
  const byMonth = groupBy((trade) => monthKey(trade.exitTime));
  const bySymbol = groupBy((trade) => trade.symbol);
  const bySide = groupBy((trade) => trade.side);
  const byBtcRegime = groupBy((trade) => regimeForTrade(trade, bundle));
  for (const key of ["BULL", "BEAR", "RANGE", "UNKNOWN"]) byBtcRegime[key] ??= [];
  for (const key of monthKeysBetween(stage.start, stage.end)) byMonth[key] ??= [];
  return {
    byMonth: summarizeGroups(byMonth),
    bySymbol: summarizeGroups(bySymbol),
    bySide: summarizeGroups(bySide),
    byBtcRegime: summarizeGroups(byBtcRegime),
  };
}

function summarizeTrades(
  trades: BacktestTrade[],
  start: number,
  end: number,
  bundle: Bundle,
  includeMtm: boolean,
): SummaryMetrics {
  const ordered = [...trades].sort((left, right) => left.exitTime - right.exitTime || left.entryTime - right.entryTime);
  const wins = trades.filter((trade) => trade.pnlUsdt > 0).length;
  const losses = trades.filter((trade) => trade.pnlUsdt < 0).length;
  const grossProfitUsdt = sum(trades.filter((trade) => trade.pnlUsdt > 0).map((trade) => trade.pnlUsdt));
  const grossLossUsdt = Math.abs(sum(trades.filter((trade) => trade.pnlUsdt < 0).map((trade) => trade.pnlUsdt)));
  const netPnlUsdt = sum(trades.map((trade) => trade.pnlUsdt));
  const netR = sum(trades.map((trade) => trade.rMultiple));
  const lossesBySeverity = [...trades].filter((trade) => trade.pnlUsdt < 0).sort((left, right) => left.pnlUsdt - right.pnlUsdt);
  const cvarTail = lossesBySeverity.slice(0, Math.max(1, Math.ceil(lossesBySeverity.length * 0.05)));
  const monthlyPnl = groupPnl(trades, (trade) => monthKey(trade.exitTime));
  const symbolPnl = groupPnl(trades, (trade) => trade.symbol);
  const absPnl = sum(trades.map((trade) => Math.abs(trade.pnlUsdt)));
  const realizedDrawdownUsdt = drawdown(ordered.map((trade) => trade.pnlUsdt));
  const mtmDrawdownUsdt = includeMtm ? markToMarketDrawdown(trades, bundle) : 0;
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
    maxDrawdownUsdt: round(realizedDrawdownUsdt, 4),
    maxDrawdownPct: round(realizedDrawdownUsdt / INITIAL_CAPITAL_USDT * 100, 4),
    mtmDrawdownUsdt: round(mtmDrawdownUsdt, 4),
    mtmDrawdownPct: round(mtmDrawdownUsdt / INITIAL_CAPITAL_USDT * 100, 4),
    cvar95LossUsdt: round(cvarTail.length === 0 ? 0 : -sum(cvarTail.map((trade) => trade.pnlUsdt)) / cvarTail.length, 4),
    cvar95LossR: round(cvarTail.length === 0 ? 0 : -sum(cvarTail.map((trade) => trade.rMultiple)) / cvarTail.length, 6),
    averageRiskUsdt: round(average(trades.map((trade) => trade.theoreticalRiskUsdt)), 4),
    averageHoldingHours: round(average(trades.map((trade) => (trade.exitTime - trade.entryTime) / 3_600_000)), 4),
    totalFeesUsdt: round(sum(trades.map((trade) => trade.feesUsdt)), 4),
    totalSlippageUsdt: round(sum(trades.map((trade) => trade.slippageUsdt)), 4),
    totalFundingUsdt: round(sum(trades.map((trade) => trade.fundingUsdt)), 4),
    positiveMonths: [...monthlyPnl.values()].filter((value) => value > 0).length,
    totalMonths,
    symbolBreadth: new Set(trades.map((trade) => trade.symbol)).size,
    regimeBreadth: new Set(trades.map((trade) => regimeForTrade(trade, bundle))).size,
    maxSymbolTradeConcentrationPct: round(maxTradeShare(trades, (trade) => trade.symbol) * 100, 4),
    maxSymbolPnlConcentrationPct: round(maxAbsoluteShare(symbolPnl, absPnl) * 100, 4),
    maxMonthlyTradeConcentrationPct: round(maxTradeShare(trades, (trade) => monthKey(trade.exitTime)) * 100, 4),
  };
}

function evaluateConfirmation(
  selected: ExperimentSummary,
  lockedAt5: StageReport,
  lockedAt10: StageReport,
  largestSymbol: Contribution,
  largestMonth: Contribution,
): Record<string, unknown> {
  const five = lockedAt5.metrics;
  const ten = lockedAt10.metrics;
  const baselinePf = 1.0115;
  const baselineExpectancy = 3.5519 / 460;
  const baselinePnlPerTrade = 181.5556 / 460;
  const checks = {
    confirmationTradesAtLeast50: five.trades >= 50,
    confirmationPfAtLeast120: five.profitFactor >= 1.2,
    confirmationExpectancyPositive: five.expectancyRPerTrade > 0,
    confirmationNetPnlPositive: five.netPnlUsdt > 0,
    fiveBpsPfAtLeast115: five.profitFactor >= 1.15,
    tenBpsNoObviousCollapse: ten.profitFactor >= 1 && ten.netPnlUsdt >= 0,
    maxRealizedDrawdownAcceptable: five.maxDrawdownPct <= 30,
    maxMtmDrawdownAcceptable: five.mtmDrawdownPct <= 30,
    noSingleSymbolTradeDependence: five.maxSymbolTradeConcentrationPct <= 30,
    noSingleSymbolPnlDependence: largestSymbol.shareOfAbsolutePnlPct <= 50,
    noSingleMonthTradeDependence: five.maxMonthlyTradeConcentrationPct <= 25,
    noSingleMonthPnlDependence: largestMonth.shareOfAbsolutePnlPct <= 50,
    positiveMonthsNotTrivial: five.positiveMonths >= Math.max(2, Math.ceil(five.totalMonths * 0.4)),
    stableValidationPlateau: selected.stablePlateau,
    validationGate: selected.validationGate,
    significantPfAdvantageVsBaseline: five.profitFactor >= baselinePf + 0.15,
    significantExpectancyAdvantageVsBaseline: five.expectancyRPerTrade >= baselineExpectancy + 0.02,
    significantPnlPerTradeAdvantageVsBaseline: five.trades > 0 && five.netPnlUsdt / five.trades >= baselinePnlPerTrade,
  };
  return {
    checks,
    allAcceptanceChecksPass: Object.values(checks).every(Boolean),
    preRegisteredThresholds: {
      minimumConfirmationTrades: 50,
      minimumFiveBpsProfitFactor: 1.2,
      minimumFiveBpsStressProfitFactor: 1.15,
      minimumTenBpsProfitFactor: 1,
      maximumRealizedAndMtmDrawdownPct: 30,
      maximumSymbolTradeConcentrationPct: 30,
      maximumMonthTradeConcentrationPct: 25,
      maximumAbsoluteSymbolOrMonthPnlSharePct: 50,
      minimumPositiveMonths: "max(2, ceil(40% of locked months))",
    },
  };
}

function classifyResult(
  selected: ExperimentSummary,
  lockedMetrics: SummaryMetrics,
  acceptance: Record<string, unknown>,
): "ROBUST ORTHOGONAL EDGE FOUND" | "PROMISING BUT INSUFFICIENT CONFIRMATION" | "NO ROBUST ORTHOGONAL EDGE" | "RESEARCH INVALID" {
  if (!selected || !Number.isFinite(lockedMetrics.trades)) return "RESEARCH INVALID";
  if (lockedMetrics.trades < 50) return "PROMISING BUT INSUFFICIENT CONFIRMATION";
  return acceptance.allAcceptanceChecksPass === true ? "ROBUST ORTHOGONAL EDGE FOUND" : "NO ROBUST ORTHOGONAL EDGE";
}

function regimeForTrade(trade: BacktestTrade, bundle: Bundle): MarketRegime {
  const context = bundle.contextBySymbol.get(trade.symbol);
  if (!context) return "UNKNOWN";
  const entryIndex = context.openIndexByTime.get(trade.entryTime);
  if (entryIndex === undefined || entryIndex <= 0) return "UNKNOWN";
  return bundle.globalRegime.get(context.primary[entryIndex - 1].closeTime) ?? "UNKNOWN";
}

function markToMarketDrawdown(trades: BacktestTrade[], bundle: Bundle): number {
  if (trades.length === 0) return 0;
  const changes = new Map<number, { realized: number; markDelta: number }>();
  const add = (timestamp: number, realized: number, markDelta: number): void => {
    const current = changes.get(timestamp) ?? { realized: 0, markDelta: 0 };
    current.realized += realized;
    current.markDelta += markDelta;
    changes.set(timestamp, current);
  };
  for (const trade of trades) {
    const context = bundle.contextBySymbol.get(trade.symbol);
    if (!context) continue;
    const candles = context.primary;
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
      const funding = (context.dataset.fundingRates ?? [])
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

function buildAvailabilityByMonth(datasets: HistoricalDataset[]): Array<{ month: string; symbolsAvailable: number; symbols: string[] }> {
  return monthKeysBetween(HISTORY_START, HISTORY_END).map((month) => {
    const calendarStart = Date.parse(month + "-01T00:00:00.000Z");
    const calendarEnd = new Date(calendarStart);
    calendarEnd.setUTCMonth(calendarEnd.getUTCMonth() + 1);
    const start = Math.max(HISTORY_START, calendarStart);
    const end = Math.min(HISTORY_END, calendarEnd.getTime() - 1);
    const symbols = datasets.filter((dataset) => {
      const candles = dataset.candles["15m"];
      return (candles[0]?.openTime ?? Number.POSITIVE_INFINITY) <= start
        && (candles.at(-1)?.closeTime ?? 0) >= end;
    }).map((dataset) => dataset.symbol).sort();
    return { month, symbolsAvailable: symbols.length, symbols };
  });
}

function buildMarkdown(input: {
  classification: string;
  historicalCoverage: { evaluationStart: string; evaluationEnd: string; reliableHistoryDays: number; datasetCount: number };
  experimentCount: { configurations: number; discoveryBacktestRuns: number; validationBacktestRuns: number; lockedConfirmationModelRuns: number; totalBacktestRuns: number };
  preregisteredSplit: { discovery: string; validation: string; lockedConfirmation: string };
  familyResults: Array<{ family: FamilyId; label: string; bestOverall: ExperimentSummary }>;
  selectedSummary: ExperimentSummary;
  selectedValidation: StageReport;
  lockedBySlippage: Record<string, StageReport>;
  acceptance: Record<string, unknown>;
  largestSymbol: Contribution;
  largestMonth: Contribution;
}): string {
  const five = input.lockedBySlippage["5"]?.metrics;
  const ten = input.lockedBySlippage["10"]?.metrics;
  const two = input.lockedBySlippage["2"]?.metrics;
  if (!five || !ten || !two) throw new Error("Cannot render Markdown without all cost runs");
  return [
    "# HY-R3 Orthogonal Edge Discovery",
    "",
    "- Status: **COMPLETED**",
    "- Final classification: **" + input.classification + "**",
    "- Historical coverage: " + input.historicalCoverage.evaluationStart + " -> " + input.historicalCoverage.evaluationEnd + " (" + input.historicalCoverage.reliableHistoryDays + " days; " + input.historicalCoverage.datasetCount + " datasets)",
    "- Experiment count: " + input.experimentCount.configurations + " configurations; " + input.experimentCount.totalBacktestRuns + " total backtest runs (" + input.experimentCount.discoveryBacktestRuns + " Discovery + " + input.experimentCount.validationBacktestRuns + " Validation + " + input.experimentCount.lockedConfirmationModelRuns + " frozen cost repricings)",
    "",
    "## Pre-registered split",
    "",
    "- Discovery: " + input.preregisteredSplit.discovery,
    "- Validation: " + input.preregisteredSplit.validation,
    "- Locked Confirmation: " + input.preregisteredSplit.lockedConfirmation,
    "- Locked Confirmation was not read before model selection; no confirmation-driven retuning was performed.",
    "",
    "## Family results",
    "",
    "| Family | Best validation candidate | Side | Validation trades | Validation PF | Validation net PnL | Stable plateau |",
    "|---|---|---:|---:|---:|---:|---:|",
    ...input.familyResults.map((family) => {
      const candidate = family.bestOverall;
      return "| " + family.label + " | " + candidate.config.id + " | " + candidate.config.side + " | " + candidate.validation.trades + " | " + format(candidate.validation.profitFactor) + " | " + format(candidate.validation.netPnlUsdt) + " | " + (candidate.stablePlateau ? "YES" : "NO") + " |";
    }),
    "",
    "## Selected frozen candidate",
    "",
    "- **" + input.selectedSummary.config.id + "** — " + familyLabel(input.selectedSummary.config.family),
    "- Parameters: " + JSON.stringify(input.selectedSummary.config.params),
    "- Validation trades / PF / expectancy: " + input.selectedValidation.metrics.trades + " / " + format(input.selectedValidation.metrics.profitFactor) + " / " + format(input.selectedValidation.metrics.expectancyRPerTrade) + " R/trade",
    "- Validation net PnL / max DD: " + format(input.selectedValidation.metrics.netPnlUsdt) + " USDT / " + format(input.selectedValidation.metrics.maxDrawdownUsdt) + " USDT",
    "- Validation gate: " + (input.selectedSummary.validationGate ? "PASS" : "FAIL") + "; stable plateau: " + (input.selectedSummary.stablePlateau ? "PASS" : "FAIL"),
    "",
    "## Locked Confirmation cost sensitivity",
    "",
    "| Slippage | Trades | LONG / SHORT | Win rate | PF | Net PnL USDT | Expectancy R/trade | Max DD USDT | MTM DD USDT |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    "| 2 bps | " + two.trades + " | " + two.longTrades + " / " + two.shortTrades + " | " + format(two.winRatePct) + "% | " + format(two.profitFactor) + " | " + format(two.netPnlUsdt) + " | " + format(two.expectancyRPerTrade) + " | " + format(two.maxDrawdownUsdt) + " | " + format(two.mtmDrawdownUsdt) + " |",
    "| 5 bps | " + five.trades + " | " + five.longTrades + " / " + five.shortTrades + " | " + format(five.winRatePct) + "% | " + format(five.profitFactor) + " | " + format(five.netPnlUsdt) + " | " + format(five.expectancyRPerTrade) + " | " + format(five.maxDrawdownUsdt) + " | " + format(five.mtmDrawdownUsdt) + " |",
    "| 10 bps | " + ten.trades + " | " + ten.longTrades + " / " + ten.shortTrades + " | " + format(ten.winRatePct) + "% | " + format(ten.profitFactor) + " | " + format(ten.netPnlUsdt) + " | " + format(ten.expectancyRPerTrade) + " | " + format(ten.maxDrawdownUsdt) + " | " + format(ten.mtmDrawdownUsdt) + " |",
    "",
    "- Largest symbol contribution: " + input.largestSymbol.key + " (" + format(input.largestSymbol.metrics.netPnlUsdt) + " USDT; " + format(input.largestSymbol.shareOfAbsolutePnlPct) + "% of absolute symbol net-PnL contributions).",
    "- Largest month contribution: " + input.largestMonth.key + " (" + format(input.largestMonth.metrics.netPnlUsdt) + " USDT; " + format(input.largestMonth.shareOfAbsolutePnlPct) + "% of absolute month net-PnL contributions).",
    "- Acceptance checks: **" + (input.acceptance.allAcceptanceChecksPass === true ? "PASS" : "FAIL") + "**.",
    "",
    "## Method and safety",
    "",
    "- Family A uses momentum breakout; Family B uses compression-to-expansion breakout; Family C uses PIT-safe dynamic Top10 cross-sectional relative strength.",
    "- Signal uses closed candle N; execution is N+1 OPEN; one TradePlan drives risk, costs and PnL; no look-ahead.",
    "- Fixed risk: 50 USDT/trade, 50 USDT single cap, 600 USDT daily budget, 10,000 USDT max notional, 20x leverage, RR2, 24h cooldown, 48h max hold.",
    "- No Production, Supabase, Vercel, environment, scheduler, strategy or trading action was taken. AUTO_TRADING remains FALSE.",
    "- Survivorship/listing and missing-history limitations remain; see the JSON report for the complete monthly availability table and all Discovery/Validation breakdowns.",
    "",
    "- [" + "hy-r3-orthogonal-edge-discovery.json](" + REPORT_JSON + ")",
    "- [" + "hy-r3-orthogonal-edge-discovery.md](" + REPORT_MD + ")",
    "",
  ].join("\n");
}

function formatStage(stage: Stage): string {
  return new Date(stage.start).toISOString() + " -> " + new Date(stage.end).toISOString();
}

function previousExtreme(candles: Candle[], period: number, field: "high" | "low"): Array<number | null> {
  const result: Array<number | null> = Array(candles.length).fill(null);
  const deque: number[] = [];
  for (let index = 0; index < candles.length; index += 1) {
    while (deque.length > 0 && deque[0] <= index - period) deque.shift();
    if (index >= period && deque.length > 0) result[index] = candles[deque[0]][field];
    while (deque.length > 0) {
      const tail = deque.at(-1);
      if (tail === undefined) break;
      const tailValue = candles[tail][field];
      const currentValue = candles[index][field];
      if (field === "high" ? tailValue <= currentValue : tailValue >= currentValue) deque.pop();
      else break;
    }
    deque.push(index);
  }
  return result;
}

function previousAverage(values: number[], period: number): Array<number | null> {
  const sums = prefix(values);
  return values.map((_, index) => index < period ? null : (sums[index] - sums[index - period]) / period);
}

function bollingerBandwidth(candles: Candle[], period: number): Array<number | null> {
  const values = closes(candles);
  const sums = prefix(values);
  const squares = prefix(values.map((value) => value ** 2));
  return values.map((value, index) => {
    if (index + 1 < period) return null;
    const sumValue = sums[index + 1] - sums[index + 1 - period];
    const mean = sumValue / period;
    const variance = Math.max(0, (squares[index + 1] - squares[index + 1 - period]) / period - mean ** 2);
    return mean === 0 ? null : 4 * Math.sqrt(variance) / mean;
  });
}

function rollingLogVolatility(context: DatasetContext, index: number, window: number): number {
  const start = Math.max(1, index - window + 1);
  const count = index - start + 1;
  if (count <= 1) return 0;
  const sumValue = context.logReturnPrefix[index + 1] - context.logReturnPrefix[start];
  const squareSum = context.logReturnSquarePrefix[index + 1] - context.logReturnSquarePrefix[start];
  const mean = sumValue / count;
  return Math.sqrt(Math.max(0, squareSum / count - mean ** 2));
}

function rollingQuoteVolume(context: DatasetContext, index: number, periods: number): number {
  const start = Math.max(0, index - periods + 1);
  return context.quoteVolumePrefix[index + 1] - context.quoteVolumePrefix[start];
}

function trueRangeAt(candles: Candle[], index: number): number {
  if (index <= 0) return candles[index].high - candles[index].low;
  return Math.max(candles[index].high - candles[index].low, Math.abs(candles[index].high - candles[index - 1].close), Math.abs(candles[index].low - candles[index - 1].close));
}

function prefix(values: number[]): number[] {
  const result = [0];
  for (const value of values) result.push(result.at(-1)! + value);
  return result;
}

function lastIndexAtOrBefore(candles: Candle[], closeTime: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].closeTime <= closeTime) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function lowerBoundCloseTime(candles: Candle[], closeTime: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].closeTime < closeTime) low = middle + 1;
    else high = middle;
  }
  return low;
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

function groupPnl<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of items) {
    const trade = item as BacktestTrade;
    result.set(key(item), (result.get(key(item)) ?? 0) + trade.pnlUsdt);
  }
  return result;
}

function largestContribution(groups: Record<string, SummaryMetrics>): Contribution {
  const denominator = sum(Object.values(groups).map((metrics) => Math.abs(metrics.netPnlUsdt)));
  const entries = Object.entries(groups).filter(([, metrics]) => metrics.trades > 0);
  const [key, metrics] = [...entries].sort(([, left], [, right]) => right.netPnlUsdt - left.netPnlUsdt)[0] ?? ["NONE", emptyMetrics(0)];
  return {
    key,
    metrics,
    shareOfAbsolutePnlPct: round(denominator <= 0 ? 0 : Math.abs(metrics.netPnlUsdt) / denominator * 100, 4),
  };
}

function emptyMetrics(totalMonths: number): SummaryMetrics {
  return {
    trades: 0,
    longTrades: 0,
    shortTrades: 0,
    wins: 0,
    losses: 0,
    winRatePct: 0,
    grossProfitUsdt: 0,
    grossLossUsdt: 0,
    profitFactor: 0,
    netPnlUsdt: 0,
    netR: 0,
    expectancyRPerTrade: 0,
    maxDrawdownUsdt: 0,
    maxDrawdownPct: 0,
    mtmDrawdownUsdt: 0,
    mtmDrawdownPct: 0,
    cvar95LossUsdt: 0,
    cvar95LossR: 0,
    averageRiskUsdt: 0,
    averageHoldingHours: 0,
    totalFeesUsdt: 0,
    totalSlippageUsdt: 0,
    totalFundingUsdt: 0,
    positiveMonths: 0,
    totalMonths,
    symbolBreadth: 0,
    regimeBreadth: 0,
    maxSymbolTradeConcentrationPct: 0,
    maxSymbolPnlConcentrationPct: 0,
    maxMonthlyTradeConcentrationPct: 0,
  };
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

function liquidityScore(quoteVolume?: number): number {
  if (!quoteVolume || quoteVolume <= 0) return 0.35;
  return clamp01((Math.log10(quoteVolume) - 5) / 5);
}

function volatilityScore(atrPercent: number): number {
  if (!Number.isFinite(atrPercent)) return 0;
  return clamp01(1 - Math.abs(atrPercent - 0.012) / 0.025);
}

function regimeFit(side: Side, regime: MarketRegime): number {
  if ((side === "LONG" && regime === "BULL") || (side === "SHORT" && regime === "BEAR")) return 1;
  if (regime === "UNKNOWN") return 0.55;
  if (regime === "RANGE") return 0.6;
  return 0.25;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
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
