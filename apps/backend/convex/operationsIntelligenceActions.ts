import {
  operationsIntelligenceIngressSignatureContext,
  operationsIntelligenceProtocolVersion,
  signServiceBody,
  type OperationsIntelligenceRequest,
} from "@code2create/domain";
import { v } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { operationFingerprint } from "./lib/operations";

const workerResponse = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("accepted"),
    submissionId: z.string().min(1).max(200),
    acceptedAt: z.iso.datetime(),
  }),
  z.object({ state: z.literal("already_exists") }),
]);

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for operations intelligence.`);
  return value;
}

function workerEndpoint() {
  const base = new URL(requiredEnvironment("INTELLIGENCE_WORKER_URL"));
  const local = base.hostname === "localhost" || base.hostname === "127.0.0.1";
  if (base.protocol !== "https:" && !(local && base.protocol === "http:")) {
    throw new Error("INTELLIGENCE_WORKER_URL must use HTTPS outside local development.");
  }
  return new URL("/v1/operations-briefs", base);
}

export const dispatchBrief = internalAction({
  args: { briefId: v.id("operationsIntelligenceBriefs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const context = await ctx.runQuery(internal.operationsIntelligence.dispatchContext, {
      briefId: args.briefId,
    });
    if (!context) return null;
    let snapshot = context.sourceSnapshot;
    let sourceChecksum = context.sourceChecksum;
    if (!snapshot || !sourceChecksum) {
      snapshot = await ctx.runQuery(internal.operationsHealth.internalOverview, {
        eventId: context.eventId,
      });
      sourceChecksum = operationFingerprint([JSON.stringify(snapshot)]);
    }
    const frozen = await ctx.runMutation(internal.operationsIntelligence.beginDispatch, {
      briefId: args.briefId,
      snapshot,
      sourceChecksum,
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
      secret: requiredEnvironment("INTELLIGENCE_INGRESS_SECRET"),
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
    const parsedBody: unknown = await response.json();
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
