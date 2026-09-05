import { ConvexError, v, type Infer } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  matchingPermissionGrantIds,
  requirePermission,
} from "./lib/permissions";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { normalizedText } from "./lib/strings";
import { writeAuditEvent } from "./lib/audit";
import { buildEvidenceCheckpoint } from "./lib/reviewEvidenceCheckpoint";
import { fixedEvidenceContext } from "./reviewEvidence";
import {
  reviewEvidenceCoverage,
  reviewQuestionPolicy,
  reviewSuggestedQuestion,
  reviewQuestionSource,
} from "./values";
import {
  reviewQuestionRequestSchema,
  reviewQuestionCallbackSchema,
  questionPayloadChecksum,
} from "./lib/reviewQuestionProtocol";
import { maximumReviewTeamsPerEvent } from "./lib/reviewLimits";

const defaultPolicy = {
  enabled: false,
  visualAnalysis: true,
  refreshSeconds: 120,
  maximumQuestions: 3,
  parallelAnalyses: 3,
  batchCharacters: 80000,
  maximumAttempts: 3,
  preparationTimeoutSeconds: 300,
  model: "openai/gpt-5.6-terra",
  instructions: "",
};
function validatePolicy(policy: Infer<typeof reviewQuestionPolicy>) {
  const ranges: readonly (readonly [number, number, number])[] = [
    [policy.refreshSeconds, 30, 3600],
    [policy.maximumQuestions, 1, 12],
    [policy.parallelAnalyses, 1, 8],
    [policy.batchCharacters, 64000, 160000],
    [policy.maximumAttempts, 1, 10],
    [policy.preparationTimeoutSeconds, 60, 600],
  ];
  if (
    ranges.some(
      ([value, min, max]) =>
        !Number.isSafeInteger(value) || value < min || value > max,
    ) ||
    !/^openai\/[A-Za-z0-9._-]{1,100}$/.test(policy.model) ||
    policy.instructions.length > 2000
  )
    throw new ConvexError({
      code: "INVALID_QUESTION_POLICY",
      message: "Check the question settings and their displayed limits.",
    });
}
export const settings = query({
  args: { eventSlug: v.string(), roundId: v.id("reviewRounds") },
  returns: v.union(
    v.null(),
    v.object({
      version: v.number(),
      canConfigure: v.boolean(),
      policy: reviewQuestionPolicy,
      teams: v.array(
        v.object({
          teamId: v.id("teams"),
          name: v.string(),
          state: v.string(),
          updatedAt: v.optional(v.number()),
          failureCode: v.optional(v.string()),
          coverage: v.optional(reviewEvidenceCoverage),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    if (
      !(
        await matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "review.configuration.read",
          scopeType: "event",
        })
      ).length
    )
      return null;
    const round = await ctx.db.get(args.roundId);
    if (!round || round.eventId !== event._id)
      throw new ConvexError({
        code: "ROUND_NOT_FOUND",
        message: "Round unavailable.",
      });
    const [policy, grants, teams] = await Promise.all([
      ctx.db
        .query("reviewQuestionPolicies")
        .withIndex("by_round", (q) => q.eq("roundId", round._id))
        .unique(),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "review.configuration.publish",
        scopeType: "event",
      }),
      ctx.db
        .query("teams")
        .withIndex("by_event_status", (q) => q.eq("eventId", event._id))
        .filter(q => q.and(q.neq(q.field("competitionCategory"), "oc"), q.or(q.eq(q.field("status"), "confirmed"), q.eq(q.field("status"), "checked_in"), q.eq(q.field("status"), "active"))))
        .take(maximumReviewTeamsPerEvent + 1),
    ]);
    if (teams.length > maximumReviewTeamsPerEvent)
      throw new Error("Team limit exceeded.");
    return {
      version: policy?.version ?? 0,
      canConfigure:
        grants.length > 0 && ["published", "open"].includes(round.status),
      policy: policy?.policy ?? defaultPolicy,
      teams: await Promise.all(
        teams
          .filter(
            (team) =>
              team.lockedProjectVersionId,
          )
          .map(async (team) => {
            const job = await ctx.db
              .query("reviewQuestionSets")
              .withIndex("by_round_team_created", (q) =>
                q.eq("roundId", round._id).eq("teamId", team._id),
              )
              .order("desc")
              .first();
            return {
              teamId: team._id,
              name: team.name,
              state: job?.state ?? "not_prepared",
              ...(job ? { updatedAt: job.updatedAt } : {}),
              ...(job?.coverage ? { coverage: job.coverage } : {}),
              ...(job?.failureCode ? { failureCode: job.failureCode } : {}),
            };
          }),
      ),
    };
  },
});
export const configure = mutation({
  args: {
    eventSlug: v.string(),
    roundId: v.id("reviewRounds"),
    expectedVersion: v.number(),
    policy: reviewQuestionPolicy,
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    validatePolicy(args.policy);
    const reason = normalizedText(args.reason, "Reason", 3, 300);
    const requestFingerprint = operationFingerprint([
      args.roundId,
      args.expectedVersion,
      JSON.stringify(args.policy),
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.questions.configure",
      requestFingerprint,
    });
    if (prior)
      return {
        version: storedOperationVersion(prior.resultJson, "question settings"),
      };
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.configuration.publish",
      scopeType: "event",
    });
    if (args.policy.enabled)
      await requirePermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "operations.intelligence.generate",
        scopeType: "event",
      });
    const round = await ctx.db.get(args.roundId);
    if (
      !round ||
      round.eventId !== event._id ||
      !["published", "open"].includes(round.status)
    )
      throw new ConvexError({
        code: "ROUND_NOT_AVAILABLE",
        message: "This round cannot be configured.",
      });
    const current = await ctx.db
      .query("reviewQuestionPolicies")
      .withIndex("by_round", (q) => q.eq("roundId", round._id))
      .unique();
    if ((current?.version ?? 0) !== args.expectedVersion)
      throw new ConvexError({
        code: "QUESTION_POLICY_CHANGED",
        message: "Question settings changed. Refresh before saving.",
      });
    const version = args.expectedVersion + 1;
    const now = Date.now();
    const fields = {
      policy: args.policy,
      operatorPersonId: person._id,
      version,
      updatedAt: now,
    };
    if (current) await ctx.db.patch(current._id, fields);
    else
      await ctx.db.insert("reviewQuestionPolicies", {
        eventId: event._id,
        roundId: round._id,
        ...fields,
      });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.questions.configure",
      requestFingerprint,
      targetType: "review_round",
      targetId: round._id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.configuration.publish",
      grantIds,
      scopeType: "event",
      action: "review.questions_configured",
      targetType: "review_round",
      targetId: round._id,
      nextSummary: JSON.stringify({ version, policy: args.policy }),
      reason,
    });
    return { version };
  },
});
export async function prepareQuestionSet(
  ctx: MutationCtx,
  round: Doc<"reviewRounds">,
  team: Doc<"teams">,
  snapshot?: Awaited<ReturnType<typeof buildEvidenceCheckpoint>>,
) {
  if (team.competitionCategory === "oc") return undefined;
  const config = await ctx.db
    .query("reviewQuestionPolicies")
    .withIndex("by_round", (q) => q.eq("roundId", round._id))
    .unique();
  if (!config?.policy.enabled) return undefined;
  const actor = await ctx.db
    .query("eventAccessSubjects")
    .withIndex("by_event_person", (q) =>
      q.eq("eventId", round.eventId).eq("personId", config.operatorPersonId),
    )
    .unique();
  if (!actor || actor.status !== "active") return undefined;
  if (
    !(
      await matchingPermissionGrantIds(ctx, {
        eventId: round.eventId,
        eventAccessSubjectId: actor._id,
        permissionKey: "operations.intelligence.generate",
        scopeType: "event",
      })
    ).length
  )
    return undefined;
  const now = Date.now();
  const fields =
    snapshot ??
    (await buildEvidenceCheckpoint(ctx, {
      eventId: round.eventId,
      round,
      team,
      actorPersonId: config.operatorPersonId,
      createdAt: now,
    }));
  const existing = await ctx.db
    .query("reviewQuestionSets")
    .withIndex("by_round_team_source_policy", (q) =>
      q
        .eq("roundId", round._id)
        .eq("teamId", team._id)
        .eq("sourceChecksum", fields.checksum)
        .eq("policyVersion", config.version),
    )
    .unique();
  if (existing) {
    if (
      ["failed", "stale"].includes(existing.state) &&
      existing.attempt < existing.policy.maximumAttempts &&
      now >= existing.updatedAt + config.policy.refreshSeconds * 1000
    ) {
      await ctx.db.patch(existing._id, { state: "queued", updatedAt: now });
      await ctx.scheduler.runAfter(0, internal.reviewQuestionActions.prepare, {
        jobId: existing._id,
      });
    }
    return existing._id;
  }
  const previousJob = await ctx.db
    .query("reviewQuestionSets")
    .withIndex("by_round_team_created", (q) =>
      q.eq("roundId", round._id).eq("teamId", team._id),
    )
    .order("desc")
    .first();
  if (
    previousJob &&
    ["queued", "collecting", "generating"].includes(previousJob.state)
  ) {
    const pinned = await ctx.db
      .query("reviewSessions")
      .withIndex("by_question_set", (q) =>
        q.eq("questionSetId", previousJob._id),
      )
      .first();
    if (!pinned)
      await ctx.db.patch(previousJob._id, { state: "stale", updatedAt: now });
  }
  const jobId = await ctx.db.insert("reviewQuestionSets", {
    eventId: round.eventId,
    roundId: round._id,
    teamId: team._id,
    policyVersion: config.version,
    policy: config.policy,
    operatorPersonId: config.operatorPersonId,
    sourceChecksum: fields.checksum,
    snapshot: fields,
    state: "queued",
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.reviewQuestionActions.prepare, {
    jobId,
  });
  return jobId;
}
export const dispatch = internalMutation({
  args: {
    status: v.union(v.literal("published"), v.literal("open")),
    cursor: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rounds = await ctx.db
      .query("reviewRounds")
      .withIndex("by_status_start", (q) => q.eq("status", args.status))
      .paginate({ cursor: args.cursor ?? null, numItems: 10 });
    for (const round of rounds.page) {
      const config = await ctx.db
        .query("reviewQuestionPolicies")
        .withIndex("by_round", (q) => q.eq("roundId", round._id))
        .unique();
      if (!config?.policy.enabled || Date.now() >= round.endsAt) continue;
      const teams = await ctx.db
        .query("teams")
        .withIndex("by_event_status", (q) => q.eq("eventId", round.eventId))
        .filter(q => q.and(q.neq(q.field("competitionCategory"), "oc"), q.or(q.eq(q.field("status"), "confirmed"), q.eq(q.field("status"), "checked_in"), q.eq(q.field("status"), "active"))))
        .take(maximumReviewTeamsPerEvent + 1);
      if (teams.length > maximumReviewTeamsPerEvent)
        throw new Error("Team limit exceeded.");
      for (const team of teams)
        if (
          team.lockedProjectVersionId
        )
          await ctx.scheduler.runAfter(
            0,
            internal.reviewQuestions.refreshTeam,
            {
              roundId: round._id,
              teamId: team._id,
            },
          );
    }
    if (!rounds.isDone)
      await ctx.scheduler.runAfter(0, internal.reviewQuestions.dispatch, {
        ...args,
        cursor: rounds.continueCursor,
      });
    return null;
  },
});
export const refreshTeam = internalMutation({
  args: { roundId: v.id("reviewRounds"), teamId: v.id("teams") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const [round, team, config, latest] = await Promise.all([
      ctx.db.get(args.roundId),
      ctx.db.get(args.teamId),
      ctx.db
        .query("reviewQuestionPolicies")
        .withIndex("by_round", (q) => q.eq("roundId", args.roundId))
        .unique(),
      ctx.db
        .query("reviewQuestionSets")
        .withIndex("by_round_team_created", (q) =>
          q.eq("roundId", args.roundId).eq("teamId", args.teamId),
        )
        .order("desc")
        .first(),
    ]);
    if (
      !round ||
      !team ||
      round.eventId !== team.eventId ||
      team.competitionCategory === "oc" ||
      !team.lockedProjectVersionId ||
      !config?.policy.enabled ||
      !["published", "open"].includes(round.status) ||
      Date.now() >= round.endsAt
    )
      return null;
    if (
      latest &&
      latest.policyVersion === config.version &&
      Date.now() <
        (latest.lastSourceCheckAt ?? latest.createdAt) +
          config.policy.refreshSeconds * 1000
    )
      return null;
    const jobId = await prepareQuestionSet(ctx, round, team);
    if (jobId) await ctx.db.patch(jobId, { lastSourceCheckAt: Date.now() });
    return null;
  },
});
export async function questionJobAuthorized(
  ctx: QueryCtx | MutationCtx,
  job: Doc<"reviewQuestionSets">,
) {
  const [actor, config, pinned, round] = await Promise.all([
    ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (q) =>
        q.eq("eventId", job.eventId).eq("personId", job.operatorPersonId),
      )
      .unique(),
    ctx.db
      .query("reviewQuestionPolicies")
      .withIndex("by_round", (q) => q.eq("roundId", job.roundId))
      .unique(),
    ctx.db
      .query("reviewSessions")
      .withIndex("by_question_set", (q) => q.eq("questionSetId", job._id))
      .first(),
    ctx.db.get(job.roundId),
  ]);
  if (!actor || actor.status !== "active" || !config?.policy.enabled || !round)
    return false;
  if (
    !pinned &&
    (config.version !== job.policyVersion ||
      !["published", "open"].includes(round.status) ||
      Date.now() >= round.endsAt)
  )
    return false;
  return (
    (
      await matchingPermissionGrantIds(ctx, {
        eventId: job.eventId,
        eventAccessSubjectId: actor._id,
        permissionKey: "operations.intelligence.generate",
        scopeType: "event",
      })
    ).length > 0
  );
}
export function questionLeaseCurrent(job: Doc<"reviewQuestionSets">) {
  return job.leaseExpiresAt !== undefined && job.leaseExpiresAt > Date.now();
}
export const claim = internalMutation({
  args: { jobId: v.id("reviewQuestionSets") },
  returns: v.union(
    v.null(),
    v.object({ attempt: v.number(), timeoutSeconds: v.number() }),
  ),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (
      !job ||
      job.state !== "queued" ||
      job.attempt >= job.policy.maximumAttempts
    )
      return null;
    if (!(await questionJobAuthorized(ctx, job))) {
      await ctx.db.patch(job._id, { state: "stale", updatedAt: Date.now() });
      return null;
    }
    const attempt = job.attempt + 1;
    const now = Date.now();
    const leaseExpiresAt = now + job.policy.preparationTimeoutSeconds * 1000;
    await ctx.db.patch(job._id, {
      state: "collecting",
      attempt,
      leaseExpiresAt,
      failureCode: undefined,
      collectionComplete: false,
      analysisLevel: 0,
      analysisSummary: undefined,
      coverage: {
        discovered: 0,
        captured: 0,
        excluded: 0,
        unavailable: 0,
        chunks: 0,
        analysedChunks: 0,
        cachedBatches: 0,
      },
      requestJson: undefined,
      payloadChecksum: undefined,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(leaseExpiresAt, internal.reviewQuestions.expire, {
      jobId: job._id,
      attempt,
    });
    return { attempt, timeoutSeconds: job.policy.preparationTimeoutSeconds };
  },
});
export const expire = internalMutation({
  args: { jobId: v.id("reviewQuestionSets"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (
      job &&
      job.attempt === args.attempt &&
      ["collecting", "generating"].includes(job.state) &&
      job.leaseExpiresAt !== undefined &&
      job.leaseExpiresAt <= Date.now()
    )
      await ctx.db.patch(job._id, {
        state: "failed",
        failureCode: "preparation_timeout",
        updatedAt: Date.now(),
      });
    return null;
  },
});
export const fail = internalMutation({
  args: {
    jobId: v.id("reviewQuestionSets"),
    attempt: v.number(),
    failureCode: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (
      job &&
      job.attempt === args.attempt &&
      ["collecting", "generating"].includes(job.state)
    )
      await ctx.db.patch(job._id, {
        state: "failed",
        failureCode: args.failureCode.slice(0, 80),
        updatedAt: Date.now(),
      });
    return null;
  },
});
export const storeRequest = internalMutation({
  args: {
    jobId: v.id("reviewQuestionSets"),
    attempt: v.number(),
    analysisPartId: v.id("reviewQuestionParts"),
    requestJson: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.attempt !== args.attempt || job.state !== "collecting")
      return false;
    if (!questionLeaseCurrent(job) || !(await questionJobAuthorized(ctx, job)))
      return false;
    const part = await ctx.db.get(args.analysisPartId);
    if (
      !job.collectionComplete ||
      !job.coverage ||
      job.coverage.analysedChunks !== job.coverage.chunks ||
      !part ||
      part.jobId !== job._id ||
      part.attempt !== job.attempt ||
      part.level !== job.analysisLevel ||
      part.state !== "ready" ||
      !part.analysis
    )
      return false;
    const outstanding = await Promise.all(
      (["queued", "generating"] as const).map((state) =>
        ctx.db
          .query("reviewQuestionParts")
          .withIndex("by_job_attempt_level_state", (q) =>
            q
              .eq("jobId", job._id)
              .eq("attempt", job.attempt)
              .eq("level", job.analysisLevel ?? 0)
              .eq("state", state),
          )
          .first(),
      ),
    );
    const ready = await ctx.db
      .query("reviewQuestionParts")
      .withIndex("by_job_attempt_level_state", (q) =>
        q
          .eq("jobId", job._id)
          .eq("attempt", job.attempt)
          .eq("level", job.analysisLevel ?? 0)
          .eq("state", "ready"),
      )
      .take(2);
    if (
      outstanding.some(Boolean) ||
      ready.length !== 1 ||
      ready[0]?._id !== part._id
    )
      return false;
    if (new TextEncoder().encode(args.requestJson).byteLength > 700 * 1024)
      throw new Error("Question request exceeds the evidence size limit.");
    const input = reviewQuestionRequestSchema.parse(
      JSON.parse(args.requestJson),
    );
    if (
      input.stage !== "questions" ||
      input.partId !== "final" ||
      input.partAttempt !== 1 ||
      input.jobId !== job._id ||
      input.attempt !== job.attempt ||
      input.sourceChecksum !== job.sourceChecksum ||
      input.model !== job.policy.model ||
      input.maximumQuestions !== job.policy.maximumQuestions ||
      input.sources.reduce((total, s) => total + s.text.length, 0) >
        job.policy.batchCharacters
    )
      throw new Error("Invalid frozen question request.");
    const { payloadChecksum, ...body } = input;
    if (payloadChecksum !== questionPayloadChecksum(body))
      throw new Error("Question payload checksum mismatch.");
    await ctx.db.patch(job._id, {
      state: "generating",
      analysisSummary: part.analysis.summary,
      requestJson: args.requestJson,
      payloadChecksum,
      sources: input.references.map((source) => ({
        id: source.id,
        kind: source.kind,
        title: source.title,
        coverage: source.coverage,
        ...(source.url ? { url: source.url } : {}),
      })),
      updatedAt: Date.now(),
    });
    return true;
  },
});
export const request = internalQuery({
  args: { jobId: v.id("reviewQuestionSets"), attempt: v.number() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    return job?.state === "generating" &&
      job.attempt === args.attempt &&
      questionLeaseCurrent(job) &&
      (await questionJobAuthorized(ctx, job))
      ? (job.requestJson ?? null)
      : null;
  },
});
export const settle = internalMutation({
  args: { body: v.string() },
  returns: v.union(
    v.literal("accepted"),
    v.literal("already_settled"),
    v.literal("stale"),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<"accepted" | "already_settled" | "stale"> => {
    const result = reviewQuestionCallbackSchema.parse(JSON.parse(args.body));
    if (result.partId !== "final")
      return await ctx.runMutation(internal.reviewQuestionParts.settle, args);
    if (result.partAttempt !== 1 || result.status === "analysed")
      throw new Error("Invalid final question callback.");
    const jobId = ctx.db.normalizeId("reviewQuestionSets", result.jobId);
    const job = jobId ? await ctx.db.get(jobId) : null;
    if (
      !job ||
      job.attempt !== result.attempt ||
      job.sourceChecksum !== result.sourceChecksum ||
      job.payloadChecksum !== result.payloadChecksum
    )
      return "stale";
    if (job.state === "ready" || job.state === "failed")
      return "already_settled";
    if (job.state !== "generating" || !job.requestJson) return "stale";
    if (!questionLeaseCurrent(job)) {
      await ctx.db.patch(job._id, {
        state: "failed",
        failureCode: "preparation_timeout",
        updatedAt: Date.now(),
      });
      return "stale";
    }
    if (!(await questionJobAuthorized(ctx, job))) {
      await ctx.db.patch(job._id, { state: "stale", updatedAt: Date.now() });
      return "stale";
    }
    const pinned = await ctx.db
      .query("reviewSessions")
      .withIndex("by_question_set", (q) => q.eq("questionSetId", job._id))
      .first();
    if (!pinned) {
      const [round, team, policy] = await Promise.all([
        ctx.db.get(job.roundId),
        ctx.db.get(job.teamId),
        ctx.db
          .query("reviewQuestionPolicies")
          .withIndex("by_round", (q) => q.eq("roundId", job.roundId))
          .unique(),
      ]);
      if (
        !round ||
        !team ||
        !policy?.policy.enabled ||
        policy.version !== job.policyVersion ||
        (
          await buildEvidenceCheckpoint(ctx, {
            eventId: job.eventId,
            round,
            team,
            actorPersonId: job.operatorPersonId,
            createdAt: Date.now(),
          })
        ).checksum !== job.sourceChecksum
      ) {
        await ctx.db.patch(job._id, { state: "stale", updatedAt: Date.now() });
        return "stale";
      }
    }
    if (result.status === "ready") {
      const input = reviewQuestionRequestSchema.parse(
        JSON.parse(job.requestJson),
      );
      const sources = new Set(input.references.map((source) => source.id));
      const criteria = new Set(
        input.criteria.map((criterion) => criterion.key),
      );
      if (
        result.questions.length > input.maximumQuestions ||
        result.questions.some(
          (question) =>
            !criteria.has(question.criterionKey) ||
            question.sourceIds.some((id) => !sources.has(id)),
        ) ||
        new Set(
          result.questions.map((question) => question.question.toLowerCase()),
        ).size !== result.questions.length
      )
        throw new ConvexError({
          code: "INVALID_SUGGESTED_QUESTIONS",
          message: "The suggested questions do not match their frozen sources.",
        });
      await ctx.db.patch(job._id, {
        state: "ready",
        questions: result.questions,
        completedAt: Date.now(),
        updatedAt: Date.now(),
      });
    } else
      await ctx.db.patch(job._id, {
        state: "failed",
        failureCode: result.failureCode,
        updatedAt: Date.now(),
      });
    return "accepted";
  },
});
export const forReview = query({
  args: { eventSlug: v.string(), reviewSessionId: v.id("reviewSessions") },
  returns: v.union(
    v.null(),
    v.object({
      state: v.string(),
      preparedAt: v.optional(v.number()),
      summary: v.optional(v.string()),
      coverage: v.optional(reviewEvidenceCoverage),
      questions: v.array(reviewSuggestedQuestion),
      sources: v.array(
        v.object({
          id: v.string(),
          title: v.string(),
          url: v.optional(v.string()),
          coverage: reviewQuestionSource.fields.coverage,
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const { session } = await fixedEvidenceContext(ctx, args);
    if (!session.questionSetId) return null;
    const job = await ctx.db.get(session.questionSetId);
    if (
      !job ||
      job.teamId !== session.teamId ||
      job.roundId !== session.roundId
    )
      throw new Error("Question checkpoint mismatch.");
    return {
      state: job.state,
      ...(job.analysisSummary ? { summary: job.analysisSummary } : {}),
      ...(job.coverage ? { coverage: job.coverage } : {}),
      ...(job.completedAt ? { preparedAt: job.completedAt } : {}),
      questions: job.questions ?? [],
      sources: (job.sources ?? []).map((source) => ({
        id: source.id,
        title: source.title,
        coverage: source.coverage,
        ...(source.url ? { url: source.url } : {}),
      })),
    };
  },
});

const githubAccess = v.object({
  installationId: v.string(),
  repositoryId: v.string(),
  owner: v.string(),
  name: v.string(),
  headSha: v.string(),
  rootPath: v.optional(v.string()),
});
const artifactAccess = v.object({
  objectKey: v.string(),
  storageRegion: v.string(),
  storageBucket: v.string(),
  storedBytes: v.number(),
  uncompressedBytes: v.number(),
  sha256: v.string(),
});
export const sourceContext = internalQuery({
  args: { jobId: v.id("reviewQuestionSets"), attempt: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      sourceChecksum: v.string(),
      policy: reviewQuestionPolicy,
      projectText: v.string(),
      checkpointText: v.string(),
      criteria: v.array(
        v.object({
          key: v.string(),
          label: v.string(),
          question: v.string(),
          guidance: v.string(),
        }),
      ),
      github: v.array(
        v.object({
          id: v.string(),
          title: v.string(),
          url: v.string(),
          metadata: v.string(),
          access: v.optional(githubAccess),
        }),
      ),
      figma: v.array(
        v.object({
          id: v.string(),
          title: v.string(),
          url: v.string(),
          metadata: v.string(),
          artifact: v.optional(artifactAccess),
          previews: v.array(v.object({
            factId: v.id("figmaNodeFacts"), nodeId: v.string(), nodeName: v.string(),
            objectKey: v.string(), storageRegion: v.string(), storageBucket: v.string(),
            byteCount: v.number(), sha256: v.string(),
          })),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (
      !job ||
      !["collecting", "generating"].includes(job.state) ||
      job.attempt !== args.attempt ||
      !questionLeaseCurrent(job) ||
      !(await questionJobAuthorized(ctx, job))
    )
      return null;
    const [project, round, checkpoint, previous] = await Promise.all([
      ctx.db.get(job.snapshot.projectVersionId),
      ctx.db.get(job.roundId),
      job.snapshot.teamCheckpointSubmissionId
        ? ctx.db.get(job.snapshot.teamCheckpointSubmissionId)
        : null,
      job.snapshot.previousCheckpointSetId
        ? ctx.db.get(job.snapshot.previousCheckpointSetId)
        : null,
    ]);
    if (
      !project ||
      !round ||
      project.eventId !== job.eventId ||
      project.teamId !== job.teamId
    )
      return null;
    const previousUpdate = previous?.teamCheckpointSubmissionId
      ? await ctx.db.get(previous.teamCheckpointSubmissionId)
      : null;
    const criteria = await ctx.db
      .query("reviewRubricCriteria")
      .withIndex("by_rubric_order", (q) =>
        q.eq("rubricVersionId", round.rubricVersionId),
      )
      .take(21);
    if (criteria.length > 20) throw new Error("Criterion limit exceeded.");
    return {
      sourceChecksum: job.sourceChecksum,
      policy: job.policy,
      projectText: JSON.stringify({
        idea: project.initialIdea,
        responses: project.intakeResponses.map((response) => ({
          question: response.question,
          answer: response.answer,
        })),
        additionalInformation: project.additionalInformation ?? "",
      }),
      checkpointText: JSON.stringify({
        current: checkpoint
          ? {
              update: checkpoint.updateText,
              question: checkpoint.followUpQuestion,
              answer: checkpoint.followUpAnswer,
            }
          : null,
        previousReviewUpdate: previousUpdate
          ? {
              update: previousUpdate.updateText,
              answer: previousUpdate.followUpAnswer,
            }
          : null,
      }),
      criteria: criteria.map((criterion) => ({
        key: criterion.stableKey,
        label: criterion.label,
        question: criterion.question,
        guidance: criterion.guidance,
      })),
      github: await Promise.all(
        job.snapshot.githubEntries.map(async (entry) => {
          const [binding, snapshot] = await Promise.all([
            ctx.db.get(entry.bindingId),
            entry.snapshotId ? ctx.db.get(entry.snapshotId) : null,
          ]);
          const connection = binding
            ? await ctx.db.get(binding.installationConnectionId)
            : null;
          const readable =
            binding &&
            binding.eventId === job.eventId &&
            binding.teamId === job.teamId &&
            binding.state !== "archived" &&
            snapshot &&
            snapshot.repositoryBindingId === binding._id &&
            connection?.state === "active" &&
            connection.eventId === job.eventId &&
            connection.teamId === job.teamId;
          return {
            id: `github:${entry.bindingId}`,
            title: entry.repositoryName,
            url: entry.repositoryUrl,
            metadata: JSON.stringify({
              purpose: entry.purpose,
              kind: entry.kind,
              headSha: snapshot?.headSha ?? null,
              languages: snapshot?.languageBytes ?? [],
              coverage: snapshot?.completeness ?? "missing",
              capturedAt: snapshot?.capturedAt ?? null,
              previousReviewSnapshot:
                previous?.githubEntries.find(
                  (row) => row.bindingId === entry.bindingId,
                )?.snapshotId ?? null,
            }),
            ...(readable
              ? {
                  access: {
                    installationId: connection.installationId,
                    repositoryId: binding.repositoryId,
                    owner: binding.owner,
                    name: binding.name,
                    headSha: snapshot.headSha,
                    ...(entry.rootPath ? { rootPath: entry.rootPath } : {}),
                  },
                }
              : {}),
          };
        }),
      ),
      figma: await Promise.all(
        job.snapshot.figmaEntries.map(async (entry) => {
          const [binding, snapshot] = await Promise.all([
            ctx.db.get(entry.bindingId),
            entry.snapshotId ? ctx.db.get(entry.snapshotId) : null,
          ]);
          const artifact = snapshot?.artifactId
            ? await ctx.db.get(snapshot.artifactId)
            : null;
          const readable =
            binding &&
            binding.eventId === job.eventId &&
            binding.teamId === job.teamId &&
            binding.state !== "archived" &&
            snapshot?.figmaFileBindingId === binding._id &&
            artifact?.state === "available" &&
            artifact.provider === "figma" &&
            artifact.eventId === job.eventId &&
            artifact.teamId === job.teamId &&
            artifact.figmaFileBindingId === binding._id &&
            artifact.providerVersionId === snapshot.providerVersionId;
          const previews = readable && job.policy.visualAnalysis
            ? (await Promise.all((entry.preview?.renders ?? []).map(async (captured) => {
                const fact = await ctx.db.get(captured.factId);
                return fact && fact.eventId === job.eventId && fact.teamId === job.teamId &&
                  fact.snapshotId === snapshot._id && fact.figmaFileBindingId === binding._id &&
                  fact.providerVersionId === snapshot.providerVersionId &&
                  fact.render.state === "available" && fact.render.sha256 === captured.sha256
                  ? { factId: fact._id, nodeId: fact.nodeId, nodeName: fact.nodeName,
                      objectKey: fact.render.objectKey, storageRegion: fact.render.storageRegion,
                      storageBucket: fact.render.storageBucket, byteCount: fact.render.byteCount,
                      sha256: fact.render.sha256 }
                  : null;
              }))).filter((fact) => fact !== null)
            : [];
          return {
            previews,
            id: `figma:${entry.bindingId}`,
            title: entry.fileName,
            url: entry.fileUrl,
            metadata: JSON.stringify({
              role: entry.role,
              version: snapshot?.providerVersionId ?? null,
              frames: snapshot?.frameCount ?? null,
              components: snapshot?.componentCount ?? null,
              prototypeInteractions:
                snapshot?.prototypeInteractionCount ?? null,
              coverage: snapshot?.completeness ?? "missing",
              capturedAt: snapshot?.capturedAt ?? null,
              visualAnalysis: job.policy.visualAnalysis,
              previewCoverage: entry.preview ? {
                state: entry.preview.state, discoveredNodes: entry.preview.discoveredNodes,
                selectedNodes: entry.preview.selectedNodes, truncated: entry.preview.truncated,
                capturedRenders: entry.preview.renders.length, accessibleRenders: previews.length,
              } : "No captured renders available",
            }),
            ...(readable
              ? {
                  artifact: {
                    objectKey: artifact.objectKey,
                    storageRegion: artifact.storageRegion,
                    storageBucket: artifact.storageBucket,
                    storedBytes: artifact.storedBytes,
                    uncompressedBytes: artifact.uncompressedBytes,
                    sha256: artifact.sha256,
                  },
                }
              : {}),
          };
        }),
      ),
    };
  },
});
