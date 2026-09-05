import { describe, expect, test } from "vitest";
import {
  matchingReviewDomains,
  rankReviewPanelRoutes,
} from "./reviewPanelRouting";

describe("review panel routing", () => {
  test("matches complete declared domain phrases without substring guesses", () => {
    expect(
      matchingReviewDomains("Our React app uses TypeScript for health care.", [
        "React",
        "AI",
        "typescript",
        "Health care",
        "REACT",
      ]),
    ).toEqual(["health care", "react", "typescript"]);
    expect(matchingReviewDomains("An email training product.", ["AI"])).toEqual(
      [],
    );
  });
  test("uses the configured priority and keeps deterministic ties", () => {
    const skilled = {
      id: "skilled",
      matchedDomains: ["react"],
      estimatedWaitSeconds: 900,
    };
    const fast = { id: "fast", matchedDomains: [], estimatedWaitSeconds: 60 };
    expect(rankReviewPanelRoutes([fast, skilled], "skills_then_wait")[0]).toBe(
      skilled,
    );
    expect(rankReviewPanelRoutes([skilled, fast], "shortest_wait")[0]).toBe(
      fast,
    );
    expect(
      rankReviewPanelRoutes(
        [
          { ...fast, id: "b" },
          { ...fast, id: "a" },
        ],
        "skills_then_wait",
      )[0]?.id,
    ).toBe("a");
  });
});
