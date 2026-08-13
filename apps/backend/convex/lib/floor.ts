import { floorAreaLabels, floorAreas } from "@code2create/domain";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { FloorArea } from "../values";

type ReadCtx = QueryCtx | MutationCtx;

export const maximumFloorZones = 30;
export const maximumFloorLandmarksPerZone = 12;

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

/** Rounds touch positions beyond the accuracy of a phone gesture. */
export function floorCoordinate(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new ConvexError({
      code: "INVALID_COORDINATE",
      message: `${label} must be from 0 through 100.`,
    });
  }
  return Math.round(value * 100) / 100;
}


/** Adds a nearby published landmark when the zone area alone is too coarse. */
export function floorLocationDescription(
  zoneName: string,
  area: FloorArea,
  landmarkName: string | undefined,
) {
  const place = `${floorAreaLabels[area]} of ${zoneName}`;
  return landmarkName === undefined ? place : `${place}, near ${landmarkName}`;
}

/** Measures landmark proximity in metres so differently sized zones behave consistently. */
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

/** Nearby team positions are valid observations, not placement conflicts. */
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

/** Includes empty areas so load comparisons always cover the whole zone. */
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

/** Resolves the team location where its review panel must walk. */
export async function teamTableLabel(ctx: ReadCtx, teamId: Id<"teams">) {
  const location = await activeTeamFloorLocation(ctx, teamId);
  if (!location) return undefined;
  return (await describeTeamFloorLocation(ctx, location)).description;
}

/** Returns no destination until this round has a recorded team location. */
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
