import { Presence } from "@convex-dev/presence";
import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { currentReadTeamContext, currentTeamContext } from "./intake";
import { applicationsCloseAtFor, requireRegistrationOpen } from "./lib/events";
import { requireCurrentPerson } from "./lib/identity";
import { requirePermission } from "./lib/permissions";

const editingSurface = v.union(
  v.literal("idea"),
  v.literal("follow_up"),
  v.literal("proposal_revision"),
);
type EditingSurface = "idea" | "follow_up" | "proposal_revision";

const heartbeatIntervalMs = 4_000;
const maximumTeamMembers = 5;
const presence = new Presence<string, Id<"eventMemberships">>(components.intakePresence);

function roomId(teamId: Id<"teams">, surface: EditingSurface) {
  return `intake:${teamId}:${surface}`;
}

export const heartbeat = mutation({
  args: {
    eventSlug: v.string(),
    surface: editingSurface,
    sessionId: v.string(),
  },
  returns: v.object({
    roomToken: v.string(),
    sessionToken: v.string(),
  }),
  handler: async (ctx, args) => {
    const { event, subject, membership, member, team } =
      await currentTeamContext(ctx, args.eventSlug);
    if (args.surface === "proposal_revision") {
      if (
        Date.now() >= applicationsCloseAtFor(event, membership.participantClass)
      ) {
        throw new ConvexError({
          code: "APPLICATION_DEADLINE_PASSED",
          message: "The application deadline has passed.",
        });
      }
      if (
        !team.membershipLocked ||
        member.role !== "lead" ||
        team.leadMembershipId !== membership._id
      ) {
        throw new ConvexError({
          code: "TEAM_LEAD_REQUIRED",
          message: "Only the current team lead can edit the submitted proposal.",
        });
      }
      await requirePermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "application.submit",
        scopeType: "team",
        scopeId: team._id,
      });
      const application = await ctx.db
        .query("applications")
        .withIndex("by_team", (index) => index.eq("teamId", team._id))
        .unique();
      if (!application || !["submitted", "under_review"].includes(application.state)) {
        throw new ConvexError({
          code: "APPLICATION_NOT_EDITABLE",
          message: "This application can no longer be edited.",
        });
      }
    } else {
      requireRegistrationOpen(event, membership.participantClass);
      if (team.membershipLocked) {
        throw new ConvexError({
          code: "SUBMISSION_LOCKED",
          message: "This team has submitted and the project intake is locked.",
        });
      }
    }
    return presence.heartbeat(
      ctx,
      roomId(team._id, args.surface),
      membership._id,
      args.sessionId,
      heartbeatIntervalMs,
    );
  },
});

export const list = query({
  args: { eventSlug: v.string() },
  returns: v.array(v.object({
    membershipId: v.id("eventMemberships"),
    surface: editingSurface,
  })),
  handler: async (ctx, args) => {
    const context = await currentReadTeamContext(ctx, args.eventSlug);
    if (!context) return [];
    const surfaces: readonly EditingSurface[] = [
      "idea",
      "follow_up",
      "proposal_revision",
    ];
    const bySurface = await Promise.all(surfaces.map(async (surface) => ({
      surface,
      members: await presence.listRoom(
        ctx,
        roomId(context.team._id, surface),
        true,
        maximumTeamMembers,
      ),
    })));
    return bySurface.flatMap(({ surface, members }) =>
      members
        .filter(({ userId }) => userId !== context.member.membershipId)
        .map(({ userId }) => ({ membershipId: userId, surface })),
    );
  },
});

export const disconnect = mutation({
  args: { sessionToken: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireCurrentPerson(ctx);
    return presence.disconnect(ctx, args.sessionToken);
  },
});
