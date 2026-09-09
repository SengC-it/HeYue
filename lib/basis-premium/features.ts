export function perpIndexBasis(perpetualPrice: number, indexPrice: number): number | null {
  if (!Number.isFinite(perpetualPrice) || !Number.isFinite(indexPrice) || indexPrice <= 0) return null;
  return perpetualPrice / indexPrice - 1;
}
export function pearsonCorrelation(pairs: Array<{ left: number; right: number }>): number | null {
  if (pairs.length < 2) return null;
  const leftMean = pairs.reduce((sum, pair) => sum + pair.left, 0) / pairs.length;
  const rightMean = pairs.reduce((sum, pair) => sum + pair.right, 0) / pairs.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (const pair of pairs) {
    const leftDelta = pair.left - leftMean;
    const rightDelta = pair.right - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
  }
  if (leftVariance === 0 || rightVariance === 0) return null;
  return covariance / Math.sqrt(leftVariance * rightVariance);
}

export type ExistingUsageClassification = "ORTHOGONAL" | "PARTIALLY_USED" | "ALREADY_USED";

export function classifyExistingUsage(input: {
  currentUsesMark: boolean;
  currentUsesIndex: boolean;
  currentUsesMarkIndexBasis: boolean;
  currentUsesPremiumIndex: boolean;
  currentUsesPerpIndexBasis: boolean;
}): ExistingUsageClassification {
  if (input.currentUsesPremiumIndex && input.currentUsesPerpIndexBasis) return "ALREADY_USED";
  if (input.currentUsesMark || input.currentUsesIndex || input.currentUsesMarkIndexBasis) return "PARTIALLY_USED";
  return "ORTHOGONAL";
}
