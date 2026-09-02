import type { HistoricalDataset } from "./types";
import { volumeSourceForDatasets, type HistoricalVolumeSource } from "./volume";

export type ValidationUniversePolicy =
  | "FIXED_COHORT"
  | "FIXED_COHORT_DYNAMIC_TOP10"
  | "BOUNDED_COHORT_DYNAMIC_TOP10"
  | "FULL_UNIVERSE_DYNAMIC_TOP10";

export type ProductionParityLevel = "BOUNDED_COHORT" | "APPROXIMATE_PRODUCTION_PARITY" | "FULL";

export interface ValidationUniverseMetadata {
  universePolicy: ValidationUniversePolicy;
  candidatePoolSize: number;
  dynamicUniverseSize: number | null;
  lookbackHours: number | null;
  volumeSource: HistoricalVolumeSource;
  symbolCohort: string;
  survivorshipBiasLimitation: string;
  productionParityLevel: ProductionParityLevel;
}

export interface ValidationUniverseMetadataInput {
  requestedSymbols: string[];
  candidatePoolSize: number;
  dynamicUniverseSize?: number;
  lookbackHours?: number;
  datasets: HistoricalDataset[];
  historicalUniverseComplete?: boolean;
}

export function buildValidationUniverseMetadata(
  input: ValidationUniverseMetadataInput,
): ValidationUniverseMetadata {
  const isDynamic = input.dynamicUniverseSize !== undefined;
  const isFixedCohort = input.requestedSymbols.length > 0;
  const isFullHistoricalUniverse = input.historicalUniverseComplete === true;
  const universePolicy = isDynamic
    ? isFullHistoricalUniverse
      ? "FULL_UNIVERSE_DYNAMIC_TOP10"
      : isFixedCohort
        ? "FIXED_COHORT_DYNAMIC_TOP10"
        : "BOUNDED_COHORT_DYNAMIC_TOP10"
    : "FIXED_COHORT";
  const productionParityLevel = isFullHistoricalUniverse
    ? "FULL"
    : isFixedCohort
      ? "BOUNDED_COHORT"
      : "APPROXIMATE_PRODUCTION_PARITY";

  return {
    universePolicy,
    candidatePoolSize: input.candidatePoolSize,
    dynamicUniverseSize: input.dynamicUniverseSize ?? null,
    lookbackHours: input.lookbackHours ?? null,
    volumeSource: volumeSourceForDatasets(input.datasets.map((dataset) => dataset.candles["15m"])),
    symbolCohort: isFullHistoricalUniverse
      ? "historical Binance USDT-M perpetual universe"
      : isFixedCohort
        ? "explicit fixed validation symbol cohort"
        : "bounded cohort selected from currently trading Binance USDT-M perpetuals",
    survivorshipBiasLimitation: "This cohort is not a complete historical Binance universe: it may exclude delisted contracts, new listings, historical exchange-universe changes, and symbols whose local cache is unavailable. Results therefore retain survivorship and availability bias.",
    productionParityLevel,
  };
}
