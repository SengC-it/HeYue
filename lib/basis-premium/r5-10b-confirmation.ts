import { directionalOutcomeCacheKey } from "./outcome";
import { transitionPerformanceLock, type ConfidenceInterval95, type PerformanceLock } from "./performance";
import { R59_RESERVED_HOLDOUT } from "./clean-window";

export const R510B_EXPERIMENT_ID = "HY-R5.10B";
export const R510B_HOLDOUT_START = R59_RESERVED_HOLDOUT.start;
export const R510B_HOLDOUT_END_EXCLUSIVE = Date.parse("2026-09-01T00:00:00.000Z");
export const R510B_PRIMARY_HYPOTHESIS = "H-B4-1H-POOLED";
export const R510B_PRIMARY_HORIZON = "1h";
export const R510B_RANDOM_SEED = 51001;
export const R510B_BOOTSTRAP_REPLICATES = 2_000;
export const R510B_PERMUTATION_REPLICATES = 2_000;
export const R510B_SYMBOL_CONCENTRATION_LIMIT = 10;
export const R510B_WEEK_CONCENTRATION_LIMIT = 40;

export type R510BClassification =
  | "CONFIRMED_INCREMENTAL_INFORMATION"
  | "NOT_CONFIRMED"
  | "INSUFFICIENT_CONFIRMATION_EVIDENCE"
  | "RESEARCH_INVALID"
  | "AUTHORITATIVE_CONFIRMATION_INVALIDATED";

export interface R510BHashGate {
  passed: boolean;
  mismatches: string[];
  expected: Record<string, string>;
  computed: Record<string, string>;
}

export interface R510BPrecisionSample {
  signalCorrect: boolean;
  controlCorrect: boolean;
  signalReturn: number;
  controlReturn: number;
}

export interface R510BPrimaryDecisionInput {
  invalid: boolean;
  implementationInvalidated: boolean;
  dataComplete: boolean;
  sampleGate: boolean;
  matchingGate: boolean;
  balancePass: boolean;
  fundingComplete: boolean;
  markIndexComplete: boolean;
  pitPass: boolean;
  concentrationPass: boolean;
  effect: number | null;
  confidenceInterval: ConfidenceInterval95 | null;
}

export function verifyExactHashes(
  expected: Record<string, string>,
  computed: Record<string, string>,
): R510BHashGate {
  const mismatches = Object.keys(expected).filter((name) => computed[name] !== expected[name]);
  return { passed: mismatches.length === 0, mismatches, expected, computed };
}

export function exactHoldoutWindow(start: number, endExclusive: number): boolean {
  return start === R510B_HOLDOUT_START && endExclusive === R510B_HOLDOUT_END_EXCLUSIVE;
}

export function rejectSeptemberExtension(start: number, endExclusive: number): boolean {
  return exactHoldoutWindow(start, endExclusive) && endExclusive <= R510B_HOLDOUT_END_EXCLUSIVE;
}

export function outcomeIdentityIncludesDirection(
  symbol: string,
  timestamp: number,
  direction: "BULLISH" | "BEARISH",
  horizon: string,
): boolean {
  const key = directionalOutcomeCacheKey({ symbol, timestamp, direction, horizon });
  return key.split("|").length === 4 && key.split("|")[2] === direction && key.split("|")[3] === horizon;
}

export function directionalPrecision(returns: number[]): number | null {
  const finite = returns.filter((value) => Number.isFinite(value));
  return finite.length === 0 ? null : finite.filter((value) => value > 0).length / finite.length;
}

export function precisionLift(samples: R510BPrecisionSample[]): number | null {
  if (samples.length === 0) return null;
  return samples.reduce((total, sample) => total + Number(sample.signalCorrect) - Number(sample.controlCorrect), 0) / samples.length;
}

export function concentrationPass(
  largestSymbolPercent: number,
  largestWeekPercent: number,
): boolean {
  return Number.isFinite(largestSymbolPercent)
    && Number.isFinite(largestWeekPercent)
    && largestSymbolPercent <= R510B_SYMBOL_CONCENTRATION_LIMIT
    && largestWeekPercent <= R510B_WEEK_CONCENTRATION_LIMIT;
}

export function updatePerformanceLock(
  current: PerformanceLock,
  futureOutcomeRowsGenerated: number,
): PerformanceLock {
  return transitionPerformanceLock(current, futureOutcomeRowsGenerated);
}

export function classifyPrimaryDecision(input: R510BPrimaryDecisionInput): R510BClassification {
  if (input.implementationInvalidated) return "AUTHORITATIVE_CONFIRMATION_INVALIDATED";
  if (input.invalid) return "RESEARCH_INVALID";
  if (!input.dataComplete || !input.sampleGate || !input.matchingGate || !input.balancePass
    || !input.fundingComplete || !input.markIndexComplete || !input.pitPass) {
    return "INSUFFICIENT_CONFIRMATION_EVIDENCE";
  }
  if (!input.concentrationPass || input.effect === null || input.effect <= 0
    || input.confidenceInterval === null || input.confidenceInterval.lower <= 0) {
    return "NOT_CONFIRMED";
  }
  return "CONFIRMED_INCREMENTAL_INFORMATION";
}

export function allowedR510BClassification(value: string): value is R510BClassification {
  return [
    "CONFIRMED_INCREMENTAL_INFORMATION",
    "NOT_CONFIRMED",
    "INSUFFICIENT_CONFIRMATION_EVIDENCE",
    "RESEARCH_INVALID",
    "AUTHORITATIVE_CONFIRMATION_INVALIDATED",
  ].includes(value);
}
