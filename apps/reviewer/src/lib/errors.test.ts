import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";

import { describeError, OperatorError } from "./errors";

describe("describeError", () => {
  test("shows explicit operator and Convex application errors", () => {
    expect(describeError(new OperatorError("Scan a supported credential."), "Fallback")).toBe(
      "Scan a supported credential.",
    );
    expect(describeError(new ConvexError("Refresh and try again."), "Fallback")).toBe(
      "Refresh and try again.",
    );
    expect(
      describeError(new ConvexError({ code: "STALE", message: "The record changed." }), "Fallback"),
    ).toBe("The record changed.");
  });

  test("does not trust objects that imitate Convex errors", () => {
    expect(
      describeError({ data: { code: "FAKE", message: "Do not expose me." } }, "Fallback"),
    ).toBe("Fallback");
  });
});
