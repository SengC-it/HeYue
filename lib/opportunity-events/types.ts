import type { Candle } from "../core/types";
import type {
  MarketStatusCode,
  SignalEngineInput,
  SignalEngineScores,
  SignalEngineSignal,
} from "../signal-engine";

export type OpportunityDirection = "LONG" | "SHORT";
export type OpportunitySignalType = "LONG_WATCH" | "SHORT_WATCH" | "RISK_WARNING" | "MARKET_STATUS";
export type OpportunityLifecycle = "NO_SETUP" | "SETUP" | "CONFIRMED" | "ACTIVE" | "INVALIDATED" | "EXPIRED";
export type OpportunityEventKind = "INITIAL" | "RISK_TRANSITION" | "RISK_UPGRADE" | "STATUS_TRANSITION";
export type EntryContextPattern =
  | "PULLBACK_RECLAIM"
  | "BREAKOUT_CONFIRMATION"
  | "SUPPORT_INTERACTION"
  | "RESISTANCE_INTERACTION"
  | "NONE";
export type ConfirmationDirection = "SUPPORTS" | "CONFLICTS" | "NEUTRAL";
export type ConfirmationSource =
  | "PRICE"
  | "TREND"
  | "MOMENTUM"
  | "VOLUME"
  | "FUNDING"
  | "OPEN_INTEREST"
  | "LIQUIDITY"
  | "BREADTH"
  | "DATA_QUALITY";
export type InvalidationCode =
  | "OBSERVATION_EXPIRED"
  | "REGIME_CHANGED"
  | "DIRECTION_CONFLICT"
  | "RISK_ESCALATED"
  | "LIQUIDITY_BLOCKED"
  | "DATA_STALE"
  | "DATA_MISSING"
  | "PIT_INVALID"
  | "MANUAL_DISMISSED";
export type InvalidationSeverity = "SOFT" | "HARD";
export type ReplayHorizon = "4h" | "12h" | "24h";
export type ReplayStatus = "COMPLETE" | "NOT_EVALUABLE" | "FAILED";

export interface OpportunityEventObservation {
  symbol: string;
  timestamp: number;
  input: SignalEngineInput;
  scores: SignalEngineScores;
  price_history: readonly Candle[];
  directional_signals: Partial<Record<OpportunityDirection, SignalEngineSignal>>;
  risk_warning: SignalEngineSignal | null;
}

export interface EntryContext {
  direction: OpportunityDirection;
  reference_price: number;
  pattern: EntryContextPattern;
  pullback_reclaim: boolean;
  breakout_confirmation: boolean;
  support_or_resistance_interaction: boolean;
  market_regime: SignalEngineInput["market_regime"];
  market_status: MarketStatusCode;
  price_structure: {
    current_open: number;
    current_high: number;
    current_low: number;
    current_close: number;
    previous_close: number | null;
    lookback_high: number | null;
    lookback_low: number | null;
  };
  source_timestamp: string;
  data_quality: SignalEngineInput["features"]["data_quality"];
  pit_safe: true;
}

export interface OpportunityConfirmation {
  confirmation_id: string;
  code: string;
  source: ConfirmationSource;
  direction: ConfirmationDirection;
  observed_value: number | string | boolean | null;
  criterion: string;
  source_timestamp: string;
  freshness: "FRESH" | "STALE" | "MISSING";
}

export interface ConfirmationBundle {
  confirmations: readonly OpportunityConfirmation[];
  supporting_sources: readonly ConfirmationSource[];
  signature: string;
  qualifying: boolean;
}

export interface OpportunityInvalidation {
  invalidation_id: string;
  opportunity_event_id: string | null;
  code: InvalidationCode;
  severity: InvalidationSeverity;
  detected_at: string;
  source_timestamp: string | null;
  observed_value: number | string | boolean | null;
  explanation: string;
}

export interface ReplayEvaluation {
  opportunity_event_id: string;
  horizon: ReplayHorizon;
  evaluation_start: string;
  evaluation_end: string;
  future_price: number | null;
  raw_return: number | null;
  aligned_return: number | null;
  max_favorable_move: number | null;
  max_adverse_move: number | null;
  time_to_mfe_hours: number | null;
  replay_status: ReplayStatus;
  price_source_timestamp: string | null;
  calculation_version: "hy-r4.15-v1";
  pit_safe: true;
}

export interface OpportunityEvent {
  opportunity_event_id: string;
  episode_id: string;
  event_kind: OpportunityEventKind;
  signal_type: OpportunitySignalType;
  symbol: string;
  observed_at: string;
  source_watermark: string;
  market_regime: SignalEngineInput["market_regime"];
  market_status: MarketStatusCode;
  opportunity_score: number;
  quality_score: number;
  risk_score: number;
  confidence: number;
  reason_codes: readonly string[];
  human_explanation: string;
  lifecycle_status: "CREATED" | "CONFIRMED";
  expires_at: string | null;
  reference_price: number;
  entry_context: EntryContext | null;
  confirmations: readonly OpportunityConfirmation[];
  invalidations: readonly OpportunityInvalidation[];
  replay_evaluations: readonly ReplayEvaluation[];
  supersedes_event_id: string | null;
}

export interface DirectionLifecycleState {
  lifecycle: OpportunityLifecycle;
  episode_number: number;
  episode_id: string | null;
  setup_started_at: number | null;
  active_event_id: string | null;
  active_started_at: number | null;
  last_seen_at: number | null;
  last_confirmation_signature: string | null;
}

export interface RiskLifecycleState {
  high_risk: boolean;
  transition_number: number;
  last_emitted_risk_score: number | null;
  active_event_id: string | null;
  last_seen_at: number | null;
}

export interface MarketStatusLifecycleState {
  last_status: MarketStatusCode | null;
  last_seen_at: number | null;
  transition_number: number;
}

export interface SymbolOpportunityEventState {
  long: DirectionLifecycleState;
  short: DirectionLifecycleState;
  risk: RiskLifecycleState;
  market_status: MarketStatusLifecycleState;
}

export interface OpportunityEventState {
  symbols: Map<string, SymbolOpportunityEventState>;
}

export interface OpportunityEventPolicy {
  setup_ttl_ms: number;
  active_ttl_ms: number;
  minimum_directional_opportunity_score: number;
  minimum_directional_confidence: number;
  maximum_directional_risk_score: number;
  minimum_confirmation_sources: number;
  risk_transition_min_score: number;
  risk_escalation_delta: number;
}

export const defaultOpportunityEventPolicy: OpportunityEventPolicy = {
  setup_ttl_ms: 24 * 60 * 60 * 1000,
  active_ttl_ms: 24 * 60 * 60 * 1000,
  minimum_directional_opportunity_score: 75,
  minimum_directional_confidence: 65,
  maximum_directional_risk_score: 45,
  minimum_confirmation_sources: 3,
  risk_transition_min_score: 55,
  risk_escalation_delta: 10,
};

export interface OpportunityEventEngineResult {
  events: readonly OpportunityEvent[];
  invalidations: readonly OpportunityInvalidation[];
  pit_rejected: boolean;
}
