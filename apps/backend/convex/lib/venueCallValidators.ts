/**
 * The stored shapes of a venue confirmation call.
 *
 * The schema imports these, and Convex evaluates the schema on its own, so
 * this module holds validators and nothing else — no Zod, no reviewer
 * lookups. The parser for a reported call lives in
 * `venueCallResponsePayload`.
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

