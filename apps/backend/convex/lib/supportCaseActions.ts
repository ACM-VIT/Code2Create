import type { WithoutSystemFields } from "convex/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

type SupportCaseAction = WithoutSystemFields<Doc<"supportCaseActions">>;

export async function insertSupportCaseAction(
  ctx: MutationCtx,
  action: SupportCaseAction,
  options: { syncToDiscord?: boolean } = {},
): Promise<Id<"supportCaseActions">> {
  const actionId = await ctx.db.insert("supportCaseActions", action);
  if (options.syncToDiscord !== false) {
    await ctx.db.insert("supportDiscordOutbox", {
      eventId: action.eventId,
      supportCaseId: action.supportCaseId,
      supportCaseActionId: actionId,
      state: "pending",
      nextAttemptAt: action.createdAt,
      attemptCount: 0,
      createdAt: action.createdAt,
      updatedAt: action.createdAt,
    });
  }
  return actionId;
}
