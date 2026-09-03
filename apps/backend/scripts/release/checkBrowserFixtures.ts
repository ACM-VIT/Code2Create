import { spawn } from "node:child_process";

import { readBrowserFixtureConfiguration } from "./browserFixtureEnvironment.ts";

const configuration = readBrowserFixtureConfiguration(process.env);
const functionArgs = JSON.stringify(configuration);

const child = spawn(
  "pnpm",
  ["exec", "convex", "run", "releaseVerification:assertReady", functionArgs],
  { env: process.env, stdio: "inherit" },
);

const exitCode = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) {
      reject(new Error(`Convex fixture verification stopped with signal ${signal}.`));
      return;
    }
    resolve(code ?? 1);
  });
});

if (exitCode !== 0) process.exitCode = exitCode;
