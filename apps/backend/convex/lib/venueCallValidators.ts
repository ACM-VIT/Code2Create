import { v } from "convex/values";
import { z } from "zod";

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

export const venueCallResponseSchema = z
  .object({
    outcome: z.enum(["available", "away", "needs_help", "unclear"]),
    confirmed: z.boolean(),
    summary: z.string().min(1).max(1000),
    returnInMinutes: z.number().int().min(0).max(1440).nullable(),
    transcript: z
      .array(
        z
          .object({
            role: z.enum(["agent", "user"]),
            text: z.string().min(1).max(4000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export const venueResponseEffect = v.union(
  v.literal("confirmed"),
  v.literal("clocked_out"),
  v.literal("needs_ops"),
  v.literal("stale"),
);

