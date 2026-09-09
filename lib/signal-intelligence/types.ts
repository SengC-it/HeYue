export const signalTypeValues = [
  "LONG_WATCH",
  "SHORT_WATCH",
  "RISK_WARNING",
  "MARKET_STATUS",
] as const;

export type SignalType = typeof signalTypeValues[number];

export const signalEventStatusValues = [
  "CREATED",
  "DELIVERED",
  "EXPIRED",
  "EVALUATED",
  "DISMISSED",
] as const;

export type SignalEventStatus = typeof signalEventStatusValues[number];

export const marketRegimeValues = ["BULL", "BEAR", "RANGE", "UNKNOWN"] as const;
export type SignalMarketRegime = typeof marketRegimeValues[number];

export const deliveryStatusValues = [
  "PENDING",
  "SENT",
  "DELIVERED",
  "FAILED",
  "SUPPRESSED",
] as const;

export type SignalDeliveryStatus = typeof deliveryStatusValues[number];

export const userActionValues = ["WATCHED", "TRADED", "IGNORED"] as const;
export type SignalUserAction = typeof userActionValues[number];

export const manualDirectionValues = ["LONG", "SHORT"] as const;
export type ManualDirection = typeof manualDirectionValues[number];

export const replayStatusValues = [
  "PENDING",
  "COMPLETE",
  "NOT_EVALUABLE",
  "FAILED",
] as const;

export type SignalReplayStatus = typeof replayStatusValues[number];

export type SignalFeatureObject = Record<string, unknown>;

export interface SignalIntelligenceEventInput {
  id?: string;
  symbol: string;
  signal_type: SignalType;
  created_at?: string;
  market_regime: SignalMarketRegime;
  quality_score: number;
  risk_score: number;
  confidence: number;
  reason_codes: string[];
  human_explanation: string;
  reference_price: number;
  status?: SignalEventStatus;
}

export interface SignalIntelligenceEvent extends Required<SignalIntelligenceEventInput> {
  id: string;
  created_at: string;
}

export interface SignalFeatureInput {
  signal_id: string;
  trend: SignalFeatureObject;
  momentum: SignalFeatureObject;
  volume: SignalFeatureObject;
  volatility: SignalFeatureObject;
  funding_state: SignalFeatureObject;
  open_interest_state: SignalFeatureObject;
  liquidity_state: SignalFeatureObject;
  market_breadth: SignalFeatureObject;
  captured_at?: string;
  pit_safe?: true;
  snapshot_hash?: string | null;
}

export interface SignalFeatureSnapshot extends SignalFeatureInput {
  captured_at: string;
  pit_safe: true;
  snapshot_hash: string | null;
}

export interface AlertDeliveryInput {
  id?: string;
  signal_id: string;
  channel?: "EMAIL";
  email: string;
  status?: SignalDeliveryStatus;
  sent_at?: string | null;
  failure_reason?: string | null;
  idempotency_key?: string;
}

export interface AlertDelivery extends Required<Omit<AlertDeliveryInput, "id" | "sent_at" | "failure_reason">> {
  id: string;
  sent_at: string | null;
  failure_reason: string | null;
  created_at: string;
}

export interface SignalReplayInput {
  signal_id: string;
  future_4h_price?: number | null;
  future_12h_price?: number | null;
  future_24h_price?: number | null;
  return_4h?: number | null;
  return_12h?: number | null;
  return_24h?: number | null;
  max_favorable_move?: number | null;
  max_adverse_move?: number | null;
  reference_timestamp: string;
  pit_safe?: true;
  replay_status?: SignalReplayStatus;
  evaluated_at?: string | null;
  calculation_version?: string | null;
}

export interface SignalReplay extends SignalReplayInput {
  pit_safe: true;
  replay_status: SignalReplayStatus;
  created_at: string;
}

export interface SignalFeedbackInput {
  id?: string;
  signal_id: string;
  user_action: SignalUserAction;
  manual_direction?: ManualDirection | null;
  rating: number;
  comment?: string | null;
}

export interface SignalFeedback extends Required<Omit<SignalFeedbackInput, "id" | "manual_direction" | "comment">> {
  id: string;
  manual_direction: ManualDirection | null;
  comment: string | null;
  created_at: string;
}

export const signalIntelligenceTableNames = [
  "hy_signal_intelligence_events",
  "hy_signal_features",
  "hy_alert_delivery",
  "hy_signal_replays",
  "hy_signal_feedback",
] as const;
