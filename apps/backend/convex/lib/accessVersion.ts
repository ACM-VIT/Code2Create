import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export function requireAccessVersion(
  subject: Pick<Doc<"eventAccessSubjects">, "accessVersion">,
  expectedAccessVersion: number,
) {
  if (subject.accessVersion !== expectedAccessVersion) {
    throw new ConvexError({
      code: "ACCESS_CHANGED",
      message: "This person’s access changed. Review the current grants and try again.",
    });
  }
}

export async function advanceAccessVersion(
  ctx: MutationCtx,
  subjectId: Id<"eventAccessSubjects">,
  now: number,
) {
  const subject = await ctx.db.get(subjectId);
  if (!subject) {
    throw new Error("Event access subject is missing.");
  }
  await ctx.db.patch("eventAccessSubjects", subject._id, {
    accessVersion: subject.accessVersion + 1,
    updatedAt: now,
  });
}
