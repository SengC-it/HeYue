import { describe, expect, it } from "vitest";
import { getHealthAttestation } from "../app/api/health/route";
import { isUsableRuntimeValue } from "../lib/config";
import { runVercelBuild } from "../scripts/vercel-build";

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const productionEnvironment = {
  HY_SUPABASE_URL: "https://jfvbikivtpfjgfsnggiz.supabase.co",
  HY_SUPABASE_SERVICE_ROLE_KEY: "ci-dummy-service-role-key",
  HY_CRON_SECRET: "ci-dummy-cron-secret",
  HY_STRATEGY_ADMIN_SECRET: "ci-dummy-admin-secret",
  HY_STRATEGY_SOURCE: "DB",
  HY_STRATEGY_STAGE: "PAPER",
  HY_STRATEGY_VERSION: "hy-paper-candidate-v2",
  HY_PAPER_TRADING_ENABLED: "true",
  HY_DRY_RUN: "false",
  HY_GMAIL_SMTP_USER: "ci-dummy@example.com",
  HY_GMAIL_SMTP_APP_PASSWORD: "ci-dummy-password",
  HY_GMAIL_RECIPIENT: "ci-dummy@example.com",
} as const;

describe("Vercel build gate", () => {
  it("runs deploy:check before build for VERCEL_ENV=production", () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    const exitCode = runVercelBuild(
      { VERCEL_ENV: "production" },
      (command, args) => {
        calls.push({ command, args });
        return 0;
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      { command: pnpmCommand, args: ["deploy:check"] },
      { command: pnpmCommand, args: ["build"] },
    ]);
  });

  it("runs deploy:check before build for VERCEL_TARGET_ENV=production", () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    const exitCode = runVercelBuild(
      { VERCEL_TARGET_ENV: "production" },
      (command, args) => {
        calls.push({ command, args });
        return 0;
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      { command: pnpmCommand, args: ["deploy:check"] },
      { command: pnpmCommand, args: ["build"] },
    ]);
  });

  it("runs deploy:check before build for HY_DEPLOY_TARGET=production", () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    const exitCode = runVercelBuild(
      { HY_DEPLOY_TARGET: "production" },
      (command, args) => {
        calls.push({ command, args });
        return 0;
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      { command: pnpmCommand, args: ["deploy:check"] },
      { command: pnpmCommand, args: ["build"] },
    ]);
  });

  it("runs only build for Preview", () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    const exitCode = runVercelBuild(
      { VERCEL_ENV: "preview" },
      (command, args) => {
        calls.push({ command, args });
        return 0;
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([{ command: pnpmCommand, args: ["build"] }]);
  });

  it("runs only build for Development", () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    const exitCode = runVercelBuild(
      { VERCEL_ENV: "development" },
      (command, args) => {
        calls.push({ command, args });
        return 0;
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([{ command: pnpmCommand, args: ["build"] }]);
  });

  it("fails closed when deployment environment markers are missing", () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    const exitCode = runVercelBuild({}, (command, args) => {
      calls.push({ command, args });
      return 0;
    });

    expect(exitCode).not.toBe(0);
    expect(calls).toEqual([]);
  });

  it("fails closed when deployment environment markers are unknown", () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    const exitCode = runVercelBuild(
      { VERCEL_ENV: "unknown" },
      (command, args) => {
        calls.push({ command, args });
        return 0;
      },
    );

    expect(exitCode).not.toBe(0);
    expect(calls).toEqual([]);
  });

  it("lets Production win over a conflicting deployment sentinel", () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    const exitCode = runVercelBuild(
      { VERCEL_ENV: "production", HY_DEPLOY_TARGET: "preview" },
      (command, args) => {
        calls.push({ command, args });
        return 0;
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      { command: pnpmCommand, args: ["deploy:check"] },
      { command: pnpmCommand, args: ["build"] },
    ]);
  });

  it("stops before build when deploy:check fails", () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    const exitCode = runVercelBuild(
      { VERCEL_ENV: "production" },
      (command, args) => {
        calls.push({ command, args });
        return 17;
      },
    );

    expect(exitCode).toBe(17);
    expect(calls).toEqual([{ command: pnpmCommand, args: ["deploy:check"] }]);
  });
});

describe("runtime value redaction", () => {
  it.each([undefined, "", "   ", "[SENSITIVE]", "[REDACTED]", " [sensitive] ", " [redacted] "]) (
    "rejects %s",
    (value) => {
      expect(isUsableRuntimeValue(value)).toBe(false);
    },
  );

  it("accepts a real non-empty value", () => {
    expect(isUsableRuntimeValue("ci-dummy-value")).toBe(true);
  });
});

describe("health runtime attestation", () => {
  it("reports the safe PAPER runtime without secret fields or values", () => {
    const payload = getHealthAttestation(productionEnvironment);

    expect(payload).toMatchObject({
      ok: true,
      service: "heyue-signal-scanner",
      mode: "alert-only",
      safety: {
        strategySource: "DB",
        strategyStage: "PAPER",
        strategyVersion: "hy-paper-candidate-v2",
        paperTradingEnabled: true,
        dryRun: false,
        supabaseProjectRef: "jfvbikivtpfjgfsnggiz",
        exchangeCredentialsConfigured: false,
        autoTrading: false,
      },
    });

    const serialized = JSON.stringify(payload);
    for (const value of [
      productionEnvironment.HY_SUPABASE_SERVICE_ROLE_KEY,
      productionEnvironment.HY_CRON_SECRET,
      productionEnvironment.HY_STRATEGY_ADMIN_SECRET,
      productionEnvironment.HY_GMAIL_SMTP_APP_PASSWORD,
    ]) {
      expect(serialized).not.toContain(value);
    }
    for (const field of [
      "HY_SUPABASE_SERVICE_ROLE_KEY",
      "HY_SUPABASE_SECRET_KEY",
      "HY_CRON_SECRET",
      "HY_STRATEGY_ADMIN_SECRET",
      "HY_GMAIL_SMTP_APP_PASSWORD",
      "HY_BINANCE_API_KEY",
      "HY_BINANCE_API_SECRET",
      "HY_BINANCE_SECRET_KEY",
      "BINANCE_API_KEY",
      "BINANCE_API_SECRET",
      "BINANCE_SECRET_KEY",
    ]) {
      expect(serialized).not.toContain(field);
    }
  });

  it("fails closed when a redacted runtime value is present", () => {
    expect(() => getHealthAttestation({
      ...productionEnvironment,
      HY_DRY_RUN: "[SENSITIVE]",
    })).toThrow();
  });
});
