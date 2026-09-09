import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  evaluateSignalEngine,
  runSignalEngine,
  runSignalEngineDryRun,
} from "../lib/signal-engine";
import type { SignalEngineInput } from "../lib/signal-engine";

const SIGNAL_TIME = "2026-09-05T00:00:00.000Z";
const SIGNAL_ID = "22222222-2222-4222-8222-222222222222";

describe("HY-R4.8 signal engine", () => {
  it("emits an explainable LONG_WATCH and MARKET_STATUS from aligned public features", async () => {
    const input = fixture("LONG");
    const evaluation = evaluateSignalEngine(input, { idFactory: () => SIGNAL_ID });
    const types = evaluation.signals.map((signal) => signal.signal_type);
    const watch = evaluation.signals.find((signal) => signal.signal_type === "LONG_WATCH");

    expect(types).toContain("LONG_WATCH");
    expect(types).toContain("MARKET_STATUS");
    expect(types).not.toContain("RISK_WARNING");
    expect(watch?.event.id).toBe(SIGNAL_ID);
    expect(watch?.event.human_explanation).toContain("人工复核");
    expect(watch?.event.human_explanation).not.toMatch(/买入|卖出|下单|开仓|平仓/);
    expect(watch?.feature_snapshot?.pit_safe).toBe(true);
    expect(watch?.feature_snapshot?.snapshot_hash).toMatch(/^fnv1a32:/);
    expect(evaluation.scores.market_condition_score).toBeGreaterThanOrEqual(0);
    expect(evaluation.scores.market_condition_score).toBeLessThanOrEqual(100);

    const dryRun = await runSignalEngineDryRun(input, () => SIGNAL_ID);
    expect(dryRun.dry_run).toBe(true);
    expect(dryRun.persisted).toBe(false);
    expect(dryRun.persisted_signal_ids).toEqual([]);
    expect(dryRun.emails_sent).toBe(0);
  });

  it("keeps LONG and SHORT rules symmetric", () => {
    const long = evaluateSignalEngine(fixture("LONG"), { idFactory: () => SIGNAL_ID });
    const short = evaluateSignalEngine(fixture("SHORT"), { idFactory: () => SIGNAL_ID });

    expect(long.signals.map((signal) => signal.signal_type)).toContain("LONG_WATCH");
    expect(long.signals.map((signal) => signal.signal_type)).not.toContain("SHORT_WATCH");
    expect(short.signals.map((signal) => signal.signal_type)).toContain("SHORT_WATCH");
    expect(short.signals.map((signal) => signal.signal_type)).not.toContain("LONG_WATCH");
    expect(long.scores.long_evidence_count).toBe(short.scores.short_evidence_count);
  });

  it("prioritizes RISK_WARNING and blocks directional output for high volatility", () => {
    const input = fixture("LONG");
    input.features.volatility = { percentile: 96, shock: true };
    const evaluation = evaluateSignalEngine(input, { idFactory: () => SIGNAL_ID });
    const types = evaluation.signals.map((signal) => signal.signal_type);

    expect(types[0]).toBe("RISK_WARNING");
    expect(types).not.toContain("LONG_WATCH");
    expect(types).toContain("MARKET_STATUS");
    expect(evaluation.scores.risk_reason_codes).toContain("HIGH_VOLATILITY");
    expect(evaluation.scores.market_status).toBe("HIGH_VOL");
  });

  it("does not generate an unqualified watch in RANGE or UNKNOWN regime", () => {
    const range = fixture("LONG");
    range.market_regime = "RANGE";
    range.features.trend = {
      direction: "FLAT",
      higher_timeframe_direction: "FLAT",
      strength: 30,
      aligned: false,
    };
    const unknown = fixture("LONG");
    unknown.market_regime = "UNKNOWN";

    expect(evaluateSignalEngine(range, { idFactory: () => SIGNAL_ID }).signals.map((signal) => signal.signal_type))
      .toEqual(["MARKET_STATUS"]);
    expect(evaluateSignalEngine(unknown, { idFactory: () => SIGNAL_ID }).signals.map((signal) => signal.signal_type))
      .toContain("RISK_WARNING");
    expect(evaluateSignalEngine(unknown, { idFactory: () => SIGNAL_ID }).signals.map((signal) => signal.signal_type))
      .not.toContain("LONG_WATCH");
  });

  it("rejects future source data from persistence and marks the run non-PIT-safe", async () => {
    const input = fixture("LONG");
    input.features.source_timestamp = "2026-09-05T00:15:00.000Z";
    const evaluation = evaluateSignalEngine(input, { idFactory: () => SIGNAL_ID });

    expect(evaluation.persistence_eligible).toBe(false);
    expect(evaluation.scores.risk_reason_codes).toContain("PIT_INVALID");
    expect(evaluation.signals.every((signal) => signal.feature_snapshot === null)).toBe(true);
    await expect(runSignalEngine(input, {
      dryRun: false,
      supabase: createSupabaseStub().client,
      idFactory: () => SIGNAL_ID,
    })).rejects.toThrow("not eligible for persistence");
  });

  it("uses the existing intelligence repository only when explicitly not dry-run", async () => {
    const stub = createSupabaseStub();
    const result = await runSignalEngine(fixture("LONG"), {
      dryRun: false,
      supabase: stub.client,
      idFactory: () => SIGNAL_ID,
    });

    expect(result.persisted).toBe(true);
    expect(result.emails_sent).toBe(0);
    expect(stub.tables.every((table) => [
      "hy_signal_intelligence_events",
      "hy_signal_features",
    ].includes(table))).toBe(true);
    expect(stub.tables).not.toContain("hy_alert_delivery");
  });

  it("does not depend on email, trading, or private API modules", () => {
    const files = [
      "lib/signal-engine/dry-run.ts",
      "lib/signal-engine/index.ts",
      "lib/signal-engine/reason-codes.ts",
      "lib/signal-engine/score-framework.ts",
      "lib/signal-engine/signal-engine.ts",
      "lib/signal-engine/types.ts",
      "lib/signal-engine/validation.ts",
    ];
    const source = files
      .map((file) => readFileSync(resolve(import.meta.dirname, "..", file), "utf8"))
      .join("\n");
    expect(source).not.toMatch(/notifications\/email|createPaperTrade|claimSignal|private-api/i);
  });
});

function fixture(direction: "LONG" | "SHORT"): SignalEngineInput {
  const isLong = direction === "LONG";
  return {
    symbol: "BTCUSDT",
    timestamp: SIGNAL_TIME,
    market_regime: isLong ? "BULL" : "BEAR",
    reference_price: 100,
    features: {
      trend: {
        direction: isLong ? "UP" : "DOWN",
        higher_timeframe_direction: isLong ? "UP" : "DOWN",
        strength: 85,
        aligned: true,
      },
      momentum: {
        value: isLong ? 62 : 38,
        direction: isLong ? "UP" : "DOWN",
        stabilizing: false,
      },
      volume: { relative: 1.3, confirming: true },
      volatility: { percentile: 35, shock: false },
      funding_state: { percentile: isLong ? 35 : 65, funding_rate: 0.0001 },
      open_interest_state: {
        direction: "UP",
        price_direction: isLong ? "UP" : "DOWN",
        change_percent: 2,
        rolling_change_percent: 3,
        abnormal: false,
      },
      liquidity_state: { state: "OK", spread_bps: 2 },
      market_breadth: {
        advancing_ratio: isLong ? 0.65 : 0.35,
        trend_agreement: 0.8,
        fragile: false,
      },
      source_timestamp: SIGNAL_TIME,
      pit_safe: true,
      data_quality: "PASS",
    },
  };
}

function createSupabaseStub() {
  const tables: string[] = [];
  const client = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          tables.push(table);
          return {
            select() {
              return {
                async single() {
                  return {
                    data: {
                      id: row.id ?? SIGNAL_ID,
                      created_at: row.created_at ?? SIGNAL_TIME,
                      ...row,
                    },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, tables };
}
