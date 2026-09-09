import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { HistoricalDataset } from "../lib/backtest/types";
import {
  calculateLiquidityFeature,
  calculateMarketBreadthFeature,
} from "../lib/market-context";
import type {
  LiquidityFeature,
  LiquidityHistoryPoint,
  LiquidityVolumeSource,
  MarketBreadthFeature,
  MarketBreadthMember,
  QuoteVolumeObservation,
} from "../lib/market-context";
import type { Candle } from "../lib/core/types";

const DATA_DIRECTORY = resolve("data", "hy-r2b-history-24m");
const REPORT_DIRECTORY = resolve("reports");
const REPORT_PATH = resolve(REPORT_DIRECTORY, "hy-r4.10-market-context-intelligence.md");
const EVALUATION_START = Date.parse("2024-08-09T00:00:00.000Z");
const EVALUATION_END = Date.parse("2026-08-09T23:59:59.999Z");
const HISTORY_START = EVALUATION_START - 7 * 24 * 60 * 60 * 1000;
const SAMPLE_INTERVAL_MS = 4 * 60 * 60 * 1000;
const LIQUIDITY_PERCENTILE_WINDOW = 42;
const TOP_UNIVERSE_SIZE = 10;
const BREADTH_MINIMUM_MEMBERS = 35;

interface QuoteVolumeSeries {
  candles: Candle[];
  values: Array<number | null>;
  prefixValues: number[];
  prefixCounts: number[];
  prefixQuoteVolumeCounts: number[];
  prefixFallbackCounts: number[];
}

interface DatasetContext {
  symbol: string;
  liquidityFeatures: LiquidityFeature[];
  breadthMembers: Array<{ timestamp: number; member: MarketBreadthMember }>;
  one_hour_candles: number;
  four_hour_candles: number;
  quote_volume_bars: number;
  fallback_volume_bars: number;
  source_start: string | null;
  source_end: string | null;
}

interface MarketContextReport {
  schema_version: "hy-r4.10";
  mode: "LOCAL_PIT_SAFE_FEATURE_RESEARCH";
  generated_at: string;
  evaluation_window: {
    start: string;
    end: string;
    warmup_start: string;
    sample_interval_hours: number;
  };
  source: {
    directory: string;
    dataset_count: number;
    symbols: string[];
    sample_timestamps: number;
    one_hour_candles: number;
    four_hour_candles: number;
    quote_volume_bars: number;
    fallback_volume_bars: number;
    static_universe_rank_used: false;
    live_api_called: false;
  };
  liquidity: {
    observations: number;
    available: number;
    blocked: number;
    pit_safe: number;
    score_average: number | null;
    status_counts: Record<string, number>;
    volume_source_counts: Record<string, number>;
  };
  breadth: {
    observations: number;
    pit_safe: number;
    blocked: number;
    score_average: number | null;
    valid_symbols_average: number | null;
    status_counts: Record<string, number>;
    direction_counts: Record<string, number>;
    top_universe_size: number;
  };
  pit_validation: {
    future_data_used: false;
    source_timestamps_after_as_of: 0;
    future_points_ignored: number;
    checks: string[];
  };
  integration_boundary: {
    signal_rules_modified: false;
    signal_engine_connected: false;
    storage_added: false;
    supabase_modified: false;
    production_connected: false;
    production_modified: false;
    emails_sent: 0;
    private_api_called: false;
    auto_trading: false;
  };
  examples: {
    liquidity: Array<Pick<LiquidityFeature, "symbol" | "timestamp" | "quote_volume_24h" | "volume_percentile" | "liquidity_score" | "status">>;
    breadth: Array<Pick<MarketBreadthFeature, "timestamp" | "advancing_ratio" | "declining_ratio" | "top_universe_strength" | "breadth_score" | "direction" | "status" | "valid_symbols">>;
  };
}

async function main(): Promise<void> {
  const files = (await readdir(DATA_DIRECTORY))
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error("No HY-R2B historical datasets found");

  const firstDataset = await loadDataset(files[0]!);
  const sampleTimestamps = buildSampleTimestamps(firstDataset);
  if (sampleTimestamps.length === 0) throw new Error("No historical sample timestamps found");

  const membersByTimestamp = new Map<number, MarketBreadthMember[]>();
  const liquidityFeatures: LiquidityFeature[] = [];
  const contexts: DatasetContext[] = [];
  for (const fileName of files) {
    const dataset = await loadDataset(fileName);
    const context = buildDatasetContext(dataset, sampleTimestamps);
    contexts.push(context);
    for (const feature of context.liquidityFeatures) {
      if (Date.parse(feature.timestamp) < EVALUATION_START) continue;
      liquidityFeatures.push(feature);
    }
    for (const { timestamp, member } of context.breadthMembers) {
      const members = membersByTimestamp.get(timestamp) ?? [];
      members.push(member);
      membersByTimestamp.set(timestamp, members);
    }
  }

  const breadthFeatures: MarketBreadthFeature[] = [];
  for (const timestamp of sampleTimestamps) {
    if (timestamp < EVALUATION_START) continue;
    breadthFeatures.push(calculateMarketBreadthFeature({
      as_of: timestamp,
      members: membersByTimestamp.get(timestamp) ?? [],
      top_universe_size: TOP_UNIVERSE_SIZE,
      minimum_members: BREADTH_MINIMUM_MEMBERS,
    }));
  }

  const report = buildReport(
    files.length,
    contexts,
    sampleTimestamps.filter((timestamp) => timestamp >= EVALUATION_START).length,
    liquidityFeatures,
    breadthFeatures,
  );
  await mkdir(REPORT_DIRECTORY, { recursive: true });
  await writeFile(REPORT_PATH, renderMarkdown(report), "utf8");
  console.log(JSON.stringify({
    report: REPORT_PATH,
    datasets: report.source.dataset_count,
    sample_timestamps: report.source.sample_timestamps,
    liquidity_observations: report.liquidity.observations,
    liquidity_available: report.liquidity.available,
    breadth_observations: report.breadth.observations,
    breadth_blocked: report.breadth.blocked,
    future_data_used: report.pit_validation.future_data_used,
  }, null, 2));
}

function buildDatasetContext(
  dataset: HistoricalDataset,
  sampleTimestamps: number[],
): DatasetContext {
  const oneHour = (dataset.candles["1h"] ?? []).filter(isUsableCandle).sort(byCloseTime);
  const fourHour = (dataset.candles["4h"] ?? []).filter(isUsableCandle).sort(byCloseTime);
  const quoteSeries = buildQuoteVolumeSeries(oneHour);
  const liquidityFeatures: LiquidityFeature[] = [];
  const breadthMembers: Array<{ timestamp: number; member: MarketBreadthMember }> = [];
  const history: LiquidityHistoryPoint[] = [];
  let oneHourIndex = -1;
  let fourHourIndex = -1;

  for (const timestamp of sampleTimestamps) {
    while (
      oneHourIndex + 1 < oneHour.length
      && oneHour[oneHourIndex + 1]!.closeTime <= timestamp
    ) {
      oneHourIndex += 1;
    }
    const volumeObservation = volumeObservationAt(quoteSeries, oneHourIndex);
    const liquidity = calculateLiquidityFeature({
      symbol: dataset.symbol,
      as_of: timestamp,
      source_timestamp: volumeObservation.source_timestamp,
      quote_volume_24h: volumeObservation.quote_volume_24h,
      sample_count_24h: volumeObservation.sample_count_24h,
      volume_source: volumeObservation.volume_source,
      history,
      percentile_window: LIQUIDITY_PERCENTILE_WINDOW,
      minimum_history_samples: LIQUIDITY_PERCENTILE_WINDOW,
    });
    liquidityFeatures.push(liquidity);
    if (
      volumeObservation.quote_volume_24h !== null
      && volumeObservation.sample_count_24h === 24
      && volumeObservation.source_timestamp !== null
    ) {
      history.push({
        timestamp: volumeObservation.source_timestamp,
        quote_volume_24h: volumeObservation.quote_volume_24h,
      });
      if (history.length > LIQUIDITY_PERCENTILE_WINDOW) history.shift();
    }

    while (
      fourHourIndex + 1 < fourHour.length
      && fourHour[fourHourIndex + 1]!.closeTime <= timestamp
    ) {
      fourHourIndex += 1;
    }
    const current = fourHour[fourHourIndex];
    const previous = fourHour[fourHourIndex - 6];
    if (current && previous && previous.close > 0 && current.closeTime <= timestamp) {
      breadthMembers.push({
        timestamp,
        member: {
          symbol: dataset.symbol,
          source_timestamp: current.closeTime,
          price_return_24h: current.close / previous.close - 1,
          quote_volume_24h: liquidity.quote_volume_24h,
        },
      });
    }
  }

  return {
    symbol: dataset.symbol,
    liquidityFeatures,
    breadthMembers,
    one_hour_candles: oneHour.length,
    four_hour_candles: fourHour.length,
    quote_volume_bars: quoteSeries.prefixQuoteVolumeCounts.at(-1) ?? 0,
    fallback_volume_bars: quoteSeries.prefixFallbackCounts.at(-1) ?? 0,
    source_start: oneHour[0] ? new Date(oneHour[0].openTime).toISOString() : null,
    source_end: oneHour.at(-1) ? new Date(oneHour.at(-1)!.closeTime).toISOString() : null,
  };
}

function buildQuoteVolumeSeries(candles: Candle[]): QuoteVolumeSeries {
  const values = candles.map((candle) => {
    if (Number.isFinite(candle.quoteVolume) && candle.quoteVolume! >= 0) return candle.quoteVolume!;
    return Number.isFinite(candle.close) && Number.isFinite(candle.volume)
      ? candle.close * candle.volume
      : null;
  });
  const prefixValues = [0];
  const prefixCounts = [0];
  const prefixQuoteVolumeCounts = [0];
  const prefixFallbackCounts = [0];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const isQuoteVolume = Number.isFinite(candles[index]!.quoteVolume)
      && candles[index]!.quoteVolume! >= 0;
    prefixValues.push(prefixValues[index]! + (value ?? 0));
    prefixCounts.push(prefixCounts[index]! + (value === null ? 0 : 1));
    prefixQuoteVolumeCounts.push(prefixQuoteVolumeCounts[index]! + (isQuoteVolume ? 1 : 0));
    prefixFallbackCounts.push(prefixFallbackCounts[index]! + (value !== null && !isQuoteVolume ? 1 : 0));
  }
  return {
    candles,
    values,
    prefixValues,
    prefixCounts,
    prefixQuoteVolumeCounts,
    prefixFallbackCounts,
  };
}

function volumeObservationAt(
  series: QuoteVolumeSeries,
  index: number,
): QuoteVolumeObservation {
  if (index < 0) {
    return {
      quote_volume_24h: null,
      sample_count_24h: 0,
      volume_source: "BLOCKED",
      source_timestamp: null,
      pit_safe: true,
    };
  }
  const start = Math.max(0, index - 23);
  const sampleCount = series.prefixCounts[index + 1]! - series.prefixCounts[start]!;
  const quoteVolume = series.prefixValues[index + 1]! - series.prefixValues[start]!;
  const quoteBars = series.prefixQuoteVolumeCounts[index + 1]! - series.prefixQuoteVolumeCounts[start]!;
  const fallbackBars = series.prefixFallbackCounts[index + 1]! - series.prefixFallbackCounts[start]!;
  const volume_source: LiquidityVolumeSource = quoteBars > 0 && fallbackBars > 0
    ? "MIXED"
    : quoteBars > 0 ? "QUOTE_VOLUME" : fallbackBars > 0 ? "CLOSE_TIMES_VOLUME" : "BLOCKED";
  return {
    quote_volume_24h: sampleCount > 0 && Number.isFinite(quoteVolume) ? quoteVolume : null,
    sample_count_24h: sampleCount,
    volume_source,
    source_timestamp: series.candles[index]?.closeTime ?? null,
    pit_safe: true,
  };
}

function buildSampleTimestamps(dataset: HistoricalDataset): number[] {
  const fourHour = (dataset.candles["4h"] ?? []).filter(isUsableCandle).sort(byCloseTime);
  const timestamps: number[] = [];
  let nextSample = HISTORY_START;
  for (const candle of fourHour) {
    if (candle.closeTime < HISTORY_START) continue;
    if (candle.closeTime > EVALUATION_END) break;
    if (candle.closeTime < nextSample) continue;
    timestamps.push(candle.closeTime);
    nextSample = candle.closeTime + SAMPLE_INTERVAL_MS;
  }
  return timestamps;
}

function buildReport(
  datasetCount: number,
  contexts: DatasetContext[],
  sampleCount: number,
  liquidityFeatures: LiquidityFeature[],
  breadthFeatures: MarketBreadthFeature[],
): MarketContextReport {
  const liquidityStatusCounts = countBy(liquidityFeatures, (feature) => feature.status);
  const liquiditySourceCounts = countBy(liquidityFeatures, (feature) => feature.volume_source);
  const breadthStatusCounts = countBy(breadthFeatures, (feature) => feature.status);
  const breadthDirectionCounts = countBy(breadthFeatures, (feature) => feature.direction);
  const liquidityScores = liquidityFeatures
    .map((feature) => feature.liquidity_score)
    .filter(isNumber);
  const breadthScores = breadthFeatures
    .map((feature) => feature.breadth_score)
    .filter(isNumber);
  const validSymbols = breadthFeatures
    .map((feature) => feature.valid_symbols)
    .filter(Number.isFinite);
  const futurePointsIgnored = liquidityFeatures.reduce(
    (total, feature) => total + feature.future_history_points_ignored,
    0,
  ) + breadthFeatures.reduce(
    (total, feature) => total + feature.future_member_points_ignored,
    0,
  );
  const firstLiquidity = liquidityFeatures.slice(0, 4).map((feature) => ({
    symbol: feature.symbol,
    timestamp: feature.timestamp,
    quote_volume_24h: feature.quote_volume_24h,
    volume_percentile: feature.volume_percentile,
    liquidity_score: feature.liquidity_score,
    status: feature.status,
  }));
  const firstBreadth = breadthFeatures.slice(0, 4).map((feature) => ({
    timestamp: feature.timestamp,
    advancing_ratio: feature.advancing_ratio,
    declining_ratio: feature.declining_ratio,
    top_universe_strength: feature.top_universe_strength,
    breadth_score: feature.breadth_score,
    direction: feature.direction,
    status: feature.status,
    valid_symbols: feature.valid_symbols,
  }));
  return {
    schema_version: "hy-r4.10",
    mode: "LOCAL_PIT_SAFE_FEATURE_RESEARCH",
    generated_at: new Date().toISOString(),
    evaluation_window: {
      start: new Date(EVALUATION_START).toISOString(),
      end: new Date(EVALUATION_END).toISOString(),
      warmup_start: new Date(HISTORY_START).toISOString(),
      sample_interval_hours: SAMPLE_INTERVAL_MS / (60 * 60 * 1000),
    },
    source: {
      directory: "data/hy-r2b-history-24m",
      dataset_count: datasetCount,
      symbols: contexts.map((context) => context.symbol).sort(),
      sample_timestamps: sampleCount,
      one_hour_candles: contexts.reduce((total, context) => total + context.one_hour_candles, 0),
      four_hour_candles: contexts.reduce((total, context) => total + context.four_hour_candles, 0),
      quote_volume_bars: contexts.reduce((total, context) => total + context.quote_volume_bars, 0),
      fallback_volume_bars: contexts.reduce((total, context) => total + context.fallback_volume_bars, 0),
      static_universe_rank_used: false,
      live_api_called: false,
    },
    liquidity: {
      observations: liquidityFeatures.length,
      available: liquidityScores.length,
      blocked: liquidityFeatures.length - liquidityScores.length,
      pit_safe: liquidityFeatures.filter((feature) => feature.pit_safe).length,
      score_average: average(liquidityScores),
      status_counts: liquidityStatusCounts,
      volume_source_counts: liquiditySourceCounts,
    },
    breadth: {
      observations: breadthFeatures.length,
      pit_safe: breadthFeatures.filter((feature) => feature.pit_safe).length,
      blocked: breadthFeatures.filter((feature) => feature.status === "BLOCKED").length,
      score_average: average(breadthScores),
      valid_symbols_average: average(validSymbols),
      status_counts: breadthStatusCounts,
      direction_counts: breadthDirectionCounts,
      top_universe_size: TOP_UNIVERSE_SIZE,
    },
    pit_validation: {
      future_data_used: false,
      source_timestamps_after_as_of: 0,
      future_points_ignored: futurePointsIgnored,
      checks: [
        "24h quote volume uses only 1h candles with closeTime <= as_of.",
        "Volume percentile history is limited to prior sampled observations and excludes future timestamps.",
        "Breadth uses only each symbol's 4h candle with closeTime <= as_of.",
        "Top universe is ranked by contemporaneous PIT-safe 24h quote volume, not static/current rank metadata.",
      ],
    },
    integration_boundary: {
      signal_rules_modified: false,
      signal_engine_connected: false,
      storage_added: false,
      supabase_modified: false,
      production_connected: false,
      production_modified: false,
      emails_sent: 0,
      private_api_called: false,
      auto_trading: false,
    },
    examples: {
      liquidity: firstLiquidity,
      breadth: firstBreadth,
    },
  };
}

function renderMarkdown(report: MarketContextReport): string {
  const statusRows = rows(report.liquidity.status_counts);
  const liquiditySourceRows = rows(report.liquidity.volume_source_counts);
  const breadthStatusRows = rows(report.breadth.status_counts);
  const breadthDirectionRows = rows(report.breadth.direction_counts);
  const liquidityExamples = report.examples.liquidity
    .map((example) => `| ${example.timestamp} | ${example.symbol} | ${format(example.quote_volume_24h)} | ${format(example.volume_percentile)} | ${format(example.liquidity_score)} | ${example.status} |`)
    .join("\n") || "| none | - | - | - | - | - |";
  const breadthExamples = report.examples.breadth
    .map((example) => `| ${example.timestamp} | ${example.valid_symbols} | ${format(example.advancing_ratio)} | ${format(example.declining_ratio)} | ${format(example.top_universe_strength)} | ${format(example.breadth_score)} | ${example.direction} | ${example.status} |`)
    .join("\n") || "| none | - | - | - | - | - | - | - |";
  return [
    "# HY-R4.10 Market Context Intelligence",
    "",
    "## Scope and boundary",
    "",
    `- Mode: **${report.mode}**`,
    `- Generated: ${report.generated_at}`,
    `- Evaluation window: ${report.evaluation_window.start} → ${report.evaluation_window.end}`,
    `- Warm-up window: ${report.evaluation_window.warmup_start}`,
    `- Sampling: every ${report.evaluation_window.sample_interval_hours}h`,
    `- Datasets: ${report.source.dataset_count}`,
    "- This phase computes feature inputs only; it does not change signal rules or enable LONG/SHORT output.",
    "- Production, Supabase, Vercel, email, private API, and AUTO_TRADING are out of scope.",
    "",
    "## Liquidity Intelligence",
    "",
    "### Feature design",
    "",
    "- `quote_volume_24h`: sum of the latest 24 eligible 1h Kline quote-volume bars at `as_of`.",
    "- `volume_percentile`: rank of the current 24h quote volume against the previous 42 sampled 4h observations for the same symbol.",
    "- `liquidity_score`: `0.8 × volume_percentile + 0.2 × 24h bar coverage score`, clamped to 0–100.",
    "- Status: STRONG ≥ 75, NORMAL ≥ 40, WEAK < 40; BLOCKED when the 24h window or percentile history is incomplete.",
    "- Legacy caches without quote volume use the explicit `close × base volume` fallback and are counted separately.",
    "",
    "### Data coverage",
    "",
    `- Feature observations: ${report.liquidity.observations}`,
    `- Available scores: ${report.liquidity.available}`,
    `- Blocked: ${report.liquidity.blocked}`,
    `- PIT-safe: ${report.liquidity.pit_safe}`,
    `- Average liquidity score: ${format(report.liquidity.score_average)}`,
    "",
    "| Liquidity status | Count |",
    "| --- | ---: |",
    statusRows,
    "",
    "| Volume source | Count |",
    "| --- | ---: |",
    liquiditySourceRows,
    "",
    "| Timestamp | Symbol | Quote volume 24h | Percentile | Score | Status |",
    "| --- | --- | ---: | ---: | ---: | --- |",
    liquidityExamples,
    "",
    "## Market Breadth Intelligence",
    "",
    "### Feature design",
    "",
    "- `advancing_ratio`, `declining_ratio`, and `flat_ratio` count 24h price returns across the available universe; ±0.1% is the flat band.",
    "- `top_universe_strength` is the mean 24h return of the top 10 symbols ranked by their contemporaneous PIT-safe 24h quote volume.",
    "- `breadth_score` combines directional balance (65%) and absolute top-universe strength (35%), clamped to 0–100.",
    "- STRONG requires dominant breadth ≥ 65%, top-universe agreement, and at least 0.25% absolute top strength; WEAK marks low consensus or disagreement.",
    "- BLOCKED requires fewer than 35 valid members or no rankable top universe; it does not invent a market-wide reading.",
    "",
    `- Breadth observations: ${report.breadth.observations}`,
    `- PIT-safe: ${report.breadth.pit_safe}`,
    `- Blocked: ${report.breadth.blocked}`,
    `- Average breadth score: ${format(report.breadth.score_average)}`,
    `- Average valid symbols: ${format(report.breadth.valid_symbols_average)}`,
    `- Top universe size: ${report.breadth.top_universe_size}`,
    "",
    "| Breadth status | Count |",
    "| --- | ---: |",
    breadthStatusRows,
    "",
    "| Breadth direction | Count |",
    "| --- | ---: |",
    breadthDirectionRows,
    "",
    "| Timestamp | Valid symbols | Advancing | Declining | Top strength | Score | Direction | Status |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    breadthExamples,
    "",
    "## Data sources and PIT validation",
    "",
    `- Local source: \`${report.source.directory}\`; ${report.source.dataset_count} datasets, ${report.source.sample_timestamps} evaluation timestamps.`,
    `- 1h candles: ${report.source.one_hour_candles}; 4h candles: ${report.source.four_hour_candles}.`,
    `- Native quote-volume bars: ${report.source.quote_volume_bars}; explicit fallback bars: ${report.source.fallback_volume_bars}.`,
    "- No live API was called. Static/current `universeRank` metadata was not used.",
    `- Future data used: **${report.pit_validation.future_data_used ? "YES" : "NO"}**`,
    `- Source timestamps after as-of: ${report.pit_validation.source_timestamps_after_as_of}`,
    `- Future points ignored: ${report.pit_validation.future_points_ignored}`,
    "",
    ...report.pit_validation.checks.map((check) => `- ${check}`),
    "",
    "## Signal Engine integration readiness",
    "",
    "- The new modules expose feature-only functions and are not imported by the existing signal engine.",
    "- No signal rule, score threshold, PAPER strategy, scanner, scheduler, or email path was changed.",
    "- No new persistence object was required; therefore no `hy_` table or migration was added.",
    "- Once separately accepted, these features can be mapped into the existing `liquidity_state` and `market_breadth` snapshots; this report does not perform that integration.",
    "",
    "## Validation and safety",
    "",
    "- Tests: run after implementation; recorded in the final execution result.",
    "- typecheck: run after implementation; recorded in the final execution result.",
    "- lint: run after implementation; recorded in the final execution result.",
    `- Production connected: ${report.integration_boundary.production_connected ? "YES" : "NO"}`,
    `- Supabase modified: ${report.integration_boundary.supabase_modified ? "YES" : "NO"}`,
    `- Emails sent: ${report.integration_boundary.emails_sent}`,
    `- Private API called: ${report.integration_boundary.private_api_called ? "YES" : "NO"}`,
    `- AUTO_TRADING: ${report.integration_boundary.auto_trading ? "TRUE" : "FALSE"}`,
    "",
  ].join("\n");
}

async function loadDataset(fileName: string): Promise<HistoricalDataset> {
  return JSON.parse(await readFile(resolve(DATA_DIRECTORY, fileName), "utf8")) as HistoricalDataset;
}

function rows(values: Record<string, number>): string {
  return Object.entries(values)
    .sort(([, left], [, right]) => right - left)
    .map(([key, value]) => `| ${key} | ${value} |`)
    .join("\n") || "| none | 0 |";
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const name = key(value);
    counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  }, {});
}

function average(values: number[]): number | null {
  return values.length === 0
    ? null
    : Math.round(values.reduce((total, value) => total + value, 0) / values.length * 100) / 100;
}

function format(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "-" : String(value);
}

function isNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

function isUsableCandle(candle: Candle): boolean {
  return [
    candle.openTime,
    candle.closeTime,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
  ].every(Number.isFinite) && candle.close > 0 && candle.volume >= 0;
}

function byCloseTime(left: Candle, right: Candle): number {
  return left.closeTime - right.closeTime;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
