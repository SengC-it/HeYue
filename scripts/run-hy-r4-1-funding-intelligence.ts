import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Candle, FundingRatePoint } from "../lib/core/types";

const DATA_DIR = join(process.cwd(), "data", "hy-r2b-history-24m");
const REPORT_DIR = join(process.cwd(), "reports");
const REPORT_JSON = join(REPORT_DIR, "hy-r4.1-funding-intelligence.json");
const REPORT_MD = join(REPORT_DIR, "hy-r4.1-funding-intelligence.md");

const HISTORY_START = Date.parse("2024-08-09T00:00:00.000Z");
const HISTORY_END = Date.parse("2026-08-09T23:59:59.999Z");
const ROLLING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_PRIOR_POINTS = 30;
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

interface HistoricalDataset {
  symbol: string;
  exchange: string;
  interval: string;
  startTime: number;
  endTime: number;
  candles: Record<string, Candle[]>;
  fundingRates: FundingRatePoint[];
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

interface EvaluatedPath {
  horizonHours: number;
  targetTime: number;
  targetTimeIso: string;
  rawReturnPct: number;
  directionalReturnPct: number;
  favorable: boolean;
  adverseExcursionPct: number;
  favorableExcursionPct: number;
  baseCandleDelayMinutes: number;
  targetCandleDelayMinutes: number;
}

interface SignalEvaluation {
  observation: FundingObservation;
  side: ObservationSide;
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

interface SymbolCoverage {
  symbol: string;
  rawFundingPoints: number;
  evaluationFundingPoints: number;
  eligibleObservations: number;
  longTriggers: number;
  shortTriggers: number;
  firstFundingTimeIso: string | null;
  lastFundingTimeIso: string | null;
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function assertDataset(dataset: HistoricalDataset, fileName: string): void {
  if (!dataset.symbol || !Array.isArray(dataset.fundingRates)) {
    throw new Error("Invalid historical dataset: " + fileName);
  }
  const candles = dataset.candles?.["15m"];
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error("Missing 15m candles: " + fileName);
  }
}

async function loadDatasets(): Promise<HistoricalDataset[]> {
  const files = (await readdir(DATA_DIR))
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    throw new Error("No historical datasets found in " + DATA_DIR);
  }

  const datasets: HistoricalDataset[] = [];
  for (const fileName of files) {
    const filePath = join(DATA_DIR, fileName);
    const dataset = JSON.parse(await readFile(filePath, "utf8")) as HistoricalDataset;
    assertDataset(dataset, fileName);
    datasets.push(dataset);
  }
  return datasets;
}

function fundingPointsForDataset(dataset: HistoricalDataset): FundingRatePoint[] {
  return dataset.fundingRates
    .filter((point) => isFiniteNumber(point.fundingTime) && isFiniteNumber(point.fundingRate))
    .sort((left, right) => left.fundingTime - right.fundingTime);
}

function buildFundingObservations(
  dataset: HistoricalDataset,
): { observations: FundingObservation[]; coverage: SymbolCoverage } {
  const points = fundingPointsForDataset(dataset);
  const observations: FundingObservation[] = [];
  let windowStart = 0;
  let evaluationFundingPoints = 0;

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    while (
      windowStart < index &&
      points[windowStart].fundingTime < point.fundingTime - ROLLING_WINDOW_MS
    ) {
      windowStart += 1;
    }

    if (point.fundingTime < HISTORY_START || point.fundingTime > HISTORY_END) {
      continue;
    }
    evaluationFundingPoints += 1;

    const prior = points.slice(windowStart, index);
    if (prior.length < MIN_PRIOR_POINTS) {
      continue;
    }

    const rates = prior.map((entry) => entry.fundingRate);
    const sum = rates.reduce((total, rate) => total + rate, 0);
    const rollingAverage = sum / rates.length;
    const variance =
      rates.reduce((total, rate) => total + (rate - rollingAverage) ** 2, 0) / rates.length;
    const historicalPercentile =
      prior.filter((entry) => entry.fundingRate <= point.fundingRate).length / prior.length;

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

  const longTriggers = observations.filter(
    (observation) => observation.extremeFlag === "LONG_OBSERVATION",
  ).length;
  const shortTriggers = observations.filter(
    (observation) => observation.extremeFlag === "SHORT_OBSERVATION",
  ).length;
  const evaluationPoints = points.filter(
    (point) => point.fundingTime >= HISTORY_START && point.fundingTime <= HISTORY_END,
  );

  return {
    observations,
    coverage: {
      symbol: dataset.symbol,
      rawFundingPoints: points.length,
      evaluationFundingPoints,
      eligibleObservations: observations.length,
      longTriggers,
      shortTriggers,
      firstFundingTimeIso: evaluationPoints.length > 0 ? iso(evaluationPoints[0].fundingTime) : null,
      lastFundingTimeIso:
        evaluationPoints.length > 0 ? iso(evaluationPoints[evaluationPoints.length - 1].fundingTime) : null,
    },
  };
}

function lowerBoundCandle(candles: Candle[], targetTime: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].openTime < targetTime) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low < candles.length ? low : -1;
}

function evaluatePaths(
  candles: Candle[],
  observation: FundingObservation,
): EvaluatedPath[] {
  const baseIndex = lowerBoundCandle(candles, observation.fundingTime);
  if (baseIndex < 0 || !isFiniteNumber(candles[baseIndex].open) || candles[baseIndex].open <= 0) {
    return [];
  }

  const baseCandle = candles[baseIndex];
  const basePrice = baseCandle.open;
  const paths: EvaluatedPath[] = [];

  for (const horizonHours of HORIZONS_HOURS) {
    const targetTime = observation.fundingTime + horizonHours * 60 * 60 * 1000;
    const targetIndex = lowerBoundCandle(candles, targetTime);
    if (targetIndex < 0 || candles[targetIndex].openTime > HISTORY_END) {
      continue;
    }
    const targetCandle = candles[targetIndex];
    if (!isFiniteNumber(targetCandle.open) || targetCandle.open <= 0) {
      continue;
    }

    const path = candles.slice(baseIndex, targetIndex + 1);
    const lows = path
      .map((candle) => candle.low)
      .filter(isFiniteNumber);
    const highs = path
      .map((candle) => candle.high)
      .filter(isFiniteNumber);
    if (lows.length === 0 || highs.length === 0) {
      continue;
    }

    const rawReturnPct = (targetCandle.open / basePrice - 1) * 100;
    const directionalReturnPct =
      observation.extremeFlag === "LONG_OBSERVATION" ? rawReturnPct : -rawReturnPct;
    const longAdversePct = Math.max(0, ((basePrice - Math.min(...lows)) / basePrice) * 100);
    const longFavorablePct = Math.max(0, ((Math.max(...highs) - basePrice) / basePrice) * 100);
    const shortAdversePct = Math.max(0, ((Math.max(...highs) - basePrice) / basePrice) * 100);
    const shortFavorablePct = Math.max(0, ((basePrice - Math.min(...lows)) / basePrice) * 100);

    paths.push({
      horizonHours,
      targetTime: targetCandle.openTime,
      targetTimeIso: iso(targetCandle.openTime),
      rawReturnPct: round(rawReturnPct, 6),
      directionalReturnPct: round(directionalReturnPct, 6),
      favorable: directionalReturnPct > 0,
      adverseExcursionPct: round(
        observation.extremeFlag === "LONG_OBSERVATION" ? longAdversePct : shortAdversePct,
        6,
      ),
      favorableExcursionPct: round(
        observation.extremeFlag === "LONG_OBSERVATION" ? longFavorablePct : shortFavorablePct,
        6,
      ),
      baseCandleDelayMinutes: round((baseCandle.openTime - observation.fundingTime) / 60000, 6),
      targetCandleDelayMinutes: round((targetCandle.openTime - targetTime) / 60000, 6),
    });
  }
  return paths;
}

function average(values: number[]): number | null {
  return values.length > 0
    ? round(values.reduce((total, value) => total + value, 0) / values.length, 6)
    : null;
}

function summarizeSide(
  signals: SignalEvaluation[],
  side: ObservationSide,
): SideSummary {
  const sideSignals = signals.filter((signal) => signal.side === side);
  const byHorizon: Record<string, HorizonSummary> = {};

  for (const horizonHours of HORIZONS_HOURS) {
    const paths = sideSignals
      .map((signal) => signal.paths.find((path) => path.horizonHours === horizonHours))
      .filter((path): path is EvaluatedPath => path !== undefined);
    const rawReturns = paths.map((path) => path.rawReturnPct);
    const directionalReturns = paths.map((path) => path.directionalReturnPct);
    const adverseExcursions = paths.map((path) => path.adverseExcursionPct);
    const favorableExcursions = paths.map((path) => path.favorableExcursionPct);
    const favorableCount = paths.filter((path) => path.favorable).length;

    byHorizon[String(horizonHours)] = {
      horizonHours,
      triggerCount: sideSignals.length,
      evaluatedCount: paths.length,
      favorableCount,
      failureCount: paths.length - favorableCount,
      winRatePct: paths.length > 0 ? round((favorableCount / paths.length) * 100, 4) : null,
      averageRawReturnPct: average(rawReturns),
      averageDirectionalReturnPct: average(directionalReturns),
      averageAdverseExcursionPct: average(adverseExcursions),
      maxAdverseExcursionPct:
        adverseExcursions.length > 0 ? round(Math.max(...adverseExcursions), 6) : null,
      averageFavorableExcursionPct: average(favorableExcursions),
      maxFavorableExcursionPct:
        favorableExcursions.length > 0 ? round(Math.max(...favorableExcursions), 6) : null,
    };
  }

  return {
    side,
    triggerCount: sideSignals.length,
    byHorizon,
  };
}

function failureCases(
  signals: SignalEvaluation[],
  side: ObservationSide,
): Record<string, Array<Record<string, string | number | boolean>>> {
  const sideSignals = signals.filter((signal) => signal.side === side);
  const result: Record<string, Array<Record<string, string | number | boolean>>> = {};

  for (const horizonHours of HORIZONS_HOURS) {
    result[String(horizonHours)] = sideSignals
      .map((signal) => {
        const path = signal.paths.find((candidate) => candidate.horizonHours === horizonHours);
        return path ? { signal, path } : null;
      })
      .filter((entry): entry is { signal: SignalEvaluation; path: EvaluatedPath } => entry !== null)
      .sort((left, right) => left.path.directionalReturnPct - right.path.directionalReturnPct)
      .slice(0, 5)
      .map(({ signal, path }) => ({
        symbol: signal.observation.symbol,
        fundingTime: signal.observation.fundingTimeIso,
        fundingRate: signal.observation.fundingRate,
        historicalPercentile: signal.observation.historicalPercentile,
        directionalReturnPct: path.directionalReturnPct,
        rawReturnPct: path.rawReturnPct,
        adverseExcursionPct: path.adverseExcursionPct,
        favorableExcursionPct: path.favorableExcursionPct,
        favorable: path.favorable,
      }));
  }
  return result;
}

function bestObservationWindow(
  longSummary: SideSummary,
  shortSummary: SideSummary,
): Record<string, string | number> | null {
  const candidates: Array<Record<string, string | number>> = [];
  for (const summary of [longSummary, shortSummary]) {
    for (const horizonHours of HORIZONS_HOURS) {
      const metrics = summary.byHorizon[String(horizonHours)];
      if (
        metrics.evaluatedCount > 0 &&
        metrics.averageDirectionalReturnPct !== null
      ) {
        candidates.push({
          side: summary.side,
          horizonHours,
          evaluatedCount: metrics.evaluatedCount,
          winRatePct: metrics.winRatePct ?? 0,
          averageDirectionalReturnPct: metrics.averageDirectionalReturnPct,
        });
      }
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  return candidates.sort(
    (left, right) =>
      Number(right.averageDirectionalReturnPct) - Number(left.averageDirectionalReturnPct),
  )[0];
}

function decideSignalFusion(
  longSummary: SideSummary,
  shortSummary: SideSummary,
): {
  decision: "CONDITIONAL_RESEARCH_ONLY" | "NO_NOT_YET";
  rule: string;
  qualifyingSides: ObservationSide[];
  reason: string;
} {
  const rule =
    "A side qualifies only when it has at least 50 evaluated observations at 12h, " +
    "12h win rate is at least 50%, 12h directional average is positive, and at least " +
    "two of 4h/12h/24h directional averages are positive. This is a research gate only.";
  const qualifyingSides = [longSummary, shortSummary]
    .filter((summary) => {
      const at12 = summary.byHorizon["12"];
      const positiveWindows = HORIZONS_HOURS.filter((horizonHours) => {
        const metrics = summary.byHorizon[String(horizonHours)];
        return (
          metrics.evaluatedCount >= 50 &&
          metrics.averageDirectionalReturnPct !== null &&
          metrics.averageDirectionalReturnPct > 0
        );
      }).length;
      return (
        at12.evaluatedCount >= 50 &&
        at12.winRatePct !== null &&
        at12.winRatePct >= 50 &&
        at12.averageDirectionalReturnPct !== null &&
        at12.averageDirectionalReturnPct > 0 &&
        positiveWindows >= 2
      );
    })
    .map((summary) => summary.side);

  if (qualifyingSides.length > 0) {
    return {
      decision: "CONDITIONAL_RESEARCH_ONLY",
      rule,
      qualifyingSides,
      reason:
        "At least one observation side met the pre-registered descriptive stability rule. " +
        "Do not activate fusion or send alerts without a separate human-reviewed change.",
    };
  }
  return {
    decision: "NO_NOT_YET",
    rule,
    qualifyingSides,
    reason:
      "No observation side met the pre-registered descriptive stability rule. " +
      "Keep Funding Extreme Detector separate from production Signal Fusion.",
  };
}

function markdownTable(summary: SideSummary): string {
  const lines = [
    "| Side | Horizon | Triggers | Evaluated | Favorable | Win rate | Avg raw return | Avg directional return | Max adverse | Max favorable |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const horizonHours of HORIZONS_HOURS) {
    const metrics = summary.byHorizon[String(horizonHours)];
    const format = (value: number | null): string => (value === null ? "n/a" : String(value));
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
        format(metrics.winRatePct) +
        "% | " +
        format(metrics.averageRawReturnPct) +
        "% | " +
        format(metrics.averageDirectionalReturnPct) +
        "% | " +
        format(metrics.maxAdverseExcursionPct) +
        "% | " +
        format(metrics.maxFavorableExcursionPct) +
        "% |",
    );
  }
  return lines.join("\n");
}

function failureMarkdown(
  side: ObservationSide,
  failures: Record<string, Array<Record<string, string | number | boolean>>>,
): string {
  const lines: string[] = [];
  for (const horizonHours of HORIZONS_HOURS) {
    lines.push("### " + side + " " + horizonHours + "h worst directional outcomes");
    const entries = failures[String(horizonHours)];
    if (entries.length === 0) {
      lines.push("No evaluated observations.");
      lines.push("");
      continue;
    }
    lines.push("| Symbol | Funding time | Percentile | Directional return | MAE | MFE |");
    lines.push("| --- | --- | ---: | ---: | ---: | ---: |");
    for (const entry of entries) {
      lines.push(
        "| " +
          entry.symbol +
          " | " +
          entry.fundingTime +
          " | " +
          entry.historicalPercentile +
          " | " +
          entry.directionalReturnPct +
          "% | " +
          entry.adverseExcursionPct +
          "% | " +
          entry.favorableExcursionPct +
          "% |",
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildMarkdown(report: Record<string, unknown>): string {
  const coverage = report.coverage as Record<string, unknown>;
  const triggerCounts = report.triggerCounts as Record<string, unknown>;
  const longSummary = report.longResults as SideSummary;
  const shortSummary = report.shortResults as SideSummary;
  const fusion = report.signalFusionAssessment as Record<string, unknown>;
  const baseline = report.baselineComparison as Record<string, unknown>;
  const failures = report.failureCases as Record<
    string,
    Record<string, Array<Record<string, string | number | boolean>>>
  >;
  const bestWindow = report.bestObservationWindow as Record<string, string | number> | null;

  return [
    "# HY-R4.1 Funding Intelligence Research",
    "",
    "## Scope",
    "",
    "This is a local, research-only Funding Extreme Detector evaluation. It does not modify Production, Vercel, Supabase, the PAPER strategy, or any trading path. It does not send email and does not call Binance private APIs.",
    "",
    "## Data and PIT safety",
    "",
    "- Evaluation window: " +
      coverage.evaluationStart +
      " through " +
      coverage.evaluationEnd +
      ".",
    "- Symbols: " +
      coverage.symbolCount +
      "; funding points read: " +
      coverage.rawFundingPoints +
      ".",
    "- Eligible PIT observations: " + coverage.eligibleObservations + ".",
    "- Funding source: local HY-R2B public Binance Futures cache (" + coverage.dataDirectory + ").",
    "- Percentile baseline: prior funding points only, current event excluded, rolling 30-day window, minimum 30 prior points.",
    "- Future percentile leakage: **none by construction**.",
    "",
    "## Trigger counts",
    "",
    "- LONG observation (historical percentile <= 5%): " + triggerCounts.long + ".",
    "- SHORT observation (historical percentile >= 95%): " + triggerCounts.short + ".",
    "- Total extreme observations: " + triggerCounts.total + ".",
    "- Non-extreme eligible observations: " + triggerCounts.none + ".",
    "",
    "## Forward reminder-quality results",
    "",
    markdownTable(longSummary),
    "",
    markdownTable(shortSummary),
    "",
    "Return is measured from the first 15m candle at or after the funding event to the first 15m candle at or after the horizon. Directional return is aligned with the observation side; it is not trading PnL.",
    "",
    "## Best observation window",
    "",
    bestWindow
      ? "- " +
        bestWindow.side +
        " at " +
        bestWindow.horizonHours +
        "h: average directional return " +
        bestWindow.averageDirectionalReturnPct +
        "%, win rate " +
        bestWindow.winRatePct +
        "%, evaluated " +
        bestWindow.evaluatedCount +
        "."
      : "- No evaluated observation window.",
    "",
    "## Failure cases",
    "",
    failureMarkdown("LONG", failures.long),
    failureMarkdown("SHORT", failures.short),
    "The tables show the five worst directional outcomes per side and horizon; they are diagnostic examples, not a trade ledger.",
    "",
    "## Comparison with current PAPER baseline",
    "",
    "- Baseline strategy: " +
      baseline.strategyVersion +
      ", stage " +
      baseline.stage +
      ", side " +
      baseline.side +
      ", entry mode " +
      baseline.entryMode +
      ".",
    "- Baseline OOS trade count: " +
      baseline.oosTrades +
      "; 5 bps PF: " +
      baseline.fiveBpsProfitFactor +
      "; 10 bps PF: " +
      baseline.tenBpsProfitFactor +
      ".",
    "- Funding Extreme Detector produces non-trading forward reminder diagnostics. Direct PF or PnL comparison with the strategy baseline is **not valid**.",
    "- Funding observations and the current hy-paper-candidate-v2 trade plan remain independent dimensions.",
    "",
    "## Signal Fusion assessment",
    "",
    "- Decision: **" + fusion.decision + "**.",
    "- Qualifying sides: " +
      (Array.isArray(fusion.qualifyingSides) ? fusion.qualifyingSides.join(", ") || "none" : "none") +
      ".",
    "- Rule: " + fusion.rule,
    "- " + fusion.reason,
    "",
    "## Safety invariants",
    "",
    "- AUTO_TRADING: **FALSE**.",
    "- Production modified: **NO**.",
    "- Supabase modified: **NO**.",
    "- Vercel modified/deployed: **NO**.",
    "- PAPER strategy parameters modified: **NO**.",
    "- Direct email: **NO**.",
    "- Binance private trading API: **NO**.",
    "",
    "Generated from scripts/run-hy-r4-1-funding-intelligence.ts.",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const datasets = await loadDatasets();
  const allObservations: FundingObservation[] = [];
  const allSignals: SignalEvaluation[] = [];
  const symbolCoverage: SymbolCoverage[] = [];
  let rawFundingPoints = 0;

  for (const dataset of datasets) {
    const result = buildFundingObservations(dataset);
    rawFundingPoints += result.coverage.rawFundingPoints;
    symbolCoverage.push(result.coverage);
    allObservations.push(...result.observations);

    const triggers = result.observations.filter(
      (observation) => observation.extremeFlag !== "NONE",
    );
    const candles = dataset.candles["15m"].slice().sort((left, right) => left.openTime - right.openTime);
    for (const observation of triggers) {
      const side: ObservationSide =
        observation.extremeFlag === "LONG_OBSERVATION" ? "LONG" : "SHORT";
      allSignals.push({
        observation,
        side,
        paths: evaluatePaths(candles, observation),
      });
    }
  }

  allObservations.sort((left, right) => {
    if (left.fundingTime !== right.fundingTime) {
      return left.fundingTime - right.fundingTime;
    }
    return left.symbol.localeCompare(right.symbol);
  });
  allSignals.sort((left, right) => {
    if (left.observation.fundingTime !== right.observation.fundingTime) {
      return left.observation.fundingTime - right.observation.fundingTime;
    }
    return left.observation.symbol.localeCompare(right.observation.symbol);
  });

  const longSummary = summarizeSide(allSignals, "LONG");
  const shortSummary = summarizeSide(allSignals, "SHORT");
  const signalFusionAssessment = decideSignalFusion(longSummary, shortSummary);
  const longTriggers = longSummary.triggerCount;
  const shortTriggers = shortSummary.triggerCount;
  const eligibleObservations = allObservations.length;
  const firstObservation = allObservations[0];
  const lastObservation = allObservations[allObservations.length - 1];

  const report: Record<string, unknown> = {
    report: "HY-R4.1 Funding Intelligence Research",
    generatedAt: new Date().toISOString(),
    scope: {
      researchOnly: true,
      systemRole: "Signal Alert System",
      noAutomaticTrading: true,
      autoTrading: false,
      noEmail: true,
      noPrivateBinanceApi: true,
      productionModified: false,
      supabaseModified: false,
      vercelModified: false,
      paperStrategyModified: false,
    },
    methodology: {
      detector: "Funding Extreme Detector",
      fundingSource: "Binance Futures public funding-rate cache",
      evaluationStart: iso(HISTORY_START),
      evaluationEnd: iso(HISTORY_END),
      rollingWindowDays: 30,
      minimumPriorHistoryPoints: MIN_PRIOR_POINTS,
      lowPercentileThreshold: LOW_PERCENTILE,
      highPercentileThreshold: HIGH_PERCENTILE,
      horizonsHours: HORIZONS_HOURS,
      percentileDefinition:
        "count(prior funding rates <= current funding rate) / prior funding rate count",
      currentEventExcludedFromBaseline: true,
      futureDataUsed: false,
      triggerEventsAreOverlapping: true,
      returnPriceDefinition:
        "first 15m candle open at or after funding event and horizon",
      excursionDefinition:
        "maximum path high/low excursion between event candle and horizon candle",
    },
    coverage: {
      dataDirectory: DATA_DIR,
      symbolCount: datasets.length,
      symbols: datasets.map((dataset) => dataset.symbol).sort(),
      rawFundingPoints,
      evaluationFundingPoints: symbolCoverage.reduce(
        (total, coverage) => total + coverage.evaluationFundingPoints,
        0,
      ),
      eligibleObservations,
      evaluationStart: iso(HISTORY_START),
      evaluationEnd: iso(HISTORY_END),
      firstEligibleObservation: firstObservation?.fundingTimeIso ?? null,
      lastEligibleObservation: lastObservation?.fundingTimeIso ?? null,
    },
    triggerCounts: {
      long: longTriggers,
      short: shortTriggers,
      total: longTriggers + shortTriggers,
      none: eligibleObservations - longTriggers - shortTriggers,
    },
    longResults: longSummary,
    shortResults: shortSummary,
    bestObservationWindow: bestObservationWindow(longSummary, shortSummary),
    failureCases: {
      long: failureCases(allSignals, "LONG"),
      short: failureCases(allSignals, "SHORT"),
    },
    baselineComparison: {
      strategyVersion: BASELINE.strategyVersion,
      stage: BASELINE.stage,
      side: BASELINE.side,
      entryMode: BASELINE.entryMode,
      oosTrades: BASELINE.oosTrades,
      fiveBpsProfitFactor: BASELINE.fiveBpsProfitFactor,
      fiveBpsNetPnlUsdt: BASELINE.fiveBpsNetPnlUsdt,
      tenBpsProfitFactor: BASELINE.tenBpsProfitFactor,
      sourceReport: BASELINE.sourceReport,
      directPnlComparisonAllowed: false,
      comparisonNote:
        "Funding observations are reminder-quality forward-return diagnostics; " +
        "hy-paper-candidate-v2 is a separate PAPER trade-plan backtest.",
    },
    signalFusionAssessment,
    symbolCoverage,
    observations: allObservations,
    triggers: allSignals,
  };

  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(REPORT_JSON, JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(REPORT_MD, buildMarkdown(report), "utf8");

  console.log(
    JSON.stringify(
      {
        reportJson: REPORT_JSON,
        reportMarkdown: REPORT_MD,
        symbols: datasets.length,
        rawFundingPoints,
        eligibleObservations,
        longTriggers,
        shortTriggers,
        fusionDecision: signalFusionAssessment.decision,
        bestObservationWindow: report.bestObservationWindow,
        autoTrading: false,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
