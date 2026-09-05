/**
 * The stored shapes of a venue confirmation call.
 *
 * Separate from `venueCallResponse` because the schema imports these, and
 * Convex evaluates the schema in isolation: anything it reaches has to be
 * validators alone. The module beside this one applies a call's result and
 * carries the runtime that comes with that — Zod, the reviewer lookups, the
 * staffing write — none of which the schema can pull in.
 */

import { v } from "convex/values";

export const venueConfirmationCall = v.object({
  appId: v.string(),
  appVersion: v.number(),
  reviewerName: v.string(),
  venueName: v.string(),
  expiresAt: v.number(),
});

export const venueCallResponseValue = v.object({
  outcome: v.union(
    v.literal("available"),
    v.literal("away"),
    v.literal("needs_help"),
    v.literal("unclear"),
  ),
  confirmed: v.boolean(),
  summary: v.string(),
  returnInMinutes: v.union(v.number(), v.null()),
  transcript: v.array(
    v.object({
      role: v.union(v.literal("agent"), v.literal("user")),
      text: v.string(),
    }),
  ),
});

export const venueResponseEffect = v.union(
  v.literal("confirmed"),
  v.literal("clocked_out"),
  v.literal("needs_ops"),
  v.literal("stale"),
);
