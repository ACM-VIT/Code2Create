import { expect, test as setup } from "@playwright/test";

import { readReleaseEnvironment } from "../src/environment.ts";

const environment = readReleaseEnvironment(process.env);

setup("release targets respond before authenticated checks start", async ({ request }) => {
  const [participant, operations] = await Promise.all([
    request.get(environment.participantUrl),
    request.get(environment.operationsUrl),
  ]);
  expect(participant.ok()).toBe(true);
  expect(operations.ok()).toBe(true);
});
