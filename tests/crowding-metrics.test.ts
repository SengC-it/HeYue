import { describe, expect, it } from "vitest";
import { parseBinanceMetricsCsv } from "../lib/crowding";

const header = "create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio";

function row(timestamp: string, overrides: string[] = []): string {
  return [timestamp, "BTCUSDT", "100", "100000", "1.2", "1.4", "1.1", "0.9", ...overrides].join(",");
}

describe("Binance Futures metrics parser", () => {
  it("parses the official daily metrics schema and maps positioning fields", () => {
    const result = parseBinanceMetricsCsv(
      [header, row("2026-08-09 00:00:00"), row("2026-08-09 00:05:00")].join("\n"),
      { expectedSymbol: "BTCUSDT" },
    );

    expect(result.schema.delimiter).toBe("COMMA");
    expect(result.schema.missingFields).toEqual([]);
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]).toMatchObject({
      topTraderAccountRatio: 1.2,
      topTraderPositionRatio: 1.4,
      globalAccountRatio: 1.1,
      takerLongShortRatio: 0.9,
    });
    expect(result.issues).toEqual([]);
  });

  it("accepts the tab-delimited representation used in the official schema example", () => {
    const tabHeader = header.replaceAll(",", "\t");
    const tabRow = row("2026-08-09 00:00:00").replaceAll(",", "\t");
    const result = parseBinanceMetricsCsv([tabHeader, tabRow].join("\n"));

    expect(result.schema.delimiter).toBe("TAB");
    expect(result.observations).toHaveLength(1);
  });

  it("rejects missing fields, zero ratios, invalid OI, and duplicate timestamps", () => {
    const missingFieldHeader = header.replace(",count_long_short_ratio", "");
    const invalid = row("2026-08-09 00:00:00").replace(",1.1,0.9", ",0,0.9");
    const result = parseBinanceMetricsCsv(
      [missingFieldHeader, invalid, invalid].join("\n"),
      { expectedSymbol: "BTCUSDT" },
    );

    expect(result.observations).toHaveLength(0);
    expect(result.issues).toContain("SCHEMA_MISSING_REQUIRED_FIELD");
  });

  it("rejects non-five-minute timestamps and symbol mismatches", () => {
    const result = parseBinanceMetricsCsv(
      [header, row("2026-08-09 00:01:00").replace("BTCUSDT", "ETHUSDT")].join("\n"),
      { expectedSymbol: "BTCUSDT" },
    );

    expect(result.observations).toHaveLength(0);
    expect(result.issues).toEqual(expect.arrayContaining(["INVALID_TIMESTAMP:2", "SYMBOL_MISMATCH:2"]));
  });
});
