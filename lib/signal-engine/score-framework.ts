import type {
  SignalDirection,
  SignalEngineFeatures,
  SignalEngineInput,
  SignalEngineScores,
} from "./types";
import { stableReasonCodes } from "./reason-codes";

export interface DirectionEvidence {
  trend: boolean;
  momentum: boolean;
  volume: boolean;
  funding: boolean;
  open_interest: boolean;
  liquidity: boolean;
  breadth: boolean;
  total: number;
}

export function calculateSignalEngineScores(input: SignalEngineInput): SignalEngineScores {
  const features = input.features;
  const pitSafe = isPitSafe(input);
  const marketCondition = marketConditionBreakdown(input);
  const signalQuality = signalQualityBreakdown(input, pitSafe);
  const riskLevel = riskLevelBreakdown(input, pitSafe);
  const marketConditionScore = weightedAverage(marketCondition, {
    trend_regime_clarity: 0.3,
    multi_timeframe_alignment: 0.2,
    market_breadth: 0.2,
    volatility_stability: 0.15,
    volume_participation: 0.15,
  });
  const signalQualityScore = weightedAverage(signalQuality, {
    price_trend_agreement: 0.2,
    momentum_agreement: 0.15,
    volume_confirmation: 0.15,
    funding_context: 0.15,
    oi_context: 0.15,
    liquidity_data_completeness: 0.1,
    reason_code_independence: 0.1,
  });
  const riskLevelScore = weightedAverage(riskLevel, {
    volatility_shock: 0.2,
    liquidity_slippage: 0.2,
    regime_conflict: 0.15,
    funding_crowding: 0.1,
    oi_crowding: 0.15,
    breadth_fragility: 0.1,
    data_pit_quality: 0.1,
  });

  const longEvidence = directionEvidence(input, "LONG");
  const shortEvidence = directionEvidence(input, "SHORT");
  const dataConfidence = features.data_quality === "PASS"
    ? 100
    : features.data_quality === "DEGRADED" ? 55 : 0;
  const confidence = clamp(
    marketConditionScore * 0.35
      + signalQualityScore * 0.35
      + dataConfidence * 0.2
      + (100 - riskLevelScore) * 0.1,
  );

  return {
    market_condition_score: round(marketConditionScore),
    signal_quality_score: round(signalQualityScore),
    risk_level_score: round(riskLevelScore),
    confidence: round(confidence),
    long_opportunity_score: round(opportunityScore(input, "LONG")),
    short_opportunity_score: round(opportunityScore(input, "SHORT")),
    long_evidence_count: longEvidence.total,
    short_evidence_count: shortEvidence.total,
    market_status: marketStatus(input, pitSafe),
    risk_reason_codes: riskReasonCodes(input, pitSafe),
    pit_safe: pitSafe,
    breakdown: {
      market_condition: roundRecord(marketCondition),
      signal_quality: roundRecord(signalQuality),
      risk_level: roundRecord(riskLevel),
    },
  };
}

export function directionEvidence(
  input: SignalEngineInput,
  direction: "LONG" | "SHORT",
): DirectionEvidence {
  const features = input.features;
  const expected = direction === "LONG" ? "UP" : "DOWN";
  const trend = input.market_regime === (direction === "LONG" ? "BULL" : "BEAR")
    && features.trend.direction === expected
    && features.trend.higher_timeframe_direction === expected
    && features.trend.aligned;
  const momentum = direction === "LONG"
    ? features.momentum.value >= 50 && features.momentum.value <= 85
      && (features.momentum.direction === "UP" || features.momentum.stabilizing)
    : features.momentum.value >= 15 && features.momentum.value <= 50
      && (features.momentum.direction === "DOWN" || features.momentum.stabilizing);
  const volume = features.volume.confirming && features.volume.relative >= 1;
  const funding = direction === "LONG"
    ? features.funding_state.percentile <= 60
    : features.funding_state.percentile >= 40;
  const openInterest = features.open_interest_state.price_direction === expected
    && features.open_interest_state.direction !== "FLAT";
  const liquidity = features.liquidity_state.state === "OK";
  const breadth = direction === "LONG"
    ? features.market_breadth.advancing_ratio >= 0.5
      && features.market_breadth.trend_agreement >= 0.5
    : features.market_breadth.advancing_ratio <= 0.5
      && features.market_breadth.trend_agreement >= 0.5;
  const checks = [trend, momentum, volume, funding, openInterest, liquidity, breadth];
  return {
    trend,
    momentum,
    volume,
    funding,
    open_interest: openInterest,
    liquidity,
    breadth,
    total: checks.filter(Boolean).length,
  };
}

export function isPitSafe(input: SignalEngineInput): boolean {
  const signalTime = Date.parse(input.timestamp);
  const sourceTime = Date.parse(input.features.source_timestamp);
  return input.features.pit_safe
    && Number.isFinite(signalTime)
    && Number.isFinite(sourceTime)
    && sourceTime <= signalTime;
}

function marketConditionBreakdown(input: SignalEngineInput): Record<string, number> {
  const features = input.features;
  const regimeClarity = input.market_regime === "UNKNOWN" ? 0 : features.trend.strength;
  const alignment = features.trend.aligned ? 100 : 25;
  const breadthClarity = Math.abs(features.market_breadth.advancing_ratio - 0.5) * 200;
  const breadth = features.market_breadth.trend_agreement * 60 + breadthClarity * 0.4;
  const volatilityStability = features.volatility.shock
    ? 0
    : 100 - features.volatility.percentile;
  const volumeParticipation = features.volume.confirming
    ? clamp(features.volume.relative / 1.5 * 100)
    : clamp(features.volume.relative / 3 * 100);
  return {
    trend_regime_clarity: regimeClarity,
    multi_timeframe_alignment: alignment,
    market_breadth: breadth,
    volatility_stability: volatilityStability,
    volume_participation: volumeParticipation,
  };
}

function signalQualityBreakdown(
  input: SignalEngineInput,
  pitSafe: boolean,
): Record<string, number> {
  const features = input.features;
  const expected = input.market_regime === "BULL" ? "UP"
    : input.market_regime === "BEAR" ? "DOWN" : "FLAT";
  const priceTrendAgreement = expected !== "FLAT"
    && features.trend.direction === expected
    && features.trend.higher_timeframe_direction === expected
    && features.trend.aligned ? 100 : input.market_regime === "RANGE" ? 45 : 0;
  const momentumAgreement = features.momentum.value >= 20 && features.momentum.value <= 80
    ? features.momentum.stabilizing ? 90 : 80
    : 35;
  const volumeConfirmation = features.volume.confirming
    ? clamp(features.volume.relative / 1.5 * 100)
    : 25;
  const fundingContext = features.funding_state.percentile <= 10
    || features.funding_state.percentile >= 90 ? 80 : 65;
  const oiContext = features.open_interest_state.abnormal
    ? 30
    : features.open_interest_state.price_direction !== "FLAT"
      && features.open_interest_state.direction !== "FLAT" ? 90 : 55;
  const liquidityData = features.liquidity_state.state === "OK"
    ? features.data_quality === "PASS" && pitSafe ? 100 : 55
    : features.liquidity_state.state === "THIN" ? 35 : 0;
  const reasonCodeIndependence = [
    features.trend.aligned,
    features.momentum.direction !== "FLAT" || features.momentum.stabilizing,
    features.volume.confirming,
    features.funding_state.percentile !== 50,
    features.open_interest_state.direction !== "FLAT",
    features.liquidity_state.state === "OK",
    pitSafe && features.data_quality === "PASS",
  ].filter(Boolean).length / 7 * 100;
  return {
    price_trend_agreement: priceTrendAgreement,
    momentum_agreement: momentumAgreement,
    volume_confirmation: volumeConfirmation,
    funding_context: fundingContext,
    oi_context: oiContext,
    liquidity_data_completeness: liquidityData,
    reason_code_independence: reasonCodeIndependence,
  };
}

function riskLevelBreakdown(
  input: SignalEngineInput,
  pitSafe: boolean,
): Record<string, number> {
  const features = input.features;
  const volatilityShock = features.volatility.shock
    ? 100
    : features.volatility.percentile >= 85 ? 80
      : features.volatility.percentile >= 70 ? 50 : 0;
  const liquiditySlippage = features.liquidity_state.state === "BLOCKED"
    ? 100
    : features.liquidity_state.state === "THIN"
      ? 70
      : clamp(features.liquidity_state.spread_bps / 20 * 100);
  const expected = input.market_regime === "BULL" ? "UP"
    : input.market_regime === "BEAR" ? "DOWN" : "FLAT";
  const regimeConflict = input.market_regime === "UNKNOWN"
    ? 100
    : expected !== "FLAT"
      && features.trend.direction === expected
      && features.trend.higher_timeframe_direction === expected
      && features.trend.aligned ? 0 : 70;
  const fundingCrowding = Math.abs(features.funding_state.percentile - 50) * 2;
  const oiCrowding = features.open_interest_state.abnormal
    ? 100
    : clamp(
      Math.abs(features.open_interest_state.change_percent) * 5
        + Math.abs(features.open_interest_state.rolling_change_percent ?? 0) * 2,
    );
  const breadthFragility = features.market_breadth.fragile
    ? 100
    : (1 - features.market_breadth.trend_agreement) * 100;
  const dataPitQuality = !pitSafe || features.data_quality === "BLOCKED"
    ? 100
    : features.data_quality === "DEGRADED" ? 55 : 0;
  return {
    volatility_shock: volatilityShock,
    liquidity_slippage: liquiditySlippage,
    regime_conflict: regimeConflict,
    funding_crowding: fundingCrowding,
    oi_crowding: oiCrowding,
    breadth_fragility: breadthFragility,
    data_pit_quality: dataPitQuality,
  };
}

function opportunityScore(
  input: SignalEngineInput,
  direction: "LONG" | "SHORT",
): number {
  const features = input.features;
  const expected = direction === "LONG" ? "UP" : "DOWN";
  const evidence = directionEvidence(input, direction);
  const trend = evidence.trend ? 100 : 20;
  const momentum = evidence.momentum ? 100 : 25;
  const volume = features.volume.confirming
    ? clamp(features.volume.relative / 1.5 * 100)
    : 20;
  const funding = direction === "LONG"
    ? features.funding_state.percentile <= 60
      ? 100 - Math.max(0, features.funding_state.percentile - 40) * 1.5
      : 15
    : features.funding_state.percentile >= 40
      ? 100 - Math.max(0, 60 - features.funding_state.percentile) * 1.5
      : 15;
  const openInterest = features.open_interest_state.price_direction === expected
    && features.open_interest_state.direction !== "FLAT"
    ? features.open_interest_state.abnormal ? 45 : 100
    : 20;
  const liquidity = features.liquidity_state.state === "OK" ? 100
    : features.liquidity_state.state === "THIN" ? 25 : 0;
  const breadth = direction === "LONG"
    ? features.market_breadth.advancing_ratio * 70 + features.market_breadth.trend_agreement * 30
    : (1 - features.market_breadth.advancing_ratio) * 70 + features.market_breadth.trend_agreement * 30;
  return weightedAverage(
    { trend, momentum, volume, funding, open_interest: openInterest, liquidity, breadth },
    { trend: 0.2, momentum: 0.15, volume: 0.15, funding: 0.15, open_interest: 0.15, liquidity: 0.1, breadth: 0.1 },
  );
}

function riskReasonCodes(input: SignalEngineInput, pitSafe: boolean): string[] {
  const features = input.features;
  const reasons: string[] = [];
  if (!pitSafe) reasons.push("PIT_INVALID");
  if (features.data_quality === "DEGRADED") reasons.push("DATA_DEGRADED");
  if (features.data_quality === "BLOCKED") reasons.push("DATA_BLOCKED");
  if (input.market_regime === "UNKNOWN") reasons.push("UNKNOWN_REGIME");
  if (features.liquidity_state.state === "THIN") reasons.push("LOW_LIQUIDITY");
  if (features.liquidity_state.state === "BLOCKED") reasons.push("LIQUIDITY_BLOCKED");
  if (features.volatility.shock || features.volatility.percentile >= 85) reasons.push("HIGH_VOLATILITY");
  if (features.funding_state.percentile <= 5) reasons.push("FUNDING_EXTREME_NEGATIVE");
  if (features.funding_state.percentile >= 95) reasons.push("FUNDING_EXTREME_POSITIVE");
  if (
    features.open_interest_state.abnormal
    || Math.abs(features.open_interest_state.change_percent) >= 10
    || Math.abs(features.open_interest_state.rolling_change_percent ?? 0) >= 15
  ) reasons.push("OI_ABNORMAL");
  const expected = input.market_regime === "BULL" ? "UP"
    : input.market_regime === "BEAR" ? "DOWN" : null;
  if (expected && (
    features.trend.direction !== expected
    || features.trend.higher_timeframe_direction !== expected
    || !features.trend.aligned
  )) reasons.push("REGIME_CONFLICT");
  if (features.market_breadth.fragile) reasons.push("BREADTH_FRAGILE");
  return stableReasonCodes(reasons);
}

function marketStatus(
  input: SignalEngineInput,
  pitSafe: boolean,
): SignalEngineScores["market_status"] {
  const features = input.features;
  if (
    !pitSafe
    || features.data_quality !== "PASS"
    || input.market_regime === "UNKNOWN"
    || features.liquidity_state.state === "BLOCKED"
  ) return "NO_TRADE";
  if (features.volatility.shock || features.volatility.percentile >= 85) return "HIGH_VOL";
  if (
    input.market_regime === "BULL"
    && features.trend.direction === "UP"
    && features.market_breadth.advancing_ratio >= 0.5
  ) return "TREND_UP";
  if (
    input.market_regime === "BEAR"
    && features.trend.direction === "DOWN"
    && features.market_breadth.advancing_ratio <= 0.5
  ) return "TREND_DOWN";
  return "RANGE";
}

function weightedAverage(values: Record<string, number>, weights: Record<string, number>): number {
  return Object.entries(weights).reduce(
    (total, [key, weight]) => total + clamp(values[key] ?? 0) * weight,
    0,
  );
}

function roundRecord(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, round(value)]),
  );
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function round(value: number): number {
  return Math.round(clamp(value) * 100) / 100;
}
