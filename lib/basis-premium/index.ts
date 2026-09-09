export {
  BASIS_PREMIUM_FAMILIES,
  BASIS_PREMIUM_RESOLUTIONS,
  BINANCE_KLINE_COLUMNS,
} from "./types";
export type {
  BasisPremiumFamily,
  BasisPremiumKline,
  BasisPremiumResolution,
  CoverageSummary,
  KlineParseResult,
  LifecycleSpan,
} from "./types";
export { parseBinanceKlineCsv, resolutionMilliseconds } from "./parser";
export { coverageForTimestamps, expectedTimestamps, isTimestampInLifecycle } from "./coverage";
export {
  alignFamilyTimestamps,
  extractZipCsv,
  isCompletePitBar,
  OFFICIAL_BINANCE_KLINE_COLUMNS,
  validateKlineSchema,
} from "./clean-foundation";
export type { FamilyAlignment, KlineSchemaValidation } from "./clean-foundation";
export { classifyExistingUsage, pearsonCorrelation, perpIndexBasis } from "./features";
export type { ExistingUsageClassification } from "./features";
export {
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
  signedExtremeDirection,
} from "./cutoff";
export type { CrossSectionalRank, CrossSectionalValue, CutoffDirection, DivergenceInput, SignedExtremeInput } from "./cutoff";
export {
  R510A_CANDIDATE,
  R510A_EXPERIMENT_ID,
  R510A_INTERVAL_MS,
  R510A_MATCH_FIELDS,
  R510A_MINIMUM_SAMPLE,
  R510A_MATCHING_COVERAGE_MINIMUM,
  R510A_PRIMARY_HYPOTHESIS,
  R510A_PRIMARY_METRIC,
  R510A_PRE_TREATMENT_TV_THRESHOLD,
  R510A_ROLLING_HISTORY,
  R510A_SECONDARY_HYPOTHESES,
  assertAllowedR510AClassification,
  assertB4Only,
  assertR510AHoldoutRange,
  bucketFundingR510A,
  existingInformationMatchKey,
  featureStrengthAuditIsNotBalanceGate,
  featureStrengthIsExcludedFromMatching,
  mapFundingAtDecision,
  matchingCoverageGate,
  minimumSampleGate,
  outcomeWindowIsLocked,
  pooledMatchingCoveragePercent,
  preTreatmentBalancePass,
  protocolManifestHash,
  rejectHistoricalR510AWindow,
} from "./r5-10a-holdout";
export type {
  R510AClassification,
  R510ACoverageGateInput,
  R510AFundingBucket,
  R510AFundingMapping,
  R510AFundingObservation,
  R510ASampleGateInput,
} from "./r5-10a-holdout";
export {
  R510B_BOOTSTRAP_REPLICATES,
  R510B_EXPERIMENT_ID,
  R510B_HOLDOUT_END_EXCLUSIVE,
  R510B_HOLDOUT_START,
  R510B_PERMUTATION_REPLICATES,
  R510B_PRIMARY_HYPOTHESIS,
  R510B_PRIMARY_HORIZON,
  R510B_RANDOM_SEED,
  allowedR510BClassification,
  classifyPrimaryDecision,
  concentrationPass,
  directionalPrecision,
  exactHoldoutWindow,
  outcomeIdentityIncludesDirection,
  precisionLift,
  rejectSeptemberExtension,
  updatePerformanceLock,
  verifyExactHashes,
} from "./r5-10b-confirmation";
export type {
  R510BClassification,
  R510BHashGate,
  R510BPrecisionSample,
  R510BPrimaryDecisionInput,
} from "./r5-10b-confirmation";
