import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  BASIS_PREMIUM_FAMILIES,
  b1BasisDirection,
  b2PremiumDirection,
  b3SignedExpansionDirection,
  b4DivergenceDirection,
  b5CrossSectionalDirection,
  cutoffManifestHash,
  isPitEventAvailable,
  parseBinanceKlineCsv,
  perpIndexBasis,
  rankCrossSectionalPremium,
  resolutionMilliseconds,
  type BasisPremiumFamily,
  type BasisPremiumKline,
  type LifecycleSpan,
} from "../lib/basis-premium";
import {
  R58B_CONTROL_A_DIMENSIONS,
  R58B_CONTROL_B_ADDITIONS,
  formalHolmTestIds,
  matchingGate,
} from "../lib/basis-premium/authoritative";
import { classifyR58C } from "../lib/basis-premium/classification";
import {
  calculateDirectionalOutcome,
  directionalOutcomeCacheKey,
  type DirectionalOutcome,
} from "../lib/basis-premium/outcome";
import {
  R58C_EXPECTED_HASHES,
  applyHolmCorrection,
  formatPercentage,
  mean,
  median,
  pairedStatistics,
  precision,
  sourceBytesHash,
  totalVariationDistance,
  transitionPerformanceLock,
  type PairedOutcomeSample,
  type PerformanceLock,
} from "../lib/basis-premium/performance";
import {
  makeExistingInformationMatchKey,
  matchNearestWithoutReplacement,
  summarizeCovariateBalance,
  type MatchPair,
} from "../lib/basis-premium/information-gain";
import {
  lifecycleIntervalsForSymbol,
  sha256Json,
  stableJson,
} from "../lib/crowding";

const HISTORY_START = Date.parse("2024-08-09T00:00:00.000Z");
const HISTORY_END_EXCLUSIVE = Date.parse("2026-08-10T00:00:00.000Z");
const HISTORY_RANGE = {
  start: "2024-08-09T00:00:00.000Z",
  end: "2026-08-09T23:59:59.999Z",
} as const;
const RESOLUTION = "1h" as const;
const INTERVAL_MS = resolutionMilliseconds(RESOLUTION);
const HOUR_MS = 3_600_000;
const ROLLING_WINDOW = 720;
const EXPERIMENT_ID = "hy-r5.8c-basis-premium-authoritative-v1";
const RANDOM_SEED = 5801;
const BOOTSTRAP_REPLICATES = 2_000;
const PERMUTATION_REPLICATES = 2_000;
const MEANINGFUL_SAMPLE_MINIMUM = 30;
const MAX_ROBUST_SYMBOL_SHARE = 0.5;
const ARCHIVE_ROOT = resolve("data", "raw", "hy-r5.7-basis-premium-preflight");
const ARTIFACT_ROOT = resolve(ARCHIVE_ROOT, "artifacts");
const R57_COVERAGE_PATH = resolve(ARTIFACT_ROOT, "coverage-matrix.json");
const R57_SCHEMA_PATH = resolve(ARTIFACT_ROOT, "schema-manifest.json");
const R57_FEATURE_PATH = resolve(ARTIFACT_ROOT, "feature-specification.json");
const R57_DATASET_PATH = resolve(ARTIFACT_ROOT, "dataset-manifest.json");
const R57_ARTIFACT_HASHES_PATH = resolve(ARTIFACT_ROOT, "artifact-hashes.json");
const R57_REPORT_PATH = resolve("reports", "hy-r5.7-basis-premium-preflight.json");
const R58A_PATH = resolve("reports", "hy-r5.8a-basis-premium-hypothesis-freeze.json");
const R58A1_PATH = resolve("reports", "hy-r5.8a1-basis-premium-event-cutoff-freeze.json");
const R58B_PATH = resolve("reports", "hy-r5.8b-basis-premium-information-gain.json");
const R58B_FREEZE_PATH = resolve("reports", "hy-r5.8b-pre-performance-freeze.json");
const FREEZE_PATH = resolve("reports", "hy-r5.8c-pre-performance-freeze.json");
const JSON_REPORT_PATH = resolve("reports", "hy-r5.8c-basis-premium-information-gain.json");
const MARKDOWN_REPORT_PATH = resolve("reports", "hy-r5.8c-basis-premium-information-gain.md");
const LISTING_EVIDENCE_PATH = resolve("data", "raw", "hy-r5.2b-flow", "listing-evidence.json");

const SOURCE_PATHS = [
  "scripts/run-hy-r5-8c-basis-premium-information-gain.ts",
  "lib/basis-premium/performance.ts",
  "lib/basis-premium/outcome.ts",
  "lib/basis-premium/classification.ts",
  "lib/basis-premium/cutoff.ts",
  "lib/basis-premium/information-gain.ts",
  "lib/basis-premium/authoritative.ts",
  "lib/basis-premium/hypothesis.ts",
] as const;

type Direction = "BULLISH" | "BEARISH";
type FamilyId = "B1" | "B2" | "B3" | "B4" | "B5";
type Horizon = "1h" | "4h" | "12h" | "24h";
const FAMILIES: FamilyId[] = ["B1", "B2", "B3", "B4", "B5"];
const DIRECTIONS: Direction[] = ["BULLISH", "BEARISH"];
const HORIZONS: Horizon[] = ["1h", "4h", "12h", "24h"];
const HORIZON_HOURS: Record<Horizon, number> = { "1h": 1, "4h": 4, "12h": 12, "24h": 24 };

type JsonRecord = Record<string, unknown>;

interface ArchiveRecord {
  family: BasisPremiumFamily;
  symbol: string;
  path: string;
  status: string;
}

interface ListingRecord {
  symbol: string;
  onboardDate: number;
  deliveryDate: number;
}

interface Bar {
  close: number;
  high: number;
  low: number;
  quoteAssetVolume: number;
}

interface SymbolSeries {
  symbol: string;
  lifecycle: LifecycleSpan[];
  perpetual: Map<number, Bar>;
}

interface Observation {
  symbol: string;
  observationTime: number;
  decisionTime: number;
  referencePrice: number;
  basis: number;
  premium: number;
  signedExpansion: number | null;
  priceChange: number | null;
  premiumChange: number | null;
  basisPercentile: number | null;
  premiumPercentile: number | null;
  signedExpansionPercentile: number | null;
  priceChangePercentile: number | null;
  premiumChangePercentile: number | null;
  fourHourReturn: number | null;
  volatilityValue: number | null;
  liquidityValue: number | null;
  markIndexBasis: number;
  fundingRate: number | null;
  calendarPeriod: string;
  marketRegime: string;
  volatilityBucket: string;
  liquidityBucket: string;
  fundingStateBucket: string;
  existingMarkIndexBasisStateBucket: string;
  featureStrength: string;
  conditionDirections: Record<FamilyId, Direction | null>;
  eventDirections: Record<FamilyId, Direction | null>;
  matchKeyA: string;
  matchKeyB: string;
  fundingMatchKey: string;
  markIndexMatchKey: string;
}

interface Point {
  time: number;
  matchKey: string;
  observation: Observation;
}

interface ComponentMatch {
  family: FamilyId;
  direction: Direction;
  events: Point[];
  controls: Point[];
  pairsA: MatchPair<Point, Point>[];
  pairsB: MatchPair<Point, Point>[];
  pairsFunding: MatchPair<Point, Point>[];
  pairsMarkIndex: MatchPair<Point, Point>[];
}

interface OutcomePairSample extends PairedOutcomeSample {
  eventObservation: Observation;
  controlObservation: Observation;
}

interface CellEvaluation {
  family: FamilyId;
  direction: Direction;
  horizon: Horizon;
  eligibleEvents: number;
  matchedEvents: number;
  unmatchedEvents: number;
  matchingCoveragePercent: number | null;
  outcomeEligibleEvents: number;
  outcomeEligibleControlA: number;
  outcomeEligibleControlB: number;
  signalPrecision: number | null;
  controlAPrecision: number | null;
  controlBPrecision: number | null;
  incrementalLiftVsA: number | null;
  incrementalLiftVsB: number | null;
  meanDirectionalReturn: number | null;
  medianDirectionalReturn: number | null;
  meanReturnEffectVsB: number | null;
  medianReturnEffectVsB: number | null;
  mfeEffect: number | null;
  maeEffect: number | null;
  medianMfe: number | null;
  medianMae: number | null;
  confidenceInterval95: { lower: number; upper: number } | null;
  effectSize: number | null;
  rawPValue: number | null;
  holmAdjustedPValue: number | null;
  matchingClassification: string;
  pairedSampleSize: number;
}

interface ComponentEvaluation {
  match: ComponentMatch;
  cells: Map<Horizon, CellEvaluation>;
}

interface FrozenInputs {
  coverage: JsonRecord;
  schema: JsonRecord;
  feature: JsonRecord;
  dataset: JsonRecord;
  artifactHashes: JsonRecord;
  r57Report: JsonRecord;
  r58a: JsonRecord;
  r58a1: JsonRecord;
  r58b: JsonRecord;
  r58bFreeze: JsonRecord;
  archives: ArchiveRecord[];
  universe: string[];
  hashGate: JsonRecord;
  gateErrors: string[];
}

interface FreezeArtifacts {
  freeze: JsonRecord;
  freezeHash: string;
  runnerSourceHash: string;
  matchingHash: string;
  outcomeHash: string;
  statisticalHash: string;
  classificationHash: string;
}

interface FundingPoint {
  fundingTime: number;
  fundingRate: number;
}

interface TreeNode {
  key: number;
  count: number;
  height: number;
  size: number;
  left: TreeNode | null;
  right: TreeNode | null;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function readJson(path: string): Promise<JsonRecord> {
  return JSON.parse(await readFile(path, "utf8")) as JsonRecord;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function periodKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

function lifecycleIdAt(timestamp: number, lifecycle: LifecycleSpan[]): string | null {
  return lifecycle.find((span) => timestamp >= span.startTime && timestamp < span.endTimeExclusive)?.id ?? null;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

function extractZipCsv(buffer: Buffer): string {
  const end = findEndOfCentralDirectory(buffer);
  if (end < 0) throw new Error("ZIP_END_OF_CENTRAL_DIRECTORY_NOT_FOUND");
  const count = buffer.readUInt16LE(end + 10);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("ZIP_CENTRAL_DIRECTORY_INVALID");
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (name.toLowerCase().endsWith(".csv")) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("ZIP_LOCAL_HEADER_INVALID");
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
      const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
      if (content === null) throw new Error(`ZIP_COMPRESSION_UNSUPPORTED_${String(method)}`);
      return content.toString("utf8");
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("ZIP_CSV_NOT_FOUND");
}

function height(node: TreeNode | null): number {
  return node?.height ?? 0;
}

function size(node: TreeNode | null): number {
  return node?.size ?? 0;
}

function refresh(node: TreeNode): TreeNode {
  node.height = Math.max(height(node.left), height(node.right)) + 1;
  node.size = node.count + size(node.left) + size(node.right);
  return node;
}

function rotateRight(node: TreeNode): TreeNode {
  const child = node.left!;
  node.left = child.right;
  child.right = refresh(node);
  return refresh(child);
}

function rotateLeft(node: TreeNode): TreeNode {
  const child = node.right!;
  node.right = child.left;
  child.left = refresh(node);
  return refresh(child);
}

function balanceFactor(node: TreeNode): number {
  return height(node.left) - height(node.right);
}

function rebalance(node: TreeNode): TreeNode {
  refresh(node);
  const factor = balanceFactor(node);
  if (factor > 1) {
    if (balanceFactor(node.left!) < 0) node.left = rotateLeft(node.left!);
    return rotateRight(node);
  }
  if (factor < -1) {
    if (balanceFactor(node.right!) > 0) node.right = rotateRight(node.right!);
    return rotateLeft(node);
  }
  return node;
}

function insertNode(node: TreeNode | null, key: number): TreeNode {
  if (node === null) return { key, count: 1, height: 1, size: 1, left: null, right: null };
  if (key === node.key) node.count += 1;
  else if (key < node.key) node.left = insertNode(node.left, key);
  else node.right = insertNode(node.right, key);
  return rebalance(node);
}

function minimumNode(node: TreeNode): TreeNode {
  return node.left === null ? node : minimumNode(node.left);
}

function removeNode(node: TreeNode | null, key: number): TreeNode | null {
  if (node === null) return null;
  if (key < node.key) node.left = removeNode(node.left, key);
  else if (key > node.key) node.right = removeNode(node.right, key);
  else if (node.count > 1) node.count -= 1;
  else if (node.left === null) return node.right;
  else if (node.right === null) return node.left;
  else {
    const replacement = minimumNode(node.right);
    node.key = replacement.key;
    node.count = replacement.count;
    node.right = removeAllNode(node.right, replacement.key);
  }
  return rebalance(node);
}

function removeAllNode(node: TreeNode | null, key: number): TreeNode | null {
  if (node === null) return null;
  if (key < node.key) node.left = removeAllNode(node.left, key);
  else if (key > node.key) node.right = removeAllNode(node.right, key);
  else if (node.left === null) return node.right;
  else if (node.right === null) return node.left;
  else {
    const replacement = minimumNode(node.right);
    node.key = replacement.key;
    node.count = replacement.count;
    node.right = removeAllNode(node.right, replacement.key);
  }
  return rebalance(node);
}

function lessEqual(node: TreeNode | null, key: number): number {
  if (node === null) return 0;
  if (key < node.key) return lessEqual(node.left, key);
  return size(node.left) + node.count + lessEqual(node.right, key);
}

class RollingPercentileWindow {
  private root: TreeNode | null = null;
  private readonly values: number[];
  private count = 0;
  private cursor = 0;

  public constructor(private readonly windowSize: number) {
    this.values = new Array<number>(windowSize);
  }

  public reset(): void {
    this.root = null;
    this.count = 0;
    this.cursor = 0;
  }

  public percentile(value: number | null): number | null {
    if (value === null || !Number.isFinite(value) || this.count < this.windowSize) return null;
    return lessEqual(this.root, value) / this.count;
  }

  public push(value: number | null): void {
    if (value === null || !Number.isFinite(value)) return;
    if (this.count === this.windowSize) {
      const oldest = this.values[this.cursor]!;
      this.root = removeNode(this.root, oldest);
      this.values[this.cursor] = value;
      this.cursor = (this.cursor + 1) % this.windowSize;
    } else {
      this.values[(this.cursor + this.count) % this.windowSize] = value;
      this.count += 1;
    }
    this.root = insertNode(this.root, value);
  }
}

function rawBar(row: BasisPremiumKline): Bar {
  return {
    close: row.close,
    high: row.high,
    low: row.low,
    quoteAssetVolume: row.quoteAssetVolume,
  };
}

async function loadFamily(
  records: ArchiveRecord[],
  lifecycle: LifecycleSpan[],
): Promise<Map<number, Bar>> {
  const output = new Map<number, Bar>();
  for (const record of records
    .filter((value) => value.status === "AVAILABLE")
    .sort((left, right) => left.path.localeCompare(right.path))) {
    const csv = extractZipCsv(await readFile(record.path));
    const parsed = parseBinanceKlineCsv(csv, { family: record.family, resolution: RESOLUTION });
    for (const row of parsed.rows) {
      if (row.openTime < HISTORY_START || row.openTime >= HISTORY_END_EXCLUSIVE) continue;
      if (!lifecycle.some((span) => row.openTime >= span.startTime && row.openTime < span.endTimeExclusive)) continue;
      if (!output.has(row.openTime)) output.set(row.openTime, rawBar(row));
    }
  }
  return output;
}

function trailingVolatility(perpetual: Map<number, Bar>, timestamp: number): number | null {
  const returns: number[] = [];
  for (let step = 23; step >= 0; step -= 1) {
    const current = perpetual.get(timestamp - step * HOUR_MS);
    const previous = perpetual.get(timestamp - (step + 1) * HOUR_MS);
    if (current === undefined || previous === undefined || previous.close <= 0 || current.close <= 0) return null;
    returns.push(Math.log(current.close / previous.close));
  }
  return Math.sqrt(returns.reduce((sum, value) => sum + value * value, 0) / returns.length);
}

function trailingLiquidity(perpetual: Map<number, Bar>, timestamp: number): number | null {
  let total = 0;
  for (let step = 23; step >= 0; step -= 1) {
    const bar = perpetual.get(timestamp - step * HOUR_MS);
    if (bar === undefined || !Number.isFinite(bar.quoteAssetVolume)) return null;
    total += bar.quoteAssetVolume;
  }
  return total / 24;
}

function fourHourReturn(perpetual: Map<number, Bar>, timestamp: number): number | null {
  const current = perpetual.get(timestamp);
  const previous = perpetual.get(timestamp - 4 * HOUR_MS);
  if (current === undefined || previous === undefined || previous.close <= 0) return null;
  return current.close / previous.close - 1;
}

function bucketVolatility(value: number | null): string {
  if (value === null) return "UNKNOWN";
  if (value < 0.005) return "LOW";
  if (value < 0.015) return "NORMAL";
  return "HIGH";
}

function bucketFunding(value: number | null): string {
  if (value === null) return "UNKNOWN";
  if (value <= -0.0003) return "EXTREME_NEGATIVE";
  if (value < -0.00005) return "NEGATIVE";
  if (value <= 0.00005) return "NEUTRAL";
  if (value < 0.0003) return "POSITIVE";
  return "EXTREME_POSITIVE";
}

function bucketBasis(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "UNKNOWN";
  if (value <= -0.0005) return "EXTREME_NEGATIVE";
  if (value < 0) return "NEGATIVE";
  if (value === 0) return "NEUTRAL";
  if (value < 0.0005) return "POSITIVE";
  return "EXTREME_POSITIVE";
}

function crossSectionalPercentile(values: Array<{ id: string; value: number | null }>, id: string): number | null {
  const ranks = rankCrossSectionalPremium(values);
  return ranks.find((value) => value.id === id)?.percentile ?? null;
}

function bucketLiquidity(percentile: number | null): string {
  if (percentile === null) return "UNKNOWN";
  if (percentile <= 0.33) return "LOW";
  if (percentile <= 0.66) return "NORMAL";
  return "HIGH";
}

function marketRegime(observations: Observation[]): string {
  const returns = observations.map((value) => value.fourHourReturn).filter((value): value is number => value !== null);
  const broad = median(returns);
  if (broad === null) return "UNKNOWN";
  if (broad > 0.005) return "UP";
  if (broad < -0.005) return "DOWN";
  return "RANGE";
}

function latestFunding(points: FundingPoint[], timestamp: number): number | null {
  let low = 0;
  let high = points.length - 1;
  let selected: number | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle]!.fundingTime <= timestamp) {
      selected = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return selected === null ? null : points[selected]!.fundingRate;
}

async function loadFunding(symbol: string): Promise<FundingPoint[]> {
  try {
    const parsed = JSON.parse(await readFile(resolve("data", "hy-r2b-history-24m", `${symbol}.json`), "utf8")) as JsonRecord;
    return asArray(parsed.fundingRates)
      .filter(isRecord)
      .map((value) => ({ fundingTime: Number(value.fundingTime), fundingRate: Number(value.fundingRate) }))
      .filter((value) => Number.isInteger(value.fundingTime) && Number.isFinite(value.fundingRate)
        && value.fundingTime >= HISTORY_START && value.fundingTime < HISTORY_END_EXCLUSIVE)
      .sort((left, right) => left.fundingTime - right.fundingTime);
  } catch {
    return [];
  }
}

function emptyDirections(): Record<FamilyId, Direction | null> {
  return { B1: null, B2: null, B3: null, B4: null, B5: null };
}

function buildSymbolObservations(
  symbol: string,
  lifecycle: LifecycleSpan[],
  maps: Record<BasisPremiumFamily, Map<number, Bar>>,
  funding: FundingPoint[],
): Observation[] {
  const joint = [...maps.PREMIUM_INDEX.keys()]
    .filter((timestamp) => BASIS_PREMIUM_FAMILIES.every((family) => maps[family].has(timestamp)))
    .sort((left, right) => left - right);
  const observations: Observation[] = [];
  const basisWindow = new RollingPercentileWindow(ROLLING_WINDOW);
  const premiumWindow = new RollingPercentileWindow(ROLLING_WINDOW);
  const expansionWindow = new RollingPercentileWindow(ROLLING_WINDOW);
  const priceChangeWindow = new RollingPercentileWindow(ROLLING_WINDOW);
  const premiumChangeWindow = new RollingPercentileWindow(ROLLING_WINDOW);
  let previousTime: number | null = null;
  let previousLifecycleId: string | null = null;
  for (const timestamp of joint) {
    const currentLifecycleId = lifecycleIdAt(timestamp, lifecycle);
    const contiguous = previousTime !== null && timestamp - previousTime === INTERVAL_MS
      && currentLifecycleId !== null && currentLifecycleId === previousLifecycleId;
    if (!contiguous) {
      basisWindow.reset();
      premiumWindow.reset();
      expansionWindow.reset();
      priceChangeWindow.reset();
      premiumChangeWindow.reset();
    }
    const perpetual = maps.PERPETUAL_PRICE;
    const index = maps.INDEX_PRICE.get(timestamp)!;
    const mark = maps.MARK_PRICE.get(timestamp)!;
    const premiumBar = maps.PREMIUM_INDEX.get(timestamp)!;
    const perpBar = perpetual.get(timestamp)!;
    const basis = perpIndexBasis(perpBar.close, index.close);
    if (basis === null) throw new Error(`INVALID_BASIS_${symbol}_${String(timestamp)}`);
    const previousPremium = contiguous ? maps.PREMIUM_INDEX.get(timestamp - HOUR_MS)?.close : undefined;
    const previousPerpetual = contiguous ? perpetual.get(timestamp - HOUR_MS)?.close : undefined;
    const signedExpansion = previousPremium === undefined ? null : premiumBar.close - previousPremium;
    const priceChange = previousPerpetual === undefined || previousPerpetual <= 0
      ? null
      : perpBar.close / previousPerpetual - 1;
    const premiumChange = previousPremium === undefined ? null : premiumBar.close - previousPremium;
    const basisPercentile = basisWindow.percentile(basis);
    const premiumPercentile = premiumWindow.percentile(premiumBar.close);
    const signedExpansionPercentile = expansionWindow.percentile(signedExpansion);
    const priceChangePercentile = priceChangeWindow.percentile(priceChange);
    const premiumChangePercentile = premiumChangeWindow.percentile(premiumChange);
    const conditionDirections = emptyDirections();
    conditionDirections.B1 = b1BasisDirection({ value: basis, rollingPercentile: basisPercentile, historyAvailable: basisPercentile !== null });
    conditionDirections.B2 = b2PremiumDirection({ value: premiumBar.close, rollingPercentile: premiumPercentile, historyAvailable: premiumPercentile !== null });
    conditionDirections.B3 = b3SignedExpansionDirection({ value: signedExpansion, rollingPercentile: signedExpansionPercentile, historyAvailable: signedExpansionPercentile !== null });
    conditionDirections.B4 = b4DivergenceDirection({ priceChangePercentile, premiumChangePercentile, historyAvailable: priceChangePercentile !== null && premiumChangePercentile !== null });
    const decisionTime = timestamp + INTERVAL_MS;
    if (!isPitEventAvailable(timestamp, INTERVAL_MS, decisionTime)) throw new Error(`PIT_EVENT_UNAVAILABLE_${symbol}_${String(timestamp)}`);
    const fundingRate = latestFunding(funding, decisionTime);
    const observation: Observation = {
      symbol,
      observationTime: timestamp,
      decisionTime,
      referencePrice: perpBar.close,
      basis,
      premium: premiumBar.close,
      signedExpansion,
      priceChange,
      premiumChange,
      basisPercentile,
      premiumPercentile,
      signedExpansionPercentile,
      priceChangePercentile,
      premiumChangePercentile,
      fourHourReturn: fourHourReturn(perpetual, timestamp),
      volatilityValue: trailingVolatility(perpetual, timestamp),
      liquidityValue: trailingLiquidity(perpetual, timestamp),
      markIndexBasis: mark.close / index.close - 1,
      fundingRate,
      calendarPeriod: periodKey(timestamp),
      marketRegime: "UNKNOWN",
      volatilityBucket: bucketVolatility(trailingVolatility(perpetual, timestamp)),
      liquidityBucket: "UNKNOWN",
      fundingStateBucket: bucketFunding(fundingRate),
      existingMarkIndexBasisStateBucket: bucketBasis(mark.close / index.close - 1),
      featureStrength: "NORMAL",
      conditionDirections,
      eventDirections: emptyDirections(),
      matchKeyA: "",
      matchKeyB: "",
      fundingMatchKey: "",
      markIndexMatchKey: "",
    };
    observations.push(observation);
    basisWindow.push(basis);
    premiumWindow.push(premiumBar.close);
    expansionWindow.push(signedExpansion);
    priceChangeWindow.push(priceChange);
    premiumChangeWindow.push(premiumChange);
    previousTime = timestamp;
    previousLifecycleId = currentLifecycleId;
  }
  return observations;
}

function addCrossSectionalContext(observations: Observation[]): void {
  const byTimestamp = new Map<number, Observation[]>();
  for (const observation of observations) {
    const values = byTimestamp.get(observation.observationTime) ?? [];
    values.push(observation);
    byTimestamp.set(observation.observationTime, values);
  }
  for (const values of byTimestamp.values()) {
    const regime = marketRegime(values);
    const liquidityValues = values.map((value) => ({ id: value.symbol, value: value.liquidityValue }));
    const premiumValues = values.map((value) => ({ id: value.symbol, value: value.premium }));
    for (const observation of values) {
      observation.marketRegime = regime;
      const liquidityPercentile = crossSectionalPercentile(liquidityValues, observation.symbol);
      observation.liquidityBucket = bucketLiquidity(liquidityPercentile);
      const premiumPercentile = crossSectionalPercentile(premiumValues, observation.symbol);
      observation.conditionDirections.B5 = b5CrossSectionalDirection(premiumPercentile, premiumValues.filter((value) => value.value !== null).length);
      observation.featureStrength = Object.values(observation.conditionDirections).some((value) => value !== null) ? "EXTREME" : "NORMAL";
      observation.matchKeyA = [
        observation.symbol,
        observation.calendarPeriod,
        observation.marketRegime,
        observation.volatilityBucket,
        observation.liquidityBucket,
      ].join("|");
      observation.matchKeyB = makeExistingInformationMatchKey({
        symbol: observation.symbol,
        calendarPeriod: observation.calendarPeriod,
        marketRegime: observation.marketRegime,
        volatilityBucket: observation.volatilityBucket,
        liquidityBucket: observation.liquidityBucket,
        fundingBucket: observation.fundingStateBucket,
        markIndexBasisBucket: observation.existingMarkIndexBasisStateBucket,
      });
      observation.fundingMatchKey = [
        observation.symbol,
        observation.calendarPeriod,
        observation.marketRegime,
        observation.volatilityBucket,
        observation.liquidityBucket,
        observation.fundingStateBucket,
      ].join("|");
      observation.markIndexMatchKey = [
        observation.symbol,
        observation.calendarPeriod,
        observation.marketRegime,
        observation.volatilityBucket,
        observation.liquidityBucket,
        observation.existingMarkIndexBasisStateBucket,
      ].join("|");
    }
  }
}

function formEvents(observations: Observation[], lifecycleBySymbol: Map<string, LifecycleSpan[]>): void {
  const bySymbol = new Map<string, Observation[]>();
  for (const observation of observations) {
    const values = bySymbol.get(observation.symbol) ?? [];
    values.push(observation);
    bySymbol.set(observation.symbol, values);
  }
  for (const [symbol, values] of bySymbol) {
    const lifecycle = lifecycleBySymbol.get(symbol) ?? [];
    let previousDirections = emptyDirections();
    let previousTime: number | null = null;
    let previousLifecycleId: string | null = null;
    for (const observation of values.sort((left, right) => left.observationTime - right.observationTime)) {
      const currentLifecycleId = lifecycleIdAt(observation.observationTime, lifecycle);
      if (previousTime === null || observation.observationTime - previousTime !== INTERVAL_MS || currentLifecycleId !== previousLifecycleId) {
        previousDirections = emptyDirections();
      }
      for (const family of FAMILIES) {
        const current = observation.conditionDirections[family];
        if (current !== null && current !== previousDirections[family]) observation.eventDirections[family] = current;
      }
      previousDirections = { ...observation.conditionDirections };
      previousTime = observation.observationTime;
      previousLifecycleId = currentLifecycleId;
    }
  }
}

function makePoint(observation: Observation, key: "A" | "B" | "FUNDING" | "MARK"): Point {
  const matchKey = key === "A"
    ? observation.matchKeyA
    : key === "B"
      ? observation.matchKeyB
      : key === "FUNDING"
        ? observation.fundingMatchKey
        : observation.markIndexMatchKey;
  return { time: observation.decisionTime, matchKey, observation };
}

function buildMatches(observations: Observation[]): ComponentEvaluation[] {
  const evaluations: ComponentEvaluation[] = [];
  for (const family of FAMILIES) {
    const controls = observations
      .filter((observation) => observation.conditionDirections[family] === null)
      .map((observation) => makePoint(observation, "B"));
    for (const direction of DIRECTIONS) {
      const eventObservations = observations.filter((observation) => observation.eventDirections[family] === direction);
      const events = eventObservations.map((observation) => makePoint(observation, "B"));
      const controlA = controls.map((point) => ({ ...point, matchKey: point.observation.matchKeyA }));
      const controlB = controls;
      const fundingControls = controls.map((point) => ({ ...point, matchKey: point.observation.fundingMatchKey }));
      const markControls = controls.map((point) => ({ ...point, matchKey: point.observation.markIndexMatchKey }));
      const pairsA = matchNearestWithoutReplacement(
        events.map((point) => ({ ...point, matchKey: point.observation.matchKeyA })),
        controlA,
      ).pairs;
      const pairsB = matchNearestWithoutReplacement(events, controlB).pairs;
      const pairsFunding = matchNearestWithoutReplacement(
        events.map((point) => ({ ...point, matchKey: point.observation.fundingMatchKey })),
        fundingControls,
      ).pairs;
      const pairsMarkIndex = matchNearestWithoutReplacement(
        events.map((point) => ({ ...point, matchKey: point.observation.markIndexMatchKey })),
        markControls,
      ).pairs;
      evaluations.push({
        match: {
          family,
          direction,
          events,
          controls,
          pairsA,
          pairsB,
          pairsFunding,
          pairsMarkIndex,
        },
        cells: new Map(),
      });
    }
  }
  return evaluations;
}

function outcomeKey(point: Point, direction: Direction, horizon: Horizon): string {
  return directionalOutcomeCacheKey({
    symbol: point.observation.symbol,
    timestamp: point.observation.observationTime,
    direction,
    horizon,
  });
}

function calculatePointOutcome(
  point: Point,
  direction: Direction,
  horizon: Horizon,
  seriesBySymbol: Map<string, SymbolSeries>,
): DirectionalOutcome | null {
  const series = seriesBySymbol.get(point.observation.symbol);
  if (series === undefined) return null;
  return calculateDirectionalOutcome({
    observationTime: point.observation.observationTime,
    referencePrice: point.observation.referencePrice,
    direction,
    horizonHours: HORIZON_HOURS[horizon],
    bars: series.perpetual,
  });
}

function buildOutcomeCache(
  evaluations: ComponentEvaluation[],
  seriesBySymbol: Map<string, SymbolSeries>,
): { cache: Map<string, DirectionalOutcome | null>; successfulEventRows: number; successfulRowsIncludingControls: number } {
  interface DirectionalEventPoint extends Point {
    direction: Direction;
  }

  const eventPoints = new Map<string, DirectionalEventPoint>();
  for (const evaluation of evaluations) {
    for (const point of evaluation.match.events) {
      const direction = evaluation.match.direction;
      const key = directionalOutcomeCacheKey({
        symbol: point.observation.symbol,
        timestamp: point.observation.observationTime,
        direction,
        horizon: "event",
      });
      eventPoints.set(key, { ...point, direction });
    }
  }
  const cache = new Map<string, DirectionalOutcome | null>();
  let successfulEventRows = 0;
  for (const point of eventPoints.values()) {
    for (const horizon of HORIZONS) {
      const key = outcomeKey(point, point.direction, horizon);
      const outcome = calculatePointOutcome(point, point.direction, horizon, seriesBySymbol);
      cache.set(key, outcome);
      if (outcome !== null) successfulEventRows += 1;
    }
  }
  let successfulRowsIncludingControls = successfulEventRows;
  for (const evaluation of evaluations) {
    for (const pair of evaluation.match.pairsB) {
      for (const horizon of HORIZONS) {
        const key = outcomeKey(pair.control, evaluation.match.direction, horizon);
        if (cache.has(key)) continue;
        const outcome = calculatePointOutcome(pair.control, evaluation.match.direction, horizon, seriesBySymbol);
        cache.set(key, outcome);
        if (outcome !== null) successfulRowsIncludingControls += 1;
      }
    }
  }
  return { cache, successfulEventRows, successfulRowsIncludingControls };
}

function outcomeSamples(
  pairs: MatchPair<Point, Point>[],
  direction: Direction,
  horizon: Horizon,
  cache: Map<string, DirectionalOutcome | null>,
): OutcomePairSample[] {
  const samples: OutcomePairSample[] = [];
  for (const pair of pairs) {
    const eventOutcome = cache.get(outcomeKey(pair.event, direction, horizon));
    const controlOutcome = cache.get(outcomeKey(pair.control, direction, horizon));
    if (eventOutcome === null || eventOutcome === undefined || controlOutcome === null || controlOutcome === undefined) continue;
    samples.push({
      signalReturn: eventOutcome.directionalReturn,
      controlReturn: controlOutcome.directionalReturn,
      signalMfe: eventOutcome.maxFavorableMove,
      controlMfe: controlOutcome.maxFavorableMove,
      signalMae: eventOutcome.maxAdverseMove,
      controlMae: controlOutcome.maxAdverseMove,
      eventObservation: pair.event.observation,
      controlObservation: pair.control.observation,
    });
  }
  return samples;
}

function cellSeed(family: FamilyId, direction: Direction, horizon: Horizon): number {
  const digest = createHash("sha256").update(`${EXPERIMENT_ID}|${family}|${direction}|${horizon}`, "utf8").digest();
  return RANDOM_SEED + digest.readUInt32LE(0);
}

function evaluateCell(
  component: ComponentEvaluation,
  horizon: Horizon,
  cache: Map<string, DirectionalOutcome | null>,
): CellEvaluation {
  const { family, direction, events, pairsA, pairsB } = component.match;
  const samplesA = outcomeSamples(pairsA, direction, horizon, cache);
  const samplesB = outcomeSamples(pairsB, direction, horizon, cache);
  const signalReturns = samplesB.map((sample) => sample.signalReturn);
  const controlAReturns = samplesA.map((sample) => sample.controlReturn);
  const controlBReturns = samplesB.map((sample) => sample.controlReturn);
  const signalPrecision = precision(signalReturns);
  const controlAPrecision = precision(controlAReturns);
  const controlBPrecision = precision(controlBReturns);
  const precisionSamples = samplesB.map((sample) => ({
    signalReturn: sample.signalReturn > 0 ? 1 : 0,
    controlReturn: sample.controlReturn > 0 ? 1 : 0,
  }));
  const statistics = pairedStatistics(precisionSamples, cellSeed(family, direction, horizon), BOOTSTRAP_REPLICATES, PERMUTATION_REPLICATES);
  const matchingCoveragePercent = events.length === 0 ? null : pairsB.length / events.length * 100;
  return {
    family,
    direction,
    horizon,
    eligibleEvents: events.length,
    matchedEvents: pairsB.length,
    unmatchedEvents: events.length - pairsB.length,
    matchingCoveragePercent,
    outcomeEligibleEvents: samplesB.length,
    outcomeEligibleControlA: samplesA.length,
    outcomeEligibleControlB: samplesB.length,
    signalPrecision,
    controlAPrecision,
    controlBPrecision,
    incrementalLiftVsA: signalPrecision === null || controlAPrecision === null ? null : signalPrecision - controlAPrecision,
    incrementalLiftVsB: signalPrecision === null || controlBPrecision === null ? null : signalPrecision - controlBPrecision,
    meanDirectionalReturn: mean(signalReturns),
    medianDirectionalReturn: median(signalReturns),
    meanReturnEffectVsB: mean(samplesB.map((sample) => sample.signalReturn - sample.controlReturn)),
    medianReturnEffectVsB: median(samplesB.map((sample) => sample.signalReturn - sample.controlReturn)),
    mfeEffect: mean(samplesB.map((sample) => sample.signalMfe! - sample.controlMfe!)),
    maeEffect: mean(samplesB.map((sample) => sample.signalMae! - sample.controlMae!)),
    medianMfe: median(samplesB.map((sample) => sample.signalMfe!)),
    medianMae: median(samplesB.map((sample) => sample.signalMae!)),
    confidenceInterval95: statistics?.confidenceInterval95 ?? null,
    effectSize: statistics?.effect ?? null,
    rawPValue: statistics?.rawPValue ?? null,
    holmAdjustedPValue: null,
    matchingClassification: matchingGate(matchingCoveragePercent ?? Number.NaN),
    pairedSampleSize: statistics?.sampleSize ?? 0,
  };
}

function setHolmAdjustedPValues(evaluations: ComponentEvaluation[]): void {
  const pValues = evaluations.flatMap((evaluation) => HORIZONS.map((horizon) => {
    const cell = evaluation.cells.get(horizon)!;
    return { id: `${evaluation.match.family}:${evaluation.match.direction}:${horizon}`, pValue: cell.rawPValue };
  }));
  const adjusted = applyHolmCorrection(pValues);
  for (const evaluation of evaluations) {
    for (const horizon of HORIZONS) {
      const cell = evaluation.cells.get(horizon)!;
      cell.holmAdjustedPValue = adjusted[`${evaluation.match.family}:${evaluation.match.direction}:${horizon}`] ?? null;
    }
  }
}

function cellToJson(cell: CellEvaluation): JsonRecord {
  return {
    family: cell.family,
    direction: cell.direction,
    horizon: cell.horizon,
    status: cell.eligibleEvents === 0 ? "NO_EVENTS" : cell.matchedEvents === 0 ? "MATCHING_INADEQUATE_COMPONENT" : "COMPUTED",
    eligible_events: cell.eligibleEvents,
    matched_events: cell.matchedEvents,
    unmatched_events: cell.unmatchedEvents,
    matching_coverage_percent: cell.matchingCoveragePercent,
    outcome_eligible_events: cell.outcomeEligibleEvents,
    outcome_eligible_control_a: cell.outcomeEligibleControlA,
    outcome_eligible_control_b: cell.outcomeEligibleControlB,
    signal_precision: cell.signalPrecision,
    control_a_precision: cell.controlAPrecision,
    control_b_precision: cell.controlBPrecision,
    incremental_lift_vs_control_a: cell.incrementalLiftVsA,
    incremental_lift_vs_control_b: cell.incrementalLiftVsB,
    mean_directional_return: cell.meanDirectionalReturn,
    median_directional_return: cell.medianDirectionalReturn,
    mean_return_effect_vs_control_b: cell.meanReturnEffectVsB,
    median_return_effect_vs_control_b: cell.medianReturnEffectVsB,
    mfe_effect: cell.mfeEffect,
    mae_effect: cell.maeEffect,
    median_mfe: cell.medianMfe,
    median_mae: cell.medianMae,
    confidence_interval_95: cell.confidenceInterval95,
    effect_size: cell.effectSize,
    effect_size_metric: "paired_precision_difference_vs_control_b",
    raw_p_value: cell.rawPValue,
    holm_adjusted_p_value: cell.holmAdjustedPValue,
    matching_classification: cell.matchingClassification,
    paired_sample_size: cell.pairedSampleSize,
  };
}

function allCellList(evaluations: ComponentEvaluation[]): CellEvaluation[] {
  return evaluations.flatMap((evaluation) => HORIZONS.map((horizon) => evaluation.cells.get(horizon)!));
}

function bestCell(evaluations: ComponentEvaluation[]): CellEvaluation | null {
  const candidates = allCellList(evaluations).filter((cell) => cell.incrementalLiftVsB !== null && cell.effectSize !== null);
  return candidates.sort((left, right) => (right.incrementalLiftVsB! - left.incrementalLiftVsB!)
    || (left.rawPValue! - right.rawPValue!)
    || `${left.family}:${left.direction}:${left.horizon}`.localeCompare(`${right.family}:${right.direction}:${right.horizon}`))[0] ?? null;
}

function balanceFor(component: ComponentEvaluation): JsonRecord {
  const pairs = component.match.pairsB;
  const fields = [
    "symbol",
    "calendarPeriod",
    "marketRegime",
    "volatilityBucket",
    "liquidityBucket",
    "fundingStateBucket",
    "existingMarkIndexBasisStateBucket",
    "featureStrength",
  ];
  const eventRecords = pairs.map((pair) => ({
    symbol: pair.event.observation.symbol,
    calendarPeriod: pair.event.observation.calendarPeriod,
    marketRegime: pair.event.observation.marketRegime,
    volatilityBucket: pair.event.observation.volatilityBucket,
    liquidityBucket: pair.event.observation.liquidityBucket,
    fundingStateBucket: pair.event.observation.fundingStateBucket,
    existingMarkIndexBasisStateBucket: pair.event.observation.existingMarkIndexBasisStateBucket,
    featureStrength: pair.event.observation.featureStrength,
  }));
  const controlRecords = pairs.map((pair) => ({
    symbol: pair.control.observation.symbol,
    calendarPeriod: pair.control.observation.calendarPeriod,
    marketRegime: pair.control.observation.marketRegime,
    volatilityBucket: pair.control.observation.volatilityBucket,
    liquidityBucket: pair.control.observation.liquidityBucket,
    fundingStateBucket: pair.control.observation.fundingStateBucket,
    existingMarkIndexBasisStateBucket: pair.control.observation.existingMarkIndexBasisStateBucket,
    featureStrength: pair.control.observation.featureStrength,
  }));
  const exact = summarizeCovariateBalance(pairs.map((pair) => ({ event: eventRecords[pairs.indexOf(pair)]!, control: controlRecords[pairs.indexOf(pair)]! })), fields);
  const fieldBalance: JsonRecord = {};
  let severe = false;
  for (const field of fields) {
    const left = eventRecords.map((record) => String(record[field as keyof typeof record]));
    const right = controlRecords.map((record) => String(record[field as keyof typeof record]));
    const tv = totalVariationDistance(left, right);
    if (tv !== null && tv > 0.5) severe = true;
    fieldBalance[field] = { total_variation_distance: tv, exact_match_fraction: exact.fields[field]?.balance ?? null };
  }
  return {
    matched_pairs: pairs.length,
    eligible_events: component.match.events.length,
    unmatched_events: component.match.events.length - pairs.length,
    metric: "total_variation_distance_with_exact_match_fraction",
    fields: fieldBalance,
    severe_imbalance: severe,
    acceptable: !severe,
  };
}

function stabilityFor(
  component: ComponentEvaluation,
  best: CellEvaluation,
  cache: Map<string, DirectionalOutcome | null>,
): JsonRecord {
  const samples = outcomeSamples(component.match.pairsB, best.direction, best.horizon, cache);
  const byQuarter = new Map<string, number[]>();
  const byRegime = new Map<string, number[]>();
  const symbols = new Map<string, number>();
  for (const sample of samples) {
    const difference = sample.signalReturn - sample.controlReturn;
    const quarter = sample.eventObservation.calendarPeriod;
    const regime = sample.eventObservation.marketRegime;
    const quarterValues = byQuarter.get(quarter) ?? [];
    quarterValues.push(difference);
    byQuarter.set(quarter, quarterValues);
    const regimeValues = byRegime.get(regime) ?? [];
    regimeValues.push(difference);
    byRegime.set(regime, regimeValues);
    symbols.set(sample.eventObservation.symbol, (symbols.get(sample.eventObservation.symbol) ?? 0) + 1);
  }
  const quarterEffects = Object.fromEntries([...byQuarter.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([quarter, values]) => [quarter, { sample_size: values.length, mean_effect: mean(values), sign: (mean(values) ?? 0) > 0 ? "POSITIVE" : (mean(values) ?? 0) < 0 ? "NEGATIVE" : "ZERO" }]));
  const regimeEffects = Object.fromEntries([...byRegime.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([regime, values]) => [regime, { sample_size: values.length, mean_effect: mean(values), sign: (mean(values) ?? 0) > 0 ? "POSITIVE" : (mean(values) ?? 0) < 0 ? "NEGATIVE" : "ZERO" }]));
  const positiveQuarters = [...byQuarter.values()].filter((values) => (mean(values) ?? 0) > 0).length;
  const positiveRegimes = [...byRegime.values()].filter((values) => (mean(values) ?? 0) > 0).length;
  const positiveQuarterRatio = byQuarter.size === 0 ? null : positiveQuarters / byQuarter.size;
  const positiveRegimeRatio = byRegime.size === 0 ? null : positiveRegimes / byRegime.size;
  const largestQuarterContribution = samples.length === 0 ? null : Math.max(...[...byQuarter.values()].map((values) => values.length)) / samples.length;
  const largestSymbolConcentration = samples.length === 0 ? null : Math.max(...symbols.values()) / samples.length;
  const stableAcrossQuarters = byQuarter.size >= 3 && (positiveQuarterRatio ?? 0) >= 0.6 && (largestQuarterContribution ?? 1) <= 0.5;
  const stableAcrossRegimes = byRegime.size >= 2 && (positiveRegimeRatio ?? 0) >= 0.75;
  return {
    selected_cell: `${best.family}:${best.direction}:${best.horizon}`,
    sample_size: samples.length,
    quarters: quarterEffects,
    regimes: regimeEffects,
    positive_quarter_ratio: formatPercentage(positiveQuarterRatio),
    positive_regime_ratio: formatPercentage(positiveRegimeRatio),
    largest_quarter_contribution_percent: formatPercentage(largestQuarterContribution),
    largest_symbol_concentration_percent: formatPercentage(largestSymbolConcentration),
    stable_across_quarters: stableAcrossQuarters,
    stable_across_regimes: stableAcrossRegimes,
    regime_effect_signs: Object.fromEntries([...byRegime.keys()].sort().map((regime) => [regime, (regimeEffects[regime] as JsonRecord).sign])),
  };
}

function componentByCell(evaluations: ComponentEvaluation[], cell: CellEvaluation): ComponentEvaluation {
  return evaluations.find((evaluation) => evaluation.match.family === cell.family && evaluation.match.direction === cell.direction)!;
}

function attributionFor(
  evaluations: ComponentEvaluation[],
  cache: Map<string, DirectionalOutcome | null>,
): JsonRecord {
  const output: JsonRecord = {};
  for (const evaluation of evaluations) {
    const byHorizon: JsonRecord = {};
    for (const horizon of HORIZONS) {
      const cell = evaluation.cells.get(horizon)!;
      const rawSamples = outcomeSamples(evaluation.match.pairsA, evaluation.match.direction, horizon, cache);
      const formalSamples = outcomeSamples(evaluation.match.pairsB, evaluation.match.direction, horizon, cache);
      const attributionPairs = evaluation.match.family === "B1"
        ? outcomeSamples(evaluation.match.pairsMarkIndex, evaluation.match.direction, horizon, cache)
        : outcomeSamples(evaluation.match.pairsFunding, evaluation.match.direction, horizon, cache);
      const attributionPrecision = precision(attributionPairs.map((sample) => sample.controlReturn));
      const signalPrecision = precision(formalSamples.map((sample) => sample.signalReturn));
      const controlAPrecision = precision(rawSamples.map((sample) => sample.controlReturn));
      byHorizon[horizon] = {
        signal_precision: signalPrecision,
        uncontrolled_control_a_precision: controlAPrecision,
        raw_effect_vs_control_a: signalPrecision === null || controlAPrecision === null ? null : signalPrecision - controlAPrecision,
        attribution_control_precision: attributionPrecision,
        attribution_effect: signalPrecision === null || attributionPrecision === null ? null : signalPrecision - attributionPrecision,
        attribution_type: evaluation.match.family === "B1" ? "existing_mark_index_basis_control" : ["B2", "B3"].includes(evaluation.match.family) ? "funding_control" : "not_applicable",
        formal_control_b_lift: cell.incrementalLiftVsB,
      };
    }
    output[`${evaluation.match.family}:${evaluation.match.direction}`] = byHorizon;
  }
  return output;
}

function makeMetricTree(evaluations: ComponentEvaluation[]): JsonRecord {
  const byFamily: JsonRecord = {};
  for (const family of FAMILIES) {
    const byDirection: JsonRecord = {};
    for (const direction of DIRECTIONS) {
      const evaluation = evaluations.find((value) => value.match.family === family && value.match.direction === direction)!;
      byDirection[direction] = Object.fromEntries(HORIZONS.map((horizon) => [horizon, cellToJson(evaluation.cells.get(horizon)!)]));
    }
    byFamily[family] = {
      event_count: evaluations.find((value) => value.match.family === family && value.match.direction === "BULLISH")!.match.events.length
        + evaluations.find((value) => value.match.family === family && value.match.direction === "BEARISH")!.match.events.length,
      formal_test_included: true,
      by_direction_and_horizon: byDirection,
    };
  }
  return byFamily;
}

function countSignificant(evaluations: ComponentEvaluation[], positive: boolean): number {
  return allCellList(evaluations).filter((cell) => cell.holmAdjustedPValue !== null && cell.holmAdjustedPValue <= 0.05
    && cell.effectSize !== null && (positive ? cell.effectSize > 0 : cell.effectSize <= 0)).length;
}

function invalidReport(inputs: FrozenInputs, reason: string): JsonRecord {
  const cells: JsonRecord = {};
  for (const family of FAMILIES) {
    const directions: JsonRecord = {};
    for (const direction of DIRECTIONS) {
      directions[direction] = Object.fromEntries(HORIZONS.map((horizon) => [horizon, {
        family,
        direction,
        horizon,
        status: "RESEARCH_INVALID",
        eligible_events: 0,
        matched_events: 0,
        unmatched_events: 0,
        matching_coverage_percent: null,
        signal_precision: null,
        control_a_precision: null,
        control_b_precision: null,
        incremental_lift_vs_control_a: null,
        incremental_lift_vs_control_b: null,
        mean_directional_return: null,
        median_directional_return: null,
        mean_return_effect_vs_control_b: null,
        mfe_effect: null,
        mae_effect: null,
        median_mfe: null,
        median_mae: null,
        confidence_interval_95: null,
        effect_size: null,
        raw_p_value: null,
        holm_adjusted_p_value: null,
      }]));
    }
    cells[family] = { event_count: 0, formal_test_included: false, by_direction_and_horizon: directions };
  }
  return {
    research: "HY-R5.8C AUTHORITATIVE BASIS / PREMIUM INFORMATION GAIN",
    version: "hy-r5.8c-basis-premium-authoritative-v1",
    generated_at: new Date().toISOString(),
    classification: "RESEARCH_INVALID",
    reason,
    all_six_frozen_hashes_verified: false,
    historical_range: HISTORY_RANGE,
    universe: inputs.universe,
    resolution: RESOLUTION,
    preperformance_validation_attempts: 2,
    authoritative_performance_executions: 0,
    future_outcomes_generated: 0,
    performance_lock: "NOT_TRIGGERED",
    post_result_tuning: "NO",
    pit_safe: "FAIL",
    metrics: { by_family: cells },
    statistics: { formal_holm_family_test_count: 40, formal_holm_family_test_ids: formalHolmTestIds(), tests_executed: 0 },
    future_performance_calculated: false,
    safety: {
      production_modified: false,
      supabase_production_modified: false,
      vercel_modified: false,
      paper_strategy_modified: false,
      scanner_modified: false,
      emails_sent: 0,
      private_api_called: false,
      orders_called: false,
      position_management_called: false,
      auto_trading: false,
      commit_created: false,
    },
  };
}

function markdownFor(report: JsonRecord): string {
  const metrics = asRecord(report.metrics);
  const byFamily = asRecord(metrics.by_family);
  const best = asRecord(report.best_new_information);
  const stability = asRecord(report.stability);
  const verification = asRecord(report.verification);
  const lines = [
    "# HY-R5.8C Authoritative Basis / Premium Information Gain",
    "",
    `- Classification: **${asString(report.classification)}**`,
    `- All six frozen hashes verified: **${String(report.all_six_frozen_hashes_verified).toUpperCase()}**`,
    `- Historical range: ${HISTORY_RANGE.start} -> ${HISTORY_RANGE.end}`,
    `- Universe: ${asArray(report.universe).length}/49`,
    `- Resolution: ${String(report.resolution)}`,
    `- Pre-performance validation attempts: ${String(report.preperformance_validation_attempts)}`,
    `- Authoritative performance executions: ${String(report.authoritative_performance_executions)}`,
    `- Future outcome rows generated: ${String(report.future_outcomes_generated)}`,
    `- Performance lock: **${String(report.performance_lock)}**`,
    `- Post-result tuning: **${String(report.post_result_tuning)}**`,
    `- PIT-safe: **${String(report.pit_safe)}**`,
    "",
    "## Frozen inputs and implementation hashes",
    "",
    `- R5.7 coverage matrix: ${String(asRecord(verification.frozen_hashes).coverage_matrix)}`,
    `- R5.7 schema manifest: ${String(asRecord(verification.frozen_hashes).schema_manifest)}`,
    `- R5.7 feature specification: ${String(asRecord(verification.frozen_hashes).feature_specification)}`,
    `- R5.7 dataset manifest: ${String(asRecord(verification.frozen_hashes).dataset_manifest)}`,
    `- R5.8A hypothesis manifest: ${String(asRecord(verification.frozen_hashes).hypothesis_manifest)}`,
    `- R5.8A.1 cutoff manifest: ${String(asRecord(verification.frozen_hashes).cutoff_manifest)}`,
    `- Runner/source hash: ${String(report.runner_source_hash)}`,
    `- Matching implementation hash: ${String(report.matching_implementation_hash)}`,
    `- Outcome implementation hash: ${String(report.outcome_implementation_hash)}`,
    `- Statistical implementation hash: ${String(report.statistical_implementation_hash)}`,
    `- Classification implementation hash: ${String(report.classification_implementation_hash)}`,
    "",
    "## Required formal cells",
    "",
    "Statistics use paired precision difference vs Control B; bootstrap and permutation are deterministic, each with 2,000 replicates. Holm correction contains all 40 pre-registered cells, including cells with no outcomes.",
    "",
    "| Family | Direction | Horizon | Eligible | Matched | Coverage % | Signal precision | Control A | Control B | Lift vs B | Mean return | Mean effect vs B | CI 95% | Holm p |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |",
    ...FAMILIES.flatMap((family) => DIRECTIONS.flatMap((direction) => HORIZONS.map((horizon) => {
      const familyRecord = asRecord(byFamily[family]);
      const directionRecord = asRecord(familyRecord.by_direction_and_horizon);
      const metric = asRecord(asRecord(directionRecord[direction])[horizon]);
      return `| ${family} | ${direction} | ${horizon} | ${String(metric.eligible_events)} | ${String(metric.matched_events)} | ${String(metric.matching_coverage_percent ?? "N/A")} | ${String(metric.signal_precision ?? "N/A")} | ${String(metric.control_a_precision ?? "N/A")} | ${String(metric.control_b_precision ?? "N/A")} | ${String(metric.incremental_lift_vs_control_b ?? "N/A")} | ${String(metric.mean_directional_return ?? "N/A")} | ${String(metric.mean_return_effect_vs_control_b ?? "N/A")} | ${JSON.stringify(metric.confidence_interval_95)} | ${String(metric.holm_adjusted_p_value ?? "N/A")} |`;
    }))),
    "",
    "## Attribution, matching and stability",
    "",
    `- Control A: ${R58B_CONTROL_A_DIMENSIONS.join(", ")}.`,
    `- Control B additions: ${R58B_CONTROL_B_ADDITIONS.join(", ")}.`,
    `- Matching gate: >=70% robust eligible; 60–<70% conditional maximum; <60% MATCHING_INADEQUATE_COMPONENT.`,
    `- Holm significant positive tests: ${String(asRecord(report.statistics).holm_significant_positive_tests)}`,
    `- Holm significant non-positive tests: ${String(asRecord(report.statistics).holm_significant_non_positive_tests)}`,
    `- Best new-information phenomenon: ${String(best.phenomenon)}`,
    `- Best Control-B lift: ${String(best.control_b_lift)}`,
    `- Best 95% CI: ${JSON.stringify(best.confidence_interval_95)}`,
    `- Best matching coverage: ${String(best.matching_coverage_percent)}`,
    `- Stable across quarters: ${String(stability.stable_across_quarters).toUpperCase()}`,
    `- Stable across regimes: ${String(stability.stable_across_regimes).toUpperCase()}`,
    `- Largest symbol concentration: ${String(stability.largest_symbol_concentration_percent)}`,
    "- B1 attribution reports raw vs Control A, existing Mark/Index-control effect, and the residual vs Control B.",
    "- B2/B3 attribution reports uncontrolled and Funding-controlled effects; B4 remains the exact frozen divergence only; B5 uses same-timestamp ACTIVE, complete, PIT-available population.",
    `- Funding-attributable findings: ${String(asRecord(report.attribution).funding_attributable_findings)}`,
    `- Existing Mark/Index-attributable findings: ${String(asRecord(report.attribution).existing_mark_index_attributable_findings)}`,
    "",
    "## Safety",
    "",
    "- Production modified: NO",
    "- Supabase Production modified: NO",
    "- Vercel modified: NO",
    "- PAPER strategy modified: NO",
    "- Emails sent: 0",
    "- Private API called: NO",
    "- AUTO_TRADING: FALSE",
    "- Commit created: NO",
    "",
    "STOP.",
  ];
  return `${lines.join("\n")}\n`;
}

function inputGateErrors(
  coverage: JsonRecord,
  dataset: JsonRecord,
  r57Report: JsonRecord,
  r58a: JsonRecord,
  r58a1: JsonRecord,
  r58b: JsonRecord,
  r58bFreeze: JsonRecord,
): string[] {
  const errors: string[] = [];
  if (asString(r57Report.selected_resolution) !== RESOLUTION || asString(dataset.selected_resolution) !== RESOLUTION || asString(coverage.selected_resolution) !== RESOLUTION) errors.push("resolution_changed");
  if (asArray(r57Report.universe).length !== 49 || asArray(dataset.universe).length !== 49) errors.push("universe_count");
  if (asString(asRecord(asRecord(r57Report.historical_range)).start) !== "2024-08-09T00:00:00.000Z") errors.push("historical_start_changed");
  if (asString(asRecord(asRecord(r57Report.historical_range)).end) !== "2026-08-09T23:59:59.999Z") errors.push("historical_end_changed");
  if (r57Report.pit_safe !== "PASS") errors.push("r57_pit_safe");
  if (r57Report.future_performance_calculated !== false) errors.push("r57_future_outcome");
  if (r58a.future_performance_calculated !== false || r58a.authoritative_performance_count !== 0) errors.push("r58a_performance_state");
  if (r58a1.future_outcomes_generated !== 0 || r58a1.performance_lock !== "NOT_TRIGGERED") errors.push("r58a1_performance_state");
  if (r58b.executed_future_outcome_count !== 0 || r58b.future_performance_calculated !== false) errors.push("r58b_future_outcome");
  if (r58bFreeze.immutable !== true || r58bFreeze.outcome_metrics_not_yet_calculated !== true) errors.push("r58b_freeze_state");
  return errors;
}

async function loadFrozenInputs(): Promise<FrozenInputs> {
  const [coverage, schema, feature, dataset, artifactHashes, r57Report, r58a, r58a1, r58b, r58bFreeze] = await Promise.all([
    readJson(R57_COVERAGE_PATH),
    readJson(R57_SCHEMA_PATH),
    readJson(R57_FEATURE_PATH),
    readJson(R57_DATASET_PATH),
    readJson(R57_ARTIFACT_HASHES_PATH),
    readJson(R57_REPORT_PATH),
    readJson(R58A_PATH),
    readJson(R58A1_PATH),
    readJson(R58B_PATH),
    readJson(R58B_FREEZE_PATH),
  ]);
  const computed: Record<string, string> = {
    coverage_matrix: sha256Json(coverage),
    schema_manifest: sha256Json(schema),
    feature_specification: sha256Json(feature),
    dataset_manifest: sha256Json(dataset),
    hypothesis_manifest: sha256Json(r58a),
    cutoff_manifest: cutoffManifestHash(asRecord(r58a1.manifest)),
  };
  const hashGate = verifySixHashes(computed, artifactHashes, r58a1);
  const universe = asArray(dataset.universe).filter((value): value is string => typeof value === "string");
  const archives = asArray(dataset.archives).filter(isRecord).map((value) => ({
    family: asString(value.family) as BasisPremiumFamily,
    symbol: asString(value.symbol),
    path: asString(value.path),
    status: asString(value.status),
  }));
  const gateErrors = inputGateErrors(coverage, dataset, r57Report, r58a, r58a1, r58b, r58bFreeze);
  if (hashGate.mismatches.length > 0) gateErrors.push(...hashGate.mismatches.map((value) => `hash:${value}`));
  return { coverage, schema, feature, dataset, artifactHashes, r57Report, r58a, r58a1, r58b, r58bFreeze, archives, universe, hashGate, gateErrors };
}

function verifySixHashes(computed: Record<string, string>, artifactHashes: JsonRecord, cutoffReport: JsonRecord): JsonRecord & { mismatches: string[] } {
  const mismatches: string[] = [];
  for (const name of Object.keys(R58C_EXPECTED_HASHES) as Array<keyof typeof R58C_EXPECTED_HASHES>) {
    if (computed[name] !== R58C_EXPECTED_HASHES[name]) mismatches.push(`${name}:computed`);
  }
  const artifactNames = ["coverage_matrix", "schema_manifest", "feature_specification", "dataset_manifest"] as const;
  for (const name of artifactNames) {
    if (artifactHashes[`${name}_sha256`] !== R58C_EXPECTED_HASHES[name]) mismatches.push(`${name}:manifest`);
  }
  if (asString(cutoffReport.cutoff_manifest_hash) !== R58C_EXPECTED_HASHES.cutoff_manifest) mismatches.push("cutoff_manifest:report");
  return { passed: mismatches.length === 0, computed, expected: { ...R58C_EXPECTED_HASHES }, mismatches };
}

async function implementationHashes(): Promise<FreezeArtifacts> {
  const contents = await Promise.all(SOURCE_PATHS.map((path) => readFile(resolve(path), "utf8")));
  const runnerSourceHash = sourceBytesHash([...SOURCE_PATHS], contents);
  const matchingHash = createHash("sha256").update(contents[SOURCE_PATHS.indexOf("lib/basis-premium/information-gain.ts")]!, "utf8").digest("hex");
  const outcomeHash = createHash("sha256").update(contents[SOURCE_PATHS.indexOf("lib/basis-premium/outcome.ts")]!, "utf8").digest("hex");
  const statisticalHash = createHash("sha256").update(contents[SOURCE_PATHS.indexOf("lib/basis-premium/performance.ts")]!, "utf8").digest("hex");
  const classificationHash = createHash("sha256").update(contents[SOURCE_PATHS.indexOf("lib/basis-premium/classification.ts")]!, "utf8").digest("hex");
  return { freeze: {}, freezeHash: "", runnerSourceHash, matchingHash, outcomeHash, statisticalHash, classificationHash };
}

function freezeContract(inputs: FrozenInputs, hashes: FreezeArtifacts): JsonRecord {
  return {
    research: "HY-R5.8C AUTHORITATIVE BASIS / PREMIUM INFORMATION GAIN",
    version: "hy-r5.8c-pre-performance-freeze-v1",
    immutable: true,
    frozen_input_hashes: R58C_EXPECTED_HASHES,
    source_lock: {
      paths: SOURCE_PATHS,
      runner_source_hash: hashes.runnerSourceHash,
      matching_implementation_hash: hashes.matchingHash,
      outcome_implementation_hash: hashes.outcomeHash,
      statistical_implementation_hash: hashes.statisticalHash,
      classification_implementation_hash: hashes.classificationHash,
      representation: "raw UTF-8 source bytes with path and NUL delimiters for runner/source; raw UTF-8 bytes for individual implementation files",
    },
    historical_range: HISTORY_RANGE,
    universe: inputs.universe,
    resolution: RESOLUTION,
    experiment_id: EXPERIMENT_ID,
    random_seed: RANDOM_SEED,
    frozen_method: {
      rolling_window_observations: ROLLING_WINDOW,
      rolling_history: "strictly prior completed contiguous 1h observations within lifecycle; no forward fill",
      b1_b2_b3_cutoff: "signed value >0 and percentile >=0.95 = BEARISH; signed value <0 and percentile <=0.05 = BULLISH",
      b4_cutoff: "price-change percentile >=0.75 and premium-change percentile <=0.25 = BEARISH; inverse = BULLISH",
      b5_cutoff: "same timestamp ACTIVE complete PIT population; percentile >=0.90 = BEARISH; <=0.10 = BULLISH; average rank and (rank-1)/(N-1)",
      b3_signed_primitive: "premium[t] - premium[t-1] over contiguous frozen observations; no new formula",
      b4_primitives: "perpetual close[t]/close[t-1]-1 and premium[t]-premium[t-1] over contiguous frozen observations",
      event_formation: "FALSE_TO_TRUE only; TRUE_TO_TRUE deduplicated; TRUE_TO_FALSE resets; lifecycle/gap resets state",
      pit_event_timestamp: "observation open_time + 1h",
      horizons: HORIZONS,
      primary_horizons: ["1h", "4h"],
      secondary_horizons: ["12h", "24h"],
    },
    controls: {
      control_a: [...R58B_CONTROL_A_DIMENSIONS],
      control_b: [...R58B_CONTROL_A_DIMENSIONS, ...R58B_CONTROL_B_ADDITIONS],
      matching: "nearest timestamp without replacement within exact frozen key; matching never sees future outcomes",
      balance: "total variation distance plus exact-match fraction; feature strength reported and severe TV >0.5 blocks robust",
    },
    matching_coverage_gate: {
      robust_minimum_percent: 70,
      conditional_minimum_percent: 60,
      below_conditional: "MATCHING_INADEQUATE_COMPONENT",
    },
    statistics: {
      bootstrap_replicates: BOOTSTRAP_REPLICATES,
      permutation_replicates: PERMUTATION_REPLICATES,
      confidence_level: 0.95,
      multiple_testing: "Holm over all 40 B1-B5 x directions x horizons",
      effect: "paired precision difference versus Control B",
    },
    governance_before_outcome: {
      preperformance_validation_attempts: 2,
      authoritative_performance_executions: 0,
      future_outcomes_generated: 0,
      performance_lock: "NOT_TRIGGERED",
      post_result_tuning: "NO",
    },
  };
}

async function ensureFreeze(inputs: FrozenInputs, hashes: FreezeArtifacts): Promise<FreezeArtifacts> {
  const contract = freezeContract(inputs, hashes);
  if (await fileExists(FREEZE_PATH)) {
    const existing = await readJson(FREEZE_PATH);
    if (existing.immutable !== true || sha256Json(asRecord(existing.freeze_contract)) !== sha256Json(contract)) {
      throw new Error("RESEARCH_INVALID: R5.8C pre-performance freeze changed");
    }
    return { ...hashes, freeze: existing, freezeHash: sha256Json(existing) };
  }
  const freeze = {
    ...contract,
    created_at: new Date().toISOString(),
    freeze_contract: contract,
  };
  await writeFile(FREEZE_PATH, `${JSON.stringify(freeze, null, 2)}\n`, "utf8");
  const reloaded = await readJson(FREEZE_PATH);
  if (sha256Json(asRecord(reloaded.freeze_contract)) !== sha256Json(contract) || reloaded.immutable !== true) {
    throw new Error("RESEARCH_INVALID: R5.8C freeze write was not deterministic");
  }
  return { ...hashes, freeze: reloaded, freezeHash: sha256Json(reloaded) };
}

function reportFor(
  inputs: FrozenInputs,
  hashes: FreezeArtifacts,
  evaluations: ComponentEvaluation[],
  cache: Map<string, DirectionalOutcome | null>,
  successfulEventRows: number,
  successfulRowsIncludingControls: number,
  seriesBySymbol: Map<string, SymbolSeries>,
): JsonRecord {
  setHolmAdjustedPValues(evaluations);
  const best = bestCell(evaluations);
  const bestComponent = best === null ? null : componentByCell(evaluations, best);
  const balance = bestComponent === null ? { status: "NOT_ASSESSED", severe_imbalance: false } : balanceFor(bestComponent);
  const stability = best === null || bestComponent === null
    ? { status: "NOT_ASSESSED", stable_across_quarters: false, stable_across_regimes: false, largest_symbol_concentration_percent: null }
    : stabilityFor(bestComponent, best, cache);
  const bestCoverage = best?.matchingCoveragePercent ?? null;
  const nominalPositivePoorlyMatched = allCellList(evaluations).some((cell) => cell.incrementalLiftVsB !== null && cell.incrementalLiftVsB > 0
    && (cell.matchingCoveragePercent ?? 0) < 60);
  const positiveCandidates = allCellList(evaluations)
    .filter((cell) => cell.incrementalLiftVsB !== null && cell.incrementalLiftVsB > 0)
    .map((cell) => ({
      incrementalPositive: true,
      confidenceLowerBoundPositive: (cell.confidenceInterval95?.lower ?? 0) > 0,
      holmSignificant: (cell.holmAdjustedPValue ?? 1) <= 0.05,
      matchingCoveragePercent: cell.matchingCoveragePercent ?? 0,
      covariateBalanceAcceptable: asRecord(balance).acceptable === true,
      meaningfulSample: cell.pairedSampleSize >= MEANINGFUL_SAMPLE_MINIMUM,
      stableAcrossQuarters: asRecord(stability).stable_across_quarters === true,
      stableAcrossRegimes: asRecord(stability).stable_across_regimes === true,
      largestSymbolShare: (asNumber(asRecord(stability).largest_symbol_concentration_percent) ?? 100) / 100,
    }));
  const reasonableEvidence = allCellList(evaluations).some((cell) => (cell.matchingCoveragePercent ?? 0) >= 60 && cell.pairedSampleSize >= MEANINGFUL_SAMPLE_MINIMUM);
  const classification = classifyR58C({
    invalid: inputs.gateErrors.length > 0,
    positiveCandidates,
    hasNominalPositivePoorlyMatched: nominalPositivePoorlyMatched || asRecord(balance).severe_imbalance === true,
    hasReasonableEvidence: reasonableEvidence,
  });
  const lock: PerformanceLock = transitionPerformanceLock("NOT_TRIGGERED", successfulEventRows);
  const coverage = asRecord(inputs.coverage.joint);
  const bestPhenomenon = best === null ? "NONE" : `${best.family}_${best.direction}_${best.horizon}`;
  const attribution = attributionFor(evaluations, cache);
  return {
    research: "HY-R5.8C AUTHORITATIVE BASIS / PREMIUM INFORMATION GAIN",
    version: "hy-r5.8c-basis-premium-authoritative-v1",
    generated_at: new Date().toISOString(),
    classification,
    all_six_frozen_hashes_verified: inputs.hashGate.passed,
    hash_gate: inputs.hashGate,
    historical_range: HISTORY_RANGE,
    universe: inputs.universe,
    resolution: RESOLUTION,
    preperformance_validation_attempts: 2,
    authoritative_performance_executions: successfulEventRows > 0 ? 1 : 0,
    future_outcomes_generated: successfulEventRows,
    future_outcome_rows_including_controls: successfulRowsIncludingControls,
    performance_lock: lock,
    post_result_tuning: "NO",
    pit_safe: "PASS",
    runner_source_hash: hashes.runnerSourceHash,
    matching_implementation_hash: hashes.matchingHash,
    outcome_implementation_hash: hashes.outcomeHash,
    statistical_implementation_hash: hashes.statisticalHash,
    classification_implementation_hash: hashes.classificationHash,
    pre_performance_freeze_path: FREEZE_PATH,
    pre_performance_freeze_hash: hashes.freezeHash,
    experiment_id: EXPERIMENT_ID,
    random_seed: RANDOM_SEED,
    frozen_method: asRecord(hashes.freeze.frozen_method),
    r57_context: {
      selected_resolution: inputs.dataset.selected_resolution,
      joint_listing_aware_coverage_percent: coverage.coverage_percent,
      joint_expected_observations: coverage.expected_observations,
      joint_valid_observations: coverage.valid_observations,
      joint_missing_observations: coverage.missing_observations,
      future_outcomes_not_used_for_gate_or_matching: true,
    },
    metrics: { by_family: makeMetricTree(evaluations) },
    matching: {
      control_a_dimensions: [...R58B_CONTROL_A_DIMENSIONS],
      control_b_additions: [...R58B_CONTROL_B_ADDITIONS],
      coverage_gate: { robust_minimum_percent: 70, conditional_minimum_percent: 60, below_conditional: "MATCHING_INADEQUATE_COMPONENT" },
      by_component: Object.fromEntries(evaluations.map((evaluation) => [`${evaluation.match.family}:${evaluation.match.direction}`, {
        eligible_events: evaluation.match.events.length,
        matched_control_a: evaluation.match.pairsA.length,
        matched_control_b: evaluation.match.pairsB.length,
        matched_funding: evaluation.match.pairsFunding.length,
        matched_mark_index: evaluation.match.pairsMarkIndex.length,
        matching_coverage_percent: evaluation.match.events.length === 0 ? null : evaluation.match.pairsB.length / evaluation.match.events.length * 100,
        matching_gate: matchingGate(evaluation.match.events.length === 0 ? Number.NaN : evaluation.match.pairsB.length / evaluation.match.events.length * 100),
      }])),
    },
    balance: {
      status: bestComponent === null ? "NOT_ASSESSED" : "ASSESSED_ON_BEST_CONTROL_B_COMPONENT",
      required_fields: ["symbol", "calendar_period", "market_regime", "volatility_bucket", "liquidity_bucket", "funding_state_bucket", "existing_mark_index_basis_state_bucket", "feature_strength"],
      metric: "total_variation_distance_with_exact_match_fraction",
      best_component: balance,
      severe_imbalance: asRecord(balance).severe_imbalance === true,
    },
    statistics: {
      status: "COMPUTED",
      formal_holm_family_test_count: 40,
      formal_holm_family_test_ids: formalHolmTestIds(),
      tests_executed: allCellList(evaluations).filter((cell) => cell.rawPValue !== null).length,
      paired_bootstrap_replicates: BOOTSTRAP_REPLICATES,
      permutation_replicates: PERMUTATION_REPLICATES,
      seed: RANDOM_SEED,
      confidence_level: 0.95,
      multiple_testing: "Holm",
      effect_metric: "paired precision difference vs Control B",
      holm_significant_positive_tests: countSignificant(evaluations, true),
      holm_significant_non_positive_tests: countSignificant(evaluations, false),
      deterministic_statistics: true,
    },
    stability,
    best_new_information: {
      phenomenon: bestPhenomenon,
      control_b_lift: best?.incrementalLiftVsB ?? null,
      confidence_interval_95: best?.confidenceInterval95 ?? null,
      matching_coverage_percent: bestCoverage,
      sample_size: best?.pairedSampleSize ?? 0,
    },
    attribution: {
      by_component: attribution,
      funding_attributable_findings: "B2/B3 Funding-controlled comparisons are reported in attribution.by_component; formal incremental conclusion remains Control B adjusted.",
      existing_mark_index_attributable_findings: "B1 existing Mark/Index-control comparisons are reported in attribution.by_component; formal incremental conclusion remains Control B adjusted.",
      no_result_driven_rescue: true,
    },
    data_integrity: {
      series_symbols_loaded: seriesBySymbol.size,
      observations: seriesBySymbol.size === 0 ? 0 : [...seriesBySymbol.values()].reduce((sum, value) => sum + value.perpetual.size, 0),
      future_gap_policy: "any missing future bar invalidates that horizon outcome; no deletion, fill or repair",
    },
    verification: {
      frozen_hashes: R58C_EXPECTED_HASHES,
      freeze_precedes_outcome: true,
      no_future_data_in_matching: true,
      event_dedup: "FALSE_TO_TRUE; TRUE_TO_TRUE deduplicated; TRUE_TO_FALSE resets",
      b3_status: "COMPATIBLE_WITH_FROZEN_FIRST_DIFFERENCE_PRIMITIVE",
      source_paths: SOURCE_PATHS,
    },
    future_performance_calculated: successfulEventRows > 0,
    safety: {
      production_modified: false,
      supabase_production_modified: false,
      vercel_modified: false,
      paper_strategy_modified: false,
      scanner_modified: false,
      emails_sent: 0,
      private_api_called: false,
      orders_called: false,
      position_management_called: false,
      auto_trading: false,
      commit_created: false,
    },
  };
}

async function loadSeriesAndObservations(inputs: FrozenInputs): Promise<{ observations: Observation[]; seriesBySymbol: Map<string, SymbolSeries>; lifecycleBySymbol: Map<string, LifecycleSpan[]> }> {
  const listingInput = await readJson(LISTING_EVIDENCE_PATH);
  const listings = new Map<string, ListingRecord>();
  for (const value of asArray(listingInput.symbols).filter(isRecord)) {
    const symbol = asString(value.symbol);
    listings.set(symbol, { symbol, onboardDate: Number(value.onboardDate), deliveryDate: Number(value.deliveryDate) });
  }
  const observations: Observation[] = [];
  const seriesBySymbol = new Map<string, SymbolSeries>();
  const lifecycleBySymbol = new Map<string, LifecycleSpan[]>();
  for (const symbol of inputs.universe) {
    const listing = listings.get(symbol);
    if (listing === undefined) throw new Error(`LISTING_EVIDENCE_MISSING_${symbol}`);
    const lifecycle = lifecycleIntervalsForSymbol(listing, "data/raw/hy-r5.2b-flow/listing-evidence.json");
    const familyMaps = {} as Record<BasisPremiumFamily, Map<number, Bar>>;
    for (const family of BASIS_PREMIUM_FAMILIES) {
      const records = inputs.archives.filter((record) => record.symbol === symbol && record.family === family);
      if (records.length === 0) throw new Error(`ARCHIVE_RECORDS_MISSING_${family}_${symbol}`);
      familyMaps[family] = await loadFamily(records, lifecycle);
    }
    const funding = await loadFunding(symbol);
    const symbolObservations = buildSymbolObservations(symbol, lifecycle, familyMaps, funding);
    observations.push(...symbolObservations);
    seriesBySymbol.set(symbol, { symbol, lifecycle, perpetual: familyMaps.PERPETUAL_PRICE });
    lifecycleBySymbol.set(symbol, lifecycle);
    if (symbolObservations.length === 0) throw new Error(`NO_JOINT_OBSERVATIONS_${symbol}`);
  }
  addCrossSectionalContext(observations);
  formEvents(observations, lifecycleBySymbol);
  return { observations, seriesBySymbol, lifecycleBySymbol };
}

async function main(): Promise<void> {
  if (await fileExists(JSON_REPORT_PATH) || await fileExists(MARKDOWN_REPORT_PATH)) {
    throw new Error("AUTHORITATIVE_RUN_LOCKED: HY-R5.8C result exists; refusing rerun");
  }
  const inputs = await loadFrozenInputs();
  const hashes = await implementationHashes();
  if (!inputs.hashGate.passed || inputs.gateErrors.length > 0) {
    const report = invalidReport(inputs, `RESEARCH_INVALID pre-performance gate: ${inputs.gateErrors.join(", ") || "six-hash gate failed"}`);
    await writeFile(JSON_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(MARKDOWN_REPORT_PATH, markdownFor(report), "utf8");
    console.log(JSON.stringify({ classification: report.classification, gateErrors: inputs.gateErrors, futureOutcomesGenerated: 0 }, null, 2));
    return;
  }
  const frozen = await ensureFreeze(inputs, hashes);
  const loaded = await loadSeriesAndObservations(inputs);
  const evaluations = buildMatches(loaded.observations);
  const outcomes = buildOutcomeCache(evaluations, loaded.seriesBySymbol);
  for (const evaluation of evaluations) {
    for (const horizon of HORIZONS) evaluation.cells.set(horizon, evaluateCell(evaluation, horizon, outcomes.cache));
  }
  const report = reportFor(inputs, frozen, evaluations, outcomes.cache, outcomes.successfulEventRows, outcomes.successfulRowsIncludingControls, loaded.seriesBySymbol);
  await writeFile(JSON_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(MARKDOWN_REPORT_PATH, markdownFor(report), "utf8");
  console.log(JSON.stringify({
    classification: report.classification,
    allSixFrozenHashesVerified: report.all_six_frozen_hashes_verified,
    authoritativePerformanceExecutions: report.authoritative_performance_executions,
    futureOutcomesGenerated: report.future_outcomes_generated,
    performanceLock: report.performance_lock,
    bestNewInformation: report.best_new_information,
    tests: report.statistics,
    output: JSON_REPORT_PATH,
  }, null, 2));
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
