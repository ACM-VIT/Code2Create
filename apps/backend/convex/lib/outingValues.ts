import { v } from "convex/values";

export const outingDurationMs = 15 * 60_000;
export const outingPhase = v.union(
  v.object({ status: v.literal("waiting") }),
  v.object({ status: v.literal("permitted"), expiresAt: v.number() }),
  v.object({ status: v.literal("out"), departedAt: v.number(), returnBy: v.number(), returnTransition: v.union(v.literal("venue_entry"), v.literal("zone_entry")), sessionId: v.optional(v.id("attendanceSessions")) }),
  v.object({ status: v.literal("overdue"), departedAt: v.number(), returnBy: v.number(), returnTransition: v.union(v.literal("venue_entry"), v.literal("zone_entry")), sessionId: v.optional(v.id("attendanceSessions")) }),
  v.object({ status: v.literal("expired") }),
);

/** Snapshot of the decision at a scan, retained with its idempotent receipt. */
export const outingScanDecision = v.union(
  v.object({ status: v.literal("waiting"), position: v.number(), returnBy: v.null() }),
  v.object({
    status: v.union(v.literal("required"), v.literal("expired"), v.literal("unconfigured"), v.literal("online_required")),
    position: v.null(), returnBy: v.null(),
  }),
  v.object({
    status: v.union(v.literal("out"), v.literal("overdue"), v.literal("returned")),
    position: v.null(), returnBy: v.number(),
  }),
);
