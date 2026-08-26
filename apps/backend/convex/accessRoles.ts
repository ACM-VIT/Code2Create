import { ConvexError, v } from "convex/values";

import { mutation } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireFreshAuthSession,
  sensitiveCommandSessionMaxAgeMs,
} from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import { eventRole } from "./values";

export const set = mutation({
  args: {
    eventSlug: v.string(),
    targetPersonId: v.id("people"),
    role: v.union(eventRole, v.null()),
    expectedAccessVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ accessVersion: v.number() }),
  handler: async (ctx, args) => {
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
      args.role,
      args.expectedAccessVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "accessRoles.set",
      requestFingerprint,
    });
    if (prior) {
      const targetSubjectId = ctx.db.normalizeId(
        "eventAccessSubjects",
        prior.targetId,
      );
      if (!targetSubjectId) throw new Error("Prior role-label result is invalid.");
      return {
        accessVersion: storedOperationVersion(prior.resultJson, "role-label"),
      };
    }

    const authorizingGrantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: actorSubject._id,
      permissionKey: "access.roles.assign",
      scopeType: "person",
      scopeId: args.targetPersonId,
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    const targetSubject = await requireEventSubject(
      ctx,
      event._id,
      args.targetPersonId,
    );
    if (targetSubject.accessVersion !== args.expectedAccessVersion) {
      throw new ConvexError({
        code: "ACCESS_CHANGED",
        message: "This person’s access changed. Review the current account and try again.",
      });
    }
    const currentRole = await ctx.db
      .query("eventRoles")
      .withIndex("by_event_person_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("personId", args.targetPersonId)
          .eq("status", "active"),
      )
      .unique();
    if ((currentRole?.role ?? null) === args.role) {
      await recordOperation(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        clientOperationId: operationId,
        commandName: "accessRoles.set",
        requestFingerprint,
        targetType: "event_access_subject",
        targetId: targetSubject._id,
        resultJson: String(targetSubject.accessVersion),
        createdAt: Date.now(),
      });
      return { accessVersion: targetSubject.accessVersion };
    }

    const now = Date.now();
    if (currentRole) {
      await ctx.db.patch(currentRole._id, {
        status: args.role === null ? "revoked" : "replaced",
        endedAt: now,
        endedByPersonId: person._id,
        endReason: reason,
      });
    }
    if (args.role !== null) {
      await ctx.db.insert("eventRoles", {
        eventId: event._id,
        personId: args.targetPersonId,
        eventAccessSubjectId: targetSubject._id,
        role: args.role,
        validFrom: now,
        status: "active",
        sourceType: "manual",
        sourceId: `manual-role:${operationId}`,
        assignedByPersonId: person._id,
        createdAt: now,
        reason,
      });
    }
    const accessVersion = targetSubject.accessVersion + 1;
    await ctx.db.patch(targetSubject._id, {
      accessVersion,
      updatedAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "access.roles.assign",
      grantIds: authorizingGrantIds,
      scopeType: "person",
      scopeId: args.targetPersonId,
      action: "access.role_label_changed",
      targetType: "event_access_subject",
      targetId: targetSubject._id,
      previousSummary: JSON.stringify({ role: currentRole?.role ?? null }),
      nextSummary: JSON.stringify({ role: args.role }),
      reason,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "accessRoles.set",
      requestFingerprint,
      targetType: "event_access_subject",
      targetId: targetSubject._id,
      resultJson: String(accessVersion),
      createdAt: now,
    });
    return { accessVersion };
  },
});
