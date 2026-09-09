export const FLOW_HORIZONS = ["1h", "4h", "12h", "24h"] as const;
export type FlowHorizon = (typeof FLOW_HORIZONS)[number];

export const R52_FROZEN_FEATURE_SPEC = {
  version: "hy-r5.2-v1",
  features: [
    "F1 INTRABAR_FLOW_IMBALANCE",
    "F2 FLOW_ACCELERATION",
    "F3 FLOW_PERSISTENCE",
    "F4 PRICE_FLOW_RESPONSE",
    "F5 ABSORPTION",
  ],
  aggregation_window_minutes: 15,
  baseline_window_days: 7,
  persistence_intervals: 3,
  extreme_buy_percentile: 90,
  extreme_sell_percentile: 10,
  minimum_completeness_percent: 100,
  event_formation_semantics: "Decision timestamps use only 1m bars with closeTime <= t; no open/current bar.",
} as const;

export const R53_FROZEN_EVALUATION_SPEC = {
  version: "hy-r5.3-v1",
  aggregation_window_minutes: 15,
  baseline_window_buckets: 672,
  persistence_intervals: 3,
  acceleration_ratio_minimum: 1,
  weak_response_multiplier_of_pit_median_abs_return: 0.5,
  primary_horizons: ["1h", "4h"],
  secondary_horizons: ["12h", "24h"],
  event_outcome_completeness: "formal event population ends 24h before the frozen data end so all horizons are observable",
  control_match_fields: ["symbol", "calendar_month", "market_regime", "volatility_bucket", "liquidity_bucket"],
  control_selection: "nearest timestamp within exact match key, deterministic earlier-time tie break, without replacement",
  control_exclusion_of_event_times: true,
  bootstrap_replicates: 2000,
  permutation_replicates: 2000,
  random_seed: 5301,
  confidence_level: 0.95,
  multiple_testing: "Holm step-down across all predeclared H1/H2 directional precision and H3 risk tests",
  regime_up_24h_return_minimum: 0.01,
  regime_up_7d_return_minimum: 0.02,
  regime_down_24h_return_maximum: -0.01,
  regime_down_7d_return_maximum: -0.02,
  volatility_low_maximum_24h_realized: 0.02,
  volatility_medium_maximum_24h_realized: 0.05,
  liquidity_low_maximum_24h_quote_volume: 1_000_000,
  liquidity_medium_maximum_24h_quote_volume: 10_000_000,
  large_move_threshold: 0.02,
  extreme_move_threshold: 0.05,
  robust_minimum_events: 100,
  robust_maximum_symbol_concentration: 0.5,
  robust_minimum_stability_groups: 3,
  robust_minimum_positive_group_fraction: 0.6,
  aggregate_baseline: "F1-only PIT extreme on the same 15m aggregate window; historical bounded aggTrades samples were not archived",
} as const;

export interface FlowFeatureClassificationInput {
  flowImbalance: number;
  flowP10: number;
  flowP90: number;
  flowPercentile: number;
  accelerationRatio: number | null;
  priceReturn: number;
  pitMedianAbsPriceReturn: number;
  persistenceSigns: number[];
  persistenceIntervals: number;
  accelerationMinimum: number;
}

export interface FlowFeatureClassification {
  extremeBuy: boolean;
  extremeSell: boolean;
  flowDirection: "BULLISH" | "BEARISH" | null;
  accelerationPass: boolean;
  persistent: boolean;
  signedResponse: number | null;
  responseThreshold: number;
  strongResponse: boolean;
  absorption: boolean;
  h1Bullish: boolean;
  h1Bearish: boolean;
  h2Bullish: boolean;
  h2Bearish: boolean;
  h3FlowShock: boolean;
}

export function classifyFrozenFlowFeatures(input: FlowFeatureClassificationInput): FlowFeatureClassification {
  const extremeBuy = input.flowImbalance >= input.flowP90;
  const extremeSell = input.flowImbalance <= input.flowP10;
  const flowDirection = extremeBuy && !extremeSell
    ? "BULLISH"
    : extremeSell && !extremeBuy
      ? "BEARISH"
      : null;
  const accelerationPass = input.accelerationRatio !== null
    && input.accelerationRatio >= input.accelerationMinimum;
  const persistenceTail = input.persistenceSigns.slice(-input.persistenceIntervals);
  const persistent = persistenceTail.length >= input.persistenceIntervals
    && persistenceTail.every((sign) => sign !== 0 && sign === persistenceTail[0]);
  const responseThreshold = input.pitMedianAbsPriceReturn * 0.5;
  const signedResponse = flowDirection === null
    ? null
    : (flowDirection === "BULLISH" ? input.priceReturn : -input.priceReturn);
  const burst = flowDirection !== null && accelerationPass && persistent;
  const strongResponse = burst && signedResponse !== null && signedResponse > responseThreshold;
  const absorption = burst && signedResponse !== null && signedResponse <= responseThreshold;
  return {
    extremeBuy,
    extremeSell,
    flowDirection,
    accelerationPass,
    persistent,
    signedResponse,
    responseThreshold,
    strongResponse,
    absorption,
    h1Bullish: flowDirection === "BULLISH" && strongResponse,
    h1Bearish: flowDirection === "BEARISH" && strongResponse,
    h2Bullish: flowDirection === "BEARISH" && absorption,
    h2Bearish: flowDirection === "BULLISH" && absorption,
    h3FlowShock: burst,
  };
}

export class RollingHistogram {
  private readonly counts: Int32Array;
  private readonly tree: Int32Array;
  private readonly width: number;
  private total = 0;

  public constructor(
    private readonly minimum: number,
    private readonly maximum: number,
    private readonly binCount: number,
  ) {
    if (!(maximum > minimum) || binCount < 2) throw new Error("Invalid rolling histogram bounds");
    this.counts = new Int32Array(binCount);
    this.tree = new Int32Array(binCount + 1);
    this.width = (maximum - minimum) / binCount;
  }

  public add(value: number): void {
    const index = this.index(value);
    this.counts[index] += 1;
    this.update(index + 1, 1);
    this.total += 1;
  }

  public remove(value: number): void {
    const index = this.index(value);
    if (this.counts[index] <= 0) throw new Error("Rolling histogram underflow");
    this.counts[index] -= 1;
    this.update(index + 1, -1);
    this.total -= 1;
  }

  public size(): number {
    return this.total;
  }

  public quantile(probability: number): number | null {
    if (this.total === 0) return null;
    const p = Math.min(1, Math.max(0, probability));
    const rank = Math.max(1, Math.ceil(p * this.total));
    const index = this.lowerBound(rank);
    return this.minimum + index * this.width;
  }

  public percentileRank(value: number): number | null {
    if (this.total === 0) return null;
    const index = this.index(value);
    return this.prefix(index + 1) / this.total;
  }

  private index(value: number): number {
    if (!Number.isFinite(value)) throw new Error("Rolling histogram received a non-finite value");
    if (value <= this.minimum) return 0;
    if (value >= this.maximum) return this.binCount - 1;
    return Math.min(this.binCount - 1, Math.floor((value - this.minimum) / this.width));
  }

  private update(index: number, delta: number): void {
    for (let current = index; current < this.tree.length; current += current & -current) {
      this.tree[current] += delta;
    }
  }

  private prefix(index: number): number {
    let total = 0;
    for (let current = index; current > 0; current -= current & -current) total += this.tree[current];
    return total;
  }

  private lowerBound(rank: number): number {
    let index = 0;
    let accumulated = 0;
    let step = 1;
    while ((step << 1) < this.tree.length) step <<= 1;
    for (; step > 0; step >>= 1) {
      const next = index + step;
      if (next < this.tree.length && accumulated + this.tree[next] < rank) {
        index = next;
        accumulated += this.tree[next];
      }
    }
    return Math.min(this.binCount - 1, index);
  }
}

export function quantileSorted(sortedValues: number[], probability: number): number | null {
  if (sortedValues.length === 0) return null;
  const p = Math.min(1, Math.max(0, probability));
  const position = (sortedValues.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower] ?? null;
  const weight = position - lower;
  return (sortedValues[lower] ?? 0) * (1 - weight) + (sortedValues[upper] ?? 0) * weight;
}

export interface NumericSummary {
  n: number;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

export function summarizeNumeric(values: number[]): NumericSummary {
  if (values.length === 0) return { n: 0, mean: null, median: null, min: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    n: values.length,
    mean: values.reduce((total, value) => total + value, 0) / values.length,
    median: quantileSorted(sorted, 0.5),
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
  };
}

export interface MatchablePoint {
  time: number;
  matchKey: string;
}

export interface MatchPair<TEvent, TControl> {
  event: TEvent;
  control: TControl;
  distanceMs: number;
}

export function matchNearestWithoutReplacement<TEvent extends MatchablePoint, TControl extends MatchablePoint>(
  events: TEvent[],
  controls: TControl[],
): { pairs: MatchPair<TEvent, TControl>[]; unmatched: TEvent[] } {
  const byKey = new Map<string, TControl[]>();
  for (const control of controls) {
    const list = byKey.get(control.matchKey) ?? [];
    list.push(control);
    byKey.set(control.matchKey, list);
  }
  for (const list of byKey.values()) list.sort((left, right) => left.time - right.time);
  const used = new Set<TControl>();
  const pairs: MatchPair<TEvent, TControl>[] = [];
  const unmatched: TEvent[] = [];
  for (const event of [...events].sort((left, right) => left.time - right.time)) {
    const candidates = byKey.get(event.matchKey) ?? [];
    let selected: TControl | null = null;
    let selectedDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (used.has(candidate)) continue;
      const distance = Math.abs(candidate.time - event.time);
      if (distance < selectedDistance || (distance === selectedDistance && candidate.time < (selected?.time ?? Number.POSITIVE_INFINITY))) {
        selected = candidate;
        selectedDistance = distance;
      }
    }
    if (selected === null) unmatched.push(event);
    else {
      used.add(selected);
      pairs.push({ event, control: selected, distanceMs: selectedDistance });
    }
  }
  return { pairs, unmatched };
}

export interface PairedInference {
  n: number;
  observed: number | null;
  ci95: { lower: number; upper: number } | null;
  pValue: number | null;
  effectSize: number | null;
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

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function sampleStandardDeviation(values: number[], average: number): number {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1));
}

export function pairedMeanInference(
  differences: number[],
  seed: number,
  replicates = 2_000,
): PairedInference {
  if (differences.length === 0) return { n: 0, observed: null, ci95: null, pValue: null, effectSize: null };
  const observed = mean(differences);
  const standardDeviation = sampleStandardDeviation(differences, observed);
  const effectSize = standardDeviation === 0 ? null : observed / standardDeviation;
  const random = seededRandom(seed);
  const permutation = new Array<number>(replicates);
  const bootstrap = new Array<number>(replicates);
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    let permutationTotal = 0;
    let bootstrapTotal = 0;
    for (let index = 0; index < differences.length; index += 1) {
      const difference = differences[index] ?? 0;
      permutationTotal += random() < 0.5 ? difference : -difference;
      bootstrapTotal += differences[Math.floor(random() * differences.length)] ?? 0;
    }
    permutation[replicate] = permutationTotal / differences.length;
    bootstrap[replicate] = bootstrapTotal / differences.length;
  }
  const absoluteObserved = Math.abs(observed);
  const exceedances = permutation.filter((value) => Math.abs(value) >= absoluteObserved).length;
  bootstrap.sort((left, right) => left - right);
  return {
    n: differences.length,
    observed,
    ci95: {
      lower: quantileSorted(bootstrap, 0.025) ?? observed,
      upper: quantileSorted(bootstrap, 0.975) ?? observed,
    },
    pValue: (exceedances + 1) / (replicates + 1),
    effectSize,
  };
}

export interface MultiPairedInference {
  [metric: string]: PairedInference;
}

export function multiPairedMeanInference(
  series: Record<string, number[]>,
  seed: number,
  replicates = 2_000,
): MultiPairedInference {
  const names = Object.keys(series);
  const n = names.length === 0 ? 0 : Math.min(...names.map((name) => series[name]?.length ?? 0));
  if (n === 0) return Object.fromEntries(names.map((name) => [name, { n: 0, observed: null, ci95: null, pValue: null, effectSize: null }])) as MultiPairedInference;
  const observed = Object.fromEntries(names.map((name) => [name, mean((series[name] ?? []).slice(0, n))]));
  const standardDeviations = Object.fromEntries(names.map((name) => {
    const values = (series[name] ?? []).slice(0, n);
    return [name, sampleStandardDeviation(values, observed[name] as number)];
  }));
  const random = seededRandom(seed);
  const permutation = Object.fromEntries(names.map((name) => [name, new Array<number>(replicates)])) as Record<string, number[]>;
  const bootstrap = Object.fromEntries(names.map((name) => [name, new Array<number>(replicates)])) as Record<string, number[]>;
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    const permutationTotals = Object.fromEntries(names.map((name) => [name, 0])) as Record<string, number>;
    const bootstrapTotals = Object.fromEntries(names.map((name) => [name, 0])) as Record<string, number>;
    for (let index = 0; index < n; index += 1) {
      const sign = random() < 0.5 ? 1 : -1;
      const bootstrapIndex = Math.floor(random() * n);
      for (const name of names) {
        const values = series[name] ?? [];
        permutationTotals[name] = (permutationTotals[name] ?? 0) + sign * (values[index] ?? 0);
        bootstrapTotals[name] = (bootstrapTotals[name] ?? 0) + (values[bootstrapIndex] ?? 0);
      }
    }
    for (const name of names) {
      permutation[name]![replicate] = (permutationTotals[name] ?? 0) / n;
      bootstrap[name]![replicate] = (bootstrapTotals[name] ?? 0) / n;
    }
  }
  const result: MultiPairedInference = {};
  for (const name of names) {
    const value = observed[name] as number;
    const permutationValues = permutation[name] ?? [];
    const bootstrapValues = bootstrap[name] ?? [];
    const exceedances = permutationValues.filter((candidate) => Math.abs(candidate) >= Math.abs(value)).length;
    bootstrapValues.sort((left, right) => left - right);
    const standardDeviation = standardDeviations[name] as number;
    result[name] = {
      n,
      observed: value,
      ci95: {
        lower: quantileSorted(bootstrapValues, 0.025) ?? value,
        upper: quantileSorted(bootstrapValues, 0.975) ?? value,
      },
      pValue: (exceedances + 1) / (replicates + 1),
      effectSize: standardDeviation === 0 ? null : value / standardDeviation,
    };
  }
  return result;
}

export function holmAdjust(pValues: Array<{ id: string; pValue: number | null }>): Record<string, number | null> {
  const valid = pValues
    .filter((item): item is { id: string; pValue: number } => item.pValue !== null && Number.isFinite(item.pValue))
    .sort((left, right) => left.pValue - right.pValue || left.id.localeCompare(right.id));
  const adjusted: Record<string, number | null> = Object.fromEntries(pValues.map((item) => [item.id, null]));
  let runningMaximum = 0;
  valid.forEach((item, index) => {
    const value = Math.min(1, (valid.length - index) * item.pValue);
    runningMaximum = Math.max(runningMaximum, value);
    adjusted[item.id] = runningMaximum;
  });
  return adjusted;
}
