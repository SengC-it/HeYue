import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

type RuntimeEnvironment = Record<string, string | undefined>;
type CommandRunner = (command: string, args: readonly string[]) => number;
type DeploymentMode = "production" | "non-production" | "unknown";

export function runVercelBuild(
  environment: RuntimeEnvironment = process.env,
  runCommand: CommandRunner = runChildProcess,
): number {
  const deploymentMode = getDeploymentMode(environment);

  if (deploymentMode === "unknown") {
    console.error("Unable to determine a safe Vercel deployment environment; refusing build.");
    return 1;
  }

  if (deploymentMode === "production") {
    const deployCheckExitCode = runCommand(pnpmCommand(), ["deploy:check"]);
    if (deployCheckExitCode !== 0) return deployCheckExitCode;
  }

  return runCommand(pnpmCommand(), ["build"]);
}

function getDeploymentMode(environment: RuntimeEnvironment): DeploymentMode {
  const isProduction =
    environment.HY_DEPLOY_TARGET === "production" ||
    environment.VERCEL_ENV === "production" ||
    environment.VERCEL_TARGET_ENV === "production";

  if (isProduction) return "production";

  const isExplicitNonProduction =
    environment.VERCEL_ENV === "preview" ||
    environment.VERCEL_ENV === "development" ||
    environment.VERCEL_TARGET_ENV === "preview" ||
    environment.VERCEL_TARGET_ENV === "development";

  return isExplicitNonProduction ? "non-production" : "unknown";
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
