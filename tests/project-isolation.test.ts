import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readHyEnv } from "../lib/config";

const root = resolve(import.meta.dirname, "..");

describe("HeYue project isolation", () => {
  it("keeps foreign table prefixes out of active database paths", () => {
    const activeFiles = [
      ...readdirSync(resolve(root, "supabase/migrations"))
        .filter((name) => name.endsWith(".sql"))
        .map((name) => resolve(root, "supabase/migrations", name)),
      resolve(root, "supabase/scheduler.sql"),
      resolve(root, "lib/services/signal-repository.ts"),
      resolve(root, "lib/services/strategy-repository.ts"),
      resolve(root, "lib/services/paper-trading.ts"),
    ];

    for (const file of activeFiles) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/\b(?:cs|bca)_/);
    }
  });

  it("keeps canonical runtime configuration on HY_* and isolates legacy fallback", () => {
    const envExample = readFileSync(resolve(root, ".env.example"), "utf8");
    const envNames = [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
    expect(envNames.every((name) => name.startsWith("HY_"))).toBe(true);
    expect(envExample).not.toMatch(/\b(?:CS|BCA)_/);

    expect(readHyEnv("HY_TOP_SYMBOLS", { HY_TOP_SYMBOLS: "10", CS_TOP_SYMBOLS: "100" })).toBe("10");
    expect(readHyEnv("HY_TOP_SYMBOLS", { CS_TOP_SYMBOLS: "10" })).toBe("10");
    expect(readHyEnv("HY_TOP_SYMBOLS", { BCA_TOP_SYMBOLS: "10" })).toBeUndefined();

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    readHyEnv("HY_CRON_SECRET", { CS_CRON_SECRET: "secret-value-must-not-leak" });
    expect(warning.mock.calls.flat().join(" ")).not.toContain("secret-value-must-not-leak");
    warning.mockRestore();
  });

  it("keeps foreign prefixes out of HeYue runtime source", () => {
    const runtimeFiles = [
      ...filesUnder(resolve(root, "app")),
      ...filesUnder(resolve(root, "lib")),
      ...filesUnder(resolve(root, "scripts")),
    ].filter((file) => !file.endsWith("lib\\config.ts") && !file.endsWith("lib/config.ts"));

    for (const file of runtimeFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/\b(?:CS|BCA)_[A-Z0-9_]+\b/);
      expect(source, file).not.toMatch(/(?:["'`])(?:cs|bca)_/i);
    }
  });

  it("uses an independent local Supabase project id", () => {
    const config = readFileSync(resolve(root, "supabase/config.toml"), "utf8");
    expect(config).toContain('project_id = "heyue"');
  });

  it("seeds only a PAPER candidate and keeps exchange execution disabled", () => {
    const migration = readFileSync(
      resolve(root, "supabase/migrations/20260809145729_hy_initial_schema.sql"),
      "utf8",
    );

    expect(migration).toContain("default 'DRAFT'");
    expect(migration).toContain("'DRAFT', 'PAPER', 'ACTIVE', 'RETIRED'");
    expect(migration).toContain("'hy-paper-candidate-v2'");
    expect(migration).toContain("'PAPER'");
    expect(migration).toContain('"exchange_orders_enabled":false');
  });

  it("defines the diagnostics table only in the hy namespace", () => {
    const migrationPath = resolve(root, "supabase/migrations/20260903090000_hy_scan_diagnostics.sql");
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).toContain("create table public.hy_scan_diagnostics");
    expect(migration).toContain("references public.hy_scan_runs(id)");
    expect(migration).not.toMatch(/create table public\.(?:cs|bca)_/i);
    expect(migration).not.toMatch(/create (?:or replace )?function public\.(?:cs|bca)_/i);
  });
});

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}
