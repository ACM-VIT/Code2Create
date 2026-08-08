import { describe, expect, test } from "vitest";

import { authSessionCreatedAtMs } from "./identity";

describe("auth session creation time", () => {
  test("accepts Better Auth's runtime and typed date representations", () => {
    const timestamp = Date.UTC(2026, 7, 8, 4, 30);
    expect(authSessionCreatedAtMs(timestamp)).toBe(timestamp);
    expect(authSessionCreatedAtMs(new Date(timestamp))).toBe(timestamp);
    expect(authSessionCreatedAtMs(new Date(timestamp).toISOString())).toBe(timestamp);
  });

  test("rejects an invalid session creation time", () => {
    expect(() => authSessionCreatedAtMs("not-a-date")).toThrow(
      "Better Auth returned an invalid session creation time.",
    );
  });
});
