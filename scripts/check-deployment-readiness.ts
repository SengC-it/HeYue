import { basename, resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { isUsableRuntimeValue, readHyEnv } from "@/lib/config";

const expectedProjectRef = "jfvbikivtpfjgfsnggiz";
const expectedSupabaseUrl = `https://${expectedProjectRef}.supabase.co`;
const root = resolve(import.meta.dirname, "..");
const failures: string[] = [];

check(basename(root).toLowerCase() === "heyue", "working directory must be the HeYue project");
const supabaseUrl = readHyEnv("HY_SUPABASE_URL");
const serviceRoleKey = readHyEnv("HY_SUPABASE_SERVICE_ROLE_KEY");
const secretKey = readHyEnv("HY_SUPABASE_SECRET_KEY");
const cronSecret = readHyEnv("HY_CRON_SECRET");
const strategyAdminSecret = readHyEnv("HY_STRATEGY_ADMIN_SECRET");
const strategySource = readHyEnv("HY_STRATEGY_SOURCE");
const strategyStage = readHyEnv("HY_STRATEGY_STAGE");
const strategyVersion = readHyEnv("HY_STRATEGY_VERSION");
const paperTradingEnabled = readHyEnv("HY_PAPER_TRADING_ENABLED");
const dryRun = readHyEnv("HY_DRY_RUN");
const smtpUser = readHyEnv("HY_GMAIL_SMTP_USER");
const smtpPassword = readHyEnv("HY_GMAIL_SMTP_APP_PASSWORD");
const recipient = readHyEnv("HY_GMAIL_RECIPIENT");

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
  check(!process.env[forbidden], `${forbidden} must not be configured in the alert-only deployment`);
}

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

if (failures.length > 0) {
  console.error("HeYue deployment gate failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("HeYue deployment gate passed: PAPER, email observation, hy_ database isolation, no exchange credentials.");

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}
