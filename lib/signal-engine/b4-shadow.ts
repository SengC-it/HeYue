import { createHash } from "node:crypto";
import {
  B4_SHADOW_CANDIDATE,
  B4_SHADOW_CUTOFF_VERSION,
  B4_SHADOW_EXPERIMENT,
  B4_SHADOW_FAMILY,
  B4_SHADOW_FEATURE_VERSION,
  B4_SHADOW_HYPOTHESIS,
  B4_SHADOW_INTERVAL_MS,
  B4_SHADOW_LOWER_PERCENTILE,
  B4_SHADOW_R57_FEATURE_SPECIFICATION_HASH,
  B4_SHADOW_R58A1_CUTOFF_HASH,
  B4_SHADOW_R58A_HYPOTHESIS_HASH,
  B4_SHADOW_UPPER_PERCENTILE,
  B4_SHADOW_VERSION,
  type B4ShadowContextState,
  type B4ShadowControlObservation,
  type B4ShadowControlSelection,
  type B4ShadowDiagnostics,
  type B4ShadowDirection,
  type B4ShadowEvaluation,
  type B4ShadowFutureObservation,
  type B4ShadowObservation,
  type B4ShadowOutcome,
  type B4ShadowSignalEvent,
} from "./b4-shadow-types";
import { parseB4ShadowFutureObservation, parseB4ShadowObservation } from "./b4-shadow-validation";

export const B4_SHADOW_MATCH_FIELDS = [
  "symbol",
  "calendar_period",
  "market_regime",
  "volatility_bucket",
  "liquidity_bucket",
  "funding_state",
  "mark_index_basis_state",
] as const;

function b4DivergenceDirection(input: {
  priceChangePercentile: number | null;
  premiumChangePercentile: number | null;
  historyAvailable: boolean;
}): B4ShadowDirection | null {
  if (!input.historyAvailable
    || input.priceChangePercentile === null
    || input.premiumChangePercentile === null
    || !Number.isFinite(input.priceChangePercentile)
    || !Number.isFinite(input.premiumChangePercentile)) return null;
  if (input.priceChangePercentile >= B4_SHADOW_UPPER_PERCENTILE
    && input.premiumChangePercentile <= B4_SHADOW_LOWER_PERCENTILE) return "BEARISH";
  if (input.priceChangePercentile <= B4_SHADOW_LOWER_PERCENTILE
    && input.premiumChangePercentile >= B4_SHADOW_UPPER_PERCENTILE) return "BULLISH";
  return null;
}

export interface B4ShadowEngineOptions {
  enabled?: boolean;
  idFactory?: () => string;
  controlCandidates?: readonly B4ShadowControlObservation[];
  episodeState?: Map<string, B4ShadowDirection | null>;
}

export function isB4ShadowEnabled(environment: Record<string, string | undefined> = process.env): boolean {
  return environment.HY_B4_SHADOW_ENABLED?.trim().toLowerCase() === "true";
}

export function b4FrozenContract(): {
  candidate: typeof B4_SHADOW_CANDIDATE;
  version: typeof B4_SHADOW_VERSION;
  hypothesis: typeof B4_SHADOW_HYPOTHESIS;
  feature_version: typeof B4_SHADOW_FEATURE_VERSION;
  cutoff_version: typeof B4_SHADOW_CUTOFF_VERSION;
  hashes: {
    r57_feature_specification: typeof B4_SHADOW_R57_FEATURE_SPECIFICATION_HASH;
    r58a_hypothesis: typeof B4_SHADOW_R58A_HYPOTHESIS_HASH;
    r58a1_cutoff: typeof B4_SHADOW_R58A1_CUTOFF_HASH;
  };
  bullish: string;
  bearish: string;
} {
  return {
    candidate: B4_SHADOW_CANDIDATE,
    version: B4_SHADOW_VERSION,
    hypothesis: B4_SHADOW_HYPOTHESIS,
    feature_version: B4_SHADOW_FEATURE_VERSION,
    cutoff_version: B4_SHADOW_CUTOFF_VERSION,
    hashes: {
      r57_feature_specification: B4_SHADOW_R57_FEATURE_SPECIFICATION_HASH,
      r58a_hypothesis: B4_SHADOW_R58A_HYPOTHESIS_HASH,
      r58a1_cutoff: B4_SHADOW_R58A1_CUTOFF_HASH,
    },
    bullish: "price-change percentile <= 0.25 AND premium-change percentile >= 0.75 -> LONG_WATCH",
    bearish: "price-change percentile >= 0.75 AND premium-change percentile <= 0.25 -> SHORT_WATCH",
  };
}

export function b4ShadowControlMatchKey(observation: Pick<
  B4ShadowObservation,
  "symbol" | "calendar_period" | "market_regime" | "volatility_bucket" | "liquidity_bucket"
> & {
  funding_state: B4ShadowContextState;
  mark_index_basis_state: B4ShadowContextState;
}): string {
  return [
    observation.symbol,
    observation.calendar_period,
    observation.market_regime,
    observation.volatility_bucket,
    observation.liquidity_bucket,
    contextValue(observation.funding_state),
    contextValue(observation.mark_index_basis_state),
  ].join("|");
}

export function selectPitSafeControlB(
  observation: B4ShadowObservation,
  candidates: readonly B4ShadowControlObservation[],
): B4ShadowControlSelection {
  const matchKey = b4ShadowControlMatchKey(observation as B4ShadowObservation & {
    funding_state: B4ShadowContextState;
    mark_index_basis_state: B4ShadowContextState;
  });
  const decisionTime = Date.parse(observation.decision_timestamp);
  const selected = candidates
    .filter((candidate) => candidate.symbol === observation.symbol)
    .filter((candidate) => controlContextKey(candidate) === matchKey)
    .filter((candidate) => Date.parse(candidate.pit_available_at) <= decisionTime)
    .sort((left, right) => Date.parse(right.pit_available_at) - Date.parse(left.pit_available_at)
      || left.control_event_id.localeCompare(right.control_event_id))[0];
  return {
    status: selected ? "AVAILABLE" : "CONTROL_UNAVAILABLE",
    control_event_id: selected?.control_event_id ?? null,
    match_key: matchKey,
  };
}

export function b4ShadowOutcomeCacheKey(
  event: Pick<B4ShadowSignalEvent, "symbol" | "market_timestamp" | "direction">,
  horizonHours: number,
): string {
  return [event.symbol, String(Date.parse(event.market_timestamp)), event.direction, String(horizonHours)].join("|");
}

export function calculateB4ShadowOutcome(
  event: B4ShadowSignalEvent,
  horizonHours: (typeof import("./b4-shadow-types").B4_SHADOW_OUTCOME_HORIZONS)[number],
  future: B4ShadowFutureObservation,
  evaluatedAt: string,
): B4ShadowOutcome | null {
  const parsedFuture = parseB4ShadowFutureObservation(future);
  const eventTime = Date.parse(event.market_timestamp);
  const futureTime = Date.parse(parsedFuture.timestamp);
  const availableAt = Date.parse(parsedFuture.pit_available_at);
  const evaluationTime = Date.parse(evaluatedAt);
  const dueTime = eventTime + horizonHours * B4_SHADOW_INTERVAL_MS;
  if (!Number.isFinite(eventTime) || !Number.isFinite(futureTime) || !Number.isFinite(availableAt)
    || !Number.isFinite(evaluationTime) || futureTime < dueTime || availableAt > evaluationTime
    || !parsedFuture.observation_closed) return null;

  const signedReturn = event.direction === "BULLISH"
    ? parsedFuture.close_price / event.perpetual_price - 1
    : event.perpetual_price / parsedFuture.close_price - 1;
  const maxFavorableMove = event.direction === "BULLISH"
    ? parsedFuture.high_price / event.perpetual_price - 1
    : event.perpetual_price / parsedFuture.low_price - 1;
  const maxAdverseMove = event.direction === "BULLISH"
    ? parsedFuture.low_price / event.perpetual_price - 1
    : event.perpetual_price / parsedFuture.high_price - 1;
  return {
    event_id: event.event_id,
    direction: event.direction,
    horizon_hours: horizonHours,
    future_observation_timestamp: parsedFuture.timestamp,
    future_available_at: parsedFuture.pit_available_at,
    future_price: parsedFuture.close_price,
    signed_return: signedReturn,
    max_favorable_move: maxFavorableMove,
    max_adverse_move: maxAdverseMove,
    pit_safe: true,
    outcome_status: "MATURED",
    calculation_version: B4_SHADOW_VERSION,
  };
}

export class B4ShadowEngine {
  private readonly enabled: boolean;
  private readonly idFactory: (() => string) | undefined;
  private readonly controlCandidates: readonly B4ShadowControlObservation[];
  private readonly episodeState: Map<string, B4ShadowDirection | null>;
  private readonly counters = {
    b4_conditions_evaluated: 0,
    shadow_events_generated: 0,
    long_watch_count: 0,
    short_watch_count: 0,
    duplicates_suppressed: 0,
    data_incomplete_count: 0,
    pit_failures: 0,
  };
  private lastEvaluationAt: string | null = null;
  private marketDataStatus: B4ShadowDiagnostics["market_data_status"] = "DISABLED";
  private rollingHistoryReady = false;
  private readonly eligibleSymbols = new Set<string>();

  constructor(options: B4ShadowEngineOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.idFactory = options.idFactory;
    this.controlCandidates = options.controlCandidates ?? [];
    this.episodeState = options.episodeState ?? new Map<string, B4ShadowDirection | null>();
  }

  evaluate(value: unknown): B4ShadowEvaluation {
    const observation = parseB4ShadowObservation(value);
    this.lastEvaluationAt = observation.decision_timestamp;
    this.rollingHistoryReady = observation.rolling_history_ready;
    if (!this.enabled) {
      this.marketDataStatus = "DISABLED";
      return { status: "DISABLED", event: null, direction: null, reason: "HY_B4_SHADOW_ENABLED is false" };
    }

    if (!observation.market_data_complete) {
      this.resetEpisode(observation.symbol);
      this.counters.data_incomplete_count += 1;
      this.marketDataStatus = "INCOMPLETE";
      return { status: "DATA_INCOMPLETE", event: null, direction: null, reason: "MARKET_DATA_INCOMPLETE" };
    }
    if (!this.isPitSafeObservation(observation)) {
      this.resetEpisode(observation.symbol);
      this.counters.pit_failures += 1;
      this.marketDataStatus = "PIT_REJECTED";
      return { status: "PIT_REJECTED", event: null, direction: null, reason: "PIT_NOT_AVAILABLE" };
    }
    if (!observation.rolling_history_ready
      || observation.premium_value === null
      || observation.price_change_value === null
      || observation.premium_change_value === null
      || observation.price_percentile === null
      || observation.premium_change_percentile === null
      || observation.funding_state === null
      || observation.mark_index_basis_state === null) {
      this.resetEpisode(observation.symbol);
      this.counters.data_incomplete_count += 1;
      this.marketDataStatus = "INCOMPLETE";
      return { status: "DATA_INCOMPLETE", event: null, direction: null, reason: "B4_INPUT_INCOMPLETE" };
    }

    this.counters.b4_conditions_evaluated += 1;
    this.marketDataStatus = "READY";
    this.eligibleSymbols.add(observation.symbol);
    const direction = b4DivergenceDirection({
      priceChangePercentile: observation.price_percentile,
      premiumChangePercentile: observation.premium_change_percentile,
      historyAvailable: observation.rolling_history_ready,
    });
    const previousDirection = this.episodeState.get(observation.symbol) ?? null;
    this.episodeState.set(observation.symbol, direction);
    if (direction === null) {
      return { status: "NO_SIGNAL", event: null, direction: null, reason: "B4_CUTOFF_NOT_MET" };
    }
    if (previousDirection === direction) {
      this.counters.duplicates_suppressed += 1;
      return { status: "DUPLICATE_SUPPRESSED", event: null, direction, reason: "TRUE_TO_TRUE" };
    }

    const control = selectPitSafeControlB(observation, this.controlCandidates);
    const event = freezeDeep({
      event_id: optionsEventId(this.idFactory, observation, direction),
      episode_key: episodeKey(observation, direction),
      experiment: B4_SHADOW_EXPERIMENT,
      version: B4_SHADOW_VERSION,
      created_at: observation.decision_timestamp,
      market_timestamp: observation.market_timestamp,
      pit_available_at: observation.pit_available_at,
      symbol: observation.symbol,
      direction,
      alert_type: direction === "BULLISH" ? "LONG_WATCH" : "SHORT_WATCH",
      family: B4_SHADOW_FAMILY,
      hypothesis: B4_SHADOW_HYPOTHESIS,
      feature_version: B4_SHADOW_FEATURE_VERSION,
      cutoff_version: B4_SHADOW_CUTOFF_VERSION,
      perpetual_price: observation.perpetual_price,
      premium_value: observation.premium_value,
      price_change_value: observation.price_change_value,
      premium_change_value: observation.premium_change_value,
      price_percentile: observation.price_percentile,
      premium_change_percentile: observation.premium_change_percentile,
      funding_state: { ...observation.funding_state },
      mark_index_basis_state: { ...observation.mark_index_basis_state },
      market_regime: observation.market_regime,
      volatility_bucket: observation.volatility_bucket,
      liquidity_bucket: observation.liquidity_bucket,
      calendar_period: observation.calendar_period,
      data_completeness: "COMPLETE",
      pit_status: "PASS",
      dedup_state: "NEW_FALSE_TO_TRUE",
      shadow_status: "WOULD_HAVE_ALERTED",
      control_status: control.status,
      control_event_id: control.control_event_id,
      control_match_key: control.match_key,
    } satisfies B4ShadowSignalEvent);
    this.counters.shadow_events_generated += 1;
    if (direction === "BULLISH") this.counters.long_watch_count += 1;
    else this.counters.short_watch_count += 1;
    return { status: "WOULD_HAVE_ALERTED", event, direction, reason: null };
  }

  diagnostics(): B4ShadowDiagnostics {
    return {
      enabled: this.enabled,
      version: B4_SHADOW_VERSION,
      last_evaluation_at: this.lastEvaluationAt,
      market_data_status: this.marketDataStatus,
      rolling_history_ready: this.rollingHistoryReady,
      eligible_symbols: [...this.eligibleSymbols].sort(),
      ...this.counters,
      emails_sent: 0,
    };
  }

  private resetEpisode(symbol: string): void {
    this.episodeState.set(symbol, null);
  }

  private isPitSafeObservation(observation: B4ShadowObservation): boolean {
    const marketTime = Date.parse(observation.market_timestamp);
    const decisionTime = Date.parse(observation.decision_timestamp);
    const availableAt = Date.parse(observation.pit_available_at);
    return observation.pit_safe
      && observation.observation_closed
      && Number.isFinite(marketTime)
      && Number.isFinite(decisionTime)
      && Number.isFinite(availableAt)
      && marketTime <= availableAt
      && availableAt <= decisionTime
      && observation.mark_price !== null
      && observation.index_price !== null
      && Number.isFinite(observation.mark_price)
      && Number.isFinite(observation.index_price)
      && observation.funding_state !== null
      && observation.mark_index_basis_state !== null;
  }
}

function optionsEventId(
  idFactory: (() => string) | undefined,
  observation: B4ShadowObservation,
  direction: B4ShadowDirection,
): string {
  if (idFactory) return idFactory();
  const digest = createHash("sha256")
    .update(`${B4_SHADOW_VERSION}|${observation.symbol}|${observation.market_timestamp}|${direction}|FALSE_TO_TRUE`, "utf8")
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function episodeKey(observation: B4ShadowObservation, direction: B4ShadowDirection): string {
  return `${B4_SHADOW_VERSION}|${observation.symbol}|${observation.market_timestamp}|${direction}|FALSE_TO_TRUE`;
}

function controlContextKey(candidate: B4ShadowControlObservation): string {
  return [
    candidate.symbol,
    candidate.calendar_period,
    candidate.market_regime,
    candidate.volatility_bucket,
    candidate.liquidity_bucket,
    candidate.funding_state,
    candidate.mark_index_basis_state,
  ].join("|");
}

function contextValue(value: B4ShadowContextState): string {
  return Object.keys(value).sort().map((key) => `${key}=${String(value[key])}`).join(",");
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}
