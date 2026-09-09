import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildSampleTimestamps,
  buildSignalInput,
  buildSymbolContext,
  loadDataset,
  loadOpenInterest,
  type SymbolContext,
  type SymbolSample,
} from "./run-hy-r4-11-signal-re-evaluation";
import { runSignalEngineDryRun } from "../lib/signal-engine";
import type { SignalEngineSignal } from "../lib/signal-engine";
import {
  createSignalQualityState,
  defaultSignalQualityPolicy,
  optimizeSignalOutputs,
} from "../lib/signal-quality";
import type {
  SignalQualityPolicy,
} from "../lib/signal-quality";
import type { Candle } from "../lib/core/types";
import { calculateMarketBreadthFeature } from "../lib/market-context";
import type { MarketBreadthFeature, MarketBreadthMember } from "../lib/market-context";

const DATA_DIRECTORY = resolve("data", "hy-r2b-history-24m");
const REPORT_DIRECTORY = resolve("reports");
const REPORT_PATH = resolve(REPORT_DIRECTORY, "hy-r4.12-signal-quality-optimization.md");
const EVALUATION_START = Date.parse("2024-08-09T00:00:00.000Z");
const EVALUATION_END = Date.parse("2026-08-09T23:59:59.999Z");
const TOP_UNIVERSE_SIZE = 10;
const BREADTH_MINIMUM_MEMBERS = 35;
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const LARGE_MOVE_THRESHOLD = 0.02;
const VOLATILITY_EXPANSION_MULTIPLIER = 1.25;

type SignalTypeKey = "LONG_WATCH" | "SHORT_WATCH" | "RISK_WARNING" | "MARKET_STATUS";
type MarketStatusKey = "TREND_UP" | "TREND_DOWN" | "RANGE" | "HIGH_VOL" | "NO_TRADE";
type HorizonKey = "4h" | "12h" | "24h";

interface HorizonAccumulator {
  signal_count: number;
  evaluable: number;
  wins: number;
  return_sum: number;
  mfe_sum: number;
  mae_sum: number;
}

interface DirectionAccumulator {
  signal_count: number;
  opportunity_sum: number;
  horizons: Record<HorizonKey, HorizonAccumulator>;
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
  repeated_alerts_24h: number;
  directional_alerts: number;
  repeated_directional_alerts_24h: number;
  low_quality_alerts: number;
  per_symbol_alerts: Map<string, number>;
  per_symbol_directional_alerts: Map<string, number>;
  last_alert_at: Map<string, number>;
}

interface EvaluationAccumulator {
  signal_count: Record<SignalTypeKey, number>;
  market_status_count: Record<MarketStatusKey, number>;
  long: DirectionAccumulator;
  short: DirectionAccumulator;
  risk: RiskAccumulator;
  noise: NoiseAccumulator;
}

interface DirectionReport {
  signal_count: number;
  average_opportunity_score: number | null;
  horizons: Record<HorizonKey, HorizonReport>;
}

interface HorizonReport {
  evaluable: number;
  direction_accuracy: number | null;
  average_return: number | null;
  mfe: number | null;
  mae: number | null;
}

interface RateMetric {
  count: number;
  rate: number | null;
}

interface EvaluationReport {
  signal_count: Record<"before" | "after", Record<SignalTypeKey, number>>;
  market_status_count: Record<"before" | "after", Record<MarketStatusKey, number>>;
  long_evaluation: Record<"before" | "after", DirectionReport>;
  short_evaluation: Record<"before" | "after", DirectionReport>;
  risk_warning_evaluation: Record<"before" | "after", {
    signal_count: number;
    evaluable_24h: number;
    volatility_expansion: RateMetric;
    negative_return_probability: RateMetric;
    large_move_frequency: RateMetric;
  }>;
  noise_analysis: Record<"before" | "after", NoiseReport>;
  alert_quality: Record<"before" | "after", AlertQualityReport>;
}

interface NoiseReport {
  total_alerts: number;
  repeated_alerts_within_24h: number;
  directional_alerts: number;
  repeated_directional_alerts_within_24h: number;
  low_quality_alerts: number;
  same_symbol_alerts_per_symbol_average: number | null;
  same_symbol_alerts_per_symbol_max: number | null;
  directional_alerts_per_symbol_average: number | null;
  directional_alerts_per_symbol_max: number | null;
}

interface AlertQualityReport {
  directional_signal_count: number;
  evaluable_4h: number;
  precision_4h: number | null;
  false_alert_rate_4h: number | null;
  average_opportunity_score: number | null;
}

interface OptimizationReport {
  schema_version: "hy-r4.12";
  mode: "LOCAL_PIT_SAFE_DRY_RUN_FILTER_REPLAY";
  generated_at: string;
  evaluation_window: {
    start: string;
    end: string;
    sample_timestamps: number;
    datasets: number;
  };
  policy: SignalQualityPolicy;
  input_coverage: {
    evaluated_observations: number;
    pit_safe_observations: number;
    pit_unsafe_observations: number;
    liquidity_available: number;
    liquidity_blocked: number;
    breadth_strong: number;
    breadth_normal: number;
    breadth_weak: number;
    breadth_blocked: number;
  };
  filtered: {
    total: number;
    by_reason: Record<string, number>;
  };
  evaluation: EvaluationReport;
  decision: "NOT_READY" | "READY_FOR_SHADOW" | "READY_FOR_EMAIL";
  boundaries: {
    new_indicators: false;
    machine_learning: false;
    signal_rules_modified: false;
    production_modified: false;
    supabase_modified: false;
    vercel_modified: false;
    paper_strategy_modified: false;
    emails_sent: 0;
    persistence_attempts: 0;
    private_api_called: false;
    auto_trading: false;
    future_data_used: false;
  };
  assumptions: string[];
  validation: {
    tests: string;
    typecheck: string;
    lint: string;
  };
}

async function main(): Promise<void> {
  const files = (await (await import("node:fs/promises")).readdir(DATA_DIRECTORY))
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error("No HY-R2B historical datasets found");
  const firstDataset = await loadDataset(files[0]!);
  const allSampleTimestamps = buildSampleTimestamps(firstDataset);
  const evaluationTimestamps = allSampleTimestamps.filter((timestamp) => (
    timestamp >= EVALUATION_START && timestamp <= EVALUATION_END
  ));
  const contexts: SymbolContext[] = [];
  const membersByTimestamp = new Map<number, MarketBreadthMember[]>();
  for (const fileName of files) {
    const dataset = await loadDataset(fileName);
    const context = buildSymbolContext(dataset, await loadOpenInterest(dataset.symbol), allSampleTimestamps);
    contexts.push(context);
    for (const { timestamp, member } of context.members) {
      const members = membersByTimestamp.get(timestamp) ?? [];
      members.push(member);
      membersByTimestamp.set(timestamp, members);
    }
  }
  const breadthByTimestamp = new Map<number, MarketBreadthFeature>();
  for (const timestamp of evaluationTimestamps) {
    breadthByTimestamp.set(timestamp, calculateBreadth(timestamp, membersByTimestamp.get(timestamp) ?? []));
  }

  const before = createEvaluationAccumulator();
  const after = createEvaluationAccumulator();
  const qualityState = createSignalQualityState();
  const filteredByReason: Record<string, number> = {};
  let evaluatedObservations = 0;
  let pitSafeObservations = 0;
  let pitUnsafeObservations = 0;
  let liquidityAvailable = 0;
  let liquidityBlocked = 0;
  const breadthCounts = { breadth_strong: 0, breadth_normal: 0, breadth_weak: 0, breadth_blocked: 0 };

  for (const context of contexts) {
    for (const sample of context.samples) {
      const breadth = breadthByTimestamp.get(sample.timestamp);
      if (!breadth) continue;
      const input = buildSignalInput(sample, breadth);
      const engineResult = await runSignalEngineDryRun(input);
      evaluatedObservations += 1;
      if (engineResult.persistence_eligible) pitSafeObservations += 1;
      else pitUnsafeObservations += 1;
      if (sample.liquidity.liquidity_score === null) liquidityBlocked += 1;
      else liquidityAvailable += 1;
      incrementBreadthCount(breadthCounts, breadth.status);
      recordSignals(before, engineResult.signals, context, sample);
      const optimized = optimizeSignalOutputs(engineResult.signals, qualityState);
      for (const filtered of optimized.filtered) {
        filteredByReason[filtered.reason] = (filteredByReason[filtered.reason] ?? 0) + 1;
      }
      recordSignals(after, optimized.signals, context, sample);
    }
  }

  const report: OptimizationReport = {
    schema_version: "hy-r4.12",
    mode: "LOCAL_PIT_SAFE_DRY_RUN_FILTER_REPLAY",
    generated_at: new Date().toISOString(),
    evaluation_window: {
      start: new Date(EVALUATION_START).toISOString(),
      end: new Date(EVALUATION_END).toISOString(),
      sample_timestamps: evaluationTimestamps.length,
      datasets: files.length,
    },
    policy: defaultSignalQualityPolicy,
    input_coverage: {
      evaluated_observations: evaluatedObservations,
      pit_safe_observations: pitSafeObservations,
      pit_unsafe_observations: pitUnsafeObservations,
      liquidity_available: liquidityAvailable,
      liquidity_blocked: liquidityBlocked,
      ...breadthCounts,
    },
    filtered: {
      total: Object.values(filteredByReason).reduce((total, count) => total + count, 0),
      by_reason: filteredByReason,
    },
    evaluation: {
      signal_count: { before: before.signal_count, after: after.signal_count },
      market_status_count: { before: before.market_status_count, after: after.market_status_count },
      long_evaluation: { before: renderDirection(before.long), after: renderDirection(after.long) },
      short_evaluation: { before: renderDirection(before.short), after: renderDirection(after.short) },
      risk_warning_evaluation: {
        before: renderRisk(before.risk),
        after: renderRisk(after.risk),
      },
      noise_analysis: {
        before: renderNoise(before.noise, files.length),
        after: renderNoise(after.noise, files.length),
      },
      alert_quality: {
        before: renderQuality(before.long, before.short),
        after: renderQuality(after.long, after.short),
      },
    },
    decision: "NOT_READY",
    boundaries: {
      new_indicators: false,
      machine_learning: false,
      signal_rules_modified: false,
      production_modified: false,
      supabase_modified: false,
      vercel_modified: false,
      paper_strategy_modified: false,
      emails_sent: 0,
      persistence_attempts: 0,
      private_api_called: false,
      auto_trading: false,
      future_data_used: false,
    },
    assumptions: [
      "本次只对现有 R4.8 Signal Engine 输出做后处理；指标计算、评分器、signal rules 与阈值未改。",
      "过滤只使用现有 market_status、risk_level_score、confidence、opportunity_score 与既有 reason_codes。",
      "MARKET_STATUS 状态相同的提醒在 24h 内去重，状态变化立即放行，24h 后允许 heartbeat。",
      "同币方向提醒冷却 24h；同币风险提醒冷却 12h；风险/机会分数至少提升 10 分才视为升级。",
      "R4.10 breadth/liquidity 作为输入上下文使用；没有新增指标，也没有接入 Production。",
      "4h/12h/24h forward replay 只使用信号时间之后的历史 Kline；MFE/MAE 是窗口内 high/low 的幅度。",
      "历史没有真实盘口 spread，因此 R4.8 必填 spread_bps 仍为 20 bps 保守代理；结果不构成邮件或生产放行。",
    ],
    validation: {
      tests: "pending",
      typecheck: "pending",
      lint: "pending",
    },
  };
  report.decision = decide(report);
  await mkdir(REPORT_DIRECTORY, { recursive: true });
  await writeFile(REPORT_PATH, renderMarkdown(report), "utf8");
  console.log(JSON.stringify({
    report: REPORT_PATH,
    evaluated: report.input_coverage.evaluated_observations,
    filtered: report.filtered,
    before: report.evaluation.signal_count.before,
    after: report.evaluation.signal_count.after,
    decision: report.decision,
  }, null, 2));
}

function calculateBreadth(
  timestamp: number,
  members: MarketBreadthMember[],
): MarketBreadthFeature {
  return calculateMarketBreadthFeature({
    as_of: timestamp,
    members,
    top_universe_size: TOP_UNIVERSE_SIZE,
    minimum_members: BREADTH_MINIMUM_MEMBERS,
  });
}

function recordSignals(
  accumulator: EvaluationAccumulator,
  signals: readonly SignalEngineSignal[],
  context: SymbolContext,
  sample: SymbolSample,
): void {
  for (const signal of signals) {
    accumulator.signal_count[signal.signal_type] += 1;
    accumulator.market_status_count[signal.scores.market_status] += 1;
    recordNoise(accumulator.noise, signal, sample);
    if (signal.signal_type === "LONG_WATCH") {
      recordDirectional(accumulator.long, signal, context, sample, "LONG");
    } else if (signal.signal_type === "SHORT_WATCH") {
      recordDirectional(accumulator.short, signal, context, sample, "SHORT");
    } else if (signal.signal_type === "RISK_WARNING") {
      recordRisk(accumulator.risk, context, sample);
    }
  }
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
  for (const [horizon, hours] of [["4h", 4], ["12h", 12], ["24h", 24]] as const) {
    const outcome = forwardOutcome(context.fourHour, sample.four_hour_index, sample.timestamp, hours, side);
    accumulator.horizons[horizon].signal_count += 1;
    if (!outcome) continue;
    const metric = accumulator.horizons[horizon];
    metric.evaluable += 1;
    if (outcome.aligned_return > 0) metric.wins += 1;
    metric.return_sum += outcome.aligned_return;
    metric.mfe_sum += outcome.mfe;
    metric.mae_sum += outcome.mae;
  }
}

function recordRisk(accumulator: RiskAccumulator, context: SymbolContext, sample: SymbolSample): void {
  accumulator.signal_count += 1;
  const outcome = riskOutcome(context.fourHour, sample.four_hour_index, sample.timestamp);
  if (!outcome) return;
  accumulator.evaluable_24h += 1;
  if (outcome.volatility_expansion) accumulator.volatility_expansion += 1;
  if (outcome.negative_return) accumulator.negative_return += 1;
  if (outcome.large_move) accumulator.large_move += 1;
}

function recordNoise(accumulator: NoiseAccumulator, signal: SignalEngineSignal, sample: SymbolSample): void {
  accumulator.total_alerts += 1;
  accumulator.per_symbol_alerts.set(sample.symbol, (accumulator.per_symbol_alerts.get(sample.symbol) ?? 0) + 1);
  const key = sample.symbol + ":" + signal.signal_type;
  const previous = accumulator.last_alert_at.get(key);
  if (previous !== undefined && sample.timestamp - previous < ALERT_COOLDOWN_MS) {
    accumulator.repeated_alerts_24h += 1;
  }
  accumulator.last_alert_at.set(key, sample.timestamp);
  if (signal.signal_type === "LONG_WATCH" || signal.signal_type === "SHORT_WATCH") {
    accumulator.directional_alerts += 1;
    accumulator.per_symbol_directional_alerts.set(
      sample.symbol,
      (accumulator.per_symbol_directional_alerts.get(sample.symbol) ?? 0) + 1,
    );
    if (previous !== undefined && sample.timestamp - previous < ALERT_COOLDOWN_MS) {
      accumulator.repeated_directional_alerts_24h += 1;
    }
  }
  if (signal.event.quality_score < 65) accumulator.low_quality_alerts += 1;
}

function renderDirection(accumulator: DirectionAccumulator): DirectionReport {
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
    direction_accuracy: accumulator.evaluable > 0 ? round(accumulator.wins / accumulator.evaluable) : null,
    average_return: accumulator.evaluable > 0 ? round(accumulator.return_sum / accumulator.evaluable) : null,
    mfe: accumulator.evaluable > 0 ? round(accumulator.mfe_sum / accumulator.evaluable) : null,
    mae: accumulator.evaluable > 0 ? round(accumulator.mae_sum / accumulator.evaluable) : null,
  };
}

function renderRisk(accumulator: RiskAccumulator): EvaluationReport["risk_warning_evaluation"]["before"] {
  return {
    signal_count: accumulator.signal_count,
    evaluable_24h: accumulator.evaluable_24h,
    volatility_expansion: rate(accumulator.volatility_expansion, accumulator.evaluable_24h),
    negative_return_probability: rate(accumulator.negative_return, accumulator.evaluable_24h),
    large_move_frequency: rate(accumulator.large_move, accumulator.evaluable_24h),
  };
}

function renderNoise(accumulator: NoiseAccumulator, symbolCount: number): NoiseReport {
  const all = [...accumulator.per_symbol_alerts.values()];
  const directional = [...accumulator.per_symbol_directional_alerts.values()];
  return {
    total_alerts: accumulator.total_alerts,
    repeated_alerts_within_24h: accumulator.repeated_alerts_24h,
    directional_alerts: accumulator.directional_alerts,
    repeated_directional_alerts_within_24h: accumulator.repeated_directional_alerts_24h,
    low_quality_alerts: accumulator.low_quality_alerts,
    same_symbol_alerts_per_symbol_average: symbolCount > 0
      ? round(all.reduce((total, value) => total + value, 0) / symbolCount)
      : null,
    same_symbol_alerts_per_symbol_max: all.length > 0 ? Math.max(...all) : null,
    directional_alerts_per_symbol_average: symbolCount > 0
      ? round(directional.reduce((total, value) => total + value, 0) / symbolCount)
      : null,
    directional_alerts_per_symbol_max: directional.length > 0 ? Math.max(...directional) : null,
  };
}

function renderQuality(long: DirectionAccumulator, short: DirectionAccumulator): AlertQualityReport {
  const longFour = long.horizons["4h"];
  const shortFour = short.horizons["4h"];
  const evaluable = longFour.evaluable + shortFour.evaluable;
  const wins = longFour.wins + shortFour.wins;
  const count = long.signal_count + short.signal_count;
  return {
    directional_signal_count: count,
    evaluable_4h: evaluable,
    precision_4h: evaluable > 0 ? round(wins / evaluable) : null,
    false_alert_rate_4h: evaluable > 0 ? round(1 - wins / evaluable) : null,
    average_opportunity_score: count > 0
      ? round((long.opportunity_sum + short.opportunity_sum) / count)
      : null,
  };
}

function decide(report: OptimizationReport): OptimizationReport["decision"] {
  const quality = report.evaluation.alert_quality.after;
  if (quality.directional_signal_count < 50 || quality.evaluable_4h < 50 || quality.precision_4h === null) {
    return "NOT_READY";
  }
  if (quality.precision_4h >= 0.55 && quality.false_alert_rate_4h! <= 0.45) return "READY_FOR_SHADOW";
  return "NOT_READY";
}

function createEvaluationAccumulator(): EvaluationAccumulator {
  return {
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
    long: createDirectionAccumulator(),
    short: createDirectionAccumulator(),
    risk: {
      signal_count: 0,
      evaluable_24h: 0,
      volatility_expansion: 0,
      negative_return: 0,
      large_move: 0,
    },
    noise: {
      total_alerts: 0,
      repeated_alerts_24h: 0,
      directional_alerts: 0,
      repeated_directional_alerts_24h: 0,
      low_quality_alerts: 0,
      per_symbol_alerts: new Map(),
      per_symbol_directional_alerts: new Map(),
      last_alert_at: new Map(),
    },
  };
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
  return { signal_count: 0, evaluable: 0, wins: 0, return_sum: 0, mfe_sum: 0, mae_sum: 0 };
}

function incrementBreadthCount(
  counts: { breadth_strong: number; breadth_normal: number; breadth_weak: number; breadth_blocked: number },
  status: MarketBreadthFeature["status"],
): void {
  const key = status === "STRONG"
    ? "breadth_strong"
    : status === "NORMAL" ? "breadth_normal" : status === "WEAK" ? "breadth_weak" : "breadth_blocked";
  counts[key] += 1;
}

function rate(count: number, denominator: number): RateMetric {
  return { count, rate: denominator > 0 ? round(count / denominator) : null };
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
  const endIndex = firstIndexAtOrAfter(candles, timestamp + hours * 60 * 60 * 1000, currentIndex + 1);
  if (endIndex === -1) return null;
  const window = candles.slice(currentIndex + 1, endIndex + 1);
  if (window.length === 0) return null;
  const futurePrice = candles[endIndex]!.close;
  const aligned_return = side === "LONG"
    ? futurePrice / current.close - 1
    : current.close / futurePrice - 1;
  const maxHigh = Math.max(...window.map((candle) => candle.high));
  const minLow = Math.min(...window.map((candle) => candle.low));
  return {
    aligned_return,
    mfe: side === "LONG"
      ? Math.max(0, maxHigh / current.close - 1)
      : Math.max(0, current.close / minLow - 1),
    mae: side === "LONG"
      ? Math.max(0, 1 - minLow / current.close)
      : Math.max(0, maxHigh / current.close - 1),
  };
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
  const return24h = future.at(-1)!.close / current.close - 1;
  return {
    volatility_expansion: currentRange > 0 && futureRange >= currentRange * VOLATILITY_EXPANSION_MULTIPLIER,
    negative_return: return24h < 0,
    large_move: Math.abs(return24h) >= LARGE_MOVE_THRESHOLD,
  };
}

function forwardWindow(candles: Candle[], currentIndex: number, timestamp: number, hours: number): Candle[] | null {
  const endIndex = firstIndexAtOrAfter(candles, timestamp + hours * 60 * 60 * 1000, currentIndex + 1);
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
    } else low = middle + 1;
  }
  return answer;
}

function renderMarkdown(report: OptimizationReport): string {
  const signalRows = (["LONG_WATCH", "SHORT_WATCH", "RISK_WARNING", "MARKET_STATUS"] as const)
    .map((type) => `| ${type} | ${report.evaluation.signal_count.before[type]} | ${report.evaluation.signal_count.after[type]} |`)
    .join("\n");
  const statusRows = (["TREND_UP", "TREND_DOWN", "RANGE", "HIGH_VOL", "NO_TRADE"] as const)
    .map((status) => `| ${status} | ${report.evaluation.market_status_count.before[status]} | ${report.evaluation.market_status_count.after[status]} |`)
    .join("\n");
  const filteredRows = Object.entries(report.filtered.by_reason)
    .sort(([, left], [, right]) => right - left)
    .map(([reason, count]) => `| ${reason} | ${count} |`)
    .join("\n") || "| none | 0 |";
  return [
    "# HY-R4.12 Signal Quality Optimization",
    "",
    "## Scope and boundary",
    "",
    `- Mode: **${report.mode}**`,
    `- Generated: ${report.generated_at}`,
    `- Window: ${report.evaluation_window.start} → ${report.evaluation_window.end}`,
    `- Datasets: ${report.evaluation_window.datasets}; evaluation timestamps: ${report.evaluation_window.sample_timestamps}.`,
    "- No new indicators, no ML, no Production, no Supabase, no Vercel, no email.",
    "- Existing R4.8 signal rules, score calculations, and PAPER strategy were not modified.",
    "- AUTO_TRADING: **FALSE**",
    "",
    "## Policy",
    "",
    `- Directional minimum opportunity: ${report.policy.directional_min_opportunity_score}; minimum confidence: ${report.policy.directional_min_confidence}; maximum risk: ${report.policy.directional_max_risk_score}.`,
    `- RISK_WARNING minimum risk: ${report.policy.risk_warning_min_risk_score}, unless an existing material risk reason is present.`,
    `- Directional cooldown: ${report.policy.directional_cooldown_ms / 3_600_000}h; risk cooldown: ${report.policy.risk_warning_cooldown_ms / 3_600_000}h; status heartbeat: ${report.policy.status_heartbeat_ms / 3_600_000}h.`,
    `- Escalation delta: ${report.policy.escalation_delta} existing score points.`,
    "",
    "## Input coverage",
    "",
    `- Evaluated observations: ${report.input_coverage.evaluated_observations}.`,
    `- PIT-safe/PIT-unsafe: ${report.input_coverage.pit_safe_observations}/${report.input_coverage.pit_unsafe_observations}.`,
    `- Liquidity available/blocked: ${report.input_coverage.liquidity_available}/${report.input_coverage.liquidity_blocked}.`,
    `- Breadth STRONG/NORMAL/WEAK/BLOCKED: ${report.input_coverage.breadth_strong}/${report.input_coverage.breadth_normal}/${report.input_coverage.breadth_weak}/${report.input_coverage.breadth_blocked}.`,
    "",
    "## Signal Count (before → after)",
    "",
    "| Signal | Before | After |",
    "| --- | ---: | ---: |",
    signalRows,
    "",
    "| Market status | Before | After |",
    "| --- | ---: | ---: |",
    statusRows,
    "",
    `- Filtered total: ${report.filtered.total}.`,
    "",
    "| Filter reason | Count |",
    "| --- | ---: |",
    filteredRows,
    "",
    "## LONG Evaluation (before → after)",
    "",
    renderDirectionComparison(report.evaluation.long_evaluation),
    "",
    "## SHORT Evaluation (before → after)",
    "",
    renderDirectionComparison(report.evaluation.short_evaluation),
    "",
    "## Risk Warning Evaluation (before → after)",
    "",
    renderRiskComparison(report.evaluation.risk_warning_evaluation),
    "",
    "## Noise Analysis (before → after)",
    "",
    renderNoiseComparison(report.evaluation.noise_analysis),
    "",
    "## Alert Quality (before → after)",
    "",
    renderQualityComparison(report.evaluation.alert_quality),
    "",
    "## Decision",
    "",
    `**${report.decision}**`,
    "",
    "`READY_FOR_SHADOW` requires at least 50 optimized directional alerts, 50 evaluable 4h outcomes, and 4h precision ≥ 55%. `READY_FOR_EMAIL` is not granted by this research phase.",
    "",
    "## Assumptions and safety",
    "",
    `- Future data used: **${report.boundaries.future_data_used ? "YES" : "NO"}**.`,
    ...report.assumptions.map((assumption) => `- ${assumption}`),
    "",
    "| Check | Result |",
    "| --- | --- |",
    `| New indicators | ${report.boundaries.new_indicators ? "FAIL" : "NO"} |`,
    `| Machine learning | ${report.boundaries.machine_learning ? "FAIL" : "NO"} |`,
    `| Signal rules modified | ${report.boundaries.signal_rules_modified ? "FAIL" : "NO"} |`,
    `| Production/Supabase/Vercel modified | ${report.boundaries.production_modified || report.boundaries.supabase_modified || report.boundaries.vercel_modified ? "FAIL" : "NO"} |`,
    `| PAPER strategy modified | ${report.boundaries.paper_strategy_modified ? "FAIL" : "NO"} |`,
    `| Emails sent | ${report.boundaries.emails_sent} |`,
    `| Persistence attempts | ${report.boundaries.persistence_attempts} |`,
    `| Private API called | ${report.boundaries.private_api_called ? "FAIL" : "NO"} |`,
    `| AUTO_TRADING | ${report.boundaries.auto_trading ? "FAIL" : "FALSE"} |`,
    "",
    "## Validation",
    "",
    `- Tests: **${report.validation.tests}**`,
    `- typecheck: **${report.validation.typecheck}**`,
    `- lint: **${report.validation.lint}**`,
    "",
  ].join("\n");
}

function renderDirectionComparison(reports: Record<"before" | "after", DirectionReport>): string {
  return [
    `- Signal count: ${reports.before.signal_count} → ${reports.after.signal_count}.`,
    `- Average opportunity: ${format(reports.before.average_opportunity_score)} → ${format(reports.after.average_opportunity_score)}.`,
    "",
    "| Horizon | Evaluable before → after | Accuracy before → after | Return before → after | MFE before → after | MAE before → after |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...(["4h", "12h", "24h"] as const).map((horizon) => {
      const before = reports.before.horizons[horizon];
      const after = reports.after.horizons[horizon];
      return `| ${horizon} | ${before.evaluable} → ${after.evaluable} | ${format(before.direction_accuracy)} → ${format(after.direction_accuracy)} | ${format(before.average_return)} → ${format(after.average_return)} | ${format(before.mfe)} → ${format(after.mfe)} | ${format(before.mae)} → ${format(after.mae)} |`;
    }),
  ].join("\n");
}

function renderRiskComparison(reports: Record<"before" | "after", EvaluationReport["risk_warning_evaluation"]["before"]>): string {
  return [
    `- Signal count: ${reports.before.signal_count} → ${reports.after.signal_count}; evaluable 24h: ${reports.before.evaluable_24h} → ${reports.after.evaluable_24h}.`,
    `- Volatility expansion: ${reports.before.volatility_expansion.count} (${format(reports.before.volatility_expansion.rate)}) → ${reports.after.volatility_expansion.count} (${format(reports.after.volatility_expansion.rate)}).`,
    `- Negative return probability: ${reports.before.negative_return_probability.count} (${format(reports.before.negative_return_probability.rate)}) → ${reports.after.negative_return_probability.count} (${format(reports.after.negative_return_probability.rate)}).`,
    `- Large move frequency: ${reports.before.large_move_frequency.count} (${format(reports.before.large_move_frequency.rate)}) → ${reports.after.large_move_frequency.count} (${format(reports.after.large_move_frequency.rate)}).`,
  ].join("\n");
}

function renderNoiseComparison(reports: Record<"before" | "after", NoiseReport>): string {
  return [
    `- Total alerts: ${reports.before.total_alerts} → ${reports.after.total_alerts}.`,
    `- Repeated within 24h: ${reports.before.repeated_alerts_within_24h} → ${reports.after.repeated_alerts_within_24h}.`,
    `- Directional alerts: ${reports.before.directional_alerts} → ${reports.after.directional_alerts}.`,
    `- Repeated directional within 24h: ${reports.before.repeated_directional_alerts_within_24h} → ${reports.after.repeated_directional_alerts_within_24h}.`,
    `- Low-quality alerts: ${reports.before.low_quality_alerts} → ${reports.after.low_quality_alerts}.`,
    `- Same-symbol alerts average: ${format(reports.before.same_symbol_alerts_per_symbol_average)} → ${format(reports.after.same_symbol_alerts_per_symbol_average)}; max: ${format(reports.before.same_symbol_alerts_per_symbol_max)} → ${format(reports.after.same_symbol_alerts_per_symbol_max)}.`,
  ].join("\n");
}

function renderQualityComparison(reports: Record<"before" | "after", AlertQualityReport>): string {
  return [
    `- Directional signal count: ${reports.before.directional_signal_count} → ${reports.after.directional_signal_count}.`,
    `- 4h evaluable: ${reports.before.evaluable_4h} → ${reports.after.evaluable_4h}.`,
    `- Precision: ${format(reports.before.precision_4h)} → ${format(reports.after.precision_4h)}.`,
    `- False alert rate: ${format(reports.before.false_alert_rate_4h)} → ${format(reports.after.false_alert_rate_4h)}.`,
    `- Average opportunity: ${format(reports.before.average_opportunity_score)} → ${format(reports.after.average_opportunity_score)}.`,
  ].join("\n");
}

function format(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "-" : String(value);
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
