import { createHash } from "node:crypto";
import { MINUTE_MS } from "./features";
import type { FlowKline } from "./types";

export type ListingWindowKind =
  | "NOT_LISTED"
  | "PARTIAL_LISTING_MONTH"
  | "EXPECTED_COMPLETE"
  | "INVALID";

export type ListingRecordClassification =
  | "NOT_LISTED"
  | "PARTIAL_LISTING_MONTH"
  | "EXPECTED_COMPLETE"
  | "SOURCE_MISSING"
  | "AVAILABLE_COMPLETE"
  | "AVAILABLE_PARTIAL"
  | "INVALID";

export type FlowSourceType = "MONTHLY" | "DAILY";

export interface ListingAdjustedWindow {
  kind: ListingWindowKind;
  calendarStart: number;
  calendarEndExclusive: number;
  eligibleStart: number | null;
  eligibleEndExclusive: number | null;
  calendarExpectedMinutes: number;
  listingAdjustedExpectedMinutes: number;
}

export interface MarketInterval {
  startTime: number;
  endTimeExclusive: number;
  source: string;
}

export interface ListingAdjustedIntervals extends ListingAdjustedWindow {
  eligibleIntervals: MarketInterval[];
}

export interface SourceFlowRows {
  sourceType: FlowSourceType;
  sourceKey: string;
  rows: FlowKline[];
}

export interface SourceConflict {
  timestamp: number;
  fields: string[];
  monthlySourceKey: string;
  dailySourceKey: string;
}

export interface MergedFlowRows {
  rows: FlowKline[];
  deduplicatedMinutes: number;
  intraSourceDuplicateMinutes: number;
  conflicts: SourceConflict[];
}

export type GapBucket = "single_minute" | "two_to_five_minutes" | "six_to_sixty_minutes" | "over_sixty_minutes";

export interface GapRun {
  startTime: number;
  endTimeExclusive: number;
  missingMinutes: number;
  bucket: GapBucket;
}

export interface GapStatistics {
  totalMissingMinutes: number;
  totalGapRuns: number;
  byBucket: Record<GapBucket, { gapRuns: number; missingMinutes: number }>;
  runs: GapRun[];
}

export interface FeatureWindowEligibility {
  complete: boolean;
  expectedMinutes: number;
  availableMinutes: number;
  missingMinutes: number;
}

const COMPARISON_FIELDS: Array<keyof FlowKline> = [
  "open",
  "high",
  "low",
  "close",
  "volume",
  "quoteVolume",
  "numberOfTrades",
  "takerBuyBaseVolume",
  "takerBuyQuoteVolume",
];

function ceilToMinute(timestamp: number): number {
  return Math.ceil(timestamp / MINUTE_MS) * MINUTE_MS;
}

function expectedMinutes(startTime: number, endTimeExclusive: number): number {
  return endTimeExclusive <= startTime ? 0 : Math.ceil((endTimeExclusive - startTime) / MINUTE_MS);
}

export function listingAdjustedWindow(input: {
  monthStart: number;
  monthEndExclusive: number;
  listingTime: number;
  researchStart: number;
  researchEndExclusive: number;
}): ListingAdjustedWindow {
  const calendarStart = Math.max(input.monthStart, input.researchStart);
  const calendarEndExclusive = Math.min(input.monthEndExclusive, input.researchEndExclusive);
  const calendarExpectedMinutes = expectedMinutes(calendarStart, calendarEndExclusive);
  if (!Number.isFinite(input.listingTime)) {
    return {
      kind: "INVALID",
      calendarStart,
      calendarEndExclusive,
      eligibleStart: null,
      eligibleEndExclusive: null,
      calendarExpectedMinutes,
      listingAdjustedExpectedMinutes: 0,
    };
  }
  if (calendarEndExclusive <= calendarStart || input.listingTime >= calendarEndExclusive) {
    return {
      kind: "NOT_LISTED",
      calendarStart,
      calendarEndExclusive,
      eligibleStart: null,
      eligibleEndExclusive: null,
      calendarExpectedMinutes,
      listingAdjustedExpectedMinutes: 0,
    };
  }
  const eligibleStart = Math.max(calendarStart, ceilToMinute(input.listingTime));
  const kind: ListingWindowKind = input.listingTime > calendarStart ? "PARTIAL_LISTING_MONTH" : "EXPECTED_COMPLETE";
  return {
    kind,
    calendarStart,
    calendarEndExclusive,
    eligibleStart,
    eligibleEndExclusive: calendarEndExclusive,
    calendarExpectedMinutes,
    listingAdjustedExpectedMinutes: expectedMinutes(eligibleStart, calendarEndExclusive),
  };
}

export function listingAdjustedIntervals(input: {
  monthStart: number;
  monthEndExclusive: number;
  intervals: MarketInterval[];
  researchStart: number;
  researchEndExclusive: number;
}): ListingAdjustedIntervals {
  const calendarStart = Math.max(input.monthStart, input.researchStart);
  const calendarEndExclusive = Math.min(input.monthEndExclusive, input.researchEndExclusive);
  const calendarExpectedMinutes = expectedMinutes(calendarStart, calendarEndExclusive);
  const eligibleIntervals: MarketInterval[] = [];
  for (const interval of [...input.intervals].sort((left, right) => left.startTime - right.startTime)) {
    const startTime = Math.max(calendarStart, ceilToMinute(interval.startTime));
    const endTimeExclusive = Math.min(calendarEndExclusive, Math.floor(interval.endTimeExclusive / MINUTE_MS) * MINUTE_MS);
    if (endTimeExclusive <= startTime) continue;
    const previous = eligibleIntervals.at(-1);
    if (previous && startTime <= previous.endTimeExclusive) {
      previous.endTimeExclusive = Math.max(previous.endTimeExclusive, endTimeExclusive);
    } else {
      eligibleIntervals.push({ startTime, endTimeExclusive, source: interval.source });
    }
  }
  const listingAdjustedExpectedMinutes = eligibleIntervals.reduce(
    (total, interval) => total + expectedMinutes(interval.startTime, interval.endTimeExclusive),
    0,
  );
  const firstInterval = eligibleIntervals[0];
  if (!firstInterval || calendarEndExclusive <= calendarStart) {
    return {
      kind: "NOT_LISTED",
      calendarStart,
      calendarEndExclusive,
      eligibleStart: null,
      eligibleEndExclusive: null,
      calendarExpectedMinutes,
      listingAdjustedExpectedMinutes: 0,
      eligibleIntervals,
    };
  }
  return {
    kind: firstInterval.startTime > calendarStart ? "PARTIAL_LISTING_MONTH" : "EXPECTED_COMPLETE",
    calendarStart,
    calendarEndExclusive,
    eligibleStart: firstInterval.startTime,
    eligibleEndExclusive: eligibleIntervals.at(-1)!.endTimeExclusive,
    calendarExpectedMinutes,
    listingAdjustedExpectedMinutes,
    eligibleIntervals,
  };
}

export function classifyGapsAcrossIntervals(rows: FlowKline[], intervals: MarketInterval[]): GapStatistics {
  const total = {
    totalMissingMinutes: 0,
    totalGapRuns: 0,
    byBucket: {
      single_minute: { gapRuns: 0, missingMinutes: 0 },
      two_to_five_minutes: { gapRuns: 0, missingMinutes: 0 },
      six_to_sixty_minutes: { gapRuns: 0, missingMinutes: 0 },
      over_sixty_minutes: { gapRuns: 0, missingMinutes: 0 },
    },
    runs: [],
  } as GapStatistics;
  for (const interval of intervals) {
    const gap = classifyListingAdjustedGaps(rows, interval.startTime, interval.endTimeExclusive);
    total.totalMissingMinutes += gap.totalMissingMinutes;
    total.totalGapRuns += gap.totalGapRuns;
    total.runs.push(...gap.runs);
    for (const bucket of Object.keys(total.byBucket) as Array<keyof GapStatistics["byBucket"]>) {
      total.byBucket[bucket]!.gapRuns += gap.byBucket[bucket]!.gapRuns;
      total.byBucket[bucket]!.missingMinutes += gap.byBucket[bucket]!.missingMinutes;
    }
  }
  return total;
}

export function classifyListingRecord(input: {
  window: ListingAdjustedWindow;
  monthlyAvailable: boolean;
  mergedAvailableMinutes: number;
  sourceConflict: boolean;
}): ListingRecordClassification {
  if (input.window.kind === "INVALID" || input.sourceConflict) return "INVALID";
  if (input.window.kind === "NOT_LISTED") return "NOT_LISTED";
  if (input.window.kind === "PARTIAL_LISTING_MONTH") return "PARTIAL_LISTING_MONTH";
  if (!input.monthlyAvailable && input.mergedAvailableMinutes === 0) return "SOURCE_MISSING";
  return input.mergedAvailableMinutes >= input.window.listingAdjustedExpectedMinutes
    ? "AVAILABLE_COMPLETE"
    : "AVAILABLE_PARTIAL";
}

function rowFieldEqual(left: FlowKline, right: FlowKline, field: keyof FlowKline): boolean {
  return left[field] === right[field];
}

function rowsEqual(left: FlowKline, right: FlowKline): { equal: boolean; fields: string[] } {
  const fields = COMPARISON_FIELDS.filter((field) => !rowFieldEqual(left, right, field)).map(String);
  return { equal: fields.length === 0, fields };
}

function indexRows(source: SourceFlowRows): { rows: Map<number, FlowKline>; duplicateMinutes: number } {
  const rows = new Map<number, FlowKline>();
  let duplicateMinutes = 0;
  for (const row of source.rows) {
    if (rows.has(row.openTime)) duplicateMinutes += 1;
    else rows.set(row.openTime, row);
  }
  return { rows, duplicateMinutes };
}

export function mergeValidatedFlowRows(monthly: SourceFlowRows, daily: SourceFlowRows): MergedFlowRows {
  const monthlyIndexed = indexRows(monthly);
  const dailyIndexed = indexRows(daily);
  const timestamps = [...new Set([...monthlyIndexed.rows.keys(), ...dailyIndexed.rows.keys()])].sort((a, b) => a - b);
  const rows: FlowKline[] = [];
  const conflicts: SourceConflict[] = [];
  let deduplicatedMinutes = 0;
  for (const timestamp of timestamps) {
    const monthlyRow = monthlyIndexed.rows.get(timestamp);
    const dailyRow = dailyIndexed.rows.get(timestamp);
    if (monthlyRow && dailyRow) {
      const comparison = rowsEqual(monthlyRow, dailyRow);
      if (!comparison.equal) {
        conflicts.push({
          timestamp,
          fields: comparison.fields,
          monthlySourceKey: monthly.sourceKey,
          dailySourceKey: daily.sourceKey,
        });
        continue;
      }
      deduplicatedMinutes += 1;
      rows.push(monthlyRow);
    } else if (monthlyRow) {
      rows.push(monthlyRow);
    } else if (dailyRow) {
      rows.push(dailyRow);
    }
  }
  return {
    rows,
    deduplicatedMinutes,
    intraSourceDuplicateMinutes: monthlyIndexed.duplicateMinutes + dailyIndexed.duplicateMinutes,
    conflicts,
  };
}

function gapBucket(missingMinutes: number): GapBucket {
  if (missingMinutes === 1) return "single_minute";
  if (missingMinutes <= 5) return "two_to_five_minutes";
  if (missingMinutes <= 60) return "six_to_sixty_minutes";
  return "over_sixty_minutes";
}

export function classifyListingAdjustedGaps(rows: FlowKline[], startTime: number, endTimeExclusive: number): GapStatistics {
  const byBucket: GapStatistics["byBucket"] = {
    single_minute: { gapRuns: 0, missingMinutes: 0 },
    two_to_five_minutes: { gapRuns: 0, missingMinutes: 0 },
    six_to_sixty_minutes: { gapRuns: 0, missingMinutes: 0 },
    over_sixty_minutes: { gapRuns: 0, missingMinutes: 0 },
  };
  const selected = [...new Set(rows
    .filter((row) => row.openTime >= startTime && row.openTime < endTimeExclusive)
    .map((row) => row.openTime))].sort((a, b) => a - b);
  const runs: GapRun[] = [];
  let cursor = ceilToMinute(startTime);
  for (const timestamp of selected) {
    if (timestamp > cursor) {
      const missingMinutes = Math.floor((timestamp - cursor) / MINUTE_MS);
      if (missingMinutes > 0) {
        const bucket = gapBucket(missingMinutes);
        runs.push({ startTime: cursor, endTimeExclusive: timestamp, missingMinutes, bucket });
        byBucket[bucket]!.gapRuns += 1;
        byBucket[bucket]!.missingMinutes += missingMinutes;
      }
    }
    cursor = Math.max(cursor, timestamp + MINUTE_MS);
  }
  if (cursor < endTimeExclusive) {
    const missingMinutes = Math.ceil((endTimeExclusive - cursor) / MINUTE_MS);
    if (missingMinutes > 0) {
      const bucket = gapBucket(missingMinutes);
      runs.push({ startTime: cursor, endTimeExclusive, missingMinutes, bucket });
      byBucket[bucket]!.gapRuns += 1;
      byBucket[bucket]!.missingMinutes += missingMinutes;
    }
  }
  return {
    totalMissingMinutes: runs.reduce((total, run) => total + run.missingMinutes, 0),
    totalGapRuns: runs.length,
    byBucket,
    runs,
  };
}

export function evaluateFeatureWindowCompleteness(
  timestamps: number[],
  startTime: number,
  endTimeExclusive: number,
): FeatureWindowEligibility {
  const expected = expectedMinutes(startTime, endTimeExclusive);
  const available = new Set(timestamps.filter((timestamp) => timestamp >= startTime && timestamp < endTimeExclusive)).size;
  return {
    complete: available === expected,
    expectedMinutes: expected,
    availableMinutes: available,
    missingMinutes: Math.max(0, expected - available),
  };
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
