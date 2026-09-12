import { B4_SHADOW_LOWER_PERCENTILE, B4_SHADOW_UPPER_PERCENTILE } from "@/lib/signal-engine/b4-shadow-types";

export interface FrozenB4FeatureInput {
  previousPrice: number;
  currentPrice: number;
  previousPremium: number;
  currentPremium: number;
  priorPriceChanges: readonly number[];
  priorPremiumChanges: readonly number[];
}

export interface FrozenB4FeatureOutput {
  priceChange: number;
  premiumChange: number;
  pricePercentile: number;
  premiumChangePercentile: number;
  direction: "BULLISH" | "BEARISH" | null;
}

/** Research-side implementation of the frozen, outcome-free B4 arithmetic. */
export function computeResearchB4Features(input: FrozenB4FeatureInput): FrozenB4FeatureOutput {
  if (input.previousPrice <= 0 || !Number.isFinite(input.previousPrice)
    || !Number.isFinite(input.currentPrice) || !Number.isFinite(input.previousPremium)
    || !Number.isFinite(input.currentPremium)
    || input.priorPriceChanges.length !== 720 || input.priorPremiumChanges.length !== 720) {
    throw new Error("B4 parity input must contain 720 finite prior observations");
  }
  const priceChange = input.currentPrice / input.previousPrice - 1;
  const premiumChange = input.currentPremium - input.previousPremium;
  const pricePercentile = researchEmpiricalPercentile(priceChange, input.priorPriceChanges);
  const premiumChangePercentile = researchEmpiricalPercentile(premiumChange, input.priorPremiumChanges);
  if (pricePercentile === null || premiumChangePercentile === null) throw new Error("B4 parity percentile unavailable");
  const direction = pricePercentile <= B4_SHADOW_LOWER_PERCENTILE
    && premiumChangePercentile >= B4_SHADOW_UPPER_PERCENTILE
    ? "BULLISH"
    : pricePercentile >= B4_SHADOW_UPPER_PERCENTILE
      && premiumChangePercentile <= B4_SHADOW_LOWER_PERCENTILE
      ? "BEARISH"
      : null;
  return { priceChange, premiumChange, pricePercentile, premiumChangePercentile, direction };
}

function researchEmpiricalPercentile(value: number, priorValues: readonly number[]): number | null {
  if (!Number.isFinite(value) || priorValues.length === 0 || priorValues.some((item) => !Number.isFinite(item))) return null;
  return priorValues.filter((item) => item <= value).length / priorValues.length;
}
