import type {
  MarketStatusCode,
  SignalEngineSignal,
} from "../signal-engine";

export interface SignalQualityPolicy {
  directional_min_opportunity_score: number;
  directional_min_confidence: number;
  directional_max_risk_score: number;
  risk_warning_min_risk_score: number;
  directional_cooldown_ms: number;
  risk_warning_cooldown_ms: number;
  status_heartbeat_ms: number;
  escalation_delta: number;
}

export const defaultSignalQualityPolicy: SignalQualityPolicy = {
  directional_min_opportunity_score: 75,
  directional_min_confidence: 65,
  directional_max_risk_score: 45,
  risk_warning_min_risk_score: 55,
  directional_cooldown_ms: 24 * 60 * 60 * 1000,
  risk_warning_cooldown_ms: 12 * 60 * 60 * 1000,
  status_heartbeat_ms: 24 * 60 * 60 * 1000,
  escalation_delta: 10,
};

export type SignalQualityFilterReason =
  | "DIRECTIONAL_STATUS_MISMATCH"
  | "DIRECTIONAL_RISK_TOO_HIGH"
  | "DIRECTIONAL_CONFIDENCE_TOO_LOW"
  | "DIRECTIONAL_OPPORTUNITY_TOO_LOW"
  | "RISK_NOT_MATERIAL"
  | "DUPLICATE_WITHIN_COOLDOWN"
  | "STATUS_HEARTBEAT_SUPPRESSED";

export interface SignalQualityFilteredSignal {
  signal: SignalEngineSignal;
  reason: SignalQualityFilterReason;
}

export interface SignalQualityState {
  last_directional: Map<string, SignalQualityStateRecord>;
  last_risk_warning: Map<string, SignalQualityStateRecord>;
  last_status: Map<string, SignalQualityStatusRecord>;
}

export interface SignalQualityStateRecord {
  timestamp: number;
  risk_score: number;
  opportunity_score: number;
  reason_signature: string;
}

export interface SignalQualityStatusRecord {
  timestamp: number;
  status: MarketStatusCode;
}

export interface SignalQualityResult {
  signals: SignalEngineSignal[];
  filtered: SignalQualityFilteredSignal[];
}
