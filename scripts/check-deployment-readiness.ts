import { basename, resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { readHyEnv } from "@/lib/config";

const expectedProjectRef = "jfvbikivtpfjgfsnggiz";
const expectedSupabaseUrl = `https://${expectedProjectRef}.supabase.co`;
const root = resolve(import.meta.dirname, "..");
const failures: string[] = [];

check(basename(root).toLowerCase() === "heyue", "working directory must be the HeYue project");
check(readHyEnv("HY_SUPABASE_URL") === expectedSupabaseUrl, "HY_SUPABASE_URL must target the approved HeYue database project");
check(Boolean(readHyEnv("HY_SUPABASE_SERVICE_ROLE_KEY") ?? readHyEnv("HY_SUPABASE_SECRET_KEY")), "a server-only Supabase service key is required");
check(Boolean(readHyEnv("HY_CRON_SECRET")), "HY_CRON_SECRET is required");
check(Boolean(readHyEnv("HY_STRATEGY_ADMIN_SECRET")), "HY_STRATEGY_ADMIN_SECRET is required");
check(readHyEnv("HY_STRATEGY_SOURCE") === "DB", "HY_STRATEGY_SOURCE must be DB");
check(readHyEnv("HY_STRATEGY_STAGE") === "PAPER", "observation deployment must remain in PAPER stage");
check(readHyEnv("HY_STRATEGY_VERSION")?.startsWith("hy-") === true, "strategy version must use the hy- namespace");
check(readHyEnv("HY_PAPER_TRADING_ENABLED") === "true", "paper ledger must be enabled");
check(readHyEnv("HY_DRY_RUN") === "false", "email observation requires HY_DRY_RUN=false");
check(Boolean(readHyEnv("HY_GMAIL_SMTP_USER")), "HY_GMAIL_SMTP_USER is required for observation email");
check(Boolean(readHyEnv("HY_GMAIL_SMTP_APP_PASSWORD")), "HY_GMAIL_SMTP_APP_PASSWORD is required for observation email");
check(Boolean(readHyEnv("HY_GMAIL_RECIPIENT")), "HY_GMAIL_RECIPIENT is required for observation email");

for (const forbidden of ["HY_BINANCE_API_KEY", "HY_BINANCE_API_SECRET", "HY_BINANCE_SECRET_KEY"]) {
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
