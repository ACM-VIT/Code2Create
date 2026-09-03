import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const backendEnvironmentPath = fileURLToPath(
  new URL("../apps/backend/.env.local", import.meta.url),
);
if (existsSync(backendEnvironmentPath)) loadEnvFile(backendEnvironmentPath);

const { localConvexEnvironment } = await import("./local-development.mjs");

const backend = ["--filter", "@code2create/backend", "exec", "convex"];
const environmentInput = `${Object.entries(localConvexEnvironment)
  .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
  .join("\n")}\n`;
const windows = process.platform === "win32";
const result = spawnSync(windows ? "pnpm.cmd" : "pnpm", [...backend, "env", "set", "--force"], {
  input: environmentInput,
  encoding: "utf-8",
  ...(windows ? { shell: true } : {}),
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.status !== 0) {
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
