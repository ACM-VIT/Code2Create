import type { VenueCallResponse } from "@code2create/domain";
import { z } from "zod";

export const venueConfirmationCallSchema = z
  .object({
    appId: z.string().trim().min(1).max(128),
    appVersion: z.number().int().positive(),
    reviewerName: z.string().min(1).max(200),
    venueName: z.string().min(1).max(100),
    expiresAt: z.number().int().positive(),
  })
  .strict();

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

// These output variables must be declared on the published Sarvam agent.
const answerSchema = z.object({
  outcome: z.enum(["available", "away", "needs_help", "unclear"]),
  confirmed: z.boolean(),
  summary: z.string().trim().min(1).max(1000),
  return_in_minutes: z.number().int().min(0).max(1440).nullable(),
});

export function venueCallResponse(
  variables: unknown,
  turns: { role: "agent" | "user"; en_text: string }[] | null | undefined,
): VenueCallResponse {
  const transcript = (turns ?? [])
    .filter((turn) => turn.en_text.trim())
    .map((turn) => ({ role: turn.role, text: turn.en_text }));
  const answer = answerSchema.safeParse(variables);
  if (!answer.success || !transcript.some((turn) => turn.role === "user")) {
    return {
      outcome: "unclear",
      confirmed: false,
      summary:
        "The call did not produce a verified answer. Ops follow-up is needed.",
      returnInMinutes: null,
      transcript,
    };
  }
  return {
    outcome: answer.data.outcome,
    confirmed: answer.data.confirmed && answer.data.outcome !== "unclear",
    summary: answer.data.summary,
    returnInMinutes: answer.data.return_in_minutes,
    transcript,
  };
}
