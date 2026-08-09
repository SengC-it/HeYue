import { basename, resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";

const expectedProjectRef = "jfvbikivtpfjgfsnggiz";
const expectedSupabaseUrl = `https://${expectedProjectRef}.supabase.co`;
const root = resolve(import.meta.dirname, "..");
const failures: string[] = [];

check(basename(root).toLowerCase() === "heyue", "working directory must be the HeYue project");
check(process.env.SUPABASE_URL === expectedSupabaseUrl, "SUPABASE_URL must target the approved HeYue database project");
check(Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY), "a server-only Supabase service key is required");
check(Boolean(process.env.CRON_SECRET), "CRON_SECRET is required");
check(Boolean(process.env.STRATEGY_ADMIN_SECRET), "STRATEGY_ADMIN_SECRET is required");
check(process.env.CS_STRATEGY_SOURCE === "DB", "CS_STRATEGY_SOURCE must be DB");
check(process.env.CS_STRATEGY_STAGE === "PAPER", "observation deployment must remain in PAPER stage");
check(process.env.CS_STRATEGY_VERSION?.startsWith("hy-") === true, "strategy version must use the hy- namespace");
check(process.env.CS_PAPER_TRADING_ENABLED === "true", "paper ledger must be enabled");
check(process.env.CS_DRY_RUN === "false", "email observation requires CS_DRY_RUN=false");
check(Boolean(process.env.GMAIL_SMTP_USER), "GMAIL_SMTP_USER is required for observation email");
check(Boolean(process.env.GMAIL_SMTP_APP_PASSWORD), "GMAIL_SMTP_APP_PASSWORD is required for observation email");
check(Boolean(process.env.GMAIL_RECIPIENT), "GMAIL_RECIPIENT is required for observation email");

for (const forbidden of ["BINANCE_API_KEY", "BINANCE_API_SECRET", "BINANCE_SECRET_KEY"]) {
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
