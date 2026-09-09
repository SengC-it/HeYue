import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ema, rsi, volumeRatio } from "../lib/core/indicators";
import { runSignalEngineDryRun } from "../lib/signal-engine";
import type {
  Candle,
  FundingRatePoint,
  MarketRegime,
} from "../lib/core/types";
import type {
  EngineDataQuality,
  SignalDirection,
  SignalEngineInput,
  SignalEngineSignal,
} from "../lib/signal-engine";

const DATA_DIRECTORY = resolve("data", "hy-r2b-history-24m");
const OI_DIRECTORY = resolve("data", "hy-r4.2-open-interest-24m");
const REPORT_DIRECTORY = resolve("reports");
const REPORT_JSON = resolve(REPORT_DIRECTORY, "hy-r4.9-signal-dry-run-evaluation.json");
const REPORT_MD = resolve(REPORT_DIRECTORY, "hy-r4.9-signal-dry-run-evaluation.md");

const EVALUATION_START = Date.parse("2024-08-09T00:00:00.000Z");
const EVALUATION_END = Date.parse("2026-08-09T23:59:59.999Z");
const SAMPLE_INTERVAL_MS = 4 * 60 * 60 * 1000;
const VOLATILITY_LOOKBACK = 96;
const FUNDING_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const OI_CHANGE_LOOKBACK_MS = 4 * 60 * 60 * 1000;
const OI_ROLLING_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_ONE_HOUR_HISTORY = 200;
const MIN_FOUR_HOUR_HISTORY = 80;
const MIN_FUNDING_HISTORY = 30;
const MIN_OI_HISTORY = 168;

interface HistoricalDataset {
  symbol: string;
  candles: Partial<Record<"15m" | "1h" | "4h", Candle[]>>;
  fundingRates: FundingRatePoint[];
}

interface OpenInterestPoint {
  timestamp: number;
  openInterest: number;
  openInterestValue: number;
}

interface OpenInterestCache {
  symbol: string;
  source: string;
  coverageStart: string;
  coverageEnd: string;
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

interface SymbolCoverage {
  symbol: string;
  source_start: string | null;
  source_end: string | null;
  funding_points: number;
  oi_points: number;
  evaluated_observations: number;
  skipped_warmup_observations: number;
  pit_safe_observations: number;
  data_quality: Record<EngineDataQuality, number>;
}

interface DryRunReport {
  schema_version: "hy-r4.9";
  mode: "DRY_RUN";
  generated_at: string;
  evaluation_window: {
    start: string;
    end: string;
    sample_interval_hours: number;
  };
  source: {
    price_and_funding_directory: string;
    open_interest_directory: string;
    dataset_count: number;
    dataset_symbols: string[];
    liquidity_history_available: false;
    market_breadth_history_available: false;
  };
  observations: {
    eligible: number;
    evaluated: number;
    skipped_warmup: number;
    pit_safe: number;
    pit_unsafe: number;
    persistence_attempts: 0;
    emails_sent: 0;
  };
  outputs: Record<"LONG_WATCH" | "SHORT_WATCH" | "RISK_WARNING" | "MARKET_STATUS", number>;
  market_status: Record<"TREND_UP" | "TREND_DOWN" | "RANGE" | "HIGH_VOL" | "NO_TRADE", number>;
  risk_reason_codes: Record<string, number>;
  alert_levels: Record<"A" | "B" | "C", number>;
  safety: {
    production_connected: false;
    production_modified: false;
    paper_strategy_modified: false;
    email_attempted: false;
    private_api_called: false;
    auto_trading: false;
    future_data_used: false;
    replay_performed: false;
    directional_watch_blocked_by_missing_required_sources: true;
  };
  data_limitations: string[];
  symbol_coverage: SymbolCoverage[];
  examples: Array<{
    symbol: string;
    timestamp: string;
    signal_type: string;
    market_status: string;
    quality_score: number;
    risk_score: number;
    confidence: number;
    reason_codes: string[];
  }>;
}

async function main(): Promise<void> {
  const files = (await readdir(DATA_DIRECTORY))
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();
  const report: DryRunReport = {
    schema_version: "hy-r4.9",
    mode: "DRY_RUN",
    generated_at: new Date().toISOString(),
    evaluation_window: {
      start: new Date(EVALUATION_START).toISOString(),
      end: new Date(EVALUATION_END).toISOString(),
      sample_interval_hours: SAMPLE_INTERVAL_MS / (60 * 60 * 1000),
    },
    source: {
      price_and_funding_directory: "data/hy-r2b-history-24m",
      open_interest_directory: "data/hy-r4.2-open-interest-24m",
      dataset_count: files.length,
      dataset_symbols: [],
      liquidity_history_available: false,
      market_breadth_history_available: false,
    },
    observations: {
      eligible: 0,
      evaluated: 0,
      skipped_warmup: 0,
      pit_safe: 0,
      pit_unsafe: 0,
      persistence_attempts: 0,
      emails_sent: 0,
    },
    outputs: {
      LONG_WATCH: 0,
      SHORT_WATCH: 0,
      RISK_WARNING: 0,
      MARKET_STATUS: 0,
    },
    market_status: {
      TREND_UP: 0,
      TREND_DOWN: 0,
      RANGE: 0,
      HIGH_VOL: 0,
      NO_TRADE: 0,
    },
    risk_reason_codes: {},
    alert_levels: { A: 0, B: 0, C: 0 },
    safety: {
      production_connected: false,
      production_modified: false,
      paper_strategy_modified: false,
      email_attempted: false,
      private_api_called: false,
      auto_trading: false,
      future_data_used: false,
      replay_performed: false,
      directional_watch_blocked_by_missing_required_sources: true,
    },
    data_limitations: [
      "历史数据没有盘口深度/点差序列，因此 liquidity_state 使用 BLOCKED，而不是推导一个流动性值。",
      "历史数据没有跨币 market breadth 序列，因此 market_breadth 使用 neutral + fragile 标记。",
      "本次只评估触发输出，不读取未来价格，也不执行 4h/12h/24h replay。",
      "由于 R4.8 方向性观察要求 PASS 数据质量和可用流动性，缺少上述来源时 LONG_WATCH/SHORT_WATCH 必须被阻断。",
    ],
    symbol_coverage: [],
    examples: [],
  };

  for (const fileName of files) {
    const dataset = JSON.parse(
      await readFile(resolve(DATA_DIRECTORY, fileName), "utf8"),
    ) as HistoricalDataset;
    const oi = await loadOpenInterest(dataset.symbol);
    report.source.dataset_symbols.push(dataset.symbol);
    const coverage = await evaluateDataset(dataset, oi, report);
    report.symbol_coverage.push(coverage);
  }

  report.source.dataset_symbols.sort();
  report.symbol_coverage.sort((left, right) => left.symbol.localeCompare(right.symbol));
  await mkdir(REPORT_DIRECTORY, { recursive: true });
  await writeFile(REPORT_JSON, JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(REPORT_MD, renderMarkdown(report), "utf8");
  console.log(JSON.stringify({
    reportJson: REPORT_JSON,
    reportMarkdown: REPORT_MD,
    datasets: report.source.dataset_count,
    eligible: report.observations.eligible,
    evaluated: report.observations.evaluated,
    outputs: report.outputs,
    marketStatus: report.market_status,
    directionalWatchCount: report.outputs.LONG_WATCH + report.outputs.SHORT_WATCH,
  }, null, 2));
}

async function evaluateDataset(
  dataset: HistoricalDataset,
  oi: OpenInterestCache | null,
  report: DryRunReport,
): Promise<SymbolCoverage> {
  const oneHour = (dataset.candles["1h"] ?? []).filter(isUsableCandle);
  const fourHour = (dataset.candles["4h"] ?? []).filter(isUsableCandle);
  const fundingRates = (dataset.fundingRates ?? [])
    .filter((point) => Number.isFinite(point.fundingTime) && Number.isFinite(point.fundingRate))
    .sort((left, right) => left.fundingTime - right.fundingTime);
  const oiPoints = oi?.points
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.openInterest))
    .sort((left, right) => left.timestamp - right.timestamp) ?? [];
  const series = deriveSeries(oneHour, fourHour);
  const coverage: SymbolCoverage = {
    symbol: dataset.symbol,
    source_start: oneHour[0] ? new Date(oneHour[0].closeTime).toISOString() : null,
    source_end: oneHour.at(-1) ? new Date(oneHour.at(-1)!.closeTime).toISOString() : null,
    funding_points: fundingRates.length,
    oi_points: oiPoints.length,
    evaluated_observations: 0,
    skipped_warmup_observations: 0,
    pit_safe_observations: 0,
    data_quality: { PASS: 0, DEGRADED: 0, BLOCKED: 0 },
  };

  let nextSampleTime = EVALUATION_START;
  let fourHourIndex = -1;
  let fundingIndex = -1;
  let oiIndex = -1;
  let eligible = 0;
  for (let index = 0; index < oneHour.length; index += 1) {
    const candle = oneHour[index];
    if (candle.closeTime < EVALUATION_START || candle.closeTime > EVALUATION_END) continue;
    if (candle.closeTime < nextSampleTime) continue;
    nextSampleTime = candle.closeTime + SAMPLE_INTERVAL_MS;
    eligible += 1;
    report.observations.eligible += 1;

    while (fourHourIndex + 1 < fourHour.length && fourHour[fourHourIndex + 1].closeTime <= candle.closeTime) {
      fourHourIndex += 1;
    }
    while (fundingIndex + 1 < fundingRates.length && fundingRates[fundingIndex + 1].fundingTime <= candle.closeTime) {
      fundingIndex += 1;
    }
    while (oiIndex + 1 < oiPoints.length && oiPoints[oiIndex + 1].timestamp <= candle.closeTime) {
      oiIndex += 1;
    }

    if (
      index < MIN_ONE_HOUR_HISTORY
      || fourHourIndex < MIN_FOUR_HOUR_HISTORY
      || fundingIndex + 1 < MIN_FUNDING_HISTORY
      || oiIndex + 1 < MIN_OI_HISTORY
    ) {
      report.observations.skipped_warmup += 1;
      coverage.skipped_warmup_observations += 1;
      continue;
    }

    const fundingPoint = fundingRates[fundingIndex]!;
    const oiPoint = oiPoints[oiIndex]!;
    const input = buildInput(
      dataset.symbol,
      candle,
      index,
      fourHour,
      fourHourIndex,
      series,
      fundingRates,
      fundingIndex,
      oiPoints,
      oiIndex,
      fundingPoint,
      oiPoint,
    );
    const result = await runSignalEngineDryRun(input);
    coverage.evaluated_observations += 1;
    report.observations.evaluated += 1;
    coverage.data_quality[input.features.data_quality] += 1;
    if (result.persistence_eligible) {
      report.observations.pit_safe += 1;
      coverage.pit_safe_observations += 1;
    } else {
      report.observations.pit_unsafe += 1;
    }
    collectResults(report, result.signals, dataset.symbol, candle.closeTime);
  }

  if (eligible === 0 && oneHour.length > 0) {
    report.observations.skipped_warmup += 1;
    coverage.skipped_warmup_observations += 1;
  }
  return coverage;
}

function buildInput(
  symbol: string,
  candle: Candle,
  oneHourIndex: number,
  fourHour: Candle[],
  fourHourIndex: number,
  series: DerivedSeries,
  fundingRates: FundingRatePoint[],
  fundingIndex: number,
  oiPoints: OpenInterestPoint[],
  oiIndex: number,
  fundingPoint: FundingRatePoint,
  oiPoint: OpenInterestPoint,
): SignalEngineInput {
  const timestamp = new Date(candle.closeTime).toISOString();
  const regime = regimeAt(series, fourHourIndex);
  const localDirection = directionAt(
    series.oneHourEma20[oneHourIndex],
    series.oneHourEma20[oneHourIndex - 5],
  );
  const higherDirection = directionAt(
    series.fourHourEma20[fourHourIndex],
    series.fourHourEma20[fourHourIndex - 5],
  );
  const priceDirection = priceDirectionAt(candle, series.oneHour[oneHourIndex - 4]);
  const oiChangePercent = changePercent(
    oiPoint.openInterest,
    pointAtOrBefore(oiPoints, oiPoint.timestamp - OI_CHANGE_LOOKBACK_MS)?.openInterest,
  );
  const oiRollingChangePercent = changePercent(
    oiPoint.openInterest,
    pointAtOrBefore(oiPoints, oiPoint.timestamp - OI_ROLLING_LOOKBACK_MS)?.openInterest,
  );
  const fundingPercentile = fundingPercentileAt(fundingRates, fundingIndex, fundingPoint);
  const requiredMarketDataAvailable = Boolean(fundingPoint && oiPoint);
  const dataQuality: EngineDataQuality = requiredMarketDataAvailable ? "DEGRADED" : "BLOCKED";
  return {
    symbol,
    timestamp,
    market_regime: regime,
    reference_price: candle.close,
    features: {
      trend: {
        direction: localDirection,
        higher_timeframe_direction: higherDirection,
        strength: trendStrength(series, fourHourIndex),
        aligned: localDirection !== "FLAT" && localDirection === higherDirection,
      },
      momentum: {
        value: series.oneHourRsi14[oneHourIndex] ?? 50,
        direction: directionFromChange(
          (series.oneHourRsi14[oneHourIndex] ?? 50) - (series.oneHourRsi14[oneHourIndex - 3] ?? 50),
          1,
        ),
        stabilizing: Math.abs(
          (series.oneHourRsi14[oneHourIndex] ?? 50) - (series.oneHourRsi14[oneHourIndex - 1] ?? 50),
        ) <= 2,
      },
      volume: {
        relative: series.oneHourVolumeRatio20[oneHourIndex] ?? 0,
        confirming: Boolean(
          series.oneHourVolumeRatio20[oneHourIndex]
          && series.oneHourVolumeRatio20[oneHourIndex]! >= 1
          && ((regime === "BULL" && candle.close >= candle.open)
            || (regime === "BEAR" && candle.close <= candle.open)),
        ),
      },
      volatility: {
        percentile: series.oneHourVolatilityPercentile[oneHourIndex] ?? 50,
        shock: (series.oneHourVolatilityPercentile[oneHourIndex] ?? 50) >= 85,
      },
      funding_state: {
        percentile: fundingPercentile,
        funding_rate: fundingPoint?.fundingRate,
        extreme: fundingPercentile <= 5 || fundingPercentile >= 95,
      },
      open_interest_state: {
        direction: directionFromChange(oiChangePercent, 0.05),
        price_direction: priceDirection,
        change_percent: oiChangePercent,
        rolling_change_percent: oiRollingChangePercent,
        abnormal: Math.abs(oiChangePercent) >= 10 || Math.abs(oiRollingChangePercent) >= 15,
      },
      liquidity_state: {
        state: "BLOCKED",
        spread_bps: 0,
      },
      market_breadth: {
        advancing_ratio: 0.5,
        trend_agreement: 0,
        fragile: true,
      },
      source_timestamp: timestamp,
      pit_safe: true,
      data_quality: dataQuality,
    },
  };
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

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function directionAt(current: number | null, previous: number | null): SignalDirection {
  if (current === null || previous === null) return "FLAT";
  if (current > previous) return "UP";
  if (current < previous) return "DOWN";
  return "FLAT";
}

function priceDirectionAt(current: Candle, previous: Candle | undefined): SignalDirection {
  if (!previous || previous.close === 0) return "FLAT";
  const change = (current.close - previous.close) / previous.close;
  return directionFromChange(change * 100, 0.1);
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
    const rank = window.filter((candidate) => candidate <= value).length;
    return rank / window.length * 100;
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

function pointAtOrBefore(
  points: OpenInterestPoint[],
  timestamp: number,
): OpenInterestPoint | undefined {
  let low = 0;
  let high = points.length - 1;
  let result: OpenInterestPoint | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const point = points[middle];
    if (point.timestamp <= timestamp) {
      result = point;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function isUsableCandle(candle: Candle): boolean {
  return [candle.openTime, candle.closeTime, candle.open, candle.high, candle.low, candle.close, candle.volume]
    .every(Number.isFinite) && candle.close > 0 && candle.high >= candle.low;
}

async function loadOpenInterest(symbol: string): Promise<OpenInterestCache | null> {
  try {
    return JSON.parse(
      await readFile(resolve(OI_DIRECTORY, symbol + ".json"), "utf8"),
    ) as OpenInterestCache;
  } catch {
    return null;
  }
}

function collectResults(
  report: DryRunReport,
  signals: SignalEngineSignal[],
  symbol: string,
  timestamp: number,
): void {
  const firstSignal = signals[0];
  if (!firstSignal) return;
  report.market_status[firstSignal.scores.market_status] += 1;
  for (const reason of firstSignal.scores.risk_reason_codes) {
    report.risk_reason_codes[reason] = (report.risk_reason_codes[reason] ?? 0) + 1;
  }
  for (const signal of signals) {
    report.outputs[signal.signal_type] += 1;
    report.alert_levels[signal.alert_level] += 1;
    if (report.examples.length < 12) {
      report.examples.push({
        symbol,
        timestamp: new Date(timestamp).toISOString(),
        signal_type: signal.signal_type,
        market_status: signal.scores.market_status,
        quality_score: signal.event.quality_score,
        risk_score: signal.event.risk_score,
        confidence: signal.event.confidence,
        reason_codes: signal.event.reason_codes,
      });
    }
  }
}

function renderMarkdown(report: DryRunReport): string {
  const outputRows = Object.entries(report.outputs)
    .map(([type, count]) => `| ${type} | ${count} |`)
    .join("\n");
  const statusRows = Object.entries(report.market_status)
    .map(([status, count]) => `| ${status} | ${count} |`)
    .join("\n");
  const reasonRows = Object.entries(report.risk_reason_codes)
    .sort(([, left], [, right]) => right - left)
    .map(([reason, count]) => `| ${reason} | ${count} |`)
    .join("\n") || "| none | 0 |";
  const exampleRows = report.examples
    .map((example) => `| ${example.timestamp} | ${example.symbol} | ${example.signal_type} | ${example.market_status} | ${example.risk_score} | ${example.reason_codes.join(", ")} |`)
    .join("\n") || "| none | - | - | - | - | - |";
  return [
    "# HY-R4.9 Signal Dry Run Evaluation",
    "",
    "## Run boundary",
    "",
    `- Mode: **${report.mode}**`,
    `- Generated: ${report.generated_at}`,
    `- Window: ${report.evaluation_window.start} → ${report.evaluation_window.end}`,
    `- Sampling: every ${report.evaluation_window.sample_interval_hours} hours`
      .replace("hours", "h"),
    `- Datasets: ${report.source.dataset_count}`,
    "- Supabase/Production: not connected",
    "- Email: not attempted",
    "- PAPER strategy: not modified",
    "- AUTO_TRADING: false",
    "",
    "## Evaluation totals",
    "",
    `- Eligible observations: ${report.observations.eligible}`,
    `- Evaluated: ${report.observations.evaluated}`,
    `- Warm-up skipped: ${report.observations.skipped_warmup}`,
    `- PIT-safe: ${report.observations.pit_safe}`,
    `- Future data used: ${report.safety.future_data_used ? "YES" : "NO"}`,
    "",
    "| Output | Count |",
    "| --- | ---: |",
    outputRows,
    "",
    "| Market status | Count |",
    "| --- | ---: |",
    statusRows,
    "",
    "| Risk reason | Count |",
    "| --- | ---: |",
    reasonRows,
    "",
    "## Sample outputs",
    "",
    "| Timestamp | Symbol | Type | Market status | Risk | Reasons |",
    "| --- | --- | --- | --- | ---: | --- |",
    exampleRows,
    "",
    "## Data limitations and interpretation",
    "",
    ...report.data_limitations.map((limitation) => `- ${limitation}`),
    "",
    "本报告只评价 R4.8 规则在本地历史输入上的 dry-run 输出，不是生产信号、交易建议或收益回测。",
    "",
    "## Safety checks",
    "",
    "| Check | Result |",
    "| --- | --- |",
    `| Production connected | ${report.safety.production_connected ? "FAIL" : "PASS"} |`,
    `| Production modified | ${report.safety.production_modified ? "FAIL" : "PASS"} |`,
    `| Email attempted | ${report.safety.email_attempted ? "FAIL" : "PASS"} |`,
    `| Private API called | ${report.safety.private_api_called ? "FAIL" : "PASS"} |`,
    `| AUTO_TRADING | ${report.safety.auto_trading ? "FAIL" : "PASS (false)"} |`,
    `| Replay performed | ${report.safety.replay_performed ? "YES" : "NO"} |`,
    "",
  ].join("\n");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
