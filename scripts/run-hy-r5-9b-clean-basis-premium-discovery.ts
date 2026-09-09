import { createHash } from "node:crypto";
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
} from "../lib/basis-premium/performance";
import {
  makeExistingInformationMatchKey,
  matchNearestWithoutReplacement,
  summarizeCovariateBalance,
  type MatchPair,
} from "../lib/basis-premium/information-gain";
import {
  assertR59DiscoveryWindow,
  R58C_CONTAMINATED_WINDOW,
  R59_CLEAN_DISCOVERY_WINDOW,
  R59_RESERVED_HOLDOUT,
} from "../lib/basis-premium/clean-window";
import {
  lifecycleIntervalsForSymbol,
  sha256Json,
  stableJson,
} from "../lib/crowding";

const EXPERIMENT_ID = "HY-R5.9B";
const RESOLUTION = "1h" as const;
const INTERVAL_MS = resolutionMilliseconds(RESOLUTION);
const HOUR_MS = 3_600_000;
const ROLLING_WINDOW = 720;
const RANDOM_SEED = 5_901;
const BOOTSTRAP_REPLICATES = 2_000;
const PERMUTATION_REPLICATES = 2_000;
const MEANINGFUL_SAMPLE_MINIMUM = 30;
const CLEAN_START = R59_CLEAN_DISCOVERY_WINDOW.start;
const CLEAN_END_EXCLUSIVE = R59_CLEAN_DISCOVERY_WINDOW.endExclusive;
const CLEAN_RANGE = {
  start: R59_CLEAN_DISCOVERY_WINDOW.startIso,
  end: R59_CLEAN_DISCOVERY_WINDOW.endIso,
  end_exclusive: new Date(CLEAN_END_EXCLUSIVE).toISOString(),
} as const;

const FAMILIES = ["B1", "B2", "B3", "B4", "B5"] as const;
const DIRECTIONS = ["BULLISH", "BEARISH"] as const;
const HORIZONS = ["1h", "4h", "12h", "24h"] as const;
const HORIZON_HOURS: Record<(typeof HORIZONS)[number], number> = {
  "1h": 1,
  "4h": 4,
  "12h": 12,
  "24h": 24,
};

type FamilyId = (typeof FAMILIES)[number];
type Direction = (typeof DIRECTIONS)[number];
type Horizon = (typeof HORIZONS)[number];
type JsonRecord = Record<string, unknown>;

const CLEAN_ROOT = resolve("data", "raw", "hy-r5.9-clean-basis-premium");
const CLEAN_ARTIFACT_ROOT = resolve(CLEAN_ROOT, "artifacts");
const CLEAN_MATERIALIZED_ROOT = resolve(CLEAN_ROOT, "materialized");
const CLEAN_HASHES_PATH = resolve(CLEAN_ARTIFACT_ROOT, "clean-artifact-hashes.json");
const CLEAN_COVERAGE_PATH = resolve(CLEAN_ARTIFACT_ROOT, "clean-coverage-matrix.json");
const CLEAN_SCHEMA_PATH = resolve(CLEAN_ARTIFACT_ROOT, "clean-schema-manifest.json");
const CLEAN_DATASET_PATH = resolve(CLEAN_ARTIFACT_ROOT, "clean-dataset-manifest.json");
const CLEAN_ALIGNED_PATH = resolve(CLEAN_ARTIFACT_ROOT, "clean-aligned-data-manifest.json");
const FREEZE_PATH = resolve("reports", "hy-r5-9b-pre-performance-freeze.json");
const JSON_REPORT_PATH = resolve("reports", "hy-r5.9b-clean-basis-premium-information-gain.json");
const MARKDOWN_REPORT_PATH = resolve("reports", "hy-r5.9b-clean-basis-premium-information-gain.md");
const FEATURE_PATH = resolve("data", "raw", "hy-r5.7-basis-premium-preflight", "artifacts", "feature-specification.json");
const HYPOTHESIS_PATH = resolve("reports", "hy-r5.8a-basis-premium-hypothesis-freeze.json");
const CUTOFF_PATH = resolve("reports", "hy-r5.8a1-basis-premium-event-cutoff-freeze.json");
const LISTING_EVIDENCE_PATH = resolve("data", "raw", "hy-r5.2b-flow", "listing-evidence.json");
const R59B_RUNNER_PATH = "scripts/run-hy-r5-9b-clean-basis-premium-discovery.ts";
const R59B_SOURCE_PATHS = [
  R59B_RUNNER_PATH,
  "lib/basis-premium/cutoff.ts",
  "lib/basis-premium/hypothesis.ts",
] as const;
const R58D_SOURCE_PATHS = [
  "scripts/run-hy-r5-8c-basis-premium-information-gain.ts",
  "scripts/run-hy-r5-8d-outcome-direction-remediation.ts",
] as const;
const OUTCOME_PATH = "lib/basis-premium/outcome.ts";
const MATCHING_PATH = "lib/basis-premium/information-gain.ts";
const STATISTICAL_PATH = "lib/basis-premium/performance.ts";
const CLASSIFICATION_PATH = "lib/basis-premium/classification.ts";

const EXPECTED_CLEAN_HASHES = {
  clean_coverage_matrix: "32a53c804f54da8aa71815a9d299d4796f8bf4c593015127e10fbb1b8e6c6e53",
  clean_schema_manifest: "6a756ccad8cc2ae269fcbe9d6d6c9e64ee4f07c6280db519839eeef8e23f3757",
  clean_dataset_manifest: "b64fe7087afa407bb16b9b4d8de80d207ccd1d7e63db0bc38ecae8bdd78389d1",
  clean_aligned_data_manifest: "a9537ecb8f7dcd080cb075883e49202bd1b955b75bf2590b685f00b37c987add",
} as const;
const EXPECTED_SEMANTIC_HASHES = {
  feature: "bbdaab9e4cba4c22e50471d538d808fca992e812aaff60a0fc3f70af6020cf51",
  hypothesis: "0b5a790a1783704fc5eb130c4d1fa65c865339e68232fa1b54af9012c58db0f3",
  cutoff: "95fe1b5a20b0d4804e52dbc01c2f0e730a8f6b377e0c29ae2877875d8f06e800",
} as const;
const EXPECTED_REMEDIATED_HASHES = {
  runner_source: "ae88361b55b519975b8a297ca8f85ef4e5177eb8e1ac78eaaa1ed7cccca7fd77",
  outcome: "8a4e81ca26c050c337012b233fa2d7017c7ecc1dfa46dabdfe9b3a142e937465",
} as const;

interface ListingRecord {
  symbol: string;
  onboardDate: number;
  deliveryDate: number;
  [key: string]: unknown;
}

interface CleanAlignedRow {
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

interface SymbolSeries {
  symbol: string;
  lifecycle: LifecycleSpan[];
  aligned: Map<number, CleanAlignedRow>;
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

interface ComponentEvaluation {
  match: ComponentMatch;
  cells: Map<Horizon, CellEvaluation>;
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

interface ImplementationHashes {
  runnerSourceHash: string;
  outcomeHash: string;
  matchingHash: string;
  statisticalHash: string;
  classificationHash: string;
}

interface FrozenInputs {
  cleanCoverage: JsonRecord;
  cleanSchema: JsonRecord;
  cleanDataset: JsonRecord;
  cleanAligned: JsonRecord;
  cleanHashGate: JsonRecord;
  semanticHashGate: JsonRecord;
  remediatedGate: JsonRecord;
  implementationHashes: ImplementationHashes;
  universe: string[];
  gateErrors: string[];
}

interface FreezeArtifacts {
  freeze: JsonRecord;
  freezeHash: string;
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

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function iso(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function quarterKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

function lifecycleIdAt(timestamp: number, lifecycle: LifecycleSpan[]): string | null {
  return lifecycle.find((span) => timestamp >= span.startTime && timestamp < span.endTimeExclusive)?.id ?? null;
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

async function implementationHashes(): Promise<ImplementationHashes> {
  const [runner, cutoff, hypothesis, outcome, matching, statistical, classification] = await Promise.all([
    readFile(resolve(R59B_RUNNER_PATH), "utf8"),
    readFile(resolve("lib/basis-premium/cutoff.ts"), "utf8"),
    readFile(resolve("lib/basis-premium/hypothesis.ts"), "utf8"),
    readFile(resolve(OUTCOME_PATH)),
    readFile(resolve(MATCHING_PATH)),
    readFile(resolve(STATISTICAL_PATH)),
    readFile(resolve(CLASSIFICATION_PATH)),
  ]);
  return {
    runnerSourceHash: sourceBytesHash([...R59B_SOURCE_PATHS], [runner, cutoff, hypothesis]),
    outcomeHash: sha256Bytes(outcome),
    matchingHash: sha256Bytes(matching),
    statisticalHash: sha256Bytes(statistical),
    classificationHash: sha256Bytes(classification),
  };
}

async function cleanHashGate(): Promise<{ gate: JsonRecord; documents: Record<keyof typeof EXPECTED_CLEAN_HASHES, JsonRecord> }> {
  const [hashManifest, cleanCoverage, cleanSchema, cleanDataset, cleanAligned] = await Promise.all([
    readJson(CLEAN_HASHES_PATH),
    readJson(CLEAN_COVERAGE_PATH),
    readJson(CLEAN_SCHEMA_PATH),
    readJson(CLEAN_DATASET_PATH),
    readJson(CLEAN_ALIGNED_PATH),
  ]);
  const documents = {
    clean_coverage_matrix: cleanCoverage,
    clean_schema_manifest: cleanSchema,
    clean_dataset_manifest: cleanDataset,
    clean_aligned_data_manifest: cleanAligned,
  } as const;
  const computed = Object.fromEntries(Object.entries(documents).map(([name, document]) => [name, sha256Json(document)])) as Record<keyof typeof EXPECTED_CLEAN_HASHES, string>;
  const declared = Object.fromEntries(Object.keys(EXPECTED_CLEAN_HASHES).map((name) => [
    name,
    asString(asRecord(hashManifest[name]).sha256),
  ])) as Record<keyof typeof EXPECTED_CLEAN_HASHES, string>;
  const mismatches = Object.keys(EXPECTED_CLEAN_HASHES).flatMap((name) => {
    const key = name as keyof typeof EXPECTED_CLEAN_HASHES;
    return [
      ...(computed[key] === EXPECTED_CLEAN_HASHES[key] ? [] : [`${name}:computed`]),
      ...(declared[key] === EXPECTED_CLEAN_HASHES[key] ? [] : [`${name}:declared`]),
    ];
  });
  return {
    gate: {
      passed: mismatches.length === 0,
      mismatches,
      expected: EXPECTED_CLEAN_HASHES,
      computed,
      declared,
      representation: "canonical JSON via stableJson; object keys sorted recursively, array order preserved",
    },
    documents,
  };
}

async function loadFrozenInputs(): Promise<FrozenInputs> {
  const [{ gate: cleanHashGateResult, documents }, feature, hypothesis, cutoff, implementations, r58cRunner, r58dRunner, outcome] = await Promise.all([
    cleanHashGate(),
    readJson(FEATURE_PATH),
    readJson(HYPOTHESIS_PATH),
    readJson(CUTOFF_PATH),
    implementationHashes(),
    readFile(resolve(R58D_SOURCE_PATHS[0]), "utf8"),
    readFile(resolve(R58D_SOURCE_PATHS[1]), "utf8"),
    readFile(resolve(OUTCOME_PATH)),
  ]);
  const computedSemanticHashes = {
    feature: sha256Json(feature),
    hypothesis: sha256Json(hypothesis),
    cutoff: cutoffManifestHash(asRecord(cutoff.manifest)),
  };
  const semanticMismatches = Object.keys(EXPECTED_SEMANTIC_HASHES).filter((name) => {
    const key = name as keyof typeof EXPECTED_SEMANTIC_HASHES;
    return computedSemanticHashes[key] !== EXPECTED_SEMANTIC_HASHES[key];
  });
  const remediatedRunnerSourceHash = sourceBytesHash(
    [...R58D_SOURCE_PATHS],
    [r58cRunner, r58dRunner],
  );
  const remediatedMismatches = [
    ...(remediatedRunnerSourceHash === EXPECTED_REMEDIATED_HASHES.runner_source ? [] : ["runner_source"]),
    ...(sha256Bytes(outcome) === EXPECTED_REMEDIATED_HASHES.outcome ? [] : ["outcome"]),
  ];
  const dataset = documents.clean_dataset_manifest;
  const cleanCoverage = documents.clean_coverage_matrix;
  const cleanAligned = documents.clean_aligned_data_manifest;
  const expectedSymbols = asArray(dataset.eligible_symbols).filter((value): value is string => typeof value === "string").sort();
  const gateErrors = [
    ...(!isRecord(cleanHashGateResult) || cleanHashGateResult.passed !== true ? ["clean_hash_gate"] : []),
    ...(semanticMismatches.length > 0 ? semanticMismatches.map((value) => `semantic:${value}`) : []),
    ...(remediatedMismatches.length > 0 ? remediatedMismatches.map((value) => `remediated:${value}`) : []),
    ...(asString(dataset.experiment_id) !== "HY-R5.9A" ? ["clean_dataset_experiment"] : []),
    ...(asString(asRecord(dataset.clean_window).start) !== CLEAN_RANGE.start ? ["clean_window_start"] : []),
    ...(asString(asRecord(dataset.clean_window).end_exclusive) !== CLEAN_RANGE.end_exclusive ? ["clean_window_end"] : []),
    ...(expectedSymbols.length !== 31 ? ["eligible_symbol_count"] : []),
    ...(asNumber(asRecord(cleanCoverage.aligned_coverage).expected) !== 369_534 ? ["aligned_expected"] : []),
    ...(asNumber(asRecord(cleanCoverage.aligned_coverage).valid) !== 368_422 ? ["aligned_valid"] : []),
    ...(asNumber(cleanAligned.expected) !== 369_534 ? ["aligned_manifest_expected"] : []),
    ...(asNumber(cleanAligned.valid) !== 368_422 ? ["aligned_manifest_valid"] : []),
    ...(asRecord(dataset.future_performance).calculated !== false ? ["clean_future_performance"] : []),
    ...(asRecord(dataset.future_performance).outcomes_generated !== 0 ? ["clean_future_outcomes"] : []),
    ...(implementations.outcomeHash !== EXPECTED_REMEDIATED_HASHES.outcome ? ["direction_aware_outcome_source"] : []),
  ];
  if (gateErrors.length > 0) throw new Error(`RESEARCH_INVALID:${gateErrors.join(",")}`);
  const universe = expectedSymbols;
  return {
    cleanCoverage,
    cleanSchema: documents.clean_schema_manifest,
    cleanDataset: dataset,
    cleanAligned,
    cleanHashGate: cleanHashGateResult,
    semanticHashGate: {
      passed: semanticMismatches.length === 0,
      expected: EXPECTED_SEMANTIC_HASHES,
      computed: computedSemanticHashes,
      mismatches: semanticMismatches,
    },
    remediatedGate: {
      passed: remediatedMismatches.length === 0,
      expected: EXPECTED_REMEDIATED_HASHES,
      computed: {
        runner_source: remediatedRunnerSourceHash,
        outcome: implementations.outcomeHash,
      },
      mismatches: remediatedMismatches,
      outcome_identity: "symbol|timestamp|direction|horizon",
    },
    implementationHashes: implementations,
    universe,
    gateErrors: [],
  };
}

function governanceGuards(): JsonRecord {
  assertR59DiscoveryWindow(CLEAN_START, CLEAN_END_EXCLUSIVE);
  let contaminatedError = "NONE";
  try {
    assertR59DiscoveryWindow(R58C_CONTAMINATED_WINDOW.start, R58C_CONTAMINATED_WINDOW.start + INTERVAL_MS);
  } catch (error) {
    contaminatedError = error instanceof Error ? error.message : String(error);
  }
  let holdoutError = "NONE";
  try {
    assertR59DiscoveryWindow(R59_RESERVED_HOLDOUT.start, R59_RESERVED_HOLDOUT.start + INTERVAL_MS);
  } catch (error) {
    holdoutError = error instanceof Error ? error.message : String(error);
  }
  if (contaminatedError !== "CONTAMINATED_WINDOW_FORBIDDEN") throw new Error(`RESEARCH_INVALID:contaminated_guard:${contaminatedError}`);
  if (holdoutError !== "RESERVED_HOLDOUT_FORBIDDEN") throw new Error(`RESEARCH_INVALID:holdout_guard:${holdoutError}`);
  return {
    clean_window: "PASS",
    contaminated_window: { accessed: false, status: "PASS", error_code: contaminatedError },
    reserved_holdout: { accessed: false, status: "PASS", error_code: holdoutError },
  };
}

const verifiedFileCache = new Map<string, Buffer>();

async function readVerifiedMaterializedFile(record: JsonRecord): Promise<Buffer> {
  const path = asString(record.path);
  const expectedHash = asString(record.sha256);
  if (path.length === 0 || expectedHash.length === 0) throw new Error("RESEARCH_INVALID:MATERIALIZED_MANIFEST_RECORD");
  const absolutePath = resolve(path);
  const cached = verifiedFileCache.get(absolutePath);
  if (cached !== undefined) return cached;
  const bytes = await readFile(absolutePath);
  if (sha256Bytes(bytes) !== expectedHash) throw new Error(`RESEARCH_INVALID:MATERIALIZED_HASH:${path}`);
  verifiedFileCache.set(absolutePath, bytes);
  return bytes;
}

async function verifyAllMaterializedFiles(dataset: JsonRecord): Promise<number> {
  let count = 0;
  const verifyGroup = async (group: unknown): Promise<void> => {
    if (Array.isArray(group)) {
      for (const record of group.filter(isRecord)) {
        await readVerifiedMaterializedFile(record);
        count += 1;
      }
      return;
    }
    for (const value of Object.values(asRecord(group))) {
      for (const record of asArray(value).filter(isRecord)) {
        await readVerifiedMaterializedFile(record);
        count += 1;
      }
    }
  };
  await verifyGroup(dataset.materialized_family_files);
  await verifyGroup(dataset.materialized_aligned_files);
  if (count < 1) {
    throw new Error("RESEARCH_INVALID:NO_MATERIALIZED_FILES");
  }
  return count;
}

function findMaterializedRecord(group: unknown, family: string, symbol: string): JsonRecord {
  const familyRecords = family.length === 0
    ? asArray(group).filter(isRecord)
    : asArray(asRecord(group)[family]).filter(isRecord);
  const suffix = `${symbol}-1h.csv`;
  const record = familyRecords.find((value) => asString(value.path).replaceAll("\\", "/").endsWith(suffix));
  if (record === undefined) throw new Error(`RESEARCH_INVALID:MATERIALIZED_RECORD_MISSING:${family}:${symbol}`);
  return record;
}

function parseAlignedCsv(csv: string, symbol: string, lifecycle: LifecycleSpan[]): Map<number, CleanAlignedRow> {
  const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const expectedHeader = "timestamp,pit_available_at,premium_close,index_close,mark_close,perpetual_close";
  if (lines.shift() !== expectedHeader) throw new Error(`RESEARCH_INVALID:ALIGNED_HEADER:${symbol}`);
  const rows = new Map<number, CleanAlignedRow>();
  for (const line of lines) {
    const cells = line.split(",");
    if (cells.length !== 6) throw new Error(`RESEARCH_INVALID:ALIGNED_WIDTH:${symbol}`);
    const values = cells.map((value) => Number(value));
    if (values.some((value) => !Number.isFinite(value))) throw new Error(`RESEARCH_INVALID:ALIGNED_NUMERIC:${symbol}`);
    const [timestamp, pitAvailableAt, premium, index, mark, perpetual] = values;
    if (!Number.isInteger(timestamp) || timestamp < CLEAN_START || timestamp >= CLEAN_END_EXCLUSIVE) {
      if (timestamp >= R58C_CONTAMINATED_WINDOW.start && timestamp < R58C_CONTAMINATED_WINDOW.endExclusive) throw new Error("CONTAMINATED_WINDOW_FORBIDDEN");
      if (timestamp >= R59_RESERVED_HOLDOUT.start) throw new Error("RESERVED_HOLDOUT_FORBIDDEN");
      throw new Error(`RESEARCH_INVALID:ALIGNED_TIMESTAMP:${symbol}`);
    }
    if (pitAvailableAt !== timestamp + INTERVAL_MS || lifecycleIdAt(timestamp, lifecycle) === null) throw new Error(`RESEARCH_INVALID:ALIGNED_PIT_OR_LIFECYCLE:${symbol}`);
    if (rows.has(timestamp)) throw new Error(`RESEARCH_INVALID:ALIGNED_DUPLICATE:${symbol}`);
    rows.set(timestamp, { timestamp, pitAvailableAt, premium, index, mark, perpetual });
  }
  return rows;
}

function parsePerpetualCsv(csv: string, symbol: string, lifecycle: LifecycleSpan[]): Map<number, Bar> {
  const parsed = parseBinanceKlineCsv(csv, { family: "PERPETUAL_PRICE", resolution: RESOLUTION });
  if (parsed.invalidRowCount > 0 || parsed.duplicateTimestampCount > 0 || parsed.outOfOrderCount > 0 || parsed.boundaryViolationCount > 0) {
    throw new Error(`RESEARCH_INVALID:PERPETUAL_PARSE:${symbol}`);
  }
  const bars = new Map<number, Bar>();
  for (const row of parsed.rows) {
    if (row.openTime < CLEAN_START || row.openTime >= CLEAN_END_EXCLUSIVE) {
      if (row.openTime >= R58C_CONTAMINATED_WINDOW.start && row.openTime < R58C_CONTAMINATED_WINDOW.endExclusive) throw new Error("CONTAMINATED_WINDOW_FORBIDDEN");
      if (row.openTime >= R59_RESERVED_HOLDOUT.start) throw new Error("RESERVED_HOLDOUT_FORBIDDEN");
      continue;
    }
    if (lifecycleIdAt(row.openTime, lifecycle) === null) continue;
    bars.set(row.openTime, { close: row.close, high: row.high, low: row.low, quoteAssetVolume: row.quoteAssetVolume });
  }
  return bars;
}

async function loadSeries(inputs: FrozenInputs): Promise<Map<string, SymbolSeries>> {
  const listingDocument = await readJson(LISTING_EVIDENCE_PATH);
  const listings = new Map<string, ListingRecord>();
  for (const value of asArray(listingDocument.symbols).filter(isRecord)) {
    if (typeof value.symbol !== "string") continue;
    listings.set(value.symbol, {
      symbol: value.symbol,
      onboardDate: Number(value.onboardDate),
      deliveryDate: Number(value.deliveryDate),
      ...value,
    });
  }
  const familyFiles = asRecord(inputs.cleanDataset.materialized_family_files);
  const alignedFiles = inputs.cleanDataset.materialized_aligned_files;
  const output = new Map<string, SymbolSeries>();
  for (const symbol of inputs.universe) {
    const listing = listings.get(symbol);
    if (listing === undefined) throw new Error(`RESEARCH_INVALID:LISTING_MISSING:${symbol}`);
    const lifecycle = lifecycleIntervalsForSymbol(listing, "data/raw/hy-r5.2b-flow/listing-evidence.json");
    const alignedRecord = findMaterializedRecord(alignedFiles, "", symbol);
    const perpetualRecord = findMaterializedRecord(familyFiles, "PERPETUAL_PRICE", symbol);
    const aligned = parseAlignedCsv((await readVerifiedMaterializedFile(alignedRecord)).toString("utf8"), symbol, lifecycle);
    const perpetual = parsePerpetualCsv((await readVerifiedMaterializedFile(perpetualRecord)).toString("utf8"), symbol, lifecycle);
    for (const row of aligned.values()) {
      const bar = perpetual.get(row.timestamp);
      if (bar === undefined || bar.close !== row.perpetual) throw new Error(`RESEARCH_INVALID:ALIGNED_PERPETUAL_MISMATCH:${symbol}`);
    }
    output.set(symbol, { symbol, lifecycle, aligned, perpetual });
  }
  return output;
}

function trailingVolatility(perpetual: Map<number, Bar>, timestamp: number): number | null {
  const returns: number[] = [];
  for (let step = 23; step >= 0; step -= 1) {
    const current = perpetual.get(timestamp - step * HOUR_MS);
    const previous = perpetual.get(timestamp - (step + 1) * HOUR_MS);
    if (current === undefined || previous === undefined || current.close <= 0 || previous.close <= 0) return null;
    returns.push(Math.log(current.close / previous.close));
  }
  return Math.sqrt(returns.reduce((total, value) => total + value * value, 0) / returns.length);
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

function marketRegime(observations: Observation[]): string {
  const returns = observations.map((value) => value.fourHourReturn).filter((value): value is number => value !== null);
  const broad = median(returns);
  if (broad === null) return "UNKNOWN";
  if (broad > 0.005) return "UP";
  if (broad < -0.005) return "DOWN";
  return "RANGE";
}

function emptyDirections(): Record<FamilyId, Direction | null> {
  return { B1: null, B2: null, B3: null, B4: null, B5: null };
}

function buildSymbolObservations(series: SymbolSeries): Observation[] {
  const timestamps = [...series.aligned.keys()].sort((left, right) => left - right);
  const observations: Observation[] = [];
  const basisWindow = new RollingPercentileWindow(ROLLING_WINDOW);
  const premiumWindow = new RollingPercentileWindow(ROLLING_WINDOW);
  const expansionWindow = new RollingPercentileWindow(ROLLING_WINDOW);
  const priceChangeWindow = new RollingPercentileWindow(ROLLING_WINDOW);
  const premiumChangeWindow = new RollingPercentileWindow(ROLLING_WINDOW);
  let previousTime: number | null = null;
  let previousLifecycleId: string | null = null;
  for (const timestamp of timestamps) {
    const row = series.aligned.get(timestamp)!;
    const currentLifecycleId = lifecycleIdAt(timestamp, series.lifecycle);
    const contiguous = previousTime !== null
      && timestamp - previousTime === INTERVAL_MS
      && currentLifecycleId !== null
      && currentLifecycleId === previousLifecycleId;
    if (!contiguous) {
      basisWindow.reset();
      premiumWindow.reset();
      expansionWindow.reset();
      priceChangeWindow.reset();
      premiumChangeWindow.reset();
    }
    const perpetual = series.perpetual.get(timestamp);
    if (perpetual === undefined || row.index <= 0 || row.mark <= 0) throw new Error(`RESEARCH_INVALID:ROW_MISSING:${series.symbol}:${String(timestamp)}`);
    const previousRow = contiguous ? series.aligned.get(timestamp - HOUR_MS) : undefined;
    const previousPerpetual = contiguous ? series.perpetual.get(timestamp - HOUR_MS) : undefined;
    const basis = perpIndexBasis(row.perpetual, row.index);
    if (basis === null) throw new Error(`RESEARCH_INVALID:BASIS:${series.symbol}`);
    const signedExpansion = previousRow === undefined ? null : row.premium - previousRow.premium;
    const priceChange = previousPerpetual === undefined || previousPerpetual.close <= 0 ? null : perpetual.close / previousPerpetual.close - 1;
    const premiumChange = previousRow === undefined ? null : row.premium - previousRow.premium;
    const volatilityValue = trailingVolatility(series.perpetual, timestamp);
    const liquidityValue = trailingLiquidity(series.perpetual, timestamp);
    const basisPercentile = basisWindow.percentile(basis);
    const premiumPercentile = premiumWindow.percentile(row.premium);
    const signedExpansionPercentile = expansionWindow.percentile(signedExpansion);
    const priceChangePercentile = priceChangeWindow.percentile(priceChange);
    const premiumChangePercentile = premiumChangeWindow.percentile(premiumChange);
    const conditionDirections = emptyDirections();
    conditionDirections.B1 = b1BasisDirection({ value: basis, rollingPercentile: basisPercentile, historyAvailable: basisPercentile !== null });
    conditionDirections.B2 = b2PremiumDirection({ value: row.premium, rollingPercentile: premiumPercentile, historyAvailable: premiumPercentile !== null });
    conditionDirections.B3 = b3SignedExpansionDirection({ value: signedExpansion, rollingPercentile: signedExpansionPercentile, historyAvailable: signedExpansionPercentile !== null });
    conditionDirections.B4 = b4DivergenceDirection({ priceChangePercentile, premiumChangePercentile, historyAvailable: priceChangePercentile !== null && premiumChangePercentile !== null });
    const decisionTime = timestamp + INTERVAL_MS;
    if (!isPitEventAvailable(timestamp, INTERVAL_MS, decisionTime)) throw new Error(`RESEARCH_INVALID:PIT:${series.symbol}`);
    observations.push({
      symbol: series.symbol,
      observationTime: timestamp,
      decisionTime,
      referencePrice: row.perpetual,
      basis,
      premium: row.premium,
      signedExpansion,
      priceChange,
      premiumChange,
      basisPercentile,
      premiumPercentile,
      signedExpansionPercentile,
      priceChangePercentile,
      premiumChangePercentile,
      fourHourReturn: fourHourReturn(series.perpetual, timestamp),
      volatilityValue,
      liquidityValue,
      markIndexBasis: row.mark / row.index - 1,
      fundingRate: null,
      calendarPeriod: quarterKey(timestamp),
      marketRegime: "UNKNOWN",
      volatilityBucket: bucketVolatility(volatilityValue),
      liquidityBucket: "UNKNOWN",
      fundingStateBucket: "UNKNOWN",
      existingMarkIndexBasisStateBucket: bucketBasis(row.mark / row.index - 1),
      featureStrength: "NORMAL",
      conditionDirections,
      eventDirections: emptyDirections(),
      matchKeyA: "",
      matchKeyB: "",
      fundingMatchKey: "",
      markIndexMatchKey: "",
    });
    basisWindow.push(basis);
    premiumWindow.push(row.premium);
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
      observation.liquidityBucket = bucketLiquidity(crossSectionalPercentile(liquidityValues, observation.symbol));
      const premiumPercentile = crossSectionalPercentile(premiumValues, observation.symbol);
      const sampleSize = premiumValues.filter((value) => value.value !== null).length;
      observation.conditionDirections.B5 = b5CrossSectionalDirection(premiumPercentile, sampleSize);
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

function formEvents(observations: Observation[], seriesBySymbol: Map<string, SymbolSeries>): void {
  const bySymbol = new Map<string, Observation[]>();
  for (const observation of observations) {
    const values = bySymbol.get(observation.symbol) ?? [];
    values.push(observation);
    bySymbol.set(observation.symbol, values);
  }
  for (const [symbol, values] of bySymbol) {
    const lifecycle = seriesBySymbol.get(symbol)?.lifecycle ?? [];
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
      evaluations.push({
        match: {
          family,
          direction,
          events,
          controls,
          pairsA: matchNearestWithoutReplacement(events.map((point) => ({ ...point, matchKey: point.observation.matchKeyA })), controlA).pairs,
          pairsB: matchNearestWithoutReplacement(events, controlB).pairs,
          pairsFunding: matchNearestWithoutReplacement(events.map((point) => ({ ...point, matchKey: point.observation.fundingMatchKey })), fundingControls).pairs,
          pairsMarkIndex: matchNearestWithoutReplacement(events.map((point) => ({ ...point, matchKey: point.observation.markIndexMatchKey })), markControls).pairs,
        },
        cells: new Map(),
      });
    }
  }
  return evaluations;
}

function eventOutcomeKey(point: Point, direction: Direction, horizon: Horizon): string {
  return directionalOutcomeCacheKey({
    symbol: point.observation.symbol,
    timestamp: point.observation.observationTime,
    direction,
    horizon,
  });
}

function calculatePointOutcome(point: Point, direction: Direction, horizon: Horizon, seriesBySymbol: Map<string, SymbolSeries>): DirectionalOutcome | null {
  const series = seriesBySymbol.get(point.observation.symbol);
  if (series === undefined) return null;
  if (point.observation.observationTime + HORIZON_HOURS[horizon] * HOUR_MS >= CLEAN_END_EXCLUSIVE) return null;
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
): { cache: Map<string, DirectionalOutcome | null>; successfulRows: number; attempts: number } {
  const cache = new Map<string, DirectionalOutcome | null>();
  let successfulRows = 0;
  let attempts = 0;
  const calculate = (point: Point, direction: Direction, horizon: Horizon): void => {
    const key = eventOutcomeKey(point, direction, horizon);
    if (cache.has(key)) return;
    const outcome = calculatePointOutcome(point, direction, horizon, seriesBySymbol);
    cache.set(key, outcome);
    attempts += 1;
    if (outcome !== null) successfulRows += 1;
  };
  for (const evaluation of evaluations) {
    for (const point of evaluation.match.events) {
      for (const horizon of HORIZONS) calculate(point, evaluation.match.direction, horizon);
    }
  }
  for (const evaluation of evaluations) {
    for (const pair of [...evaluation.match.pairsA, ...evaluation.match.pairsB]) {
      for (const horizon of HORIZONS) {
        calculate(pair.event, evaluation.match.direction, horizon);
        calculate(pair.control, evaluation.match.direction, horizon);
      }
    }
  }
  return { cache, successfulRows, attempts };
}

function outcomeSamples(
  pairs: MatchPair<Point, Point>[],
  direction: Direction,
  horizon: Horizon,
  cache: Map<string, DirectionalOutcome | null>,
): OutcomePairSample[] {
  const samples: OutcomePairSample[] = [];
  for (const pair of pairs) {
    const eventOutcome = cache.get(eventOutcomeKey(pair.event, direction, horizon));
    const controlOutcome = cache.get(eventOutcomeKey(pair.control, direction, horizon));
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

function evaluateCell(component: ComponentEvaluation, horizon: Horizon, cache: Map<string, DirectionalOutcome | null>): CellEvaluation {
  const { family, direction, events, pairsA, pairsB } = component.match;
  const samplesA = outcomeSamples(pairsA, direction, horizon, cache);
  const samplesB = outcomeSamples(pairsB, direction, horizon, cache);
  const signalReturns = samplesB.map((sample) => sample.signalReturn);
  const controlAReturns = samplesA.map((sample) => sample.controlReturn);
  const controlBReturns = samplesB.map((sample) => sample.controlReturn);
  const signalPrecision = precision(signalReturns);
  const controlAPrecision = precision(controlAReturns);
  const controlBPrecision = precision(controlBReturns);
  const statistics = pairedStatistics(
    samplesB.map((sample) => ({ signalReturn: sample.signalReturn > 0 ? 1 : 0, controlReturn: sample.controlReturn > 0 ? 1 : 0 })),
    cellSeed(family, direction, horizon),
    BOOTSTRAP_REPLICATES,
    PERMUTATION_REPLICATES,
  );
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
  const exact = summarizeCovariateBalance(pairs.map((_pair, index) => ({ event: eventRecords[index]!, control: controlRecords[index]! })), fields);
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
    fields: fieldBalance,
    severe_imbalance: severe,
    acceptable: !severe,
  };
}

function stabilityFor(component: ComponentEvaluation, cell: CellEvaluation, cache: Map<string, DirectionalOutcome | null>): JsonRecord {
  const samples = outcomeSamples(component.match.pairsB, cell.direction, cell.horizon, cache);
  const byQuarter = new Map<string, number[]>();
  const byRegime = new Map<string, number[]>();
  const bySymbol = new Map<string, number>();
  for (const sample of samples) {
    const difference = sample.signalReturn - sample.controlReturn;
    const quarter = sample.eventObservation.calendarPeriod;
    const regime = sample.eventObservation.marketRegime;
    byQuarter.set(quarter, [...(byQuarter.get(quarter) ?? []), difference]);
    byRegime.set(regime, [...(byRegime.get(regime) ?? []), difference]);
    bySymbol.set(sample.eventObservation.symbol, (bySymbol.get(sample.eventObservation.symbol) ?? 0) + 1);
  }
  const quarterEffects = Object.fromEntries([...byQuarter.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([quarter, values]) => [
    quarter,
    { sample_size: values.length, mean_effect: mean(values), sign: (mean(values) ?? 0) > 0 ? "POSITIVE" : (mean(values) ?? 0) < 0 ? "NEGATIVE" : "ZERO" },
  ]));
  const regimeEffects = Object.fromEntries([...byRegime.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([regime, values]) => [
    regime,
    { sample_size: values.length, mean_effect: mean(values), sign: (mean(values) ?? 0) > 0 ? "POSITIVE" : (mean(values) ?? 0) < 0 ? "NEGATIVE" : "ZERO" },
  ]));
  const positiveQuarters = [...byQuarter.values()].filter((values) => (mean(values) ?? 0) > 0).length;
  const positiveRegimes = [...byRegime.values()].filter((values) => (mean(values) ?? 0) > 0).length;
  const positiveQuarterRatio = byQuarter.size === 0 ? null : positiveQuarters / byQuarter.size;
  const positiveRegimeRatio = byRegime.size === 0 ? null : positiveRegimes / byRegime.size;
  const largestQuarterContribution = samples.length === 0 ? null : Math.max(...[...byQuarter.values()].map((values) => values.length)) / samples.length;
  const largestSymbolConcentration = samples.length === 0 ? null : Math.max(...bySymbol.values()) / samples.length;
  return {
    selected_cell: `${cell.family}:${cell.direction}:${cell.horizon}`,
    sample_size: samples.length,
    quarters: quarterEffects,
    regimes: regimeEffects,
    positive_quarter_ratio: formatPercentage(positiveQuarterRatio),
    positive_regime_ratio: formatPercentage(positiveRegimeRatio),
    largest_quarter_contribution_percent: formatPercentage(largestQuarterContribution),
    largest_symbol_concentration_percent: formatPercentage(largestSymbolConcentration),
    stable_across_quarters: byQuarter.size >= 3 && (positiveQuarterRatio ?? 0) >= 0.6 && (largestQuarterContribution ?? 1) <= 0.5,
    stable_across_regimes: byRegime.size >= 2 && (positiveRegimeRatio ?? 0) >= 0.75,
    regime_effect_signs: Object.fromEntries([...byRegime.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([regime, values]) => [regime, (regimeEffects[regime] as JsonRecord).sign])),
  };
}

function fileExists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

function cellToJson(cell: CellEvaluation): JsonRecord {
  return {
    family: cell.family,
    direction: cell.direction,
    horizon: cell.horizon,
    status: cell.eligibleEvents === 0
      ? "NO_EVENTS"
      : cell.matchedEvents === 0
        ? "MATCHING_INADEQUATE_COMPONENT"
        : cell.outcomeEligibleControlB === 0
          ? "NO_COMPLETE_OUTCOME"
          : "COMPUTED",
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
    effect_size_metric: "paired_directional_precision_difference_vs_control_b",
    raw_p_value: cell.rawPValue,
    holm_adjusted_p_value: cell.holmAdjustedPValue,
    matching_classification: cell.matchingClassification,
    paired_sample_size: cell.pairedSampleSize,
  };
}

function allCellList(evaluations: ComponentEvaluation[]): CellEvaluation[] {
  return evaluations.flatMap((evaluation) => HORIZONS.map((horizon) => evaluation.cells.get(horizon)!));
}

function cellId(cell: CellEvaluation): string {
  return `${cell.family}:${cell.direction}:${cell.horizon}`;
}

function bestCell(evaluations: ComponentEvaluation[]): CellEvaluation | null {
  const candidates = allCellList(evaluations)
    .filter((cell) => cell.incrementalLiftVsB !== null && cell.effectSize !== null)
    .sort((left, right) => (right.incrementalLiftVsB! - left.incrementalLiftVsB!)
      || ((left.rawPValue ?? Number.POSITIVE_INFINITY) - (right.rawPValue ?? Number.POSITIVE_INFINITY))
      || cellId(left).localeCompare(cellId(right)));
  return candidates[0] ?? null;
}

function componentByCell(evaluations: ComponentEvaluation[], cell: CellEvaluation): ComponentEvaluation {
  const component = evaluations.find((evaluation) => evaluation.match.family === cell.family && evaluation.match.direction === cell.direction);
  if (component === undefined) throw new Error(`RESEARCH_INVALID:MISSING_COMPONENT:${cellId(cell)}`);
  return component;
}

function countSignificant(evaluations: ComponentEvaluation[], positive: boolean): number {
  return allCellList(evaluations).filter((cell) => cell.holmAdjustedPValue !== null
    && cell.holmAdjustedPValue <= 0.05
    && cell.effectSize !== null
    && (positive ? cell.effectSize > 0 : cell.effectSize <= 0)).length;
}

function makeMetricTree(evaluations: ComponentEvaluation[]): JsonRecord {
  const byFamily: JsonRecord = {};
  for (const family of FAMILIES) {
    const byDirection: JsonRecord = {};
    for (const direction of DIRECTIONS) {
      const evaluation = evaluations.find((value) => value.match.family === family && value.match.direction === direction);
      if (evaluation === undefined) throw new Error(`RESEARCH_INVALID:MISSING_COMPONENT:${family}:${direction}`);
      byDirection[direction] = Object.fromEntries(HORIZONS.map((horizon) => [horizon, cellToJson(evaluation.cells.get(horizon)!)]));
    }
    const eventCount = DIRECTIONS.reduce((sum, direction) => {
      const evaluation = evaluations.find((value) => value.match.family === family && value.match.direction === direction);
      return sum + (evaluation?.match.events.length ?? 0);
    }, 0);
    byFamily[family] = {
      event_count: eventCount,
      formal_test_included: true,
      by_direction_and_horizon: byDirection,
    };
  }
  return byFamily;
}

function setHolmAdjustedPValues(evaluations: ComponentEvaluation[]): void {
  const pValues = evaluations.flatMap((evaluation) => HORIZONS.map((horizon) => {
    const cell = evaluation.cells.get(horizon)!;
    return { id: cellId(cell), pValue: cell.rawPValue };
  }));
  const formalIds = formalHolmTestIds();
  const actualIds = pValues.map((value) => value.id).sort();
  const expectedIds = [...formalIds].sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error("RESEARCH_INVALID:HOLM_40_CELL_COMPLETENESS");
  }
  const adjusted = applyHolmCorrection(pValues);
  for (const evaluation of evaluations) {
    for (const horizon of HORIZONS) {
      const cell = evaluation.cells.get(horizon)!;
      cell.holmAdjustedPValue = adjusted[cellId(cell)] ?? null;
    }
  }
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
      const signalPrecision = precision(formalSamples.map((sample) => sample.signalReturn));
      const controlAPrecision = precision(rawSamples.map((sample) => sample.controlReturn));
      const attributionPrecision = precision(attributionPairs.map((sample) => sample.controlReturn));
      byHorizon[horizon] = {
        signal_precision: signalPrecision,
        uncontrolled_control_a_precision: controlAPrecision,
        raw_effect_vs_control_a: signalPrecision === null || controlAPrecision === null ? null : signalPrecision - controlAPrecision,
        attribution_control_precision: attributionPrecision,
        attribution_effect: signalPrecision === null || attributionPrecision === null ? null : signalPrecision - attributionPrecision,
        attribution_type: evaluation.match.family === "B1"
          ? "existing_mark_index_basis_control"
          : ["B2", "B3"].includes(evaluation.match.family)
            ? "funding_control"
            : "not_applicable",
        formal_control_b_lift: cell.incrementalLiftVsB,
        attribution_sample_size: attributionPairs.length,
      };
    }
    output[`${evaluation.match.family}:${evaluation.match.direction}`] = byHorizon;
  }
  return output;
}

function freezeContract(inputs: FrozenInputs, hashes: ImplementationHashes): JsonRecord {
  return {
    research: "HY-R5.9B CLEAN AUTHORITATIVE BASIS/PREMIUM DISCOVERY",
    version: "hy-r5.9b-clean-basis-premium-freeze-v1",
    immutable: true,
    experiment_id: EXPERIMENT_ID,
    historical_window: CLEAN_RANGE,
    universe: inputs.universe,
    resolution: RESOLUTION,
    random_seed: RANDOM_SEED,
    statistical_policy: {
      bootstrap_replicates: BOOTSTRAP_REPLICATES,
      permutation_replicates: PERMUTATION_REPLICATES,
      confidence_level: 0.95,
      multiple_testing: "Holm across all 40 B1-B5 × direction × horizon cells",
    },
    frozen_artifact_hashes: inputs.cleanHashGate,
    frozen_semantic_hashes: inputs.semanticHashGate,
    remediated_implementation_gate: inputs.remediatedGate,
    implementation_hashes: hashes,
    event_contract: {
      families: [...FAMILIES],
      directions: [...DIRECTIONS],
      formation: "FALSE_TO_TRUE_TRANSITION",
      repeated_true_deduplicated: true,
      true_to_false_resets: true,
      separate_directions: true,
      b5_population: "same-timestamp ACTIVE complete PIT-available clean observations",
    },
    matching_contract: {
      control_a_dimensions: [...R58B_CONTROL_A_DIMENSIONS],
      control_b_additions: [...R58B_CONTROL_B_ADDITIONS],
      formal_incremental_comparison: "Control B",
      nearest_without_replacement: true,
      matching_buckets_frozen: true,
      matching_distance_frozen: true,
      fallback_forbidden: true,
    },
    forbidden_data: {
      contaminated_window: R58C_CONTAMINATED_WINDOW,
      reserved_holdout: R59_RESERVED_HOLDOUT,
      future_outcome_before_freeze: true,
    },
    authoritative_performance_executions: 0,
    future_outcomes_generated: 0,
    performance_lock: "NOT_TRIGGERED",
    post_result_tuning: "NO",
    future_performance_calculated: false,
  };
}

async function ensurePrePerformanceFreeze(inputs: FrozenInputs, hashes: ImplementationHashes): Promise<FreezeArtifacts> {
  const contract = freezeContract(inputs, hashes);
  if (await fileExists(FREEZE_PATH)) {
    const existing = await readJson(FREEZE_PATH);
    if (existing.immutable !== true
      || sha256Json(asRecord(existing.freeze_contract)) !== sha256Json(contract)
      || existing.authoritative_performance_executions !== 0
      || existing.future_outcomes_generated !== 0
      || existing.performance_lock !== "NOT_TRIGGERED"
      || existing.post_result_tuning !== "NO") {
      throw new Error("RESEARCH_INVALID:PERFORMANCE_LOCK_TRIGGERED_OR_FREEZE_CHANGED");
    }
    return { freeze: existing, freezeHash: sha256Json(existing) };
  }
  const freeze = {
    ...contract,
    created_at: new Date().toISOString(),
    freeze_contract: contract,
  };
  await writeFile(FREEZE_PATH, `${JSON.stringify(freeze, null, 2)}\n`, "utf8");
  const reloaded = await readJson(FREEZE_PATH);
  if (reloaded.immutable !== true || sha256Json(asRecord(reloaded.freeze_contract)) !== sha256Json(contract)) {
    throw new Error("RESEARCH_INVALID:PRE_PERFORMANCE_FREEZE_WRITE");
  }
  return { freeze: reloaded, freezeHash: sha256Json(reloaded) };
}

function evidenceFor(
  evaluations: ComponentEvaluation[],
  cache: Map<string, DirectionalOutcome | null>,
): Map<string, { balance: JsonRecord; stability: JsonRecord }> {
  const output = new Map<string, { balance: JsonRecord; stability: JsonRecord }>();
  for (const evaluation of evaluations) {
    const balance = balanceFor(evaluation);
    for (const horizon of HORIZONS) {
      const cell = evaluation.cells.get(horizon)!;
      output.set(cellId(cell), { balance, stability: stabilityFor(evaluation, cell, cache) });
    }
  }
  return output;
}

function reportFor(
  inputs: FrozenInputs,
  frozen: FreezeArtifacts,
  evaluations: ComponentEvaluation[],
  cache: Map<string, DirectionalOutcome | null>,
  successfulEventRows: number,
  successfulRowsIncludingControls: number,
  outcomeAttempts: number,
  seriesBySymbol: Map<string, SymbolSeries>,
): JsonRecord {
  setHolmAdjustedPValues(evaluations);
  const evidence = evidenceFor(evaluations, cache);
  const best = bestCell(evaluations);
  const bestComponent = best === null ? null : componentByCell(evaluations, best);
  const bestEvidence = best === null ? null : evidence.get(cellId(best));
  const allCells = allCellList(evaluations);
  const nominalPositivePoorlyMatched = allCells.some((cell) => {
    if (cell.incrementalLiftVsB === null || cell.incrementalLiftVsB <= 0) return false;
    const candidateEvidence = evidence.get(cellId(cell));
    return (cell.matchingCoveragePercent ?? 0) < 60 || candidateEvidence?.balance.severe_imbalance === true;
  });
  const positiveCandidates = allCells
    .filter((cell) => cell.incrementalLiftVsB !== null && cell.incrementalLiftVsB > 0)
    .map((cell) => {
      const candidateEvidence = evidence.get(cellId(cell));
      const stability = candidateEvidence?.stability ?? {};
      return {
        incrementalPositive: true,
        confidenceLowerBoundPositive: (cell.confidenceInterval95?.lower ?? 0) > 0,
        holmSignificant: (cell.holmAdjustedPValue ?? 1) <= 0.05,
        matchingCoveragePercent: cell.matchingCoveragePercent ?? 0,
        covariateBalanceAcceptable: candidateEvidence?.balance.acceptable === true,
        meaningfulSample: cell.pairedSampleSize >= MEANINGFUL_SAMPLE_MINIMUM,
        stableAcrossQuarters: stability.stable_across_quarters === true,
        stableAcrossRegimes: stability.stable_across_regimes === true,
        largestSymbolShare: (asNumber(stability.largest_symbol_concentration_percent) ?? 100) / 100,
      };
    });
  const reasonableEvidence = allCells.some((cell) => (cell.matchingCoveragePercent ?? 0) >= 60
    && cell.pairedSampleSize >= MEANINGFUL_SAMPLE_MINIMUM);
  const classification = classifyR58C({
    invalid: inputs.gateErrors.length > 0,
    positiveCandidates,
    hasNominalPositivePoorlyMatched: nominalPositivePoorlyMatched,
    hasReasonableEvidence: reasonableEvidence,
  });
  const performanceLock = transitionPerformanceLock("NOT_TRIGGERED", successfulEventRows);
  const coverage = asRecord(inputs.cleanCoverage.aligned_coverage);
  const cleanExpected = asNumber(coverage.expected) ?? 0;
  const cleanValid = asNumber(coverage.valid) ?? 0;
  const cleanCoveragePercent = cleanExpected === 0 ? null : cleanValid / cleanExpected * 100;
  const stability = bestEvidence?.stability ?? {
    status: "NOT_ASSESSED",
    stable_across_quarters: false,
    stable_across_regimes: false,
    largest_symbol_concentration_percent: null,
  };
  const matchingByComponent: JsonRecord = {};
  for (const evaluation of evaluations) {
    const eligible = evaluation.match.events.length;
    const coveragePercent = eligible === 0 ? null : evaluation.match.pairsB.length / eligible * 100;
    matchingByComponent[`${evaluation.match.family}:${evaluation.match.direction}`] = {
      eligible_events: eligible,
      matched_control_a: evaluation.match.pairsA.length,
      matched_control_b: evaluation.match.pairsB.length,
      unmatched_control_b: eligible - evaluation.match.pairsB.length,
      matched_funding_attribution: evaluation.match.pairsFunding.length,
      matched_mark_index_attribution: evaluation.match.pairsMarkIndex.length,
      matching_coverage_percent: coveragePercent,
      matching_gate: matchingGate(coveragePercent ?? Number.NaN),
    };
  }
  const byCellStability: JsonRecord = {};
  const byCellBalance: JsonRecord = {};
  for (const cell of allCells) {
    const item = evidence.get(cellId(cell));
    byCellStability[cellId(cell)] = item?.stability ?? { status: "NOT_ASSESSED" };
    byCellBalance[cellId(cell)] = item?.balance ?? { status: "NOT_ASSESSED" };
  }
  return {
    research: "HY-R5.9B CLEAN AUTHORITATIVE BASIS/PREMIUM DISCOVERY",
    version: "hy-r5.9b-clean-basis-premium-authoritative-v1",
    generated_at: new Date().toISOString(),
    experiment_id: EXPERIMENT_ID,
    classification,
    historical_range: CLEAN_RANGE,
    universe: inputs.universe,
    resolution: RESOLUTION,
    clean_foundation: {
      experiment_id: asString(inputs.cleanDataset.experiment_id),
      expected_symbols: inputs.universe.length,
      aligned_expected: cleanExpected,
      aligned_valid: cleanValid,
      aligned_missing: asNumber(coverage.missing) ?? cleanExpected - cleanValid,
      aligned_coverage_percent: cleanCoveragePercent,
      listing_aware: inputs.cleanCoverage.listing_aware === true,
      future_performance_calculated: inputs.cleanDataset.future_performance,
    },
    pre_performance_freeze: {
      path: FREEZE_PATH,
      sha256: frozen.freezeHash,
      created_before_outcomes: true,
      contract: frozen.freeze.freeze_contract,
    },
    frozen_inputs: {
      clean_artifact_hash_gate: inputs.cleanHashGate,
      semantic_hash_gate: inputs.semanticHashGate,
      remediated_implementation_gate: inputs.remediatedGate,
      implementation_hashes: inputs.implementationHashes,
    },
    authoritative_performance_executions: successfulEventRows > 0 ? 1 : 0,
    future_outcomes_generated: successfulEventRows,
    future_outcome_rows_including_controls: successfulRowsIncludingControls,
    future_outcome_attempts: outcomeAttempts,
    performance_lock: performanceLock,
    post_result_tuning: "NO",
    pit_safe: "PASS",
    governance: governanceGuards(),
    hypotheses: {
      families: [...FAMILIES],
      b1: "Perp/Index basis MEAN_REVERSION: positive extreme BEARISH, negative extreme BULLISH; FALSE_TO_TRUE only.",
      b2: "Premium extreme MEAN_REVERSION: positive extreme BEARISH, negative extreme BULLISH; FALSE_TO_TRUE only.",
      b3: "Frozen signed premium-change expansion/compression DISLOCATION_REVERSION primitive; no replacement formula.",
      b4: "Frozen price/premium divergence percentiles; ambiguous states NO_EVENT.",
      b5: "Same-timestamp ACTIVE complete PIT-available cross-sectional premium rank; N<2 NO_EVENT.",
      deduplication: "Separate directions; TRUE_TO_TRUE no event; TRUE_TO_FALSE resets.",
    },
    metrics: { by_family: makeMetricTree(evaluations) },
    matching: {
      control_a_dimensions: [...R58B_CONTROL_A_DIMENSIONS],
      control_b_additions: [...R58B_CONTROL_B_ADDITIONS],
      formal_incremental_comparison: "Control B",
      coverage_gate: {
        robust_minimum_percent: 70,
        conditional_minimum_percent: 60,
        below_conditional: "MATCHING_INADEQUATE_COMPONENT",
      },
      by_component: matchingByComponent,
    },
    balance: {
      metric: "total_variation_distance_with_exact_match_fraction",
      severe_imbalance_threshold: ">0.5 total variation distance",
      required_fields: [
        "symbol",
        "calendar_period",
        "market_regime",
        "volatility_bucket",
        "liquidity_bucket",
        "funding_state_bucket",
        "existing_mark_index_basis_state_bucket",
        "feature_strength",
      ],
      by_cell: byCellBalance,
      best_cell: best === null ? null : byCellBalance[cellId(best)],
      severe_imbalance: Object.values(byCellBalance).some((value) => asRecord(value).severe_imbalance === true),
    },
    statistics: {
      formal_holm_family_test_count: formalHolmTestIds().length,
      formal_holm_family_test_ids: formalHolmTestIds(),
      formal_cells_complete: allCells.length === formalHolmTestIds().length,
      tests_executed: allCells.filter((cell) => cell.rawPValue !== null).length,
      cells_without_outcomes: allCells.filter((cell) => cell.rawPValue === null).map(cellId),
      paired_bootstrap_replicates: BOOTSTRAP_REPLICATES,
      permutation_replicates: PERMUTATION_REPLICATES,
      seed: RANDOM_SEED,
      confidence_level: 0.95,
      multiple_testing: "Holm",
      effect_metric: "paired directional precision difference vs Control B",
      holm_significant_positive_tests: countSignificant(evaluations, true),
      holm_significant_non_positive_tests: countSignificant(evaluations, false),
      deterministic_statistics: true,
    },
    stability: {
      best_cell: best === null ? null : cellId(best),
      best_cell_evidence: stability,
      by_cell: byCellStability,
      stable_across_quarters: asRecord(stability).stable_across_quarters === true,
      stable_across_regimes: asRecord(stability).stable_across_regimes === true,
      largest_symbol_concentration_percent: asRecord(stability).largest_symbol_concentration_percent ?? null,
    },
    best_new_information: {
      phenomenon: best === null ? "NONE" : cellId(best),
      control_b_lift: best?.incrementalLiftVsB ?? null,
      confidence_interval_95: best?.confidenceInterval95 ?? null,
      holm_adjusted_p_value: best?.holmAdjustedPValue ?? null,
      matching_coverage_percent: best?.matchingCoveragePercent ?? null,
      paired_sample_size: best?.pairedSampleSize ?? 0,
    },
    attribution: {
      by_component: attributionFor(evaluations, cache),
      funding_attribution: "No clean-window funding history is present; funding_state_bucket=UNKNOWN, so funding attribution is not identifiable from this window.",
      mark_index_attribution: "B1 Mark/Index basis attribution is reported separately; formal incremental conclusion remains Control B adjusted.",
      no_result_driven_rescue: true,
    },
    data_integrity: {
      series_symbols_loaded: seriesBySymbol.size,
      aligned_observations_loaded: [...seriesBySymbol.values()].reduce((sum, series) => sum + series.aligned.size, 0),
      perpetual_bars_loaded: [...seriesBySymbol.values()].reduce((sum, series) => sum + series.perpetual.size, 0),
      materialized_files_verified: verifiedFileCache.size,
      future_gap_policy: "any missing future bar invalidates that horizon outcome; no deletion, fill or repair",
      contaminated_data_accessed: false,
      reserved_holdout_accessed: false,
    },
    verification: {
      clean_artifacts_verified: true,
      semantic_freeze_verified: true,
      remediated_direction_aware_outcome_verified: true,
      outcome_cache_identity: "symbol|timestamp|direction|horizon",
      freeze_precedes_outcome: true,
      no_future_data_in_matching: true,
      event_dedup: "FALSE_TO_TRUE; TRUE_TO_TRUE deduplicated; TRUE_TO_FALSE resets",
      b3_status: "COMPATIBLE_WITH_FROZEN_FIRST_DIFFERENCE_PRIMITIVE",
      source_paths: {
        current_runner: R59B_RUNNER_PATH,
        frozen_semantics: [...R59B_SOURCE_PATHS.slice(1)],
        remediated_source: [...R58D_SOURCE_PATHS],
        outcome: OUTCOME_PATH,
        matching: MATCHING_PATH,
        statistical: STATISTICAL_PATH,
        classification: CLASSIFICATION_PATH,
      },
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
      migration_executed: false,
    },
  };
}

function markdownFor(report: JsonRecord): string {
  const clean = asRecord(report.clean_foundation);
  const frozen = asRecord(report.frozen_inputs);
  const cleanGate = asRecord(frozen.clean_artifact_hash_gate);
  const semanticGate = asRecord(frozen.semantic_hash_gate);
  const remediatedGate = asRecord(frozen.remediated_implementation_gate);
  const implementations = asRecord(frozen.implementation_hashes);
  const metrics = asRecord(asRecord(report.metrics).by_family);
  const best = asRecord(report.best_new_information);
  const stability = asRecord(report.stability);
  const statistics = asRecord(report.statistics);
  const lines = [
    "# HY-R5.9B Clean Authoritative Basis / Premium Discovery",
    "",
    `- Classification: **${asString(report.classification)}**`,
    `- Historical window: ${CLEAN_RANGE.start} → ${CLEAN_RANGE.end}`,
    `- Universe: ${String(asArray(report.universe).length)} symbols`,
    `- Resolution: ${String(report.resolution)}`,
    `- Aligned expected / valid / coverage: ${String(clean.aligned_expected)} / ${String(clean.aligned_valid)} / ${String(clean.aligned_coverage_percent)}%`,
    `- PIT-safe: **${asString(report.pit_safe)}**`,
    `- Authoritative performance executions: ${String(report.authoritative_performance_executions)}`,
    `- Future outcome rows (events / including controls): ${String(report.future_outcomes_generated)} / ${String(report.future_outcome_rows_including_controls)}`,
    `- Performance lock: **${String(report.performance_lock)}**`,
    `- Post-result tuning: **${String(report.post_result_tuning)}**`,
    "",
    "## Frozen hash gates",
    "",
    `- Clean artifact gate: **${String(cleanGate.passed).toUpperCase()}**`,
    `- Clean coverage matrix: ${String(asRecord(cleanGate.computed).clean_coverage_matrix)}`,
    `- Clean schema manifest: ${String(asRecord(cleanGate.computed).clean_schema_manifest)}`,
    `- Clean dataset manifest: ${String(asRecord(cleanGate.computed).clean_dataset_manifest)}`,
    `- Clean aligned-data manifest: ${String(asRecord(cleanGate.computed).clean_aligned_data_manifest)}`,
    `- Semantic gate: **${String(semanticGate.passed).toUpperCase()}**`,
    `- Feature specification: ${String(asRecord(semanticGate.computed).feature)}`,
    `- Hypothesis freeze: ${String(asRecord(semanticGate.computed).hypothesis)}`,
    `- Cutoff freeze: ${String(asRecord(semanticGate.computed).cutoff)}`,
    `- Remediated gate: **${String(remediatedGate.passed).toUpperCase()}**`,
    `- R5.8D runner/source hash: ${String(asRecord(remediatedGate.computed).runner_source)}`,
    `- Direction-aware outcome hash: ${String(asRecord(remediatedGate.computed).outcome)}`,
    `- Current runner hash: ${String(implementations.runnerSourceHash)}`,
    `- Matching implementation hash: ${String(implementations.matchingHash)}`,
    `- Statistical implementation hash: ${String(implementations.statisticalHash)}`,
    `- Classification implementation hash: ${String(implementations.classificationHash)}`,
    "",
    "## Formal 40-cell results",
    "",
    "The formal comparison is paired directional precision against Control B. Each cell uses 2,000 deterministic bootstrap replicates, 2,000 deterministic permutation replicates, a 95% confidence interval, raw p-value, and Holm correction across all 40 pre-registered cells, including cells without outcomes.",
    "",
    "| Family | Direction | Horizon | Eligible | Matched | Coverage % | Signal precision | Control A | Control B | Lift vs B | Return effect vs B | MFE effect | MAE effect | CI 95% | Holm p |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |",
    ...FAMILIES.flatMap((family) => DIRECTIONS.flatMap((direction) => HORIZONS.map((horizon) => {
      const familyRecord = asRecord(metrics[family]);
      const directionRecord = asRecord(familyRecord.by_direction_and_horizon);
      const metric = asRecord(asRecord(directionRecord[direction])[horizon]);
      return `| ${family} | ${direction} | ${horizon} | ${String(metric.eligible_events)} | ${String(metric.matched_events)} | ${String(metric.matching_coverage_percent ?? "N/A")} | ${String(metric.signal_precision ?? "N/A")} | ${String(metric.control_a_precision ?? "N/A")} | ${String(metric.control_b_precision ?? "N/A")} | ${String(metric.incremental_lift_vs_control_b ?? "N/A")} | ${String(metric.mean_return_effect_vs_control_b ?? "N/A")} | ${String(metric.mfe_effect ?? "N/A")} | ${String(metric.mae_effect ?? "N/A")} | ${JSON.stringify(metric.confidence_interval_95)} | ${String(metric.holm_adjusted_p_value ?? "N/A")} |`;
    }))),
    "",
    "## Matching, stability and attribution",
    "",
    `- Control A dimensions: ${R58B_CONTROL_A_DIMENSIONS.join(", ")}.`,
    `- Control B additions: ${R58B_CONTROL_B_ADDITIONS.join(", ")}; formal incremental comparison is Control B.`,
    "- Matching: nearest without replacement; buckets, dimensions, distance, and fallback are frozen.",
    "- Matching classification: >=70% robust eligible; 60–<70% conditional maximum; <60% inadequate.",
    `- Holm significant positive / non-positive cells: ${String(statistics.holm_significant_positive_tests)} / ${String(statistics.holm_significant_non_positive_tests)}.`,
    `- Best phenomenon: ${String(best.phenomenon)}; Control-B lift: ${String(best.control_b_lift)}; CI: ${JSON.stringify(best.confidence_interval_95)}; matching: ${String(best.matching_coverage_percent)}%.`,
    `- Best-cell stable across quarters / regimes: ${String(stability.stable_across_quarters).toUpperCase()} / ${String(stability.stable_across_regimes).toUpperCase()}.`,
    `- Largest symbol concentration: ${String(stability.largest_symbol_concentration_percent ?? "N/A")}%.`,
    "- Funding attribution: clean-window funding history is unavailable; the frozen Control B funding bucket is UNKNOWN and no funding attribution is claimed.",
    "- B1 Mark/Index attribution is reported separately from the formal Control-B result.",
    "",
    "## Governance and safety",
    "",
    "- Contaminated R5.8C window accessed: NO",
    "- Reserved 2026-08-10+ holdout accessed: NO",
    "- Result-driven tuning: NO",
    "- Production modified: NO",
    "- Supabase Production modified: NO",
    "- Vercel modified: NO",
    "- PAPER strategy modified: NO",
    "- Emails sent: 0",
    "- Private API / orders: NO",
    "- AUTO_TRADING: FALSE",
    "- Commit created: NO",
    "",
    "STOP.",
  ];
  return `${lines.join("\n")}\n`;
}

function updateOutcomeCounts(
  evaluations: ComponentEvaluation[],
  seriesBySymbol: Map<string, SymbolSeries>,
): { cache: Map<string, DirectionalOutcome | null>; successfulEventRows: number; successfulRowsIncludingControls: number; attempts: number } {
  const cache = new Map<string, DirectionalOutcome | null>();
  const eventKeys = new Set<string>();
  const allKeys = new Set<string>();
  const calculate = (point: Point, direction: Direction, horizon: Horizon): void => {
    const key = eventOutcomeKey(point, direction, horizon);
    if (cache.has(key)) return;
    cache.set(key, calculatePointOutcome(point, direction, horizon, seriesBySymbol));
  };
  for (const evaluation of evaluations) {
    for (const point of evaluation.match.events) {
      for (const horizon of HORIZONS) {
        const key = eventOutcomeKey(point, evaluation.match.direction, horizon);
        eventKeys.add(key);
        allKeys.add(key);
        calculate(point, evaluation.match.direction, horizon);
      }
    }
  }
  for (const evaluation of evaluations) {
    for (const pair of [...evaluation.match.pairsA, ...evaluation.match.pairsB]) {
      for (const horizon of HORIZONS) {
        allKeys.add(eventOutcomeKey(pair.event, evaluation.match.direction, horizon));
        allKeys.add(eventOutcomeKey(pair.control, evaluation.match.direction, horizon));
        calculate(pair.event, evaluation.match.direction, horizon);
        calculate(pair.control, evaluation.match.direction, horizon);
      }
    }
  }
  const successful = (key: string): boolean => cache.get(key) !== null && cache.get(key) !== undefined;
  return {
    cache,
    successfulEventRows: [...eventKeys].filter(successful).length,
    successfulRowsIncludingControls: [...allKeys].filter(successful).length,
    attempts: cache.size,
  };
}

async function main(): Promise<void> {
  if (await fileExists(JSON_REPORT_PATH) || await fileExists(MARKDOWN_REPORT_PATH)) {
    throw new Error("AUTHORITATIVE_RUN_LOCKED: HY-R5.9B result exists; refusing rerun");
  }
  const governance = governanceGuards();
  const inputs = await loadFrozenInputs();
  const implementations = await implementationHashes();
  if (!asString(governance.clean_window) || !inputs.cleanHashGate.passed || !inputs.semanticHashGate.passed || !inputs.remediatedGate.passed) {
    throw new Error("RESEARCH_INVALID:PRE_PERFORMANCE_GATE");
  }
  const frozen = await ensurePrePerformanceFreeze(inputs, implementations);
  const seriesBySymbol = await loadSeries(inputs);
  const observations = [...seriesBySymbol.values()].flatMap((series) => buildSymbolObservations(series));
  addCrossSectionalContext(observations);
  formEvents(observations, seriesBySymbol);
  const evaluations = buildMatches(observations);
  const outcomes = updateOutcomeCounts(evaluations, seriesBySymbol);
  for (const evaluation of evaluations) {
    for (const horizon of HORIZONS) evaluation.cells.set(horizon, evaluateCell(evaluation, horizon, outcomes.cache));
  }
  const report = reportFor(
    inputs,
    frozen,
    evaluations,
    outcomes.cache,
    outcomes.successfulEventRows,
    outcomes.successfulRowsIncludingControls,
    outcomes.attempts,
    seriesBySymbol,
  );
  await writeFile(JSON_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(MARKDOWN_REPORT_PATH, markdownFor(report), "utf8");
  console.log(JSON.stringify({
    classification: report.classification,
    cleanArtifactsVerified: asRecord(report.frozen_inputs).clean_artifact_hash_gate,
    authoritativePerformanceExecutions: report.authoritative_performance_executions,
    futureOutcomesGenerated: report.future_outcomes_generated,
    performanceLock: report.performance_lock,
    bestNewInformation: report.best_new_information,
    formalCells: asRecord(report.statistics).formal_holm_family_test_count,
    output: JSON_REPORT_PATH,
  }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
