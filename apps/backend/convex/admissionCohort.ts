/**
 * Suggests a capacity-bounded cohort without deciding applications.
 * Capacity is measured in people, ranking uses only recorded signals, and
 * applied decisions still run through `admissions.decide` as the operator.
 */

import {
  admissionIntelligenceReadNames,
  operationsIntelligenceProtocolVersion,
  admissionIntelligenceReadSignatureContext,
  verifyServiceBody,
} from "@code2create/domain";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import { z } from "zod";

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  httpAction,
  internalAction,
  internalQuery,
  mutation,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { HttpBodyTooLargeError, readBoundedRequestText } from "./lib/boundedHttpBody";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { findOperation, operationFingerprint } from "./lib/operations";
import { boundedActivePermissionGrants, requirePermission } from "./lib/permissions";
import { noveltyInputFingerprint } from "./lib/novelty";
import { redactProjectText } from "./lib/projectText";
import {
  maximumApplicantTeamsPerEvent,
  maximumReviewerAssignmentsPerEvent,
} from "./lib/reviewLimits";
import {
  admissionAiDisposition,
  admissionDecision,
  admissionExperienceBand,
  admissionRecommendationState,
  applicationState,
  criterionAssessment,
} from "./values";

/** Pure ranking: human support, AI tie-break, submission time, then ID. */
export type AdmissionCohortSignals = {
  applicationId: string;
  teamSize: number;
  submittedAt: number;
  reviewAccepts: number;
  reviewDeclines: number;
  aiRecommendation: "accept" | "waitlist" | "decline" | null;
};

const aiSupportRank = {
  accept: 2,
  waitlist: 1,
  decline: -1,
} as const;
const maximumActiveApplicationPermissionGrants = 2_000;

export function compareAdmissionCohortCandidates(
  left: AdmissionCohortSignals,
  right: AdmissionCohortSignals,
) {
  const reviewSupport =
    right.reviewAccepts - right.reviewDeclines - (left.reviewAccepts - left.reviewDeclines);
  if (reviewSupport !== 0) return reviewSupport;
  const aiSupport =
    (right.aiRecommendation ? aiSupportRank[right.aiRecommendation] : 0) -
    (left.aiRecommendation ? aiSupportRank[left.aiRecommendation] : 0);
  if (aiSupport !== 0) return aiSupport;
  if (left.submittedAt !== right.submittedAt) return left.submittedAt - right.submittedAt;
  return left.applicationId < right.applicationId
    ? -1
    : left.applicationId > right.applicationId
      ? 1
      : 0;
}

/**
 * Selects a strict ranking prefix; no bin-packing around a higher-ranked team.
 * `entryCapacityPeople` lets clients recompute the line without refetching.
 */
export function selectAdmissionCohort<T extends AdmissionCohortSignals>(
  candidates: readonly T[],
  capacityPeople: number,
  committedPeople: number,
) {
  const ranked = [...candidates].sort(compareAdmissionCohortCandidates);
  let cumulativePeople = 0;
  return ranked.map((candidate, index) => {
    cumulativePeople += candidate.teamSize;
    const entryCapacityPeople = committedPeople + cumulativePeople;
    return {
      ...candidate,
      rank: index + 1,
      cumulativePeople,
      entryCapacityPeople,
      suggestedIn: entryCapacityPeople <= capacityPeople,
    };
  });
}

export function normalizedCapacityPeople(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new ConvexError({
      code: "INVALID_CAPACITY",
      message: "Choose a whole number of people from 1 through 100000.",
    });
  }
  return value;
}

/** Committed states consume capacity; decided-out states are never re-ranked. */
const committedStates = new Set<Doc<"applications">["state"]>([
  "accepted",
  "offer_sent",
  "confirmed",
]);
const candidateStates = new Set<Doc<"applications">["state"]>([
  "submitted",
  "under_review",
]);

const experienceBands = [
  "first_year",
  "early_year",
  "later_year",
  "postgraduate_or_professional",
  "mixed_or_external",
] as const;

type CohortRow = {
  applicationId: Id<"applications">;
  teamId: Id<"teams">;
  teamName: string;
  state: Doc<"applications">["state"];
  experienceBand: Doc<"applications">["experienceBand"];
  submittedAt: number;
  assignedReviewCount: number;
  initialIdea: string;
  novelty: ReturnType<typeof noveltySignal>;
  teamSize: number;
  minimumHumanReviews: number;
  reviewSignal: { accept: number; waitlist: number; decline: number };
  completedCurrentReviews: number;
  ai: {
    state: Doc<"admissionAIRecommendations">["state"];
    current: boolean;
    recommendation?: NonNullable<Doc<"admissionAIRecommendations">["recommendation"]>;
    confidence?: NonNullable<Doc<"admissionAIRecommendations">["confidence"]>;
    criterionAssessments: {
      criterionKey: string;
      assessment: Doc<"admissionAIRecommendations">["criterionAssessments"][number]["assessment"];
    }[];
  } | null;
};

type CohortRowPage = {
  page: CohortRow[];
  isDone: boolean;
  continueCursor: string;
  splitCursor?: string | null;
  pageStatus?: "SplitRecommended" | "SplitRequired" | null;
};

const admissionCohortPageSize = 20;

function noveltySignal(draft: Doc<"projectDrafts"> | null, submittedIdea: string) {
  if (
    draft === null ||
    draft.noveltyEvaluatedInputFingerprint !== noveltyInputFingerprint(submittedIdea) ||
    draft.noveltyScore === undefined ||
    draft.noveltyBand === undefined ||
    draft.noveltyNearestThemeLabel === undefined ||
    !Number.isSafeInteger(draft.noveltyScore) ||
    draft.noveltyScore < 0 ||
    draft.noveltyScore > 100
  )
    return null;
  return {
    score: draft.noveltyScore,
    band: draft.noveltyBand,
    nearestThemeLabel: draft.noveltyNearestThemeLabel,
  };
}

/** Reads the event through bounded transactions instead of one whole-cohort query. */
async function loadAdmissionCohortRows(ctx: ActionCtx, eventId: Id<"events">) {
  const rows: CohortRow[] = [];
  let cursor: string | null = null;
  while (true) {
    const page: CohortRowPage = await ctx.runQuery(internal.admissionCohort.cohortRowPage, {
      eventId,
      paginationOpts: {
        cursor,
        numItems: admissionCohortPageSize,
        maximumRowsRead: admissionCohortPageSize,
      },
    });
    if (rows.length + page.page.length > maximumApplicantTeamsPerEvent) {
      throw new Error(
        `Admission cohort reads support at most ${maximumApplicantTeamsPerEvent} applicant teams.`,
      );
    }
    rows.push(...page.page);
    if (page.isDone) return rows;
    cursor = page.continueCursor;
  }
}

async function requirePublishedAdmissionPolicy(ctx: QueryCtx, event: Doc<"events">) {
  const policy = await ctx.db
    .query("admissionPolicyVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", event._id).eq("status", "published"),
    )
    .unique();
  if (!policy) {
    throw new ConvexError({
      code: "ADMISSION_POLICY_REQUIRED",
      message: "Publish an admission policy before planning a cohort.",
    });
  }
  return policy;
}

function candidateSignals(row: CohortRow): AdmissionCohortSignals {
  return {
    applicationId: row.applicationId,
    teamSize: row.teamSize,
    submittedAt: row.submittedAt,
    reviewAccepts: row.reviewSignal.accept,
    reviewDeclines: row.reviewSignal.decline,
    aiRecommendation: row.ai?.current ? (row.ai.recommendation ?? null) : null,
  };
}

function rosterEntry(row: CohortRow) {
  return {
    applicationId: row.applicationId,
    teamId: row.teamId,
    teamName: row.teamName,
    state: row.state,
    teamSize: row.teamSize,
  };
}

function candidateView(
  row: CohortRow,
  selection: ReturnType<typeof selectAdmissionCohort>[number],
) {
  const decidable = row.completedCurrentReviews >= row.minimumHumanReviews;
  return {
    applicationId: row.applicationId,
    teamId: row.teamId,
    teamName: row.teamName,
    state: row.state,
    submittedAt: row.submittedAt,
    experienceBand: row.experienceBand,
    teamSize: row.teamSize,
    reviewCoverage: {
      assigned: row.assignedReviewCount,
      completed: row.completedCurrentReviews,
      required: row.minimumHumanReviews,
      decidable,
      shortfall: Math.max(0, row.minimumHumanReviews - row.completedCurrentReviews),
    },
    reviewSignal: row.reviewSignal,
    ...(row.ai ? { aiRecommendation: row.ai } : {}),
    novelty: row.novelty,
    rank: selection.rank,
    cumulativePeople: selection.cumulativePeople,
    entryCapacityPeople: selection.entryCapacityPeople,
    suggestedIn: selection.suggestedIn,
  };
}

/** Computes whole-event arithmetic before grant-based row filtering. */
async function buildAdmissionCohortView(
  ctx: ActionCtx,
  eventId: Id<"events">,
  policy: Infer<typeof cohortPolicyView>,
  requestedCapacityPeople: number | undefined,
) {
  const capacityPeople = normalizedCapacityPeople(
    requestedCapacityPeople ?? policy.overallParticipantCapacity,
  );
  const rows = await loadAdmissionCohortRows(ctx, eventId);
  const committedRows = rows.filter((row) => committedStates.has(row.state));
  const candidateRows = rows.filter((row) => candidateStates.has(row.state));
  const decidedOutRows = rows.filter(
    (row) => !committedStates.has(row.state) && !candidateStates.has(row.state),
  );
  const committedPeople = committedRows.reduce((total, row) => total + row.teamSize, 0);
  const selection = selectAdmissionCohort(
    candidateRows.map(candidateSignals),
    capacityPeople,
    committedPeople,
  );
  const rowById = new Map(candidateRows.map((row) => [row.applicationId as string, row]));
  const candidates = selection.map((selected) => {
    const row = rowById.get(selected.applicationId);
    if (!row) throw new Error("A ranked cohort candidate lost its source row.");
    return candidateView(row, selected);
  });
  const inCandidates = candidates.filter((candidate) => candidate.suggestedIn);
  const suggestedPeople =
    committedPeople + inCandidates.reduce((total, candidate) => total + candidate.teamSize, 0);
  const bandMix = experienceBands.map((band) => {
    const ofBand = candidates.filter((candidate) => candidate.experienceBand === band);
    const inBand = ofBand.filter((candidate) => candidate.suggestedIn);
    const outBand = ofBand.filter((candidate) => !candidate.suggestedIn);
    return {
      band,
      teamsIn: inBand.length,
      peopleIn: inBand.reduce((total, candidate) => total + candidate.teamSize, 0),
      teamsOut: outBand.length,
      peopleOut: outBand.reduce((total, candidate) => total + candidate.teamSize, 0),
    };
  });
  return {
    generatedAt: Date.now(),
    capacityPeople,
    policy: {
      version: policy.version,
      minimumHumanReviews: policy.minimumHumanReviews,
      overallParticipantCapacity: policy.overallParticipantCapacity,
      criteria: policy.criteria.map((criterion) => ({
        criterionKey: criterion.criterionKey,
        label: criterion.label,
      })),
    },
    summary: {
      capacityPeople,
      committedPeople,
      suggestedPeople,
      remainingPeople: capacityPeople - suggestedPeople,
      suggestedInTeamCount: inCandidates.length,
      suggestedInNotYetDecidableCount: inCandidates.filter(
        (candidate) => !candidate.reviewCoverage.decidable,
      ).length,
      bandMix,
    },
    committed: committedRows.map(rosterEntry),
    decidedOut: decidedOutRows.map(rosterEntry),
    candidates,
  };
}

const reviewCoverageView = v.object({
  assigned: v.number(),
  completed: v.number(),
  required: v.number(),
  decidable: v.boolean(),
  shortfall: v.number(),
});

const reviewSignalView = v.object({
  accept: v.number(),
  waitlist: v.number(),
  decline: v.number(),
});

const aiRecommendationView = v.object({
  state: admissionRecommendationState,
  current: v.boolean(),
  recommendation: v.optional(admissionDecision),
  confidence: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"))),
  criterionAssessments: v.array(
    v.object({ criterionKey: v.string(), assessment: criterionAssessment }),
  ),
});

const noveltySignalView = v.union(
  v.null(),
  v.object({
    score: v.number(),
    band: v.union(v.literal("familiar"), v.literal("developing"), v.literal("distinct")),
    nearestThemeLabel: v.string(),
  }),
);

const rosterEntryView = v.object({
  applicationId: v.id("applications"),
  teamId: v.id("teams"),
  teamName: v.string(),
  state: applicationState,
  teamSize: v.number(),
});

const candidateViewFields = {
  applicationId: v.id("applications"),
  teamId: v.id("teams"),
  teamName: v.string(),
  state: applicationState,
  submittedAt: v.number(),
  teamSize: v.number(),
  reviewCoverage: reviewCoverageView,
  reviewSignal: reviewSignalView,
  aiRecommendation: v.optional(aiRecommendationView),
  rank: v.number(),
  cumulativePeople: v.number(),
  entryCapacityPeople: v.number(),
  suggestedIn: v.boolean(),
} as const;

// Operator year-band visibility requires the profile-context grant.
const operatorCandidateView = v.object({
  ...candidateViewFields,
  experienceBand: v.optional(admissionExperienceBand),
});
const internalCandidateView = v.object({
  ...candidateViewFields,
  experienceBand: admissionExperienceBand,
  novelty: noveltySignalView,
});

const cohortSummaryView = v.object({
  capacityPeople: v.number(),
  committedPeople: v.number(),
  suggestedPeople: v.number(),
  remainingPeople: v.number(),
  suggestedInTeamCount: v.number(),
  suggestedInNotYetDecidableCount: v.number(),
  bandMix: v.array(
    v.object({
      band: admissionExperienceBand,
      teamsIn: v.number(),
      peopleIn: v.number(),
      teamsOut: v.number(),
      peopleOut: v.number(),
    }),
  ),
});

const cohortPolicyView = v.object({
  version: v.string(),
  minimumHumanReviews: v.number(),
  overallParticipantCapacity: v.number(),
  criteria: v.array(v.object({ criterionKey: v.string(), label: v.string() })),
});

const cohortRowView = v.object({
  applicationId: v.id("applications"),
  teamId: v.id("teams"),
  teamName: v.string(),
  state: applicationState,
  experienceBand: admissionExperienceBand,
  submittedAt: v.number(),
  assignedReviewCount: v.number(),
  initialIdea: v.string(),
  novelty: noveltySignalView,
  teamSize: v.number(),
  minimumHumanReviews: v.number(),
  reviewSignal: reviewSignalView,
  completedCurrentReviews: v.number(),
  ai: v.union(v.null(), aiRecommendationView),
});

const cohortRowPageView = paginationResultValidator(cohortRowView);

/** Hydrates one bounded application page inside one database transaction. */
export const cohortRowPage = internalQuery({
  args: { eventId: v.id("events"), paginationOpts: paginationOptsValidator },
  returns: cohortRowPageView,
  handler: async (ctx, args) => {
    const applicationPage = await ctx.db
      .query("applications")
      .withIndex("by_event_submitted", (index) => index.eq("eventId", args.eventId))
      .paginate(args.paginationOpts);
    const policies = new Map<Id<"admissionPolicyVersions">, Doc<"admissionPolicyVersions">>();
    const page: CohortRow[] = [];
    for (const application of applicationPage.page) {
      const [team, project, draft] = await Promise.all([
        ctx.db.get(application.teamId),
        ctx.db.get(application.submittedProjectVersionId),
        ctx.db
          .query("projectDrafts")
          .withIndex("by_team", (index) => index.eq("teamId", application.teamId))
          .unique(),
      ]);
      if (!team || !project) {
        throw new Error("An admission cohort application has incomplete team or project data.");
      }
      let policy = policies.get(application.admissionPolicyVersionId);
      if (!policy) {
        const loaded = await ctx.db.get(application.admissionPolicyVersionId);
        if (!loaded || loaded.eventId !== args.eventId) {
          throw new Error("An admission cohort application has invalid policy data.");
        }
        policies.set(application.admissionPolicyVersionId, loaded);
        policy = loaded;
      }
      const [reviews, recommendation] = await Promise.all([
        ctx.db
          .query("admissionHumanReviews")
          .withIndex("by_application_status", (index) =>
            index.eq("applicationId", application._id).eq("status", "active"),
          )
          .take(maximumReviewerAssignmentsPerEvent + 1),
        application.aiRecommendationId
          ? ctx.db.get(application.aiRecommendationId)
          : Promise.resolve(null),
      ]);
      if (reviews.length > maximumReviewerAssignmentsPerEvent) {
        throw new Error(
          `An application has more than ${maximumReviewerAssignmentsPerEvent} active reviews.`,
        );
      }
      const currentReviews = reviews.filter(
        (review) => review.applicationContentVersion === application.contentVersion,
      );
      const reviewSignal = { accept: 0, waitlist: 0, decline: 0 };
      for (const review of currentReviews) {
        if (review.recommendation === "accept") reviewSignal.accept += 1;
        else if (review.recommendation === "waitlist") reviewSignal.waitlist += 1;
        else reviewSignal.decline += 1;
      }
      const aiCurrent = Boolean(
        recommendation &&
        recommendation.state === "succeeded" &&
        recommendation.applicationContentVersion === application.contentVersion &&
        recommendation.projectVersionId === project._id &&
        recommendation.admissionPolicyVersionId === application.admissionPolicyVersionId &&
        recommendation.recommendation,
      );
      const ai = recommendation
        ? {
            state: recommendation.state,
            current: aiCurrent,
            ...(aiCurrent && recommendation.recommendation
              ? { recommendation: recommendation.recommendation }
              : {}),
            ...(aiCurrent && recommendation.confidence
              ? { confidence: recommendation.confidence }
              : {}),
            criterionAssessments: aiCurrent
              ? recommendation.criterionAssessments.map((assessment) => ({
                  criterionKey: assessment.criterionKey,
                  assessment: assessment.assessment,
                }))
              : [],
          }
        : null;
      page.push({
        applicationId: application._id,
        teamId: team._id,
        teamName: team.name,
        state: application.state,
        experienceBand: application.experienceBand,
        submittedAt: application.submittedAt,
        assignedReviewCount: application.assignedReviewCount,
        initialIdea: project.initialIdea,
        novelty: noveltySignal(draft, project.initialIdea),
        teamSize: project.lockedMemberCount,
        minimumHumanReviews: policy.minimumHumanReviews,
        reviewSignal,
        completedCurrentReviews: currentReviews.length,
        ai,
      });
    }
    return { ...applicationPage, page };
  },
});

const applicationAccessView = v.object({
  eventWide: v.boolean(),
  applicationIds: v.array(v.id("applications")),
});

type ApplicationAccess = Infer<typeof applicationAccessView>;

/** Loads one permission's live event/application scope without querying per row. */
async function applicationGrantAccess(
  ctx: QueryCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    permissionKey:
      | "application.read"
      | "application.profile_context.read"
      | "application.ai_recommendation.read";
  },
) {
  const live = await boundedActivePermissionGrants(ctx, {
    ...args,
    maximumGrantCount: maximumActiveApplicationPermissionGrants,
  });
  const eventWide = live.some(
    (grant) => grant.scopeType === "event" && grant.scopeId === undefined,
  );
  const applicationIds = live.flatMap((grant) => {
    if (grant.scopeType !== "application" || grant.scopeId === undefined) return [];
    const applicationId = ctx.db.normalizeId("applications", grant.scopeId);
    return applicationId ? [applicationId] : [];
  });
  return { eventWide, applicationIds };
}

function applicationGrantMatcher(access: ApplicationAccess) {
  const scoped = new Set<Id<"applications">>(access.applicationIds);
  return (applicationId: Id<"applications">) => access.eventWide || scoped.has(applicationId);
}

async function publishedCohortPolicy(ctx: QueryCtx, event: Doc<"events">) {
  const policy = await requirePublishedAdmissionPolicy(ctx, event);
  return {
    version: policy.version,
    minimumHumanReviews: policy.minimumHumanReviews,
    overallParticipantCapacity: policy.overallParticipantCapacity,
    criteria: policy.criteria.map((criterion) => ({
      criterionKey: criterion.criterionKey,
      label: criterion.label,
    })),
  };
}

export const cohortContextRead = internalQuery({
  args: { eventId: v.id("events") },
  returns: v.object({ eventId: v.id("events"), policy: cohortPolicyView }),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("The admission cohort event no longer exists.");
    return { eventId: event._id, policy: await publishedCohortPolicy(ctx, event) };
  },
});

const operatorCohortAccessView = v.object({
  eventId: v.id("events"),
  policy: cohortPolicyView,
  applicationRead: applicationAccessView,
  profileContextRead: applicationAccessView,
  aiRecommendationRead: applicationAccessView,
});

export const operatorCohortAccess = internalQuery({
  args: { eventSlug: v.string() },
  returns: operatorCohortAccessView,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.read",
      scopeType: "event",
    });
    const [applicationRead, profileContextRead, aiRecommendationRead, policy] = await Promise.all([
      applicationGrantAccess(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "application.read",
      }),
      applicationGrantAccess(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "application.profile_context.read",
      }),
      applicationGrantAccess(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "application.ai_recommendation.read",
      }),
      publishedCohortPolicy(ctx, event),
    ]);
    return {
      eventId: event._id,
      policy,
      applicationRead,
      profileContextRead,
      aiRecommendationRead,
    };
  },
});

/** Filters rows and sensitive fields through the standard application grants. */
export const cohort = action({
  args: {
    eventSlug: v.string(),
    capacityPeople: v.optional(v.number()),
  },
  returns: v.object({
    generatedAt: v.number(),
    capacityPeople: v.number(),
    policy: cohortPolicyView,
    summary: cohortSummaryView,
    committed: v.array(rosterEntryView),
    decidedOut: v.array(rosterEntryView),
    candidates: v.array(operatorCandidateView),
    hiddenApplicationCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const access: Infer<typeof operatorCohortAccessView> = await ctx.runQuery(
      internal.admissionCohort.operatorCohortAccess,
      { eventSlug: args.eventSlug },
    );
    const view = await buildAdmissionCohortView(
      ctx,
      access.eventId,
      access.policy,
      args.capacityPeople,
    );
    const canReadApplication = applicationGrantMatcher(access.applicationRead);
    const canReadProfile = applicationGrantMatcher(access.profileContextRead);
    const canReadAi = applicationGrantMatcher(access.aiRecommendationRead);
    let hiddenApplicationCount = 0;
    const visible = <T extends { applicationId: Id<"applications"> }>(entries: T[]) =>
      entries.filter((entry) => {
        if (canReadApplication(entry.applicationId)) return true;
        hiddenApplicationCount += 1;
        return false;
      });
    const candidates = visible(view.candidates).map((candidate) => {
      const { experienceBand, aiRecommendation, novelty: _novelty, ...rest } = candidate;
      return {
        ...rest,
        ...(canReadProfile(candidate.applicationId) ? { experienceBand } : {}),
        ...(aiRecommendation && canReadAi(candidate.applicationId) ? { aiRecommendation } : {}),
      };
    });
    return {
      generatedAt: view.generatedAt,
      capacityPeople: view.capacityPeople,
      policy: view.policy,
      summary: view.summary,
      committed: visible(view.committed),
      decidedOut: visible(view.decidedOut),
      candidates,
      hiddenApplicationCount,
    };
  },
});

const applyRefusal = v.object({
  code: v.string(),
  message: v.string(),
  completedReviewCount: v.number(),
  minimumHumanReviews: v.number(),
});

// Break the circular api.admissions.decide inference explicitly.
type ApplyDecisionResult =
  | {
      applied: true;
      applicationId: Id<"applications">;
      state: Infer<typeof applicationState>;
      applicationVersion: number;
    }
  | { applied: false; refusal: Infer<typeof applyRefusal> };

/** Delegates decisions to admissions.decide and returns policy refusals as data. */
export const applyDecision = mutation({
  args: {
    eventSlug: v.string(),
    applicationId: v.id("applications"),
    expectedApplicationVersion: v.number(),
    decision: admissionDecision,
    reasonCode: v.string(),
    aiDisposition: admissionAiDisposition,
    clientOperationId: v.string(),
  },
  returns: v.union(
    v.object({
      applied: v.literal(true),
      applicationId: v.id("applications"),
      state: applicationState,
      applicationVersion: v.number(),
    }),
    v.object({ applied: v.literal(false), refusal: applyRefusal }),
  ),
  handler: async (ctx: MutationCtx, args): Promise<ApplyDecisionResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const application = await ctx.db.get(args.applicationId);
    if (!application || application.eventId !== event._id) {
      throw new ConvexError({ code: "APPLICATION_NOT_FOUND", message: "Application not found." });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.decide",
      scopeType: "application",
      scopeId: application._id,
    });
    const [policy, reviews] = await Promise.all([
      ctx.db.get(application.admissionPolicyVersionId),
      ctx.db
        .query("admissionHumanReviews")
        .withIndex("by_application_status", (index) =>
          index.eq("applicationId", application._id).eq("status", "active"),
        )
        .collect(),
    ]);
    if (!policy || policy.eventId !== event._id) {
      throw new Error("The application's admission policy context is missing.");
    }
    const completedReviewCount = reviews.filter(
      (review) => review.applicationContentVersion === application.contentVersion,
    ).length;
    // Resolve the prior operation before release-state checks so retries replay.
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.decision.record",
      requestFingerprint: operationFingerprint([
        args.applicationId,
        args.expectedApplicationVersion,
        args.decision,
        args.reasonCode,
        args.aiDisposition,
      ]),
    });
    const refusal = (code: string, message: string) => ({
      applied: false as const,
      refusal: {
        code,
        message,
        completedReviewCount,
        minimumHumanReviews: policy.minimumHumanReviews,
      },
    });
    if (!prior) {
      if (Date.now() < event.applicationsCloseAt) {
        return refusal(
          "APPLICATIONS_STILL_OPEN",
          "Record admission decisions after the application deadline.",
        );
      }
      if (["accepted", "waitlisted", "declined", "withdrawn"].includes(application.state)) {
        return refusal(
          "APPLICATION_DECIDED",
          "This application already has a released terminal decision.",
        );
      }
      if (application.version !== args.expectedApplicationVersion) {
        return refusal(
          "APPLICATION_CHANGED",
          "The application changed. Review it before applying this suggestion.",
        );
      }
      if (completedReviewCount < policy.minimumHumanReviews) {
        return refusal(
          "HUMAN_REVIEW_INCOMPLETE",
          `At least ${policy.minimumHumanReviews} independent human review${policy.minimumHumanReviews === 1 ? " is" : "s are"} required before this application can be decided.`,
        );
      }
    }
    const result: {
      applicationId: Id<"applications">;
      state: Infer<typeof applicationState>;
      applicationVersion: number;
    } = await ctx.runMutation(api.admissions.decide, {
      eventSlug: args.eventSlug,
      applicationId: args.applicationId,
      expectedApplicationVersion: args.expectedApplicationVersion,
      decision: args.decision,
      reasonCode: args.reasonCode,
      aiDisposition: args.aiDisposition,
      clientOperationId: args.clientOperationId,
    });
    return {
      applied: true as const,
      applicationId: result.applicationId,
      state: result.state,
      applicationVersion: result.applicationVersion,
    };
  },
});

const maximumIntelligenceCohortWindow = 48;
const intelligenceCohortRowsPerSide = maximumIntelligenceCohortWindow / 2;

/**
 * Redacted admission projection for the fixed intelligence read boundary.
 * Only the decision boundary is useful to the model; whole-cohort rows remain
 * on the human workspace and never consume the Worker's bounded response.
 */
export const cohortRead = internalAction({
  args: { eventId: v.id("events"), capacityPeople: v.optional(v.number()) },
  returns: v.object({
    generatedAt: v.number(),
    capacityPeople: v.number(),
    policy: cohortPolicyView,
    summary: cohortSummaryView,
    counts: v.object({
      committedTeams: v.number(),
      decidedOutTeams: v.number(),
      candidateTeams: v.number(),
    }),
    window: v.object({
      startRank: v.number(),
      endRank: v.number(),
      hasEarlier: v.boolean(),
      hasLater: v.boolean(),
    }),
    candidates: v.array(internalCandidateView),
  }),
  handler: async (ctx, args) => {
    const context: { eventId: Id<"events">; policy: Infer<typeof cohortPolicyView> } =
      await ctx.runQuery(internal.admissionCohort.cohortContextRead, {
        eventId: args.eventId,
      });
    const view = await buildAdmissionCohortView(
      ctx,
      context.eventId,
      context.policy,
      args.capacityPeople,
    );
    const firstOutIndex = view.candidates.findIndex((candidate) => !candidate.suggestedIn);
    const boundaryIndex = firstOutIndex === -1 ? view.candidates.length : firstOutIndex;
    const startIndex = Math.max(0, boundaryIndex - intelligenceCohortRowsPerSide);
    const endIndex = Math.min(
      view.candidates.length,
      boundaryIndex + intelligenceCohortRowsPerSide,
    );
    const candidates = view.candidates.slice(startIndex, endIndex);
    return {
      generatedAt: view.generatedAt,
      capacityPeople: view.capacityPeople,
      policy: view.policy,
      summary: view.summary,
      counts: {
        committedTeams: view.committed.length,
        decidedOutTeams: view.decidedOut.length,
        candidateTeams: view.candidates.length,
      },
      window: {
        startRank: candidates[0]?.rank ?? 0,
        endRank: candidates.at(-1)?.rank ?? 0,
        hasEarlier: startIndex > 0,
        hasLater: endIndex < view.candidates.length,
      },
      candidates,
    };
  },
});

const searchMatchView = v.object({
  applicationId: v.id("applications"),
  teamId: v.id("teams"),
  teamName: v.string(),
  state: applicationState,
  experienceBand: admissionExperienceBand,
  teamSize: v.number(),
  ideaExcerpt: v.string(),
  novelty: noveltySignalView,
  reviewCoverage: reviewCoverageView,
});

const maximumSearchMatches = 25;

/** Conjunctive text search that returns only stored signals and redacted excerpts. */
export const submissionSearchRead = internalAction({
  args: { eventId: v.id("events"), searchQuery: v.string(), limit: v.number() },
  returns: v.object({
    generatedAt: v.number(),
    searchQuery: v.string(),
    matches: v.array(searchMatchView),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const generatedAt = Date.now();
    const context: { eventId: Id<"events">; policy: Infer<typeof cohortPolicyView> } =
      await ctx.runQuery(internal.admissionCohort.cohortContextRead, {
        eventId: args.eventId,
      });
    const limit = Math.max(1, Math.min(maximumSearchMatches, Math.floor(args.limit)));
    const tokens = args.searchQuery
      .trim()
      .toLocaleLowerCase("en")
      .split(/\s+/u)
      .filter((token) => token.length >= 2)
      .slice(0, 8);
    if (tokens.length === 0) {
      return { generatedAt, searchQuery: args.searchQuery, matches: [], truncated: false };
    }
    const rows = await loadAdmissionCohortRows(ctx, context.eventId);
    const matched = rows.filter((row) => {
      const haystack = [row.teamName, row.initialIdea].join("\n").toLocaleLowerCase("en");
      return tokens.every((token) => haystack.includes(token));
    });
    matched.sort((left, right) => left.submittedAt - right.submittedAt);
    const matches = matched.slice(0, limit).map((row) => ({
      applicationId: row.applicationId,
      teamId: row.teamId,
      teamName: row.teamName,
      state: row.state,
      experienceBand: row.experienceBand,
      teamSize: row.teamSize,
      ideaExcerpt: redactProjectText(row.initialIdea).slice(0, 240),
      novelty: row.novelty,
      reviewCoverage: {
        assigned: row.assignedReviewCount,
        completed: row.completedCurrentReviews,
        required: row.minimumHumanReviews,
        decidable: row.completedCurrentReviews >= row.minimumHumanReviews,
        shortfall: Math.max(0, row.minimumHumanReviews - row.completedCurrentReviews),
      },
    }));
    return {
      generatedAt,
      searchQuery: args.searchQuery,
      matches,
      truncated: matched.length > limit,
    };
  },
});

const maximumBodyBytes = 4 * 1_024;
const maximumSignatureAgeMs = 5 * 60 * 1_000;

const admissionReadRequest = z
  .object({
    protocolVersion: z.literal(operationsIntelligenceProtocolVersion),
    read: z.enum(admissionIntelligenceReadNames),
    eventSlug: z.string().min(1).max(120),
    capacityPeople: z.number().int().min(1).max(100_000).optional(),
    query: z.string().min(2).max(200).optional(),
    limit: z.number().int().min(1).max(maximumSearchMatches).optional(),
  })
  .strict();

function readSecret() {
  const value = process.env.INTELLIGENCE_READ_SECRET?.trim();
  if (!value) throw new Error("INTELLIGENCE_READ_SECRET is not configured.");
  return value;
}

/** Signed, size-bounded admission-read endpoint with a route-specific context. */
export const admissionIntelligenceReadEndpoint = httpAction(async (ctx, request) => {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    return Response.json({ error: "unsupported_media_type" }, { status: 415 });
  }
  let body: string;
  try {
    body = await readBoundedRequestText(request, maximumBodyBytes);
  } catch (error) {
    if (error instanceof HttpBodyTooLargeError) {
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    }
    throw error;
  }
  let verified = false;
  try {
    verified = await verifyServiceBody({
      context: admissionIntelligenceReadSignatureContext,
      secret: readSecret(),
      timestamp: request.headers.get("x-c2c-timestamp") ?? "",
      signature: request.headers.get("x-c2c-signature") ?? "",
      body,
      now: Date.now(),
      maximumAgeMs: maximumSignatureAgeMs,
    });
  } catch {
    return Response.json({ error: "service_unavailable" }, { status: 503 });
  }
  if (!verified) return Response.json({ error: "unauthorized" }, { status: 401 });
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = admissionReadRequest.safeParse(json);
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 422 });
  const resolved = await ctx.runQuery(internal.intelligenceReads.resolveEvent, {
    eventSlug: parsed.data.eventSlug,
  });
  if (!resolved) return Response.json({ error: "event_not_found" }, { status: 404 });
  const read = parsed.data.read;
  if (read === "admission_submission_search" && parsed.data.query === undefined) {
    return Response.json({ error: "invalid_request" }, { status: 422 });
  }
  const data =
    read === "admission_cohort"
      ? await ctx.runAction(internal.admissionCohort.cohortRead, {
          eventId: resolved.eventId,
          ...(parsed.data.capacityPeople !== undefined
            ? { capacityPeople: parsed.data.capacityPeople }
            : {}),
        })
      : await ctx.runAction(internal.admissionCohort.submissionSearchRead, {
          eventId: resolved.eventId,
          searchQuery: parsed.data.query ?? "",
          limit: parsed.data.limit ?? maximumSearchMatches,
        });
  return Response.json({ read, data }, { status: 200 });
});
