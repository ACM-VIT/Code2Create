/**
 * The shape a venue call reports back, parsed at the edge.
 *
 * Kept apart from `venueCallValidators` because the schema imports those and
 * Convex evaluates the schema in isolation: anything it reaches has to be
 * validators alone, and Zod is a node_modules import that a schema may not
 * pull in.
 */

import { z } from "zod";

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
