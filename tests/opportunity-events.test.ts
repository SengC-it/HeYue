import { describe, expect, it } from "vitest";
import type { Candle } from "../lib/core/types";
import type {
  MarketStatusCode,
  SignalEngineInput,
  SignalEngineScores,
  SignalEngineSignal,
} from "../lib/signal-engine";
import {
  createOpportunityEventState,
  processOpportunityObservation,
  replayOpportunityEvent,
} from "../lib/opportunity-events";
import type {
  OpportunityDirection,
  OpportunityEventObservation,
} from "../lib/opportunity-events";

const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");
const FOUR_HOURS = 4 * 60 * 60 * 1000;

describe("opportunity event engine", () => {
  it("keeps SETUP separate from CONFIRMED and emits once on confirmation transition", () => {
    const state = createOpportunityEventState();
    const setup = processOpportunityObservation(makeObservation(BASE_TIME, "LONG", "NONE"), state);
    expect(setup.events).toHaveLength(0);
    expect(state.symbols.get("BTCUSDT")?.long.lifecycle).toBe("SETUP");

    const confirmed = processOpportunityObservation(makeObservation(BASE_TIME + FOUR_HOURS, "LONG", "BREAKOUT"), state);
    expect(confirmed.events).toHaveLength(1);
    expect(confirmed.events[0]?.signal_type).toBe("LONG_WATCH");
    expect(state.symbols.get("BTCUSDT")?.long.lifecycle).toBe("ACTIVE");

    const persistent = processOpportunityObservation(makeObservation(BASE_TIME + 2 * FOUR_HOURS, "LONG", "BREAKOUT"), state);
    expect(persistent.events).toHaveLength(0);
  });

  it("does not emit a duplicate while a persistent opportunity episode remains active", () => {
    const state = createOpportunityEventState();
    processOpportunityObservation(makeObservation(BASE_TIME, "LONG", "NONE"), state);
    const first = processOpportunityObservation(makeObservation(BASE_TIME + FOUR_HOURS, "LONG", "BREAKOUT"), state);
    const second = processOpportunityObservation(makeObservation(BASE_TIME + 2 * FOUR_HOURS, "LONG", "BREAKOUT"), state);
    expect(first.events[0]?.opportunity_event_id).toBe("opportunity:BTCUSDT:LONG:1");
    expect(second.events).toHaveLength(0);
  });

  it("invalidates an old episode, then allows a new episode after a fresh setup", () => {
    const state = createOpportunityEventState();
    processOpportunityObservation(makeObservation(BASE_TIME, "LONG", "NONE"), state);
    const first = processOpportunityObservation(makeObservation(BASE_TIME + FOUR_HOURS, "LONG", "BREAKOUT"), state);
    const invalidated = processOpportunityObservation(makeObservation(BASE_TIME + 2 * FOUR_HOURS, "LONG", "NONE", false), state);
    expect(first.events).toHaveLength(1);
    expect(invalidated.events).toHaveLength(0);
    expect(invalidated.invalidations[0]?.code).toBe("DIRECTION_CONFLICT");

    processOpportunityObservation(makeObservation(BASE_TIME + 3 * FOUR_HOURS, "LONG", "NONE"), state);
    const second = processOpportunityObservation(makeObservation(BASE_TIME + 4 * FOUR_HOURS, "LONG", "BREAKOUT"), state);
    expect(second.events[0]?.opportunity_event_id).toBe("opportunity:BTCUSDT:LONG:2");
  });

  it("keeps LONG and SHORT lifecycle state isolated", () => {
    const state = createOpportunityEventState();
    processOpportunityObservation(makeObservation(BASE_TIME, "LONG", "NONE", true, "LONGBTC"), state);
    processOpportunityObservation(makeObservation(BASE_TIME, "SHORT", "NONE", true, "SHORTBTC"), state);
    const long = processOpportunityObservation(makeObservation(BASE_TIME + FOUR_HOURS, "LONG", "BREAKOUT", true, "LONGBTC"), state);
    const short = processOpportunityObservation(makeObservation(BASE_TIME + FOUR_HOURS, "SHORT", "BREAKOUT", true, "SHORTBTC"), state);
    expect(long.events[0]?.signal_type).toBe("LONG_WATCH");
    expect(short.events[0]?.signal_type).toBe("SHORT_WATCH");
    expect(state.symbols.get("LONGBTC")?.short.lifecycle).toBe("NO_SETUP");
    expect(state.symbols.get("SHORTBTC")?.long.lifecycle).toBe("NO_SETUP");
  });

  it("emits one risk warning per transition and allows a later transition", () => {
    const state = createOpportunityEventState();
    const first = processOpportunityObservation(makeObservation(BASE_TIME, "LONG", "NONE", true, "RISKBTC", true), state);
    const persistent = processOpportunityObservation(makeObservation(BASE_TIME + FOUR_HOURS, "LONG", "NONE", true, "RISKBTC", true), state);
    const cleared = processOpportunityObservation(makeObservation(BASE_TIME + 2 * FOUR_HOURS, "LONG", "NONE", true, "RISKBTC", false), state);
    const second = processOpportunityObservation(makeObservation(BASE_TIME + 3 * FOUR_HOURS, "LONG", "NONE", true, "RISKBTC", true), state);
    expect(first.events.filter((event) => event.signal_type === "RISK_WARNING")).toHaveLength(1);
    expect(persistent.events.filter((event) => event.signal_type === "RISK_WARNING")).toHaveLength(0);
    expect(cleared.events.filter((event) => event.signal_type === "RISK_WARNING")).toHaveLength(0);
    expect(second.events.filter((event) => event.signal_type === "RISK_WARNING")).toHaveLength(1);
  });

  it("emits MARKET_STATUS only on an observed status transition", () => {
    const state = createOpportunityEventState();
    const initial = processOpportunityObservation(makeObservation(BASE_TIME, "LONG", "NONE", true, "STATUSBTC", false, "TREND_UP"), state);
    const same = processOpportunityObservation(makeObservation(BASE_TIME + FOUR_HOURS, "LONG", "NONE", true, "STATUSBTC", false, "TREND_UP"), state);
    const changed = processOpportunityObservation(makeObservation(BASE_TIME + 2 * FOUR_HOURS, "LONG", "NONE", true, "STATUSBTC", false, "RANGE"), state);
    const repeated = processOpportunityObservation(makeObservation(BASE_TIME + 3 * FOUR_HOURS, "LONG", "NONE", true, "STATUSBTC", false, "RANGE"), state);
    expect(initial.events.filter((event) => event.signal_type === "MARKET_STATUS")).toHaveLength(0);
    expect(same.events).toHaveLength(0);
    expect(changed.events.filter((event) => event.signal_type === "MARKET_STATUS")).toHaveLength(1);
    expect(repeated.events).toHaveLength(0);
  });

  it("rejects a future source or candle instead of creating an event", () => {
    const state = createOpportunityEventState();
    const observation = makeObservation(BASE_TIME, "LONG", "BREAKOUT");
    observation.price_history = [...observation.price_history, makeCandle(BASE_TIME + FOUR_HOURS, 108, 110, 107, 109)];
    const result = processOpportunityObservation(observation, state);
    expect(result.pit_rejected).toBe(true);
    expect(result.events).toHaveLength(0);
    expect(state.symbols.get("BTCUSDT")?.long.lifecycle).toBe("NO_SETUP");
  });

  it("keeps the confirmed Entry Context snapshot immutable", () => {
    const state = createOpportunityEventState();
    processOpportunityObservation(makeObservation(BASE_TIME, "LONG", "NONE"), state);
    const observation = makeObservation(BASE_TIME + FOUR_HOURS, "LONG", "BREAKOUT");
    const result = processOpportunityObservation(observation, state);
    const event = result.events[0]!;
    const pattern = event.entry_context?.pattern;
    observation.price_history[3]!.close = 1;
    expect(event.entry_context?.pattern).toBe(pattern);
    expect(event.entry_context?.price_structure.current_close).toBe(107);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.entry_context)).toBe(true);
  });

  it("replays directional events only with candles after the event timestamp", () => {
    const state = createOpportunityEventState();
    processOpportunityObservation(makeObservation(BASE_TIME, "LONG", "NONE"), state);
    const observation = makeObservation(BASE_TIME + FOUR_HOURS, "LONG", "BREAKOUT");
    const result = processOpportunityObservation(observation, state);
    const event = result.events.find((candidate) => candidate.signal_type === "LONG_WATCH")!;
    const future = [
      ...observation.price_history,
      makeCandle(BASE_TIME + 2 * FOUR_HOURS, 107, 110, 106, 109),
      makeCandle(BASE_TIME + 3 * FOUR_HOURS, 109, 112, 108, 111),
      makeCandle(BASE_TIME + 4 * FOUR_HOURS, 111, 113, 110, 112),
      makeCandle(BASE_TIME + 5 * FOUR_HOURS, 112, 114, 111, 113),
      makeCandle(BASE_TIME + 6 * FOUR_HOURS, 113, 115, 112, 114),
    ];
    const replay = replayOpportunityEvent(event, future);
    expect(replay).toHaveLength(3);
    expect(replay[0]?.replay_status).toBe("COMPLETE");
    expect(replay[0]?.aligned_return).toBeGreaterThan(0);
    expect(replay[0]?.price_source_timestamp).toBe(new Date(BASE_TIME + 2 * FOUR_HOURS).toISOString());
  });
});

function makeObservation(
  timestamp: number,
  direction: OpportunityDirection,
  pattern: "NONE" | "BREAKOUT",
  includeDirectional = true,
  symbol = "BTCUSDT",
  risk = false,
  status: MarketStatusCode = direction === "LONG" ? "TREND_UP" : "TREND_DOWN",
): OpportunityEventObservation {
  const input = makeInput(timestamp, direction, symbol, status);
  const scores = makeScores(direction, status, risk);
  const directionalSignal = includeDirectional ? makeSignal(input, scores, direction) : undefined;
  return {
    symbol,
    timestamp,
    input,
    scores,
    price_history: makePriceHistory(timestamp, direction, pattern),
    directional_signals: directionalSignal
      ? { [direction]: directionalSignal }
      : {},
    risk_warning: risk ? makeRiskSignal(input, scores) : null,
  };
}

function makeInput(
  timestamp: number,
  direction: OpportunityDirection,
  symbol: string,
  status: MarketStatusCode,
): SignalEngineInput {
  const long = direction === "LONG";
  return {
    symbol,
    timestamp: new Date(timestamp).toISOString(),
    market_regime: long ? "BULL" : "BEAR",
    reference_price: 100,
    features: {
      trend: {
        direction: long ? "UP" : "DOWN",
        higher_timeframe_direction: long ? "UP" : "DOWN",
        strength: 80,
        aligned: true,
      },
      momentum: {
        value: long ? 60 : 40,
        direction: long ? "UP" : "DOWN",
        stabilizing: false,
      },
      volume: { relative: 1.5, confirming: true },
      volatility: { percentile: 40, shock: false },
      funding_state: { percentile: long ? 45 : 55, funding_rate: 0 },
      open_interest_state: {
        direction: "UP",
        price_direction: long ? "UP" : "DOWN",
        change_percent: 1,
        rolling_change_percent: 2,
        abnormal: false,
      },
      liquidity_state: { state: "OK", spread_bps: 10 },
      market_breadth: {
        advancing_ratio: long ? 0.65 : 0.35,
        trend_agreement: 0.7,
        fragile: false,
      },
      source_timestamp: new Date(timestamp).toISOString(),
      pit_safe: true,
      data_quality: "PASS",
    },
  };
}

function makeScores(
  direction: OpportunityDirection,
  status: MarketStatusCode,
  risk: boolean,
): SignalEngineScores {
  return {
    market_condition_score: 80,
    signal_quality_score: 80,
    risk_level_score: risk ? 70 : 30,
    confidence: 80,
    long_opportunity_score: direction === "LONG" ? 85 : 20,
    short_opportunity_score: direction === "SHORT" ? 85 : 20,
    long_evidence_count: direction === "LONG" ? 5 : 1,
    short_evidence_count: direction === "SHORT" ? 5 : 1,
    market_status: status,
    risk_reason_codes: risk ? ["HIGH_VOLATILITY"] : [],
    pit_safe: true,
    breakdown: {
      market_condition: {},
      signal_quality: {},
      risk_level: {},
    },
  };
}

function makeSignal(
  input: SignalEngineInput,
  scores: SignalEngineScores,
  direction: OpportunityDirection,
): SignalEngineSignal {
  const signalType = direction === "LONG" ? "LONG_WATCH" : "SHORT_WATCH";
  return {
    event: {
      id: input.symbol + ":" + signalType + ":" + input.timestamp,
      symbol: input.symbol,
      signal_type: signalType,
      created_at: input.timestamp,
      market_regime: input.market_regime,
      quality_score: 85,
      risk_score: scores.risk_level_score,
      confidence: scores.confidence,
      reason_codes: ["TREND_ALIGNED", "VOLUME_CONFIRMATION", "FUNDING_CONTEXT_SUPPORTIVE"],
      human_explanation: "Manual observation context.",
      reference_price: input.reference_price,
      status: "CREATED",
    },
    feature_snapshot: null,
    signal_type: signalType,
    opportunity_score: 85,
    alert_level: "B",
    scores,
  };
}

function makeRiskSignal(input: SignalEngineInput, scores: SignalEngineScores): SignalEngineSignal {
  return {
    ...makeSignal(input, scores, "LONG"),
    event: {
      ...makeSignal(input, scores, "LONG").event,
      signal_type: "RISK_WARNING",
      reason_codes: ["HIGH_VOLATILITY"],
    },
    signal_type: "RISK_WARNING",
    opportunity_score: 0,
  };
}

function makePriceHistory(
  timestamp: number,
  direction: OpportunityDirection,
  pattern: "NONE" | "BREAKOUT",
): Candle[] {
  const long = direction === "LONG";
  const prior = long
    ? [
      makeCandle(timestamp - 3 * FOUR_HOURS, 100, 104, 98, 102),
      makeCandle(timestamp - 2 * FOUR_HOURS, 102, 105, 100, 103),
      makeCandle(timestamp - FOUR_HOURS, 103, 106, 101, 104),
    ]
    : [
      makeCandle(timestamp - 3 * FOUR_HOURS, 100, 102, 96, 98),
      makeCandle(timestamp - 2 * FOUR_HOURS, 98, 100, 95, 97),
      makeCandle(timestamp - FOUR_HOURS, 97, 99, 94, 96),
    ];
  const current = long
    ? pattern === "BREAKOUT"
      ? makeCandle(timestamp, 104, 108, 103, 107)
      : makeCandle(timestamp, 104, 105, 103, 104.5)
    : pattern === "BREAKOUT"
      ? makeCandle(timestamp, 96, 97, 92, 93)
      : makeCandle(timestamp, 96, 97, 95, 96.5);
  return [...prior, current];
}

function makeCandle(
  closeTime: number,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  return {
    openTime: closeTime - FOUR_HOURS,
    open,
    high,
    low,
    close,
    volume: 100,
    quoteVolume: 1000,
    closeTime,
  };
}
