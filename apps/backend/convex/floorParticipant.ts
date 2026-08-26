import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  activeTeamFloorLocation,
  currentTeamForMembership,
  describeTeamFloorLocation,
  floorDigest,
  publishedFloorPlan,
  randomFloorManualCode,
  randomFloorToken,
  teamCanBeMapped,
} from "./lib/floor";
import {
  findCurrentPerson,
  requireCurrentPerson,
  requireEventSubject,
  requireMembership,
} from "./lib/identity";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { floorActiveMappingState, floorArea, floorTeamQrTokenState } from "./values";

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      teamId: v.id("teams"),
      teamName: v.string(),
      planName: v.string(),
      mappingState: floorActiveMappingState,
      canMintQr: v.boolean(),
      location: v.union(
        v.null(),
        v.object({
          id: v.id("teamFloorLocations"),
          zoneName: v.string(),
          area: floorArea,
          description: v.string(),
          x: v.number(),
          y: v.number(),
          mappedAt: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const person = await findCurrentPerson(ctx);
    if (!person) return null;
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const membership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (index) => index.eq("eventId", event._id).eq("personId", person._id))
      .unique();
    if (!membership) return null;
    const teamContext = await currentTeamForMembership(ctx, event._id, membership._id);
    if (!teamContext || !teamCanBeMapped(teamContext.team.status)) return null;
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "floor.team.read",
      scopeType: "team",
      scopeId: teamContext.team._id,
    });
    const plan = await publishedFloorPlan(ctx, event);
    if (!plan || plan.mappingState === "setup") return null;
    const location = await activeTeamFloorLocation(ctx, teamContext.team._id);
    if (location && location.planVersionId !== plan._id) {
      throw new Error("The active team location belongs to a different floor plan.");
    }
    const described = location ? await describeTeamFloorLocation(ctx, location) : null;
    if (described && described.zone.eventId !== event._id) {
      throw new Error("The active team location is incomplete.");
    }
    const mintGrantIds = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "floor.team_qr.mint",
      scopeType: "team",
      scopeId: teamContext.team._id,
    });
    return {
      teamId: teamContext.team._id,
      teamName: teamContext.team.name,
      planName: plan.name,
      mappingState: plan.mappingState,
      canMintQr: mintGrantIds.length > 0,
      location:
        location && described
          ? {
              id: location._id,
              zoneName: described.zone.name,
              area: location.area,
              description: described.description,
              x: location.x,
              y: location.y,
              mappedAt: location.mappedAt,
            }
          : null,
    };
  },
});

export const teamQrState = query({
  args: {
    eventSlug: v.string(),
    tokenId: v.id("floorTeamQrTokens"),
  },
  returns: v.union(
    v.null(),
    v.object({
      state: floorTeamQrTokenState,
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const membership = await requireMembership(ctx, event._id, person._id);
    const teamContext = await currentTeamForMembership(ctx, event._id, membership._id);
    if (!teamContext) return null;
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "floor.team.read",
      scopeType: "team",
      scopeId: teamContext.team._id,
    });
    const token = await ctx.db.get(args.tokenId);
    if (
      !token ||
      token.eventId !== event._id ||
      token.teamId !== teamContext.team._id
    ) {
      return null;
    }
    return { state: token.state, expiresAt: token.expiresAt };
  },
});

export const mintTeamQr = mutation({
  args: { eventSlug: v.string() },
  returns: v.object({
    tokenId: v.id("floorTeamQrTokens"),
    payload: v.string(),
    manualCode: v.string(),
    expiresAt: v.number(),
    serverNow: v.number(),
    teamName: v.string(),
    planName: v.string(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const membership = await requireMembership(ctx, event._id, person._id);
    const teamContext = await currentTeamForMembership(ctx, event._id, membership._id);
    const plan = await publishedFloorPlan(ctx, event);
    if (!teamContext || !teamCanBeMapped(teamContext.team.status) || !plan || plan.mappingState === "setup") {
      throw new ConvexError({
        code: "FLOOR_QR_UNAVAILABLE",
        message: "A hall-location code is available only to a confirmed team during floor mapping.",
      });
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "floor.team_qr.mint",
      scopeType: "team",
      scopeId: teamContext.team._id,
    });
    const [activeTokens, latestTokens] = await Promise.all([
      ctx.db
        .query("floorTeamQrTokens")
        .withIndex("by_team_state", (index) =>
          index.eq("teamId", teamContext.team._id).eq("state", "active"),
        )
        .take(2),
      ctx.db
        .query("floorTeamQrTokens")
        .withIndex("by_team_version", (index) => index.eq("teamId", teamContext.team._id))
        .order("desc")
        .take(1),
    ]);
    if (activeTokens.length > 1) {
      throw new Error("A team has more than one active hall-location QR.");
    }
    const latestToken = latestTokens[0];
    if (latestToken !== undefined && latestToken.eventId !== event._id) {
      throw new Error("A hall-location QR belongs to the wrong event.");
    }
    const now = Date.now();
    const activeToken = activeTokens[0];
    if (activeToken !== undefined) {
      await ctx.db.patch(activeToken._id, {
        state: activeToken.expiresAt <= now ? "expired" : "superseded",
      });
    }
    const payload = `c2c-floor-v1.${randomFloorToken()}`;
    const manualCode = randomFloorManualCode();
    const expiresAt = now + 10 * 60_000;
    const tokenVersion = (latestToken?.tokenVersion ?? 0) + 1;
    const tokenId = await ctx.db.insert("floorTeamQrTokens", {
      eventId: event._id,
      planVersionId: plan._id,
      teamId: teamContext.team._id,
      tokenDigest: floorDigest(payload),
      manualCodeDigest: floorDigest(manualCode.replaceAll("-", "")),
      tokenVersion,
      state: "active",
      expiresAt,
      issuedByMembershipId: membership._id,
      issuedAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "floor.team_qr.mint",
      grantIds,
      scopeType: "team",
      scopeId: teamContext.team._id,
      action: "floor.team_qr_issued",
      targetType: "floor_team_qr",
      targetId: tokenId,
      nextSummary: JSON.stringify({ planVersionId: plan._id, tokenVersion, expiresAt }),
      reason: "Team member opened the current hall-location QR",
    });
    return {
      tokenId,
      payload,
      manualCode,
      expiresAt,
      serverNow: now,
      teamName: teamContext.team.name,
      planName: plan.name,
    };
  },
});
