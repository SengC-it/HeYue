import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  alignFamilyTimestamps,
  extractZipCsv,
  isCompletePitBar,
  validateKlineSchema,
} from "../lib/basis-premium/clean-foundation";
import {
  assertR59DiscoveryWindow,
  R58C_CONTAMINATED_WINDOW,
  R59_CLEAN_DISCOVERY_WINDOW,
  R59_RESERVED_HOLDOUT,
} from "../lib/basis-premium/clean-window";
import { expectedTimestamps } from "../lib/basis-premium";
import { lifecycleIntervalsForSymbol, sha256Json } from "../lib/crowding";

describe("HY-R5.9A clean foundation guards and validation", () => {
  it("accepts the exact clean-window boundaries and rejects forbidden windows", () => {
    expect(() => assertR59DiscoveryWindow(
      R59_CLEAN_DISCOVERY_WINDOW.start,
      R59_CLEAN_DISCOVERY_WINDOW.endExclusive,
    )).not.toThrow();
    expect(() => assertR59DiscoveryWindow(
      R59_CLEAN_DISCOVERY_WINDOW.start,
      R58C_CONTAMINATED_WINDOW.start,
    )).not.toThrow();
    expect(() => assertR59DiscoveryWindow(
      R58C_CONTAMINATED_WINDOW.start,
      R58C_CONTAMINATED_WINDOW.start + 3_600_000,
    )).toThrow("CONTAMINATED_WINDOW_FORBIDDEN");
    expect(() => assertR59DiscoveryWindow(
      R59_RESERVED_HOLDOUT.start,
      R59_RESERVED_HOLDOUT.start + 3_600_000,
    )).toThrow("RESERVED_HOLDOUT_FORBIDDEN");
  });

  it("derives the listing-aware clean universe instead of forcing all listed symbols", () => {
    const listingEvidence = JSON.parse(readFileSync("data/raw/hy-r5.2b-flow/listing-evidence.json", "utf8")) as {
      symbols: Array<{ symbol: string; onboardDate: number; deliveryDate: number }>;
    };
    const eligible = listingEvidence.symbols.filter((listing) => expectedTimestamps(
      lifecycleIntervalsForSymbol(listing, "listing-evidence.json"),
      R59_CLEAN_DISCOVERY_WINDOW.start,
      R59_CLEAN_DISCOVERY_WINDOW.endExclusive,
      "1h",
    ).length > 0);
    const pump = listingEvidence.symbols.find((listing) => listing.symbol === "PUMPUSDT")!;
    expect(listingEvidence.symbols).toHaveLength(49);
    expect(eligible).toHaveLength(31);
    expect(expectedTimestamps(
      lifecycleIntervalsForSymbol(pump, "listing-evidence.json"),
      R59_CLEAN_DISCOVERY_WINDOW.start,
      R59_CLEAN_DISCOVERY_WINDOW.endExclusive,
      "1h",
    )).toHaveLength(0);
  });

  it("requires all four families at the same timestamp", () => {
    const expected = [1, 2, 3];
    const complete = [new Set(expected), new Set(expected), new Set(expected), new Set(expected)];
    expect(alignFamilyTimestamps(expected, complete)).toMatchObject({ expected: 3, valid: 3, incomplete: 0 });
    const missingMark = [new Set(expected), new Set(expected), new Set([1, 3]), new Set(expected)];
    expect(alignFamilyTimestamps(expected, missingMark)).toMatchObject({ expected: 3, valid: 2, incomplete: 1 });
  });

  it("marks a missing family as DATA_INCOMPLETE rather than filling it", () => {
    const result = alignFamilyTimestamps([3_600_000], [new Set([3_600_000]), new Set<number>(), new Set([3_600_000]), new Set([3_600_000])]);
    expect(result.incomplete).toBe(1);
    expect(result.validTimestamps).toEqual([]);
  });

  it("rejects corrupt ZIP bytes and schema drift", () => {
    expect(() => extractZipCsv(Buffer.from("not a zip"))).toThrow("ZIP_END_OF_CENTRAL_DIRECTORY_NOT_FOUND");
    expect(validateKlineSchema([
      "open_time", "open", "high", "low", "close", "volume", "close_time",
      "quote_volume", "count", "taker_buy_volume", "taker_buy_quote_volume", "unexpected",
    ], [12]).passed).toBe(false);
    expect(validateKlineSchema(null, [12]).passed).toBe(true);
    expect(validateKlineSchema(null, [13]).conflicts).toContain("UNEXPECTED_COLUMN_COUNT:13");
  });

  it("keeps the 1h bar-close PIT boundary explicit", () => {
    expect(isCompletePitBar(0, 3_599_998, 3_600_000)).toBe(false);
    expect(isCompletePitBar(0, 3_599_999, 3_600_000)).toBe(true);
    expect(3_600_000).toBe(0 + 3_600_000);
  });

  it("keeps frozen inputs and the remediated source unchanged", () => {
    const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const expected = {
      feature: "bbdaab9e4cba4c22e50471d538d808fca992e812aaff60a0fc3f70af6020cf51",
      hypothesis: "0b5a790a1783704fc5eb130c4d1fa65c865339e68232fa1b54af9012c58db0f3",
      cutoff: "95fe1b5a20b0d4804e52dbc01c2f0e730a8f6b377e0c29ae2877875d8f06e800",
      source: "ae88361b55b519975b8a297ca8f85ef4e5177eb8e1ac78eaaa1ed7cccca7fd77",
      outcome: "8a4e81ca26c050c337012b233fa2d7017c7ecc1dfa46dabdfe9b3a142e937465",
    };
    expect(sha256Json(readJson("data/raw/hy-r5.7-basis-premium-preflight/artifacts/feature-specification.json"))).toBe(expected.feature);
    expect(sha256Json(readJson("reports/hy-r5.8a-basis-premium-hypothesis-freeze.json"))).toBe(expected.hypothesis);
    const cutoff = readJson("reports/hy-r5.8a1-basis-premium-event-cutoff-freeze.json").manifest as Record<string, unknown>;
    expect(sha256Json(cutoff)).toBe(expected.cutoff);
    const sourceHash = createHash("sha256");
    for (const path of [
      "scripts/run-hy-r5-8c-basis-premium-information-gain.ts",
      "scripts/run-hy-r5-8d-outcome-direction-remediation.ts",
    ]) {
      sourceHash.update(path, "utf8");
      sourceHash.update("\0", "utf8");
      sourceHash.update(readFileSync(path, "utf8"), "utf8");
      sourceHash.update("\0", "utf8");
    }
    expect(sourceHash.digest("hex")).toBe(expected.source);
    expect(createHash("sha256").update(readFileSync("lib/basis-premium/outcome.ts")).digest("hex")).toBe(expected.outcome);
  });

  it("hashes a clean manifest deterministically", () => {
    const first = { version: "v1", symbols: ["BTCUSDT", "ETHUSDT"], coverage: { expected: 2, valid: 2 } };
    const second = { coverage: { valid: 2, expected: 2 }, symbols: ["BTCUSDT", "ETHUSDT"], version: "v1" };
    expect(sha256Json(first)).toBe(sha256Json(second));
  });
});
