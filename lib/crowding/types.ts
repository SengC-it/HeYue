export const BINANCE_METRICS_FIELDS = [
  "create_time",
  "symbol",
  "sum_open_interest",
  "sum_open_interest_value",
  "count_toptrader_long_short_ratio",
  "sum_toptrader_long_short_ratio",
  "count_long_short_ratio",
  "sum_taker_long_short_vol_ratio",
] as const;

export type BinanceMetricsField = (typeof BINANCE_METRICS_FIELDS)[number];

export interface CrowdingMetricsObservation {
  timestamp: number;
  symbol: string;
  openInterest: number;
  openInterestValue: number;
  topTraderAccountRatio: number;
  topTraderPositionRatio: number;
  globalAccountRatio: number;
  takerLongShortRatio: number;
}

export interface MetricsSchemaAudit {
  delimiter: "COMMA" | "TAB" | "UNKNOWN";
  headers: string[];
  missingFields: BinanceMetricsField[];
  extraFields: string[];
}

export interface MetricsParseResult {
  schema: MetricsSchemaAudit;
  observations: CrowdingMetricsObservation[];
  issues: string[];
}
