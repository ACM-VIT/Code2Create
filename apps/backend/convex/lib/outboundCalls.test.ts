import { describe, expect, test } from "vitest";

import { normalizedE164Phone, reviewerPageCallScript } from "./outboundCalls";

describe("outbound call policy", () => {
  test("normalizes ordinary E.164 presentation characters", () => {
    expect(normalizedE164Phone(" +91 98765-43210 ")).toBe("+919876543210");
    expect(normalizedE164Phone("9876543210")).toBeNull();
    expect(normalizedE164Phone("+01 23456789")).toBeNull();
    expect(normalizedE164Phone(undefined)).toBeNull();
  });

  test("builds a concise reviewer page script", () => {
    expect(
      reviewerPageCallScript({
        roundName: "Final review",
        responseWindowSeconds: 90,
      }),
    ).toBe(
      "Code2Create needs you as a substitute reviewer for Final review. " +
        "Open the reviewer app now and accept or decline within 90 seconds.",
    );
  });
});
