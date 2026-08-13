/** Projects agent lifecycle records without copying Durable Object content. */

import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";

import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { internalQuery, query } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { requirePermission } from "./lib/permissions";

const maximumBriefPageSize = 20;

const copilotAuthorization = v.object({
  eventId: v.id("events"),
  eventSlug: v.string(),
  eventAccessSubjectId: v.id("eventAccessSubjects"),
});

/** Resolves the private copilot identity only after checking the exact permission. */
export const authorizeCopilot = internalQuery({
  args: {
    eventSlug: v.string(),
    permission: v.union(
      v.literal("operations.intelligence.generate"),
      v.literal("operations.intelligence.read"),
    ),
  },
  returns: copilotAuthorization,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: args.permission,
      scopeType: "event",
    });
    return {
      eventId: event._id,
      eventSlug: event.slug,
      eventAccessSubjectId: subject._id,
    };
  },
});

/** Binds a brief stream ticket to one authorized event-owned run. */
export const authorizeBriefStream = internalQuery({
  args: {
    eventSlug: v.string(),
    briefId: v.id("operationsIntelligenceBriefs"),
  },
  returns: v.object({ eventSlug: v.string(), briefId: v.id("operationsIntelligenceBriefs") }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "operations.intelligence.read",
      scopeType: "event",
    });
    const brief = await ctx.db.get(args.briefId);
    if (!brief || brief.eventId !== event._id) {
      throw new ConvexError({
        code: "INTELLIGENCE_BRIEF_NOT_FOUND",
        message: "That intelligence run is unavailable.",
      });
    }
    return { eventSlug: event.slug, briefId: brief._id };
  },
});

const briefRunView = v.object({
  id: v.id("operationsIntelligenceBriefs"),
  state: v.union(
    v.literal("pending"),
    v.literal("dispatching"),
    v.literal("accepted"),
    v.literal("succeeded"),
    v.literal("failed"),
  ),
  failureCode: v.optional(
    v.union(
      v.literal("dispatch_failed"),
      v.literal("agent_timed_out"),
      v.literal("model_did_not_publish"),
      v.literal("callback_rejected"),
    ),
  ),
  headline: v.optional(v.string()),
  agentVersion: v.optional(v.string()),
  model: v.optional(v.string()),
  requestedAt: v.number(),
  workerAcceptedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
});

function briefRun(brief: Doc<"operationsIntelligenceBriefs">) {
  return {
    id: brief._id,
    state: brief.state,
    ...(brief.failureCode !== undefined ? { failureCode: brief.failureCode } : {}),
    ...(brief.headline !== undefined ? { headline: brief.headline } : {}),
    ...(brief.agentVersion !== undefined ? { agentVersion: brief.agentVersion } : {}),
    ...(brief.model !== undefined ? { model: brief.model } : {}),
    requestedAt: brief.requestedAt,
    ...(brief.workerAcceptedAt !== undefined
      ? { workerAcceptedAt: brief.workerAcceptedAt }
      : {}),
    ...(brief.completedAt !== undefined ? { completedAt: brief.completedAt } : {}),
  };
}

function requireBriefPageSize(numItems: number) {
  if (numItems < 1 || numItems > maximumBriefPageSize) {
    throw new ConvexError({
      code: "INVALID_PAGE_SIZE",
      message: `Brief history pages must contain between 1 and ${maximumBriefPageSize} rows.`,
    });
  }
}

/** Newest-first manual brief history; older runs always remain reachable. */
export const briefHistory = query({
  args: {
    eventSlug: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(briefRunView),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "operations.intelligence.read",
      scopeType: "event",
    });

    requireBriefPageSize(args.paginationOpts.numItems);
    const page = await ctx.db
      .query("operationsIntelligenceBriefs")
      .withIndex("by_event_requested", (index) => index.eq("eventId", event._id))
      .order("desc")
      .paginate(args.paginationOpts);

    return { ...page, page: page.page.map(briefRun) };
  },
});
