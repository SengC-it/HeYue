import { describe, expect, it } from "vitest";
import {
  calculate24hQuoteVolume,
  calculateLiquidityFeature,
  calculateMarketBreadthFeature,
} from "../lib/market-context";
import type { Candle } from "../lib/core/types";

const HOUR = 60 * 60 * 1000;

describe("HY-R4.10 market context intelligence", () => {
  it("calculates 24h quote volume only from candles known at as-of", () => {
    const candles = Array.from({ length: 26 }, (_, index) => candle(index, {
      quoteVolume: index === 25 ? 1_000_000 : index + 1,
    }));
    const asOf = candles[23]!.closeTime;

    const result = calculate24hQuoteVolume(candles, asOf);

    expect(result.quote_volume_24h).toBe(300);
    expect(result.sample_count_24h).toBe(24);
    expect(result.volume_source).toBe("QUOTE_VOLUME");
    expect(result.source_timestamp).toBe(asOf);
    expect(result.pit_safe).toBe(true);
  });

  it("uses a transparent close-times-volume fallback for legacy candles", () => {
    const candles = Array.from({ length: 24 }, (_, index) => candle(index, {
      quoteVolume: index === 0 ? undefined : 10,
      close: 2,
      volume: 5,
    }));

    const result = calculate24hQuoteVolume(candles, candles[23]!.closeTime);

    expect(result.quote_volume_24h).toBe(240);
    expect(result.volume_source).toBe("MIXED");
  });

  it("excludes future volume history from the percentile", () => {
    const asOf = 2_000_000;
    const history = Array.from({ length: 42 }, (_, index) => ({
      timestamp: asOf - (42 - index) * HOUR,
      quote_volume_24h: 100 + index,
    }));
    history.push({
      timestamp: asOf + HOUR,
      quote_volume_24h: 99_999_999,
    });

    const result = calculateLiquidityFeature({
      symbol: "BTCUSDT",
      as_of: asOf,
      source_timestamp: asOf,
      quote_volume_24h: 200,
      sample_count_24h: 24,
      volume_source: "QUOTE_VOLUME",
      history,
    });

    expect(result.volume_percentile).toBe(100);
    expect(result.liquidity_score).toBe(100);
    expect(result.status).toBe("STRONG");
    expect(result.future_history_points_ignored).toBe(1);
    expect(result.pit_safe).toBe(true);
  });

  it("blocks liquidity until both 24h bars and percentile history exist", () => {
    const result = calculateLiquidityFeature({
      symbol: "ETHUSDT",
      as_of: 2_000_000,
      quote_volume_24h: 100,
      sample_count_24h: 12,
      volume_source: "QUOTE_VOLUME",
      history: [],
    });

    expect(result.status).toBe("BLOCKED");
    expect(result.volume_percentile).toBeNull();
    expect(result.liquidity_score).toBeNull();
  });

  it("computes breadth ratios and ranks top universe by contemporaneous volume", () => {
    const asOf = 2_000_000;
    const members = [
      member("A", 0.02, 500),
      member("B", 0.015, 400),
      member("C", 0.01, 300),
      member("D", 0.008, 200),
      member("E", -0.01, 100),
      member("F", -0.008, 50),
      member("FUTURE", 0.5, 9_999, asOf + HOUR),
    ];

    const result = calculateMarketBreadthFeature({
      as_of: asOf,
      members,
      top_universe_size: 3,
      minimum_members: 5,
    });

    expect(result.advancing_ratio).toBeCloseTo(4 / 6, 4);
    expect(result.declining_ratio).toBeCloseTo(2 / 6, 4);
    expect(result.flat_ratio).toBe(0);
    expect(result.valid_symbols).toBe(6);
    expect(result.top_universe_symbols).toEqual(["A", "B", "C"]);
    expect(result.top_universe_strength).toBeCloseTo(0.015, 4);
    expect(result.direction).toBe("UP");
    expect(result.status).toBe("STRONG");
    expect(result.future_member_points_ignored).toBe(1);
    expect(result.pit_safe).toBe(true);
  });

  it("keeps price breadth usable when one member lacks volume ranking data", () => {
    const result = calculateMarketBreadthFeature({
      as_of: 2_000_000,
      members: [
        member("A", 0.01, 100),
        member("B", 0.01, null),
        member("C", -0.01, 50),
      ],
      top_universe_size: 2,
      minimum_members: 3,
    });

    expect(result.valid_symbols).toBe(3);
    expect(result.top_universe_symbols).toEqual(["A", "C"]);
    expect(result.status).not.toBe("BLOCKED");
  });

  it("returns BLOCKED rather than inventing breadth when coverage is insufficient", () => {
    const result = calculateMarketBreadthFeature({
      as_of: 2_000_000,
      members: [member("A", 0.01, 100)],
      minimum_members: 3,
    });

    expect(result.status).toBe("BLOCKED");
    expect(result.breadth_score).toBeNull();
    expect(result.direction).toBe("UP");
  });
});

function candle(index: number, overrides: Partial<Candle> = {}): Candle {
  const closeTime = index * HOUR + HOUR - 1;
  return {
    openTime: index * HOUR,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    quoteVolume: 1,
    closeTime,
    ...overrides,
  };
}

function member(
  symbol: string,
  priceReturn: number,
  quoteVolume: number | null,
  sourceTimestamp = 2_000_000,
) {
  return {
    symbol,
    price_return_24h: priceReturn,
    quote_volume_24h: quoteVolume,
    source_timestamp: sourceTimestamp,
  };
}
