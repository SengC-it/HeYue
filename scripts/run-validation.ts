import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { buildCandidateCache, runPortfolioBacktest, type BacktestOptions } from "@/lib/backtest/engine";
import { assertHistoricalDatasetIntegrity } from "@/lib/backtest/data-integrity";
import type { BacktestTrade, HistoricalDataset } from "@/lib/backtest/types";
import { runProductionParityBacktest } from "@/lib/backtest/production-parity";
import { buildValidationUniverseMetadata, type ValidationUniverseMetadata } from "@/lib/backtest/validation-metadata";
import { BinancePublicClient } from "@/lib/binance/public-client";
import { readHyEnv, type HyEnvName } from "@/lib/config";
import { volumeSourceForDatasets } from "@/lib/backtest/volume";
import { fitScoreCalibration, type ScoreCalibrationFitOptions, type ScoreCalibrationModel } from "@/lib/core/scoring";
import type { RuntimeStrategyPolicy } from "@/lib/core/runtime-strategy";
import { DEFAULT_STRATEGY_PARAMS, type EntryMode, type StrategyParams } from "@/lib/core/strategies";
import type { Instrument, ScoredCandidate } from "@/lib/core/types";

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MINIMUM_VALIDATION_CANDLES_15M = 365 * 24 * 4;
const MAX_VALIDATION_CANDIDATES = 100;
const MAX_HOLD_HOURS = 72;
const INITIAL_CAPITAL_USDT = 10_000;
const CANDIDATE_CACHE_VERSION = "candidate-cache-v4";
const DEFAULT_SYMBOL_COUNT = 50;

interface Variant {
  id: string;
  description: string;
  params: StrategyParams;
  options: BacktestOptions;
  calibration?: ScoreCalibrationFitOptions;
}

interface Metrics {
  signals: number;
  wins: number;
  losses: number;
  winRate: number;
  avgScore: number;
  avgRiskUsdt: number;
  avgPnlUsdt: number;
  netR: number;
  netPnlUsdt: number;
  pricePnlBeforeExecutionCostsUsdt: number;
  totalFeesUsdt: number;
  totalFundingUsdt: number;
  totalSlippageUsdt: number;
  profitFactor: number;
  maxDrawdownUsdt: number;
  maxDrawdownPercent: number;
  finalEquityUsdt: number;
}

async function main() {
  const configuredWindowEnd = timestampEnv("HY_VALIDATION_END_TIME");
  const currentBucketOpen = configuredWindowEnd === undefined
    ? Math.floor(Date.now() / FIFTEEN_MINUTES) * FIFTEEN_MINUTES
    : configuredWindowEnd + 1;
  const windowStart = currentBucketOpen - 365 * DAY;
  const windowEnd = currentBucketOpen - 1;
  const warmupStart = windowStart - 14 * DAY;
  const splitTime = addMonths(windowStart, 9);
  const trainEnd = splitTime - MAX_HOLD_HOURS * HOUR;
  const oosStart = splitTime;
  const minScore = numberEnv("HY_VALIDATION_MIN_SCORE", 60);
  const feeRate = numberEnv("HY_VALIDATION_FEE_RATE", 0.0004);
  const slippageBps = numberEnv("HY_VALIDATION_SLIPPAGE_BPS", 2);
  const concurrency = Math.max(1, Math.min(4, Math.floor(numberEnv("HY_VALIDATION_CONCURRENCY", 1))));
  const interSymbolDelayMs = Math.max(0, Math.floor(numberEnv("HY_VALIDATION_INTER_SYMBOL_DELAY_MS", 2_000)));
  const focus = readHyEnv("HY_VALIDATION_FOCUS") ?? "calibrated-trend-selected";
  const validationSymbolCount = Math.max(
    50,
    Math.min(100, Math.floor(numberEnv("HY_VALIDATION_SYMBOL_COUNT", DEFAULT_SYMBOL_COUNT))),
  );
  const requestedSymbols = parseSymbols(readHyEnv("HY_VALIDATION_SYMBOLS"));
  const targetSymbolCount = requestedSymbols.length > 0 ? requestedSymbols.length : validationSymbolCount;
  const client = new BinancePublicClient(readHyEnv("HY_BINANCE_API_BASE_URL"), undefined, numberEnv("HY_BINANCE_REQUEST_DELAY_MS", 0));
  const cacheDir = resolve("data/validation-cache");
  await mkdir(cacheDir, { recursive: true });
  const offlineValidation = readHyEnv("HY_VALIDATION_OFFLINE") === "true" && requestedSymbols.length > 0;
  const universe = offlineValidation ? [] : await client.getUniverse();
  const candidateInstruments = offlineValidation
    ? await loadCachedInstruments(requestedSymbols, cacheDir, windowStart, windowEnd)
    : selectInstruments(universe, requestedSymbols, validationSymbolCount, focus === "production-parity" ? validationSymbolCount : undefined);

  console.info(JSON.stringify({
    stage: "fetching_validation_history",
    symbols: candidateInstruments.map((instrument) => instrument.symbol),
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(windowEnd).toISOString(),
    trainEnd: new Date(trainEnd).toISOString(),
    oosStart: new Date(oosStart).toISOString(),
    concurrency,
    interSymbolDelayMs,
    candidateSymbolCount: candidateInstruments.length,
  }));

  const datasets: HistoricalDataset[] = [];
  for (const instrument of candidateInstruments) {
    if (datasets.length >= targetSymbolCount) break;
    const cachePath = resolve(cacheDir, `${instrument.symbol}-${windowStart}-${windowEnd}.json`);
    let dataset: HistoricalDataset | null = null;
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as HistoricalDataset;
      console.info(JSON.stringify({ stage: "loaded_validation_cache", symbol: instrument.symbol }));
      if (!hasFullValidationHistory(cached, windowStart, windowEnd)) {
        console.warn(JSON.stringify({ stage: "skipped_short_history", symbol: instrument.symbol }));
      } else {
        dataset = cached;
      }
    } catch {
      const fallback = await loadLatestPriorCache(cacheDir, instrument.symbol, windowEnd);
      if (fallback) {
        console.info(JSON.stringify({ stage: "loaded_prior_validation_cache", symbol: instrument.symbol }));
        if (!hasFullValidationHistory(fallback, windowStart, windowEnd)) {
          console.warn(JSON.stringify({ stage: "skipped_short_history", symbol: instrument.symbol }));
        } else {
          dataset = fallback;
        }
      }
    }
    if (!dataset) {
      const [candles15m, candles1h, candles4h, fundingRates] = await Promise.all([
        client.getCandlesRange(instrument.symbol, "15m", warmupStart, windowEnd),
        client.getCandlesRange(instrument.symbol, "1h", warmupStart, windowEnd),
        client.getCandlesRange(instrument.symbol, "4h", warmupStart, windowEnd),
        client.getFundingRatesRange(instrument.symbol, windowStart, windowEnd),
      ]);
      console.info(JSON.stringify({
        stage: "downloaded",
        symbol: instrument.symbol,
        candles15m: candles15m.length,
        candles1h: candles1h.length,
        candles4h: candles4h.length,
        fundingRates: fundingRates.length,
      }));
      const downloaded = {
        symbol: instrument.symbol,
        instrument,
        candles: { "15m": candles15m, "1h": candles1h, "4h": candles4h },
        fundingRates,
      } satisfies HistoricalDataset;
      if (candles15m.length < 80 || candles1h.length < 80 || candles4h.length < 80 || !hasFullValidationHistory(downloaded, windowStart, windowEnd)) {
        console.warn(JSON.stringify({ stage: "skipped_short_history", symbol: instrument.symbol }));
        continue;
      }
      await writeFile(cachePath, JSON.stringify(downloaded), "utf8");
      dataset = downloaded;
    }
    assertHistoricalDatasetIntegrity(dataset);
    datasets.push(dataset);
    if (interSymbolDelayMs > 0) await delay(interSymbolDelayMs);
  }
  if (datasets.length < targetSymbolCount) {
    throw new Error(`Only ${datasets.length} of ${targetSymbolCount} requested symbols have at least one year of history within the top ${candidateInstruments.length} candidates`);
  }
  const instruments = datasets.map((dataset) => dataset.instrument);
  const universeMetadata = buildValidationUniverseMetadata({
    requestedSymbols,
    candidatePoolSize: candidateInstruments.length,
    dynamicUniverseSize: focus === "production-parity" ? 10 : undefined,
    lookbackHours: focus === "production-parity" ? 24 : undefined,
    datasets,
  });

  const allVariants = createVariants(minScore, feeRate, slippageBps, focus);
  const requestedVariantIds = parseVariantIds(readHyEnv("HY_VALIDATION_VARIANT_IDS"));
  const variants = requestedVariantIds.length === 0
    ? allVariants
    : allVariants.filter((variant) => requestedVariantIds.includes(variant.id));
  if (variants.length === 0) {
    throw new Error("HY_VALIDATION_VARIANT_IDS did not match any configured variants");
  }
  const candidateCacheDir = resolve("data/candidate-cache");
  if (focus === "production-parity") {
    const candidateCaches = await loadCandidateCaches(datasets, variants[0].params, windowEnd, candidateCacheDir);
    await writeProductionParityValidationReport({
      datasets,
      variant: variants[0],
      candidateCaches,
      universeMetadata,
      windowStart,
      windowEnd,
      warmupStart,
      feeRate,
      slippageBps,
      concurrency,
      interSymbolDelayMs,
      symbols: instruments.map((instrument) => instrument.symbol),
    });
    return;
  }
  if (focus === "calibrated-rolling" || focus === "cost-frequency-rolling" || focus === "improved-quality-rolling" || focus === "improved-quality-control-rolling" || focus === "liquid-quality-rolling" || focus === "dynamic-liquid-quality-rolling" || focus === "dynamic-liquid-regime-rolling" || focus === "dynamic-liquid-regime-confirmation-rolling" || focus === "dynamic-liquid-risk-rolling" || focus === "dynamic-liquid-exit-rolling" || focus === "dynamic-liquid-train-grid-rolling" || focus === "exit-rolling") {
    const candidateCaches = await loadCandidateCaches(datasets, variants[0].params, windowEnd, candidateCacheDir);
    await writeRollingValidationReport({
      datasets,
      variant: variants[0],
      candidateCaches,
      universeMetadata,
      windowStart,
      windowEnd,
      warmupStart,
      feeRate,
      slippageBps,
      concurrency,
      interSymbolDelayMs,
      symbols: instruments.map((instrument) => instrument.symbol),
      reportFileName: validationReportFileName(
        focus === "cost-frequency-rolling" || focus === "improved-quality-rolling" || focus === "improved-quality-control-rolling" || focus === "liquid-quality-rolling" || focus === "dynamic-liquid-quality-rolling" || focus === "dynamic-liquid-regime-rolling" || focus === "dynamic-liquid-regime-confirmation-rolling" || focus === "dynamic-liquid-risk-rolling" || focus === "dynamic-liquid-exit-rolling" || focus === "dynamic-liquid-train-grid-rolling"
          ? `${variants[0].id}-rolling`
          : focus === "exit-rolling"
            ? `${variants[0].id}-rolling`
            : "calibrated-rolling",
        feeRate,
        slippageBps,
      ),
    });
    return;
  }
  if (focus === "score-calibrated") {
    const candidateCaches = await loadCandidateCaches(datasets, variants[0].params, windowEnd, candidateCacheDir);
    await writeScoreCalibrationReport({
      datasets,
      variant: variants[0],
      candidateCaches,
      universeMetadata,
      windowStart,
      windowEnd,
      trainEnd,
      oosStart,
      warmupStart,
      feeRate,
      slippageBps,
      concurrency,
      interSymbolDelayMs,
      symbols: instruments.map((instrument) => instrument.symbol),
    });
    return;
  }
  if (focus === "score-calibrated-rolling") {
    const candidateCaches = await loadCandidateCaches(datasets, variants[0].params, windowEnd, candidateCacheDir);
    await writeScoreCalibratedRollingReport({
      datasets,
      variant: variants[0],
      candidateCaches,
      universeMetadata,
      windowStart,
      windowEnd,
      warmupStart,
      feeRate,
      slippageBps,
      concurrency,
      interSymbolDelayMs,
      symbols: instruments.map((instrument) => instrument.symbol),
    });
    return;
  }
  const candidateCachesByParams = new Map<string, Promise<Array<Map<number, ScoredCandidate[]>>>>();
  const getCandidateCaches = async (variant: Variant) => {
    const key = JSON.stringify(variant.params);
    const existing = candidateCachesByParams.get(key);
    if (existing) return existing;
    const caches = loadCandidateCaches(datasets, variant.params, windowEnd, candidateCacheDir);
    candidateCachesByParams.set(key, caches);
    return caches;
  };
  const results = await Promise.all(variants.map(async (variant) => {
    const candidateCaches = await getCandidateCaches(variant);
    const full = runValidationSlice(datasets, variant, windowStart, windowEnd, candidateCaches);
    const train = runValidationSlice(datasets, variant, windowStart, trainEnd, candidateCaches);
    const outOfSample = runValidationSlice(datasets, variant, oosStart, windowEnd, candidateCaches);
    return {
      id: variant.id,
      description: variant.description,
      params: variant.params,
      options: variant.options,
      rawFullSignals: full.rawSignals,
      rawTrainSignals: train.rawSignals,
      rawOutOfSampleSignals: outOfSample.rawSignals,
      rawFull: full.rawMetrics,
      rawTrain: train.rawMetrics,
      rawOutOfSample: outOfSample.rawMetrics,
      fullRejections: full.rejectionCounts,
      trainRejections: train.rejectionCounts,
      outOfSampleRejections: outOfSample.rejectionCounts,
      full: full.metrics,
      train: train.metrics,
      outOfSample: outOfSample.metrics,
      passesSuggestedGate: passesSuggestedGate(outOfSample.metrics),
    };
  }));

  results.sort((left, right) => rankResult(right) - rankResult(left));
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: "P0-P1 experimental validation; no production strategy changed",
    focus,
    window: {
      start: new Date(windowStart).toISOString(),
      end: new Date(windowEnd).toISOString(),
      warmupStart: new Date(warmupStart).toISOString(),
      train: {
        start: new Date(windowStart).toISOString(),
        end: new Date(trainEnd).toISOString(),
      },
      outOfSample: {
        start: new Date(oosStart).toISOString(),
        end: new Date(windowEnd).toISOString(),
      },
      embargoHours: MAX_HOLD_HOURS,
    },
    assumptions: {
      primaryTimeframe: "15m",
      confirmationTimeframes: ["1h", "4h"],
      initialCapitalUsdt: INITIAL_CAPITAL_USDT,
      maxHoldHours: MAX_HOLD_HOURS,
      takeProfitRewardRisk: 2,
      takerFeeRate: feeRate,
      slippageBps,
      intrabarModel: "stop-first when both levels are inside one candle",
      entryModel: "signal on a closed 15m candle; fill at the next 15m open plus adverse slippage",
      note: "The suggested gate is a research threshold, not a profit guarantee.",
    },
    universe: {
      ...universeMetadata,
      symbols: instruments.map((instrument) => instrument.symbol),
      selection: `top ${candidateInstruments.length} USDT-M perpetual candidates by 24h quote volume, retaining ${instruments.length} with at least one year of history`,
      note: "Set HY_VALIDATION_SYMBOL_COUNT to 100 for the full top-100 candidate run, or HY_VALIDATION_SYMBOLS for an explicit reproducible list.",
    },
    variants: results,
    data: datasets.map((dataset) => ({
      symbol: dataset.symbol,
      candles15m: dataset.candles["15m"].length,
      candles1h: dataset.candles["1h"]?.length ?? 0,
      candles4h: dataset.candles["4h"]?.length ?? 0,
      fundingRates: dataset.fundingRates?.length ?? 0,
    })),
  };

  const reportPath = resolve("reports", validationReportFileName(focus, feeRate, slippageBps));
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.info(JSON.stringify({
    ok: true,
    reportPath,
    variants: results.map((result) => ({
      id: result.id,
      rawFullSignals: result.rawFullSignals,
      fullSignals: result.full.signals,
      fullNetPnlUsdt: result.full.netPnlUsdt,
      fullPF: result.full.profitFactor,
      rawTrainSignals: result.rawTrainSignals,
      trainSignals: result.train.signals,
      trainNetPnlUsdt: result.train.netPnlUsdt,
      trainPF: result.train.profitFactor,
      rawOosSignals: result.rawOutOfSampleSignals,
      oosSignals: result.outOfSample.signals,
      oosNetPnlUsdt: result.outOfSample.netPnlUsdt,
      oosPF: result.outOfSample.profitFactor,
      oosDD: result.outOfSample.maxDrawdownPercent,
      passesSuggestedGate: result.passesSuggestedGate,
    })),
  }, null, 2));
}

function createVariants(minScore: number, feeRate: number, slippageBps: number, focus: string): Variant[] {
  const common = {
    initialCapitalUsdt: INITIAL_CAPITAL_USDT,
    minScore,
    maxHoldHours: MAX_HOLD_HOURS,
    minimumSampleDays: 0,
    singleSignalRiskCapUsdt: 100,
    dailyRiskBudgetUsdt: 600,
    dailyLossLimitUsdt: 600,
    maxConcurrentPositions: 6,
    maxEmailsPerDay: 10,
    maxEmailsPerScan: 6,
    capitalFloorUsdt: 0,
    marginUsdt: 100,
    leverage: 20,
    takerFeeRate: feeRate,
    slippageBps,
    // Reprice the same eligible opportunities in cost stress runs.
    selectionTakerFeeRate: 0.0004,
    selectionSlippageBps: 2,
    entryDelayBars: 1,
  } satisfies BacktestOptions;

  if (focus === "production-parity") {
    return [{
      id: "hy-paper-candidate-v2-production-parity",
      description: "Research-only reproduction of the current PAPER policy: TREND_PULLBACK, TREND, SHORT, score >= 80, strict local and BTC 4h global regime alignment, 24h cooldown, 50U risk, 10,000U max notional, 2R target, 48h max hold, execution cost risk <= 10%.",
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "TREND_PULLBACK",
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        minScore: 80,
        maxHoldHours: 48,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        rewardRisk: 2,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        strategyFamilies: ["TREND"],
        cooldownHours: 24,
        maxExecutionCostRiskFraction: 0.1,
        dynamicUniverseSize: 10,
        dynamicUniverseLookbackDays: 1,
        globalReferenceSymbol: "BTCUSDT",
        globalReferenceTimeframe: "4h",
        globalRegimeAlignment: true,
        maxConcurrentPositions: undefined,
        dailyLossLimitUsdt: undefined,
      },
    }];
  }

  const fixedRisk = (stopAtrMultiplier: number, extras: Partial<BacktestOptions> = {}, variantMinScore = minScore): Variant => ({
    id: "risk50-stop" + stopAtrMultiplier.toString().replace(".", "-") + variantSuffix(extras, variantMinScore, minScore),
    description: "50U fixed-risk sizing, " + stopAtrMultiplier + " ATR stop" + (extras.requireRegimeAlignment ? ", strict regime alignment" : "") + (variantMinScore === minScore ? "" : ", score >= " + variantMinScore),
    params: { ...DEFAULT_STRATEGY_PARAMS, stopAtrMultiplier },
    options: {
      ...common,
      ...extras,
      minScore: variantMinScore,
      riskPerTradeUsdt: 50,
      maxPositionNotionalUsdt: 10_000,
      singleSignalRiskCapUsdt: 50,
    },
  });

  const improvedQualityVariant = (variantMinScore: number, stopAtrMultiplier: number): Variant => ({
    id: `quality-pullback-short-score${variantMinScore}-stop${stopAtrMultiplier.toString().replace(".", "-")}-cooldown8-cost10`,
    description: `Trend pullback short-only, score >= ${variantMinScore}, ${stopAtrMultiplier} ATR stop, strict regime, max 3 positions, 8h cooldown, execution cost <= 10% of risk`,
    params: {
      ...DEFAULT_STRATEGY_PARAMS,
      entryMode: "TREND_PULLBACK",
      stopAtrMultiplier,
    },
    options: {
      ...common,
      minScore: variantMinScore,
      riskPerTradeUsdt: 50,
      maxPositionNotionalUsdt: 10_000,
      singleSignalRiskCapUsdt: 50,
      maxConcurrentPositions: 3,
      requireRegimeAlignment: true,
      sideFilter: "SHORT",
      strategyFamilies: ["TREND"],
      cooldownHours: 8,
      maxExecutionCostRiskFraction: 0.1,
    },
  });

  const improvedQualityControlVariant = (): Variant => ({
    id: "quality-control-default-short-score80-stop0-75-cooldown8-cost10",
    description: "Control: default entry, score >= 80, short-only strict regime, max 3 positions, 8h cooldown, execution cost <= 10% of risk",
    params: {
      ...DEFAULT_STRATEGY_PARAMS,
      entryMode: "DEFAULT",
      stopAtrMultiplier: 0.75,
    },
    options: {
      ...common,
      minScore: 80,
      riskPerTradeUsdt: 50,
      maxPositionNotionalUsdt: 10_000,
      singleSignalRiskCapUsdt: 50,
      maxConcurrentPositions: 3,
      requireRegimeAlignment: true,
      sideFilter: "SHORT",
      cooldownHours: 8,
      maxExecutionCostRiskFraction: 0.1,
    },
  });

  const liquidQualityVariant = (): Variant => ({
    id: "liquid-quality-short-score75-stop0-75-cooldown8-cost10-max6",
    description: "Fixed liquid-universe policy: trend pullback short-only, score >= 75, 0.75 ATR stop, strict regime, max 6 positions, 8h cooldown, execution cost <= 10% of risk",
    params: {
      ...DEFAULT_STRATEGY_PARAMS,
      entryMode: "TREND_PULLBACK",
      stopAtrMultiplier: 0.75,
    },
    options: {
      ...common,
      minScore: 75,
      riskPerTradeUsdt: 50,
      maxPositionNotionalUsdt: 10_000,
      singleSignalRiskCapUsdt: 50,
      maxConcurrentPositions: 6,
      requireRegimeAlignment: true,
      sideFilter: "SHORT",
      strategyFamilies: ["TREND"],
      cooldownHours: 8,
      maxExecutionCostRiskFraction: 0.1,
    },
  });

  const dynamicLiquidQualityVariant = (globalRegimeAlignment = false, confirmationTimeframe?: "1h" | "4h", dailyLossLimitUsdt = 600, rewardRisk = 2, maxHoldHours = MAX_HOLD_HOURS): Variant => ({
    id: `dynamic-liquid-top10-short-score75-stop0-75-cooldown8-cost10-max6${globalRegimeAlignment ? "-btc-regime" : ""}${confirmationTimeframe ? `-${confirmationTimeframe}-confirmation` : ""}${dailyLossLimitUsdt === 600 ? "" : `-daily-loss${dailyLossLimitUsdt}`}${rewardRisk === 2 && maxHoldHours === MAX_HOLD_HOURS ? "" : `-rr${rewardRisk.toString().replace(".", "-")}-h${maxHoldHours}`}`,
    description: `Dynamic historical top-10 quote-volume universe, trend pullback short-only, score >= 75, 0.75 ATR stop, strict regime, max 6 positions, 8h cooldown, execution cost <= 10% of risk${globalRegimeAlignment ? ", BTC 4h regime aligned" : ""}${confirmationTimeframe ? ` + BTC ${confirmationTimeframe} confirmation` : ""}${dailyLossLimitUsdt === 600 ? "" : `, daily realized-loss stop ${dailyLossLimitUsdt} USDT`}${rewardRisk === 2 && maxHoldHours === MAX_HOLD_HOURS ? "" : `, target ${rewardRisk}R, max hold ${maxHoldHours}h`}`,
    params: {
      ...DEFAULT_STRATEGY_PARAMS,
      entryMode: "TREND_PULLBACK",
      stopAtrMultiplier: 0.75,
    },
    options: {
      ...common,
      minScore: 75,
      maxHoldHours,
      rewardRisk,
      riskPerTradeUsdt: 50,
      maxPositionNotionalUsdt: 10_000,
      singleSignalRiskCapUsdt: 50,
      dailyLossLimitUsdt,
      maxConcurrentPositions: 6,
      requireRegimeAlignment: true,
      sideFilter: "SHORT",
      strategyFamilies: ["TREND"],
      cooldownHours: 8,
      maxExecutionCostRiskFraction: 0.1,
      dynamicUniverseSize: 10,
      dynamicUniverseLookbackDays: 1,
      globalReferenceSymbol: "BTCUSDT",
      globalReferenceTimeframe: "4h",
      globalConfirmationTimeframe: confirmationTimeframe,
      globalRegimeAlignment,
    },
  });

  if (focus === "short-score") {
    return [65, 70, 75, 80, 85, 90].map((variantMinScore) => fixedRisk(0.75, {
      requireRegimeAlignment: true,
      sideFilter: "SHORT",
    }, variantMinScore));
  }

  if (focus === "cost-frequency") {
    const costFrequencyVariant = (variantMinScore: number, cooldownHours: number, maxCostRisk: number): Variant => ({
      id: `costfreq-score${variantMinScore}-cooldown${cooldownHours}-cost${Math.round(maxCostRisk * 100)}`,
      description: `Default entry, short-only strict regime, score >= ${variantMinScore}, ${cooldownHours}h cooldown, execution cost <= ${Math.round(maxCostRisk * 100)}% of risk`,
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        minScore: variantMinScore,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        cooldownHours,
        maxExecutionCostRiskFraction: maxCostRisk,
      },
    });
    const variants = [
      ...[75, 80, 85, 90].flatMap((variantMinScore) => [0, 8].map((cooldownHours) => costFrequencyVariant(variantMinScore, cooldownHours, 0.15))),
      costFrequencyVariant(80, 8, 0.1),
      costFrequencyVariant(80, 8, 0.2),
      costFrequencyVariant(80, 24, 0.15),
      costFrequencyVariant(85, 24, 0.15),
    ];
    return variants;
  }

  if (focus === "cost-frequency-cost10") {
    return [75, 80, 85, 90].map((variantMinScore) => ({
      id: `costfreq-score${variantMinScore}-cooldown8-cost10`,
      description: `Default entry, short-only strict regime, score >= ${variantMinScore}, 8h cooldown, execution cost <= 10% of risk`,
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        minScore: variantMinScore,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        cooldownHours: 8,
        maxExecutionCostRiskFraction: 0.1,
      },
    }));
  }

  if (focus === "cost-frequency-confirm") {
    return [{
      id: "costfreq-score80-cooldown8-cost10",
      description: "Default entry, short-only strict regime, score >= 80, 8h cooldown, execution cost <= 10% of risk",
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        minScore: 80,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        cooldownHours: 8,
        maxExecutionCostRiskFraction: 0.1,
      },
    }];
  }

  if (focus === "improved-quality") {
    return [
      improvedQualityControlVariant(),
      improvedQualityVariant(70, 0.75),
      improvedQualityVariant(75, 0.75),
      improvedQualityVariant(80, 0.75),
      improvedQualityVariant(75, 1),
    ];
  }

  if (focus === "improved-quality-rolling") {
    const rollingScore = numberEnv("HY_VALIDATION_ROLLING_SCORE", 75);
    const rollingStopAtr = numberEnv("HY_VALIDATION_ROLLING_STOP_ATR", 0.75);
    return [improvedQualityVariant(rollingScore, rollingStopAtr)];
  }

  if (focus === "improved-quality-control-rolling") {
    return [improvedQualityControlVariant()];
  }

  if (focus === "liquid-quality" || focus === "liquid-quality-rolling") {
    return [liquidQualityVariant()];
  }

  if (focus === "dynamic-liquid-quality") {
    return [dynamicLiquidQualityVariant(), dynamicLiquidQualityVariant(true)];
  }

  if (focus === "dynamic-liquid-quality-rolling") {
    return [dynamicLiquidQualityVariant()];
  }

  if (focus === "dynamic-liquid-regime-rolling") {
    return [dynamicLiquidQualityVariant(true)];
  }

  if (focus === "dynamic-liquid-regime-confirmation") {
    return [dynamicLiquidQualityVariant(true, "1h")];
  }

  if (focus === "dynamic-liquid-regime-confirmation-rolling") {
    return [dynamicLiquidQualityVariant(true, "1h")];
  }

  if (focus === "dynamic-liquid-risk") {
    return [dynamicLiquidQualityVariant(true, undefined, numberEnv("HY_VALIDATION_DAILY_LOSS_LIMIT_USDT", 300))];
  }

  if (focus === "dynamic-liquid-risk-rolling") {
    return [dynamicLiquidQualityVariant(true, undefined, numberEnv("HY_VALIDATION_DAILY_LOSS_LIMIT_USDT", 300))];
  }

  if (focus === "dynamic-liquid-exit") {
    return [dynamicLiquidQualityVariant(true, undefined, 600, 2.5, 72)];
  }

  if (focus === "dynamic-liquid-exit-rolling") {
    return [dynamicLiquidQualityVariant(true, undefined, 600, 2.5, 72)];
  }

  if (focus === "dynamic-liquid-train-grid" || focus === "dynamic-liquid-train-grid-rolling") {
    const variants: Variant[] = [];
    for (const variantMinScore of [75, 80]) {
      for (const cooldownHours of [8, 24]) {
        for (const rewardRisk of [2, 2.5]) {
          for (const maxHoldHours of [48, 72]) {
            variants.push({
              id: `train-grid-score${variantMinScore}-cooldown${cooldownHours}-rr${rewardRisk.toString().replace(".", "-")}-h${maxHoldHours}`,
              description: `Train-only selection grid: historical liquid top-10, pullback short, BTC 4h aligned, score >= ${variantMinScore}, cooldown ${cooldownHours}h, target ${rewardRisk}R, hold ${maxHoldHours}h`,
              params: {
                ...DEFAULT_STRATEGY_PARAMS,
                entryMode: "TREND_PULLBACK",
                stopAtrMultiplier: 0.75,
              },
              options: {
                ...common,
                minScore: variantMinScore,
                maxHoldHours,
                rewardRisk,
                riskPerTradeUsdt: 50,
                maxPositionNotionalUsdt: 10_000,
                singleSignalRiskCapUsdt: 50,
                maxConcurrentPositions: 6,
                requireRegimeAlignment: true,
                sideFilter: "SHORT",
                strategyFamilies: ["TREND"],
                cooldownHours,
                maxExecutionCostRiskFraction: 0.1,
                dynamicUniverseSize: 10,
                dynamicUniverseLookbackDays: 1,
                globalReferenceSymbol: "BTCUSDT",
                globalReferenceTimeframe: "4h",
                globalRegimeAlignment: true,
              },
            });
          }
        }
      }
    }
    return variants;
  }

  if (focus === "exit-grid") {
    const variants: Variant[] = [];
    for (const entryMode of ["DEFAULT", "BREAKOUT_RETEST"] as EntryMode[]) {
      for (const stopAtrMultiplier of [0.5, 0.75, 1]) {
        for (const rewardRisk of [1.5, 2, 2.5]) {
          for (const maxHoldHours of [48, 72]) {
            const family = entryMode === "DEFAULT" ? ["BREAKOUT"] as const : undefined;
            variants.push({
              id: `exitgrid-${entryMode.toLowerCase()}-stop${stopAtrMultiplier}-rr${rewardRisk}-hold${maxHoldHours}`,
              description: `${entryMode} short-only strict-regime breakout candidate, score >= 70, stop ${stopAtrMultiplier} ATR, target ${rewardRisk}R, max hold ${maxHoldHours}h, cooldown 8h, cost <= 10% of risk`,
              params: {
                ...DEFAULT_STRATEGY_PARAMS,
                entryMode,
                stopAtrMultiplier,
              },
              options: {
                ...common,
                minScore: 70,
                maxHoldHours,
                riskPerTradeUsdt: 50,
                maxPositionNotionalUsdt: 10_000,
                singleSignalRiskCapUsdt: 50,
                rewardRisk,
                requireRegimeAlignment: true,
                sideFilter: "SHORT",
                strategyFamilies: family ? [...family] : undefined,
                cooldownHours: 8,
                maxExecutionCostRiskFraction: 0.1,
              },
            });
          }
        }
      }
    }
    return variants;
  }

  if (focus === "exit-frequency") {
    const variants: Variant[] = [];
    for (const variantMinScore of [70, 75, 80, 85, 90]) {
      for (const cooldownHours of [8, 24, 48]) {
        variants.push({
          id: `exitfreq-score${variantMinScore}-cooldown${cooldownHours}`,
          description: `DEFAULT short-only strict-regime breakout candidate, score >= ${variantMinScore}, stop 0.75 ATR, target 2.5R, max hold 72h, cooldown ${cooldownHours}h, cost <= 10% of risk`,
          params: {
            ...DEFAULT_STRATEGY_PARAMS,
            entryMode: "DEFAULT",
            stopAtrMultiplier: 0.75,
          },
          options: {
            ...common,
            minScore: variantMinScore,
            maxHoldHours: 72,
            riskPerTradeUsdt: 50,
            maxPositionNotionalUsdt: 10_000,
            singleSignalRiskCapUsdt: 50,
            rewardRisk: 2.5,
            requireRegimeAlignment: true,
            sideFilter: "SHORT",
            strategyFamilies: ["BREAKOUT"],
            cooldownHours,
            maxExecutionCostRiskFraction: 0.1,
          },
        });
      }
    }
    return variants;
  }

  if (focus === "exit-direction") {
    const variants: Variant[] = [];
    for (const sideFilter of [undefined, "LONG", "SHORT"] as Array<"LONG" | "SHORT" | undefined>) {
      for (const variantMinScore of [65, 70]) {
        for (const cooldownHours of [24, 48]) {
          const sideLabel = sideFilter?.toLowerCase() ?? "adaptive";
          variants.push({
            id: `exitdir-${sideLabel}-score${variantMinScore}-cooldown${cooldownHours}`,
            description: `DEFAULT ${sideLabel} strict-regime breakout candidate, score >= ${variantMinScore}, stop 0.75 ATR, target 2.5R, max hold 72h, cooldown ${cooldownHours}h, cost <= 10% of risk`,
            params: {
              ...DEFAULT_STRATEGY_PARAMS,
              entryMode: "DEFAULT",
              stopAtrMultiplier: 0.75,
            },
            options: {
              ...common,
              minScore: variantMinScore,
              maxHoldHours: 72,
              riskPerTradeUsdt: 50,
              maxPositionNotionalUsdt: 10_000,
              singleSignalRiskCapUsdt: 50,
              rewardRisk: 2.5,
              requireRegimeAlignment: true,
              sideFilter,
              strategyFamilies: ["BREAKOUT"],
              cooldownHours,
              maxExecutionCostRiskFraction: 0.1,
            },
          });
        }
      }
    }
    return variants;
  }

  if (focus === "score-calibrated" || focus === "score-calibrated-rolling") {
    const bucketSize = numberEnv("HY_VALIDATION_CALIBRATION_BUCKET_SIZE", 5);
    const minimumSamples = numberEnv("HY_VALIDATION_CALIBRATION_MIN_SAMPLES", 40);
    const minimumExpectedNetR = numberEnv("HY_VALIDATION_CALIBRATION_MIN_NET_R", 0.02);
    const priorWeight = numberEnv("HY_VALIDATION_CALIBRATION_PRIOR_WEIGHT", 20);
    const groupByStrategyFamily = readHyEnv("HY_VALIDATION_CALIBRATION_GROUP_FAMILY") !== "false";
    return [{
      id: `score-calibrated-short-${groupByStrategyFamily ? "family-" : ""}b${bucketSize}-n${minimumSamples}-r${minimumExpectedNetR}`,
      description: `Empirical score calibration fitted on train only; short-only strict regime, 8h cooldown, execution cost <= 10% of risk, ${groupByStrategyFamily ? "family-specific, " : ""}bucket ${bucketSize}, minimum ${minimumSamples} samples, expected net R >= ${minimumExpectedNetR}`,
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: "DEFAULT",
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        minScore: 0,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
        sideFilter: "SHORT",
        cooldownHours: 8,
        maxExecutionCostRiskFraction: 0.1,
      },
      calibration: {
        bucketSize,
        groupByStrategyFamily,
        minimumSamples,
        minimumExpectedNetR,
        priorWeight,
      },
    }];
  }

  if (focus === "cost-frequency-rolling") {
    const rollingScore = numberEnv("HY_VALIDATION_ROLLING_SCORE", 90);
    const rollingCooldown = numberEnv("HY_VALIDATION_ROLLING_COOLDOWN_HOURS", 8);
    const rollingCost = numberEnv("HY_VALIDATION_ROLLING_COST_RISK", 0.1);
    const rollingEntryInterval = numberEnv("HY_VALIDATION_ROLLING_ENTRY_INTERVAL_HOURS", 0);
    const rollingEntryMode = (readHyEnv("HY_VALIDATION_ROLLING_ENTRY_MODE") ?? "DEFAULT") as EntryMode;
    const rollingSideValue = readHyEnv("HY_VALIDATION_ROLLING_SIDE");
    const rollingSide = rollingSideValue === "LONG" || rollingSideValue === "SHORT"
      ? rollingSideValue
      : undefined;
    return [{
      id: `costfreq-${rollingEntryMode.toLowerCase()}-${rollingSide?.toLowerCase() ?? "adaptive"}-score${rollingScore}-cooldown${rollingCooldown}-cost${Math.round(rollingCost * 100)}-interval${rollingEntryInterval}`,
      description: `Fixed rolling policy: ${rollingEntryMode} entry, ${rollingSide?.toLowerCase() ?? "adaptive"} strict regime, score >= ${rollingScore}, ${rollingCooldown}h cooldown, entry every ${rollingEntryInterval || "15m"}, execution cost <= ${Math.round(rollingCost * 100)}% of risk`,
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: rollingEntryMode,
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        minScore: rollingScore,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
        sideFilter: rollingSide,
        cooldownHours: rollingCooldown,
        maxExecutionCostRiskFraction: rollingCost,
        entryIntervalHours: rollingEntryInterval > 0 ? rollingEntryInterval : undefined,
      },
    }];
  }

  if (focus === "exit-rolling") {
    const rollingScore = numberEnv("HY_VALIDATION_ROLLING_SCORE", 70);
    const rollingCooldown = numberEnv("HY_VALIDATION_ROLLING_COOLDOWN_HOURS", 8);
    const rollingCost = numberEnv("HY_VALIDATION_ROLLING_COST_RISK", 0.1);
    const rollingStopAtr = numberEnv("HY_VALIDATION_ROLLING_STOP_ATR", 0.75);
    const rollingRewardRisk = numberEnv("HY_VALIDATION_ROLLING_REWARD_RISK", 2.5);
    const rollingMaxHoldHours = numberEnv("HY_VALIDATION_ROLLING_MAX_HOLD_HOURS", 72);
    const rollingEntryMode = (readHyEnv("HY_VALIDATION_ROLLING_ENTRY_MODE") ?? "DEFAULT") as EntryMode;
    const rollingSideValue = readHyEnv("HY_VALIDATION_ROLLING_SIDE");
    const rollingSide = rollingSideValue === "LONG" || rollingSideValue === "SHORT"
      ? rollingSideValue
      : undefined;
    const rollingFamily = readHyEnv("HY_VALIDATION_ROLLING_FAMILY") === "BREAKOUT"
      ? ["BREAKOUT"] as Array<"BREAKOUT">
      : undefined;
    return [{
      id: `exit-${rollingEntryMode.toLowerCase()}-${rollingSide?.toLowerCase() ?? "adaptive"}-stop${rollingStopAtr}-rr${rollingRewardRisk}-hold${rollingMaxHoldHours}-score${rollingScore}`,
      description: `Fixed rolling exit policy: ${rollingEntryMode} entry, ${rollingSide?.toLowerCase() ?? "adaptive"}, stop ${rollingStopAtr} ATR, target ${rollingRewardRisk}R, max hold ${rollingMaxHoldHours}h, score >= ${rollingScore}`,
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode: rollingEntryMode,
        stopAtrMultiplier: rollingStopAtr,
      },
      options: {
        ...common,
        minScore: rollingScore,
        maxHoldHours: rollingMaxHoldHours,
        rewardRisk: rollingRewardRisk,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
        sideFilter: rollingSide,
        strategyFamilies: rollingFamily,
        cooldownHours: rollingCooldown,
        maxExecutionCostRiskFraction: rollingCost,
      },
    }];
  }

  if (focus === "new-entries") {
    return (["TREND_PULLBACK", "BREAKOUT_RETEST", "RANGE_RECLAIM"] as EntryMode[]).map((entryMode) => ({
      id: "new-entry-" + entryMode.toLowerCase(),
      description: entryMode + ", 50U fixed-risk sizing, 0.75 ATR stop, strict regime alignment",
      params: {
        ...DEFAULT_STRATEGY_PARAMS,
        entryMode,
        stopAtrMultiplier: 0.75,
      },
      options: {
        ...common,
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
        requireRegimeAlignment: true,
      },
    }));
  }

  if (focus === "calibrated") {
    return [60, 65, 70, 75].map((variantMinScore) => ({
      id: "calibrated-short-score" + variantMinScore,
      description: "Calibrated short-only policy, score >= " + variantMinScore + ", fixed 100U margin, portfolio limits enforced",
      params: { ...DEFAULT_STRATEGY_PARAMS },
      options: {
        ...common,
        minScore: variantMinScore,
        sideFilter: "SHORT",
      },
    }));
  }

  if (focus === "calibrated-selected") {
    return [70].map((variantMinScore) => ({
      id: "calibrated-short-score" + variantMinScore,
      description: "Selected calibrated short-only policy, score >= " + variantMinScore + ", fixed 100U margin, portfolio limits enforced",
      params: { ...DEFAULT_STRATEGY_PARAMS },
      options: {
        ...common,
        minScore: variantMinScore,
        sideFilter: "SHORT",
      },
    }));
  }

  if (focus === "calibrated-risk50") {
    return [65, 70, 75].map((variantMinScore) => ({
      id: "calibrated-risk50-short-score" + variantMinScore,
      description: "Calibrated short-only policy, score >= " + variantMinScore + ", 50U fixed risk, portfolio limits enforced",
      params: { ...DEFAULT_STRATEGY_PARAMS },
      options: {
        ...common,
        minScore: variantMinScore,
        sideFilter: "SHORT",
        riskPerTradeUsdt: 50,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 50,
      },
    }));
  }

  if (focus === "calibrated-conservative") {
    return [2, 3, 4].map((maxConcurrentPositions) => ({
      id: "calibrated-short-score70-max" + maxConcurrentPositions,
      description: "Calibrated short-only policy, score >= 70, max " + maxConcurrentPositions + " simultaneous positions",
      params: { ...DEFAULT_STRATEGY_PARAMS },
      options: {
        ...common,
        minScore: 70,
        sideFilter: "SHORT",
        maxConcurrentPositions,
      },
    }));
  }

  if (focus === "calibrated-selected-max3") {
    return [{
      id: "calibrated-short-score70-max3",
      description: "Selected calibrated short-only policy, score >= 70, max 3 simultaneous positions",
      params: { ...DEFAULT_STRATEGY_PARAMS },
      options: {
        ...common,
        minScore: 70,
        sideFilter: "SHORT",
        maxConcurrentPositions: 3,
      },
    }];
  }

  if (focus === "calibrated-grid") {
    const makeVariant = (
      id: string,
      description: string,
      variantMinScore: number,
      stopAtrMultiplier = DEFAULT_STRATEGY_PARAMS.stopAtrMultiplier,
      strategyFamilies?: Array<"TREND" | "BREAKOUT" | "MEAN_REVERSION">,
    ): Variant => ({
      id,
      description,
      params: { ...DEFAULT_STRATEGY_PARAMS, stopAtrMultiplier },
      options: {
        ...common,
        minScore: variantMinScore,
        sideFilter: "SHORT",
        maxConcurrentPositions: 3,
        strategyFamilies,
      },
    });
    return [
      ...[65, 70, 75].map((variantMinScore) => makeVariant(
        "grid-short-score" + variantMinScore,
        "Short-only score >= " + variantMinScore + ", max 3 positions",
        variantMinScore,
      )),
      ...[60, 65, 70].map((variantMinScore) => makeVariant(
        "grid-breakout-short-score" + variantMinScore,
        "Breakout short-only score >= " + variantMinScore + ", max 3 positions",
        variantMinScore,
        DEFAULT_STRATEGY_PARAMS.stopAtrMultiplier,
        ["BREAKOUT"],
      )),
      ...[65, 70, 75].map((variantMinScore) => makeVariant(
        "grid-trend-short-score" + variantMinScore,
        "Trend short-only score >= " + variantMinScore + ", max 3 positions",
        variantMinScore,
        DEFAULT_STRATEGY_PARAMS.stopAtrMultiplier,
        ["TREND"],
      )),
      makeVariant("grid-short-stop0-5-score70", "Short-only score >= 70, 0.5 ATR stop, max 3 positions", 70, 0.5),
      makeVariant("grid-short-stop0-75-score70", "Short-only score >= 70, 0.75 ATR stop, max 3 positions", 70, 0.75),
    ];
  }

  if (focus === "calibrated-trend-selected") {
    return [{
      id: "calibrated-trend-short-score70-max3",
      description: "Selected calibrated TREND short-only policy, score >= 70, max 3 simultaneous positions",
      params: { ...DEFAULT_STRATEGY_PARAMS },
      options: {
        ...common,
        minScore: 70,
        sideFilter: "SHORT",
        strategyFamilies: ["TREND"],
        maxConcurrentPositions: 3,
      },
    }];
  }

  if (focus === "calibrated-rolling") {
    return [{
      id: "calibrated-trend-short-score70-max3",
      description: "Fixed rolling-validation policy: TREND short-only, score >= 70, max 3 simultaneous positions",
      params: { ...DEFAULT_STRATEGY_PARAMS },
      options: {
        ...common,
        minScore: 70,
        sideFilter: "SHORT",
        strategyFamilies: ["TREND"],
        maxConcurrentPositions: 3,
      },
    }];
  }

  return [
    {
      id: "baseline-fixed-margin-stop0-25",
      description: "Original fixed 100U margin x20, 0.25 ATR stop",
      params: { ...DEFAULT_STRATEGY_PARAMS },
      options: common,
    },
    fixedRisk(0.5),
    fixedRisk(0.75),
    fixedRisk(1),
    fixedRisk(0.75, { requireRegimeAlignment: true }),
    fixedRisk(0.75, { requireRegimeAlignment: true, sideFilter: "LONG" }),
    fixedRisk(0.75, { requireRegimeAlignment: true, sideFilter: "SHORT" }),
    fixedRisk(0.75, { requireRegimeAlignment: true, strategyFamilies: ["TREND"] }),
    fixedRisk(0.75, { requireRegimeAlignment: true, strategyFamilies: ["BREAKOUT"] }),
    {
      id: "risk25-stop0-75-regime",
      description: "25U fixed-risk sizing, 0.75 ATR stop, strict regime alignment",
      params: { ...DEFAULT_STRATEGY_PARAMS, stopAtrMultiplier: 0.75 },
      options: {
        ...common,
        riskPerTradeUsdt: 25,
        maxPositionNotionalUsdt: 10_000,
        singleSignalRiskCapUsdt: 25,
        requireRegimeAlignment: true,
      },
    },
  ];
}

function productionRuntimePolicy(variant: Variant): RuntimeStrategyPolicy {
  const options = variant.options;
  return {
    version: "hy-paper-candidate-v2",
    params: variant.params,
    minScore: options.minScore ?? 80,
    sideFilter: options.sideFilter,
    strategyFamily: options.strategyFamilies?.length === 1 ? options.strategyFamilies[0] : undefined,
    requireRegimeAlignment: options.requireRegimeAlignment === true,
    riskPolicy: {
      marginUsdt: options.marginUsdt ?? 100,
      leverage: options.leverage ?? 20,
      singleSignalRiskCapUsdt: options.singleSignalRiskCapUsdt ?? 50,
      dailyRiskBudgetUsdt: options.dailyRiskBudgetUsdt ?? 600,
      maxHoldHours: options.maxHoldHours ?? 48,
      rewardRisk: options.rewardRisk,
      riskPerTradeUsdt: options.riskPerTradeUsdt,
      maxPositionNotionalUsdt: options.maxPositionNotionalUsdt,
    },
    cooldownHours: options.cooldownHours ?? 24,
    maxExecutionCostRiskFraction: options.maxExecutionCostRiskFraction,
    takerFeeRate: options.takerFeeRate ?? 0.0004,
    slippageBps: options.slippageBps ?? 2,
    globalRegimeAlignment: options.globalRegimeAlignment === true,
    globalReferenceSymbol: options.globalReferenceSymbol ?? "BTCUSDT",
    globalReferenceTimeframe: options.globalReferenceTimeframe ?? "4h",
  };
}

async function writeProductionParityValidationReport(input: {
  datasets: HistoricalDataset[];
  variant: Variant;
  candidateCaches: Array<Map<number, ScoredCandidate[]>>;
  universeMetadata: ValidationUniverseMetadata;
  windowStart: number;
  windowEnd: number;
  warmupStart: number;
  feeRate: number;
  slippageBps: number;
  concurrency: number;
  interSymbolDelayMs: number;
  symbols: string[];
}): Promise<void> {
  const reportPath = resolve("reports", `hy-r1-production-parity-validation-${new Date(input.windowEnd).toISOString().slice(0, 10).replaceAll("-", "")}.json`);
  const splitTime = addMonths(input.windowStart, 9);
  const productionMaxHoldHours = 48;
  const trainEnd = splitTime - productionMaxHoldHours * HOUR;
  const oosStart = splitTime;
  const quarterLength = Math.floor((input.windowEnd - input.windowStart + 1) / 4);
  const policy = productionRuntimePolicy(input.variant);
  const run = (evaluationStartTime: number, evaluationEndTime: number) => runProductionParityBacktest(input.datasets, {
    policy,
    candidateCaches: input.candidateCaches,
    evaluationStartTime,
    evaluationEndTime,
    dynamicUniverseSize: input.variant.options.dynamicUniverseSize,
    dynamicUniverseLookbackDays: input.variant.options.dynamicUniverseLookbackDays,
    maxEmailsPerDay: input.variant.options.maxEmailsPerDay ?? 10,
    maxEmailsPerScan: input.variant.options.maxEmailsPerScan ?? 6,
    budgetTimezone: readHyEnv("HY_DEFAULT_TIMEZONE") ?? "Asia/Shanghai",
    // Validation records cap decisions without sending external email.
    emailObservationEnabled: true,
    dryRun: true,
  });
  const summarizeRun = (result: ReturnType<typeof run>) => ({
    qualifiedCandidateCount: result.counts.qualifiedCandidateCount,
    claimedSignalCount: result.counts.claimedSignalCount,
    paperTradeCount: result.counts.paperTradeCount,
    emailAllowedCount: result.counts.emailAllowedCount,
    emailDeliveredEquivalentCount: result.counts.emailDeliveredEquivalentCount,
    tradeCount: result.trades.length,
    metrics: summarize(result.trades),
    rejectionCounts: result.rejectionCounts,
    deliveryStatusCounts: result.deliveryStatusCounts,
  });

  try {
    const full = summarizeRun(run(input.windowStart, input.windowEnd));
    const train = summarizeRun(run(input.windowStart, trainEnd));
    const outOfSample = summarizeRun(run(oosStart, input.windowEnd));
    const folds = Array.from({ length: 4 }, (_, index) => {
      const start = input.windowStart + index * quarterLength;
      const end = index === 3 ? input.windowEnd : input.windowStart + (index + 1) * quarterLength - 1;
      return {
        id: `q${index + 1}`,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        ...summarizeRun(run(start, end)),
      };
    });
    const report = {
      generatedAt: new Date().toISOString(),
      status: "COMPLETED",
      purpose: "Research-only validation of the unchanged HeYue PAPER policy against a bounded historical candidate cohort",
      focus: "production-parity",
      executionSemantics: "PRODUCTION_CLAIM_PARITY",
      cooldownBasis: "SIGNAL_SOURCE_TIMESTAMP",
      replacementRiskAccounting: "INCREMENTAL_DELTA",
      concurrentPositionCap: "NONE",
      dailyRealizedLossGate: "NONE",
      emailCapAffectsTradeSelection: false,
      qualifiedCandidateCount: full.qualifiedCandidateCount,
      claimedSignalCount: full.claimedSignalCount,
      paperTradeCount: full.paperTradeCount,
      emailAllowedCount: full.emailAllowedCount,
      emailDeliveredEquivalentCount: full.emailDeliveredEquivalentCount,
      universeMetadata: input.universeMetadata,
      policy: {
        id: input.variant.id,
        description: input.variant.description,
        strategyVersion: "hy-paper-candidate-v2",
        params: input.variant.params,
        options: input.variant.options,
      },
      universe: {
        ...input.universeMetadata,
        symbols: input.symbols,
        selection: `historical trailing 24h quote-volume ranking over a ${input.universeMetadata.candidatePoolSize}-symbol candidate pool, selecting dynamic top ${input.universeMetadata.dynamicUniverseSize ?? 10}`,
      },
      window: {
        start: new Date(input.windowStart).toISOString(),
        end: new Date(input.windowEnd).toISOString(),
        warmupStart: new Date(input.warmupStart).toISOString(),
        train: { start: new Date(input.windowStart).toISOString(), end: new Date(trainEnd).toISOString() },
        outOfSample: { start: new Date(oosStart).toISOString(), end: new Date(input.windowEnd).toISOString() },
        embargoHours: productionMaxHoldHours,
      },
      assumptions: {
        primaryTimeframe: "15m",
        confirmationTimeframes: ["1h", "4h"],
        dynamicUniverseLookbackHours: 24,
        initialCapitalUsdt: INITIAL_CAPITAL_USDT,
        maxHoldHours: productionMaxHoldHours,
        takeProfitRewardRisk: 2,
        takerFeeRate: input.feeRate,
        slippageBps: input.slippageBps,
        funding: "actual cached Binance USDⓈ-M fundingRate observations; no synthetic fallback rate",
        entryModel: "signal on a closed 15m candle; fill at the next 15m open plus adverse slippage",
        intrabarModel: "stop-first when both levels are inside one candle; gap-through stops fill at the worse open",
        claimSimulation: "same-symbol active replacement expires at valid_until; cooldown uses prior signal source timestamp; daily reservation uses max(newRisk - oldActiveRisk, 0)",
        emailSimulation: "email caps are measured as allowed/equivalent delivery only and never remove qualified, claimed, or paper samples; no external email is sent",
        note: "This is a research artifact only. It does not select or activate a production strategy.",
      },
      results: { full, train, outOfSample, folds },
      data: input.datasets.map((dataset) => ({
        symbol: dataset.symbol,
        candles15m: dataset.candles["15m"].length,
        candles1h: dataset.candles["1h"]?.length ?? 0,
        candles4h: dataset.candles["4h"]?.length ?? 0,
        fundingRates: dataset.fundingRates?.length ?? 0,
        volumeSource: volumeSourceForDatasets([dataset.candles["15m"]]),
      })),
      knownLimitations: [input.universeMetadata.survivorshipBiasLimitation, "Dynamic ranking is limited to the supplied historical cohort; no claim is made about contracts absent from the cohort or cache.", "Legacy caches without quoteVolume use ESTIMATED_CLOSE_X_BASE_VOLUME; email delivery counts are equivalent projections in dry-run mode."],
      runSettings: { concurrency: input.concurrency, interSymbolDelayMs: input.interSymbolDelayMs },
    };
    await mkdir(resolve("reports"), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.info(JSON.stringify({
      ok: true,
      reportPath,
      status: report.status,
      candidatePoolSize: input.universeMetadata.candidatePoolSize,
      dynamicUniverseSize: input.universeMetadata.dynamicUniverseSize,
      volumeSource: input.universeMetadata.volumeSource,
      productionParityLevel: input.universeMetadata.productionParityLevel,
      outOfSample: {
        trades: outOfSample.tradeCount,
        profitFactor: outOfSample.metrics.profitFactor,
        netPnlUsdt: outOfSample.metrics.netPnlUsdt,
        maxDrawdownPercent: outOfSample.metrics.maxDrawdownPercent,
      },
    }, null, 2));
  } catch (error) {
    const report = {
      generatedAt: new Date().toISOString(),
      status: "NOT_COMPLETED",
      purpose: "Research-only validation of the unchanged HeYue PAPER policy",
      focus: "production-parity",
      executionSemantics: "PRODUCTION_CLAIM_PARITY",
      cooldownBasis: "SIGNAL_SOURCE_TIMESTAMP",
      replacementRiskAccounting: "INCREMENTAL_DELTA",
      concurrentPositionCap: "NONE",
      dailyRealizedLossGate: "NONE",
      emailCapAffectsTradeSelection: false,
      qualifiedCandidateCount: null,
      claimedSignalCount: null,
      paperTradeCount: null,
      emailAllowedCount: null,
      emailDeliveredEquivalentCount: null,
      universeMetadata: input.universeMetadata,
      candidatePool: input.symbols,
      window: {
        start: new Date(input.windowStart).toISOString(),
        end: new Date(input.windowEnd).toISOString(),
        warmupStart: new Date(input.warmupStart).toISOString(),
      },
      progress: "Historical datasets and candidate caches were loaded before the production-parity backtest failed.",
      error: errorMessage(error),
      metrics: null,
      knownLimitations: [input.universeMetadata.survivorshipBiasLimitation],
    };
    await mkdir(resolve("reports"), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.error(JSON.stringify({ ok: false, reportPath, status: report.status, error: report.error }, null, 2));
  }
}

async function writeScoreCalibrationReport(input: {
  datasets: HistoricalDataset[];
  variant: Variant;
  candidateCaches: Array<Map<number, ScoredCandidate[]>>;
  universeMetadata: ValidationUniverseMetadata;
  windowStart: number;
  windowEnd: number;
  trainEnd: number;
  oosStart: number;
  warmupStart: number;
  feeRate: number;
  slippageBps: number;
  concurrency: number;
  interSymbolDelayMs: number;
  symbols: string[];
}) {
  const run = (evaluationStartTime: number, evaluationEndTime: number, scoreCalibration?: ScoreCalibrationModel) => runPortfolioBacktest(
    input.datasets,
    input.variant.params,
    {
      ...input.variant.options,
      scoreCalibration,
      evaluationStartTime,
      evaluationEndTime,
      candidateCaches: input.candidateCaches,
    },
  );

  // The model is fitted only from uncalibrated train trades. Portfolio and
  // email caps are intentionally not used as calibration labels because they
  // describe account capacity, not signal edge.
  const trainRawRun = run(input.windowStart, input.trainEnd);
  const model = fitScoreCalibration(
    trainRawRun.rawTrades.map((trade) => ({
      score: trade.score,
      netR: trade.rMultiple,
      strategyFamily: trade.strategyFamily as "TREND" | "BREAKOUT" | "MEAN_REVERSION",
    })),
    input.variant.calibration,
  );
  const trainCalibratedRun = run(input.windowStart, input.trainEnd, model);
  const oosRawRun = run(input.oosStart, input.windowEnd);
  const oosCalibratedRun = run(input.oosStart, input.windowEnd, model);
  const fullCalibratedRun = run(input.windowStart, input.windowEnd, model);
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: "Train-only empirical score calibration followed by fixed out-of-sample evaluation",
    policy: {
      id: input.variant.id,
      description: input.variant.description,
      params: input.variant.params,
      options: input.variant.options,
    },
    calibration: {
      fitWindow: {
        start: new Date(input.windowStart).toISOString(),
        end: new Date(input.trainEnd).toISOString(),
      },
      model,
      note: "Each score bucket is accepted only when its shrunk train mean net R meets the pre-registered threshold and its sample count is sufficient. The OOS window never contributes labels.",
    },
    window: {
      start: new Date(input.windowStart).toISOString(),
      end: new Date(input.windowEnd).toISOString(),
      warmupStart: new Date(input.warmupStart).toISOString(),
      trainEnd: new Date(input.trainEnd).toISOString(),
      oosStart: new Date(input.oosStart).toISOString(),
      embargoHours: MAX_HOLD_HOURS,
    },
    assumptions: {
      initialCapitalUsdt: INITIAL_CAPITAL_USDT,
      feeRate: input.feeRate,
      slippageBps: input.slippageBps,
      note: "Raw metrics measure signal edge before portfolio/email caps; calibrated metrics measure the alert account after those caps.",
    },
    universe: {
      ...input.universeMetadata,
      symbols: input.symbols,
      selection: "fixed liquid symbols",
      note: "This is not the full production top-100 universe.",
    },
    results: {
      fullCalibrated: summarize(fullCalibratedRun.trades),
      train: {
        rawSignals: trainRawRun.rawTrades.length,
        raw: summarize(trainRawRun.rawTrades),
        beforeCalibration: summarize(trainRawRun.trades),
        calibrated: summarize(trainCalibratedRun.trades),
        calibratedRaw: summarize(trainCalibratedRun.rawTrades),
        rejectionCounts: trainCalibratedRun.rejectionCounts,
      },
      outOfSample: {
        rawSignals: oosRawRun.rawTrades.length,
        raw: summarize(oosRawRun.rawTrades),
        beforeCalibration: summarize(oosRawRun.trades),
        calibrated: summarize(oosCalibratedRun.trades),
        calibratedRaw: summarize(oosCalibratedRun.rawTrades),
        rejectionCounts: oosCalibratedRun.rejectionCounts,
        passesSuggestedGate: passesSuggestedGate(summarize(oosCalibratedRun.trades)),
      },
    },
    runSettings: { concurrency: input.concurrency, interSymbolDelayMs: input.interSymbolDelayMs },
  };
  const reportPath = resolve("reports", validationReportFileName("score-calibrated", input.feeRate, input.slippageBps));
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.info(JSON.stringify({
    ok: true,
    reportPath,
    calibration: {
      samples: trainRawRun.rawTrades.length,
      globalMeanNetR: model.globalMeanNetR,
      acceptedBins: model.bins.filter((bin) => bin.samples >= model.minimumSamples && bin.meanNetR >= model.minimumExpectedNetR),
    },
    train: {
      rawNetPnlUsdt: report.results.train.raw.netPnlUsdt,
      calibratedNetPnlUsdt: report.results.train.calibrated.netPnlUsdt,
      calibratedPF: report.results.train.calibrated.profitFactor,
    },
    outOfSample: {
      rawNetPnlUsdt: report.results.outOfSample.raw.netPnlUsdt,
      calibratedNetPnlUsdt: report.results.outOfSample.calibrated.netPnlUsdt,
      calibratedPF: report.results.outOfSample.calibrated.profitFactor,
      calibratedDD: report.results.outOfSample.calibrated.maxDrawdownPercent,
      passesSuggestedGate: report.results.outOfSample.passesSuggestedGate,
    },
  }, null, 2));
}

async function writeScoreCalibratedRollingReport(input: {
  datasets: HistoricalDataset[];
  variant: Variant;
  candidateCaches: Array<Map<number, ScoredCandidate[]>>;
  universeMetadata: ValidationUniverseMetadata;
  windowStart: number;
  windowEnd: number;
  warmupStart: number;
  feeRate: number;
  slippageBps: number;
  concurrency: number;
  interSymbolDelayMs: number;
  symbols: string[];
}) {
  const quarterLength = Math.floor((input.windowEnd - input.windowStart + 1) / 4);
  const run = (evaluationStartTime: number, evaluationEndTime: number, scoreCalibration?: ScoreCalibrationModel) => runPortfolioBacktest(
    input.datasets,
    input.variant.params,
    {
      ...input.variant.options,
      scoreCalibration,
      evaluationStartTime,
      evaluationEndTime,
      candidateCaches: input.candidateCaches,
    },
  );
  const folds = [1, 2, 3].map((index) => {
    const start = input.windowStart + index * quarterLength;
    const end = index === 3
      ? input.windowEnd
      : input.windowStart + (index + 1) * quarterLength - 1;
    const trainEnd = start - MAX_HOLD_HOURS * HOUR;
    const trainRun = run(input.windowStart, trainEnd);
    const model = fitScoreCalibration(
      trainRun.rawTrades.map((trade) => ({
        score: trade.score,
        netR: trade.rMultiple,
        strategyFamily: trade.strategyFamily as "TREND" | "BREAKOUT" | "MEAN_REVERSION",
      })),
      input.variant.calibration,
    );
    const rawRun = run(start, end);
    const calibratedRun = run(start, end, model);
    return {
      id: `q${index + 1}`,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      calibrationTrainEnd: new Date(trainEnd).toISOString(),
      calibration: {
        samples: trainRun.rawTrades.length,
        globalMeanNetR: model.globalMeanNetR,
        bins: model.bins,
        acceptedBins: model.bins.filter((bin) => bin.samples >= model.minimumSamples && bin.meanNetR >= model.minimumExpectedNetR),
      },
      raw: summarize(rawRun.trades),
      rawSignals: rawRun.rawTrades.length,
      calibrated: summarize(calibratedRun.trades),
      calibratedRaw: summarize(calibratedRun.rawTrades),
      rejectionCounts: calibratedRun.rejectionCounts,
    };
  });
  const totalNetPnlUsdt = round(folds.reduce((sum, fold) => sum + fold.calibrated.netPnlUsdt, 0), 4);
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: "Expanding-window train-only score calibration followed by independent quarterly OOS folds",
    policy: {
      id: input.variant.id,
      description: input.variant.description,
      params: input.variant.params,
      options: input.variant.options,
    },
    window: {
      start: new Date(input.windowStart).toISOString(),
      end: new Date(input.windowEnd).toISOString(),
      warmupStart: new Date(input.warmupStart).toISOString(),
    },
    assumptions: {
      initialCapitalUsdt: INITIAL_CAPITAL_USDT,
      feeRate: input.feeRate,
      slippageBps: input.slippageBps,
      note: "Q1 is reserved as initial calibration history. Each later quarter fits on all prior data with a 72h embargo, then evaluates a fresh 10,000U account. No quarter's outcomes fit its own model.",
    },
    universe: {
      ...input.universeMetadata,
      symbols: input.symbols,
      selection: "fixed liquid symbols",
      note: "This is not the full production top-100 universe.",
    },
    summary: {
      folds: folds.length,
      profitableFolds: folds.filter((fold) => fold.calibrated.netPnlUsdt > 0).length,
      totalNetPnlUsdt,
      minimumFoldNetPnlUsdt: round(Math.min(...folds.map((fold) => fold.calibrated.netPnlUsdt)), 4),
      maximumFoldDrawdownPercent: round(Math.max(...folds.map((fold) => fold.calibrated.maxDrawdownPercent)), 4),
    },
    folds,
    runSettings: { concurrency: input.concurrency, interSymbolDelayMs: input.interSymbolDelayMs },
  };
  const reportPath = resolve("reports", validationReportFileName("score-calibrated-rolling", input.feeRate, input.slippageBps));
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.info(JSON.stringify({
    ok: true,
    reportPath,
    summary: report.summary,
    folds: folds.map((fold) => ({
      id: fold.id,
      calibrationSamples: fold.calibration.samples,
      acceptedBins: fold.calibration.acceptedBins.length,
      rawNetPnlUsdt: fold.raw.netPnlUsdt,
      calibratedNetPnlUsdt: fold.calibrated.netPnlUsdt,
      calibratedPF: fold.calibrated.profitFactor,
      calibratedDD: fold.calibrated.maxDrawdownPercent,
    })),
  }, null, 2));
}

async function writeRollingValidationReport(input: {
  datasets: HistoricalDataset[];
  variant: Variant;
  candidateCaches: Array<Map<number, ScoredCandidate[]>>;
  universeMetadata: ValidationUniverseMetadata;
  windowStart: number;
  windowEnd: number;
  warmupStart: number;
  feeRate: number;
  slippageBps: number;
  concurrency: number;
  interSymbolDelayMs: number;
  symbols: string[];
  reportFileName: string;
}) {
  const quarterLength = Math.floor((input.windowEnd - input.windowStart + 1) / 4);
  const folds = Array.from({ length: 4 }, (_, index) => {
    const start = input.windowStart + index * quarterLength;
    const end = index === 3
      ? input.windowEnd
      : input.windowStart + (index + 1) * quarterLength - 1;
    const run = runPortfolioBacktest(input.datasets, input.variant.params, {
      ...input.variant.options,
      evaluationStartTime: start,
      evaluationEndTime: end,
      candidateCaches: input.candidateCaches,
    });
    return {
      id: `q${index + 1}`,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      metrics: summarize(run.trades),
      rawSignals: run.rawTrades.length,
      rejectionCounts: run.rejectionCounts,
    };
  });
  const netPnlUsdt = round(folds.reduce((sum, fold) => sum + fold.metrics.netPnlUsdt, 0), 4);
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: "Fixed-policy rolling robustness check; no parameter selection uses these folds",
    policy: {
      id: input.variant.id,
      description: input.variant.description,
      params: input.variant.params,
      options: input.variant.options,
    },
    window: {
      start: new Date(input.windowStart).toISOString(),
      end: new Date(input.windowEnd).toISOString(),
      warmupStart: new Date(input.warmupStart).toISOString(),
    },
    assumptions: {
      initialCapitalUsdt: INITIAL_CAPITAL_USDT,
      feeRate: input.feeRate,
      slippageBps: input.slippageBps,
      entryModel: "signal on a closed 15m candle; fill at the next 15m open plus adverse slippage",
      stopModel: "stop-first intrabar; a gap through the stop fills at the worse candle open",
      note: "Each fold is evaluated independently with a fresh 10,000U paper capital base; this is a stability check, not a compounded equity curve.",
    },
    universe: {
      ...input.universeMetadata,
      symbols: input.symbols,
      selection: "fixed liquid symbols",
      note: "This is not the full production top-100 universe.",
    },
    summary: {
      folds: folds.length,
      profitableFolds: folds.filter((fold) => fold.metrics.netPnlUsdt > 0).length,
      totalNetPnlUsdt: netPnlUsdt,
      minimumFoldNetPnlUsdt: round(Math.min(...folds.map((fold) => fold.metrics.netPnlUsdt)), 4),
      maximumFoldDrawdownPercent: round(Math.max(...folds.map((fold) => fold.metrics.maxDrawdownPercent)), 4),
    },
    folds,
    runSettings: { concurrency: input.concurrency, interSymbolDelayMs: input.interSymbolDelayMs },
  };
  const reportPath = resolve("reports", input.reportFileName);
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.info(JSON.stringify({
    ok: true,
    reportPath,
    summary: report.summary,
    folds: folds.map((fold) => ({ id: fold.id, signals: fold.metrics.signals, netPnlUsdt: fold.metrics.netPnlUsdt, profitFactor: fold.metrics.profitFactor })),
  }, null, 2));
}

function variantSuffix(options: Partial<BacktestOptions>, variantMinScore: number, defaultMinScore: number): string {
  const parts = [
    options.requireRegimeAlignment ? "regime" : "",
    options.sideFilter ? options.sideFilter.toLowerCase() : "",
    options.strategyFamilies?.join("-").toLowerCase() ?? "",
  ].filter(Boolean);
  if (variantMinScore !== defaultMinScore) parts.push("score" + variantMinScore);
  return parts.length === 0 ? "" : "-" + parts.join("-");
}

function summarize(trades: BacktestTrade[]): Metrics {
  const ordered = [...trades].sort((left, right) => left.exitTime - right.exitTime || left.entryTime - right.entryTime);
  let equity = INITIAL_CAPITAL_USDT;
  let peak = equity;
  let maxDrawdownUsdt = 0;
  for (const trade of ordered) {
    equity += trade.pnlUsdt;
    peak = Math.max(peak, equity);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peak - equity);
  }
  const wins = trades.filter((trade) => trade.pnlUsdt > 0).length;
  const losses = trades.filter((trade) => trade.pnlUsdt < 0).length;
  const grossProfitUsdt = trades.filter((trade) => trade.pnlUsdt > 0).reduce((sum, trade) => sum + trade.pnlUsdt, 0);
  const grossLossUsdt = Math.abs(trades.filter((trade) => trade.pnlUsdt < 0).reduce((sum, trade) => sum + trade.pnlUsdt, 0));
  const netPnlUsdt = trades.reduce((sum, trade) => sum + trade.pnlUsdt, 0);
  return {
    signals: trades.length,
    wins,
    losses,
    winRate: trades.length === 0 ? 0 : round(wins / trades.length * 100, 2),
    avgScore: trades.length === 0 ? 0 : round(trades.reduce((sum, trade) => sum + trade.score, 0) / trades.length, 2),
    avgRiskUsdt: trades.length === 0 ? 0 : round(trades.reduce((sum, trade) => sum + trade.theoreticalRiskUsdt, 0) / trades.length, 4),
    avgPnlUsdt: trades.length === 0 ? 0 : round(netPnlUsdt / trades.length, 4),
    netR: round(trades.reduce((sum, trade) => sum + trade.rMultiple, 0), 4),
    netPnlUsdt: round(netPnlUsdt, 4),
    pricePnlBeforeExecutionCostsUsdt: round(trades.reduce((sum, trade) => sum + trade.grossPnlUsdt + trade.slippageUsdt, 0), 4),
    totalFeesUsdt: round(trades.reduce((sum, trade) => sum + trade.feesUsdt, 0), 4),
    totalFundingUsdt: round(trades.reduce((sum, trade) => sum + trade.fundingUsdt, 0), 4),
    totalSlippageUsdt: round(trades.reduce((sum, trade) => sum + trade.slippageUsdt, 0), 4),
    profitFactor: grossLossUsdt === 0 ? (grossProfitUsdt > 0 ? 999 : 0) : round(grossProfitUsdt / grossLossUsdt, 4),
    maxDrawdownUsdt: round(maxDrawdownUsdt, 4),
    maxDrawdownPercent: round(maxDrawdownUsdt / INITIAL_CAPITAL_USDT * 100, 4),
    finalEquityUsdt: round(INITIAL_CAPITAL_USDT + netPnlUsdt, 4),
  };
}

async function loadCandidateCaches(
  datasets: HistoricalDataset[],
  params: StrategyParams,
  windowEnd: number,
  cacheDir: string,
): Promise<Array<Map<number, ScoredCandidate[]>>> {
  await mkdir(cacheDir, { recursive: true });
  const paramsKey = JSON.stringify(params);
  const caches: Array<Map<number, ScoredCandidate[]>> = [];
  for (const dataset of datasets) {
    const descriptor = JSON.stringify({
      version: CANDIDATE_CACHE_VERSION,
      symbol: dataset.symbol,
      windowEnd,
      params: paramsKey,
      dataFingerprint: historicalDatasetFingerprint(dataset),
    });
    const hash = createHash("sha256").update(descriptor).digest("hex").slice(0, 20);
    const cachePath = resolve(cacheDir, `${dataset.symbol}-${hash}.json`);
    try {
      const payload = JSON.parse(await readFile(cachePath, "utf8")) as {
        version?: string;
        descriptor?: string;
        entries?: Array<[number, ScoredCandidate[]]>;
      };
      if (payload.version === CANDIDATE_CACHE_VERSION && payload.descriptor === descriptor && Array.isArray(payload.entries)) {
        caches.push(new Map(payload.entries));
        console.info(JSON.stringify({ stage: "loaded_candidate_cache", symbol: dataset.symbol }));
        continue;
      }
    } catch {
      // Build the cache below when it is missing or stale.
    }

    const cache = buildCandidateCache(dataset, params, windowEnd);
    await writeFile(cachePath, JSON.stringify({
      version: CANDIDATE_CACHE_VERSION,
      descriptor,
      entries: [...cache.entries()],
    }), "utf8");
    console.info(JSON.stringify({ stage: "built_candidate_cache", symbol: dataset.symbol, entries: cache.size }));
    caches.push(cache);
  }
  return caches;
}

function runValidationSlice(
  datasets: HistoricalDataset[],
  variant: Variant,
  evaluationStartTime: number,
  evaluationEndTime: number,
  candidateCaches: Array<Map<number, ScoredCandidate[]>>,
): {
  metrics: Metrics;
  rawMetrics: Metrics;
  rawSignals: number;
  rejectionCounts: ReturnType<typeof runPortfolioBacktest>["rejectionCounts"];
} {
  const run = runPortfolioBacktest(datasets, variant.params, {
    ...variant.options,
    evaluationStartTime,
    evaluationEndTime,
    candidateCaches,
  });
  return {
    metrics: summarize(run.trades),
    rawMetrics: summarize(run.rawTrades),
    rawSignals: run.rawTrades.length,
    rejectionCounts: run.rejectionCounts,
  };
}

function passesSuggestedGate(metrics: Metrics): boolean {
  return metrics.signals >= 100
    && metrics.netPnlUsdt > 0
    && metrics.profitFactor >= 1.1
    && metrics.maxDrawdownPercent <= 30;
}

function rankResult(result: {
  train: Metrics;
}): number {
  return (passesSuggestedGate(result.train) ? 1_000_000 : 0)
    + result.train.netPnlUsdt
    - result.train.maxDrawdownUsdt;
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
  for (const point of dataset.fundingRates ?? []) {
    hash.update(`${point.fundingTime},${point.fundingRate};`);
  }
  return hash.digest("hex");
}

function selectInstruments(
  universe: Instrument[],
  symbols: string[],
  symbolCount: number,
  candidatePoolSize?: number,
): Instrument[] {
  const bySymbol = new Map(universe.map((instrument) => [instrument.symbol, instrument]));
  if (symbols.length === 0) {
    const candidateCount = Math.min(MAX_VALIDATION_CANDIDATES, candidatePoolSize ?? symbolCount + 25);
    return universe.slice(0, candidateCount);
  }
  const missing = symbols.filter((symbol) => !bySymbol.has(symbol));
  if (missing.length > 0) throw new Error("Symbols are not currently trading USDT-M perpetuals: " + missing.join(", "));
  return symbols.map((symbol) => bySymbol.get(symbol) as Instrument);
}

function parseSymbols(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const symbols = value.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  return symbols.length === 0 ? [] : [...new Set(symbols)];
}

function hasFullValidationHistory(dataset: HistoricalDataset, windowStart: number, windowEnd: number): boolean {
  const candles15m = dataset.candles["15m"];
  const firstOpenTime = candles15m[0]?.openTime ?? Number.POSITIVE_INFINITY;
  const lastCloseTime = candles15m.at(-1)?.closeTime ?? 0;
  return candles15m.length >= MINIMUM_VALIDATION_CANDLES_15M
    && firstOpenTime <= windowStart
    && lastCloseTime >= windowEnd - 15 * 60 * 1000;
}

function parseVariantIds(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function addMonths(timestamp: number, months: number): number {
  const date = new Date(timestamp);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(readHyEnv(name as HyEnvName));
  return Number.isFinite(value) ? value : fallback;
}

function validationReportFileName(focus: string, feeRate: number, slippageBps: number): string {
  const isDefaultCost = feeRate === 0.0004 && slippageBps === 2;
  const suffix = isDefaultCost
    ? "latest"
    : `fee${Math.round(feeRate * 10_000)}bps-slip${slippageBps}bps`;
  return focus === "full"
    ? `validation-${suffix}.json`
    : `validation-${focus}-${suffix}.json`;
}

function timestampEnv(name: string): number | undefined {
  const value = readHyEnv(name as HyEnvName);
  if (!value?.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadLatestPriorCache(
  cacheDir: string,
  symbol: string,
  requestedEndTime: number,
): Promise<HistoricalDataset | null> {
  const names = await readdir(cacheDir);
  const candidates = names
    .filter((name) => name.startsWith(symbol + "-") && name.endsWith(".json"))
    .map((name) => resolve(cacheDir, name));
  const datasets: HistoricalDataset[] = [];
  for (const path of candidates) {
    try {
      const dataset = JSON.parse(await readFile(path, "utf8")) as HistoricalDataset;
      const lastCloseTime = dataset.candles["15m"].at(-1)?.closeTime ?? 0;
      if (lastCloseTime <= requestedEndTime) datasets.push(dataset);
    } catch {
      // Ignore an incomplete cache file and continue with the remaining candidates.
    }
  }
  datasets.sort((left, right) => (right.candles["15m"].at(-1)?.closeTime ?? 0) - (left.candles["15m"].at(-1)?.closeTime ?? 0));
  return datasets[0] ?? null;
}

async function loadCachedInstruments(
  symbols: string[],
  cacheDir: string,
  windowStart: number,
  windowEnd: number,
): Promise<Instrument[]> {
  const instruments: Instrument[] = [];
  for (const symbol of symbols) {
    const cachePath = resolve(cacheDir, `${symbol}-${windowStart}-${windowEnd}.json`);
    try {
      const dataset = JSON.parse(await readFile(cachePath, "utf8")) as HistoricalDataset;
      instruments.push(dataset.instrument);
    } catch {
      const prior = await loadLatestPriorCache(cacheDir, symbol, windowEnd);
      if (!prior) throw new Error(`Offline validation cache is missing for ${symbol}: ${cachePath}`);
      instruments.push(prior.instrument);
    }
  }
  return instruments;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

main().catch(async (error) => {
  if (readHyEnv("HY_VALIDATION_FOCUS") === "production-parity") {
    try {
      const configuredWindowEnd = timestampEnv("HY_VALIDATION_END_TIME");
      const currentBucketOpen = configuredWindowEnd === undefined
        ? Math.floor(Date.now() / FIFTEEN_MINUTES) * FIFTEEN_MINUTES
        : configuredWindowEnd + 1;
      const windowStart = currentBucketOpen - 365 * DAY;
      const windowEnd = currentBucketOpen - 1;
      const reportPath = resolve("reports", `hy-r1-production-parity-validation-${new Date(windowEnd).toISOString().slice(0, 10).replaceAll("-", "")}.json`);
      await mkdir(resolve("reports"), { recursive: true });
      await writeFile(reportPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        status: "NOT_COMPLETED",
        purpose: "Research-only validation of the unchanged HeYue PAPER policy",
        focus: "production-parity",
        executionSemantics: "PRODUCTION_CLAIM_PARITY",
        cooldownBasis: "SIGNAL_SOURCE_TIMESTAMP",
        replacementRiskAccounting: "INCREMENTAL_DELTA",
        concurrentPositionCap: "NONE",
        dailyRealizedLossGate: "NONE",
        emailCapAffectsTradeSelection: false,
        qualifiedCandidateCount: null,
        claimedSignalCount: null,
        paperTradeCount: null,
        emailAllowedCount: null,
        emailDeliveredEquivalentCount: null,
        candidatePoolSize: null,
        dynamicUniverseSize: 10,
        lookbackHours: 24,
        volumeSource: null,
        productionParityLevel: null,
        window: {
          start: new Date(windowStart).toISOString(),
          end: new Date(windowEnd).toISOString(),
        },
        progress: "Validation failed before a complete production-parity result could be written.",
        error: errorMessage(error),
        metrics: null,
        knownLimitations: ["The run did not complete; no performance metrics are reported."],
      }, null, 2) + "\n", "utf8");
      console.error(`Validation report written with status NOT_COMPLETED: ${reportPath}`);
    } catch (reportError) {
      console.error(`Unable to write NOT_COMPLETED validation report: ${errorMessage(reportError)}`);
    }
  }
  console.error(errorMessage(error));
  process.exitCode = 1;
});
