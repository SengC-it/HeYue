export const B4_SHADOW_EXPERIMENT = "HY-R6.1" as const;
export const B4_SHADOW_VERSION = "hy-b4-shadow-v1" as const;
export const B4_SHADOW_CANDIDATE = "B4 PRICE_PREMIUM_DIVERGENCE" as const;
export const B4_SHADOW_FAMILY = "B4" as const;
export const B4_SHADOW_HYPOTHESIS = "DIVERGENCE_REVERSAL" as const;
export const B4_SHADOW_FEATURE_VERSION = "hy-r5.7-basis-premium-frozen-v1" as const;
export const B4_SHADOW_CUTOFF_VERSION = "hy-r5.8a1-basis-premium-event-cutoff-v1" as const;

export const B4_SHADOW_R57_FEATURE_SPECIFICATION_HASH =
  "bbdaab9e4cba4c22e50471d538d808fca992e812aaff60a0fc3f70af6020cf51" as const;
export const B4_SHADOW_R58A_HYPOTHESIS_HASH =
  "0b5a790a1783704fc5eb130c4d1fa65c865339e68232fa1b54af9012c58db0f3" as const;
export const B4_SHADOW_R58A1_CUTOFF_HASH =
  "95fe1b5a20b0d4804e52dbc01c2f0e730a8f6b377e0c29ae2877875d8f06e800" as const;

export const B4_SHADOW_LOWER_PERCENTILE = 0.25 as const;
export const B4_SHADOW_UPPER_PERCENTILE = 0.75 as const;
export const B4_SHADOW_INTERVAL_MS = 3_600_000 as const;
export const B4_SHADOW_OUTCOME_HORIZONS = [1, 4, 12, 24] as const;

export const B4_SHADOW_EVENT_TABLE = "hy_shadow_signal_events" as const;
export const B4_SHADOW_OUTCOME_TABLE = "hy_shadow_signal_outcomes" as const;
export const B4_SHADOW_TABLE_NAMES = [
  B4_SHADOW_EVENT_TABLE,
  B4_SHADOW_OUTCOME_TABLE,
] as const;

export type B4ShadowDirection = "BULLISH" | "BEARISH";
export type B4ShadowAlertType = "LONG_WATCH" | "SHORT_WATCH";
export type B4ShadowStatus = "WOULD_HAVE_ALERTED";
export type B4ShadowDedupState = "NEW_FALSE_TO_TRUE";
export type B4ShadowControlStatus = "AVAILABLE" | "CONTROL_UNAVAILABLE";
export type B4ShadowEvaluationStatus =
  | "WOULD_HAVE_ALERTED"
  | "NO_SIGNAL"
  | "DUPLICATE_SUPPRESSED"
  | "DATA_INCOMPLETE"
  | "PIT_REJECTED"
  | "DISABLED";
export type B4ShadowOutcomeStatus = "MATURED" | "NOT_MATURED" | "NOT_EVALUABLE";

export type B4ShadowContextState = Record<string, string | number | boolean | null>;

export interface B4ShadowObservation {
  symbol: string;
  market_timestamp: string;
  decision_timestamp: string;
  pit_available_at: string;
  perpetual_price: number;
  premium_value: number | null;
  price_change_value: number | null;
  premium_change_value: number | null;
  price_percentile: number | null;
  premium_change_percentile: number | null;
  funding_state: B4ShadowContextState | null;
  mark_index_basis_state: B4ShadowContextState | null;
  mark_price: number | null;
  index_price: number | null;
  market_regime: string;
  volatility_bucket: string;
  liquidity_bucket: string;
  volatility_value: number | null;
  liquidity_percentile: number | null;
  calendar_period: string;
  observation_closed: boolean;
  market_data_complete: boolean;
  rolling_history_ready: boolean;
  pit_safe: boolean;
}

export interface B4ShadowSignalEvent {
  event_id: string;
  episode_key: string;
  experiment: typeof B4_SHADOW_EXPERIMENT;
  version: typeof B4_SHADOW_VERSION;
  created_at: string;
  market_timestamp: string;
  pit_available_at: string;
  symbol: string;
  direction: B4ShadowDirection;
  alert_type: B4ShadowAlertType;
  family: typeof B4_SHADOW_FAMILY;
  hypothesis: typeof B4_SHADOW_HYPOTHESIS;
  feature_version: typeof B4_SHADOW_FEATURE_VERSION;
  cutoff_version: typeof B4_SHADOW_CUTOFF_VERSION;
  perpetual_price: number;
  premium_value: number;
  price_change_value: number;
  premium_change_value: number;
  price_percentile: number;
  premium_change_percentile: number;
  funding_state: B4ShadowContextState;
  mark_index_basis_state: B4ShadowContextState;
  market_regime: string;
  volatility_bucket: string;
  liquidity_bucket: string;
  calendar_period: string;
  data_completeness: "COMPLETE";
  pit_status: "PASS";
  dedup_state: B4ShadowDedupState;
  shadow_status: B4ShadowStatus;
  control_status: B4ShadowControlStatus;
  control_event_id: string | null;
  control_match_key: string;
  /** Repository-populated pending horizons; not persisted in the event row. */
  pending_horizons?: readonly (typeof B4_SHADOW_OUTCOME_HORIZONS)[number][];
}

export interface B4ShadowEvaluation {
  status: B4ShadowEvaluationStatus;
  event: B4ShadowSignalEvent | null;
  direction: B4ShadowDirection | null;
  reason: string | null;
}

export interface B4ShadowDiagnostics {
  enabled: boolean;
  version: typeof B4_SHADOW_VERSION;
  last_evaluation_at: string | null;
  market_data_status: "READY" | "INCOMPLETE" | "PIT_REJECTED" | "DISABLED";
  rolling_history_ready: boolean;
  eligible_symbols: string[];
  b4_conditions_evaluated: number;
  shadow_events_generated: number;
  long_watch_count: number;
  short_watch_count: number;
  duplicates_suppressed: number;
  data_incomplete_count: number;
  pit_failures: number;
  emails_sent: 0;
}

export interface B4ShadowFutureObservation {
  timestamp: string;
  pit_available_at: string;
  close_price: number;
  high_price: number;
  low_price: number;
  observation_closed: boolean;
  path?: readonly B4ShadowPathObservation[];
}

export interface B4ShadowPathObservation {
  timestamp: string;
  pit_available_at: string;
  close_price: number;
  high_price: number;
  low_price: number;
  observation_closed: boolean;
}

export interface B4ShadowOutcome {
  event_id: string;
  direction: B4ShadowDirection;
  horizon_hours: (typeof B4_SHADOW_OUTCOME_HORIZONS)[number];
  future_observation_timestamp: string;
  future_available_at: string;
  future_price: number;
  signed_return: number;
  max_favorable_move: number;
  max_adverse_move: number;
  pit_safe: true;
  outcome_status: "MATURED";
  calculation_version: typeof B4_SHADOW_VERSION;
}

export interface B4ShadowControlEvent {
  control_event_id: string;
  direction: B4ShadowDirection;
  event_id: string;
  symbol: string;
  market_timestamp: string;
  pit_available_at: string;
  reference_price: number;
  pending_horizons?: readonly (typeof B4_SHADOW_OUTCOME_HORIZONS)[number][];
}

export interface B4ShadowControlOutcome {
  control_event_id: string;
  direction: B4ShadowDirection;
  horizon_hours: (typeof B4_SHADOW_OUTCOME_HORIZONS)[number];
  future_observation_timestamp: string;
  future_available_at: string;
  reference_price: number;
  future_price: number;
  signed_return: number;
  max_favorable_move: number;
  max_adverse_move: number;
  pit_safe: true;
  outcome_status: "MATURED";
  calculation_version: typeof B4_SHADOW_VERSION;
}
