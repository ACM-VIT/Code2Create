import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { z } from "zod";

const args = process.argv.slice(2);
if (args.length === 0) throw new Error("Pass a Wrangler command.");

const token = await cloudflareToken();
await run("pnpm", ["exec", "wrangler", ...args], {
  ...process.env,
  ...(token ? { CLOUDFLARE_API_TOKEN: token } : {}),
});

async function cloudflareToken() {
  const explicit = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (explicit) return explicit;

  const configurationPath = join(homedir(), ".cf/config.toml");
  if (!existsSync(configurationPath)) return undefined;
  await run("cf", ["auth", "whoami"], process.env, true);
  const configuration = await readFile(configurationPath, "utf8");
  const value = configuration.match(/^access_token\s*=\s*(.+)$/mu)?.[1];
  if (!value) throw new Error("The authenticated cf CLI has no access token.");
  return z.string().min(32).parse(JSON.parse(value));
}

async function run(
  command: string,
  commandArgs: string[],
  environment: NodeJS.ProcessEnv,
  quiet = false,
) {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, commandArgs, {
      env: environment,
      stdio: quiet ? "ignore" : "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} failed with ${signal ?? `exit code ${code}`}.`));
    });
  });
}
