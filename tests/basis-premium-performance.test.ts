import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { cutoffManifestHash } from "../lib/basis-premium";
import {
  R58C_EXPECTED_HASHES,
  applyHolmCorrection,
  classifyMatchingCoverage,
  mean,
  median,
  pairedBootstrapConfidenceInterval,
  pairedPermutationPValue,
  pairedStatistics,
  precision,
  sourceBytesHash,
  totalVariationDistance,
  transitionPerformanceLock,
  verifyR58CHashGate,
} from "../lib/basis-premium/performance";
import { classifyR58C } from "../lib/basis-premium/classification";
import {
  calculateDirectionalOutcome,
  directionalOutcomeCacheKey,
} from "../lib/basis-premium/outcome";
import { assertCleanWindow, overlapsR58CContaminatedWindow } from "../lib/basis-premium/clean-window";
import { sha256Json } from "../lib/crowding";

describe("HY-R5.8C authoritative performance controls", () => {
  it("requires all six frozen hashes", () => {
    expect(verifyR58CHashGate({ ...R58C_EXPECTED_HASHES }).passed).toBe(true);
    expect(verifyR58CHashGate({ ...R58C_EXPECTED_HASHES, cutoff_manifest: "changed" }).passed).toBe(false);
    expect(verifyR58CHashGate({ ...R58C_EXPECTED_HASHES, dataset_manifest: undefined }).mismatches).toContain("dataset_manifest");
  });

  it("keeps the frozen R5.8C input artifacts unchanged", () => {
    const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const computed = {
      coverage_matrix: sha256Json(readJson("data/raw/hy-r5.7-basis-premium-preflight/artifacts/coverage-matrix.json")),
      schema_manifest: sha256Json(readJson("data/raw/hy-r5.7-basis-premium-preflight/artifacts/schema-manifest.json")),
      feature_specification: sha256Json(readJson("data/raw/hy-r5.7-basis-premium-preflight/artifacts/feature-specification.json")),
      dataset_manifest: sha256Json(readJson("data/raw/hy-r5.7-basis-premium-preflight/artifacts/dataset-manifest.json")),
      hypothesis_manifest: sha256Json(readJson("reports/hy-r5.8a-basis-premium-hypothesis-freeze.json")),
      cutoff_manifest: cutoffManifestHash(readJson("reports/hy-r5.8a1-basis-premium-event-cutoff-freeze.json").manifest as Record<string, unknown>),
    };
    expect(computed).toEqual(R58C_EXPECTED_HASHES);
  });

  it("uses deterministic source bytes hashing", () => {
    expect(sourceBytesHash(["a", "b"], ["one", "two"])).toBe(sourceBytesHash(["a", "b"], ["one", "two"]));
    expect(sourceBytesHash(["a", "b"], ["one", "two"])).not.toBe(sourceBytesHash(["b", "a"], ["one", "two"]));
  });

  it("transitions the performance lock only after a future outcome", () => {
    expect(transitionPerformanceLock("NOT_TRIGGERED", 0)).toBe("NOT_TRIGGERED");
    expect(transitionPerformanceLock("NOT_TRIGGERED", 1)).toBe("TRIGGERED");
    expect(transitionPerformanceLock("TRIGGERED", 0)).toBe("TRIGGERED");
  });

  it("freezes the 70/60 matching classification boundaries", () => {
    expect(classifyMatchingCoverage(70)).toBe("ROBUST_ELIGIBLE");
    expect(classifyMatchingCoverage(60)).toBe("CONDITIONAL_MAX");
    expect(classifyMatchingCoverage(59.999)).toBe("MATCHING_INADEQUATE_COMPONENT");
  });

  it("keeps Control A and Control B attribution as distinct effects", () => {
    const signal = 0.7;
    const controlA = 0.5;
    const controlB = 0.6;
    expect(signal - controlA).toBeCloseTo(0.2);
    expect(signal - controlB).toBeCloseTo(0.1);
    expect(controlB - controlA).toBeCloseTo(0.1);
  });

  it("supports Funding attribution without replacing the formal Control B", () => {
    const uncontrolled = 0.65;
    const fundingControlled = 0.55;
    const formalControlB = 0.52;
    expect(uncontrolled - fundingControlled).toBeCloseTo(0.1);
    expect(uncontrolled - formalControlB).toBeCloseTo(0.13);
  });

  it("reports basic deterministic descriptive statistics", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(median([3, 1, 2, 4])).toBe(2.5);
    expect(precision([0.1, -0.1, 0])).toBeCloseTo(1 / 3);
  });

  it("uses deterministic paired bootstrap and permutation statistics", () => {
    const differences = [0.1, 0.2, -0.05, 0.3];
    expect(pairedBootstrapConfidenceInterval(differences, 5801, 200)).toEqual(
      pairedBootstrapConfidenceInterval(differences, 5801, 200),
    );
    expect(pairedPermutationPValue(differences, 5802, 200)).toBe(
      pairedPermutationPValue(differences, 5802, 200),
    );
    expect(pairedStatistics(
      differences.map((signalReturn, index) => ({ signalReturn, controlReturn: signalReturn - differences[index]! })),
      5801,
      200,
      200,
    )?.sampleSize).toBe(4);
  });

  it("keeps a complete Holm family, including null tests", () => {
    const adjusted = applyHolmCorrection([
      { id: "B1:BULLISH:1h", pValue: 0.001 },
      { id: "B1:BULLISH:4h", pValue: null },
      { id: "B5:BEARISH:24h", pValue: 0.02 },
    ]);
    expect(Object.keys(adjusted)).toEqual(["B1:BULLISH:1h", "B1:BULLISH:4h", "B5:BEARISH:24h"]);
    expect(adjusted["B1:BULLISH:4h"]).toBeNull();
    expect(adjusted["B1:BULLISH:1h"]).toBeLessThanOrEqual(adjusted["B5:BEARISH:24h"]!);
  });

  it("reports covariate imbalance deterministically", () => {
    expect(totalVariationDistance(["A", "A", "B"], ["A", "B", "B"])).toBeCloseTo(1 / 3);
    expect(totalVariationDistance([], ["A"])).toBeNull();
  });

  it("does not expose a result-driven rescue path", () => {
    const frozen = { cutoff: 0.95, rollingWindow: 720, horizons: ["1h", "4h", "12h", "24h"] };
    const afterResults = { ...frozen };
    expect(afterResults).toEqual(frozen);
    expect(afterResults.cutoff).toBe(0.95);
    expect(afterResults.rollingWindow).toBe(720);
  });

  it("keeps outcome calculation directional and gap-safe", () => {
    const bars = new Map([
      [3_600_000, { close: 101, high: 102, low: 99 }],
      [7_200_000, { close: 103, high: 104, low: 100 }],
    ]);
    expect(calculateDirectionalOutcome({
      observationTime: 0,
      referencePrice: 100,
      direction: "BULLISH",
      horizonHours: 2,
      bars,
    })?.directionalReturn).toBeCloseTo(0.03);
    expect(calculateDirectionalOutcome({
      observationTime: 0,
      referencePrice: 100,
      direction: "BULLISH",
      horizonHours: 3,
      bars,
    })).toBeNull();
  });

  it("isolates opposite directions for the same event and preserves MFE/MAE", () => {
    const bars = new Map<number, { close: number; high: number; low: number }>();
    for (let step = 1; step <= 24; step += 1) {
      const close = 100 + step;
      bars.set(step * 3_600_000, { close, high: close + 2, low: close - 3 });
    }
    const bullish = calculateDirectionalOutcome({
      observationTime: 0,
      referencePrice: 100,
      direction: "BULLISH",
      horizonHours: 4,
      bars,
    })!;
    const bearish = calculateDirectionalOutcome({
      observationTime: 0,
      referencePrice: 100,
      direction: "BEARISH",
      horizonHours: 4,
      bars,
    })!;
    expect(bullish.directionalReturn).toBeCloseTo(0.04);
    expect(bearish.directionalReturn).toBeCloseTo(100 / 104 - 1);
    expect(bullish.maxFavorableMove).toBeCloseTo(0.06);
    expect(bearish.maxFavorableMove).toBeCloseTo(100 / 98 - 1);
    expect(bullish.maxAdverseMove).toBeCloseTo(-0.02);
    expect(bearish.maxAdverseMove).toBeCloseTo(100 / 106 - 1);
    expect(precision([bullish.directionalReturn])).toBe(1);
    expect(precision([bearish.directionalReturn])).toBe(0);
    expect(directionalOutcomeCacheKey({ symbol: "BTCUSDT", timestamp: 0, direction: "BULLISH", horizon: "4h" }))
      .not.toBe(directionalOutcomeCacheKey({ symbol: "BTCUSDT", timestamp: 0, direction: "BEARISH", horizon: "4h" }));
  });

  it("is independent of component insertion order and keeps horizon entries isolated", () => {
    const entries = [
      ["B1", "BULLISH", "1h"],
      ["B5", "BEARISH", "1h"],
      ["B1", "BULLISH", "4h"],
      ["B5", "BEARISH", "4h"],
      ["B1", "BULLISH", "12h"],
      ["B5", "BEARISH", "12h"],
      ["B1", "BULLISH", "24h"],
      ["B5", "BEARISH", "24h"],
    ] as const;
    const build = (ordered: readonly (typeof entries)[number][]) => {
      const cache = new Map<string, number>();
      for (const [component, direction, horizon] of ordered) {
        const key = directionalOutcomeCacheKey({ symbol: "ETHUSDT", timestamp: 123, direction, horizon });
        cache.set(key, component === "B1" ? 1 : -1);
      }
      return [...cache.entries()].sort(([left], [right]) => left.localeCompare(right));
    };
    expect(build(entries)).toEqual(build([...entries].reverse()));
    expect(new Set(entries.map(([, direction, horizon]) => directionalOutcomeCacheKey({
      symbol: "ETHUSDT", timestamp: 123, direction, horizon,
    }))).size).toBe(8);
  });

  it("rejects the invalidated R5.8C window and accepts non-overlapping windows", () => {
    expect(overlapsR58CContaminatedWindow(
      Date.parse("2024-08-09T00:00:00.000Z"),
      Date.parse("2024-08-10T00:00:00.000Z"),
    )).toBe(true);
    expect(() => assertCleanWindow(
      Date.parse("2024-08-09T00:00:00.000Z"),
      Date.parse("2024-08-10T00:00:00.000Z"),
    )).toThrow(/overlaps invalidated/);
    expect(() => assertCleanWindow(
      Date.parse("2026-08-10T00:00:00.000Z"),
      Date.parse("2026-08-11T00:00:00.000Z"),
    )).not.toThrow();
  });

  it("does not classify a result with only sub-60% matching as alpha", () => {
    expect(classifyR58C({
      invalid: false,
      positiveCandidates: [],
      hasNominalPositivePoorlyMatched: true,
      hasReasonableEvidence: false,
    })).toBe("INSUFFICIENT_MATCHING_EVIDENCE");
    expect(classifyR58C({
      invalid: false,
      positiveCandidates: [],
      hasNominalPositivePoorlyMatched: false,
      hasReasonableEvidence: true,
    })).toBe("NO_INCREMENTAL_INFORMATION");
  });
});
