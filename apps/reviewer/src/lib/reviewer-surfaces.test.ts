import { describe, expect, it } from "vitest";

import { reviewerSurfaces } from "./reviewer-surfaces";

describe("reviewerSurfaces", () => {
  it("derives duties only from the granted capability flags", () => {
    expect(
      reviewerSurfaces({
        reviews: true,
        attendance: false,
        floor: true,
        support: false,
        operations: false,
        incidents: true,
      }),
    ).toEqual(["reviews", "floor", "incidents"]);
  });
});
