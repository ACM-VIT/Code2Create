import { floorAreaLabels, floorAreas } from "@code2create/domain";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { FloorArea } from "../values";

type ReadCtx = QueryCtx | MutationCtx;

/** A landmark is called "near" a team only within this many metres of it. */
const nearLandmarkMeters = 5;

export function floorDigest(value: string) {
  return bytesToHex(sha256(utf8ToBytes(value)));
}

export function floorConfigurationChecksum(value: object) {
  return floorDigest(JSON.stringify(value));
}

export function randomFloorToken() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function randomFloorManualCode() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const compact = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  return `${compact.slice(0, 5)}-${compact.slice(5, 10)}`;
}

export function floorStableKey(value: string, label: string) {
  const key = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(key)) {
    throw new ConvexError({
      code: "INVALID_STABLE_KEY",
      message: `${label} must use lowercase letters, numbers, and underscores.`,
    });
  }
  return key;
}

/**
 * A percentage of a zone rectangle's width or depth. Positions are recorded by
 * a finger on a phone, so two decimal places is already past the accuracy of
 * the gesture; it exists only so a dot lands where it was drawn.
 */
export function floorCoordinate(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new ConvexError({
      code: "INVALID_COORDINATE",
      message: `${label} must be from 0 through 100.`,
    });
  }
  return Math.round(value * 100) / 100;
}


/**
 * What an operator says to a reviewer who has to walk over. A coarse area on
 * its own is not enough in a hall the size of this one, so the nearest
 * published landmark is named whenever the team is standing by one.
 */
export function floorLocationDescription(
  zoneName: string,
  area: FloorArea,
  landmarkName: string | undefined,
) {
  const place = `${floorAreaLabels[area]} of ${zoneName}`;
  return landmarkName === undefined ? place : `${place}, near ${landmarkName}`;
}

/**
 * The landmark a team is standing by, if any. Distance is measured in real
 * metres from the zone's published width and depth, because "near the windows"
 * has to mean a few paces rather than a share of a rectangle.
 */
export function nearestLandmarkName(
  zone: { widthMeters: number; depthMeters: number },
  landmarks: readonly { name: string; x: number; y: number }[],
  x: number,
  y: number,
) {
  let nearest: { name: string; meters: number } | undefined;
  for (const landmark of landmarks) {
    const across = ((landmark.x - x) / 100) * zone.widthMeters;
    const along = ((landmark.y - y) / 100) * zone.depthMeters;
    const meters = Math.hypot(across, along);
    if (meters <= nearLandmarkMeters && (!nearest || meters < nearest.meters)) {
      nearest = { name: landmark.name, meters };
    }
  }
  return nearest?.name;
}

export type PlacedTeam = {
  teamId: Id<"teams">;
  teamName: string;
  x: number;
  y: number;
  area: FloorArea;
  mappedAt: number;
};

/**
 * Every team currently sitting in one zone, as points to draw. Teams are not
 * competing for anything here, so two of them close together is a normal
 * reading of a busy corner rather than a clash to resolve.
 */
export function placedTeamsInZone(
  locations: readonly Doc<"teamFloorLocations">[],
  teamById: ReadonlyMap<Id<"teams">, Doc<"teams">>,
  zoneId: Id<"floorZones">,
): PlacedTeam[] {
  return locations
    .filter((location) => location.zoneId === zoneId)
    .map((location) => {
      const team = teamById.get(location.teamId);
      if (!team) throw new Error("A recorded team location names a team outside this event.");
      return {
        teamId: team._id,
        teamName: team.name,
        x: location.x,
        y: location.y,
        area: location.area,
        mappedAt: location.mappedAt,
      };
    });
}

/**
 * How many teams sit in each of a zone's nine parts. All nine are returned,
 * including the empty ones, because the point of the view is seeing where the
 * room has filled up relative to everywhere else.
 */
export function floorAreaLoad(placed: readonly PlacedTeam[]) {
  return floorAreas.map((area) => ({
    area,
    teamCount: placed.filter((team) => team.area === area).length,
  }));
}

export function teamCanBeMapped(status: Doc<"teams">["status"]) {
  return status === "confirmed" ||
    status === "checked_in" ||
    status === "active";
}

export async function currentTeamForMembership(
  ctx: ReadCtx,
  eventId: Id<"events">,
  membershipId: Id<"eventMemberships">,
) {
  const member = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index.eq("eventId", eventId).eq("membershipId", membershipId).eq("status", "active"),
    )
    .unique();
  if (!member) return null;
  const team = await ctx.db.get(member.teamId);
  return team?.eventId === eventId ? { team, member } : null;
}

export async function publishedFloorPlan(ctx: ReadCtx, event: Doc<"events">) {
  const plan = event.publishedFloorPlanVersionId
    ? await ctx.db.get(event.publishedFloorPlanVersionId)
    : null;
  if (!plan || plan.eventId !== event._id || plan.status !== "published") return null;
  return plan;
}

export async function zoneLandmarks(ctx: ReadCtx, zoneId: Id<"floorZones">) {
  return ctx.db
    .query("floorLandmarks")
    .withIndex("by_zone_order", (index) => index.eq("zoneId", zoneId))
    .collect();
}

export async function activeTeamFloorLocation(
  ctx: ReadCtx,
  teamId: Id<"teams">,
) {
  return ctx.db
    .query("teamFloorLocations")
    .withIndex("by_team_state", (index) => index.eq("teamId", teamId).eq("state", "active"))
    .unique();
}

/**
 * Spells out a recorded location for whoever has to find the team.
 */
export async function describeTeamFloorLocation(
  ctx: ReadCtx,
  location: Doc<"teamFloorLocations">,
) {
  const zone = await ctx.db.get(location.zoneId);
  if (!zone) throw new Error("The recorded team location has no zone.");
  const landmarks = await zoneLandmarks(ctx, zone._id);
  return {
    zone,
    description: floorLocationDescription(
      zone.name,
      location.area,
      nearestLandmarkName(zone, landmarks, location.x, location.y),
    ),
  };
}

/**
 * Where a review panel walks for this team. Panels have no table of their own,
 * so the only location in a review is where the team was last seen sitting.
 * The string names a part of the hall and the nearest fixed landmark; no table
 * in this venue is numbered, and none stays where it was put.
 */
export async function teamTableLabel(ctx: ReadCtx, teamId: Id<"teams">) {
  const location = await activeTeamFloorLocation(ctx, teamId);
  if (!location) return undefined;
  return (await describeTeamFloorLocation(ctx, location)).description;
}

/**
 * The location recorded for this team in this round, which is where the panel
 * walks. Undefined until the team is queued or when the team has no recorded
 * location, and callers must say so rather than name a place that is not real.
 */
export async function teamRoundTableLabel(
  ctx: ReadCtx,
  roundId: Id<"reviewRounds">,
  teamId: Id<"teams">,
) {
  const state = await ctx.db
    .query("teamRoundStates")
    .withIndex("by_round_team", (index) => index.eq("roundId", roundId).eq("teamId", teamId))
    .unique();
  return state?.tableLabel;
}
