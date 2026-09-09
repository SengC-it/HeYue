import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  R58A1_B1_B2_B3_LOWER_PERCENTILE,
  R58A1_B1_B2_B3_UPPER_PERCENTILE,
  R58A1_B4_LOWER_PERCENTILE,
  R58A1_B4_UPPER_PERCENTILE,
  R58A1_B5_LOWER_PERCENTILE,
  R58A1_B5_UPPER_PERCENTILE,
  R58A1_ROLLING_MINIMUM_HISTORY,
  averageRankPercentile,
  b1BasisDirection,
  b2PremiumDirection,
  b3SignedExpansionDirection,
  b4DivergenceDirection,
  b5CrossSectionalDirection,
  buildR58A1CutoffManifest,
  cutoffEventFromTransition,
  cutoffManifestHash,
  directionalCutoffEvent,
  hasFrozenRollingHistory,
  isPitEventAvailable,
  pitEventTimestamp,
  rankCrossSectionalPremium,
} from "../lib/basis-premium/cutoff";

describe("HY-R5.8A.1 exact basis/premium event cutoffs", () => {
  it("freezes B1 bearish at positive basis and percentile >=95%", () => {
    expect(b1BasisDirection({ value: 0.001, rollingPercentile: R58A1_B1_B2_B3_UPPER_PERCENTILE, historyAvailable: true })).toBe("BEARISH");
    expect(b1BasisDirection({ value: 0.001, rollingPercentile: 0.949999, historyAvailable: true })).toBeNull();
  });

  it("freezes B1 bullish at negative basis and percentile <=5%", () => {
    expect(b1BasisDirection({ value: -0.001, rollingPercentile: R58A1_B1_B2_B3_LOWER_PERCENTILE, historyAvailable: true })).toBe("BULLISH");
    expect(b1BasisDirection({ value: -0.001, rollingPercentile: 0.050001, historyAvailable: true })).toBeNull();
  });

  it("returns no B1 event for middle, zero, or ambiguous values", () => {
    expect(b1BasisDirection({ value: 0.001, rollingPercentile: 0.5, historyAvailable: true })).toBeNull();
    expect(b1BasisDirection({ value: 0, rollingPercentile: 0.01, historyAvailable: true })).toBeNull();
    expect(b1BasisDirection({ value: null, rollingPercentile: 0.01, historyAvailable: true })).toBeNull();
  });

  it("applies the same exact signed 95/5 cutoff to B2 premium", () => {
    expect(b2PremiumDirection({ value: 0.02, rollingPercentile: 0.95, historyAvailable: true })).toBe("BEARISH");
    expect(b2PremiumDirection({ value: -0.02, rollingPercentile: 0.05, historyAvailable: true })).toBe("BULLISH");
    expect(b2PremiumDirection({ value: 0.02, rollingPercentile: 0.94, historyAvailable: true })).toBeNull();
  });

  it("applies the exact signed 95/5 cutoff to the frozen B3 primitive", () => {
    expect(b3SignedExpansionDirection({ value: 0.0002, rollingPercentile: 0.95, historyAvailable: true })).toBe("BEARISH");
    expect(b3SignedExpansionDirection({ value: -0.0002, rollingPercentile: 0.05, historyAvailable: true })).toBe("BULLISH");
  });

  it("freezes B4 bearish divergence at price >=75% and premium <=25%", () => {
    expect(b4DivergenceDirection({ priceChangePercentile: R58A1_B4_UPPER_PERCENTILE, premiumChangePercentile: R58A1_B4_LOWER_PERCENTILE, historyAvailable: true })).toBe("BEARISH");
    expect(b4DivergenceDirection({ priceChangePercentile: 0.749999, premiumChangePercentile: 0.25, historyAvailable: true })).toBeNull();
  });

  it("freezes B4 bullish divergence at price <=25% and premium >=75%", () => {
    expect(b4DivergenceDirection({ priceChangePercentile: R58A1_B4_LOWER_PERCENTILE, premiumChangePercentile: R58A1_B4_UPPER_PERCENTILE, historyAvailable: true })).toBe("BULLISH");
    expect(b4DivergenceDirection({ priceChangePercentile: 0.25, premiumChangePercentile: 0.749999, historyAvailable: true })).toBeNull();
  });

  it("rejects non-divergent B4 combinations and missing primitives", () => {
    expect(b4DivergenceDirection({ priceChangePercentile: 0.9, premiumChangePercentile: 0.9, historyAvailable: true })).toBeNull();
    expect(b4DivergenceDirection({ priceChangePercentile: null, premiumChangePercentile: 0.1, historyAvailable: true })).toBeNull();
  });

  it("freezes B5 at bottom/top ten percent of the active complete PIT population", () => {
    expect(b5CrossSectionalDirection(R58A1_B5_LOWER_PERCENTILE, 10)).toBe("BULLISH");
    expect(b5CrossSectionalDirection(R58A1_B5_UPPER_PERCENTILE, 10)).toBe("BEARISH");
    expect(b5CrossSectionalDirection(0.5, 10)).toBeNull();
    expect(b5CrossSectionalDirection(0.1, 1)).toBeNull();
  });

  it("uses deterministic average ranks for equal B5 premium values", () => {
    const first = rankCrossSectionalPremium([
      { id: "B", value: 1 },
      { id: "A", value: 1 },
      { id: "C", value: 2 },
      { id: "D", value: 3 },
    ]);
    const second = rankCrossSectionalPremium([
      { id: "D", value: 3 },
      { id: "C", value: 2 },
      { id: "A", value: 1 },
      { id: "B", value: 1 },
    ]);
    expect(first).toEqual(second);
    expect(first.filter((value) => value.id === "A" || value.id === "B").map((value) => value.rank)).toEqual([1.5, 1.5]);
    expect(averageRankPercentile(1.5, 4)).toBe(1 / 6);
    expect(rankCrossSectionalPremium([{ id: "A", value: 1 }, { id: "MISSING", value: null }])).toEqual([
      { id: "A", value: 1, rank: 1, percentile: null },
    ]);
  });

  it("returns NO_EVENT when frozen rolling history is insufficient", () => {
    expect(hasFrozenRollingHistory(R58A1_ROLLING_MINIMUM_HISTORY - 1)).toBe(false);
    expect(hasFrozenRollingHistory(R58A1_ROLLING_MINIMUM_HISTORY)).toBe(true);
    expect(b1BasisDirection({ value: 0.01, rollingPercentile: 0.99, historyAvailable: false })).toBeNull();
    expect(b4DivergenceDirection({ priceChangePercentile: 0.99, premiumChangePercentile: 0.01, historyAvailable: false })).toBeNull();
  });

  it("forms events only on FALSE to TRUE and deduplicates TRUE to TRUE", () => {
    expect(cutoffEventFromTransition(false, true)).toBe(true);
    expect(cutoffEventFromTransition(true, true)).toBe(false);
    expect(cutoffEventFromTransition(true, false)).toBe(false);
    expect(cutoffEventFromTransition(false, false)).toBe(false);
  });

  it("maintains directional state independently while allowing one current direction", () => {
    expect(directionalCutoffEvent(null, "BULLISH", "BULLISH")).toBe(true);
    expect(directionalCutoffEvent("BULLISH", "BULLISH", "BULLISH")).toBe(false);
    expect(directionalCutoffEvent("BEARISH", "BULLISH", "BULLISH")).toBe(true);
    expect(b4DivergenceDirection({ priceChangePercentile: 0.1, premiumChangePercentile: 0.9, historyAvailable: true })).toBe("BULLISH");
  });

  it("publishes an event only at the completed observation availability time", () => {
    expect(pitEventTimestamp(0, 3_600_000)).toBe(3_600_000);
    expect(isPitEventAvailable(0, 3_600_000, 3_599_999)).toBe(false);
    expect(isPitEventAvailable(0, 3_600_000, 3_600_000)).toBe(true);
    expect(pitEventTimestamp(0, 0)).toBeNull();
  });

  it("freezes the exact cutoff manifest and its canonical hash deterministically", () => {
    const first = buildR58A1CutoffManifest();
    const second = buildR58A1CutoffManifest();
    expect(cutoffManifestHash(first)).toBe(cutoffManifestHash(second));
    const cutoffs = first.cutoffs as Record<string, Record<string, unknown>>;
    expect((cutoffs.B1?.bearish as Record<string, unknown>).rolling_percentile).toBe(">= 0.95");
    expect((cutoffs.B4?.bullish as Record<string, unknown>).price_change_percentile).toBe("<= 0.25");
    expect((cutoffs.B5?.bearish as Record<string, unknown>).cross_sectional_percentile).toBe(">= 0.90");
    expect((first.b5_tie_method as Record<string, unknown>).method).toBe("average_rank");
    expect((first.event_formation as Record<string, unknown>).rule).toBe("FALSE_TO_TRUE_TRANSITION");
  });

  it("contains no future-outcome API calls in the cutoff module or runner", () => {
    const source = [
      readFileSync(resolve("lib", "basis-premium", "cutoff.ts"), "utf8"),
      readFileSync(resolve("scripts", "run-hy-r5-8a1-basis-premium-event-cutoff-freeze.ts"), "utf8"),
    ].join("\n");
    for (const api of ["futureReturn", "forwardReturn", "futureDirection", "precision", "MFE", "MAE", "futureVolatility", "matchedControl", "PnL", "ProfitFactor", "Sharpe"]) {
      expect(source).not.toMatch(new RegExp(`\\b${api}\\s*\\(`));
    }
  });
});
