import { ConvexError, v } from "convex/values";
import type { ReviewQuestionSource } from "@code2create/domain";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { operationFingerprint } from "./lib/operations";
import { reviewQuestionCallbackSchema } from "./lib/reviewQuestionProtocol";
import { questionJobAuthorized, questionLeaseCurrent } from "./reviewQuestions";
import { reviewSourceBatches } from "./lib/reviewQuestionSources";
import { reviewQuestionSource } from "./values";

type Job = Doc<"reviewQuestionSets">;
const identity = { jobId: v.id("reviewQuestionSets"), attempt: v.number() };
const zeroCoverage = {
  discovered: 0,
  captured: 0,
  excluded: 0,
  unavailable: 0,
  chunks: 0,
  analysedChunks: 0,
  cachedBatches: 0,
};
export async function renewQuestionWork(
  ctx: MutationCtx,
  job: Job,
  delayMs = 0,
) {
  const leaseExpiresAt =
    Date.now() + delayMs + job.policy.preparationTimeoutSeconds * 1000 + 60000;
  await ctx.db.patch(job._id, { leaseExpiresAt, updatedAt: Date.now() });
  await ctx.scheduler.runAt(leaseExpiresAt, internal.reviewQuestions.expire, {
    jobId: job._id,
    attempt: job.attempt,
  });
}
async function currentJob(
  ctx: MutationCtx,
  args: { jobId: Id<"reviewQuestionSets">; attempt: number },
) {
  const job = await ctx.db.get(args.jobId);
  return job &&
    job.attempt === args.attempt &&
    job.state === "collecting" &&
    questionLeaseCurrent(job) &&
    (await questionJobAuthorized(ctx, job))
    ? job
    : null;
}
function referencesFor(sources: ReviewQuestionSource[]) {
  return sources.map(({ text: _text, ...reference }) => reference);
}
async function addPart(
  ctx: MutationCtx,
  job: Job,
  args: {
    key: string;
    level: number;
    sources: ReviewQuestionSource[];
    references?: Omit<ReviewQuestionSource, "text">[];
  },
) {
  const previous = await ctx.db
    .query("reviewQuestionParts")
    .withIndex("by_job_attempt_key", (q) =>
      q.eq("jobId", job._id).eq("attempt", job.attempt).eq("key", args.key),
    )
    .unique();
  if (previous) return;
  if (
    !args.sources.length ||
    args.sources.length > 150 ||
    args.sources.reduce((n, s) => n + s.text.length, 0) >
      job.policy.batchCharacters
  )
    throw new Error(
      "Analysis batch must fit its configured size without discarding source text.",
    );
  const references = args.references ?? referencesFor(args.sources);
  if (references.length > 150)
    throw new Error("Too many references in one analysis batch.");
  const cacheKey = operationFingerprint([
    "comprehensive-review-v2",
    job.snapshot.projectVersionId,
    job.roundId,
    job.snapshot.teamCheckpointSubmissionId ?? null,
    job.snapshot.previousCheckpointSetId ?? null,
    job.policy.model,
    job.policy.instructions,
    args.level,
    JSON.stringify(
      args.sources.map((s) => [s.id, s.title, s.text, s.coverage, s.image ?? null]),
    ),
  ]);
  const matches = await Promise.all(
    (["ready", "consumed"] as const).map((state) =>
      ctx.db
        .query("reviewQuestionParts")
        .withIndex("by_team_cache_state", (q) =>
          q
            .eq("teamId", job.teamId)
            .eq("cacheKey", cacheKey)
            .eq("state", state),
        )
        .first(),
    ),
  );
  const cached = matches.find((part) => part?.analysis);
  await ctx.db.insert("reviewQuestionParts", {
    jobId: job._id,
    teamId: job.teamId,
    attempt: job.attempt,
    key: args.key,
    level: args.level,
    sources: args.sources,
    references,
    state: cached ? "ready" : "queued",
    ...(cached ? { analysis: cached.analysis } : {}),
    cacheKey,
    cached: !!cached,
    partAttempt: 0,
  });
  if (args.level === 0) {
    const latest = await ctx.db.get(job._id);
    const coverage = latest?.coverage ?? zeroCoverage;
    await ctx.db.patch(job._id, {
      coverage: {
        ...coverage,
        chunks: coverage.chunks + args.sources.length,
        analysedChunks:
          coverage.analysedChunks + (cached ? args.sources.length : 0),
        cachedBatches: coverage.cachedBatches + (cached ? 1 : 0),
      },
    });
  }
}
export const initialize = internalMutation({
  args: {
    ...identity,
    sources: v.array(reviewQuestionSource),
    collections: v.array(
      v.object({
        sourceId: v.string(),
        kind: v.union(v.literal("github"), v.literal("figma")),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await currentJob(ctx, args);
    if (!job) return null;
    if ((job.coverage?.discovered ?? 0) > 0) return null;
    const batches = reviewSourceBatches(
      args.sources,
      job.policy.batchCharacters,
    );
    for (let index = 0; index < batches.length; index++) {
      const sources = batches[index];
      if (sources)
        await addPart(ctx, job, { key: `project:${index}`, level: 0, sources });
    }
    const latest = await ctx.db.get(job._id);
    await ctx.db.patch(job._id, {
      coverage: {
        ...(latest?.coverage ?? zeroCoverage),
        discovered: args.sources.length,
        captured: args.sources.length,
      },
      collectionComplete: args.collections.length === 0,
    });
    for (const source of args.collections) {
      const collectionId = await ctx.db.insert("reviewQuestionCollections", {
        ...source,
        jobId: job._id,
        attempt: job.attempt,
        state: "queued",
        offset: 0,
        failures: 0,
      });
      await ctx.scheduler.runAfter(0, internal.reviewQuestionActions.collect, {
        collectionId,
      });
    }
    await renewQuestionWork(ctx, job);
    await ctx.scheduler.runAfter(
      0,
      internal.reviewQuestionParts.advance,
      argsIdentity(job),
    );
    return null;
  },
});
function argsIdentity(job: Job) {
  return { jobId: job._id, attempt: job.attempt };
}
export const append = internalMutation({
  args: {
    ...identity,
    collectionId: v.id("reviewQuestionCollections"),
    offset: v.number(),
    batch: v.number(),
    sources: v.array(reviewQuestionSource),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await currentJob(ctx, args);
    const collection = await ctx.db.get(args.collectionId);
    if (
      !job ||
      !collection ||
      collection.jobId !== job._id ||
      collection.attempt !== job.attempt ||
      collection.state !== "running" ||
      collection.offset !== args.offset
    )
      return false;
    await addPart(ctx, job, {
      key: `${collection._id}:${args.offset}:${args.batch}`,
      level: 0,
      sources: args.sources,
    });
    await renewQuestionWork(ctx, job);
    await ctx.scheduler.runAfter(
      0,
      internal.reviewQuestionParts.advance,
      argsIdentity(job),
    );
    return true;
  },
});
export const claimCollection = internalMutation({
  args: { collectionId: v.id("reviewQuestionCollections") },
  handler: async (ctx, args) => {
    const collection = await ctx.db.get(args.collectionId);
    if (!collection) return null;
    const job = await currentJob(ctx, collection);
    if (
      !job ||
      collection.state === "complete" ||
      (collection.state === "running" &&
        (collection.leaseExpiresAt ?? 0) > Date.now())
    )
      return null;
    const leaseExpiresAt =
      Date.now() + job.policy.preparationTimeoutSeconds * 1000;
    await ctx.db.patch(collection._id, { state: "running", leaseExpiresAt });
    await renewQuestionWork(ctx, job);
    await ctx.scheduler.runAt(
      leaseExpiresAt,
      internal.reviewQuestionParts.collectionExpired,
      { ...args, leaseExpiresAt },
    );
    return { ...collection, batchCharacters: job.policy.batchCharacters };
  },
});
export const collectionExpired = internalMutation({
  args: {
    collectionId: v.id("reviewQuestionCollections"),
    leaseExpiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const collection = await ctx.db.get(args.collectionId);
    if (
      collection?.state === "running" &&
      collection.leaseExpiresAt === args.leaseExpiresAt &&
      args.leaseExpiresAt <= Date.now()
    )
      await retryCollection(ctx, collection, "collection_timeout", 1000);
    return null;
  },
});
async function retryCollection(
  ctx: MutationCtx,
  collection: Doc<"reviewQuestionCollections">,
  failureCode: string,
  delayMs: number,
) {
  const job = await ctx.db.get(collection.jobId);
  if (
    !job ||
    job.attempt !== collection.attempt ||
    job.state !== "collecting" ||
    !(await questionJobAuthorized(ctx, job))
  )
    return;
  if (collection.failures + 1 >= job.policy.maximumAttempts) {
    await ctx.db.patch(job._id, {
      state: "failed",
      failureCode,
      updatedAt: Date.now(),
    });
    return;
  }
  await ctx.db.patch(collection._id, {
    state: "queued",
    failures: collection.failures + 1,
    leaseExpiresAt: undefined,
  });
  await renewQuestionWork(ctx, job, delayMs);
  await ctx.scheduler.runAfter(
    delayMs,
    internal.reviewQuestionActions.collect,
    { collectionId: collection._id },
  );
}
export const collectionFailed = internalMutation({
  args: {
    collectionId: v.id("reviewQuestionCollections"),
    offset: v.number(),
    failureCode: v.string(),
    delayMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const collection = await ctx.db.get(args.collectionId);
    if (collection?.state === "running" && collection.offset === args.offset)
      await retryCollection(
        ctx,
        collection,
        args.failureCode,
        Math.min(3600000, Math.max(1000, args.delayMs)),
      );
    return null;
  },
});
export const saveManifest = internalMutation({
  args: {
    collectionId: v.id("reviewQuestionCollections"),
    manifestId: v.id("_storage"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const collection = await ctx.db.get(args.collectionId);
    if (
      !collection ||
      !(await currentJob(ctx, collection)) ||
      collection.state !== "running"
    )
      return false;
    if (collection.manifestId) return false;
    await ctx.db.patch(collection._id, { manifestId: args.manifestId });
    return true;
  },
});
export const collected = internalMutation({
  args: {
    collectionId: v.id("reviewQuestionCollections"),
    offset: v.number(),
    nextOffset: v.number(),
    done: v.boolean(),
    captured: v.number(),
    excluded: v.number(),
    unavailable: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const collection = await ctx.db.get(args.collectionId);
    if (!collection) return null;
    const job = await currentJob(ctx, collection);
    if (
      !job ||
      collection.state !== "running" ||
      collection.offset !== args.offset
    )
      return null;
    const coverage = job.coverage ?? zeroCoverage;
    await ctx.db.patch(collection._id, {
      state: args.done ? "complete" : "queued",
      offset: args.nextOffset,
      leaseExpiresAt: undefined,
      failures: 0,
    });
    await ctx.db.patch(job._id, {
      coverage: {
        ...coverage,
        discovered:
          coverage.discovered +
          args.captured +
          args.excluded +
          args.unavailable,
        captured: coverage.captured + args.captured,
        excluded: coverage.excluded + args.excluded,
        unavailable: coverage.unavailable + args.unavailable,
      },
    });
    if (!args.done)
      await ctx.scheduler.runAfter(0, internal.reviewQuestionActions.collect, {
        collectionId: collection._id,
      });
    const outstanding = await Promise.all(
      (["queued", "running"] as const).map((state) =>
        ctx.db
          .query("reviewQuestionCollections")
          .withIndex("by_job_attempt_state", (q) =>
            q
              .eq("jobId", job._id)
              .eq("attempt", job.attempt)
              .eq("state", state),
          )
          .first(),
      ),
    );
    if (outstanding.every((row) => !row))
      await ctx.db.patch(job._id, { collectionComplete: true });
    await renewQuestionWork(ctx, job);
    await ctx.scheduler.runAfter(
      0,
      internal.reviewQuestionParts.advance,
      argsIdentity(job),
    );
    return null;
  },
});

export const advance = internalMutation({
  args: identity,
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await currentJob(ctx, args);
    if (!job) return null;
    const level = job.analysisLevel ?? 0;
    const parts = (
      state: "queued" | "generating" | "ready",
      count: number,
      atLevel = level,
    ) =>
      ctx.db
        .query("reviewQuestionParts")
        .withIndex("by_job_attempt_level_state", (q) =>
          q
            .eq("jobId", job._id)
            .eq("attempt", job.attempt)
            .eq("level", atLevel)
            .eq("state", state),
        )
        .take(count);
    const [running, queued] = await Promise.all([
      parts("generating", 8),
      parts("queued", job.policy.parallelAnalyses),
    ]);
    for (const part of queued.slice(
      0,
      Math.max(0, job.policy.parallelAnalyses - running.length),
    )) {
      const partAttempt = part.partAttempt + 1;
      const leaseExpiresAt =
        Date.now() + job.policy.preparationTimeoutSeconds * 1000;
      await ctx.db.patch(part._id, {
        state: "generating",
        partAttempt,
        leaseExpiresAt,
      });
      await ctx.scheduler.runAfter(0, internal.reviewQuestionActions.analyse, {
        partId: part._id,
        partAttempt,
      });
      await ctx.scheduler.runAt(
        leaseExpiresAt,
        internal.reviewQuestionParts.expirePart,
        { partId: part._id, partAttempt },
      );
    }
    if (running.length || queued.length || !job.collectionComplete) {
      await renewQuestionWork(ctx, job);
      return null;
    }
    const ready = await parts("ready", 2);
    if (ready.length === 2) {
      const sources = ready.map(analysisSource);
      const references = analysisReferences(ready);
      await addPart(ctx, job, {
        key: ready.map((p) => p._id).join(":"),
        level: level + 1,
        sources,
        references,
      });
      for (const part of ready)
        await ctx.db.patch(part._id, { state: "consumed" });
    } else {
      const next = await Promise.all(
        (["queued", "generating", "ready"] as const).map((state) =>
          parts(state, 1, level + 1),
        ),
      );
      if (next.some((rows) => rows.length)) {
        if (ready[0]) await ctx.db.patch(ready[0]._id, { level: level + 1 });
        await ctx.db.patch(job._id, { analysisLevel: level + 1 });
      } else if (ready[0]) {
        await ctx.scheduler.runAfter(
          0,
          internal.reviewQuestionActions.finalize,
          { partId: ready[0]._id },
        );
        return null;
      } else throw new Error("Completed collection has no analysis.");
    }
    await renewQuestionWork(ctx, job);
    await ctx.scheduler.runAfter(0, internal.reviewQuestionParts.advance, args);
    return null;
  },
});
export function analysisSource(
  part: Doc<"reviewQuestionParts">,
): ReviewQuestionSource {
  if (!part.analysis) throw new Error("Ready evidence batch has no analysis.");
  return {
    id: `analysis:${part._id}`,
    kind: "checkpoint",
    title: "Project evidence analysis",
    coverage: "partial",
    text: JSON.stringify({
      summary: part.analysis.summary,
      findings: part.analysis.findings,
    }),
  };
}
export function analysisReferences(parts: Doc<"reviewQuestionParts">[]) {
  const references = new Map<string, Omit<ReviewQuestionSource, "text">>();
  for (const part of parts) {
    if (!part.analysis) throw new Error("Missing evidence analysis.");
    const cited = new Set(part.analysis.findings.flatMap((f) => f.sourceIds));
    for (const reference of part.references)
      if (cited.has(reference.id)) references.set(reference.id, reference);
  }
  return [...references.values()];
}
export const partContext = internalQuery({
  args: {
    partId: v.id("reviewQuestionParts"),
    partAttempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const part = await ctx.db.get(args.partId);
    if (!part) return null;
    const job = await ctx.db.get(part.jobId);
    if (
      !job ||
      job.attempt !== part.attempt ||
      job.state !== "collecting" ||
      !questionLeaseCurrent(job) ||
      !(await questionJobAuthorized(ctx, job))
    )
      return null;
    if (
      args.partAttempt !== undefined &&
      (part.state !== "generating" ||
        part.partAttempt !== args.partAttempt ||
        (part.leaseExpiresAt ?? 0) <= Date.now())
    )
      return null;
    return { part, job };
  },
});
export const saveRequest = internalMutation({
  args: {
    partId: v.id("reviewQuestionParts"),
    partAttempt: v.number(),
    payloadChecksum: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const part = await ctx.db.get(args.partId);
    if (
      !part ||
      part.state !== "generating" ||
      part.partAttempt !== args.partAttempt ||
      !(await currentJob(ctx, part))
    )
      return false;
    await ctx.db.patch(part._id, { payloadChecksum: args.payloadChecksum });
    return true;
  },
});
export const expirePart = internalMutation({
  args: { partId: v.id("reviewQuestionParts"), partAttempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const part = await ctx.db.get(args.partId);
    if (
      !part ||
      part.state !== "generating" ||
      part.partAttempt !== args.partAttempt ||
      (part.leaseExpiresAt ?? Infinity) > Date.now()
    )
      return null;
    const job = await ctx.db.get(part.jobId);
    if (!job || job.attempt !== part.attempt || job.state !== "collecting")
      return null;
    if (part.partAttempt >= job.policy.maximumAttempts)
      await ctx.db.patch(job._id, {
        state: "failed",
        failureCode: "analysis_timeout",
        updatedAt: Date.now(),
      });
    else {
      await ctx.db.patch(part._id, {
        state: "queued",
        leaseExpiresAt: undefined,
      });
      await renewQuestionWork(ctx, job);
      await ctx.scheduler.runAfter(
        0,
        internal.reviewQuestionParts.advance,
        argsIdentity(job),
      );
    }
    return null;
  },
});
export const settle = internalMutation({
  args: { body: v.string() },
  returns: v.union(
    v.literal("accepted"),
    v.literal("already_settled"),
    v.literal("stale"),
  ),
  handler: async (ctx, args) => {
    const result = reviewQuestionCallbackSchema.parse(JSON.parse(args.body));
    const partId = ctx.db.normalizeId("reviewQuestionParts", result.partId);
    const part = partId ? await ctx.db.get(partId) : null;
    if (
      !part ||
      part.jobId !== result.jobId ||
      part.attempt !== result.attempt ||
      part.partAttempt !== result.partAttempt ||
      part.payloadChecksum !== result.payloadChecksum
    )
      return "stale";
    if (part.state === "ready" || part.state === "consumed")
      return "already_settled";
    const job = await currentJob(ctx, part);
    if (
      !job ||
      job.sourceChecksum !== result.sourceChecksum ||
      part.state !== "generating" ||
      (part.leaseExpiresAt ?? 0) <= Date.now()
    )
      return "stale";
    if (result.status === "ready")
      throw new Error("Expected evidence analysis.");
    if (result.status === "failed") {
      await ctx.db.patch(part._id, { leaseExpiresAt: Date.now() });
      await ctx.scheduler.runAfter(0, internal.reviewQuestionParts.expirePart, {
        partId: part._id,
        partAttempt: part.partAttempt,
      });
      return "accepted";
    }
    const examined = new Set(result.examinedSourceIds);
    if (
      examined.size !== part.sources.length ||
      examined.size !== result.examinedSourceIds.length ||
      part.sources.some((s) => !examined.has(s.id)) ||
      result.findings.some((f) =>
        f.sourceIds.some((id) => !part.references.some((r) => r.id === id)),
      )
    )
      throw new ConvexError({
        code: "INVALID_EVIDENCE_ANALYSIS",
        message:
          "Every source must be accounted for and findings must cite original evidence.",
      });
    const analysis = {
      summary: result.summary,
      findings: result.findings,
      examinedSourceIds: result.examinedSourceIds,
    };
    await ctx.db.patch(part._id, {
      state: "ready",
      analysis,
      leaseExpiresAt: undefined,
    });
    if (part.level === 0) {
      const coverage = job.coverage ?? zeroCoverage;
      await ctx.db.patch(job._id, {
        coverage: {
          ...coverage,
          analysedChunks: coverage.analysedChunks + part.sources.length,
        },
      });
    }
    await renewQuestionWork(ctx, job);
    await ctx.scheduler.runAfter(
      0,
      internal.reviewQuestionParts.advance,
      argsIdentity(job),
    );
    return "accepted";
  },
});
