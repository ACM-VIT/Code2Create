import { describe, expect, test } from "vitest";

import { serviceUrl } from "./serviceUrl.ts";

describe("configured service URLs", () => {
  test("accepts exact HTTPS and loopback HTTP endpoints", () => {
    expect(serviceUrl("https://backend.example.test/path", "test").href).toBe(
      "https://backend.example.test/path",
    );
    expect(serviceUrl("http://127.0.0.1:3211/path", "test").href).toBe(
      "http://127.0.0.1:3211/path",
    );
  });

  test.each([
    "http://backend.example.test/path",
    "https://user:password@backend.example.test/path",
    "https://backend.example.test/path?redirect=elsewhere",
    "https://backend.example.test/path#fragment",
  ])("rejects unsafe or ambiguous endpoint %s", (value) => {
    expect(() => serviceUrl(value, "test")).toThrow("exact HTTPS URL");
  });
});
