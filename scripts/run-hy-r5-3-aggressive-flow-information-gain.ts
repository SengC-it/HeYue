import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  FLOW_HORIZONS,
  R52_FROZEN_FEATURE_SPEC,
  R53_FROZEN_EVALUATION_SPEC,
  RollingHistogram,
  classifyFrozenFlowFeatures,
  holmAdjust,
  matchNearestWithoutReplacement,
  multiPairedMeanInference,
  pairedMeanInference,
  sha256Json,
  summarizeNumeric,
} from "../lib/aggressive-flow";
import type { FlowHorizon } from "../lib/aggressive-flow";

type JsonRecord = Record<string, unknown>;
type Direction = "BULLISH" | "BEARISH";
type Hypothesis = "H1_CONTINUATION" | "H2_ABSORPTION" | "H3_FLOW_SHOCK";
type VolatilityBucket = "LOW" | "MEDIUM" | "HIGH";
type LiquidityBucket = "LOW" | "MEDIUM" | "HIGH";

const EVALUATION_START = Date.parse("2024-08-09T00:00:00.000Z");
const EVALUATION_END_EXCLUSIVE = Date.parse("2026-08-10T00:00:00.000Z");
const EVALUATION_START_ISO = "2024-08-09T00:00:00.000Z";
const EVALUATION_END_ISO = "2026-08-09T23:59:59.999Z";
const FORMAL_EVENT_END_EXCLUSIVE = EVALUATION_END_EXCLUSIVE - 24 * 60 * 60_000;
const FLOW_BUCKET_MS = 15 * 60_000;
const BASELINE_BUCKETS = 672;
const EXPECTED_UNIVERSE_SIZE = 49;
const EXPECTED_COVERAGE_MATRIX_HASH = "4b063c3394865832e0414a30b5d704632b0ea6288a5eb7e9a692da8aa9fdf595";
const EXPECTED_FEATURE_SPECIFICATION_HASH = "6fa0896d17e4d377fd1cf835ee15791c4d95665c6447b25198737d78f38e9319";
const DATA_DIRECTORY = resolve("data", "hy-r2b-history-24m");
const FLOW_DIRECTORY = resolve("data", "raw", "hy-r5.2-flow");
const LISTING_DIRECTORY = resolve("data", "raw", "hy-r5.2b-flow");
const COVERAGE_MATRIX_PATH = resolve(LISTING_DIRECTORY, "coverage-matrix.json");
const LISTING_EVIDENCE_PATH = resolve(LISTING_DIRECTORY, "listing-evidence.json");
const R52_MANIFEST_PATH = resolve(FLOW_DIRECTORY, "manifest.json");
const R52_REPORT_PATH = resolve("reports", "hy-r5.2b-listing-aware-flow-data-gate.json");
const FREEZE_MANIFEST_PATH = resolve("reports", "hy-r5.3-pre-performance-freeze.json");
const JSON_REPORT_PATH = resolve("reports", "hy-r5.3-aggressive-flow-information-gain.json");
const MARKDOWN_REPORT_PATH = resolve("reports", "hy-r5.3-aggressive-flow-information-gain.md");
const RUNNER_SOURCE_PATHS = [
  "scripts/run-hy-r5-3-aggressive-flow-information-gain.ts",
  "lib/aggressive-flow/information-gain.ts",
  "lib/aggressive-flow/features.ts",
  "lib/aggressive-flow/validation.ts",
  "lib/aggressive-flow/listing-aware.ts",
  "lib/aggressive-flow/index.ts",
] as const;

interface R52MonthlyRecord {
  symbol: string;
  month: string;
  compact_path: string | null;
  download_status: string;
  quality_status: string;
  valid_1m_observations: number;
}

interface R52Manifest {
  schema_version: string;
  evaluation_window: { start: string; end: string };
  universe: string[];
  expected_months: string[];
  records: Record<string, R52MonthlyRecord>;
}

interface R52Report {
  classification: string;
  pit_safe: string;
  data: {
    historical_range_start: string;
    historical_range_end: string;
    universe_count: number;
    universe: string[];
    listing_adjusted_expected_minutes: number;
    valid_flow_minutes: number;
    coverage_matrix_hash: string;
    feature_specification_hash: string;
    original_feature_specification: JsonRecord;
    market_lifecycle_exceptions: JsonRecord[];
  };
}

interface CoverageMonth {
  month: string;
  classification: string;
  quality_status: string;
  listing_adjusted_expected_minutes: number;
  valid_available_minutes: number;
  missing_minutes: number;
  source_conflict_count: number;
}

interface CoverageSymbol {
  symbol: string;
  months: CoverageMonth[];
}

interface CoverageMatrix {
  version: string;
  historical_range: { start: string; end: string };
  symbols: CoverageSymbol[];
  quarter_matrix: { version: string; quarters: JsonRecord[] };
}

interface ExchangeSymbol {
  symbol: string;
  contractType: string;
  status: string;
  onboardDate: number;
  deliveryDate: number;
}

interface ListingEvidence {
  endpoint: string;
  fetched_at: string;
  server_time: number;
  symbols: ExchangeSymbol[];
}

interface HistoricalCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  quoteVolume: number;
  closeTime: number;
}

interface HistoricalDataset {
  symbol: string;
  candles: { "15m": HistoricalCandle[] };
}

interface MarketInterval {
  startTime: number;
  endTimeExclusive: number;
  source: string;
}

interface FlowBucket {
  time: number;
  minuteCount: number;
  open: number;
  high: number;
  low: number;
  close: number;
  buyQuoteVolume: number;
  sellQuoteVolume: number;
  signs: number[];
}

interface CandleArrays {
  candles: HistoricalCandle[];
  byOpenTime: Map<number, number>;
  logSquaredPrefix: Float64Array;
  quoteVolumePrefix: Float64Array;
}

interface MarketContext {
  marketRegime: "UP" | "DOWN" | "RANGE";
  volatilityBucket: VolatilityBucket;
  liquidityBucket: LiquidityBucket;
  return24h: number;
  return7d: number;
  realizedVolatility24h: number;
  quoteVolume24h: number;
}

interface AnalysisPoint {
  time: number;
  matchKey: string;
  symbol: string;
  month: string;
  quarter: string;
  marketRegime: MarketContext["marketRegime"];
  volatilityBucket: VolatilityBucket;
  liquidityBucket: LiquidityBucket;
  candleIndex: number;
  referencePrice: number;
  priceReturn: number;
  flowImbalance: number;
  flowPercentile: number;
  accelerationRatio: number | null;
  persistent: boolean;
  responseThreshold: number;
  extremeBuy: boolean;
  extremeSell: boolean;
  h1Bullish: boolean;
  h1Bearish: boolean;
  h2Bullish: boolean;
  h2Bearish: boolean;
  h3FlowShock: boolean;
  anyEvent: boolean;
}

interface HorizonOutcome {
  futurePrice: number;
  closeReturn: number;
  directionalReturn: number | null;
  maxFavorableMove: number | null;
  maxAdverseMove: number | null;
  realizedVolatility: number;
  largeMove: boolean;
  extremeMove: boolean;
}

type OutcomeBundle = Record<FlowHorizon, HorizonOutcome | null>;

interface PairObservation {
  hypothesis: Hypothesis;
  direction: Direction | null;
  event: AnalysisPoint;
  control: AnalysisPoint;
  distanceMs: number;
  eventOutcome: OutcomeBundle;
  controlOutcome: OutcomeBundle;
}

interface BaselineObservation {
  point: AnalysisPoint;
  direction: Direction;
  outcome: OutcomeBundle;
}

interface PopulationMatch {
  hypothesis: Hypothesis;
  direction: Direction | null;
  eventCount: number;
  pairs: PairObservation[];
  unmatchedCount: number;
  distancesMs: number[];
}

interface SymbolAnalysis {
  flowObservations: number;
  featureEligibleDecisions: number;
  points: AnalysisPoint[];
  populationMatches: PopulationMatch[];
  baselineObservations: BaselineObservation[];
}

interface FrozenInputs {
  report: R52Report;
  manifest: R52Manifest;
  matrix: CoverageMatrix;
  listing: ListingEvidence;
}

const HORIZON_MS: Record<FlowHorizon, number> = {
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function round(value: number | null, digits = 6): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function monthKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

function quarterKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

function seedFor(id: string): number {
  let hash = 5301;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function loadJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function loadFrozenInputs(): Promise<FrozenInputs> {
  const [report, manifest, matrix, listing] = await Promise.all([
    loadJson<R52Report>(R52_REPORT_PATH),
    loadJson<R52Manifest>(R52_MANIFEST_PATH),
    loadJson<CoverageMatrix>(COVERAGE_MATRIX_PATH),
    loadJson<ListingEvidence>(LISTING_EVIDENCE_PATH),
  ]);
  const computedMatrixHash = sha256Json(matrix);
  const computedFeatureHash = sha256Json(report.data.original_feature_specification);
  if (report.classification !== "DATA_FOUNDATION_READY") throw new Error("RESEARCH_INVALID: R5.2B classification is not DATA_FOUNDATION_READY");
  if (report.pit_safe !== "PASS") throw new Error("RESEARCH_INVALID: R5.2B PIT gate is not PASS");
  if (report.data.universe_count !== EXPECTED_UNIVERSE_SIZE || report.data.universe.length !== EXPECTED_UNIVERSE_SIZE) {
    throw new Error("RESEARCH_INVALID: R5.2B universe is not 49/49");
  }
  if (report.data.coverage_matrix_hash !== EXPECTED_COVERAGE_MATRIX_HASH || computedMatrixHash !== EXPECTED_COVERAGE_MATRIX_HASH) {
    throw new Error(`RESEARCH_INVALID: coverage matrix hash mismatch (${computedMatrixHash})`);
  }
  if (report.data.feature_specification_hash !== EXPECTED_FEATURE_SPECIFICATION_HASH || computedFeatureHash !== EXPECTED_FEATURE_SPECIFICATION_HASH) {
    throw new Error(`RESEARCH_INVALID: feature specification hash mismatch (${computedFeatureHash})`);
  }
  if (sha256Json(R52_FROZEN_FEATURE_SPEC) !== EXPECTED_FEATURE_SPECIFICATION_HASH) {
    throw new Error("RESEARCH_INVALID: local R5.2 frozen feature specification does not match the accepted hash");
  }
  if (matrix.symbols.length !== EXPECTED_UNIVERSE_SIZE || matrix.quarter_matrix.quarters.length !== EXPECTED_UNIVERSE_SIZE) {
    throw new Error("RESEARCH_INVALID: coverage matrix dimensions are not 49 symbols");
  }
  const expectedMonths = new Set(manifest.expected_months);
  for (const symbol of matrix.symbols) {
    if (symbol.months.length !== expectedMonths.size) throw new Error(`RESEARCH_INVALID: incomplete month matrix for ${symbol.symbol}`);
    for (const month of symbol.months) {
      if (month.source_conflict_count !== 0 || month.missing_minutes !== 0) {
        throw new Error(`RESEARCH_INVALID: R5.2B source gap/conflict remains for ${symbol.symbol}:${month.month}`);
      }
    }
  }
  if (listing.symbols.length < EXPECTED_UNIVERSE_SIZE) throw new Error("RESEARCH_INVALID: listing evidence does not cover the accepted universe");
  return { report, manifest, matrix, listing };
}

async function runnerSourceHash(): Promise<string> {
  const hash = createHash("sha256");
  for (const sourcePath of RUNNER_SOURCE_PATHS) {
    hash.update(sourcePath);
    hash.update("\0");
    hash.update(await readFile(resolve(sourcePath), "utf8"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function lifecycleIntervals(symbol: string, inputs: FrozenInputs): MarketInterval[] {
  const listing = inputs.listing.symbols.find((item) => item.symbol === symbol);
  if (!listing) throw new Error(`RESEARCH_INVALID: missing listing evidence for ${symbol}`);
  const delivery = listing.deliveryDate > 0 ? Math.min(listing.deliveryDate, EVALUATION_END_EXCLUSIVE) : EVALUATION_END_EXCLUSIVE;
  if (symbol !== "PUMPUSDT") return [{ startTime: listing.onboardDate, endTimeExclusive: delivery, source: "R5.2B frozen exchangeInfo snapshot" }];
  const exception = inputs.report.data.market_lifecycle_exceptions.find((item) => item.symbol === "PUMPUSDT");
  const oldInterval = isRecord(exception?.old_interval) ? exception.old_interval : null;
  const oldStart = typeof oldInterval?.start === "string" ? Date.parse(oldInterval.start) : Number.NaN;
  const oldEnd = typeof oldInterval?.end === "string" ? Date.parse(oldInterval.end) : Number.NaN;
  const relisted = typeof exception?.relisted_at === "string" ? Date.parse(exception.relisted_at) : Number.NaN;
  if (!Number.isFinite(oldStart) || !Number.isFinite(oldEnd) || !Number.isFinite(relisted)) {
    throw new Error("RESEARCH_INVALID: PUMPUSDT lifecycle exception is not frozen and parseable");
  }
  return [
    { startTime: oldStart, endTimeExclusive: oldEnd, source: "R5.2B frozen PUMPUSDT original lifecycle" },
    { startTime: Math.max(listing.onboardDate, relisted), endTimeExclusive: delivery, source: "R5.2B frozen exchangeInfo relisted lifecycle" },
  ];
}

function activeAt(timestamp: number, intervals: MarketInterval[]): boolean {
  return intervals.some((interval) => timestamp >= interval.startTime && timestamp < interval.endTimeExclusive);
}

function flowImbalance(buyQuoteVolume: number, sellQuoteVolume: number): number {
  const total = buyQuoteVolume + sellQuoteVolume;
  return total > 0 ? (buyQuoteVolume - sellQuoteVolume) / total : 0;
}

async function readFlowBuckets(symbol: string, inputs: FrozenInputs): Promise<{ buckets: FlowBucket[]; flowObservations: number }> {
  const intervals = lifecycleIntervals(symbol, inputs);
  const byMonth = inputs.matrix.symbols.find((item) => item.symbol === symbol);
  if (!byMonth) throw new Error(`RESEARCH_INVALID: coverage matrix does not contain ${symbol}`);
  const buckets = new Map<number, FlowBucket>();
  let flowObservations = 0;
  for (const monthRow of byMonth.months) {
    if (monthRow.listing_adjusted_expected_minutes === 0) continue;
    const record = inputs.manifest.records[`${symbol}:${monthRow.month}`];
    if (!record || record.download_status !== "AVAILABLE" || record.compact_path === null) {
      throw new Error(`RESEARCH_INVALID: missing frozen compact flow source for ${symbol}:${monthRow.month}`);
    }
    if (record.valid_1m_observations < monthRow.listing_adjusted_expected_minutes) {
      throw new Error(`RESEARCH_INVALID: frozen flow source is shorter than listing-adjusted coverage for ${symbol}:${monthRow.month}`);
    }
    const content = await readFile(record.compact_path, "utf8");
    let monthFlowObservations = 0;
    for (const line of content.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const value = JSON.parse(line) as JsonRecord;
      const timestamp = finiteNumber(value.timestamp);
      const open = finiteNumber(value.open);
      const high = finiteNumber(value.high);
      const low = finiteNumber(value.low);
      const close = finiteNumber(value.close);
      const quoteVolume = finiteNumber(value.quote_volume);
      const buyQuoteVolume = finiteNumber(value.taker_buy_quote_volume);
      if (timestamp === null || open === null || high === null || low === null || close === null || quoteVolume === null || buyQuoteVolume === null) {
        throw new Error(`RESEARCH_INVALID: malformed frozen compact row in ${symbol}:${monthRow.month}`);
      }
      if (timestamp < EVALUATION_START || timestamp >= EVALUATION_END_EXCLUSIVE || !activeAt(timestamp, intervals)) continue;
      monthFlowObservations += 1;
      const sellQuoteVolume = quoteVolume - buyQuoteVolume;
      if (sellQuoteVolume < 0) throw new Error(`RESEARCH_INVALID: taker sell quote volume is negative for ${symbol}`);
      const bucketTime = Math.floor(timestamp / FLOW_BUCKET_MS) * FLOW_BUCKET_MS;
      const current = buckets.get(bucketTime);
      const sign = buyQuoteVolume > sellQuoteVolume ? 1 : buyQuoteVolume < sellQuoteVolume ? -1 : 0;
      if (!current) {
        buckets.set(bucketTime, {
          time: bucketTime,
          minuteCount: 1,
          open,
          high,
          low,
          close,
          buyQuoteVolume,
          sellQuoteVolume,
          signs: [sign],
        });
      } else {
        current.minuteCount += 1;
        current.high = Math.max(current.high, high);
        current.low = Math.min(current.low, low);
        current.close = close;
        current.buyQuoteVolume += buyQuoteVolume;
        current.sellQuoteVolume += sellQuoteVolume;
        current.signs.push(sign);
      }
      flowObservations += 1;
    }
    if (monthFlowObservations !== monthRow.listing_adjusted_expected_minutes) {
      throw new Error(`RESEARCH_INVALID: active listing-adjusted flow count mismatch for ${symbol}:${monthRow.month}`);
    }
  }
  for (const bucket of buckets.values()) bucket.signs = bucket.signs.slice(-R52_FROZEN_FEATURE_SPEC.persistence_intervals);
  return { buckets: [...buckets.values()].sort((left, right) => left.time - right.time), flowObservations };
}

function buildCandleArrays(candles: HistoricalCandle[]): CandleArrays {
  const byOpenTime = new Map<number, number>();
  const logSquaredPrefix = new Float64Array(candles.length + 1);
  const quoteVolumePrefix = new Float64Array(candles.length + 1);
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]!;
    byOpenTime.set(candle.openTime, index);
    const previous = candles[index - 1];
    const logReturn = previous && previous.close > 0 && candle.close > 0 ? Math.log(candle.close / previous.close) : 0;
    logSquaredPrefix[index + 1] = logSquaredPrefix[index]! + logReturn ** 2;
    quoteVolumePrefix[index + 1] = quoteVolumePrefix[index]! + Math.max(0, candle.quoteVolume);
  }
  return { candles, byOpenTime, logSquaredPrefix, quoteVolumePrefix };
}

function candleContext(arrays: CandleArrays, candleIndex: number): MarketContext | null {
  const candles = arrays.candles;
  if (candleIndex < BASELINE_BUCKETS || candleIndex < 96) return null;
  const current = candles[candleIndex];
  const dayReference = candles[candleIndex - 96];
  const weekReference = candles[candleIndex - BASELINE_BUCKETS];
  if (!current || !dayReference || !weekReference || weekReference.close <= 0 || dayReference.close <= 0) return null;
  const return24h = current.close / dayReference.close - 1;
  const return7d = current.close / weekReference.close - 1;
  const realizedVolatility24h = Math.sqrt(
    arrays.logSquaredPrefix[candleIndex + 1]! - arrays.logSquaredPrefix[candleIndex - 95]!,
  );
  const quoteVolume24h = arrays.quoteVolumePrefix[candleIndex + 1]! - arrays.quoteVolumePrefix[candleIndex - 95]!;
  const marketRegime = return24h >= R53_FROZEN_EVALUATION_SPEC.regime_up_24h_return_minimum
    && return7d >= R53_FROZEN_EVALUATION_SPEC.regime_up_7d_return_minimum
    ? "UP"
    : return24h <= R53_FROZEN_EVALUATION_SPEC.regime_down_24h_return_maximum
      && return7d <= R53_FROZEN_EVALUATION_SPEC.regime_down_7d_return_maximum
      ? "DOWN"
      : "RANGE";
  const volatilityBucket: VolatilityBucket = realizedVolatility24h < R53_FROZEN_EVALUATION_SPEC.volatility_low_maximum_24h_realized
    ? "LOW"
    : realizedVolatility24h < R53_FROZEN_EVALUATION_SPEC.volatility_medium_maximum_24h_realized
      ? "MEDIUM"
      : "HIGH";
  const liquidityBucket: LiquidityBucket = quoteVolume24h < R53_FROZEN_EVALUATION_SPEC.liquidity_low_maximum_24h_quote_volume
    ? "LOW"
    : quoteVolume24h < R53_FROZEN_EVALUATION_SPEC.liquidity_medium_maximum_24h_quote_volume
      ? "MEDIUM"
      : "HIGH";
  return { marketRegime, volatilityBucket, liquidityBucket, return24h, return7d, realizedVolatility24h, quoteVolume24h };
}

interface SeriesPoint extends FlowBucket {
  candleIndex: number;
  priceReturn: number;
}

function completeSeriesSegments(buckets: FlowBucket[], arrays: CandleArrays): SeriesPoint[][] {
  const series: SeriesPoint[] = [];
  for (const bucket of buckets) {
    const candleIndex = arrays.byOpenTime.get(bucket.time);
    const candle = candleIndex === undefined ? undefined : arrays.candles[candleIndex];
    if (candleIndex === undefined || !candle || candle.open <= 0) continue;
    series.push({ ...bucket, candleIndex, priceReturn: candle.close / candle.open - 1 });
  }
  const segments: SeriesPoint[][] = [];
  let current: SeriesPoint[] = [];
  for (const point of series) {
    const previous = current.at(-1);
    const contiguous = previous !== undefined
      && point.time === previous.time + FLOW_BUCKET_MS
      && point.candleIndex === previous.candleIndex + 1
      && point.minuteCount === 15
      && previous.minuteCount === 15;
    if (!contiguous && current.length > 0) {
      segments.push(current);
      current = [];
    }
    if (point.minuteCount === 15) current.push(point);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function buildAnalysisPoints(symbol: string, buckets: FlowBucket[], arrays: CandleArrays): AnalysisPoint[] {
  const points: AnalysisPoint[] = [];
  for (const segment of completeSeriesSegments(buckets, arrays)) {
    if (segment.length <= BASELINE_BUCKETS) continue;
    const flowHistogram = new RollingHistogram(-1, 1, 4_001);
    const absFlowHistogram = new RollingHistogram(0, 1, 2_001);
    const absReturnHistogram = new RollingHistogram(0, 1, 10_001);
    const imbalanceOf = (point: SeriesPoint): number => flowImbalance(point.buyQuoteVolume, point.sellQuoteVolume);
    for (let index = 0; index < BASELINE_BUCKETS; index += 1) {
      const value = imbalanceOf(segment[index]!);
      flowHistogram.add(value);
      absFlowHistogram.add(Math.abs(value));
      absReturnHistogram.add(Math.min(1, Math.abs(segment[index]!.priceReturn)));
    }
    for (let index = BASELINE_BUCKETS; index < segment.length; index += 1) {
      const current = segment[index]!;
      const value = imbalanceOf(current);
      const flowP10 = flowHistogram.quantile(R52_FROZEN_FEATURE_SPEC.extreme_sell_percentile / 100);
      const flowP90 = flowHistogram.quantile(R52_FROZEN_FEATURE_SPEC.extreme_buy_percentile / 100);
      const flowPercentile = flowHistogram.percentileRank(value);
      const medianAbsFlow = absFlowHistogram.quantile(0.5);
      const medianAbsPriceReturn = absReturnHistogram.quantile(0.5);
      if (flowP10 === null || flowP90 === null || flowPercentile === null || medianAbsFlow === null || medianAbsPriceReturn === null) {
        throw new Error("RESEARCH_INVALID: rolling PIT baseline unexpectedly empty");
      }
      const context = candleContext(arrays, current.candleIndex);
      const classification = classifyFrozenFlowFeatures({
        flowImbalance: value,
        flowP10,
        flowP90,
        flowPercentile,
        accelerationRatio: medianAbsFlow > 0 ? Math.abs(value) / medianAbsFlow : null,
        priceReturn: current.priceReturn,
        pitMedianAbsPriceReturn: medianAbsPriceReturn,
        persistenceSigns: current.signs,
        persistenceIntervals: R52_FROZEN_FEATURE_SPEC.persistence_intervals,
        accelerationMinimum: R53_FROZEN_EVALUATION_SPEC.acceleration_ratio_minimum,
      });
      if (context && current.time + FLOW_BUCKET_MS <= FORMAL_EVENT_END_EXCLUSIVE) {
        const decisionTime = current.time + FLOW_BUCKET_MS;
        const matchKey = [
          symbol,
          monthKey(decisionTime),
          context.marketRegime,
          context.volatilityBucket,
          context.liquidityBucket,
        ].join("|");
        points.push({
          time: decisionTime,
          matchKey,
          symbol,
          month: monthKey(decisionTime),
          quarter: quarterKey(decisionTime),
          marketRegime: context.marketRegime,
          volatilityBucket: context.volatilityBucket,
          liquidityBucket: context.liquidityBucket,
          candleIndex: current.candleIndex,
          referencePrice: arrays.candles[current.candleIndex]!.close,
          priceReturn: current.priceReturn,
          flowImbalance: value,
          flowPercentile,
          accelerationRatio: classification.accelerationPass ? Math.abs(value) / Math.max(medianAbsFlow, 1e-12) : null,
          persistent: classification.persistent,
          responseThreshold: classification.responseThreshold,
          extremeBuy: classification.extremeBuy && classification.flowDirection === "BULLISH",
          extremeSell: classification.extremeSell && classification.flowDirection === "BEARISH",
          h1Bullish: classification.h1Bullish,
          h1Bearish: classification.h1Bearish,
          h2Bullish: classification.h2Bullish,
          h2Bearish: classification.h2Bearish,
          h3FlowShock: classification.h3FlowShock,
          anyEvent: classification.h1Bullish || classification.h1Bearish || classification.h2Bullish || classification.h2Bearish || classification.h3FlowShock,
        });
      }
      const outgoing = segment[index - BASELINE_BUCKETS]!;
      flowHistogram.remove(imbalanceOf(outgoing));
      absFlowHistogram.remove(Math.abs(imbalanceOf(outgoing)));
      absReturnHistogram.remove(Math.min(1, Math.abs(outgoing.priceReturn)));
      flowHistogram.add(value);
      absFlowHistogram.add(Math.abs(value));
      absReturnHistogram.add(Math.min(1, Math.abs(current.priceReturn)));
    }
  }
  return points.sort((left, right) => left.time - right.time);
}

function emptyOutcomeBundle(): OutcomeBundle {
  return { "1h": null, "4h": null, "12h": null, "24h": null };
}

function buildOutcome(
  point: AnalysisPoint,
  arrays: CandleArrays,
  direction: Direction | null,
): OutcomeBundle {
  const result = emptyOutcomeBundle();
  const current = arrays.candles[point.candleIndex];
  if (!current || current.close <= 0) return result;
  const entryPrice = current.close;
  for (const horizon of FLOW_HORIZONS) {
    const targetOpenTime = point.time + HORIZON_MS[horizon] - FLOW_BUCKET_MS;
    const startIndex = arrays.byOpenTime.get(point.time);
    const targetIndex = arrays.byOpenTime.get(targetOpenTime);
    if (startIndex === undefined || targetIndex === undefined || targetIndex < startIndex) continue;
    let contiguous = true;
    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    let realizedVariance = 0;
    for (let index = startIndex; index <= targetIndex; index += 1) {
      const candle = arrays.candles[index]!;
      const previous = arrays.candles[index - 1];
      if (index > startIndex && arrays.candles[index - 1]!.openTime + FLOW_BUCKET_MS !== candle.openTime) contiguous = false;
      high = Math.max(high, candle.high);
      low = Math.min(low, candle.low);
      if (previous && previous.close > 0 && candle.close > 0) {
        const logReturn = Math.log(candle.close / previous.close);
        realizedVariance += logReturn ** 2;
      }
    }
    if (!contiguous || !Number.isFinite(high) || !Number.isFinite(low)) continue;
    const futurePrice = arrays.candles[targetIndex]!.close;
    const closeReturn = futurePrice / entryPrice - 1;
    const directionalReturn = direction === null ? null : closeReturn * (direction === "BULLISH" ? 1 : -1);
    const maxFavorableMove = direction === null
      ? null
      : direction === "BULLISH" ? high / entryPrice - 1 : 1 - low / entryPrice;
    const maxAdverseMove = direction === null
      ? null
      : direction === "BULLISH" ? 1 - low / entryPrice : high / entryPrice - 1;
    const largestAbsoluteMove = Math.max(Math.abs(high / entryPrice - 1), Math.abs(low / entryPrice - 1));
    result[horizon] = {
      futurePrice,
      closeReturn,
      directionalReturn,
      maxFavorableMove,
      maxAdverseMove,
      realizedVolatility: Math.sqrt(realizedVariance),
      largeMove: largestAbsoluteMove >= R53_FROZEN_EVALUATION_SPEC.large_move_threshold,
      extremeMove: largestAbsoluteMove >= R53_FROZEN_EVALUATION_SPEC.extreme_move_threshold,
    };
  }
  return result;
}

function eventPointsFor(points: AnalysisPoint[], hypothesis: Hypothesis, direction: Direction | null): AnalysisPoint[] {
  return points.filter((point) => {
    if (hypothesis === "H1_CONTINUATION") return direction === "BULLISH" ? point.h1Bullish : point.h1Bearish;
    if (hypothesis === "H2_ABSORPTION") return direction === "BULLISH" ? point.h2Bullish : point.h2Bearish;
    return point.h3FlowShock;
  });
}

async function analyzeSymbol(symbol: string, inputs: FrozenInputs): Promise<SymbolAnalysis> {
  const dataset = await loadJson<HistoricalDataset>(resolve(DATA_DIRECTORY, `${symbol}.json`));
  if (dataset.symbol !== symbol || !dataset.candles?.["15m"]?.length) throw new Error(`RESEARCH_INVALID: missing 15m price data for ${symbol}`);
  const candles = [...dataset.candles["15m"]].sort((left, right) => left.openTime - right.openTime);
  const arrays = buildCandleArrays(candles);
  const flow = await readFlowBuckets(symbol, inputs);
  const points = buildAnalysisPoints(symbol, flow.buckets, arrays);
  const anyEventTimes = new Set(points.filter((point) => point.anyEvent).map((point) => point.time));
  const controls = points.filter((point) => !anyEventTimes.has(point.time));
  const populationMatches: PopulationMatch[] = [];
  const populationSpecs: Array<{ hypothesis: Hypothesis; direction: Direction | null }> = [
    { hypothesis: "H1_CONTINUATION", direction: "BULLISH" },
    { hypothesis: "H1_CONTINUATION", direction: "BEARISH" },
    { hypothesis: "H2_ABSORPTION", direction: "BULLISH" },
    { hypothesis: "H2_ABSORPTION", direction: "BEARISH" },
    { hypothesis: "H3_FLOW_SHOCK", direction: null },
  ];
  for (const specification of populationSpecs) {
    const events = eventPointsFor(points, specification.hypothesis, specification.direction);
    const matched = matchNearestWithoutReplacement(events, controls);
    const pairs: PairObservation[] = matched.pairs.map((pair) => ({
      hypothesis: specification.hypothesis,
      direction: specification.direction,
      event: pair.event,
      control: pair.control,
      distanceMs: pair.distanceMs,
      eventOutcome: buildOutcome(pair.event, arrays, specification.direction),
      controlOutcome: buildOutcome(pair.control, arrays, specification.direction),
    }));
    populationMatches.push({
      hypothesis: specification.hypothesis,
      direction: specification.direction,
      eventCount: events.length,
      pairs,
      unmatchedCount: matched.unmatched.length,
      distancesMs: pairs.map((pair) => pair.distanceMs),
    });
  }
  const baselineObservations: BaselineObservation[] = [];
  for (const point of points) {
    if (point.extremeBuy) baselineObservations.push({ point, direction: "BULLISH", outcome: buildOutcome(point, arrays, "BULLISH") });
    else if (point.extremeSell) baselineObservations.push({ point, direction: "BEARISH", outcome: buildOutcome(point, arrays, "BEARISH") });
  }
  return {
    flowObservations: flow.flowObservations,
    featureEligibleDecisions: points.length,
    points,
    populationMatches,
    baselineObservations,
  };
}

function populationId(hypothesis: Hypothesis, direction: Direction | null): string {
  return `${hypothesis}${direction === null ? "" : `_${direction}`}`;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
}

function probability(values: boolean[]): number | null {
  return values.length === 0 ? null : values.filter(Boolean).length / values.length;
}

function completeDirectionalPairs(pairs: PairObservation[], horizon: FlowHorizon): PairObservation[] {
  return pairs.filter((pair) => pair.eventOutcome[horizon]?.directionalReturn !== null
    && pair.eventOutcome[horizon]?.directionalReturn !== undefined
    && pair.controlOutcome[horizon]?.directionalReturn !== null
    && pair.controlOutcome[horizon]?.directionalReturn !== undefined);
}

function directionalMetrics(pairs: PairObservation[], hypothesis: Hypothesis, direction: Direction): JsonRecord {
  const metrics: JsonRecord = {};
  for (const horizon of FLOW_HORIZONS) {
    const complete = completeDirectionalPairs(pairs, horizon);
    const signalReturns = complete.map((pair) => pair.eventOutcome[horizon]!.directionalReturn!);
    const controlReturns = complete.map((pair) => pair.controlOutcome[horizon]!.directionalReturn!);
    const signalMfe = complete.map((pair) => pair.eventOutcome[horizon]!.maxFavorableMove!).filter(Number.isFinite);
    const signalMae = complete.map((pair) => pair.eventOutcome[horizon]!.maxAdverseMove!).filter(Number.isFinite);
    const controlPrecision = controlReturns.map((value) => value > 0);
    const signalPrecision = signalReturns.map((value) => value > 0);
    const precisionDifferences = signalPrecision.map((value, index) => Number(value) - Number(controlPrecision[index]));
    const inference = pairedMeanInference(precisionDifferences, seedFor(`${hypothesis}.${direction}.${horizon}`), R53_FROZEN_EVALUATION_SPEC.permutation_replicates);
    const mfeSummary = summarizeNumeric(signalMfe);
    const maeSummary = summarizeNumeric(signalMae);
    const averageMfe = mfeSummary.mean;
    const averageMae = maeSummary.mean;
    metrics[horizon] = {
      n: complete.length,
      signal_precision: probability(signalPrecision),
      matched_control_precision: probability(controlPrecision),
      incremental_lift: inference.observed,
      average_directional_return: mean(signalReturns),
      median_directional_return: summarizeNumeric(signalReturns).median,
      max_favorable_move: mfeSummary.max,
      max_adverse_move: maeSummary.max,
      median_mfe: mfeSummary.median,
      median_mae: maeSummary.median,
      mfe_mae_ratio: averageMfe !== null && averageMae !== null && averageMae !== 0 ? averageMfe / averageMae : null,
      confidence_interval_95: inference.ci95,
      effect_size: inference.effectSize,
      p_value: inference.pValue,
      adjusted_p_value: null,
      test_id: `${hypothesis}.${direction}.${horizon}.precision_lift`,
    };
  }
  return metrics;
}

function h3Metrics(pairs: PairObservation[]): JsonRecord {
  const metrics: JsonRecord = {};
  for (const horizon of FLOW_HORIZONS) {
    const complete = pairs.filter((pair) => pair.eventOutcome[horizon] !== null && pair.controlOutcome[horizon] !== null);
    const eventVolatility = complete.map((pair) => pair.eventOutcome[horizon]!.realizedVolatility);
    const controlVolatility = complete.map((pair) => pair.controlOutcome[horizon]!.realizedVolatility);
    const eventLarge = complete.map((pair) => pair.eventOutcome[horizon]!.largeMove);
    const controlLarge = complete.map((pair) => pair.controlOutcome[horizon]!.largeMove);
    const eventExtreme = complete.map((pair) => pair.eventOutcome[horizon]!.extremeMove);
    const controlExtreme = complete.map((pair) => pair.controlOutcome[horizon]!.extremeMove);
    const differences = {
      realized_volatility: eventVolatility.map((value, index) => value - controlVolatility[index]!),
      large_move_probability: eventLarge.map((value, index) => Number(value) - Number(controlLarge[index])),
      extreme_move_probability: eventExtreme.map((value, index) => Number(value) - Number(controlExtreme[index])),
    };
    const inference = multiPairedMeanInference(differences, seedFor(`H3_FLOW_SHOCK.${horizon}`), R53_FROZEN_EVALUATION_SPEC.permutation_replicates);
    const eventVolatilityMean = mean(eventVolatility);
    const controlVolatilityMean = mean(controlVolatility);
    const eventLargeProbability = probability(eventLarge);
    const controlLargeProbability = probability(controlLarge);
    const eventExtremeProbability = probability(eventExtreme);
    const controlExtremeProbability = probability(controlExtreme);
    const effect = (metric: keyof typeof differences, controlMean: number | null): JsonRecord => ({
      absolute_difference: inference[metric]!.observed,
      relative_lift: controlMean === null || controlMean === 0 || inference[metric]!.observed === null ? null : inference[metric]!.observed / controlMean,
      confidence_interval_95: inference[metric]!.ci95,
      effect_size: inference[metric]!.effectSize,
      p_value: inference[metric]!.pValue,
      adjusted_p_value: null,
      test_id: `H3_FLOW_SHOCK.${horizon}.${metric}`,
    });
    metrics[horizon] = {
      n: complete.length,
      flow_shock: {
        future_realized_volatility: eventVolatilityMean,
        large_move_probability: eventLargeProbability,
        extreme_move_probability: eventExtremeProbability,
      },
      matched_control: {
        future_realized_volatility: controlVolatilityMean,
        large_move_probability: controlLargeProbability,
        extreme_move_probability: controlExtremeProbability,
      },
      effects: {
        future_realized_volatility: effect("realized_volatility", controlVolatilityMean),
        large_move_probability: effect("large_move_probability", controlLargeProbability),
        extreme_move_probability: effect("extreme_move_probability", controlExtremeProbability),
      },
    };
  }
  return metrics;
}

function allPairs(matches: PopulationMatch[], hypothesis: Hypothesis, direction?: Direction | null): PairObservation[] {
  return matches
    .filter((match) => match.hypothesis === hypothesis && (direction === undefined || match.direction === direction))
    .flatMap((match) => match.pairs);
}

function matchSummary(matches: PopulationMatch[]): JsonRecord {
  const eventCount = matches.reduce((total, match) => total + match.eventCount, 0);
  const matchedCount = matches.reduce((total, match) => total + match.pairs.length, 0);
  const distances = matches.flatMap((match) => match.distancesMs);
  const maxDistanceMs = distances.length === 0
    ? null
    : distances.reduce((maximum, value) => Math.max(maximum, value), Number.NEGATIVE_INFINITY);
  return {
    event_count: eventCount,
    matched_controls: matchedCount,
    unmatched_count: matches.reduce((total, match) => total + match.unmatchedCount, 0),
    matching_coverage_percent: eventCount === 0 ? 100 : matchedCount / eventCount * 100,
    match_distance_minutes: {
      mean: mean(distances.map((value) => value / 60_000)),
      median: summarizeNumeric(distances.map((value) => value / 60_000)).median,
      max: maxDistanceMs === null ? null : maxDistanceMs / 60_000,
    },
    match_quality: {
      within_7_days_percent: distances.length === 0 ? null : distances.filter((value) => value <= 7 * 24 * 60 * 60_000).length / distances.length * 100,
    },
  };
}

function groupBreakdown(pairs: PairObservation[], horizon: FlowHorizon, grouping: "quarter" | "regime" | "symbol", metric: "precision" | "volatility"): JsonRecord[] {
  const groups = new Map<string, number[]>();
  for (const pair of pairs) {
    const eventOutcome = pair.eventOutcome[horizon];
    const controlOutcome = pair.controlOutcome[horizon];
    if (!eventOutcome || !controlOutcome) continue;
    const key = grouping === "quarter" ? pair.event.quarter : grouping === "regime" ? pair.event.marketRegime : pair.event.symbol;
    const difference = metric === "precision"
      ? Number(eventOutcome.directionalReturn! > 0) - Number(controlOutcome.directionalReturn! > 0)
      : eventOutcome.realizedVolatility - controlOutcome.realizedVolatility;
    const values = groups.get(key) ?? [];
    values.push(difference);
    groups.set(key, values);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => ({
    group: key,
    n: values.length,
    effect: mean(values),
    positive: (mean(values) ?? 0) > 0,
  }));
}

function stabilitySummary(groups: JsonRecord[], total: number): JsonRecord {
  const nonEmpty = groups.filter((group) => Number(group.n) > 0);
  const positive = nonEmpty.filter((group) => group.positive === true).length;
  return {
    groups: nonEmpty,
    group_count: nonEmpty.length,
    positive_group_fraction: nonEmpty.length === 0 ? null : positive / nonEmpty.length,
    largest_group_share: total === 0 ? null : Math.max(...nonEmpty.map((group) => Number(group.n))) / total,
    stable: nonEmpty.length >= R53_FROZEN_EVALUATION_SPEC.robust_minimum_stability_groups
      && positive / nonEmpty.length >= R53_FROZEN_EVALUATION_SPEC.robust_minimum_positive_group_fraction,
  };
}

function symbolConcentration(points: AnalysisPoint[]): JsonRecord {
  const counts = new Map<string, number>();
  for (const point of points) counts.set(point.symbol, (counts.get(point.symbol) ?? 0) + 1);
  const ordered = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const [topSymbol, topCount] = ordered[0] ?? ["NONE", 0];
  return {
    total_events: points.length,
    unique_symbols: counts.size,
    largest_symbol: topSymbol,
    largest_symbol_count: topCount,
    largest_symbol_share: points.length === 0 ? null : topCount / points.length,
    by_symbol: Object.fromEntries(ordered.map(([key, value]) => [key, value])),
  };
}

function baselineMetrics(observations: BaselineObservation[]): JsonRecord {
  const result: JsonRecord = {};
  for (const direction of ["BULLISH", "BEARISH"] as const) {
    const selected = observations.filter((item) => item.direction === direction);
    const byHorizon: JsonRecord = {};
    for (const horizon of FLOW_HORIZONS) {
      const outcomes = selected.map((item) => item.outcome[horizon]).filter((item): item is HorizonOutcome => item !== null && item.directionalReturn !== null);
      const returns = outcomes.map((item) => item.directionalReturn!);
      byHorizon[horizon] = {
        n: outcomes.length,
        precision: probability(returns.map((value) => value > 0)),
        average_directional_return: mean(returns),
        median_directional_return: summarizeNumeric(returns).median,
      };
    }
    result[direction.toLowerCase()] = { event_count: selected.length, by_horizon: byHorizon };
  }
  return result;
}

function fineGrainedMetrics(matches: PopulationMatch[]): JsonRecord {
  const observations = matches.filter((match) => match.hypothesis !== "H3_FLOW_SHOCK").flatMap((match) => match.pairs);
  const result: JsonRecord = {};
  for (const horizon of FLOW_HORIZONS) {
    const outcomes = observations.map((pair) => pair.eventOutcome[horizon]).filter((item): item is HorizonOutcome => item !== null && item.directionalReturn !== null);
    const returns = outcomes.map((item) => item.directionalReturn!);
    result[horizon] = {
      n: outcomes.length,
      precision: probability(returns.map((value) => value > 0)),
      average_directional_return: mean(returns),
      median_directional_return: summarizeNumeric(returns).median,
    };
  }
  return { event_count: observations.length, by_horizon: result };
}

function adjustPValues(report: JsonRecord): JsonRecord[] {
  const tests: Array<{ id: string; pValue: number | null; metric: JsonRecord }> = [];
  const hypotheses = report.hypotheses as JsonRecord;
  for (const hypothesis of ["H1_CONTINUATION", "H2_ABSORPTION"] as const) {
    const value = hypotheses[hypothesis] as JsonRecord;
    for (const direction of ["bullish", "bearish"] as const) {
      const metrics = value[direction] as JsonRecord;
      for (const horizon of FLOW_HORIZONS) {
        const metric = metrics[horizon] as JsonRecord;
        tests.push({ id: String(metric.test_id), pValue: typeof metric.p_value === "number" ? metric.p_value : null, metric });
      }
    }
  }
  const h3 = (hypotheses.H3_FLOW_SHOCK as JsonRecord).by_horizon as JsonRecord;
  for (const horizon of FLOW_HORIZONS) {
    const effects = (h3[horizon] as JsonRecord).effects as JsonRecord;
    for (const metricName of ["future_realized_volatility", "large_move_probability", "extreme_move_probability"]) {
      const metric = effects[metricName] as JsonRecord;
      tests.push({ id: String(metric.test_id), pValue: typeof metric.p_value === "number" ? metric.p_value : null, metric });
    }
  }
  const adjusted = holmAdjust(tests.map((test) => ({ id: test.id, pValue: test.pValue })));
  for (const test of tests) test.metric.adjusted_p_value = adjusted[test.id] ?? null;
  return tests.map((test) => ({
    test_id: test.id,
    p_value: test.pValue,
    adjusted_p_value: adjusted[test.id] ?? null,
    reject_at_0_05: adjusted[test.id] !== null && adjusted[test.id]! <= 0.05,
  }));
}

function buildPhenomena(report: JsonRecord, populationMatches: PopulationMatch[], eventPoints: Record<string, AnalysisPoint[]>): JsonRecord[] {
  const candidates: JsonRecord[] = [];
  const hypotheses = report.hypotheses as JsonRecord;
  for (const hypothesis of ["H1_CONTINUATION", "H2_ABSORPTION"] as const) {
    const value = hypotheses[hypothesis] as JsonRecord;
    for (const direction of ["bullish", "bearish"] as const) {
      const directionValue = value[direction] as JsonRecord;
      const directionName = direction === "bullish" ? "BULLISH" : "BEARISH";
      const pairs = allPairs(populationMatches, hypothesis, directionName);
      for (const horizon of FLOW_HORIZONS) {
        const metric = directionValue[horizon] as JsonRecord;
        const quarter = stabilitySummary(groupBreakdown(pairs, horizon, "quarter", "precision"), Number(metric.n));
        const regime = stabilitySummary(groupBreakdown(pairs, horizon, "regime", "precision"), Number(metric.n));
        const concentration = symbolConcentration(eventPoints[populationId(hypothesis, directionName)] ?? []);
        candidates.push({
          phenomenon: `${hypothesis}.${directionName}.${horizon}.precision_lift`,
          family: hypothesis,
          direction: directionName,
          horizon,
          metric: "precision_lift",
          n: metric.n,
          effect: metric.incremental_lift,
          confidence_interval_95: metric.confidence_interval_95,
          adjusted_p_value: metric.adjusted_p_value,
          quarter_stability: quarter,
          regime_stability: regime,
          symbol_concentration: concentration,
        });
      }
    }
  }
  const h3 = (hypotheses.H3_FLOW_SHOCK as JsonRecord).by_horizon as JsonRecord;
  for (const horizon of FLOW_HORIZONS) {
    const pairs = allPairs(populationMatches, "H3_FLOW_SHOCK");
    const value = h3[horizon] as JsonRecord;
    const effects = value.effects as JsonRecord;
    for (const metricName of ["future_realized_volatility", "large_move_probability", "extreme_move_probability"]) {
      const metric = effects[metricName] as JsonRecord;
      const quarter = stabilitySummary(groupBreakdown(pairs, horizon, "quarter", "volatility"), Number(value.n));
      const regime = stabilitySummary(groupBreakdown(pairs, horizon, "regime", "volatility"), Number(value.n));
      candidates.push({
        phenomenon: `H3_FLOW_SHOCK.${horizon}.${metricName}`,
        family: "H3_FLOW_SHOCK",
        direction: null,
        horizon,
        metric: metricName,
        n: value.n,
        effect: metric.absolute_difference,
        confidence_interval_95: metric.confidence_interval_95,
        adjusted_p_value: metric.adjusted_p_value,
        quarter_stability: quarter,
        regime_stability: regime,
        symbol_concentration: symbolConcentration(eventPoints.H3_FLOW_SHOCK ?? []),
      });
    }
  }
  return candidates;
}

function classifyResearch(
  invalidReason: string | null,
  phenomena: JsonRecord[],
): { classification: "ROBUST_INCREMENTAL_INFORMATION" | "CONDITIONAL_INFORMATION_ONLY" | "NO_INCREMENTAL_INFORMATION" | "RESEARCH_INVALID"; best: string } {
  if (invalidReason !== null) return { classification: "RESEARCH_INVALID", best: "NONE" };
  const robust = phenomena.filter((phenomenon) => {
    const ci = phenomenon.confidence_interval_95 as JsonRecord | null;
    const lower = typeof ci?.lower === "number" ? ci.lower : Number.NEGATIVE_INFINITY;
    const p = typeof phenomenon.adjusted_p_value === "number" ? phenomenon.adjusted_p_value : 1;
    const concentration = phenomenon.symbol_concentration as JsonRecord;
    const quarter = phenomenon.quarter_stability as JsonRecord;
    const regime = phenomenon.regime_stability as JsonRecord;
    return Number(phenomenon.n) >= R53_FROZEN_EVALUATION_SPEC.robust_minimum_events
      && Number(phenomenon.effect) > 0
      && lower > 0
      && p <= 0.05
      && Number(concentration.largest_symbol_share ?? 1) <= R53_FROZEN_EVALUATION_SPEC.robust_maximum_symbol_concentration
      && quarter.stable === true
      && regime.stable === true;
  });
  if (robust.length > 0) {
    const best = [...robust].sort((left, right) => Number(right.effect) - Number(left.effect))[0]!;
    return { classification: "ROBUST_INCREMENTAL_INFORMATION", best: String(best.phenomenon) };
  }
  const conditional = phenomena.some((phenomenon) => {
    const p = typeof phenomenon.adjusted_p_value === "number" ? phenomenon.adjusted_p_value : 1;
    const effect = typeof phenomenon.effect === "number" ? phenomenon.effect : 0;
    return Number(phenomenon.n) >= 30 && effect > 0 && p <= 0.2;
  });
  if (conditional) {
    const best = [...phenomena]
      .filter((phenomenon) => Number(phenomenon.effect) > 0)
      .sort((left, right) => Number(right.effect) - Number(left.effect))[0];
    return { classification: "CONDITIONAL_INFORMATION_ONLY", best: best ? String(best.phenomenon) : "NONE" };
  }
  return { classification: "NO_INCREMENTAL_INFORMATION", best: "NONE" };
}

function safetyBoundary(): JsonRecord {
  return {
    production_modified: false,
    supabase_production_modified: false,
    vercel_modified: false,
    paper_strategy_modified: false,
    scanner_live_integrated: false,
    emails_sent: 0,
    private_api_called: false,
    orders_sent: false,
    position_management_used: false,
    auto_trading: false,
    commit_created: false,
  };
}

async function createOrLoadFreezeManifest(inputs: FrozenInputs, sourceHash: string): Promise<{ manifest: JsonRecord; hash: string }> {
  const expectedUniverse = [...inputs.report.data.universe].sort();
  if (await exists(FREEZE_MANIFEST_PATH)) {
    const existing = await loadJson<JsonRecord>(FREEZE_MANIFEST_PATH);
    const accepted = isRecord(existing.authoritative_inputs) ? existing.authoritative_inputs : null;
    if (existing.version !== R53_FROZEN_EVALUATION_SPEC.version
      || existing.experiment_count !== 1
      || sha256Json(existing.feature_specification) !== EXPECTED_FEATURE_SPECIFICATION_HASH
      || sha256Json(existing.evaluation_specification) !== sha256Json(R53_FROZEN_EVALUATION_SPEC)
      || String(accepted?.coverage_matrix_hash) !== EXPECTED_COVERAGE_MATRIX_HASH
      || JSON.stringify(existing.universe) !== JSON.stringify(expectedUniverse)) {
      throw new Error("RESEARCH_INVALID: existing pre-performance freeze manifest does not match the accepted frozen inputs");
    }
    return { manifest: existing, hash: sha256Json(existing) };
  }
  const manifest: JsonRecord = {
    research: "HY-R5.3 FROZEN AGGRESSIVE FLOW INFORMATION GAIN",
    version: R53_FROZEN_EVALUATION_SPEC.version,
    created_at: new Date().toISOString(),
    immutable: true,
    historical_range: { start: EVALUATION_START_ISO, end: EVALUATION_END_ISO },
    formal_event_end_exclusive: iso(FORMAL_EVENT_END_EXCLUSIVE),
    universe: expectedUniverse,
    universe_count: expectedUniverse.length,
    authoritative_inputs: {
      r52b_report: R52_REPORT_PATH,
      r52_flow_manifest: R52_MANIFEST_PATH,
      coverage_matrix: COVERAGE_MATRIX_PATH,
      coverage_matrix_hash: EXPECTED_COVERAGE_MATRIX_HASH,
      feature_specification_hash: EXPECTED_FEATURE_SPECIFICATION_HASH,
      r52b_pit_safe: "PASS",
      r52b_listing_adjusted_coverage_percent: 100,
    },
    feature_specification: R52_FROZEN_FEATURE_SPEC,
    evaluation_specification: R53_FROZEN_EVALUATION_SPEC,
    hypotheses: {
      H1_CONTINUATION: "F1 extreme flow + F2 acceleration + F3 persistence + strong same-direction F4 response; H1 excludes F5 absorption.",
      H2_ABSORPTION: "F1 extreme flow + F2 acceleration + F3 persistence + F5 weak/opposite F4 response; direction is the expected reversal.",
      H3_FLOW_SHOCK: "F1 extreme flow + F2 acceleration + F3 persistence; direction is not evaluated.",
    },
    matched_control_policy: {
      fields: R53_FROZEN_EVALUATION_SPEC.control_match_fields,
      no_future_outcome_matching: true,
      control_pool_excludes_formal_event_times: true,
    },
    outcome_definitions: {
      reference_price: "close of the completed 15m flow window; decision time is its next 15m boundary",
      forward_return: "close-to-close from decision time through the exact horizon close",
      mfe_mae: "high/low excursion across future 15m candles only",
      realized_volatility: "square root of summed squared 15m log returns across the future horizon",
      large_move: "maximum absolute high/low excursion >= 2%",
      extreme_move: "maximum absolute high/low excursion >= 5%",
    },
    statistical_policy: {
      seed: R53_FROZEN_EVALUATION_SPEC.random_seed,
      bootstrap_replicates: R53_FROZEN_EVALUATION_SPEC.bootstrap_replicates,
      permutation_replicates: R53_FROZEN_EVALUATION_SPEC.permutation_replicates,
      confidence_level: R53_FROZEN_EVALUATION_SPEC.confidence_level,
      multiple_testing: R53_FROZEN_EVALUATION_SPEC.multiple_testing,
    },
    classification_policy: {
      robust: "n>=100, positive 95% CI lower bound, Holm-adjusted p<=0.05, >=3 positive stability groups with >=60% positive, and largest symbol share<=50%",
      conditional: "predeclared positive effect with n>=30 and adjusted p<=0.20 but robust stability/uncertainty not established",
      negative: "no predeclared phenomenon meets the conditional gate",
    },
    experiment_count: 1,
    features_frozen_before_performance: "YES",
    post_result_tuning: "NO",
    outcome_metrics_not_yet_calculated: true,
    runner_source_paths: RUNNER_SOURCE_PATHS,
    runner_source_hash: sourceHash,
  };
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(FREEZE_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const reloaded = await loadJson<JsonRecord>(FREEZE_MANIFEST_PATH);
  if (sha256Json(reloaded) !== sha256Json(manifest)) throw new Error("RESEARCH_INVALID: freeze manifest changed during write");
  return { manifest: reloaded, hash: sha256Json(reloaded) };
}

function buildMarkdown(report: JsonRecord): string {
  const data = report.data as JsonRecord;
  const hypotheses = report.hypotheses as JsonRecord;
  const controls = report.matched_controls as JsonRecord;
  const statistics = report.statistics as JsonRecord;
  const stability = report.stability as JsonRecord;
  const comparison = report.comparison as JsonRecord;
  const safety = report.safety as JsonRecord;
  const lines = [
    "# HY-R5.3 Frozen Aggressive Flow Information Gain",
    "",
    `- Classification: **${String(report.classification)}**`,
    `- Historical range: ${String(data.historical_range_start)} -> ${String(data.historical_range_end)}`,
    `- Universe: ${String(data.universe_count)}/49`,
    `- Listing-adjusted coverage: ${String(data.listing_adjusted_coverage_percent)}%`,
    `- PIT-safe: **${String(report.pit_safe)}**`,
    `- Experiment count: **${String((report.experiment_control as JsonRecord).experiment_count)}**`,
    `- Features frozen before performance: **${String((report.experiment_control as JsonRecord).features_frozen_before_performance)}**`,
    `- Post-result tuning: **${String((report.experiment_control as JsonRecord).post_result_tuning)}**`,
    `- Engineering pre-performance attempt: ${String((report.experiment_control as JsonRecord).engineering_preperformance_attempt_status)}`,
    "",
    "## Freeze",
    "",
    `- Freeze manifest: ${String((report.freeze_manifest as JsonRecord).path)}`,
    `- Freeze manifest hash: ${String((report.freeze_manifest as JsonRecord).hash)}`,
    `- Coverage matrix hash: ${String(data.coverage_matrix_hash)}`,
    `- Feature specification hash: ${String(data.feature_specification_hash)}`,
    `- Runner/source hash: ${String(data.runner_source_hash)}`,
    "- R5.2 F1-F5 semantics, windows, percentiles, completeness and closed-bar PIT rule are unchanged.",
    `- Preflight outcome metrics persisted/emitted before remediation: ${String((report.experiment_control as JsonRecord).preflight_outcome_metrics_persisted_or_emitted)}`,
    `- Remediation: ${String(data.engineering_preperformance_remediation)}`,
    "",
    "## Data",
    "",
    `- Flow observations: ${String(data.flow_observations)}`,
    `- Feature-eligible decisions: ${String(data.feature_eligible_decisions)}`,
    `- Formal event end: ${String(data.formal_event_end_exclusive)}`,
    "- No synthetic rows, no future feature values, and no outcome-based matching fields were used.",
    "",
    "## Hypothesis populations",
    "",
    "| Hypothesis | Events | Matched controls | Coverage |",
    "| --- | ---: | ---: | ---: |",
  ];
  for (const [name, label] of [["H1_CONTINUATION", "H1 continuation"], ["H2_ABSORPTION", "H2 absorption"], ["H3_FLOW_SHOCK", "H3 flow shock"]] as const) {
    const value = hypotheses[name] as JsonRecord;
    const match = controls[name] as JsonRecord;
    lines.push(`| ${label} | ${String(value.event_count)} | ${String(match.matched_controls)} | ${round(Number(match.matching_coverage_percent), 2)}% |`);
  }
  lines.push(
    "",
    "## H1 / H2 directional results",
    "",
    "| Hypothesis | Direction | 1h n | 1h lift | 4h n | 4h lift | 12h lift | 24h lift |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const hypothesis of ["H1_CONTINUATION", "H2_ABSORPTION"] as const) {
    const value = hypotheses[hypothesis] as JsonRecord;
    for (const direction of ["bullish", "bearish"] as const) {
      const metrics = value[direction] as JsonRecord;
      const h1 = metrics["1h"] as JsonRecord;
      const h4 = metrics["4h"] as JsonRecord;
      const h12 = metrics["12h"] as JsonRecord;
      const h24 = metrics["24h"] as JsonRecord;
      lines.push(`| ${hypothesis} | ${direction} | ${String(h1.n)} | ${round(Number(h1.incremental_lift), 4)} | ${String(h4.n)} | ${round(Number(h4.incremental_lift), 4)} | ${round(Number(h12.incremental_lift), 4)} | ${round(Number(h24.incremental_lift), 4)} |`);
    }
  }
  lines.push(
    "",
    "## H3 risk results",
    "",
    "| Horizon | n | Volatility lift | Large-move lift | Extreme-move lift |",
    "| --- | ---: | ---: | ---: | ---: |",
  );
  const h3 = (hypotheses.H3_FLOW_SHOCK as JsonRecord).by_horizon as JsonRecord;
  for (const horizon of FLOW_HORIZONS) {
    const value = h3[horizon] as JsonRecord;
    const effects = value.effects as JsonRecord;
    lines.push(`| ${horizon} | ${String(value.n)} | ${round(Number((effects.future_realized_volatility as JsonRecord).absolute_difference), 6)} | ${round(Number((effects.large_move_probability as JsonRecord).absolute_difference), 6)} | ${round(Number((effects.extreme_move_probability as JsonRecord).absolute_difference), 6)} |`);
  }
  lines.push(
    "",
    "## Existing aggregate-flow comparison",
    "",
    `- Baseline: ${String((comparison.existing_aggregate_flow_baseline as JsonRecord).definition)}`,
    `- Limitation: ${String((comparison.existing_aggregate_flow_baseline as JsonRecord).limitation)}`,
    `- Fine-grained event summary: ${JSON.stringify(comparison.fine_grained_flow)}`,
    `- F1-only aggregate proxy summary: ${JSON.stringify((comparison.existing_aggregate_flow_baseline as JsonRecord).metrics)}`,
    "- This comparison is descriptive; no causal credit is assigned to F1-F5 beyond the predeclared phenomenon definitions.",
    "",
    "## Statistics and stability",
    "",
    `- Holm tests: ${String(statistics.test_count)}; adjusted discoveries at 0.05: ${String(statistics.significant_after_holm)}`,
    `- Bootstrap/permutation replicates: ${String(statistics.bootstrap_replicates)}/${String(statistics.permutation_replicates)}`,
    `- Seed: ${String(statistics.seed)}`,
    `- Stable across quarters: ${String(stability.stable_across_quarters)}`,
    `- Stable across regimes: ${String(stability.stable_across_regimes)}`,
    `- Largest symbol concentration: ${round(Number(stability.largest_symbol_concentration), 4)}`,
    `- Best robust phenomenon: ${String(stability.best_robust_phenomenon)}`,
    "- Full quarter/regime/symbol breakdowns and corrected p-values are in the JSON report.",
    "",
    "## Safety boundary",
    "",
    `- Production modified: ${safety.production_modified ? "YES" : "NO"}`,
    `- Supabase Production modified: ${safety.supabase_production_modified ? "YES" : "NO"}`,
    `- Vercel modified: ${safety.vercel_modified ? "YES" : "NO"}`,
    `- PAPER strategy modified: ${safety.paper_strategy_modified ? "YES" : "NO"}`,
    `- Emails sent: ${String(safety.emails_sent)}`,
    `- Private API called: ${safety.private_api_called ? "YES" : "NO"}`,
    `- AUTO_TRADING: ${safety.auto_trading ? "TRUE" : "FALSE"}`,
    `- Commit created: ${safety.commit_created ? "YES" : "NO"}`,
    "",
    "STOP.",
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (await exists(JSON_REPORT_PATH) || await exists(MARKDOWN_REPORT_PATH)) {
    throw new Error("FORMAL PERFORMANCE ALREADY COMPLETED: R5.3 authoritative study will not be rerun");
  }
  const inputs = await loadFrozenInputs();
  const sourceHash = await runnerSourceHash();
  const freeze = await createOrLoadFreezeManifest(inputs, sourceHash);
  const performanceStartedAt = new Date().toISOString();
  const symbols = [...inputs.report.data.universe].sort();
  const allMatches: PopulationMatch[] = [];
  const allBaseline: BaselineObservation[] = [];
  const eventPoints: Record<string, AnalysisPoint[]> = {
    H1_CONTINUATION_BULLISH: [],
    H1_CONTINUATION_BEARISH: [],
    H2_ABSORPTION_BULLISH: [],
    H2_ABSORPTION_BEARISH: [],
    H3_FLOW_SHOCK: [],
  };
  let flowObservations = 0;
  let featureEligibleDecisions = 0;
  for (const [index, symbol] of symbols.entries()) {
    const analysis = await analyzeSymbol(symbol, inputs);
    flowObservations += analysis.flowObservations;
    featureEligibleDecisions += analysis.featureEligibleDecisions;
    allMatches.push(...analysis.populationMatches);
    allBaseline.push(...analysis.baselineObservations);
    for (const match of analysis.populationMatches) {
      const key = populationId(match.hypothesis, match.direction);
      eventPoints[key]!.push(...analysis.points.filter((point) => {
        if (match.hypothesis === "H1_CONTINUATION") return match.direction === "BULLISH" ? point.h1Bullish : point.h1Bearish;
        if (match.hypothesis === "H2_ABSORPTION") return match.direction === "BULLISH" ? point.h2Bullish : point.h2Bearish;
        return point.h3FlowShock;
      }));
    }
    console.log(JSON.stringify({ progress: `${index + 1}/${symbols.length}`, symbol, flowObservations: analysis.flowObservations, featureEligibleDecisions: analysis.featureEligibleDecisions }));
  }
  if (flowObservations !== inputs.report.data.valid_flow_minutes) {
    throw new Error(`RESEARCH_INVALID: parsed active flow observations ${flowObservations} != frozen ${inputs.report.data.valid_flow_minutes}`);
  }
  const h1Pairs = allPairs(allMatches, "H1_CONTINUATION");
  const h1BullishPairs = allPairs(allMatches, "H1_CONTINUATION", "BULLISH");
  const h1BearishPairs = allPairs(allMatches, "H1_CONTINUATION", "BEARISH");
  const h2Pairs = allPairs(allMatches, "H2_ABSORPTION");
  const h2BullishPairs = allPairs(allMatches, "H2_ABSORPTION", "BULLISH");
  const h2BearishPairs = allPairs(allMatches, "H2_ABSORPTION", "BEARISH");
  const h3Pairs = allPairs(allMatches, "H3_FLOW_SHOCK");
  const h1BullishEvents = eventPoints.H1_CONTINUATION_BULLISH;
  const h1BearishEvents = eventPoints.H1_CONTINUATION_BEARISH;
  const h2BullishEvents = eventPoints.H2_ABSORPTION_BULLISH;
  const h2BearishEvents = eventPoints.H2_ABSORPTION_BEARISH;
  const hypotheses: JsonRecord = {
    H1_CONTINUATION: {
      event_count: h1BullishEvents.length + h1BearishEvents.length,
      bullish_event_count: h1BullishEvents.length,
      bearish_event_count: h1BearishEvents.length,
      bullish: directionalMetrics(h1BullishPairs, "H1_CONTINUATION", "BULLISH"),
      bearish: directionalMetrics(h1BearishPairs, "H1_CONTINUATION", "BEARISH"),
    },
    H2_ABSORPTION: {
      event_count: h2BullishEvents.length + h2BearishEvents.length,
      bullish_event_count: h2BullishEvents.length,
      bearish_event_count: h2BearishEvents.length,
      bullish: directionalMetrics(h2BullishPairs, "H2_ABSORPTION", "BULLISH"),
      bearish: directionalMetrics(h2BearishPairs, "H2_ABSORPTION", "BEARISH"),
    },
    H3_FLOW_SHOCK: {
      event_count: eventPoints.H3_FLOW_SHOCK.length,
      by_horizon: h3Metrics(h3Pairs),
    },
  };
  const matchedControls: JsonRecord = {
    H1_CONTINUATION: matchSummary(allMatches.filter((match) => match.hypothesis === "H1_CONTINUATION")),
    H2_ABSORPTION: matchSummary(allMatches.filter((match) => match.hypothesis === "H2_ABSORPTION")),
    H3_FLOW_SHOCK: matchSummary(allMatches.filter((match) => match.hypothesis === "H3_FLOW_SHOCK")),
  };
  const invalidMatch = Object.entries(matchedControls).some(([key, value]) => {
    const coverage = Number((value as JsonRecord).matching_coverage_percent);
    const events = Number((value as JsonRecord).event_count);
    return events > 0 && coverage < 80;
  });
  const preliminary: JsonRecord = {
    hypotheses,
    matched_controls: matchedControls,
  };
  const tests = adjustPValues(preliminary);
  const phenomena = buildPhenomena(preliminary, allMatches, eventPoints);
  const robustPhenomena = phenomena.filter((phenomenon) => Number(phenomenon.n) >= 100 && Number(phenomenon.effect) > 0 && Number((phenomenon.adjusted_p_value ?? 1)) <= 0.05);
  const stableAcrossQuarters = robustPhenomena.some((phenomenon) => (phenomenon.quarter_stability as JsonRecord).stable === true);
  const stableAcrossRegimes = robustPhenomena.some((phenomenon) => (phenomenon.regime_stability as JsonRecord).stable === true);
  const largestSymbolConcentration = phenomena.length === 0 ? 0 : Math.max(...phenomena.map((phenomenon) => Number((phenomenon.symbol_concentration as JsonRecord).largest_symbol_share ?? 0)));
  const invalidReason = invalidMatch ? "At least one formal hypothesis has <80% deterministic matched-control coverage." : null;
  const classification = classifyResearch(invalidReason, phenomena);
  const significanceCount = tests.filter((test) => test.reject_at_0_05).length;
  const report: JsonRecord = {
    research: "HY-R5.3 FROZEN AGGRESSIVE FLOW INFORMATION GAIN",
    version: R53_FROZEN_EVALUATION_SPEC.version,
    classification: classification.classification,
    freeze_manifest: { path: FREEZE_MANIFEST_PATH, hash: freeze.hash, immutable: true },
    data: {
      historical_range_start: EVALUATION_START_ISO,
      historical_range_end: EVALUATION_END_ISO,
      formal_event_end_exclusive: iso(FORMAL_EVENT_END_EXCLUSIVE),
      universe_count: symbols.length,
      universe: symbols,
      listing_adjusted_coverage_percent: 100,
      coverage_matrix_hash: EXPECTED_COVERAGE_MATRIX_HASH,
      feature_specification_hash: EXPECTED_FEATURE_SPECIFICATION_HASH,
      runner_source_hash: sourceHash,
      freeze_manifest_runner_source_hash: String((freeze.manifest as JsonRecord).runner_source_hash),
      engineering_preperformance_remediation: "R5.2B listing-adjusted completeness/lifecycle admission, large-array summary, and H1/H2 directional pair isolation were corrected before acceptance; feature/rule/evaluation specification unchanged.",
      flow_observations: flowObservations,
      feature_eligible_decisions: featureEligibleDecisions,
      no_synthetic_fill: true,
    },
    experiment_control: {
      experiment_count: 1,
      authoritative: true,
      performance_executed: true,
      performance_started_at: performanceStartedAt,
      performance_completed_at: new Date().toISOString(),
      features_frozen_before_performance: "YES",
      post_result_tuning: "NO",
      thresholds_changed_after_performance: "NO",
      horizons_changed_after_performance: "NO",
      symbols_filtered_after_performance: "NO",
      engineering_preperformance_attempt_status: "INVALID_ARTIFACT_ARCHIVED_AND_REMEDIATED_BEFORE_ACCEPTANCE",
      preflight_outcome_values_computed_in_memory: true,
      preflight_outcome_metrics_persisted_or_emitted: "YES_BUT_INVALID_ARTIFACT_ARCHIVED",
      preflight_invalid_artifact_archived: true,
      preflight_failure_reason: "Engineering preflights exposed three implementation defects without changing the frozen feature/rule/evaluation specification: PUMPUSDT:2025-06 needed active lifecycle admission, match summary needed an O(n) maximum, and the previous completed artifact incorrectly passed pooled H1/H2 pairs into directional metrics. The invalid artifact was archived before acceptance; the corrected run isolates direction-specific pairs.",
    },
    hypotheses,
    matched_controls: matchedControls,
    statistics: {
      seed: R53_FROZEN_EVALUATION_SPEC.random_seed,
      bootstrap_replicates: R53_FROZEN_EVALUATION_SPEC.bootstrap_replicates,
      permutation_replicates: R53_FROZEN_EVALUATION_SPEC.permutation_replicates,
      confidence_level: R53_FROZEN_EVALUATION_SPEC.confidence_level,
      multiple_testing: "Holm step-down across all predeclared H1/H2 directional precision and H3 risk tests",
      test_count: tests.length,
      significant_after_holm: significanceCount,
      tests,
    },
    stability: {
      phenomena,
      stable_across_quarters: stableAcrossQuarters,
      stable_across_regimes: stableAcrossRegimes,
      largest_symbol_concentration: largestSymbolConcentration,
      best_robust_phenomenon: classification.best,
      quarter_stability_definition: ">=3 populated groups and >=60% positive effects",
      regime_stability_definition: ">=3 populated groups and >=60% positive effects",
    },
    comparison: {
      fine_grained_flow: {
        definition: "H1/H2 F1-F5 operational phenomena, event-only descriptive summary",
        metrics: fineGrainedMetrics(allMatches),
      },
      existing_aggregate_flow_baseline: {
        definition: R53_FROZEN_EVALUATION_SPEC.aggregate_baseline,
        metrics: baselineMetrics(allBaseline),
        limitation: "The historical cache does not archive the bounded live aggTrades sample; F1-only is an explicit same-window historical proxy, not a claim that the two feeds are identical.",
      },
      information_gain_interpretation: "Primary evidence is the predeclared matched-control lift. The aggregate comparison is descriptive and does not reassign existing aggregate-flow effects to F1-F5.",
    },
    sample_size: {
      H1_continuation: { bullish: h1BullishEvents.length, bearish: h1BearishEvents.length },
      H2_absorption: { bullish: h2BullishEvents.length, bearish: h2BearishEvents.length },
      H3_flow_shock: eventPoints.H3_FLOW_SHOCK.length,
      hypotheses_below_robust_minimum: phenomena.filter((phenomenon) => Number(phenomenon.n) < R53_FROZEN_EVALUATION_SPEC.robust_minimum_events).map((phenomenon) => phenomenon.phenomenon),
    },
    failure_cases: {
      invalid_reason: invalidReason,
      unmatched_by_hypothesis: Object.fromEntries(Object.entries(matchedControls).map(([key, value]) => [key, (value as JsonRecord).unmatched_count])),
      small_sample_warning: "Small populations are not allowed to support a robust claim; no post-result filtering was performed.",
    },
    pit_safe: invalidReason === null ? "PASS" : "FAIL",
    future_performance_calculated: true,
    performance: {
      executed: true,
      future_return: true,
      precision: true,
      mfe: true,
      mae: true,
      pnl: false,
      signal_vs_control: true,
      h1_h2_h3_outcomes: true,
    },
    safety: safetyBoundary(),
  };
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(JSON_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(MARKDOWN_REPORT_PATH, buildMarkdown(report), "utf8");
  console.log(JSON.stringify({
    json: JSON_REPORT_PATH,
    markdown: MARKDOWN_REPORT_PATH,
    freeze: FREEZE_MANIFEST_PATH,
    classification: report.classification,
    coverageMatrixHash: EXPECTED_COVERAGE_MATRIX_HASH,
    featureSpecificationHash: EXPECTED_FEATURE_SPECIFICATION_HASH,
    runnerSourceHash: sourceHash,
    experimentCount: 1,
    h1ContinuationEvents: (hypotheses.H1_CONTINUATION as JsonRecord).event_count,
    h2AbsorptionEvents: (hypotheses.H2_ABSORPTION as JsonRecord).event_count,
    h3FlowShockEvents: (hypotheses.H3_FLOW_SHOCK as JsonRecord).event_count,
    matchedControlCoverage: Object.fromEntries(Object.entries(matchedControls).map(([key, value]) => [key, (value as JsonRecord).matching_coverage_percent])),
    tests: `${tests.length}/${tests.length}`,
    pitSafe: report.pit_safe,
    productionModified: false,
    autoTrading: false,
  }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
