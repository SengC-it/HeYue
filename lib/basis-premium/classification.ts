import { classifyMatchingCoverage } from "./performance";

export type R58CClassification =
  | "ROBUST_INCREMENTAL_INFORMATION"
  | "CONDITIONAL_INFORMATION_ONLY"
  | "NO_INCREMENTAL_INFORMATION"
  | "INSUFFICIENT_MATCHING_EVIDENCE"
  | "RESEARCH_INVALID";

export interface ClassificationCandidate {
  incrementalPositive: boolean;
  confidenceLowerBoundPositive: boolean;
  holmSignificant: boolean;
  matchingCoveragePercent: number;
  covariateBalanceAcceptable: boolean;
  meaningfulSample: boolean;
  stableAcrossQuarters: boolean;
  stableAcrossRegimes: boolean;
  largestSymbolShare: number;
}

export function classifyR58C(input: {
  invalid: boolean;
  positiveCandidates: ClassificationCandidate[];
  hasNominalPositivePoorlyMatched: boolean;
  hasReasonableEvidence: boolean;
}): R58CClassification {
  if (input.invalid) return "RESEARCH_INVALID";
  if (input.positiveCandidates.some((candidate) => candidate.incrementalPositive
    && candidate.confidenceLowerBoundPositive
    && candidate.holmSignificant
    && classifyMatchingCoverage(candidate.matchingCoveragePercent) === "ROBUST_ELIGIBLE"
    && candidate.covariateBalanceAcceptable
    && candidate.meaningfulSample
    && candidate.stableAcrossQuarters
    && candidate.stableAcrossRegimes
    && candidate.largestSymbolShare <= 0.5)) return "ROBUST_INCREMENTAL_INFORMATION";
  if (input.positiveCandidates.some((candidate) => candidate.incrementalPositive
    && classifyMatchingCoverage(candidate.matchingCoveragePercent) === "CONDITIONAL_MAX"
    && candidate.covariateBalanceAcceptable)) return "CONDITIONAL_INFORMATION_ONLY";
  if (input.hasNominalPositivePoorlyMatched) return "INSUFFICIENT_MATCHING_EVIDENCE";
  if (input.hasReasonableEvidence) return "NO_INCREMENTAL_INFORMATION";
  return "INSUFFICIENT_MATCHING_EVIDENCE";
}
