import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateLoadTarget } from "./target.ts";

const baseInput = {
  acknowledgement: "code2create-staging",
  clientCount: 3_000,
  endpoint: new URL("https://realtime-staging.c2c.sh"),
  eventSlug: "code2create-7",
  mode: "public" as const,
  workload: "subscriptions" as const,
};

test("accepts the exact staging read-only target", () => {
  assert.deepEqual(validateLoadTarget(baseInput), { target: "staging", mutates: false });
});

test("rejects hostnames that merely contain staging", () => {
  assert.throws(
    () => validateLoadTarget({
      ...baseInput,
      endpoint: new URL("https://staging.attacker.example"),
    }),
    /not an approved/u,
  );
});

test("live production accepts only the public shell workload", () => {
  assert.deepEqual(validateLoadTarget({
    ...baseInput,
    acknowledgement: "code2create-production-readonly",
    endpoint: new URL("https://realtime.c2c.sh"),
  }), { target: "production-readonly", mutates: false });
  assert.throws(
    () => validateLoadTarget({
      ...baseInput,
      acknowledgement: "code2create-production-rehearsal",
      endpoint: new URL("https://realtime.c2c.sh"),
      eventSlug: "load-capacity",
      mode: "participant",
      workload: "full-flow",
    }),
    /read-only/u,
  );
});

test("production rehearsal writes require the isolated origin, load slug, and exact acknowledgement", () => {
  const input = {
    ...baseInput,
    acknowledgement: "code2create-production-rehearsal",
    endpoint: new URL("https://realtime-load.c2c.sh"),
    eventSlug: "load-capacity",
    mode: "participant" as const,
    workload: "full-flow" as const,
  };
  assert.deepEqual(validateLoadTarget(input), {
    target: "production-rehearsal",
    mutates: true,
  });
  assert.throws(
    () => validateLoadTarget({ ...input, eventSlug: "code2create-7" }),
    /load-\*/u,
  );
  assert.throws(
    () => validateLoadTarget({ ...input, acknowledgement: "code2create-staging-writes" }),
    /production-rehearsal/u,
  );
});

test("the rehearsal preparation entrypoint resolves its TypeScript modules", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./prepareRehearsal.ts", import.meta.url)),
    ],
    { encoding: "utf8", env: {} },
  );
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/u);
  assert.match(result.stderr, /C2C_LOAD_ACKNOWLEDGE/u);
});
