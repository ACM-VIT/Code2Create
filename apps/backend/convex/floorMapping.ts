import { floorAreaAt, floorAreas } from "@code2create/domain";
import { ConvexError, v } from "convex/values";
import { z } from "zod";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  activeTeamFloorLocation,
  describeTeamFloorLocation,
  floorAreaLoad,
  floorCoordinate,
  floorDigest,
  floorLocationDescription,
  maximumFloorLandmarksPerZone,
  maximumFloorZones,
  nearestLandmarkName,
  placedTeamsInZone,
  publishedFloorPlan,
  teamCanBeMapped,
  zoneLandmarks,
} from "./lib/floor";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
} from "./lib/operations";
import { normalizedText } from "./lib/strings";
import { maximumReviewTeamsPerEvent } from "./lib/reviewLimits";
import { floorActiveMappingState, floorArea, floorMappingMode } from "./values";

const landmarkView = v.object({
  id: v.id("floorLandmarks"),
  name: v.string(),
  x: v.number(),
  y: v.number(),
});

const placedTeamView = v.object({
  teamId: v.id("teams"),
  teamName: v.string(),
  x: v.number(),
  y: v.number(),
  area: floorArea,
  mappedAt: v.number(),
});

/** How many teams are sitting in each part of a zone, in reading order. */
const areaLoadView = v.object({ area: floorArea, teamCount: v.number() });

const claimOperationResult = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    expiresAt: z.number(),
    mode: z.enum(["map", "override"]),
    team: z.object({ id: z.string().min(1), name: z.string() }).strict(),
    currentLocation: z
      .object({
        id: z.string().min(1),
        zoneId: z.string().min(1),
        zoneName: z.string(),
        x: z.number().finite(),
        y: z.number().finite(),
        area: z.enum(floorAreas),
        description: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const assignmentOperationResult = z
  .object({
    locationId: z.string().min(1),
    teamName: z.string(),
    zoneName: z.string(),
    x: z.number().finite(),
    y: z.number().finite(),
    area: z.enum(floorAreas),
    description: z.string(),
    unchanged: z.boolean(),
  })
  .strict();

const claimView = v.object({
  id: v.id("floorMappingClaims"),
  version: v.number(),
  expiresAt: v.number(),
  mode: floorMappingMode,
  team: v.object({ id: v.id("teams"), name: v.string() }),
  currentLocation: v.union(
    v.null(),
    v.object({
      id: v.id("teamFloorLocations"),
      zoneId: v.id("floorZones"),
      zoneName: v.string(),
      x: v.number(),
      y: v.number(),
      area: floorArea,
      description: v.string(),
    }),
  ),
});

export const summary = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      mappingState: floorActiveMappingState,
      placedTeamCount: v.number(),
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
      .take(maximumFloorZones + 1);
    if (zones.length > maximumFloorZones) {
      throw new Error(`A floor plan cannot contain more than ${maximumFloorZones} zones.`);
    }
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
    const visibleZones = zones.filter(
      (_, index) => (grantsByZone[index]?.length ?? 0) > 0,
    );
    if (visibleZones.length === 0) return null;
    let placedTeamCount = 0;
    for (const zone of visibleZones) {
      const locations = await ctx.db
        .query("teamFloorLocations")
        .withIndex("by_zone_state", (index) =>
          index.eq("zoneId", zone._id).eq("state", "active"),
        )
        .take(maximumReviewTeamsPerEvent - placedTeamCount + 1);
      placedTeamCount += locations.length;
      if (placedTeamCount > maximumReviewTeamsPerEvent) {
        throw new Error(
          `A floor plan cannot contain more than ${maximumReviewTeamsPerEvent} active team locations.`,
        );
      }
    }
    return {
      mappingState: plan.mappingState,
      placedTeamCount,
    };
  },
});

/** Returns the zones, landmarks, placed teams, and area load visible to a mapper. */
export const available = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      serverNow: v.number(),
      plan: v.object({
        id: v.id("floorPlanVersions"),
        name: v.string(),
        version: v.number(),
        mappingState: floorActiveMappingState,
      }),
      mode: floorMappingMode,
      zones: v.array(
        v.object({
          id: v.id("floorZones"),
          name: v.string(),
          widthMeters: v.number(),
          depthMeters: v.number(),
          landmarks: v.array(landmarkView),
          teams: v.array(placedTeamView),
          areas: v.array(areaLoadView),
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
      .take(maximumFloorZones + 1);
    if (zones.length > maximumFloorZones) {
      throw new Error(`A floor plan cannot contain more than ${maximumFloorZones} zones.`);
    }
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
    const zoneViews = [];
    let placedTeamCount = 0;
    for (const zone of visibleZones) {
      const [landmarks, locations] = await Promise.all([
        ctx.db
          .query("floorLandmarks")
          .withIndex("by_zone_order", (index) => index.eq("zoneId", zone._id))
          .take(maximumFloorLandmarksPerZone + 1),
        ctx.db
          .query("teamFloorLocations")
          .withIndex("by_zone_state", (index) =>
            index.eq("zoneId", zone._id).eq("state", "active"),
          )
          .take(maximumReviewTeamsPerEvent - placedTeamCount + 1),
      ]);
      if (
        landmarks.length < 1 ||
        landmarks.length > maximumFloorLandmarksPerZone
      ) {
        throw new Error("A visible floor zone does not match its landmark limits.");
      }
      placedTeamCount += locations.length;
      if (placedTeamCount > maximumReviewTeamsPerEvent) {
        throw new Error(
          `A floor plan cannot contain more than ${maximumReviewTeamsPerEvent} active team locations.`,
        );
      }
      const teams = await Promise.all(
        locations.map((location) => ctx.db.get(location.teamId)),
      );
      const teamById = new Map<Id<"teams">, Doc<"teams">>();
      for (const [index, location] of locations.entries()) {
        const team = teams[index];
        if (
          !team ||
          team.eventId !== event._id ||
          location.eventId !== event._id ||
          location.planVersionId !== plan._id ||
          location.zoneId !== zone._id
        ) {
          throw new Error("A visible floor location is outside its event or zone.");
        }
        teamById.set(team._id, team);
      }
      const placed = placedTeamsInZone(locations, teamById, zone._id);
      zoneViews.push({
        id: zone._id,
        name: zone.name,
        widthMeters: zone.widthMeters,
        depthMeters: zone.depthMeters,
        landmarks: landmarks.map((landmark) => ({
          id: landmark._id,
          name: landmark.name,
          x: landmark.x,
          y: landmark.y,
        })),
        teams: placed,
        areas: floorAreaLoad(placed),
      });
    }
    return {
      serverNow: Date.now(),
      plan: { id: plan._id, name: plan.name, version: plan.version, mappingState: plan.mappingState },
      mode,
      zones: zoneViews,
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
      const result = storedOperationResult(
        prior.resultJson,
        "mapping claim",
        claimOperationResult,
      );
      const claimId = ctx.db.normalizeId("floorMappingClaims", result.id);
      const teamId = ctx.db.normalizeId("teams", result.team.id);
      const currentLocation = result.currentLocation;
      const locationId = currentLocation
        ? ctx.db.normalizeId("teamFloorLocations", currentLocation.id)
        : null;
      const zoneId = currentLocation
        ? ctx.db.normalizeId("floorZones", currentLocation.zoneId)
        : null;
      if (
        !claimId ||
        !teamId ||
        claimId !== prior.targetId ||
        (currentLocation !== null && (!locationId || !zoneId))
      ) {
        throw new Error("Prior mapping claim is unavailable.");
      }
      return {
        ...result,
        id: claimId,
        team: { ...result.team, id: teamId },
        currentLocation:
          currentLocation && locationId && zoneId
            ? { ...currentLocation, id: locationId, zoneId }
            : null,
      };
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
    const claim = await ctx.db.get(claimId);
    if (!claim) throw new Error("Mapping claim did not persist.");
    const result = await claimResult(ctx, claim);
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "floor.team_qr.claim",
      requestFingerprint,
      targetType: "floor_mapping_claim",
      targetId: claimId,
      resultJson: JSON.stringify(result),
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
    return result;
  },
});

/** Records a mapped position; only concurrent updates to the same team conflict. */
export const assignClaim = mutation({
  args: {
    eventSlug: v.string(),
    claimId: v.string(),
    x: v.number(),
    y: v.number(),
    expectedClaimVersion: v.number(),
    reason: v.optional(v.string()),
    clientOperationId: v.string(),
  },
  returns: v.object({
    locationId: v.id("teamFloorLocations"),
    teamName: v.string(),
    zoneName: v.string(),
    x: v.number(),
    y: v.number(),
    area: floorArea,
    description: v.string(),
    unchanged: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const claimId = ctx.db.normalizeId("floorMappingClaims", args.claimId);
    if (!claimId) {
      throw new ConvexError({
        code: "FLOOR_CLAIM_UNAVAILABLE",
        message: "Scan the team's current code again.",
      });
    }
    const x = floorCoordinate(args.x, "Position across the zone");
    const y = floorCoordinate(args.y, "Position along the zone");
    const requestFingerprint = operationFingerprint([
      claimId,
      x,
      y,
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
      const result = storedOperationResult(
        prior.resultJson,
        "floor assignment",
        assignmentOperationResult,
      );
      const locationId = ctx.db.normalizeId("teamFloorLocations", result.locationId);
      if (!locationId || prior.targetId !== claimId) {
        throw new Error("Prior floor assignment is unavailable.");
      }
      return { ...result, locationId };
    }
    const claim = await ctx.db.get(claimId);
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
    const [plan, zone, team] = await Promise.all([
      ctx.db.get(claim.planVersionId),
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
      !zone ||
      !team ||
      zone.eventId !== event._id ||
      zone.planVersionId !== plan._id ||
      team.eventId !== event._id ||
      !teamCanBeMapped(team.status)
    ) {
      throw new ConvexError({ code: "FLOOR_ZONE_UNAVAILABLE", message: "Choose a zone in the current floor plan." });
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
    const reason =
      claim.mode === "override"
        ? normalizedText(args.reason ?? "", "Override reason", 5, 300)
        : undefined;
    const area = floorAreaAt(x, y);
    // Each accepted scan is a new sighting even when its visible location is unchanged.
    const unchanged =
      currentLocation !== null &&
      currentLocation.zoneId === zone._id &&
      currentLocation.area === area;
    const locationId: Id<"teamFloorLocations"> = await ctx.db.insert("teamFloorLocations", {
      eventId: event._id,
      planVersionId: plan._id,
      teamId: team._id,
      zoneId: zone._id,
      x,
      y,
      area,
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
    await ctx.db.patch(claim._id, {
      state: "completed",
      version: claim.version + 1,
      completedAt: now,
      locationId,
    });
    const completedClaim = await ctx.db.get(claim._id);
    if (!completedClaim) throw new Error("Completed mapping claim is unavailable.");
    const result = await assignmentResult(ctx, completedClaim, locationId);
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "floor.location.assign",
      requestFingerprint,
      targetType: "floor_mapping_claim",
      targetId: claim._id,
      resultJson: JSON.stringify(result),
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
        ? {
            previousSummary: JSON.stringify({
              locationId: currentLocation._id,
              zoneId: currentLocation.zoneId,
              area: currentLocation.area,
              x: currentLocation.x,
              y: currentLocation.y,
            }),
          }
        : {}),
      nextSummary: JSON.stringify({ locationId, teamId: team._id, zoneId: zone._id, area, x, y, unchanged }),
      reason: reason ?? "Floor mapper confirmed where the team is sitting from the team's QR",
    });
    return result;
  },
});

async function claimResult(ctx: MutationCtx, claim: Doc<"floorMappingClaims">) {
  const team = await ctx.db.get(claim.teamId);
  if (!team) throw new Error("Mapping claim team is unavailable.");
  const currentLocation = claim.expectedLocationId
    ? await ctx.db.get(claim.expectedLocationId)
    : null;
  const described = currentLocation ? await describeTeamFloorLocation(ctx, currentLocation) : null;
  return {
    id: claim._id,
    version: 1,
    expiresAt: claim.expiresAt,
    mode: claim.mode,
    team: { id: team._id, name: team.name },
    currentLocation:
      currentLocation && described
        ? {
            id: currentLocation._id,
            zoneId: described.zone._id,
            zoneName: described.zone.name,
            x: currentLocation.x,
            y: currentLocation.y,
            area: currentLocation.area,
            description: described.description,
          }
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
  const [zone, landmarks, superseded] = await Promise.all([
    ctx.db.get(location.zoneId),
    zoneLandmarks(ctx, location.zoneId),
    location.supersedesLocationId ? ctx.db.get(location.supersedesLocationId) : Promise.resolve(null),
  ]);
  if (!zone) throw new Error("The recorded team location has no zone.");
  return {
    locationId,
    teamName: team.name,
    zoneName: zone.name,
    x: location.x,
    y: location.y,
    area: location.area,
    description: floorLocationDescription(
      zone.name,
      location.area,
      nearestLandmarkName(zone, landmarks, location.x, location.y),
    ),
    unchanged:
      superseded !== null &&
      superseded.zoneId === location.zoneId &&
      superseded.area === location.area,
  };
}

function invalidTeamCode() {
  return new ConvexError({ code: "FLOOR_QR_INVALID", message: "That is not a current team location code." });
}
