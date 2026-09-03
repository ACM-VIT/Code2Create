import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";

import { parseFigmaFileLocation } from "./figmaFileLocation.ts";

describe("parseFigmaFileLocation", () => {
  test("accepts a design URL and strips query and hash", () => {
    expect(
      parseFigmaFileLocation(
        "https://www.figma.com/design/AbCdEf123456/Portal?node-id=1-2#123:456",
      ),
    ).toEqual({
      fileKey: "AbCdEf123456",
      url: "https://www.figma.com/design/AbCdEf123456/Portal",
    });
  });

  test("accepts file and board links", () => {
    expect(parseFigmaFileLocation("https://figma.com/file/AbCdEf123456/Old")).toEqual({
      fileKey: "AbCdEf123456",
      url: "https://figma.com/file/AbCdEf123456/Old",
    });
    expect(parseFigmaFileLocation("https://www.figma.com/board/AbCdEf123456")).toEqual({
      fileKey: "AbCdEf123456",
      url: "https://www.figma.com/board/AbCdEf123456",
    });
  });

  test("rejects a non-Figma host", () => {
    expect(() =>
      parseFigmaFileLocation("https://figjam.com/design/AbCdEf123456/Portal"),
    ).toThrow(ConvexError);
  });
});
