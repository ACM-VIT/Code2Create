import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject, requireMembership } from "./lib/identity";
import { requirePermission } from "./lib/permissions";

const externalPassResult = v.object({
  passId: v.id("attendanceExternalPasses"),
  encryptedBearer: v.string(),
  bearerIv: v.string(),
  bearerAuthTag: v.string(),
  version: v.number(),
});

type ExternalPassResult = {
  passId: Id<"attendanceExternalPasses">;
  encryptedBearer: string;
  bearerIv: string;
  bearerAuthTag: string;
  version: number;
};

function requireCandidate(args: {
  encryptedBearer: string;
  bearerIv: string;
  bearerAuthTag: string;
  lookupHash: string;
}) {
  if (
    !/^[A-Za-z0-9_-]+$/u.test(args.encryptedBearer) ||
    !/^[A-Za-z0-9_-]{16}$/u.test(args.bearerIv) ||
    !/^[A-Za-z0-9_-]{22}$/u.test(args.bearerAuthTag) ||
    !/^[a-f0-9]{64}$/u.test(args.lookupHash)
  ) {
    throw new Error("External event-pass candidate is invalid.");
  }
}

async function ensureExternalPass(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    membership: Doc<"eventMemberships">;
    encryptedBearer: string;
    bearerIv: string;
    bearerAuthTag: string;
    lookupHash: string;
  },
): Promise<ExternalPassResult> {
  if (
    args.membership.eventId !== args.eventId ||
    args.membership.participantClass !== "external_participant" ||
    args.membership.eligibilityStatus !== "eligible" ||
    args.membership.onboardingStatus !== "accepted"
  ) {
    throw new ConvexError({
      code: "EXTERNAL_PASS_NOT_AVAILABLE",
      message: "Event passes are available only to accepted external participants.",
    });
  }
  const existing = await ctx.db
    .query("attendanceExternalPasses")
    .withIndex("by_membership", (index) => index.eq("membershipId", args.membership._id))
    .unique();
  if (existing?.state === "suspended") {
    throw new ConvexError({
      code: "EXTERNAL_PASS_SUSPENDED",
      message: "This external event pass is suspended. Ask event support for help.",
    });
  }
  if (existing) {
    return {
      passId: existing._id,
      encryptedBearer: existing.encryptedBearer,
      bearerIv: existing.bearerIv,
      bearerAuthTag: existing.bearerAuthTag,
      version: existing.version,
    };
  }
  requireCandidate(args);
  const collision = await ctx.db
    .query("attendanceExternalPasses")
    .withIndex("by_event_lookup", (index) =>
      index.eq("eventId", args.eventId).eq("lookupHash", args.lookupHash),
    )
    .unique();
  if (collision) throw new Error("External event-pass token collision.");
  const now = Date.now();
  const passId = await ctx.db.insert("attendanceExternalPasses", {
    eventId: args.eventId,
    membershipId: args.membership._id,
    encryptedBearer: args.encryptedBearer,
    bearerIv: args.bearerIv,
    bearerAuthTag: args.bearerAuthTag,
    lookupHash: args.lookupHash,
    version: 1,
    state: "active",
    issuedAt: now,
    updatedAt: now,
  });
  return {
    passId,
    encryptedBearer: args.encryptedBearer,
    bearerIv: args.bearerIv,
    bearerAuthTag: args.bearerAuthTag,
    version: 1,
  };
}

export const ensureMine = internalMutation({
  args: {
    eventSlug: v.string(),
    encryptedBearer: v.string(),
    bearerIv: v.string(),
    bearerAuthTag: v.string(),
    lookupHash: v.string(),
  },
  returns: externalPassResult,
  handler: async (ctx, args): Promise<ExternalPassResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.external_pass.read",
      scopeType: "self",
      scopeId: membership._id,
    });
    return ensureExternalPass(ctx, {
      eventId: event._id,
      membership,
      encryptedBearer: args.encryptedBearer,
      bearerIv: args.bearerIv,
      bearerAuthTag: args.bearerAuthTag,
      lookupHash: args.lookupHash,
    });
  },
});

export const ensureForDelivery = internalMutation({
  args: {
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
    encryptedBearer: v.string(),
    bearerIv: v.string(),
    bearerAuthTag: v.string(),
    lookupHash: v.string(),
  },
  returns: externalPassResult,
  handler: async (ctx, args): Promise<ExternalPassResult> => {
    const membership = await ctx.db.get(args.membershipId);
    if (!membership) {
      throw new ConvexError({
        code: "PARTICIPANT_NOT_FOUND",
        message: "The external participant no longer exists.",
      });
    }
    return ensureExternalPass(ctx, {
      eventId: args.eventId,
      membership,
      encryptedBearer: args.encryptedBearer,
      bearerIv: args.bearerIv,
      bearerAuthTag: args.bearerAuthTag,
      lookupHash: args.lookupHash,
    });
  },
});

export const detailsForWallet = internalQuery({
  args: { passId: v.string() },
  returns: v.object({
    passId: v.id("attendanceExternalPasses"),
    eventSlug: v.string(),
    eventName: v.string(),
    eventStartsAt: v.number(),
    eventEndsAt: v.number(),
    eventTimezone: v.string(),
    venueName: v.string(),
    participantName: v.string(),
    teamName: v.string(),
    encryptedBearer: v.string(),
    bearerIv: v.string(),
    bearerAuthTag: v.string(),
  }),
  handler: async (ctx, args) => {
    const passId = ctx.db.normalizeId("attendanceExternalPasses", args.passId);
    const pass = passId ? await ctx.db.get(passId) : null;
    if (!pass || pass.state !== "active") {
      throw new ConvexError({
        code: "EXTERNAL_PASS_NOT_AVAILABLE",
        message: "This external event pass is not active.",
      });
    }
    const [event, membership] = await Promise.all([
      ctx.db.get(pass.eventId),
      ctx.db.get(pass.membershipId),
    ]);
    if (
      !event ||
      !membership ||
      membership.eventId !== pass.eventId ||
      membership.participantClass !== "external_participant" ||
      membership.eligibilityStatus !== "eligible" ||
      membership.onboardingStatus !== "accepted"
    ) {
      throw new ConvexError({
        code: "EXTERNAL_PASS_NOT_AVAILABLE",
        message: "This external event pass no longer belongs to an accepted participant.",
      });
    }
    const [person, teamMember, communicationsPolicy] = await Promise.all([
      ctx.db.get(membership.personId),
      ctx.db
        .query("teamMembers")
        .withIndex("by_event_membership_status", (index) =>
          index.eq("eventId", event._id).eq("membershipId", membership._id).eq("status", "active"),
        )
        .unique(),
      event.publishedCommunicationsPolicyId
        ? ctx.db.get(event.publishedCommunicationsPolicyId)
        : null,
    ]);
    if (
      !person ||
      !teamMember ||
      !communicationsPolicy ||
      communicationsPolicy.eventId !== event._id ||
      communicationsPolicy.status !== "published"
    ) {
      throw new ConvexError({
        code: "EXTERNAL_PASS_NOT_AVAILABLE",
        message: "The event pass details are not currently available.",
      });
    }
    const team = await ctx.db.get(teamMember.teamId);
    if (!team || team.eventId !== event._id) {
      throw new Error("The external event pass team is missing.");
    }
    return {
      passId: pass._id,
      eventSlug: event.slug,
      eventName: event.name,
      eventStartsAt: communicationsPolicy.startsAt,
      eventEndsAt: communicationsPolicy.endsAt,
      eventTimezone: event.timezone,
      venueName: communicationsPolicy.venueName,
      participantName: person.displayName,
      teamName: team.name,
      encryptedBearer: pass.encryptedBearer,
      bearerIv: pass.bearerIv,
      bearerAuthTag: pass.bearerAuthTag,
    };
  },
});
