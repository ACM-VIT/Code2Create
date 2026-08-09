import { ConvexError, v } from "convex/values";

import { query } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import {
  floorAreaLoad,
  placedTeamsInZone,
  publishedFloorPlan,
  teamCanBeMapped,
} from "./lib/floor";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { matchingPermissionGrantIds } from "./lib/permissions";
import { floorActiveMappingState, floorArea } from "./values";

/**
 * The hall as operations sees it: one rectangle per zone, the landmarks that
 * make it recognisable, a dot for every team currently sitting in it, and a
 * count for each part of the room so a busy corner is visible before anyone
 * walks into it.
 */
export const overview = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      plan: v.object({
        id: v.id("floorPlanVersions"),
        name: v.string(),
        planNumber: v.number(),
        mappingState: floorActiveMappingState,
        version: v.number(),
      }),
      canSeeAll: v.boolean(),
      visibleMappedCount: v.number(),
      eligibleTeamCount: v.optional(v.number()),
      unmappedTeams: v.optional(v.array(v.object({ id: v.id("teams"), name: v.string() }))),
      lastMappedAt: v.optional(v.number()),
      zones: v.array(
        v.object({
          id: v.id("floorZones"),
          name: v.string(),
          widthMeters: v.number(),
          depthMeters: v.number(),
          landmarks: v.array(
            v.object({
              id: v.id("floorLandmarks"),
              name: v.string(),
              x: v.number(),
              y: v.number(),
            }),
          ),
          teams: v.array(
            v.object({
              teamId: v.id("teams"),
              teamName: v.string(),
              x: v.number(),
              y: v.number(),
              area: floorArea,
              mappedAt: v.number(),
            }),
          ),
          areas: v.array(v.object({ area: floorArea, teamCount: v.number() })),
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
    const zones = await ctx.db
      .query("floorZones")
      .withIndex("by_plan_order", (index) => index.eq("planVersionId", plan._id))
      .collect();
    const [eventGrantIds, grantsByZone] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "floor.location.read",
        scopeType: "event",
      }),
      Promise.all(
        zones.map((zone) =>
          matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: "floor.location.read",
            scopeType: "floor_zone",
            scopeId: zone._id,
          }),
        ),
      ),
    ]);
    const visibleZones = zones.filter((_, index) => (grantsByZone[index]?.length ?? 0) > 0);
    if (visibleZones.length === 0) {
      throw new ConvexError({ code: "ACCESS_DENIED", message: "This account cannot read a floor-plan zone." });
    }
    const [landmarks, locations, teams] = await Promise.all([
      ctx.db
        .query("floorLandmarks")
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
    const visibleZoneIds = new Set(visibleZones.map((zone) => zone._id));
    const visibleLocations = locations.filter((location) => visibleZoneIds.has(location.zoneId));
    const teamById = new Map(teams.map((team) => [team._id, team]));
    const eligibleTeams = teams.filter((team) => teamCanBeMapped(team.status));
    const mappedTeamIds = new Set(locations.map((location) => location.teamId));
    const canSeeAll = eventGrantIds.length > 0;
    return {
      plan: {
        id: plan._id,
        name: plan.name,
        planNumber: plan.planNumber,
        mappingState: plan.mappingState,
        version: plan.version,
      },
      canSeeAll,
      visibleMappedCount: visibleLocations.length,
      ...(canSeeAll
        ? {
            eligibleTeamCount: eligibleTeams.length,
            unmappedTeams: eligibleTeams
              .filter((team) => !mappedTeamIds.has(team._id))
              .map((team) => ({ id: team._id, name: team.name })),
          }
        : {}),
      ...(visibleLocations.length > 0
        ? { lastMappedAt: Math.max(...visibleLocations.map((location) => location.mappedAt)) }
        : {}),
      zones: visibleZones.map((zone) => {
        const placed = placedTeamsInZone(visibleLocations, teamById, zone._id);
        return {
          id: zone._id,
          name: zone.name,
          widthMeters: zone.widthMeters,
          depthMeters: zone.depthMeters,
          landmarks: landmarks
            .filter((landmark) => landmark.zoneId === zone._id)
            .map((landmark) => ({
              id: landmark._id,
              name: landmark.name,
              x: landmark.x,
              y: landmark.y,
            })),
          teams: placed,
          areas: floorAreaLoad(placed),
        };
      }),
    };
  },
});
