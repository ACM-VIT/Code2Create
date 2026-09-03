import { describe, expect, test } from "vitest";

import { createIntelligenceHistoryCursor, readIntelligenceHistoryCursor } from "./historyCursor.ts";

const secret = "history-secret-".repeat(4);

describe("intelligence history cursor", () => {
  test("round-trips one route-bound native message key", async () => {
    const cursor = await createIntelligenceHistoryCursor({
      instanceId: "autonomy-run-1",
      messageKey: "message:message-34",
      secret,
    });
    await expect(
      readIntelligenceHistoryCursor({
        cursor,
        instanceId: "autonomy-run-1",
        secret,
      }),
    ).resolves.toBe("message:message-34");
    await expect(
      readIntelligenceHistoryCursor({
        cursor,
        instanceId: "autonomy-run-2",
        secret,
      }),
    ).resolves.toBeNull();
  });

  test("rejects a modified or malformed cursor", async () => {
    const cursor = await createIntelligenceHistoryCursor({
      instanceId: "autonomy-run-1",
      messageKey: "assistant:submission-1",
      secret,
    });
    const replacement = cursor.endsWith("a") ? "b" : "a";
    await expect(
      readIntelligenceHistoryCursor({
        cursor: `${cursor.slice(0, -1)}${replacement}`,
        instanceId: "autonomy-run-1",
        secret,
      }),
    ).resolves.toBeNull();
    await expect(
      readIntelligenceHistoryCursor({
        cursor: "not+base64",
        instanceId: "autonomy-run-1",
        secret,
      }),
    ).resolves.toBeNull();
  });
});
