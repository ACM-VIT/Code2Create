import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const backendRoot = fileURLToPath(new URL("../..", import.meta.url));
export const workspaceRoot = fileURLToPath(new URL("../../../..", import.meta.url));

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} through the recovery operator's secret manager.`);
  return value;
}

function deployKeyEnvironment(deployKey: string) {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    "C2C_PRODUCTION_CONVEX_DEPLOY_KEY",
    "C2C_STAGING_CONVEX_DEPLOY_KEY",
    "C2C_RECOVERY_S3_ACCESS_KEY_ID",
    "C2C_RECOVERY_S3_SECRET_ACCESS_KEY",
    "C2C_RECOVERY_S3_KMS_KEY_ID",
  ]) {
    Reflect.deleteProperty(environment, name);
  }
  environment.CONVEX_DEPLOY_KEY = deployKey;
  return environment;
}

export function productionDeployment(argument: string) {
  const configured = requiredEnvironment("C2C_PRODUCTION_DEPLOYMENT");
  if (argument !== configured) {
    throw new Error("The source deployment must exactly match C2C_PRODUCTION_DEPLOYMENT.");
  }
  const reference = argument.split(":").at(-1)?.toLowerCase();
  if (reference !== undefined && ["dev", "local", "staging"].includes(reference)) {
    throw new Error("The production backup source cannot be dev, local, or staging.");
  }
  return configured;
}

export function stagingDeployment(argument: string, confirmation: string) {
  const configured = requiredEnvironment("C2C_STAGING_DEPLOYMENT");
  const production = requiredEnvironment("C2C_PRODUCTION_DEPLOYMENT");
  if (argument !== configured || confirmation !== configured) {
    throw new Error(
      "Both staging arguments must exactly match C2C_STAGING_DEPLOYMENT before replacement is allowed.",
    );
  }
  const reference = argument.split(":").at(-1)?.toLowerCase();
  if (
    argument === production ||
    (reference !== undefined && ["prod", "production", "dev", "local"].includes(reference))
  ) {
    throw new Error("The restore rehearsal refuses production, dev, and local deployments.");
  }
  return configured;
}

function waitForCommand(child: ReturnType<typeof spawn>, label: string) {
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const outcome = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
      reject(new Error(`${label} failed with ${outcome}.`));
    });
  });
}

async function runConvex(args: string[], deployKeyName: string) {
  const deployKey = requiredEnvironment(deployKeyName);
  const child = spawn("pnpm", ["exec", "convex", ...args], {
    cwd: backendRoot,
    env: deployKeyEnvironment(deployKey),
    stdio: "inherit",
  });
  await waitForCommand(child, `convex ${args[0] ?? "command"}`);
}

export async function exportProductionSnapshot(deployment: string, destinationPath: string) {
  await runConvex(
    ["export", "--deployment", deployment, "--include-file-storage", "--path", destinationPath],
    "C2C_PRODUCTION_CONVEX_DEPLOY_KEY",
  );
}

export async function exportStagingSnapshot(deployment: string, destinationPath: string) {
  await runConvex(
    ["export", "--deployment", deployment, "--include-file-storage", "--path", destinationPath],
    "C2C_STAGING_CONVEX_DEPLOY_KEY",
  );
}

export async function replaceStagingFromSnapshot(deployment: string, snapshotPath: string) {
  await runConvex(
    ["import", "--deployment", deployment, "--replace-all", "--yes", snapshotPath],
    "C2C_STAGING_CONVEX_DEPLOY_KEY",
  );
}

export async function convexCliVersion() {
  const deployKey = requiredEnvironment("C2C_PRODUCTION_CONVEX_DEPLOY_KEY");
  const child = spawn("pnpm", ["exec", "convex", "--version"], {
    cwd: backendRoot,
    env: deployKeyEnvironment(deployKey),
    stdio: ["ignore", "pipe", "inherit"],
  });
  const stdout = child.stdout;
  if (!stdout) {
    child.kill();
    throw new Error("Could not read the Convex CLI version.");
  }
  stdout.setEncoding("utf8");
  let value = "";
  stdout.on("data", (chunk: string) => {
    value += chunk;
  });
  await waitForCommand(child, "convex --version");
  const version = value.trim();
  if (!version) throw new Error("Convex CLI returned no version.");
  return version;
}
