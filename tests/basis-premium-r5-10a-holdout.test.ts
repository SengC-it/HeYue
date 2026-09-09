import { describe, expect, it } from "vitest";

import {
  R510A_MATCH_FIELDS,
  R510A_MINIMUM_SAMPLE,
  R510A_MATCHING_COVERAGE_MINIMUM,
  R510A_PRE_TREATMENT_TV_THRESHOLD,
  assertAllowedR510AClassification,
  assertB4Only,
  assertR510AHoldoutRange,
  bucketFundingR510A,
  existingInformationMatchKey,
  featureStrengthAuditIsNotBalanceGate,
  featureStrengthIsExcludedFromMatching,
  mapFundingAtDecision,
  matchingCoverageGate,
  minimumSampleGate,
  outcomeWindowIsLocked,
  preTreatmentBalancePass,
  rejectHistoricalR510AWindow,
} from "../lib/basis-premium/r5-10a-holdout";
import { R59_CLEAN_DISCOVERY_WINDOW, R59_RESERVED_HOLDOUT } from "../lib/basis-premium/clean-window";

describe("HY-R5.10A frozen B4 holdout protocol", () => {
  it("allows B4 and rejects every other frozen family", () => {
    expect(() => assertB4Only("B4")).not.toThrow();
    for (const family of ["B1", "B2", "B3", "B5"]) {
      expect(() => assertB4Only(family)).toThrow("B4_ONLY_GUARD_FAILED");
    }
  });

  it("excludes current B4 feature strength from matching while retaining an audit", () => {
    expect(featureStrengthIsExcludedFromMatching()).toBe(true);
    expect(featureStrengthAuditIsNotBalanceGate()).toBe(true);
    expect(R510A_MATCH_FIELDS).not.toContain("feature_strength");
  });

  it("keeps the seven pre-treatment covariates in the frozen Existing-Information key", () => {
    const key = existingInformationMatchKey({
      symbol: "BTCUSDT",
      calendarPeriod: "2026-Q3",
      marketRegime: "RANGE",
      volatilityBucket: "NORMAL",
      liquidityBucket: "HIGH",
      fundingBucket: "POSITIVE",
      markIndexBasisBucket: "NEGATIVE",
    });
    expect(key.split("|")).toHaveLength(7);
    expect(key).not.toContain("EXTREME");
  });

  it("maps official Funding with frozen five-band boundaries collapsed to three buckets", () => {
    expect(bucketFundingR510A(-0.0003)).toBe("NEGATIVE");
    expect(bucketFundingR510A(-0.00005)).toBe("NEUTRAL");
    expect(bucketFundingR510A(0.00005)).toBe("NEUTRAL");
    expect(bucketFundingR510A(0.00005001)).toBe("POSITIVE");
  });

  it("uses only the latest PIT-available Funding observation", () => {
    const result = mapFundingAtDecision([
      { fundingTime: 1_000, fundingRate: -0.0001, pitAvailableAt: 1_000 },
      { fundingTime: 2_000, fundingRate: 0.0001, pitAvailableAt: 2_500 },
    ], 2_000);
    expect(result.status).toBe("COMPLETE");
    expect(result.observation?.fundingTime).toBe(1_000);
    expect(result.bucket).toBe("NEGATIVE");
  });

  it("turns missing or unresolved Funding into CONTROL_DATA_INCOMPLETE", () => {
    expect(mapFundingAtDecision([], 2_000)).toEqual({ observation: null, bucket: null, status: "CONTROL_DATA_INCOMPLETE" });
    expect(mapFundingAtDecision([{ fundingTime: 1_000, fundingRate: Number.NaN }], 2_000).status).toBe("CONTROL_DATA_INCOMPLETE");
  });

  it("freezes the severe pre-treatment TV threshold at 0.20", () => {
    expect(R510A_PRE_TREATMENT_TV_THRESHOLD).toBe(0.20);
    expect(preTreatmentBalancePass(0.20)).toBe(true);
    expect(preTreatmentBalancePass(0.200001)).toBe(false);
    expect(preTreatmentBalancePass(null)).toBe(false);
  });

  it("enforces the pooled and directional minimum sample gate", () => {
    expect(minimumSampleGate(R510A_MINIMUM_SAMPLE)).toBe(true);
    expect(minimumSampleGate({ pooled: 999, bullish: 300, bearish: 300 })).toBe(false);
    expect(minimumSampleGate({ pooled: 1_000, bullish: 299, bearish: 300 })).toBe(false);
  });

  it("enforces pooled and directional matching coverage gates", () => {
    expect(matchingCoverageGate(R510A_MATCHING_COVERAGE_MINIMUM)).toBe(true);
    expect(matchingCoverageGate({ pooled: 69.99, bullish: 60, bearish: 60 })).toBe(false);
    expect(matchingCoverageGate({ pooled: 70, bullish: 59.99, bearish: 60 })).toBe(false);
  });

  it("locks the reserved holdout start and rejects contaminated or discovery windows", () => {
    const end = Date.parse("2026-09-01T00:00:00.000Z");
    expect(() => assertR510AHoldoutRange(R59_RESERVED_HOLDOUT.start, end)).not.toThrow();
    expect(() => assertR510AHoldoutRange(Date.parse("2026-08-09T00:00:00.000Z"), end)).toThrow("HOLDOUT_START_NOT_RESERVED");
    expect(() => rejectHistoricalR510AWindow(Date.parse("2024-08-09T00:00:00.000Z"), Date.parse("2024-08-10T00:00:00.000Z"))).toThrow("CONTAMINATED_WINDOW_FORBIDDEN");
    expect(() => rejectHistoricalR510AWindow(R59_CLEAN_DISCOVERY_WINDOW.start, R59_CLEAN_DISCOVERY_WINDOW.endExclusive)).toThrow("DISCOVERY_WINDOW_FORBIDDEN");
  });

  it("does not lock an outcome window for data or matching failures", () => {
    expect(outcomeWindowIsLocked("HOLDOUT_PROTOCOL_READY")).toBe(true);
    expect(outcomeWindowIsLocked("HOLDOUT_DATA_NOT_READY")).toBe(false);
    expect(outcomeWindowIsLocked("HOLDOUT_MATCHING_NOT_READY")).toBe(false);
  });

  it("accepts only the four protocol classifications", () => {
    for (const value of ["HOLDOUT_PROTOCOL_READY", "HOLDOUT_DATA_NOT_READY", "HOLDOUT_MATCHING_NOT_READY", "HOLDOUT_PROTOCOL_INVALID"]) {
      expect(() => assertAllowedR510AClassification(value)).not.toThrow();
    }
    expect(() => assertAllowedR510AClassification("CONFIRMED_INCREMENTAL_INFORMATION")).toThrow("R510A_CLASSIFICATION_INVALID");
  });
});
