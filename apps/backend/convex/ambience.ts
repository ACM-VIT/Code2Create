import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import { ambienceMode } from "./values";

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    mode: ambienceMode,
    changedAt: v.union(v.null(), v.number()),
    canManage: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "event.lifecycle.read",
      scopeType: "event",
    });
    const manageGrantIds = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "event.lifecycle.manage",
      scopeType: "event",
    });
    return {
      mode: event.ambience?.mode ?? "off",
      changedAt: event.ambience?.changedAt ?? null,
      canManage: manageGrantIds.length > 0,
    };
  },
});

export const set = mutation({
  args: { eventSlug: v.string(), mode: ambienceMode, reason: v.string() },
  returns: v.object({ mode: ambienceMode }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "event.lifecycle.manage",
      scopeType: "event",
    });
    const reason = normalizedText(args.reason, "Reason", 2, 200);
    const previous = event.ambience?.mode ?? "off";
    if (previous === args.mode) return { mode: previous };
    const now = Date.now();
    await ctx.db.patch(event._id, {
      ambience: { mode: args.mode, changedAt: now, changedByPersonId: person._id },
      updatedAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "event.lifecycle.manage",
      grantIds,
      scopeType: "event",
      action: "event.ambience_changed",
      targetType: "event",
      targetId: event._id,
      previousSummary: JSON.stringify({ mode: previous }),
      nextSummary: JSON.stringify({ mode: args.mode }),
      reason,
    });
    return { mode: args.mode };
  },
});
