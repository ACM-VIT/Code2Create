import { describe, expect, it } from "vitest";

import { requireStrongServiceSecret } from "./serviceSecret.ts";

describe("service HMAC secret validation", () => {
  it("rejects fewer than 32 UTF-8 bytes and accepts a 32-byte secret", () => {
    expect(() => requireStrongServiceSecret("x".repeat(31), "TEST_SECRET")).toThrow(
      "TEST_SECRET must contain at least 32 UTF-8 bytes.",
    );
    expect(requireStrongServiceSecret("é".repeat(16), "TEST_SECRET")).toBe("é".repeat(16));
  });
});
