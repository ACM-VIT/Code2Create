import type { VenueCallResponse } from "@code2create/domain";
// Re-exported so callers keep one import for a call's shapes and its handling.
export {
  venueCallResponseValue,
  venueConfirmationCall,
  venueResponseEffect,
} from "./venueCallResponseValidators";
import { z } from "zod";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { activeVenueAuthority } from "./reviewerVenue";
import { reviewerParticipation } from "./reviewerParticipation";
import { clockOutForVenueDeparture } from "./reviewerVenueStaffing";

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

/** The signed callback is a report, not authority to bypass the current review state. */
export async function applyVenueCallResponse(
  ctx: MutationCtx,
  delivery: Doc<"outboundCallDeliveries">,
  response: VenueCallResponse,
  now: number,
): Promise<"confirmed" | "clocked_out" | "needs_ops" | "stale"> {
  const confirmation = delivery.venueConfirmation;
  const departureId = ctx.db.normalizeId(
    "reviewerVenueDepartures",
    delivery.sourceId,
  );
  const departure = departureId ? await ctx.db.get(departureId) : null;
  const presence = departure ? await ctx.db.get(departure.presenceId) : null;
  if (
    !confirmation ||
    confirmation.expiresAt <= now ||
    !departure ||
    !presence ||
    departure.state !== "open" ||
    departure.callDeliveryId !== delivery._id ||
    presence.departureId !== departure._id ||
    presence.eventId !== delivery.eventId ||
    presence.personId !== delivery.targetPersonId ||
    departure.policyVersion !== presence.policyVersion ||
    !(await activeVenueAuthority(ctx, presence, now))
  )
    return "stale";
  const consent = delivery.consentId
    ? await ctx.db.get(delivery.consentId)
    : null;
  if (
    !consent ||
    consent.state !== "granted" ||
    consent.version !== delivery.consentVersion ||
    consent.scriptPolicyVersion !== delivery.scriptPolicyVersion
  )
    return "stale";
  if (
    !response.confirmed ||
    !response.transcript.some((turn) => turn.role === "user") ||
    response.outcome === "unclear" ||
    response.outcome === "needs_help"
  )
    return "needs_ops";
  if (response.outcome === "available") return "confirmed";
  if (
    (
      await reviewerParticipation(
        ctx,
        delivery.eventId,
        delivery.targetPersonId,
      )
    ).hasActiveReview
  )
    return "needs_ops";
  await clockOutForVenueDeparture(
    ctx,
    delivery.eventId,
    delivery.targetPersonId,
    "Confirmed unavailable by phone",
    now,
  );
  await ctx.db.patch(departure._id, {
    state: "reported",
    reportedAt: now,
    reason: response.summary,
    updatedAt: now,
  });
  await ctx.db.patch(presence._id, {
    status: "reported_left",
    version: presence.version + 1,
    updatedAt: now,
  });
  return "clocked_out";
}
