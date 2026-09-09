import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
import { calculateMarketBreadthFeature } from "../lib/market-context";
import type { MarketBreadthFeature, MarketBreadthMember } from "../lib/market-context";
import { directionEvidence, type SignalEngineInput } from "../lib/signal-engine";
import type { Candle } from "../lib/core/types";

const DATA_DIRECTORY = resolve("data", "hy-r2b-history-24m");
const R4_15_REPORT_PATH = resolve("reports", "hy-r4.15-opportunity-event-locked-replay.json");
const REPORT_DIRECTORY = resolve("reports");
const JSON_REPORT_PATH = resolve(REPORT_DIRECTORY, "hy-r4.16-signal-information-gain-audit.json");
const MARKDOWN_REPORT_PATH = resolve(REPORT_DIRECTORY, "hy-r4.16-signal-information-gain-audit.md");

const EVALUATION_START = Date.parse("2024-08-09T00:00:00.000Z");
const EVALUATION_END = Date.parse("2026-08-09T23:59:59.999Z");
const RULE_VERSION = "hy-r4.15-v1";
const AUDIT_VERSION = "hy-r4.16-v1";
const EXPERIMENT_COUNT = 1;
const BOOTSTRAP_REPLICATES = 2_000;
const PERMUTATION_REPLICATES = 2_000;
const BOOTSTRAP_SEED = 41_616;
const LARGE_MOVE_THRESHOLD = 0.02;
const EXTREME_MOVE_THRESHOLD = 0.05;
const MIN_RESEARCH_MATCHING_COVERAGE = 0.5;
const MIN_ROBUST_MATCHING_COVERAGE = 0.8;
const MIN_CONDITIONAL_COMPONENT_PAIRS = 30;
const CONDITIONAL_P_VALUE_THRESHOLD = 0.1;
const TOP_UNIVERSE_SIZE = 10;
const BREADTH_MINIMUM_MEMBERS = 35;

const HORIZONS = ["4h", "12h", "24h"] as const;
type Horizon = (typeof HORIZONS)[number];
type Direction = "LONG" | "SHORT";
type SignalType = "LONG_WATCH" | "SHORT_WATCH";
type Statistic = "mean" | "median";

const COMPONENTS = [
  "PRICE_STRUCTURE",
  "TREND",
  "MOMENTUM",
  "VOLUME",
  "VOLATILITY",
  "FUNDING",
  "OPEN_INTEREST",
  "LIQUIDITY",
  "MARKET_BREADTH",
  "ENTRY_CONTEXT",
  "CONFIRMATION",
] as const;
type ComponentName = (typeof COMPONENTS)[number];

type DirectionContext = "LONG" | "SHORT" | "NEUTRAL";
type MatchField =
  | "symbol"
  | "direction_context"
  | "quarter"
  | "market_regime"
  | "liquidity_bucket"
  | "volatility_bucket"
  | "breadth_state";

interface LockedEvent {
  opportunity_event_id: string;
  signal_type: SignalType | "RISK_WARNING" | "MARKET_STATUS";
  symbol: string;
  observed_at: string;
  market_regime: string;
  market_status: string;
  entry_context: { pattern: string } | null;
  confirmations: Array<{ source: string; direction: string; code: string }>;
}

interface LockedReplayReport {
  rule_version: string;
  experiment_count: number;
  event_counts: Record<string, number>;
  historical_coverage: {
    datasets: number;
    pit_unsafe_observations: number;
    pit_rejected_observations: number;
  };
  event_records: Array<{ event: LockedEvent }>;
}

interface HistoricalObservation {
  observation_key: string;
  symbol: string;
  timestamp: number;
  quarter: string;
  market_regime: string;
  direction_context: DirectionContext;
  liquidity_bucket: string;
  volatility_bucket: string;
  breadth_state: string;
  sample: SymbolSample;
  breadth: MarketBreadthFeature;
  context: SymbolContext;
}

interface MatchSpec {
  name: string;
  fields: readonly MatchField[];
}

interface MatchIndex {
  spec: MatchSpec;
  buckets: Map<string, HistoricalObservation[]>;
}

interface MatchSummary {
  requested: number;
  matched: number;
  unmatched: number;
  coverage: number | null;
  match_level_counts: Record<string, number>;
  unmatched_reasons: Record<string, number>;
  controls_without_signal: number;
  controls_from_future: number;
}

interface DirectionPair {
  direction: Direction;
  event: LockedEvent;
  signal: HistoricalObservation;
  control: HistoricalObservation;
  match_level: string;
}

interface RiskPair {
  event: LockedEvent;
  signal: HistoricalObservation;
  control: HistoricalObservation;
  match_level: string;
}

interface DirectionOutcome {
  future_price: number;
  aligned_return: number;
  mfe: number;
  mae: number;
}

interface RiskOutcome {
  future_return: number;
  realized_volatility: number;
  large_move: number;
  extreme_move: number;
  negative_return: number;
  drawdown_proxy: number;
}

interface OutcomePair {
  signal: DirectionOutcome;
  control: DirectionOutcome;
}

interface RiskOutcomePair {
  signal: RiskOutcome;
  control: RiskOutcome;
}

interface MetricComparison {
  signal: number | null;
  control: number | null;
  effect_size_signal_minus_control: number | null;
  ci95: { lower: number | null; upper: number | null };
  paired_samples: number;
  permutation_p_value: number | null;
  holm_adjusted_p_value: number | null;
}

interface HorizonComparison {
  evaluable_pairs: number;
  direction_precision: MetricComparison;
  average_directional_return: MetricComparison;
  median_directional_return: MetricComparison;
  mfe: MetricComparison;
  mae: MetricComparison;
  mfe_mae: MetricComparison;
}

interface DirectionAudit {
  signal_count: number;
  matched_control_count: number;
  matching_coverage: number | null;
  matching: MatchSummary;
  horizons: Record<Horizon, HorizonComparison>;
}

interface CombinedMetric {
  signal: number | null;
  control: number | null;
  effect_size_signal_minus_control: number | null;
  paired_samples: number;
}

interface CombinedDirectionalAudit {
  horizons: Record<Horizon, {
    direction_precision: CombinedMetric;
    average_directional_return: CombinedMetric;
    mfe: CombinedMetric;
    mae: CombinedMetric;
  }>;
}

interface RiskAudit {
  signal_count: number;
  matched_control_count: number;
  matching_coverage: number | null;
  matching: MatchSummary;
  evaluation_horizon: "24h";
  evaluable_pairs: number;
  realized_volatility_24h: MetricComparison;
  large_move_probability_24h: MetricComparison;
  extreme_move_probability_24h: MetricComparison;
  negative_return_probability_24h: MetricComparison;
  drawdown_proxy_24h: MetricComparison;
}

interface StabilityRow {
  key: string;
  pair_count: number;
  evaluable_4h: number;
  signal_precision_4h: number | null;
  control_precision_4h: number | null;
  precision_lift_4h: number | null;
  signal_mfe_4h: number | null;
  control_mfe_4h: number | null;
  mfe_lift_4h: number | null;
}

interface StabilityReport {
  quarter: StabilityRow[];
  market_regime: StabilityRow[];
  symbol: StabilityRow[];
  concentration: {
    largest_symbol: { key: string | null; count: number; share: number | null };
    largest_quarter: { key: string | null; count: number; share: number | null };
    largest_regime: { key: string | null; count: number; share: number | null };
    no_obvious_single_dependency: boolean;
  };
  stable_across_quarters: boolean;
  stable_across_regimes: boolean;
}

interface ComponentAuditRow {
  component: ComponentName;
  method: "PREDEFINED_COMPONENT_CONDITIONED_COMPARISON";
  total_directional_pairs: number;
  signal_present_count: number;
  control_present_count: number;
  signal_present_rate: number | null;
  control_present_rate: number | null;
  conditioned_pair_count: number;
  variation_identifiable: boolean;
  four_hour_precision: MetricComparison;
  four_hour_mfe: MetricComparison;
  interpretation: string;
}

interface MatchingCoverageReport {
  directional_signal_events: number;
  directional_matched_controls: number;
  directional_coverage: number | null;
  risk_warning_events: number;
  risk_warning_matched_controls: number;
  risk_warning_coverage: number | null;
  control_selection: "WITHOUT_REPLACEMENT";
  control_time_rule: "CONTROL_TIMESTAMP_STRICTLY_BEFORE_SIGNAL_TIMESTAMP";
  future_data_used_for_matching: false;
  outcome_used_for_matching: false;
}

interface LockedAuditReport {
  schema_version: "hy-r4.16";
  audit_version: typeof AUDIT_VERSION;
  baseline: {
    rule_version: typeof RULE_VERSION;
    source_report: "hy-r4.15-opportunity-event-locked-replay.json";
    post_result_tuning: false;
    known_long_watch: 80;
    known_short_watch: 109;
    known_combined_watch: 189;
    known_precision_4h: 0.5027;
    known_duplicate_rate_24h: 0.0212;
  };
  experiment: {
    experiment_count: 1;
    rules_frozen_before_audit: true;
    post_result_tuning: false;
    no_new_thresholds: true;
    no_new_alpha_source: true;
    machine_learning: false;
  };
  historical_coverage: {
    requested_start: string;
    requested_end: string;
    actual_start: string | null;
    actual_end: string | null;
    datasets: number;
    sample_timestamps: number;
    observations: number;
    pit_safe_observations: number;
    pit_unsafe_observations: number;
    r4_15_event_observation_matches: number;
  };
  matching_methodology: {
    primary_fields: string[];
    directional_fallback_levels: Array<{ level: string; fields: string[] }>;
    risk_fallback_levels: Array<{ level: string; fields: string[] }>;
    no_outcome_matching: true;
    no_future_matching: true;
    no_replacement: true;
    deterministic_selection: "LATEST_ELIGIBLE_PRIOR_OBSERVATION_WITHIN_PREDECLARED_LEVEL";
  };
  matching_coverage: MatchingCoverageReport;
  signal_counts: {
    LONG_WATCH: number;
    SHORT_WATCH: number;
    combined_directional: number;
    RISK_WARNING: number;
    MARKET_STATUS: number;
  };
  control_counts: {
    LONG_WATCH: number;
    SHORT_WATCH: number;
    combined_directional: number;
    RISK_WARNING: number;
  };
  long: DirectionAudit;
  short: DirectionAudit;
  combined_directional: CombinedDirectionalAudit;
  risk_warning: RiskAudit;
  component_audit: {
    method: "PREDEFINED_COMPONENT_CONDITIONED_COMPARISON";
    exploratory: true;
    components: ComponentAuditRow[];
    robust_components: ComponentName[];
  };
  stability: StabilityReport;
  multiple_testing: {
    primary_directional_family: {
      tests: number;
      correction: "HOLM_STEP_DOWN";
      p_value_definition: "PAIRED_SIGN_FLIP_PERMUTATION_ON_MEAN_DIFFERENCE";
    };
    risk_family: {
      tests: number;
      correction: "HOLM_STEP_DOWN";
    };
    component_family: {
      tests: number;
      handling: "EXPLORATORY_NO_CONFIRMATORY_CLAIM";
    };
    bootstrap: {
      replicates: number;
      seed: number;
      confidence_level: "95_PERCENTILE_CI";
    };
    permutation: {
      replicates: number;
      seed: number;
      two_sided: true;
    };
  };
  baseline_comparison: {
    baseline_long_watch: 786;
    baseline_short_watch: 1154;
    baseline_precision_4h: 0.4701;
    baseline_false_alert_rate_4h: 0.5299;
    baseline_duplicate_rate_24h: 0.8549;
    event_model_long_watch: number;
    event_model_short_watch: number;
    event_model_precision_4h: number | null;
    event_model_duplicate_rate_24h: number | null;
    interpretation: string;
  };
  final_classification:
    | "ROBUST_INCREMENTAL_INFORMATION"
    | "CONDITIONAL_INFORMATION_ONLY"
    | "NO_INCREMENTAL_INFORMATION"
    | "RESEARCH_INVALID";
  next_stage_recommendation: string;
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
  };
  validation: {
    tests: string;
    typecheck: string;
    lint: string;
  };
}

const DIRECTION_MATCH_SPECS: MatchSpec[] = [
  {
    name: "EXACT_SYMBOL_DIRECTION_QUARTER_REGIME_LIQUIDITY_VOLATILITY_BREADTH",
    fields: ["symbol", "direction_context", "quarter", "market_regime", "liquidity_bucket", "volatility_bucket", "breadth_state"],
  },
  {
    name: "DROP_BREADTH",
    fields: ["symbol", "direction_context", "quarter", "market_regime", "liquidity_bucket", "volatility_bucket"],
  },
  {
    name: "DROP_VOLATILITY_AND_BREADTH",
    fields: ["symbol", "direction_context", "quarter", "market_regime", "liquidity_bucket"],
  },
  {
    name: "SYMBOL_DIRECTION_REGIME_ONLY",
    fields: ["symbol", "direction_context", "market_regime"],
  },
];

const RISK_MATCH_SPECS: MatchSpec[] = [
  {
    name: "EXACT_SYMBOL_QUARTER_REGIME_LIQUIDITY_VOLATILITY_BREADTH",
    fields: ["symbol", "quarter", "market_regime", "liquidity_bucket", "volatility_bucket", "breadth_state"],
  },
  {
    name: "DROP_BREADTH",
    fields: ["symbol", "quarter", "market_regime", "liquidity_bucket", "volatility_bucket"],
  },
  {
    name: "DROP_VOLATILITY_AND_BREADTH",
    fields: ["symbol", "quarter", "market_regime", "liquidity_bucket"],
  },
  {
    name: "SYMBOL_REGIME_ONLY",
    fields: ["symbol", "market_regime"],
  },
];

async function main(): Promise<void> {
  const lockedReplay = await loadLockedReplayReport();
  validateLockedBaseline(lockedReplay);
  const allEvents = lockedReplay.event_records.map((record) => record.event);
  const eventKeys = new Set(allEvents.map((event) => eventObservationKey(event)));
  const directionalEvents = allEvents.filter(isDirectionalEvent);
  const riskEvents = allEvents.filter((event) => event.signal_type === "RISK_WARNING");
  const observations = await loadHistoricalObservations();
  const observationsByKey = new Map(observations.map((observation) => [observation.observation_key, observation]));
  const pitUnsafeObservations = observations.filter((observation) => !isPitSafeObservation(observation)).length;
  const r4_15EventObservationMatches = directionalEvents.filter((event) => observationsByKey.has(eventObservationKey(event))).length;

  const directionIndexes = DIRECTION_MATCH_SPECS.map((spec) => buildMatchIndex(observations, spec));
  const riskIndexes = RISK_MATCH_SPECS.map((spec) => buildMatchIndex(observations, spec));
  const usedDirectionalControls = new Set<string>();
  const usedRiskControls = new Set<string>();
  const longResult = matchDirectionalEvents(
    directionalEvents.filter((event) => event.signal_type === "LONG_WATCH"),
    "LONG",
    observationsByKey,
    directionIndexes,
    eventKeys,
    usedDirectionalControls,
  );
  const shortResult = matchDirectionalEvents(
    directionalEvents.filter((event) => event.signal_type === "SHORT_WATCH"),
    "SHORT",
    observationsByKey,
    directionIndexes,
    eventKeys,
    usedDirectionalControls,
  );
  const riskResult = matchRiskEvents(
    riskEvents,
    observationsByKey,
    riskIndexes,
    eventKeys,
    usedRiskControls,
  );
  const directionalPairs = longResult.pairs.concat(shortResult.pairs);
  const longAudit = buildDirectionAudit(longResult.pairs, longResult.summary);
  const shortAudit = buildDirectionAudit(shortResult.pairs, shortResult.summary);
  const combinedDirectional = buildCombinedDirectionalAudit(longAudit, shortAudit);
  const riskAudit = buildRiskAudit(riskResult.pairs, riskResult.summary);
  const stability = buildStabilityReport(directionalPairs);
  const componentAudit = buildComponentAudit(directionalPairs);
  applyHolmCorrection([
    ...collectDirectionalMetrics(longAudit),
    ...collectDirectionalMetrics(shortAudit),
  ]);
  applyHolmCorrection(collectRiskMetrics(riskAudit));

  const actualStart = observations.length > 0
    ? observations.reduce((minimum, observation) => Math.min(minimum, observation.timestamp), Number.POSITIVE_INFINITY)
    : null;
  const actualEnd = observations.length > 0
    ? observations.reduce((maximum, observation) => Math.max(maximum, observation.timestamp), Number.NEGATIVE_INFINITY)
    : null;
  const directionalCoverage = coverage(directionalPairs.length, directionalEvents.length);
  const riskCoverage = coverage(riskResult.pairs.length, riskEvents.length);
  const finalClassification = classifyAudit({
    pitUnsafeObservations,
    r4_15EventObservationMatches,
    directionalEvents: directionalEvents.length,
    directionalCoverage,
    riskEvents: riskEvents.length,
    riskCoverage,
    longAudit,
    shortAudit,
    riskAudit,
    stability,
  });
  const eventModelPrecision4h = combinedMetric(longAudit, shortAudit, "direction_precision");
  const report: LockedAuditReport = {
    schema_version: "hy-r4.16",
    audit_version: AUDIT_VERSION,
    baseline: {
      rule_version: RULE_VERSION,
      source_report: "hy-r4.15-opportunity-event-locked-replay.json",
      post_result_tuning: false,
      known_long_watch: 80,
      known_short_watch: 109,
      known_combined_watch: 189,
      known_precision_4h: 0.5027,
      known_duplicate_rate_24h: 0.0212,
    },
    experiment: {
      experiment_count: EXPERIMENT_COUNT,
      rules_frozen_before_audit: true,
      post_result_tuning: false,
      no_new_thresholds: true,
      no_new_alpha_source: true,
      machine_learning: false,
    },
    historical_coverage: {
      requested_start: new Date(EVALUATION_START).toISOString(),
      requested_end: new Date(EVALUATION_END).toISOString(),
      actual_start: actualStart === null ? null : new Date(actualStart).toISOString(),
      actual_end: actualEnd === null ? null : new Date(actualEnd).toISOString(),
      datasets: observations.length === 0 ? 0 : new Set(observations.map((observation) => observation.symbol)).size,
      sample_timestamps: new Set(observations.map((observation) => observation.timestamp)).size,
      observations: observations.length,
      pit_safe_observations: observations.length - pitUnsafeObservations,
      pit_unsafe_observations: pitUnsafeObservations,
      r4_15_event_observation_matches: r4_15EventObservationMatches,
    },
    matching_methodology: {
      primary_fields: ["symbol", "direction context", "UTC quarter", "market regime", "liquidity bucket", "volatility bucket", "breadth state"],
      directional_fallback_levels: DIRECTION_MATCH_SPECS.map((spec) => ({ level: spec.name, fields: [...spec.fields] })),
      risk_fallback_levels: RISK_MATCH_SPECS.map((spec) => ({ level: spec.name, fields: [...spec.fields] })),
      no_outcome_matching: true,
      no_future_matching: true,
      no_replacement: true,
      deterministic_selection: "LATEST_ELIGIBLE_PRIOR_OBSERVATION_WITHIN_PREDECLARED_LEVEL",
    },
    matching_coverage: {
      directional_signal_events: directionalEvents.length,
      directional_matched_controls: directionalPairs.length,
      directional_coverage: directionalCoverage,
      risk_warning_events: riskEvents.length,
      risk_warning_matched_controls: riskResult.pairs.length,
      risk_warning_coverage: riskCoverage,
      control_selection: "WITHOUT_REPLACEMENT",
      control_time_rule: "CONTROL_TIMESTAMP_STRICTLY_BEFORE_SIGNAL_TIMESTAMP",
      future_data_used_for_matching: false,
      outcome_used_for_matching: false,
    },
    signal_counts: {
      LONG_WATCH: longResult.summary.requested,
      SHORT_WATCH: shortResult.summary.requested,
      combined_directional: directionalEvents.length,
      RISK_WARNING: riskEvents.length,
      MARKET_STATUS: allEvents.filter((event) => event.signal_type === "MARKET_STATUS").length,
    },
    control_counts: {
      LONG_WATCH: longResult.pairs.length,
      SHORT_WATCH: shortResult.pairs.length,
      combined_directional: directionalPairs.length,
      RISK_WARNING: riskResult.pairs.length,
    },
    long: longAudit,
    short: shortAudit,
    combined_directional: combinedDirectional,
    risk_warning: riskAudit,
    component_audit: componentAudit,
    stability,
    multiple_testing: {
      primary_directional_family: {
        tests: collectDirectionalMetrics(longAudit).length + collectDirectionalMetrics(shortAudit).length,
        correction: "HOLM_STEP_DOWN",
        p_value_definition: "PAIRED_SIGN_FLIP_PERMUTATION_ON_MEAN_DIFFERENCE",
      },
      risk_family: {
        tests: collectRiskMetrics(riskAudit).length,
        correction: "HOLM_STEP_DOWN",
      },
      component_family: {
        tests: COMPONENTS.length * 2,
        handling: "EXPLORATORY_NO_CONFIRMATORY_CLAIM",
      },
      bootstrap: {
        replicates: BOOTSTRAP_REPLICATES,
        seed: BOOTSTRAP_SEED,
        confidence_level: "95_PERCENTILE_CI",
      },
      permutation: {
        replicates: PERMUTATION_REPLICATES,
        seed: BOOTSTRAP_SEED,
        two_sided: true,
      },
    },
    baseline_comparison: {
      baseline_long_watch: 786,
      baseline_short_watch: 1154,
      baseline_precision_4h: 0.4701,
      baseline_false_alert_rate_4h: 0.5299,
      baseline_duplicate_rate_24h: 0.8549,
      event_model_long_watch: longResult.pairs.length,
      event_model_short_watch: shortResult.pairs.length,
      event_model_precision_4h: eventModelPrecision4h,
      event_model_duplicate_rate_24h: null,
      interpretation: "R4.13 and R4.15 use different event semantics and denominators; this comparison is descriptive, not a causal lift estimate.",
    },
    final_classification: finalClassification,
    next_stage_recommendation: nextStageRecommendation(finalClassification, componentAudit),
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
    },
    validation: {
      tests: "pending",
      typecheck: "pending",
      lint: "pending",
    },
  };

  await mkdir(REPORT_DIRECTORY, { recursive: true });
  await writeFile(JSON_REPORT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(MARKDOWN_REPORT_PATH, renderMarkdown(report), "utf8");
  console.log(JSON.stringify({
    json_report: JSON_REPORT_PATH,
    markdown_report: MARKDOWN_REPORT_PATH,
    historical_observations: report.historical_coverage.observations,
    signal_events: report.signal_counts.combined_directional,
    matched_controls: report.control_counts.combined_directional,
    directional_coverage: report.matching_coverage.directional_coverage,
    risk_warning_coverage: report.matching_coverage.risk_warning_coverage,
    combined_precision_4h: report.baseline_comparison.event_model_precision_4h,
    classification: report.final_classification,
  }, null, 2));
}

async function loadLockedReplayReport(): Promise<LockedReplayReport> {
  const content = await readFile(R4_15_REPORT_PATH, "utf8");
  return JSON.parse(content) as LockedReplayReport;
}

function validateLockedBaseline(report: LockedReplayReport): void {
  if (report.rule_version !== RULE_VERSION) throw new Error("R4.15 rule version is not locked to hy-r4.15-v1");
  if (report.experiment_count !== 1) throw new Error("R4.15 baseline experiment count is not 1");
  if (report.event_counts.LONG_WATCH !== 80 || report.event_counts.SHORT_WATCH !== 109) {
    throw new Error("R4.15 directional event counts changed");
  }
  if (
    report.historical_coverage.datasets !== 49
    || report.historical_coverage.pit_unsafe_observations !== 0
    || report.historical_coverage.pit_rejected_observations !== 0
  ) throw new Error("R4.15 historical/PIT baseline changed");
}

async function loadHistoricalObservations(): Promise<HistoricalObservation[]> {
  const files = (await readdir(DATA_DIRECTORY)).filter((fileName) => fileName.endsWith(".json")).sort();
  if (files.length !== 49) throw new Error("Expected exactly 49 HY-R2B datasets");
  const firstDataset = await loadDataset(files[0]!);
  const sampleTimestamps = buildSampleTimestamps(firstDataset);
  const evaluationTimestamps = sampleTimestamps.filter((timestamp) => timestamp >= EVALUATION_START && timestamp <= EVALUATION_END);
  const contexts: SymbolContext[] = [];
  const membersByTimestamp = new Map<number, MarketBreadthMember[]>();
  for (const fileName of files) {
    const dataset = await loadDataset(fileName);
    const context = buildSymbolContext(dataset, await loadOpenInterest(dataset.symbol), sampleTimestamps);
    contexts.push(context);
    for (const memberPoint of context.members) {
      const members = membersByTimestamp.get(memberPoint.timestamp) ?? [];
      members.push(memberPoint.member);
      membersByTimestamp.set(memberPoint.timestamp, members);
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
  const observations: HistoricalObservation[] = [];
  for (const context of contexts) {
    for (const sample of context.samples) {
      if (sample.timestamp < EVALUATION_START || sample.timestamp > EVALUATION_END) continue;
      const breadth = breadthByTimestamp.get(sample.timestamp);
      if (!breadth) continue;
      observations.push({
        observation_key: sample.symbol + "@" + sample.timestamp,
        symbol: sample.symbol,
        timestamp: sample.timestamp,
        quarter: quarterKey(sample.timestamp),
        market_regime: sample.market_regime,
        direction_context: sample.market_regime === "BULL" ? "LONG" : sample.market_regime === "BEAR" ? "SHORT" : "NEUTRAL",
        liquidity_bucket: sample.liquidity.status,
        volatility_bucket: volatilityBucket(sample.volatility_percentile),
        breadth_state: breadth.status,
        sample,
        breadth,
        context,
      });
    }
  }
  return observations;
}

function buildMatchIndex(observations: HistoricalObservation[], spec: MatchSpec): MatchIndex {
  const buckets = new Map<string, HistoricalObservation[]>();
  for (const observation of observations) {
    const key = matchKey(observation, spec.fields);
    const bucket = buckets.get(key) ?? [];
    bucket.push(observation);
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) bucket.sort((left, right) => left.timestamp - right.timestamp);
  return { spec, buckets };
}

function matchDirectionalEvents(
  events: LockedEvent[],
  direction: Direction,
  observationsByKey: Map<string, HistoricalObservation>,
  indexes: MatchIndex[],
  eventKeys: Set<string>,
  usedControls: Set<string>,
): { pairs: DirectionPair[]; summary: MatchSummary } {
  const summary = emptyMatchSummary(DIRECTION_MATCH_SPECS);
  const pairs: DirectionPair[] = [];
  for (const event of [...events].sort(compareEvents)) {
    summary.requested += 1;
    const signal = observationsByKey.get(eventObservationKey(event));
    if (!signal) {
      increment(summary.unmatched_reasons, "SIGNAL_OBSERVATION_MISSING");
      summary.unmatched += 1;
      continue;
    }
    const result = findControl(signal, indexes, eventKeys, usedControls);
    if (!result) {
      increment(summary.unmatched_reasons, "NO_PREDECLARED_PRIOR_MATCH");
      summary.unmatched += 1;
      continue;
    }
    if (result.control.timestamp >= signal.timestamp) summary.controls_from_future += 1;
    if (eventKeys.has(result.control.observation_key)) {
      increment(summary.unmatched_reasons, "CONTROL_HAS_SIGNAL");
      summary.unmatched += 1;
      usedControls.delete(result.control.observation_key);
      continue;
    }
    increment(summary.match_level_counts, result.match_level);
    summary.matched += 1;
    summary.controls_without_signal += 1;
    pairs.push({ direction, event, signal, control: result.control, match_level: result.match_level });
  }
  summary.coverage = coverage(summary.matched, summary.requested);
  return { pairs, summary };
}

function matchRiskEvents(
  events: LockedEvent[],
  observationsByKey: Map<string, HistoricalObservation>,
  indexes: MatchIndex[],
  eventKeys: Set<string>,
  usedControls: Set<string>,
): { pairs: RiskPair[]; summary: MatchSummary } {
  const summary = emptyMatchSummary(RISK_MATCH_SPECS);
  const pairs: RiskPair[] = [];
  for (const event of [...events].sort(compareEvents)) {
    summary.requested += 1;
    const signal = observationsByKey.get(eventObservationKey(event));
    if (!signal) {
      increment(summary.unmatched_reasons, "SIGNAL_OBSERVATION_MISSING");
      summary.unmatched += 1;
      continue;
    }
    const result = findControl(signal, indexes, eventKeys, usedControls);
    if (!result) {
      increment(summary.unmatched_reasons, "NO_PREDECLARED_PRIOR_MATCH");
      summary.unmatched += 1;
      continue;
    }
    if (result.control.timestamp >= signal.timestamp) summary.controls_from_future += 1;
    if (eventKeys.has(result.control.observation_key)) {
      increment(summary.unmatched_reasons, "CONTROL_HAS_SIGNAL");
      summary.unmatched += 1;
      usedControls.delete(result.control.observation_key);
      continue;
    }
    increment(summary.match_level_counts, result.match_level);
    summary.matched += 1;
    summary.controls_without_signal += 1;
    pairs.push({ event, signal, control: result.control, match_level: result.match_level });
  }
  summary.coverage = coverage(summary.matched, summary.requested);
  return { pairs, summary };
}

function findControl(
  signal: HistoricalObservation,
  indexes: MatchIndex[],
  eventKeys: Set<string>,
  usedControls: Set<string>,
): { control: HistoricalObservation; match_level: string } | null {
  for (const index of indexes) {
    const bucket = index.buckets.get(matchKey(signal, index.spec.fields));
    if (!bucket) continue;
    for (let indexPosition = bucket.length - 1; indexPosition >= 0; indexPosition -= 1) {
      const candidate = bucket[indexPosition]!;
      if (candidate.timestamp >= signal.timestamp) continue;
      if (eventKeys.has(candidate.observation_key) || usedControls.has(candidate.observation_key)) continue;
      usedControls.add(candidate.observation_key);
      return { control: candidate, match_level: index.spec.name };
    }
  }
  return null;
}

function buildDirectionAudit(pairs: DirectionPair[], matching: MatchSummary): DirectionAudit {
  const horizons = {} as Record<Horizon, HorizonComparison>;
  for (const [horizonIndex, horizon] of HORIZONS.entries()) {
    const outcomePairs = pairs
      .map((pair) => {
        const signal = directionOutcome(pair.signal, pair.direction, horizon);
        const control = directionOutcome(pair.control, pair.direction, horizon);
        return signal && control ? { signal, control } : null;
      })
      .filter((pair): pair is OutcomePair => pair !== null);
    horizons[horizon] = {
      evaluable_pairs: outcomePairs.length,
      direction_precision: compareOutcomeMetric(outcomePairs, (outcome) => outcome.aligned_return > 0 ? 1 : 0, "mean", 100 + horizonIndex),
      average_directional_return: compareOutcomeMetric(outcomePairs, (outcome) => outcome.aligned_return, "mean", 110 + horizonIndex),
      median_directional_return: compareOutcomeMetric(outcomePairs, (outcome) => outcome.aligned_return, "median", 120 + horizonIndex),
      mfe: compareOutcomeMetric(outcomePairs, (outcome) => outcome.mfe, "mean", 130 + horizonIndex),
      mae: compareOutcomeMetric(outcomePairs, (outcome) => outcome.mae, "mean", 140 + horizonIndex),
      mfe_mae: compareOutcomeMetric(outcomePairs, (outcome) => outcome.mae > 0 ? outcome.mfe / outcome.mae : null, "median", 150 + horizonIndex),
    };
  }
  return {
    signal_count: matching.requested,
    matched_control_count: pairs.length,
    matching_coverage: matching.coverage,
    matching,
    horizons,
  };
}

function buildRiskAudit(pairs: RiskPair[], matching: MatchSummary): RiskAudit {
  const outcomePairs = pairs
    .map((pair) => {
      const signal = riskOutcome(pair.signal);
      const control = riskOutcome(pair.control);
      return signal && control ? { signal, control } : null;
    })
    .filter((pair): pair is RiskOutcomePair => pair !== null);
  return {
    signal_count: matching.requested,
    matched_control_count: pairs.length,
    matching_coverage: matching.coverage,
    matching,
    evaluation_horizon: "24h",
    evaluable_pairs: outcomePairs.length,
    realized_volatility_24h: compareRiskMetric(outcomePairs, (outcome) => outcome.realized_volatility, 201),
    large_move_probability_24h: compareRiskMetric(outcomePairs, (outcome) => outcome.large_move, 202),
    extreme_move_probability_24h: compareRiskMetric(outcomePairs, (outcome) => outcome.extreme_move, 203),
    negative_return_probability_24h: compareRiskMetric(outcomePairs, (outcome) => outcome.negative_return, 204),
    drawdown_proxy_24h: compareRiskMetric(outcomePairs, (outcome) => outcome.drawdown_proxy, 205),
  };
}

function buildCombinedDirectionalAudit(long: DirectionAudit, short: DirectionAudit): CombinedDirectionalAudit {
  const horizons = {} as CombinedDirectionalAudit["horizons"];
  for (const horizon of HORIZONS) {
    const longMetrics = long.horizons[horizon];
    const shortMetrics = short.horizons[horizon];
    horizons[horizon] = {
      direction_precision: combineMetric(longMetrics.direction_precision, shortMetrics.direction_precision),
      average_directional_return: combineMetric(longMetrics.average_directional_return, shortMetrics.average_directional_return),
      mfe: combineMetric(longMetrics.mfe, shortMetrics.mfe),
      mae: combineMetric(longMetrics.mae, shortMetrics.mae),
    };
  }
  return { horizons };
}

function combineMetric(long: MetricComparison, short: MetricComparison): CombinedMetric {
  const longCount = long.paired_samples;
  const shortCount = short.paired_samples;
  const total = longCount + shortCount;
  if (total === 0 || long.signal === null || short.signal === null || long.control === null || short.control === null) {
    return { signal: null, control: null, effect_size_signal_minus_control: null, paired_samples: 0 };
  }
  const signal = (long.signal * longCount + short.signal * shortCount) / total;
  const control = (long.control * longCount + short.control * shortCount) / total;
  return {
    signal,
    control,
    effect_size_signal_minus_control: signal - control,
    paired_samples: total,
  };
}

function buildStabilityReport(pairs: DirectionPair[]): StabilityReport {
  const quarter = buildStabilityRows(pairs, (pair) => pair.signal.quarter);
  const marketRegime = buildStabilityRows(pairs, (pair) => pair.signal.market_regime);
  const symbol = buildStabilityRows(pairs, (pair) => pair.signal.symbol);
  const total = pairs.length;
  const largestSymbol = concentration(symbol, total);
  const largestQuarter = concentration(quarter, total);
  const largestRegime = concentration(marketRegime, total);
  return {
    quarter,
    market_regime: marketRegime,
    symbol,
    concentration: {
      largest_symbol: largestSymbol,
      largest_quarter: largestQuarter,
      largest_regime: largestRegime,
      no_obvious_single_dependency: [largestSymbol, largestQuarter, largestRegime].every((entry) => entry.share === null || entry.share <= 0.5),
    },
    stable_across_quarters: stabilityPass(quarter),
    stable_across_regimes: stabilityPass(marketRegime),
  };
}

function buildStabilityRows(pairs: DirectionPair[], keyOf: (pair: DirectionPair) => string): StabilityRow[] {
  const groups = new Map<string, DirectionPair[]>();
  for (const pair of pairs) {
    const key = keyOf(pair);
    const group = groups.get(key) ?? [];
    group.push(pair);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, group]) => {
    const outcomePairs = group
      .map((pair) => {
        const signal = directionOutcome(pair.signal, pair.direction, "4h");
        const control = directionOutcome(pair.control, pair.direction, "4h");
        return signal && control ? { signal, control } : null;
      })
      .filter((pair): pair is OutcomePair => pair !== null);
    const precision = compareOutcomeMetric(outcomePairs, (outcome) => outcome.aligned_return > 0 ? 1 : 0, "mean", 301 + key.length);
    const mfe = compareOutcomeMetric(outcomePairs, (outcome) => outcome.mfe, "mean", 401 + key.length);
    return {
      key,
      pair_count: group.length,
      evaluable_4h: outcomePairs.length,
      signal_precision_4h: precision.signal,
      control_precision_4h: precision.control,
      precision_lift_4h: precision.effect_size_signal_minus_control,
      signal_mfe_4h: mfe.signal,
      control_mfe_4h: mfe.control,
      mfe_lift_4h: mfe.effect_size_signal_minus_control,
    };
  });
}

function buildComponentAudit(pairs: DirectionPair[]): LockedAuditReport["component_audit"] {
  const rows = COMPONENTS.map((component, componentIndex) => {
    const signalPresent = pairs.filter((pair) => componentPresent(pair.signal, pair.direction, component));
    const controlPresentCount = pairs.filter((pair) => componentPresent(pair.control, pair.direction, component)).length;
    const outcomePairs = signalPresent
      .map((pair) => {
        const signal = directionOutcome(pair.signal, pair.direction, "4h");
        const control = directionOutcome(pair.control, pair.direction, "4h");
        return signal && control ? { signal, control } : null;
      })
      .filter((pair): pair is OutcomePair => pair !== null);
    const precision = compareOutcomeMetric(outcomePairs, (outcome) => outcome.aligned_return > 0 ? 1 : 0, "mean", 501 + componentIndex);
    const mfe = compareOutcomeMetric(outcomePairs, (outcome) => outcome.mfe, "mean", 601 + componentIndex);
    const signalPresentRate = coverage(signalPresent.length, pairs.length);
    const controlPresentRate = coverage(controlPresentCount, pairs.length);
    const variationIdentifiable = signalPresent.length > 0
      && signalPresent.length < pairs.length
      && controlPresentCount > 0
      && controlPresentCount < pairs.length;
    return {
      component,
      method: "PREDEFINED_COMPONENT_CONDITIONED_COMPARISON",
      total_directional_pairs: pairs.length,
      signal_present_count: signalPresent.length,
      control_present_count: controlPresentCount,
      signal_present_rate: signalPresentRate,
      control_present_rate: controlPresentRate,
      conditioned_pair_count: outcomePairs.length,
      variation_identifiable: variationIdentifiable,
      four_hour_precision: precision,
      four_hour_mfe: mfe,
      interpretation: variationIdentifiable
        ? "Exploratory conditional comparison; not used to change the locked event rule."
        : "No within-event variation sufficient for a component-specific incremental claim.",
    } satisfies ComponentAuditRow;
  });
  const robustComponents = rows
    .filter((row) => (
      row.variation_identifiable
      && row.conditioned_pair_count >= MIN_CONDITIONAL_COMPONENT_PAIRS
      && (row.four_hour_precision.ci95.lower ?? 0) > 0
      && (row.four_hour_mfe.ci95.lower ?? 0) > 0
    ))
    .map((row) => row.component);
  return {
    method: "PREDEFINED_COMPONENT_CONDITIONED_COMPARISON",
    exploratory: true,
    components: rows,
    robust_components: robustComponents,
  };
}

function classifyAudit(input: {
  pitUnsafeObservations: number;
  r4_15EventObservationMatches: number;
  directionalEvents: number;
  directionalCoverage: number | null;
  riskEvents: number;
  riskCoverage: number | null;
  longAudit: DirectionAudit;
  shortAudit: DirectionAudit;
  riskAudit: RiskAudit;
  stability: StabilityReport;
}): LockedAuditReport["final_classification"] {
  if (
    input.pitUnsafeObservations > 0
    || input.r4_15EventObservationMatches < input.directionalEvents
    || (input.directionalCoverage !== null && input.directionalCoverage < MIN_RESEARCH_MATCHING_COVERAGE)
    || (input.riskEvents > 0 && input.riskCoverage !== null && input.riskCoverage < MIN_RESEARCH_MATCHING_COVERAGE)
  ) return "RESEARCH_INVALID";

  const robust = input.directionalCoverage !== null
    && input.directionalCoverage >= MIN_ROBUST_MATCHING_COVERAGE
    && input.stability.stable_across_quarters
    && input.stability.stable_across_regimes
    && allDirectionalHorizonsPass(input.longAudit, input.shortAudit)
    && (input.riskAudit.realized_volatility_24h.ci95.lower ?? 0) > 0;
  if (robust) return "ROBUST_INCREMENTAL_INFORMATION";

  const conditional = [input.longAudit, input.shortAudit]
    .some((audit) => HORIZONS.some((horizon) => (
      hasConditionalEvidence(audit.horizons[horizon].direction_precision)
      || hasConditionalEvidence(audit.horizons[horizon].mfe)
    ))) || hasConditionalEvidence(input.riskAudit.realized_volatility_24h);
  if (conditional) return "CONDITIONAL_INFORMATION_ONLY";
  return "NO_INCREMENTAL_INFORMATION";
}

function allDirectionalHorizonsPass(long: DirectionAudit, short: DirectionAudit): boolean {
  return [long, short].every((audit) => HORIZONS.every((horizon) => {
    const metrics = audit.horizons[horizon];
    return (metrics.direction_precision.ci95.lower ?? 0) > 0
      && (metrics.mfe.ci95.lower ?? 0) > 0;
  }));
}

function hasConditionalEvidence(metric: MetricComparison): boolean {
  return (metric.ci95.lower ?? 0) > 0
    && (metric.holm_adjusted_p_value ?? metric.permutation_p_value ?? 1) < CONDITIONAL_P_VALUE_THRESHOLD;
}

function nextStageRecommendation(
  classification: LockedAuditReport["final_classification"],
  componentAudit: LockedAuditReport["component_audit"],
): string {
  if (classification === "ROBUST_INCREMENTAL_INFORMATION") {
    return "Only design a separately preregistered Shadow validation; do not deploy, email, trade, or change PAPER strategy.";
  }
  if (classification === "CONDITIONAL_INFORMATION_ONLY") {
    const componentText = componentAudit.robust_components.length > 0
      ? componentAudit.robust_components.join(", ")
      : "NONE isolated confirmatorily";
    return "Continue only a separately preregistered validation of the existing conditional evidence; component audit result: " + componentText + ". No Shadow, email, deployment, or parameter change is authorized.";
  }
  if (classification === "NO_INCREMENTAL_INFORMATION") {
    return "Stop further parameter optimization of the current Price/Volume/Funding/OI/Liquidity/Breadth Opportunity Event route. Future research may examine orthogonal categories only: order-book depth/imbalance, liquidation flow, options positioning, cross-asset/macro context, or on-chain flow; none is implemented here.";
  }
  return "Research is invalid until the PIT or matching defect is corrected under a new preregistered audit; do not use this result for Shadow or production.";
}

function collectDirectionalMetrics(audit: DirectionAudit): MetricComparison[] {
  return HORIZONS.flatMap((horizon) => {
    const metrics = audit.horizons[horizon];
    return [
      metrics.direction_precision,
      metrics.average_directional_return,
      metrics.median_directional_return,
      metrics.mfe,
      metrics.mae,
      metrics.mfe_mae,
    ];
  });
}

function collectRiskMetrics(audit: RiskAudit): MetricComparison[] {
  return [
    audit.realized_volatility_24h,
    audit.large_move_probability_24h,
    audit.extreme_move_probability_24h,
    audit.negative_return_probability_24h,
    audit.drawdown_proxy_24h,
  ];
}

function applyHolmCorrection(metrics: MetricComparison[]): void {
  const eligible = metrics
    .filter((metric) => metric.permutation_p_value !== null)
    .sort((left, right) => (left.permutation_p_value ?? 1) - (right.permutation_p_value ?? 1));
  let previous = 0;
  for (const [index, metric] of eligible.entries()) {
    const raw = Math.min(1, (eligible.length - index) * (metric.permutation_p_value ?? 1));
    const adjusted = Math.max(previous, raw);
    metric.holm_adjusted_p_value = adjusted;
    previous = adjusted;
  }
}

function compareOutcomeMetric(
  pairs: OutcomePair[],
  selector: (outcome: DirectionOutcome) => number | null,
  statistic: Statistic,
  seedOffset: number,
): MetricComparison {
  const rows = pairs
    .map((pair) => ({ signal: selector(pair.signal), control: selector(pair.control) }))
    .filter((row): row is { signal: number; control: number } => row.signal !== null && row.control !== null && Number.isFinite(row.signal) && Number.isFinite(row.control));
  return compareRows(rows, statistic, seedOffset);
}

function compareRiskMetric(
  pairs: RiskOutcomePair[],
  selector: (outcome: RiskOutcome) => number | null,
  seedOffset: number,
): MetricComparison {
  const rows = pairs
    .map((pair) => ({ signal: selector(pair.signal), control: selector(pair.control) }))
    .filter((row): row is { signal: number; control: number } => row.signal !== null && row.control !== null && Number.isFinite(row.signal) && Number.isFinite(row.control));
  return compareRows(rows, "mean", seedOffset);
}

function compareRows(
  rows: Array<{ signal: number; control: number }>,
  statisticType: Statistic,
  seedOffset: number,
): MetricComparison {
  if (rows.length === 0) {
    return {
      signal: null,
      control: null,
      effect_size_signal_minus_control: null,
      ci95: { lower: null, upper: null },
      paired_samples: 0,
      permutation_p_value: null,
      holm_adjusted_p_value: null,
    };
  }
  const signalValues = rows.map((row) => row.signal);
  const controlValues = rows.map((row) => row.control);
  const signal = statistic(signalValues, statisticType);
  const control = statistic(controlValues, statisticType);
  const effect = signal !== null && control !== null ? signal - control : null;
  const bootstrap = bootstrapDifference(signalValues, controlValues, statisticType, BOOTSTRAP_SEED + seedOffset);
  const permutation = permutationPValue(signalValues, controlValues, BOOTSTRAP_SEED + 10_000 + seedOffset);
  return {
    signal,
    control,
    effect_size_signal_minus_control: effect,
    ci95: bootstrap,
    paired_samples: rows.length,
    permutation_p_value: permutation,
    holm_adjusted_p_value: null,
  };
}

function bootstrapDifference(
  signalValues: number[],
  controlValues: number[],
  statisticType: Statistic,
  seed: number,
): { lower: number; upper: number } {
  const random = mulberry32(seed);
  const distribution: number[] = [];
  for (let replicate = 0; replicate < BOOTSTRAP_REPLICATES; replicate += 1) {
    const signalSample: number[] = [];
    const controlSample: number[] = [];
    for (let row = 0; row < signalValues.length; row += 1) {
      const selected = Math.floor(random() * signalValues.length);
      signalSample.push(signalValues[selected]!);
      controlSample.push(controlValues[selected]!);
    }
    const signal = statistic(signalSample, statisticType);
    const control = statistic(controlSample, statisticType);
    if (signal !== null && control !== null) distribution.push(signal - control);
  }
  distribution.sort((left, right) => left - right);
  return {
    lower: quantile(distribution, 0.025) ?? 0,
    upper: quantile(distribution, 0.975) ?? 0,
  };
}

function permutationPValue(signalValues: number[], controlValues: number[], seed: number): number {
  const random = mulberry32(seed);
  const observed = Math.abs(average(signalValues.map((value, index) => value - controlValues[index]!)) ?? 0);
  if (observed === 0) return 1;
  let atLeastAsExtreme = 0;
  for (let replicate = 0; replicate < PERMUTATION_REPLICATES; replicate += 1) {
    let sum = 0;
    for (let row = 0; row < signalValues.length; row += 1) {
      const difference = signalValues[row]! - controlValues[row]!;
      sum += random() < 0.5 ? difference : -difference;
    }
    if (Math.abs(sum / signalValues.length) >= observed) atLeastAsExtreme += 1;
  }
  return (atLeastAsExtreme + 1) / (PERMUTATION_REPLICATES + 1);
}

function componentPresent(record: HistoricalObservation, direction: Direction, component: ComponentName): boolean {
  const input = buildSignalInput(record.sample, record.breadth);
  const evidence = directionEvidence(input, direction);
  switch (component) {
    case "PRICE_STRUCTURE":
    case "ENTRY_CONTEXT":
      return hasClosedCandlePriceStructure(record, direction);
    case "TREND":
      return evidence.trend;
    case "MOMENTUM":
      return evidence.momentum;
    case "VOLUME":
      return evidence.volume;
    case "VOLATILITY":
      return !input.features.volatility.shock && input.features.volatility.percentile < 85;
    case "FUNDING":
      return evidence.funding;
    case "OPEN_INTEREST":
      return evidence.open_interest;
    case "LIQUIDITY":
      return evidence.liquidity;
    case "MARKET_BREADTH":
      return evidence.breadth;
    case "CONFIRMATION":
      return evidence.total >= 3 && hasClosedCandlePriceStructure(record, direction);
  }
}

function hasClosedCandlePriceStructure(record: HistoricalObservation, direction: Direction): boolean {
  const candles = record.context.fourHour;
  const currentIndex = record.sample.four_hour_index;
  const current = candles[currentIndex];
  const previous = candles[currentIndex - 1];
  if (!current || !previous || current.closeTime > record.timestamp || previous.closeTime > record.timestamp) return false;
  const lookback = candles.slice(Math.max(0, currentIndex - 3), currentIndex);
  if (lookback.length === 0) return false;
  const lookbackHigh = Math.max(...lookback.map((candle) => candle.high));
  const lookbackLow = Math.min(...lookback.map((candle) => candle.low));
  const currentBullish = current.close > current.open;
  const currentBearish = current.close < current.open;
  const pullbackReclaim = direction === "LONG"
    ? previous.close <= previous.open && currentBullish && current.close > previous.high
    : previous.close >= previous.open && currentBearish && current.close < previous.low;
  const breakout = direction === "LONG"
    ? currentBullish && current.close > lookbackHigh
    : currentBearish && current.close < lookbackLow;
  const interaction = direction === "LONG"
    ? current.low <= lookbackLow && current.close > previous.close && currentBullish
    : current.high >= lookbackHigh && current.close < previous.close && currentBearish;
  return pullbackReclaim || breakout || interaction;
}

function directionOutcome(record: HistoricalObservation, direction: Direction, horizon: Horizon): DirectionOutcome | null {
  const currentIndex = record.sample.four_hour_index;
  const candles = record.context.fourHour;
  const current = candles[currentIndex];
  if (!current || current.close <= 0 || current.closeTime > record.timestamp) return null;
  const target = record.timestamp + Number.parseInt(horizon, 10) * 60 * 60 * 1000;
  const endIndex = firstIndexAtOrAfter(candles, target, currentIndex + 1);
  if (endIndex === -1) return null;
  const window = candles.slice(currentIndex + 1, endIndex + 1);
  const future = candles[endIndex];
  if (!future || future.close <= 0 || window.length === 0) return null;
  const alignedReturn = direction === "LONG" ? future.close / current.close - 1 : current.close / future.close - 1;
  const maximumHigh = Math.max(...window.map((candle) => candle.high));
  const minimumLow = Math.min(...window.map((candle) => candle.low));
  const mfe = direction === "LONG"
    ? Math.max(0, maximumHigh / current.close - 1)
    : Math.max(0, current.close / minimumLow - 1);
  const mae = direction === "LONG"
    ? Math.max(0, 1 - minimumLow / current.close)
    : Math.max(0, maximumHigh / current.close - 1);
  return { future_price: future.close, aligned_return: alignedReturn, mfe, mae };
}

function riskOutcome(record: HistoricalObservation): RiskOutcome | null {
  const currentIndex = record.sample.four_hour_index;
  const candles = record.context.fourHour;
  const current = candles[currentIndex];
  if (!current || current.close <= 0 || current.closeTime > record.timestamp) return null;
  const endIndex = firstIndexAtOrAfter(candles, record.timestamp + 24 * 60 * 60 * 1000, currentIndex + 1);
  if (endIndex === -1) return null;
  const window = candles.slice(currentIndex + 1, endIndex + 1);
  const future = candles[endIndex];
  if (!future || future.close <= 0 || window.length === 0) return null;
  const maximumHigh = Math.max(...window.map((candle) => candle.high));
  const minimumLow = Math.min(...window.map((candle) => candle.low));
  const futureReturn = future.close / current.close - 1;
  return {
    future_return: futureReturn,
    realized_volatility: (maximumHigh - minimumLow) / current.close,
    large_move: Math.abs(futureReturn) >= LARGE_MOVE_THRESHOLD ? 1 : 0,
    extreme_move: Math.abs(futureReturn) >= EXTREME_MOVE_THRESHOLD ? 1 : 0,
    negative_return: futureReturn < 0 ? 1 : 0,
    drawdown_proxy: Math.max(0, 1 - minimumLow / current.close),
  };
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

function combinedMetric(long: DirectionAudit, short: DirectionAudit, metric: keyof HorizonComparison): number | null {
  if (metric === "evaluable_pairs") return null;
  const longMetric = long.horizons["4h"][metric] as MetricComparison;
  const shortMetric = short.horizons["4h"][metric] as MetricComparison;
  const longWeight = longMetric.paired_samples;
  const shortWeight = shortMetric.paired_samples;
  if (longWeight + shortWeight === 0 || longMetric.signal === null || shortMetric.signal === null) return null;
  return round((longMetric.signal * longWeight + shortMetric.signal * shortWeight) / (longWeight + shortWeight));
}

function isPitSafeObservation(observation: HistoricalObservation): boolean {
  const sourceTimestamp = observation.sample.source_timestamp;
  return observation.breadth.pit_safe
    && Number.isFinite(sourceTimestamp)
    && sourceTimestamp <= observation.timestamp
    && observation.sample.candle.closeTime <= observation.timestamp;
}

function isDirectionalEvent(event: LockedEvent): boolean {
  return event.signal_type === "LONG_WATCH" || event.signal_type === "SHORT_WATCH";
}

function eventObservationKey(event: LockedEvent): string {
  const timestamp = Date.parse(event.observed_at);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid event timestamp: " + event.opportunity_event_id);
  return event.symbol + "@" + timestamp;
}

function matchKey(observation: HistoricalObservation, fields: readonly MatchField[]): string {
  return fields.map((field) => {
    switch (field) {
      case "symbol": return observation.symbol;
      case "direction_context": return observation.direction_context;
      case "quarter": return observation.quarter;
      case "market_regime": return observation.market_regime;
      case "liquidity_bucket": return observation.liquidity_bucket;
      case "volatility_bucket": return observation.volatility_bucket;
      case "breadth_state": return observation.breadth_state;
    }
  }).join("\u001f");
}

function emptyMatchSummary(specs: MatchSpec[]): MatchSummary {
  return {
    requested: 0,
    matched: 0,
    unmatched: 0,
    coverage: null,
    match_level_counts: Object.fromEntries(specs.map((spec) => [spec.name, 0])),
    unmatched_reasons: {},
    controls_without_signal: 0,
    controls_from_future: 0,
  };
}

function compareEvents(left: LockedEvent, right: LockedEvent): number {
  const timeDifference = Date.parse(left.observed_at) - Date.parse(right.observed_at);
  return timeDifference !== 0 ? timeDifference : left.opportunity_event_id.localeCompare(right.opportunity_event_id);
}

function concentration(rows: StabilityRow[], total: number): { key: string | null; count: number; share: number | null } {
  const largest = [...rows].sort((left, right) => right.pair_count - left.pair_count || left.key.localeCompare(right.key))[0];
  return largest
    ? { key: largest.key, count: largest.pair_count, share: coverage(largest.pair_count, total) }
    : { key: null, count: 0, share: null };
}

function stabilityPass(rows: StabilityRow[]): boolean {
  return rows.length >= 2
    && rows.every((row) => row.evaluable_4h > 0 && (row.precision_lift_4h ?? -1) >= 0);
}

function volatilityBucket(percentile: number): string {
  if (percentile < 25) return "LOW";
  if (percentile < 75) return "NORMAL";
  return "HIGH";
}

function quarterKey(timestamp: number): string {
  const date = new Date(timestamp);
  return date.getUTCFullYear() + "-Q" + (Math.floor(date.getUTCMonth() / 3) + 1);
}

function coverage(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round(numerator / denominator) : null;
}

function statistic(values: number[], statisticType: Statistic): number | null {
  return statisticType === "mean" ? average(values) : median(values);
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function quantile(values: number[], probabilityValue: number): number | null {
  if (values.length === 0) return null;
  const position = (values.length - 1) * probabilityValue;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower]!;
  const weight = position - lower;
  return values[lower]! + (values[upper]! - values[lower]!) * weight;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function formatMetric(metric: MetricComparison): string {
  return JSON.stringify({
    signal: metric.signal,
    control: metric.control,
    effect: metric.effect_size_signal_minus_control,
    ci95: metric.ci95,
    n: metric.paired_samples,
    p: metric.permutation_p_value,
    p_holm: metric.holm_adjusted_p_value,
  });
}

function renderMarkdown(report: LockedAuditReport): string {
  const lines: string[] = [
    "# HY-R4.16 Signal Information Gain Audit",
    "",
    "## Rule freeze",
    "",
    "- Baseline: " + report.baseline.rule_version,
    "- Source report: " + report.baseline.source_report,
    "- Experiment count: " + report.experiment.experiment_count,
    "- Rules frozen before audit: YES",
    "- Post-result tuning: NO",
    "- New alpha source / ML: NO / NO",
    "",
    "## Historical coverage and PIT",
    "",
    "- Requested: " + report.historical_coverage.requested_start + " -> " + report.historical_coverage.requested_end,
    "- Actual: " + report.historical_coverage.actual_start + " -> " + report.historical_coverage.actual_end,
    "- Datasets / sample timestamps / observations: " + report.historical_coverage.datasets + " / " + report.historical_coverage.sample_timestamps + " / " + report.historical_coverage.observations,
    "- PIT-safe / PIT-unsafe observations: " + report.historical_coverage.pit_safe_observations + " / " + report.historical_coverage.pit_unsafe_observations,
    "",
    "## Matching methodology",
    "",
    "- Primary match: symbol, direction context, UTC quarter, market regime, liquidity bucket, volatility bucket, breadth state.",
    "- Controls are selected without replacement and strictly before the signal timestamp.",
    "- Selection is deterministic: latest eligible prior observation within the first available predeclared level.",
    "- Matching uses no replay outcome and no future observation.",
    "- Directional coverage: " + format(report.matching_coverage.directional_coverage) + " (" + report.matching_coverage.directional_matched_controls + "/" + report.matching_coverage.directional_signal_events + ")",
    "- Risk-warning coverage: " + format(report.matching_coverage.risk_warning_coverage) + " (" + report.matching_coverage.risk_warning_matched_controls + "/" + report.matching_coverage.risk_warning_events + ")",
    "",
    "## Signal and control counts",
    "",
    "| Type | Signal events | Matched controls |",
    "| --- | ---: | ---: |",
    "| LONG_WATCH | " + report.signal_counts.LONG_WATCH + " | " + report.control_counts.LONG_WATCH + " |",
    "| SHORT_WATCH | " + report.signal_counts.SHORT_WATCH + " | " + report.control_counts.SHORT_WATCH + " |",
    "| Directional total | " + report.signal_counts.combined_directional + " | " + report.control_counts.combined_directional + " |",
    "| RISK_WARNING | " + report.signal_counts.RISK_WARNING + " | " + report.control_counts.RISK_WARNING + " |",
    "",
    "## LONG_WATCH: Signal vs matched control",
    "",
    renderDirectionTable(report.long),
    "",
    "## SHORT_WATCH: Signal vs matched control",
    "",
    renderDirectionTable(report.short),
    "",
    "## Combined directional incremental lift",
    "",
    "| Horizon | Precision signal | Precision control | Precision lift | Average return lift | MFE lift | MAE lift |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...HORIZONS.map((horizon) => {
      const metrics = report.combined_directional.horizons[horizon];
      return "| " + horizon
        + " | " + format(metrics.direction_precision.signal)
        + " | " + format(metrics.direction_precision.control)
        + " | " + format(metrics.direction_precision.effect_size_signal_minus_control)
        + " | " + format(metrics.average_directional_return.effect_size_signal_minus_control)
        + " | " + format(metrics.mfe.effect_size_signal_minus_control)
        + " | " + format(metrics.mae.effect_size_signal_minus_control)
        + " |";
    }),
    "",
    "## RISK_WARNING: Signal vs matched control",
    "",
    "- Evaluation horizon: 24h; direction prediction is intentionally not used.",
    "- Realized volatility: " + formatMetric(report.risk_warning.realized_volatility_24h),
    "- Large-move probability: " + formatMetric(report.risk_warning.large_move_probability_24h),
    "- Extreme-move probability: " + formatMetric(report.risk_warning.extreme_move_probability_24h),
    "- Negative-return probability: " + formatMetric(report.risk_warning.negative_return_probability_24h),
    "- Drawdown proxy: " + formatMetric(report.risk_warning.drawdown_proxy_24h),
    "",
    "## Component information audit",
    "",
    "The component method was fixed before analysis as a component-conditioned comparison. It is exploratory because the locked event rule was not re-run with components removed; no result is used to add combinations or change thresholds.",
    "",
    "| Component | Signal present | Control present | Conditioned pairs | 4h precision effect | 4h MFE effect | Variation identifiable |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...report.component_audit.components.map((row) => (
      "| " + row.component + " | " + row.signal_present_count + " | " + row.control_present_count + " | " + row.conditioned_pair_count + " | " + format(row.four_hour_precision.effect_size_signal_minus_control) + " | " + format(row.four_hour_mfe.effect_size_signal_minus_control) + " | " + (row.variation_identifiable ? "YES" : "NO") + " |"
    )),
    "",
    "- Robust components (confirmatory): " + (report.component_audit.robust_components.length > 0 ? report.component_audit.robust_components.join(", ") : "NONE"),
    "",
    "## Stability and concentration",
    "",
    "- Stable across quarters: " + (report.stability.stable_across_quarters ? "YES" : "NO"),
    "- Stable across regimes: " + (report.stability.stable_across_regimes ? "YES" : "NO"),
    "- Largest symbol: " + concentrationText(report.stability.concentration.largest_symbol),
    "- Largest quarter: " + concentrationText(report.stability.concentration.largest_quarter),
    "- Largest regime: " + concentrationText(report.stability.concentration.largest_regime),
    "",
    "### Quarter stability",
    "",
    renderStabilityTable(report.stability.quarter),
    "",
    "### Market-regime stability",
    "",
    renderStabilityTable(report.stability.market_regime),
    "",
    "### Symbol stability",
    "",
    renderStabilityTable(report.stability.symbol),
    "",
    "## Multiple-testing handling",
    "",
    "- Directional primary family: " + report.multiple_testing.primary_directional_family.tests + " metrics, Holm step-down correction.",
    "- Risk family: " + report.multiple_testing.risk_family.tests + " metrics, Holm step-down correction.",
    "- Component family: exploratory only; no confirmatory claim.",
    "- Bootstrap: " + report.multiple_testing.bootstrap.replicates + " replicates, fixed seed " + report.multiple_testing.bootstrap.seed + ", 95% percentile CI.",
    "- Paired permutation: " + report.multiple_testing.permutation.replicates + " fixed sign-flip replicates; p-values are two-sided.",
    "",
    "## Baseline comparison",
    "",
    "- R4.13 baseline LONG/SHORT: " + report.baseline_comparison.baseline_long_watch + "/" + report.baseline_comparison.baseline_short_watch,
    "- R4.13 4h precision / false-alert / 24h duplicate: " + report.baseline_comparison.baseline_precision_4h + " / " + report.baseline_comparison.baseline_false_alert_rate_4h + " / " + report.baseline_comparison.baseline_duplicate_rate_24h,
    "- R4.15 event-model LONG/SHORT: " + report.baseline_comparison.event_model_long_watch + "/" + report.baseline_comparison.event_model_short_watch,
    "- R4.15 event-model combined 4h precision: " + format(report.baseline_comparison.event_model_precision_4h),
    "- " + report.baseline_comparison.interpretation,
    "",
    "## Final classification",
    "",
    "**" + report.final_classification + "**",
    "",
    report.next_stage_recommendation,
    "",
    "## Safety and validation",
    "",
    "- Production / Supabase / Vercel / PAPER / scanner modified: NO.",
    "- Emails sent: 0; private API called: NO; AUTO_TRADING: FALSE.",
    "- Tests: " + report.validation.tests,
    "- typecheck: " + report.validation.typecheck,
    "- lint: " + report.validation.lint,
    "",
  ];
  return lines.join("\n");
}

function renderDirectionTable(audit: DirectionAudit): string {
  const lines = [
    "| Horizon | P signal | P control | P effect | Avg return effect | Median return effect | MFE effect | MAE effect | MFE/MAE effect |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const horizon of HORIZONS) {
    const metrics = audit.horizons[horizon];
    lines.push(
      "| " + horizon
      + " | " + format(metrics.direction_precision.signal)
      + " | " + format(metrics.direction_precision.control)
      + " | " + format(metrics.direction_precision.effect_size_signal_minus_control)
      + " | " + format(metrics.average_directional_return.effect_size_signal_minus_control)
      + " | " + format(metrics.median_directional_return.effect_size_signal_minus_control)
      + " | " + format(metrics.mfe.effect_size_signal_minus_control)
      + " | " + format(metrics.mae.effect_size_signal_minus_control)
      + " | " + format(metrics.mfe_mae.effect_size_signal_minus_control)
      + " |",
    );
  }
  return lines.join("\n");
}

function renderStabilityTable(rows: StabilityRow[]): string {
  const lines = [
    "| Key | Pairs | Evaluable 4h | Signal precision | Control precision | Precision lift | MFE lift |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of rows) {
    lines.push("| " + row.key + " | " + row.pair_count + " | " + row.evaluable_4h + " | " + format(row.signal_precision_4h) + " | " + format(row.control_precision_4h) + " | " + format(row.precision_lift_4h) + " | " + format(row.mfe_lift_4h) + " |");
  }
  return lines.join("\n");
}

function concentrationText(entry: { key: string | null; count: number; share: number | null }): string {
  return (entry.key ?? "NONE") + " (" + entry.count + ", share " + format(entry.share) + ")";
}

function format(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
