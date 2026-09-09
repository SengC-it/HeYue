import { createHash } from "node:crypto";

import { holmAdjustR58 } from "./information-gain";

export const R58C_EXPECTED_HASHES = {
  coverage_matrix: "add14656788d11e4852840956895803c26c4eb8a10053c2e50d8bbadf9278447",
  schema_manifest: "17da39cd0ad500b21b2f1380bf526bdc1175738091f5b0ada05d0e73dcd3288a",
  feature_specification: "bbdaab9e4cba4c22e50471d538d808fca992e812aaff60a0fc3f70af6020cf51",
  dataset_manifest: "4a6c99a36df032f605b96a63dffda35beb2cce60679281368070da57480f8da0",
  hypothesis_manifest: "0b5a790a1783704fc5eb130c4d1fa65c865339e68232fa1b54af9012c58db0f3",
  cutoff_manifest: "95fe1b5a20b0d4804e52dbc01c2f0e730a8f6b377e0c29ae2877875d8f06e800",
} as const;

export type R58CFrozenHashName = keyof typeof R58C_EXPECTED_HASHES;

export interface R58CHashGate {
  passed: boolean;
  expected: Record<R58CFrozenHashName, string>;
  computed: Partial<Record<R58CFrozenHashName, string>>;
  mismatches: string[];
}

export function verifyR58CHashGate(
  computed: Partial<Record<R58CFrozenHashName, string>>,
): R58CHashGate {
  const expected = { ...R58C_EXPECTED_HASHES };
  const mismatches = (Object.keys(expected) as R58CFrozenHashName[])
    .filter((name) => computed[name] !== expected[name]);
  return { passed: mismatches.length === 0, expected, computed, mismatches };
}

export function sourceBytesHash(paths: string[], contents: string[]): string {
  if (paths.length !== contents.length) throw new Error("SOURCE_HASH_INPUT_LENGTH_MISMATCH");
  const hash = createHash("sha256");
  paths.forEach((path, index) => {
    hash.update(path, "utf8");
    hash.update("\0", "utf8");
    hash.update(contents[index]!, "utf8");
    hash.update("\0", "utf8");
  });
  return hash.digest("hex");
}

export type MatchingGateClassification =
  | "ROBUST_ELIGIBLE"
  | "CONDITIONAL_MAX"
  | "MATCHING_INADEQUATE_COMPONENT";

export function classifyMatchingCoverage(coveragePercent: number): MatchingGateClassification {
  if (!Number.isFinite(coveragePercent) || coveragePercent < 60) return "MATCHING_INADEQUATE_COMPONENT";
  if (coveragePercent < 70) return "CONDITIONAL_MAX";
  return "ROBUST_ELIGIBLE";
}

export type PerformanceLock = "NOT_TRIGGERED" | "TRIGGERED";

export function transitionPerformanceLock(
  current: PerformanceLock,
  futureOutcomeRowsGenerated: number,
): PerformanceLock {
  if (current === "TRIGGERED") return current;
  return futureOutcomeRowsGenerated > 0 ? "TRIGGERED" : "NOT_TRIGGERED";
}

export interface PairedOutcomeSample {
  signalReturn: number;
  controlReturn: number;
  signalMfe?: number;
  controlMfe?: number;
  signalMae?: number;
  controlMae?: number;
}

export interface ConfidenceInterval95 {
  lower: number;
  upper: number;
}

export interface PairedStatistics {
  sampleSize: number;
  effect: number;
  confidenceInterval95: ConfidenceInterval95;
  rawPValue: number;
  bootstrapReplicates: number;
  permutationReplicates: number;
  seed: number;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

export function mean(values: number[]): number | null {
  const finiteValues = values.filter(finite);
  if (finiteValues.length === 0) return null;
  return finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
}

export function median(values: number[]): number | null {
  const finiteValues = values.filter(finite).sort((left, right) => left - right);
  if (finiteValues.length === 0) return null;
  const middle = Math.floor(finiteValues.length / 2);
  return finiteValues.length % 2 === 0
    ? (finiteValues[middle - 1]! + finiteValues[middle]!) / 2
    : finiteValues[middle]!;
}

export function precision(values: number[]): number | null {
  const finiteValues = values.filter(finite);
  if (finiteValues.length === 0) return null;
  return finiteValues.filter((value) => value > 0).length / finiteValues.length;
}

function makeRng(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = Math.imul(1664525, state) + 1013904223;
    return (state >>> 0) / 4294967296;
  };
}

function quantileSorted(values: number[], probability: number): number {
  if (values.length === 1) return values[0]!;
  const position = (values.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower]!;
  const weight = position - lower;
  return values[lower]! + (values[upper]! - values[lower]!) * weight;
}

export function pairedBootstrapConfidenceInterval(
  differences: number[],
  seed: number,
  replicates = 2_000,
): ConfidenceInterval95 | null {
  const values = differences.filter(finite);
  if (values.length === 0 || replicates < 1) return null;
  const rng = makeRng(seed);
  const bootstrap: number[] = [];
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      total += values[Math.floor(rng() * values.length)]!;
    }
    bootstrap.push(total / values.length);
  }
  bootstrap.sort((left, right) => left - right);
  return {
    lower: quantileSorted(bootstrap, 0.025),
    upper: quantileSorted(bootstrap, 0.975),
  };
}

export function pairedPermutationPValue(
  differences: number[],
  seed: number,
  replicates = 2_000,
): number | null {
  const values = differences.filter(finite);
  if (values.length === 0 || replicates < 1) return null;
  const observed = values.reduce((sum, value) => sum + value, 0) / values.length;
  const target = Math.abs(observed);
  const rng = makeRng(seed);
  let atLeastAsExtreme = 0;
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    let total = 0;
    for (const value of values) total += rng() < 0.5 ? value : -value;
    if (Math.abs(total / values.length) >= target) atLeastAsExtreme += 1;
  }
  return (atLeastAsExtreme + 1) / (replicates + 1);
}

export function pairedStatistics(
  samples: PairedOutcomeSample[],
  seed: number,
  bootstrapReplicates = 2_000,
  permutationReplicates = 2_000,
): PairedStatistics | null {
  const differences = samples
    .map((sample) => sample.signalReturn - sample.controlReturn)
    .filter(finite);
  if (differences.length === 0) return null;
  const effect = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const confidenceInterval95 = pairedBootstrapConfidenceInterval(differences, seed, bootstrapReplicates);
  const rawPValue = pairedPermutationPValue(differences, seed + 1, permutationReplicates);
  if (confidenceInterval95 === null || rawPValue === null) return null;
  return {
    sampleSize: differences.length,
    effect,
    confidenceInterval95,
    rawPValue,
    bootstrapReplicates,
    permutationReplicates,
    seed,
  };
}

export function applyHolmCorrection(
  pValues: Array<{ id: string; pValue: number | null }>,
): Record<string, number | null> {
  return holmAdjustR58(pValues);
}

export function totalVariationDistance(left: string[], right: string[]): number | null {
  if (left.length === 0 || right.length === 0) return null;
  const leftCounts = new Map<string, number>();
  const rightCounts = new Map<string, number>();
  for (const value of left) leftCounts.set(value, (leftCounts.get(value) ?? 0) + 1);
  for (const value of right) rightCounts.set(value, (rightCounts.get(value) ?? 0) + 1);
  const keys = new Set([...leftCounts.keys(), ...rightCounts.keys()]);
  let total = 0;
  for (const key of keys) {
    total += Math.abs((leftCounts.get(key) ?? 0) / left.length - (rightCounts.get(key) ?? 0) / right.length);
  }
  return total / 2;
}

export function formatPercentage(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : value * 100;
}
