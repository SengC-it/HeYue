import { z } from "zod";
import {
  deliveryStatusValues,
  manualDirectionValues,
  marketRegimeValues,
  replayStatusValues,
  signalEventStatusValues,
  signalTypeValues,
  userActionValues,
} from "./types";

const finiteScore = z.number()
  .min(0)
  .max(100)
  .refine(Number.isFinite, "score must be finite");

const positiveFiniteNumber = z.number()
  .positive()
  .refine(Number.isFinite, "value must be finite");

const finiteMetric = z.number()
  .refine(Number.isFinite, "metric must be finite");

const featureObject = z.record(z.string(), z.unknown());

export const signalIntelligenceEventInputSchema = z.object({
  id: z.string().uuid().optional(),
  symbol: z.string().trim().min(1).max(32),
  signal_type: z.enum(signalTypeValues),
  created_at: z.string().trim().min(1).optional(),
  market_regime: z.enum(marketRegimeValues),
  quality_score: finiteScore,
  risk_score: finiteScore,
  confidence: finiteScore,
  reason_codes: z.array(z.string().trim().min(1).max(120)).max(64),
  human_explanation: z.string().trim().min(1).max(4000),
  reference_price: positiveFiniteNumber,
  status: z.enum(signalEventStatusValues).default("CREATED"),
}).strict();

export const signalFeatureInputSchema = z.object({
  signal_id: z.string().uuid(),
  trend: featureObject,
  momentum: featureObject,
  volume: featureObject,
  volatility: featureObject,
  funding_state: featureObject,
  open_interest_state: featureObject,
  liquidity_state: featureObject,
  market_breadth: featureObject,
  captured_at: z.string().trim().min(1).optional(),
  pit_safe: z.literal(true).default(true),
  snapshot_hash: z.string().trim().min(1).nullable().optional(),
}).strict();

export const alertDeliveryInputSchema = z.object({
  id: z.string().uuid().optional(),
  signal_id: z.string().uuid(),
  channel: z.literal("EMAIL").default("EMAIL"),
  email: z.string().email(),
  status: z.enum(deliveryStatusValues).default("PENDING"),
  sent_at: z.string().trim().min(1).nullable().optional(),
  failure_reason: z.string().trim().max(1000).nullable().optional(),
  idempotency_key: z.string().trim().min(1).max(512).optional(),
}).strict();

const optionalMetric = finiteMetric.nullable().optional();
const optionalPositivePrice = positiveFiniteNumber.nullable().optional();

export const signalReplayInputSchema = z.object({
  signal_id: z.string().uuid(),
  future_4h_price: optionalPositivePrice,
  future_12h_price: optionalPositivePrice,
  future_24h_price: optionalPositivePrice,
  return_4h: optionalMetric,
  return_12h: optionalMetric,
  return_24h: optionalMetric,
  max_favorable_move: optionalMetric,
  max_adverse_move: optionalMetric,
  reference_timestamp: z.string().trim().min(1),
  pit_safe: z.literal(true).default(true),
  replay_status: z.enum(replayStatusValues).default("PENDING"),
  evaluated_at: z.string().trim().min(1).nullable().optional(),
  calculation_version: z.string().trim().min(1).nullable().optional(),
}).strict();

export const signalFeedbackInputSchema = z.object({
  id: z.string().uuid().optional(),
  signal_id: z.string().uuid(),
  user_action: z.enum(userActionValues),
  manual_direction: z.enum(manualDirectionValues).nullable().optional(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(4000).nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.user_action === "TRADED" && !value.manual_direction) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["manual_direction"],
      message: "manual_direction is required when user_action is TRADED",
    });
  }
});
