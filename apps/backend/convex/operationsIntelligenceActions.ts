import {
  deriveOperationsCopilotConversationId,
  encodeOperationsIntelligenceStreamTicket,
  operationsBriefStreamTicketSignatureContext,
  operationsCopilotInstanceId,
  operationsCopilotIngressSignatureContext,
  operationsCopilotStreamTicketSignatureContext,
  operationsIntelligenceIngressSignatureContext,
  operationsIntelligenceProtocolVersion,
  operationsIntelligenceStreamCapability,
  operationsIntelligenceStreamTicketLifetimeMs,
  serializeOperationsIntelligenceStreamTicket,
  signServiceBody,
  type OperationsIntelligenceStreamTicket,
  type OperationsIntelligenceStreamAccess,
  type OperationsIntelligenceRequest,
} from "@code2create/domain";
import { ConvexError, v } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { readBoundedJsonResponse } from "./lib/boundedHttpBody";
import {
  requireIntelligenceHmacSecret,
  requireIntelligenceWorkerOrigin,
} from "./lib/intelligenceServiceConfiguration";

const workerResponse = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("accepted"),
    submissionId: z.string().min(1).max(200),
    acceptedAt: z.iso.datetime(),
  }),
  z.object({ state: z.literal("already_exists") }),
]);

const copilotTurnInput = z
  .object({
    turnId: z.string().min(8).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
    message: z.string().trim().min(1).max(4_000),
  })
  .strict();

const copilotTurnReceipt = z
  .object({
    state: z.literal("accepted"),
    conversationId: z.string().min(1).max(200),
    instanceId: z.string().min(1).max(400),
    submissionId: z.string().min(1).max(200),
    acceptedAt: z.iso.datetime(),
    uid: z.string().min(1).max(400),
    deduplicated: z.boolean(),
  })
  .strict();

const copilotTurnConflict = z
  .object({
    error: z.literal("turn_conflict"),
    submissionId: z.string().min(1).max(200),
  })
  .strict();

const streamAccess = v.object({
  conversationUrl: v.string(),
  ticket: v.string(),
  issuedAt: v.number(),
  expiresAt: v.number(),
  signature: v.string(),
});

function workerEndpoint() {
  return intelligenceWorkerUrl("/v1/operations-briefs");
}

export function intelligenceWorkerUrl(pathname: string) {
  return new URL(pathname, requireIntelligenceWorkerOrigin());
}

async function copilotCoordinates(args: {
  eventId: string;
  eventAccessSubjectId: string;
  eventSlug: string;
}) {
  const conversationId = await deriveOperationsCopilotConversationId({
    secret: requireIntelligenceHmacSecret("INTELLIGENCE_STREAM_SECRET"),
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
  });
  return {
    conversationId,
    instanceId: operationsCopilotInstanceId({
      eventSlug: args.eventSlug,
      conversationId,
    }),
  };
}

export async function signedStreamAccess(args: {
  ticket: OperationsIntelligenceStreamTicket;
  signatureContext: string;
  conversationUrl: URL;
}) {
  const serialized = serializeOperationsIntelligenceStreamTicket(args.ticket);
  const signature = await signServiceBody({
    context: args.signatureContext,
    secret: requireIntelligenceHmacSecret("INTELLIGENCE_STREAM_SECRET"),
    timestamp: String(args.ticket.issuedAt),
    body: serialized,
  });
  return {
    conversationUrl: args.conversationUrl.toString(),
    ticket: encodeOperationsIntelligenceStreamTicket(args.ticket),
    issuedAt: args.ticket.issuedAt,
    expiresAt: args.ticket.expiresAt,
    signature,
  };
}

/** Sends an idempotent turn through the signed service boundary. */
export const submitCopilotTurn = action({
  args: { eventSlug: v.string(), turnId: v.string(), message: v.string() },
  returns: v.object({
    conversationId: v.string(),
    instanceId: v.string(),
    submissionId: v.string(),
    acceptedAt: v.string(),
    deduplicated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const input = copilotTurnInput.safeParse({ turnId: args.turnId, message: args.message });
    if (!input.success) {
      throw new ConvexError({
        code: "COPILOT_TURN_INVALID",
        message: "The turn ID or message is invalid.",
      });
    }
    const authorization = await ctx.runQuery(internal.intelligenceObservability.authorizeCopilot, {
      eventSlug: args.eventSlug,
      permission: "operations.intelligence.generate",
    });
    const coordinates = await copilotCoordinates({
      eventId: authorization.eventId,
      eventAccessSubjectId: authorization.eventAccessSubjectId,
      eventSlug: authorization.eventSlug,
    });
    const body = JSON.stringify({
      protocolVersion: operationsIntelligenceProtocolVersion,
      conversationId: coordinates.conversationId,
      turnId: input.data.turnId,
      eventSlug: authorization.eventSlug,
      message: input.data.message,
    });
    const timestamp = String(Date.now());
    const signature = await signServiceBody({
      context: operationsCopilotIngressSignatureContext,
      secret: requireIntelligenceHmacSecret("INTELLIGENCE_INGRESS_SECRET"),
      timestamp,
      body,
    });
    const response = await fetch(intelligenceWorkerUrl("/v1/operations-copilot/turns"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-c2c-signature": signature,
        "x-c2c-timestamp": timestamp,
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    let responseBody: unknown;
    try {
      responseBody = await readBoundedJsonResponse(response, 8 * 1_024);
    } catch {
      throw new Error("The intelligence service returned an invalid response. Retry safely.");
    }
    if (response.status === 409) {
      const conflict = copilotTurnConflict.safeParse(responseBody);
      if (!conflict.success) {
        throw new Error("The intelligence service returned an invalid conflict. Retry safely.");
      }
      throw new ConvexError({
        code: "COPILOT_TURN_CONFLICT",
        message: "That turn ID was already used for different content.",
        submissionId: conflict.data.submissionId,
      });
    }
    if (!response.ok) {
      throw new Error("The intelligence service could not accept this turn. Retry safely.");
    }
    const receipt = copilotTurnReceipt.safeParse(responseBody);
    if (
      !receipt.success ||
      receipt.data.conversationId !== coordinates.conversationId ||
      receipt.data.instanceId !== coordinates.instanceId
    ) {
      throw new Error("The intelligence Worker returned an invalid copilot receipt.");
    }
    return {
      conversationId: coordinates.conversationId,
      instanceId: coordinates.instanceId,
      submissionId: receipt.data.submissionId,
      acceptedAt: receipt.data.acceptedAt,
      deduplicated: receipt.data.deduplicated,
    };
  },
});

/** Mints a short-lived read-only capability for this operator's private conversation. */
export const openCopilotStream = action({
  args: { eventSlug: v.string() },
  returns: streamAccess,
  handler: async (
    ctx: ActionCtx,
    args: { eventSlug: string },
  ): Promise<OperationsIntelligenceStreamAccess> => {
    const authorization: {
      eventId: Id<"events">;
      eventSlug: string;
      eventAccessSubjectId: Id<"eventAccessSubjects">;
    } = await ctx.runQuery(internal.intelligenceObservability.authorizeCopilot, {
      eventSlug: args.eventSlug,
      permission: "operations.intelligence.read",
    });
    const coordinates = await copilotCoordinates({
      eventId: authorization.eventId,
      eventAccessSubjectId: authorization.eventAccessSubjectId,
      eventSlug: authorization.eventSlug,
    });
    const issuedAt = Date.now();
    const ticket: OperationsIntelligenceStreamTicket = {
      protocolVersion: operationsIntelligenceProtocolVersion,
      eventSlug: authorization.eventSlug,
      instanceId: coordinates.instanceId,
      agentName: "operations-copilot",
      capability: operationsIntelligenceStreamCapability,
      issuedAt,
      expiresAt: issuedAt + operationsIntelligenceStreamTicketLifetimeMs,
      nonce: crypto.randomUUID(),
      conversationId: coordinates.conversationId,
    } satisfies OperationsIntelligenceStreamTicket;
    return signedStreamAccess({
      ticket,
      signatureContext: operationsCopilotStreamTicketSignatureContext,
      conversationUrl: intelligenceWorkerUrl(
        `/v1/operations-copilot/conversations/${encodeURIComponent(coordinates.instanceId)}`,
      ),
    });
  },
});

/** Mints a short-lived read-only capability for one event-owned brief run. */
export const openBriefStream = action({
  args: { eventSlug: v.string(), briefId: v.id("operationsIntelligenceBriefs") },
  returns: streamAccess,
  handler: async (
    ctx: ActionCtx,
    args: { eventSlug: string; briefId: Id<"operationsIntelligenceBriefs"> },
  ): Promise<OperationsIntelligenceStreamAccess> => {
    const authorization: {
      eventSlug: string;
      briefId: Id<"operationsIntelligenceBriefs">;
    } = await ctx.runQuery(
      internal.intelligenceObservability.authorizeBriefStream,
      args,
    );
    const issuedAt = Date.now();
    const ticket: OperationsIntelligenceStreamTicket = {
      protocolVersion: operationsIntelligenceProtocolVersion,
      eventSlug: authorization.eventSlug,
      briefId: authorization.briefId,
      instanceId: authorization.briefId,
      agentName: "operations-brief",
      capability: operationsIntelligenceStreamCapability,
      issuedAt,
      expiresAt: issuedAt + operationsIntelligenceStreamTicketLifetimeMs,
      nonce: crypto.randomUUID(),
    } satisfies OperationsIntelligenceStreamTicket;
    return signedStreamAccess({
      ticket,
      signatureContext: operationsBriefStreamTicketSignatureContext,
      conversationUrl: intelligenceWorkerUrl(
        `/v1/operations-brief-runs/${encodeURIComponent(authorization.briefId)}`,
      ),
    });
  },
});

export const dispatchBrief = internalAction({
  args: { briefId: v.id("operationsIntelligenceBriefs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const frozen = await ctx.runMutation(internal.operationsIntelligence.beginDispatch, {
      briefId: args.briefId,
    });
    if (!frozen) return null;
    const request: OperationsIntelligenceRequest = {
      protocolVersion: operationsIntelligenceProtocolVersion,
      briefId: args.briefId,
      sourceChecksum: frozen.sourceChecksum,
      snapshot: frozen.snapshot,
    };
    const body = JSON.stringify(request);
    const timestamp = Date.now().toString();
    const signature = await signServiceBody({
      context: operationsIntelligenceIngressSignatureContext,
      secret: requireIntelligenceHmacSecret("INTELLIGENCE_INGRESS_SECRET"),
      timestamp,
      body,
    });
    const response = await fetch(workerEndpoint(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-c2c-signature": signature,
        "x-c2c-timestamp": timestamp,
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`The intelligence Worker rejected dispatch with HTTP ${response.status}.`);
    }
    const parsedBody = await readBoundedJsonResponse(response, 8 * 1_024);
    const parsed = workerResponse.safeParse(parsedBody);
    if (!parsed.success) throw new Error("The intelligence Worker returned an invalid receipt.");
    const acceptedAt =
      parsed.data.state === "accepted" ? Date.parse(parsed.data.acceptedAt) : Date.now();
    if (!Number.isFinite(acceptedAt)) {
      throw new Error("The intelligence Worker receipt has an invalid acceptance time.");
    }
    await ctx.runMutation(internal.operationsIntelligence.markAccepted, {
      briefId: args.briefId,
      ...(parsed.data.state === "accepted"
        ? { workerSubmissionId: parsed.data.submissionId }
        : {}),
      workerAcceptedAt: acceptedAt,
    });
    return null;
  },
});
