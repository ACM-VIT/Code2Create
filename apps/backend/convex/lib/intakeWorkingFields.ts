import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export async function reconcileWorkingFieldsAfterDraftVersionChange(
  ctx: MutationCtx,
  args: {
    teamId: Id<"teams">;
    previousDraftVersion: number;
    nextDraftVersion: number;
    removeIdea?: boolean;
    removedQuestionIds?: readonly Id<"intakeGeneratedQuestions">[];
  },
) {
  const removedQuestionIds = new Set(args.removedQuestionIds ?? []);
  const workingFields = await ctx.db
    .query("intakeWorkingFields")
    .withIndex("by_team", (index) => index.eq("teamId", args.teamId))
    .collect();
  for (const field of workingFields) {
    const removed =
      (field.kind === "idea" && args.removeIdea === true) ||
      (field.kind === "follow_up" &&
        field.questionId !== undefined &&
        removedQuestionIds.has(field.questionId));
    if (removed) {
      await ctx.db.delete(field._id);
    } else if (field.baseDraftVersion === args.previousDraftVersion) {
      await ctx.db.patch(field._id, {
        baseDraftVersion: args.nextDraftVersion,
      });
    }
  }
}
