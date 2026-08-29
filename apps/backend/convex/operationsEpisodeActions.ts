import {
  operationsEpisodeIngressSignatureContext,
  operationsIntelligenceProtocolVersion,
  signServiceBody,
  type OperationsEpisodeDispatchRequest,
} from "@code2create/domain";
import { v } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { readBoundedJsonResponse } from "./lib/boundedHttpBody";
import {
  requireIntelligenceHmacSecret,
  requireIntelligenceWorkerOrigin,
} from "./lib/intelligenceServiceConfiguration";

const receiptSchema = z.object({
  state: z.literal("accepted"),
  episodeId: z.string().min(1).max(200),
  instanceId: z.string().min(1).max(200),
  submissionId: z.string().min(1).max(200),
  acceptedAt: z.iso.datetime(),
}).strict();

export const dispatchEpisode = internalAction({
  args: { episodeId: v.id("operationsIntelligenceEpisodes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const prepared = await ctx.runMutation(internal.operationsEpisodes.prepareDispatch, {
      episodeId: args.episodeId,
      now,
    });
    if (!prepared) return null;
    const request: OperationsEpisodeDispatchRequest = {
      protocolVersion: operationsIntelligenceProtocolVersion,
      episodeId: prepared.episodeId,
      eventId: prepared.eventId,
      revision: prepared.revision,
    };
    const body = JSON.stringify(request);
    const timestamp = String(now);
    const signature = await signServiceBody({
      context: operationsEpisodeIngressSignatureContext,
      secret: requireIntelligenceHmacSecret("INTELLIGENCE_INGRESS_SECRET"),
      timestamp,
      body,
    });
    try {
      const response = await fetch(
        new URL("/v1/operations-episodes", requireIntelligenceWorkerOrigin()),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-c2c-signature": signature,
            "x-c2c-timestamp": timestamp,
          },
          body,
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) throw new Error(`The episode Worker returned HTTP ${response.status}.`);
      const parsed = receiptSchema.safeParse(await readBoundedJsonResponse(response, 8 * 1_024));
      if (!parsed.success || parsed.data.episodeId !== prepared.episodeId || parsed.data.instanceId !== prepared.episodeId) {
        throw new Error("The episode Worker returned an invalid receipt.");
      }
      const acceptedAt = Date.parse(parsed.data.acceptedAt);
      if (!Number.isFinite(acceptedAt)) throw new Error("The episode receipt time is invalid.");
      await ctx.runMutation(internal.operationsEpisodes.recordDispatchReceipt, {
        episodeId: prepared.episodeId,
        revision: prepared.revision,
        attemptId: prepared.attemptId,
        submissionId: parsed.data.submissionId,
        acceptedAt,
      });
    } catch {
      await ctx.runMutation(internal.operationsEpisodes.recordDispatchFailure, {
        episodeId: prepared.episodeId,
        revision: prepared.revision,
        attemptId: prepared.attemptId,
        now: Date.now(),
      });
    }
    return null;
  },
});
