import { describe, expect, test } from "vitest";

import {
  helpStatus,
  incidentStatus,
  judgingStatus,
  reviewerPanelMode,
} from "./judging-status";

describe("judging duty status", () => {
  test.each([
    ["reserve", "On call"],
    ["panel", "Waiting"],
  ] as const)("shows %s duty before a review starts", (assignment, status) => {
    expect(
      judgingStatus(
        {
          deviceRegistered: true,
          assignment,
          review: null,
        },
        false,
        true,
      ),
    ).toEqual({ status, active: false });
  });

  test("keeps an assigned scorecard reachable after panel duty ends", () => {
    expect(
      judgingStatus(
        {
          deviceRegistered: true,
          assignment: null,
          review: {
            reviewerPresenceConfirmed: true,
            scoredCount: 2,
            criterionCount: 5,
          },
        },
        false,
        true,
      ),
    ).toMatchObject({ status: "2 of 5 scored", active: true });
  });

  test("uses the root-owned page signal before reviewer state", () => {
    expect(judgingStatus(undefined, true, true)).toEqual({
      status: "Needed at a table",
      active: true,
    });
  });

  test("renders scoring progress from the lightweight duty projection", () => {
    expect(
      judgingStatus(
        {
          deviceRegistered: true,
          assignment: "panel",
          review: {
            reviewerPresenceConfirmed: true,
            scoredCount: 3,
            criterionCount: 5,
          },
        },
        false,
        true,
      ),
    ).toEqual({
      status: "3 of 5 scored",
      active: true,
      headline: { value: "3/5", unit: "scored" },
    });
  });

  test("does not expose a hidden judging subscription as active work", () => {
    expect(judgingStatus(undefined, true, false)).toEqual({
      status: "",
      active: false,
    });
  });

  test("keeps phone registration reachable before a panel is assigned", () => {
    expect(
      reviewerPanelMode({
        deviceIsCurrent: false,
        hasAssignment: false,
        hasReview: false,
      }),
    ).toBe("setup");
    expect(
      reviewerPanelMode({
        deviceIsCurrent: true,
        hasAssignment: false,
        hasReview: false,
      }),
    ).toBe("empty");
  });
});

describe("lightweight duty summaries", () => {
  test("marks bounded incident and support counts as lower bounds", () => {
    expect(
      incidentStatus({ liveCount: 20, pendingManualModeCount: 1 }, true),
    ).toEqual({
      status: "Awaiting approval",
      active: true,
      headline: { value: "20", unit: "live" },
    });
    expect(
      helpStatus({ openCount: 20, countIsLowerBound: true }, true),
    ).toEqual({
      status: "20+ open",
      active: true,
      headline: { value: "20+", unit: "cases open" },
    });
  });
});
