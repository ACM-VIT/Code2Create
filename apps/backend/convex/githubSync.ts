import {
  githubSyncIngressContext,
  githubSyncMaximumRetryAfterMs,
  githubSyncProtocolVersion,
  signServiceBody,
  type GithubRepositorySyncRequest,
} from "@code2create/domain";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { internalAction, internalMutation } from "./_generated/server";
import { refreshGithubTeamMetrics } from "./lib/githubTeamMetrics";
import {
  requireIntelligenceHmacSecret,
  requireIntelligenceWorkerOrigin,
} from "./lib/intelligenceServiceConfiguration";
import { appendGithubIntegrationReadFactById } from "./lib/operationsAutonomyReadFacts/integrationJobs";
import { githubRepositoryCoverage } from "./values";

/** A reconciliation the Worker has not settled by this deadline is dispatched again. */
const syncDeadlineMs = 5 * 60_000;
/** A dispatch the Worker refused is retried after this pause. */
const dispatchRetryMs = 30_000;
const sweepPageSize = 25;

const languageBytes = v.array(v.object({ language: v.string(), bytes: v.number() }));

const syncRequest = v.object({
  protocolVersion: v.literal(githubSyncProtocolVersion),
  bindingId: v.string(),
  syncRevision: v.number(),
  installationId: v.string(),
  repositoryId: v.string(),
  owner: v.string(),
  name: v.string(),
  trackedBranch: v.string(),
  rootPath: v.optional(v.string()),
  baselineSha: v.string(),
  requiredTopic: v.string(),
});

const observation = v.object({
  repositoryId: v.string(),
  owner: v.string(),
  name: v.string(),
  fullName: v.string(),
  url: v.string(),
  isPrivate: v.boolean(),
  isFork: v.boolean(),
  defaultBranch: v.string(),
  topicState: v.union(v.literal("present"), v.literal("missing")),
  headSha: v.string(),
  providerCommitAt: v.optional(v.number()),
  commitCount: v.number(),
  additions: v.number(),
  deletions: v.number(),
  changedFiles: v.number(),
  observedCommitShas: v.array(v.string()),
  commitIdentityComplete: v.boolean(),
  languageBytes,
  completeness: githubRepositoryCoverage,
  compareTruncated: v.boolean(),
});

const syncSettlement = v.union(
  v.object({
    bindingId: v.string(),
    syncRevision: v.number(),
    status: v.literal("succeeded"),
    observation,
  }),
  v.object({
    bindingId: v.string(),
    syncRevision: v.number(),
    status: v.literal("rate_limited"),
    errorCode: v.literal("github_rate_limited"),
    retryAfterMs: v.number(),
  }),
  v.object({
    bindingId: v.string(),
    syncRevision: v.number(),
    status: v.literal("failed"),
    errorCode: v.string(),
  }),
);

const settlementState = v.union(
  v.literal("accepted"),
  v.literal("already_settled"),
  v.literal("stale"),
);

/** Requests one reconciliation for the binding's current `syncRevision`. */
export async function scheduleRepositorySync(
  ctx: MutationCtx,
  bindingId: Id<"githubRepositoryBindings">,
  delayMs = 0,
) {
  await ctx.scheduler.runAfter(delayMs, internal.githubSync.dispatch, { bindingId });
}

async function recordBindingChange(ctx: MutationCtx, binding: Doc<"githubRepositoryBindings">, now: number) {
  await appendGithubIntegrationReadFactById(ctx, binding._id, now);
  await refreshGithubTeamMetrics(ctx, { eventId: binding.eventId, teamId: binding.teamId, now });
}

function normalizedObservedCommitShas(args: {
  values: string[];
  commitCount: number;
  complete: boolean;
}) {
  const normalized = [...new Set(args.values.map((value) => value.trim()).filter(Boolean))];
  if (
    normalized.length > 100 ||
    normalized.length > args.commitCount ||
    (args.complete && normalized.length !== args.commitCount)
  ) {
    throw new Error("GitHub returned an inconsistent commit identity set.");
  }
  return normalized;
}

/**
 * Freezes the binding's current revision into one Worker request. A binding
 * whose reconciliation is still inside its deadline is not requested twice; a
 * newer revision settles through the dirty re-dispatch when that result lands.
 */
export const claimSyncRequest = internalMutation({
  args: { bindingId: v.id("githubRepositoryBindings") },
  returns: v.union(v.null(), syncRequest),
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.bindingId);
    if (!binding || binding.state !== "active" || !binding.baselineSha) return null;
    if (binding.syncedRevision >= binding.syncRevision) return null;
    const now = Date.now();
    if (binding.syncState === "running" && (binding.syncLeaseExpiresAt ?? 0) > now) return null;
    const connection = await ctx.db.get(binding.installationConnectionId);
    if (!connection || connection.state !== "active") {
      await ctx.db.patch(binding._id, {
        state: "inaccessible",
        syncState: "error",
        syncErrorCode: "installation_unavailable",
        syncLeaseId: undefined,
        syncLeaseExpiresAt: undefined,
        version: binding.version + 1,
        updatedAt: now,
      });
      await recordBindingChange(ctx, binding, now);
      return null;
    }
    await ctx.db.patch(binding._id, {
      syncState: "running",
      syncLeaseId: undefined,
      syncLeaseExpiresAt: now + syncDeadlineMs,
      syncErrorCode: undefined,
    });
    const request: GithubRepositorySyncRequest = {
      protocolVersion: githubSyncProtocolVersion,
      bindingId: binding._id,
      syncRevision: binding.syncRevision,
      installationId: connection.installationId,
      repositoryId: binding.repositoryId,
      owner: binding.owner,
      name: binding.name,
      trackedBranch: binding.trackedBranch,
      ...(binding.rootPath === undefined ? {} : { rootPath: binding.rootPath }),
      baselineSha: binding.baselineSha,
      requiredTopic: binding.requiredTopic,
    };
    return request;
  },
});

/** Returns a refused dispatch to `pending` and retries after a bounded pause. */
export const releaseSyncRequest = internalMutation({
  args: { bindingId: v.id("githubRepositoryBindings"), syncRevision: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.bindingId);
    if (
      !binding ||
      binding.state !== "active" ||
      binding.syncState !== "running" ||
      binding.syncedRevision >= args.syncRevision
    ) {
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(binding._id, {
      syncState: "pending",
      syncLeaseExpiresAt: now + dispatchRetryMs,
      updatedAt: now,
    });
    await scheduleRepositorySync(ctx, binding._id, dispatchRetryMs);
    return null;
  },
});

/** Signs the frozen request and hands the provider work to the intelligence Worker. */
export const dispatch = internalAction({
  args: { bindingId: v.id("githubRepositoryBindings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const request: GithubRepositorySyncRequest | null = await ctx.runMutation(
      internal.githubSync.claimSyncRequest,
      { bindingId: args.bindingId },
    );
    if (!request) return null;
    const body = JSON.stringify(request);
    const timestamp = String(Date.now());
    let accepted = false;
    try {
      const signature = await signServiceBody({
        context: githubSyncIngressContext,
        secret: requireIntelligenceHmacSecret("INTELLIGENCE_INGRESS_SECRET"),
        timestamp,
        body,
      });
      const response = await fetch(
        new URL("/v1/github/repository-syncs", requireIntelligenceWorkerOrigin()),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-c2c-timestamp": timestamp,
            "x-c2c-signature": signature,
          },
          body,
          signal: AbortSignal.timeout(20_000),
        },
      );
      accepted = response.status === 202;
    } catch {
      accepted = false;
    }
    if (!accepted) {
      await ctx.runMutation(internal.githubSync.releaseSyncRequest, {
        bindingId: args.bindingId,
        syncRevision: request.syncRevision,
      });
    }
    return null;
  },
});

/**
 * Applies one signed settlement exactly once per revision. A result for an
 * older revision still records what GitHub returned, then requests the newer
 * revision so the binding converges without a lease.
 */
export const apply = internalMutation({
  args: { settlement: syncSettlement },
  returns: settlementState,
  handler: async (ctx, { settlement }) => {
    const bindingId = ctx.db.normalizeId("githubRepositoryBindings", settlement.bindingId);
    const binding = bindingId === null ? null : await ctx.db.get(bindingId);
    if (!binding || binding.state !== "active") return "stale";
    if (settlement.syncRevision <= binding.syncedRevision) return "already_settled";
    if (settlement.syncRevision > binding.syncRevision) return "stale";
    const now = Date.now();
    const dirty = binding.syncRevision > settlement.syncRevision;
    if (settlement.status === "rate_limited") {
      const retryAfterMs = Math.min(
        Math.max(settlement.retryAfterMs, 1_000),
        githubSyncMaximumRetryAfterMs,
      );
      await ctx.db.patch(binding._id, {
        syncState: "rate_limited",
        syncErrorCode: settlement.errorCode,
        syncLeaseId: undefined,
        syncLeaseExpiresAt: now + retryAfterMs,
        version: binding.version + 1,
        updatedAt: now,
      });
      await recordBindingChange(ctx, binding, now);
      await scheduleRepositorySync(ctx, binding._id, retryAfterMs);
      return "accepted";
    }
    if (settlement.status === "failed") {
      await ctx.db.patch(binding._id, {
        syncState: "error",
        syncErrorCode: settlement.errorCode,
        syncLeaseId: undefined,
        syncLeaseExpiresAt: undefined,
        version: binding.version + 1,
        updatedAt: now,
      });
      await recordBindingChange(ctx, binding, now);
      return "accepted";
    }
    const observed = settlement.observation;
    if (observed.repositoryId !== binding.repositoryId) {
      throw new Error("The repository sync settlement names a different repository.");
    }
    const metric = await ctx.db
      .query("githubRepositoryMetrics")
      .withIndex("by_binding", (index) => index.eq("repositoryBindingId", binding._id))
      .unique();
    if (!metric) throw new Error("GitHub repository metrics are missing.");
    for (const value of [observed.commitCount, observed.additions, observed.deletions, observed.changedFiles]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("GitHub returned an invalid repository metric.");
      }
    }
    const observedCommitShas = normalizedObservedCommitShas({
      values: observed.observedCommitShas,
      commitCount: observed.commitCount,
      complete: observed.commitIdentityComplete,
    });
    await ctx.db.patch(binding._id, {
      owner: observed.owner,
      name: observed.name,
      fullName: observed.fullName,
      url: observed.url,
      isPrivate: observed.isPrivate,
      isFork: observed.isFork,
      defaultBranch: observed.defaultBranch,
      topicState: dirty ? "unknown" : observed.topicState,
      currentHeadSha: observed.headSha,
      pendingHeadSha: undefined,
      lastReconciledAt: now,
      syncedRevision: settlement.syncRevision,
      syncState: dirty ? "pending" : "ready",
      syncLeaseId: undefined,
      syncLeaseExpiresAt: undefined,
      syncErrorCode: undefined,
      version: binding.version + 1,
      updatedAt: now,
    });
    await ctx.db.patch(metric._id, {
      currentHeadSha: observed.headSha,
      commitCount: observed.commitCount,
      additions: observed.additions,
      deletions: observed.deletions,
      changedFiles: observed.changedFiles,
      observedCommitShas,
      commitIdentityComplete: observed.commitIdentityComplete,
      languageBytes: observed.languageBytes,
      completeness: observed.completeness,
      compareTruncated: observed.compareTruncated,
      ...(observed.providerCommitAt === undefined
        ? {}
        : { lastProviderCommitAt: observed.providerCommitAt }),
      capturedAt: now,
      version: metric.version + 1,
    });
    const previousSnapshot = await ctx.db
      .query("githubRepositorySnapshots")
      .withIndex("by_binding_time", (index) => index.eq("repositoryBindingId", binding._id))
      .order("desc")
      .first();
    await ctx.db.insert("githubRepositorySnapshots", {
      eventId: binding.eventId,
      teamId: binding.teamId,
      repositoryBindingId: binding._id,
      ...(previousSnapshot ? { previousSnapshotId: previousSnapshot._id } : {}),
      reason: "reconcile",
      headSha: observed.headSha,
      topicState: observed.topicState,
      commitCount: observed.commitCount,
      additions: observed.additions,
      deletions: observed.deletions,
      changedFiles: observed.changedFiles,
      observedCommitShas,
      commitIdentityComplete: observed.commitIdentityComplete,
      languageBytes: observed.languageBytes,
      completeness: observed.completeness,
      compareTruncated: observed.compareTruncated,
      ...(observed.providerCommitAt === undefined
        ? {}
        : { providerCommitAt: observed.providerCommitAt }),
      capturedAt: now,
    });
    await recordBindingChange(ctx, binding, now);
    if (dirty) await scheduleRepositorySync(ctx, binding._id);
    return "accepted";
  },
});

/**
 * Re-requests reconciliations whose Worker settlement never arrived and pending
 * bindings whose dispatch was lost, one bounded page per event and minute.
 */
export const sweep = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const events = await ctx.db.query("events").collect();
    let dispatched = 0;
    for (const event of events) {
      const overdue = await ctx.db
        .query("githubRepositoryBindings")
        .withIndex("by_event_state_sync_lease", (index) =>
          index
            .eq("eventId", event._id)
            .eq("state", "active")
            .eq("syncState", "running")
            .lt("syncLeaseExpiresAt", now),
        )
        .take(sweepPageSize);
      const lost = await ctx.db
        .query("githubRepositoryBindings")
        .withIndex("by_event_state_sync_updated", (index) =>
          index
            .eq("eventId", event._id)
            .eq("state", "active")
            .eq("syncState", "pending")
            .lt("updatedAt", now - syncDeadlineMs),
        )
        .take(sweepPageSize);
      for (const binding of [...overdue, ...lost]) {
        if (binding.syncedRevision >= binding.syncRevision) continue;
        await ctx.db.patch(binding._id, {
          syncState: "pending",
          syncLeaseExpiresAt: undefined,
          updatedAt: now,
        });
        await scheduleRepositorySync(ctx, binding._id);
        dispatched += 1;
      }
    }
    return dispatched;
  },
});
