import { Presence } from "@convex-dev/presence";

import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

export type IntakeEditingSurface = "idea" | "follow_up" | "proposal_revision";

export const maximumIntakeEditors = 5;
export const intakeEditingPresence = new Presence<string, Id<"eventMemberships">>(
  components.intakePresence,
);

export function intakeEditingRoomId(
  teamId: Id<"teams">,
  surface: IntakeEditingSurface,
  questionId: Id<"intakeGeneratedQuestions"> | undefined,
) {
  return `intake:${teamId}:${surface}:${questionId ?? "idea"}`;
}
