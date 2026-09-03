import {
  operationsAutonomyAbortSignatureContext,
  operationsAutonomyContinuationSignatureContext,
  operationsAutonomyIngressSignatureContext,
  operationsAutonomyStreamTicketSignatureContext,
  operationsIntelligenceProtocolVersion,
  operationsIntelligenceStreamCapability,
  operationsIntelligenceStreamTicketLifetimeMs,
  signServiceBody,
  type OperationsAutonomyAbortRequest,
  type OperationsAutonomyContinuationRequest,
  type OperationsAutonomyTurnReceipt,
  type OperationsIntelligenceStreamAccess,
  type OperationsIntelligenceStreamTicket,
} from "@code2create/domain";
import { v } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { readBoundedJsonResponse } from "./lib/boundedHttpBody";
import { requireIntelligenceHmacSecret } from "./lib/intelligenceServiceConfiguration";
import { intelligenceWorkerUrl, signedStreamAccess } from "./operationsIntelligenceActions";

const workerReceipt = z
  .object({
    state: z.literal("accepted"),
    runId: z.string().min(1).max(200),
    instanceId: z.string().min(1).max(200),
    submissionId: z.string().min(1).max(200),
    acceptedAt: z.iso.datetime(),
    uid: z.string().min(1).max(400),
  })
  .strict();

const abortReceipt = z
  .object({
    state: z.literal("accepted"),
    runId: z.string().min(1).max(200),
    operationId: z.string().min(8).max(200),
  })
  .strict();

const streamAccess = v.object({
  conversationUrl: v.string(),
  ticket: v.string(),
  issuedAt: v.number(),
  expiresAt: v.number(),
  serverNow: v.number(),
  signature: v.string(),
});

const autonomyTickLeaseDurationMs = 60_000;
const autonomyTickLeaseRenewalWindowMs = 15_000;

async function signedPost(args: { path: string; context: string; body: string; signedAt: number }) {
  const timestamp = String(args.signedAt);
  const signature = await signServiceBody({
    context: args.context,
    secret: requireIntelligenceHmacSecret("INTELLIGENCE_INGRESS_SECRET"),
    timestamp,
    body: args.body,
  });
  return fetch(intelligenceWorkerUrl(args.path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-c2c-signature": signature,
      "x-c2c-timestamp": timestamp,
    },
    body: args.body,
    signal: AbortSignal.timeout(20_000),
  });
}

async function validatedTurnReceipt(response: Response, runId: string) {
  if (!response.ok) throw new Error(`The autonomy Worker returned HTTP ${response.status}.`);
  const body = await readBoundedJsonResponse(response, 8 * 1_024);
  const parsed = workerReceipt.safeParse(body);
  if (!parsed.success || parsed.data.runId !== runId || parsed.data.instanceId !== runId) {
    throw new Error("The autonomy Worker returned an invalid admission receipt.");
  }
  const acceptedAt = Date.parse(parsed.data.acceptedAt);
  if (!Number.isFinite(acceptedAt)) throw new Error("The autonomy receipt time is invalid.");
  const receipt: OperationsAutonomyTurnReceipt = parsed.data;
  return { receipt, acceptedAt };
}

export const dispatchRun = internalAction({
  args: { runId: v.id("operationsAutonomyRuns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const prepared = await ctx.runMutation(internal.operationsAutonomyDispatch.prepareDispatch, {
      runId: args.runId,
      now: Date.now(),
    });
    if (!prepared) return null;
    try {
      const response = await signedPost({
        path: "/v1/operations-autonomy-runs",
        context: operationsAutonomyIngressSignatureContext,
        body: JSON.stringify(prepared.request),
        signedAt: prepared.signedAt,
      });
      const { receipt, acceptedAt } = await validatedTurnReceipt(response, args.runId);
      await ctx.runMutation(internal.operationsAutonomyDispatch.recordDispatchReceipt, {
        runId: args.runId,
        attemptId: prepared.attemptId,
        submissionId: receipt.submissionId,
        acceptedAt,
        now: Date.now(),
      });
    } catch {
      await ctx.runMutation(internal.operationsAutonomyDispatch.recordDispatchFailure, {
        runId: args.runId,
        attemptId: prepared.attemptId,
        now: Date.now(),
      });
    }
    return null;
  },
});

export const continueRun = internalAction({
  args: { continuationId: v.id("operationsAutonomyContinuations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const prepared = await ctx.runMutation(
      internal.operationsAutonomyDispatch.prepareContinuation,
      { continuationId: args.continuationId, now: Date.now() },
    );
    if (!prepared) return null;
    const request: OperationsAutonomyContinuationRequest = {
      protocolVersion: operationsIntelligenceProtocolVersion,
      runId: prepared.runId,
      operationId: prepared.operationId,
      priorSubmissionId: prepared.priorSubmissionId,
      workItemId: prepared.workItemId,
    };
    try {
      const response = await signedPost({
        path: `/v1/operations-autonomy-runs/${encodeURIComponent(prepared.runId)}/continue`,
        context: operationsAutonomyContinuationSignatureContext,
        body: JSON.stringify(request),
        signedAt: prepared.signedAt,
      });
      const { receipt, acceptedAt } = await validatedTurnReceipt(response, prepared.runId);
      await ctx.runMutation(internal.operationsAutonomyDispatch.recordContinuationReceipt, {
        continuationId: args.continuationId,
        attemptId: prepared.attemptId,
        submissionId: receipt.submissionId,
        acceptedAt,
        now: Date.now(),
      });
    } catch {
      await ctx.runMutation(internal.operationsAutonomyDispatch.recordContinuationFailure, {
        continuationId: args.continuationId,
        attemptId: prepared.attemptId,
        now: Date.now(),
      });
    }
    return null;
  },
});

export const abortRun = internalAction({
  args: {
    runId: v.id("operationsAutonomyRuns"),
    reason: v.union(
      v.literal("kill_switch"),
      v.literal("policy_superseded"),
      v.literal("owner_revoked"),
      v.literal("event_not_live"),
    ),
    operationId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const request: OperationsAutonomyAbortRequest = {
      protocolVersion: operationsIntelligenceProtocolVersion,
      runId: args.runId,
      reason: args.reason,
      operationId: args.operationId,
    };
    try {
      const response = await signedPost({
        path: `/v1/operations-autonomy-runs/${encodeURIComponent(args.runId)}/abort`,
        context: operationsAutonomyAbortSignatureContext,
        body: JSON.stringify(request),
        signedAt: Date.now(),
      });
      if (!response.ok) throw new Error(`The autonomy abort returned HTTP ${response.status}.`);
      const body = await readBoundedJsonResponse(response, 4 * 1_024);
      const parsed = abortReceipt.safeParse(body);
      if (
        !parsed.success ||
        parsed.data.runId !== args.runId ||
        parsed.data.operationId !== args.operationId
      )
        throw new Error("The autonomy Worker returned an invalid abort receipt.");
      await ctx.runMutation(internal.operationsAutonomyDispatch.acknowledgeAbort, {
        runId: args.runId,
        operationId: args.operationId,
        now: Date.now(),
      });
    } catch {
      await ctx.runMutation(internal.operationsAutonomyDispatch.recordAbortFailure, {
        runId: args.runId,
        operationId: args.operationId,
        now: Date.now(),
      });
    }
    return null;
  },
});

export const tick = internalAction({
  args: {},
  returns: v.object({ evaluated: v.number(), queued: v.number(), monitored: v.number() }),
  handler: async (ctx): Promise<{ evaluated: number; queued: number; monitored: number }> => {
    const leaseId = crypto.randomUUID();
    const claimedAt = Date.now();
    const claimed = await ctx.runMutation(internal.operationsBackground.claim, {
      holder: "autonomy_tick",
      leaseId,
      now: claimedAt,
      leaseDurationMs: autonomyTickLeaseDurationMs,
    });
    if (!claimed) return { evaluated: 0, queued: 0, monitored: 0 };

    let leaseExpiresAt = claimedAt + autonomyTickLeaseDurationMs;
    const progress = { evaluated: 0, queued: 0, monitored: 0 };
    const renewLeaseIfNeeded = async () => {
      const now = Date.now();
      if (now < leaseExpiresAt - autonomyTickLeaseRenewalWindowMs) return true;
      const renewed = await ctx.runMutation(internal.operationsBackground.renew, {
        holder: "autonomy_tick",
        leaseId,
        now,
        leaseDurationMs: autonomyTickLeaseDurationMs,
      });
      if (renewed) leaseExpiresAt = now + autonomyTickLeaseDurationMs;
      return renewed;
    };

    try {
      const now = Date.now();
      const supervisionIds: Id<"operationsAutonomyRunSupervision">[] = await ctx.runQuery(
        internal.operationsAutonomyScheduler.supervisionCandidates,
        { now },
      );
      for (const supervisionId of supervisionIds) {
        if (!(await renewLeaseIfNeeded())) return progress;
        const reconciled = await ctx.runMutation(
          internal.operationsAutonomyScheduler.reconcileSupervision,
          {
            supervisionId,
            leaseId,
            now,
          },
        );
        if (!reconciled.leaseHeld) return progress;
        progress.monitored += 1;
      }
      const stateIds: Id<"operationsAutonomyStates">[] = await ctx.runQuery(
        internal.operationsAutonomyScheduler.dueStates,
        { now },
      );
      for (const stateId of stateIds) {
        if (!(await renewLeaseIfNeeded())) return progress;
        const enqueued = await ctx.runMutation(
          internal.operationsAutonomyScheduler.enqueueDueSchedules,
          {
            stateId,
            leaseId,
            now,
          },
        );
        if (!enqueued.leaseHeld) return progress;
        progress.evaluated += 1;
      }
      const cancellationPolicies: Id<"operationsAutonomyPolicyVersions">[] = await ctx.runQuery(
        internal.operationsAutonomyScheduler.pendingCancellationPolicies,
        {},
      );
      for (const policyVersionId of cancellationPolicies) {
        if (!(await renewLeaseIfNeeded())) return progress;
        const canceled = await ctx.runMutation(
          internal.operationsAutonomyScheduler.cancelPendingInboxPage,
          {
            policyVersionId,
            leaseId,
            now,
          },
        );
        if (!canceled.leaseHeld) return progress;
      }
      const inboxIds: Id<"operationsAutonomyInbox">[] = await ctx.runQuery(
        internal.operationsAutonomyScheduler.pendingInboxCandidates,
        { now },
      );
      for (const inboxId of inboxIds) {
        if (!(await renewLeaseIfNeeded())) return progress;
        const materialized = await ctx.runMutation(
          internal.operationsAutonomyScheduler.materializeInbox,
          {
            inboxId,
            leaseId,
            now,
          },
        );
        if (!materialized.leaseHeld) return progress;
        progress.queued += 1;
      }
      const continuationIds: Id<"operationsAutonomyContinuations">[] = await ctx.runQuery(
        internal.operationsAutonomyDispatch.dueContinuations,
        { now },
      );
      for (const continuationId of continuationIds) {
        if (!(await renewLeaseIfNeeded())) return progress;
        const scheduled = await ctx.runMutation(
          internal.operationsAutonomyScheduler.scheduleContinuation,
          {
            continuationId,
            leaseId,
            now,
          },
        );
        if (!scheduled) return progress;
      }
      return progress;
    } finally {
      await ctx.runMutation(internal.operationsBackground.release, {
        holder: "autonomy_tick",
        leaseId,
      });
    }
  },
});

export const openRunStream = action({
  args: { eventSlug: v.string(), runId: v.id("operationsAutonomyRuns") },
  returns: streamAccess,
  handler: async (
    ctx: ActionCtx,
    args: { eventSlug: string; runId: Id<"operationsAutonomyRuns"> },
  ): Promise<OperationsIntelligenceStreamAccess> => {
    const authorization = await ctx.runQuery(internal.operationsAutonomy.authorizeRunStream, args);
    const issuedAt = Date.now();
    const ticket: OperationsIntelligenceStreamTicket = {
      protocolVersion: operationsIntelligenceProtocolVersion,
      eventSlug: authorization.eventSlug,
      runId: authorization.runId,
      instanceId: authorization.runId,
      agentName: "operations-autopilot",
      capability: operationsIntelligenceStreamCapability,
      issuedAt,
      expiresAt: issuedAt + operationsIntelligenceStreamTicketLifetimeMs,
      nonce: crypto.randomUUID(),
    };
    return signedStreamAccess({
      ticket,
      signatureContext: operationsAutonomyStreamTicketSignatureContext,
      conversationUrl: intelligenceWorkerUrl(
        `/v1/operations-autonomy-runs/${encodeURIComponent(authorization.runId)}`,
      ),
    });
  },
});
