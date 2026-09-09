import { mkdir, readdir, writeFile } from "node:fs/promises";
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
import { calculateMarketBreadthFeature } from "../lib/market-context";
import type { MarketBreadthFeature, MarketBreadthMember } from "../lib/market-context";
import {
  createSignalQualityState,
  defaultSignalQualityPolicy,
  optimizeSignalOutputs,
} from "../lib/signal-quality";
import type { SignalQualityPolicy } from "../lib/signal-quality";
import type { Candle } from "../lib/core/types";

const DATA_DIRECTORY = resolve("data", "hy-r2b-history-24m");
const REPORT_DIRECTORY = resolve("reports");
const REPORT_PATH = resolve(REPORT_DIRECTORY, "hy-r4.13-filtered-signal-evaluation.md");
const EVALUATION_START = Date.parse("2024-08-09T00:00:00.000Z");
const EVALUATION_END = Date.parse("2026-08-09T23:59:59.999Z");
const TOP_UNIVERSE_SIZE = 10;
const BREADTH_MINIMUM_MEMBERS = 35;
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const LARGE_MOVE_THRESHOLD = 0.02;
const EXTREME_MOVE_THRESHOLD = 0.05;
const MIN_DIRECTIONAL_PRECISION = 0.55;
const MAX_MANUAL_AVERAGE_DAILY_TOTAL = 50;
const MAX_MANUAL_DUPLICATE_RATE = 0.1;

type EvaluatedSignalType = "LONG_WATCH" | "SHORT_WATCH" | "RISK_WARNING";
type HorizonKey = "4h" | "12h" | "24h";

interface HorizonAccumulator {
  evaluable: number;
  wins: number;
  return_sum: number;
  returns: number[];
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
  large_move: number;
  negative_return: number;
  extreme_move: number;
}

interface DailySignalCount {
  long: number;
  short: number;
  risk: number;
  total: number;
}

interface EvaluationAccumulator {
  signal_count: Record<EvaluatedSignalType, number>;
  long: DirectionAccumulator;
  short: DirectionAccumulator;
  risk: RiskAccumulator;
  daily: Map<string, DailySignalCount>;
  duplicate_total: number;
  duplicate_repeats: number;
  last_signal_at: Map<string, number>;
}

interface HorizonReport {
  evaluable: number;
  direction_accuracy: number | null;
  average_return: number | null;
  median_return: number | null;
  max_favorable_move: number | null;
  max_adverse_move: number | null;
}

interface DirectionReport {
  signal_count: number;
  average_opportunity_score: number | null;
  horizons: Record<HorizonKey, HorizonReport>;
}

interface RateReport {
  count: number;
  probability: number | null;
}

interface RiskReport {
  signal_count: number;
  evaluable_24h: number;
  large_move_probability: RateReport;
  negative_return_probability: RateReport;
  extreme_move_probability: RateReport;
}

interface DailyReport {
  observed_days: number;
  active_signal_days: number;
  average_long_per_day: number | null;
  average_short_per_day: number | null;
  average_risk_per_day: number | null;
  average_total_per_day: number | null;
  maximum_total_per_day: number | null;
}

interface QualityReport {
  directional_signal_count: number;
  evaluable_4h: number;
  signal_precision_4h: number | null;
  false_alert_rate_4h: number | null;
  duplicate_rate_24h: number | null;
  duplicate_count_24h: number;
  signal_value: {
    directional_4h_average_aligned_return: number | null;
    directional_4h_median_aligned_return: number | null;
    risk_warning_24h_large_move_probability: number | null;
  };
}

interface ManualUseReport {
  suitable_for_human_reading: boolean;
  reasons: string[];
  gate: {
    minimum_directional_precision: number;
    maximum_average_daily_total: number;
    maximum_duplicate_rate_24h: number;
  };
  daily_signal_count: DailyReport;
}

interface EvaluationReport {
  schema_version: "hy-r4.13";
  mode: "LOCAL_PIT_SAFE_R4_12_FILTERED_REPLAY";
  generated_at: string;
  evaluation_window: {
    start: string;
    end: string;
    datasets: number;
    sample_timestamps: number;
  };
  r4_12_policy: SignalQualityPolicy;
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
  r4_12_filtered: {
    total: number;
    by_reason: Record<string, number>;
  };
  signal_count: Record<EvaluatedSignalType, number>;
  long_evaluation: DirectionReport;
  short_evaluation: DirectionReport;
  risk_warning_evaluation: RiskReport;
  quality: QualityReport;
  manual_use: ManualUseReport;
  decision: "NOT_READY" | "READY_FOR_SHADOW" | "READY_FOR_EMAIL";
  safety: {
    dry_run: true;
    emails_sent: 0;
    persistence_attempts: 0;
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

async function main(): Promise<void> {
  const files = (await readdir(DATA_DIRECTORY))
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error("No HY-R2B historical datasets found");

  const firstDataset = await loadDataset(files[0]!);
  const allSampleTimestamps = buildSampleTimestamps(firstDataset);
  const evaluationTimestamps = allSampleTimestamps.filter((timestamp) => (
    timestamp >= EVALUATION_START && timestamp <= EVALUATION_END
  ));
  if (evaluationTimestamps.length === 0) throw new Error("No evaluation timestamps found");

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
    breadthByTimestamp.set(timestamp, calculateMarketBreadthFeature({
      as_of: timestamp,
      members: membersByTimestamp.get(timestamp) ?? [],
      top_universe_size: TOP_UNIVERSE_SIZE,
      minimum_members: BREADTH_MINIMUM_MEMBERS,
    }));
  }

  const accumulator = createAccumulator();
  const qualityState = createSignalQualityState();
  const filteredByReason: Record<string, number> = {};
  const inputCoverage = createInputCoverage();

  for (const context of contexts) {
    for (const sample of context.samples) {
      const breadth = breadthByTimestamp.get(sample.timestamp);
      if (!breadth) continue;

      const engineResult = await runSignalEngineDryRun(buildSignalInput(sample, breadth));
      inputCoverage.evaluated_observations += 1;
      if (engineResult.persistence_eligible) inputCoverage.pit_safe_observations += 1;
      else inputCoverage.pit_unsafe_observations += 1;
      if (sample.liquidity.liquidity_score === null) inputCoverage.liquidity_blocked += 1;
      else inputCoverage.liquidity_available += 1;
      incrementBreadthCount(inputCoverage, breadth.status);
      ensureDailyObservation(accumulator.daily, sample.timestamp);

      const optimized = optimizeSignalOutputs(engineResult.signals, qualityState);
      for (const filtered of optimized.filtered) {
        filteredByReason[filtered.reason] = (filteredByReason[filtered.reason] ?? 0) + 1;
      }
      for (const signal of optimized.signals) {
        recordSignal(accumulator, signal, context, sample);
      }
    }
  }

  const longEvaluation = renderDirection(accumulator.long);
  const shortEvaluation = renderDirection(accumulator.short);
  const riskEvaluation = renderRisk(accumulator.risk);
  const quality = renderQuality(accumulator, longEvaluation, shortEvaluation, riskEvaluation);
  const dailySignalCount = renderDaily(accumulator.daily);
  const manualUse = renderManualUse(dailySignalCount, quality);
  const report: EvaluationReport = {
    schema_version: "hy-r4.13",
    mode: "LOCAL_PIT_SAFE_R4_12_FILTERED_REPLAY",
    generated_at: new Date().toISOString(),
    evaluation_window: {
      start: new Date(EVALUATION_START).toISOString(),
      end: new Date(EVALUATION_END).toISOString(),
      datasets: files.length,
      sample_timestamps: evaluationTimestamps.length,
    },
    r4_12_policy: defaultSignalQualityPolicy,
    input_coverage: inputCoverage,
    r4_12_filtered: {
      total: Object.values(filteredByReason).reduce((total, count) => total + count, 0),
      by_reason: filteredByReason,
    },
    signal_count: accumulator.signal_count,
    long_evaluation: longEvaluation,
    short_evaluation: shortEvaluation,
    risk_warning_evaluation: riskEvaluation,
    quality,
    manual_use: manualUse,
    decision: decide(quality, manualUse),
    safety: {
      dry_run: true,
      emails_sent: 0,
      persistence_attempts: 0,
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

  await mkdir(REPORT_DIRECTORY, { recursive: true });
  await writeFile(REPORT_PATH, renderMarkdown(report), "utf8");
  console.log(JSON.stringify({
    report: REPORT_PATH,
    evaluated: report.input_coverage.evaluated_observations,
    signal_count: report.signal_count,
    quality: report.quality,
    manual_use: report.manual_use,
    decision: report.decision,
  }, null, 2));
}

function createAccumulator(): EvaluationAccumulator {
  return {
    signal_count: { LONG_WATCH: 0, SHORT_WATCH: 0, RISK_WARNING: 0 },
    long: createDirectionAccumulator(),
    short: createDirectionAccumulator(),
    risk: {
      signal_count: 0,
      evaluable_24h: 0,
      large_move: 0,
      negative_return: 0,
      extreme_move: 0,
    },
    daily: new Map(),
    duplicate_total: 0,
    duplicate_repeats: 0,
    last_signal_at: new Map(),
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
  return {
    evaluable: 0,
    wins: 0,
    return_sum: 0,
    returns: [],
    mfe_sum: 0,
    mae_sum: 0,
  };
}

function createInputCoverage(): EvaluationReport["input_coverage"] {
  return {
    evaluated_observations: 0,
    pit_safe_observations: 0,
    pit_unsafe_observations: 0,
    liquidity_available: 0,
    liquidity_blocked: 0,
    breadth_strong: 0,
    breadth_normal: 0,
    breadth_weak: 0,
    breadth_blocked: 0,
  };
}

function recordSignal(
  accumulator: EvaluationAccumulator,
  signal: SignalEngineSignal,
  context: SymbolContext,
  sample: SymbolSample,
): void {
  if (!isEvaluatedSignalType(signal.signal_type)) return;
  const type = signal.signal_type;
  accumulator.signal_count[type] += 1;
  const day = ensureDailyObservation(accumulator.daily, sample.timestamp);
  day.total += 1;
  const signalTimestamp = Date.parse(signal.event.created_at ?? "") || sample.timestamp;
  const duplicateKey = `${sample.symbol}:${type}`;
  const previous = accumulator.last_signal_at.get(duplicateKey);
  accumulator.duplicate_total += 1;
  if (previous !== undefined && signalTimestamp >= previous && signalTimestamp - previous < DUPLICATE_WINDOW_MS) {
    accumulator.duplicate_repeats += 1;
  }
  accumulator.last_signal_at.set(duplicateKey, signalTimestamp);

  if (type === "LONG_WATCH") {
    day.long += 1;
    recordDirectional(accumulator.long, signal, context, sample, "LONG");
  } else if (type === "SHORT_WATCH") {
    day.short += 1;
    recordDirectional(accumulator.short, signal, context, sample, "SHORT");
  } else {
    day.risk += 1;
    recordRisk(accumulator.risk, context, sample);
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
    if (!outcome) continue;
    const metric = accumulator.horizons[horizon];
    metric.evaluable += 1;
    if (outcome.aligned_return > 0) metric.wins += 1;
    metric.return_sum += outcome.aligned_return;
    metric.returns.push(outcome.aligned_return);
    metric.mfe_sum += outcome.mfe;
    metric.mae_sum += outcome.mae;
  }
}

function recordRisk(accumulator: RiskAccumulator, context: SymbolContext, sample: SymbolSample): void {
  accumulator.signal_count += 1;
  const outcome = riskOutcome(context.fourHour, sample.four_hour_index, sample.timestamp);
  if (!outcome) return;
  accumulator.evaluable_24h += 1;
  if (outcome.large_move) accumulator.large_move += 1;
  if (outcome.negative_return) accumulator.negative_return += 1;
  if (outcome.extreme_move) accumulator.extreme_move += 1;
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
    median_return: median(accumulator.returns),
    max_favorable_move: accumulator.evaluable > 0 ? round(accumulator.mfe_sum / accumulator.evaluable) : null,
    max_adverse_move: accumulator.evaluable > 0 ? round(accumulator.mae_sum / accumulator.evaluable) : null,
  };
}

function renderRisk(accumulator: RiskAccumulator): RiskReport {
  return {
    signal_count: accumulator.signal_count,
    evaluable_24h: accumulator.evaluable_24h,
    large_move_probability: rate(accumulator.large_move, accumulator.evaluable_24h),
    negative_return_probability: rate(accumulator.negative_return, accumulator.evaluable_24h),
    extreme_move_probability: rate(accumulator.extreme_move, accumulator.evaluable_24h),
  };
}

function renderQuality(
  accumulator: EvaluationAccumulator,
  long: DirectionReport,
  short: DirectionReport,
  risk: RiskReport,
): QualityReport {
  const longFour = accumulator.long.horizons["4h"];
  const shortFour = accumulator.short.horizons["4h"];
  const evaluable = longFour.evaluable + shortFour.evaluable;
  const wins = longFour.wins + shortFour.wins;
  const directionalCount = accumulator.signal_count.LONG_WATCH + accumulator.signal_count.SHORT_WATCH;
  const precision = evaluable > 0 ? round(wins / evaluable) : null;
  const directionalReturns = [...longFour.returns, ...shortFour.returns];
  return {
    directional_signal_count: directionalCount,
    evaluable_4h: evaluable,
    signal_precision_4h: precision,
    false_alert_rate_4h: precision === null ? null : round(1 - precision),
    duplicate_rate_24h: accumulator.duplicate_total > 0
      ? round(accumulator.duplicate_repeats / accumulator.duplicate_total)
      : null,
    duplicate_count_24h: accumulator.duplicate_repeats,
    signal_value: {
      directional_4h_average_aligned_return: average(directionalReturns),
      directional_4h_median_aligned_return: median(directionalReturns),
      risk_warning_24h_large_move_probability: risk.large_move_probability.probability,
    },
  };
}

function renderDaily(daily: Map<string, DailySignalCount>): DailyReport {
  const values = [...daily.values()];
  if (values.length === 0) {
    return {
      observed_days: 0,
      active_signal_days: 0,
      average_long_per_day: null,
      average_short_per_day: null,
      average_risk_per_day: null,
      average_total_per_day: null,
      maximum_total_per_day: null,
    };
  }
  const totals = values.reduce((summary, value) => ({
    long: summary.long + value.long,
    short: summary.short + value.short,
    risk: summary.risk + value.risk,
    total: summary.total + value.total,
  }), { long: 0, short: 0, risk: 0, total: 0 });
  return {
    observed_days: values.length,
    active_signal_days: values.filter((value) => value.total > 0).length,
    average_long_per_day: round(totals.long / values.length),
    average_short_per_day: round(totals.short / values.length),
    average_risk_per_day: round(totals.risk / values.length),
    average_total_per_day: round(totals.total / values.length),
    maximum_total_per_day: Math.max(...values.map((value) => value.total)),
  };
}

function renderManualUse(daily: DailyReport, quality: QualityReport): ManualUseReport {
  const reasons: string[] = [];
  if (quality.signal_precision_4h === null || quality.signal_precision_4h < MIN_DIRECTIONAL_PRECISION) {
    reasons.push("4h directional precision is below the 55% human-review gate.");
  }
  if (quality.duplicate_rate_24h !== null && quality.duplicate_rate_24h > MAX_MANUAL_DUPLICATE_RATE) {
    reasons.push("24h duplicate rate is above the 10% human-review gate.");
  }
  if (daily.average_total_per_day !== null && daily.average_total_per_day > MAX_MANUAL_AVERAGE_DAILY_TOTAL) {
    reasons.push("Average daily alert volume is above the 50-alert human-review gate.");
  }
  return {
    suitable_for_human_reading: reasons.length === 0,
    reasons,
    gate: {
      minimum_directional_precision: MIN_DIRECTIONAL_PRECISION,
      maximum_average_daily_total: MAX_MANUAL_AVERAGE_DAILY_TOTAL,
      maximum_duplicate_rate_24h: MAX_MANUAL_DUPLICATE_RATE,
    },
    daily_signal_count: daily,
  };
}

function decide(quality: QualityReport, manualUse: ManualUseReport): EvaluationReport["decision"] {
  if (
    quality.directional_signal_count < 50
    || quality.evaluable_4h < 50
    || quality.signal_precision_4h === null
    || quality.signal_precision_4h < MIN_DIRECTIONAL_PRECISION
    || !manualUse.suitable_for_human_reading
  ) {
    return "NOT_READY";
  }
  return "READY_FOR_SHADOW";
}

function ensureDailyObservation(daily: Map<string, DailySignalCount>, timestamp: number): DailySignalCount {
  const key = new Date(timestamp).toISOString().slice(0, 10);
  const existing = daily.get(key);
  if (existing) return existing;
  const value = { long: 0, short: 0, risk: 0, total: 0 };
  daily.set(key, value);
  return value;
}

function incrementBreadthCount(
  coverage: EvaluationReport["input_coverage"],
  status: MarketBreadthFeature["status"],
): void {
  const key = status === "STRONG"
    ? "breadth_strong"
    : status === "NORMAL" ? "breadth_normal" : status === "WEAK" ? "breadth_weak" : "breadth_blocked";
  coverage[key] += 1;
}

function isEvaluatedSignalType(signalType: SignalEngineSignal["signal_type"]): signalType is EvaluatedSignalType {
  return signalType === "LONG_WATCH" || signalType === "SHORT_WATCH" || signalType === "RISK_WARNING";
}

function riskOutcome(
  candles: Candle[],
  currentIndex: number,
  timestamp: number,
): { large_move: boolean; negative_return: boolean; extreme_move: boolean } | null {
  const current = candles[currentIndex];
  if (!current || current.close <= 0) return null;
  const future = forwardWindow(candles, currentIndex, timestamp, 24);
  if (!future) return null;
  const return24h = future.at(-1)!.close / current.close - 1;
  return {
    large_move: Math.abs(return24h) >= LARGE_MOVE_THRESHOLD,
    negative_return: return24h < 0,
    extreme_move: Math.abs(return24h) >= EXTREME_MOVE_THRESHOLD,
  };
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
  const alignedReturn = side === "LONG"
    ? futurePrice / current.close - 1
    : current.close / futurePrice - 1;
  const maxHigh = Math.max(...window.map((candle) => candle.high));
  const minLow = Math.min(...window.map((candle) => candle.low));
  return {
    aligned_return: alignedReturn,
    mfe: side === "LONG"
      ? Math.max(0, maxHigh / current.close - 1)
      : Math.max(0, current.close / minLow - 1),
    mae: side === "LONG"
      ? Math.max(0, 1 - minLow / current.close)
      : Math.max(0, maxHigh / current.close - 1),
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

function rate(count: number, denominator: number): RateReport {
  return { count, probability: denominator > 0 ? round(count / denominator) : null };
}

function average(values: number[]): number | null {
  return values.length > 0 ? round(values.reduce((total, value) => total + value, 0) / values.length) : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!);
}

function renderMarkdown(report: EvaluationReport): string {
  const signalRows = (["LONG_WATCH", "SHORT_WATCH", "RISK_WARNING"] as const)
    .map((type) => `| ${type} | ${report.signal_count[type]} |`)
    .join("\n");
  const filteredRows = Object.entries(report.r4_12_filtered.by_reason)
    .sort(([, left], [, right]) => right - left)
    .map(([reason, count]) => `| ${reason} | ${count} |`)
    .join("\n") || "| none | 0 |";
  return [
    "# HY-R4.13 Filtered Signal Evaluation",
    "",
    "## Scope and boundary",
    "",
    `- Mode: **${report.mode}**`,
    `- Generated: ${report.generated_at}`,
    `- Window: ${report.evaluation_window.start} → ${report.evaluation_window.end}`,
    `- Datasets: ${report.evaluation_window.datasets}; sample timestamps: ${report.evaluation_window.sample_timestamps}.`,
    "- Input is the deterministic HY-R4.12 filtering policy applied to the existing R4.8 dry-run output.",
    "- No signal-rule changes, new indicators, ML, Production, Supabase, Vercel, or email delivery.",
    "- AUTO_TRADING: **FALSE**",
    "",
    "## R4.12 filtered input",
    "",
    `- Evaluated observations: ${report.input_coverage.evaluated_observations}.`,
    `- PIT-safe/PIT-unsafe: ${report.input_coverage.pit_safe_observations}/${report.input_coverage.pit_unsafe_observations}.`,
    `- Liquidity available/blocked: ${report.input_coverage.liquidity_available}/${report.input_coverage.liquidity_blocked}.`,
    `- Breadth STRONG/NORMAL/WEAK/BLOCKED: ${report.input_coverage.breadth_strong}/${report.input_coverage.breadth_normal}/${report.input_coverage.breadth_weak}/${report.input_coverage.breadth_blocked}.`,
    `- Signals filtered out by R4.12 policy (including MARKET_STATUS suppressions): ${report.r4_12_filtered.total}.`,
    "",
    "| R4.12 filter reason | Count |",
    "| --- | ---: |",
    filteredRows,
    "",
    "## Signal count",
    "",
    "| Signal | Filtered count |",
    "| --- | ---: |",
    signalRows,
    "",
    "## LONG_WATCH evaluation",
    "",
    renderDirectionMarkdown(report.long_evaluation),
    "",
    "## SHORT_WATCH evaluation",
    "",
    renderDirectionMarkdown(report.short_evaluation),
    "",
    "## RISK_WARNING evaluation",
    "",
    "| Metric | Count | Probability |",
    "| --- | ---: | ---: |",
    `| Large 24h move (|return| ≥ ${LARGE_MOVE_THRESHOLD}) | ${report.risk_warning_evaluation.large_move_probability.count} | ${format(report.risk_warning_evaluation.large_move_probability.probability)} |`,
    `| Negative 24h return | ${report.risk_warning_evaluation.negative_return_probability.count} | ${format(report.risk_warning_evaluation.negative_return_probability.probability)} |`,
    `| Extreme 24h move (|return| ≥ ${EXTREME_MOVE_THRESHOLD}) | ${report.risk_warning_evaluation.extreme_move_probability.count} | ${format(report.risk_warning_evaluation.extreme_move_probability.probability)} |`,
    `- Signal count/evaluable 24h: ${report.risk_warning_evaluation.signal_count}/${report.risk_warning_evaluation.evaluable_24h}.`,
    "",
    "## Quality metrics",
    "",
    `- Directional signal precision (4h): ${format(report.quality.signal_precision_4h)}; false alert rate: ${format(report.quality.false_alert_rate_4h)}.`,
    `- Directional signal count/evaluable 4h: ${report.quality.directional_signal_count}/${report.quality.evaluable_4h}.`,
    `- Duplicate rate within 24h: ${format(report.quality.duplicate_rate_24h)} (${report.quality.duplicate_count_24h} repeated alerts).`,
    `- Signal value (observed outcomes, not a trading score): directional 4h average aligned return ${format(report.quality.signal_value.directional_4h_average_aligned_return)}, median ${format(report.quality.signal_value.directional_4h_median_aligned_return)}; RISK_WARNING 24h large-move probability ${format(report.quality.signal_value.risk_warning_24h_large_move_probability)}.`,
    "",
    "## Human-use volume",
    "",
    `- Average daily LONG/SHORT/RISK: ${format(report.manual_use.daily_signal_count.average_long_per_day)}/${format(report.manual_use.daily_signal_count.average_short_per_day)}/${format(report.manual_use.daily_signal_count.average_risk_per_day)}.`,
    `- Average total per day: ${format(report.manual_use.daily_signal_count.average_total_per_day)}; maximum total per day: ${format(report.manual_use.daily_signal_count.maximum_total_per_day)}.`,
    `- Observed days/active signal days: ${report.manual_use.daily_signal_count.observed_days}/${report.manual_use.daily_signal_count.active_signal_days}.`,
    `- Suitable for human reading: **${report.manual_use.suitable_for_human_reading ? "YES" : "NO"}**.`,
    ...report.manual_use.reasons.map((reason) => `- Reason: ${reason}`),
    "",
    "## Final classification",
    "",
    `**${report.decision}**`,
    "",
    "`READY_FOR_EMAIL` is not granted by this evaluation; no email was sent.",
    "",
    "## Method and safety",
    "",
    `- R4.12 policy: directional opportunity ≥ ${report.r4_12_policy.directional_min_opportunity_score}, confidence ≥ ${report.r4_12_policy.directional_min_confidence}, risk ≤ ${report.r4_12_policy.directional_max_risk_score}; cooldowns and status heartbeat were unchanged.`,
    "- 4h/12h/24h replay uses only candles after each signal timestamp; no future data was used to filter or create a signal.",
    "- Median return is the median of per-signal forward returns. Max favorable/adverse move is the per-signal window excursion averaged across evaluable signals.",
    "- Directional return is aligned to the watch direction; this is research evaluation, not trading P&L.",
    "",
    "| Check | Result |",
    "| --- | --- |",
    `| Dry-run | ${report.safety.dry_run ? "PASS" : "FAIL"} |`,
    `| New indicators / ML | NO |`,
    `| Signal rules modified | ${report.safety.signal_rules_modified ? "FAIL" : "NO"} |`,
    `| Production/Supabase/Vercel modified | ${report.safety.production_modified || report.safety.supabase_modified || report.safety.vercel_modified ? "FAIL" : "NO"} |`,
    `| PAPER strategy modified | ${report.safety.paper_strategy_modified ? "FAIL" : "NO"} |`,
    `| Emails sent | ${report.safety.emails_sent} |`,
    `| Persistence attempts | ${report.safety.persistence_attempts} |`,
    `| Private API called | ${report.safety.private_api_called ? "FAIL" : "NO"} |`,
    `| AUTO_TRADING | ${report.safety.auto_trading ? "FAIL" : "FALSE"} |`,
    "",
    "## Validation",
    "",
    `- Tests: **${report.validation.tests}**`,
    `- typecheck: **${report.validation.typecheck}**`,
    `- lint: **${report.validation.lint}**`,
    "",
  ].join("\n");
}

function renderDirectionMarkdown(report: DirectionReport): string {
  return [
    `- Signal count: ${report.signal_count}; average opportunity score: ${format(report.average_opportunity_score)}.`,
    "",
    "| Horizon | Evaluable | Direction accuracy | Average return | Median return | Average max favorable move | Average max adverse move |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...(["4h", "12h", "24h"] as const).map((horizon) => {
      const metric = report.horizons[horizon];
      return `| ${horizon} | ${metric.evaluable} | ${format(metric.direction_accuracy)} | ${format(metric.average_return)} | ${format(metric.median_return)} | ${format(metric.max_favorable_move)} | ${format(metric.max_adverse_move)} |`;
    }),
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
