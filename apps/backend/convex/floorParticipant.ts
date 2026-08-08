import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  activeTeamFloorLocation,
  currentTeamForMembership,
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
import { requirePermission } from "./lib/permissions";

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      teamId: v.id("teams"),
      teamName: v.string(),
      planName: v.string(),
      mappingState: v.union(v.literal("open"), v.literal("frozen")),
      canMintQr: v.boolean(),
      location: v.union(
        v.null(),
        v.object({
          id: v.id("teamFloorLocations"),
          zoneName: v.string(),
          spotLabel: v.string(),
          x: v.number(),
          y: v.number(),
          accessible: v.boolean(),
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
    const [zone, spot] = location
      ? await Promise.all([ctx.db.get(location.zoneId), ctx.db.get(location.spotId)])
      : [null, null];
    if (location && (!zone || !spot || zone.eventId !== event._id || spot.eventId !== event._id)) {
      throw new Error("The active team location is incomplete.");
    }
    return {
      teamId: teamContext.team._id,
      teamName: teamContext.team.name,
      planName: plan.name,
      mappingState: plan.mappingState,
      canMintQr: true,
      location:
        location && zone && spot
          ? {
              id: location._id,
              zoneName: zone.name,
              spotLabel: spot.label,
              x: spot.x,
              y: spot.y,
              accessible: spot.accessible,
              mappedAt: location.mappedAt,
            }
          : null,
    };
  },
});

export const mintTeamQr = mutation({
  args: { eventSlug: v.string() },
  returns: v.object({
    payload: v.string(),
    manualCode: v.string(),
    expiresAt: v.number(),
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
        message: "A hall-location code is available only to an accepted team during floor mapping.",
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
    const existingTokens = await ctx.db
      .query("floorTeamQrTokens")
      .withIndex("by_team_state", (index) => index.eq("teamId", teamContext.team._id))
      .collect();
    const now = Date.now();
    for (const token of existingTokens.filter((candidate) => candidate.state === "active")) {
      await ctx.db.patch(token._id, {
        state: token.expiresAt <= now ? "expired" : "superseded",
      });
    }
    const payload = `c2c-floor-v1.${randomFloorToken()}`;
    const manualCode = randomFloorManualCode();
    const expiresAt = now + 10 * 60_000;
    const tokenVersion =
      existingTokens.reduce((maximum, token) => Math.max(maximum, token.tokenVersion), 0) + 1;
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
    return { payload, manualCode, expiresAt, teamName: teamContext.team.name, planName: plan.name };
  },
});
