import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

type RuntimeEnvironment = Record<string, string | undefined>;
type CommandRunner = (command: string, args: readonly string[]) => number;

export function runVercelBuild(
  environment: RuntimeEnvironment = process.env,
  runCommand: CommandRunner = runChildProcess,
): number {
  const isProduction =
    environment.VERCEL_ENV === "production" ||
    environment.VERCEL_TARGET_ENV === "production";

  if (isProduction) {
    const deployCheckExitCode = runCommand(pnpmCommand(), ["deploy:check"]);
    if (deployCheckExitCode !== 0) {
      return deployCheckExitCode;
    }
  }

  return runCommand(pnpmCommand(), ["build"]);
}

function runChildProcess(command: string, args: readonly string[]): number {
  const result = spawnSync(command, args, {
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`Failed to run ${command}: ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}

function pnpmCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runVercelBuild());
}
