import { ConvexError, v } from "convex/values";

import { query } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { publishedFloorPlan, teamCanBeMapped } from "./lib/floor";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { matchingPermissionGrantIds } from "./lib/permissions";

export const overview = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      plan: v.object({
        id: v.id("floorPlanVersions"),
        name: v.string(),
        planNumber: v.number(),
        mappingState: v.union(v.literal("open"), v.literal("frozen")),
        version: v.number(),
      }),
      canSeeAll: v.boolean(),
      visibleMappedCount: v.number(),
      visibleSpotCount: v.number(),
      eligibleTeamCount: v.optional(v.number()),
      unmappedTeams: v.optional(v.array(v.object({ id: v.id("teams"), name: v.string() }))),
      lastMappedAt: v.optional(v.number()),
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
              status: v.union(v.literal("available"), v.literal("closed")),
              team: v.union(
                v.null(),
                v.object({
                  id: v.id("teams"),
                  name: v.string(),
                  mappedAt: v.number(),
                }),
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
    const visibleZoneIds = new Set(visibleZones.map((zone) => zone._id));
    const visibleSpots = spots.filter((spot) => visibleZoneIds.has(spot.zoneId));
    const visibleLocations = locations.filter((location) => visibleZoneIds.has(location.zoneId));
    const locationBySpot = new Map(visibleLocations.map((location) => [location.spotId, location]));
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
      visibleSpotCount: visibleSpots.filter((spot) => spot.status === "available").length,
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
      zones: visibleZones.map((zone) => ({
        id: zone._id,
        name: zone.name,
        spots: visibleSpots
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
              status: spot.status,
              team:
                location && team
                  ? { id: team._id, name: team.name, mappedAt: location.mappedAt }
                  : null,
            };
          }),
      })),
    };
  },
});
