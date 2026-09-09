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
  createOpportunityEventState,
  defaultOpportunityEventPolicy,
  processOpportunityObservation,
  replayOpportunityEvent,
} from "../lib/opportunity-events";
import type {
  OpportunityEvent,
  OpportunityEventObservation,
  OpportunityInvalidation,
  ReplayEvaluation,
  ReplayHorizon,
} from "../lib/opportunity-events";
import type { Candle } from "../lib/core/types";

const DATA_DIRECTORY = resolve("data", "hy-r2b-history-24m");
const REPORT_DIRECTORY = resolve("reports");
const JSON_REPORT_PATH = resolve(REPORT_DIRECTORY, "hy-r4.15-opportunity-event-locked-replay.json");
const MARKDOWN_REPORT_PATH = resolve(REPORT_DIRECTORY, "hy-r4.15-opportunity-event-locked-replay.md");
const EVALUATION_START = Date.parse("2024-08-09T00:00:00.000Z");
const EVALUATION_END = Date.parse("2026-08-09T23:59:59.999Z");
const TOP_UNIVERSE_SIZE = 10;
const BREADTH_MINIMUM_MEMBERS = 35;
const LARGE_MOVE_THRESHOLD = 0.02;
const EXTREME_MOVE_THRESHOLD = 0.05;
const SHADOW_MIN_COMBINED_EVENTS = 200;
const SHADOW_MIN_LONG_EVENTS = 50;
const SHADOW_MIN_SHORT_EVENTS = 50;
const SHADOW_MIN_PRECISION = 0.55;
const SHADOW_MAX_FALSE_ALERT_RATE = 0.45;
const SHADOW_MAX_DUPLICATE_RATE = 0.1;
const SHADOW_MAX_SYMBOL_CONCENTRATION = 0.5;
const SHADOW_MAX_QUARTER_CONCENTRATION = 0.5;
const SHADOW_MAX_REGIME_CONCENTRATION = 0.8;
const RULE_VERSION = "hy-r4.15-v1";
const EXPERIMENT_COUNT = 1;

type DirectionalSignalType = "LONG_WATCH" | "SHORT_WATCH";
type EventCountKey = DirectionalSignalType | "RISK_WARNING" | "MARKET_STATUS";
type HorizonKey = "4h" | "12h" | "24h";

interface DailyEventCount {
  long: number;
  short: number;
  watch: number;
  risk: number;
}

interface ReplayAccumulator {
  events: OpportunityEvent[];
  invalidations: OpportunityInvalidation[];
  replays: Map<string, ReplayEvaluation[]>;
  daily: Map<string, DailyEventCount>;
  signal_count: Record<EventCountKey, number>;
  risk_outcomes: RiskOutcome[];
  duplicate_event_ids: Set<string>;
}

interface RiskOutcome {
  event_id: string;
  evaluable: boolean;
  large_move: boolean;
  negative_return: boolean;
  extreme_move: boolean;
}

interface QuantileReport {
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
}

interface DirectionReplayReport {
  event_count: number;
  horizons: Record<HorizonKey, {
    evaluable: number;
    direction_precision: number | null;
    false_alert_rate: number | null;
    average_directional_return: number | null;
    median_directional_return: number | null;
    mfe: number | null;
    mae: number | null;
    median_mfe: number | null;
    median_mae: number | null;
    mfe_mae_relationship: {
      median_ratio: number | null;
      median_mfe_greater_than_mae: boolean | null;
      mfe_greater_than_mae_rate: number | null;
    };
    time_to_mfe_hours: {
      average: number | null;
      median: number | null;
    };
    opportunity_value_quantiles: {
      mfe: QuantileReport;
      mae: QuantileReport;
      mfe_mae_ratio: QuantileReport;
    };
  }>;
}

interface RiskWarningReport {
  event_count: number;
  evaluable_24h: number;
  large_move_probability: number | null;
  negative_return_probability: number | null;
  extreme_move_probability: number | null;
}

interface DailyReport {
  observed_days: number;
  active_signal_days: number;
  average_long_per_day: number | null;
  average_short_per_day: number | null;
  average_watch_per_day: number | null;
  average_risk_warning_per_day: number | null;
  maximum_watch_per_day: number | null;
}

interface StabilityRow {
  key: string;
  event_count: number;
  long_count: number;
  short_count: number;
  evaluable_4h: number;
  precision_4h: number | null;
}

interface ConcentrationEntry {
  key: string | null;
  count: number;
  share: number | null;
}

interface StabilityReport {
  quarter: StabilityRow[];
  market_regime: StabilityRow[];
  symbol: StabilityRow[];
  concentration: {
    largest_symbol: ConcentrationEntry;
    largest_quarter: ConcentrationEntry;
    largest_regime: ConcentrationEntry;
    no_obvious_single_dependency: boolean;
  };
}

interface DuplicateReport {
  event_count: number;
  duplicate_count: number;
  duplicate_rate: number | null;
}

interface BaselineReport {
  source: "hy-r4.13-filtered-signal-evaluation.md";
  long_watch: 786;
  short_watch: 1154;
  precision_4h: 0.4701;
  false_alert_rate_4h: 0.5299;
  duplicate_rate_24h: 0.8549;
}

interface GateReport {
  combined_watch_events: number;
  minimum_combined_watch_events: number;
  long_events: number;
  minimum_long_events: number;
  short_events: number;
  minimum_short_events: number;
  combined_precision_4h: number | null;
  minimum_precision_4h: number;
  combined_false_alert_rate_4h: number | null;
  maximum_false_alert_rate_4h: number;
  duplicate_rate_24h: number | null;
  maximum_duplicate_rate_24h: number;
  median_normalized_mfe_4h: number | null;
  median_normalized_mae_4h: number | null;
  mfe_above_mae: boolean;
  concentration_pass: boolean;
  pit_safe_pass: boolean;
}

interface LockedReplayReport {
  schema_version: "hy-r4.15";
  rule_version: typeof RULE_VERSION;
  mode: "AUTHORITATIVE_LOCAL_PIT_SAFE_LOCKED_REPLAY";
  generated_at: string;
  experiment_count: number;
  rules_frozen_before_replay: true;
  post_result_tuning: false;
  historical_coverage: {
    requested_start: string;
    requested_end: string;
    actual_start: string | null;
    actual_end: string | null;
    datasets: number;
    sample_timestamps: number;
    evaluated_observations: number;
    pit_safe_observations: number;
    pit_unsafe_observations: number;
    pit_rejected_observations: number;
  };
  input_sources: {
    price: "existing PIT-safe local candles";
    volume: "existing PIT-safe local candles";
    trend: "existing R4.11 derived series";
    momentum: "existing R4.11 derived series";
    volatility: "existing R4.11 derived series";
    funding: "existing local funding cache";
    open_interest: "existing local OI cache";
    liquidity: "existing R4.10/R4.11 context";
    market_breadth: "existing R4.10/R4.11 context";
    new_alpha_source: false;
    machine_learning: false;
  };
  event_rules: {
    source_of_truth: "reports/hy-r4.14-opportunity-event-model-design.md";
    directional_input: "raw R4.8 dry-run candidate with locked R4.12 quality gates";
    directional_transition: "SETUP to CONFIRMED only";
    risk_transition: "NORMAL to HIGH_RISK or locked score escalation";
    market_status_transition: "status change only; no heartbeat event";
    episode_ttl_hours: 24;
    minimum_confirmation_sources: number;
    price_touch_rule: "closed-candle pullback/reclaim, breakout, or support/resistance interaction";
  };
  event_counts: Record<EventCountKey, number>;
  daily_alert_rate: DailyReport;
  long_evaluation: DirectionReplayReport;
  short_evaluation: DirectionReplayReport;
  risk_warning_evaluation: RiskWarningReport;
  duplicate_rate: {
    same_symbol_same_direction: Record<HorizonKey, DuplicateReport>;
  };
  stability: StabilityReport;
  baseline_comparison: BaselineReport;
  shadow_gate: GateReport;
  final_classification: "READY_FOR_SHADOW" | "NOT_READY" | "INSUFFICIENT_SAMPLE" | "RESEARCH_INVALID";
  event_records: Array<{
    event: OpportunityEvent;
    replay_evaluations: ReplayEvaluation[];
  }>;
  invalidation_counts: Record<string, number>;
  safety: {
    dry_run: true;
    production_modified: false;
    supabase_production_modified: false;
    vercel_modified: false;
    paper_strategy_modified: false;
    scanner_production_connected: false;
    emails_sent: 0;
    private_api_called: false;
    auto_trading: false;
    future_data_used_for_event_creation: false;
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
  const eventState = createOpportunityEventState();
  let evaluatedObservations = 0;
  let pitSafeObservations = 0;
  let pitUnsafeObservations = 0;
  let pitRejectedObservations = 0;
  let actualStart: number | null = null;
  let actualEnd: number | null = null;

  for (const context of contexts) {
    for (const sample of context.samples) {
      const breadth = breadthByTimestamp.get(sample.timestamp);
      if (!breadth) continue;
      const input = buildSignalInput(sample, breadth);
      const engineResult = await runSignalEngineDryRun(input);
      evaluatedObservations += 1;
      actualStart = actualStart === null ? sample.timestamp : Math.min(actualStart, sample.timestamp);
      actualEnd = actualEnd === null ? sample.timestamp : Math.max(actualEnd, sample.timestamp);
      if (engineResult.persistence_eligible) pitSafeObservations += 1;
      else pitUnsafeObservations += 1;
      ensureDailyObservation(accumulator.daily, sample.timestamp);

      const observation: OpportunityEventObservation = {
        symbol: sample.symbol,
        timestamp: sample.timestamp,
        input,
        scores: engineResult.scores,
        price_history: context.fourHour.slice(0, sample.four_hour_index + 1),
        directional_signals: directionalSignals(engineResult.signals),
        risk_warning: riskSignal(engineResult.signals),
      };
      const result = processOpportunityObservation(observation, eventState, defaultOpportunityEventPolicy);
      if (result.pit_rejected) pitRejectedObservations += 1;
      for (const invalidation of result.invalidations) {
        accumulator.invalidations.push(invalidation);
        const key = invalidation.code;
        accumulator.invalidation_counts[key] = (accumulator.invalidation_counts[key] ?? 0) + 1;
      }
      for (const event of result.events) {
        recordEvent(accumulator, event, context.fourHour);
      }
    }
  }

  const longEvents = accumulator.events.filter((event) => event.signal_type === "LONG_WATCH");
  const shortEvents = accumulator.events.filter((event) => event.signal_type === "SHORT_WATCH");
  const riskEvents = accumulator.events.filter((event) => event.signal_type === "RISK_WARNING");
  const statusEvents = accumulator.events.filter((event) => event.signal_type === "MARKET_STATUS");
  const longEvaluation = renderDirection(longEvents, accumulator.replays);
  const shortEvaluation = renderDirection(shortEvents, accumulator.replays);
  const riskEvaluation = renderRisk(accumulator.risk_outcomes);
  const dailyAlertRate = renderDaily(accumulator.daily);
  const stability = renderStability(longEvents.concat(shortEvents), accumulator.replays);
  const duplicateRate = {
    same_symbol_same_direction: {
      "4h": duplicateReport(longEvents.concat(shortEvents), 4),
      "12h": duplicateReport(longEvents.concat(shortEvents), 12),
      "24h": duplicateReport(longEvents.concat(shortEvents), 24),
    },
  };
  const shadowGate = renderShadowGate(
    longEvents,
    shortEvents,
    longEvaluation,
    shortEvaluation,
    duplicateRate.same_symbol_same_direction["24h"],
    stability,
    pitSafeObservations,
    pitUnsafeObservations,
    pitRejectedObservations,
  );
  const finalClassification = classify(shadowGate);
  const report: LockedReplayReport = {
    schema_version: "hy-r4.15",
    rule_version: RULE_VERSION,
    mode: "AUTHORITATIVE_LOCAL_PIT_SAFE_LOCKED_REPLAY",
    generated_at: new Date().toISOString(),
    experiment_count: EXPERIMENT_COUNT,
    rules_frozen_before_replay: true,
    post_result_tuning: false,
    historical_coverage: {
      requested_start: new Date(EVALUATION_START).toISOString(),
      requested_end: new Date(EVALUATION_END).toISOString(),
      actual_start: actualStart === null ? null : new Date(actualStart).toISOString(),
      actual_end: actualEnd === null ? null : new Date(actualEnd).toISOString(),
      datasets: files.length,
      sample_timestamps: evaluationTimestamps.length,
      evaluated_observations: evaluatedObservations,
      pit_safe_observations: pitSafeObservations,
      pit_unsafe_observations: pitUnsafeObservations,
      pit_rejected_observations: pitRejectedObservations,
    },
    input_sources: {
      price: "existing PIT-safe local candles",
      volume: "existing PIT-safe local candles",
      trend: "existing R4.11 derived series",
      momentum: "existing R4.11 derived series",
      volatility: "existing R4.11 derived series",
      funding: "existing local funding cache",
      open_interest: "existing local OI cache",
      liquidity: "existing R4.10/R4.11 context",
      market_breadth: "existing R4.10/R4.11 context",
      new_alpha_source: false,
      machine_learning: false,
    },
    event_rules: {
      source_of_truth: "reports/hy-r4.14-opportunity-event-model-design.md",
      directional_input: "raw R4.8 dry-run candidate with locked R4.12 quality gates",
      directional_transition: "SETUP to CONFIRMED only",
      risk_transition: "NORMAL to HIGH_RISK or locked score escalation",
      market_status_transition: "status change only; no heartbeat event",
      episode_ttl_hours: 24,
      minimum_confirmation_sources: defaultOpportunityEventPolicy.minimum_confirmation_sources,
      price_touch_rule: "closed-candle pullback/reclaim, breakout, or support/resistance interaction",
    },
    event_counts: {
      LONG_WATCH: longEvents.length,
      SHORT_WATCH: shortEvents.length,
      RISK_WARNING: riskEvents.length,
      MARKET_STATUS: statusEvents.length,
    },
    daily_alert_rate: dailyAlertRate,
    long_evaluation: longEvaluation,
    short_evaluation: shortEvaluation,
    risk_warning_evaluation: riskEvaluation,
    duplicate_rate: duplicateRate,
    stability,
    baseline_comparison: {
      source: "hy-r4.13-filtered-signal-evaluation.md",
      long_watch: 786,
      short_watch: 1154,
      precision_4h: 0.4701,
      false_alert_rate_4h: 0.5299,
      duplicate_rate_24h: 0.8549,
    },
    shadow_gate: shadowGate,
    final_classification: finalClassification,
    event_records: accumulator.events.map((event) => ({
      event,
      replay_evaluations: accumulator.replays.get(event.opportunity_event_id) ?? [],
    })),
    invalidation_counts: accumulator.invalidation_counts,
    safety: {
      dry_run: true,
      production_modified: false,
      supabase_production_modified: false,
      vercel_modified: false,
      paper_strategy_modified: false,
      scanner_production_connected: false,
      emails_sent: 0,
      private_api_called: false,
      auto_trading: false,
      future_data_used_for_event_creation: false,
    },
    validation: {
      tests: "pending",
      typecheck: "pending",
      lint: "pending",
    },
  };

  await mkdir(REPORT_DIRECTORY, { recursive: true });
  await writeFile(JSON_REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  await writeFile(MARKDOWN_REPORT_PATH, renderMarkdown(report), "utf8");
  console.log(JSON.stringify({
    json_report: JSON_REPORT_PATH,
    markdown_report: MARKDOWN_REPORT_PATH,
    event_counts: report.event_counts,
    daily_alert_rate: report.daily_alert_rate,
    shadow_gate: report.shadow_gate,
    final_classification: report.final_classification,
  }, null, 2));
}

function createAccumulator(): ReplayAccumulator & { invalidation_counts: Record<string, number> } {
  return {
    events: [],
    invalidations: [],
    replays: new Map(),
    daily: new Map(),
    signal_count: {
      LONG_WATCH: 0,
      SHORT_WATCH: 0,
      RISK_WARNING: 0,
      MARKET_STATUS: 0,
    },
    risk_outcomes: [],
    duplicate_event_ids: new Set(),
    invalidation_counts: {},
  };
}

function directionalSignals(
  signals: readonly SignalEngineSignal[],
): Partial<Record<"LONG" | "SHORT", SignalEngineSignal>> {
  const result: Partial<Record<"LONG" | "SHORT", SignalEngineSignal>> = {};
  for (const signal of signals) {
    if (signal.signal_type === "LONG_WATCH") result.LONG = signal;
    if (signal.signal_type === "SHORT_WATCH") result.SHORT = signal;
  }
  return result;
}

function riskSignal(signals: readonly SignalEngineSignal[]): SignalEngineSignal | null {
  return signals.find((signal) => signal.signal_type === "RISK_WARNING") ?? null;
}

function recordEvent(
  accumulator: ReplayAccumulator & { invalidation_counts: Record<string, number> },
  event: OpportunityEvent,
  candles: Candle[],
): void {
  if (accumulator.events.some((existing) => existing.opportunity_event_id === event.opportunity_event_id)) {
    accumulator.duplicate_event_ids.add(event.opportunity_event_id);
    return;
  }
  accumulator.events.push(event);
  accumulator.signal_count[event.signal_type] += 1;
  const daily = ensureDailyObservation(accumulator.daily, Date.parse(event.observed_at));
  if (event.signal_type === "LONG_WATCH") {
    daily.long += 1;
    daily.watch += 1;
    const replays = replayOpportunityEvent(event, candles);
    accumulator.replays.set(event.opportunity_event_id, replays);
  } else if (event.signal_type === "SHORT_WATCH") {
    daily.short += 1;
    daily.watch += 1;
    const replays = replayOpportunityEvent(event, candles);
    accumulator.replays.set(event.opportunity_event_id, replays);
  } else if (event.signal_type === "RISK_WARNING") {
    daily.risk += 1;
    accumulator.risk_outcomes.push(evaluateRiskEvent(event, candles));
  }
}

function evaluateRiskEvent(event: OpportunityEvent, candles: Candle[]): RiskOutcome {
  const eventTime = Date.parse(event.observed_at);
  const currentIndex = lastIndexAtOrBefore(candles, eventTime);
  const current = candles[currentIndex];
  const endIndex = firstIndexAtOrAfter(candles, eventTime + 24 * 60 * 60 * 1000, currentIndex + 1);
  const future = endIndex === -1 ? null : candles[endIndex];
  if (!current || !future || current.close <= 0 || future.close <= 0) {
    return {
      event_id: event.opportunity_event_id,
      evaluable: false,
      large_move: false,
      negative_return: false,
      extreme_move: false,
    };
  }
  const return24h = future.close / event.reference_price - 1;
  return {
    event_id: event.opportunity_event_id,
    evaluable: true,
    large_move: Math.abs(return24h) >= LARGE_MOVE_THRESHOLD,
    negative_return: return24h < 0,
    extreme_move: Math.abs(return24h) >= EXTREME_MOVE_THRESHOLD,
  };
}

function renderDirection(
  events: OpportunityEvent[],
  replays: Map<string, ReplayEvaluation[]>,
): DirectionReplayReport {
  return {
    event_count: events.length,
    horizons: {
      "4h": renderHorizon(events, replays, "4h"),
      "12h": renderHorizon(events, replays, "12h"),
      "24h": renderHorizon(events, replays, "24h"),
    },
  };
}

function renderHorizon(
  events: OpportunityEvent[],
  replays: Map<string, ReplayEvaluation[]>,
  horizon: ReplayHorizon,
): DirectionReplayReport["horizons"]["4h"] {
  const values = events
    .map((event) => replays.get(event.opportunity_event_id)?.find((replay) => replay.horizon === horizon))
    .filter((replay): replay is ReplayEvaluation => replay?.replay_status === "COMPLETE");
  const returns = values.map((replay) => replay.aligned_return).filter(isNumber);
  const mfes = values.map((replay) => replay.max_favorable_move).filter(isNumber);
  const maes = values.map((replay) => replay.max_adverse_move).filter(isNumber);
  const ratios = values
    .map((replay) => (
      replay.max_favorable_move !== null
      && replay.max_adverse_move !== null
      && replay.max_adverse_move > 0
        ? replay.max_favorable_move / replay.max_adverse_move
        : null
    ))
    .filter(isNumber);
  const times = values.map((replay) => replay.time_to_mfe_hours).filter(isNumber);
  const precision = returns.length > 0 ? returns.filter((value) => value > 0).length / returns.length : null;
  const medianMfe = median(mfes);
  const medianMae = median(maes);
  return {
    evaluable: values.length,
    direction_precision: precision === null ? null : round(precision),
    false_alert_rate: precision === null ? null : round(1 - precision),
    average_directional_return: average(returns),
    median_directional_return: median(returns),
    mfe: average(mfes),
    mae: average(maes),
    median_mfe: medianMfe,
    median_mae: medianMae,
    mfe_mae_relationship: {
      median_ratio: median(ratios),
      median_mfe_greater_than_mae: medianMfe === null || medianMae === null ? null : medianMfe > medianMae,
      mfe_greater_than_mae_rate: mfes.length === maes.length && mfes.length > 0
        ? round(mfes.filter((value, index) => value > maes[index]!).length / mfes.length)
        : null,
    },
    time_to_mfe_hours: {
      average: average(times),
      median: median(times),
    },
    opportunity_value_quantiles: {
      mfe: quantiles(mfes),
      mae: quantiles(maes),
      mfe_mae_ratio: quantiles(ratios),
    },
  };
}

function renderRisk(outcomes: RiskOutcome[]): RiskWarningReport {
  const evaluable = outcomes.filter((outcome) => outcome.evaluable);
  return {
    event_count: outcomes.length,
    evaluable_24h: evaluable.length,
    large_move_probability: probability(evaluable.filter((outcome) => outcome.large_move).length, evaluable.length),
    negative_return_probability: probability(evaluable.filter((outcome) => outcome.negative_return).length, evaluable.length),
    extreme_move_probability: probability(evaluable.filter((outcome) => outcome.extreme_move).length, evaluable.length),
  };
}

function renderDaily(daily: Map<string, DailyEventCount>): DailyReport {
  const values = [...daily.values()];
  if (values.length === 0) {
    return {
      observed_days: 0,
      active_signal_days: 0,
      average_long_per_day: null,
      average_short_per_day: null,
      average_watch_per_day: null,
      average_risk_warning_per_day: null,
      maximum_watch_per_day: null,
    };
  }
  const total = values.reduce((sum, value) => ({
    long: sum.long + value.long,
    short: sum.short + value.short,
    watch: sum.watch + value.watch,
    risk: sum.risk + value.risk,
  }), { long: 0, short: 0, watch: 0, risk: 0 });
  return {
    observed_days: values.length,
    active_signal_days: values.filter((value) => value.watch > 0 || value.risk > 0).length,
    average_long_per_day: round(total.long / values.length),
    average_short_per_day: round(total.short / values.length),
    average_watch_per_day: round(total.watch / values.length),
    average_risk_warning_per_day: round(total.risk / values.length),
    maximum_watch_per_day: Math.max(...values.map((value) => value.watch)),
  };
}

function renderStability(
  events: OpportunityEvent[],
  replays: Map<string, ReplayEvaluation[]>,
): StabilityReport {
  const quarter = stabilityRows(events, replays, (event) => quarterKey(event.observed_at));
  const marketRegime = stabilityRows(events, replays, (event) => event.market_regime);
  const symbol = stabilityRows(events, replays, (event) => event.symbol);
  const directionalCount = events.length;
  const concentration = {
    largest_symbol: concentrationEntry(symbol, directionalCount),
    largest_quarter: concentrationEntry(quarter, directionalCount),
    largest_regime: concentrationEntry(marketRegime, directionalCount),
    no_obvious_single_dependency: (
      (concentrationEntry(symbol, directionalCount).share ?? 1) <= SHADOW_MAX_SYMBOL_CONCENTRATION
      && (concentrationEntry(quarter, directionalCount).share ?? 1) <= SHADOW_MAX_QUARTER_CONCENTRATION
      && (concentrationEntry(marketRegime, directionalCount).share ?? 1) <= SHADOW_MAX_REGIME_CONCENTRATION
    ),
  };
  return { quarter, market_regime: marketRegime, symbol, concentration };
}

function stabilityRows(
  events: OpportunityEvent[],
  replays: Map<string, ReplayEvaluation[]>,
  keyOf: (event: OpportunityEvent) => string,
): StabilityRow[] {
  const grouped = new Map<string, OpportunityEvent[]>();
  for (const event of events) {
    const key = keyOf(event);
    const group = grouped.get(key) ?? [];
    group.push(event);
    grouped.set(key, group);
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, group]) => {
    const values = group
      .map((event) => replays.get(event.opportunity_event_id)?.find((replay) => replay.horizon === "4h"))
      .filter((replay): replay is ReplayEvaluation => replay?.replay_status === "COMPLETE");
    const precision = values.length > 0
      ? values.filter((replay) => (replay.aligned_return ?? 0) > 0).length / values.length
      : null;
    return {
      key,
      event_count: group.length,
      long_count: group.filter((event) => event.signal_type === "LONG_WATCH").length,
      short_count: group.filter((event) => event.signal_type === "SHORT_WATCH").length,
      evaluable_4h: values.length,
      precision_4h: precision === null ? null : round(precision),
    };
  });
}

function concentrationEntry(rows: StabilityRow[], total: number): ConcentrationEntry {
  const largest = [...rows].sort((left, right) => right.event_count - left.event_count)[0];
  return {
    key: largest?.key ?? null,
    count: largest?.event_count ?? 0,
    share: total > 0 && largest ? round(largest.event_count / total) : null,
  };
}

function duplicateReport(events: OpportunityEvent[], hours: number): DuplicateReport {
  const grouped = new Map<string, OpportunityEvent[]>();
  for (const event of events) {
    const key = event.symbol + ":" + event.signal_type;
    const group = grouped.get(key) ?? [];
    group.push(event);
    grouped.set(key, group);
  }
  let duplicateCount = 0;
  for (const group of grouped.values()) {
    group.sort((left, right) => Date.parse(left.observed_at) - Date.parse(right.observed_at));
    for (let index = 1; index < group.length; index += 1) {
      if (Date.parse(group[index]!.observed_at) - Date.parse(group[index - 1]!.observed_at) < hours * 60 * 60 * 1000) {
        duplicateCount += 1;
      }
    }
  }
  return {
    event_count: events.length,
    duplicate_count: duplicateCount,
    duplicate_rate: probability(duplicateCount, events.length),
  };
}

function renderShadowGate(
  longEvents: OpportunityEvent[],
  shortEvents: OpportunityEvent[],
  longEvaluation: DirectionReplayReport,
  shortEvaluation: DirectionReplayReport,
  duplicate: DuplicateReport,
  stability: StabilityReport,
  pitSafeObservations: number,
  pitUnsafeObservations: number,
  pitRejectedObservations: number,
): GateReport {
  const combined4h = combineHorizon(longEvaluation, shortEvaluation, "4h");
  const mfeValues = [
    longEvaluation.horizons["4h"].median_mfe,
    shortEvaluation.horizons["4h"].median_mfe,
  ].filter(isNumber);
  const maeValues = [
    longEvaluation.horizons["4h"].median_mae,
    shortEvaluation.horizons["4h"].median_mae,
  ].filter(isNumber);
  const medianMfe = median(mfeValues);
  const medianMae = median(maeValues);
  return {
    combined_watch_events: longEvents.length + shortEvents.length,
    minimum_combined_watch_events: SHADOW_MIN_COMBINED_EVENTS,
    long_events: longEvents.length,
    minimum_long_events: SHADOW_MIN_LONG_EVENTS,
    short_events: shortEvents.length,
    minimum_short_events: SHADOW_MIN_SHORT_EVENTS,
    combined_precision_4h: combined4h.precision,
    minimum_precision_4h: SHADOW_MIN_PRECISION,
    combined_false_alert_rate_4h: combined4h.precision === null ? null : round(1 - combined4h.precision),
    maximum_false_alert_rate_4h: SHADOW_MAX_FALSE_ALERT_RATE,
    duplicate_rate_24h: duplicate.duplicate_rate,
    maximum_duplicate_rate_24h: SHADOW_MAX_DUPLICATE_RATE,
    median_normalized_mfe_4h: medianMfe,
    median_normalized_mae_4h: medianMae,
    mfe_above_mae: medianMfe !== null && medianMae !== null && medianMfe > medianMae,
    concentration_pass: stability.concentration.no_obvious_single_dependency,
    pit_safe_pass: pitUnsafeObservations === 0 && pitRejectedObservations === 0 && pitSafeObservations > 0,
  };
}

function combineHorizon(
  longEvaluation: DirectionReplayReport,
  shortEvaluation: DirectionReplayReport,
  horizon: HorizonKey,
): { precision: number | null; evaluable: number } {
  const long = longEvaluation.horizons[horizon];
  const short = shortEvaluation.horizons[horizon];
  const longWins = long.direction_precision === null ? 0 : long.direction_precision * long.evaluable;
  const shortWins = short.direction_precision === null ? 0 : short.direction_precision * short.evaluable;
  const evaluable = long.evaluable + short.evaluable;
  return {
    precision: evaluable > 0 ? round((longWins + shortWins) / evaluable) : null,
    evaluable,
  };
}

function classify(gate: GateReport): LockedReplayReport["final_classification"] {
  if (gate.pit_safe_pass === false) return "RESEARCH_INVALID";
  if (
    gate.combined_watch_events < gate.minimum_combined_watch_events
    || gate.long_events < gate.minimum_long_events
    || gate.short_events < gate.minimum_short_events
    || gate.combined_precision_4h === null
  ) return "INSUFFICIENT_SAMPLE";
  if (
    gate.combined_precision_4h < gate.minimum_precision_4h
    || (gate.combined_false_alert_rate_4h ?? 1) > gate.maximum_false_alert_rate_4h
    || (gate.duplicate_rate_24h ?? 1) > gate.maximum_duplicate_rate_24h
    || !gate.mfe_above_mae
    || !gate.concentration_pass
  ) return "NOT_READY";
  return "READY_FOR_SHADOW";
}

function ensureDailyObservation(daily: Map<string, DailyEventCount>, timestamp: number): DailyEventCount {
  const key = new Date(timestamp).toISOString().slice(0, 10);
  const existing = daily.get(key);
  if (existing) return existing;
  const value = { long: 0, short: 0, watch: 0, risk: 0 };
  daily.set(key, value);
  return value;
}

function quarterKey(timestamp: string): string {
  const date = new Date(timestamp);
  return date.getUTCFullYear() + "-Q" + (Math.floor(date.getUTCMonth() / 3) + 1);
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

function lastIndexAtOrBefore(candles: Candle[], timestamp: number): number {
  let low = 0;
  let high = candles.length - 1;
  let answer = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle]!.closeTime <= timestamp) {
      answer = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return answer;
}

function isNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

function average(values: number[]): number | null {
  return values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!);
}

function quantiles(values: number[]): QuantileReport {
  if (values.length === 0) return { p25: null, p50: null, p75: null, p90: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
  };
}

function quantile(sorted: number[], probabilityValue: number): number {
  const index = (sorted.length - 1) * probabilityValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return round(sorted[lower]!);
  return round(sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower));
}

function probability(count: number, denominator: number): number | null {
  return denominator > 0 ? round(count / denominator) : null;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function renderMarkdown(report: LockedReplayReport): string {
  const eventRows = (["LONG_WATCH", "SHORT_WATCH", "RISK_WARNING", "MARKET_STATUS"] as const)
    .map((type) => "| " + type + " | " + report.event_counts[type] + " |")
    .join("\n");
  const quarterRows = report.stability.quarter.length > 0
    ? report.stability.quarter.map(stabilityRow).join("\n")
    : "| none | 0 | 0 | 0 | 0 | - |";
  const regimeRows = report.stability.market_regime.length > 0
    ? report.stability.market_regime.map(stabilityRow).join("\n")
    : "| none | 0 | 0 | 0 | 0 | - |";
  const symbolRows = report.stability.symbol.length > 0
    ? report.stability.symbol.slice(0, 10).map(stabilityRow).join("\n")
    : "| none | 0 | 0 | 0 | 0 | - |";
  const invalidationRows = Object.entries(report.invalidation_counts)
    .sort(([, left], [, right]) => right - left)
    .map(([key, value]) => "| " + key + " | " + value + " |")
    .join("\n") || "| none | 0 |";
  return [
    "# HY-R4.15 Opportunity Event + Locked Replay",
    "",
    "## Locked experiment",
    "",
    "- Rule version: " + report.rule_version,
    "- Source of truth: " + report.event_rules.source_of_truth,
    "- Experiment count: " + report.experiment_count,
    "- Rules frozen before replay: YES",
    "- Post-result tuning: NO",
    "- Mode: " + report.mode,
    "- Requested coverage: " + report.historical_coverage.requested_start + " → " + report.historical_coverage.requested_end,
    "- Actual evaluated coverage: " + (report.historical_coverage.actual_start ?? "-") + " → " + (report.historical_coverage.actual_end ?? "-"),
    "- Datasets/sample timestamps: " + report.historical_coverage.datasets + "/" + report.historical_coverage.sample_timestamps,
    "",
    "The replay consumed the raw R4.8 dry-run candidates so the new detector could observe persistent candidate state. It applied the locked R4.12 quality gates for directional setup admission, then required a SETUP → CONFIRMED transition. No performance result was used to change the rules.",
    "",
    "## Event counts",
    "",
    "| Event | Count |",
    "| --- | ---: |",
    eventRows,
    "",
    "## Daily alert rate",
    "",
    "- Observed days/active days: " + report.daily_alert_rate.observed_days + "/" + report.daily_alert_rate.active_signal_days,
    "- Average LONG/SHORT/WATCH/RISK per day: " + format(report.daily_alert_rate.average_long_per_day) + "/" + format(report.daily_alert_rate.average_short_per_day) + "/" + format(report.daily_alert_rate.average_watch_per_day) + "/" + format(report.daily_alert_rate.average_risk_warning_per_day),
    "- Maximum WATCH per day: " + format(report.daily_alert_rate.maximum_watch_per_day),
    "",
    "## LONG_WATCH replay",
    "",
    renderDirectionMarkdown(report.long_evaluation),
    "",
    "## SHORT_WATCH replay",
    "",
    renderDirectionMarkdown(report.short_evaluation),
    "",
    "## RISK_WARNING replay",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    "| Event count | " + report.risk_warning_evaluation.event_count + " |",
    "| Evaluable 24h | " + report.risk_warning_evaluation.evaluable_24h + " |",
    "| Large 24h move probability | " + format(report.risk_warning_evaluation.large_move_probability) + " |",
    "| Negative 24h return probability | " + format(report.risk_warning_evaluation.negative_return_probability) + " |",
    "| Extreme 24h move probability | " + format(report.risk_warning_evaluation.extreme_move_probability) + " |",
    "",
    "## Same-symbol same-direction duplication",
    "",
    "| Horizon | Events | Duplicates | Rate |",
    "| --- | ---: | ---: | ---: |",
    ...(["4h", "12h", "24h"] as const).map((horizon) => {
      const value = report.duplicate_rate.same_symbol_same_direction[horizon];
      return "| " + horizon + " | " + value.event_count + " | " + value.duplicate_count + " | " + format(value.duplicate_rate) + " |";
    }),
    "",
    "## Stability",
    "",
    "### Quarter",
    "",
    "| Quarter | Events | LONG | SHORT | Evaluable 4h | Precision 4h |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    quarterRows,
    "",
    "### Market regime",
    "",
    "| Regime | Events | LONG | SHORT | Evaluable 4h | Precision 4h |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    regimeRows,
    "",
    "### Symbol (top 10 by directional event count)",
    "",
    "| Symbol | Events | LONG | SHORT | Evaluable 4h | Precision 4h |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    symbolRows,
    "",
    "- Largest symbol concentration: " + concentrationText(report.stability.concentration.largest_symbol),
    "- Largest quarter concentration: " + concentrationText(report.stability.concentration.largest_quarter),
    "- Largest regime concentration: " + concentrationText(report.stability.concentration.largest_regime),
    "- No obvious single-symbol/quarter/regime dependency: " + (report.stability.concentration.no_obvious_single_dependency ? "PASS" : "FAIL"),
    "",
    "## Opportunity Value",
    "",
    "Opportunity Value is reported as continuous excursion distributions; no threshold was mined from replay performance.",
    "- Directional MFE/MAE are normalized to the watch direction.",
    "- Each horizon reports average and median MFE/MAE, MFE/MAE relationship, time to MFE, and p25/p50/p75/p90 quantiles.",
    "- MFE/MAE gate uses the combined 4h median values only for Shadow qualification.",
    "",
    "## Baseline comparison",
    "",
    "| Metric | HY-R4.13 baseline | HY-R4.15 event model |",
    "| --- | ---: | ---: |",
    "| LONG_WATCH | " + report.baseline_comparison.long_watch + " | " + report.event_counts.LONG_WATCH + " |",
    "| SHORT_WATCH | " + report.baseline_comparison.short_watch + " | " + report.event_counts.SHORT_WATCH + " |",
    "| 4h precision | " + report.baseline_comparison.precision_4h + " | " + format(report.shadow_gate.combined_precision_4h) + " combined |",
    "| 4h false alert rate | " + report.baseline_comparison.false_alert_rate_4h + " | " + format(report.shadow_gate.combined_false_alert_rate_4h) + " combined |",
    "| 24h duplicate rate | " + report.baseline_comparison.duplicate_rate_24h + " | " + format(report.shadow_gate.duplicate_rate_24h) + " |",
    "",
    "## Shadow gate",
    "",
    "- Combined/LONG/SHORT events: " + report.shadow_gate.combined_watch_events + "/" + report.shadow_gate.long_events + "/" + report.shadow_gate.short_events + " (minimum " + report.shadow_gate.minimum_combined_watch_events + "/" + report.shadow_gate.minimum_long_events + "/" + report.shadow_gate.minimum_short_events + ")",
    "- Combined 4h precision: " + format(report.shadow_gate.combined_precision_4h) + " (minimum " + report.shadow_gate.minimum_precision_4h + ")",
    "- Combined 4h false alert rate: " + format(report.shadow_gate.combined_false_alert_rate_4h) + " (maximum " + report.shadow_gate.maximum_false_alert_rate_4h + ")",
    "- 24h duplicate rate: " + format(report.shadow_gate.duplicate_rate_24h) + " (maximum " + report.shadow_gate.maximum_duplicate_rate_24h + ")",
    "- Median normalized MFE/MAE 4h: " + format(report.shadow_gate.median_normalized_mfe_4h) + "/" + format(report.shadow_gate.median_normalized_mae_4h) + "; MFE > MAE: " + (report.shadow_gate.mfe_above_mae ? "PASS" : "FAIL"),
    "- Concentration: " + (report.shadow_gate.concentration_pass ? "PASS" : "FAIL"),
    "- PIT-safe: " + (report.shadow_gate.pit_safe_pass ? "PASS" : "FAIL"),
    "",
    "## Final classification",
    "",
    "**" + report.final_classification + "**",
    "",
    "## Invalidation audit",
    "",
    "| Invalidation | Count |",
    "| --- | ---: |",
    invalidationRows,
    "",
    "## Safety and validation",
    "",
    "- PIT-safe observations: " + report.historical_coverage.pit_safe_observations + "; PIT-unsafe: " + report.historical_coverage.pit_unsafe_observations + "; PIT-rejected: " + report.historical_coverage.pit_rejected_observations,
    "- New alpha source: NO; ML: NO; future data used for event creation: NO.",
    "- Production/Supabase/Vercel/PAPER/scanner modified: NO.",
    "- Emails sent: 0; private API called: NO; AUTO_TRADING: FALSE.",
    "",
    "- Tests: " + report.validation.tests,
    "- typecheck: " + report.validation.typecheck,
    "- lint: " + report.validation.lint,
    "",
  ].join("\n");
}

function renderDirectionMarkdown(report: DirectionReplayReport): string {
  return [
    "- Event count: " + report.event_count,
    "",
    "| Horizon | Evaluable | Precision | False alert | Avg return | Median return | MFE | MAE | Median MFE | Median MAE | Median MFE/MAE | Time to MFE avg/median |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...(["4h", "12h", "24h"] as const).map((horizon) => {
      const value = report.horizons[horizon];
      return "| " + horizon + " | " + value.evaluable + " | " + format(value.direction_precision) + " | " + format(value.false_alert_rate) + " | " + format(value.average_directional_return) + " | " + format(value.median_directional_return) + " | " + format(value.mfe) + " | " + format(value.mae) + " | " + format(value.median_mfe) + " | " + format(value.median_mae) + " | " + format(value.mfe_mae_relationship.median_ratio) + " | " + format(value.time_to_mfe_hours.average) + "/" + format(value.time_to_mfe_hours.median) + " |";
    }),
    "",
    "Opportunity Value quantiles (MFE/MAE/ratio p25, p50, p75, p90):",
    "",
    ...(["4h", "12h", "24h"] as const).map((horizon) => {
      const value = report.horizons[horizon].opportunity_value_quantiles;
      return "- " + horizon + ": MFE " + quantileText(value.mfe) + "; MAE " + quantileText(value.mae) + "; ratio " + quantileText(value.mfe_mae_ratio);
    }),
  ].join("\n");
}

function stabilityRow(row: StabilityRow): string {
  return "| " + row.key + " | " + row.event_count + " | " + row.long_count + " | " + row.short_count + " | " + row.evaluable_4h + " | " + format(row.precision_4h) + " |";
}

function quantileText(value: QuantileReport): string {
  return format(value.p25) + "/" + format(value.p50) + "/" + format(value.p75) + "/" + format(value.p90);
}

function concentrationText(value: ConcentrationEntry): string {
  return (value.key ?? "-") + " (" + value.count + ", share " + format(value.share) + ")";
}

function format(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "-" : String(value);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
