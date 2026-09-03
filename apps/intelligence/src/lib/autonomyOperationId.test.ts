import { describe, expect, test } from "vitest";

import { autonomyOperationId } from "./autonomyOperationId.ts";

describe("autonomy operation identity", () => {
  test("is stable, domain separated, and bounded for maximum-length coordinates", async () => {
    const coordinate = "x".repeat(1_000);
    const first = await autonomyOperationId("read", [coordinate, "operations_health", "1"]);
    const retry = await autonomyOperationId("read", [coordinate, "operations_health", "1"]);
    const changed = await autonomyOperationId("read", [coordinate, "operations_health", "2"]);
    const otherKind = await autonomyOperationId("callback", [coordinate, "operations_health", "1"]);

    expect(retry).toBe(first);
    expect(changed).not.toBe(first);
    expect(otherKind).not.toBe(first);
    expect(first.length).toBeLessThanOrEqual(240);
    expect(first).toMatch(/^autonomy-read-[a-f0-9]{64}$/u);
  });

  test("never grows recursively across many continuation coordinates", async () => {
    let workItemId = `work:${"a".repeat(64)}`;
    const callbackIds = new Set<string>();
    for (let index = 0; index < 32; index += 1) {
      const callbackId = await autonomyOperationId("callback", [
        "run-many-pages",
        workItemId,
        "continuing",
      ]);
      expect(callbackId.length).toBeLessThanOrEqual(200);
      callbackIds.add(callbackId);
      workItemId = `work:${callbackId.slice(-64)}`;
    }
    expect(callbackIds).toHaveLength(32);
  });
});
