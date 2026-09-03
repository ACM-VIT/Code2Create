import { describe, expect, test } from "vitest";

import { eventCommandCatalog, resolveEventCommand } from "./eventCommandRegistry.ts";

describe("event command registry", () => {
  test("returns only the relevant command slice instead of loading every schema", () => {
    const result = eventCommandCatalog("change admission human reviews");
    expect(result.commands).toEqual([
      expect.objectContaining({
        command: "configuration.admission.minimum_human_reviews.set",
      }),
    ]);
  });

  test("resolves a catalog command to the strict signed transport shape", () => {
    expect(
      resolveEventCommand(
        "configuration.admission.minimum_human_reviews.set",
        JSON.stringify({ minimumHumanReviews: 1, reason: "Use one organizer review." }),
      ),
    ).toEqual({
      kind: "set_admission_minimum_human_reviews",
      minimumHumanReviews: 1,
      reason: "Use one organizer review.",
    });
  });

  test.each([
    {
      command: "review.team.hold",
      arguments: {
        teamRoundStateId: "state-1",
        expectedTeamRoundStateVersion: 2,
        reason: "The team missed both calls.",
      },
      expectedKind: "hold_review_team",
    },
    {
      command: "review.reserve_reviewer.page",
      arguments: {
        missingPanelMemberId: "member-1",
        expectedPanelVersion: 3,
        reason: "The current panel seat is vacant.",
      },
      expectedKind: "page_reserve_reviewer",
    },
    {
      command: "support.case.open",
      arguments: {
        category: "queue",
        description: "A participant is blocked at the review queue.",
        teamId: "team-1",
      },
      expectedKind: "open_support_case",
    },
    {
      command: "operations.attention.dismiss",
      arguments: {
        itemId: "item-1",
        expectedItemVersion: 4,
        reason: "The underlying issue was resolved.",
      },
      expectedKind: "dismiss_attention_item",
    },
    {
      command: "configuration.admission.minimum_human_reviews.set",
      arguments: {
        minimumHumanReviews: 1,
        reason: "Use one organizer review.",
      },
      expectedKind: "set_admission_minimum_human_reviews",
    },
  ])(
    "resolves $command without weakening its typed argument contract",
    ({ command, arguments: commandArguments, expectedKind }) => {
      expect(resolveEventCommand(command, JSON.stringify(commandArguments))).toMatchObject({
        kind: expectedKind,
      });
    },
  );

  test("rejects unknown commands and arguments outside the registered contract", () => {
    expect(() => resolveEventCommand("event.do_anything", "{}")).toThrow(
      "That event command is not registered",
    );
    expect(() =>
      resolveEventCommand(
        "configuration.admission.minimum_human_reviews.set",
        JSON.stringify({ minimumHumanReviews: 0, reason: "Too low to be valid." }),
      ),
    ).toThrow();
    expect(() =>
      resolveEventCommand(
        "configuration.admission.minimum_human_reviews.set",
        JSON.stringify({
          minimumHumanReviews: 6,
          reason: "This exceeds the published contract.",
        }),
      ),
    ).toThrow();
    expect(() =>
      resolveEventCommand(
        "review.team.hold",
        JSON.stringify({
          teamRoundStateId: "state-1",
          expectedTeamRoundStateVersion: 1,
          reason: "The team missed both calls.",
          unregisteredArgument: true,
        }),
      ),
    ).toThrow();
    expect(() => resolveEventCommand("review.team.hold", "{not-json")).toThrow(
      "Event command arguments must be valid JSON",
    );
  });

  test("keeps discovery bounded and includes approval semantics even for broad queries", () => {
    const result = eventCommandCatalog("");
    expect(result.commands).toHaveLength(5);
    expect(result.commands.length).toBeLessThanOrEqual(8);
    expect(new Set(result.commands.map((entry) => entry.command)).size).toBe(
      result.commands.length,
    );
    expect(result.approval).toContain("authorized operator must approve");
    expect(result.approval).toContain("frozen versions");
  });
});
