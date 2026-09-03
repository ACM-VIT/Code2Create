import { describe, expect, test } from "vitest";

import { dutySubscriptionPlan } from "./duty-subscriptions";

describe("duty query routing", () => {
  test("retained tab trees subscribe only to their visible duty group", () => {
    const groups = {
      floor: ["reviews", "attendance", "support"] as const,
      board: ["operations", "incidents"] as const,
    };

    expect(dutySubscriptionPlan(groups.floor)).toEqual({
      attendance: true,
      support: true,
      operations: false,
      incidents: false,
    });
    expect(dutySubscriptionPlan(groups.board)).toEqual({
      attendance: false,
      support: false,
      operations: true,
      incidents: true,
    });
  });
});
