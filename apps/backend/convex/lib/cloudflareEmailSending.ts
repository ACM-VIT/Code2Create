import { z } from "zod";

const providerError = z.object({
  code: z.number().int(),
  message: z.string().max(500),
});

const sendFailure = z.object({
  success: z.literal(false),
  errors: z.array(providerError).min(1).max(20),
});

const sendSuccess = z.object({
  success: z.literal(true),
  result: z.object({
    delivered: z.array(z.email().max(320)).max(1),
    message_id: z.string().min(1).max(512),
    permanent_bounces: z.array(z.email().max(320)).max(1),
    queued: z.array(z.email().max(320)).max(1),
  }),
});

type InitialProviderOutcome = "queued" | "delivered" | "permanent_bounce";

export type CloudflareEmailSendInterpretation =
  | {
      kind: "accepted";
      providerMessageId: string;
      initialOutcome: InitialProviderOutcome;
    }
  | {
      kind: "rejected";
      errorCode: string;
      retryable: boolean;
    }
  | {
      kind: "ambiguous";
      errorCode:
        | "cloudflare_email_response_ambiguous"
        | "cloudflare_email_recipient_outcome_invalid";
    };

function retryableProviderFailure(status: number, providerCode: number | undefined) {
  return (
    status === 429 ||
    status >= 500 ||
    providerCode === 10_004 ||
    providerCode === 10_002 ||
    providerCode === 10_003 ||
    providerCode === 10_100
  );
}

function providerErrorCode(status: number, code: number | undefined) {
  return code === undefined ? `cloudflare_email_http_${status}` : `cloudflare_email_${code}`;
}

function initialOutcome(
  result: z.infer<typeof sendSuccess>["result"],
  destinationEmail: string,
): InitialProviderOutcome | null {
  const delivered = result.delivered.map((email) => email.toLocaleLowerCase("en"));
  const permanentBounces = result.permanent_bounces.map((email) => email.toLocaleLowerCase("en"));
  const queued = result.queued.map((email) => email.toLocaleLowerCase("en"));
  const outcomes = [...delivered, ...permanentBounces, ...queued];
  if (outcomes.length !== 1 || outcomes[0] !== destinationEmail) return null;
  if (delivered.length === 1) return "delivered";
  if (permanentBounces.length === 1) return "permanent_bounce";
  return "queued";
}

export function interpretCloudflareEmailSendResponse(input: {
  status: number;
  ok: boolean;
  body: unknown;
  destinationEmail: string;
}): CloudflareEmailSendInterpretation {
  const parsedFailure = sendFailure.safeParse(input.body);
  if (parsedFailure.success) {
    const code = parsedFailure.data.errors[0]?.code;
    return {
      kind: "rejected",
      errorCode: providerErrorCode(input.status, code),
      retryable: retryableProviderFailure(input.status, code),
    };
  }

  const parsedSuccess = sendSuccess.safeParse(input.body);
  if (!input.ok || !parsedSuccess.success) {
    return { kind: "ambiguous", errorCode: "cloudflare_email_response_ambiguous" };
  }

  const outcome = initialOutcome(parsedSuccess.data.result, input.destinationEmail);
  if (!outcome) {
    return {
      kind: "ambiguous",
      errorCode: "cloudflare_email_recipient_outcome_invalid",
    };
  }

  return {
    kind: "accepted",
    providerMessageId: parsedSuccess.data.result.message_id,
    initialOutcome: outcome,
  };
}
