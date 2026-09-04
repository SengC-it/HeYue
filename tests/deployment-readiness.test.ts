import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { getDeploymentReadinessFailures } from "../scripts/check-deployment-readiness";

const validEnvironment = {
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
};

describe("content-based deployment identity", () => {
  it("passes a valid HeYue project in an arbitrary directory", () => {
    const root = createProjectFixture("release-12345-");
    try {
      expect(basename(root).toLowerCase()).not.toBe("heyue");
      expect(getDeploymentReadinessFailures(root, validEnvironment)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes a valid HeYue project whose directory is not named heyue", () => {
    const root = createProjectFixture("remote-build-");
    try {
      expect(getDeploymentReadinessFailures(root, validEnvironment)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when package.json has the wrong project name", () => {
    const root = createProjectFixture("wrong-name-");
    try {
      updateJson(join(root, "package.json"), (packageJson) => {
        packageJson.name = "different-project";
      });

      expect(getDeploymentReadinessFailures(root, validEnvironment)).toContain(
        "package.json must identify the HeYue application",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when package.json is missing the expected vercel:build script", () => {
    const root = createProjectFixture("missing-script-");
    try {
      updateJson(join(root, "package.json"), (packageJson) => {
        const scripts = packageJson.scripts as Record<string, unknown>;
        delete scripts["vercel:build"];
      });

      expect(getDeploymentReadinessFailures(root, validEnvironment)).toContain(
        "package.json vercel:build must run the production gate",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when vercel.json has a different buildCommand", () => {
    const root = createProjectFixture("wrong-build-command-");
    try {
      updateJson(join(root, "vercel.json"), (vercelJson) => {
        vercelJson.buildCommand = "pnpm build";
      });

      expect(getDeploymentReadinessFailures(root, validEnvironment)).toContain(
        "vercel.json buildCommand must be pnpm vercel:build",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["package.json", "missing-package-"],
    ["vercel.json", "missing-vercel-"],
  ])("fails closed when %s is missing", (file, prefix) => {
    const root = createProjectFixture(prefix);
    try {
      rmSync(join(root, file));
      expect(getDeploymentReadinessFailures(root, validEnvironment)).toContain(
        `${file} is required and must be valid JSON`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("existing production safety checks", () => {
  it("passes with the safe PAPER observation environment", () => {
    const root = createProjectFixture("safe-paper-");
    try {
      expect(getDeploymentReadinessFailures(root, validEnvironment)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["[SENSITIVE]", "[REDACTED]"]) (
    "rejects sensitive placeholders in runtime values: %s",
    (value) => {
      const root = createProjectFixture("redacted-value-");
      try {
        expect(getDeploymentReadinessFailures(root, {
          ...validEnvironment,
          HY_DRY_RUN: value,
        })).toContain("email observation requires HY_DRY_RUN=false");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects Binance private credentials", () => {
    const root = createProjectFixture("private-credential-");
    try {
      expect(getDeploymentReadinessFailures(root, {
        ...validEnvironment,
        HY_BINANCE_API_KEY: "ci-dummy-binance-key",
      })).toContain(
        "HY_BINANCE_API_KEY must not be configured in the alert-only deployment",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function createProjectFixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "supabase", "migrations"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "heyue-contract-signal-scanner",
    scripts: {
      "deploy:check": "tsx scripts/check-deployment-readiness.ts",
      "vercel:build": "tsx scripts/vercel-build.ts",
    },
  }));
  writeFileSync(join(root, "vercel.json"), JSON.stringify({ buildCommand: "pnpm vercel:build" }));
  writeFileSync(join(root, "supabase", "migrations", "001.sql"), "-- hy_ schema");
  writeFileSync(join(root, "supabase", "scheduler.sql"), "-- hy_ scheduler");
  return root;
}

function updateJson(path: string, update: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  update(value);
  writeFileSync(path, JSON.stringify(value));
}
