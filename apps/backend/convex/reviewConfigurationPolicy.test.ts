import { describe, expect, test } from "vitest";

import { validateScoreSpreadThreshold } from "./reviewConfiguration.ts";
import {
  planReviewPanels,
  validatePanelComposition,
  type PanelCandidate,
} from "@code2create/domain";

describe("review configuration policy", () => {
  test("balances six five-person panels and chooses the strongest SC leads when no Board is available", () => {
    const candidates: PanelCandidate[] = Array.from(
      { length: 80 },
      (_, index) => ({
        id: `reviewer-${String(index).padStart(2, "0")}`,
        seniority: index < 23 ? "sc" : "jc",
        completedReviews: 0,
        strength: index % 5,
        domains: [index % 2 ? "design" : "backend"],
        criterionKeys: ["technical_execution"],
      }),
    );
    const policy = {
      seniorSeats: 2,
      juniorSeats: 2,
      allowSeniorLeadFallback: true,
    };
    const result = planReviewPanels(candidates, 6, policy);
    expect(result.panels).toHaveLength(6);
    expect(result.reserveIds).toHaveLength(50);
    const members = result.panels.flat();
    expect(new Set(members.map((member) => member.id)).size).toBe(30);
    expect(members.filter((member) => member.seniority === "sc")).toHaveLength(
      18,
    );
    expect(
      result.panels
        .map((panel) => panel.find((member) => member.isCoordinator)?.strength)
        .sort(),
    ).toEqual([3, 3, 4, 4, 4, 4]);
    for (const panel of result.panels)
      expect(() => validatePanelComposition(panel, policy)).not.toThrow();
    expect(() => planReviewPanels(candidates, 8, policy)).toThrow(
      "not enough eligible SC",
    );
    expect(() =>
      planReviewPanels(candidates, 6, {
        ...policy,
        allowSeniorLeadFallback: false,
      }),
    ).toThrow("not enough eligible panel leads");
  });
  test("accepts only configurable whole-point score spreads", () => {
    expect(validateScoreSpreadThreshold(1)).toBe(1);
    expect(validateScoreSpreadThreshold(4)).toBe(4);
    expect(() => validateScoreSpreadThreshold(0)).toThrow("from 1 through 4");
    expect(() => validateScoreSpreadThreshold(2.5)).toThrow("from 1 through 4");
    expect(() => validateScoreSpreadThreshold(5)).toThrow("from 1 through 4");
  });
});
