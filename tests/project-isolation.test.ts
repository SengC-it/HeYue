import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
});
