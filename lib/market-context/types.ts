export type ContextDirection = "UP" | "DOWN" | "FLAT";
export type ContextStatus = "STRONG" | "NORMAL" | "WEAK" | "BLOCKED";
export type LiquidityVolumeSource = "QUOTE_VOLUME" | "CLOSE_TIMES_VOLUME" | "MIXED" | "BLOCKED";

export interface LiquidityHistoryPoint {
  timestamp: number;
  quote_volume_24h: number;
}

export interface LiquidityFeatureInput {
  symbol: string;
  as_of: number;
  source_timestamp?: number | null;
  quote_volume_24h: number | null;
  sample_count_24h: number;
  volume_source: LiquidityVolumeSource;
  history: LiquidityHistoryPoint[];
  percentile_window?: number;
  minimum_history_samples?: number;
}

export interface LiquidityFeature {
  symbol: string;
  timestamp: string;
  quote_volume_24h: number | null;
  volume_percentile: number | null;
  liquidity_score: number | null;
  status: ContextStatus;
  sample_count_24h: number;
  history_sample_count: number;
  volume_source: LiquidityVolumeSource;
  future_history_points_ignored: number;
  source_timestamp: string;
  pit_safe: true;
}

export interface QuoteVolumeObservation {
  quote_volume_24h: number | null;
  sample_count_24h: number;
  volume_source: LiquidityVolumeSource;
  source_timestamp: number | null;
  pit_safe: true;
}

export interface MarketBreadthMember {
  symbol: string;
  source_timestamp: number;
  price_return_24h: number;
  quote_volume_24h: number | null;
}

export interface MarketBreadthFeatureInput {
  as_of: number;
  members: MarketBreadthMember[];
  top_universe_size?: number;
  minimum_members?: number;
  direction_threshold?: number;
}

export interface MarketBreadthFeature {
  timestamp: string;
  advancing_ratio: number | null;
  declining_ratio: number | null;
  flat_ratio: number | null;
  valid_symbols: number;
  total_symbols: number;
  top_universe_size: number;
  top_universe_strength: number | null;
  top_universe_symbols: string[];
  breadth_score: number | null;
  direction: ContextDirection;
  status: ContextStatus;
  future_member_points_ignored: number;
  source_timestamp: string | null;
  pit_safe: true;
}
