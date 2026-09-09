import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  parseBinanceKlineCsv,
  perpIndexBasis,
  rankCrossSectionalPremium,
  resolutionMilliseconds,
  type BasisPremiumKline,
} from "../lib/basis-premium";
import {
  OFFICIAL_BINANCE_KLINE_COLUMNS,
} from "../lib/basis-premium/clean-foundation";
import {
  R58A1_B4_LOWER_PERCENTILE,
  R58A1_B4_UPPER_PERCENTILE,
  R58A1_ROLLING_MINIMUM_HISTORY,
  b4DivergenceDirection,
} from "../lib/basis-premium/cutoff";
import {
  makeExistingInformationMatchKey,
  matchNearestWithoutReplacement,
} from "../lib/basis-premium/information-gain";
import {
  R58C_EXPECTED_HASHES,
  mean,
  median,
  pairedStatistics,
  precision,
  sourceBytesHash,
  totalVariationDistance,
  type PairedOutcomeSample,
} from "../lib/basis-premium/performance";
import {
  calculateDirectionalOutcome,
  directionalOutcomeCacheKey,
  type OutcomeDirection,
} from "../lib/basis-premium/outcome";
import {
  R510A_MATCH_FIELDS,
  R510A_MINIMUM_SAMPLE,
  R510A_MATCHING_COVERAGE_MINIMUM,
  R510A_PRE_TREATMENT_TV_THRESHOLD,
  R510A_ROLLING_HISTORY,
  bucketFundingR510A,
  mapFundingAtDecision,
  matchingCoverageGate,
  minimumSampleGate,
  pooledMatchingCoveragePercent,
  preTreatmentBalancePass,
  protocolManifestHash,
  type R510AFundingObservation,
} from "../lib/basis-premium/r5-10a-holdout";
import {
  R510B_BOOTSTRAP_REPLICATES,
  R510B_EXPERIMENT_ID,
  R510B_HOLDOUT_END_EXCLUSIVE,
  R510B_HOLDOUT_START,
  R510B_PERMUTATION_REPLICATES,
  R510B_PRIMARY_HYPOTHESIS,
  R510B_PRIMARY_HORIZON,
  R510B_RANDOM_SEED,
  allowedR510BClassification,
  classifyPrimaryDecision,
  concentrationPass,
  directionalPrecision,
  outcomeIdentityIncludesDirection,
  updatePerformanceLock,
  verifyExactHashes,
  type R510BClassification,
} from "../lib/basis-premium/r5-10b-confirmation";
import {
  lifecycleIdAtTimestamp,
  lifecycleIntervalsForSymbol,
  sha256Json,
} from "../lib/crowding";
import type { LifecycleInterval } from "../lib/crowding";

type JsonRecord = Record<string, unknown>;
type Direction = "BULLISH" | "BEARISH";
type Horizon = "1h" | "4h" | "12h" | "24h";

interface ListingRecord {
  symbol: string;
  onboardDate: number;
  deliveryDate: number;
  [key: string]: unknown;
}

interface AlignedRow {
  timestamp: number;
  pitAvailableAt: number;
  premium: number;
  index: number;
  mark: number;
  perpetual: number;
}

interface Bar {
  close: number;
  high: number;
  low: number;
  quoteAssetVolume: number;
}

interface Observation {
  symbol: string;
  observationTime: number;
  decisionTime: number;
  lifecycleId: string;
  referencePrice: number;
  premium: number;
  index: number;
  mark: number;
  perpetual: number;
  priceChange: number | null;
  premiumChange: number | null;
  priceChangePercentile: number | null;
  premiumChangePercentile: number | null;
  fourHourReturn: number | null;
  volatilityValue: number | null;
  liquidityValue: number | null;
  marketRegime: string;
  volatilityBucket: string;
  liquidityBucket: string;
  fundingRate: number | null;
  fundingTime: number | null;
  fundingBucket: string | null;
  existingMarkIndexBasis: number | null;
  existingMarkIndexBasisBucket: string;
  calendarPeriod: string;
  b4Direction: Direction | null;
  b4EventDirection: Direction | null;
  b4FeatureStrength: "EXTREME" | "NORMAL";
  matchKey: string;
}

interface Point {
  time: number;
  matchKey: string;
  observation: Observation;
}

interface OutcomeEvaluation {
  pairIndex: number;
  direction: Direction;
  horizon: Horizon;
  signalIdentity: string;
  controlIdentity: string;
  signalSymbol: string;
  controlSymbol: string;
  signalTimestamp: number;
  controlTimestamp: number;
  signalReturn: number;
  controlReturn: number;
  signalMfe: number;
  signalMae: number;
  controlMfe: number;
  controlMae: number;
  signalCorrect: boolean;
  controlCorrect: boolean;
}

interface FrozenInputs {
  report: JsonRecord;
  coverage: JsonRecord;
  funding: JsonRecord;
  matching: JsonRecord;
  hypothesis: JsonRecord;
  dataset: JsonRecord;
  artifactHashes: JsonRecord;
  protocolGate: ReturnType<typeof verifyExactHashes>;
  semanticGate: ReturnType<typeof verifyExactHashes>;
  outcomeHash: string;
  sourceHashes: JsonRecord;
}

interface MatchResult {
  allEvents: Observation[];
  incompleteEvents: Observation[];
  events: Point[];
  controls: Point[];
  pairs: Array<{ event: Point; control: Point; distanceMs: number }>;
}

const RESOLUTION = "1h" as const;
const STEP_MS = resolutionMilliseconds(RESOLUTION);
const HOUR_MS = STEP_MS;
const DAY_MS = 86_400_000;
const WARMUP_START = Date.parse("2026-07-01T00:00:00.000Z");
const ROOT = resolve("data", "raw", "hy-r5.10a-b4-holdout");
const MATERIALIZED_ROOT = resolve(ROOT, "materialized");
const ARTIFACT_ROOT = resolve(ROOT, "artifacts");
const LISTING_EVIDENCE_PATH = resolve("data", "raw", "hy-r5.2b-flow", "listing-evidence.json");
const R510A_REPORT_PATH = resolve("reports", "hy-r5.10a-b4-holdout-protocol-freeze.json");
const COVERAGE_PATH = resolve(ARTIFACT_ROOT, "holdout-coverage-manifest.json");
const FUNDING_PATH = resolve(ARTIFACT_ROOT, "funding-manifest.json");
const MATCHING_PATH = resolve(ARTIFACT_ROOT, "matching-protocol-manifest.json");
const HYPOTHESIS_PATH = resolve(ARTIFACT_ROOT, "confirmation-hypothesis-manifest.json");
const DATASET_PATH = resolve(ARTIFACT_ROOT, "holdout-dataset-manifest.json");
const HASHES_PATH = resolve(ARTIFACT_ROOT, "artifact-hashes.json");
const R57_FEATURE_PATH = resolve("data", "raw", "hy-r5.7-basis-premium-preflight", "artifacts", "feature-specification.json");
const R58A_PATH = resolve("reports", "hy-r5.8a-basis-premium-hypothesis-freeze.json");
const R58A1_PATH = resolve("reports", "hy-r5.8a1-basis-premium-event-cutoff-freeze.json");
const OUTCOME_PATH = resolve("lib", "basis-premium", "outcome.ts");
const MATCHING_SOURCE_PATH = resolve("lib", "basis-premium", "information-gain.ts");
const STATISTICS_SOURCE_PATH = resolve("lib", "basis-premium", "performance.ts");
const CLASSIFICATION_SOURCE_PATH = resolve("lib", "basis-premium", "classification.ts");
const RUNNER_PATH = resolve("scripts", "run-hy-r5-10b-b4-independent-holdout-confirmation.ts");
const HELPER_PATH = resolve("lib", "basis-premium", "r5-10b-confirmation.ts");
const PREFREEZE_PATH = resolve("reports", "hy-r5.10b-pre-confirmation-freeze.json");
const REPORT_JSON_PATH = resolve("reports", "hy-r5.10b-b4-independent-holdout-confirmation.json");
const REPORT_MD_PATH = resolve("reports", "hy-r5.10b-b4-independent-holdout-confirmation.md");

const EXPECTED_PROTOCOL_HASHES = {
  protocol_manifest: "7f633aa51cdc893ba2fa7f31ab4841e6dbbb9e115e477d4002af648aad06331d",
  funding_manifest: "47522301bf768f92e74fe98b6fa878b7c8628b396b4accfb7f87bbf505cb5aab",
  holdout_dataset: "5b1600a1270705064f43d4c2ed5e93c87a8c237b274fba266b1c6ffb873ed67c",
  matching_protocol: "dda5575f224d60c40bc492ab4941a481916bacbc8eaff9ae0f53da097997566c",
} as const;

const EXPECTED_SEMANTIC_HASHES = {
  r57_feature_specification: "bbdaab9e4cba4c22e50471d538d808fca992e812aaff60a0fc3f70af6020cf51",
  r58a_hypothesis_manifest: "0b5a790a1783704fc5eb130c4d1fa65c865339e68232fa1b54af9012c58db0f3",
  r58a1_cutoff_manifest: "95fe1b5a20b0d4804e52dbc01c2f0e730a8f6b377e0c29ae2877875d8f06e800",
} as const;

const EXPECTED_OUTCOME_HASH = "8a4e81ca26c050c337012b233fa2d7017c7ecc1dfa46dabdfe9b3a142e937465";
const EXPECTED_ELIGIBLE = { bullish: 1_560, bearish: 1_508 } as const;
const EXPECTED_MATCHED = { bullish: 1_502, bearish: 1_444 } as const;
const HORIZONS: Horizon[] = ["1h", "4h", "12h", "24h"];

function asRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("EXPECTED_OBJECT");
  return value as JsonRecord;
}

async function readJson(path: string): Promise<JsonRecord> {
  return asRecord(JSON.parse(await readFile(path, "utf8")));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function relativePath(path: string): string {
  return relative(resolve("."), path).replaceAll("\\", "/");
}

function iso(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function expectValue(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`FROZEN_INPUT_MISMATCH:${label}`);
}

function finiteNumber(value: string | undefined): number {
  return value === undefined || value.trim() === "" ? Number.NaN : Number(value.trim());
}

function csvLines(content: string): string[] {
  return content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

function monthKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function quarterKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

function distribution(values: string[]): JsonRecord {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return {
    count: values.length,
    categories: Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => [key, {
      count,
      fraction: values.length > 0 ? count / values.length : null,
    }])),
  };
}

function bucketVolatility(value: number | null): string {
  if (value === null) return "UNKNOWN";
  if (value < 0.005) return "LOW";
  if (value < 0.015) return "NORMAL";
  return "HIGH";
}

function bucketBasis(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "UNKNOWN";
  if (value <= -0.0005) return "EXTREME_NEGATIVE";
  if (value < 0) return "NEGATIVE";
  if (value === 0) return "NEUTRAL";
  if (value < 0.0005) return "POSITIVE";
  return "EXTREME_POSITIVE";
}

function bucketLiquidity(percentile: number | null): string {
  if (percentile === null) return "UNKNOWN";
  if (percentile <= 0.33) return "LOW";
  if (percentile <= 0.66) return "NORMAL";
  return "HIGH";
}

function crossSectionalPercentile(values: Array<{ id: string; value: number | null }>, id: string): number | null {
  return rankCrossSectionalPremium(values).find((value) => value.id === id)?.percentile ?? null;
}

class RollingPercentileWindow {
  private values: number[] = [];

  public constructor(private readonly windowSize: number) {}

  public reset(): void {
    this.values = [];
  }

  public percentile(value: number | null): number | null {
    if (value === null || !Number.isFinite(value) || this.values.length < this.windowSize) return null;
    return this.values.filter((entry) => entry <= value).length / this.values.length;
  }

  public push(value: number | null): void {
    if (value === null || !Number.isFinite(value)) return;
    this.values.push(value);
    if (this.values.length > this.windowSize) this.values.shift();
  }
}

function trailingVolatility(bars: Map<number, Bar>, lifecycle: LifecycleInterval[], timestamp: number): number | null {
  const lifecycleId = lifecycleIdAtTimestamp(timestamp, lifecycle);
  if (lifecycleId === null) return null;
  const returns: number[] = [];
  for (let step = 23; step >= 0; step -= 1) {
    const currentTime = timestamp - step * HOUR_MS;
    const previousTime = currentTime - HOUR_MS;
    if (lifecycleIdAtTimestamp(currentTime, lifecycle) !== lifecycleId
      || lifecycleIdAtTimestamp(previousTime, lifecycle) !== lifecycleId) return null;
    const current = bars.get(currentTime);
    const previous = bars.get(previousTime);
    if (current === undefined || previous === undefined || current.close <= 0 || previous.close <= 0) return null;
    returns.push(Math.log(current.close / previous.close));
  }
  return Math.sqrt(returns.reduce((total, value) => total + value * value, 0) / returns.length);
}

function trailingLiquidity(bars: Map<number, Bar>, lifecycle: LifecycleInterval[], timestamp: number): number | null {
  const lifecycleId = lifecycleIdAtTimestamp(timestamp, lifecycle);
  if (lifecycleId === null) return null;
  let total = 0;
  for (let step = 23; step >= 0; step -= 1) {
    const currentTime = timestamp - step * HOUR_MS;
    if (lifecycleIdAtTimestamp(currentTime, lifecycle) !== lifecycleId) return null;
    const bar = bars.get(currentTime);
    if (bar === undefined || !Number.isFinite(bar.quoteAssetVolume)) return null;
    total += bar.quoteAssetVolume;
  }
  return total / 24;
}

function fourHourReturn(bars: Map<number, Bar>, lifecycle: LifecycleInterval[], timestamp: number): number | null {
  const current = bars.get(timestamp);
  const previous = bars.get(timestamp - 4 * HOUR_MS);
  const lifecycleId = lifecycleIdAtTimestamp(timestamp, lifecycle);
  if (current === undefined || previous === undefined || lifecycleId === null
    || lifecycleIdAtTimestamp(timestamp - 4 * HOUR_MS, lifecycle) !== lifecycleId
    || previous.close <= 0) return null;
  return current.close / previous.close - 1;
}

async function loadFrozenInputs(): Promise<FrozenInputs> {
  const [report, coverage, funding, matching, hypothesis, dataset, artifactHashes] = await Promise.all([
    readJson(R510A_REPORT_PATH),
    readJson(COVERAGE_PATH),
    readJson(FUNDING_PATH),
    readJson(MATCHING_PATH),
    readJson(HYPOTHESIS_PATH),
    readJson(DATASET_PATH),
    readJson(HASHES_PATH),
  ]);
  const computedProtocolHashes = {
    protocol_manifest: protocolManifestHash(matching, hypothesis),
    funding_manifest: sha256Json(funding),
    holdout_dataset: sha256Json(dataset),
    matching_protocol: sha256Json(matching),
  };
  const protocolGate = verifyExactHashes(EXPECTED_PROTOCOL_HASHES, computedProtocolHashes);
  const artifactHashValues = {
    protocol_manifest: artifactHashes.protocol_manifest_hash,
    funding_manifest: asRecord(artifactHashes.funding_manifest).sha256,
    holdout_dataset: artifactHashes.holdout_dataset_hash,
    matching_protocol: artifactHashes.matching_protocol_hash,
  };
  expectValue(artifactHashValues, EXPECTED_PROTOCOL_HASHES, "artifact_hashes");
  expectValue(asRecord(report.artifact_hashes).protocol_manifest_hash, EXPECTED_PROTOCOL_HASHES.protocol_manifest, "report.protocol_hash");
  expectValue(asRecord(report.artifact_hashes).funding_manifest, asRecord(artifactHashes.funding_manifest), "report.funding_hash");
  if (!protocolGate.passed) throw new Error(`RESEARCH_INVALID:PROTOCOL_HASH:${protocolGate.mismatches.join(",")}`);

  const r57Feature = await readJson(R57_FEATURE_PATH);
  const r58a = await readJson(R58A_PATH);
  const r58a1 = await readJson(R58A1_PATH);
  const semanticValues = {
    r57_feature_specification: sha256Json(r57Feature),
    r58a_hypothesis_manifest: sha256Json(r58a),
    r58a1_cutoff_manifest: sha256Json(asRecord(r58a1.manifest)),
  };
  const semanticGate = verifyExactHashes(EXPECTED_SEMANTIC_HASHES, semanticValues);
  if (!semanticGate.passed) throw new Error(`RESEARCH_INVALID:SEMANTIC_HASH:${semanticGate.mismatches.join(",")}`);
  expectValue(r58a1.r57_feature_hash, EXPECTED_SEMANTIC_HASHES.r57_feature_specification, "r58a1.r57_feature_hash");
  expectValue(r58a1.r58a_hypothesis_hash, EXPECTED_SEMANTIC_HASHES.r58a_hypothesis_manifest, "r58a1.r58a_hypothesis_hash");
  expectValue(r58a1.cutoff_manifest_hash, EXPECTED_SEMANTIC_HASHES.r58a1_cutoff_manifest, "r58a1.cutoff_hash");

  const outcomeBytes = await readFile(OUTCOME_PATH);
  const outcomeHash = createHash("sha256").update(outcomeBytes).digest("hex");
  if (outcomeHash !== EXPECTED_OUTCOME_HASH) throw new Error("RESEARCH_INVALID:OUTCOME_IMPLEMENTATION_HASH");
  if (!outcomeIdentityIncludesDirection("BTCUSDT", 1_000, "BULLISH", "1h")
    || !outcomeIdentityIncludesDirection("BTCUSDT", 1_000, "BEARISH", "1h")) {
    throw new Error("RESEARCH_INVALID:OUTCOME_IDENTITY");
  }
  const [runnerSource, helperSource, matchingSource, statisticsSource, classificationSource] = await Promise.all([
    readFile(RUNNER_PATH, "utf8"),
    readFile(HELPER_PATH, "utf8"),
    readFile(MATCHING_SOURCE_PATH, "utf8"),
    readFile(STATISTICS_SOURCE_PATH, "utf8"),
    readFile(CLASSIFICATION_SOURCE_PATH, "utf8"),
  ]);
  const sourceHashes = {
    runner_source_hash: sourceBytesHash([relativePath(RUNNER_PATH), relativePath(HELPER_PATH)], [runnerSource, helperSource]),
    outcome_hash: outcomeHash,
    matching_hash: createHash("sha256").update(matchingSource).digest("hex"),
    statistics_hash: createHash("sha256").update(statisticsSource).digest("hex"),
    classification_hash: createHash("sha256").update(classificationSource).digest("hex"),
    representation: "runner/helper use sourceBytesHash(path + NUL + UTF-8 bytes); module hashes use raw UTF-8 source bytes",
  };

  expectValue(report.classification, "HOLDOUT_PROTOCOL_READY", "r510a.classification");
  expectValue(report.candidate, "B4 PRICE_PREMIUM_DIVERGENCE", "r510a.candidate");
  expectValue(report.holdout_start, new Date(R510B_HOLDOUT_START).toISOString(), "r510a.holdout_start");
  expectValue(report.holdout_end_exclusive, new Date(R510B_HOLDOUT_END_EXCLUSIVE).toISOString(), "r510a.holdout_end_exclusive");
  expectValue(report.eligible_b4_bullish_events, EXPECTED_ELIGIBLE.bullish, "r510a.eligible_bullish");
  expectValue(report.eligible_b4_bearish_events, EXPECTED_ELIGIBLE.bearish, "r510a.eligible_bearish");
  expectValue(report.potential_matched_bullish, EXPECTED_MATCHED.bullish, "r510a.matched_bullish");
  expectValue(report.potential_matched_bearish, EXPECTED_MATCHED.bearish, "r510a.matched_bearish");
  expectValue(matching.matched_fields, [...R510A_MATCH_FIELDS], "matching.fields");
  if ((R510A_MATCH_FIELDS as readonly string[]).some((field) => field === "feature_strength" || field === "b4_feature_strength")) {
    throw new Error("RESEARCH_INVALID:FEATURE_STRENGTH_IN_MATCHING");
  }
  expectValue(funding.pit_safe, true, "funding.pit_safe");
  expectValue(asRecord(dataset.schema).conflicts, 0, "dataset.schema_conflicts");
  expectValue(asRecord(dataset.coverage).outcome_window_locked, true, "dataset.outcome_lock");
  return {
    report,
    coverage,
    funding,
    matching,
    hypothesis,
    dataset,
    artifactHashes,
    protocolGate,
    semanticGate,
    outcomeHash,
    sourceHashes,
  };
}

function parseAligned(content: string, symbol: string): Map<number, AlignedRow> {
  const lines = csvLines(content);
  const expectedHeader = ["timestamp", "pit_available_at", "premium_close", "index_close", "mark_close", "perpetual_close"];
  expectValue(lines[0]?.split(","), expectedHeader, `aligned.header:${symbol}`);
  const rows = new Map<number, AlignedRow>();
  let previous: number | null = null;
  for (const line of lines.slice(1)) {
    const cells = line.split(",").map((cell) => cell.trim());
    if (cells.length !== expectedHeader.length) throw new Error(`DATA_INVALID:ALIGNED_COLUMNS:${symbol}`);
    const [timestamp, pitAvailableAt, premium, index, mark, perpetual] = cells.map(finiteNumber);
    if (![timestamp, pitAvailableAt, premium, index, mark, perpetual].every(Number.isFinite)
      || !Number.isInteger(timestamp) || timestamp < WARMUP_START || timestamp >= R510B_HOLDOUT_END_EXCLUSIVE
      || pitAvailableAt !== timestamp + STEP_MS || index <= 0 || mark <= 0 || perpetual <= 0) {
      throw new Error(`DATA_INVALID:ALIGNED_ROW:${symbol}`);
    }
    if (previous !== null && timestamp - previous !== STEP_MS) throw new Error(`DATA_INVALID:ALIGNED_CADENCE:${symbol}`);
    if (rows.has(timestamp)) throw new Error(`DATA_INVALID:ALIGNED_DUPLICATE:${symbol}`);
    rows.set(timestamp, { timestamp, pitAvailableAt, premium, index, mark, perpetual });
    previous = timestamp;
  }
  return rows;
}

function parsePerpetual(content: string, symbol: string): Map<number, Bar> {
  const parsed = parseBinanceKlineCsv(content, { family: "PERPETUAL_PRICE", resolution: RESOLUTION });
  if (parsed.invalidRowCount > 0 || parsed.duplicateTimestampCount > 0 || parsed.outOfOrderCount > 0
    || parsed.cadenceBreakCount > 0 || parsed.boundaryViolationCount > 0) {
    throw new Error(`DATA_INVALID:PERPETUAL:${symbol}`);
  }
  const output = new Map<number, Bar>();
  for (const row of parsed.rows) {
    if (row.openTime < WARMUP_START || row.openTime >= R510B_HOLDOUT_END_EXCLUSIVE) {
      throw new Error(`DATA_INVALID:PERPETUAL_RANGE:${symbol}`);
    }
    output.set(row.openTime, {
      close: row.close,
      high: row.high,
      low: row.low,
      quoteAssetVolume: row.quoteAssetVolume,
    });
  }
  return output;
}

function parseFunding(content: string, symbol: string): R510AFundingObservation[] {
  const lines = csvLines(content);
  const header = ["funding_time", "pit_available_at", "funding_interval_hours", "funding_rate"];
  expectValue(lines[0]?.split(","), header, `funding.header:${symbol}`);
  const rows: R510AFundingObservation[] = [];
  let previous: number | null = null;
  for (const line of lines.slice(1)) {
    const cells = line.split(",").map((cell) => cell.trim());
    if (cells.length !== header.length) throw new Error(`DATA_INVALID:FUNDING_COLUMNS:${symbol}`);
    const [fundingTime, pitAvailableAt, fundingIntervalHours, fundingRate] = cells.map(finiteNumber);
    if (![fundingTime, pitAvailableAt, fundingIntervalHours, fundingRate].every(Number.isFinite)
      || !Number.isInteger(fundingTime) || !Number.isInteger(pitAvailableAt)
      || fundingTime < WARMUP_START || fundingTime >= R510B_HOLDOUT_END_EXCLUSIVE
      || pitAvailableAt < fundingTime || fundingIntervalHours <= 0) {
      throw new Error(`DATA_INVALID:FUNDING_ROW:${symbol}`);
    }
    if (previous !== null && fundingTime < previous) throw new Error(`DATA_INVALID:FUNDING_ORDER:${symbol}`);
    rows.push({ fundingTime, pitAvailableAt, fundingIntervalHours, fundingRate });
    previous = fundingTime;
  }
  return rows;
}

function buildSymbolObservations(
  symbol: string,
  lifecycle: LifecycleInterval[],
  aligned: Map<number, AlignedRow>,
  perpetual: Map<number, Bar>,
  funding: R510AFundingObservation[],
): Observation[] {
  const timestamps = [...aligned.keys()].sort((left, right) => left - right);
  const output: Observation[] = [];
  const priceWindow = new RollingPercentileWindow(R510A_ROLLING_HISTORY);
  const premiumWindow = new RollingPercentileWindow(R510A_ROLLING_HISTORY);
  let previousTime: number | null = null;
  let previousLifecycleId: string | null = null;
  for (const timestamp of timestamps) {
    const row = aligned.get(timestamp)!;
    const currentLifecycleId = lifecycleIdAtTimestamp(timestamp, lifecycle);
    if (currentLifecycleId === null) continue;
    const contiguous = previousTime !== null
      && timestamp - previousTime === STEP_MS
      && currentLifecycleId === previousLifecycleId;
    if (!contiguous) {
      priceWindow.reset();
      premiumWindow.reset();
    }
    const previousRow = contiguous ? aligned.get(timestamp - STEP_MS) : undefined;
    const previousPerpetual = contiguous ? perpetual.get(timestamp - STEP_MS) : undefined;
    const priceChange = previousPerpetual === undefined || previousPerpetual.close <= 0
      ? null
      : row.perpetual / previousPerpetual.close - 1;
    const premiumChange = previousRow === undefined ? null : row.premium - previousRow.premium;
    const priceChangePercentile = priceWindow.percentile(priceChange);
    const premiumChangePercentile = premiumWindow.percentile(premiumChange);
    const b4Direction = b4DivergenceDirection({
      priceChangePercentile,
      premiumChangePercentile,
      historyAvailable: priceChangePercentile !== null && premiumChangePercentile !== null,
    });
    const fundingMapping = mapFundingAtDecision(funding, timestamp + STEP_MS);
    const basis = perpIndexBasis(row.perpetual, row.index);
    if (basis === null) throw new Error(`DATA_INVALID:BASIS:${symbol}:${String(timestamp)}`);
    const volatilityValue = trailingVolatility(perpetual, lifecycle, timestamp);
    const liquidityValue = trailingLiquidity(perpetual, lifecycle, timestamp);
    output.push({
      symbol,
      observationTime: timestamp,
      decisionTime: timestamp + STEP_MS,
      lifecycleId: currentLifecycleId,
      referencePrice: row.perpetual,
      premium: row.premium,
      index: row.index,
      mark: row.mark,
      perpetual: row.perpetual,
      priceChange,
      premiumChange,
      priceChangePercentile,
      premiumChangePercentile,
      fourHourReturn: fourHourReturn(perpetual, lifecycle, timestamp),
      volatilityValue,
      liquidityValue,
      marketRegime: "UNKNOWN",
      volatilityBucket: bucketVolatility(volatilityValue),
      liquidityBucket: "UNKNOWN",
      fundingRate: fundingMapping.observation?.fundingRate ?? null,
      fundingTime: fundingMapping.observation?.fundingTime ?? null,
      fundingBucket: fundingMapping.bucket,
      existingMarkIndexBasis: row.mark / row.index - 1,
      existingMarkIndexBasisBucket: bucketBasis(row.mark / row.index - 1),
      calendarPeriod: quarterKey(timestamp),
      b4Direction,
      b4EventDirection: null,
      b4FeatureStrength: b4Direction === null ? "NORMAL" : "EXTREME",
      matchKey: "",
    });
    priceWindow.push(priceChange);
    premiumWindow.push(premiumChange);
    previousTime = timestamp;
    previousLifecycleId = currentLifecycleId;
  }
  return output;
}

function addCrossSectionalContext(observations: Observation[]): void {
  const byTimestamp = new Map<number, Observation[]>();
  for (const observation of observations) {
    const values = byTimestamp.get(observation.observationTime) ?? [];
    values.push(observation);
    byTimestamp.set(observation.observationTime, values);
  }
  for (const values of byTimestamp.values()) {
    const returns = values.map((value) => value.fourHourReturn).filter((value): value is number => value !== null);
    const broad = median(returns);
    const regime = broad === null ? "UNKNOWN" : broad > 0.005 ? "UP" : broad < -0.005 ? "DOWN" : "RANGE";
    const liquidityValues = values.map((value) => ({ id: value.symbol, value: value.liquidityValue }));
    for (const observation of values) {
      observation.marketRegime = regime;
      observation.liquidityBucket = bucketLiquidity(crossSectionalPercentile(liquidityValues, observation.symbol));
      if (observation.fundingBucket === null || observation.existingMarkIndexBasisBucket === "UNKNOWN"
        || observation.marketRegime === "UNKNOWN" || observation.volatilityBucket === "UNKNOWN" || observation.liquidityBucket === "UNKNOWN") {
        observation.matchKey = "";
        continue;
      }
      observation.matchKey = makeExistingInformationMatchKey({
        symbol: observation.symbol,
        calendarPeriod: observation.calendarPeriod,
        marketRegime: observation.marketRegime,
        volatilityBucket: observation.volatilityBucket,
        liquidityBucket: observation.liquidityBucket,
        fundingBucket: observation.fundingBucket,
        markIndexBasisBucket: observation.existingMarkIndexBasisBucket,
      });
    }
  }
}

function formB4Events(observations: Observation[]): void {
  const bySymbol = new Map<string, Observation[]>();
  for (const observation of observations) {
    const values = bySymbol.get(observation.symbol) ?? [];
    values.push(observation);
    bySymbol.set(observation.symbol, values);
  }
  for (const values of bySymbol.values()) {
    let previousDirection: Direction | null = null;
    let previousTime: number | null = null;
    let previousLifecycleId: string | null = null;
    for (const observation of values.sort((left, right) => left.observationTime - right.observationTime)) {
      if (previousTime === null || observation.observationTime - previousTime !== STEP_MS || observation.lifecycleId !== previousLifecycleId) {
        previousDirection = null;
      }
      if (observation.b4Direction !== null && observation.b4Direction !== previousDirection) {
        observation.b4EventDirection = observation.b4Direction;
      }
      previousDirection = observation.b4Direction;
      previousTime = observation.observationTime;
      previousLifecycleId = observation.lifecycleId;
    }
  }
}

function isInHoldout(timestamp: number): boolean {
  return timestamp >= R510B_HOLDOUT_START && timestamp < R510B_HOLDOUT_END_EXCLUSIVE;
}

function formalContextReady(observation: Observation): boolean {
  return observation.matchKey.length > 0;
}

function makePoint(observation: Observation): Point {
  return { time: observation.decisionTime, matchKey: observation.matchKey, observation };
}

function matchDirection(observations: Observation[], direction: Direction): MatchResult {
  const allEvents = observations.filter((observation) => isInHoldout(observation.observationTime) && observation.b4EventDirection === direction);
  const incompleteEvents = allEvents.filter((observation) => !formalContextReady(observation));
  const events = allEvents.filter(formalContextReady).map(makePoint);
  const controls = observations
    .filter((observation) => isInHoldout(observation.observationTime)
      && observation.b4Direction === null
      && formalContextReady(observation))
    .map(makePoint);
  return {
    allEvents,
    incompleteEvents,
    events,
    controls,
    pairs: matchNearestWithoutReplacement(events, controls).pairs,
  };
}

function preTreatmentBalance(pairs: Array<{ event: Point; control: Point }>): JsonRecord {
  const fieldMap: Record<string, (observation: Observation) => string> = {
    symbol: (value) => value.symbol,
    calendar_period: (value) => value.calendarPeriod,
    market_regime: (value) => value.marketRegime,
    volatility_bucket: (value) => value.volatilityBucket,
    liquidity_bucket: (value) => value.liquidityBucket,
    funding_bucket: (value) => value.fundingBucket ?? "CONTROL_DATA_INCOMPLETE",
    mark_index_basis_bucket: (value) => value.existingMarkIndexBasisBucket,
  };
  const fields: JsonRecord = {};
  let maxTotalVariation: number | null = pairs.length === 0 ? null : 0;
  for (const field of R510A_MATCH_FIELDS) {
    const accessor = fieldMap[field];
    const eventValues = pairs.map((pair) => accessor(pair.event.observation));
    const controlValues = pairs.map((pair) => accessor(pair.control.observation));
    const tv = totalVariationDistance(eventValues, controlValues);
    fields[field] = { total_variation: tv, event_distribution: distribution(eventValues), control_distribution: distribution(controlValues) };
    if (tv !== null) maxTotalVariation = Math.max(maxTotalVariation ?? 0, tv);
  }
  return {
    fields,
    compared_pairs: pairs.length,
    max_total_variation: maxTotalVariation,
    severe_threshold: R510A_PRE_TREATMENT_TV_THRESHOLD,
    status: preTreatmentBalancePass(maxTotalVariation) ? "PASS" : "FAIL",
  };
}

function featureStrengthAudit(pairs: Array<{ event: Point; control: Point }>): JsonRecord {
  const eventValues = pairs.map((pair) => pair.event.observation.b4FeatureStrength);
  const controlValues = pairs.map((pair) => pair.control.observation.b4FeatureStrength);
  return {
    excluded_from_matching: true,
    balance_gate: false,
    interpretation: "EXPECTED_TREATMENT_SEPARATION",
    event_distribution: distribution(eventValues),
    control_distribution: distribution(controlValues),
    total_variation: totalVariationDistance(eventValues, controlValues),
  };
}

function bucketCounts(values: string[]): JsonRecord {
  return distribution(values);
}

function weekKey(timestamp: number): string {
  const date = new Date(timestamp);
  const dayFromMonday = (date.getUTCDay() + 6) % 7;
  return iso(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - dayFromMonday))!;
}

function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function concentration(values: string[]): JsonRecord {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  const entries = Object.entries(counts).sort(([leftKey, leftCount], [rightKey, rightCount]) => rightCount - leftCount || leftKey.localeCompare(rightKey));
  const [key, count] = entries[0] ?? [null, 0];
  return { key, count, total: values.length, percent: values.length > 0 ? count / values.length * 100 : null };
}

function summarizeOutcomes(evaluations: OutcomeEvaluation[], horizon: Horizon, direction?: Direction): JsonRecord {
  const rows = evaluations.filter((row) => row.horizon === horizon && (direction === undefined || row.direction === direction));
  const samples: PairedOutcomeSample[] = rows.map((row) => ({
    signalReturn: Number(row.signalCorrect),
    controlReturn: Number(row.controlCorrect),
    signalMfe: row.signalMfe,
    controlMfe: row.controlMfe,
    signalMae: row.signalMae,
    controlMae: row.controlMae,
  }));
  const seedOffset = horizon === "1h" ? 0 : horizon === "4h" ? 10 : horizon === "12h" ? 20 : 30;
  const directionOffset = direction === "BULLISH" ? 1 : direction === "BEARISH" ? 2 : 0;
  const statistics = horizon === "1h" || horizon === "4h"
    ? pairedStatistics(samples, R510B_RANDOM_SEED + seedOffset + directionOffset, R510B_BOOTSTRAP_REPLICATES, R510B_PERMUTATION_REPLICATES)
    : null;
  const signalReturns = rows.map((row) => row.signalReturn);
  const controlReturns = rows.map((row) => row.controlReturn);
  const signalMfe = rows.map((row) => row.signalMfe);
  const signalMae = rows.map((row) => row.signalMae);
  const controlMfe = rows.map((row) => row.controlMfe);
  const controlMae = rows.map((row) => row.controlMae);
  return {
    horizon,
    direction: direction ?? "POOLED",
    sample_size: rows.length,
    signal_precision: precision(signalReturns),
    control_b_precision: precision(controlReturns),
    incremental_lift: statistics?.effect ?? null,
    confidence_interval_95: statistics?.confidenceInterval95 ?? null,
    permutation_p_value: statistics?.rawPValue ?? null,
    bootstrap_replicates: statistics?.bootstrapReplicates ?? null,
    permutation_replicates: statistics?.permutationReplicates ?? null,
    seed: statistics?.seed ?? null,
    signal_average_directional_return: mean(signalReturns),
    control_average_directional_return: mean(controlReturns),
    signal_median_directional_return: median(signalReturns),
    control_median_directional_return: median(controlReturns),
    signal_mean_favorable_move: mean(signalMfe),
    signal_mean_adverse_move: mean(signalMae),
    control_mean_favorable_move: mean(controlMfe),
    control_mean_adverse_move: mean(controlMae),
  };
}

function outcomeIdentityAudit(keys: string[]): JsonRecord {
  const unique = new Set(keys);
  return {
    generated_identity_count: keys.length,
    unique_identity_count: unique.size,
    unique: unique.size === keys.length,
    includes_direction_and_horizon: keys.every((key) => key.split("|").length === 4),
    sample: [...keys].sort().slice(0, 8),
    sha256: sha256Json([...keys].sort()),
  };
}

function testStatus(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function booleanStatus(value: boolean): string {
  return value ? "PASS" : "FAIL";
}

function buildMarkdown(report: JsonRecord): string {
  const primary = asRecord(report.primary);
  const gates = asRecord(report.gates);
  const concentrationEvidence = asRecord(report.concentration);
  const safety = asRecord(report.safety);
  const lines = [
    "# HY-R5.10B B4 Independent Holdout Confirmation",
    "",
    `- Classification: **${String(report.classification)}**`,
    `- Candidate: ${String(report.candidate)}`,
    `- Holdout: ${String(report.holdout_range)}`,
    `- Window unchanged: ${String(report.window_unchanged)}`,
    `- Confirmation executions: ${String(report.confirmation_executions)}`,
    `- Future outcomes generated: ${String(report.future_outcomes_generated)}`,
    `- Performance lock: ${String(report.performance_lock)}`,
    "",
    "## Frozen gates",
    "",
    `- Protocol hashes: ${String(report.all_protocol_hashes_verified)}`,
    `- Semantic hashes: ${String(report.semantic_hashes_verified)}`,
    `- Outcome implementation: ${String(report.outcome_implementation_verified)}`,
    `- PIT: ${String(report.pit_safe)}`,
    `- Funding Control: ${String(gates.funding_control)}`,
    `- Existing Mark/Index Control: ${String(gates.existing_mark_index_control)}`,
    `- Pre-treatment balance: ${String(gates.pre_treatment_balance)}`,
    `- Max pre-treatment TV: ${String(gates.max_pre_treatment_tv)}`,
    `- Feature-strength TV (audit only): ${String(gates.feature_strength_tv)}`,
    "",
    "## Primary hypothesis — H-B4-1H-POOLED",
    "",
    `- Signal precision: ${String(primary.signal_precision)}`,
    `- Control-B precision: ${String(primary.control_b_precision)}`,
    `- Incremental lift: ${String(primary.incremental_lift)}`,
    `- 95% CI: ${JSON.stringify(primary.confidence_interval_95)}`,
    `- Permutation p: ${String(primary.permutation_p_value)}`,
    `- Sample size: ${String(primary.sample_size)}`,
    "",
    "## Secondary and exploratory outcomes",
    "",
    "The JSON report contains bullish/bearish 1h, pooled/bullish/bearish 4h, and 12h/24h exploratory summaries. Secondary results cannot rescue a failed primary.",
    "",
    "## Concentration",
    "",
    `- Largest symbol: ${JSON.stringify(concentrationEvidence.largest_symbol)}`,
    `- Largest day: ${JSON.stringify(concentrationEvidence.largest_day)}`,
    `- Largest week: ${JSON.stringify(concentrationEvidence.largest_week)}`,
    `- Gate: ${String(concentrationEvidence.gate)}`,
    `- Regime distribution: ${JSON.stringify(concentrationEvidence.regime_distribution)}`,
    `- Regime concentrated (>80%): ${String(concentrationEvidence.regime_concentrated)}`,
    "",
    "## Discovery comparison",
    "",
    `- Discovery direction reproduced: ${String(report.discovery_direction_reproduced)}`,
    `- Effect attenuation: ${JSON.stringify(report.effect_attenuation)}`,
    "",
    "## Verification",
    "",
    `- Tests: ${String(report.tests)}`,
    `- Typecheck: ${String(report.typecheck)}`,
    `- Lint: ${String(report.lint)}`,
    `- Diff check: ${String(report.diff_check)}`,
    `- Post-result tuning: ${String(report.post_result_tuning)}`,
    `- Safety: ${JSON.stringify(safety)}`,
    "",
    "No Production, Supabase, Vercel, PAPER strategy, email, private API, order, or commit action was performed.",
    "",
    "STOP — await acceptance before any later shadow or email decision.",
    "",
  ];
  return lines.join("\n");
}

async function loadMarketData(symbols: string[], lifecycleMap: Map<string, LifecycleInterval[]>): Promise<{
  alignedBySymbol: Map<string, Map<number, AlignedRow>>;
  perpetualBySymbol: Map<string, Map<number, Bar>>;
  fundingBySymbol: Map<string, R510AFundingObservation[]>;
}> {
  const alignedBySymbol = new Map<string, Map<number, AlignedRow>>();
  const perpetualBySymbol = new Map<string, Map<number, Bar>>();
  const fundingBySymbol = new Map<string, R510AFundingObservation[]>();
  for (const symbol of symbols) {
    const [alignedContent, perpetualContent, fundingContent] = await Promise.all([
      readFile(resolve(MATERIALIZED_ROOT, "aligned", `${symbol}-1h.csv`), "utf8"),
      readFile(resolve(MATERIALIZED_ROOT, "families", "perpetual_price", `${symbol}-1h.csv`), "utf8"),
      readFile(resolve(MATERIALIZED_ROOT, "funding", `${symbol}.csv`), "utf8"),
    ]);
    const aligned = parseAligned(alignedContent, symbol);
    const perpetual = parsePerpetual(perpetualContent, symbol);
    const funding = parseFunding(fundingContent, symbol);
    const lifecycle = lifecycleMap.get(symbol) ?? [];
    const expectedHoldout = [...aligned.values()].filter((row) => isInHoldout(row.timestamp)
      && lifecycleIdAtTimestamp(row.timestamp, lifecycle) !== null).length;
    if (expectedHoldout !== 528) throw new Error(`DATA_INVALID:HOLDOUT_SLOTS:${symbol}:${String(expectedHoldout)}`);
    alignedBySymbol.set(symbol, aligned);
    perpetualBySymbol.set(symbol, perpetual);
    fundingBySymbol.set(symbol, funding);
  }
  return { alignedBySymbol, perpetualBySymbol, fundingBySymbol };
}

function makeOutcomeEvaluation(
  pairIndex: number,
  direction: Direction,
  horizon: Horizon,
  event: Point,
  control: Point,
  signal: ReturnType<typeof calculateDirectionalOutcome>,
  controlOutcome: ReturnType<typeof calculateDirectionalOutcome>,
): OutcomeEvaluation | null {
  if (signal === null || controlOutcome === null) return null;
  const signalIdentity = directionalOutcomeCacheKey({
    symbol: event.observation.symbol,
    timestamp: event.observation.observationTime,
    direction,
    horizon,
  });
  const controlIdentity = directionalOutcomeCacheKey({
    symbol: control.observation.symbol,
    timestamp: control.observation.observationTime,
    direction,
    horizon,
  });
  return {
    pairIndex,
    direction,
    horizon,
    signalIdentity,
    controlIdentity,
    signalSymbol: event.observation.symbol,
    controlSymbol: control.observation.symbol,
    signalTimestamp: event.observation.observationTime,
    controlTimestamp: control.observation.observationTime,
    signalReturn: signal.directionalReturn,
    controlReturn: controlOutcome.directionalReturn,
    signalMfe: signal.maxFavorableMove,
    signalMae: signal.maxAdverseMove,
    controlMfe: controlOutcome.maxFavorableMove,
    controlMae: controlOutcome.maxAdverseMove,
    signalCorrect: signal.directionalReturn > 0,
    controlCorrect: controlOutcome.directionalReturn > 0,
  };
}

async function writePreConfirmationFreeze(inputs: FrozenInputs, observed: JsonRecord, preFreezeSourceHash: string): Promise<void> {
  const freeze = {
    research: "HY-R5.10B B4 INDEPENDENT TEMPORAL HOLDOUT CONFIRMATION",
    version: "hy-r5.10b-b4-independent-holdout-confirmation-v1",
    candidate: "B4 PRICE_PREMIUM_DIVERGENCE",
    primary_hypothesis: R510B_PRIMARY_HYPOTHESIS,
    primary_horizon: R510B_PRIMARY_HORIZON,
    holdout_start: new Date(R510B_HOLDOUT_START).toISOString(),
    holdout_end_exclusive: new Date(R510B_HOLDOUT_END_EXCLUSIVE).toISOString(),
    holdout_range: `${new Date(R510B_HOLDOUT_START).toISOString()} → ${new Date(R510B_HOLDOUT_END_EXCLUSIVE - 1).toISOString()}`,
    exact_window_lock: true,
    september_extension_rejected: true,
    protocol_hashes: {
      expected: EXPECTED_PROTOCOL_HASHES,
      computed: inputs.protocolGate.computed,
      verified: inputs.protocolGate.passed,
    },
    semantic_hashes: {
      expected: EXPECTED_SEMANTIC_HASHES,
      computed: inputs.semanticGate.computed,
      verified: inputs.semanticGate.passed,
    },
    outcome_implementation_hash: inputs.outcomeHash,
    outcome_implementation_expected_hash: EXPECTED_OUTCOME_HASH,
    outcome_identity: "symbol|timestamp|direction|horizon",
    outcome_identity_direction_verified: true,
    source_hashes: { ...inputs.sourceHashes, pre_freeze_source_hash: preFreezeSourceHash },
    matching: {
      fields: [...R510A_MATCH_FIELDS],
      feature_strength_in_matching: false,
      funding_unknown_policy: "CONTROL_DATA_INCOMPLETE; no formal Control-B row",
      pre_treatment_threshold: R510A_PRE_TREATMENT_TV_THRESHOLD,
      sample_gate: { ...R510A_MINIMUM_SAMPLE },
      coverage_gate: { ...R510A_MATCHING_COVERAGE_MINIMUM },
    },
    statistical_policy: {
      random_seed: R510B_RANDOM_SEED,
      bootstrap_replicates: R510B_BOOTSTRAP_REPLICATES,
      permutation_replicates: R510B_PERMUTATION_REPLICATES,
      primary_multiple_testing: "NONE; one pre-registered primary hypothesis",
      secondary: "descriptive; cannot rescue primary",
    },
    observed_before_outcome: observed,
    confirmation_executions: 0,
    future_outcomes_generated: 0,
    performance_lock: "NOT_TRIGGERED",
    future_performance_calculated: false,
    post_result_tuning: "NO",
    generated_at: new Date().toISOString(),
    safety: {
      production_modified: false,
      supabase_modified: false,
      vercel_modified: false,
      paper_strategy_modified: false,
      emails_sent: 0,
      private_api_called: false,
      orders_called: false,
      auto_trading: false,
      commit_created: false,
    },
  };
  await writeFile(PREFREEZE_PATH, `${JSON.stringify(freeze, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  if (await fileExists(PREFREEZE_PATH) || await fileExists(REPORT_JSON_PATH)) {
    throw new Error("AUTHORITATIVE_CONFIRMATION_INVALIDATED:OUTPUT_ALREADY_EXISTS_NO_RERUN");
  }
  if (!Number.isFinite(R510B_HOLDOUT_START) || !Number.isFinite(R510B_HOLDOUT_END_EXCLUSIVE)
    || R510B_HOLDOUT_END_EXCLUSIVE !== Date.parse("2026-09-01T00:00:00.000Z")) {
    throw new Error("RESEARCH_INVALID:EXACT_HOLDOUT_WINDOW");
  }
  const inputs = await loadFrozenInputs();
  const listingDocument = await readJson(LISTING_EVIDENCE_PATH);
  const listings = (Array.isArray(listingDocument.symbols) ? listingDocument.symbols : [])
    .map(asRecord)
    .filter((listing): listing is ListingRecord => typeof listing.symbol === "string"
      && Number.isFinite(listing.onboardDate) && Number.isFinite(listing.deliveryDate));
  const lifecycleMap = new Map(listings.map((listing) => [listing.symbol, lifecycleIntervalsForSymbol(listing, relativePath(LISTING_EVIDENCE_PATH))]));
  const datasetSymbols = Array.isArray(inputs.dataset.eligible_symbols)
    ? inputs.dataset.eligible_symbols.filter((symbol): symbol is string => typeof symbol === "string").sort()
    : [];
  if (datasetSymbols.length !== 49) throw new Error("RESEARCH_INVALID:UNIVERSE_SIZE");
  const eligibleListings = datasetSymbols.map((symbol) => {
    const listing = listings.find((value) => value.symbol === symbol);
    if (listing === undefined) throw new Error(`RESEARCH_INVALID:LISTING_MISSING:${symbol}`);
    return listing;
  });
  const marketData = await loadMarketData(datasetSymbols, lifecycleMap);
  const observations = datasetSymbols.flatMap((symbol) => buildSymbolObservations(
    symbol,
    lifecycleMap.get(symbol) ?? [],
    marketData.alignedBySymbol.get(symbol)!,
    marketData.perpetualBySymbol.get(symbol)!,
    marketData.fundingBySymbol.get(symbol)!,
  ));
  addCrossSectionalContext(observations);
  formB4Events(observations);
  const bullish = matchDirection(observations, "BULLISH");
  const bearish = matchDirection(observations, "BEARISH");
  const pooledPairs = [...bullish.pairs, ...bearish.pairs];
  const pooledEligible = bullish.events.length + bearish.events.length;
  const pooledCoverage = pooledMatchingCoveragePercent(pooledPairs.length, pooledEligible);
  const balance = preTreatmentBalance(pooledPairs);
  const strengthAudit = featureStrengthAudit(pooledPairs);
  const fundingAlignedSlots = observations.filter((observation) => isInHoldout(observation.observationTime)).length;
  const fundingCompleteSlots = observations.filter((observation) => isInHoldout(observation.observationTime) && observation.fundingBucket !== null).length;
  const fundingCoveragePercent = pooledMatchingCoveragePercent(fundingCompleteSlots, fundingAlignedSlots);
  const incompleteEvents = [...bullish.incompleteEvents, ...bearish.incompleteEvents];
  const reconstructedCounts = {
    eligible_bullish: bullish.allEvents.length,
    eligible_bearish: bearish.allEvents.length,
    matched_bullish: bullish.pairs.length,
    matched_bearish: bearish.pairs.length,
    pooled_eligible: pooledEligible,
    pooled_matched: pooledPairs.length,
    pooled_matching_coverage_percent: pooledCoverage,
    funding_aligned_slots: fundingAlignedSlots,
    funding_complete_slots: fundingCompleteSlots,
    funding_mapping_coverage_percent: fundingCoveragePercent,
  };
  expectValue(reconstructedCounts.eligible_bullish, EXPECTED_ELIGIBLE.bullish, "reconstructed.eligible_bullish");
  expectValue(reconstructedCounts.eligible_bearish, EXPECTED_ELIGIBLE.bearish, "reconstructed.eligible_bearish");
  expectValue(reconstructedCounts.matched_bullish, EXPECTED_MATCHED.bullish, "reconstructed.matched_bullish");
  expectValue(reconstructedCounts.matched_bearish, EXPECTED_MATCHED.bearish, "reconstructed.matched_bearish");
  expectValue(reconstructedCounts.pooled_matched, 2_946, "reconstructed.pooled_matched");
  if (incompleteEvents.length !== 0 || fundingCoveragePercent !== 100) throw new Error("RESEARCH_INVALID:CONTROL_DATA_INCOMPLETE");

  const sampleGatePreOutcome = minimumSampleGate({
    pooled: pooledPairs.length,
    bullish: bullish.pairs.length,
    bearish: bearish.pairs.length,
  });
  const directionCoverage = {
    bullish: pooledMatchingCoveragePercent(bullish.pairs.length, bullish.allEvents.length),
    bearish: pooledMatchingCoveragePercent(bearish.pairs.length, bearish.allEvents.length),
  };
  const coverageGate = matchingCoverageGate({
    pooled: pooledCoverage ?? 0,
    bullish: directionCoverage.bullish ?? 0,
    bearish: directionCoverage.bearish ?? 0,
  });
  const pitPass = observations.every((observation) => observation.decisionTime === observation.observationTime + STEP_MS)
    && observations.every((observation) => !isInHoldout(observation.observationTime)
      || observation.fundingTime === null || observation.fundingTime <= observation.decisionTime);
  const basisComplete = observations.filter((observation) => isInHoldout(observation.observationTime))
    .every((observation) => observation.existingMarkIndexBasisBucket !== "UNKNOWN");
  const alignedRows = observations.filter((observation) => isInHoldout(observation.observationTime)).length;
  const maxTv = balance.max_total_variation;
  const observedBeforeOutcome = {
    eligible_universe: datasetSymbols,
    aligned_holdout_slots: alignedRows,
    reconstructed_counts: reconstructedCounts,
    direction_coverage: directionCoverage,
    sample_gate: sampleGatePreOutcome,
    matching_coverage_gate: coverageGate,
    pre_treatment_balance: balance.status,
    max_pre_treatment_tv: maxTv,
    feature_strength_audit: strengthAudit,
    funding_control: fundingCoveragePercent === 100 && incompleteEvents.length === 0 ? "COMPLETE" : "CONTROL_DATA_INCOMPLETE",
    existing_mark_index_control: basisComplete ? "COMPLETE" : "INCOMPLETE",
    pit_safe: pitPass,
    exact_window: {
      start: new Date(R510B_HOLDOUT_START).toISOString(),
      end_exclusive: new Date(R510B_HOLDOUT_END_EXCLUSIVE).toISOString(),
    },
    no_outcomes_generated: true,
  };
  const currentRunnerSource = await readFile(RUNNER_PATH, "utf8");
  const preFreezeSourceHash = sourceBytesHash([relativePath(RUNNER_PATH)], [currentRunnerSource]);
  await writePreConfirmationFreeze(inputs, observedBeforeOutcome, preFreezeSourceHash);

  const outcomeEvaluations: OutcomeEvaluation[] = [];
  const outcomeKeys: string[] = [];
  let individualOutcomeRows = 0;
  let incompleteOutcomePairs = 0;
  let pairIndex = 0;
  for (const pair of pooledPairs) {
    const direction = pair.event.observation.b4EventDirection;
    if (direction === null) throw new Error("AUTHORITATIVE_CONFIRMATION_INVALIDATED:PAIR_DIRECTION_MISSING");
    const signalBars = marketData.perpetualBySymbol.get(pair.event.observation.symbol)!;
    const controlBars = marketData.perpetualBySymbol.get(pair.control.observation.symbol)!;
    for (const horizon of HORIZONS) {
      const horizonHours = Number.parseInt(horizon, 10);
      const signal = calculateDirectionalOutcome({
        observationTime: pair.event.observation.observationTime,
        referencePrice: pair.event.observation.referencePrice,
        direction,
        horizonHours,
        bars: signalBars,
      });
      const controlOutcome = calculateDirectionalOutcome({
        observationTime: pair.control.observation.observationTime,
        referencePrice: pair.control.observation.referencePrice,
        direction,
        horizonHours,
        bars: controlBars,
      });
      if (signal !== null) {
        individualOutcomeRows += 1;
        outcomeKeys.push(directionalOutcomeCacheKey({
          symbol: pair.event.observation.symbol,
          timestamp: pair.event.observation.observationTime,
          direction,
          horizon,
        }));
      }
      if (controlOutcome !== null) {
        individualOutcomeRows += 1;
        outcomeKeys.push(directionalOutcomeCacheKey({
          symbol: pair.control.observation.symbol,
          timestamp: pair.control.observation.observationTime,
          direction,
          horizon,
        }));
      }
      const evaluation = makeOutcomeEvaluation(pairIndex, direction, horizon, pair.event, pair.control, signal, controlOutcome);
      if (evaluation === null) incompleteOutcomePairs += 1;
      else outcomeEvaluations.push(evaluation);
    }
    pairIndex += 1;
  }
  const performanceLock = updatePerformanceLock("NOT_TRIGGERED", individualOutcomeRows);
  if (performanceLock !== "TRIGGERED" || individualOutcomeRows === 0) {
    throw new Error("AUTHORITATIVE_CONFIRMATION_INVALIDATED:PERFORMANCE_LOCK_NOT_TRIGGERED");
  }
  const identityAudit = outcomeIdentityAudit(outcomeKeys);
  const implementationInvalidated = !identityAudit.unique || !identityAudit.includes_direction_and_horizon
    || outcomeKeys.some((key) => key.split("|").length !== 4);
  const pooledOneHour = summarizeOutcomes(outcomeEvaluations, "1h");
  const bullishOneHour = summarizeOutcomes(outcomeEvaluations, "1h", "BULLISH");
  const bearishOneHour = summarizeOutcomes(outcomeEvaluations, "1h", "BEARISH");
  const pooledFourHour = summarizeOutcomes(outcomeEvaluations, "4h");
  const bullishFourHour = summarizeOutcomes(outcomeEvaluations, "4h", "BULLISH");
  const bearishFourHour = summarizeOutcomes(outcomeEvaluations, "4h", "BEARISH");
  const exploratory = {
    pooled_12h: summarizeOutcomes(outcomeEvaluations, "12h"),
    pooled_24h: summarizeOutcomes(outcomeEvaluations, "24h"),
  };

  const eventSymbols = pooledPairs.map((pair) => pair.event.observation.symbol);
  const eventDays = pooledPairs.map((pair) => dayKey(pair.event.observation.observationTime));
  const eventWeeks = pooledPairs.map((pair) => weekKey(pair.event.observation.observationTime));
  const eventRegimes = pooledPairs.map((pair) => pair.event.observation.marketRegime);
  const largestSymbol = concentration(eventSymbols);
  const largestDay = concentration(eventDays);
  const largestWeek = concentration(eventWeeks);
  const regimeDistribution = bucketCounts(eventRegimes);
  const regimeEntries = Object.entries(asRecord(regimeDistribution.categories));
  const largestRegimeFraction = regimeEntries.reduce((max, [, value]) => Math.max(max, Number(asRecord(value).fraction ?? 0)), 0);
  const regimeConcentrated = largestRegimeFraction > 0.8;
  const concentrationGate = concentrationPass(Number(largestSymbol.percent), Number(largestWeek.percent));
  const primaryStats = asRecord(pooledOneHour);
  const actualOutcomeSampleGate = minimumSampleGate({
    pooled: Number(primaryStats.sample_size),
    bullish: Number(asRecord(bullishOneHour).sample_size),
    bearish: Number(asRecord(bearishOneHour).sample_size),
  });
  const effect = typeof primaryStats.incremental_lift === "number" ? primaryStats.incremental_lift : null;
  const confidenceInterval = primaryStats.confidence_interval_95 === null ? null : asRecord(primaryStats.confidence_interval_95);
  const classification: R510BClassification = classifyPrimaryDecision({
    invalid: false,
    implementationInvalidated,
    dataComplete: alignedRows === 25_872 && fundingCoveragePercent === 100 && basisComplete,
    sampleGate: sampleGatePreOutcome && actualOutcomeSampleGate,
    matchingGate: coverageGate,
    balancePass: balance.status === "PASS",
    fundingComplete: fundingCoveragePercent === 100 && incompleteEvents.length === 0,
    markIndexComplete: basisComplete,
    pitPass,
    concentrationPass: concentrationGate,
    effect,
    confidenceInterval: confidenceInterval === null ? null : {
      lower: Number(confidenceInterval.lower),
      upper: Number(confidenceInterval.upper),
    },
  });
  if (!allowedR510BClassification(classification)) throw new Error("AUTHORITATIVE_CONFIRMATION_INVALIDATED:CLASSIFICATION");
  const discoveryBullish = Number(asRecord(bullishOneHour).incremental_lift);
  const discoveryBearish = Number(asRecord(bearishOneHour).incremental_lift);
  const discoveryDirectionReproduced = Number.isFinite(discoveryBullish) && Number.isFinite(discoveryBearish)
    && discoveryBullish > 0 && discoveryBearish > 0;
  const effectAttenuation = {
    discovery_bullish_1h_lift: 0.1261786,
    discovery_bearish_1h_lift: 0.125672,
    holdout_bullish_1h_lift: Number.isFinite(discoveryBullish) ? discoveryBullish : null,
    holdout_bearish_1h_lift: Number.isFinite(discoveryBearish) ? discoveryBearish : null,
    bullish_ratio: Number.isFinite(discoveryBullish) && discoveryBullish !== 0 ? discoveryBullish / 0.1261786 : null,
    bearish_ratio: Number.isFinite(discoveryBearish) && discoveryBearish !== 0 ? discoveryBearish / 0.125672 : null,
    interpretation: "descriptive comparison only; never used for matching, filtering, or classification gates",
  };
  const r510aCoverage = asRecord(inputs.report.coverage);
  const report: JsonRecord = {
    research: "HY-R5.10B B4 INDEPENDENT TEMPORAL HOLDOUT CONFIRMATION",
    version: "hy-r5.10b-b4-independent-holdout-confirmation-v1",
    generated_at: new Date().toISOString(),
    candidate: "B4 PRICE_PREMIUM_DIVERGENCE",
    hypothesis: "DIVERGENCE_REVERSAL",
    primary_hypothesis: R510B_PRIMARY_HYPOTHESIS,
    primary_metric: "POOLED_DIRECTIONAL_1H_INCREMENTAL_PRECISION",
    holdout_range: `${new Date(R510B_HOLDOUT_START).toISOString()} → ${new Date(R510B_HOLDOUT_END_EXCLUSIVE - 1).toISOString()}`,
    holdout_start: new Date(R510B_HOLDOUT_START).toISOString(),
    holdout_end_exclusive: new Date(R510B_HOLDOUT_END_EXCLUSIVE).toISOString(),
    window_unchanged: "YES",
    september_data_included: "NO",
    confirmation_executions: 1,
    future_outcomes_generated: individualOutcomeRows,
    completed_paired_outcome_rows: outcomeEvaluations.length,
    incomplete_paired_outcome_rows: incompleteOutcomePairs,
    performance_lock: performanceLock,
    future_performance_calculated: true,
    post_result_tuning: "NO",
    all_protocol_hashes_verified: "YES",
    protocol_hashes: { expected: EXPECTED_PROTOCOL_HASHES, computed: inputs.protocolGate.computed },
    semantic_hashes_verified: "YES",
    semantic_hashes: { expected: EXPECTED_SEMANTIC_HASHES, computed: inputs.semanticGate.computed },
    outcome_implementation_verified: "YES",
    outcome_implementation_hash: inputs.outcomeHash,
    outcome_identity: "symbol|timestamp|direction|horizon",
    outcome_identity_audit: identityAudit,
    source_hashes: inputs.sourceHashes,
    universe: {
      count: datasetSymbols.length,
      symbols: datasetSymbols,
      listing_records_verified: eligibleListings.length,
      aligned_slots: Number(r510aCoverage.aligned_valid),
    },
    eligible_bullish: bullish.allEvents.length,
    matched_bullish: bullish.pairs.length,
    bullish_matching_coverage_percent: directionCoverage.bullish,
    eligible_bearish: bearish.allEvents.length,
    matched_bearish: bearish.pairs.length,
    bearish_matching_coverage_percent: directionCoverage.bearish,
    pooled_matching_coverage_percent: pooledCoverage,
    primary: pooledOneHour,
    secondary: {
      bullish_1h: bullishOneHour,
      bearish_1h: bearishOneHour,
      pooled_4h: pooledFourHour,
      bullish_4h: bullishFourHour,
      bearish_4h: bearishFourHour,
    },
    exploratory,
    gates: {
      pre_treatment_balance: balance.status,
      max_pre_treatment_tv: maxTv,
      severe_pre_treatment_threshold: R510A_PRE_TREATMENT_TV_THRESHOLD,
      feature_strength_tv: strengthAudit.total_variation,
      feature_strength_treated_as_balance_failure: "NO",
      sample_gate_pre_outcome: sampleGatePreOutcome ? "PASS" : "FAIL",
      sample_gate_actual_outcome: actualOutcomeSampleGate ? "PASS" : "FAIL",
      matching_coverage_gate: coverageGate ? "PASS" : "FAIL",
      funding_control: fundingCoveragePercent === 100 && incompleteEvents.length === 0 ? "COMPLETE" : "CONTROL_DATA_INCOMPLETE",
      existing_mark_index_control: basisComplete ? "COMPLETE" : "INCOMPLETE",
      pit: booleanStatus(pitPass),
      frozen_counts_match: "PASS",
    },
    concentration: {
      largest_symbol: largestSymbol,
      largest_day: largestDay,
      largest_week: largestWeek,
      gate: concentrationGate ? "PASS" : "FAIL",
      symbol_limit_percent: 10,
      week_limit_percent: 40,
      regime_distribution: regimeDistribution,
      regime_concentrated: regimeConcentrated,
      regime_concentration_limit_percent: 80,
    },
    discovery_direction_reproduced: discoveryDirectionReproduced ? "YES" : "NO",
    effect_attenuation: effectAttenuation,
    primary_failure_cannot_be_rescued_by_secondary: "YES",
    classification,
    reports: {
      pre_confirmation_freeze: relativePath(PREFREEZE_PATH),
      final_json: relativePath(REPORT_JSON_PATH),
      final_markdown: relativePath(REPORT_MD_PATH),
    },
    frozen_inputs: {
      r510a_report: relativePath(R510A_REPORT_PATH),
      coverage_manifest: relativePath(COVERAGE_PATH),
      funding_manifest: relativePath(FUNDING_PATH),
      matching_protocol_manifest: relativePath(MATCHING_PATH),
      holdout_dataset_manifest: relativePath(DATASET_PATH),
      raw_dataset_excluded_from_return: true,
    },
    tests: testStatus("HY_R510B_TEST_STATUS", "NOT_RUN"),
    typecheck: testStatus("HY_R510B_TYPECHECK_STATUS", "NOT_RUN"),
    lint: testStatus("HY_R510B_LINT_STATUS", "NOT_RUN"),
    diff_check: testStatus("HY_R510B_DIFF_STATUS", "NOT_RUN"),
    safety: {
      production_modified: false,
      supabase_modified: false,
      vercel_modified: false,
      paper_strategy_modified: false,
      scanner_modified: false,
      emails_sent: 0,
      private_api_called: false,
      orders_called: false,
      auto_trading: false,
      commit_created: false,
      migration_executed: false,
    },
  };
  if (classification === "AUTHORITATIVE_CONFIRMATION_INVALIDATED") {
    throw new Error("AUTHORITATIVE_CONFIRMATION_INVALIDATED:FINAL_REPORT_NOT_VALID");
  }
  await writeFile(REPORT_JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(REPORT_MD_PATH, buildMarkdown(report), "utf8");
  console.log(JSON.stringify({
    classification,
    holdout_range: report.holdout_range,
    confirmation_executions: report.confirmation_executions,
    future_outcomes_generated: report.future_outcomes_generated,
    primary: report.primary,
    reports: report.reports,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
