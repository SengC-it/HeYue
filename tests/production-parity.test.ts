import { describe, expect, it } from "vitest";
import { ProductionClaimSimulator } from "../lib/backtest/production-parity";
import type { BacktestTrade } from "../lib/backtest/types";

const T0 = Date.parse("2026-09-01T00:00:00.000Z");

describe("production claim parity", () => {
  it("uses signal source timestamp for cooldown while a prior trade is held", () => {
    const simulator = newSimulator();
    simulator.claim({
      symbol: "BTCUSDT",
      sourceTimestamp: T0,
      score: 81,
      riskUsdt: 49,
      validUntil: T0 + 48 * HOUR,
      paperTrade: sampleTrade(T0 + 40 * HOUR),
    });

    const outcome = simulator.claim({
      symbol: "BTCUSDT",
      sourceTimestamp: T0 + 25 * HOUR,
      score: 82,
      riskUsdt: 50,
      validUntil: T0 + 73 * HOUR,
    });

    expect(outcome.status).toBe("REPLACED");
    expect(outcome.riskDeltaUsdt).toBe(1);
  });

  it("accounts for same-symbol replacement as incremental risk", () => {
    const simulator = newSimulator();
    simulator.claim({ symbol: "ETHUSDT", sourceTimestamp: T0, score: 81, riskUsdt: 49, validUntil: T0 + 48 * HOUR });
    const outcome = simulator.claim({
      symbol: "ETHUSDT",
      sourceTimestamp: T0 + 25 * HOUR,
      score: 82,
      riskUsdt: 50,
      validUntil: T0 + 73 * HOUR,
    });

    expect(outcome.status).toBe("REPLACED");
    expect(outcome.riskDeltaUsdt).toBe(1);
    expect(simulator.result().counts.claimedSignalCount).toBe(2);
  });

  it("rejects a same-symbol lower-score candidate", () => {
    const simulator = newSimulator();
    simulator.claim({ symbol: "SOLUSDT", sourceTimestamp: T0, score: 82, riskUsdt: 50, validUntil: T0 + 48 * HOUR });
    const outcome = simulator.claim({
      symbol: "SOLUSDT",
      sourceTimestamp: T0 + 25 * HOUR,
      score: 81,
      riskUsdt: 50,
      validUntil: T0 + 73 * HOUR,
    });

    expect(outcome.status).toBe("REJECTED_LOWER_SCORE");
    expect(outcome.claimed).toBe(false);
  });

  it("does not apply a concurrent-position cap to a seventh claim", () => {
    const simulator = newSimulator();
    for (let index = 0; index < 6; index += 1) {
      expect(simulator.claim({
        symbol: `COIN${index}USDT`,
        sourceTimestamp: T0,
        score: 80,
        riskUsdt: 50,
        validUntil: T0 + 48 * HOUR,
      }).claimed).toBe(true);
    }

    const seventh = simulator.claim({
      symbol: "COIN6USDT",
      sourceTimestamp: T0,
      score: 80,
      riskUsdt: 50,
      validUntil: T0 + 48 * HOUR,
    });

    expect(seventh.claimed).toBe(true);
    expect(seventh.paperTradeCreated).toBe(true);
  });

  it("keeps a daily email cap from blocking a claimed paper sample", () => {
    const simulator = newSimulator({ maxEmailsPerDay: 1 });
    simulator.claim({ symbol: "ADAUSDT", sourceTimestamp: T0, score: 80, riskUsdt: 50, validUntil: T0 + 48 * HOUR });
    const outcome = simulator.claim({
      symbol: "XRPUSDT",
      sourceTimestamp: T0 + 15 * MINUTE,
      score: 80,
      riskUsdt: 50,
      validUntil: T0 + 48 * HOUR,
    });

    expect(outcome.claimed).toBe(true);
    expect(outcome.paperTradeCreated).toBe(true);
    expect(outcome.emailAllowed).toBe(false);
    expect(outcome.deliveryStatus).toBe("NOT_ALLOWED");
  });

  it("keeps a scan email cap from blocking a claimed paper sample", () => {
    const simulator = newSimulator({ maxEmailsPerScan: 1 });
    simulator.claim({ symbol: "LINKUSDT", sourceTimestamp: T0, score: 80, riskUsdt: 50, validUntil: T0 + 48 * HOUR });
    const outcome = simulator.claim({
      symbol: "AVAXUSDT",
      sourceTimestamp: T0,
      score: 80,
      riskUsdt: 50,
      validUntil: T0 + 48 * HOUR,
    });

    expect(outcome.claimed).toBe(true);
    expect(outcome.paperTradeCreated).toBe(true);
    expect(outcome.emailAllowed).toBe(false);
    expect(outcome.deliveryStatus).toBe("NOT_ALLOWED");
  });

  it("blocks when the daily risk reservation is exceeded", () => {
    const simulator = newSimulator({ dailyRiskBudgetUsdt: 50 });
    simulator.claim({ symbol: "BNBUSDT", sourceTimestamp: T0, score: 80, riskUsdt: 50, validUntil: T0 + 48 * HOUR });
    const outcome = simulator.claim({
      symbol: "DOGEUSDT",
      sourceTimestamp: T0 + 15 * MINUTE,
      score: 80,
      riskUsdt: 1,
      validUntil: T0 + 48 * HOUR,
    });

    expect(outcome.status).toBe("BUDGET_BLOCKED");
    expect(outcome.claimed).toBe(false);
    expect(outcome.paperTradeCreated).toBe(false);
  });

  it("blocks when the single-signal risk cap is exceeded", () => {
    const simulator = newSimulator();
    const outcome = simulator.claim({
      symbol: "OPUSDT",
      sourceTimestamp: T0,
      score: 80,
      riskUsdt: 51,
      validUntil: T0 + 48 * HOUR,
    });

    expect(outcome.status).toBe("SINGLE_RISK_CAP");
    expect(outcome.claimed).toBe(false);
  });

  it("records a dry-run delivery separately from the claim", () => {
    const simulator = newSimulator({ dryRun: true });
    const outcome = simulator.claim({
      symbol: "SUIUSDT",
      sourceTimestamp: T0,
      score: 80,
      riskUsdt: 50,
      validUntil: T0 + 48 * HOUR,
    });

    expect(outcome.claimed).toBe(true);
    expect(outcome.emailAllowed).toBe(true);
    expect(outcome.emailDeliveredEquivalent).toBe(true);
    expect(outcome.deliveryStatus).toBe("SKIPPED_DRY_RUN");
  });
});

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function newSimulator(overrides: Partial<ConstructorParameters<typeof ProductionClaimSimulator>[0]> = {}) {
  return new ProductionClaimSimulator({
    cooldownHours: 24,
    singleSignalRiskCapUsdt: 50,
    dailyRiskBudgetUsdt: 600,
    maxEmailsPerDay: 10,
    maxEmailsPerScan: 6,
    emailObservationEnabled: true,
    ...overrides,
  });
}

function sampleTrade(exitTime: number): BacktestTrade {
  return {
    symbol: "BTCUSDT",
    side: "SHORT",
    strategyFamily: "TREND",
    entryTime: T0,
    exitTime,
    score: 81,
    entryPrice: 100,
    exitPrice: 99,
    rMultiple: 1,
    pnlUsdt: 49,
    grossPnlUsdt: 50,
    feesUsdt: 1,
    fundingUsdt: 0,
    slippageUsdt: 0,
    theoreticalRiskUsdt: 49,
    exitReason: "TIME_LIMIT",
  };
}
