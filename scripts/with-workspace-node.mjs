import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

const workspaceNodeVersion = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();

function findWorkspaceNodeDirectory() {
  const candidates = [
    process.env.NVM_BIN,
    dirname(process.execPath),
    ...(process.env.PATH ?? "").split(delimiter),
  ];
  const visited = new Set();
  const executableName = process.platform === "win32" ? "node.exe" : "node";

  for (const directory of candidates) {
    if (!directory || visited.has(directory)) continue;
    visited.add(directory);
    const executable = join(directory, executableName);
    try {
      const version = execFileSync(executable, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1_000,
      }).trim();
      if (version === `v${workspaceNodeVersion}`) return directory;
    } catch {
      // Continue until the repository's configured runtime is found.
    }
  }

  throw new Error(
    `Node.js ${workspaceNodeVersion} is required. Install it or run nvm install ${workspaceNodeVersion}.`,
  );
}

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("A command is required.");

const workspaceNodeDirectory = findWorkspaceNodeDirectory();
const child = spawn(command, args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PATH: [workspaceNodeDirectory, process.env.PATH].filter(Boolean).join(delimiter),
  },
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
