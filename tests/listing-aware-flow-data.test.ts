import { describe, expect, it } from "vitest";
import {
  classifyGapsAcrossIntervals,
  classifyListingAdjustedGaps,
  classifyListingRecord,
  evaluateFeatureWindowCompleteness,
  listingAdjustedIntervals,
  listingAdjustedWindow,
  mergeValidatedFlowRows,
  sha256Json,
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

describe("listing-aware historical flow gate", () => {
  it("classifies a pre-listing month without assigning expected minutes", () => {
    const result = listingAdjustedWindow({
      monthStart: 0,
      monthEndExclusive: 31 * 60_000,
      listingTime: 31 * 60_000,
      researchStart: 0,
      researchEndExclusive: 31 * 60_000,
    });
    expect(result.kind).toBe("NOT_LISTED");
    expect(result.listingAdjustedExpectedMinutes).toBe(0);
  });

  it("starts the listing-month denominator at the actual listing minute", () => {
    const result = listingAdjustedWindow({
      monthStart: 0,
      monthEndExclusive: 10 * 60_000,
      listingTime: 4 * 60_000,
      researchStart: 0,
      researchEndExclusive: 10 * 60_000,
    });
    expect(result.kind).toBe("PARTIAL_LISTING_MONTH");
    expect(result.eligibleStart).toBe(4 * 60_000);
    expect(result.listingAdjustedExpectedMinutes).toBe(6);
  });

  it("deduplicates identical monthly and daily minutes with monthly priority", () => {
    const result = mergeValidatedFlowRows(
      { sourceType: "MONTHLY", sourceKey: "BTCUSDT:2025-01", rows: [row(1), row(2)] },
      { sourceType: "DAILY", sourceKey: "BTCUSDT:2025-01-02", rows: [row(2), row(3)] },
    );
    expect(result.rows.map((item) => item.openTime)).toEqual([60_000, 120_000, 180_000]);
    expect(result.deduplicatedMinutes).toBe(1);
    expect(result.conflicts).toHaveLength(0);
  });

  it("records a monthly/daily conflict and excludes the ambiguous minute", () => {
    const result = mergeValidatedFlowRows(
      { sourceType: "MONTHLY", sourceKey: "BTCUSDT:2025-01", rows: [row(1)] },
      { sourceType: "DAILY", sourceKey: "BTCUSDT:2025-01-01", rows: [row(1, { close: 101 })] },
    );
    expect(result.rows).toHaveLength(0);
    expect(result.conflicts[0]?.fields).toContain("close");
  });

  it("classifies daily-only rows as available rather than synthetic fill", () => {
    const result = mergeValidatedFlowRows(
      { sourceType: "MONTHLY", sourceKey: "missing", rows: [] },
      { sourceType: "DAILY", sourceKey: "BTCUSDT:2025-01-01", rows: [row(1)] },
    );
    expect(result.rows).toHaveLength(1);
    expect(classifyListingRecord({
      window: {
        kind: "EXPECTED_COMPLETE",
        calendarStart: 0,
        calendarEndExclusive: 120_000,
        eligibleStart: 0,
        eligibleEndExclusive: 120_000,
        calendarExpectedMinutes: 2,
        listingAdjustedExpectedMinutes: 2,
      },
      monthlyAvailable: false,
      mergedAvailableMinutes: result.rows.length,
      sourceConflict: false,
    })).toBe("AVAILABLE_PARTIAL");
  });

  it("buckets listing-adjusted gap runs by missing-minute span", () => {
    const result = classifyListingAdjustedGaps([row(0), row(2), row(8), row(70)], 0, 80 * 60_000);
    expect(result.byBucket.single_minute.gapRuns).toBe(1);
    expect(result.byBucket.two_to_five_minutes.gapRuns).toBe(1);
    expect(result.byBucket.six_to_sixty_minutes.gapRuns).toBe(1);
    expect(result.byBucket.over_sixty_minutes.gapRuns).toBe(1);
  });

  it("rejects a feature observation when any required minute is missing", () => {
    const result = evaluateFeatureWindowCompleteness([0, 60_000, 180_000], 0, 4 * 60_000);
    expect(result.complete).toBe(false);
    expect(result.missingMinutes).toBe(1);
  });

  it("uses disjoint market intervals without treating the inactive interval as a gap", () => {
    const window = listingAdjustedIntervals({
      monthStart: 0,
      monthEndExclusive: 8 * 60_000,
      intervals: [
        { startTime: 0, endTimeExclusive: 3 * 60_000, source: "old" },
        { startTime: 5 * 60_000, endTimeExclusive: 7 * 60_000, source: "relisted" },
      ],
      researchStart: 0,
      researchEndExclusive: 8 * 60_000,
    });
    expect(window.listingAdjustedExpectedMinutes).toBe(5);
    expect(classifyGapsAcrossIntervals([row(0), row(1), row(2), row(5), row(6)], window.eligibleIntervals).totalMissingMinutes).toBe(0);
  });

  it("produces a deterministic coverage-matrix hash independent of object insertion order", () => {
    expect(sha256Json({ b: 2, a: 1 })).toBe(sha256Json({ a: 1, b: 2 }));
  });
});
