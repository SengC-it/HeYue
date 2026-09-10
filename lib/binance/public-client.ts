import type {
  Candle,
  FundingRatePoint,
  Instrument,
  MarketMicrostructure,
  MarketSnapshot,
  Timeframe,
} from "@/lib/core/types";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import type {
  BinanceExchangeInfo,
  BinanceExchangeSymbol,
  BinanceAggTrade,
  BinanceDepth,
  BinanceFundingRate,
  BinanceKline,
  BinanceOpenInterest,
  BinancePremiumIndex,
  BinanceTicker24h,
} from "./types";
import type {
  B4LiveBar,
  B4LiveFundingPoint,
  B4LiveHistory,
} from "@/lib/signal-engine/b4-live-features";

configureNodeProxy();

const INTERVALS: Record<Timeframe, string> = {
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
};

const INTERVAL_MS: Record<Timeframe, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
};

const DEFAULT_REQUEST_DELAY_MS = 0;

export class BinancePublicClient {
  constructor(
    private readonly baseUrl = "https://fapi.binance.com",
    private readonly timeoutMs = 12_000,
    private readonly requestDelayMs = DEFAULT_REQUEST_DELAY_MS,
  ) {}

  private nextRequestAt = 0;

  async getUniverse(): Promise<Instrument[]> {
    const [exchangeInfo, tickers] = await Promise.all([
      this.get<BinanceExchangeInfo>("/fapi/v1/exchangeInfo"),
      this.get<BinanceTicker24h[]>("/fapi/v1/ticker/24hr"),
    ]);
    const tickerBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));

    return exchangeInfo.symbols
      .filter(
        (symbol) =>
          symbol.status === "TRADING" &&
          symbol.contractType === "PERPETUAL" &&
          symbol.quoteAsset === "USDT",
      )
      .map((symbol) => this.toInstrument(symbol, tickerBySymbol.get(symbol.symbol)))
      .sort((left, right) => (right.quoteVolume24h ?? 0) - (left.quoteVolume24h ?? 0))
      .map((instrument, index) => ({ ...instrument, universeRank: index + 1 }));
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit = 250): Promise<Candle[]> {
    const raw = await this.get<unknown[][]>("/fapi/v1/klines", {
      symbol,
      interval: INTERVALS[timeframe],
      limit: String(limit),
    });

    return raw
      .map(parseKline)
      .filter((candle) => candle.closeTime <= Date.now());
  }

  async getCandlesRange(
    symbol: string,
    timeframe: Timeframe,
    startTime: number,
    endTime: number,
  ): Promise<Candle[]> {
    const candles = new Map<number, Candle>();
    const intervalMs = INTERVAL_MS[timeframe];
    let cursor = startTime;
    let page = 0;

    while (cursor <= endTime && page < 10_000) {
      const raw = await this.get<unknown[][]>("/fapi/v1/klines", {
        symbol,
        interval: INTERVALS[timeframe],
        startTime: String(cursor),
        endTime: String(endTime),
        limit: "1500",
      });
      if (raw.length === 0) break;

      const parsed = raw
        .map(parseKline)
        .filter((candle) => candle.openTime >= startTime && candle.closeTime <= endTime && candle.closeTime <= Date.now());
      for (const candle of parsed) candles.set(candle.openTime, candle);

      const lastOpenTime = Number(raw.at(-1)?.[0]);
      if (!Number.isFinite(lastOpenTime) || lastOpenTime < cursor || raw.length < 1500) break;
      cursor = lastOpenTime + intervalMs;
      page += 1;
      await delay(40);
    }

    return [...candles.values()].sort((left, right) => left.openTime - right.openTime);
  }

  async getFundingRatesRange(
    symbol: string,
    startTime: number,
    endTime: number,
  ): Promise<FundingRatePoint[]> {
    const rates = new Map<number, FundingRatePoint>();
    let cursor = startTime;
    let page = 0;

    while (cursor <= endTime && page < 100) {
      const raw = await this.get<BinanceFundingRate[]>("/fapi/v1/fundingRate", {
        symbol,
        startTime: String(cursor),
        endTime: String(endTime),
        limit: "1000",
      });
      if (raw.length === 0) break;

      for (const point of raw) {
        const fundingTime = Number(point.fundingTime);
        const fundingRate = Number(point.fundingRate);
        if (Number.isFinite(fundingTime) && Number.isFinite(fundingRate)) {
          rates.set(fundingTime, { fundingTime, fundingRate });
        }
      }

      const lastFundingTime = Number(raw.at(-1)?.fundingTime);
      if (!Number.isFinite(lastFundingTime) || lastFundingTime < cursor || raw.length < 1000) break;
      cursor = lastFundingTime + 1;
      page += 1;
      await delay(40);
    }

    return [...rates.values()].sort((left, right) => left.fundingTime - right.fundingTime);
  }

  /**
   * Fetch the public, closed 1h histories required by frozen B4. Each kline
   * endpoint is bounded to the 1500-row Binance maximum; the B4 builder then
   * applies its own PIT and contiguity checks.
   */
  async getB4LiveHistory(
    symbol: string,
    decisionTime = Date.now(),
    limit = 722,
  ): Promise<B4LiveHistory> {
    const boundedLimit = Math.min(1500, Math.max(2, Math.floor(limit)));
    const lastClosedBarCloseTime = getLastClosedB4BarCloseTime(decisionTime);
    const lastClosedBarOpenTime = lastClosedBarCloseTime - INTERVAL_MS["1h"] + 1;
    const startTime = Math.max(0, lastClosedBarOpenTime - (boundedLimit - 1) * INTERVAL_MS["1h"]);
    // Funding is independent from the 3-bar incremental kline fetch. The
    // latest valid funding event may be several hours older than the current
    // close and remains the only PIT-safe context to consume.
    const fundingStartTime = Math.max(0, decisionTime - 24 * INTERVAL_MS["1h"]);
    const [priceRaw, premiumRaw, markRaw, indexRaw, fundingRates] = await Promise.all([
      this.get<unknown[][]>("/fapi/v1/klines", {
        symbol,
        interval: "1h",
        startTime: String(startTime),
        endTime: String(lastClosedBarCloseTime),
        limit: String(boundedLimit),
      }),
      this.get<unknown[][]>("/fapi/v1/premiumIndexKlines", {
        symbol,
        interval: "1h",
        startTime: String(startTime),
        endTime: String(lastClosedBarCloseTime),
        limit: String(boundedLimit),
      }),
      this.get<unknown[][]>("/fapi/v1/markPriceKlines", {
        symbol,
        interval: "1h",
        startTime: String(startTime),
        endTime: String(lastClosedBarCloseTime),
        limit: String(boundedLimit),
      }),
      this.get<unknown[][]>("/fapi/v1/indexPriceKlines", {
        pair: symbol,
        interval: "1h",
        startTime: String(startTime),
        endTime: String(lastClosedBarCloseTime),
        limit: String(boundedLimit),
      }),
      this.getFundingRatesRange(symbol, fundingStartTime, decisionTime),
    ]);
    return {
      symbol,
      priceBars: priceRaw.map((row) => parseB4Kline(row)),
      premiumBars: premiumRaw.map((row) => parseB4Kline(row, false)),
      markBars: markRaw.map((row) => parseB4Kline(row)),
      indexBars: indexRaw.map((row) => parseB4Kline(row)),
      fundingRates: fundingRates.map((point) => ({
        fundingTime: point.fundingTime,
        fundingRate: point.fundingRate,
        pitAvailableAt: point.fundingTime,
      } satisfies B4LiveFundingPoint)),
    };
  }

  async getClosedB4FutureObservation(
    symbol: string,
    eventTime: number,
    dueTime: number,
    decisionTime = Date.now(),
  ): Promise<{
    timestamp: string;
    pit_available_at: string;
    close_price: number;
    high_price: number;
    low_price: number;
    observation_closed: boolean;
    path: Array<{
      timestamp: string;
      pit_available_at: string;
      close_price: number;
      high_price: number;
      low_price: number;
      observation_closed: boolean;
    }>;
  } | null> {
    const candles = await this.getCandles(symbol, "1h", 1000);
    const closed = candles
      .filter((item) => item.openTime + INTERVAL_MS["1h"] <= decisionTime)
      .sort((left, right) => left.openTime - right.openTime);
    const candle = closed.find((item) => item.openTime === dueTime);
    if (!candle) return null;
    const path = closed.filter((item) => item.openTime > eventTime && item.openTime <= dueTime);
    if (path.length === 0 || path[0].openTime !== eventTime + INTERVAL_MS["1h"]
      || path.at(-1)?.openTime !== dueTime
      || path.some((item, index) => index > 0 && item.openTime !== path[index - 1].openTime + INTERVAL_MS["1h"])) return null;
    return {
      timestamp: new Date(candle.openTime).toISOString(),
      pit_available_at: new Date(candle.openTime + INTERVAL_MS["1h"]).toISOString(),
      close_price: candle.close,
      high_price: candle.high,
      low_price: candle.low,
      observation_closed: true,
      path: path.map((item) => ({
        timestamp: new Date(item.openTime).toISOString(),
        pit_available_at: new Date(item.openTime + INTERVAL_MS["1h"]).toISOString(),
        close_price: item.close,
        high_price: item.high,
        low_price: item.low,
        observation_closed: true,
      })),
    };
  }

  async getTickerPrice(symbol: string): Promise<number> {
    const result = await this.get<{ symbol: string; price: string }>("/fapi/v1/ticker/price", {
      symbol,
    });
    const price = Number(result.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Invalid ticker price for ${symbol}`);
    return price;
  }

  async getDepth(symbol: string, limit = 20): Promise<BinanceDepth> {
    return this.get<BinanceDepth>("/fapi/v1/depth", {
      symbol,
      limit: String(limit),
    });
  }

  async getAggTrades(symbol: string, limit = 100): Promise<BinanceAggTrade[]> {
    return this.get<BinanceAggTrade[]>("/fapi/v1/aggTrades", {
      symbol,
      limit: String(limit),
    });
  }

  async getPremiumIndex(symbol: string): Promise<BinancePremiumIndex> {
    return this.get<BinancePremiumIndex>("/fapi/v1/premiumIndex", { symbol });
  }

  async getOpenInterest(symbol: string): Promise<BinanceOpenInterest> {
    return this.get<BinanceOpenInterest>("/fapi/v1/openInterest", { symbol });
  }

  async getMicrostructure(
    symbol: string,
    options: { depthLimit?: number; tradeLimit?: number } = {},
  ): Promise<MarketMicrostructure> {
    const depthLimit = options.depthLimit ?? 20;
    const tradeLimit = options.tradeLimit ?? 100;
    const [depth, trades, premiumIndex, openInterest] = await Promise.all([
      this.getDepth(symbol, depthLimit),
      this.getAggTrades(symbol, tradeLimit),
      this.getPremiumIndex(symbol),
      this.getOpenInterest(symbol),
    ]);
    return buildMicrostructure(depth, trades, premiumIndex, openInterest);
  }

  async getSnapshot(
    instrument: Instrument,
    timeframes: Timeframe[],
    limit = 250,
    options: {
      includeMicrostructure?: boolean;
      microstructureDepthLimit?: number;
      microstructureTradeLimit?: number;
    } = {},
  ): Promise<MarketSnapshot> {
    const requestedTimeframes = Array.from(new Set(["15m" as Timeframe, ...timeframes]));
    const candlePromise = Promise.all(
      requestedTimeframes.map(async (timeframe) => [timeframe, await this.getCandles(instrument.symbol, timeframe, limit)] as const),
    );
    const microstructurePromise = options.includeMicrostructure
      ? this.getMicrostructure(instrument.symbol, {
        depthLimit: options.microstructureDepthLimit,
        tradeLimit: options.microstructureTradeLimit,
      })
      : Promise.resolve(undefined);
    const tickerPromise = this.getTickerPrice(instrument.symbol).catch(() => undefined);
    const [candleEntries, microstructure, liveTickerPrice] = await Promise.all([
      candlePromise,
      microstructurePromise,
      tickerPromise,
    ]);
    const primaryCandles = candleEntries.find(([timeframe]) => timeframe === "15m")?.[1] ?? [];
    const tickerPrice = liveTickerPrice ?? primaryCandles.at(-1)?.close;
    if (tickerPrice === undefined) throw new Error(`No ticker or closed candle price for ${instrument.symbol}`);
    const sourceTimestamp = primaryCandles.at(-1)?.closeTime
      ?? candleEntries.flatMap(([, candles]) => candles).reduce((latest, candle) => Math.max(latest, candle.closeTime), 0);

    return {
      instrument,
      tickerPrice,
      candles: Object.fromEntries(candleEntries),
      // Signal identity follows the primary 15m candle. A higher timeframe can stay
      // unchanged for hours and must not suppress new 15m opportunities.
      sourceTimestamp,
      microstructure,
    };
  }

  private async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.waitForRequestSlot();
        const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
        const body = await response.text();
        if (!response.ok) {
          throw new BinanceApiError(response.status, body.slice(0, 500));
        }
        return JSON.parse(body) as T;
      } catch (error) {
        lastError = error;
        if (error instanceof BinanceApiError && error.status < 500 && error.status !== 429) break;
        if (attempt < 2) await delay(250 * 2 ** attempt);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Binance request failed");
  }

  private async waitForRequestSlot(): Promise<void> {
    if (this.requestDelayMs <= 0) return;
    const now = Date.now();
    const requestAt = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = requestAt + this.requestDelayMs;
    if (requestAt > now) await delay(requestAt - now);
  }

  private toInstrument(symbol: BinanceExchangeSymbol, ticker?: BinanceTicker24h): Instrument {
    const priceFilter = symbol.filters.find((filter) => filter.filterType === "PRICE_FILTER");
    const lotSizeFilter = symbol.filters.find((filter) => filter.filterType === "LOT_SIZE");
    return {
      symbol: symbol.symbol,
      baseAsset: symbol.baseAsset,
      quoteAsset: symbol.quoteAsset,
      contractType: symbol.contractType,
      status: symbol.status,
      priceTick: Number(priceFilter?.tickSize ?? "0.00000001"),
      quantityStep: Number(lotSizeFilter?.stepSize ?? "0.00000001"),
      minQuantity: lotSizeFilter?.minQty ? Number(lotSizeFilter.minQty) : undefined,
      maxLeverage: undefined,
      quoteVolume24h: ticker?.quoteVolume ? Number(ticker.quoteVolume) : undefined,
    };
  }
}

/** Millisecond close boundary of the last 1h bar available at decisionTime. */
export function getLastClosedB4BarCloseTime(decisionTime: number): number {
  if (!Number.isFinite(decisionTime)) throw new Error("decision time must be finite");
  const hour = INTERVAL_MS["1h"];
  return Math.floor(decisionTime / hour) * hour - 1;
}

export function buildMicrostructure(
  depth: BinanceDepth,
  trades: BinanceAggTrade[],
  premiumIndex: BinancePremiumIndex,
  openInterest: BinanceOpenInterest,
): MarketMicrostructure {
  const bids = depth.bids.map(parseBookLevel).filter(isBookLevel);
  const asks = depth.asks.map(parseBookLevel).filter(isBookLevel);
  const topBidNotional = bids.reduce((total, level) => total + level.price * level.quantity, 0);
  const topAskNotional = asks.reduce((total, level) => total + level.price * level.quantity, 0);
  const bestBidPrice = bids[0]?.price ?? null;
  const bestAskPrice = asks[0]?.price ?? null;
  const midpoint = bestBidPrice !== null && bestAskPrice !== null
    ? (bestBidPrice + bestAskPrice) / 2
    : null;
  const bidAskSpreadBps = midpoint && midpoint > 0 && bestBidPrice !== null && bestAskPrice !== null
    ? (bestAskPrice - bestBidPrice) / midpoint * 10_000
    : null;
  const totalBookNotional = topBidNotional + topAskNotional;
  const orderBookImbalance = totalBookNotional > 0
    ? (topBidNotional - topAskNotional) / totalBookNotional
    : null;
  const tradeTotals = trades.reduce((totals, trade) => {
    const price = Number(trade.p);
    const quantity = Number(trade.nq ?? trade.q);
    if (!Number.isFinite(price) || !Number.isFinite(quantity) || quantity <= 0) return totals;
    const quoteVolume = price * quantity;
    totals.quoteVolume += quoteVolume;
    if (!trade.m) totals.aggressiveBuyQuoteVolume += quoteVolume;
    return totals;
  }, { quoteVolume: 0, aggressiveBuyQuoteVolume: 0 });
  const markPrice = Number(premiumIndex.markPrice);
  const indexPrice = Number(premiumIndex.indexPrice);
  const fundingRate = Number(premiumIndex.lastFundingRate);
  const openInterestValue = Number(openInterest.openInterest);
  const markIndexBasisBps = Number.isFinite(markPrice)
    && Number.isFinite(indexPrice)
    && indexPrice > 0
    ? (markPrice / indexPrice - 1) * 10_000
    : null;
  const aggregateTradeQuoteVolume = roundMetric(tradeTotals.quoteVolume);
  const aggressiveBuyQuoteVolume = roundMetric(tradeTotals.aggressiveBuyQuoteVolume);

  return {
    depthUpdateId: Number(depth.lastUpdateId),
    depthTimestamp: Number.isFinite(depth.T ?? NaN) ? Number(depth.T) : Number.isFinite(depth.E ?? NaN) ? Number(depth.E) : null,
    bestBidPrice,
    bestAskPrice,
    bidAskSpreadBps: bidAskSpreadBps === null ? null : roundMetric(bidAskSpreadBps),
    topBidNotional: roundMetric(topBidNotional),
    topAskNotional: roundMetric(topAskNotional),
    orderBookImbalance: orderBookImbalance === null ? null : roundMetric(orderBookImbalance),
    aggregateTradeCount: trades.length,
    aggregateTradeQuoteVolume,
    aggressiveBuyQuoteVolume,
    aggressiveBuyRatio: aggregateTradeQuoteVolume > 0
      ? roundMetric(aggressiveBuyQuoteVolume / aggregateTradeQuoteVolume)
      : null,
    markPrice,
    indexPrice,
    markIndexBasisBps: markIndexBasisBps === null ? null : roundMetric(markIndexBasisBps),
    fundingRate,
    nextFundingTime: Number(premiumIndex.nextFundingTime),
    openInterest: openInterestValue,
    sourceTimestamp: Math.max(
      Number(depth.E ?? 0),
      Number(depth.T ?? 0),
      ...trades.map((trade) => Number(trade.T) || 0),
      Number(premiumIndex.time),
      Number(openInterest.time),
    ),
  };
}

export class BinanceApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(`Binance API ${status}: ${message}`);
    this.name = "BinanceApiError";
  }
}

export function selectDeepUniverse(universe: Instrument[], limit: number): Instrument[] {
  return universe.slice(0, Math.max(1, limit));
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }),
  );

  return results;
}

export function parseKline(raw: unknown[]): BinanceKline {
  if (raw.length < 7) throw new Error("Malformed Binance kline");
  const quoteVolume = Number(raw[7]);
  const candle = {
    openTime: Number(raw[0]),
    open: Number(raw[1]),
    high: Number(raw[2]),
    low: Number(raw[3]),
    close: Number(raw[4]),
    volume: Number(raw[5]),
    ...(Number.isFinite(quoteVolume) && quoteVolume >= 0 ? { quoteVolume } : {}),
    closeTime: Number(raw[6]),
  };
  if (Object.values(candle).some((value) => !Number.isFinite(value))) {
    throw new Error("Malformed Binance kline values");
  }
  if (
    candle.open <= 0
    || candle.high < Math.max(candle.open, candle.close)
    || candle.low > Math.min(candle.open, candle.close)
    || candle.low <= 0
    || candle.volume < 0
    || candle.closeTime <= candle.openTime
  ) {
    throw new Error("Malformed Binance kline OHLCV invariants");
  }
  return candle;
}

interface ParsedBookLevel {
  price: number;
  quantity: number;
}

function parseBookLevel(raw: [string, string]): ParsedBookLevel | null {
  const price = Number(raw[0]);
  const quantity = Number(raw[1]);
  return Number.isFinite(price) && Number.isFinite(quantity) && price > 0 && quantity >= 0
    ? { price, quantity }
    : null;
}

function isBookLevel(value: ParsedBookLevel | null): value is ParsedBookLevel {
  return value !== null;
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseB4Kline(raw: unknown[], requirePositive = true): B4LiveBar {
  if (raw.length < 7) throw new Error("Malformed B4 Binance kline");
  const openTime = Number(raw[0]);
  const closeTime = Number(raw[6]);
  const close = Number(raw[4]);
  const high = Number(raw[2]);
  const low = Number(raw[3]);
  const quoteVolume = Number(raw[7]);
  if (![openTime, closeTime, close, high, low].every(Number.isFinite)
    || (requirePositive && (close <= 0 || high <= 0 || low <= 0))
    || (!requirePositive && (high < low))
    || (requirePositive && (low > close || high < close))
    || closeTime <= openTime || closeTime >= openTime + INTERVAL_MS["1h"]) {
    throw new Error("Malformed B4 Binance kline values");
  }
  return {
    openTime,
    closeTime,
    close,
    high,
    low,
    ...(Number.isFinite(quoteVolume) && quoteVolume >= 0 ? { quoteVolume } : {}),
  };
}

function configureNodeProxy(): void {
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (proxyUrl) setGlobalDispatcher(new ProxyAgent(proxyUrl));
}
