import { z } from "zod";
import {
  B4_SHADOW_OUTCOME_HORIZONS,
  type B4ShadowFutureObservation,
  type B4ShadowObservation,
  type B4ShadowOutcome,
  type B4ShadowSignalEvent,
} from "./b4-shadow-types";

const finiteNumber = z.number().refine(Number.isFinite, "value must be finite");
const positiveNumber = finiteNumber.positive();
const timestamp = z.string().trim().min(1).refine(
  (value) => Number.isFinite(Date.parse(value)),
  "timestamp must be a valid date",
);
const contextState = z.record(z.string(), z.union([
  z.string(),
  finiteNumber,
  z.boolean(),
  z.null(),
]));

export const b4ShadowObservationSchema = z.object({
  symbol: z.string().trim().min(1).max(32),
  market_timestamp: timestamp,
  decision_timestamp: timestamp,
  pit_available_at: timestamp,
  perpetual_price: positiveNumber,
  premium_value: finiteNumber.nullable(),
  price_change_value: finiteNumber.nullable(),
  premium_change_value: finiteNumber.nullable(),
  price_percentile: finiteNumber.min(0).max(1).nullable(),
  premium_change_percentile: finiteNumber.min(0).max(1).nullable(),
  funding_state: contextState.nullable(),
  mark_index_basis_state: contextState.nullable(),
  mark_price: positiveNumber.nullable(),
  index_price: positiveNumber.nullable(),
  market_regime: z.string().trim().min(1).max(64),
  volatility_bucket: z.string().trim().min(1).max(64),
  liquidity_bucket: z.string().trim().min(1).max(64),
  volatility_value: finiteNumber.nullable(),
  liquidity_percentile: finiteNumber.min(0).max(1).nullable(),
  calendar_period: z.string().trim().min(1).max(64),
  observation_closed: z.boolean(),
  market_data_complete: z.boolean(),
  rolling_history_ready: z.boolean(),
  pit_safe: z.boolean(),
}).strict();

export const b4ShadowFutureObservationSchema = z.object({
  timestamp,
  pit_available_at: timestamp,
  close_price: positiveNumber,
  high_price: positiveNumber,
  low_price: positiveNumber,
  observation_closed: z.boolean(),
  path: z.array(z.object({
    timestamp,
    pit_available_at: timestamp,
    close_price: positiveNumber,
    high_price: positiveNumber,
    low_price: positiveNumber,
    observation_closed: z.boolean(),
  }).strict().refine(
    (value) => value.high_price >= value.low_price,
    "path high_price must be greater than or equal to low_price",
  )).optional(),
}).strict().refine(
  (value) => value.high_price >= value.low_price,
  "high_price must be greater than or equal to low_price",
);

export const b4ShadowEventSchema = z.object({
  event_id: z.string().uuid(),
  episode_key: z.string().trim().min(1).max(256),
  experiment: z.literal("HY-R6.1"),
  version: z.literal("hy-b4-shadow-v1"),
  created_at: timestamp,
  market_timestamp: timestamp,
  pit_available_at: timestamp,
  symbol: z.string().trim().min(1).max(32),
  direction: z.enum(["BULLISH", "BEARISH"]),
  alert_type: z.enum(["LONG_WATCH", "SHORT_WATCH"]),
  family: z.literal("B4"),
  hypothesis: z.literal("DIVERGENCE_REVERSAL"),
  feature_version: z.string().min(1),
  cutoff_version: z.string().min(1),
  perpetual_price: positiveNumber,
  premium_value: finiteNumber,
  price_change_value: finiteNumber,
  premium_change_value: finiteNumber,
  price_percentile: finiteNumber.min(0).max(1),
  premium_change_percentile: finiteNumber.min(0).max(1),
  funding_state: contextState,
  mark_index_basis_state: contextState,
  market_regime: z.string().trim().min(1).max(64),
  volatility_bucket: z.string().trim().min(1).max(64),
  liquidity_bucket: z.string().trim().min(1).max(64),
  calendar_period: z.string().trim().min(1).max(64),
  data_completeness: z.literal("COMPLETE"),
  pit_status: z.literal("PASS"),
  dedup_state: z.literal("NEW_FALSE_TO_TRUE"),
  shadow_status: z.literal("WOULD_HAVE_ALERTED"),
  control_status: z.enum(["AVAILABLE", "CONTROL_UNAVAILABLE"]),
  control_event_id: z.string().nullable(),
  control_match_key: z.string().min(1),
}).strict();

export const b4ShadowOutcomeSchema = z.object({
  event_id: z.string().uuid(),
  direction: z.enum(["BULLISH", "BEARISH"]),
  horizon_hours: z.number().int().refine(
    (value) => (B4_SHADOW_OUTCOME_HORIZONS as readonly number[]).includes(value),
    "unsupported outcome horizon",
  ),
  future_observation_timestamp: timestamp,
  future_available_at: timestamp,
  future_price: positiveNumber,
  signed_return: finiteNumber,
  max_favorable_move: finiteNumber,
  max_adverse_move: finiteNumber,
  pit_safe: z.literal(true),
  outcome_status: z.literal("MATURED"),
  calculation_version: z.literal("hy-b4-shadow-v1"),
}).strict();

export function parseB4ShadowObservation(value: unknown): B4ShadowObservation {
  return b4ShadowObservationSchema.parse(value) as B4ShadowObservation;
}

export function parseB4ShadowFutureObservation(value: unknown): B4ShadowFutureObservation {
  return b4ShadowFutureObservationSchema.parse(value) as B4ShadowFutureObservation;
}

export function parseB4ShadowEvent(value: unknown): B4ShadowSignalEvent {
  return b4ShadowEventSchema.parse(value) as B4ShadowSignalEvent;
}

export function parseB4ShadowOutcome(value: unknown): B4ShadowOutcome {
  return b4ShadowOutcomeSchema.parse(value) as B4ShadowOutcome;
}
