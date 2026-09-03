import assert from "node:assert/strict";
import test from "node:test";

import { readReleaseEnvironment } from "./environment.ts";

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    C2C_E2E_ENVIRONMENT: "staging",
    C2C_E2E_RUN_ID: "release-120.2",
    C2C_EVENT_SLUG: "code2create-7",
    C2C_OPERATIONS_ACCOUNT_EMAIL: "ops-release@acmvit.example",
    C2C_OPERATIONS_STORAGE_STATE_PATH: "/tmp/c2c-operations-state.json",
    C2C_OPERATIONS_URL: "https://operations-staging.example.test",
    C2C_PARTICIPANT_ACCOUNT_EMAIL: "participant-release@example.test",
    C2C_PARTICIPANT_STORAGE_STATE_PATH: "/tmp/c2c-participant-state.json",
    C2C_PARTICIPANT_URL: "https://participant-staging.example.test",
  };
}

test("release browser configuration accepts distinct staging origins and accounts", () => {
  const configuration = readReleaseEnvironment(validEnvironment());
  assert.equal(configuration.environment, "staging");
  assert.equal(configuration.eventSlug, "code2create-7");
  assert.equal(configuration.runId, "release-120.2");
});

test("release browser configuration rejects production", () => {
  const environment = validEnvironment();
  environment.C2C_E2E_ENVIRONMENT = "production";
  assert.throws(() => readReleaseEnvironment(environment), /only against staging/u);
});

test("release browser configuration rejects shared or non-origin targets", () => {
  const shared = validEnvironment();
  shared.C2C_OPERATIONS_URL = shared.C2C_PARTICIPANT_URL;
  assert.throws(() => readReleaseEnvironment(shared), /different origins/u);

  const withPath = validEnvironment();
  withPath.C2C_PARTICIPANT_URL = "https://participant-staging.example.test/app";
  assert.throws(() => readReleaseEnvironment(withPath), /one HTTPS origin/u);
});

test("release browser configuration rejects one account for both surfaces", () => {
  const environment = validEnvironment();
  environment.C2C_OPERATIONS_ACCOUNT_EMAIL = "PARTICIPANT-RELEASE@example.test";
  assert.throws(() => readReleaseEnvironment(environment), /accounts must be different/u);
});

test("release browser configuration requires absolute storage-state paths", () => {
  const environment = validEnvironment();
  environment.C2C_PARTICIPANT_STORAGE_STATE_PATH = "participant.json";
  assert.throws(() => readReleaseEnvironment(environment), /absolute path/u);
});
