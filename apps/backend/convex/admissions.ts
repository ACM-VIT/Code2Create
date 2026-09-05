import { getAll } from "convex-helpers/server/relationships";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import { paginator } from "convex-helpers/server/pagination";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { admissionGuidanceForBand } from "./lib/admission";
import { loadPublishedAdmissionConfiguration } from "./lib/admissionPolicy";
import { createAdmissionRecommendation } from "./lib/admissionRecommendation";
import { advanceAccessVersion } from "./lib/accessVersion";
import { writeAuditEvent } from "./lib/audit";
import { initializeAttendanceTeamAvailability } from "./lib/attendanceTeamAvailability";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject, requireMembership } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
  storedOperationVersion,
} from "./lib/operations";
import {
  boundedActivePermissionScopeIds,
  hasAnyActivePermissionGrant,
  insertPermissionGrant,
  matchingPermissionGrantIds,
  requirePermission,
  revokeSourceGrants,
} from "./lib/permissions";
import {
  enqueueAdmissionDecisionNotifications,
  enqueueApplicationNotifications,
} from "./lib/participantNotificationDelivery";
import { maximumApplicantTeamsPerEvent } from "./lib/reviewLimits";
import { synchronizeTeamAdmissionIdeaComparison } from "./lib/noveltyIndex";
import { teamMatchesOrigin, type ExclusiveTeamOrigin } from "./lib/teamRoster";
import {
  normalizeEmail,
  normalizedLongText,
  normalizedText,
  optionalNormalizedText,
} from "./lib/strings";
import schema from "./schema";
import {
  admissionAiDisposition,
  admissionDecision,
  admissionDecisionStage,
  admissionOfferState,
  admissionRecommendationState,
  admissionReviewAssignmentState,
  applicationState,
  criterionAssessment,
  participantClass,
  studyYear,
} from "./values";

/** Year and class of each locked roster member. Only readers with profile context get it. */
const rosterCohortView = v.array(v.object({ participantClass, yearOfStudy: studyYear }));

const listItem = v.object({
  id: v.id("applications"),
  teamName: v.string(),
  state: applicationState,
  decisionStage: admissionDecisionStage,
  humanDecision: v.optional(admissionDecision),
  cohort: v.optional(rosterCohortView),
  memberCount: v.number(),
  minimumHumanReviews: v.number(),
  submittedAt: v.number(),
  aiState: v.optional(admissionRecommendationState),
  aiRecommendation: v.optional(admissionDecision),
  assignedReviewCount: v.number(),
  completedReviewCount: v.number(),
  humanReviewScore: v.object({
    accept: v.number(),
    waitlist: v.number(),
    reject: v.number(),
  }),
  version: v.number(),
});

const maximumScopedApplicationsForStageCounts = 2_000;
const maximumWorkloadAssignments = 4_000;
const maximumApplicationSearchResults = 100;
const maximumAdmissionPageSize = 100;
export const admissionReviewClaimMs = 30 * 60 * 1_000;
const admissionTeamOrigin = v.union(v.literal("internal"), v.literal("external"));
const admissionQueueStage = v.union(applicationState, v.literal("recorded"));
const recommendationOutcome = v.union(v.literal("accepted"), v.literal("waitlisted"), v.literal("rejected"));
const recommendationFilter = v.union(
  v.object({ source: v.literal("idea"), outcome: v.union(recommendationOutcome, v.literal("unavailable")) }),
  v.object({ source: v.literal("human"), outcome: v.union(recommendationOutcome, v.literal("split"), v.literal("needed")) }),
);

function applicationQueueStage(application: Doc<"applications">): Doc<"applications">["state"] | "recorded" {
  return application.decisionStage === "recorded" && application.state !== "withdrawn"
    ? "recorded"
    : application.state;
}

type HumanReviewScoreSource = Pick<
  Doc<"admissionHumanReviews">,
  "applicationContentVersion" | "recommendation"
>;

export function countHumanReviewScore(
  reviews: readonly HumanReviewScoreSource[],
  applicationContentVersion: number,
) {
  const score = { accept: 0, waitlist: 0, reject: 0 };
  for (const review of reviews) {
    if (review.applicationContentVersion !== applicationContentVersion) continue;
    if (review.recommendation === "accept") score.accept += 1;
    if (review.recommendation === "waitlist") score.waitlist += 1;
    if (review.recommendation === "decline") score.reject += 1;
  }
  return score;
}

function humanReviewOutcome(score: ReturnType<typeof countHumanReviewScore>, minimumReviews: number) {
  const completed = score.accept + score.waitlist + score.reject;
  if (completed < minimumReviews) return "needed";
  if (score.accept === completed) return "accepted";
  if (score.waitlist === completed) return "waitlisted";
  if (score.reject === completed) return "rejected";
  return "split";
}

function currentIdeaRecommendation(
  application: Doc<"applications">,
  recommendation: Doc<"admissionAIRecommendations"> | null | undefined,
) {
  return recommendation?.state === "succeeded" &&
    recommendation.eventId === application.eventId &&
    recommendation.applicationId === application._id &&
    recommendation.projectVersionId === application.submittedProjectVersionId &&
    recommendation.admissionPolicyVersionId === application.admissionPolicyVersionId &&
    recommendation.applicationContentVersion === application.contentVersion
    ? recommendation.recommendation : undefined;
}

async function applicationMatchesRecommendation(
  ctx: QueryCtx,
  application: Doc<"applications">,
  filter: Infer<typeof recommendationFilter>,
) {
  if (application.state === "withdrawn" && application.decisionStage !== "released") return false;
  if (filter.source === "idea") {
    const recommendation = application.aiRecommendationId
      ? await ctx.db.get(application.aiRecommendationId) : null;
    const decision = currentIdeaRecommendation(application, recommendation);
    const outcome = decision === "accept" ? "accepted" : decision === "waitlist" ? "waitlisted"
      : decision === "decline" ? "rejected" : "unavailable";
    return outcome === filter.outcome;
  }
  const [policy, reviews] = await Promise.all([
    ctx.db.get(application.admissionPolicyVersionId),
    ctx.db.query("admissionHumanReviews")
      .withIndex("by_application_status", (index) =>
        index.eq("applicationId", application._id).eq("status", "active"),
      ).collect(),
  ]);
  if (!policy) throw new Error("An application admission policy is missing.");
  return humanReviewOutcome(countHumanReviewScore(reviews, application.contentVersion), policy.minimumHumanReviews) === filter.outcome;
}

/** Null means event-wide AI access; a set limits summaries and filters to granted applications. */
async function admissionAiReadScopeIds(
  ctx: QueryCtx,
  eventId: Id<"events">,
  eventAccessSubjectId: Id<"eventAccessSubjects">,
) {
  const eventGrants = await matchingPermissionGrantIds(ctx, {
    eventId, eventAccessSubjectId,
    permissionKey: "application.ai_recommendation.read", scopeType: "event",
  });
  return eventGrants.length > 0 ? null : boundedActivePermissionScopeIds(ctx, {
    eventId, eventAccessSubjectId,
    permissionKey: "application.ai_recommendation.read", scopeType: "application",
    maximumScopeCount: maximumScopedApplicationsForStageCounts,
  });
}

function requireAdmissionPageSize(numItems: number) {
  if (!Number.isSafeInteger(numItems) || numItems < 1 || numItems > maximumAdmissionPageSize) {
    throw new ConvexError({
      code: "INVALID_PAGINATION",
      message: `Admission pages support 1 through ${maximumAdmissionPageSize} items.`,
    });
  }
}

async function applicationMatchesOrigin(
  ctx: QueryCtx,
  application: Doc<"applications">,
  origin: ExclusiveTeamOrigin | undefined,
) {
  if (origin === undefined) return true;
  const team = await ctx.db.get(application.teamId);
  return team !== null && teamMatchesOrigin(team, origin);
}

async function rosterCohort(ctx: QueryCtx, project: Doc<"projectVersions">) {
  const members = await ctx.db
    .query("teamSubmissionMembers")
    .withIndex("by_submission_attempt_and_ordinal", (index) =>
      index.eq("submissionAttemptId", project.lockedRosterSnapshotId),
    )
    .take(project.lockedMemberCount);
  return members.map((member) => ({
    participantClass: member.participantClass,
    yearOfStudy: member.yearOfStudy,
  }));
}

/** Returns stage counts only for applications covered by the caller's grants. */
export const stageCounts = query({
  args: {
    eventSlug: v.string(),
    origin: v.optional(admissionTeamOrigin),
    completedReviewCount: v.optional(v.literal(1)),
  },
  returns: v.array(v.object({ state: admissionQueueStage, count: v.number() })),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const eventGrantIds = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.read",
      scopeType: "event",
    });
    const applications =
      eventGrantIds.length > 0
        ? await ctx.db
            .query("applications")
            .withIndex("by_event_state_submitted", (index) => index.eq("eventId", event._id))
            .collect()
        : await scopedApplicationsForStageCounts(ctx, event._id, subject._id);
    const counts = new Map<ReturnType<typeof applicationQueueStage>, number>();
    for (const application of applications) {
      if (!(await applicationMatchesOrigin(ctx, application, args.origin))) continue;
      if (
        args.completedReviewCount !== undefined &&
        application.completedReviewCount !== args.completedReviewCount
      ) {
        continue;
      }
      const stage = applicationQueueStage(application);
      counts.set(stage, (counts.get(stage) ?? 0) + 1);
    }
    return [...counts.entries()].map(([state, count]) => ({ state, count }));
  },
});

async function activeSupremeRole(
  ctx: QueryCtx | MutationCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
) {
  const role = await ctx.db
    .query("eventRoles")
    .withIndex("by_event_person_status", (index) =>
      index.eq("eventId", eventId).eq("personId", personId).eq("status", "active"),
    )
    .unique();
  return role?.role === "supreme" && (role.validUntil === undefined || role.validUntil > Date.now())
    ? role
    : null;
}

const admissionSummaryCounts = v.object({
  total: v.number(),
  reviewsComplete: v.number(),
  reviewsNeeded: v.number(),
  unrecorded: v.number(),
  recorded: v.number(),
  released: v.number(),
  accepted: v.number(),
  waitlisted: v.number(),
  declined: v.number(),
});
const ideaAgentSummaryCounts = v.object({
  accepted: v.number(),
  waitlisted: v.number(),
  rejected: v.number(),
  unavailable: v.number(),
});
const humanReviewSummaryCounts = v.object({
  accepted: v.number(),
  waitlisted: v.number(),
  rejected: v.number(),
  split: v.number(),
  needed: v.number(),
});

export const admissionSummary = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    canReleaseResults: v.boolean(),
    serverNow: v.number(),
    eventVersion: v.number(),
    applicationsCloseAt: v.number(),
    releasedAt: v.optional(v.number()),
    releasedByName: v.optional(v.string()),
    ...admissionSummaryCounts.fields,
    people: admissionSummaryCounts,
    humanReviews: v.object({
      ...humanReviewSummaryCounts.fields,
      people: humanReviewSummaryCounts,
    }),
    ideaAgent: v.union(v.null(), v.object({
      ...ideaAgentSummaryCounts.fields,
      people: ideaAgentSummaryCounts,
    })),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const supremeRole = await activeSupremeRole(ctx, event._id, person._id);
    const readGrantIds = await matchingPermissionGrantIds(ctx, {
      eventId: event._id, eventAccessSubjectId: subject._id,
      permissionKey: "application.read", scopeType: "event",
    });
    const decisionGrantIds = supremeRole && readGrantIds.length > 0
      ? await matchingPermissionGrantIds(ctx, {
          eventId: event._id, eventAccessSubjectId: subject._id,
          permissionKey: "application.decide", scopeType: "event",
        })
      : [];
    const counts = {
      total: 0, reviewsComplete: 0, reviewsNeeded: 0,
      unrecorded: 0, recorded: 0, released: 0,
      accepted: 0, waitlisted: 0, declined: 0,
    };
    const people = { ...counts };
    const humanReviews = {
      accepted: 0, waitlisted: 0, rejected: 0, split: 0, needed: 0,
      people: { accepted: 0, waitlisted: 0, rejected: 0, split: 0, needed: 0 },
    };
    const applications = readGrantIds.length > 0
      ? await ctx.db
          .query("applications")
          .withIndex("by_event_submitted", (index) => index.eq("eventId", event._id))
          .collect()
      : await scopedApplicationsForStageCounts(ctx, event._id, subject._id);
    const active = applications.filter(
      (application) =>
        application.state !== "withdrawn" || application.decisionStage === "released",
    );
    const aiScopeIds = await admissionAiReadScopeIds(ctx, event._id, subject._id);
    const aiApplications = active.filter((application) => aiScopeIds === null || aiScopeIds.has(application._id));
    const ideaAgent = aiScopeIds === null || aiScopeIds.size > 0
      ? {
          accepted: 0, waitlisted: 0, rejected: 0, unavailable: 0,
          people: { accepted: 0, waitlisted: 0, rejected: 0, unavailable: 0 },
        }
      : null;
    const policyIds = [...new Set(active.map((application) => application.admissionPolicyVersionId))];
    const projectIds = [...new Set(active.map((application) => application.submittedProjectVersionId))];
    const recommendationIds = ideaAgent
      ? [...new Set(aiApplications.flatMap((application) =>
          application.aiRecommendationId ? [application.aiRecommendationId] : [],
        ))]
      : [];
    // Batch indexed review reads alongside the current policies, rosters, and AI recommendations.
    const [policies, projects, recommendations, humanScores] = await Promise.all([
      getAll(ctx.db, "admissionPolicyVersions", policyIds),
      getAll(ctx.db, "projectVersions", projectIds),
      getAll(ctx.db, "admissionAIRecommendations", recommendationIds),
      Promise.all(active.map(async (application) => {
        const reviews = application.completedReviewCount > 0
          ? await ctx.db.query("admissionHumanReviews")
              .withIndex("by_application_status", (index) =>
                index.eq("applicationId", application._id).eq("status", "active"),
              )
              .collect()
          : [];
        return { application, score: countHumanReviewScore(reviews, application.contentVersion) };
      })),
    ]);
    const policiesById = new Map(policies.filter((policy) => policy !== null).map((policy) => [policy._id, policy]));
    const projectsById = new Map(projects.filter((project) => project !== null).map((project) => [project._id, project]));
    const recommendationsById = new Map(
      recommendations
        .filter((recommendation) => recommendation !== null)
        .map((recommendation) => [recommendation._id, recommendation]),
    );
    for (const { application, score } of humanScores) {
      const policy = policiesById.get(application.admissionPolicyVersionId);
      const project = projectsById.get(application.submittedProjectVersionId);
      if (!policy || policy.eventId !== event._id || !project || project.eventId !== event._id) {
        throw new Error("An application admission policy or submitted project is missing.");
      }
      const memberCount = project.lockedMemberCount;
      const completedReviews = score.accept + score.waitlist + score.reject;
      const reviewStage = completedReviews >= policy.minimumHumanReviews
        ? "reviewsComplete" : "reviewsNeeded";
      for (const metric of ["total", reviewStage, application.decisionStage] as const) {
        counts[metric] += 1;
        people[metric] += memberCount;
      }
      // Outcomes describe unanimous, complete reviews; they do not record a final decision.
      const humanOutcome = humanReviewOutcome(score, policy.minimumHumanReviews);
      humanReviews[humanOutcome] += 1;
      humanReviews.people[humanOutcome] += memberCount;
      if (ideaAgent && (aiScopeIds === null || aiScopeIds.has(application._id))) {
        const recommendation = application.aiRecommendationId
          ? recommendationsById.get(application.aiRecommendationId)
          : null;
        const decision = currentIdeaRecommendation(application, recommendation);
        const outcome = decision === "accept" ? "accepted" : decision === "waitlist" ? "waitlisted"
          : decision === "decline" ? "rejected" : "unavailable";
        ideaAgent[outcome] += 1;
        ideaAgent.people[outcome] += memberCount;
      }
      if (application.decisionStage === "unrecorded" || application.humanDecision === undefined) continue;
      const outcome = application.humanDecision === "accept" ? "accepted"
        : application.humanDecision === "waitlist" ? "waitlisted" : "declined";
      counts[outcome] += 1;
      people[outcome] += memberCount;
    }
    const releaser = event.admissionResultsReleasedByPersonId
      ? await ctx.db.get(event.admissionResultsReleasedByPersonId)
      : null;
    return {
      canReleaseResults: decisionGrantIds.length > 0,
      serverNow: Date.now(),
      eventVersion: event.version,
      applicationsCloseAt: event.applicationsCloseAt,
      ...(event.admissionResultsReleasedAt !== undefined
        ? { releasedAt: event.admissionResultsReleasedAt }
        : {}),
      ...(releaser ? { releasedByName: releaser.displayName } : {}),
      ...counts,
      people,
      humanReviews,
      ideaAgent,
    };
  },
});

const admissionResultsReleaseOperationResult = z
  .object({
    releasedAt: z.number().int().positive(),
    applicationCount: z.number().int().positive(),
  })
  .strict();

export const releaseAdmissionResults = mutation({
  args: {
    eventSlug: v.string(),
    expectedEventVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ releasedAt: v.number(), applicationCount: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const requestFingerprint = operationFingerprint([args.expectedEventVersion, args.reason]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.results.release",
      requestFingerprint,
    });
    if (prior) {
      return storedOperationResult(
        prior.resultJson,
        "admission-results release",
        admissionResultsReleaseOperationResult,
      );
    }
    if (!(await activeSupremeRole(ctx, event._id, person._id))) {
      throw new ConvexError({
        code: "SUPREME_ROLE_REQUIRED",
        message: "Only an active Supreme can release admission results.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.decide",
      scopeType: "event",
    });
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CHANGED",
        message: "Event state changed. Review the release summary again.",
      });
    }
    if (event.admissionResultsReleasedAt !== undefined) {
      throw new ConvexError({
        code: "ADMISSION_RESULTS_RELEASED",
        message: "Admission results have already been released.",
      });
    }
    const now = Date.now();
    if (now < event.applicationsCloseAt) {
      throw new ConvexError({
        code: "APPLICATIONS_STILL_OPEN",
        message: "Results can be released only after applications close.",
      });
    }
    const communicationsPolicyVersionId = await publishedCommunicationsPolicyId(ctx, event._id);
    const applications = await ctx.db
      .query("applications")
      .withIndex("by_event_submitted", (index) => index.eq("eventId", event._id))
      .collect();
    const active = applications.filter((application) => application.state !== "withdrawn");
    const incomplete = active.find((application) => application.decisionStage !== "recorded");
    if (incomplete || active.length === 0) {
      throw new ConvexError({
        code: "ADMISSION_DECISIONS_INCOMPLETE",
        message:
          active.length === 0
            ? "There are no applications to release."
            : "Every active application needs a recorded final decision before release.",
      });
    }
    for (const application of active) {
      if (
        application.humanDecision === undefined ||
        application.humanReasonCode === undefined ||
        application.decidedByPersonId === undefined ||
        application.decidedAt === undefined
      ) {
        throw new Error("A recorded admission decision is incomplete.");
      }
    }
    const reason = normalizedText(args.reason, "Release reason", 5, 500);
    await ctx.db.patch(event._id, {
      admissionResultsReleasedAt: now,
      admissionResultsReleasedByPersonId: person._id,
      admissionResultsCommunicationsPolicyId: communicationsPolicyVersionId,
      version: event.version + 1,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.admissions.finalizeReleasedAdmissionResults, {
      eventId: event._id,
      releasedAt: now,
      releasedByPersonId: person._id,
      communicationsPolicyVersionId,
    });
    const result = { releasedAt: now, applicationCount: active.length };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.results.release",
      requestFingerprint,
      targetType: "event",
      targetId: event._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "application.decide",
      grantIds,
      scopeType: "event",
      action: "admission.results_released",
      targetType: "event",
      targetId: event._id,
      previousSummary: JSON.stringify({ admissionResultsReleasedAt: null }),
      nextSummary: JSON.stringify({
        admissionResultsReleasedAt: now,
        applicationCount: active.length,
        communicationsPolicyVersionId,
      }),
      reason,
    });
    return result;
  },
});

async function scopedApplicationsForStageCounts(
  ctx: QueryCtx,
  eventId: Id<"events">,
  eventAccessSubjectId: Id<"eventAccessSubjects">,
) {
  const scopeIds = await boundedActivePermissionScopeIds(ctx, {
    eventId,
    eventAccessSubjectId,
    permissionKey: "application.read",
    scopeType: "application",
    maximumScopeCount: maximumScopedApplicationsForStageCounts,
  });
  if (scopeIds.size === 0) {
    throw new ConvexError({
      code: "ACCESS_DENIED",
      message: "This account cannot read application counts.",
    });
  }
  const applications = await Promise.all(
    [...scopeIds].map(async (scopeId) => {
      const applicationId = ctx.db.normalizeId("applications", scopeId);
      const application = applicationId ? await ctx.db.get(applicationId) : null;
      return application?.eventId === eventId ? application : null;
    }),
  );
  return applications.filter((application) => application !== null);
}

async function applicationListProjection(
  ctx: QueryCtx,
  eventId: Id<"events">,
  eventAccessSubjectId: Id<"eventAccessSubjects">,
  application: Doc<"applications">,
) {
  const [profileGrantIds, aiGrantIds, team, project, policy, humanReviews] = await Promise.all([
    matchingPermissionGrantIds(ctx, {
      eventId,
      eventAccessSubjectId,
      permissionKey: "application.profile_context.read",
      scopeType: "application",
      scopeId: application._id,
    }),
    matchingPermissionGrantIds(ctx, {
      eventId,
      eventAccessSubjectId,
      permissionKey: "application.ai_recommendation.read",
      scopeType: "application",
      scopeId: application._id,
    }),
    ctx.db.get(application.teamId),
    ctx.db.get(application.submittedProjectVersionId),
    ctx.db.get(application.admissionPolicyVersionId),
    ctx.db
      .query("admissionHumanReviews")
      .withIndex("by_application_status", (index) =>
        index.eq("applicationId", application._id).eq("status", "active"),
      )
      .collect(),
  ]);
  if (!team || !project || !policy) return null;
  const recommendation =
    aiGrantIds.length > 0 && application.aiRecommendationId
      ? await ctx.db.get(application.aiRecommendationId)
      : null;
  const aiRecommendation = currentIdeaRecommendation(application, recommendation);
  return {
    id: application._id,
    teamName: team.name,
    state: application.state,
    decisionStage: application.decisionStage,
    ...(application.humanDecision !== undefined
      ? { humanDecision: application.humanDecision }
      : {}),
    ...(profileGrantIds.length > 0 ? { cohort: await rosterCohort(ctx, project) } : {}),
    memberCount: project.lockedMemberCount,
    minimumHumanReviews: policy.minimumHumanReviews,
    submittedAt: application.submittedAt,
    ...(recommendation
      ? {
          aiState: recommendation.state === "succeeded" && aiRecommendation === undefined
            ? "stale" as const : recommendation.state,
          ...(aiRecommendation !== undefined
            ? { aiRecommendation }
            : {}),
        }
      : {}),
    assignedReviewCount: application.assignedReviewCount,
    completedReviewCount: application.completedReviewCount,
    humanReviewScore: countHumanReviewScore(humanReviews, application.contentVersion),
    version: application.version,
  };
}

async function visibleApplicationListProjection(
  ctx: QueryCtx,
  eventId: Id<"events">,
  eventAccessSubjectId: Id<"eventAccessSubjects">,
  application: Doc<"applications">,
) {
  const grantIds = await matchingPermissionGrantIds(ctx, {
    eventId,
    eventAccessSubjectId,
    permissionKey: "application.read",
    scopeType: "application",
    scopeId: application._id,
  });
  return grantIds.length > 0
    ? applicationListProjection(ctx, eventId, eventAccessSubjectId, application)
    : null;
}

export const list = query({
  args: {
    eventSlug: v.string(),
    state: v.optional(admissionQueueStage),
    origin: v.optional(admissionTeamOrigin),
    completedReviewCount: v.optional(v.literal(1)),
    needsReview: v.optional(v.literal(true)),
    recommendationFilter: v.optional(recommendationFilter),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(listItem),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    requireAdmissionPageSize(args.paginationOpts.numItems);
    const aiScopeIds = args.recommendationFilter?.source === "idea"
      ? await admissionAiReadScopeIds(ctx, event._id, subject._id) : null;
    if (aiScopeIds?.size === 0) {
      throw new ConvexError({ code: "ACCESS_DENIED", message: "This account lacks AI recommendation read permission." });
    }
    const state = args.state;
    if (args.origin !== undefined || args.needsReview || args.recommendationFilter) {
      const applications = paginator(ctx.db, schema).query("applications");
      const applicationQuery = state === "recorded"
        ? applications.withIndex("by_event_decision_stage", (index) =>
            index.eq("eventId", event._id).eq("decisionStage", "recorded"),
          )
        : applications.withIndex("by_event_state_submitted", (index) => {
            const eventIndex = index.eq("eventId", event._id);
            return state ? eventIndex.eq("state", state) : eventIndex;
          });
      return applicationQuery
        .order("asc")
        .map(async (application) => {
          if (aiScopeIds !== null && !aiScopeIds.has(application._id)) return null;
          if (state !== undefined && applicationQueueStage(application) !== state) return null;
          if (
            args.completedReviewCount !== undefined &&
            application.completedReviewCount !== args.completedReviewCount
          ) {
            return null;
          }
          if (!(await applicationMatchesOrigin(ctx, application, args.origin))) return null;
          if (args.recommendationFilter &&
            !(await applicationMatchesRecommendation(ctx, application, args.recommendationFilter))) return null;
          const projected = await visibleApplicationListProjection(
            ctx,
            event._id,
            subject._id,
            application,
          );
          if (
            args.needsReview &&
            projected &&
            projected.completedReviewCount >= projected.minimumHumanReviews
          ) {
            return null;
          }
          return projected;
        })
        .paginate({
          ...args.paginationOpts,
          maximumRowsRead: args.recommendationFilter ? maximumAdmissionPageSize : maximumApplicantTeamsPerEvent + 1,
        });
    }
    const applications = ctx.db.query("applications");
    let applicationQuery = (state === "recorded"
      ? applications.withIndex("by_event_decision_stage", (index) =>
          index.eq("eventId", event._id).eq("decisionStage", "recorded"),
        ).filter((filter) => filter.neq(filter.field("state"), "withdrawn"))
      : applications.withIndex("by_event_state_submitted", (index) => {
          const eventIndex = index.eq("eventId", event._id);
          return state ? eventIndex.eq("state", state) : eventIndex;
        })
    ).order("asc");
    if (state !== undefined && state !== "recorded" && state !== "withdrawn") {
      applicationQuery = applicationQuery.filter((filter) =>
        filter.neq(filter.field("decisionStage"), "recorded"),
      );
    }
    const page = await (args.completedReviewCount === undefined
      ? applicationQuery
      : applicationQuery.filter((filter) =>
          filter.eq(filter.field("completedReviewCount"), args.completedReviewCount),
        )
    ).paginate(args.paginationOpts);
    const visible = [];
    for (const application of page.page) {
      const item = await visibleApplicationListProjection(
        ctx,
        event._id,
        subject._id,
        application,
      );
      if (item) visible.push(item);
    }
    return { ...page, page: visible };
  },
});

export const searchApplications = query({
  args: {
    eventSlug: v.string(),
    state: v.optional(admissionQueueStage),
    search: v.string(),
    origin: v.optional(admissionTeamOrigin),
    completedReviewCount: v.optional(v.literal(1)),
    needsReview: v.optional(v.literal(true)),
    recommendationFilter: v.optional(recommendationFilter),
  },
  returns: v.object({
    applications: v.array(listItem),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const searchTerms = normalizedText(args.search, "Team search", 1, 80)
      .toLowerCase()
      .split(" ");
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const aiScopeIds = args.recommendationFilter?.source === "idea"
      ? await admissionAiReadScopeIds(ctx, event._id, subject._id) : null;
    if (aiScopeIds?.size === 0) {
      throw new ConvexError({ code: "ACCESS_DENIED", message: "This account lacks AI recommendation read permission." });
    }
    const state = args.state;
    const applicationQuery = ctx.db.query("applications");
    const applications = await (state === "recorded"
      ? applicationQuery.withIndex("by_event_decision_stage", (index) =>
          index.eq("eventId", event._id).eq("decisionStage", "recorded"),
        )
      : applicationQuery.withIndex("by_event_state_submitted", (index) => {
          const eventIndex = index.eq("eventId", event._id);
          return state ? eventIndex.eq("state", state) : eventIndex;
        })
    ).take(maximumApplicantTeamsPerEvent + 1);
    if (applications.length > maximumApplicantTeamsPerEvent) {
      throw new Error(
        `Admission searches support at most ${maximumApplicantTeamsPerEvent} applicant teams.`,
      );
    }
    const eventGrantIds = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.read",
      scopeType: "event",
    });
    const readableScopeIds =
      eventGrantIds.length > 0
        ? null
        : await boundedActivePermissionScopeIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: "application.read",
            scopeType: "application",
            maximumScopeCount: maximumApplicantTeamsPerEvent,
          });
    const candidates = await Promise.all(
      applications
        .filter(
          (application) =>
            (state === undefined || applicationQueueStage(application) === state) &&
            (readableScopeIds === null || readableScopeIds.has(application._id)) &&
            (aiScopeIds === null || aiScopeIds.has(application._id)) &&
            (args.completedReviewCount === undefined ||
              application.completedReviewCount === args.completedReviewCount),
        )
        .map(async (application) => {
          const [team, policy] = await Promise.all([
            ctx.db.get(application.teamId),
            args.needsReview
              ? ctx.db.get(application.admissionPolicyVersionId)
              : Promise.resolve(null),
          ]);
          return { application, team, policy };
        }),
    );
    const matches = candidates
      .flatMap(({ application, team, policy }) => {
        if (
          !team ||
          !searchTerms.every((term) => team.name.toLowerCase().includes(term)) ||
          (args.origin !== undefined && !teamMatchesOrigin(team, args.origin)) ||
          (args.needsReview &&
            (!policy || application.completedReviewCount >= policy.minimumHumanReviews))
        ) {
          return [];
        }
        return [{ application, teamName: team.name }];
      })
      .sort((left, right) => {
        const byName = left.teamName.localeCompare(right.teamName);
        return byName || left.application.submittedAt - right.application.submittedAt;
      });
    const projected = [];
    for (const { application } of matches) {
      if (args.recommendationFilter &&
        !(await applicationMatchesRecommendation(ctx, application, args.recommendationFilter))) continue;
      const item = await applicationListProjection(ctx, event._id, subject._id, application);
      if (
        item &&
        (!args.needsReview || item.completedReviewCount < item.minimumHumanReviews)
      ) {
        projected.push(item);
        if (projected.length > maximumApplicationSearchResults) break;
      }
    }
    return {
      applications: projected.slice(0, maximumApplicationSearchResults),
      truncated: projected.length > maximumApplicationSearchResults,
    };
  },
});

const assignedReviewItem = v.object({
  assignmentId: v.id("admissionReviewAssignments"),
  assignmentState: admissionReviewAssignmentState,
  assignmentVersion: v.number(),
  assignedAt: v.number(),
  claimExpiresAt: v.optional(v.number()),
  applicationId: v.id("applications"),
  applicationState,
  applicationVersion: v.number(),
  teamName: v.string(),
  cohort: v.optional(rosterCohortView),
  memberCount: v.number(),
  aiState: v.optional(admissionRecommendationState),
  aiRecommendation: v.optional(admissionDecision),
  ownRecommendation: v.optional(admissionDecision),
});

const reviewAssignmentCountRow = v.object({
  state: v.union(v.literal("active"), v.literal("completed")),
});

async function visibleReviewAssignmentApplication(
  ctx: QueryCtx,
  eventId: Id<"events">,
  eventAccessSubjectId: Id<"eventAccessSubjects">,
  assignment: Doc<"admissionReviewAssignments">,
  origin: ExclusiveTeamOrigin | undefined,
) {
  const application = await ctx.db.get(assignment.applicationId);
  if (!application || application.eventId !== eventId) return null;
  if (
    assignment.state === "active" &&
    assignment.assignedAt + admissionReviewClaimMs <= Date.now()
  ) {
    return null;
  }
  if (!(await applicationMatchesOrigin(ctx, application, origin))) return null;
  const reviewReadGrantIds = await matchingPermissionGrantIds(ctx, {
    eventId,
    eventAccessSubjectId,
    permissionKey: "application.review.read",
    scopeType: "application",
    scopeId: application._id,
  });
  return reviewReadGrantIds.length > 0 ? application : null;
}

async function visibleReviewAssignmentProjection(
  ctx: QueryCtx,
  eventId: Id<"events">,
  eventAccessSubjectId: Id<"eventAccessSubjects">,
  reviewerPersonId: Id<"people">,
  assignment: Doc<"admissionReviewAssignments">,
  origin: ExclusiveTeamOrigin | undefined,
) {
  const application = await visibleReviewAssignmentApplication(
    ctx,
    eventId,
    eventAccessSubjectId,
    assignment,
    origin,
  );
  if (!application) return null;
  const [team, project, profileGrantIds, aiGrantIds, ownReview] = await Promise.all([
    ctx.db.get(application.teamId),
    ctx.db.get(application.submittedProjectVersionId),
    matchingPermissionGrantIds(ctx, {
      eventId,
      eventAccessSubjectId,
      permissionKey: "application.profile_context.read",
      scopeType: "application",
      scopeId: application._id,
    }),
    matchingPermissionGrantIds(ctx, {
      eventId,
      eventAccessSubjectId,
      permissionKey: "application.ai_recommendation.read",
      scopeType: "application",
      scopeId: application._id,
    }),
    ctx.db
      .query("admissionHumanReviews")
      .withIndex("by_application_reviewer_status", (index) =>
        index
          .eq("applicationId", application._id)
          .eq("reviewerPersonId", reviewerPersonId)
          .eq("status", "active"),
      )
      .unique(),
  ]);
  if (!team || !project) return null;
  const recommendation =
    aiGrantIds.length > 0 && application.aiRecommendationId
      ? await ctx.db.get(application.aiRecommendationId)
      : null;
  return {
    assignmentId: assignment._id,
    assignmentState: assignment.state,
    assignmentVersion: assignment.version,
    assignedAt: assignment.assignedAt,
    ...(assignment.state === "active"
      ? { claimExpiresAt: assignment.assignedAt + admissionReviewClaimMs }
      : {}),
    applicationId: application._id,
    applicationState: application.state,
    applicationVersion: application.version,
    teamName: team.name,
    ...(profileGrantIds.length > 0 ? { cohort: await rosterCohort(ctx, project) } : {}),
    memberCount: project.lockedMemberCount,
    ...(recommendation
      ? {
          aiState: recommendation.state,
          ...(recommendation.state === "succeeded" && recommendation.recommendation !== undefined
            ? { aiRecommendation: recommendation.recommendation }
            : {}),
        }
      : {}),
    ...(ownReview?.applicationContentVersion === application.contentVersion
      ? { ownRecommendation: ownReview.recommendation }
      : {}),
  };
}

export const myReviewAssignments = query({
  args: {
    eventSlug: v.string(),
    state: admissionReviewAssignmentState,
    origin: v.optional(admissionTeamOrigin),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(assignedReviewItem),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    requireAdmissionPageSize(args.paginationOpts.numItems);
    if (args.origin !== undefined) {
      const origin = args.origin;
      return paginator(ctx.db, schema)
        .query("admissionReviewAssignments")
        .withIndex("by_event_reviewer_state_assigned", (index) =>
          index.eq("eventId", event._id).eq("reviewerPersonId", person._id).eq("state", args.state),
        )
        .order("desc")
        .map((assignment) =>
          visibleReviewAssignmentProjection(
            ctx,
            event._id,
            subject._id,
            person._id,
            assignment,
            origin,
          ),
        )
        .paginate({
          ...args.paginationOpts,
          maximumRowsRead: maximumWorkloadAssignments + 1,
        });
    }
    const page = await ctx.db
      .query("admissionReviewAssignments")
      .withIndex("by_event_reviewer_state_assigned", (index) =>
        index.eq("eventId", event._id).eq("reviewerPersonId", person._id).eq("state", args.state),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    const visible = [];
    for (const assignment of page.page) {
      const item = await visibleReviewAssignmentProjection(
        ctx,
        event._id,
        subject._id,
        person._id,
        assignment,
        undefined,
      );
      if (item) visible.push(item);
    }
    return { ...page, page: visible };
  },
});

/** Pages the caller's workload so the client can derive exact totals without a read ceiling. */
export const myReviewAssignmentCountRows = query({
  args: {
    eventSlug: v.string(),
    origin: v.optional(admissionTeamOrigin),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(reviewAssignmentCountRow),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    requireAdmissionPageSize(args.paginationOpts.numItems);
    const page = await ctx.db
      .query("admissionReviewAssignments")
      .withIndex("by_event_reviewer_state_assigned", (index) =>
        index.eq("eventId", event._id).eq("reviewerPersonId", person._id),
      )
      .paginate(args.paginationOpts);
    const visible = [];
    for (const assignment of page.page) {
      if (assignment.state === "cancelled") continue;
      const application = await visibleReviewAssignmentApplication(
        ctx,
        event._id,
        subject._id,
        assignment,
        args.origin,
      );
      if (!application) continue;
      visible.push({ state: assignment.state });
    }
    return { ...page, page: visible };
  },
});

/** Every reviewer who holds or held an assignment, with how much is open, so coordinators can balance work. */
export const reviewerWorkload = query({
  args: { eventSlug: v.string() },
  returns: v.array(
    v.object({
      personId: v.id("people"),
      displayName: v.string(),
      email: v.string(),
      active: v.number(),
      completed: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const canAssign = await hasAnyActivePermissionGrant(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.assign",
    });
    if (!canAssign) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account cannot assign application reviews.",
      });
    }
    const rows = await ctx.db
      .query("admissionReviewAssignments")
      .withIndex("by_event_reviewer_state_assigned", (index) => index.eq("eventId", event._id))
      .take(maximumWorkloadAssignments);
    const totals = new Map<Id<"people">, { active: number; completed: number }>();
    for (const row of rows) {
      if (row.state === "cancelled") continue;
      const current = totals.get(row.reviewerPersonId) ?? { active: 0, completed: 0 };
      if (row.state === "active") current.active += 1;
      else current.completed += 1;
      totals.set(row.reviewerPersonId, current);
    }
    const reviewers = [];
    for (const [personId, counts] of totals) {
      const [reviewer, reviewerSubject] = await Promise.all([
        ctx.db.get("people", personId),
        ctx.db
          .query("eventAccessSubjects")
          .withIndex("by_event_person", (index) =>
            index.eq("eventId", event._id).eq("personId", personId),
          )
          .unique(),
      ]);
      if (!reviewer || !reviewerSubject) continue;
      reviewers.push({
        personId,
        displayName: reviewer.displayName,
        email: reviewerSubject.emailNormalized,
        ...counts,
      });
    }
    return reviewers.sort((left, right) => left.displayName.localeCompare(right.displayName));
  },
});

const memberView = v.object({
  membershipId: v.id("eventMemberships"),
  displayName: v.string(),
  profileContext: v.union(
    v.null(),
    v.object({
      participantClass,
      yearOfStudy: studyYear,
      institution: v.string(),
    }),
  ),
});

const reviewAssignmentView = v.object({
  id: v.id("admissionReviewAssignments"),
  reviewerName: v.string(),
  reviewerEmail: v.string(),
  applicationContentVersion: v.number(),
  evidenceAvailable: v.boolean(),
  state: admissionReviewAssignmentState,
  version: v.number(),
  assignedAt: v.number(),
  completedAt: v.optional(v.number()),
  cancelledAt: v.optional(v.number()),
  cancellationReason: v.optional(v.string()),
});

export const members = query({
  args: {
    eventSlug: v.string(),
    applicationId: v.id("applications"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(memberView),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const application = await ctx.db.get(args.applicationId);
    if (!application || application.eventId !== event._id) {
      throw new ConvexError({
        code: "APPLICATION_NOT_FOUND",
        message: "The application does not exist in this event.",
      });
    }
    const permissionRequest = {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      scopeType: "application" as const,
      scopeId: application._id,
    };
    const [fullReadGrantIds, reviewReadGrantIds, profileGrantIds, project] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        ...permissionRequest,
        permissionKey: "application.read",
      }),
      matchingPermissionGrantIds(ctx, {
        ...permissionRequest,
        permissionKey: "application.review.read",
      }),
      matchingPermissionGrantIds(ctx, {
        ...permissionRequest,
        permissionKey: "application.profile_context.read",
      }),
      ctx.db.get(application.submittedProjectVersionId),
    ]);
    if (fullReadGrantIds.length === 0 && reviewReadGrantIds.length === 0) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account cannot read that application or assigned review.",
      });
    }
    if (!project || project.eventId !== event._id || project.teamId !== application.teamId) {
      throw new Error("The submitted project snapshot is missing.");
    }
    const snapshot = await ctx.db.get(project.lockedRosterSnapshotId);
    if (
      !snapshot ||
      snapshot.state !== "complete" ||
      snapshot.processedMemberCount !== project.lockedMemberCount
    ) {
      throw new Error("The immutable submitted roster is incomplete.");
    }
    const page = await ctx.db
      .query("teamSubmissionMembers")
      .withIndex("by_submission_attempt_and_ordinal", (index) =>
        index.eq("submissionAttemptId", snapshot._id),
      )
      .paginate(args.paginationOpts);
    return {
      ...page,
      page: page.page.map((snapshotMember) => {
        if (snapshotMember.eventId !== event._id || snapshotMember.teamId !== application.teamId) {
          throw new Error("The immutable submitted roster belongs to another team.");
        }
        return {
          membershipId: snapshotMember.membershipId,
          displayName: snapshotMember.displayName,
          profileContext:
            profileGrantIds.length > 0
              ? {
                  participantClass: snapshotMember.participantClass,
                  yearOfStudy: snapshotMember.yearOfStudy,
                  institution: snapshotMember.institution,
                }
              : null,
        };
      }),
    };
  },
});

export const detail = query({
  args: { eventSlug: v.string(), applicationId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      serverNow: v.number(),
      applicationsCloseAt: v.number(),
      eventTimezone: v.string(),
      application: v.object({
        id: v.id("applications"),
        state: applicationState,
        decisionStage: admissionDecisionStage,
        cohort: v.optional(rosterCohortView),
        assignedReviewCount: v.number(),
        completedReviewCount: v.number(),
        contentVersion: v.number(),
        version: v.number(),
        submittedAt: v.number(),
        humanDecision: v.optional(admissionDecision),
        humanReasonCode: v.optional(v.string()),
        aiDisposition: v.optional(admissionAiDisposition),
      }),
      team: v.object({ id: v.id("teams"), name: v.string(), memberCount: v.number() }),
      project: v.object({
        id: v.id("projectVersions"),
        initialIdea: v.string(),
        additionalInformation: v.optional(v.string()),
        intakeResponses: v.array(
          v.object({
            ordinal: v.number(),
            question: v.string(),
            answer: v.string(),
          }),
        ),
      }),
      policy: v.object({
        id: v.id("admissionPolicyVersions"),
        version: v.string(),
        minimumHumanReviews: v.number(),
        criteria: v.array(
          v.object({
            criterionKey: v.string(),
            label: v.string(),
            guidance: v.optional(v.string()),
          }),
        ),
        decisionReasonCodes: v.array(
          v.object({
            key: v.string(),
            label: v.string(),
            allowedDecisions: v.array(admissionDecision),
          }),
        ),
      }),
      aiRecommendation: v.union(
        v.null(),
        v.object({
          id: v.id("admissionAIRecommendations"),
          state: admissionRecommendationState,
          recommendation: v.optional(admissionDecision),
          criterionAssessments: v.array(
            v.object({
              criterionKey: v.string(),
              assessment: criterionAssessment,
              sourceRefs: v.array(v.string()),
            }),
          ),
          strengths: v.array(v.string()),
          concerns: v.array(v.string()),
          confidence: v.optional(v.string()),
          limitations: v.array(v.string()),
          agentVersion: v.optional(v.string()),
          agentModel: v.optional(v.string()),
        }),
      ),
      aiRecommendationVisible: v.boolean(),
      aiRecommendationRerun: v.union(
        v.null(),
        v.object({ recommendationId: v.id("admissionAIRecommendations") }),
      ),
      humanReviews: v.array(
        v.object({
          id: v.id("admissionHumanReviews"),
          reviewerName: v.string(),
          own: v.boolean(),
          recommendation: admissionDecision,
          reasonCode: v.string(),
          note: v.optional(v.string()),
          createdAt: v.number(),
        }),
      ),
      reviewAssignments: v.optional(v.array(reviewAssignmentView)),
      currentOffer: v.union(
        v.null(),
        v.object({
          id: v.id("admissionOffers"),
          state: admissionOfferState,
          participantCount: v.number(),
          sentAt: v.number(),
          expiresAt: v.number(),
          version: v.number(),
        }),
      ),
      capacity: v.union(v.null(), v.object({ capacity: v.number(), reserved: v.number() })),
      permissions: v.object({
        review: v.boolean(),
        assign: v.boolean(),
        decide: v.boolean(),
        offerManage: v.boolean(),
        participantDeliveryRead: v.boolean(),
      }),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const applicationId = ctx.db.normalizeId("applications", args.applicationId);
    const application = applicationId ? await ctx.db.get(applicationId) : null;
    if (!application || application.eventId !== event._id) return null;
    const permissionRequest = {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      scopeType: "application" as const,
      scopeId: application._id,
    };
    const [
      fullReadGrantIds,
      reviewReadGrantIds,
      profileGrantIds,
      aiGrantIds,
      aiRunGrantIds,
      assignmentGrantIds,
      reviewGrantIds,
      decideGrantIds,
      offerGrantIds,
      participantDeliveryRead,
    ] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        ...permissionRequest,
        permissionKey: "application.read",
      }),
      matchingPermissionGrantIds(ctx, {
        ...permissionRequest,
        permissionKey: "application.review.read",
      }),
      matchingPermissionGrantIds(ctx, {
        ...permissionRequest,
        permissionKey: "application.profile_context.read",
      }),
      matchingPermissionGrantIds(ctx, {
        ...permissionRequest,
        permissionKey: "application.ai_recommendation.read",
      }),
      matchingPermissionGrantIds(ctx, {
        ...permissionRequest,
        permissionKey: "application.ai_recommendation.run",
      }),
      matchingPermissionGrantIds(ctx, {
        ...permissionRequest,
        permissionKey: "application.assign",
      }),
      matchingPermissionGrantIds(ctx, {
        ...permissionRequest,
        permissionKey: "application.review",
      }),
      matchingPermissionGrantIds(ctx, {
        ...permissionRequest,
        permissionKey: "application.decide",
      }),
      matchingPermissionGrantIds(ctx, {
        ...permissionRequest,
        permissionKey: "application.offer.manage",
      }),
      hasAnyActivePermissionGrant(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "communications.delivery.read",
      }),
    ]);
    const canReadApplication = fullReadGrantIds.length > 0;
    const canReadReview = reviewReadGrantIds.length > 0;
    if (!canReadApplication && !canReadReview) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account cannot read that application or assigned review.",
      });
    }
    const canReadProfileContext = profileGrantIds.length > 0;
    const canReadAiRecommendation = aiGrantIds.length > 0;
    const canRunAiRecommendation = aiRunGrantIds.length > 0;
    const canManageAssignments = assignmentGrantIds.length > 0;
    const [team, project, policy, reviews] = await Promise.all([
      ctx.db.get(application.teamId),
      ctx.db.get(application.submittedProjectVersionId),
      ctx.db.get(application.admissionPolicyVersionId),
      ctx.db
        .query("admissionHumanReviews")
        .withIndex("by_application_status", (index) =>
          index.eq("applicationId", application._id).eq("status", "active"),
        )
        .collect(),
    ]);
    if (!team || !project || !policy || policy.eventId !== event._id) return null;
    const [recommendation, capacity, currentOffer, assignmentRows] =
      await Promise.all([
        (canReadAiRecommendation || canRunAiRecommendation) && application.aiRecommendationId
          ? ctx.db.get(application.aiRecommendationId)
          : Promise.resolve(null),
        canReadApplication
          ? ctx.db
              .query("admissionCapacityBuckets")
              .withIndex("by_policy", (index) =>
                index.eq("admissionPolicyVersionId", application.admissionPolicyVersionId),
              )
              .unique()
          : Promise.resolve(null),
        canReadApplication && application.currentOfferId
          ? ctx.db.get(application.currentOfferId)
          : Promise.resolve(null),
        canManageAssignments
          ? ctx.db
              .query("admissionReviewAssignments")
              .withIndex("by_application_state_assigned", (index) =>
                index.eq("applicationId", application._id),
              )
              .collect()
          : Promise.resolve(null),
      ]);
    const currentReviews = reviews.filter(
      (review) => review.applicationContentVersion === application.contentVersion,
    );
    const ownReview = currentReviews.find((review) => review.reviewerPersonId === person._id);
    const visibleReviews =
      canReadApplication || ownReview
        ? currentReviews
        : currentReviews.filter((review) => review.reviewerPersonId === person._id);
    const reviewViews = [];
    for (const review of visibleReviews) {
      const reviewer = await ctx.db.get(review.reviewerPersonId);
      if (!reviewer) continue;
      reviewViews.push({
        id: review._id,
        reviewerName: reviewer.displayName,
        own: review.reviewerPersonId === person._id,
        recommendation: review.recommendation,
        reasonCode: review.reasonCode,
        ...(review.note !== undefined ? { note: review.note } : {}),
        createdAt: review.createdAt,
      });
    }
    const reviewAssignments = [];
    for (const assignment of assignmentRows ?? []) {
      const [reviewer, reviewerSubject] = await Promise.all([
        ctx.db.get(assignment.reviewerPersonId),
        ctx.db
          .query("eventAccessSubjects")
          .withIndex("by_event_person", (index) =>
            index.eq("eventId", event._id).eq("personId", assignment.reviewerPersonId),
          )
          .unique(),
      ]);
      if (!reviewer || !reviewerSubject) {
        throw new Error("Application review assignment owner is missing.");
      }
      reviewAssignments.push({
        id: assignment._id,
        reviewerName: reviewer.displayName,
        reviewerEmail: reviewerSubject.emailNormalized,
        applicationContentVersion: assignment.applicationContentVersion,
        evidenceAvailable:
          canReadApplication || assignment.reviewerPersonId === person._id,
        state: assignment.state,
        version: assignment.version,
        assignedAt: assignment.assignedAt,
        ...(assignment.completedAt !== undefined ? { completedAt: assignment.completedAt } : {}),
        ...(assignment.cancelledAt !== undefined ? { cancelledAt: assignment.cancelledAt } : {}),
        ...(assignment.cancellationReason !== undefined
          ? { cancellationReason: assignment.cancellationReason }
          : {}),
      });
    }
    return {
      serverNow: Date.now(),
      applicationsCloseAt: event.applicationsCloseAt,
      eventTimezone: event.timezone,
      application: {
        id: application._id,
        state: application.state,
        decisionStage: application.decisionStage,
        ...(canReadProfileContext ? { cohort: await rosterCohort(ctx, project) } : {}),
        assignedReviewCount: application.assignedReviewCount,
        completedReviewCount: application.completedReviewCount,
        contentVersion: application.contentVersion,
        version: application.version,
        submittedAt: application.submittedAt,
        ...(application.humanDecision !== undefined
          ? { humanDecision: application.humanDecision }
          : {}),
        ...(application.humanReasonCode !== undefined
          ? { humanReasonCode: application.humanReasonCode }
          : {}),
        ...(application.aiDisposition !== undefined
          ? { aiDisposition: application.aiDisposition }
          : {}),
      },
      team: { id: team._id, name: team.name, memberCount: project.lockedMemberCount },
      project: {
        id: project._id,
        initialIdea: project.initialIdea,
        ...(project.additionalInformation !== undefined
          ? { additionalInformation: project.additionalInformation }
          : {}),
        intakeResponses: project.intakeResponses.map((response) => ({
          ordinal: response.ordinal,
          question: response.question,
          answer: response.answer,
        })),
      },
      policy: {
        id: policy._id,
        version: policy.version,
        minimumHumanReviews: policy.minimumHumanReviews,
        criteria: policy.criteria.map((criterion) => ({
          criterionKey: criterion.criterionKey,
          label: criterion.label,
          ...(canReadProfileContext
            ? {
                guidance: admissionGuidanceForBand(
                  criterion.guidanceByBand,
                  application.experienceBand,
                ),
              }
            : {}),
        })),
        decisionReasonCodes: policy.decisionReasonCodes,
      },
      aiRecommendation:
        canReadAiRecommendation &&
        recommendation &&
        recommendation.eventId === event._id &&
        recommendation.applicationId === application._id
          ? {
              id: recommendation._id,
              state: recommendation.state,
              ...(recommendation.recommendation !== undefined
                ? { recommendation: recommendation.recommendation }
                : {}),
              criterionAssessments: recommendation.criterionAssessments,
              strengths: recommendation.strengths,
              concerns: recommendation.concerns,
              ...(recommendation.confidence !== undefined
                ? { confidence: recommendation.confidence }
                : {}),
              limitations: recommendation.limitations,
              ...(recommendation.agentVersion !== undefined
                ? { agentVersion: recommendation.agentVersion }
                : {}),
              ...(recommendation.agentModel !== undefined
                ? { agentModel: recommendation.agentModel }
                : {}),
            }
          : null,
      aiRecommendationVisible: canReadAiRecommendation,
      aiRecommendationRerun:
        canRunAiRecommendation &&
        recommendation &&
        recommendation.eventId === event._id &&
        recommendation.applicationId === application._id &&
        admissionRecommendationCanRerun(application, recommendation)
          ? { recommendationId: recommendation._id }
          : null,
      humanReviews: reviewViews,
      ...(canManageAssignments ? { reviewAssignments } : {}),
      currentOffer:
        currentOffer &&
        currentOffer.eventId === event._id &&
        currentOffer.applicationId === application._id &&
        currentOffer.teamId === team._id
          ? {
              id: currentOffer._id,
              state: currentOffer.state,
              participantCount: currentOffer.participantCount,
              sentAt: currentOffer.sentAt,
              expiresAt: currentOffer.expiresAt,
              version: currentOffer.version,
            }
          : null,
      capacity: capacity ? { capacity: capacity.capacity, reserved: capacity.reserved } : null,
      permissions: {
        review: reviewGrantIds.length > 0,
        assign: assignmentGrantIds.length > 0,
        decide: decideGrantIds.length > 0,
        offerManage: offerGrantIds.length > 0,
        participantDeliveryRead,
      },
    };
  },
});

const reviewAssignmentEvidenceView = v.object({
  applicationContentVersion: v.number(),
  project: v.object({
    id: v.id("projectVersions"),
    version: v.number(),
    initialIdea: v.string(),
    additionalInformation: v.optional(v.string()),
    intakeResponses: v.array(
      v.object({
        ordinal: v.number(),
        question: v.string(),
        answer: v.string(),
      }),
    ),
  }),
  review: v.union(
    v.null(),
    v.object({
      id: v.id("admissionHumanReviews"),
      recommendation: admissionDecision,
      reasonCode: v.string(),
      note: v.optional(v.string()),
      createdAt: v.number(),
    }),
  ),
});

export const reviewAssignmentEvidence = query({
  args: {
    eventSlug: v.string(),
    applicationId: v.id("applications"),
    assignmentId: v.id("admissionReviewAssignments"),
  },
  returns: reviewAssignmentEvidenceView,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const [application, assignment] = await Promise.all([
      ctx.db.get(args.applicationId),
      ctx.db.get(args.assignmentId),
    ]);
    if (
      !application ||
      application.eventId !== event._id ||
      !assignment ||
      assignment.eventId !== event._id ||
      assignment.applicationId !== application._id
    ) {
      throw new ConvexError({
        code: "APPLICATION_REVIEW_ASSIGNMENT_NOT_FOUND",
        message: "That review assignment is unavailable.",
      });
    }
    const [fullReadGrantIds, reviewReadGrantIds] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "application.read",
        scopeType: "application",
        scopeId: application._id,
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "application.review.read",
        scopeType: "application",
        scopeId: application._id,
      }),
    ]);
    const canReadEvidence =
      fullReadGrantIds.length > 0 ||
      (reviewReadGrantIds.length > 0 && assignment.reviewerPersonId === person._id);
    if (!canReadEvidence) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account cannot read that historical review.",
      });
    }

    const currentProject = await ctx.db.get(application.submittedProjectVersionId);
    if (
      !currentProject ||
      currentProject.eventId !== event._id ||
      currentProject.teamId !== application.teamId
    ) {
      throw new Error("The current submitted project snapshot is missing.");
    }
    const projectVersion =
      currentProject.version -
      (application.contentVersion - assignment.applicationContentVersion);
    if (projectVersion < 1 || assignment.applicationContentVersion > application.contentVersion) {
      throw new Error("The assignment references an invalid application-content version.");
    }
    const [project, review] = await Promise.all([
      ctx.db
        .query("projectVersions")
        .withIndex("by_team_version", (index) =>
          index.eq("teamId", application.teamId).eq("version", projectVersion),
        )
        .unique(),
      ctx.db
        .query("admissionHumanReviews")
        .withIndex("by_application_reviewer_content_version", (index) =>
          index
            .eq("applicationId", application._id)
            .eq("reviewerPersonId", assignment.reviewerPersonId)
            .eq("applicationContentVersion", assignment.applicationContentVersion),
        )
        .order("desc")
        .first(),
    ]);
    if (!project || project.eventId !== event._id) {
      throw new Error("The historical submitted project snapshot is missing.");
    }

    return {
      applicationContentVersion: assignment.applicationContentVersion,
      project: {
        id: project._id,
        version: project.version,
        initialIdea: project.initialIdea,
        ...(project.additionalInformation !== undefined
          ? { additionalInformation: project.additionalInformation }
          : {}),
        intakeResponses: project.intakeResponses.map((response) => ({
          ordinal: response.ordinal,
          question: response.question,
          answer: response.answer,
        })),
      },
      review: review
        ? {
            id: review._id,
            recommendation: review.recommendation,
            reasonCode: review.reasonCode,
            ...(review.note !== undefined ? { note: review.note } : {}),
            createdAt: review.createdAt,
          }
        : null,
    };
  },
});

function normalizedReasonCode(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(normalized) || normalized.length > 60) {
    throw new ConvexError({
      code: "INVALID_REASON_CODE",
      message: "Choose a valid published reason code.",
    });
  }
  return normalized;
}

async function requirePolicyReason(
  ctx: QueryCtx | MutationCtx,
  application: Doc<"applications">,
  decision: NonNullable<Doc<"applications">["humanDecision"]>,
  value: string,
) {
  const normalized = normalizedReasonCode(value);
  const policy = await ctx.db.get(application.admissionPolicyVersionId);
  const reason = policy?.decisionReasonCodes.find((candidate) => candidate.key === normalized);
  if (
    !policy ||
    policy.eventId !== application.eventId ||
    policy.status !== "published" ||
    !reason?.allowedDecisions.some((allowed) => allowed === decision)
  ) {
    throw new ConvexError({
      code: "REASON_NOT_ALLOWED",
      message: "Choose a published reason that applies to this recommendation.",
    });
  }
  return normalized;
}

function decisionState(
  decision: Doc<"applications">["humanDecision"],
): Doc<"applications">["state"] {
  if (decision === "accept") return "accepted";
  if (decision === "waitlist") return "waitlisted";
  return "declined";
}

async function publishedCommunicationsPolicyId(ctx: QueryCtx | MutationCtx, eventId: Id<"events">) {
  const event = await ctx.db.get(eventId);
  const policyId = event?.publishedCommunicationsPolicyId;
  const policy = policyId ? await ctx.db.get(policyId) : null;
  if (!event || !policy || policy.eventId !== eventId || policy.status !== "published") {
    throw new ConvexError({
      code: "COMMUNICATIONS_POLICY_UNAVAILABLE",
      message: "Publish participant email templates before sending participant updates.",
    });
  }
  return policy._id;
}

async function applicationContext(
  ctx: QueryCtx | MutationCtx,
  args: { eventSlug: string; applicationId: Id<"applications"> },
) {
  const event = await requireEventBySlug(ctx, args.eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const application = await ctx.db.get(args.applicationId);
  if (!application || application.eventId !== event._id) {
    throw new ConvexError({ code: "APPLICATION_NOT_FOUND", message: "Application not found." });
  }
  return { event, person, subject, application };
}

const assignmentEmail = z.email().max(254);
const activeReviewAssignmentState: Doc<"admissionReviewAssignments">["state"] = "active";
const cancelledReviewAssignmentState: Doc<"admissionReviewAssignments">["state"] = "cancelled";

function exactAssignmentEmail(value: string) {
  const email = normalizeEmail(value);
  if (!assignmentEmail.safeParse(email).success) {
    throw new ConvexError({
      code: "INVALID_EMAIL",
      message: "Enter one complete event account email address.",
    });
  }
  return email;
}

function assignmentSourceId(assignmentId: Id<"admissionReviewAssignments">) {
  return assignmentId;
}

export async function createAdmissionReviewAssignment(
  ctx: MutationCtx,
  args: {
    application: Doc<"applications">;
    expectedApplicationVersion: number;
    reviewerSubject: Doc<"eventAccessSubjects">;
    assignedByPersonId: Id<"people">;
    now: number;
  },
) {
  if (args.application.version !== args.expectedApplicationVersion) {
    throw new ConvexError({
      code: "APPLICATION_CHANGED",
      message: "The application changed. Review it before assigning work.",
    });
  }
  if (
    args.application.state !== "submitted" &&
    args.application.state !== "under_review"
  ) {
    throw new ConvexError({
      code: "APPLICATION_NOT_REVIEWABLE",
      message: "This application no longer accepts ordinary review assignments.",
    });
  }
  if (
    args.reviewerSubject.eventId !== args.application.eventId ||
    args.reviewerSubject.status !== "active"
  ) {
    throw new ConvexError({
      code: "REVIEWER_NOT_ACTIVE",
      message: "Choose an active account in this event.",
    });
  }
  const [activeAssignment, activeReview] = await Promise.all([
    ctx.db
      .query("admissionReviewAssignments")
      .withIndex("by_application_reviewer_state", (index) =>
        index
          .eq("applicationId", args.application._id)
          .eq("reviewerPersonId", args.reviewerSubject.personId)
          .eq("state", "active"),
      )
      .unique(),
    ctx.db
      .query("admissionHumanReviews")
      .withIndex("by_application_reviewer_status", (index) =>
        index
          .eq("applicationId", args.application._id)
          .eq("reviewerPersonId", args.reviewerSubject.personId)
          .eq("status", "active"),
      )
      .unique(),
  ]);
  if (activeAssignment) {
    throw new ConvexError({
      code: "REVIEW_ALREADY_ASSIGNED",
      message: "That person already has this review assignment.",
    });
  }
  if (activeReview?.applicationContentVersion === args.application.contentVersion) {
    throw new ConvexError({
      code: "REVIEW_ALREADY_COMPLETED",
      message: "That person already reviewed the current application version.",
    });
  }
  const assignmentId = await ctx.db.insert("admissionReviewAssignments", {
    eventId: args.application.eventId,
    applicationId: args.application._id,
    applicationContentVersion: args.application.contentVersion,
    reviewerPersonId: args.reviewerSubject.personId,
    assignedByPersonId: args.assignedByPersonId,
    state: "active",
    version: 1,
    assignedAt: args.now,
  });
  const sourceId = assignmentSourceId(assignmentId);
  for (const permissionKey of ["application.review.read", "application.review"] as const) {
    await insertPermissionGrant(ctx, {
      eventId: args.application.eventId,
      personId: args.reviewerSubject.personId,
      eventAccessSubjectId: args.reviewerSubject._id,
      permissionKey,
      scopeType: "application",
      scopeId: args.application._id,
      sourceType: "application_assignment",
      sourceId,
      grantedByPersonId: args.assignedByPersonId,
      reason: "Assigned application review",
    });
  }
  await advanceAccessVersion(ctx, args.reviewerSubject._id, args.now);
  const applicationVersion = args.application.version + 1;
  await ctx.db.patch(args.application._id, {
    ...(args.application.state === "submitted" ? { state: "under_review" } : {}),
    assignedReviewCount: args.application.assignedReviewCount + 1,
    version: applicationVersion,
  });
  return { assignmentId, assignmentVersion: 1, applicationVersion };
}

export async function cancelAdmissionReviewAssignment(
  ctx: MutationCtx,
  args: {
    application: Doc<"applications">;
    expectedApplicationVersion: number;
    assignment: Doc<"admissionReviewAssignments">;
    expectedAssignmentVersion: number;
    cancelledByPersonId: Id<"people">;
    reason: string;
    now: number;
  },
) {
  if (args.application.version !== args.expectedApplicationVersion) {
    throw new ConvexError({
      code: "APPLICATION_CHANGED",
      message: "The application changed. Review it before cancelling the assignment.",
    });
  }
  if (
    args.assignment.eventId !== args.application.eventId ||
    args.assignment.applicationId !== args.application._id
  ) {
    throw new ConvexError({
      code: "ASSIGNMENT_NOT_FOUND",
      message: "Review assignment not found.",
    });
  }
  if (args.assignment.version !== args.expectedAssignmentVersion) {
    throw new ConvexError({
      code: "ASSIGNMENT_CHANGED",
      message: "The review assignment changed. Refresh before cancelling it.",
    });
  }
  if (args.assignment.state !== "active") {
    throw new ConvexError({
      code: "ASSIGNMENT_NOT_ACTIVE",
      message: "Only an active review assignment can be cancelled.",
    });
  }
  if (args.application.assignedReviewCount < 1) {
    throw new Error("Application assignment count is inconsistent.");
  }
  await ctx.db.patch(args.assignment._id, {
    state: "cancelled",
    version: args.assignment.version + 1,
    cancelledAt: args.now,
    cancelledByPersonId: args.cancelledByPersonId,
    cancellationReason: args.reason,
  });
  await revokeSourceGrants(ctx, {
    eventId: args.application.eventId,
    sourceType: "application_assignment",
    sourceId: assignmentSourceId(args.assignment._id),
    revokedByPersonId: args.cancelledByPersonId,
    reason: args.reason,
  });
  const applicationVersion = args.application.version + 1;
  await ctx.db.patch(args.application._id, {
    assignedReviewCount: args.application.assignedReviewCount - 1,
    version: applicationVersion,
  });
  return {
    assignmentVersion: args.assignment.version + 1,
    applicationVersion,
  };
}

const expiredReviewAssignmentBatchSize = 50;
const expiredReviewAssignmentReason =
  "The 30-minute review claim expired before a review was submitted.";

export const expireReviewAssignments = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const now = Date.now();
    const assignments = await ctx.db
      .query("admissionReviewAssignments")
      .withIndex("by_state_assigned", (index) =>
        index.eq("state", "active").lte("assignedAt", now - admissionReviewClaimMs),
      )
      .take(expiredReviewAssignmentBatchSize);
    for (const assignment of assignments) {
      const application = await ctx.db.get(assignment.applicationId);
      if (!application || application.eventId !== assignment.eventId) {
        throw new Error("The expiring review assignment context is missing.");
      }
      const result = await cancelAdmissionReviewAssignment(ctx, {
        application,
        expectedApplicationVersion: application.version,
        assignment,
        expectedAssignmentVersion: assignment.version,
        cancelledByPersonId: assignment.assignedByPersonId,
        reason: expiredReviewAssignmentReason,
        now,
      });
      await writeAuditEvent(ctx, {
        eventId: assignment.eventId,
        actorPersonId: assignment.assignedByPersonId,
        permissionKey: "application.assign",
        grantIds: [],
        scopeType: "application",
        scopeId: application._id,
        action: "admission.review_assignment_expired",
        targetType: "application",
        targetId: application._id,
        previousSummary: JSON.stringify({
          assignmentId: assignment._id,
          reviewerPersonId: assignment.reviewerPersonId,
          state: assignment.state,
          assignmentVersion: assignment.version,
        }),
        nextSummary: JSON.stringify({
          assignmentId: assignment._id,
          state: "cancelled",
          assignmentVersion: result.assignmentVersion,
          applicationVersion: result.applicationVersion,
        }),
        reason: expiredReviewAssignmentReason,
      });
    }
    if (assignments.length === expiredReviewAssignmentBatchSize) {
      await ctx.scheduler.runAfter(0, internal.admissions.expireReviewAssignments, {});
    }
    return null;
  },
});

export async function completeAdmissionReviewAssignment(
  ctx: MutationCtx,
  args: {
    application: Doc<"applications">;
    assignment: Doc<"admissionReviewAssignments">;
    reviewerPersonId: Id<"people">;
    now: number;
  },
) {
  if (
    args.assignment.eventId !== args.application.eventId ||
    args.assignment.applicationId !== args.application._id ||
    args.assignment.reviewerPersonId !== args.reviewerPersonId ||
    args.assignment.state !== "active"
  ) {
    throw new Error("Active application review assignment is inconsistent.");
  }
  await ctx.db.patch(args.assignment._id, {
    state: "completed",
    version: args.assignment.version + 1,
    completedAt: args.now,
  });
  return args.assignment._id;
}

export const assignReview = mutation({
  args: {
    eventSlug: v.string(),
    applicationId: v.id("applications"),
    expectedApplicationVersion: v.number(),
    reviewerEmail: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    assignmentId: v.id("admissionReviewAssignments"),
    assignmentState: admissionReviewAssignmentState,
    assignmentVersion: v.number(),
    applicationVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const { event, person, subject, application } = await applicationContext(ctx, args);
    const reviewerEmail = exactAssignmentEmail(args.reviewerEmail);
    const requestFingerprint = operationFingerprint([
      args.applicationId,
      args.expectedApplicationVersion,
      reviewerEmail,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.review_assignment.assign",
      requestFingerprint,
    });
    if (prior) {
      const assignmentId = ctx.db.normalizeId("admissionReviewAssignments", prior.targetId);
      if (!assignmentId) throw new Error("Prior review assignment result is invalid.");
      const [assignment, currentApplication] = await Promise.all([
        ctx.db.get(assignmentId),
        ctx.db.get(application._id),
      ]);
      if (!assignment || !currentApplication) {
        throw new Error("Prior review assignment no longer resolves.");
      }
      return {
        assignmentId,
        assignmentState: assignment.state,
        assignmentVersion: assignment.version,
        applicationVersion: currentApplication.version,
      };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.assign",
      scopeType: "application",
      scopeId: application._id,
    });
    const reviewerSubject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_email", (index) =>
        index.eq("eventId", event._id).eq("emailNormalized", reviewerEmail),
      )
      .unique();
    if (!reviewerSubject || reviewerSubject.status !== "active") {
      throw new ConvexError({
        code: "REVIEWER_NOT_ACTIVE",
        message: "No active event account uses that email address.",
      });
    }
    const now = Date.now();
    const result = await createAdmissionReviewAssignment(ctx, {
      application,
      expectedApplicationVersion: args.expectedApplicationVersion,
      reviewerSubject,
      assignedByPersonId: person._id,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.review_assignment.assign",
      requestFingerprint,
      targetType: "admission_review_assignment",
      targetId: result.assignmentId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "application.assign",
      grantIds,
      scopeType: "application",
      scopeId: application._id,
      action: "admission.review_assigned",
      targetType: "application",
      targetId: application._id,
      nextSummary: JSON.stringify({
        assignmentId: result.assignmentId,
        reviewerPersonId: reviewerSubject.personId,
        applicationVersion: result.applicationVersion,
      }),
      reason: "Assigned application review",
    });
    return {
      assignmentId: result.assignmentId,
      assignmentState: activeReviewAssignmentState,
      assignmentVersion: result.assignmentVersion,
      applicationVersion: result.applicationVersion,
    };
  },
});

export const cancelReviewAssignment = mutation({
  args: {
    eventSlug: v.string(),
    applicationId: v.id("applications"),
    expectedApplicationVersion: v.number(),
    assignmentId: v.id("admissionReviewAssignments"),
    expectedAssignmentVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    assignmentId: v.id("admissionReviewAssignments"),
    assignmentState: admissionReviewAssignmentState,
    assignmentVersion: v.number(),
    applicationVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const { event, person, subject, application } = await applicationContext(ctx, args);
    const reason = normalizedText(args.reason, "Cancellation reason", 3, 240);
    const requestFingerprint = operationFingerprint([
      args.applicationId,
      args.expectedApplicationVersion,
      args.assignmentId,
      args.expectedAssignmentVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.review_assignment.cancel",
      requestFingerprint,
    });
    if (prior) {
      const assignmentId = ctx.db.normalizeId("admissionReviewAssignments", prior.targetId);
      if (!assignmentId) throw new Error("Prior assignment cancellation is invalid.");
      const [assignment, currentApplication] = await Promise.all([
        ctx.db.get(assignmentId),
        ctx.db.get(application._id),
      ]);
      if (!assignment || !currentApplication) {
        throw new Error("Prior assignment cancellation no longer resolves.");
      }
      return {
        assignmentId,
        assignmentState: assignment.state,
        assignmentVersion: assignment.version,
        applicationVersion: currentApplication.version,
      };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.assign",
      scopeType: "application",
      scopeId: application._id,
    });
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) {
      throw new ConvexError({
        code: "ASSIGNMENT_NOT_FOUND",
        message: "Review assignment not found.",
      });
    }
    const now = Date.now();
    const result = await cancelAdmissionReviewAssignment(ctx, {
      application,
      expectedApplicationVersion: args.expectedApplicationVersion,
      assignment,
      expectedAssignmentVersion: args.expectedAssignmentVersion,
      cancelledByPersonId: person._id,
      reason,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.review_assignment.cancel",
      requestFingerprint,
      targetType: "admission_review_assignment",
      targetId: assignment._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "application.assign",
      grantIds,
      scopeType: "application",
      scopeId: application._id,
      action: "admission.review_assignment_cancelled",
      targetType: "application",
      targetId: application._id,
      previousSummary: JSON.stringify({
        assignmentId: assignment._id,
        reviewerPersonId: assignment.reviewerPersonId,
        state: assignment.state,
      }),
      nextSummary: JSON.stringify({
        state: "cancelled",
        applicationVersion: result.applicationVersion,
      }),
      reason,
    });
    return {
      assignmentId: assignment._id,
      assignmentState: cancelledReviewAssignmentState,
      assignmentVersion: result.assignmentVersion,
      applicationVersion: result.applicationVersion,
    };
  },
});

export async function saveAdmissionHumanReview(
  ctx: MutationCtx,
  args: {
    application: Doc<"applications">;
    expectedApplicationContentVersion: number;
    reviewerPersonId: Id<"people">;
    recommendation: NonNullable<Doc<"admissionHumanReviews">["recommendation"]>;
    reasonCode: string;
    note?: string;
    now: number;
  },
) {
  if (args.application.contentVersion !== args.expectedApplicationContentVersion) {
    throw new ConvexError({
      code: "APPLICATION_CONTENT_CHANGED",
      message: "The application content changed. Read the current version before saving.",
    });
  }
  if (
    args.application.state !== "submitted" &&
    args.application.state !== "under_review"
  ) {
    throw new ConvexError({
      code: "APPLICATION_DECIDED",
      message: "This application no longer accepts ordinary reviews.",
    });
  }
  const [activeReview, activeAssignment] = await Promise.all([
    ctx.db
      .query("admissionHumanReviews")
      .withIndex("by_application_reviewer_status", (index) =>
        index
          .eq("applicationId", args.application._id)
          .eq("reviewerPersonId", args.reviewerPersonId)
          .eq("status", "active"),
      )
      .unique(),
    ctx.db
      .query("admissionReviewAssignments")
      .withIndex("by_application_reviewer_state", (index) =>
        index
          .eq("applicationId", args.application._id)
          .eq("reviewerPersonId", args.reviewerPersonId)
          .eq("state", "active"),
      )
      .unique(),
  ]);
  const replacesCurrentReview =
    activeReview?.applicationContentVersion === args.application.contentVersion;
  if (
    activeAssignment &&
    activeAssignment.assignedAt + admissionReviewClaimMs <= args.now
  ) {
    throw new ConvexError({
      code: "REVIEW_ASSIGNMENT_EXPIRED",
      message: "This 30-minute review assignment expired. Ask a coordinator to assign it again.",
    });
  }
  if (activeReview) await ctx.db.patch(activeReview._id, { status: "superseded" });
  const note = optionalNormalizedText(args.note, "Review note", 600);
  const reviewReasonCode = await requirePolicyReason(
    ctx,
    args.application,
    args.recommendation,
    args.reasonCode,
  );
  const reviewId = await ctx.db.insert("admissionHumanReviews", {
    eventId: args.application.eventId,
    applicationId: args.application._id,
    applicationContentVersion: args.application.contentVersion,
    reviewerPersonId: args.reviewerPersonId,
    recommendation: args.recommendation,
    reasonCode: reviewReasonCode,
    ...(note !== undefined ? { note } : {}),
    status: "active",
    createdAt: args.now,
  });
  if (activeAssignment) {
    await completeAdmissionReviewAssignment(ctx, {
      application: args.application,
      assignment: activeAssignment,
      reviewerPersonId: args.reviewerPersonId,
      now: args.now,
    });
  }
  const applicationVersion = args.application.version + 1;
  await ctx.db.patch(args.application._id, {
    ...(args.application.state === "submitted" ? { state: "under_review" } : {}),
    completedReviewCount: args.application.completedReviewCount + (replacesCurrentReview ? 0 : 1),
    version: applicationVersion,
  });
  return {
    reviewId,
    reviewReasonCode,
    completedAssignmentId: activeAssignment?._id,
    applicationVersion,
  };
}

export const saveReview = mutation({
  args: {
    eventSlug: v.string(),
    applicationId: v.id("applications"),
    expectedApplicationContentVersion: v.number(),
    recommendation: admissionDecision,
    reasonCode: v.string(),
    note: v.optional(v.string()),
    clientOperationId: v.string(),
  },
  returns: v.object({
    reviewId: v.id("admissionHumanReviews"),
    applicationVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const { event, person, subject, application } = await applicationContext(ctx, args);
    const requestFingerprint = operationFingerprint([
      args.applicationId,
      args.expectedApplicationContentVersion,
      args.recommendation,
      args.reasonCode,
      args.note ?? null,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.review.save",
      requestFingerprint,
    });
    if (prior) {
      const reviewId = ctx.db.normalizeId("admissionHumanReviews", prior.targetId);
      if (!reviewId) throw new Error("Prior admission review result is invalid.");
      return {
        reviewId,
        applicationVersion: storedOperationVersion(prior.resultJson, "admission-review"),
      };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.review",
      scopeType: "application",
      scopeId: application._id,
    });
    const now = Date.now();
    const result = await saveAdmissionHumanReview(ctx, {
      application,
      expectedApplicationContentVersion: args.expectedApplicationContentVersion,
      reviewerPersonId: person._id,
      recommendation: args.recommendation,
      reasonCode: args.reasonCode,
      ...(args.note !== undefined ? { note: args.note } : {}),
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.review.save",
      requestFingerprint,
      targetType: "admission_human_review",
      targetId: result.reviewId,
      resultJson: String(result.applicationVersion),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "application.review",
      grantIds,
      scopeType: "application",
      scopeId: application._id,
      action: "admission.human_review_saved",
      targetType: "application",
      targetId: application._id,
      nextSummary: JSON.stringify({
        recommendation: args.recommendation,
        reasonCode: result.reviewReasonCode,
        completedAssignmentId: result.completedAssignmentId ?? null,
        applicationVersion: result.applicationVersion,
      }),
      reason: "Saved an independent human admission review",
    });
    return {
      reviewId: result.reviewId,
      applicationVersion: result.applicationVersion,
    };
  },
});

const rerunnableAdmissionRecommendationStates = new Set<Doc<"admissionAIRecommendations">["state"]>(
  [
    "succeeded",
    "refused",
    "invalid",
    "timed_out",
    "rate_limited",
    "failed",
    "stale",
    "disabled",
  ],
);

export function admissionRecommendationCanRerun(
  application: Doc<"applications">,
  recommendation: Doc<"admissionAIRecommendations">,
) {
  return (
    (application.state === "submitted" || application.state === "under_review") &&
    application.aiRecommendationId === recommendation._id &&
    recommendation.eventId === application.eventId &&
    recommendation.applicationId === application._id &&
    recommendation.teamId === application.teamId &&
    recommendation.projectVersionId === application.submittedProjectVersionId &&
    recommendation.admissionPolicyVersionId === application.admissionPolicyVersionId &&
    recommendation.applicationContentVersion === application.contentVersion &&
    rerunnableAdmissionRecommendationStates.has(recommendation.state)
  );
}

export async function createAdmissionRecommendationRerun(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    application: Doc<"applications">;
    currentRecommendation: Doc<"admissionAIRecommendations">;
    expectedApplicationVersion: number;
    expectedRecommendationId: Id<"admissionAIRecommendations">;
    now: number;
  },
) {
  if (args.application.version !== args.expectedApplicationVersion) {
    throw new ConvexError({
      code: "APPLICATION_CHANGED",
      message: "The application changed. Review it before retrying the analysis.",
    });
  }
  if (
    args.expectedRecommendationId !== args.currentRecommendation._id ||
    !admissionRecommendationCanRerun(args.application, args.currentRecommendation)
  ) {
    throw new ConvexError({
      code: "ADMISSION_ANALYSIS_NOT_RETRYABLE",
      message:
        "This analysis is current, still running, or no longer part of active admission review.",
    });
  }
  const admissionConfiguration = await loadPublishedAdmissionConfiguration(ctx, args.event);
  if (
    admissionConfiguration.policy._id !== args.application.admissionPolicyVersionId ||
    !admissionConfiguration.model
  ) {
    throw new ConvexError({
      code: "ADMISSION_ANALYSIS_UNAVAILABLE",
      message: "The published admission policy does not have an available AI release.",
    });
  }
  const project = await ctx.db.get(args.application.submittedProjectVersionId);
  if (
    !project ||
    project.eventId !== args.event._id ||
    project.teamId !== args.application.teamId ||
    project.admissionPolicyVersionId !== args.application.admissionPolicyVersionId
  ) {
    throw new Error("The submitted project does not match its admission application.");
  }
  const recommendationId = await createAdmissionRecommendation(ctx, {
    application: args.application,
    project,
    policy: admissionConfiguration.policy,
    modelConfig: admissionConfiguration.model,
    now: args.now,
  });
  const applicationVersion = args.application.version + 1;
  await ctx.db.patch(args.application._id, { version: applicationVersion });
  return { recommendationId, applicationVersion };
}

export const rerunAiRecommendation = mutation({
  args: {
    eventSlug: v.string(),
    applicationId: v.id("applications"),
    expectedApplicationVersion: v.number(),
    expectedRecommendationId: v.id("admissionAIRecommendations"),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    recommendationId: v.id("admissionAIRecommendations"),
    applicationVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const { event, person, subject, application } = await applicationContext(ctx, args);
    const reason = normalizedLongText(args.reason, "Retry reason", 8, 240);
    const requestFingerprint = operationFingerprint([
      args.applicationId,
      args.expectedApplicationVersion,
      args.expectedRecommendationId,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.ai_recommendation.rerun",
      requestFingerprint,
    });
    if (prior) {
      const recommendationId = ctx.db.normalizeId("admissionAIRecommendations", prior.targetId);
      if (!recommendationId) throw new Error("Prior admission-analysis retry is invalid.");
      return {
        recommendationId,
        applicationVersion: storedOperationVersion(prior.resultJson, "admission-analysis retry"),
      };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.ai_recommendation.run",
      scopeType: "application",
      scopeId: application._id,
    });
    const currentRecommendation = await ctx.db.get(args.expectedRecommendationId);
    if (!currentRecommendation) {
      throw new ConvexError({
        code: "ADMISSION_ANALYSIS_NOT_FOUND",
        message: "The admission analysis is no longer available.",
      });
    }
    const now = Date.now();
    const result = await createAdmissionRecommendationRerun(ctx, {
      event,
      application,
      currentRecommendation,
      expectedApplicationVersion: args.expectedApplicationVersion,
      expectedRecommendationId: args.expectedRecommendationId,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.ai_recommendation.rerun",
      requestFingerprint,
      targetType: "admission_ai_recommendation",
      targetId: result.recommendationId,
      resultJson: String(result.applicationVersion),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "application.ai_recommendation.run",
      grantIds,
      scopeType: "application",
      scopeId: application._id,
      action: "admission.ai_recommendation_rerun",
      targetType: "application",
      targetId: application._id,
      previousSummary: JSON.stringify({
        recommendationId: currentRecommendation._id,
        state: currentRecommendation.state,
        applicationVersion: application.version,
      }),
      nextSummary: JSON.stringify({
        recommendationId: result.recommendationId,
        state: "pending",
        applicationVersion: result.applicationVersion,
      }),
      reason,
    });
    return result;
  },
});

const aiDisposition = v.union(
  v.literal("used"),
  v.literal("cleared"),
  v.literal("overridden"),
  v.literal("stale"),
  v.literal("unavailable"),
);

async function reserveAdmissionCapacity(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    application: Doc<"applications">;
    project: Doc<"projectVersions">;
    policy: Doc<"admissionPolicyVersions">;
    offerId: Id<"admissionOffers">;
    now: number;
  },
) {
  const existing = await ctx.db
    .query("admissionCapacityReservations")
    .withIndex("by_application_state", (index) =>
      index.eq("applicationId", args.application._id).eq("state", "active"),
    )
    .unique();
  if (existing) {
    throw new ConvexError({
      code: "ADMISSION_CAPACITY_ALREADY_RESERVED",
      message: "This application already has an active admission reservation.",
    });
  }
  const participantCount = args.project.lockedMemberCount;
  const overall = await ctx.db
    .query("admissionCapacityBuckets")
    .withIndex("by_policy", (index) => index.eq("admissionPolicyVersionId", args.policy._id))
    .unique();
  if (!overall || overall.eventId !== args.eventId) {
    throw new Error("Published admission capacity is missing.");
  }
  if (overall.reserved + participantCount > overall.capacity) {
    throw new ConvexError({
      code: "ADMISSION_CAPACITY_FULL",
      message: "Sending this offer would exceed the published participant capacity.",
    });
  }
  await ctx.db.patch(overall._id, {
    reserved: overall.reserved + participantCount,
    version: overall.version + 1,
    updatedAt: args.now,
  });
  await ctx.db.insert("admissionCapacityReservations", {
    eventId: args.eventId,
    applicationId: args.application._id,
    offerId: args.offerId,
    admissionPolicyVersionId: args.policy._id,
    participantCount,
    state: "active",
    reservedAt: args.now,
  });
}

type CapacityReleaseReason = NonNullable<Doc<"admissionCapacityReservations">["releasedReason"]>;

async function releaseAdmissionCapacity(
  ctx: MutationCtx,
  args: {
    offer: Doc<"admissionOffers">;
    reason: CapacityReleaseReason;
    releasedByPersonId?: Id<"people">;
    now: number;
  },
) {
  const reservation = await ctx.db
    .query("admissionCapacityReservations")
    .withIndex("by_application_state", (index) =>
      index.eq("applicationId", args.offer.applicationId).eq("state", "active"),
    )
    .unique();
  if (!reservation || reservation.offerId !== args.offer._id) {
    throw new Error("The active admission reservation does not match this offer.");
  }
  const overall = await ctx.db
    .query("admissionCapacityBuckets")
    .withIndex("by_policy", (index) =>
      index.eq("admissionPolicyVersionId", reservation.admissionPolicyVersionId),
    )
    .unique();
  if (!overall || overall.eventId !== args.offer.eventId) {
    throw new Error("The overall admission capacity bucket is missing.");
  }
  if (overall.reserved < reservation.participantCount) {
    throw new Error("The overall admission reservation count is inconsistent.");
  }
  await ctx.db.patch(overall._id, {
    reserved: overall.reserved - reservation.participantCount,
    version: overall.version + 1,
    updatedAt: args.now,
  });
  await ctx.db.patch(reservation._id, {
    state: "released",
    releasedAt: args.now,
    releasedReason: args.reason,
    ...(args.releasedByPersonId !== undefined
      ? { releasedByPersonId: args.releasedByPersonId }
      : {}),
  });
}

const admissionDecisionOperationResult = z
  .object({
    state: z.literal("under_review"),
    applicationVersion: z.number().int().positive(),
  })
  .strict();

export const decide = mutation({
  args: {
    eventSlug: v.string(),
    applicationId: v.id("applications"),
    expectedApplicationVersion: v.number(),
    decision: admissionDecision,
    reasonCode: v.string(),
    aiDisposition,
    clientOperationId: v.string(),
  },
  returns: v.object({
    applicationId: v.id("applications"),
    state: applicationState,
    applicationVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const { event, person, subject, application } = await applicationContext(ctx, args);
    const requestFingerprint = operationFingerprint([
      args.applicationId,
      args.expectedApplicationVersion,
      args.decision,
      args.reasonCode,
      args.aiDisposition,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.decision.record",
      requestFingerprint,
    });
    if (prior) {
      const replayApplicationId = ctx.db.normalizeId("applications", prior.targetId);
      if (!replayApplicationId) throw new Error("Prior admission decision is invalid.");
      const stored = storedOperationResult(
        prior.resultJson,
        "admission-decision",
        admissionDecisionOperationResult,
      );
      return {
        applicationId: replayApplicationId,
        state: stored.state,
        applicationVersion: stored.applicationVersion,
      };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.decide",
      scopeType: "application",
      scopeId: application._id,
    });
    if (Date.now() < event.applicationsCloseAt) {
      throw new ConvexError({
        code: "APPLICATIONS_STILL_OPEN",
        message: "Record admission decisions after the application deadline.",
      });
    }
    if (event.admissionResultsReleasedAt !== undefined) {
      throw new ConvexError({
        code: "ADMISSION_RESULTS_RELEASED",
        message: "Admission results have already been released and cannot be changed.",
      });
    }
    const aiReadGrantIds = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.ai_recommendation.read",
      scopeType: "application",
      scopeId: application._id,
    });
    const canReadAiRecommendation = aiReadGrantIds.length > 0;
    if (application.version !== args.expectedApplicationVersion) {
      throw new ConvexError({
        code: "APPLICATION_CHANGED",
        message: "The application changed. Review it before recording a decision.",
      });
    }
    if (["accepted", "waitlisted", "declined", "withdrawn"].includes(application.state)) {
      throw new ConvexError({
        code: "APPLICATION_DECIDED",
        message: "This application already has a released terminal decision.",
      });
    }
    const [project, policy, recommendation, reviews] = await Promise.all([
      ctx.db.get(application.submittedProjectVersionId),
      ctx.db.get(application.admissionPolicyVersionId),
      canReadAiRecommendation && application.aiRecommendationId
        ? ctx.db.get(application.aiRecommendationId)
        : Promise.resolve(null),
      ctx.db
        .query("admissionHumanReviews")
        .withIndex("by_application_status", (index) =>
          index.eq("applicationId", application._id).eq("status", "active"),
        )
        .collect(),
    ]);
    if (!project || !policy || policy.status !== "published") {
      throw new Error("Application policy context is missing.");
    }
    const currentReviews = reviews.filter(
      (review) => review.applicationContentVersion === application.contentVersion,
    );
    if (currentReviews.length !== application.completedReviewCount) {
      throw new Error("Application completed-review count is inconsistent.");
    }
    if (currentReviews.length < policy.minimumHumanReviews) {
      throw new ConvexError({
        code: "HUMAN_REVIEW_INCOMPLETE",
        message: `At least ${policy.minimumHumanReviews} independent human review${policy.minimumHumanReviews === 1 ? " is" : "s are"} required.`,
      });
    }
    const currentRecommendation = Boolean(
      recommendation &&
      recommendation.state === "succeeded" &&
      recommendation.applicationContentVersion === application.contentVersion &&
      recommendation.projectVersionId === project._id &&
      recommendation.admissionPolicyVersionId === policy._id &&
      recommendation.recommendation,
    );
    if (currentRecommendation && recommendation?.recommendation) {
      if (args.aiDisposition === "stale" || args.aiDisposition === "unavailable") {
        throw new ConvexError({
          code: "AI_DISPOSITION_INVALID",
          message: "The current AI recommendation must be used, cleared, or explicitly overridden.",
        });
      }
      const differs = recommendation.recommendation !== args.decision;
      if (
        (args.aiDisposition === "used" && differs) ||
        (args.aiDisposition === "overridden" && !differs)
      ) {
        throw new ConvexError({
          code: "AI_OVERRIDE_REQUIRED",
          message:
            args.aiDisposition === "used"
              ? "Mark a different human decision as overridden, or clear the AI recommendation."
              : "Override is only used when the human decision differs from the AI recommendation.",
        });
      }
    } else if (
      args.aiDisposition !==
      (canReadAiRecommendation && recommendation?.state === "stale" ? "stale" : "unavailable")
    ) {
      throw new ConvexError({
        code: "AI_DISPOSITION_INVALID",
        message: "Record the unavailable or stale AI state before saving the decision.",
      });
    }
    const now = Date.now();
    const decisionReasonCode = await requirePolicyReason(
      ctx,
      application,
      args.decision,
      args.reasonCode,
    );
    const state = "under_review" as const;
    const decisionStage = "recorded" as const;
    const applicationVersion = application.version + 1;
    await ctx.db.patch(application._id, {
      state,
      decisionStage,
      humanDecision: args.decision,
      humanReasonCode: decisionReasonCode,
      aiDisposition: args.aiDisposition,
      decidedByPersonId: person._id,
      decidedAt: now,
      version: applicationVersion,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.decision.record",
      requestFingerprint,
      targetType: "application",
      targetId: application._id,
      resultJson: JSON.stringify({ state, applicationVersion }),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "application.decide",
      grantIds,
      scopeType: "application",
      scopeId: application._id,
      action: "admission.human_decision_recorded",
      targetType: "application",
      targetId: application._id,
      previousSummary: JSON.stringify({ state: application.state, version: application.version }),
      nextSummary: JSON.stringify({
        state,
        decisionStage,
        decision: args.decision,
        reasonCode: decisionReasonCode,
        aiDisposition: args.aiDisposition,
        humanReviewCount: currentReviews.length,
        version: applicationVersion,
      }),
      reason: "Recorded the human admission decision for Supreme release",
    });
    return {
      applicationId: application._id,
      state,
      applicationVersion,
    };
  },
});

const offerMutationResult = v.object({
  offerId: v.id("admissionOffers"),
  offerState: admissionOfferState,
  offerVersion: v.number(),
  applicationState,
  applicationVersion: v.number(),
});

const offerOperationResult = z
  .object({
    offerState: z.enum(["offered", "confirmed", "declined", "expired", "revoked"]),
    offerVersion: z.number().int().positive(),
    applicationState: z.enum(["accepted", "offer_sent", "confirmed", "offer_expired", "withdrawn"]),
    applicationVersion: z.number().int().positive(),
  })
  .strict();

function offerResult(offer: Doc<"admissionOffers">, application: Doc<"applications">) {
  return {
    offerId: offer._id,
    offerState: offer.state,
    offerVersion: offer.version,
    applicationState: application.state,
    applicationVersion: application.version,
  };
}

function offerOperationResultJson(result: ReturnType<typeof offerResult>) {
  return JSON.stringify({
    offerState: result.offerState,
    offerVersion: result.offerVersion,
    applicationState: result.applicationState,
    applicationVersion: result.applicationVersion,
  });
}

function storedOfferOperationResult(
  ctx: MutationCtx,
  targetId: string,
  resultJson: string | undefined,
) {
  const offerId = ctx.db.normalizeId("admissionOffers", targetId);
  if (!offerId) throw new Error("The stored admission offer result is invalid.");
  return {
    offerId,
    ...storedOperationResult(resultJson, "admission-offer", offerOperationResult),
  };
}

function requireOfferExpiry(event: Doc<"events">, expiresAt: number, now: number) {
  const latestAllowedExpiry = Math.min(
    event.startsAt ?? now + 30 * 24 * 60 * 60 * 1_000,
    now + 30 * 24 * 60 * 60 * 1_000,
  );
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > latestAllowedExpiry) {
    throw new ConvexError({
      code: "INVALID_OFFER_EXPIRY",
      message: "Choose a future offer deadline no later than the event start or 30 days from now.",
    });
  }
}

async function requireActiveOfferReservation(ctx: MutationCtx, offer: Doc<"admissionOffers">) {
  const reservation = await ctx.db
    .query("admissionCapacityReservations")
    .withIndex("by_application_state", (index) =>
      index.eq("applicationId", offer.applicationId).eq("state", "active"),
    )
    .unique();
  if (
    !reservation ||
    reservation.offerId !== offer._id ||
    reservation.eventId !== offer.eventId ||
    reservation.participantCount !== offer.participantCount
  ) {
    throw new Error("The offer does not have its exact active capacity reservation.");
  }
  return reservation;
}

type OfferTransition = "confirmed" | "declined" | "expired" | "revoked";

export async function transitionOffer(
  ctx: MutationCtx,
  args: {
    application: Doc<"applications">;
    offer: Doc<"admissionOffers">;
    project: Doc<"projectVersions">;
    team: Doc<"teams">;
    transition: OfferTransition;
    actorPersonId?: Id<"people">;
    reason: string;
    now: number;
  },
) {
  if (
    args.application.currentOfferId !== args.offer._id ||
    args.application.state !== "offer_sent" ||
    args.offer.state !== "offered" ||
    args.offer.applicationId !== args.application._id ||
    args.offer.teamId !== args.team._id ||
    args.project._id !== args.application.submittedProjectVersionId ||
    args.project.teamId !== args.team._id ||
    args.team.lockedProjectVersionId !== args.project._id ||
    args.offer.lockedRosterSnapshotId !== args.project.lockedRosterSnapshotId ||
    args.offer.participantCount !== args.project.lockedMemberCount
  ) {
    throw new Error("The application, offer, team, and locked roster do not match.");
  }
  await requireActiveOfferReservation(ctx, args.offer);
  if (args.transition !== "confirmed") {
    const releaseReason: CapacityReleaseReason =
      args.transition === "declined"
        ? "offer_declined"
        : args.transition === "expired"
          ? "offer_expired"
          : "offer_revoked";
    await releaseAdmissionCapacity(ctx, {
      offer: args.offer,
      reason: releaseReason,
      ...(args.actorPersonId !== undefined ? { releasedByPersonId: args.actorPersonId } : {}),
      now: args.now,
    });
  }

  const applicationStateAfter: Doc<"applications">["state"] =
    args.transition === "confirmed"
      ? "confirmed"
      : args.transition === "declined"
        ? "withdrawn"
        : args.transition === "expired"
          ? "offer_expired"
          : "accepted";
  const teamStatusAfter: Doc<"teams">["status"] =
    args.transition === "confirmed"
      ? "confirmed"
      : args.transition === "revoked"
        ? "admitted"
        : "withdrawn";
  const offerVersion = args.offer.version + 1;
  const applicationVersion = args.application.version + 1;

  await ctx.db.patch(args.offer._id, {
    state: args.transition,
    ...(args.actorPersonId !== undefined ? { decidedByPersonId: args.actorPersonId } : {}),
    decidedAt: args.now,
    decisionReason: args.reason,
    version: offerVersion,
  });
  await ctx.db.patch(args.application._id, {
    state: applicationStateAfter,
    ...(args.transition === "revoked" ? { currentOfferId: undefined } : {}),
    version: applicationVersion,
  });
  await ctx.db.patch(args.team._id, {
    status: teamStatusAfter,
    version: args.team.version + 1,
    updatedAt: args.now,
  });
  const onboardingStatusAfter: Doc<"eventMemberships">["onboardingStatus"] =
    args.transition === "confirmed"
      ? "accepted"
      : args.transition === "revoked"
        ? "selected"
        : "submitted";
  const communicationsPolicyVersionId =
    args.transition === "revoked"
      ? undefined
      : await publishedCommunicationsPolicyId(ctx, args.offer.eventId);
  await ctx.scheduler.runAfter(0, internal.admissions.updateRosterOnboardingStatus, {
    applicationId: args.application._id,
    expectedApplicationVersion: applicationVersion,
    lockedRosterSnapshotId: args.offer.lockedRosterSnapshotId,
    onboardingStatus: onboardingStatusAfter,
    cursor: null,
    ...(args.transition === "confirmed" && communicationsPolicyVersionId
      ? { externalPassCommunicationsPolicyVersionId: communicationsPolicyVersionId }
      : {}),
  });
  if (args.transition === "confirmed") {
    await initializeAttendanceTeamAvailability(ctx, {
      eventId: args.offer.eventId,
      teamId: args.team._id,
      activeMemberCount: args.offer.participantCount,
      now: args.now,
    });
  }

  if (args.transition !== "revoked") {
    const templateKey =
      args.transition === "confirmed"
        ? "offer_confirmed"
        : args.transition === "declined"
          ? "offer_declined"
          : "offer_expired";
    if (!communicationsPolicyVersionId) {
      throw new Error("The participant communications policy is unavailable.");
    }
    await enqueueApplicationNotifications(ctx, {
      eventId: args.offer.eventId,
      applicationId: args.application._id,
      teamId: args.team._id,
      lockedRosterSnapshotId: args.project.lockedRosterSnapshotId,
      lockedMemberCount: args.project.lockedMemberCount,
      communicationsPolicyVersionId,
      templateKey,
      applicationVersion,
      now: args.now,
    });
  }

  const updatedOffer = await ctx.db.get(args.offer._id);
  const updatedApplication = await ctx.db.get(args.application._id);
  if (!updatedOffer || !updatedApplication) {
    throw new Error("The offer transition did not persist.");
  }
  return { offer: updatedOffer, application: updatedApplication };
}

export async function createAdmissionOffer(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    application: Doc<"applications">;
    project: Doc<"projectVersions">;
    policy: Doc<"admissionPolicyVersions">;
    team: Doc<"teams">;
    actorPersonId: Id<"people">;
    grantIds: Id<"permissionGrants">[];
    expiresAt: number;
    now: number;
  },
) {
  if (
    args.application.state !== "accepted" ||
    args.application.currentOfferId !== undefined ||
    args.application.eventId !== args.event._id ||
    args.project._id !== args.application.submittedProjectVersionId ||
    args.project.teamId !== args.team._id ||
    args.policy._id !== args.application.admissionPolicyVersionId ||
    args.policy.eventId !== args.event._id ||
    args.policy.status !== "published" ||
    args.team._id !== args.application.teamId ||
    args.team.status !== "admitted" ||
    args.team.lockedProjectVersionId !== args.project._id
  ) {
    throw new Error("The accepted application context is incomplete.");
  }
  requireOfferExpiry(args.event, args.expiresAt, args.now);
  const offerId = await ctx.db.insert("admissionOffers", {
    eventId: args.event._id,
    applicationId: args.application._id,
    teamId: args.team._id,
    lockedRosterSnapshotId: args.project.lockedRosterSnapshotId,
    participantCount: args.project.lockedMemberCount,
    source: "accepted_decision",
    state: "offered",
    sentAt: args.now,
    expiresAt: args.expiresAt,
    createdByPersonId: args.actorPersonId,
    createdByGrantIds: args.grantIds,
    version: 1,
  });
  await reserveAdmissionCapacity(ctx, {
    eventId: args.event._id,
    application: args.application,
    project: args.project,
    policy: args.policy,
    offerId,
    now: args.now,
  });
  const applicationVersion = args.application.version + 1;
  await ctx.db.patch(args.application._id, {
    state: "offer_sent",
    currentOfferId: offerId,
    version: applicationVersion,
  });
  await ctx.scheduler.runAfter(0, internal.admissions.updateRosterOnboardingStatus, {
    applicationId: args.application._id,
    expectedApplicationVersion: applicationVersion,
    lockedRosterSnapshotId: args.project.lockedRosterSnapshotId,
    onboardingStatus: "offer_pending",
    cursor: null,
  });
  const communicationsPolicyVersionId = await publishedCommunicationsPolicyId(ctx, args.event._id);
  await enqueueApplicationNotifications(ctx, {
    eventId: args.event._id,
    applicationId: args.application._id,
    teamId: args.team._id,
    lockedRosterSnapshotId: args.project.lockedRosterSnapshotId,
    lockedMemberCount: args.project.lockedMemberCount,
    communicationsPolicyVersionId,
    templateKey: "offer",
    applicationVersion,
    now: args.now,
  });
  await ctx.scheduler.runAt(args.expiresAt, internal.admissions.expireOffer, {
    offerId,
    expectedOfferVersion: 1,
  });
  const offer = await ctx.db.get(offerId);
  const updatedApplication = await ctx.db.get(args.application._id);
  if (!offer || !updatedApplication) throw new Error("The admission offer did not persist.");
  return { offer, application: updatedApplication };
}

const rosterOnboardingStatus = v.union(
  v.literal("submitted"),
  v.literal("selected"),
  v.literal("offer_pending"),
  v.literal("accepted"),
);

export const finalizeReleasedAdmissionResults = internalMutation({
  args: {
    eventId: v.id("events"),
    releasedAt: v.number(),
    releasedByPersonId: v.id("people"),
    communicationsPolicyVersionId: v.id("communicationsPolicyVersions"),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const event = await ctx.db.get(args.eventId);
    if (
      !event ||
      event.admissionResultsReleasedAt !== args.releasedAt ||
      event.admissionResultsReleasedByPersonId !== args.releasedByPersonId ||
      event.admissionResultsCommunicationsPolicyId !== args.communicationsPolicyVersionId
    ) {
      return null;
    }
    const applications = await ctx.db
      .query("applications")
      .withIndex("by_event_decision_stage", (index) =>
        index.eq("eventId", args.eventId).eq("decisionStage", "recorded"),
      )
      .take(25);
    const now = Date.now();
    for (const application of applications) {
      if (application.state === "withdrawn") {
        await ctx.db.patch(application._id, {
          decisionStage: "released",
          releasedByPersonId: args.releasedByPersonId,
          releasedAt: args.releasedAt,
          version: application.version + 1,
        });
        await synchronizeTeamAdmissionIdeaComparison(ctx, {
          eventId: application.eventId,
          teamId: application.teamId,
        });
        continue;
      }
      const decision = application.humanDecision;
      if (!decision) {
        throw new Error("A released admission result has no terminal decision.");
      }
      const [project, team] = await Promise.all([
        ctx.db.get(application.submittedProjectVersionId),
        ctx.db.get(application.teamId),
      ]);
      if (
        !project ||
        !team ||
        project.eventId !== args.eventId ||
        project.teamId !== team._id ||
        team.lockedProjectVersionId !== project._id
      ) {
        throw new Error("A released admission result has invalid locked team context.");
      }
      const applicationVersion = application.version + 1;
      await ctx.db.patch(application._id, {
        state: decisionState(decision),
        decisionStage: "released",
        releasedByPersonId: args.releasedByPersonId,
        releasedAt: args.releasedAt,
        version: applicationVersion,
      });
      await synchronizeTeamAdmissionIdeaComparison(ctx, {
        eventId: application.eventId,
        teamId: application.teamId,
      });
      if (decision === "accept") {
        await ctx.db.patch(team._id, {
          status: "admitted",
          version: team.version + 1,
          updatedAt: now,
        });
        await ctx.scheduler.runAfter(0, internal.admissions.updateRosterOnboardingStatus, {
          applicationId: application._id,
          expectedApplicationVersion: applicationVersion,
          lockedRosterSnapshotId: project.lockedRosterSnapshotId,
          onboardingStatus: "selected",
          cursor: null,
        });
      }
      await enqueueAdmissionDecisionNotifications(ctx, {
        eventId: args.eventId,
        applicationId: application._id,
        teamId: application.teamId,
        lockedRosterSnapshotId: project.lockedRosterSnapshotId,
        lockedMemberCount: project.lockedMemberCount,
        communicationsPolicyVersionId: args.communicationsPolicyVersionId,
        decision,
        applicationVersion,
        now,
      });
    }
    if (applications.length === 25) {
      await ctx.scheduler.runAfter(0, internal.admissions.finalizeReleasedAdmissionResults, args);
    }
    return null;
  },
});

export const updateRosterOnboardingStatus = internalMutation({
  args: {
    applicationId: v.id("applications"),
    expectedApplicationVersion: v.number(),
    lockedRosterSnapshotId: v.id("teamSubmissionAttempts"),
    onboardingStatus: rosterOnboardingStatus,
    cursor: v.union(v.string(), v.null()),
    externalPassCommunicationsPolicyVersionId: v.optional(
      v.id("communicationsPolicyVersions"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const [application, attempt] = await Promise.all([
      ctx.db.get(args.applicationId),
      ctx.db.get(args.lockedRosterSnapshotId),
    ]);
    if (
      !application ||
      application.version !== args.expectedApplicationVersion ||
      !attempt ||
      attempt.state !== "complete"
    ) {
      return null;
    }
    if (application.eventId !== attempt.eventId || application.teamId !== attempt.teamId) {
      throw new Error("The immutable submitted roster is unavailable.");
    }
    const project = await ctx.db.get(application.submittedProjectVersionId);
    if (!project || project.lockedRosterSnapshotId !== attempt._id) {
      throw new Error("The application does not own the immutable submitted roster.");
    }
    const page = await ctx.db
      .query("teamSubmissionMembers")
      .withIndex("by_submission_attempt_and_ordinal", (index) =>
        index.eq("submissionAttemptId", attempt._id),
      )
      .paginate({ numItems: 100, cursor: args.cursor });
    const now = Date.now();
    for (const snapshotMember of page.page) {
      const membership = await ctx.db.get(snapshotMember.membershipId);
      if (!membership || membership.eventId !== attempt.eventId) {
        throw new Error("A submitted roster membership no longer resolves.");
      }
      await ctx.db.patch(membership._id, {
        onboardingStatus: args.onboardingStatus,
        updatedAt: now,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.admissions.updateRosterOnboardingStatus, {
        applicationId: application._id,
        expectedApplicationVersion: args.expectedApplicationVersion,
        lockedRosterSnapshotId: attempt._id,
        onboardingStatus: args.onboardingStatus,
        cursor: page.continueCursor,
        ...(args.externalPassCommunicationsPolicyVersionId !== undefined
          ? {
              externalPassCommunicationsPolicyVersionId:
                args.externalPassCommunicationsPolicyVersionId,
            }
          : {}),
      });
    } else if (args.externalPassCommunicationsPolicyVersionId !== undefined) {
      if (args.onboardingStatus !== "accepted") {
        throw new Error("External event-pass delivery requires accepted roster onboarding.");
      }
      await enqueueApplicationNotifications(ctx, {
        eventId: application.eventId,
        applicationId: application._id,
        teamId: application.teamId,
        lockedRosterSnapshotId: attempt._id,
        lockedMemberCount: project.lockedMemberCount,
        communicationsPolicyVersionId: args.externalPassCommunicationsPolicyVersionId,
        templateKey: "external_event_pass",
        applicationVersion: args.expectedApplicationVersion,
        now,
        participantClass: "external_participant",
      });
    }
    return null;
  },
});

export const sendOffer = mutation({
  args: {
    eventSlug: v.string(),
    applicationId: v.id("applications"),
    expectedApplicationVersion: v.number(),
    expiresAt: v.number(),
    clientOperationId: v.string(),
  },
  returns: offerMutationResult,
  handler: async (ctx, args) => {
    const { event, person, subject, application } = await applicationContext(ctx, args);
    const requestFingerprint = operationFingerprint([
      args.applicationId,
      args.expectedApplicationVersion,
      args.expiresAt,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.offer.send",
      requestFingerprint,
    });
    if (prior) {
      return storedOfferOperationResult(ctx, prior.targetId, prior.resultJson);
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.offer.manage",
      scopeType: "application",
      scopeId: application._id,
    });
    if (application.version !== args.expectedApplicationVersion) {
      throw new ConvexError({
        code: "APPLICATION_CHANGED",
        message: "The application changed. Review it before sending the offer.",
      });
    }
    if (application.state !== "accepted" || application.currentOfferId !== undefined) {
      throw new ConvexError({
        code: "OFFER_NOT_SENDABLE",
        message: "Only an accepted application without a current offer can receive an offer.",
      });
    }
    const [project, policy, team] = await Promise.all([
      ctx.db.get(application.submittedProjectVersionId),
      ctx.db.get(application.admissionPolicyVersionId),
      ctx.db.get(application.teamId),
    ]);
    if (
      !project ||
      !policy ||
      policy.status !== "published" ||
      policy.eventId !== event._id ||
      !team ||
      team.status !== "admitted" ||
      team.lockedProjectVersionId !== project._id
    ) {
      throw new Error("The accepted application context is incomplete.");
    }
    const now = Date.now();
    const created = await createAdmissionOffer(ctx, {
      event,
      application,
      project,
      policy,
      team,
      actorPersonId: person._id,
      grantIds,
      expiresAt: args.expiresAt,
      now,
    });
    const offerId = created.offer._id;
    const applicationVersion = created.application.version;
    const result = offerResult(created.offer, created.application);
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.offer.send",
      requestFingerprint,
      targetType: "admission_offer",
      targetId: offerId,
      resultJson: offerOperationResultJson(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "application.offer.manage",
      grantIds,
      scopeType: "application",
      scopeId: application._id,
      action: "admission.offer_sent",
      targetType: "admission_offer",
      targetId: offerId,
      previousSummary: JSON.stringify({
        applicationState: application.state,
        applicationVersion: application.version,
      }),
      nextSummary: JSON.stringify({
        applicationState: "offer_sent",
        applicationVersion,
        participantCount: project.lockedMemberCount,
        expiresAt: args.expiresAt,
      }),
      reason: "Sent an admission offer to the locked team",
    });
    return result;
  },
});

export const respondToOffer = mutation({
  args: {
    eventSlug: v.string(),
    applicationId: v.id("applications"),
    expectedApplicationVersion: v.number(),
    expectedOfferVersion: v.number(),
    response: v.union(v.literal("confirm"), v.literal("decline")),
    clientOperationId: v.string(),
  },
  returns: offerMutationResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    const application = await ctx.db.get(args.applicationId);
    if (!application || application.eventId !== event._id) {
      throw new ConvexError({ code: "APPLICATION_NOT_FOUND", message: "Application not found." });
    }
    const member = await ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index.eq("eventId", event._id).eq("membershipId", membership._id).eq("status", "active"),
      )
      .unique();
    if (!member || member.teamId !== application.teamId || member.role !== "lead") {
      throw new ConvexError({
        code: "TEAM_LEAD_REQUIRED",
        message: "Only the locked team lead can respond to this offer.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.offer.respond",
      scopeType: "team",
      scopeId: member.teamId,
    });
    const [project, team, offer] = await Promise.all([
      ctx.db.get(application.submittedProjectVersionId),
      ctx.db.get(application.teamId),
      application.currentOfferId ? ctx.db.get(application.currentOfferId) : Promise.resolve(null),
    ]);
    if (
      !project ||
      project.lockedLeadMembershipId !== membership._id ||
      !team ||
      !offer ||
      offer.applicationId !== application._id
    ) {
      throw new Error("The locked offer context is incomplete.");
    }
    const requestFingerprint = operationFingerprint([
      application._id,
      args.expectedApplicationVersion,
      offer._id,
      args.expectedOfferVersion,
      args.response,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.offer.respond",
      requestFingerprint,
    });
    if (prior) {
      return storedOfferOperationResult(ctx, prior.targetId, prior.resultJson);
    }
    const matchingTerminalResponse =
      (args.response === "confirm" &&
        offer.state === "confirmed" &&
        application.state === "confirmed") ||
      (args.response === "decline" &&
        offer.state === "declined" &&
        application.state === "withdrawn") ||
      (offer.state === "expired" && application.state === "offer_expired");
    if (matchingTerminalResponse) {
      return offerResult(offer, application);
    }
    if (offer.state !== "offered" || application.state !== "offer_sent") {
      throw new ConvexError({
        code: "OFFER_NOT_OPEN",
        message: "This offer no longer accepts a response.",
      });
    }
    const now = Date.now();
    const transition: OfferTransition =
      offer.expiresAt <= now ? "expired" : args.response === "confirm" ? "confirmed" : "declined";
    if (
      transition !== "expired" &&
      (application.version !== args.expectedApplicationVersion ||
        offer.version !== args.expectedOfferVersion)
    ) {
      throw new ConvexError({
        code: "OFFER_CHANGED",
        message: "The offer changed. Review the current deadline and state before responding.",
      });
    }
    const reason =
      transition === "confirmed"
        ? "The locked team lead confirmed the offer"
        : transition === "declined"
          ? "The locked team lead declined the offer"
          : "The offer deadline elapsed before confirmation";
    const transitioned = await transitionOffer(ctx, {
      application,
      offer,
      project,
      team,
      transition,
      actorPersonId: person._id,
      reason,
      now,
    });
    const result = offerResult(transitioned.offer, transitioned.application);
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.offer.respond",
      requestFingerprint,
      targetType: "admission_offer",
      targetId: offer._id,
      resultJson: offerOperationResultJson(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "application.offer.respond",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: `admission.offer_${transition}`,
      targetType: "admission_offer",
      targetId: offer._id,
      previousSummary: JSON.stringify({
        offerState: offer.state,
        offerVersion: offer.version,
        applicationState: application.state,
        applicationVersion: application.version,
      }),
      nextSummary: JSON.stringify({
        offerState: transitioned.offer.state,
        offerVersion: transitioned.offer.version,
        applicationState: transitioned.application.state,
        applicationVersion: transitioned.application.version,
      }),
      reason,
    });
    return result;
  },
});

export const revokeOffer = mutation({
  args: {
    eventSlug: v.string(),
    applicationId: v.id("applications"),
    expectedApplicationVersion: v.number(),
    expectedOfferVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: offerMutationResult,
  handler: async (ctx, args) => {
    const { event, person, subject, application } = await applicationContext(ctx, args);
    const reason = normalizedText(args.reason, "Reason", 3, 300);
    const requestFingerprint = operationFingerprint([
      application._id,
      args.expectedApplicationVersion,
      args.expectedOfferVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.offer.revoke",
      requestFingerprint,
    });
    if (prior) {
      return storedOfferOperationResult(ctx, prior.targetId, prior.resultJson);
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.offer.manage",
      scopeType: "application",
      scopeId: application._id,
    });
    const [offer, project, team] = await Promise.all([
      application.currentOfferId ? ctx.db.get(application.currentOfferId) : Promise.resolve(null),
      ctx.db.get(application.submittedProjectVersionId),
      ctx.db.get(application.teamId),
    ]);
    if (!offer || !project || !team) throw new Error("The current offer context is missing.");
    if (offer.state !== "offered" || application.state !== "offer_sent") {
      throw new ConvexError({
        code: "OFFER_NOT_OPEN",
        message: "Only an open offer can be revoked.",
      });
    }
    const now = Date.now();
    const transition: OfferTransition = offer.expiresAt <= now ? "expired" : "revoked";
    if (
      transition === "revoked" &&
      (application.version !== args.expectedApplicationVersion ||
        offer.version !== args.expectedOfferVersion)
    ) {
      throw new ConvexError({
        code: "OFFER_CHANGED",
        message: "The offer changed. Review it before revoking it.",
      });
    }
    const transitionReason =
      transition === "expired" ? "The offer deadline elapsed before revocation" : reason;
    const transitioned = await transitionOffer(ctx, {
      application,
      offer,
      project,
      team,
      transition,
      actorPersonId: person._id,
      reason: transitionReason,
      now,
    });
    const result = offerResult(transitioned.offer, transitioned.application);
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.offer.revoke",
      requestFingerprint,
      targetType: "admission_offer",
      targetId: offer._id,
      resultJson: offerOperationResultJson(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "application.offer.manage",
      grantIds,
      scopeType: "application",
      scopeId: application._id,
      action: `admission.offer_${transition}`,
      targetType: "admission_offer",
      targetId: offer._id,
      previousSummary: JSON.stringify({
        offerState: offer.state,
        offerVersion: offer.version,
        applicationState: application.state,
        applicationVersion: application.version,
      }),
      nextSummary: JSON.stringify({
        offerState: transitioned.offer.state,
        offerVersion: transitioned.offer.version,
        applicationState: transitioned.application.state,
        applicationVersion: transitioned.application.version,
      }),
      reason: transitionReason,
    });
    return result;
  },
});

export const expireOffer = internalMutation({
  args: {
    offerId: v.id("admissionOffers"),
    expectedOfferVersion: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const offer = await ctx.db.get(args.offerId);
    if (!offer || offer.state !== "offered" || offer.version !== args.expectedOfferVersion) {
      return null;
    }
    const now = Date.now();
    if (offer.expiresAt > now) {
      await ctx.scheduler.runAt(offer.expiresAt, internal.admissions.expireOffer, args);
      return null;
    }
    const application = await ctx.db.get(offer.applicationId);
    if (!application) {
      throw new Error("The expiring offer context is missing.");
    }
    const [project, team] = await Promise.all([
      ctx.db.get(application.submittedProjectVersionId),
      ctx.db.get(offer.teamId),
    ]);
    if (!project || !team) throw new Error("The expiring offer context is missing.");
    const transitioned = await transitionOffer(ctx, {
      application,
      offer,
      project,
      team,
      transition: "expired",
      reason: "The published offer deadline elapsed",
      now,
    });
    await writeAuditEvent(ctx, {
      eventId: offer.eventId,
      actorPersonId: offer.createdByPersonId,
      permissionKey: "application.offer.manage",
      grantIds: offer.createdByGrantIds,
      scopeType: "application",
      scopeId: offer.applicationId,
      action: "admission.offer_expired",
      targetType: "admission_offer",
      targetId: offer._id,
      previousSummary: JSON.stringify({
        offerState: offer.state,
        offerVersion: offer.version,
        applicationState: application.state,
        applicationVersion: application.version,
      }),
      nextSummary: JSON.stringify({
        offerState: transitioned.offer.state,
        offerVersion: transitioned.offer.version,
        applicationState: transitioned.application.state,
        applicationVersion: transitioned.application.version,
      }),
      reason: "The published offer deadline elapsed",
    });
    return null;
  },
});
