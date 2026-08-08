import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  activeTeamFloorLocation,
  floorDigest,
  publishedFloorPlan,
  teamCanBeMapped,
} from "./lib/floor";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { normalizedText } from "./lib/strings";

const mappingMode = v.union(v.literal("map"), v.literal("override"));

const claimView = v.object({
  id: v.id("floorMappingClaims"),
  version: v.number(),
  expiresAt: v.number(),
  mode: mappingMode,
  team: v.object({ id: v.id("teams"), name: v.string() }),
  currentLocation: v.union(
    v.null(),
    v.object({
      id: v.id("teamFloorLocations"),
      zoneName: v.string(),
      spotLabel: v.string(),
    }),
  ),
});

export const available = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      plan: v.object({
        id: v.id("floorPlanVersions"),
        name: v.string(),
        version: v.number(),
        mappingState: v.union(v.literal("open"), v.literal("frozen")),
      }),
      mode: mappingMode,
      zones: v.array(
        v.object({
          id: v.id("floorZones"),
          name: v.string(),
          spots: v.array(
            v.object({
              id: v.id("floorSpots"),
              label: v.string(),
              x: v.number(),
              y: v.number(),
              accessible: v.boolean(),
              occupiedBy: v.union(
                v.null(),
                v.object({ teamId: v.id("teams"), teamName: v.string() }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const plan = await publishedFloorPlan(ctx, event);
    if (!plan || plan.mappingState === "setup") return null;
    const mode: "map" | "override" = plan.mappingState === "open" ? "map" : "override";
    const permissionKey = mode === "map" ? "floor.location.map" : "floor.location.override";
    const zones = await ctx.db
      .query("floorZones")
      .withIndex("by_plan_order", (index) => index.eq("planVersionId", plan._id))
      .collect();
    const grantsByZone = await Promise.all(
      zones.map((zone) =>
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey,
          scopeType: "floor_zone",
          scopeId: zone._id,
        }),
      ),
    );
    const visibleZones = zones.filter((_, index) => (grantsByZone[index]?.length ?? 0) > 0);
    if (visibleZones.length === 0) return null;
    const [spots, locations, teams] = await Promise.all([
      ctx.db
        .query("floorSpots")
        .withIndex("by_plan_order", (index) => index.eq("planVersionId", plan._id))
        .collect(),
      ctx.db
        .query("teamFloorLocations")
        .withIndex("by_plan_state", (index) => index.eq("planVersionId", plan._id).eq("state", "active"))
        .collect(),
      ctx.db
        .query("teams")
        .withIndex("by_event_status", (index) => index.eq("eventId", event._id))
        .collect(),
    ]);
    const locationBySpot = new Map(locations.map((location) => [location.spotId, location]));
    const teamById = new Map(teams.map((team) => [team._id, team]));
    return {
      plan: { id: plan._id, name: plan.name, version: plan.version, mappingState: plan.mappingState },
      mode,
      zones: await Promise.all(
        visibleZones.map(async (zone) => {
          return {
            id: zone._id,
            name: zone.name,
            spots: spots
                .filter((spot) => spot.status === "available")
                .filter((spot) => spot.zoneId === zone._id)
                .map((spot) => {
                  const location = locationBySpot.get(spot._id);
                  const team = location ? teamById.get(location.teamId) : undefined;
                  return {
                    id: spot._id,
                    label: spot.label,
                    x: spot.x,
                    y: spot.y,
                    accessible: spot.accessible,
                    occupiedBy:
                      location && team
                        ? { teamId: team._id, teamName: team.name }
                        : null,
                  };
                }),
          };
        }),
      ),
    };
  },
});

export const claimTeamQr = mutation({
  args: {
    eventSlug: v.string(),
    destinationZoneId: v.id("floorZones"),
    credential: v.string(),
    clientOperationId: v.string(),
  },
  returns: claimView,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.destinationZoneId,
      floorDigest(args.credential.trim()),
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "floor.team_qr.claim",
      requestFingerprint,
    });
    if (prior) {
      const claimId = ctx.db.normalizeId("floorMappingClaims", prior.targetId);
      const claim = claimId ? await ctx.db.get(claimId) : null;
      if (!claim) throw new Error("Prior mapping claim is unavailable.");
      return claimResult(ctx, claim);
    }
    const plan = await publishedFloorPlan(ctx, event);
    const zone = await ctx.db.get(args.destinationZoneId);
    if (
      !plan ||
      plan.mappingState === "setup" ||
      !zone ||
      zone.eventId !== event._id ||
      zone.planVersionId !== plan._id
    ) {
      throw new ConvexError({ code: "FLOOR_ZONE_UNAVAILABLE", message: "Choose a zone in the current floor plan." });
    }
    const mode: "map" | "override" = plan.mappingState === "open" ? "map" : "override";
    const permissionKey = mode === "map" ? "floor.location.map" : "floor.location.override";
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const destinationGrantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey,
      scopeType: "floor_zone",
      scopeId: zone._id,
    });
    const credential = args.credential.trim();
    if (credential.length < 8 || credential.length > 120) {
      throw invalidTeamCode();
    }
    const isQr = /^c2c-floor-v1\.[a-f0-9]{64}$/.test(credential);
    const manualCode = credential.toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
    const token = isQr
      ? await ctx.db
          .query("floorTeamQrTokens")
          .withIndex("by_digest", (index) => index.eq("tokenDigest", floorDigest(credential)))
          .unique()
      : manualCode.length === 10
        ? await ctx.db
            .query("floorTeamQrTokens")
            .withIndex("by_manual_digest", (index) => index.eq("manualCodeDigest", floorDigest(manualCode)))
            .unique()
        : null;
    const now = Date.now();
    if (
      !token ||
      token.eventId !== event._id ||
      token.planVersionId !== plan._id ||
      token.state !== "active"
    ) {
      throw invalidTeamCode();
    }
    if (token.expiresAt <= now) {
      throw new ConvexError({ code: "FLOOR_QR_EXPIRED", message: "That team code expired. Ask the team to refresh it." });
    }
    const team = await ctx.db.get(token.teamId);
    if (!team || team.eventId !== event._id || !teamCanBeMapped(team.status)) {
      throw invalidTeamCode();
    }
    const currentLocation = await activeTeamFloorLocation(ctx, team._id);
    let grantIds = destinationGrantIds;
    if (currentLocation && currentLocation.zoneId !== zone._id) {
      const originGrantIds = await requirePermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey,
        scopeType: "floor_zone",
        scopeId: currentLocation.zoneId,
      });
      grantIds = [...new Set([...destinationGrantIds, ...originGrantIds])];
    }
    const claimId = await ctx.db.insert("floorMappingClaims", {
      eventId: event._id,
      planVersionId: plan._id,
      teamId: team._id,
      destinationZoneId: zone._id,
      tokenId: token._id,
      operatorPersonId: person._id,
      mode,
      ...(currentLocation
        ? { expectedLocationId: currentLocation._id, expectedLocationVersion: currentLocation.version }
        : {}),
      state: "active",
      version: 1,
      expiresAt: now + 3 * 60_000,
      createdAt: now,
    });
    await ctx.db.patch(token._id, { state: "used", usedAt: now });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "floor.team_qr.claim",
      requestFingerprint,
      targetType: "floor_mapping_claim",
      targetId: claimId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey,
      grantIds,
      scopeType: "floor_zone",
      scopeId: zone._id,
      action: "floor.team_qr_claimed",
      targetType: "floor_mapping_claim",
      targetId: claimId,
      nextSummary: JSON.stringify({ teamId: team._id, destinationZoneId: zone._id, mode, expiresAt: now + 3 * 60_000 }),
      reason: "Floor mapper scanned the team's current dashboard code",
    });
    const claim = await ctx.db.get(claimId);
    if (!claim) throw new Error("Mapping claim did not persist.");
    return claimResult(ctx, claim);
  },
});

export const assignClaim = mutation({
  args: {
    eventSlug: v.string(),
    claimId: v.id("floorMappingClaims"),
    spotId: v.id("floorSpots"),
    expectedClaimVersion: v.number(),
    reason: v.optional(v.string()),
    clientOperationId: v.string(),
  },
  returns: v.object({
    locationId: v.id("teamFloorLocations"),
    teamName: v.string(),
    zoneName: v.string(),
    spotLabel: v.string(),
    unchanged: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.claimId,
      args.spotId,
      args.expectedClaimVersion,
      args.reason ?? "",
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "floor.location.assign",
      requestFingerprint,
    });
    if (prior) {
      const claimId = ctx.db.normalizeId("floorMappingClaims", prior.targetId);
      const claim = claimId ? await ctx.db.get(claimId) : null;
      if (!claim?.locationId) throw new Error("Prior floor assignment is unavailable.");
      return assignmentResult(ctx, claim, claim.locationId);
    }
    const claim = await ctx.db.get(args.claimId);
    if (
      !claim ||
      claim.eventId !== event._id ||
      claim.operatorPersonId !== person._id ||
      claim.state !== "active"
    ) {
      throw new ConvexError({ code: "FLOOR_CLAIM_UNAVAILABLE", message: "Scan the team's current code again." });
    }
    if (claim.version !== args.expectedClaimVersion) {
      throw new ConvexError({ code: "FLOOR_CLAIM_CHANGED", message: "This mapping step changed. Scan the team code again." });
    }
    const now = Date.now();
    if (claim.expiresAt <= now) {
      throw new ConvexError({ code: "FLOOR_CLAIM_EXPIRED", message: "This mapping step expired. Scan the team code again." });
    }
    const [plan, spot, zone, team] = await Promise.all([
      ctx.db.get(claim.planVersionId),
      ctx.db.get(args.spotId),
      ctx.db.get(claim.destinationZoneId),
      ctx.db.get(claim.teamId),
    ]);
    if (
      !plan ||
      plan.eventId !== event._id ||
      event.publishedFloorPlanVersionId !== plan._id ||
      plan.status !== "published" ||
      (claim.mode === "map" ? plan.mappingState !== "open" : plan.mappingState !== "frozen")
    ) {
      throw new ConvexError({ code: "FLOOR_PLAN_CHANGED", message: "The floor plan changed. Scan the team code again." });
    }
    if (
      !spot ||
      !zone ||
      !team ||
      spot.eventId !== event._id ||
      spot.planVersionId !== plan._id ||
      spot.zoneId !== zone._id ||
      zone.eventId !== event._id ||
      zone.planVersionId !== plan._id ||
      team.eventId !== event._id ||
      !teamCanBeMapped(team.status) ||
      spot.status !== "available"
    ) {
      throw new ConvexError({ code: "FLOOR_SPOT_UNAVAILABLE", message: "Choose an available spot in the selected zone." });
    }
    const permissionKey = claim.mode === "map" ? "floor.location.map" : "floor.location.override";
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const destinationGrantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey,
      scopeType: "floor_zone",
      scopeId: zone._id,
    });
    const currentLocation = await activeTeamFloorLocation(ctx, team._id);
    if (
      (claim.expectedLocationId === undefined && currentLocation !== null) ||
      (claim.expectedLocationId !== undefined &&
        (!currentLocation ||
          currentLocation._id !== claim.expectedLocationId ||
          currentLocation.version !== claim.expectedLocationVersion))
    ) {
      throw new ConvexError({ code: "TEAM_LOCATION_CHANGED", message: "This team's location changed. Scan its code again." });
    }
    let grantIds = destinationGrantIds;
    if (currentLocation && currentLocation.zoneId !== zone._id) {
      const originGrantIds = await requirePermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey,
        scopeType: "floor_zone",
        scopeId: currentLocation.zoneId,
      });
      grantIds = [...new Set([...destinationGrantIds, ...originGrantIds])];
    }
    const occupied = await ctx.db
      .query("teamFloorLocations")
      .withIndex("by_spot_state", (index) => index.eq("spotId", spot._id).eq("state", "active"))
      .unique();
    if (occupied && occupied.teamId !== team._id) {
      throw new ConvexError({ code: "FLOOR_SPOT_OCCUPIED", message: "Another team was just mapped to that spot. Choose another." });
    }
    const reason =
      claim.mode === "override"
        ? normalizedText(args.reason ?? "", "Override reason", 5, 300)
        : undefined;
    let locationId: Id<"teamFloorLocations">;
    let unchanged = false;
    if (currentLocation && currentLocation.spotId === spot._id) {
      locationId = currentLocation._id;
      unchanged = true;
    } else {
      locationId = await ctx.db.insert("teamFloorLocations", {
        eventId: event._id,
        planVersionId: plan._id,
        teamId: team._id,
        zoneId: zone._id,
        spotId: spot._id,
        state: "active",
        method: claim.mode === "map" ? "team_qr_scan" : "override",
        ...(currentLocation ? { supersedesLocationId: currentLocation._id } : {}),
        version: 1,
        mappedByPersonId: person._id,
        mappedAt: now,
        ...(reason !== undefined ? { reason } : {}),
      });
      if (currentLocation) {
        await ctx.db.patch(currentLocation._id, {
          state: "superseded",
          version: currentLocation.version + 1,
          supersededAt: now,
          supersededByLocationId: locationId,
        });
      }
    }
    await ctx.db.patch(claim._id, {
      state: "completed",
      version: claim.version + 1,
      completedAt: now,
      locationId,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "floor.location.assign",
      requestFingerprint,
      targetType: "floor_mapping_claim",
      targetId: claim._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey,
      grantIds,
      scopeType: "floor_zone",
      scopeId: zone._id,
      action: unchanged ? "floor.location_confirmed" : currentLocation ? "floor.location_moved" : "floor.location_mapped",
      targetType: "team_floor_location",
      targetId: locationId,
      ...(currentLocation
        ? { previousSummary: JSON.stringify({ locationId: currentLocation._id, zoneId: currentLocation.zoneId, spotId: currentLocation.spotId }) }
        : {}),
      nextSummary: JSON.stringify({ locationId, teamId: team._id, zoneId: zone._id, spotId: spot._id, unchanged }),
      reason: reason ?? "Floor mapper confirmed the physical team location from the team's QR",
    });
    const completedClaim = await ctx.db.get(claim._id);
    if (!completedClaim) throw new Error("Completed mapping claim is unavailable.");
    return assignmentResult(ctx, completedClaim, locationId);
  },
});

async function claimResult(ctx: MutationCtx, claim: Doc<"floorMappingClaims">) {
  const team = await ctx.db.get(claim.teamId);
  if (!team) throw new Error("Mapping claim team is unavailable.");
  const currentLocation = claim.expectedLocationId
    ? await ctx.db.get(claim.expectedLocationId)
    : null;
  const [zone, spot] = currentLocation
    ? await Promise.all([ctx.db.get(currentLocation.zoneId), ctx.db.get(currentLocation.spotId)])
    : [null, null];
  return {
    id: claim._id,
    version: 1,
    expiresAt: claim.expiresAt,
    mode: claim.mode,
    team: { id: team._id, name: team.name },
    currentLocation:
      currentLocation && zone && spot
        ? { id: currentLocation._id, zoneName: zone.name, spotLabel: spot.label }
        : null,
  };
}

async function assignmentResult(
  ctx: MutationCtx,
  claim: Doc<"floorMappingClaims">,
  locationId: Id<"teamFloorLocations">,
) {
  const [location, team] = await Promise.all([ctx.db.get(locationId), ctx.db.get(claim.teamId)]);
  if (!location || !team) throw new Error("Floor assignment result is incomplete.");
  const [zone, spot] = await Promise.all([ctx.db.get(location.zoneId), ctx.db.get(location.spotId)]);
  if (!zone || !spot) throw new Error("Floor assignment labels are unavailable.");
  return {
    locationId,
    teamName: team.name,
    zoneName: zone.name,
    spotLabel: spot.label,
    unchanged: claim.expectedLocationId === locationId,
  };
}

function invalidTeamCode() {
  return new ConvexError({ code: "FLOOR_QR_INVALID", message: "That is not a current team location code." });
}
