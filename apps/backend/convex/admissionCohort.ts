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
import { ConvexError, v, type Infer } from "convex/values";
import { z } from "zod";

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  httpAction,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import {
  HttpBodyTooLargeError,
  readBoundedRequestText,
} from "./lib/boundedHttpBody";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { noveltyInputFingerprint } from "./lib/novelty";
import { findOperation, operationFingerprint } from "./lib/operations";
import {
  boundedActivePermissionGrants,
  requirePermission,
} from "./lib/permissions";
import { redactProjectText } from "./lib/projectText";
import { maximumReviewTeamsPerEvent } from "./lib/reviewLimits";
import {
  admissionAiDisposition,
  admissionDecision,
  admissionExperienceBand,
  admissionRecommendationState,
  applicationState,
  criterionAssessment,
  noveltyBand,
} from "./values";

/** Pure ranking: human support, AI tie-break, novelty, submission time, then ID. */
export type AdmissionCohortSignals = {
  applicationId: string;
  teamSize: number;
  submittedAt: number;
  reviewAccepts: number;
  reviewDeclines: number;
  aiRecommendation: "accept" | "waitlist" | "decline" | "needs_information" | null;
  noveltyScore: number | null;
};

const aiSupportRank = {
  accept: 2,
  waitlist: 1,
  needs_information: 0,
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
  const novelty = (right.noveltyScore ?? 0) - (left.noveltyScore ?? 0);
  if (novelty !== 0) return novelty;
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
  "needs_information",
]);

const experienceBands = [
  "first_year",
  "early_year",
  "later_year",
  "postgraduate_or_professional",
  "mixed_or_external",
] as const;

type CohortRow = {
  application: Doc<"applications">;
  team: Doc<"teams">;
  project: Doc<"projectVersions">;
  teamSize: number;
  minimumHumanReviews: number;
  reviewSignal: { accept: number; waitlist: number; decline: number; needsInformation: number };
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
  novelty: {
    score: number;
    band: NonNullable<Doc<"projectDrafts">["noveltyBand"]>;
    nearestThemeLabel: string;
    nearestSimilarity?: number;
  } | null;
};

/** Loads only current-version recorded review, AI, and novelty signals. */
async function loadAdmissionCohortRows(ctx: QueryCtx, event: Doc<"events">) {
  const applications = await ctx.db
    .query("applications")
    .withIndex("by_event_state_submitted", (index) => index.eq("eventId", event._id))
    .take(maximumReviewTeamsPerEvent + 1);
  if (applications.length > maximumReviewTeamsPerEvent) {
    throw new Error(
      `Admission cohort reads support at most ${maximumReviewTeamsPerEvent} event teams.`,
    );
  }
  const policies = new Map<Id<"admissionPolicyVersions">, Doc<"admissionPolicyVersions">>();
  const rows: CohortRow[] = [];
  for (const application of applications) {
    const [team, project] = await Promise.all([
      ctx.db.get(application.teamId),
      ctx.db.get(application.submittedProjectVersionId),
    ]);
    if (!team || !project) continue;
    let policy = policies.get(application.admissionPolicyVersionId);
    if (!policy) {
      const loaded = await ctx.db.get(application.admissionPolicyVersionId);
      if (!loaded || loaded.eventId !== event._id) continue;
      policies.set(application.admissionPolicyVersionId, loaded);
      policy = loaded;
    }
    const [reviews, recommendation, draft] = await Promise.all([
      ctx.db
        .query("admissionHumanReviews")
        .withIndex("by_application_status", (index) =>
          index.eq("applicationId", application._id).eq("status", "active"),
        )
        .collect(),
      application.aiRecommendationId
        ? ctx.db.get(application.aiRecommendationId)
        : Promise.resolve(null),
      ctx.db
        .query("projectDrafts")
        .withIndex("by_team", (index) => index.eq("teamId", team._id))
        .unique(),
    ]);
    const currentReviews = reviews.filter(
      (review) => review.applicationContentVersion === application.contentVersion,
    );
    const reviewSignal = { accept: 0, waitlist: 0, decline: 0, needsInformation: 0 };
    for (const review of currentReviews) {
      if (review.recommendation === "accept") reviewSignal.accept += 1;
      else if (review.recommendation === "waitlist") reviewSignal.waitlist += 1;
      else if (review.recommendation === "decline") reviewSignal.decline += 1;
      else reviewSignal.needsInformation += 1;
    }
    // Match the AI currency check used by admissions.decide.
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
    // Use novelty only while its fingerprint matches the submitted idea.
    const noveltyValid = Boolean(
      draft &&
        draft.noveltyScore !== undefined &&
        draft.noveltyBand !== undefined &&
        draft.noveltyNearestThemeLabel !== undefined &&
        draft.noveltyEvaluatedInputFingerprint === noveltyInputFingerprint(project.initialIdea),
    );
    let novelty: CohortRow["novelty"] = null;
    if (
      noveltyValid &&
      draft &&
      draft.noveltyScore !== undefined &&
      draft.noveltyBand !== undefined &&
      draft.noveltyNearestThemeLabel !== undefined
    ) {
      const preview = draft.noveltyPreviewRequestId
        ? await ctx.db.get(draft.noveltyPreviewRequestId)
        : null;
      novelty = {
        score: draft.noveltyScore,
        band: draft.noveltyBand,
        nearestThemeLabel: draft.noveltyNearestThemeLabel,
        ...(preview &&
        preview.state === "succeeded" &&
        preview.inputFingerprint === draft.noveltyEvaluatedInputFingerprint &&
        preview.nearestSimilarity !== undefined
          ? { nearestSimilarity: preview.nearestSimilarity }
          : {}),
      };
    }
    rows.push({
      application,
      team,
      project,
      teamSize: project.lockedMemberCount,
      minimumHumanReviews: policy.minimumHumanReviews,
      reviewSignal,
      completedCurrentReviews: currentReviews.length,
      ai,
      novelty,
    });
  }
  return rows;
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
    applicationId: row.application._id,
    teamSize: row.teamSize,
    submittedAt: row.application.submittedAt,
    reviewAccepts: row.reviewSignal.accept,
    reviewDeclines: row.reviewSignal.decline,
    aiRecommendation: row.ai?.current ? (row.ai.recommendation ?? null) : null,
    noveltyScore: row.novelty ? row.novelty.score : null,
  };
}

function rosterEntry(row: CohortRow) {
  return {
    applicationId: row.application._id,
    teamId: row.team._id,
    teamName: row.team.name,
    state: row.application.state,
    teamSize: row.teamSize,
  };
}

function candidateView(row: CohortRow, selection: ReturnType<typeof selectAdmissionCohort>[number]) {
  const decidable = row.completedCurrentReviews >= row.minimumHumanReviews;
  return {
    applicationId: row.application._id,
    teamId: row.team._id,
    teamName: row.team.name,
    state: row.application.state,
    submittedAt: row.application.submittedAt,
    experienceBand: row.application.experienceBand,
    teamSize: row.teamSize,
    reviewCoverage: {
      assigned: row.application.assignedReviewCount,
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
  ctx: QueryCtx,
  event: Doc<"events">,
  requestedCapacityPeople: number | undefined,
) {
  const policy = await requirePublishedAdmissionPolicy(ctx, event);
  const capacityPeople = normalizedCapacityPeople(
    requestedCapacityPeople ?? policy.overallParticipantCapacity,
  );
  const rows = await loadAdmissionCohortRows(ctx, event);
  const committedRows = rows.filter((row) => committedStates.has(row.application.state));
  const candidateRows = rows.filter((row) => candidateStates.has(row.application.state));
  const decidedOutRows = rows.filter(
    (row) =>
      !committedStates.has(row.application.state) && !candidateStates.has(row.application.state),
  );
  const committedPeople = committedRows.reduce((total, row) => total + row.teamSize, 0);
  const selection = selectAdmissionCohort(
    candidateRows.map(candidateSignals),
    capacityPeople,
    committedPeople,
  );
  const rowById = new Map(candidateRows.map((row) => [row.application._id as string, row]));
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
  needsInformation: v.number(),
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

const noveltyView = v.union(
  v.null(),
  v.object({
    score: v.number(),
    band: noveltyBand,
    nearestThemeLabel: v.string(),
    nearestSimilarity: v.optional(v.number()),
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
  novelty: noveltyView,
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

/** Builds one live-grant matcher per permission instead of querying per row. */
async function applicationGrantMatcher(
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
  const scoped = new Set(
    live
      .filter((grant) => grant.scopeType === "application" && grant.scopeId !== undefined)
      .map((grant) => grant.scopeId),
  );
  return (applicationId: Id<"applications">) => eventWide || scoped.has(applicationId);
}

/** Filters rows and sensitive fields through the standard application grants. */
export const cohort = query({
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
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const view = await buildAdmissionCohortView(ctx, event, args.capacityPeople);
    const [canReadApplication, canReadProfile, canReadAi] = await Promise.all([
      applicationGrantMatcher(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "application.read",
      }),
      applicationGrantMatcher(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "application.profile_context.read",
      }),
      applicationGrantMatcher(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "application.ai_recommendation.read",
      }),
    ]);
    let hiddenApplicationCount = 0;
    const visible = <T extends { applicationId: Id<"applications"> }>(entries: T[]) =>
      entries.filter((entry) => {
        if (canReadApplication(entry.applicationId)) return true;
        hiddenApplicationCount += 1;
        return false;
      });
    const candidates = visible(view.candidates).map((candidate) => {
      const { experienceBand, aiRecommendation, ...rest } = candidate;
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
    informationQuestions: v.array(v.string()),
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
    // Resolve the prior operation before terminal-state checks so retries replay.
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.decision.publish",
      requestFingerprint: operationFingerprint([
        args.applicationId,
        args.expectedApplicationVersion,
        args.decision,
        args.reasonCode,
        JSON.stringify(args.informationQuestions),
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
      if (["accepted", "waitlisted", "declined", "withdrawn"].includes(application.state)) {
        return refusal(
          "APPLICATION_DECIDED",
          "This application already has a published terminal decision.",
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
      informationRequestId: Id<"admissionInformationRequests"> | null;
    } = await ctx.runMutation(api.admissions.decide, {
      eventSlug: args.eventSlug,
      applicationId: args.applicationId,
      expectedApplicationVersion: args.expectedApplicationVersion,
      decision: args.decision,
      reasonCode: args.reasonCode,
      informationQuestions: args.informationQuestions,
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
export const cohortRead = internalQuery({
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
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("The admission read event no longer exists.");
    const view = await buildAdmissionCohortView(ctx, event, args.capacityPeople);
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
  novelty: noveltyView,
  reviewCoverage: reviewCoverageView,
});

const maximumSearchMatches = 25;

/** Conjunctive text search that returns only stored signals and redacted excerpts. */
export const submissionSearchRead = internalQuery({
  args: { eventId: v.id("events"), searchQuery: v.string(), limit: v.number() },
  returns: v.object({
    generatedAt: v.number(),
    searchQuery: v.string(),
    matches: v.array(searchMatchView),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const generatedAt = Date.now();
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("The admission read event no longer exists.");
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
    const rows = await loadAdmissionCohortRows(ctx, event);
    const matched = rows.filter((row) => {
      const haystack = [
        row.team.name,
        row.project.initialIdea,
        row.novelty?.nearestThemeLabel ?? "",
      ]
        .join("\n")
        .toLocaleLowerCase("en");
      return tokens.every((token) => haystack.includes(token));
    });
    matched.sort((left, right) => left.application.submittedAt - right.application.submittedAt);
    const matches = matched.slice(0, limit).map((row) => ({
      applicationId: row.application._id,
      teamId: row.team._id,
      teamName: row.team.name,
      state: row.application.state,
      experienceBand: row.application.experienceBand,
      teamSize: row.teamSize,
      ideaExcerpt: redactProjectText(row.project.initialIdea).slice(0, 240),
      novelty: row.novelty,
      reviewCoverage: {
        assigned: row.application.assignedReviewCount,
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
      ? await ctx.runQuery(internal.admissionCohort.cohortRead, {
          eventId: resolved.eventId,
          ...(parsed.data.capacityPeople !== undefined
            ? { capacityPeople: parsed.data.capacityPeople }
            : {}),
        })
      : await ctx.runQuery(internal.admissionCohort.submissionSearchRead, {
          eventId: resolved.eventId,
          searchQuery: parsed.data.query ?? "",
          limit: parsed.data.limit ?? maximumSearchMatches,
        });
  return Response.json({ read, data }, { status: 200 });
});
