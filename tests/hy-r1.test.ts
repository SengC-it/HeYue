import { describe, expect, it, vi } from "vitest";
import { parseKline } from "../lib/binance/public-client";
import { buildDynamicUniverseByTimestamp } from "../lib/backtest/engine";
import { buildValidationUniverseMetadata } from "../lib/backtest/validation-metadata";
import { quoteVolumeForCandle, volumeSourceForDatasets } from "../lib/backtest/volume";
import { getServerConfig, readHyEnv } from "../lib/config";
import { emptySignalMessage, getScannerHealth, getStrategyObservationHealth } from "../lib/dashboard/health";
import type { HistoricalDataset } from "../lib/backtest/types";
import type { Candle, Instrument } from "../lib/core/types";

describe("HY-R1 configuration compatibility", () => {
  it("uses HY over a conflicting legacy CS value", () => {
    const config = getServerConfig({
      HY_SUPABASE_URL: "https://heyue.example.com",
      HY_SUPABASE_SERVICE_ROLE_KEY: "service-value",
      HY_TOP_SYMBOLS: "10",
      CS_TOP_SYMBOLS: "100",
    });

    expect(config.HY_TOP_SYMBOLS).toBe(10);
  });

  it("reads a legacy CS value only through the compatibility reader", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const value = readHyEnv("HY_TOP_SYMBOLS", { CS_TOP_SYMBOLS: "10" });

    expect(value).toBe("10");
    expect(warning).toHaveBeenCalledWith("legacy CS_* configuration detected");
    warning.mockRestore();
  });

  it("does not use a BCA value as a HeYue fallback and never logs a secret", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readHyEnv("HY_TOP_SYMBOLS", { BCA_TOP_SYMBOLS: "10" })).toBeUndefined();
    readHyEnv("HY_CRON_SECRET", { CS_CRON_SECRET: "do-not-print-this" });

    expect(warning.mock.calls.flat().join(" ")).not.toContain("do-not-print-this");
    warning.mockRestore();
  });
});

describe("historical quote volume and validation metadata", () => {
  it("parses Binance quote asset volume from a kline", () => {
    const candle = parseKline([1_000, "99", "101", "98", "100", "2", 1_899, "1234.5"]);
    expect(candle.quoteVolume).toBe(1234.5);
  });

  it("ranks a historical dynamic universe by quote volume first", () => {
    const timestamp = 1_800_000;
    const first = dataset("FIRST", [candle(0, 100, 1_000, 10), candle(1, 100, 1_000, 10)]);
    const second = dataset("SECOND", [candle(0, 100, 1, 10_000), candle(1, 100, 1, 10_000)]);
    const universe = buildDynamicUniverseByTimestamp([first, second], [timestamp], 1, 1);

    expect([...universe.get(timestamp)!]).toEqual(["SECOND"]);
    expect(quoteVolumeForCandle(first.candles["15m"][0])).toBe(10);
  });

  it("marks legacy and mixed cache volume sources explicitly", () => {
    const legacy = dataset("LEGACY", [candle(0, 100, 10, undefined)]);
    const modern = dataset("MODERN", [candle(0, 100, 10, 1_000)]);

    expect(volumeSourceForDatasets([legacy.candles["15m"]])).toBe("ESTIMATED_CLOSE_X_BASE_VOLUME");
    expect(volumeSourceForDatasets([legacy.candles["15m"], modern.candles["15m"]])).toBe("MIXED_WITH_FALLBACK");
    expect(buildValidationUniverseMetadata({
      requestedSymbols: ["LEGACY"],
      candidatePoolSize: 1,
      dynamicUniverseSize: 10,
      lookbackHours: 24,
      datasets: [legacy],
    })).toMatchObject({
      universePolicy: "FIXED_COHORT_DYNAMIC_TOP10",
      candidatePoolSize: 1,
      dynamicUniverseSize: 10,
      lookbackHours: 24,
      volumeSource: "ESTIMATED_CLOSE_X_BASE_VOLUME",
      productionParityLevel: "BOUNDED_COHORT",
    });
  });

  it("only classifies a genuinely complete historical universe as FULL", () => {
    const metadata = buildValidationUniverseMetadata({
      requestedSymbols: [],
      candidatePoolSize: 100,
      dynamicUniverseSize: 10,
      lookbackHours: 24,
      datasets: [dataset("FULL", [candle(0, 100, 10, 1_000)])],
      historicalUniverseComplete: true,
    });

    expect(metadata.universePolicy).toBe("FULL_UNIVERSE_DYNAMIC_TOP10");
    expect(metadata.productionParityLevel).toBe("FULL");
  });
});

describe("dashboard health split", () => {
  const now = Date.parse("2026-09-03T00:00:00.000Z");

  it("distinguishes healthy, stale, partial, and failed scanners", () => {
    expect(getScannerHealth({ status: "COMPLETED", started_at: new Date(now - 10 * 60_000).toISOString() }, now).status).toBe("HEALTHY");
    expect(getScannerHealth({ status: "COMPLETED", started_at: new Date(now - 40 * 60_000).toISOString() }, now).status).toBe("WARNING");
    expect(getScannerHealth({ status: "PARTIAL", started_at: new Date(now - 10 * 60_000).toISOString() }, now).status).toBe("WARNING");
    expect(getScannerHealth({ status: "FAILED", started_at: new Date(now - 10 * 60_000).toISOString() }, now).status).toBe("FAILED");
  });

  it("marks a healthy scanner with no week-old samples as STARVED", () => {
    const health = getStrategyObservationHealth({
      createdAt: new Date(now - 8 * 24 * 3_600_000).toISOString(),
      hasQualifiedSignal: false,
      hasForwardSample: false,
      starvationHours: 168,
    }, now);

    expect(health.status).toBe("STARVED");
    expect(health.tone).toBe("warning");
    expect(emptySignalMessage(getScannerHealth({ status: "COMPLETED", started_at: new Date(now - 10 * 60_000).toISOString() }, now), health).title)
      .toContain("尚未积累新的前向信号样本");
  });

  it("keeps forward samples separate from signal starvation", () => {
    expect(getStrategyObservationHealth({
      createdAt: new Date(now - 30 * 24 * 3_600_000).toISOString(),
      hasQualifiedSignal: false,
      hasForwardSample: true,
      starvationHours: 168,
    }, now).status).toBe("HAS_FORWARD_SAMPLE");
  });
});

function dataset(symbol: string, candles: Candle[]): HistoricalDataset {
  const instrument: Instrument = {
    symbol,
    baseAsset: symbol,
    quoteAsset: "USDT",
    contractType: "PERPETUAL",
    status: "TRADING",
    priceTick: 0.1,
    quantityStep: 0.001,
  };
  return { symbol, instrument, candles: { "15m": candles }, fundingRates: [] };
}

function candle(index: number, close: number, volume: number, quoteVolume?: number): Candle {
  const openTime = index * 900_000;
  return {
    openTime,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume,
    ...(quoteVolume === undefined ? {} : { quoteVolume }),
    closeTime: openTime + 899_999,
  };
}
