import { describe, expect, it } from "vitest";

import {
  classifyExistingUsage,
  coverageForTimestamps,
  expectedTimestamps,
  parseBinanceKlineCsv,
  pearsonCorrelation,
  perpIndexBasis,
} from "../lib/basis-premium";

describe("HY-R5.7 basis/premium preflight contracts", () => {
  it("keeps premium, index, mark, and perpetual price semantics distinct", () => {
    const csv = [
      "1723161600000,0.001,0.002,-0.001,0.0015,0,1723165199999,0,0,0,0,0",
      "1723165200000,0.0015,0.0025,-0.0005,0.002,0,1723168799999,0,0,0,0,0",
    ].join("\n");
    expect(parseBinanceKlineCsv(csv, { family: "PREMIUM_INDEX", resolution: "1h" }).rows).toHaveLength(2);
    expect(parseBinanceKlineCsv(csv, { family: "INDEX_PRICE", resolution: "1h" }).rows).toHaveLength(0);
  });

  it("rejects non-positive index, mark, and perpetual prices", () => {
    const csv = "1723161600000,0,1,0,1,0,1723165199999,0,0,0,0,0";
    expect(parseBinanceKlineCsv(csv, { family: "INDEX_PRICE", resolution: "1h" }).invalidRowCount).toBe(1);
    expect(parseBinanceKlineCsv(csv, { family: "MARK_PRICE", resolution: "1h" }).invalidRowCount).toBe(1);
    expect(parseBinanceKlineCsv(csv, { family: "PERPETUAL_PRICE", resolution: "1h" }).invalidRowCount).toBe(1);
  });

  it("excludes partial bars and detects timestamp boundary problems", () => {
    const csv = [
      "1723161600000,100,101,99,100,1,1723165199999,1,1,0,0,0",
      "1723165200000,100,101,99,100,1,1723167000000,1,1,0,0,0",
    ].join("\n");
    const result = parseBinanceKlineCsv(csv, { family: "PERPETUAL_PRICE", resolution: "1h" });
    expect(result.rows).toHaveLength(1);
    expect(result.boundaryViolationCount).toBe(1);
  });

  it("uses listing-aware intervals and isolates relaunch gaps", () => {
    const spans = [
      { id: "old", kind: "ACTIVE", startTime: 0, endTimeExclusive: 3 * 3_600_000 },
      { id: "new", kind: "RELAUNCHED", startTime: 6 * 3_600_000, endTimeExclusive: 9 * 3_600_000 },
    ];
    expect(expectedTimestamps(spans, 0, 9 * 3_600_000, "1h")).toHaveLength(6);
    expect(coverageForTimestamps([0, 3_600_000, 6 * 3_600_000], spans, 0, 9 * 3_600_000, "1h")).toMatchObject({
      expected: 6,
      valid: 3,
      missing: 3,
    });
  });

  it("computes the B1 perpetual/index basis without invalid denominators", () => {
    expect(perpIndexBasis(101, 100)).toBeCloseTo(0.01);
    expect(perpIndexBasis(101, 0)).toBeNull();
  });

  it("keeps contemporaneous funding overlap descriptive only", () => {
    expect(pearsonCorrelation([
      { left: -0.01, right: -0.02 },
      { left: 0.01, right: 0.02 },
      { left: 0.02, right: 0.01 },
    ])).toBeGreaterThan(0);
    expect(classifyExistingUsage({
      currentUsesMark: true,
      currentUsesIndex: true,
      currentUsesMarkIndexBasis: true,
      currentUsesPremiumIndex: false,
      currentUsesPerpIndexBasis: false,
    })).toBe("PARTIALLY_USED");
  });
});
