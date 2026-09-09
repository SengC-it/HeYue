export const BASIS_PREMIUM_FAMILIES = [
  "PREMIUM_INDEX",
  "INDEX_PRICE",
  "MARK_PRICE",
  "PERPETUAL_PRICE",
] as const;

export type BasisPremiumFamily = (typeof BASIS_PREMIUM_FAMILIES)[number];

export const BASIS_PREMIUM_RESOLUTIONS = ["1m", "5m", "15m", "1h"] as const;
export type BasisPremiumResolution = (typeof BASIS_PREMIUM_RESOLUTIONS)[number];

export const BINANCE_KLINE_COLUMNS = [
  "open_time",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "close_time",
  "quote_asset_volume",
  "number_of_trades",
  "taker_buy_base_asset_volume",
  "taker_buy_quote_asset_volume",
  "ignore",
] as const;

export interface BasisPremiumKline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteAssetVolume: number;
  numberOfTrades: number;
  takerBuyBaseAssetVolume: number;
  takerBuyQuoteAssetVolume: number;
  ignore: number;
}

export interface KlineParseResult {
  rows: BasisPremiumKline[];
  rawRowCount: number;
  invalidRowCount: number;
  invalidTimestampCount: number;
  invalidPriceCount: number;
  invalidVolumeCount: number;
  duplicateTimestampCount: number;
  outOfOrderCount: number;
  cadenceBreakCount: number;
  boundaryViolationCount: number;
  schemaFields: string[];
  issues: string[];
}

export interface LifecycleSpan {
  id: string;
  kind: string;
  startTime: number;
  endTimeExclusive: number;
}

export interface CoverageSummary {
  expected: number;
  valid: number;
  missing: number;
  coveragePercent: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  gapRuns: number;
  gapSamples: Array<{ startTime: number; endTimeExclusive: number; missing: number }>;
}
