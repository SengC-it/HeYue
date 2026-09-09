import type { SignalEngineSignal } from "../signal-engine";
import {
  defaultSignalQualityPolicy,
  type SignalQualityFilteredSignal,
  type SignalQualityPolicy,
  type SignalQualityResult,
  type SignalQualityState,
} from "./types";

const MATERIAL_RISK_REASONS = new Set([
  "DATA_BLOCKED",
  "FUNDING_EXTREME_NEGATIVE",
  "FUNDING_EXTREME_POSITIVE",
  "HIGH_VOLATILITY",
  "LIQUIDITY_BLOCKED",
  "OI_ABNORMAL",
  "PIT_INVALID",
  "UNKNOWN_REGIME",
]);

export function createSignalQualityState(): SignalQualityState {
  return {
    last_directional: new Map(),
    last_risk_warning: new Map(),
    last_status: new Map(),
  };
}

export function optimizeSignalOutputs(
  signals: readonly SignalEngineSignal[],
  state: SignalQualityState,
  policy: SignalQualityPolicy = defaultSignalQualityPolicy,
): SignalQualityResult {
  const accepted: SignalEngineSignal[] = [];
  const filtered: SignalQualityFilteredSignal[] = [];
  for (const signal of signals) {
    const reason = filterReason(signal, state, policy);
    if (reason) {
      filtered.push({ signal, reason });
      continue;
    }
    accepted.push(signal);
    remember(signal, state);
  }
  return { signals: accepted, filtered };
}

function filterReason(
  signal: SignalEngineSignal,
  state: SignalQualityState,
  policy: SignalQualityPolicy,
): SignalQualityFilteredSignal["reason"] | null {
  if (signal.signal_type === "LONG_WATCH" || signal.signal_type === "SHORT_WATCH") {
    const expectedStatus = signal.signal_type === "LONG_WATCH" ? "TREND_UP" : "TREND_DOWN";
    if (signal.scores.market_status !== expectedStatus) return "DIRECTIONAL_STATUS_MISMATCH";
    if (signal.scores.risk_level_score > policy.directional_max_risk_score) return "DIRECTIONAL_RISK_TOO_HIGH";
    if (signal.scores.confidence < policy.directional_min_confidence) return "DIRECTIONAL_CONFIDENCE_TOO_LOW";
    if (signal.opportunity_score < policy.directional_min_opportunity_score) return "DIRECTIONAL_OPPORTUNITY_TOO_LOW";
    const key = signal.event.symbol + ":" + signal.signal_type;
    const previous = state.last_directional.get(key);
    if (previous && isWithin(previous.timestamp, signal.event.created_at, policy.directional_cooldown_ms)) {
      if (signal.opportunity_score < previous.opportunity_score + policy.escalation_delta) {
        return "DUPLICATE_WITHIN_COOLDOWN";
      }
    }
    return null;
  }

  if (signal.signal_type === "RISK_WARNING") {
    const material = signal.scores.risk_reason_codes.some((reason) => MATERIAL_RISK_REASONS.has(reason));
    if (signal.scores.risk_level_score < policy.risk_warning_min_risk_score && !material) {
      return "RISK_NOT_MATERIAL";
    }
    const key = signal.event.symbol;
    const previous = state.last_risk_warning.get(key);
    if (previous && isWithin(previous.timestamp, signal.event.created_at, policy.risk_warning_cooldown_ms)) {
      const escalated = signal.scores.risk_level_score >= previous.risk_score + policy.escalation_delta;
      if (!escalated) return "DUPLICATE_WITHIN_COOLDOWN";
    }
    return null;
  }

  const key = signal.event.symbol;
  const previous = state.last_status.get(key);
  const status = signal.scores.market_status;
  if (
    previous
    && previous.status === status
    && isWithin(previous.timestamp, signal.event.created_at, policy.status_heartbeat_ms)
  ) {
    return "STATUS_HEARTBEAT_SUPPRESSED";
  }
  return null;
}

function remember(signal: SignalEngineSignal, state: SignalQualityState): void {
  const timestamp = Date.parse(signal.event.created_at ?? "");
  if (!Number.isFinite(timestamp)) return;
  if (signal.signal_type === "LONG_WATCH" || signal.signal_type === "SHORT_WATCH") {
    state.last_directional.set(signal.event.symbol + ":" + signal.signal_type, {
      timestamp,
      risk_score: signal.scores.risk_level_score,
      opportunity_score: signal.opportunity_score,
      reason_signature: signal.event.reason_codes.join(","),
    });
    return;
  }
  if (signal.signal_type === "RISK_WARNING") {
    state.last_risk_warning.set(signal.event.symbol, {
      timestamp,
      risk_score: signal.scores.risk_level_score,
      opportunity_score: signal.opportunity_score,
      reason_signature: signal.event.reason_codes.join(","),
    });
    return;
  }
  state.last_status.set(signal.event.symbol, {
    timestamp,
    status: signal.scores.market_status,
  });
}

function isWithin(previousTimestamp: number, createdAt: string | undefined, cooldownMs: number): boolean {
  const timestamp = Date.parse(createdAt ?? "");
  return Number.isFinite(timestamp)
    && timestamp >= previousTimestamp
    && timestamp - previousTimestamp < cooldownMs;
}
