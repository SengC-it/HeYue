import { quantileSorted } from "../aggressive-flow";

export const R55_CROWDING_FAMILIES = ["C1", "C2", "C3", "C4"] as const;
export type CrowdingFamily = (typeof R55_CROWDING_FAMILIES)[number];

export const R55_DIRECTIONS = ["BULLISH", "BEARISH"] as const;
export type CrowdingDirection = (typeof R55_DIRECTIONS)[number];

export const R55_HORIZONS = ["1h", "4h", "12h", "24h"] as const;
export type CrowdingHorizon = (typeof R55_HORIZONS)[number];

export const R55_FROZEN_EVALUATION_SPEC = {
  version: "hy-r5.5-v1",
  event_resolution: "one_latest_pit_safe_5m_observation_per_completed_15m_price_slot",
  event_resolution_rule: "map the latest compact row with pit_available_at <= completed 15m candle boundary; no forward fill",
  reference_price: "completed_15m_candle_close",
  decision_timestamp: "completed_15m_candle_close_plus_one_millisecond",
  outcome_population: "require contiguous future 15m candles through 24h; omit incomplete horizons from the formal event population",
  primary_horizons: ["1h", "4h"],
  secondary_horizons: ["12h", "24h"],
  crowding_direction: {
    C1: "BULLISH when any P1/P2/P3 percentile >=95 and none <=5; BEARISH when any <=5 and none >=95; ambiguous sides remain in total events only",
    C2: "BULLISH when top_vs_global_divergence >0; BEARISH when <0; zero is ambiguous",
    C3: "same side as the C1 absolute-crowding event; OI is context and not a new standalone crowding alpha",
    C4: "same side as the immediately prior contiguous selected C1 row; missing/ambiguous prior side is excluded from directional metrics",
    no_reversal_or_post_result_direction_flip: true,
  },
  control_match_fields: [
    "symbol",
    "calendar_month",
    "market_regime",
    "volatility_bucket",
    "liquidity_bucket",
  ],
  control_selection: "nearest timestamp within exact match key, deterministic earlier-time tie break, without replacement",
  control_exclusion: "all crowding event timestamps are excluded from the non-event control pool",
  c3_oi_only_definition: "oi_change > 0, C1 false, no C1-C4 event, C3 feature eligibility true",
  c3_oi_only_selection: "match each C3 directional event to one OI-only point by the same frozen context key without replacement",
  outcome_direction: "directional return is raw return for BULLISH and the negated raw return for BEARISH",
  mfe_mae: "future 15m high/low excursion from the reference close; future candles only",
  fixed_random_seed: 5505,
  bootstrap_replicates: 2000,
  permutation_replicates: 2000,
  confidence_level: 0.95,
  multiple_testing: "Holm step-down across C1-C4 directional precision-lift tests at all four horizons plus C3 OI-only incremental tests",
  robust_gate: {
    minimum_events: 100,
    minimum_positive_primary_horizon_count: 2,
    minimum_stability_groups: 3,
    minimum_positive_group_fraction: 0.6,
    maximum_symbol_concentration: 0.5,
    adjusted_p_value: 0.05,
    confidence_interval_lower_bound: 0,
  },
  conditional_gate: {
    minimum_events: 30,
    adjusted_p_value: 0.2,
  },
  taker_ratio_excluded: true,
  post_result_tuning: false,
} as const;

export function classifyC1Direction(input: {
  topTraderPositionPercentile: number | null;
  topTraderAccountPercentile: number | null;
  globalAccountPercentile: number | null;
}): CrowdingDirection | null {
  const values = [
    input.topTraderPositionPercentile,
    input.topTraderAccountPercentile,
    input.globalAccountPercentile,
  ];
  if (!values.every((value): value is number => value !== null && Number.isFinite(value))) return null;
  const bullish = values.some((value) => value >= 95);
  const bearish = values.some((value) => value <= 5);
  if (bullish === bearish) return null;
  return bullish ? "BULLISH" : "BEARISH";
}

export function classifyC2Direction(divergence: number): CrowdingDirection | null {
  if (!Number.isFinite(divergence) || divergence === 0) return null;
  return divergence > 0 ? "BULLISH" : "BEARISH";
}

export function crowdingMatchKey(input: {
  symbol: string;
  time: number;
  marketRegime: string;
  volatilityBucket: string;
  liquidityBucket: string;
}): string {
  const calendarMonth = new Date(input.time).toISOString().slice(0, 7);
  return [
    input.symbol,
    calendarMonth,
    input.marketRegime,
    input.volatilityBucket,
    input.liquidityBucket,
  ].join("|");
}

export interface BinaryPairedInference {
  n: number;
  observed: number | null;
  ci95: { lower: number; upper: number } | null;
  pValue: number | null;
  effectSize: number | null;
  bootstrapReplicates: number;
  permutationReplicates: number;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function gaussian(random: () => number): number {
  const first = Math.max(Number.MIN_VALUE, random());
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function poisson(lambda: number, random: () => number): number {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let product = 1;
  let count = 0;
  do {
    count += 1;
    product *= Math.max(Number.MIN_VALUE, random());
  } while (product > limit);
  return count - 1;
}

function sampleBinomial(n: number, probability: number, random: () => number): number {
  if (n <= 0 || probability <= 0) return 0;
  if (probability >= 1) return n;
  const p = Math.min(probability, 1 - probability);
  const mean = n * p;
  let sample: number;
  if (n <= 256) {
    sample = 0;
    for (let index = 0; index < n; index += 1) if (random() < p) sample += 1;
  } else if (mean < 32) {
    sample = Math.min(n, poisson(mean, random));
  } else {
    sample = Math.round(mean + Math.sqrt(n * p * (1 - p)) * gaussian(random));
  }
  const bounded = Math.max(0, Math.min(n, sample));
  return probability <= 0.5 ? bounded : n - bounded;
}

function sampleStandardDeviation(values: number[], average: number): number {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1));
}

/**
 * Primary precision inference. Differences are paired binary precision outcomes
 * in {-1, 0, 1}; categorical compression keeps 2,000 bootstrap/permutation
 * replicates tractable without changing the paired statistic.
 */
export function binaryPairedInference(
  differences: number[],
  seed: number,
  bootstrapReplicates = 2_000,
  permutationReplicates = 2_000,
): BinaryPairedInference {
  if (differences.length === 0) {
    return {
      n: 0,
      observed: null,
      ci95: null,
      pValue: null,
      effectSize: null,
      bootstrapReplicates,
      permutationReplicates,
    };
  }
  if (!differences.every((value) => value === -1 || value === 0 || value === 1)) {
    throw new Error("binaryPairedInference requires {-1, 0, 1} differences");
  }
  const positive = differences.filter((value) => value === 1).length;
  const negative = differences.filter((value) => value === -1).length;
  const nonZero = positive + negative;
  const n = differences.length;
  const observed = (positive - negative) / n;
  const standardDeviation = sampleStandardDeviation(differences, observed);
  const random = seededRandom(seed);
  const bootstrap = new Array<number>(bootstrapReplicates);
  const permutation = new Array<number>(permutationReplicates);
  for (let replicate = 0; replicate < bootstrapReplicates; replicate += 1) {
    const drawnPositive = sampleBinomial(n, positive / n, random);
    const remaining = n - drawnPositive;
    const drawnNegative = remaining === 0
      ? 0
      : sampleBinomial(remaining, negative / (negative + (n - positive - negative)), random);
    bootstrap[replicate] = (drawnPositive - drawnNegative) / n;
  }
  for (let replicate = 0; replicate < permutationReplicates; replicate += 1) {
    const positiveSigns = sampleBinomial(nonZero, 0.5, random);
    permutation[replicate] = (2 * positiveSigns - nonZero) / n;
  }
  const absoluteObserved = Math.abs(observed);
  const exceedances = permutation.filter((value) => Math.abs(value) >= absoluteObserved).length;
  bootstrap.sort((left, right) => left - right);
  return {
    n,
    observed,
    ci95: {
      lower: quantileSorted(bootstrap, 0.025) ?? observed,
      upper: quantileSorted(bootstrap, 0.975) ?? observed,
    },
    pValue: (exceedances + 1) / (permutationReplicates + 1),
    effectSize: standardDeviation === 0 ? null : observed / standardDeviation,
    bootstrapReplicates,
    permutationReplicates,
  };
}
