export type Side = "LONG" | "SHORT";
export type Timeframe = "15m" | "1h" | "4h";
export type MarketRegime = "BULL" | "BEAR" | "RANGE" | "UNKNOWN";

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Binance quote-asset volume; absent only in legacy local caches. */
  quoteVolume?: number;
  closeTime: number;
}

export interface FundingRatePoint {
  fundingTime: number;
  fundingRate: number;
}

export interface MarketMicrostructure {
  depthUpdateId: number;
  depthTimestamp: number | null;
  bestBidPrice: number | null;
  bestAskPrice: number | null;
  bidAskSpreadBps: number | null;
  topBidNotional: number;
  topAskNotional: number;
  orderBookImbalance: number | null;
  aggregateTradeCount: number;
  aggregateTradeQuoteVolume: number;
  aggressiveBuyQuoteVolume: number;
  aggressiveBuyRatio: number | null;
  markPrice: number;
  indexPrice: number;
  markIndexBasisBps: number | null;
  fundingRate: number;
  nextFundingTime: number;
  openInterest: number;
  sourceTimestamp: number;
}

export interface Instrument {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  contractType: string;
  status: string;
  priceTick: number;
  quantityStep: number;
  minQuantity?: number;
  maxLeverage?: number;
  quoteVolume24h?: number;
  universeRank?: number;
}

export interface MarketSnapshot {
  instrument: Instrument;
  tickerPrice: number;
  candles: Partial<Record<Timeframe, Candle[]>>;
  sourceTimestamp: number;
  microstructure?: MarketMicrostructure;
}

export interface ScoreComponents {
  trendAlignment: number;
  momentum: number;
  structure: number;
  liquidity: number;
  volatility: number;
  regimeFit: number;
  dataQuality: number;
}

export interface StrategyCandidate {
  strategyFamily: "TREND" | "BREAKOUT" | "MEAN_REVERSION";
  side: Side;
  primaryTimeframe: Timeframe;
  confirmationTimeframes: Timeframe[];
  entryPrice: number;
  stopReferencePrice: number;
  atr: number;
  scoreComponents: ScoreComponents;
  marketRegime: MarketRegime;
  regimeDependency: "LOW" | "MEDIUM" | "HIGH";
  rationale: string[];
  microstructure?: MarketMicrostructure;
}

export interface ScoredCandidate extends StrategyCandidate {
  score: number;
  scoreComponents: ScoreComponents;
}

export interface RiskPolicy {
  marginUsdt: number;
  leverage: number;
  singleSignalRiskCapUsdt: number;
  dailyRiskBudgetUsdt: number;
  maxHoldHours: number;
  rewardRisk?: number;
  riskPerTradeUsdt?: number;
  maxPositionNotionalUsdt?: number;
}

export interface TradePlan {
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  rewardRisk: number;
  assumedMarginUsdt: number;
  assumedLeverage: number;
  positionNotionalUsdt: number;
  quantity: number;
  theoreticalRiskUsdt: number;
  riskOverSingleCap: boolean;
  validUntil: number;
}
