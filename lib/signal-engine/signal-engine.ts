import { randomUUID } from "node:crypto";
import {
  createSignalFeatureSnapshot,
  createSignalIntelligenceEvent,
} from "@/lib/services/signal-intelligence-repository";
import type { SignalIntelligenceEventInput, SignalType } from "@/lib/signal-intelligence/types";
import { reasonExplanation, stableReasonCodes } from "./reason-codes";
import { calculateSignalEngineScores, directionEvidence } from "./score-framework";
import { parseSignalEngineInput } from "./validation";
import type {
  SignalAlertLevel,
  SignalEngineEvaluation,
  SignalEngineInput,
  SignalEngineRunOptions,
  SignalEngineRunResult,
  SignalEngineScores,
  SignalEngineSignal,
} from "./types";

const DIRECTIONAL_GATE = {
  condition: 60,
  quality: 65,
  risk: 55,
  confidence: 60,
  opportunity: 65,
  evidence: 2,
} as const;

export function evaluateSignalEngine(
  value: unknown,
  options: Pick<SignalEngineRunOptions, "idFactory"> = {},
): SignalEngineEvaluation {
  const input = parseSignalEngineInput(value);
  const scores = calculateSignalEngineScores(input);
  const idFactory = options.idFactory ?? randomUUID;
  const signals: SignalEngineSignal[] = [];

  if (scores.risk_reason_codes.length > 0) {
    signals.push(createSignal(
      input,
      scores,
      "RISK_WARNING",
      0,
      riskAlertLevel(scores.risk_level_score),
      idFactory,
    ));
  }

  const long = directionSignal(input, scores, "LONG", idFactory);
  const short = directionSignal(input, scores, "SHORT", idFactory);
  if (long) signals.push(long);
  if (short) signals.push(short);

  signals.push(createSignal(
    input,
    scores,
    "MARKET_STATUS",
    0,
    "C",
    idFactory,
  ));

  return {
    signals,
    scores,
    persistence_eligible: scores.pit_safe,
  };
}

export async function runSignalEngine(
  value: unknown,
  options: SignalEngineRunOptions = {},
): Promise<SignalEngineRunResult> {
  const evaluation = evaluateSignalEngine(value, options);
  const dryRun = options.dryRun ?? true;
  if (dryRun) {
    return {
      ...evaluation,
      dry_run: true,
      persisted: false,
      persisted_signal_ids: [],
      emails_sent: 0,
    };
  }

  if (!options.supabase) {
    throw new Error("Supabase client is required when dryRun is false");
  }
  if (!evaluation.persistence_eligible || evaluation.signals.some((signal) => !signal.feature_snapshot)) {
    throw new Error("Signal engine output is not eligible for persistence");
  }

  const persistedSignalIds: string[] = [];
  for (const signal of evaluation.signals) {
    await createSignalIntelligenceEvent(options.supabase, signal.event);
    await createSignalFeatureSnapshot(options.supabase, signal.feature_snapshot!);
    persistedSignalIds.push(signal.event.id!);
  }
  return {
    ...evaluation,
    dry_run: false,
    persisted: true,
    persisted_signal_ids: persistedSignalIds,
    emails_sent: 0,
  };
}

function directionSignal(
  input: SignalEngineInput,
  scores: SignalEngineScores,
  direction: "LONG" | "SHORT",
  idFactory: () => string,
): SignalEngineSignal | null {
  const evidence = directionEvidence(input, direction);
  const opportunityScore = direction === "LONG"
    ? scores.long_opportunity_score
    : scores.short_opportunity_score;
  const eligible = input.market_regime === (direction === "LONG" ? "BULL" : "BEAR")
    && input.features.data_quality === "PASS"
    && input.features.liquidity_state.state === "OK"
    && !input.features.volatility.shock
    && input.features.volatility.percentile < 85
    && scores.pit_safe
    && scores.risk_level_score <= DIRECTIONAL_GATE.risk
    && scores.market_condition_score >= DIRECTIONAL_GATE.condition
    && scores.signal_quality_score >= DIRECTIONAL_GATE.quality
    && scores.confidence >= DIRECTIONAL_GATE.confidence
    && opportunityScore >= DIRECTIONAL_GATE.opportunity
    && evidence.total >= DIRECTIONAL_GATE.evidence;
  if (!eligible) return null;

  return createSignal(
    input,
    scores,
    direction === "LONG" ? "LONG_WATCH" : "SHORT_WATCH",
    opportunityScore,
    directionalAlertLevel(scores),
    idFactory,
  );
}

function createSignal(
  input: SignalEngineInput,
  scores: SignalEngineScores,
  signalType: SignalType,
  opportunityScore: number,
  alertLevel: SignalAlertLevel,
  idFactory: () => string,
): SignalEngineSignal {
  const id = idFactory();
  const reasonCodes = reasonsFor(input, scores, signalType);
  const event: SignalIntelligenceEventInput = {
    id,
    symbol: input.symbol,
    signal_type: signalType,
    created_at: input.timestamp,
    market_regime: input.market_regime,
    quality_score: signalType === "RISK_WARNING" || signalType === "MARKET_STATUS"
      ? scores.signal_quality_score
      : opportunityScore,
    risk_score: scores.risk_level_score,
    confidence: scores.confidence,
    reason_codes: reasonCodes,
    human_explanation: explanationFor(input, scores, signalType, reasonCodes),
    reference_price: input.reference_price,
    status: "CREATED",
  };
  return {
    event,
    feature_snapshot: scores.pit_safe ? featureSnapshot(input, id) : null,
    signal_type: signalType,
    opportunity_score: opportunityScore,
    alert_level: alertLevel,
    scores,
  };
}

function reasonsFor(
  input: SignalEngineInput,
  scores: SignalEngineScores,
  signalType: SignalType,
): string[] {
  const features = input.features;
  const reasons: string[] = [];
  if (signalType === "RISK_WARNING") reasons.push(...scores.risk_reason_codes);
  if (signalType === "MARKET_STATUS") reasons.push(scores.market_status);
  if (signalType === "LONG_WATCH" || signalType === "SHORT_WATCH") {
    reasons.push("TREND_ALIGNED");
    reasons.push(signalType === "LONG_WATCH" ? "MOMENTUM_UP" : "MOMENTUM_DOWN");
    if (features.momentum.stabilizing) reasons.push("MOMENTUM_STABILIZING");
    reasons.push("VOLUME_CONFIRMATION");
    reasons.push("FUNDING_CONTEXT_SUPPORTIVE");
    if (features.open_interest_state.direction === "UP") reasons.push("OI_RISING");
    if (features.open_interest_state.direction === "DOWN") reasons.push("OI_FALLING");
    const price = features.open_interest_state.price_direction;
    const oi = features.open_interest_state.direction;
    if (price === "UP" && oi === "UP") reasons.push("PRICE_UP_OI_UP");
    if (price === "UP" && oi === "DOWN") reasons.push("PRICE_UP_OI_DOWN");
    if (price === "DOWN" && oi === "UP") reasons.push("PRICE_DOWN_OI_UP");
    if (price === "DOWN" && oi === "DOWN") reasons.push("PRICE_DOWN_OI_DOWN");
    reasons.push("LIQUIDITY_OK");
  }
  if (features.funding_state.percentile <= 5) reasons.push("FUNDING_EXTREME_NEGATIVE");
  if (features.funding_state.percentile >= 95) reasons.push("FUNDING_EXTREME_POSITIVE");
  return stableReasonCodes(reasons);
}

function explanationFor(
  input: SignalEngineInput,
  scores: SignalEngineScores,
  signalType: SignalType,
  reasonCodes: string[],
): string {
  const observations = reasonCodes.slice(0, 4).map(reasonExplanation).join("；");
  if (signalType === "LONG_WATCH") {
    return `LONG_WATCH 观察：${observations}。Funding 和 Open Interest 仅作市场上下文；该条目供人工复核，不是执行指令。`;
  }
  if (signalType === "SHORT_WATCH") {
    return `SHORT_WATCH 观察：${observations}。Funding 和 Open Interest 仅作市场上下文；该条目供人工复核，不是执行指令。`;
  }
  if (signalType === "RISK_WARNING") {
    return `风险观察：${observations}。Risk Level ${scores.risk_level_score}/100；请人工复核数据和市场条件，本条目不表达方向。`;
  }
  return `市场状态：${scores.market_status}。${observations}。这是描述性上下文，不是方向性或执行指令。`;
}

function featureSnapshot(input: SignalEngineInput, signalId: string) {
  const features = input.features;
  return {
    signal_id: signalId,
    trend: { ...features.trend, source_timestamp: features.source_timestamp },
    momentum: { ...features.momentum, source_timestamp: features.source_timestamp },
    volume: { ...features.volume, source_timestamp: features.source_timestamp },
    volatility: { ...features.volatility, source_timestamp: features.source_timestamp },
    funding_state: { ...features.funding_state, source_timestamp: features.source_timestamp },
    open_interest_state: { ...features.open_interest_state, source_timestamp: features.source_timestamp },
    liquidity_state: { ...features.liquidity_state, source_timestamp: features.source_timestamp },
    market_breadth: { ...features.market_breadth, source_timestamp: features.source_timestamp },
    captured_at: input.timestamp,
    pit_safe: true as const,
    snapshot_hash: snapshotHash(features),
  };
}

function snapshotHash(value: unknown): string {
  const serialized = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function directionalAlertLevel(scores: SignalEngineScores): SignalAlertLevel {
  if (
    scores.market_condition_score >= 75
    && scores.signal_quality_score >= 80
    && scores.risk_level_score <= 35
    && scores.confidence >= 75
  ) return "A";
  return "B";
}

function riskAlertLevel(riskScore: number): SignalAlertLevel {
  if (riskScore >= 85) return "A";
  if (riskScore >= 70) return "B";
  return "C";
}
