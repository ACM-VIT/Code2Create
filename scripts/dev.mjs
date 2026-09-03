import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const workspace = new URL("..", import.meta.url);
const children = new Set();
const usesProcessGroups = process.platform !== "win32";
let stopping = false;
const fullStack = process.argv.includes("--full");

const localSurfaces = [
  {
    label: "Participant portal",
    healthUrl: "http://localhost:5180/",
    displayUrl: "http://localhost:5180",
  },
  {
    label: "Operations dashboard",
    healthUrl: "http://localhost:5181/",
    displayUrl: "http://localhost:5181",
  },
  ...(fullStack
    ? [
        {
          label: "Reviewer Metro",
          healthUrl: "http://localhost:8082/status",
          displayUrl: "http://localhost:8082",
        },
        {
          label: "Intelligence Worker",
          healthUrl: "http://localhost:8791/health",
          displayUrl: "http://localhost:8791/health",
        },
        {
          label: "Updates Worker",
          healthUrl: "http://localhost:8792/health",
          displayUrl: "http://localhost:8792/health",
        },
        {
          label: "Email Worker",
          healthUrl: "http://localhost:8793/health",
          displayUrl: "http://localhost:8793/health",
        },
        {
          label: "Voice Worker",
          healthUrl: "http://localhost:8794/health",
          displayUrl: "http://localhost:8794/health",
        },
      ]
    : []),
];

const applicationPackages = [
  "@code2create/web",
  "@code2create/ops",
  ...(fullStack
    ? [
        "@code2create/reviewer",
        "@code2create/intelligence",
        "@code2create/updates",
        "@code2create/email",
        "@code2create/voice",
      ]
    : []),
];

function start(args, onOutput) {
  const capturesOutput = onOutput !== undefined;
  const child = spawn("pnpm", args, {
    cwd: workspace,
    env: process.env,
    stdio: capturesOutput ? ["inherit", "pipe", "pipe"] : "inherit",
    detached: usesProcessGroups,
  });
  if (capturesOutput) {
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      onOutput(chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      onOutput(chunk.toString());
    });
  }
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function startBackend() {
  let markListenerReady = () => {};
  const listenerReady = new Promise((resolve) => {
    markListenerReady = resolve;
  });
  let markPushReady = () => {};
  const pushReady = new Promise((resolve) => {
    markPushReady = resolve;
  });
  let outputTail = "";
  let listenerWasReady = false;
  let pushWasReady = false;
  const child = start(["dev:backend"], (output) => {
    outputTail = `${outputTail}${output}`.slice(-4_096);
    if (!listenerWasReady && outputTail.includes("http://127.0.0.1:3210")) {
      listenerWasReady = true;
      markListenerReady();
    }
    if (!pushWasReady && outputTail.includes("Convex functions ready!")) {
      pushWasReady = true;
      markPushReady();
    }
  });
  return { child, listenerReady, pushReady };
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForBackend(backendExit, pushReady) {
  const pushResult = await Promise.race([
    pushReady.then(() => ({ ready: true })),
    backendExit.then((exit) => ({ ready: false, exit })),
  ]);
  if (!pushResult.ready) {
    throw new Error(
      `The backend stopped before its first function push completed (${pushResult.exit.signal ?? `exit ${pushResult.exit.code}`}).`,
    );
  }

  const controller = new AbortController();
  const ready = (async () => {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (controller.signal.aborted) return;
      try {
        const response = await fetch("http://127.0.0.1:3210/api/query", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Convex-Client": "code2create-local-readiness",
          },
          body: JSON.stringify({
            path: "system:getPublicShellState",
            format: "convex_encoded_json",
            args: [{ eventSlug: "code2create-7" }],
          }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1_000)]),
        });
        if (response.ok) {
          const result = await response.json();
          if (result?.status === "success") return;
        }
      } catch {
        // The local backend or its first function push is still starting.
      }
      if (controller.signal.aborted) return;
      try {
        await delay(250, undefined, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) return;
        throw error;
      }
    }
    throw new Error("The local Convex functions did not become ready on port 3210.");
  })();
  let result;
  try {
    result = await Promise.race([
      ready.then(() => ({ ready: true })),
      backendExit.then((exit) => ({ ready: false, exit })),
    ]);
  } finally {
    controller.abort();
  }
  if (!result.ready) {
    throw new Error(
      `The backend stopped before it was ready (${result.exit.signal ?? `exit ${result.exit.code}`}).`,
    );
  }
}

async function waitForBackendListener(backendExit, listenerReady) {
  const result = await Promise.race([
    listenerReady.then(() => ({ ready: true })),
    backendExit.then((exit) => ({ ready: false, exit })),
  ]);
  if (!result.ready) {
    throw new Error(
      `The backend stopped before its local API was listening (${result.exit.signal ?? `exit ${result.exit.code}`}).`,
    );
  }
}

async function waitForSurface(surface, signal) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (signal.aborted) return;
    try {
      const response = await fetch(surface.healthUrl, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
      });
      if (response.ok) return;
    } catch {
      // This surface is still starting.
    }
    if (signal.aborted) return;
    try {
      await delay(500, undefined, { signal });
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
  }
  throw new Error(`${surface.label} did not become ready at ${surface.displayUrl}.`);
}

async function waitForApplications(applicationsExit) {
  const controller = new AbortController();
  const readiness = Promise.all(
    localSurfaces.map((surface) => waitForSurface(surface, controller.signal)),
  );
  let result;
  try {
    result = await Promise.race([
      readiness.then(() => ({ ready: true })),
      applicationsExit.then((exit) => ({ ready: false, exit })),
    ]);
  } finally {
    controller.abort();
  }
  if (!result.ready) {
    throw new Error(
      `The application group stopped before every surface was ready (${result.exit.signal ?? `exit ${result.exit.code}`}).`,
    );
  }
  process.stdout.write(
    `\nLocal stack ready\n${localSurfaces.map((surface) => `  ${surface.label}: ${surface.displayUrl}`).join("\n")}\n\n`,
  );
}

async function runPreparation() {
  const child = start(["exec", "node", "scripts/prepare-local-development.mjs"]);
  const { code, signal } = await waitForExit(child);
  if (code !== 0) {
    throw new Error(`Local environment preparation failed (${signal ?? `exit ${code}`}).`);
  }
}

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (usesProcessGroups && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
          throw error;
        }
      }
    } else {
      child.kill(signal);
    }
  }
}

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}

try {
  const { child: backend, listenerReady, pushReady } = startBackend();
  const backendExit = waitForExit(backend);
  await waitForBackendListener(backendExit, listenerReady);
  await runPreparation();
  await waitForBackend(backendExit, pushReady);

  const applications = start([
    "--parallel",
    "--stream",
    // Keep sibling applications running if one development process exits.
    "--no-bail",
    ...applicationPackages.flatMap((packageName) => ["--filter", packageName]),
    "run",
    "dev",
  ]);
  const applicationsExit = waitForExit(applications);
  await waitForApplications(applicationsExit);
  const stopped = await Promise.race([
    backendExit.then((exit) => ({ application: "backend", ...exit })),
    applicationsExit.then((exit) => ({ application: "application", ...exit })),
  ]);
  const unexpected = !stopping;
  stop();
  if (unexpected) {
    throw new Error(
      `The local ${stopped.application} process stopped (${stopped.signal ?? `exit ${stopped.code}`}).`,
    );
  }
} catch (error) {
  stop();
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
