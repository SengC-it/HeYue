import { createHash } from "node:crypto";

import { FIVE_MINUTES_MS } from "./metrics";

export const CROWDING_FOUNDATION_SCHEMA_VERSION = "hy-r5.4b-v1";
export const CROWDING_FEATURE_SPECIFICATION_VERSION = "hy-r5.4b-c1-c4-v1";
export const CROWDING_ROLLING_WINDOW_OBSERVATIONS = 288;

export const CROWDING_RAW_FIELD_MAPPING = [
  {
    rawField: "create_time",
    dataType: "UTC datetime string",
    normalizedField: "timestamp",
    researchFeature: "observation_timestamp",
    semanticMeaning: "Start label of the complete 5m metrics bucket.",
    timestampSemantics: "period_start_label; conservative PIT availability is timestamp + 5m",
  },
  {
    rawField: "symbol",
    dataType: "string",
    normalizedField: "symbol",
    researchFeature: "universe_identity",
    semanticMeaning: "Binance USDⓈ-M futures symbol.",
    timestampSemantics: "not_applicable",
  },
  {
    rawField: "sum_open_interest",
    dataType: "positive decimal",
    normalizedField: "open_interest",
    researchFeature: "P4_OI_CONTEXT",
    semanticMeaning: "Aggregate open interest level.",
    timestampSemantics: "same metrics observation timestamp",
  },
  {
    rawField: "sum_open_interest_value",
    dataType: "positive decimal",
    normalizedField: "open_interest_value",
    researchFeature: "P4_OI_VALUE_CONTEXT",
    semanticMeaning: "Aggregate open-interest notional value.",
    timestampSemantics: "same metrics observation timestamp",
  },
  {
    rawField: "count_toptrader_long_short_ratio",
    dataType: "positive decimal ratio",
    normalizedField: "top_trader_account_ratio",
    researchFeature: "P2_TOP_TRADER_ACCOUNT_RATIO",
    semanticMeaning: "Top-trader account/count long-short ratio.",
    timestampSemantics: "same metrics observation timestamp",
  },
  {
    rawField: "sum_toptrader_long_short_ratio",
    dataType: "positive decimal ratio",
    normalizedField: "top_trader_position_ratio",
    researchFeature: "P1_TOP_TRADER_POSITION_RATIO",
    semanticMeaning: "Top-trader position/sum long-short ratio.",
    timestampSemantics: "same metrics observation timestamp",
  },
  {
    rawField: "count_long_short_ratio",
    dataType: "positive decimal ratio",
    normalizedField: "global_account_ratio",
    researchFeature: "P3_GLOBAL_ACCOUNT_RATIO",
    semanticMeaning: "Global account/count long-short ratio.",
    timestampSemantics: "same metrics observation timestamp",
  },
  {
    rawField: "sum_taker_long_short_vol_ratio",
    dataType: "positive decimal ratio",
    normalizedField: null,
    researchFeature: "EXCLUDED_TAKER_RATIO",
    semanticMeaning: "Taker buy/sell volume ratio; this is flow, not crowding positioning.",
    timestampSemantics: "same metrics observation timestamp",
  },
] as const;

export const FROZEN_CROWDING_CANDIDATES = [
  {
    id: "C1",
    name: "ABSOLUTE_CROWDING",
    definition: "P1/P2/P3 positioning ratio is at a predeclared extreme",
    threshold_method: "rolling PIT percentile, frozen before performance",
  },
  {
    id: "C2",
    name: "CROWDING_DIVERGENCE",
    definition: "Top-Trader positioning direction diverges from global account direction",
    threshold_method: "predeclared sign/percentile bands, no outcome-driven selection",
  },
  {
    id: "C3",
    name: "OI_CROWDING_BUILDUP",
    definition: "OI rises while positioning concentrates toward one side",
    threshold_method: "PIT-safe rolling changes and frozen percentile bands",
  },
  {
    id: "C4",
    name: "CROWDING_UNWIND",
    definition: "Previously extreme positioning mean-reverts at a predeclared rate",
    threshold_method: "PIT-safe rolling recovery threshold, frozen before performance",
  },
] as const;

export const FROZEN_CROWDING_FEATURE_SPECIFICATION = {
  version: CROWDING_FEATURE_SPECIFICATION_VERSION,
  candidates: FROZEN_CROWDING_CANDIDATES,
  rolling_window_observations: CROWDING_ROLLING_WINDOW_OBSERVATIONS,
  rolling_percentile_method: "empirical_count_less_or_equal_over_previous_288_completed_observations",
  rolling_percentile_history: "strictly prior observations within the same lifecycle interval",
  change_lag_observations: 1,
  velocity_lag_observations: 1,
  divergence_definition: "mean(log(P1), log(P2)) - log(P3)",
  oi_change_definition: "current_open_interest / previous_open_interest - 1",
  c1_rule: "P1 or P2 or P3 prior-history percentile <= 5 or >= 95",
  c2_rule: "absolute top-vs-global divergence is at or above its prior-history 95th percentile",
  c3_rule: "C1 is true and OI change is positive; OI is context, not a new standalone alpha",
  c4_rule: "prior C1 is true and current crowding extremity is lower than the prior extremity",
  missing_history_policy: "ineligible; no shortened window, forward fill, zero fill, or interpolation",
  outcome_fields: "none",
} as const;

export interface LifecycleInterval {
  id: string;
  kind: "ACTIVE" | "RELAUNCHED" | "DELISTED";
  startTime: number;
  endTimeExclusive: number;
  source: string;
}

export interface ListingEvidenceLike {
  symbol: string;
  onboardDate: number;
  deliveryDate: number;
}

export const PUMP_OLD_LISTING = Date.parse("2025-04-12T14:30:00.000Z");
export const PUMP_OLD_DELISTING = Date.parse("2025-06-13T09:00:00.000Z");
export const PUMP_RELISTING = Date.parse("2025-07-10T07:30:00.000Z");

export function lifecycleIntervalsForSymbol(
  listing: ListingEvidenceLike,
  exchangeInfoSource: string,
): LifecycleInterval[] {
  if (listing.symbol === "PUMPUSDT") {
    return [
      {
        id: "PUMPUSDT:old-contract",
        kind: "ACTIVE",
        startTime: PUMP_OLD_LISTING,
        endTimeExclusive: PUMP_OLD_DELISTING,
        source: "official archive first observed + Binance rename evidence",
      },
      {
        id: "PUMPUSDT:relaunch-contract",
        kind: "RELAUNCHED",
        startTime: Math.max(listing.onboardDate, PUMP_RELISTING),
        endTimeExclusive: listing.deliveryDate,
        source: exchangeInfoSource,
      },
    ];
  }
  return [{
    id: `${listing.symbol}:active-contract`,
    kind: "ACTIVE",
    startTime: listing.onboardDate,
    endTimeExclusive: listing.deliveryDate,
    source: exchangeInfoSource,
  }];
}

function firstAlignedTimestamp(timestamp: number): number {
  return Math.ceil(timestamp / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
}

export function isTimestampInLifecycle(
  timestamp: number,
  intervals: LifecycleInterval[],
): boolean {
  return intervals.some(
    (interval) => timestamp >= interval.startTime && timestamp < interval.endTimeExclusive,
  );
}

export function lifecycleIdAtTimestamp(
  timestamp: number,
  intervals: LifecycleInterval[],
): string | null {
  return intervals.find(
    (interval) => timestamp >= interval.startTime && timestamp < interval.endTimeExclusive,
  )?.id ?? null;
}

export function pitAvailableAt(timestamp: number): number {
  return timestamp + FIVE_MINUTES_MS;
}

export function metricsSchemaFingerprint(headers: string[]): string {
  return headers.join("\u001f");
}

export function hasMetricsSchemaDrift(headers: string[]): boolean {
  return metricsSchemaFingerprint(headers) !== metricsSchemaFingerprint(
    CROWDING_RAW_FIELD_MAPPING.map((field) => field.rawField),
  );
}

export interface TimestampSequenceIssues {
  duplicateCount: number;
  outOfOrderCount: number;
  unexpectedCadenceCount: number;
  missingTimestamps: number[];
  gapRuns: number;
}

export function analyzeTimestampSequence(
  observedTimestamps: number[],
  expectedTimestamps: number[] = [],
): TimestampSequenceIssues {
  const seen = new Set<number>();
  let duplicateCount = 0;
  let outOfOrderCount = 0;
  let unexpectedCadenceCount = 0;
  for (let index = 0; index < observedTimestamps.length; index += 1) {
    const timestamp = observedTimestamps[index]!;
    if (seen.has(timestamp)) duplicateCount += 1;
    seen.add(timestamp);
    const previous = observedTimestamps[index - 1];
    if (previous !== undefined) {
      if (timestamp < previous) outOfOrderCount += 1;
      if (timestamp !== previous && timestamp - previous !== FIVE_MINUTES_MS) unexpectedCadenceCount += 1;
    }
  }
  const observed = new Set(observedTimestamps);
  const missingTimestamps = expectedTimestamps.filter((timestamp) => !observed.has(timestamp));
  let gapRuns = 0;
  for (let index = 0; index < missingTimestamps.length; index += 1) {
    if (index === 0 || missingTimestamps[index]! - missingTimestamps[index - 1]! !== FIVE_MINUTES_MS) gapRuns += 1;
  }
  return {
    duplicateCount,
    outOfOrderCount,
    unexpectedCadenceCount,
    missingTimestamps,
    gapRuns,
  };
}

export function expected5mTimestamps(
  intervals: LifecycleInterval[],
  startTime: number,
  endTimeExclusive: number,
): number[] {
  const timestamps: number[] = [];
  for (const interval of intervals) {
    const start = Math.max(startTime, interval.startTime);
    const end = Math.min(endTimeExclusive, interval.endTimeExclusive);
    for (let timestamp = firstAlignedTimestamp(start); timestamp < end; timestamp += FIVE_MINUTES_MS) {
      timestamps.push(timestamp);
    }
  }
  return timestamps.sort((left, right) => left - right);
}

export interface RatioConsistencyInput {
  longAccount?: number;
  shortAccount?: number;
  longShortRatio?: number;
  tolerance?: number;
}

export interface RatioConsistencyResult {
  status: "PASS" | "NOT_APPLICABLE" | "INVALID";
  issues: string[];
}

export function validateRatioConsistency(input: RatioConsistencyInput): RatioConsistencyResult {
  const hasComponents = input.longAccount !== undefined || input.shortAccount !== undefined;
  if (!hasComponents) return { status: "NOT_APPLICABLE", issues: ["LONG_SHORT_COMPONENTS_NOT_PRESENT"] };
  const tolerance = input.tolerance ?? 0.02;
  const longAccount = input.longAccount ?? Number.NaN;
  const shortAccount = input.shortAccount ?? Number.NaN;
  const ratio = input.longShortRatio ?? Number.NaN;
  const issues: string[] = [];
  if (![longAccount, shortAccount, ratio].every(Number.isFinite)) issues.push("NAN_OR_NON_FINITE");
  if (longAccount < 0 || shortAccount < 0) issues.push("NEGATIVE_ACCOUNT_COMPONENT");
  if (longAccount + shortAccount <= 0) issues.push("ZERO_DENOMINATOR");
  if (Number.isFinite(longAccount) && Number.isFinite(shortAccount) && Math.abs(longAccount + shortAccount - 1) > tolerance) {
    issues.push("ACCOUNT_SUM_MISMATCH");
  }
  if (Number.isFinite(ratio) && shortAccount > 0 && Math.abs(ratio - longAccount / shortAccount) > tolerance) {
    issues.push("RATIO_MISMATCH");
  }
  return { status: issues.length === 0 ? "PASS" : "INVALID", issues };
}

export function rollingPercentilePIT(
  history: number[],
  value: number,
  window = CROWDING_ROLLING_WINDOW_OBSERVATIONS,
): number | null {
  if (!Number.isFinite(value) || history.length < window) return null;
  const prior = history.slice(-window);
  if (!prior.every(Number.isFinite)) return null;
  return prior.filter((candidate) => candidate <= value).length / window * 100;
}

class FenwickTree {
  private readonly values: number[];

  public constructor(size: number) {
    this.values = new Array(size + 1).fill(0);
  }

  public add(index: number, value: number): void {
    for (let cursor = index + 1; cursor < this.values.length; cursor += cursor & -cursor) {
      this.values[cursor] = (this.values[cursor] ?? 0) + value;
    }
  }

  public prefix(index: number): number {
    let total = 0;
    for (let cursor = index + 1; cursor > 0; cursor -= cursor & -cursor) {
      total += this.values[cursor] ?? 0;
    }
    return total;
  }
}

export function rollingPercentilesPIT(
  values: number[],
  window = CROWDING_ROLLING_WINDOW_OBSERVATIONS,
): Array<number | null> {
  const result = new Array<number | null>(values.length).fill(null);
  if (values.length === 0 || window <= 0 || !values.every(Number.isFinite)) return result;
  const sorted = [...new Set(values)].sort((left, right) => left - right);
  const indexByValue = new Map(sorted.map((value, index) => [value, index]));
  const tree = new FenwickTree(sorted.length);
  for (let index = 0; index < values.length; index += 1) {
    if (index >= window) {
      const currentIndex = indexByValue.get(values[index]!);
      if (currentIndex !== undefined) result[index] = tree.prefix(currentIndex) / window * 100;
    }
    const valueIndex = indexByValue.get(values[index]!);
    if (valueIndex === undefined) return result;
    tree.add(valueIndex, 1);
    if (index >= window) {
      const expiredIndex = indexByValue.get(values[index - window]!);
      if (expiredIndex !== undefined) tree.add(expiredIndex, -1);
    }
  }
  return result;
}

export interface PrimitiveInputRow {
  timestamp: number;
  topTraderPositionRatio: number;
  topTraderAccountRatio: number;
  globalAccountRatio: number;
  openInterest: number;
}

export interface PrimitiveOutputRow {
  topTraderPositionPercentile: number | null;
  topTraderAccountPercentile: number | null;
  globalAccountPercentile: number | null;
  topVsGlobalDivergence: number;
  topVsGlobalDivergencePercentile: number | null;
  crowdingChange: number | null;
  crowdingVelocity: number | null;
  oiChange: number | null;
  c1AbsoluteCrowding: boolean;
  c2CrowdingDivergence: boolean;
  c3OiCrowdingBuildup: boolean;
  c4CrowdingUnwind: boolean;
  featureEligibility: {
    c1: boolean;
    c2: boolean;
    c3: boolean;
    c4: boolean;
  };
}

function finiteLog(value: number): number {
  return Math.log(value);
}

export function derivePITSafePrimitives(
  rows: PrimitiveInputRow[],
  window = CROWDING_ROLLING_WINDOW_OBSERVATIONS,
): PrimitiveOutputRow[] {
  const position = rows.map((row) => finiteLog(row.topTraderPositionRatio));
  const account = rows.map((row) => finiteLog(row.topTraderAccountRatio));
  const global = rows.map((row) => finiteLog(row.globalAccountRatio));
  const composite = rows.map((_, index) => (position[index]! + account[index]!) / 2);
  const divergence = rows.map((_, index) => composite[index]! - global[index]!);
  const absoluteDivergence = divergence.map(Math.abs);
  const positionPercentile = rollingPercentilesPIT(position, window);
  const accountPercentile = rollingPercentilesPIT(account, window);
  const globalPercentile = rollingPercentilesPIT(global, window);
  const divergencePercentile = rollingPercentilesPIT(absoluteDivergence, window);
  return rows.map((row, index) => {
    const p1 = positionPercentile[index];
    const p2 = accountPercentile[index];
    const p3 = globalPercentile[index];
    const c1Eligible = p1 !== null && p2 !== null && p3 !== null;
    const c1 = c1Eligible && [p1, p2, p3].some((value) => value <= 5 || value >= 95);
    const c2Eligible = divergencePercentile[index] !== null;
    const c2 = c2Eligible && divergencePercentile[index]! >= 95;
    const crowdingChange = index === 0 ? null : composite[index]! - composite[index - 1]!;
    const crowdingVelocity = index < 2 || crowdingChange === null
      ? null
      : crowdingChange - (composite[index - 1]! - composite[index - 2]!);
    const oiChange = index === 0
      ? null
      : row.openInterest / rows[index - 1]!.openInterest - 1;
    const oiReady = oiChange !== null;
    const priorExtremity = index === 0 ? null : extremityAt(index - 1, positionPercentile, accountPercentile, globalPercentile);
    const currentExtremity = extremityAt(index, positionPercentile, accountPercentile, globalPercentile);
    const c4Eligible = c1Eligible && priorExtremity !== null && currentExtremity !== null;
    const c4 = c4Eligible && Boolean(extremityAt(index - 1, positionPercentile, accountPercentile, globalPercentile) !== null)
      && Boolean(currentExtremity! < priorExtremity!);
    return {
      topTraderPositionPercentile: p1 ?? null,
      topTraderAccountPercentile: p2 ?? null,
      globalAccountPercentile: p3 ?? null,
      topVsGlobalDivergence: divergence[index]!,
      topVsGlobalDivergencePercentile: divergencePercentile[index] ?? null,
      crowdingChange,
      crowdingVelocity,
      oiChange,
      c1AbsoluteCrowding: c1,
      c2CrowdingDivergence: c2,
      c3OiCrowdingBuildup: Boolean(c1 && oiReady && oiChange! > 0),
      c4CrowdingUnwind: Boolean(c4),
      featureEligibility: {
        c1: c1Eligible,
        c2: c2Eligible,
        c3: Boolean(c1Eligible && oiReady),
        c4: c4Eligible,
      },
    };
  });
}

function extremityAt(
  index: number,
  position: Array<number | null>,
  account: Array<number | null>,
  global: Array<number | null>,
): number | null {
  const values = [position[index], account[index], global[index]];
  if (!values.every((value): value is number => value !== null)) return null;
  return Math.max(...values.map((value) => Math.abs(value - 50)));
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

export { FIVE_MINUTES_MS };
