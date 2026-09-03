import * as v from "valibot";

import { copilotRecommendationArgumentsSchema } from "../protocol.ts";

const boundedReason = v.pipe(v.string(), v.minLength(5), v.maxLength(500));
const convexId = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
const positiveVersion = v.pipe(v.number(), v.integer(), v.minValue(1));

const commandDefinitions = [
  {
    command: "review.team.hold",
    area: "review",
    description: "Hold one team in an open review round.",
    arguments: '{"teamRoundStateId":"<id>","expectedTeamRoundStateVersion":1,"reason":"..."}',
    evidence: "A fresh review_exceptions read containing the team-round state id and version.",
  },
  {
    command: "review.reserve_reviewer.page",
    area: "review",
    description: "Start the substitute page chain for a current panel vacancy.",
    arguments: '{"missingPanelMemberId":"<id>","expectedPanelVersion":1,"reason":"..."}',
    evidence: "A fresh review_exceptions read containing the vacancy id and panel version.",
  },
  {
    command: "support.case.open",
    area: "support",
    description: "Open a staff support case, optionally linked to a round or team.",
    arguments:
      '{"category":"queue","description":"...","roundId":"<optional>","teamId":"<optional>"}',
    evidence: "Fresh event evidence that supports the described issue.",
  },
  {
    command: "operations.attention.dismiss",
    area: "operations",
    description: "Dismiss one current operations-attention item.",
    arguments: '{"itemId":"<id>","expectedItemVersion":1,"reason":"..."}',
    evidence: "A fresh operations_attention read containing the item id and version.",
  },
  {
    command: "configuration.admission.minimum_human_reviews.set",
    area: "admissions configuration",
    description: "Publish a new admission-policy release with a different human-review minimum.",
    arguments: '{"minimumHumanReviews":1,"reason":"..."}',
    evidence: "A fresh admission_cohort read cited with the literal key policy.",
  },
] as const;

type RecommendationArguments = v.InferOutput<typeof copilotRecommendationArgumentsSchema>;

export function eventCommandCatalog(query: string) {
  const tokens = query.trim().toLocaleLowerCase("en").split(/\s+/u).filter(Boolean);
  const matches = commandDefinitions.filter((definition) => {
    const searchable =
      `${definition.command} ${definition.area} ${definition.description}`.toLocaleLowerCase("en");
    return tokens.some((token) => searchable.includes(token));
  });
  return {
    commands: (matches.length > 0 ? matches : commandDefinitions).slice(0, 8),
    approval:
      "Proposal only. An authorized operator must approve; execution re-checks current permissions, lifecycle locks, and frozen versions.",
  };
}

export function resolveEventCommand(
  command: string,
  argumentsJson: string,
): RecommendationArguments {
  const input = parseArgumentsJson(argumentsJson);
  switch (command) {
    case "review.team.hold": {
      const data = v.parse(
        v.strictObject({
          teamRoundStateId: convexId,
          expectedTeamRoundStateVersion: positiveVersion,
          reason: boundedReason,
        }),
        input,
      );
      return { kind: "hold_review_team", ...data };
    }
    case "review.reserve_reviewer.page": {
      const data = v.parse(
        v.strictObject({
          missingPanelMemberId: convexId,
          expectedPanelVersion: positiveVersion,
          reason: boundedReason,
        }),
        input,
      );
      return { kind: "page_reserve_reviewer", ...data };
    }
    case "support.case.open": {
      const data = v.parse(
        v.strictObject({
          category: v.picklist([
            "identity",
            "team",
            "project_intake",
            "attendance_credential",
            "missing_scan",
            "scanner_device",
            "table_location",
            "integration",
            "queue",
            "reviewer_device",
            "scorecard",
            "accessibility",
            "safety",
          ]),
          description: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
          roundId: v.optional(convexId),
          teamId: v.optional(convexId),
        }),
        input,
      );
      return { kind: "open_support_case", ...data };
    }
    case "operations.attention.dismiss": {
      const data = v.parse(
        v.strictObject({
          itemId: convexId,
          expectedItemVersion: positiveVersion,
          reason: boundedReason,
        }),
        input,
      );
      return { kind: "dismiss_attention_item", ...data };
    }
    case "configuration.admission.minimum_human_reviews.set": {
      const data = v.parse(
        v.strictObject({
          minimumHumanReviews: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5)),
          reason: boundedReason,
        }),
        input,
      );
      return { kind: "set_admission_minimum_human_reviews", ...data };
    }
  }
  throw new Error("That event command is not registered. Inspect the command catalog first.");
}

function parseArgumentsJson(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson);
  } catch {
    throw new Error("Event command arguments must be valid JSON.");
  }
}
