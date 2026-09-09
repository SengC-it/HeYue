import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  SignalFeatureInput,
  SignalIntelligenceEventInput,
  SignalType,
} from "@/lib/signal-intelligence/types";

export type SignalDirection = "UP" | "DOWN" | "FLAT";
export type LiquidityState = "OK" | "THIN" | "BLOCKED";
export type EngineDataQuality = "PASS" | "DEGRADED" | "BLOCKED";
export type SignalAlertLevel = "A" | "B" | "C";
export type MarketStatusCode =
  | "TREND_UP"
  | "TREND_DOWN"
  | "RANGE"
  | "HIGH_VOL"
  | "NO_TRADE";

export interface TrendFeatures {
  direction: SignalDirection;
  higher_timeframe_direction: SignalDirection;
  strength: number;
  aligned: boolean;
}

export interface MomentumFeatures {
  value: number;
  direction: SignalDirection;
  stabilizing: boolean;
}

export interface VolumeFeatures {
  relative: number;
  confirming: boolean;
}

export interface VolatilityFeatures {
  percentile: number;
  shock: boolean;
}

export interface FundingFeatures {
  percentile: number;
  funding_rate?: number;
  extreme?: boolean;
}

export interface OpenInterestFeatures {
  direction: SignalDirection;
  price_direction: SignalDirection;
  change_percent: number;
  rolling_change_percent?: number;
  abnormal: boolean;
}

export interface LiquidityFeatures {
  state: LiquidityState;
  spread_bps: number;
}

export interface MarketBreadthFeatures {
  advancing_ratio: number;
  trend_agreement: number;
  fragile: boolean;
}

export interface SignalEngineFeatures {
  trend: TrendFeatures;
  momentum: MomentumFeatures;
  volume: VolumeFeatures;
  volatility: VolatilityFeatures;
  funding_state: FundingFeatures;
  open_interest_state: OpenInterestFeatures;
  liquidity_state: LiquidityFeatures;
  market_breadth: MarketBreadthFeatures;
  source_timestamp: string;
  pit_safe: true;
  data_quality: EngineDataQuality;
}

export interface SignalEngineInput {
  symbol: string;
  timestamp: string;
  market_regime: "BULL" | "BEAR" | "RANGE" | "UNKNOWN";
  reference_price: number;
  features: SignalEngineFeatures;
}

export interface SignalScoreBreakdown {
  market_condition: Record<string, number>;
  signal_quality: Record<string, number>;
  risk_level: Record<string, number>;
}

export interface SignalEngineScores {
  market_condition_score: number;
  signal_quality_score: number;
  risk_level_score: number;
  confidence: number;
  long_opportunity_score: number;
  short_opportunity_score: number;
  long_evidence_count: number;
  short_evidence_count: number;
  market_status: MarketStatusCode;
  risk_reason_codes: string[];
  pit_safe: boolean;
  breakdown: SignalScoreBreakdown;
}

export interface SignalEngineSignal {
  event: SignalIntelligenceEventInput;
  feature_snapshot: SignalFeatureInput | null;
  signal_type: SignalType;
  opportunity_score: number;
  alert_level: SignalAlertLevel;
  scores: SignalEngineScores;
}

export interface SignalEngineEvaluation {
  signals: SignalEngineSignal[];
  scores: SignalEngineScores;
  persistence_eligible: boolean;
}

export interface SignalEngineRunOptions {
  dryRun?: boolean;
  supabase?: SupabaseClient;
  idFactory?: () => string;
}

export interface SignalEngineRunResult extends SignalEngineEvaluation {
  dry_run: boolean;
  persisted: boolean;
  persisted_signal_ids: string[];
  emails_sent: 0;
}
