import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  R58C_CONTAMINATED_WINDOW,
  R59_CLEAN_DISCOVERY_WINDOW,
  R59_RESERVED_HOLDOUT,
  assertR59DiscoveryWindow,
} from "../lib/basis-premium/clean-window";
import {
  formalHolmTestIds,
  matchingGate,
} from "../lib/basis-premium/authoritative";
import {
  makeExistingInformationMatchKey,
  matchNearestWithoutReplacement,
} from "../lib/basis-premium/information-gain";
import {
  applyHolmCorrection,
  transitionPerformanceLock,
} from "../lib/basis-premium/performance";
import {
  directionalOutcomeCacheKey,
} from "../lib/basis-premium/outcome";
import { classifyR58C } from "../lib/basis-premium/classification";
import { sha256Json, stableJson } from "../lib/crowding";

type JsonRecord = Record<string, unknown>;

function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as JsonRecord;
}

describe("HY-R5.9B clean authoritative governance", () => {
  it("accepts only the exact clean artifact hashes and frozen dimensions", () => {
    const hashManifest = readJson("data/raw/hy-r5.9-clean-basis-premium/artifacts/clean-artifact-hashes.json");
    const expected = {
      clean_coverage_matrix: "32a53c804f54da8aa71815a9d299d4796f8bf4c593015127e10fbb1b8e6c6e53",
      clean_schema_manifest: "6a756ccad8cc2ae269fcbe9d6d6c9e64ee4f07c6280db519839eeef8e23f3757",
      clean_dataset_manifest: "b64fe7087afa407bb16b9b4d8de80d207ccd1d7e63db0bc38ecae8bdd78389d1",
      clean_aligned_data_manifest: "a9537ecb8f7dcd080cb075883e49202bd1b955b75bf2590b685f00b37c987add",
    } as const;
    const documents = {
      clean_coverage_matrix: "data/raw/hy-r5.9-clean-basis-premium/artifacts/clean-coverage-matrix.json",
      clean_schema_manifest: "data/raw/hy-r5.9-clean-basis-premium/artifacts/clean-schema-manifest.json",
      clean_dataset_manifest: "data/raw/hy-r5.9-clean-basis-premium/artifacts/clean-dataset-manifest.json",
      clean_aligned_data_manifest: "data/raw/hy-r5.9-clean-basis-premium/artifacts/clean-aligned-data-manifest.json",
    } as const;
    for (const name of Object.keys(expected) as Array<keyof typeof expected>) {
      expect(sha256Json(readJson(documents[name]))).toBe(expected[name]);
      expect((hashManifest[name] as JsonRecord).sha256).toBe(expected[name]);
    }
    const dataset = readJson(documents.clean_dataset_manifest);
    const coverage = readJson(documents.clean_coverage_matrix);
    expect(dataset.experiment_id).toBe("HY-R5.9A");
    expect((dataset.eligible_symbols as unknown[]).length).toBe(31);
    expect((coverage.aligned_coverage as JsonRecord).expected).toBe(369_534);
    expect((coverage.aligned_coverage as JsonRecord).valid).toBe(368_422);
  });

  it("rejects every contaminated-window overlap at runtime", () => {
    expect(() => assertR59DiscoveryWindow(
      R58C_CONTAMINATED_WINDOW.start,
      R58C_CONTAMINATED_WINDOW.start + 3_600_000,
    )).toThrow("CONTAMINATED_WINDOW_FORBIDDEN");
    expect(() => assertR59DiscoveryWindow(
      R58C_CONTAMINATED_WINDOW.endExclusive - 3_600_000,
      R58C_CONTAMINATED_WINDOW.endExclusive,
    )).toThrow("CONTAMINATED_WINDOW_FORBIDDEN");
  });

  it("rejects the reserved holdout and accepts the exact clean interval", () => {
    expect(() => assertR59DiscoveryWindow(
      R59_RESERVED_HOLDOUT.start,
      R59_RESERVED_HOLDOUT.start + 3_600_000,
    )).toThrow("RESERVED_HOLDOUT_FORBIDDEN");
    expect(() => assertR59DiscoveryWindow(
      R59_CLEAN_DISCOVERY_WINDOW.start,
      R59_CLEAN_DISCOVERY_WINDOW.endExclusive,
    )).not.toThrow();
  });

  it("keeps bullish and bearish outcomes distinct for the same timestamp", () => {
    const bullish = directionalOutcomeCacheKey({ symbol: "BTCUSDT", timestamp: 123, direction: "BULLISH", horizon: "4h" });
    const bearish = directionalOutcomeCacheKey({ symbol: "BTCUSDT", timestamp: 123, direction: "BEARISH", horizon: "4h" });
    expect(bullish).not.toBe(bearish);
    expect(new Set([bullish, bearish]).size).toBe(2);
  });

  it("freezes Control B as Control A plus funding and existing Mark/Index basis", () => {
    const base = {
      symbol: "ETHUSDT",
      calendarPeriod: "2023-Q1",
      marketRegime: "RANGE",
      volatilityBucket: "NORMAL",
      liquidityBucket: "HIGH",
      fundingBucket: "UNKNOWN",
      markIndexBasisBucket: "POSITIVE",
    };
    const key = makeExistingInformationMatchKey(base);
    expect(key.split("|")).toHaveLength(7);
    expect(makeExistingInformationMatchKey({ ...base, fundingBucket: "EXTREME_POSITIVE" })).not.toBe(key);
    expect(makeExistingInformationMatchKey({ ...base, markIndexBasisBucket: "EXTREME_POSITIVE" })).not.toBe(key);
  });

  it("uses frozen nearest matching without replacement and exact coverage boundaries", () => {
    const result = matchNearestWithoutReplacement(
      [
        { time: 100, matchKey: "same" },
        { time: 200, matchKey: "same" },
      ],
      [{ time: 110, matchKey: "same" }],
    );
    expect(result.pairs).toHaveLength(1);
    expect(result.unmatched).toHaveLength(1);
    expect(result.pairs[0]?.event.time).toBe(100);
    expect(matchingGate(70)).toBe("ROBUST_ELIGIBLE");
    expect(matchingGate(60)).toBe("CONDITIONAL_MAX");
    expect(matchingGate(59.999)).toBe("MATCHING_INADEQUATE_COMPONENT");
  });

  it("keeps a complete 40-cell Holm family including null cells", () => {
    const ids = formalHolmTestIds();
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
    const adjusted = applyHolmCorrection(ids.map((id, index) => ({ id, pValue: index === 0 ? 0.001 : null })));
    expect(Object.keys(adjusted).sort()).toEqual([...ids].sort());
    expect(adjusted[ids[0]!]).not.toBeNull();
    expect(adjusted[ids[1]!]).toBeNull();
  });

  it("triggers the performance lock exactly once after the first outcome", () => {
    expect(transitionPerformanceLock("NOT_TRIGGERED", 0)).toBe("NOT_TRIGGERED");
    expect(transitionPerformanceLock("NOT_TRIGGERED", 1)).toBe("TRIGGERED");
    expect(transitionPerformanceLock("TRIGGERED", 0)).toBe("TRIGGERED");
  });

  it("applies the allowed robust, conditional, inadequate, and negative classifications", () => {
    const common = {
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
    expect(classifyR58C({ invalid: false, positiveCandidates: [common], hasNominalPositivePoorlyMatched: false, hasReasonableEvidence: true }))
      .toBe("ROBUST_INCREMENTAL_INFORMATION");
    expect(classifyR58C({ invalid: false, positiveCandidates: [{ ...common, matchingCoveragePercent: 60 }], hasNominalPositivePoorlyMatched: false, hasReasonableEvidence: true }))
      .toBe("CONDITIONAL_INFORMATION_ONLY");
    expect(classifyR58C({ invalid: false, positiveCandidates: [], hasNominalPositivePoorlyMatched: true, hasReasonableEvidence: false }))
      .toBe("INSUFFICIENT_MATCHING_EVIDENCE");
    expect(classifyR58C({ invalid: false, positiveCandidates: [], hasNominalPositivePoorlyMatched: false, hasReasonableEvidence: true }))
      .toBe("NO_INCREMENTAL_INFORMATION");
  });

  it("keeps the deterministic canonical representation stable", () => {
    const value = { z: [3, 2, 1], a: { second: true, first: "frozen" } };
    expect(stableJson(value)).toBe(stableJson(value));
    expect(sha256Json(value)).toBe(sha256Json({ a: { first: "frozen", second: true }, z: [3, 2, 1] }));
  });

  it("records that the R5.8A semantic freeze has no future-performance result", () => {
    const hypothesis = readJson("reports/hy-r5.8a-basis-premium-hypothesis-freeze.json");
    expect(hypothesis.future_performance_calculated).toBe(false);
    expect(hypothesis.authoritative_performance_count).toBe(0);
    expect((hypothesis.event_semantics as JsonRecord).formation).toBe("FALSE_TO_TRUE_TRANSITION");
  });
});
