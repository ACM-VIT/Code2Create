import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, open, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { updateChannelSchema } from "../src/contracts.ts";

const updatesDirectory = resolve(import.meta.dirname, "..");
const channel = updateChannelSchema.parse(process.argv[2]);
const environmentPath = join(updatesDirectory, `.env.${channel}.local`);
const lockPath = join(updatesDirectory, `.configure-${channel}.lock`);

let lock;
try {
  lock = await open(lockPath, "wx");
} catch {
  throw new Error(`Another ${channel} update configuration is already running.`);
}

try {
  const current = existsSync(environmentPath) ? await readFile(environmentPath, "utf8") : "";
  const matches = [...current.matchAll(/^C2C_UPDATES_ADMIN_TOKEN=(.*)$/gmu)];
  if (matches.length > 1) {
    throw new Error(`${environmentPath} contains more than one C2C_UPDATES_ADMIN_TOKEN.`);
  }

  const existingToken = matches[0]?.[1]?.trim();
  const token =
    existingToken !== undefined && existingToken.length > 0
      ? existingToken
      : Buffer.from(randomBytes(48)).toString("base64url");
  if (token.length < 32 || /\s/u.test(token)) {
    throw new Error("The existing C2C_UPDATES_ADMIN_TOKEN is invalid.");
  }

  let next = current;
  if (existingToken === undefined || existingToken.length === 0) {
    next =
      matches.length === 1
        ? current.replace(/^C2C_UPDATES_ADMIN_TOKEN=.*$/mu, `C2C_UPDATES_ADMIN_TOKEN=${token}`)
        : appendToken(current, token);
  }

  const privateKeyMatches = [...next.matchAll(/^C2C_UPDATE_PRIVATE_KEY_PATH=(.*)$/gmu)];
  if (privateKeyMatches.length > 1) {
    throw new Error(`${environmentPath} contains more than one C2C_UPDATE_PRIVATE_KEY_PATH.`);
  }
  const defaultPrivateKeyPath = join(homedir(), ".config/code2create/updates/private-key.pem");
  const configuredPrivateKeyPath = process.env.C2C_UPDATE_PRIVATE_KEY_PATH?.trim();
  const privateKeyPath =
    configuredPrivateKeyPath !== undefined && configuredPrivateKeyPath.length > 0
      ? configuredPrivateKeyPath
      : existsSync(defaultPrivateKeyPath)
        ? defaultPrivateKeyPath
        : undefined;
  const existingPrivateKeyPath = privateKeyMatches[0]?.[1]?.trim();
  if (
    (existingPrivateKeyPath === undefined || existingPrivateKeyPath.length === 0) &&
    privateKeyPath !== undefined
  ) {
    const line = `C2C_UPDATE_PRIVATE_KEY_PATH=${JSON.stringify(privateKeyPath)}`;
    next =
      privateKeyMatches.length === 1
        ? next.replace(/^C2C_UPDATE_PRIVATE_KEY_PATH=.*$/mu, line)
        : appendLine(next, line);
  }

  if (next !== current) {
    await writeFile(environmentPath, next, { encoding: "utf8", mode: 0o600 });
  }
  await chmod(environmentPath, 0o600);
  await setWorkerSecret(channel, token);
  console.log(`Configured the ${channel} update Worker admin token.`);
} finally {
  await lock.close();
  await unlink(lockPath);
}

function appendToken(current: string, token: string) {
  return appendLine(current, `C2C_UPDATES_ADMIN_TOKEN=${token}`);
}

function appendLine(current: string, line: string) {
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  return `${current}${separator}${line}\n`;
}

async function setWorkerSecret(selectedChannel: "staging" | "production", value: string) {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [
        join(updatesDirectory, "scripts/wrangler.ts"),
        "secret",
        "put",
        "C2C_UPDATES_ADMIN_TOKEN",
        "--env",
        selectedChannel,
        "--config",
        "wrangler.jsonc",
      ],
      { cwd: updatesDirectory, stdio: ["pipe", "inherit", "inherit"] },
    );
    child.stdin.end(`${value}\n`);
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Wrangler failed with ${signal ?? `exit code ${code}`}.`));
    });
  });
}
