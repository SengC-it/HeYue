import { describe, expect, it } from "vitest";

import {
  R510B_BOOTSTRAP_REPLICATES,
  R510B_HOLDOUT_END_EXCLUSIVE,
  R510B_HOLDOUT_START,
  R510B_PERMUTATION_REPLICATES,
  R510B_RANDOM_SEED,
  allowedR510BClassification,
  classifyPrimaryDecision,
  concentrationPass,
  directionalPrecision,
  exactHoldoutWindow,
  outcomeIdentityIncludesDirection,
  precisionLift,
  rejectSeptemberExtension,
  updatePerformanceLock,
  verifyExactHashes,
} from "../lib/basis-premium/r5-10b-confirmation";
import {
  makeExistingInformationMatchKey,
  matchNearestWithoutReplacement,
} from "../lib/basis-premium/information-gain";
import {
  featureStrengthIsExcludedFromMatching,
  mapFundingAtDecision,
  matchingCoverageGate,
  minimumSampleGate,
  preTreatmentBalancePass,
} from "../lib/basis-premium/r5-10a-holdout";

describe("HY-R5.10B frozen independent confirmation gates", () => {
  it("keeps the exact August holdout and rejects a September extension", () => {
    expect(exactHoldoutWindow(R510B_HOLDOUT_START, R510B_HOLDOUT_END_EXCLUSIVE)).toBe(true);
    expect(rejectSeptemberExtension(R510B_HOLDOUT_START, R510B_HOLDOUT_END_EXCLUSIVE + 3_600_000)).toBe(false);
  });

  it("preserves the direction-aware outcome identity", () => {
    expect(outcomeIdentityIncludesDirection("BTCUSDT", 1_000, "BULLISH", "1h")).toBe(true);
    expect(outcomeIdentityIncludesDirection("BTCUSDT", 1_000, "BEARISH", "1h")).toBe(true);
  });

  it("calculates directional precision and pooled bullish/bearish precision lift", () => {
    expect(directionalPrecision([0.1, -0.1, 0.2])).toBeCloseTo(2 / 3);
    expect(precisionLift([
      { signalCorrect: true, controlCorrect: false, signalReturn: 0.1, controlReturn: -0.1 },
      { signalCorrect: false, controlCorrect: true, signalReturn: -0.1, controlReturn: 0.1 },
      { signalCorrect: true, controlCorrect: true, signalReturn: 0.1, controlReturn: 0.1 },
    ])).toBeCloseTo(0);
  });

  it("requires all four frozen R5.10A protocol hashes", () => {
    const expected = {
      protocol_manifest: "protocol",
      funding_manifest: "funding",
      holdout_dataset: "dataset",
      matching_protocol: "matching",
    };
    expect(verifyExactHashes(expected, { ...expected }).passed).toBe(true);
    expect(verifyExactHashes(expected, { ...expected, holdout_dataset: "drift" }).mismatches).toEqual(["holdout_dataset"]);
  });

  it("keeps the three semantic hashes as an exact gate", () => {
    const expected = {
      r57_feature_specification: "feature",
      r58a_hypothesis_manifest: "hypothesis",
      r58a1_cutoff_manifest: "cutoff",
    };
    expect(verifyExactHashes(expected, { ...expected }).passed).toBe(true);
    expect(verifyExactHashes(expected, { ...expected, r58a1_cutoff_manifest: "drift" }).passed).toBe(false);
  });

  it("freezes the primary inference budget and seed", () => {
    expect(R510B_BOOTSTRAP_REPLICATES).toBeGreaterThanOrEqual(2_000);
    expect(R510B_PERMUTATION_REPLICATES).toBeGreaterThanOrEqual(2_000);
    expect(R510B_RANDOM_SEED).toBe(51_001);
  });

  it("applies the symbol and week concentration gates", () => {
    expect(concentrationPass(10, 40)).toBe(true);
    expect(concentrationPass(10.01, 40)).toBe(false);
    expect(concentrationPass(10, 40.01)).toBe(false);
  });

  it("uses exact Control-B keys and nearest matching without replacement", () => {
    const matchKey = makeExistingInformationMatchKey({
      symbol: "BTCUSDT",
      calendarPeriod: "2026-Q3",
      marketRegime: "RANGE",
      volatilityBucket: "NORMAL",
      liquidityBucket: "HIGH",
      fundingBucket: "NEUTRAL",
      markIndexBasisBucket: "POSITIVE",
    });
    const events = [{ time: 100, matchKey }, { time: 200, matchKey }];
    const controls = [{ time: 90, matchKey }, { time: 300, matchKey }];
    const result = matchNearestWithoutReplacement(events, controls);
    expect(result.pairs.map((pair) => pair.control.time)).toEqual([90, 300]);
    expect(result.unmatched).toHaveLength(0);
    expect(matchKey).not.toContain("feature_strength");
  });

  it("enforces Funding PIT and treats feature strength as audit-only", () => {
    const mapping = mapFundingAtDecision([
      { fundingTime: 100, fundingRate: -0.0001, pitAvailableAt: 150 },
      { fundingTime: 200, fundingRate: 0.0001, pitAvailableAt: 250 },
    ], 200);
    expect(mapping.observation?.fundingTime).toBe(100);
    expect(featureStrengthIsExcludedFromMatching()).toBe(true);
    expect(preTreatmentBalancePass(0.2)).toBe(true);
    expect(preTreatmentBalancePass(0.20001)).toBe(false);
  });

  it("enforces the frozen sample and matching coverage gates", () => {
    expect(minimumSampleGate({ pooled: 1000, bullish: 300, bearish: 300 })).toBe(true);
    expect(minimumSampleGate({ pooled: 999, bullish: 300, bearish: 300 })).toBe(false);
    expect(matchingCoverageGate({ pooled: 70, bullish: 60, bearish: 60 })).toBe(true);
    expect(matchingCoverageGate({ pooled: 69.99, bullish: 60, bearish: 60 })).toBe(false);
  });

  it("transitions the performance lock only after outcome rows exist", () => {
    expect(updatePerformanceLock("NOT_TRIGGERED", 0)).toBe("NOT_TRIGGERED");
    expect(updatePerformanceLock("NOT_TRIGGERED", 1)).toBe("TRIGGERED");
  });

  it("does not allow a secondary result to rescue a failed primary", () => {
    expect(classifyPrimaryDecision({
      invalid: false,
      implementationInvalidated: false,
      dataComplete: true,
      sampleGate: true,
      matchingGate: true,
      balancePass: true,
      fundingComplete: true,
      markIndexComplete: true,
      pitPass: true,
      concentrationPass: true,
      effect: -0.01,
      confidenceInterval: { lower: -0.02, upper: 0.01 },
    })).toBe("NOT_CONFIRMED");
  });

  it("distinguishes invalid, insufficient, not-confirmed, and confirmed states", () => {
    const base = {
      invalid: false,
      implementationInvalidated: false,
      dataComplete: true,
      sampleGate: true,
      matchingGate: true,
      balancePass: true,
      fundingComplete: true,
      markIndexComplete: true,
      pitPass: true,
      concentrationPass: true,
      effect: 0.01,
      confidenceInterval: { lower: 0.001, upper: 0.02 },
    };
    expect(classifyPrimaryDecision({ ...base, invalid: true })).toBe("RESEARCH_INVALID");
    expect(classifyPrimaryDecision({ ...base, sampleGate: false })).toBe("INSUFFICIENT_CONFIRMATION_EVIDENCE");
    expect(classifyPrimaryDecision({ ...base, confidenceInterval: { lower: -0.001, upper: 0.02 } })).toBe("NOT_CONFIRMED");
    expect(classifyPrimaryDecision(base)).toBe("CONFIRMED_INCREMENTAL_INFORMATION");
    expect(classifyPrimaryDecision({ ...base, implementationInvalidated: true })).toBe("AUTHORITATIVE_CONFIRMATION_INVALIDATED");
  });

  it("allows only the prescribed final classifications", () => {
    expect(allowedR510BClassification("CONFIRMED_INCREMENTAL_INFORMATION")).toBe(true);
    expect(allowedR510BClassification("WEAK_CONFIRMATION")).toBe(false);
  });
});
