/**
 * The capacity-driven admission cohort: given an auditorium capacity in
 * PEOPLE, rank the undecided idea submissions with the signals the platform
 * already records and show which teams the line admits, which it excludes,
 * and — the whole point — which teams sit near the line as the capacity
 * number moves.
 *
 * Three rules shape everything in this file:
 *
 * 1. Nothing here decides. The cohort is a suggestion; every applied decision
 *    goes through `admissions.decide`, as the signed-in operator, with a
 *    published reason code, so the audit trail names a person. The apply
 *    mutation below is a thin, refusal-aware delegate around that mutation,
 *    never a bypass of it.
 * 2. Capacity is people, submissions are teams. A team's cost against the
 *    capacity is its locked roster size — the same
 *    `project.lockedTeamMemberIds.length` the offer pipeline reserves — and
 *    the arithmetic is returned row by row so a human can check it.
 * 3. No new scoring model. The ordering composes signals that already exist —
 *    human review recommendations, the bounded AI recommendation, the novelty
 *    score — and returns every component it used. Year bands are reported,
 *    never balanced toward: the band mix is an observation for the operator,
 *    not a quota this file enforces.
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
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { noveltyInputFingerprint } from "./lib/novelty";
import { findOperation, operationFingerprint } from "./lib/operations";
import { requirePermission } from "./lib/permissions";
import { redactProjectText } from "./lib/projectText";
import {
  admissionAiDisposition,
  admissionDecision,
  admissionExperienceBand,
  admissionRecommendationState,
  applicationState,
  criterionAssessment,
  noveltyBand,
} from "./values";

/**
 * Ranking and selection are pure and exported so the capacity arithmetic is
 * testable without a database. The ordering deliberately invents no number:
 * it compares existing signals lexicographically, strongest authority first.
 *
 * - Human reviews first: accept recommendations minus decline
 *   recommendations, because a policy-coded human read of the submission
 *   outranks everything a machine produced.
 * - The bounded AI recommendation second, as a preference order over its four
 *   published outcomes (accept > waitlist > needs_information/none >
 *   decline). It breaks ties between equally-reviewed submissions; it never
 *   overrides a human signal.
 * - The existing novelty score third. It is optional for teams, so a missing
 *   score ties with the most-familiar band rather than being penalised
 *   further; by this depth the earlier signals are already equal.
 * - Submission time last: the earlier submission wins a full tie, and the
 *   document id makes the order total so two runs never disagree.
 */
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
 * The selection is a strict prefix of the ranking: people are accumulated in
 * rank order and the line falls where the next whole team no longer fits.
 * No bin-packing — skipping a large team to admit a smaller, lower-ranked one
 * would silently reorder merit by roster size, and a human can still admit
 * the smaller team by hand.
 *
 * `entryCapacityPeople` is the property that makes capacity movement cheap:
 * it is the minimum capacity at which this team enters the suggestion, it is
 * monotone down the ranking, and it is independent of the capacity this call
 * evaluated. A UI holding one response can slide the capacity and recompute
 * every team's side of the line as `entryCapacityPeople <= capacity`, without
 * refetching anything.
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

/**
 * Which bucket a state falls into. Committed teams already hold their seats —
 * a published accept, a live offer, or a confirmation — so their people are
 * subtracted from the capacity before any suggestion is made. Decided-out
 * teams left by a human decision and are reported, never re-ranked.
 */
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

/**
 * Load every application in the event with the admission signals that already
 * exist for it. Everything here is a read of recorded state: the review
 * counts come from `admissionHumanReviews` filtered to the current content
 * version exactly the way `admissions.decide` counts them, the AI
 * recommendation is "current" under the same test `decide` applies before it
 * accepts a disposition, and the novelty signal is the one the team's own
 * intake preview stored — trusted only while its fingerprint still matches
 * the submitted idea text.
 */
async function loadAdmissionCohortRows(ctx: QueryCtx, event: Doc<"events">) {
  const applications = await ctx.db
    .query("applications")
    .withIndex("by_event_state_submitted", (index) => index.eq("eventId", event._id))
    .collect();
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
    // The same currency test `admissions.decide` applies before it lets a
    // disposition reference the AI recommendation.
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
    // The stored novelty preview counts only while it still describes the
    // submitted idea: the fingerprint is the same check intake applies before
    // it shows the signal back to the team.
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
      teamSize: project.lockedTeamMemberIds.length,
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

/**
 * The complete, viewer-independent cohort view. The operator query prunes it
 * per grant before returning; the intelligence read returns it whole because
 * its validator is the redaction. The arithmetic is always computed over the
 * whole event — a viewer who can read only some applications still sees true
 * capacity numbers, with the rows they cannot read counted, not shown.
 */
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

// The operator view carries the year band only under the profile-context
// grant; the intelligence read always carries it, because a band is policy
// vocabulary, not an identity.
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

/**
 * The per-application read gates, fetched once per permission key instead of
 * once per application. This restates the live-grant filter of
 * `matchingPermissionGrantIds` — same event, same validity window, same
 * exact-application-scope-or-event-wide rule — because calling that helper
 * hundreds of times per key would multiply identical index reads without
 * changing a single answer. The subject was already verified active by
 * `requireEventSubject` on this same request.
 */
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
  const now = Date.now();
  const grants = await ctx.db
    .query("permissionGrants")
    .withIndex("by_subject_permission_status", (index) =>
      index
        .eq("eventAccessSubjectId", args.eventAccessSubjectId)
        .eq("permissionKey", args.permissionKey)
        .eq("status", "active"),
    )
    .collect();
  const live = grants.filter(
    (grant) =>
      grant.eventId === args.eventId &&
      grant.validFrom <= now &&
      (grant.validUntil === undefined || grant.validUntil > now),
  );
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

/**
 * The operator's cohort view. Authorised exactly like the neighbouring
 * admissions queries: the event access subject is required up front, the
 * aggregate numbers are visible to any event account the way `stageCounts`
 * counts are, and every row is shown only under the same `application.read`
 * grant `admissions.list` requires — with `application.profile_context.read`
 * gating the year band and `application.ai_recommendation.read` gating the AI
 * fields, again exactly as `list` and `detail` gate them. Rows the caller
 * cannot read stay in the arithmetic and are reported as a count.
 */
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

// Written out because the handler both returns through `api.admissions.decide`
// and appears inside `api` itself; without the annotation the reference is
// circular and TypeScript gives the whole mutation type `any`.
type ApplyDecisionResult =
  | {
      applied: true;
      applicationId: Id<"applications">;
      state: Infer<typeof applicationState>;
      applicationVersion: number;
    }
  | { applied: false; refusal: Infer<typeof applyRefusal> };

/**
 * Apply one operator decision for one application in the cohort view. The
 * decision itself is `admissions.decide`, run through `ctx.runMutation` as
 * this signed-in operator — the same delegation shape
 * `intelligenceRecommendations.executeApprovedKind` uses — so the review
 * minimum, the published reason code, the AI disposition rules, and the
 * decision audit all re-check and re-record there under the operator's own
 * grants. What this wrapper adds is an honest refusal: the policy conditions
 * `decide` would reject are checked first and returned as data with the
 * review arithmetic attached, so the cohort surface can say "one more review
 * needed" instead of surfacing a thrown error.
 */
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
    // A retried apply must replay, not refuse: after a successful decision the
    // application is terminal, so the refusal checks below would misread the
    // retry as a conflict. `decide` records its operation under this exact
    // fingerprint recipe; finding it here short-circuits to the same replay
    // `decide` itself would return.
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

/**
 * The intelligence-facing reads. The same signed keyhole discipline as
 * `intelligenceReads.ts`: the Worker names one whitelisted read with bounded
 * parameters, Convex runs its own projection, and the `returns` validators
 * are the redaction. These reads carry team names (operator-visible on
 * `admissions.list`), ids, aggregate counts, year bands, and scores against
 * published policy — and never a participant's name, email, or membership
 * detail; team rosters appear only as a size.
 */
export const cohortRead = internalQuery({
  args: { eventId: v.id("events"), capacityPeople: v.optional(v.number()) },
  returns: v.object({
    generatedAt: v.number(),
    capacityPeople: v.number(),
    policy: cohortPolicyView,
    summary: cohortSummaryView,
    committed: v.array(rosterEntryView),
    decidedOut: v.array(rosterEntryView),
    candidates: v.array(internalCandidateView),
  }),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("The admission read event no longer exists.");
    return buildAdmissionCohortView(ctx, event, args.capacityPeople);
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

/**
 * Word search over this event's submissions. Matching is plain, conjunctive
 * substring matching over the team name, the submitted idea, and the stored
 * nearest-theme label — no embedding call, no new score; the novelty and
 * similarity numbers returned are the ones the intake preview already
 * computed and stored. The excerpt passes through `redactProjectText`, the
 * same scrub the admission model input uses.
 */
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

/**
 * The signed HTTP boundary for the admission reads, mirroring
 * `intelligenceReadEndpoint` byte for byte in its checks: media type, body
 * size, a fresh HMAC over the exact body under this route's own signature
 * context, then a strict parse. The read secret is shared with the operations
 * reads — both prove "the intelligence Worker may ask for a redacted
 * projection" — but the distinct context means neither route's traffic
 * replays on the other.
 */
export const admissionIntelligenceReadEndpoint = httpAction(async (ctx, request) => {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    return Response.json({ error: "unsupported_media_type" }, { status: 415 });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBodyBytes) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maximumBodyBytes) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
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
