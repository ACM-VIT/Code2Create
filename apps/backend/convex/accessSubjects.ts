import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
} from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";

type SubjectLifecyclePermission =
  | "access.subjects.suspend"
  | "access.subjects.reactivate";

async function changeStatus(
  ctx: MutationCtx,
  args: {
    eventSlug: string;
    targetPersonId: Id<"people">;
    expectedAccessVersion: number;
    reason: string;
    clientOperationId: string;
    permissionKey: SubjectLifecyclePermission;
    targetStatus: "active" | "suspended";
    commandName: string;
  },
) {
  const event = await requireEventBySlug(ctx, args.eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const actorSubject = await requireEventSubject(ctx, event._id, person._id);
  const reason = normalizedText(args.reason, "Reason", 5, 300);
  const operationId = normalizedText(
    args.clientOperationId,
    "Client operation ID",
    10,
    100,
  );
  const requestFingerprint = operationFingerprint([
    args.targetPersonId,
    args.targetStatus,
    args.expectedAccessVersion,
    reason,
  ]);
  const prior = await findOperation(ctx, {
    eventId: event._id,
    actorPersonId: person._id,
    clientOperationId: operationId,
    commandName: args.commandName,
    requestFingerprint,
  });
  if (prior) {
    const targetSubjectId = ctx.db.normalizeId(
      "eventAccessSubjects",
      prior.targetId,
    );
    if (!targetSubjectId) {
      throw new Error("Prior event-account status result is invalid.");
    }
    return storedOperationVersion(prior.resultJson, "event-account status");
  }

  const authorizingGrantIds = await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: actorSubject._id,
    permissionKey: args.permissionKey,
    scopeType: "person",
    scopeId: args.targetPersonId,
  });
  if (args.targetStatus === "suspended" && args.targetPersonId === person._id) {
    throw new ConvexError({
      code: "SELF_SUSPENSION_NOT_ALLOWED",
      message: "Another access administrator must suspend your event account.",
    });
  }
  const targetSubject = await ctx.db
    .query("eventAccessSubjects")
    .withIndex("by_event_person", (index) =>
      index
        .eq("eventId", event._id)
        .eq("personId", args.targetPersonId),
    )
    .unique();
  if (!targetSubject) {
    throw new ConvexError({
      code: "EVENT_ACCOUNT_NOT_FOUND",
      message: "That person is not linked to this event.",
    });
  }
  if (targetSubject.accessVersion !== args.expectedAccessVersion) {
    throw new ConvexError({
      code: "ACCESS_CHANGED",
      message: "This person’s access changed. Review the current account and try again.",
    });
  }
  const requiredStatus = args.targetStatus === "suspended" ? "active" : "suspended";
  if (targetSubject.status !== requiredStatus) {
    throw new ConvexError({
      code: "EVENT_ACCOUNT_STATE_CHANGED",
      message:
        args.targetStatus === "suspended"
          ? "Only an active event account can be suspended."
          : "Only a suspended event account can be reactivated.",
    });
  }
  if (args.targetStatus === "active") {
    const targetPerson = await ctx.db.get(args.targetPersonId);
    if (!targetPerson || targetPerson.status !== "active") {
      throw new ConvexError({
        code: "PERSON_NOT_ACTIVE",
        message: "The underlying Code2Create account must be active before event access returns.",
      });
    }
  }
  const now = Date.now();
  const accessVersion = targetSubject.accessVersion + 1;
  await ctx.db.patch(targetSubject._id, {
    status: args.targetStatus,
    accessVersion,
    statusChangedAt: now,
    statusChangedByPersonId: person._id,
    statusReason: reason,
    updatedAt: now,
  });
  await writeAuditEvent(ctx, {
    eventId: event._id,
    actorPersonId: person._id,
    permissionKey: args.permissionKey,
    grantIds: authorizingGrantIds,
    scopeType: "person",
    scopeId: args.targetPersonId,
    action:
      args.targetStatus === "suspended"
        ? "access.subject_suspended"
        : "access.subject_reactivated",
    targetType: "event_access_subject",
    targetId: targetSubject._id,
    previousSummary: JSON.stringify({
      status: targetSubject.status,
      accessVersion: targetSubject.accessVersion,
    }),
    nextSummary: JSON.stringify({
      status: args.targetStatus,
      accessVersion,
    }),
    reason,
  });
  await recordOperation(ctx, {
    eventId: event._id,
    actorPersonId: person._id,
    clientOperationId: operationId,
    commandName: args.commandName,
    requestFingerprint,
    targetType: "event_access_subject",
    targetId: targetSubject._id,
    resultJson: String(accessVersion),
    createdAt: now,
  });
  return accessVersion;
}

export const suspend = mutation({
  args: {
    eventSlug: v.string(),
    targetPersonId: v.id("people"),
    expectedAccessVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ accessVersion: v.number() }),
  handler: async (ctx, args) => ({
    accessVersion: await changeStatus(ctx, {
      ...args,
      permissionKey: "access.subjects.suspend",
      targetStatus: "suspended",
      commandName: "accessSubjects.suspend",
    }),
  }),
});

export const reactivate = mutation({
  args: {
    eventSlug: v.string(),
    targetPersonId: v.id("people"),
    expectedAccessVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ accessVersion: v.number() }),
  handler: async (ctx, args) => ({
    accessVersion: await changeStatus(ctx, {
      ...args,
      permissionKey: "access.subjects.reactivate",
      targetStatus: "active",
      commandName: "accessSubjects.reactivate",
    }),
  }),
});
