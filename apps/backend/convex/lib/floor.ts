import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type ReadCtx = QueryCtx | MutationCtx;

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
 * The label of the table a review panel walks to for this team. Panels have no
 * table of their own, so the only true location is where the team is mapped.
 */
export async function teamTableLabel(ctx: ReadCtx, teamId: Id<"teams">) {
  const location = await activeTeamFloorLocation(ctx, teamId);
  if (!location) return undefined;
  const spot = await ctx.db.get(location.spotId);
  return spot?.label;
}

/**
 * The table recorded for this team in this round, which is where the panel
 * walks. Undefined until the team is queued or when the team has no mapped
 * table, and callers must say so rather than name a location that is not real.
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
