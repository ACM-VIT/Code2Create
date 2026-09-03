import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";

import { parseGitHubRepositoryLocation } from "./githubRepositoryLocation.ts";

describe("parseGitHubRepositoryLocation", () => {
  test("accepts a canonical repository URL and ignores extra path", () => {
    expect(
      parseGitHubRepositoryLocation("https://github.com/acm-vit/portal/tree/main"),
    ).toEqual({
      owner: "acm-vit",
      name: "portal",
      url: "https://github.com/acm-vit/portal",
    });
  });

  test("strips .git and www", () => {
    expect(
      parseGitHubRepositoryLocation("https://www.github.com/acm-vit/portal.git"),
    ).toEqual({
      owner: "acm-vit",
      name: "portal",
      url: "https://github.com/acm-vit/portal",
    });
  });

  test("rejects a non-GitHub host", () => {
    expect(() => parseGitHubRepositoryLocation("https://gitlab.com/acm-vit/portal")).toThrow(
      ConvexError,
    );
  });
});
