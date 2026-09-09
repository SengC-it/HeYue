import { describe, expect, it } from "vitest";

import {
  R55_CROWDING_FAMILIES,
  R55_FROZEN_EVALUATION_SPEC,
  binaryPairedInference,
  classifyC1Direction,
  classifyC2Direction,
  crowdingMatchKey,
} from "../lib/crowding";

describe("HY-R5.5 frozen crowding information-gain contracts", () => {
  it("keeps the C1-C4 family and direction rules frozen", () => {
    expect(R55_CROWDING_FAMILIES).toEqual(["C1", "C2", "C3", "C4"]);
    expect(classifyC1Direction({
      topTraderPositionPercentile: 99,
      topTraderAccountPercentile: 70,
      globalAccountPercentile: 60,
    })).toBe("BULLISH");
    expect(classifyC1Direction({
      topTraderPositionPercentile: 1,
      topTraderAccountPercentile: 30,
      globalAccountPercentile: 40,
    })).toBe("BEARISH");
    expect(classifyC1Direction({
      topTraderPositionPercentile: 99,
      topTraderAccountPercentile: 1,
      globalAccountPercentile: 50,
    })).toBeNull();
    expect(classifyC2Direction(0.2)).toBe("BULLISH");
    expect(classifyC2Direction(-0.2)).toBe("BEARISH");
    expect(classifyC2Direction(0)).toBeNull();
    expect(R55_FROZEN_EVALUATION_SPEC.taker_ratio_excluded).toBe(true);
    expect(R55_FROZEN_EVALUATION_SPEC.post_result_tuning).toBe(false);
  });

  it("builds the exact symbol-month-regime-context match key", () => {
    expect(crowdingMatchKey({
      symbol: "BTCUSDT",
      time: Date.parse("2025-03-08T12:00:00.000Z"),
      marketRegime: "UP",
      volatilityBucket: "MEDIUM",
      liquidityBucket: "HIGH",
    })).toBe("BTCUSDT|2025-03|UP|MEDIUM|HIGH");
  });

  it("runs deterministic paired bootstrap and permutation inference", () => {
    const differences = [1, 1, 1, 0, 0, -1, 0, 1, -1, 0];
    const first = binaryPairedInference(differences, 5505, 2_000, 2_000);
    const second = binaryPairedInference(differences, 5505, 2_000, 2_000);
    expect(first).toEqual(second);
    expect(first.n).toBe(10);
    expect(first.observed).toBeCloseTo(0.2);
    expect(first.bootstrapReplicates).toBe(2_000);
    expect(first.permutationReplicates).toBe(2_000);
    expect(first.ci95).not.toBeNull();
  });
});
