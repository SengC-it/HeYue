import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { isUsableRuntimeValue, readHyEnv } from "@/lib/config";

const expectedProjectRef = "jfvbikivtpfjgfsnggiz";
const expectedSupabaseUrl = `https://${expectedProjectRef}.supabase.co`;
const defaultRoot = resolve(import.meta.dirname, "..");

export type RuntimeEnvironment = Record<string, string | undefined>;

export function getDeploymentReadinessFailures(
  root: string,
  environment: RuntimeEnvironment = process.env,
): string[] {
  const failures: string[] = [];
  const check = (condition: boolean, message: string): void => {
    if (!condition) failures.push(message);
  };
  const packageJson = readJsonFile(resolve(root, "package.json"));
  const vercelJson = readJsonFile(resolve(root, "vercel.json"));

  check(packageJson !== undefined, "package.json is required and must be valid JSON");
  check(vercelJson !== undefined, "vercel.json is required and must be valid JSON");

  if (packageJson) {
    check(packageJson.name === "heyue-contract-signal-scanner", "package.json must identify the HeYue application");
    const scripts = asRecord(packageJson.scripts);
    check(typeof scripts?.["deploy:check"] === "string" && scripts["deploy:check"].trim() !== "", "package.json must define deploy:check");
    check(scripts?.["vercel:build"] === "tsx scripts/vercel-build.ts", "package.json vercel:build must run the production gate");
  }
  if (vercelJson) {
    check(vercelJson.buildCommand === "pnpm vercel:build", "vercel.json buildCommand must be pnpm vercel:build");
  }

  const supabaseUrl = readHyEnv("HY_SUPABASE_URL", environment);
  const serviceRoleKey = readHyEnv("HY_SUPABASE_SERVICE_ROLE_KEY", environment);
  const secretKey = readHyEnv("HY_SUPABASE_SECRET_KEY", environment);
  const cronSecret = readHyEnv("HY_CRON_SECRET", environment);
  const strategyAdminSecret = readHyEnv("HY_STRATEGY_ADMIN_SECRET", environment);
  const strategySource = readHyEnv("HY_STRATEGY_SOURCE", environment);
  const strategyStage = readHyEnv("HY_STRATEGY_STAGE", environment);
  const strategyVersion = readHyEnv("HY_STRATEGY_VERSION", environment);
  const paperTradingEnabled = readHyEnv("HY_PAPER_TRADING_ENABLED", environment);
  const dryRun = readHyEnv("HY_DRY_RUN", environment);
  const smtpUser = readHyEnv("HY_GMAIL_SMTP_USER", environment);
  const smtpPassword = readHyEnv("HY_GMAIL_SMTP_APP_PASSWORD", environment);
  const recipient = readHyEnv("HY_GMAIL_RECIPIENT", environment);

  check(isUsableRuntimeValue(supabaseUrl) && supabaseUrl === expectedSupabaseUrl, "HY_SUPABASE_URL must target the approved HeYue database project");
  check(isUsableRuntimeValue(serviceRoleKey) || isUsableRuntimeValue(secretKey), "a server-only Supabase service key is required");
  check(isUsableRuntimeValue(cronSecret), "HY_CRON_SECRET is required");
  check(isUsableRuntimeValue(strategyAdminSecret), "HY_STRATEGY_ADMIN_SECRET is required");
  check(isUsableRuntimeValue(strategySource) && strategySource === "DB", "HY_STRATEGY_SOURCE must be DB");
  check(isUsableRuntimeValue(strategyStage) && strategyStage === "PAPER", "observation deployment must remain in PAPER stage");
  check(isUsableRuntimeValue(strategyVersion) && strategyVersion.startsWith("hy-"), "strategy version must use the hy- namespace");
  check(isUsableRuntimeValue(paperTradingEnabled) && paperTradingEnabled === "true", "paper ledger must be enabled");
  check(isUsableRuntimeValue(dryRun) && dryRun === "false", "email observation requires HY_DRY_RUN=false");
  check(isUsableRuntimeValue(smtpUser), "HY_GMAIL_SMTP_USER is required for observation email");
  check(isUsableRuntimeValue(smtpPassword), "HY_GMAIL_SMTP_APP_PASSWORD is required for observation email");
  check(isUsableRuntimeValue(recipient), "HY_GMAIL_RECIPIENT is required for observation email");

  for (const forbidden of [
    "HY_BINANCE_API_KEY",
    "HY_BINANCE_API_SECRET",
    "HY_BINANCE_SECRET_KEY",
    "BINANCE_API_KEY",
    "BINANCE_API_SECRET",
    "BINANCE_SECRET_KEY",
  ]) {
    check(!environment[forbidden], `${forbidden} must not be configured in the alert-only deployment`);
  }

  try {
    const activeSqlFiles = [
      ...readdirSync(resolve(root, "supabase", "migrations"))
        .filter((name) => name.endsWith(".sql"))
        .map((name) => resolve(root, "supabase", "migrations", name)),
      resolve(root, "supabase", "scheduler.sql"),
    ];
    for (const file of activeSqlFiles) {
      const sql = readFileSync(file, "utf8");
      check(!/\b(?:cs|bca)_/i.test(sql), `foreign project prefix found in ${file}`);
    }
  } catch {
    check(false, "active Supabase SQL files are required");
  }

  return failures;
}

export function runDeploymentReadinessCheck(
  root: string = defaultRoot,
  environment: RuntimeEnvironment = process.env,
): number {
  const failures = getDeploymentReadinessFailures(root, environment);
  if (failures.length > 0) {
    console.error("HeYue deployment gate failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    return 1;
  }

  console.log("HeYue deployment gate passed: PAPER, email observation, hy_ database isolation, no exchange credentials.");
  return 0;
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return asRecord(value);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runDeploymentReadinessCheck());
}
