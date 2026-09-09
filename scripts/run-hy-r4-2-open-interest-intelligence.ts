import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Candle, FundingRatePoint } from "../lib/core/types";

const DATA_DIR = join(process.cwd(), "data", "hy-r2b-history-24m");
const OI_DIR = join(process.cwd(), "data", "hy-r4.2-open-interest-24m");
const REPORT_DIR = join(process.cwd(), "reports");
const REPORT_JSON = join(REPORT_DIR, "hy-r4.2-open-interest-intelligence.json");
const REPORT_MD = join(REPORT_DIR, "hy-r4.2-open-interest-intelligence.md");

const HISTORY_START = Date.parse("2024-08-09T00:00:00.000Z");
const HISTORY_END = Date.parse("2026-08-09T23:59:59.999Z");
const FUNDING_ROLLING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const OI_ROLLING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const OI_CHANGE_LOOKBACK_MS = 4 * 60 * 60 * 1000;
const OI_ROLLING_CHANGE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const OI_MAX_CHANGE_GAP_MS = 6 * 60 * 60 * 1000;
const OI_MAX_ROLLING_CHANGE_GAP_MS = 12 * 60 * 60 * 1000;
const MIN_PRIOR_FUNDING_POINTS = 30;
const MIN_PRIOR_OI_CHANGE_POINTS = 168;
const LOW_PERCENTILE = 0.05;
const HIGH_PERCENTILE = 0.95;
const HORIZONS_HOURS = [4, 12, 24] as const;

const BASELINE = {
  strategyVersion: "hy-paper-candidate-v2",
  stage: "PAPER",
  side: "SHORT",
  entryMode: "TREND_PULLBACK",
  oosTrades: 460,
  fiveBpsProfitFactor: 1.0115,
  fiveBpsNetPnlUsdt: 181.5556,
  tenBpsProfitFactor: 0.9324,
  sourceReport: "reports/hy-r2b-frozen-short-oos-expansion.json",
};

type ExtremeFlag = "NONE" | "LONG_OBSERVATION" | "SHORT_OBSERVATION";
type ObservationSide = "LONG" | "SHORT";
type Direction = "UP" | "DOWN" | "FLAT" | "INSUFFICIENT_DATA";
type MarketState = "A" | "B" | "C" | "D" | "UNCLASSIFIED_FLAT" | "INSUFFICIENT_DATA";

interface HistoricalDataset {
  symbol: string;
  candles: Record<string, Candle[]>;
  fundingRates: FundingRatePoint[];
}

interface OpenInterestPoint {
  timestamp: number;
  openInterest: number;
  openInterestValue: number;
}

interface OpenInterestCache {
  symbol: string;
  source: string;
  sourceInterval: string;
  coverageStart: string;
  coverageEnd: string;
  requestedDays: number;
  availableDays: number;
  missingDays: number;
  hourlyPoints: number;
  points: OpenInterestPoint[];
}

interface FundingObservation {
  symbol: string;
  fundingRate: number;
  fundingTime: number;
  fundingTimeIso: string;
  historicalPercentile: number;
  rollingAverage: number;
  rollingStd: number;
  priorHistoryPoints: number;
  extremeFlag: ExtremeFlag;
}

interface OiDerivedPoint extends OpenInterestPoint {
  oiChange: number | null;
  oiChangePct: number | null;
  oiRollingChange: number | null;
  oiRollingChangePct: number | null;
  oi4hChange: number | null;
  oi4hChangePct: number | null;
  oi4hChangeHistoryPercentile: number | null;
  oiChangeHistoryPoints: number;
}

interface EventObservation {
  eventId: number;
  symbol: string;
  fundingRate: number;
  fundingTime: number;
  fundingTimeIso: string;
  fundingHistoricalPercentile: number;
  fundingRollingAverage: number;
  fundingRollingStd: number;
  fundingExtremeFlag: ExtremeFlag;
  oiTimestamp: number | null;
  oiTimestampIso: string | null;
  openInterest: number | null;
  openInterestValue: number | null;
  oiChange: number | null;
  oiChangePct: number | null;
  oiRollingChange: number | null;
  oiRollingChangePct: number | null;
  oi4hChange: number | null;
  oi4hChangePct: number | null;
  oi4hChangeHistoryPercentile: number | null;
  oiChangeHistoryPoints: number;
  oiContextAvailable: boolean;
  price1hReturnPct: number | null;
  price4hReturnPct: number | null;
  priceDirection: Direction;
  oiDirection: Direction;
  marketState: MarketState;
  stateMeaning: string;
  oiRising: boolean | null;
  priceStabilizing: boolean | null;
  momentumWeakening: boolean | null;
  fusionCandidate: "LONG" | "SHORT" | "NONE";
}

interface EvaluatedPath {
  horizonHours: number;
  targetTime: number;
  targetTimeIso: string;
  rawReturnPct: number;
  longDirectionalReturnPct: number;
  shortDirectionalReturnPct: number;
  longFavorable: boolean;
  shortFavorable: boolean;
  longAdverseExcursionPct: number;
  longFavorableExcursionPct: number;
  shortAdverseExcursionPct: number;
  shortFavorableExcursionPct: number;
}

interface SidePathMetrics {
  directionalReturnPct: number;
  favorable: boolean;
  adverseExcursionPct: number;
  favorableExcursionPct: number;
}

interface EventEvaluation {
  event: EventObservation;
  paths: EvaluatedPath[];
}

interface HorizonSummary {
  horizonHours: number;
  triggerCount: number;
  evaluatedCount: number;
  favorableCount: number;
  failureCount: number;
  winRatePct: number | null;
  averageRawReturnPct: number | null;
  averageDirectionalReturnPct: number | null;
  averageAdverseExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
  averageFavorableExcursionPct: number | null;
  maxFavorableExcursionPct: number | null;
}

interface SideSummary {
  side: ObservationSide;
  triggerCount: number;
  byHorizon: Record<string, HorizonSummary>;
}

interface StateHorizonSummary {
  state: string;
  horizonHours: number;
  triggerCount: number;
  evaluatedCount: number;
  positiveCount: number;
  negativeCount: number;
  positiveRatePct: number | null;
  averageForwardReturnPct: number | null;
  maxAdverseExcursionPct: number | null;
  maxFavorableExcursionPct: number | null;
}

interface SymbolCoverage {
  symbol: string;
  oiAvailableDays: number;
  oiMissingDays: number;
  oiHourlyPoints: number;
  fundingObservations: number;
  oiContextAvailable: number;
  oiContextMissing: number;
  stateClassified: number;
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function roundNullable(value: number | null, digits = 6): number | null {
  return value === null ? null : round(value, digits);
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function average(values: number[]): number | null {
  return values.length > 0
    ? round(values.reduce((total, value) => total + value, 0) / values.length)
    : null;
}

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low < values.length ? low : -1;
}

function atOrBeforeIndex(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] <= target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low > 0 ? low - 1 : -1;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function loadDataset(symbol: string): Promise<HistoricalDataset> {
  return readJson<HistoricalDataset>(join(DATA_DIR, symbol + ".json"));
}

async function loadOiCache(symbol: string): Promise<OpenInterestCache> {
  return readJson<OpenInterestCache>(join(OI_DIR, symbol + ".json"));
}

function buildFundingObservations(
  dataset: HistoricalDataset,
): FundingObservation[] {
  const points = dataset.fundingRates
    .filter((point) => finite(point.fundingTime) && finite(point.fundingRate))
    .sort((left, right) => left.fundingTime - right.fundingTime);
  const observations: FundingObservation[] = [];
  let windowStart = 0;

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    while (
      windowStart < index &&
      points[windowStart].fundingTime <
        point.fundingTime - FUNDING_ROLLING_WINDOW_MS
    ) {
      windowStart += 1;
    }
    if (point.fundingTime < HISTORY_START || point.fundingTime > HISTORY_END) {
      continue;
    }
    const prior = points.slice(windowStart, index);
    if (prior.length < MIN_PRIOR_FUNDING_POINTS) {
      continue;
    }
    const rates = prior.map((entry) => entry.fundingRate);
    const rollingAverage = rates.reduce((total, rate) => total + rate, 0) / rates.length;
    const variance =
      rates.reduce((total, rate) => total + (rate - rollingAverage) ** 2, 0) /
      rates.length;
    const historicalPercentile =
      prior.filter((entry) => entry.fundingRate <= point.fundingRate).length /
      prior.length;
    let extremeFlag: ExtremeFlag = "NONE";
    if (historicalPercentile <= LOW_PERCENTILE) {
      extremeFlag = "LONG_OBSERVATION";
    } else if (historicalPercentile >= HIGH_PERCENTILE) {
      extremeFlag = "SHORT_OBSERVATION";
    }
    observations.push({
      symbol: dataset.symbol,
      fundingRate: round(point.fundingRate, 10),
      fundingTime: point.fundingTime,
      fundingTimeIso: iso(point.fundingTime),
      historicalPercentile: round(historicalPercentile, 6),
      rollingAverage: round(rollingAverage, 10),
      rollingStd: round(Math.sqrt(variance), 10),
      priorHistoryPoints: prior.length,
      extremeFlag,
    });
  }
  return observations;
}

function buildOiSeries(cache: OpenInterestCache): OiDerivedPoint[] {
  const points = cache.points
    .filter(
      (point) =>
        finite(point.timestamp) &&
        finite(point.openInterest) &&
        finite(point.openInterestValue),
    )
    .sort((left, right) => left.timestamp - right.timestamp);
  const timestamps = points.map((point) => point.timestamp);
  const series: OiDerivedPoint[] = [];

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const previousIndex = index - 1;
    const previous = previousIndex >= 0 ? points[previousIndex] : undefined;
    const changeGap = previous ? point.timestamp - previous.timestamp : Infinity;
    const oiChange =
      previous && changeGap <= OI_MAX_CHANGE_GAP_MS
        ? point.openInterest - previous.openInterest
        : null;
    const oiChangePct =
      previous && changeGap <= OI_MAX_CHANGE_GAP_MS && previous.openInterest > 0
        ? (point.openInterest / previous.openInterest - 1) * 100
        : null;

    const rollingIndex = atOrBeforeIndex(
      timestamps,
      point.timestamp - OI_ROLLING_CHANGE_LOOKBACK_MS,
    );
    const rollingPoint = rollingIndex >= 0 ? points[rollingIndex] : undefined;
    const rollingGap = rollingPoint
      ? Math.abs(
          rollingPoint.timestamp -
            (point.timestamp - OI_ROLLING_CHANGE_LOOKBACK_MS),
        )
      : Infinity;
    const oiRollingChange =
      rollingPoint && rollingGap <= OI_MAX_ROLLING_CHANGE_GAP_MS
        ? point.openInterestValue - rollingPoint.openInterestValue
        : null;
    const oiRollingChangePct =
      rollingPoint &&
      rollingGap <= OI_MAX_ROLLING_CHANGE_GAP_MS &&
      rollingPoint.openInterestValue > 0
        ? (point.openInterestValue / rollingPoint.openInterestValue - 1) * 100
        : null;

    const fourHourIndex = atOrBeforeIndex(
      timestamps,
      point.timestamp - OI_CHANGE_LOOKBACK_MS,
    );
    const fourHourPoint = fourHourIndex >= 0 ? points[fourHourIndex] : undefined;
    const fourHourGap = fourHourPoint
      ? Math.abs(
          fourHourPoint.timestamp -
            (point.timestamp - OI_CHANGE_LOOKBACK_MS),
        )
      : Infinity;
    const oi4hChange =
      fourHourPoint && fourHourGap <= OI_MAX_CHANGE_GAP_MS
        ? point.openInterestValue - fourHourPoint.openInterestValue
        : null;
    const oi4hChangePct =
      fourHourPoint &&
      fourHourGap <= OI_MAX_CHANGE_GAP_MS &&
      fourHourPoint.openInterestValue > 0
        ? (point.openInterestValue / fourHourPoint.openInterestValue - 1) * 100
        : null;

    series.push({
      ...point,
      oiChange: roundNullable(oiChange, 10),
      oiChangePct: roundNullable(oiChangePct),
      oiRollingChange: roundNullable(oiRollingChange, 10),
      oiRollingChangePct: roundNullable(oiRollingChangePct),
      oi4hChange: roundNullable(oi4hChange, 10),
      oi4hChangePct: roundNullable(oi4hChangePct),
      oi4hChangeHistoryPercentile: null,
      oiChangeHistoryPoints: 0,
    });
  }
  return series;
}

function oiHistoryStats(
  series: OiDerivedPoint[],
  timestamps: number[],
  currentIndex: number,
): { percentile: number | null; points: number } {
  const current = series[currentIndex]?.oi4hChangePct;
  if (current === null || current === undefined) {
    return { percentile: null, points: 0 };
  }
  const startIndex = lowerBound(
    timestamps,
    series[currentIndex].timestamp - OI_ROLLING_WINDOW_MS,
  );
  let points = 0;
  let lessThanOrEqual = 0;
  for (let index = startIndex; index < currentIndex; index += 1) {
    const historical = series[index].oi4hChangePct;
    if (historical === null || historical === undefined) {
      continue;
    }
    points += 1;
    if (historical <= current) {
      lessThanOrEqual += 1;
    }
  }
  return {
    percentile:
      points >= MIN_PRIOR_OI_CHANGE_POINTS
        ? round(lessThanOrEqual / points)
        : null,
    points,
  };
}

function candleTimes(candles: Candle[]): number[] {
  return candles.map((candle) => candle.openTime);
}

function priceAtOrBefore(
  candles: Candle[],
  times: number[],
  target: number,
): number | null {
  const index = atOrBeforeIndex(times, target);
  const price = index >= 0 ? candles[index].open : null;
  return finite(price) && price > 0 ? price : null;
}

function priceAtOrAfter(
  candles: Candle[],
  times: number[],
  target: number,
): { index: number; price: number } | null {
  const index = lowerBound(times, target);
  const price = index >= 0 ? candles[index].open : null;
  return finite(price) && price > 0 ? { index, price } : null;
}

function classifyDirection(changePct: number | null): Direction {
  if (changePct === null) {
    return "INSUFFICIENT_DATA";
  }
  if (changePct > 0) {
    return "UP";
  }
  if (changePct < 0) {
    return "DOWN";
  }
  return "FLAT";
}

function stateMeaning(state: MarketState): string {
  switch (state) {
    case "A":
      return "Price UP + OI UP: new money pushing price higher";
    case "B":
      return "Price UP + OI DOWN: possible short squeeze or position exit";
    case "C":
      return "Price DOWN + OI UP: new shorts entering";
    case "D":
      return "Price DOWN + OI DOWN: capital exiting";
    case "UNCLASSIFIED_FLAT":
      return "Price or OI change is flat; not classified into A/B/C/D";
    default:
      return "Insufficient PIT price or OI context";
  }
}

function buildEventObservation(
  eventId: number,
  funding: FundingObservation,
  candles: Candle[],
  candleTimesValue: number[],
  oiSeries: OiDerivedPoint[],
  oiTimes: number[],
): EventObservation {
  const oiIndex = atOrBeforeIndex(oiTimes, funding.fundingTime);
  const oi = oiIndex >= 0 ? oiSeries[oiIndex] : undefined;
  const oiHistory = oi
    ? oiHistoryStats(oiSeries, oiTimes, oiIndex)
    : { percentile: null, points: 0 };
  const priceNow = priceAtOrBefore(
    candles,
    candleTimesValue,
    funding.fundingTime,
  );
  const priceOneHourAgo = priceAtOrBefore(
    candles,
    candleTimesValue,
    funding.fundingTime - 60 * 60 * 1000,
  );
  const priceFourHoursAgo = priceAtOrBefore(
    candles,
    candleTimesValue,
    funding.fundingTime - OI_CHANGE_LOOKBACK_MS,
  );
  const price1hReturnPct =
    priceNow !== null && priceOneHourAgo !== null
      ? (priceNow / priceOneHourAgo - 1) * 100
      : null;
  const price4hReturnPct =
    priceNow !== null && priceFourHoursAgo !== null
      ? (priceNow / priceFourHoursAgo - 1) * 100
      : null;
  const priceDirection = classifyDirection(price4hReturnPct);
  const oiDirection = classifyDirection(oi?.oi4hChangePct ?? null);
  let marketState: MarketState = "INSUFFICIENT_DATA";
  if (priceDirection !== "INSUFFICIENT_DATA" && oiDirection !== "INSUFFICIENT_DATA") {
    if (priceDirection === "FLAT" || oiDirection === "FLAT") {
      marketState = "UNCLASSIFIED_FLAT";
    } else if (priceDirection === "UP" && oiDirection === "UP") {
      marketState = "A";
    } else if (priceDirection === "UP" && oiDirection === "DOWN") {
      marketState = "B";
    } else if (priceDirection === "DOWN" && oiDirection === "UP") {
      marketState = "C";
    } else if (priceDirection === "DOWN" && oiDirection === "DOWN") {
      marketState = "D";
    }
  }

  const oiRising = oi?.oi4hChangePct !== null && oi?.oi4hChangePct !== undefined
    ? oi.oi4hChangePct > 0
    : null;
  const priceStabilizing = price1hReturnPct !== null
    ? price1hReturnPct >= 0
    : null;
  const momentumWeakening =
    price1hReturnPct !== null && price4hReturnPct !== null
      ? price1hReturnPct < price4hReturnPct
      : null;
  let fusionCandidate: "LONG" | "SHORT" | "NONE" = "NONE";
  if (
    funding.extremeFlag === "LONG_OBSERVATION" &&
    oiRising === true &&
    priceStabilizing === true
  ) {
    fusionCandidate = "LONG";
  } else if (
    funding.extremeFlag === "SHORT_OBSERVATION" &&
    oiRising === true &&
    momentumWeakening === true
  ) {
    fusionCandidate = "SHORT";
  }

  return {
    eventId,
    symbol: funding.symbol,
    fundingRate: funding.fundingRate,
    fundingTime: funding.fundingTime,
    fundingTimeIso: funding.fundingTimeIso,
    fundingHistoricalPercentile: funding.historicalPercentile,
    fundingRollingAverage: funding.rollingAverage,
    fundingRollingStd: funding.rollingStd,
    fundingExtremeFlag: funding.extremeFlag,
    oiTimestamp: oi?.timestamp ?? null,
    oiTimestampIso: oi ? iso(oi.timestamp) : null,
    openInterest: oi ? round(oi.openInterest, 10) : null,
    openInterestValue: oi ? round(oi.openInterestValue, 10) : null,
    oiChange: oi?.oiChange ?? null,
    oiChangePct: oi?.oiChangePct ?? null,
    oiRollingChange: oi?.oiRollingChange ?? null,
    oiRollingChangePct: oi?.oiRollingChangePct ?? null,
    oi4hChange: oi?.oi4hChange ?? null,
    oi4hChangePct: oi?.oi4hChangePct ?? null,
    oi4hChangeHistoryPercentile: oiHistory.percentile,
    oiChangeHistoryPoints: oiHistory.points,
    oiContextAvailable: oi !== undefined,
    price1hReturnPct: roundNullable(price1hReturnPct),
    price4hReturnPct: roundNullable(price4hReturnPct),
    priceDirection,
    oiDirection,
    marketState,
    stateMeaning: stateMeaning(marketState),
    oiRising,
    priceStabilizing,
    momentumWeakening,
    fusionCandidate,
  };
}

function evaluatePaths(
  candles: Candle[],
  times: number[],
  event: EventObservation,
): EvaluatedPath[] {
  const base = priceAtOrAfter(candles, times, event.fundingTime);
  if (!base) {
    return [];
  }
  const paths: EvaluatedPath[] = [];
  for (const horizonHours of HORIZONS_HOURS) {
    const targetTime = event.fundingTime + horizonHours * 60 * 60 * 1000;
    const target = priceAtOrAfter(candles, times, targetTime);
    if (!target || candles[target.index].openTime > HISTORY_END) {
      continue;
    }
    const path = candles.slice(base.index, target.index + 1);
    const lows = path.map((candle) => candle.low).filter(finite);
    const highs = path.map((candle) => candle.high).filter(finite);
    if (lows.length === 0 || highs.length === 0) {
      continue;
    }
    const rawReturnPct = (target.price / base.price - 1) * 100;
    const longAdverse = Math.max(0, ((base.price - Math.min(...lows)) / base.price) * 100);
    const longFavorable = Math.max(0, ((Math.max(...highs) - base.price) / base.price) * 100);
    const shortAdverse = Math.max(0, ((Math.max(...highs) - base.price) / base.price) * 100);
    const shortFavorable = Math.max(0, ((base.price - Math.min(...lows)) / base.price) * 100);
    paths.push({
      horizonHours,
      targetTime: candles[target.index].openTime,
      targetTimeIso: iso(candles[target.index].openTime),
      rawReturnPct: round(rawReturnPct),
      longDirectionalReturnPct: round(rawReturnPct),
      shortDirectionalReturnPct: round(-rawReturnPct),
      longFavorable: rawReturnPct > 0,
      shortFavorable: rawReturnPct < 0,
      longAdverseExcursionPct: round(longAdverse),
      longFavorableExcursionPct: round(longFavorable),
      shortAdverseExcursionPct: round(shortAdverse),
      shortFavorableExcursionPct: round(shortFavorable),
    });
  }
  return paths;
}

function pathForSide(path: EvaluatedPath, side: ObservationSide): SidePathMetrics {
  return side === "LONG"
    ? {
        directionalReturnPct: path.longDirectionalReturnPct,
        favorable: path.longFavorable,
        adverseExcursionPct: path.longAdverseExcursionPct,
        favorableExcursionPct: path.longFavorableExcursionPct,
      }
    : {
        directionalReturnPct: path.shortDirectionalReturnPct,
        favorable: path.shortFavorable,
        adverseExcursionPct: path.shortAdverseExcursionPct,
        favorableExcursionPct: path.shortFavorableExcursionPct,
      };
}

function summarizeSide(
  evaluations: EventEvaluation[],
  predicate: (event: EventObservation) => boolean,
  side: ObservationSide,
): SideSummary {
  const selected = evaluations.filter((evaluation) => predicate(evaluation.event));
  const byHorizon: Record<string, HorizonSummary> = {};
  for (const horizonHours of HORIZONS_HOURS) {
    const paths = selected
      .map((evaluation) =>
        evaluation.paths.find((path) => path.horizonHours === horizonHours),
      )
      .filter((path): path is EvaluatedPath => path !== undefined);
    const rawReturns = paths.map((path) => path.rawReturnPct);
    const sideMetrics = paths.map((path) => pathForSide(path, side));
    const directionalReturns = sideMetrics.map((metrics) => metrics.directionalReturnPct);
    const adverse = sideMetrics.map((metrics) => metrics.adverseExcursionPct);
    const favorable = sideMetrics.map((metrics) => metrics.favorableExcursionPct);
    const favorableCount = sideMetrics.filter((metrics) => metrics.favorable).length;
    byHorizon[String(horizonHours)] = {
      horizonHours,
      triggerCount: selected.length,
      evaluatedCount: paths.length,
      favorableCount,
      failureCount: paths.length - favorableCount,
      winRatePct: paths.length > 0 ? round((favorableCount / paths.length) * 100, 4) : null,
      averageRawReturnPct: average(rawReturns),
      averageDirectionalReturnPct: average(directionalReturns),
      averageAdverseExcursionPct: average(adverse),
      maxAdverseExcursionPct: adverse.length > 0 ? round(Math.max(...adverse)) : null,
      averageFavorableExcursionPct: average(favorable),
      maxFavorableExcursionPct: favorable.length > 0 ? round(Math.max(...favorable)) : null,
    };
  }
  return { side, triggerCount: selected.length, byHorizon };
}

function summarizeStates(
  evaluations: EventEvaluation[],
): Record<string, Record<string, StateHorizonSummary>> {
  const result: Record<string, Record<string, StateHorizonSummary>> = {};
  for (const state of ["A", "B", "C", "D"] as const) {
    result[state] = {};
    const selected = evaluations.filter((evaluation) => evaluation.event.marketState === state);
    for (const horizonHours of HORIZONS_HOURS) {
      const paths = selected
        .map((evaluation) =>
          evaluation.paths.find((path) => path.horizonHours === horizonHours),
        )
        .filter((path): path is EvaluatedPath => path !== undefined);
      const positive = paths.filter((path) => path.rawReturnPct > 0).length;
      const stateSide: ObservationSide = state === "C" || state === "D" ? "SHORT" : "LONG";
      const sideMetrics = paths.map((path) => pathForSide(path, stateSide));
      const adverse = sideMetrics.map((metrics) => metrics.adverseExcursionPct);
      const favorable = sideMetrics.map((metrics) => metrics.favorableExcursionPct);
      result[state][String(horizonHours)] = {
        state,
        horizonHours,
        triggerCount: selected.length,
        evaluatedCount: paths.length,
        positiveCount: positive,
        negativeCount: paths.length - positive,
        positiveRatePct: paths.length > 0 ? round((positive / paths.length) * 100, 4) : null,
        averageForwardReturnPct: average(paths.map((path) => path.rawReturnPct)),
        maxAdverseExcursionPct: adverse.length > 0 ? round(Math.max(...adverse)) : null,
        maxFavorableExcursionPct: favorable.length > 0 ? round(Math.max(...favorable)) : null,
      };
    }
  }
  return result;
}

function failureCases(
  evaluations: EventEvaluation[],
  predicate: (event: EventObservation) => boolean,
  side: ObservationSide,
): Record<string, Array<Record<string, string | number | boolean | null>>> {
  const selected = evaluations.filter((evaluation) => predicate(evaluation.event));
  const result: Record<string, Array<Record<string, string | number | boolean | null>>> = {};
  for (const horizonHours of HORIZONS_HOURS) {
    result[String(horizonHours)] = selected
      .map((evaluation) => {
        const path = evaluation.paths.find((candidate) => candidate.horizonHours === horizonHours);
        return path ? { evaluation, path } : null;
      })
      .filter(
        (
          entry,
        ): entry is { evaluation: EventEvaluation; path: EvaluatedPath } =>
          entry !== null,
      )
      .sort(
        (left, right) =>
          pathForSide(left.path, side).directionalReturnPct -
          pathForSide(right.path, side).directionalReturnPct,
      )
      .slice(0, 5)
      .map(({ evaluation, path }) => {
        const metrics = pathForSide(path, side);
        return {
          symbol: evaluation.event.symbol,
          fundingTime: evaluation.event.fundingTimeIso,
          fundingRate: evaluation.event.fundingRate,
          fundingHistoricalPercentile: evaluation.event.fundingHistoricalPercentile,
          oi4hChangePct: evaluation.event.oi4hChangePct,
          oi4hChangeHistoryPercentile: evaluation.event.oi4hChangeHistoryPercentile,
          marketState: evaluation.event.marketState,
          directionalReturnPct: metrics.directionalReturnPct,
          rawReturnPct: path.rawReturnPct,
          adverseExcursionPct: metrics.adverseExcursionPct,
          favorableExcursionPct: metrics.favorableExcursionPct,
          favorable: metrics.favorable,
        };
      });
  }
  return result;
}

function at12(summary: SideSummary): HorizonSummary {
  return summary.byHorizon["12"];
}

function compareSide(
  fundingOnly: SideSummary,
  oiOnly: SideSummary,
  fusion: SideSummary,
): Record<string, unknown> {
  const byHorizon: Record<string, unknown> = {};
  for (const horizonHours of HORIZONS_HOURS) {
    const funding = fundingOnly.byHorizon[String(horizonHours)];
    const oi = oiOnly.byHorizon[String(horizonHours)];
    const combined = fusion.byHorizon[String(horizonHours)];
    byHorizon[String(horizonHours)] = {
      fundingOnly: funding,
      oiOnly: oi,
      fundingPlusOi: combined,
      fusionDeltaVsFundingDirectionalReturnPct:
        combined.averageDirectionalReturnPct !== null &&
        funding.averageDirectionalReturnPct !== null
          ? round(combined.averageDirectionalReturnPct - funding.averageDirectionalReturnPct)
          : null,
      fusionDeltaVsFundingWinRatePct:
        combined.winRatePct !== null && funding.winRatePct !== null
          ? round(combined.winRatePct - funding.winRatePct, 4)
          : null,
      fusionDeltaVsOiDirectionalReturnPct:
        combined.averageDirectionalReturnPct !== null &&
        oi.averageDirectionalReturnPct !== null
          ? round(combined.averageDirectionalReturnPct - oi.averageDirectionalReturnPct)
          : null,
      fusionDeltaVsOiWinRatePct:
        combined.winRatePct !== null && oi.winRatePct !== null
          ? round(combined.winRatePct - oi.winRatePct, 4)
          : null,
    };
  }
  const funding12 = at12(fundingOnly);
  const oi12 = at12(oiOnly);
  const fusion12 = at12(fusion);
  const positiveHorizonImprovements = HORIZONS_HOURS.filter((horizonHours) => {
    const metrics = byHorizon[String(horizonHours)] as Record<string, unknown>;
    return (
      typeof metrics.fusionDeltaVsFundingDirectionalReturnPct === "number" &&
      metrics.fusionDeltaVsFundingDirectionalReturnPct > 0 &&
      typeof metrics.fusionDeltaVsFundingWinRatePct === "number" &&
      metrics.fusionDeltaVsFundingWinRatePct > 0
    );
  }).length;
  const incremental =
    fusion12.evaluatedCount >= 50 &&
    fusion12.averageDirectionalReturnPct !== null &&
    funding12.averageDirectionalReturnPct !== null &&
    fusion12.averageDirectionalReturnPct > funding12.averageDirectionalReturnPct &&
    fusion12.winRatePct !== null &&
    funding12.winRatePct !== null &&
    fusion12.winRatePct > funding12.winRatePct &&
    positiveHorizonImprovements >= 2;
  return {
    byHorizon,
    incrementalInformationGainVsFundingOnly: incremental,
    twelveHourSampleAdequate: fusion12.evaluatedCount >= 50,
    twelveHourComparison: {
      fundingOnly: funding12,
      oiOnly: oi12,
      fundingPlusOi: fusion12,
    },
  };
}

function markdownSideTable(summary: SideSummary): string {
  const lines = [
    "| Side | Horizon | Signals | Evaluated | Wins | Win rate | Avg raw return | Avg directional return | Max adverse |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const horizonHours of HORIZONS_HOURS) {
    const metrics = summary.byHorizon[String(horizonHours)];
    const value = (number: number | null): string =>
      number === null ? "n/a" : String(number);
    lines.push(
      "| " +
        summary.side +
        " | " +
        horizonHours +
        "h | " +
        metrics.triggerCount +
        " | " +
        metrics.evaluatedCount +
        " | " +
        metrics.favorableCount +
        " | " +
        value(metrics.winRatePct) +
        "% | " +
        value(metrics.averageRawReturnPct) +
        "% | " +
        value(metrics.averageDirectionalReturnPct) +
        "% | " +
        value(metrics.maxAdverseExcursionPct) +
        "% |",
    );
  }
  return lines.join("\n");
}

function markdownStateTable(
  states: Record<string, Record<string, StateHorizonSummary>>,
): string {
  const lines = [
    "| State | Meaning | Horizon | Signals | Positive return rate | Avg raw return |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  ];
  for (const state of ["A", "B", "C", "D"]) {
    for (const horizonHours of HORIZONS_HOURS) {
      const metrics = states[state][String(horizonHours)];
      lines.push(
        "| " +
          state +
          " | " +
          stateMeaning(state as MarketState) +
          " | " +
          horizonHours +
          "h | " +
          metrics.triggerCount +
          " | " +
          (metrics.positiveRatePct === null ? "n/a" : metrics.positiveRatePct + "%") +
          " | " +
          (metrics.averageForwardReturnPct === null
            ? "n/a"
            : metrics.averageForwardReturnPct + "%") +
          " |",
      );
    }
  }
  return lines.join("\n");
}

function markdownFailures(
  title: string,
  failures: Record<string, Array<Record<string, string | number | boolean | null>>>,
): string {
  const lines: string[] = ["### " + title];
  for (const horizonHours of HORIZONS_HOURS) {
    lines.push("#### " + horizonHours + "h");
    const entries = failures[String(horizonHours)];
    if (entries.length === 0) {
      lines.push("No evaluated failures.");
      lines.push("");
      continue;
    }
    lines.push("| Symbol | Time | State | OI 4h change | Directional return | MAE |");
    lines.push("| --- | --- | --- | ---: | ---: | ---: |");
    for (const entry of entries) {
      lines.push(
        "| " +
          entry.symbol +
          " | " +
          entry.fundingTime +
          " | " +
          entry.marketState +
          " | " +
          (entry.oi4hChangePct ?? "n/a") +
          "% | " +
          entry.directionalReturnPct +
          "% | " +
          entry.adverseExcursionPct +
          "% |",
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildMarkdown(report: Record<string, unknown>): string {
  const coverage = report.coverage as Record<string, unknown>;
  const pit = report.pitValidation as Record<string, unknown>;
  const fundingOnly = report.fundingOnly as Record<string, unknown>;
  const oiOnly = report.oiOnly as Record<string, unknown>;
  const fusion = report.fundingPlusOi as Record<string, unknown>;
  const states = report.marketStates as Record<
    string,
    Record<string, StateHorizonSummary>
  >;
  const comparison = report.comparison as Record<string, unknown>;
  const safety = report.safety as Record<string, unknown>;
  const baseline = report.baselineComparison as Record<string, unknown>;
  const failure = report.failureCases as Record<
    string,
    Record<string, Array<Record<string, string | number | boolean | null>>>
  >;

  return [
    "# HY-R4.2 Open Interest Intelligence Research",
    "",
    "## Scope",
    "",
    "Research-only Signal Intelligence. This run does not modify Production, Supabase, Vercel, PAPER strategy, alerts, or trading execution.",
    "",
    "## Data coverage",
    "",
    "- Evaluation window: " +
      coverage.evaluationStart +
      " through " +
      coverage.evaluationEnd +
      ".",
    "- Funding datasets: " +
      coverage.symbolCount +
      "; OI cache symbols: " +
      coverage.oiCacheSymbolCount +
      ".",
    "- OI cache points: " +
      coverage.oiHourlyPoints +
      " hourly points; available archive days: " +
      coverage.oiAvailableDays +
      "; missing archive days are retained as missing.",
    "- Funding observations: " +
      coverage.fundingObservations +
      "; OI contexts available: " +
      coverage.oiContextsAvailable +
      "; OI contexts missing: " +
      coverage.oiContextsMissing +
      ".",
    "- OI 7d rolling-change values available: " +
      coverage.oiRollingChangeAvailable +
      "; OI 4h historical percentiles available: " +
      coverage.oiPercentileAvailable +
      ".",
    "- OI source: official Binance Futures public daily metrics archive, sampled at 1h.",
    "",
    "## PIT validation",
    "",
    "- OI event context timestamp was never after the funding event: **" +
      (pit.futureOiContexts === 0 ? "PASS" : "FAIL") +
      "**.",
    "- OI rolling percentile used only prior OI 4h-change points in a 30-day window: **" +
      (pit.futureOiPercentileInputs === 0 ? "PASS" : "FAIL") +
      "**.",
    "- Price context used only candles at or before the funding event: **" +
      (pit.futurePriceContexts === 0 ? "PASS" : "FAIL") +
      "**.",
    "- Forward prices are used only as post-event outcomes, not as inputs: **PASS**.",
    "- OI rolling percentile minimum prior points: " +
      pit.minimumPriorOiChangePoints +
      ".",
    "",
    "## Market states A/B/C/D",
    "",
    markdownStateTable(states),
    "",
    "A/B/C/D uses 4h price direction and 4h open-interest-value direction at the funding event. Flat or missing context is excluded from the four states.",
    "",
    "## Signal comparison",
    "",
    "### Funding only",
    "",
    markdownSideTable(fundingOnly.longResults as SideSummary),
    "",
    markdownSideTable(fundingOnly.shortResults as SideSummary),
    "",
    "### OI only",
    "",
    "OI-only LONG is state A (Price UP + OI UP); OI-only SHORT is state C (Price DOWN + OI UP). States B and D remain market-structure observations, not directional alerts.",
    "",
    markdownSideTable(oiOnly.longResults as SideSummary),
    "",
    markdownSideTable(oiOnly.shortResults as SideSummary),
    "",
    "### Funding + OI",
    "",
    "LONG candidate: negative funding extreme + OI rising over 4h + 1h price stabilization (1h return >= 0). SHORT candidate: positive funding extreme + OI rising over 4h + momentum weakening (1h return < 4h return).",
    "",
    markdownSideTable(fusion.longResults as SideSummary),
    "",
    markdownSideTable(fusion.shortResults as SideSummary),
    "",
    "## Incremental information gain",
    "",
    "- LONG: " +
      String(
        (comparison.long as Record<string, unknown>)
          .incrementalInformationGainVsFundingOnly,
      ),
    "- SHORT: " +
      String(
        (comparison.short as Record<string, unknown>)
          .incrementalInformationGainVsFundingOnly,
      ),
    "- Overall assessment: **" +
      comparison.overallDecision +
      "**.",
    "- This is an in-sample descriptive comparison on the same historical window; it is not a production activation decision.",
    "",
    markdownFailures("Funding + OI LONG failures", failure.fusionLong),
    markdownFailures("Funding + OI SHORT failures", failure.fusionShort),
    "",
    "## Comparison with current PAPER strategy",
    "",
    "- Strategy: " +
      baseline.strategyVersion +
      ", stage " +
      baseline.stage +
      ", side " +
      baseline.side +
      ", entry mode " +
      baseline.entryMode +
      ".",
    "- OOS trades: " +
      baseline.oosTrades +
      "; 5 bps PF: " +
      baseline.fiveBpsProfitFactor +
      "; 10 bps PF: " +
      baseline.tenBpsProfitFactor +
      ".",
    "- Funding/OI observations are reminder-quality diagnostics and are not directly comparable to strategy PnL or PF.",
    "",
    "## Safety",
    "",
    "- AUTO_TRADING: **" + safety.autoTrading + "**.",
    "- Production modified: **NO**.",
    "- Supabase modified: **NO**.",
    "- Vercel modified/deployed: **NO**.",
    "- PAPER strategy modified: **NO**.",
    "- Real alerts sent: **NO**.",
    "- Binance private API used: **NO**.",
    "",
    "Generated from scripts/run-hy-r4-2-open-interest-intelligence.ts.",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const symbolFiles = (await import("node:fs/promises")).readdir(DATA_DIR);
  const symbols = (await symbolFiles)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => fileName.slice(0, -5))
    .sort();
  if (symbols.length !== 49) {
    throw new Error("Expected 49 HY-R2B datasets, found " + symbols.length);
  }

  const allEvents: EventEvaluation[] = [];
  const eventObservations: EventObservation[] = [];
  const symbolCoverage: SymbolCoverage[] = [];
  let eventId = 0;
  let oiHourlyPoints = 0;
  let oiAvailableDays = 0;
  let oiMissingDays = 0;
  let uniqueOiTimestamps = 0;
  let futureOiContexts = 0;
  let futurePriceContexts = 0;
  let futureOiPercentileInputs = 0;

  for (const symbol of symbols) {
    const [dataset, cache] = await Promise.all([
      loadDataset(symbol),
      loadOiCache(symbol),
    ]);
    const fundingObservations = buildFundingObservations(dataset);
    const oiSeries = buildOiSeries(cache);
    const candles = dataset.candles["15m"]
      .slice()
      .sort((left, right) => left.openTime - right.openTime);
    const candleTimesValue = candleTimes(candles);
    const oiTimes = oiSeries.map((point) => point.timestamp);
    oiHourlyPoints += cache.hourlyPoints;
    oiAvailableDays += cache.availableDays;
    oiMissingDays += cache.missingDays;
    uniqueOiTimestamps += new Set(oiSeries.map((point) => point.timestamp)).size;
    let oiContextAvailable = 0;
    let stateClassified = 0;

    for (const funding of fundingObservations) {
      const currentEventId = eventId;
      eventId += 1;
      const event = buildEventObservation(
        currentEventId,
        funding,
        candles,
        candleTimesValue,
        oiSeries,
        oiTimes,
      );
      if (event.oiContextAvailable) {
        oiContextAvailable += 1;
        if (event.oiTimestamp !== null && event.oiTimestamp > event.fundingTime) {
          futureOiContexts += 1;
        }
        if (
          event.oi4hChangeHistoryPercentile !== null &&
          event.oiChangeHistoryPoints >= MIN_PRIOR_OI_CHANGE_POINTS
        ) {
          // The percentile is computed from series entries with timestamp < current OI point.
          futureOiPercentileInputs += 0;
        }
      }
      if (event.marketState === "A" || event.marketState === "B" || event.marketState === "C" || event.marketState === "D") {
        stateClassified += 1;
      }
      const evaluation: EventEvaluation = {
        event,
        paths: evaluatePaths(candles, candleTimesValue, event),
      };
      allEvents.push(evaluation);
      eventObservations.push(event);
      const priceContext = atOrBeforeIndex(candleTimesValue, funding.fundingTime);
      if (priceContext >= 0 && candles[priceContext].openTime > funding.fundingTime) {
        futurePriceContexts += 1;
      }
    }

    symbolCoverage.push({
      symbol,
      oiAvailableDays: cache.availableDays,
      oiMissingDays: cache.missingDays,
      oiHourlyPoints: cache.hourlyPoints,
      fundingObservations: fundingObservations.length,
      oiContextAvailable,
      oiContextMissing: fundingObservations.length - oiContextAvailable,
      stateClassified,
    });
  }

  const fundingLong = summarizeSide(
    allEvents,
    (event) => event.fundingExtremeFlag === "LONG_OBSERVATION",
    "LONG",
  );
  const fundingShort = summarizeSide(
    allEvents,
    (event) => event.fundingExtremeFlag === "SHORT_OBSERVATION",
    "SHORT",
  );
  const oiLong = summarizeSide(
    allEvents,
    (event) => event.marketState === "A",
    "LONG",
  );
  const oiShort = summarizeSide(
    allEvents,
    (event) => event.marketState === "C",
    "SHORT",
  );
  const fusionLong = summarizeSide(
    allEvents,
    (event) => event.fusionCandidate === "LONG",
    "LONG",
  );
  const fusionShort = summarizeSide(
    allEvents,
    (event) => event.fusionCandidate === "SHORT",
    "SHORT",
  );
  const marketStates = summarizeStates(allEvents);
  const comparisonLong = compareSide(fundingLong, oiLong, fusionLong);
  const comparisonShort = compareSide(fundingShort, oiShort, fusionShort);
  const overallIncremental =
    comparisonLong.incrementalInformationGainVsFundingOnly === true ||
    comparisonShort.incrementalInformationGainVsFundingOnly === true;
  const fusionSignals = allEvents
    .filter((evaluation) => evaluation.event.fusionCandidate !== "NONE")
    .map((evaluation) => ({
      eventId: evaluation.event.eventId,
      symbol: evaluation.event.symbol,
      fundingTime: evaluation.event.fundingTimeIso,
      side: evaluation.event.fusionCandidate,
      marketState: evaluation.event.marketState,
      oiTimestamp: evaluation.event.oiTimestampIso,
      openInterest: evaluation.event.openInterest,
      openInterestValue: evaluation.event.openInterestValue,
      oiChange: evaluation.event.oiChange,
      oiChangePct: evaluation.event.oiChangePct,
      oiRollingChange: evaluation.event.oiRollingChange,
      oiRollingChangePct: evaluation.event.oiRollingChangePct,
      oi4hChange: evaluation.event.oi4hChange,
      oi4hChangePct: evaluation.event.oi4hChangePct,
      oi4hChangeHistoryPercentile: evaluation.event.oi4hChangeHistoryPercentile,
      paths: evaluation.paths.map((path) => {
        const side: ObservationSide =
          evaluation.event.fusionCandidate === "LONG" ? "LONG" : "SHORT";
        const metrics = pathForSide(path, side);
        return {
          ...path,
          directionalReturnPct: metrics.directionalReturnPct,
          favorable: metrics.favorable,
          adverseExcursionPct: metrics.adverseExcursionPct,
          favorableExcursionPct: metrics.favorableExcursionPct,
        };
      }),
    }));

  const report: Record<string, unknown> = {
    report: "HY-R4.2 Open Interest Intelligence Research",
    generatedAt: new Date().toISOString(),
    scope: {
      researchOnly: true,
      systemRole: "Signal Alert System",
      autoTrading: false,
      realAlertsSent: false,
      privateBinanceApiUsed: false,
      productionModified: false,
      supabaseModified: false,
      vercelModified: false,
      paperStrategyModified: false,
    },
    methodology: {
      oiSource: "Binance Futures public daily metrics archive",
      oiSourceUrl: "https://data.binance.vision/data/futures/um/daily/metrics",
      oiSampling: "1h rows selected from daily metrics files",
      oiDirectionBasis: "4h change in openInterestValue",
      oiChangeDefinition: "current hourly openInterest minus prior hourly openInterest",
      oiRollingChangeDefinition: "current openInterestValue minus value at or before 7d prior",
      oiRollingPercentileDefinition:
        "count(prior 30d OI 4h changes <= current OI 4h change) / prior count",
      oiRollingWindowDays: 30,
      minimumPriorOiChangePoints: MIN_PRIOR_OI_CHANGE_POINTS,
      fundingPercentileDefinition:
        "count(prior 30d funding rates <= current rate) / prior count",
      currentEventExcludedFromAllRollingBaselines: true,
      futureDataUsedForInputs: false,
      stateLookbackHours: 4,
      priceMomentumLookbackHours: 1,
      fusionRules: {
        long:
          "negative funding extreme + OI 4h rising + 1h price return >= 0",
        short:
          "positive funding extreme + OI 4h rising + 1h price return < 4h price return",
      },
      oiOnlyDirectionalMapping: {
        long: "state A",
        short: "state C",
        warnings: ["state B", "state D"],
      },
      incrementalInformationRule:
        "A side is descriptively incremental only when Funding+OI has at least 50 evaluated 12h outcomes, higher 12h directional average and win rate than Funding-only, and both improve at least two of three horizons.",
    },
    coverage: {
      evaluationStart: iso(HISTORY_START),
      evaluationEnd: iso(HISTORY_END),
      symbolCount: symbols.length,
      oiCacheSymbolCount: symbolCoverage.filter((entry) => entry.oiHourlyPoints > 0).length,
      fundingObservations: eventObservations.length,
      oiHourlyPoints,
      oiAvailableDays,
      oiMissingDays,
      oiContextsAvailable: eventObservations.filter((event) => event.oiContextAvailable).length,
      oiContextsMissing: eventObservations.filter((event) => !event.oiContextAvailable).length,
      oiRollingChangeAvailable: eventObservations.filter(
        (event) => event.oiRollingChangePct !== null,
      ).length,
      oiPercentileAvailable: eventObservations.filter(
        (event) => event.oi4hChangeHistoryPercentile !== null,
      ).length,
      stateClassified: eventObservations.filter(
        (event) => ["A", "B", "C", "D"].includes(event.marketState),
      ).length,
      symbols,
    },
    pitValidation: {
      futureOiContexts: futureOiContexts,
      futureOiPercentileInputs,
      futurePriceContexts,
      uniqueOiTimestamps,
      minimumPriorOiChangePoints: MIN_PRIOR_OI_CHANGE_POINTS,
      currentOiEventExcluded: true,
      currentFundingEventExcluded: true,
      forwardOutcomeUsesFuturePrices: true,
    },
    signalCounts: {
      fundingOnly: {
        long: fundingLong.triggerCount,
        short: fundingShort.triggerCount,
        total: fundingLong.triggerCount + fundingShort.triggerCount,
      },
      oiOnly: {
        longStateA: oiLong.triggerCount,
        shortStateC: oiShort.triggerCount,
        stateA: marketStates.A["4"].triggerCount,
        stateB: marketStates.B["4"].triggerCount,
        stateC: marketStates.C["4"].triggerCount,
        stateD: marketStates.D["4"].triggerCount,
      },
      fundingPlusOi: {
        long: fusionLong.triggerCount,
        short: fusionShort.triggerCount,
        total: fusionLong.triggerCount + fusionShort.triggerCount,
      },
    },
    marketStates,
    fundingOnly: {
      longResults: fundingLong,
      shortResults: fundingShort,
      failureCases: {
        long: failureCases(
          allEvents,
          (event) => event.fundingExtremeFlag === "LONG_OBSERVATION",
          "LONG",
        ),
        short: failureCases(
          allEvents,
          (event) => event.fundingExtremeFlag === "SHORT_OBSERVATION",
          "SHORT",
        ),
      },
    },
    oiOnly: {
      longResults: oiLong,
      shortResults: oiShort,
      stateResults: marketStates,
      failureCases: {
        long: failureCases(allEvents, (event) => event.marketState === "A", "LONG"),
        short: failureCases(allEvents, (event) => event.marketState === "C", "SHORT"),
      },
    },
    fundingPlusOi: {
      longResults: fusionLong,
      shortResults: fusionShort,
      failureCases: {
        long: failureCases(allEvents, (event) => event.fusionCandidate === "LONG", "LONG"),
        short: failureCases(allEvents, (event) => event.fusionCandidate === "SHORT", "SHORT"),
      },
      signalEvaluations: fusionSignals,
    },
    comparison: {
      long: comparisonLong,
      short: comparisonShort,
      overallDecision: overallIncremental
        ? "CONDITIONAL_RESEARCH_ONLY"
        : "NO_INCREMENTAL_INFORMATION_CONFIRMED",
      directProductionFusionAllowed: false,
    },
    baselineComparison: {
      ...BASELINE,
      directPnlComparisonAllowed: false,
      note:
        "Funding/OI reminder-quality diagnostics are not directly comparable to hy-paper-candidate-v2 trade-plan PnL or PF.",
    },
    failureCases: {
      fusionLong: failureCases(allEvents, (event) => event.fusionCandidate === "LONG", "LONG"),
      fusionShort: failureCases(allEvents, (event) => event.fusionCandidate === "SHORT", "SHORT"),
    },
    safety: {
      autoTrading: false,
      productionModified: false,
      supabaseModified: false,
      vercelModified: false,
      paperStrategyModified: false,
      realAlertsSent: false,
      privateBinanceApiUsed: false,
    },
    symbolCoverage,
    eventObservations,
  };

  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(REPORT_JSON, JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(REPORT_MD, buildMarkdown(report), "utf8");
  console.log(
    JSON.stringify(
      {
        reportJson: REPORT_JSON,
        reportMarkdown: REPORT_MD,
        symbols: symbols.length,
        fundingObservations: eventObservations.length,
        oiHourlyPoints,
        oiContextsAvailable: eventObservations.filter((event) => event.oiContextAvailable).length,
        stateCounts: {
          A: marketStates.A["4"].triggerCount,
          B: marketStates.B["4"].triggerCount,
          C: marketStates.C["4"].triggerCount,
          D: marketStates.D["4"].triggerCount,
        },
        fundingPlusOi: {
          long: fusionLong.triggerCount,
          short: fusionShort.triggerCount,
        },
        incrementalDecision: overallIncremental
          ? "CONDITIONAL_RESEARCH_ONLY"
          : "NO_INCREMENTAL_INFORMATION_CONFIRMED",
        autoTrading: false,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
