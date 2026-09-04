import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import {
  shortlistAuditSchema,
  shortlistCandidateInputSchema,
  shortlistPairSchema,
  shortlistProfileSchema,
  shortlistSuggestionSchema,
  shortlistSummarySchema,
  shortlistTaskSchema,
  shortlistVersion,
  validateShortlistPair,
  validateShortlistProfile,
} from "@code2create/domain";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { requireEventBySlug } from "./lib/events";
import { requirePermission } from "./lib/permissions";
import { admissionGuidanceForBand } from "./lib/admission";
import { createAdmissionRecommendation } from "./lib/admissionRecommendation";
import { redactProjectText } from "./lib/projectText";
import { writeAuditEvent } from "./lib/audit";
import { admissionWorkpool, intelligenceWorkpool } from "./workpools";
import { maximumApplicantTeamsPerEvent } from "./lib/reviewLimits";

async function authorize(
  ctx: QueryCtx | MutationCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
  write = false,
) {
  const subject = await requireEventSubject(ctx, eventId, personId);
  const keys = [
    "application.read",
    "application.profile_context.read",
    "application.ai_recommendation.read",
    ...(write ? ["application.ai_recommendation.run" as const] : []),
  ] as const;
  const grants: Id<"permissionGrants">[] = [];
  for (const permissionKey of keys)
    grants.push(
      ...(await requirePermission(ctx, {
        eventId,
        eventAccessSubjectId: subject._id,
        permissionKey,
        scopeType: "event",
      })),
    );
  return grants;
}
async function requireRun(
  ctx: QueryCtx | MutationCtx,
  runId: Id<"admissionShortlistRuns">,
) {
  const run = await ctx.db.get(runId);
  if (!run) throw new ConvexError("Shortlist run not found");
  return run;
}
async function enqueueAdvance(
  ctx: MutationCtx,
  runId: Id<"admissionShortlistRuns">,
) {
  await intelligenceWorkpool.enqueueAction(
    ctx,
    internal.admissionShortlistActions.advance,
    { runId },
    { retry: true },
  );
}

export const start = mutation({
  args: {
    eventSlug: v.string(),
    acceptPeople: v.number(),
    waitlistPeople: v.number(),
    operationId: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"admissionShortlistRuns">> => {
    const { person } = await requireCurrentPerson(ctx);
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const grants = await authorize(ctx, event._id, person._id, true);
    if (
      ![args.acceptPeople, args.waitlistPeople].every(
        (n) => Number.isSafeInteger(n) && n >= 0 && n <= 100000,
      ) ||
      args.acceptPeople === 0 ||
      args.operationId.length < 8 ||
      args.operationId.length > 100
    )
      throw new ConvexError("Invalid shortlist targets or operation ID");
    const prior = await ctx.db
      .query("admissionShortlistRuns")
      .withIndex("by_actorPersonId_and_operationId", (q) =>
        q.eq("actorPersonId", person._id).eq("operationId", args.operationId),
      )
      .unique();
    if (prior) {
      if (
        prior.eventId !== event._id ||
        prior.acceptPeople !== args.acceptPeople ||
        prior.waitlistPeople !== args.waitlistPeople
      )
        throw new ConvexError(
          "Operation ID was already used for different targets",
        );
      return prior._id;
    }
    if (
      !event.publishedAdmissionPolicyId ||
      !event.publishedAdmissionModelConfigId
    )
      throw new ConvexError(
        "Publish admissions policy and model configuration first",
      );
    const policy = await ctx.db.get(event.publishedAdmissionPolicyId);
    const model = await ctx.db.get(event.publishedAdmissionModelConfigId);
    if (
      !policy ||
      !model ||
      policy.eventId !== event._id ||
      model.admissionPolicyVersionId !== policy._id ||
      policy.status !== "published" ||
      model.status !== "published" ||
      policy.aiRecommendationMode !== "enabled"
    )
      throw new ConvexError("Published admission analysis is unavailable");
    const applications = await ctx.db
      .query("applications")
      .withIndex("by_event_submitted", (q) => q.eq("eventId", event._id))
      .take(maximumApplicantTeamsPerEvent + 1);
    if (applications.length > maximumApplicantTeamsPerEvent)
      throw new ConvexError("Applicant pool exceeds the supported event limit");
    const pool = applications.filter(
      (a) =>
        (["submitted", "under_review"].includes(a.state) && !a.humanDecision) ||
        ["accepted", "offer_sent", "confirmed"].includes(a.state) ||
        a.humanDecision === "accept",
    );
    const runId = await ctx.db.insert("admissionShortlistRuns", {
      eventId: event._id,
      actorPersonId: person._id,
      operationId: args.operationId,
      policyId: policy._id,
      modelConfigId: model._id,
      releaseVersion: shortlistVersion,
      acceptPeople: args.acceptPeople,
      waitlistPeople: args.waitlistPeople,
      remainingCapacity: policy.overallParticipantCapacity,
      committedPeople: 0,
      state: "preparing",
      candidateCount: 0,
      pendingJobs: 0,
      failedJobs: 0,
      preparationDone: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    for (const a of pool)
      await ctx.db.insert("admissionShortlistCandidates", {
        runId,
        applicationId: a._id,
        applicationVersion: a.version,
        contentVersion: a.contentVersion,
        projectVersionId: a.submittedProjectVersionId,
        ...(a.aiRecommendationId
          ? { recommendationId: a.aiRecommendationId }
          : {}),
        committed:
          a.humanDecision === "accept" ||
          ["accepted", "offer_sent", "confirmed"].includes(a.state),
        teamName: "",
        teamSize: 0,
      });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "application.ai_recommendation.run",
      grantIds: grants,
      scopeType: "event",
      scopeId: event._id,
      action: "admission_shortlist.started",
      targetType: "admissionShortlistRuns",
      targetId: runId,
      nextSummary: `Advisory shortlist: ${args.acceptPeople} accept / ${args.waitlistPeople} waitlist people`,
      reason:
        "Operator requested a frozen advisory shortlist; no decisions changed.",
    });
    await enqueueAdvance(ctx, runId);
    return runId;
  },
});

export const latest = query({
  args: { eventSlug: v.string() },
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    await authorize(ctx, event._id, person._id);
    return ctx.db
      .query("admissionShortlistRuns")
      .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
      .order("desc")
      .first();
  },
});
export const results = query({
  args: {
    runId: v.id("admissionShortlistRuns"),
    paginationOpts: paginationOptsValidator,
    suggestion: v.optional(
      v.union(
        v.literal("accept"),
        v.literal("waitlist"),
        v.literal("reject"),
        v.literal("unresolved"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const run = await requireRun(ctx, args.runId);
    await authorize(
      ctx,
      run.eventId,
      (await requireCurrentPerson(ctx)).person._id,
    );
    const candidates = ctx.db.query("admissionShortlistCandidates");
    const page = await (
      args.suggestion
        ? candidates.withIndex("by_runId_and_suggestion", (q) =>
            q.eq("runId", run._id).eq("suggestion", args.suggestion),
          )
        : candidates.withIndex("by_runId", (q) => q.eq("runId", run._id))
    ).paginate(args.paginationOpts);
    const event = await ctx.db.get(run.eventId);
    const policyChanged =
      event?.publishedAdmissionPolicyId !== run.policyId ||
      event?.publishedAdmissionModelConfigId !== run.modelConfigId;
    return {
      ...page,
      page: await Promise.all(
        page.page.map(async (item) => {
          const application = await ctx.db.get(item.applicationId);
          const stale =
            policyChanged ||
            !application ||
            application.contentVersion !== item.contentVersion ||
            application.submittedProjectVersionId !== item.projectVersionId ||
            (application.humanDecision !== undefined && !item.committed) ||
            application.aiRecommendationId !== item.recommendationId;
          const { embedding: _embedding, ...visible } = item;
          return { ...visible, stale };
        }),
      ),
    };
  },
});
export const comparisons = query({
  args: {
    runId: v.id("admissionShortlistRuns"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const run = await requireRun(ctx, args.runId);
    await authorize(
      ctx,
      run.eventId,
      (await requireCurrentPerson(ctx)).person._id,
    );
    return ctx.db
      .query("admissionShortlistJobs")
      .withIndex("by_runId_and_key", (q) =>
        q.eq("runId", run._id).gte("key", "pair:").lt("key", "pair;"),
      )
      .paginate(args.paginationOpts);
  },
});

export const retry = mutation({
  args: { runId: v.id("admissionShortlistRuns") },
  handler: async (ctx, args) => {
    const run = await requireRun(ctx, args.runId);
    await authorize(
      ctx,
      run.eventId,
      (await requireCurrentPerson(ctx)).person._id,
      true,
    );
    if (run.state === "stale")
      throw new ConvexError("Start a new snapshot for changed sources");
    if (!["waiting", "failed"].includes(run.state)) return;
    if (run.failedJobs) {
      await ctx.db.patch(run._id, {
        state: "retrying",
        preparationDone: false,
        error: undefined,
      });
      await intelligenceWorkpool.enqueueAction(
        ctx,
        internal.admissionShortlistActions.retryJobs,
        { runId: run._id },
        { retry: true },
      );
    } else {
      await ctx.db.patch(run._id, { state: "preparing", error: undefined });
      await enqueueAdvance(ctx, run._id);
    }
  },
});

export const retryJobBatch = internalMutation({
  args: {
    runId: v.id("admissionShortlistRuns"),
    jobs: v.array(
      v.object({ jobId: v.id("admissionShortlistJobs"), attempt: v.number() }),
    ),
  },
  handler: async (ctx, args) => {
    if (args.jobs.length > 25) throw new Error("Retry batch is too large");
    const run = await requireRun(ctx, args.runId);
    if (run.state !== "retrying") return;
    await authorize(ctx, run.eventId, run.actorPersonId, true);
    let count = 0;
    for (const expected of args.jobs) {
      const job = await ctx.db.get(expected.jobId);
      if (!job || job.runId !== run._id)
        throw new Error("Invalid retry job identity");
      if (job.state !== "failed" || job.attempt !== expected.attempt) continue;
      await ctx.db.patch(job._id, {
        state: "pending",
        attempt: job.attempt + 1,
      });
      await admissionWorkpool.enqueueAction(
        ctx,
        internal.admissionShortlistActions.dispatchJob,
        { jobId: job._id, attempt: job.attempt + 1 },
        { retry: false },
      );
      count++;
    }
    await ctx.db.patch(run._id, {
      pendingJobs: run.pendingJobs + count,
      failedJobs: run.failedJobs - count,
    });
  },
});

export const finishRetry = internalMutation({
  args: { runId: v.id("admissionShortlistRuns") },
  handler: async (ctx, args) => {
    const run = await requireRun(ctx, args.runId);
    if (run.state !== "retrying") return;
    await ctx.db.patch(run._id, {
      state: run.failedJobs ? "failed" : "profiling",
      preparationDone: true,
    });
    if (!run.failedJobs && !run.pendingJobs) await enqueueAdvance(ctx, run._id);
  },
});

export const readRun = internalQuery({
  args: { runId: v.id("admissionShortlistRuns") },
  handler: async (ctx, args) => requireRun(ctx, args.runId),
});
export const latestForEvent = internalQuery({
  args: { eventId: v.id("events") },
  handler: async (ctx, args) =>
    ctx.db
      .query("admissionShortlistRuns")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .order("desc")
      .first(),
});
export const candidatePage = internalQuery({
  args: {
    runId: v.id("admissionShortlistRuns"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) =>
    ctx.db
      .query("admissionShortlistCandidates")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .paginate(args.paginationOpts),
});
export const jobPage = internalQuery({
  args: {
    runId: v.id("admissionShortlistRuns"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) =>
    ctx.db
      .query("admissionShortlistJobs")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .paginate(args.paginationOpts),
});
export const readJob = internalQuery({
  args: { jobId: v.id("admissionShortlistJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.state !== "pending") return null;
    const run = await requireRun(ctx, job.runId);
    if (["stale", "complete"].includes(run.state)) return null;
    if (run.releaseVersion !== shortlistVersion)
      throw new Error("Shortlist release changed; create a new snapshot");
    await authorize(ctx, run.eventId, run.actorPersonId, true);
    const model = await ctx.db.get(run.modelConfigId);
    if (!model) throw new Error("Missing frozen shortlist model");
    return { job, modelId: model.modelId };
  },
});

export const hydrate = internalMutation({
  args: { candidateId: v.id("admissionShortlistCandidates") },
  handler: async (ctx, args): Promise<boolean> => {
    const item = await ctx.db.get(args.candidateId);
    if (!item) throw new Error("Missing shortlist candidate");
    const run = await requireRun(ctx, item.runId);
    await authorize(ctx, run.eventId, run.actorPersonId, true);
    const application = await ctx.db.get(item.applicationId);
    const project = await ctx.db.get(item.projectVersionId);
    const event = await ctx.db.get(run.eventId);
    if (
      run.releaseVersion !== shortlistVersion ||
      !application ||
      !project ||
      application.contentVersion !== item.contentVersion ||
      application.submittedProjectVersionId !== item.projectVersionId ||
      event?.publishedAdmissionPolicyId !== run.policyId ||
      event?.publishedAdmissionModelConfigId !== run.modelConfigId ||
      (!item.committed && application.humanDecision !== undefined)
    ) {
      await ctx.db.patch(run._id, {
        state: "stale",
        error: "Sources changed; start a new snapshot.",
      });
      return false;
    }
    const team = await ctx.db.get(application.teamId);
    await ctx.db.patch(item._id, {
      teamSize: project.lockedMemberCount,
      teamName: team?.name ?? "Team",
    });
    if (
      (item.committed && application.version !== item.applicationVersion) ||
      (item.inputJson &&
        application.aiRecommendationId !== item.recommendationId)
    ) {
      await ctx.db.patch(run._id, {
        state: "stale",
        error: "A frozen decision or assessment changed.",
      });
      return false;
    }
    if (item.committed || item.inputJson) return true;
    const policy = await ctx.db.get(run.policyId);
    const model = await ctx.db.get(run.modelConfigId);
    if (!policy || !model) throw new Error("Missing frozen shortlist policy");
    const recommendation = application.aiRecommendationId
      ? await ctx.db.get(application.aiRecommendationId)
      : null;
    if (
      !recommendation ||
      recommendation.applicationContentVersion !== item.contentVersion ||
      recommendation.modelConfigVersionId !== run.modelConfigId
    ) {
      const id = await createAdmissionRecommendation(ctx, {
        application,
        project,
        policy,
        modelConfig: model,
        now: Date.now(),
      });
      await ctx.db.patch(item._id, { recommendationId: id });
      return false;
    }
    if (recommendation.state !== "succeeded" || !recommendation.recommendation)
      return false;
    const sources = [
      {
        sourceRef: "initial_idea",
        question: "Initial idea",
        answer: redactProjectText(project.initialIdea),
      },
      ...(project.intakeResponses ?? []).map((r) => ({
        sourceRef: `follow_up_${r.ordinal}`,
        question: redactProjectText(r.question),
        answer: redactProjectText(r.answer),
      })),
      ...(project.additionalInformation
        ? [
            {
              sourceRef: "additional_information",
              question: "Additional information",
              answer: redactProjectText(project.additionalInformation),
            },
          ]
        : []),
    ];
    const input = shortlistCandidateInputSchema.parse({
      applicationId: application._id,
      teamSize: project.lockedMemberCount,
      experienceBand: application.experienceBand,
      sources,
      criteria: policy.criteria.map((c) => ({
        criterionKey: c.criterionKey,
        label: c.label,
        guidance: admissionGuidanceForBand(
          c.guidanceByBand,
          application.experienceBand,
        ),
      })),
      quality: recommendation.recommendation,
    });
    await ctx.db.patch(item._id, {
      inputJson: JSON.stringify(input),
      recommendationId: recommendation._id,
    });
    return true;
  },
});

export const createJob = internalMutation({
  args: {
    runId: v.id("admissionShortlistRuns"),
    key: v.string(),
    inputJson: v.string(),
  },
  handler: async (ctx, args) => {
    const run = await requireRun(ctx, args.runId);
    if (["complete", "stale", "failed"].includes(run.state)) return;
    if (run.releaseVersion !== shortlistVersion) {
      await ctx.db.patch(run._id, {
        state: "stale",
        error: "Shortlist release changed; create a new snapshot.",
      });
      return;
    }
    if (args.inputJson.length > 180000)
      throw new Error("Shortlist task exceeds the bounded payload limit");
    const task = shortlistTaskSchema.parse(JSON.parse(args.inputJson));
    const prior = await ctx.db
      .query("admissionShortlistJobs")
      .withIndex("by_runId_and_key", (q) =>
        q.eq("runId", run._id).eq("key", args.key),
      )
      .unique();
    if (prior) {
      if (prior.inputJson !== args.inputJson)
        throw new Error("Shortlist task changed");
      return;
    }
    if (task.kind === "profile") {
      const candidate = await ctx.db
        .query("admissionShortlistCandidates")
        .withIndex("by_runId_and_applicationId", (q) =>
          q.eq("runId", run._id).eq(
            "applicationId",
            ctx.db.normalizeId("applications", task.candidate.applicationId) ??
              (() => {
                throw new Error("Invalid application identity");
              })(),
          ),
        )
        .unique();
      if (!candidate || candidate.inputJson !== JSON.stringify(task.candidate))
        throw new Error("Profile task is not frozen to this run");
    }
    const jobId = await ctx.db.insert("admissionShortlistJobs", {
      runId: run._id,
      key: args.key,
      inputJson: args.inputJson,
      state: "pending",
      attempt: 1,
    });
    await ctx.db.patch(run._id, { pendingJobs: run.pendingJobs + 1 });
    await admissionWorkpool.enqueueAction(
      ctx,
      internal.admissionShortlistActions.dispatchJob,
      { jobId, attempt: 1 },
      { retry: false },
    );
  },
});

export const setProgress = internalMutation({
  args: {
    runId: v.id("admissionShortlistRuns"),
    state: v.union(
      v.literal("waiting"),
      v.literal("profiling"),
      v.literal("comparing"),
      v.literal("auditing"),
      v.literal("failed"),
    ),
    preparationDone: v.boolean(),
    committedPeople: v.optional(v.number()),
    candidateCount: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await requireRun(ctx, args.runId);
    if (["complete", "stale"].includes(run.state)) return;
    if (run.releaseVersion !== shortlistVersion) {
      await ctx.db.patch(run._id, {
        state: "stale",
        error: "Shortlist release changed; create a new snapshot.",
      });
      return;
    }
    const { runId: _runId, ...patch } = args;
    const policy = await ctx.db.get(run.policyId);
    await ctx.db.patch(run._id, {
      ...patch,
      ...(args.committedPeople !== undefined
        ? {
            remainingCapacity: Math.max(
              0,
              (policy?.overallParticipantCapacity ?? 0) - args.committedPeople,
            ),
          }
        : {}),
      updatedAt: Date.now(),
    });
    if (
      args.preparationDone &&
      run.pendingJobs === 0 &&
      !["failed", "waiting"].includes(args.state)
    )
      await enqueueAdvance(ctx, run._id);
  },
});

export const settleJob = internalMutation({
  args: {
    jobId: v.string(),
    runId: v.string(),
    attempt: v.number(),
    resultJson: v.string(),
    embedding: v.array(v.number()),
  },
  handler: async (ctx, args) => {
    const jobId = ctx.db.normalizeId("admissionShortlistJobs", args.jobId);
    const runId = ctx.db.normalizeId("admissionShortlistRuns", args.runId);
    if (!jobId || !runId) throw new Error("Invalid shortlist identity");
    const job = await ctx.db.get(jobId);
    const run = await requireRun(ctx, runId);
    if (run.releaseVersion !== shortlistVersion) {
      await ctx.db.patch(run._id, {
        state: "stale",
        error: "Shortlist release changed; create a new snapshot.",
      });
      return;
    }
    if (!job || job.runId !== run._id || job.attempt !== args.attempt)
      throw new Error("Stale shortlist task");
    if (job.state === "succeeded") {
      if (job.resultJson !== args.resultJson)
        throw new Error("Conflicting shortlist result");
      return;
    }
    if (job.state !== "pending" || ["stale", "complete"].includes(run.state))
      throw new Error("Shortlist task is no longer current");
    await authorize(ctx, run.eventId, run.actorPersonId, true);
    const task = shortlistTaskSchema.parse(JSON.parse(job.inputJson));
    const json: unknown = JSON.parse(args.resultJson);
    if (task.kind === "profile") {
      const result = shortlistProfileSchema.parse(json);
      validateShortlistProfile(result, task.candidate);
      if (
        args.embedding.length !== 1536 ||
        args.embedding.some((n) => !Number.isFinite(n))
      )
        throw new Error("Invalid profile embedding");
      const id = ctx.db.normalizeId(
        "applications",
        task.candidate.applicationId,
      );
      if (!id) throw new Error("Invalid shortlist application");
      const candidate = await ctx.db
        .query("admissionShortlistCandidates")
        .withIndex("by_runId_and_applicationId", (q) =>
          q.eq("runId", run._id).eq("applicationId", id),
        )
        .unique();
      if (!candidate) throw new Error("Missing snapshot candidate");
      const current = await ctx.db.get(id);
      if (
        !current ||
        current.contentVersion !== candidate.contentVersion ||
        current.aiRecommendationId !== candidate.recommendationId ||
        current.humanDecision
      ) {
        await ctx.db.patch(run._id, {
          state: "stale",
          error: "Application changed during analysis.",
        });
        return;
      }
      await ctx.db.patch(candidate._id, {
        profileJson: JSON.stringify(result),
        embedding: args.embedding,
      });
    } else if (task.kind === "pair")
      validateShortlistPair(
        shortlistPairSchema.parse(json),
        task.left,
        task.right,
      );
    else {
      const result = shortlistAuditSchema.parse(json);
      const ids = new Set(task.candidates.map((c) => c.applicationId));
      if (
        result.warnings.some((w) => w.applicationIds.some((id) => !ids.has(id)))
      )
        throw new Error("Invalid audit reference");
    }
    await ctx.db.patch(job._id, {
      state: "succeeded",
      resultJson: args.resultJson,
    });
    await ctx.db.patch(run._id, {
      pendingJobs: run.pendingJobs - 1,
      updatedAt: Date.now(),
    });
    if (run.pendingJobs === 1 && run.preparationDone && run.failedJobs === 0)
      await enqueueAdvance(ctx, run._id);
  },
});

export const expireJob = internalMutation({
  args: { jobId: v.id("admissionShortlistJobs"), attempt: v.number() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.state !== "pending" || job.attempt !== args.attempt) return;
    const run = await requireRun(ctx, job.runId);
    if (["stale", "complete"].includes(run.state)) return;
    await ctx.db.patch(job._id, { state: "failed" });
    await ctx.db.patch(run._id, {
      state: run.state === "retrying" ? "retrying" : "failed",
      failedJobs: run.failedJobs + 1,
      pendingJobs: run.pendingJobs - 1,
      error:
        "A model task failed or timed out. Retry resumes the frozen run; no team was rejected for this failure.",
    });
  },
});

export const saveSuggestions = internalMutation({
  args: {
    runId: v.id("admissionShortlistRuns"),
    rows: v.array(
      v.object({
        applicationId: v.id("applications"),
        suggestion: v.union(
          v.literal("accept"),
          v.literal("waitlist"),
          v.literal("reject"),
          v.literal("unresolved"),
        ),
        resultJson: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    if (args.rows.length > 25)
      throw new Error("Shortlist write batch is too large");
    const run = await requireRun(ctx, args.runId);
    if (["stale", "failed", "complete"].includes(run.state)) return;
    for (const row of args.rows) {
      const result = shortlistSuggestionSchema.parse(
        JSON.parse(row.resultJson),
      );
      if (
        result.applicationId !== row.applicationId ||
        result.suggestion !== row.suggestion
      )
        throw new Error("Shortlist result identity mismatch");
      const item = await ctx.db
        .query("admissionShortlistCandidates")
        .withIndex("by_runId_and_applicationId", (q) =>
          q.eq("runId", run._id).eq("applicationId", row.applicationId),
        )
        .unique();
      if (!item || item.committed)
        throw new Error("Invalid shortlist result target");
      await ctx.db.patch(item._id, {
        suggestion: row.suggestion,
        resultJson: row.resultJson,
      });
    }
  },
});
export const complete = internalMutation({
  args: {
    runId: v.id("admissionShortlistRuns"),
    summaryJson: v.string(),
    expected: v.array(
      v.object({
        applicationId: v.id("applications"),
        contentVersion: v.number(),
        projectVersionId: v.id("projectVersions"),
        recommendationId: v.optional(v.id("admissionAIRecommendations")),
        committed: v.boolean(),
        applicationVersion: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const run = await requireRun(ctx, args.runId);
    if (run.state !== "auditing" || run.pendingJobs || run.failedJobs) return;
    shortlistSummarySchema.parse(JSON.parse(args.summaryJson));
    await authorize(ctx, run.eventId, run.actorPersonId, true);
    const event = await ctx.db.get(run.eventId);
    const current = await ctx.db
      .query("applications")
      .withIndex("by_event_submitted", (q) => q.eq("eventId", run.eventId))
      .take(maximumApplicantTeamsPerEvent + 1);
    const expected = new Map(
      args.expected.map((item) => [item.applicationId, item]),
    );
    let stale =
      run.releaseVersion !== shortlistVersion ||
      event?.publishedAdmissionPolicyId !== run.policyId ||
      event?.publishedAdmissionModelConfigId !== run.modelConfigId ||
      current.length > maximumApplicantTeamsPerEvent ||
      args.expected.filter((e) => !e.committed).length !== run.candidateCount;
    for (const app of current) {
      const prior = expected.get(app._id);
      const committed =
        ["accepted", "offer_sent", "confirmed"].includes(app.state) ||
        app.humanDecision === "accept";
      if (!prior) {
        if (committed) stale = true;
        continue;
      }
      expected.delete(app._id);
      if (
        committed !== prior.committed ||
        app.contentVersion !== prior.contentVersion ||
        app.submittedProjectVersionId !== prior.projectVersionId ||
        app.aiRecommendationId !== prior.recommendationId ||
        (!prior.committed &&
          (app.humanDecision !== undefined ||
            !["submitted", "under_review"].includes(app.state))) ||
        (prior.committed && app.version !== prior.applicationVersion)
      )
        stale = true;
    }
    if (stale || expected.size) {
      await ctx.db.patch(run._id, {
        state: "stale",
        error:
          "Sources or committed places changed before publication. Start a new snapshot.",
      });
      return;
    }
    await ctx.db.patch(run._id, {
      state: "complete",
      summaryJson: args.summaryJson,
      updatedAt: Date.now(),
    });
  },
});
