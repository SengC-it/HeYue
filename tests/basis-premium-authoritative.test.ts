import { describe, expect, it } from "vitest";

import { sha256Json } from "../lib/crowding";
import {
  R58B_AUTHORITATIVE_PERFORMANCE_COUNT,
  R58B_CONTROL_A_DIMENSIONS,
  R58B_CONTROL_B_ADDITIONS,
  R58B_EXPECTED_R57_HASHES,
  R58B_EXPECTED_R58A_HYPOTHESIS_HASH,
  auditEventEligibility,
  conditionalPositiveGate,
  emptyDirectionalMetric,
  formalHolmFamilySize,
  formalHolmTestIds,
  matchingGate,
  negativeResultNoRescue,
  robustPositiveGate,
  verifyR58BHashGate,
} from "../lib/basis-premium/authoritative";
import {
  buildR58AHypothesisManifest,
  eventFromTransition,
  hypothesisManifestHash,
} from "../lib/basis-premium/hypothesis";
import {
  makeExistingInformationMatchKey,
  verifyExpectedArtifactHashes,
} from "../lib/basis-premium/information-gain";

describe("HY-R5.8B authoritative basis/premium gates", () => {
  it("requires an exact match for all four R5.7 artifacts and the R5.8A hypothesis hash", () => {
    const r57Gate = verifyExpectedArtifactHashes(
      R58B_EXPECTED_R57_HASHES,
      R58B_EXPECTED_R57_HASHES,
      {
        coverage_matrix_sha256: R58B_EXPECTED_R57_HASHES.coverage_matrix,
        schema_manifest_sha256: R58B_EXPECTED_R57_HASHES.schema_manifest,
        feature_specification_sha256: R58B_EXPECTED_R57_HASHES.feature_specification,
        dataset_manifest_sha256: R58B_EXPECTED_R57_HASHES.dataset_manifest,
      },
    );
    expect(verifyR58BHashGate(r57Gate, R58B_EXPECTED_R58A_HYPOTHESIS_HASH)).toEqual({ passed: true, mismatches: [] });
    expect(verifyR58BHashGate(r57Gate, "drifted").passed).toBe(false);
    expect(hypothesisManifestHash(buildR58AHypothesisManifest())).toBe(R58B_EXPECTED_R58A_HYPOTHESIS_HASH);
  });

  it("rejects a changed R5.7 artifact even when the R5.8A hash is valid", () => {
    const expected = R58B_EXPECTED_R57_HASHES;
    const computed = { ...expected, dataset_manifest: "changed" };
    const r57Gate = verifyExpectedArtifactHashes(expected, computed, {
      coverage_matrix_sha256: expected.coverage_matrix,
      schema_manifest_sha256: expected.schema_manifest,
      feature_specification_sha256: expected.feature_specification,
      dataset_manifest_sha256: expected.dataset_manifest,
    });
    const result = verifyR58BHashGate(r57Gate, R58B_EXPECTED_R58A_HYPOTHESIS_HASH);
    expect(result.passed).toBe(false);
    expect(result.mismatches).toContain("dataset_manifest:computed");
    expect(result.mismatches).toContain("r57_artifact_hash_gate");
  });

  it("locks the single authoritative performance count", () => {
    expect(R58B_AUTHORITATIVE_PERFORMANCE_COUNT).toBe(1);
  });

  it("keeps false-to-true episode formation and repeated-true deduplication", () => {
    const states = [false, false, true, true, true, false, true];
    const events = states.slice(1).map((state, index) => eventFromTransition(states[index], state));
    expect(events).toEqual([false, true, false, false, false, true]);
  });

  it("separates Control A dimensions from Control B funding and Mark/Index additions", () => {
    expect(R58B_CONTROL_A_DIMENSIONS).toEqual([
      "symbol",
      "calendar_period",
      "market_regime",
      "volatility_bucket",
      "liquidity_bucket",
    ]);
    expect(R58B_CONTROL_B_ADDITIONS).toEqual([
      "funding_state_bucket",
      "existing_mark_index_basis_state_bucket",
    ]);
    const controlA = makeExistingInformationMatchKey({
      symbol: "BTCUSDT",
      calendarPeriod: "2025-Q1",
      marketRegime: "UP",
      volatilityBucket: "MEDIUM",
      liquidityBucket: "HIGH",
      fundingBucket: "NORMAL",
      markIndexBasisBucket: "NORMAL",
    });
    const differentFunding = makeExistingInformationMatchKey({
      symbol: "BTCUSDT",
      calendarPeriod: "2025-Q1",
      marketRegime: "UP",
      volatilityBucket: "MEDIUM",
      liquidityBucket: "HIGH",
      fundingBucket: "EXTREME_POSITIVE",
      markIndexBasisBucket: "NORMAL",
    });
    const differentBasis = makeExistingInformationMatchKey({
      symbol: "BTCUSDT",
      calendarPeriod: "2025-Q1",
      marketRegime: "UP",
      volatilityBucket: "MEDIUM",
      liquidityBucket: "HIGH",
      fundingBucket: "NORMAL",
      markIndexBasisBucket: "EXTREME",
    });
    expect(controlA).not.toBe(differentFunding);
    expect(controlA).not.toBe(differentBasis);
  });

  it("applies the frozen 70/60 matching gates", () => {
    expect(matchingGate(70)).toBe("ROBUST_ELIGIBLE");
    expect(matchingGate(69.999)).toBe("CONDITIONAL_MAX");
    expect(matchingGate(60)).toBe("CONDITIONAL_MAX");
    expect(matchingGate(59.999)).toBe("MATCHING_INADEQUATE_COMPONENT");
    expect(matchingGate(Number.NaN)).toBe("MATCHING_INADEQUATE_COMPONENT");
  });

  it("reports balance fields without inventing balance for an empty match set", () => {
    const empty = emptyDirectionalMetric("B1", "BULLISH", "1h");
    expect(empty.matching_coverage_percent).toBeNull();
    expect(empty.eligible_events).toBe(0);
    expect(sha256Json(empty)).toBe(sha256Json(emptyDirectionalMetric("B1", "BULLISH", "1h")));
  });

  it("freezes a complete Holm family of 5 x 2 x 4 tests", () => {
    const ids = formalHolmTestIds();
    expect(formalHolmFamilySize()).toBe(40);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
    expect(ids).toContain("B1:BULLISH:1h");
    expect(ids).toContain("B5:BEARISH:24h");
  });

  it("requires every robust-positive criterion", () => {
    const valid = {
      incrementalPositive: true,
      confidenceLowerBoundPositive: true,
      holmSignificant: true,
      matchingCoveragePercent: 70,
      covariateBalanceAcceptable: true,
      meaningfulSample: true,
      stableAcrossQuarters: true,
      stableAcrossRegimes: true,
      largestSymbolShare: 0.5,
    };
    expect(robustPositiveGate(valid)).toBe(true);
    expect(robustPositiveGate({ ...valid, largestSymbolShare: 0.5001 })).toBe(false);
    expect(robustPositiveGate({ ...valid, holmSignificant: false })).toBe(false);
  });

  it("limits conditional positive classification to the 60–70 percent window", () => {
    const valid = {
      incrementalPositive: true,
      confidenceLowerBoundPositive: true,
      holmSignificant: true,
      matchingCoveragePercent: 65,
      covariateBalanceAcceptable: true,
      meaningfulSample: false,
      stableAcrossQuarters: false,
      stableAcrossRegimes: false,
      largestSymbolShare: 0.9,
    };
    expect(conditionalPositiveGate(valid)).toBe(true);
    expect(conditionalPositiveGate({ ...valid, matchingCoveragePercent: 70 })).toBe(false);
    expect(conditionalPositiveGate({ ...valid, incrementalPositive: false })).toBe(false);
  });

  it("does not provide a rescue path for a negative result", () => {
    expect(negativeResultNoRescue("NO_INCREMENTAL_INFORMATION")).toBe(true);
    expect(negativeResultNoRescue("CONDITIONAL_INFORMATION_ONLY")).toBe(false);
  });

  it("audits every R5.8A hypothesis as incomplete when executable cutoffs are absent", () => {
    const audit = auditEventEligibility(buildR58AHypothesisManifest());
    expect(audit).toHaveLength(5);
    expect(audit.map((value) => value.id)).toEqual(["B1", "B2", "B3", "B4", "B5"]);
    expect(audit.every((value) => value.status === "SPECIFICATION_INCOMPLETE")).toBe(true);
    expect(audit.every((value) => value.missing_fields.includes("explicit_event_condition"))).toBe(true);
    expect(audit.every((value) => value.missing_fields.includes("extreme_threshold_or_cutoff"))).toBe(true);
  });
});
