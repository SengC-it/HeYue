import { describe, expect, it } from "vitest";

import {
  R58_BASIS_PREMIUM_FAMILIES,
  R58_STATISTICAL_POLICY,
  b1IncrementalAttribution,
  buildHypothesisManifest,
  classifyFundingOverlap,
  holmAdjustR58,
  isPitAvailable,
  makeExistingInformationMatchKey,
  matchNearestWithoutReplacement,
  summarizeCovariateBalance,
  validateExperimentGovernance,
  verifyExpectedArtifactHashes,
} from "../lib/basis-premium/information-gain";

describe("HY-R5.8 frozen basis/premium information-gain gates", () => {
  it("fails closed when any R5.7 artifact hash differs", () => {
    const expected = {
      coverage_matrix: "coverage",
      schema_manifest: "schema",
      feature_specification: "feature",
      dataset_manifest: "dataset",
    } as const;
    const manifest = {
      coverage_matrix_sha256: "coverage",
      schema_manifest_sha256: "schema",
      feature_specification_sha256: "feature",
      dataset_manifest_sha256: "dataset",
    };
    expect(verifyExpectedArtifactHashes(expected, expected, manifest).passed).toBe(true);
    const changed = { ...expected, feature_specification: "changed" };
    const result = verifyExpectedArtifactHashes(expected, changed, manifest);
    expect(result.passed).toBe(false);
    expect(result.mismatches).toContain("feature_specification:computed");
  });

  it("detects that R5.7 definitions lack post-result direction semantics", () => {
    const hypotheses = buildHypothesisManifest({
      candidates: R58_BASIS_PREMIUM_FAMILIES.map((id) => ({ id, name: id, definition: "frozen" })),
    });
    expect(hypotheses).toHaveLength(5);
    expect(hypotheses.every((value) => value.directional_semantics === "SPECIFICATION_INCOMPLETE")).toBe(true);
    expect(hypotheses.every((value) => value.formal_test_included === false)).toBe(true);
  });

  it("locks one experiment with no post-result tuning", () => {
    expect(validateExperimentGovernance({
      experiment_count: 1,
      features_frozen_before_performance: "YES",
      post_result_tuning: "NO",
    })).toEqual([]);
    expect(validateExperimentGovernance({
      experiment_count: 2,
      features_frozen_before_performance: "YES",
      post_result_tuning: "NO",
    })).toEqual(["experiment_count"]);
  });

  it("keeps the existing mark/index and funding controls in the match key", () => {
    const key = makeExistingInformationMatchKey({
      symbol: "BTCUSDT",
      calendarPeriod: "2025-Q1",
      marketRegime: "UP",
      volatilityBucket: "MEDIUM",
      liquidityBucket: "HIGH",
      fundingBucket: "EXTREME_POSITIVE",
      markIndexBasisBucket: "HIGH",
    });
    expect(key).toContain("EXTREME_POSITIVE");
    expect(key).toContain("HIGH");
    expect(key.split("|")).toHaveLength(7);
  });

  it("attributes B1 separately from the existing mark/index baseline", () => {
    expect(b1IncrementalAttribution(0.06, 0.04)).toEqual({
      raw_b1_effect: 0.06,
      existing_mark_index_effect: 0.04,
      incremental_over_existing_mark_index: 0.019999999999999997,
    });
    expect(b1IncrementalAttribution(null, 0.04).incremental_over_existing_mark_index).toBeNull();
  });

  it("does not credit funding as new information", () => {
    expect(classifyFundingOverlap({ correlation: 0.7, semantic: "RELATED_BUT_NOT_IDENTICAL" })).toBe("RELATED_BUT_NOT_IDENTICAL");
    expect(classifyFundingOverlap({ correlation: 0.2, semantic: "DISTINCT_FROM_FUNDING" })).toBe("DISTINCT_FROM_FUNDING");
  });

  it("enforces PIT availability and cross-sectional missing-symbol exclusion", () => {
    expect(isPitAvailable(1_000, 3_600_000, 3_601_000)).toBe(true);
    expect(isPitAvailable(1_000, 3_600_000, 3_600_999)).toBe(false);
    const points = [
      { time: 1_000, matchKey: "BTC|2025-Q1|UP|LOW|HIGH|NORMAL|LOW", symbol: "BTCUSDT", active: true },
      { time: 2_000, matchKey: "BTC|2025-Q1|UP|LOW|HIGH|NORMAL|LOW", symbol: "BTCUSDT", active: true },
    ];
    const controls = [{ ...points[0], time: 1_100 }];
    const result = matchNearestWithoutReplacement(points, controls);
    expect(result.pairs).toHaveLength(1);
    expect(result.unmatched).toHaveLength(1);
  });

  it("reports matching covariate balance", () => {
    const pairs = [{
      event: { symbol: "BTCUSDT", regime: "UP", funding: "NORMAL" },
      control: { symbol: "BTCUSDT", regime: "UP", funding: "EXTREME" },
    }];
    const balance = summarizeCovariateBalance(pairs, ["symbol", "regime", "funding"]);
    expect(balance.exact_match_fraction).toBe(0);
    expect(balance.fields.symbol.balance).toBe(1);
    expect(balance.fields.funding.balance).toBe(0);
  });

  it("keeps Holm correction deterministic and the statistical policy frozen", () => {
    const values = [
      { id: "B2:BULLISH:1h", pValue: 0.01 },
      { id: "B1:BULLISH:1h", pValue: 0.02 },
      { id: "B3:BULLISH:1h", pValue: null },
    ];
    expect(holmAdjustR58(values)).toEqual(holmAdjustR58([...values].reverse()));
    expect(R58_STATISTICAL_POLICY.bootstrap_replicates).toBe(2_000);
    expect(R58_STATISTICAL_POLICY.permutation_replicates).toBe(2_000);
    expect(R58_STATISTICAL_POLICY.multiple_testing).toBe("Holm");
  });
});
