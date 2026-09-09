import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ema, rsi, volumeRatio } from "../lib/core/indicators";
import type {
  Candle,
  FundingRatePoint,
  MarketRegime,
} from "../lib/core/types";
import { runSignalEngineDryRun } from "../lib/signal-engine";
import type {
  EngineDataQuality,
  SignalDirection,
  SignalEngineInput,
  SignalEngineSignal,
} from "../lib/signal-engine";
import {
  calculate24hQuoteVolume,
  calculateLiquidityFeature,
  calculateMarketBreadthFeature,
} from "../lib/market-context";
import type {
  LiquidityFeature,
  LiquidityHistoryPoint,
  LiquidityVolumeSource,
  MarketBreadthFeature,
  MarketBreadthMember,
} from "../lib/market-context";

const DATA_DIRECTORY = resolve("data", "hy-r2b-history-24m");
const OI_DIRECTORY = resolve("data", "hy-r4.2-open-interest-24m");
const REPORT_DIRECTORY = resolve("reports");
const REPORT_PATH = resolve(REPORT_DIRECTORY, "hy-r4.11-signal-re-evaluation.md");
const EVALUATION_START = Date.parse("2024-08-09T00:00:00.000Z");
const EVALUATION_END = Date.parse("2026-08-09T23:59:59.999Z");
const WARMUP_START = EVALUATION_START - 7 * 24 * 60 * 60 * 1000;
const SAMPLE_INTERVAL_MS = 4 * 60 * 60 * 1000;
const VOLATILITY_LOOKBACK = 96;
const FUNDING_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const OI_CHANGE_LOOKBACK_MS = 4 * 60 * 60 * 1000;
const OI_ROLLING_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_ONE_HOUR_HISTORY = 200;
const MIN_FOUR_HOUR_HISTORY = 80;
const MIN_FUNDING_HISTORY = 30;
const MIN_OI_HISTORY = 168;
const LIQUIDITY_PERCENTILE_WINDOW = 42;
const TOP_UNIVERSE_SIZE = 10;
const BREADTH_MINIMUM_MEMBERS = 35;
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const LARGE_MOVE_THRESHOLD = 0.02;
const VOLATILITY_EXPANSION_MULTIPLIER = 1.25;

export interface HistoricalDataset {
  symbol: string;
  candles: Partial<Record<"15m" | "1h" | "4h", Candle[]>>;
  fundingRates: FundingRatePoint[];
}

interface OpenInterestPoint {
  timestamp: number;
  openInterest: number;
  openInterestValue: number;
}

export interface OpenInterestCache {
  points: OpenInterestPoint[];
}

interface DerivedSeries {
  oneHour: Candle[];
  fourHour: Candle[];
  oneHourEma20: Array<number | null>;
  oneHourRsi14: Array<number | null>;
  oneHourVolumeRatio20: Array<number | null>;
  oneHourVolatilityPercentile: Array<number | null>;
  fourHourEma20: Array<number | null>;
  fourHourEma50: Array<number | null>;
}

export interface SymbolSample {
  symbol: string;
  timestamp: number;
  one_hour_index: number;
  four_hour_index: number;
  candle: Candle;
  market_regime: MarketRegime;
  local_direction: SignalDirection;
  higher_direction: SignalDirection;
  trend_strength: number;
  rsi_value: number;
  rsi_direction: SignalDirection;
  momentum_stabilizing: boolean;
  volume_relative: number;
  volume_confirming: boolean;
  volatility_percentile: number;
  volatility_shock: boolean;
  funding_percentile: number;
  funding_rate: number;
  oi_direction: SignalDirection;
  oi_price_direction: SignalDirection;
  oi_change_percent: number;
  oi_rolling_change_percent: number;
  liquidity: LiquidityFeature;
  member: MarketBreadthMember | null;
  source_timestamp: number;
}

export interface SymbolContext {
  symbol: string;
  oneHour: Candle[];
  fourHour: Candle[];
  samples: SymbolSample[];
  members: Array<{ timestamp: number; member: MarketBreadthMember }>;
}

interface HorizonAccumulator {
  signal_count: number;
  evaluable: number;
  accuracy_wins: number;
  return_sum: number;
  mfe_sum: number;
  mae_sum: number;
}

interface DirectionAccumulator {
  signal_count: number;
  opportunity_sum: number;
  horizons: Record<"4h" | "12h" | "24h", HorizonAccumulator>;
}

interface RiskAccumulator {
  signal_count: number;
  evaluable_24h: number;
  volatility_expansion: number;
  negative_return: number;
  large_move: number;
}

interface NoiseAccumulator {
  total_alerts: number;
  duplicate_alerts_24h: number;
  directional_alerts: number;
  directional_duplicate_alerts_24h: number;
  low_quality_alerts: number;
  per_symbol_alerts: Map<string, number>;
  per_symbol_directional_alerts: Map<string, number>;
  last_alert_at: Map<string, number>;
}

interface ReEvaluationReport {
  schema_version: "hy-r4.11";
  mode: "LOCAL_PIT_SAFE_DRY_RUN_REPLAY";
  generated_at: string;
  evaluation_window: {
    start: string;
    end: string;
    warmup_start: string;
    sample_interval_hours: number;
  };
  source: {
    dataset_count: number;
    sample_timestamps: number;
    symbols: string[];
    price_volume_candles_1h: number;
    price_volume_candles_4h: number;
    funding_points: number;
    open_interest_points: number;
    liquidity_features: number;
    breadth_features: number;
    live_api_called: false;
  };
  input_coverage: {
    candidate_observations: number;
    evaluated_observations: number;
    skipped_warmup_or_missing_inputs: number;
    pit_safe_observations: number;
    pit_unsafe_observations: number;
    liquidity_available: number;
    liquidity_blocked: number;
    breadth_strong: number;
    breadth_normal: number;
    breadth_weak: number;
    breadth_blocked: number;
  };
  signal_count: Record<"LONG_WATCH" | "SHORT_WATCH" | "RISK_WARNING" | "MARKET_STATUS", number>;
  market_status_count: Record<"TREND_UP" | "TREND_DOWN" | "RANGE" | "HIGH_VOL" | "NO_TRADE", number>;
  long_evaluation: DirectionReport;
  short_evaluation: DirectionReport;
  risk_warning_evaluation: {
    signal_count: number;
    evaluable_24h: number;
    volatility_expansion: MetricRate;
    negative_return_probability: MetricRate;
    large_move_frequency: MetricRate;
  };
  noise_analysis: {
    total_alerts: number;
    repeated_alerts_within_24h: number;
    directional_alerts: number;
    repeated_directional_alerts_within_24h: number;
    low_quality_alerts: number;
    same_symbol_alerts_per_symbol_average: number | null;
    same_symbol_alerts_per_symbol_max: number | null;
    directional_alerts_per_symbol_average: number | null;
    directional_alerts_per_symbol_max: number | null;
  };
  alert_quality: {
    directional_signal_count: number;
    evaluable_4h: number;
    precision_4h: number | null;
    false_alert_rate_4h: number | null;
    average_opportunity_score: number | null;
  };
  decision: "NOT_READY" | "READY_FOR_SHADOW" | "READY_FOR_EMAIL";
  assumptions_and_limitations: string[];
  safety: {
    dry_run: true;
    emails_sent: 0;
    persistence_attempts: 0;
    production_connected: false;
    production_modified: false;
    supabase_modified: false;
    vercel_modified: false;
    paper_strategy_modified: false;
    signal_rules_modified: false;
    private_api_called: false;
    auto_trading: false;
    future_data_used: false;
  };
  validation: {
    tests: string;
    typecheck: string;
    lint: string;
  };
}

interface DirectionReport {
  signal_count: number;
  average_opportunity_score: number | null;
  horizons: Record<"4h" | "12h" | "24h", HorizonReport>;
}

interface HorizonReport {
  evaluable: number;
  direction_accuracy: number | null;
  average_return: number | null;
  mfe: number | null;
  mae: number | null;
}

interface MetricRate {
  count: number;
  rate: number | null;
}

async function main(): Promise<void> {
  const files = (await readdir(DATA_DIRECTORY))
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error("No HY-R2B historical datasets found");

  const firstDataset = await loadDataset(files[0]!);
  const allSampleTimestamps = buildSampleTimestamps(firstDataset);
  const evaluationTimestamps = allSampleTimestamps.filter((timestamp) => timestamp >= EVALUATION_START);
  if (evaluationTimestamps.length === 0) throw new Error("No evaluation timestamps found");

  const contexts: SymbolContext[] = [];
  const membersByTimestamp = new Map<number, MarketBreadthMember[]>();
  let totalOneHourCandles = 0;
  let totalFourHourCandles = 0;
  let totalFundingPoints = 0;
  let totalOpenInterestPoints = 0;
  let liquidityFeatureCount = 0;

  for (const fileName of files) {
    const dataset = await loadDataset(fileName);
    const oi = await loadOpenInterest(dataset.symbol);
    const context = buildSymbolContext(dataset, oi, allSampleTimestamps);
    contexts.push(context);
    totalOneHourCandles += context.oneHour.length;
    totalFourHourCandles += context.fourHour.length;
    totalFundingPoints += dataset.fundingRates?.length ?? 0;
    totalOpenInterestPoints += oi?.points.length ?? 0;
    liquidityFeatureCount += allSampleTimestamps.length;
    for (const { timestamp, member } of context.members) {
      const members = membersByTimestamp.get(timestamp) ?? [];
      members.push(member);
      membersByTimestamp.set(timestamp, members);
    }
  }

  const breadthByTimestamp = new Map<number, MarketBreadthFeature>();
  for (const timestamp of evaluationTimestamps) {
    breadthByTimestamp.set(timestamp, calculateMarketBreadthFeature({
      as_of: timestamp,
      members: membersByTimestamp.get(timestamp) ?? [],
      top_universe_size: TOP_UNIVERSE_SIZE,
      minimum_members: BREADTH_MINIMUM_MEMBERS,
    }));
  }

  const report = createReport(
    files.length,
    contexts,
    evaluationTimestamps,
    breadthByTimestamp,
    totalOneHourCandles,
    totalFourHourCandles,
    totalFundingPoints,
    totalOpenInterestPoints,
    liquidityFeatureCount,
  );
  const long = createDirectionAccumulator();
  const short = createDirectionAccumulator();
  const risk = createRiskAccumulator();
  const noise = createNoiseAccumulator();
  const signalCount = report.signal_count;
  const marketStatusCount = report.market_status_count;

  for (const context of contexts) {
    for (const sample of context.samples) {
      const breadth = breadthByTimestamp.get(sample.timestamp);
      if (!breadth) continue;
      const input = buildSignalInput(sample, breadth);
      const result = await runSignalEngineDryRun(input);
      report.input_coverage.evaluated_observations += 1;
      if (result.persistence_eligible) report.input_coverage.pit_safe_observations += 1;
      else report.input_coverage.pit_unsafe_observations += 1;
      if (sample.liquidity.liquidity_score === null) report.input_coverage.liquidity_blocked += 1;
      else report.input_coverage.liquidity_available += 1;
      increment(report.input_coverage, breadth.status === "STRONG"
        ? "breadth_strong"
        : breadth.status === "NORMAL"
          ? "breadth_normal"
          : breadth.status === "WEAK" ? "breadth_weak" : "breadth_blocked");
      for (const signal of result.signals) {
        signalCount[signal.signal_type] += 1;
        marketStatusCount[signal.scores.market_status] += 1;
        recordNoise(noise, signal, sample);
        if (signal.signal_type === "LONG_WATCH") {
          recordDirectional(long, signal, context, sample, "LONG");
        } else if (signal.signal_type === "SHORT_WATCH") {
          recordDirectional(short, signal, context, sample, "SHORT");
        } else if (signal.signal_type === "RISK_WARNING") {
          recordRisk(risk, context, sample);
        }
      }
    }
  }

  report.long_evaluation = renderDirectionReport(long);
  report.short_evaluation = renderDirectionReport(short);
  report.risk_warning_evaluation = renderRiskReport(risk);
  report.noise_analysis = renderNoiseReport(noise, files.length);
  report.alert_quality = renderAlertQuality(long, short);
  report.decision = decide(report, long, short);
  await mkdir(REPORT_DIRECTORY, { recursive: true });
  await writeFile(REPORT_PATH, renderMarkdown(report), "utf8");
  console.log(JSON.stringify({
    report: REPORT_PATH,
    datasets: report.source.dataset_count,
    evaluated: report.input_coverage.evaluated_observations,
    signals: report.signal_count,
    long_watch: report.signal_count.LONG_WATCH,
    short_watch: report.signal_count.SHORT_WATCH,
    risk_warning: report.signal_count.RISK_WARNING,
    market_status: report.signal_count.MARKET_STATUS,
    decision: report.decision,
  }, null, 2));
}

function createReport(
  datasetCount: number,
  contexts: SymbolContext[],
  evaluationTimestamps: number[],
  breadthByTimestamp: Map<number, MarketBreadthFeature>,
  totalOneHourCandles: number,
  totalFourHourCandles: number,
  totalFundingPoints: number,
  totalOpenInterestPoints: number,
  liquidityFeatureCount: number,
): ReEvaluationReport {
  const candidateObservations = contexts.reduce((total, context) => total + context.samples.length, 0);
  return {
    schema_version: "hy-r4.11",
    mode: "LOCAL_PIT_SAFE_DRY_RUN_REPLAY",
    generated_at: new Date().toISOString(),
    evaluation_window: {
      start: new Date(EVALUATION_START).toISOString(),
      end: new Date(EVALUATION_END).toISOString(),
      warmup_start: new Date(WARMUP_START).toISOString(),
      sample_interval_hours: SAMPLE_INTERVAL_MS / (60 * 60 * 1000),
    },
    source: {
      dataset_count: datasetCount,
      sample_timestamps: evaluationTimestamps.length,
      symbols: contexts.map((context) => context.symbol).sort(),
      price_volume_candles_1h: totalOneHourCandles,
      price_volume_candles_4h: totalFourHourCandles,
      funding_points: totalFundingPoints,
      open_interest_points: totalOpenInterestPoints,
      liquidity_features: liquidityFeatureCount,
      breadth_features: breadthByTimestamp.size,
      live_api_called: false,
    },
    input_coverage: {
      candidate_observations: candidateObservations,
      evaluated_observations: 0,
      skipped_warmup_or_missing_inputs: datasetCount * evaluationTimestamps.length - candidateObservations,
      pit_safe_observations: 0,
      pit_unsafe_observations: 0,
      liquidity_available: 0,
      liquidity_blocked: 0,
      breadth_strong: 0,
      breadth_normal: 0,
      breadth_weak: 0,
      breadth_blocked: 0,
    },
    signal_count: {
      LONG_WATCH: 0,
      SHORT_WATCH: 0,
      RISK_WARNING: 0,
      MARKET_STATUS: 0,
    },
    market_status_count: {
      TREND_UP: 0,
      TREND_DOWN: 0,
      RANGE: 0,
      HIGH_VOL: 0,
      NO_TRADE: 0,
    },
    long_evaluation: emptyDirectionReport(),
    short_evaluation: emptyDirectionReport(),
    risk_warning_evaluation: {
      signal_count: 0,
      evaluable_24h: 0,
      volatility_expansion: { count: 0, rate: null },
      negative_return_probability: { count: 0, rate: null },
      large_move_frequency: { count: 0, rate: null },
    },
    noise_analysis: {
      total_alerts: 0,
      repeated_alerts_within_24h: 0,
      directional_alerts: 0,
      repeated_directional_alerts_within_24h: 0,
      low_quality_alerts: 0,
      same_symbol_alerts_per_symbol_average: null,
      same_symbol_alerts_per_symbol_max: null,
      directional_alerts_per_symbol_average: null,
      directional_alerts_per_symbol_max: null,
    },
    alert_quality: {
      directional_signal_count: 0,
      evaluable_4h: 0,
      precision_4h: null,
      false_alert_rate_4h: null,
      average_opportunity_score: null,
    },
    decision: "NOT_READY",
    assumptions_and_limitations: [
      "本次只调用 runSignalEngineDryRun；不写事件、不发送邮件、不连接 Production 或 Supabase。",
      "4h/12h/24h 评价使用信号时间之后第一根达到该 horizon 的 4h 收盘价；MFE/MAE 使用该窗口内的 high/low。",
      "历史缓存没有盘口 spread/depth；R4.8 必填 spread_bps 使用固定 20 bps 的保守风险代理，不是观测值，因此结果不是生产放行依据。",
      "R4.10 breadth 的 top universe 按当时 24h quote volume 排名；未使用静态/当前 universeRank。",
      "Signal rules、阈值、PAPER strategy 未修改；本报告只评估现有 R4.8 规则在新增上下文特征下的研究结果。",
      `Risk warning 的 volatility expansion 定义为未来 24h range >= 当前已知 24h range × ${VOLATILITY_EXPANSION_MULTIPLIER}。`,
      `Large move 定义为 24h aligned return 的绝对值 >= ${(LARGE_MOVE_THRESHOLD * 100).toFixed(0)}%。`,
    ],
    safety: {
      dry_run: true,
      emails_sent: 0,
      persistence_attempts: 0,
      production_connected: false,
      production_modified: false,
      supabase_modified: false,
      vercel_modified: false,
      paper_strategy_modified: false,
      signal_rules_modified: false,
      private_api_called: false,
      auto_trading: false,
      future_data_used: false,
    },
    validation: {
      tests: "pending",
      typecheck: "pending",
      lint: "pending",
    },
  };
}

export function buildSymbolContext(
  dataset: HistoricalDataset,
  oi: OpenInterestCache | null,
  sampleTimestamps: number[],
): SymbolContext {
  const oneHour = (dataset.candles["1h"] ?? []).filter(isUsableCandle).sort(byCloseTime);
  const fourHour = (dataset.candles["4h"] ?? []).filter(isUsableCandle).sort(byCloseTime);
  const fundingRates = (dataset.fundingRates ?? [])
    .filter((point) => Number.isFinite(point.fundingTime) && Number.isFinite(point.fundingRate))
    .sort((left, right) => left.fundingTime - right.fundingTime);
  const oiPoints = oi?.points
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.openInterest))
    .sort((left, right) => left.timestamp - right.timestamp) ?? [];
  const series = deriveSeries(oneHour, fourHour);
  const samples: SymbolSample[] = [];
  const members: Array<{ timestamp: number; member: MarketBreadthMember }> = [];
  const liquidityHistory: LiquidityHistoryPoint[] = [];
  let oneHourIndex = -1;
  let fourHourIndex = -1;
  let fundingIndex = -1;
  let oiIndex = -1;

  for (const timestamp of sampleTimestamps) {
    while (oneHourIndex + 1 < oneHour.length && oneHour[oneHourIndex + 1]!.closeTime <= timestamp) oneHourIndex += 1;
    while (fourHourIndex + 1 < fourHour.length && fourHour[fourHourIndex + 1]!.closeTime <= timestamp) fourHourIndex += 1;
    while (fundingIndex + 1 < fundingRates.length && fundingRates[fundingIndex + 1]!.fundingTime <= timestamp) fundingIndex += 1;
    while (oiIndex + 1 < oiPoints.length && oiPoints[oiIndex + 1]!.timestamp <= timestamp) oiIndex += 1;

    const volumeObservation = calculate24hQuoteVolume(
      oneHour.slice(Math.max(0, oneHourIndex - 23), oneHourIndex + 1),
      timestamp,
    );
    const liquidity = calculateLiquidityFeature({
      symbol: dataset.symbol,
      as_of: timestamp,
      source_timestamp: volumeObservation.source_timestamp,
      quote_volume_24h: volumeObservation.quote_volume_24h,
      sample_count_24h: volumeObservation.sample_count_24h,
      volume_source: volumeObservation.volume_source,
      history: liquidityHistory,
      percentile_window: LIQUIDITY_PERCENTILE_WINDOW,
      minimum_history_samples: LIQUIDITY_PERCENTILE_WINDOW,
    });
    if (
      volumeObservation.quote_volume_24h !== null
      && volumeObservation.sample_count_24h === 24
      && volumeObservation.source_timestamp !== null
    ) {
      liquidityHistory.push({
        timestamp: volumeObservation.source_timestamp,
        quote_volume_24h: volumeObservation.quote_volume_24h,
      });
      if (liquidityHistory.length > LIQUIDITY_PERCENTILE_WINDOW) liquidityHistory.shift();
    }

    const currentFourHour = fourHour[fourHourIndex];
    const previousDay = fourHour[fourHourIndex - 6];
    const member = currentFourHour && previousDay && previousDay.close > 0
      ? {
        symbol: dataset.symbol,
        source_timestamp: currentFourHour.closeTime,
        price_return_24h: currentFourHour.close / previousDay.close - 1,
        quote_volume_24h: liquidity.quote_volume_24h,
      }
      : null;
    if (timestamp >= EVALUATION_START && member) members.push({ timestamp, member });

    if (
      timestamp < EVALUATION_START
      || oneHourIndex < MIN_ONE_HOUR_HISTORY
      || fourHourIndex < MIN_FOUR_HOUR_HISTORY
      || fundingIndex + 1 < MIN_FUNDING_HISTORY
      || oiIndex + 1 < MIN_OI_HISTORY
      || !currentFourHour
    ) continue;

    const fundingPoint = fundingRates[fundingIndex]!;
    const oiPoint = oiPoints[oiIndex]!;
    const oiChangePercent = changePercent(
      oiPoint.openInterest,
      pointAtOrBefore(oiPoints, oiPoint.timestamp - OI_CHANGE_LOOKBACK_MS)?.openInterest,
    );
    const oiRollingChangePercent = changePercent(
      oiPoint.openInterest,
      pointAtOrBefore(oiPoints, oiPoint.timestamp - OI_ROLLING_LOOKBACK_MS)?.openInterest,
    );
    const rsiValue = series.oneHourRsi14[oneHourIndex] ?? 50;
    const sourceTimes = [
      currentFourHour.closeTime,
      fundingPoint.fundingTime,
      oiPoint.timestamp,
      Date.parse(liquidity.source_timestamp),
    ].filter(Number.isFinite);
    samples.push({
      symbol: dataset.symbol,
      timestamp,
      one_hour_index: oneHourIndex,
      four_hour_index: fourHourIndex,
      candle: currentFourHour,
      market_regime: regimeAt(series, fourHourIndex),
      local_direction: directionAt(series.oneHourEma20[oneHourIndex], series.oneHourEma20[oneHourIndex - 5]),
      higher_direction: directionAt(series.fourHourEma20[fourHourIndex], series.fourHourEma20[fourHourIndex - 5]),
      trend_strength: trendStrength(series, fourHourIndex),
      rsi_value: rsiValue,
      rsi_direction: directionFromChange(
        rsiValue - (series.oneHourRsi14[oneHourIndex - 3] ?? 50),
        1,
      ),
      momentum_stabilizing: Math.abs(rsiValue - (series.oneHourRsi14[oneHourIndex - 1] ?? 50)) <= 2,
      volume_relative: series.oneHourVolumeRatio20[oneHourIndex] ?? 0,
      volume_confirming: Boolean(
        series.oneHourVolumeRatio20[oneHourIndex]
        && series.oneHourVolumeRatio20[oneHourIndex]! >= 1
        && ((regimeAt(series, fourHourIndex) === "BULL" && currentFourHour.close >= currentFourHour.open)
          || (regimeAt(series, fourHourIndex) === "BEAR" && currentFourHour.close <= currentFourHour.open)),
      ),
      volatility_percentile: series.oneHourVolatilityPercentile[oneHourIndex] ?? 50,
      volatility_shock: (series.oneHourVolatilityPercentile[oneHourIndex] ?? 50) >= 85,
      funding_percentile: fundingPercentileAt(fundingRates, fundingIndex, fundingPoint),
      funding_rate: fundingPoint.fundingRate,
      oi_direction: directionFromChange(oiChangePercent, 0.05),
      oi_price_direction: priceDirectionAt(
        currentFourHour,
        fourHour[fourHourIndex - 1],
      ),
      oi_change_percent: oiChangePercent,
      oi_rolling_change_percent: oiRollingChangePercent,
      liquidity,
      member,
      source_timestamp: Math.max(...sourceTimes),
    });
  }
  return { symbol: dataset.symbol, oneHour, fourHour, samples, members };
}

export function buildSignalInput(sample: SymbolSample, breadth: MarketBreadthFeature): SignalEngineInput {
  const liquidityState = sample.liquidity.status === "STRONG"
    ? "OK"
    : sample.liquidity.status === "BLOCKED" ? "BLOCKED" : "THIN";
  const breadthAvailable = breadth.status !== "BLOCKED"
    && breadth.advancing_ratio !== null
    && breadth.declining_ratio !== null;
  const dataQuality: EngineDataQuality = sample.liquidity.status === "BLOCKED" || !breadthAvailable
    ? "DEGRADED"
    : "PASS";
  const localRegime = sample.market_regime;
  return {
    symbol: sample.symbol,
    timestamp: new Date(sample.timestamp).toISOString(),
    market_regime: localRegime,
    reference_price: sample.candle.close,
    features: {
      trend: {
        direction: sample.local_direction,
        higher_timeframe_direction: sample.higher_direction,
        strength: sample.trend_strength,
        aligned: sample.local_direction !== "FLAT" && sample.local_direction === sample.higher_direction,
      },
      momentum: {
        value: sample.rsi_value,
        direction: sample.rsi_direction,
        stabilizing: sample.momentum_stabilizing,
      },
      volume: {
        relative: sample.volume_relative,
        confirming: sample.volume_confirming,
      },
      volatility: {
        percentile: sample.volatility_percentile,
        shock: sample.volatility_shock,
      },
      funding_state: {
        percentile: sample.funding_percentile,
        funding_rate: sample.funding_rate,
        extreme: sample.funding_percentile <= 5 || sample.funding_percentile >= 95,
      },
      open_interest_state: {
        direction: sample.oi_direction,
        price_direction: sample.oi_price_direction,
        change_percent: sample.oi_change_percent,
        rolling_change_percent: sample.oi_rolling_change_percent,
        abnormal: Math.abs(sample.oi_change_percent) >= 10 || Math.abs(sample.oi_rolling_change_percent) >= 15,
      },
      liquidity_state: {
        state: liquidityState,
        // R4.10 has no historical order-book spread. Keep the required R4.8 field conservative.
        spread_bps: 20,
      },
      market_breadth: {
        advancing_ratio: breadth.advancing_ratio ?? 0.5,
        trend_agreement: breadthAvailable
          ? Math.max(breadth.advancing_ratio ?? 0, breadth.declining_ratio ?? 0)
          : 0,
        fragile: breadth.status !== "STRONG",
      },
      source_timestamp: new Date(sample.source_timestamp).toISOString(),
      pit_safe: true,
      data_quality: dataQuality,
    },
  };
}

function recordDirectional(
  accumulator: DirectionAccumulator,
  signal: SignalEngineSignal,
  context: SymbolContext,
  sample: SymbolSample,
  side: "LONG" | "SHORT",
): void {
  accumulator.signal_count += 1;
  accumulator.opportunity_sum += signal.opportunity_score;
  for (const [label, hours] of [["4h", 4], ["12h", 12], ["24h", 24]] as const) {
    const horizon = forwardOutcome(context.fourHour, sample.four_hour_index, sample.timestamp, hours, side);
    accumulator.horizons[label].signal_count += 1;
    if (!horizon) continue;
    const metric = accumulator.horizons[label];
    metric.evaluable += 1;
    if (horizon.aligned_return > 0) metric.accuracy_wins += 1;
    metric.return_sum += horizon.aligned_return;
    metric.mfe_sum += horizon.mfe;
    metric.mae_sum += horizon.mae;
  }
}

function recordRisk(
  accumulator: RiskAccumulator,
  context: SymbolContext,
  sample: SymbolSample,
): void {
  accumulator.signal_count += 1;
  const outcome = riskOutcome(context.fourHour, sample.four_hour_index, sample.timestamp);
  if (!outcome) return;
  accumulator.evaluable_24h += 1;
  if (outcome.volatility_expansion) accumulator.volatility_expansion += 1;
  if (outcome.negative_return) accumulator.negative_return += 1;
  if (outcome.large_move) accumulator.large_move += 1;
}

function recordNoise(
  accumulator: NoiseAccumulator,
  signal: SignalEngineSignal,
  sample: SymbolSample,
): void {
  accumulator.total_alerts += 1;
  accumulator.per_symbol_alerts.set(
    sample.symbol,
    (accumulator.per_symbol_alerts.get(sample.symbol) ?? 0) + 1,
  );
  const key = sample.symbol + ":" + signal.signal_type;
  const previous = accumulator.last_alert_at.get(key);
  if (previous !== undefined && sample.timestamp - previous < ALERT_COOLDOWN_MS) {
    accumulator.duplicate_alerts_24h += 1;
  }
  accumulator.last_alert_at.set(key, sample.timestamp);
  if (signal.signal_type === "LONG_WATCH" || signal.signal_type === "SHORT_WATCH") {
    accumulator.directional_alerts += 1;
    accumulator.per_symbol_directional_alerts.set(
      sample.symbol,
      (accumulator.per_symbol_directional_alerts.get(sample.symbol) ?? 0) + 1,
    );
    if (previous !== undefined && sample.timestamp - previous < ALERT_COOLDOWN_MS) {
      accumulator.directional_duplicate_alerts_24h += 1;
    }
  }
  if (signal.event.quality_score < 65) accumulator.low_quality_alerts += 1;
}

function renderDirectionReport(accumulator: DirectionAccumulator): DirectionReport {
  return {
    signal_count: accumulator.signal_count,
    average_opportunity_score: accumulator.signal_count > 0
      ? round(accumulator.opportunity_sum / accumulator.signal_count)
      : null,
    horizons: {
      "4h": renderHorizon(accumulator.horizons["4h"]),
      "12h": renderHorizon(accumulator.horizons["12h"]),
      "24h": renderHorizon(accumulator.horizons["24h"]),
    },
  };
}

function renderHorizon(accumulator: HorizonAccumulator): HorizonReport {
  return {
    evaluable: accumulator.evaluable,
    direction_accuracy: accumulator.evaluable > 0
      ? round(accumulator.accuracy_wins / accumulator.evaluable)
      : null,
    average_return: accumulator.evaluable > 0
      ? round(accumulator.return_sum / accumulator.evaluable)
      : null,
    mfe: accumulator.evaluable > 0 ? round(accumulator.mfe_sum / accumulator.evaluable) : null,
    mae: accumulator.evaluable > 0 ? round(accumulator.mae_sum / accumulator.evaluable) : null,
  };
}

function renderRiskReport(accumulator: RiskAccumulator): ReEvaluationReport["risk_warning_evaluation"] {
  return {
    signal_count: accumulator.signal_count,
    evaluable_24h: accumulator.evaluable_24h,
    volatility_expansion: rate(accumulator.volatility_expansion, accumulator.evaluable_24h),
    negative_return_probability: rate(accumulator.negative_return, accumulator.evaluable_24h),
    large_move_frequency: rate(accumulator.large_move, accumulator.evaluable_24h),
  };
}

function renderNoiseReport(
  accumulator: NoiseAccumulator,
  symbolCount: number,
): ReEvaluationReport["noise_analysis"] {
  const allCounts = [...accumulator.per_symbol_alerts.values()];
  const directionalCounts = [...accumulator.per_symbol_directional_alerts.values()];
  return {
    total_alerts: accumulator.total_alerts,
    repeated_alerts_within_24h: accumulator.duplicate_alerts_24h,
    directional_alerts: accumulator.directional_alerts,
    repeated_directional_alerts_within_24h: accumulator.directional_duplicate_alerts_24h,
    low_quality_alerts: accumulator.low_quality_alerts,
    same_symbol_alerts_per_symbol_average: symbolCount > 0
      ? round(allCounts.reduce((total, value) => total + value, 0) / symbolCount)
      : null,
    same_symbol_alerts_per_symbol_max: allCounts.length > 0 ? Math.max(...allCounts) : null,
    directional_alerts_per_symbol_average: symbolCount > 0
      ? round(directionalCounts.reduce((total, value) => total + value, 0) / symbolCount)
      : null,
    directional_alerts_per_symbol_max: directionalCounts.length > 0 ? Math.max(...directionalCounts) : null,
  };
}

function renderAlertQuality(
  long: DirectionAccumulator,
  short: DirectionAccumulator,
): ReEvaluationReport["alert_quality"] {
  const fourHour = [long.horizons["4h"], short.horizons["4h"]];
  const evaluable = fourHour.reduce((total, metric) => total + metric.evaluable, 0);
  const wins = fourHour.reduce((total, metric) => total + metric.accuracy_wins, 0);
  const directionalSignalCount = long.signal_count + short.signal_count;
  const opportunitySum = long.opportunity_sum + short.opportunity_sum;
  return {
    directional_signal_count: directionalSignalCount,
    evaluable_4h: evaluable,
    precision_4h: evaluable > 0 ? round(wins / evaluable) : null,
    false_alert_rate_4h: evaluable > 0 ? round(1 - wins / evaluable) : null,
    average_opportunity_score: directionalSignalCount > 0
      ? round(opportunitySum / directionalSignalCount)
      : null,
  };
}

function decide(
  report: ReEvaluationReport,
  long: DirectionAccumulator,
  short: DirectionAccumulator,
): ReEvaluationReport["decision"] {
  const directionalCount = long.signal_count + short.signal_count;
  const precision = report.alert_quality.precision_4h;
  const evaluable = report.alert_quality.evaluable_4h;
  if (directionalCount < 50 || evaluable < 50 || precision === null) return "NOT_READY";
  if (precision >= 0.55 && report.alert_quality.false_alert_rate_4h! <= 0.45) {
    return "READY_FOR_SHADOW";
  }
  return "NOT_READY";
}

function forwardOutcome(
  candles: Candle[],
  currentIndex: number,
  timestamp: number,
  hours: number,
  side: "LONG" | "SHORT",
): { aligned_return: number; mfe: number; mae: number } | null {
  const current = candles[currentIndex];
  if (!current || current.close <= 0) return null;
  const target = timestamp + hours * 60 * 60 * 1000;
  const endIndex = firstIndexAtOrAfter(candles, target, currentIndex + 1);
  if (endIndex === -1) return null;
  const window = candles.slice(currentIndex + 1, endIndex + 1);
  if (window.length === 0) return null;
  const futurePrice = candles[endIndex]!.close;
  const alignedReturn = side === "LONG"
    ? futurePrice / current.close - 1
    : current.close / futurePrice - 1;
  const maxHigh = Math.max(...window.map((candle) => candle.high));
  const minLow = Math.min(...window.map((candle) => candle.low));
  const mfe = side === "LONG"
    ? Math.max(0, maxHigh / current.close - 1)
    : Math.max(0, current.close / minLow - 1);
  const mae = side === "LONG"
    ? Math.max(0, 1 - minLow / current.close)
    : Math.max(0, maxHigh / current.close - 1);
  return { aligned_return: alignedReturn, mfe, mae };
}

function riskOutcome(
  candles: Candle[],
  currentIndex: number,
  timestamp: number,
): { volatility_expansion: boolean; negative_return: boolean; large_move: boolean } | null {
  const current = candles[currentIndex];
  const prior = candles.slice(Math.max(0, currentIndex - 5), currentIndex + 1);
  if (!current || current.close <= 0 || prior.length < 6) return null;
  const future = forwardWindow(candles, currentIndex, timestamp, 24);
  if (!future) return null;
  const currentRange = (Math.max(...prior.map((candle) => candle.high))
    - Math.min(...prior.map((candle) => candle.low))) / current.close;
  const futureRange = (Math.max(...future.map((candle) => candle.high))
    - Math.min(...future.map((candle) => candle.low))) / current.close;
  const futurePrice = future.at(-1)!.close;
  const return24h = futurePrice / current.close - 1;
  return {
    volatility_expansion: currentRange > 0 && futureRange >= currentRange * VOLATILITY_EXPANSION_MULTIPLIER,
    negative_return: return24h < 0,
    large_move: Math.abs(return24h) >= LARGE_MOVE_THRESHOLD,
  };
}

function forwardWindow(
  candles: Candle[],
  currentIndex: number,
  timestamp: number,
  hours: number,
): Candle[] | null {
  const endIndex = firstIndexAtOrAfter(
    candles,
    timestamp + hours * 60 * 60 * 1000,
    currentIndex + 1,
  );
  if (endIndex === -1) return null;
  const window = candles.slice(currentIndex + 1, endIndex + 1);
  return window.length > 0 ? window : null;
}

function firstIndexAtOrAfter(candles: Candle[], timestamp: number, start: number): number {
  let low = Math.max(0, start);
  let high = candles.length - 1;
  let answer = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle]!.closeTime >= timestamp) {
      answer = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return answer;
}

function createDirectionAccumulator(): DirectionAccumulator {
  return {
    signal_count: 0,
    opportunity_sum: 0,
    horizons: {
      "4h": createHorizonAccumulator(),
      "12h": createHorizonAccumulator(),
      "24h": createHorizonAccumulator(),
    },
  };
}

function createHorizonAccumulator(): HorizonAccumulator {
  return {
    signal_count: 0,
    evaluable: 0,
    accuracy_wins: 0,
    return_sum: 0,
    mfe_sum: 0,
    mae_sum: 0,
  };
}

function createRiskAccumulator(): RiskAccumulator {
  return {
    signal_count: 0,
    evaluable_24h: 0,
    volatility_expansion: 0,
    negative_return: 0,
    large_move: 0,
  };
}

function createNoiseAccumulator(): NoiseAccumulator {
  return {
    total_alerts: 0,
    duplicate_alerts_24h: 0,
    directional_alerts: 0,
    directional_duplicate_alerts_24h: 0,
    low_quality_alerts: 0,
    per_symbol_alerts: new Map(),
    per_symbol_directional_alerts: new Map(),
    last_alert_at: new Map(),
  };
}

function emptyDirectionReport(): DirectionReport {
  return {
    signal_count: 0,
    average_opportunity_score: null,
    horizons: {
      "4h": emptyHorizonReport(),
      "12h": emptyHorizonReport(),
      "24h": emptyHorizonReport(),
    },
  };
}

function emptyHorizonReport(): HorizonReport {
  return { evaluable: 0, direction_accuracy: null, average_return: null, mfe: null, mae: null };
}

function rate(count: number, denominator: number): MetricRate {
  return { count, rate: denominator > 0 ? round(count / denominator) : null };
}

function increment(record: ReEvaluationReport["input_coverage"], key: string): void {
  const typedKey = key as keyof ReEvaluationReport["input_coverage"];
  const value = record[typedKey];
  if (typeof value === "number") record[typedKey] = value + 1;
}

function deriveSeries(oneHour: Candle[], fourHour: Candle[]): DerivedSeries {
  const oneHourCloses = oneHour.map((candle) => candle.close);
  const fourHourCloses = fourHour.map((candle) => candle.close);
  return {
    oneHour,
    fourHour,
    oneHourEma20: ema(oneHourCloses, 20),
    oneHourRsi14: rsi(oneHourCloses, 14),
    oneHourVolumeRatio20: volumeRatio(oneHour, 20),
    oneHourVolatilityPercentile: rollingPercentile(
      oneHour.map((candle) => (candle.high - candle.low) / candle.close),
      VOLATILITY_LOOKBACK,
    ),
    fourHourEma20: ema(fourHourCloses, 20),
    fourHourEma50: ema(fourHourCloses, 50),
  };
}

export function buildSampleTimestamps(dataset: HistoricalDataset): number[] {
  const fourHour = (dataset.candles["4h"] ?? []).filter(isUsableCandle).sort(byCloseTime);
  const timestamps: number[] = [];
  let nextSample = WARMUP_START;
  for (const candle of fourHour) {
    if (candle.closeTime < WARMUP_START) continue;
    if (candle.closeTime > EVALUATION_END) break;
    if (candle.closeTime < nextSample) continue;
    timestamps.push(candle.closeTime);
    nextSample = candle.closeTime + SAMPLE_INTERVAL_MS;
  }
  return timestamps;
}

function regimeAt(series: DerivedSeries, index: number): MarketRegime {
  const fast = series.fourHourEma20[index];
  const slow = series.fourHourEma50[index];
  const previous = series.fourHourEma20[index - 5];
  if (fast === null || slow === null || previous === null || fast === 0) return "UNKNOWN";
  const slope = (fast - previous) / fast;
  if (fast > slow && slope > 0.002) return "BULL";
  if (fast < slow && slope < -0.002) return "BEAR";
  return "RANGE";
}

function trendStrength(series: DerivedSeries, index: number): number {
  const fast = series.fourHourEma20[index];
  const slow = series.fourHourEma50[index];
  if (fast === null || slow === null || slow === 0) return 0;
  return clamp(Math.abs(fast - slow) / Math.abs(slow) * 5000);
}

function directionAt(current: number | null, previous: number | null): SignalDirection {
  if (current === null || previous === null) return "FLAT";
  if (current > previous) return "UP";
  if (current < previous) return "DOWN";
  return "FLAT";
}

function priceDirectionAt(current: Candle, previous: Candle | undefined): SignalDirection {
  if (!previous || previous.close === 0) return "FLAT";
  return directionFromChange((current.close / previous.close - 1) * 100, 0.1);
}

function directionFromChange(change: number, threshold: number): SignalDirection {
  if (!Number.isFinite(change) || Math.abs(change) <= threshold) return "FLAT";
  return change > 0 ? "UP" : "DOWN";
}

function changePercent(current: number, previous: number | undefined): number {
  if (!previous || previous === 0) return 0;
  return (current / previous - 1) * 100;
}

function rollingPercentile(values: number[], lookback: number): Array<number | null> {
  return values.map((value, index) => {
    if (!Number.isFinite(value)) return null;
    const window = values
      .slice(Math.max(0, index - lookback + 1), index + 1)
      .filter(Number.isFinite);
    if (window.length === 0) return null;
    return window.filter((candidate) => candidate <= value).length / window.length * 100;
  });
}

function fundingPercentileAt(
  points: FundingRatePoint[],
  index: number,
  current: FundingRatePoint,
): number {
  const start = current.fundingTime - FUNDING_LOOKBACK_MS;
  const values = points
    .slice(0, index + 1)
    .filter((point) => point.fundingTime >= start && point.fundingTime <= current.fundingTime)
    .map((point) => point.fundingRate)
    .filter(Number.isFinite);
  if (values.length === 0) return 50;
  return values.filter((value) => value <= current.fundingRate).length / values.length * 100;
}

function pointAtOrBefore(points: OpenInterestPoint[], timestamp: number): OpenInterestPoint | undefined {
  let low = 0;
  let high = points.length - 1;
  let result: OpenInterestPoint | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const point = points[middle]!;
    if (point.timestamp <= timestamp) {
      result = point;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

export async function loadDataset(fileName: string): Promise<HistoricalDataset> {
  return JSON.parse(await readFile(resolve(DATA_DIRECTORY, fileName), "utf8")) as HistoricalDataset;
}

export async function loadOpenInterest(symbol: string): Promise<OpenInterestCache | null> {
  try {
    return JSON.parse(await readFile(resolve(OI_DIRECTORY, symbol + ".json"), "utf8")) as OpenInterestCache;
  } catch {
    return null;
  }
}

function isUsableCandle(candle: Candle): boolean {
  return [
    candle.openTime,
    candle.closeTime,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
  ].every(Number.isFinite) && candle.close > 0 && candle.high >= candle.low;
}

function byCloseTime(left: Candle, right: Candle): number {
  return left.closeTime - right.closeTime;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function format(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "-" : String(value);
}

function renderMarkdown(report: ReEvaluationReport): string {
  const signalRows = Object.entries(report.signal_count)
    .map(([type, count]) => `| ${type} | ${count} |`)
    .join("\n");
  const statusRows = Object.entries(report.market_status_count)
    .map(([status, count]) => `| ${status} | ${count} |`)
    .join("\n");
  return [
    "# HY-R4.11 Signal Re-evaluation",
    "",
    "## Scope and safety boundary",
    "",
    `- Mode: **${report.mode}**`,
    `- Generated: ${report.generated_at}`,
    `- Window: ${report.evaluation_window.start} → ${report.evaluation_window.end}`,
    `- Warm-up: ${report.evaluation_window.warmup_start}`,
    `- Sampling: every ${report.evaluation_window.sample_interval_hours}h`,
    "- Inputs: Price, Volume, Funding, Open Interest, R4.10 Liquidity, R4.10 Market Breadth.",
    "- Existing R4.8 signal rules and thresholds: unchanged.",
    "- Email: not attempted. Persistence: not attempted. Production/Supabase/Vercel: not connected.",
    "- AUTO_TRADING: **FALSE**",
    "",
    "## Data coverage",
    "",
    `- Datasets: ${report.source.dataset_count}; evaluation timestamps: ${report.source.sample_timestamps}.`,
    `- 1h candles: ${report.source.price_volume_candles_1h}; 4h candles: ${report.source.price_volume_candles_4h}.`,
    `- Funding points: ${report.source.funding_points}; Open Interest points: ${report.source.open_interest_points}.`,
    `- Liquidity features: ${report.source.liquidity_features}; breadth features: ${report.source.breadth_features}.`,
    `- Candidate observations: ${report.input_coverage.candidate_observations}.`,
    `- Evaluated observations: ${report.input_coverage.evaluated_observations}.`,
    `- Skipped warm-up/missing inputs: ${report.input_coverage.skipped_warmup_or_missing_inputs}.`,
    `- PIT-safe: ${report.input_coverage.pit_safe_observations}; PIT-unsafe: ${report.input_coverage.pit_unsafe_observations}.`,
    `- Liquidity available/blocked: ${report.input_coverage.liquidity_available}/${report.input_coverage.liquidity_blocked}.`,
    `- Breadth STRONG/NORMAL/WEAK/BLOCKED: ${report.input_coverage.breadth_strong}/${report.input_coverage.breadth_normal}/${report.input_coverage.breadth_weak}/${report.input_coverage.breadth_blocked}.`,
    "",
    "## Signal Count",
    "",
    "| Signal | Count |",
    "| --- | ---: |",
    signalRows,
    "",
    "| Market status | Count |",
    "| --- | ---: |",
    statusRows,
    "",
    "## LONG Evaluation",
    "",
    renderDirectionMarkdown(report.long_evaluation),
    "",
    "## SHORT Evaluation",
    "",
    renderDirectionMarkdown(report.short_evaluation),
    "",
    "## Risk Warning Evaluation",
    "",
    `- Risk warnings: ${report.risk_warning_evaluation.signal_count}; evaluable at 24h: ${report.risk_warning_evaluation.evaluable_24h}.`,
    `- Volatility expansion: ${report.risk_warning_evaluation.volatility_expansion.count} (${format(report.risk_warning_evaluation.volatility_expansion.rate)}).`,
    `- Negative return probability: ${report.risk_warning_evaluation.negative_return_probability.count} (${format(report.risk_warning_evaluation.negative_return_probability.rate)}).`,
    `- Large move frequency: ${report.risk_warning_evaluation.large_move_frequency.count} (${format(report.risk_warning_evaluation.large_move_frequency.rate)}).`,
    "",
    "## Noise Analysis",
    "",
    `- Total alerts: ${report.noise_analysis.total_alerts}.`,
    `- Repeated alerts within 24h: ${report.noise_analysis.repeated_alerts_within_24h}.`,
    `- Directional alerts: ${report.noise_analysis.directional_alerts}; repeated directional alerts within 24h: ${report.noise_analysis.repeated_directional_alerts_within_24h}.`,
    `- Low-quality alerts (quality score < 65): ${report.noise_analysis.low_quality_alerts}.`,
    `- Same-symbol alerts per symbol: average ${format(report.noise_analysis.same_symbol_alerts_per_symbol_average)}, max ${format(report.noise_analysis.same_symbol_alerts_per_symbol_max)}.`,
    `- Directional alerts per symbol: average ${format(report.noise_analysis.directional_alerts_per_symbol_average)}, max ${format(report.noise_analysis.directional_alerts_per_symbol_max)}.`,
    "",
    "## Alert Quality",
    "",
    `- Directional signal count: ${report.alert_quality.directional_signal_count}.`,
    `- 4h evaluable: ${report.alert_quality.evaluable_4h}.`,
    `- Precision (4h): ${format(report.alert_quality.precision_4h)}.`,
    `- False alert rate (4h): ${format(report.alert_quality.false_alert_rate_4h)}.`,
    `- Average opportunity score: ${format(report.alert_quality.average_opportunity_score)}.`,
    "",
    "## Decision",
    "",
    `**${report.decision}**`,
    "",
    "Decision rule: at least 50 directional alerts and 50 evaluable 4h outcomes, with 4h precision ≥ 55%, qualifies for READY_FOR_SHADOW. READY_FOR_EMAIL is not granted by this dry-run.",
    "",
    "## PIT, assumptions, and limitations",
    "",
    `- Future data used: **${report.safety.future_data_used ? "YES" : "NO"}**.`,
    ...report.assumptions_and_limitations.map((item) => `- ${item}`),
    "",
    "## Validation",
    "",
    `- Tests: **${report.validation.tests}**`,
    `- typecheck: **${report.validation.typecheck}**`,
    `- lint: **${report.validation.lint}**`,
    "",
    "## Safety checks",
    "",
    "| Check | Result |",
    "| --- | --- |",
    `| Dry-run | ${report.safety.dry_run ? "PASS" : "FAIL"} |`,
    `| Emails sent | ${report.safety.emails_sent} |`,
    `| Persistence attempts | ${report.safety.persistence_attempts} |`,
    `| Production connected/modified | ${report.safety.production_connected || report.safety.production_modified ? "FAIL" : "PASS"} |`,
    `| Supabase modified | ${report.safety.supabase_modified ? "FAIL" : "PASS"} |`,
    `| Vercel modified | ${report.safety.vercel_modified ? "FAIL" : "PASS"} |`,
    `| PAPER strategy modified | ${report.safety.paper_strategy_modified ? "FAIL" : "PASS"} |`,
    `| Signal rules modified | ${report.safety.signal_rules_modified ? "FAIL" : "PASS"} |`,
    `| Private API called | ${report.safety.private_api_called ? "FAIL" : "PASS"} |`,
    `| AUTO_TRADING | ${report.safety.auto_trading ? "FAIL" : "PASS (false)"} |`,
    "",
  ].join("\n");
}

function renderDirectionMarkdown(report: DirectionReport): string {
  return [
    `- Signal count: ${report.signal_count}.`,
    `- Average opportunity score: ${format(report.average_opportunity_score)}.`,
    "",
    "| Horizon | Evaluable | Direction accuracy | Average return | MFE | MAE |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...(["4h", "12h", "24h"] as const).map((horizon) => {
      const metric = report.horizons[horizon];
      return `| ${horizon} | ${metric.evaluable} | ${format(metric.direction_accuracy)} | ${format(metric.average_return)} | ${format(metric.mfe)} | ${format(metric.mae)} |`;
    }),
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
