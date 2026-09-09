import { describe, expect, it } from "vitest";

import {
  R58A_R57_FEATURE_SPECIFICATION_HASH,
  buildR58AHypothesisManifest,
  eventFromTransition,
  hypothesisManifestHash,
  isPitEventAvailable,
  mapDivergenceDirection,
  mapRelativePremium,
  mapSignedMeanReversion,
  validateR58AHypothesisManifest,
} from "../lib/basis-premium/hypothesis";

describe("HY-R5.8A basis/premium hypothesis freeze", () => {
  it("maps positive B1 basis to bearish mean reversion", () => {
    expect(mapSignedMeanReversion(0.01)).toBe("BEARISH");
  });

  it("maps negative B1 basis to bullish mean reversion", () => {
    expect(mapSignedMeanReversion(-0.01)).toBe("BULLISH");
  });

  it("maps positive B2 premium extreme to bearish", () => {
    expect(mapSignedMeanReversion(0.02)).toBe("BEARISH");
  });

  it("maps negative B2 premium extreme to bullish", () => {
    expect(mapSignedMeanReversion(-0.02)).toBe("BULLISH");
  });

  it("maps positive B3 premium sign to bearish dislocation reversion", () => {
    expect(mapSignedMeanReversion(0.0001)).toBe("BEARISH");
  });

  it("maps negative B3 premium sign to bullish dislocation reversion", () => {
    expect(mapSignedMeanReversion(-0.0001)).toBe("BULLISH");
  });

  it("maps price-up/premium-down divergence to bearish reversal", () => {
    expect(mapDivergenceDirection("UP", "DOWN")).toBe("BEARISH");
  });

  it("maps price-down/premium-up divergence to bullish reversal", () => {
    expect(mapDivergenceDirection("DOWN", "UP")).toBe("BULLISH");
  });

  it("rejects ambiguous divergence", () => {
    expect(mapDivergenceDirection("UP", "UP")).toBeNull();
    expect(mapDivergenceDirection("AMBIGUOUS", "DOWN")).toBeNull();
  });

  it("maps high and low B5 cross-sectional premium without using funding", () => {
    expect(mapRelativePremium("HIGH")).toBe("BEARISH");
    expect(mapRelativePremium("LOW")).toBe("BULLISH");
  });

  it("does not directionalize zero or ambiguous sign", () => {
    expect(mapSignedMeanReversion(0)).toBeNull();
    expect(mapSignedMeanReversion(Number.NaN)).toBeNull();
    expect(mapRelativePremium("AMBIGUOUS")).toBeNull();
  });

  it("creates an event only on false-to-true transition", () => {
    expect(eventFromTransition(false, true)).toBe(true);
  });

  it("deduplicates repeated true observations", () => {
    expect(eventFromTransition(true, true)).toBe(false);
  });

  it("resets episode eligibility after false", () => {
    expect(eventFromTransition(true, false)).toBe(false);
    expect(eventFromTransition(false, true)).toBe(true);
  });

  it("requires the completed observation to be PIT available", () => {
    expect(isPitEventAvailable(1_000, 3_600_000, 3_601_000)).toBe(true);
    expect(isPitEventAvailable(1_000, 3_600_000, 3_600_999)).toBe(false);
  });

  it("builds and validates the complete frozen manifest", () => {
    const manifest = buildR58AHypothesisManifest();
    expect(manifest.hypotheses).toHaveLength(5);
    expect(manifest.r57_feature_specification_hash).toBe(R58A_R57_FEATURE_SPECIFICATION_HASH);
    expect(manifest.event_semantics.pit_event_timestamp).toContain("open_time + 1h");
    expect(validateR58AHypothesisManifest(manifest)).toEqual([]);
  });

  it("produces a deterministic hypothesis manifest hash", () => {
    const first = buildR58AHypothesisManifest();
    const second = buildR58AHypothesisManifest();
    expect(hypothesisManifestHash(first)).toBe(hypothesisManifestHash(second));
  });
});
