import { spawnSync } from "node:child_process";

type CloudflareEnvironment = "staging" | "production";
type ReleaseEnvironment = Readonly<Record<string, string | undefined>>;

function required(environment: ReleaseEnvironment, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Set ${name} for this release environment.`);
  return value;
}

function cloudflareEnvironment(environment: ReleaseEnvironment): CloudflareEnvironment {
  const value = required(environment, "CLOUDFLARE_ENV");
  if (value !== "staging" && value !== "production") {
    throw new Error("CLOUDFLARE_ENV must be staging or production.");
  }
  return value;
}

export function cloudflareWorkerName(baseName: string, environment: ReleaseEnvironment) {
  if (!/^code2create-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(baseName)) {
    throw new Error("The Cloudflare Worker base name is invalid.");
  }
  return cloudflareEnvironment(environment) === "staging" ? `${baseName}-staging` : baseName;
}

export function cloudflareDeployArguments(
  baseName: string,
  environment: ReleaseEnvironment,
  configPath = "dist/wrangler.json",
) {
  const releaseId = required(environment, "VITE_RELEASE_ID");
  if (releaseId.length > 120) {
    throw new Error("VITE_RELEASE_ID must be no longer than 120 characters.");
  }
  return [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    configPath,
    "--name",
    cloudflareWorkerName(baseName, environment),
    "--strict",
    "--message",
    releaseId,
  ];
}

if (import.meta.main) {
  const baseName = process.argv[2];
  if (!baseName) throw new Error("Pass the Cloudflare Worker base name.");
  const configPath = process.argv[3];

  const wranglerEnvironment = { ...process.env };
  delete wranglerEnvironment.CLOUDFLARE_ENV;

  const result = spawnSync("pnpm", cloudflareDeployArguments(baseName, process.env, configPath), {
    env: wranglerEnvironment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Wrangler stopped after signal ${result.signal}.`);
  if (result.status === null) throw new Error("Wrangler exited without a status code.");
  process.exitCode = result.status;
}
