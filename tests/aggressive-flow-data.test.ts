import { describe, expect, it } from "vitest";
import {
  aggregateClosedFlow,
  calculateFlowImbalance,
  deriveTakerSellBaseVolume,
  deriveTakerSellQuoteVolume,
  parseBinanceKlineCsv,
  pitSafeClosedRows,
  validateMinuteSequence,
} from "../lib/aggressive-flow";
import type { FlowKline } from "../lib/aggressive-flow";

function row(index: number, overrides: Partial<FlowKline> = {}): FlowKline {
  const openTime = index * 60_000;
  return {
    openTime,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
    closeTime: openTime + 59_999,
    quoteVolume: 1_000,
    numberOfTrades: 10,
    takerBuyBaseVolume: 6,
    takerBuyQuoteVolume: 600,
    takerSellBaseVolume: 4,
    takerSellQuoteVolume: 400,
    flowImbalance: 0.2,
    ...overrides,
  };
}

describe("historical aggressive-flow data foundation", () => {
  it("derives taker sell base and quote volumes without clamping", () => {
    expect(deriveTakerSellBaseVolume(10, 6)).toBe(4);
    expect(deriveTakerSellQuoteVolume(1_000, 600)).toBe(400);
  });

  it("calculates the frozen flow imbalance", () => {
    expect(calculateFlowImbalance(600, 400)).toBe(0.2);
  });

  it("handles zero-volume windows explicitly", () => {
    expect(calculateFlowImbalance(0, 0)).toBeNull();
    expect(aggregateClosedFlow([row(0, { quoteVolume: 0, takerBuyQuoteVolume: 0, takerSellQuoteVolume: 0, flowImbalance: null })], {
      startTime: 0,
      endTimeExclusive: 60_000,
      asOf: 60_000,
    }).flowImbalance).toBeNull();
  });

  it("detects a taker-buy base or quote value above its total", () => {
    const csv = [
      "open_time,open,high,low,close,volume,close_time,quote_asset_volume,number_of_trades,taker_buy_base_asset_volume,taker_buy_quote_asset_volume,ignore",
      "0,100,101,99,100,10,59999,1000,10,11,1001,0",
    ].join("\n");
    const parsed = parseBinanceKlineCsv(csv);
    expect(parsed.invalidRowCount).toBe(1);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.errors[0]).toContain("TAKER_BUY_BASE_EXCEEDS_TOTAL");
  });

  it("detects duplicate timestamps and missing minutes", () => {
    const result = validateMinuteSequence([row(0), row(0), row(2)], 0, 3 * 60_000);
    expect(result.duplicateTimestampCount).toBe(1);
    expect(result.gapCount).toBe(1);
    expect(result.availableMinutes).toBe(2);
  });

  it("detects out-of-order timestamps", () => {
    const result = validateMinuteSequence([row(1), row(0)], 0, 2 * 60_000);
    expect(result.outOfOrderCount).toBe(1);
  });

  it("excludes an unfinished bar from the PIT-safe window", () => {
    const rows = [row(0), row(1)];
    expect(pitSafeClosedRows(rows, 60_000)).toEqual([rows[0]]);
  });

  it("uses an inclusive start and exclusive end for aggregation boundaries", () => {
    const result = aggregateClosedFlow([row(0), row(1), row(2)], {
      startTime: 60_000,
      endTimeExclusive: 180_000,
      asOf: 180_000,
    });
    expect(result.rowCount).toBe(2);
    expect(result.buyQuoteVolume).toBe(1_200);
  });

  it("excludes a partial candle even when its open time is in the window", () => {
    const result = aggregateClosedFlow([row(0), row(1)], {
      startTime: 0,
      endTimeExclusive: 120_000,
      asOf: 59_999,
    });
    expect(result.rowCount).toBe(1);
  });

  it("parses Binance kline fields deterministically", () => {
    const csv = [
      "open_time,open,high,low,close,volume,close_time,quote_asset_volume,number_of_trades,taker_buy_base_asset_volume,taker_buy_quote_asset_volume,ignore",
      "0,100,101,99,100,10,59999,1000,10,6,600,0",
    ].join("\n");
    const first = parseBinanceKlineCsv(csv);
    const second = parseBinanceKlineCsv(csv);
    expect(first).toEqual(second);
    expect(first.rows[0]?.takerSellQuoteVolume).toBe(400);
    expect(first.rows[0]?.flowImbalance).toBe(0.2);
  });

  it("rejects inconsistent OHLC rows instead of silently dropping their quality status", () => {
    const csv = [
      "0,100,99,98,100,10,59999,1000,10,6,600,0",
    ].join("\n");
    const parsed = parseBinanceKlineCsv(csv);
    expect(parsed.invalidRowCount).toBe(1);
    expect(parsed.errors[0]).toContain("INVALID_OHLC");
  });
});
