import { describe, expect, test } from "vitest";
import { normalizeFigmaLink } from "./figmaLinks";

describe("Figma file links", () => {
  test("accepts shared file and prototype links, preserving node selection", () => {
    for (const kind of ["design", "file", "proto"]) {
      const url = `https://www.figma.com/${kind}/Abc123/Project?node-id=1-2`;
      expect(normalizeFigmaLink(`  ${url}  `)).toBe(url);
    }
    expect(normalizeFigmaLink(" ")).toBeUndefined();
  });
  test("rejects non-file links, other hosts, credentials and unsafe schemes", () => {
    for (const url of [
      "https://www.figma.com/", "https://www.figma.com/files/recent",
      "https://figma.com.evil.test/design/Abc/Project", "https://example.test/design/Abc/Project",
      "http://www.figma.com/design/Abc/Project", "data:text/plain,not-a-file",
      "https://user:secret@figma.com/design/Abc/Project", "https://figma.com:8443/design/Abc/Project",
      "https://figma.com/design/Abc/" + "x".repeat(2000), "not a URL",
    ]) expect(() => normalizeFigmaLink(url)).toThrow();
  });
});
