import { describe, expect, it } from "vitest";
import {
  R52_FROZEN_FEATURE_SPEC,
  RollingHistogram,
  classifyFrozenFlowFeatures,
  holmAdjust,
  matchNearestWithoutReplacement,
  pairedMeanInference,
  sha256Json,
} from "../lib/aggressive-flow";

describe("HY-R5.3 frozen aggressive-flow primitives", () => {
  it("keeps the accepted R5.2 feature specification hash unchanged", () => {
    expect(sha256Json(R52_FROZEN_FEATURE_SPEC)).toBe("6fa0896d17e4d377fd1cf835ee15791c4d95665c6447b25198737d78f38e9319");
  });

  it("maintains PIT rolling histogram quantiles across add/remove", () => {
    const histogram = new RollingHistogram(-1, 1, 4_001);
    histogram.add(-0.5);
    histogram.add(0);
    histogram.add(0.5);
    expect(histogram.size()).toBe(3);
    expect(histogram.quantile(0.1)).toBeLessThanOrEqual(0);
    expect(histogram.quantile(0.9)).toBeGreaterThanOrEqual(0);
    expect(histogram.percentileRank(0.5)).toBe(1);
    histogram.remove(-0.5);
    expect(histogram.size()).toBe(2);
    expect(histogram.quantile(0.5)).toBeCloseTo(0, 2);
  });

  it("separates continuation, absorption, and shock event semantics", () => {
    const common = {
      flowP10: -0.4,
      flowP90: 0.4,
      flowPercentile: 0.95,
      accelerationRatio: 2,
      pitMedianAbsPriceReturn: 0.01,
      persistenceSigns: [1, 1, 1],
      persistenceIntervals: 3,
      accelerationMinimum: 1,
    };
    const continuation = classifyFrozenFlowFeatures({ ...common, flowImbalance: 0.8, priceReturn: 0.01 });
    expect(continuation.h1Bullish).toBe(true);
    expect(continuation.h2Bearish).toBe(false);
    expect(continuation.h3FlowShock).toBe(true);

    const absorption = classifyFrozenFlowFeatures({ ...common, flowImbalance: 0.8, priceReturn: 0 });
    expect(absorption.h1Bullish).toBe(false);
    expect(absorption.h2Bearish).toBe(true);
    expect(absorption.h3FlowShock).toBe(true);

    const sellAbsorption = classifyFrozenFlowFeatures({
      ...common,
      flowImbalance: -0.8,
      flowPercentile: 0.05,
      persistenceSigns: [-1, -1, -1],
      priceReturn: 0,
    });
    expect(sellAbsorption.h2Bullish).toBe(true);
  });

  it("matches nearest controls deterministically without replacement", () => {
    const events = [
      { id: "e2", time: 2_000, matchKey: "same" },
      { id: "e1", time: 1_000, matchKey: "same" },
      { id: "e3", time: 3_000, matchKey: "other" },
    ];
    const controls = [
      { id: "c1", time: 900, matchKey: "same" },
      { id: "c2", time: 2_100, matchKey: "same" },
      { id: "c3", time: 3_100, matchKey: "other" },
    ];
    const result = matchNearestWithoutReplacement(events, controls);
    expect(result.unmatched).toHaveLength(0);
    expect(result.pairs.map((pair) => [pair.event.id, pair.control.id])).toEqual([
      ["e1", "c1"],
      ["e2", "c2"],
      ["e3", "c3"],
    ]);
  });

  it("is reproducible and applies Holm step-down correction", () => {
    const differences = [1, 1, 0, -1, 1, 0];
    const first = pairedMeanInference(differences, 5301, 2_000);
    const second = pairedMeanInference(differences, 5301, 2_000);
    expect(first).toEqual(second);
    expect(first.ci95?.lower).toBeLessThanOrEqual(first.observed ?? 0);
    const adjusted = holmAdjust([
      { id: "small", pValue: 0.001 },
      { id: "medium", pValue: 0.02 },
      { id: "null", pValue: 0.8 },
    ]);
    expect(adjusted.small).toBeLessThanOrEqual(adjusted.medium ?? 1);
    expect(adjusted.medium).toBeLessThanOrEqual(adjusted.null ?? 1);
  });
});
