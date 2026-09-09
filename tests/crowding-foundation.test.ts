import { describe, expect, it } from "vitest";

import {
  CROWDING_RAW_FIELD_MAPPING,
  CROWDING_ROLLING_WINDOW_OBSERVATIONS,
  FROZEN_CROWDING_CANDIDATES,
  PUMP_OLD_DELISTING,
  PUMP_OLD_LISTING,
  PUMP_RELISTING,
  analyzeTimestampSequence,
  derivePITSafePrimitives,
  expected5mTimestamps,
  hasMetricsSchemaDrift,
  lifecycleIdAtTimestamp,
  lifecycleIntervalsForSymbol,
  pitAvailableAt,
  rollingPercentilePIT,
  rollingPercentilesPIT,
  sha256Json,
  validateRatioConsistency,
} from "../lib/crowding";

describe("HY-R5.4B crowding foundation contracts", () => {
  it("keeps position, account, global, and taker ratios distinct", () => {
    expect(CROWDING_RAW_FIELD_MAPPING.find((field) => field.researchFeature === "P1_TOP_TRADER_POSITION_RATIO")?.rawField)
      .toBe("sum_toptrader_long_short_ratio");
    expect(CROWDING_RAW_FIELD_MAPPING.find((field) => field.researchFeature === "P2_TOP_TRADER_ACCOUNT_RATIO")?.rawField)
      .toBe("count_toptrader_long_short_ratio");
    expect(CROWDING_RAW_FIELD_MAPPING.find((field) => field.researchFeature === "P3_GLOBAL_ACCOUNT_RATIO")?.rawField)
      .toBe("count_long_short_ratio");
    expect(CROWDING_RAW_FIELD_MAPPING.find((field) => field.researchFeature === "EXCLUDED_TAKER_RATIO")?.normalizedField)
      .toBeNull();
  });

  it("identifies an exact schema and rejects schema drift", () => {
    const fields = CROWDING_RAW_FIELD_MAPPING.map((field) => field.rawField);
    expect(hasMetricsSchemaDrift(fields)).toBe(false);
    expect(hasMetricsSchemaDrift([...fields, "unexpected_field"])).toBe(true);
    expect(hasMetricsSchemaDrift(fields.filter((field) => field !== "count_long_short_ratio"))).toBe(true);
  });

  it("creates listing-aware expected observations and excludes pre-listing time", () => {
    const intervals = lifecycleIntervalsForSymbol(
      { symbol: "TESTUSDT", onboardDate: Date.parse("2024-08-09T00:07:00.000Z"), deliveryDate: Date.parse("2024-08-09T00:27:00.000Z") },
      "exchangeInfo",
    );
    const expected = expected5mTimestamps(
      intervals,
      Date.parse("2024-08-09T00:00:00.000Z"),
      Date.parse("2024-08-09T00:30:00.000Z"),
    );
    expect(expected.map((timestamp) => new Date(timestamp).toISOString())).toEqual([
      "2024-08-09T00:10:00.000Z",
      "2024-08-09T00:15:00.000Z",
      "2024-08-09T00:20:00.000Z",
      "2024-08-09T00:25:00.000Z",
    ]);
  });

  it("isolates the PUMPUSDT old and relaunch lifecycles", () => {
    const intervals = lifecycleIntervalsForSymbol(
      { symbol: "PUMPUSDT", onboardDate: PUMP_RELISTING, deliveryDate: Date.parse("2026-08-10T00:00:00.000Z") },
      "exchangeInfo",
    );
    expect(intervals).toHaveLength(2);
    expect(lifecycleIdAtTimestamp(PUMP_OLD_LISTING, intervals)).toBe("PUMPUSDT:old-contract");
    expect(lifecycleIdAtTimestamp(PUMP_OLD_DELISTING - 1, intervals)).toBe("PUMPUSDT:old-contract");
    expect(lifecycleIdAtTimestamp((PUMP_OLD_DELISTING + PUMP_RELISTING) / 2, intervals)).toBeNull();
    expect(lifecycleIdAtTimestamp(PUMP_RELISTING, intervals)).toBe("PUMPUSDT:relaunch-contract");
  });

  it("detects duplicates, order breaks, cadence breaks, and missing expected intervals", () => {
    const result = analyzeTimestampSequence(
      [0, 300_000, 300_000, 900_000, 600_000],
      [0, 300_000, 600_000, 900_000],
    );
    expect(result.duplicateCount).toBe(1);
    expect(result.outOfOrderCount).toBe(1);
    expect(result.unexpectedCadenceCount).toBe(2);
    expect(result.missingTimestamps).toEqual([]);
  });

  it("reports missing 5m intervals and gap runs", () => {
    const result = analyzeTimestampSequence(
      [0, 900_000],
      [0, 300_000, 600_000, 900_000, 1_200_000],
    );
    expect(result.missingTimestamps).toEqual([300_000, 600_000, 1_200_000]);
    expect(result.gapRuns).toBe(2);
  });

  it("validates ratio consistency when component fields are present", () => {
    expect(validateRatioConsistency({ longAccount: 0.6, shortAccount: 0.4, longShortRatio: 1.5 })).toEqual({
      status: "PASS",
      issues: [],
    });
    expect(validateRatioConsistency({ longAccount: 0.6, shortAccount: 0.4, longShortRatio: 1.2 })).toMatchObject({
      status: "INVALID",
    });
  });

  it("does not invent ratio components when the archive only exposes ratios", () => {
    expect(validateRatioConsistency({})).toEqual({
      status: "NOT_APPLICABLE",
      issues: ["LONG_SHORT_COMPONENTS_NOT_PRESENT"],
    });
  });

  it("rejects zero denominators and invalid components", () => {
    expect(validateRatioConsistency({ longAccount: 0, shortAccount: 0, longShortRatio: 1 })).toMatchObject({
      status: "INVALID",
      issues: expect.arrayContaining(["ZERO_DENOMINATOR"]),
    });
  });

  it("uses strictly prior history for PIT percentile", () => {
    expect(rollingPercentilePIT([1, 2], 3, 2)).toBe(100);
    expect(rollingPercentilesPIT([1, 2, 3], 2)).toEqual([null, null, 100]);
    expect(CROWDING_ROLLING_WINDOW_OBSERVATIONS).toBe(288);
  });

  it("marks the PIT boundary after the complete 5m bucket", () => {
    const timestamp = Date.parse("2026-08-09T00:00:00.000Z");
    expect(pitAvailableAt(timestamp)).toBe(Date.parse("2026-08-09T00:05:00.000Z"));
  });

  it("derives divergence, transition, and OI interaction without future data", () => {
    const rows = Array.from({ length: CROWDING_ROLLING_WINDOW_OBSERVATIONS + 1 }, (_, index) => ({
      timestamp: index * 300_000,
      topTraderPositionRatio: index === CROWDING_ROLLING_WINDOW_OBSERVATIONS ? 2 : 1,
      topTraderAccountRatio: 1,
      globalAccountRatio: 1,
      openInterest: index === CROWDING_ROLLING_WINDOW_OBSERVATIONS ? 110 : 100,
    }));
    const result = derivePITSafePrimitives(rows);
    const last = result.at(-1)!;
    expect(last.topVsGlobalDivergence).toBeCloseTo(Math.log(2) / 2);
    expect(last.crowdingChange).toBeCloseTo(Math.log(2) / 2);
    expect(last.oiChange).toBeCloseTo(0.1);
    expect(last.c1AbsoluteCrowding).toBe(true);
    expect(last.c2CrowdingDivergence).toBe(true);
    expect(last.c3OiCrowdingBuildup).toBe(true);
    expect(last.featureEligibility).toEqual({ c1: true, c2: true, c3: true, c4: false });
  });

  it("keeps the four frozen candidate definitions unchanged", () => {
    expect(FROZEN_CROWDING_CANDIDATES.map((candidate) => candidate.name)).toEqual([
      "ABSOLUTE_CROWDING",
      "CROWDING_DIVERGENCE",
      "OI_CROWDING_BUILDUP",
      "CROWDING_UNWIND",
    ]);
  });

  it("produces deterministic artifact hashes", () => {
    const artifact = { b: 2, a: ["x", 1] };
    expect(sha256Json(artifact)).toBe(sha256Json({ a: ["x", 1], b: 2 }));
  });
});
