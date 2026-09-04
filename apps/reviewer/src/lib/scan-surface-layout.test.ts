import { describe, expect, test } from "vitest";

import { scanGuideSize } from "./scan-surface-layout";

describe("scanner viewfinder layout", () => {
  test("uses a square sized to the available width on a tall screen", () => {
    expect(scanGuideSize({ width: 400, height: 500 })).toBe(304);
  });

  test("shrinks the square above a tall action panel", () => {
    expect(scanGuideSize({ width: 400, height: 200 })).toBe(176);
  });

  test("hides the guide when controls leave no useful camera area", () => {
    expect(scanGuideSize({ width: 400, height: 110 })).toBe(0);
  });
});
