import { z } from "zod";
import type { SignalEngineInput } from "./types";

const finiteNumber = (minimum?: number, maximum?: number) => {
  let schema = z.number().refine(Number.isFinite, "value must be finite");
  if (minimum !== undefined) schema = schema.min(minimum);
  if (maximum !== undefined) schema = schema.max(maximum);
  return schema;
};

const timestamp = z.string().trim().min(1).refine(
  (value) => Number.isFinite(Date.parse(value)),
  "timestamp must be a valid date",
);

const direction = z.enum(["UP", "DOWN", "FLAT"]);

export const signalEngineInputSchema = z.object({
  symbol: z.string().trim().min(1).max(32),
  timestamp,
  market_regime: z.enum(["BULL", "BEAR", "RANGE", "UNKNOWN"]),
  reference_price: finiteNumber().positive(),
  features: z.object({
    trend: z.object({
      direction,
      higher_timeframe_direction: direction,
      strength: finiteNumber(0, 100),
      aligned: z.boolean(),
    }).strict(),
    momentum: z.object({
      value: finiteNumber(0, 100),
      direction,
      stabilizing: z.boolean(),
    }).strict(),
    volume: z.object({
      relative: finiteNumber(0),
      confirming: z.boolean(),
    }).strict(),
    volatility: z.object({
      percentile: finiteNumber(0, 100),
      shock: z.boolean(),
    }).strict(),
    funding_state: z.object({
      percentile: finiteNumber(0, 100),
      funding_rate: finiteNumber().optional(),
      extreme: z.boolean().optional(),
    }).strict(),
    open_interest_state: z.object({
      direction,
      price_direction: direction,
      change_percent: finiteNumber(),
      rolling_change_percent: finiteNumber().optional(),
      abnormal: z.boolean(),
    }).strict(),
    liquidity_state: z.object({
      state: z.enum(["OK", "THIN", "BLOCKED"]),
      spread_bps: finiteNumber(0),
    }).strict(),
    market_breadth: z.object({
      advancing_ratio: finiteNumber(0, 1),
      trend_agreement: finiteNumber(0, 1),
      fragile: z.boolean(),
    }).strict(),
    source_timestamp: timestamp,
    pit_safe: z.literal(true),
    data_quality: z.enum(["PASS", "DEGRADED", "BLOCKED"]),
  }).strict(),
}).strict();

export function parseSignalEngineInput(value: unknown): SignalEngineInput {
  return signalEngineInputSchema.parse(value) as SignalEngineInput;
}
