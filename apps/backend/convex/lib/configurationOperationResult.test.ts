import { describe, expect, test } from "vitest";

import {
  configurationDraftResultJson,
  configurationPublicationResultJson,
  storedConfigurationDraftResult,
  storedConfigurationPublicationResult,
} from "./configurationOperationResult.ts";

describe("configuration operation results", () => {
  test("round-trips exact draft and publication results", () => {
    const draft = { version: 3, checksum: "configuration-checksum", changed: true };
    const publication = { version: 3, eventVersion: 8 };

    expect(
      storedConfigurationDraftResult(
        configurationDraftResultJson(draft),
        "configuration-draft",
      ),
    ).toEqual(draft);
    expect(
      storedConfigurationPublicationResult(
        configurationPublicationResultJson(publication),
        "configuration-publication",
      ),
    ).toEqual(publication);
  });

  test("rejects incomplete stored results", () => {
    expect(() => storedConfigurationDraftResult("{}", "configuration-draft")).toThrow(
      "The stored configuration-draft result is invalid.",
    );
    expect(() =>
      storedConfigurationPublicationResult(undefined, "configuration-publication"),
    ).toThrow("The stored configuration-publication result is invalid.");
  });
});
