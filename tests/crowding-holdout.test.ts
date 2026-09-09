import { describe, expect, it } from "vitest";

import {
  classifyHoldout,
  crowdingStrength,
  crowdingStrengthBucket,
  distributionTotalVariation,
  weekKey,
} from "../lib/crowding/holdout";
import { classifyC1Direction } from "../lib/crowding";
import { matchNearestWithoutReplacement } from "../lib/aggressive-flow";

describe("HY-R5.6 independent holdout gates", () => {
  it("keeps the frozen C1 bullish/bearish/ambiguous rule", () => {
    expect(classifyC1Direction({ topTraderPositionPercentile: 96, topTraderAccountPercentile: 60, globalAccountPercentile: 70 })).toBe("BULLISH");
    expect(classifyC1Direction({ topTraderPositionPercentile: 4, topTraderAccountPercentile: 40, globalAccountPercentile: 30 })).toBe("BEARISH");
    expect(classifyC1Direction({ topTraderPositionPercentile: 96, topTraderAccountPercentile: 40, globalAccountPercentile: 4 })).toBeNull();
  });

  it("uses deterministic UTC weeks and frozen crowding-strength buckets", () => {
    expect(weekKey(Date.parse("2026-08-10T00:00:00.000Z"))).toBe("2026-08-10");
    expect(weekKey(Date.parse("2026-08-16T23:59:00.000Z"))).toBe("2026-08-10");
    expect(crowdingStrength([96, 60, 70])).toBe(46);
    expect(crowdingStrengthBucket(46)).toBe("40-50");
    expect(crowdingStrength([96, null, 70])).toBeNull();
  });

  it("measures categorical imbalance symmetrically", () => {
    expect(distributionTotalVariation(["A", "A", "B"], ["A", "B", "B"])).toBeCloseTo(1 / 3);
    expect(distributionTotalVariation([], ["A"])).toBeNull();
  });

  it("classifies a positive, well-covered, non-concentrated confirmation", () => {
    expect(classifyHoldout({
      eligibleEvents: 100,
      matchedEvents: 90,
      matchingCoveragePercent: 90,
      incrementalLift: 0.02,
      ciLower: 0.01,
      ciUpper: 0.03,
      largestSymbolPercent: 20,
      largestWeekPercent: 30,
      stableAcrossRegimes: "YES",
      pitSafe: true,
      postResultTuning: false,
    })).toBe("CONFIRMED_INCREMENTAL_INFORMATION");
  });

  it("stops confirmation when the matching coverage gate fails", () => {
    expect(classifyHoldout({
      eligibleEvents: 100,
      matchedEvents: 50,
      matchingCoveragePercent: 50,
      incrementalLift: 0.02,
      ciLower: 0.01,
      ciUpper: 0.03,
      largestSymbolPercent: 20,
      largestWeekPercent: 30,
      stableAcrossRegimes: "YES",
      pitSafe: true,
      postResultTuning: false,
    })).toBe("MATCHING_INADEQUATE");
  });

  it("preserves exact nearest-without-replacement matching semantics", () => {
    const result = matchNearestWithoutReplacement(
      [{ time: 100, matchKey: "same" }, { time: 200, matchKey: "same" }],
      [{ time: 90, matchKey: "same" }, { time: 250, matchKey: "same" }],
    );
    expect(result.pairs.map((pair) => [pair.event.time, pair.control.time])).toEqual([[100, 90], [200, 250]]);
    expect(result.unmatched).toHaveLength(0);
  });
});
