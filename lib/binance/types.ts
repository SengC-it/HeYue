export interface BinanceExchangeFilter {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
  minQty?: string;
  maxQty?: string;
}

export interface BinanceExchangeSymbol {
  symbol: string;
  pair: string;
  contractType: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  marginAsset: string;
  filters: BinanceExchangeFilter[];
}

export interface BinanceExchangeInfo {
  symbols: BinanceExchangeSymbol[];
}

export interface BinanceTicker24h {
  symbol: string;
  lastPrice: string;
  quoteVolume: string;
  volume: string;
  priceChangePercent: string;
}

export interface BinanceKline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume?: number;
  closeTime: number;
}

export interface BinanceFundingRate {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
}

export type BinanceOrderBookLevel = [string, string];

export interface BinanceDepth {
  lastUpdateId: number;
  E?: number;
  T?: number;
  bids: BinanceOrderBookLevel[];
  asks: BinanceOrderBookLevel[];
}

export interface BinanceAggTrade {
  a: number;
  p: string;
  q: string;
  nq?: string;
  f: number;
  l: number;
  T: number;
  m: boolean;
}

export interface BinancePremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  estimatedSettlePrice?: string;
  lastFundingRate: string;
  interestRate?: string;
  nextFundingTime: number;
  time: number;
}

export interface BinanceOpenInterest {
  symbol: string;
  openInterest: string;
  time: number;
}
