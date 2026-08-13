import { describe, expect, test } from "vitest";

import { validateScoreSpreadThreshold } from "./reviewConfiguration.ts";

describe("review configuration policy", () => {
  test("accepts only configurable whole-point score spreads", () => {
    expect(validateScoreSpreadThreshold(1)).toBe(1);
    expect(validateScoreSpreadThreshold(4)).toBe(4);
    expect(() => validateScoreSpreadThreshold(0)).toThrow("from 1 through 4");
    expect(() => validateScoreSpreadThreshold(2.5)).toThrow("from 1 through 4");
    expect(() => validateScoreSpreadThreshold(5)).toThrow("from 1 through 4");
  });
});
