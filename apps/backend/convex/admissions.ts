import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
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
import {
  requireCurrentPerson,
  requireEventSubject,
  requireFreshAuthSession,
  requireMembership,
  sensitiveCommandSessionMaxAgeMs,
} from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import {
  insertPermissionGrant,
  matchingPermissionGrantIds,
  requirePermission,
  revokeSourceGrants,
} from "./lib/permissions";
import {
  enqueueAdmissionDecisionNotifications,
  enqueueApplicationNotifications,
} from "./lib/participantNotificationDelivery";
import {
  normalizeEmail,
  normalizedLongText,
  normalizedText,
  optionalNormalizedText,
} from "./lib/strings";
import { requireProjectTrackSelection } from "./lib/trackCatalog";
import {
  admissionDecision,
  admissionReviewAssignmentState,
  applicationState,
  criterionAssessment,
  participantClass,
  studyYear,
} from "./values";

const admissionOfferState = v.union(
  v.literal("offered"),
  v.literal("confirmed"),
  v.literal("declined"),
  v.literal("expired"),
  v.literal("revoked"),
);

const listItem = v.object({
  id: v.id("applications"),
  teamName: v.string(),
  state: applicationState,
  experienceBand: v.optional(v.string()),
  trackName: v.string(),
  submittedAt: v.number(),
  aiState: v.optional(v.string()),
  assignedReviewCount: v.number(),
  completedReviewCount: v.number(),
  version: v.number(),
});

/**
 * How many applications sit at each stage.
 *
 * The queue filters by one stage at a time, so without these an operator who
 * lands on an empty stage cannot tell whether there are no applications at all
 * or simply none here. specs/06:169 asks the workspace to group records by the
 * next real action; that only reads if the sizes of the groups are visible.
 */
export const stageCounts = query({
  args: { eventSlug: v.string() },
  returns: v.array(v.object({ state: applicationState, count: v.number() })),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    await requireEventSubject(ctx, event._id, person._id);
    const applications = await ctx.db
      .query("applications")
      .withIndex("by_event_state_submitted", (index) => index.eq("eventId", event._id))
      .collect();
    const counts = new Map<Doc<"applications">["state"], number>();
    for (const application of applications) {
      counts.set(application.state, (counts.get(application.state) ?? 0) + 1);
    }
    return [...counts.entries()].map(([state, count]) => ({ state, count }));
  },
});

export const list = query({
  args: {
    eventSlug: v.string(),
    state: v.optional(applicationState),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(listItem),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const page = await ctx.db
      .query("applications")
      .withIndex("by_event_state_submitted", (index) => {
        const eventIndex = index.eq("eventId", event._id);
        return args.state ? eventIndex.eq("state", args.state) : eventIndex;
      })
      .order("asc")
      .paginate(args.paginationOpts);
    const visible = [];
    for (const application of page.page) {
      const grantIds = await matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "application.read",
        scopeType: "application",
        scopeId: application._id,
      });
      if (grantIds.length === 0) continue;
      const [profileGrantIds, aiGrantIds, team, project] = await Promise.all([
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "application.profile_context.read",
          scopeType: "application",
          scopeId: application._id,
        }),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "application.ai_recommendation.read",
          scopeType: "application",
          scopeId: application._id,
        }),
        ctx.db.get(application.teamId),
        ctx.db.get(application.submittedProjectVersionId),
      ]);
      if (!team || !project) continue;
      const track = await ctx.db.get(project.coreTrackVersionId);
      if (!track || track.eventId !== event._id) continue;
      const recommendation =
        aiGrantIds.length > 0 && application.aiRecommendationId
          ? await ctx.db.get(application.aiRecommendationId)
          : null;
      visible.push({
        id: application._id,
        teamName: team.name,
        state: application.state,
        ...(profileGrantIds.length > 0
          ? { experienceBand: application.experienceBand }
          : {}),
        trackName: track.displayName,
        submittedAt: application.submittedAt,
        ...(recommendation ? { aiState: recommendation.state } : {}),
        assignedReviewCount: application.assignedReviewCount,
        completedReviewCount: application.completedReviewCount,
        version: application.version,
      });
    }
    return { ...page, page: visible };
  },
});

const assignedReviewItem = v.object({
  assignmentId: v.id("admissionReviewAssignments"),
  assignmentState: admissionReviewAssignmentState,
  assignmentVersion: v.number(),
  assignedAt: v.number(),
  applicationId: v.id("applications"),
  applicationState,
  applicationVersion: v.number(),
  teamName: v.string(),
  trackName: v.string(),
  experienceBand: v.optional(v.string()),
  aiState: v.optional(v.string()),
  ownRecommendation: v.optional(admissionDecision),
});

export const myReviewAssignments = query({
  args: {
    eventSlug: v.string(),
    state: admissionReviewAssignmentState,
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(assignedReviewItem),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const page = await ctx.db
      .query("admissionReviewAssignments")
      .withIndex("by_event_reviewer_state_assigned", (index) =>
        index
          .eq("eventId", event._id)
          .eq("reviewerPersonId", person._id)
          .eq("state", args.state),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    const visible = [];
    for (const assignment of page.page) {
      const application = await ctx.db.get(assignment.applicationId);
      if (!application || application.eventId !== event._id) continue;
      const reviewReadGrantIds = await matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "application.review.read",
        scopeType: "application",
        scopeId: application._id,
      });
      if (reviewReadGrantIds.length === 0) continue;
      const [team, project, profileGrantIds, aiGrantIds, ownReview] = await Promise.all([
        ctx.db.get(application.teamId),
        ctx.db.get(application.submittedProjectVersionId),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "application.profile_context.read",
          scopeType: "application",
          scopeId: application._id,
        }),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "application.ai_recommendation.read",
          scopeType: "application",
          scopeId: application._id,
        }),
        ctx.db
          .query("admissionHumanReviews")
          .withIndex("by_application_reviewer_status", (index) =>
            index
              .eq("applicationId", application._id)
              .eq("reviewerPersonId", person._id)
              .eq("status", "active"),
          )
          .unique(),
      ]);
      if (!team || !project) continue;
      const track = await ctx.db.get(project.coreTrackVersionId);
      if (!track || track.eventId !== event._id) continue;
      const recommendation =
        aiGrantIds.length > 0 && application.aiRecommendationId
          ? await ctx.db.get(application.aiRecommendationId)
          : null;
      visible.push({
        assignmentId: assignment._id,
        assignmentState: assignment.state,
        assignmentVersion: assignment.version,
        assignedAt: assignment.assignedAt,
        applicationId: application._id,
        applicationState: application.state,
        applicationVersion: application.version,
        teamName: team.name,
        trackName: track.displayName,
        ...(profileGrantIds.length > 0
          ? { experienceBand: application.experienceBand }
          : {}),
        ...(recommendation ? { aiState: recommendation.state } : {}),
        ...(ownReview?.applicationContentVersion === application.contentVersion
          ? { ownRecommendation: ownReview.recommendation }
          : {}),
      });
    }
    return { ...page, page: visible };
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
  state: admissionReviewAssignmentState,
  version: v.number(),
  assignedAt: v.number(),
  completedAt: v.optional(v.number()),
  cancelledAt: v.optional(v.number()),
  cancellationReason: v.optional(v.string()),
});

export const detail = query({
  args: { eventSlug: v.string(), applicationId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      eventTimezone: v.string(),
      application: v.object({
        id: v.id("applications"),
        state: applicationState,
        experienceBand: v.optional(v.string()),
        assignedReviewCount: v.number(),
        completedReviewCount: v.number(),
        contentVersion: v.number(),
        version: v.number(),
        submittedAt: v.number(),
        humanDecision: v.optional(admissionDecision),
        humanReasonCode: v.optional(v.string()),
        aiDisposition: v.optional(v.string()),
      }),
      team: v.object({ id: v.id("teams"), name: v.string(), members: v.array(memberView) }),
      project: v.object({
        id: v.id("projectVersions"),
        initialIdea: v.string(),
        intakeResponses: v.array(
          v.object({
            ordinal: v.number(),
            question: v.string(),
            answer: v.optional(v.string()),
            skipped: v.boolean(),
          }),
        ),
        informationResponses: v.array(
          v.object({
            requestId: v.id("admissionInformationRequests"),
            answers: v.array(
              v.object({
                questionKey: v.string(),
                question: v.string(),
                answer: v.string(),
              }),
            ),
            respondedAt: v.number(),
          }),
        ),
        trackName: v.string(),
        sponsorTracks: v.array(
          v.object({ id: v.id("trackVersions"), name: v.string(), eligibilityText: v.string() }),
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
          state: v.string(),
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
          proposedQuestions: v.array(v.string()),
          confidence: v.optional(v.string()),
          limitations: v.array(v.string()),
        }),
      ),
      aiRecommendationVisible: v.boolean(),
      humanReviews: v.array(
        v.object({
          id: v.id("admissionHumanReviews"),
          reviewerName: v.string(),
          recommendation: admissionDecision,
          reasonCode: v.string(),
          note: v.optional(v.string()),
          createdAt: v.number(),
        }),
      ),
      currentInformationRequest: v.union(
        v.null(),
        v.object({
          id: v.id("admissionInformationRequests"),
          state: v.union(
            v.literal("open"),
            v.literal("answered"),
            v.literal("superseded"),
          ),
          questions: v.array(
            v.object({ questionKey: v.string(), question: v.string() }),
          ),
          answers: v.optional(
            v.array(v.object({ questionKey: v.string(), answer: v.string() })),
          ),
          requestedAt: v.number(),
          respondedAt: v.optional(v.number()),
          version: v.number(),
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
      capacity: v.union(
        v.null(),
        v.object({ capacity: v.number(), reserved: v.number() }),
      ),
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
      assignmentGrantIds,
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
        permissionKey: "application.assign",
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
    const [
      recommendation,
      currentInformationRequest,
      capacity,
      currentOffer,
      assignmentRows,
    ] = await Promise.all([
      canReadAiRecommendation && application.aiRecommendationId
        ? ctx.db.get(application.aiRecommendationId)
        : Promise.resolve(null),
      application.currentInformationRequestId
        ? ctx.db.get(application.currentInformationRequestId)
        : Promise.resolve(null),
      canReadApplication
        ? ctx.db
        .query("admissionCapacityBuckets")
        .withIndex("by_policy_scope_track", (index) =>
          index
            .eq("admissionPolicyVersionId", application.admissionPolicyVersionId)
            .eq("scope", "overall")
            .eq("trackVersionId", undefined),
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
    const { coreTrack: track, sponsorTracks } = await requireProjectTrackSelection(
      ctx,
      project,
    );
    const members = [];
    for (const teamMemberId of project.lockedTeamMemberIds) {
      const teamMember = await ctx.db.get(teamMemberId);
      if (!teamMember || teamMember.teamId !== team._id) return null;
      const membership = await ctx.db.get(teamMember.membershipId);
      if (!membership || membership.eventId !== event._id) return null;
      const [profile, memberPerson] = await Promise.all([
        canReadProfileContext
          ? ctx.db
          .query("participantProfiles")
          .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
              .unique()
          : Promise.resolve(null),
        ctx.db.get(membership.personId),
      ]);
      if (!memberPerson || (canReadProfileContext && !profile)) return null;
      members.push({
        membershipId: membership._id,
        displayName:
          profile?.preferredName ?? profile?.fullName ?? memberPerson.displayName,
        profileContext: profile
          ? {
              participantClass: membership.participantClass,
              yearOfStudy: profile.yearOfStudy,
              institution: profile.institution,
            }
          : null,
      });
    }
    const currentReviews = reviews.filter(
      (review) => review.applicationContentVersion === application.contentVersion,
    );
    const ownReview = currentReviews.find(
      (review) => review.reviewerPersonId === person._id,
    );
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
            index
              .eq("eventId", event._id)
              .eq("personId", assignment.reviewerPersonId),
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
        state: assignment.state,
        version: assignment.version,
        assignedAt: assignment.assignedAt,
        ...(assignment.completedAt !== undefined
          ? { completedAt: assignment.completedAt }
          : {}),
        ...(assignment.cancelledAt !== undefined
          ? { cancelledAt: assignment.cancelledAt }
          : {}),
        ...(assignment.cancellationReason !== undefined
          ? { cancellationReason: assignment.cancellationReason }
          : {}),
      });
    }
    return {
      eventTimezone: event.timezone,
      application: {
        id: application._id,
        state: application.state,
        ...(canReadProfileContext
          ? { experienceBand: application.experienceBand }
          : {}),
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
      team: { id: team._id, name: team.name, members },
      project: {
        id: project._id,
        initialIdea: project.initialIdea,
        intakeResponses: project.intakeResponses.map((response) => ({
          ordinal: response.ordinal,
          question: response.question,
          ...(response.answer !== undefined ? { answer: response.answer } : {}),
          skipped: response.skipped,
        })),
        informationResponses: (project.admissionInformationResponses ?? []).map(
          (response) => ({
            requestId: response.requestId,
            answers: response.answers,
            respondedAt: response.respondedAt,
          }),
        ),
        trackName: track.displayName,
        sponsorTracks: sponsorTracks.map((sponsorTrack) => ({
          id: sponsorTrack._id,
          name: sponsorTrack.displayName,
          eligibilityText: sponsorTrack.eligibilityText,
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
      aiRecommendation: recommendation
        && recommendation.eventId === event._id
        && recommendation.applicationId === application._id
        ? {
            id: recommendation._id,
            state: recommendation.state,
            ...(recommendation.recommendation !== undefined
              ? { recommendation: recommendation.recommendation }
              : {}),
            criterionAssessments: recommendation.criterionAssessments,
            strengths: recommendation.strengths,
            concerns: recommendation.concerns,
            proposedQuestions: recommendation.proposedQuestions,
            ...(recommendation.confidence !== undefined
              ? { confidence: recommendation.confidence }
              : {}),
            limitations: recommendation.limitations,
          }
        : null,
      aiRecommendationVisible: canReadAiRecommendation,
      humanReviews: reviewViews,
      currentInformationRequest:
        currentInformationRequest &&
        currentInformationRequest.eventId === event._id &&
        currentInformationRequest.applicationId === application._id &&
        currentInformationRequest.teamId === team._id
          ? {
              id: currentInformationRequest._id,
              state: currentInformationRequest.state,
              questions: currentInformationRequest.questions,
              ...(currentInformationRequest.answers !== undefined
                ? { answers: currentInformationRequest.answers }
                : {}),
              requestedAt: currentInformationRequest.requestedAt,
              ...(currentInformationRequest.respondedAt !== undefined
                ? { respondedAt: currentInformationRequest.respondedAt }
                : {}),
              version: currentInformationRequest.version,
            }
          : null,
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
      capacity: capacity
        ? { capacity: capacity.capacity, reserved: capacity.reserved }
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

function decisionState(decision: Doc<"applications">["humanDecision"]): Doc<"applications">["state"] {
  if (decision === "accept") return "accepted";
  if (decision === "waitlist") return "waitlisted";
  if (decision === "decline") return "declined";
  return "needs_information";
}

export function normalizeInformationQuestions(
  decision: NonNullable<Doc<"applications">["humanDecision"]>,
  values: readonly string[],
) {
  if (decision !== "needs_information") {
    if (values.length !== 0) {
      throw new ConvexError({
        code: "INFORMATION_QUESTIONS_NOT_ALLOWED",
        message: "Information questions apply only to Needs information.",
      });
    }
    return [];
  }
  if (values.length < 1 || values.length > 2) {
    throw new ConvexError({
      code: "INFORMATION_QUESTIONS_REQUIRED",
      message: "Ask one or two short questions for the team.",
    });
  }
  const questions = values.map((value, index) => ({
    questionKey: `question_${index + 1}`,
    question: normalizedLongText(value, `Information question ${index + 1}`, 8, 240),
  }));
  if (new Set(questions.map(({ question }) => question.toLowerCase())).size !== questions.length) {
    throw new ConvexError({
      code: "INFORMATION_QUESTIONS_DUPLICATE",
      message: "Ask two different questions.",
    });
  }
  return questions;
}

export async function replaceAdmissionInformationRequest(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    application: Doc<"applications">;
    project: Doc<"projectVersions">;
    decision: NonNullable<Doc<"applications">["humanDecision"]>;
    decisionReasonCode: string;
    informationQuestions: readonly string[];
    requestedByPersonId: Id<"people">;
    now: number;
  },
) {
  const questions = normalizeInformationQuestions(
    args.decision,
    args.informationQuestions,
  );
  const currentInformationRequest = args.application.currentInformationRequestId
    ? await ctx.db.get(args.application.currentInformationRequestId)
    : null;
  if (
    currentInformationRequest &&
    (currentInformationRequest.eventId !== args.event._id ||
      currentInformationRequest.applicationId !== args.application._id ||
      currentInformationRequest.teamId !== args.application.teamId)
  ) {
    throw new Error("The application's information request pointer is invalid.");
  }
  if (currentInformationRequest?.state === "open") {
    await ctx.db.patch(currentInformationRequest._id, {
      state: "superseded",
      supersededAt: args.now,
      version: currentInformationRequest.version + 1,
    });
  }
  const informationRequestId =
    args.decision === "needs_information"
      ? await ctx.db.insert("admissionInformationRequests", {
          eventId: args.event._id,
          applicationId: args.application._id,
          teamId: args.application.teamId,
          sourceProjectVersionId: args.project._id,
          applicationContentVersion: args.application.contentVersion,
          decisionReasonCode: args.decisionReasonCode,
          questions,
          state: "open",
          requestedByPersonId: args.requestedByPersonId,
          requestedAt: args.now,
          version: 1,
        })
      : null;
  return { informationRequestId, informationQuestionCount: questions.length };
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
const activeReviewAssignmentState: Doc<"admissionReviewAssignments">["state"] =
  "active";
const cancelledReviewAssignmentState: Doc<"admissionReviewAssignments">["state"] =
  "cancelled";

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
    args.application.state !== "under_review" &&
    args.application.state !== "needs_information"
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
  for (const permissionKey of [
    "application.review.read",
    "application.review",
  ] as const) {
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
      const assignmentId = ctx.db.normalizeId(
        "admissionReviewAssignments",
        prior.targetId,
      );
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
      const assignmentId = ctx.db.normalizeId(
        "admissionReviewAssignments",
        prior.targetId,
      );
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
  if (["accepted", "waitlisted", "declined", "withdrawn"].includes(args.application.state)) {
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
    completedReviewCount:
      args.application.completedReviewCount + (replacesCurrentReview ? 0 : 1),
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
      const review = await ctx.db.get(reviewId);
      const currentApplication = await ctx.db.get(args.applicationId);
      if (!review || !currentApplication) throw new Error("Prior admission review no longer resolves.");
      return { reviewId, applicationVersion: currentApplication.version };
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
  const participantCount = args.project.lockedTeamMemberIds.length;
  const overall = await ctx.db
    .query("admissionCapacityBuckets")
    .withIndex("by_policy_scope_track", (index) =>
      index
        .eq("admissionPolicyVersionId", args.policy._id)
        .eq("scope", "overall")
        .eq("trackVersionId", undefined),
    )
    .unique();
  if (!overall || overall.eventId !== args.eventId) {
    throw new Error("Published admission capacity is missing.");
  }
  const track = await ctx.db
    .query("admissionCapacityBuckets")
    .withIndex("by_policy_scope_track", (index) =>
      index
        .eq("admissionPolicyVersionId", args.policy._id)
        .eq("scope", "track")
        .eq("trackVersionId", args.project.coreTrackVersionId),
    )
    .unique();
  if (overall.reserved + participantCount > overall.capacity) {
    throw new ConvexError({
      code: "ADMISSION_CAPACITY_FULL",
      message: "Sending this offer would exceed the published participant capacity.",
    });
  }
  if (track && track.reserved + participantCount > track.capacity) {
    throw new ConvexError({
      code: "TRACK_CAPACITY_FULL",
      message: "Sending this offer would exceed the published track capacity.",
    });
  }
  await ctx.db.patch(overall._id, {
    reserved: overall.reserved + participantCount,
    version: overall.version + 1,
    updatedAt: args.now,
  });
  if (track) {
    await ctx.db.patch(track._id, {
      reserved: track.reserved + participantCount,
      version: track.version + 1,
      updatedAt: args.now,
    });
  }
  await ctx.db.insert("admissionCapacityReservations", {
    eventId: args.eventId,
    applicationId: args.application._id,
    offerId: args.offerId,
    admissionPolicyVersionId: args.policy._id,
    trackVersionId: args.project.coreTrackVersionId,
    participantCount,
    trackCapacityReserved: Boolean(track),
    state: "active",
    reservedAt: args.now,
  });
}

type CapacityReleaseReason = NonNullable<
  Doc<"admissionCapacityReservations">["releasedReason"]
>;

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
    .withIndex("by_policy_scope_track", (index) =>
      index
        .eq("admissionPolicyVersionId", reservation.admissionPolicyVersionId)
        .eq("scope", "overall")
        .eq("trackVersionId", undefined),
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
  if (reservation.trackCapacityReserved) {
    const track = await ctx.db
      .query("admissionCapacityBuckets")
      .withIndex("by_policy_scope_track", (index) =>
        index
          .eq("admissionPolicyVersionId", reservation.admissionPolicyVersionId)
          .eq("scope", "track")
          .eq("trackVersionId", reservation.trackVersionId),
      )
      .unique();
    if (!track || track.eventId !== args.offer.eventId) {
      throw new Error("The track admission capacity bucket is missing.");
    }
    if (track.reserved < reservation.participantCount) {
      throw new Error("The track admission reservation count is inconsistent.");
    }
    await ctx.db.patch(track._id, {
      reserved: track.reserved - reservation.participantCount,
      version: track.version + 1,
      updatedAt: args.now,
    });
  }
  await ctx.db.patch(reservation._id, {
    state: "released",
    releasedAt: args.now,
    releasedReason: args.reason,
    ...(args.releasedByPersonId !== undefined
      ? { releasedByPersonId: args.releasedByPersonId }
      : {}),
  });
}

export const decide = mutation({
  args: {
    eventSlug: v.string(),
    applicationId: v.id("applications"),
    expectedApplicationVersion: v.number(),
    decision: admissionDecision,
    reasonCode: v.string(),
    informationQuestions: v.array(v.string()),
    aiDisposition,
    clientOperationId: v.string(),
  },
  returns: v.object({
    applicationId: v.id("applications"),
    state: applicationState,
    applicationVersion: v.number(),
    informationRequestId: v.union(v.null(), v.id("admissionInformationRequests")),
  }),
  handler: async (ctx, args) => {
    const { event, person, subject, application } = await applicationContext(ctx, args);
    const requestFingerprint = operationFingerprint([
      args.applicationId,
      args.expectedApplicationVersion,
      args.decision,
      args.reasonCode,
      JSON.stringify(args.informationQuestions),
      args.aiDisposition,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.decision.publish",
      requestFingerprint,
    });
    if (prior) {
      const replayApplicationId = ctx.db.normalizeId("applications", prior.targetId);
      if (!replayApplicationId) throw new Error("Prior admission decision is invalid.");
      const replay = await ctx.db.get(replayApplicationId);
      if (!replay) throw new Error("Prior admission decision no longer resolves.");
      return {
        applicationId: replay._id,
        state: replay.state,
        applicationVersion: replay.version,
        informationRequestId: replay.currentInformationRequestId ?? null,
      };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.decide",
      scopeType: "application",
      scopeId: application._id,
    });
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
        message: "The application changed. Review it before publishing a decision.",
      });
    }
    if (["accepted", "waitlisted", "declined", "withdrawn"].includes(application.state)) {
      throw new ConvexError({
        code: "APPLICATION_DECIDED",
        message: "This application already has a published terminal decision.",
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
      (canReadAiRecommendation && recommendation?.state === "stale"
        ? "stale"
        : "unavailable")
    ) {
      throw new ConvexError({
        code: "AI_DISPOSITION_INVALID",
        message: "Record the unavailable or stale AI state before publishing.",
      });
    }
    const now = Date.now();
    const decisionReasonCode = await requirePolicyReason(
      ctx,
      application,
      args.decision,
      args.reasonCode,
    );
    const state = decisionState(args.decision);
    const applicationVersion = application.version + 1;
    const informationRequest = await replaceAdmissionInformationRequest(ctx, {
      event,
      application,
      project,
      decision: args.decision,
      decisionReasonCode,
      informationQuestions: args.informationQuestions,
      requestedByPersonId: person._id,
      now,
    });
    const informationRequestId = informationRequest.informationRequestId;
    await ctx.db.patch(application._id, {
      state,
      humanDecision: args.decision,
      humanReasonCode: decisionReasonCode,
      aiDisposition: args.aiDisposition,
      decidedByPersonId: person._id,
      decidedAt: now,
      currentInformationRequestId: informationRequestId ?? undefined,
      version: applicationVersion,
    });
    if (args.decision === "accept") {
      const team = await ctx.db.get(application.teamId);
      if (!team || team.lockedProjectVersionId !== project._id) {
        throw new Error("Locked team context is missing.");
      }
      await ctx.db.patch(team._id, {
        status: "admitted",
        version: team.version + 1,
        updatedAt: now,
      });
      for (const teamMemberId of project.lockedTeamMemberIds) {
        const teamMember = await ctx.db.get(teamMemberId);
        if (!teamMember || teamMember.teamId !== team._id) {
          throw new Error("Locked team membership is missing.");
        }
        await ctx.db.patch(teamMember.membershipId, {
          onboardingStatus: "selected",
          updatedAt: now,
        });
      }
    }
    const notificationDeliveryIds = await enqueueAdmissionDecisionNotifications(ctx, {
      eventId: event._id,
      applicationId: application._id,
      teamId: application.teamId,
      lockedTeamMemberIds: project.lockedTeamMemberIds,
      decision: args.decision,
      applicationVersion,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.decision.publish",
      requestFingerprint,
      targetType: "application",
      targetId: application._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "application.decide",
      grantIds,
      scopeType: "application",
      scopeId: application._id,
      action: "admission.human_decision_published",
      targetType: "application",
      targetId: application._id,
      previousSummary: JSON.stringify({ state: application.state, version: application.version }),
      nextSummary: JSON.stringify({
        state,
        decision: args.decision,
        reasonCode: decisionReasonCode,
        aiDisposition: args.aiDisposition,
        humanReviewCount: currentReviews.length,
        informationQuestionCount: informationRequest.informationQuestionCount,
        notificationDeliveryCount: notificationDeliveryIds.length,
        version: applicationVersion,
      }),
      reason: "Published the human admission decision",
    });
    return {
      applicationId: application._id,
      state,
      applicationVersion,
      informationRequestId,
    };
  },
});

type InformationAnswer = NonNullable<
  Doc<"admissionInformationRequests">["answers"]
>[number];

export function normalizeInformationAnswers(
  request: Doc<"admissionInformationRequests">,
  values: readonly InformationAnswer[],
) {
  if (values.length !== request.questions.length) {
    throw new ConvexError({
      code: "INFORMATION_ANSWERS_INCOMPLETE",
      message: "Answer every requested question before submitting.",
    });
  }
  const answers = values.map((value) => ({
    questionKey: normalizedText(value.questionKey, "Question key", 1, 40),
    answer: normalizedLongText(value.answer, "Information answer", 2, 1_200),
  }));
  if (new Set(answers.map(({ questionKey }) => questionKey)).size !== answers.length) {
    throw new ConvexError({
      code: "INFORMATION_ANSWERS_DUPLICATE",
      message: "Each requested question must have one answer.",
    });
  }
  if (
    request.questions.some(
      (question, index) => answers[index]?.questionKey !== question.questionKey,
    )
  ) {
    throw new ConvexError({
      code: "INFORMATION_ANSWERS_CHANGED",
      message: "The requested questions changed. Review them before submitting.",
    });
  }
  return answers;
}

export async function respondToAdmissionInformationRequest(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    application: Doc<"applications">;
    expectedApplicationVersion: number;
    request: Doc<"admissionInformationRequests">;
    expectedRequestVersion: number;
    membership: Doc<"eventMemberships">;
    answers: readonly InformationAnswer[];
    now: number;
  },
) {
  if (args.application.version !== args.expectedApplicationVersion) {
    throw new ConvexError({
      code: "APPLICATION_CHANGED",
      message: "The application changed. Review the current request before submitting.",
    });
  }
  if (
    args.application.state !== "needs_information" ||
    args.application.currentInformationRequestId !== args.request._id ||
    args.request.eventId !== args.event._id ||
    args.request.applicationId !== args.application._id ||
    args.request.teamId !== args.application.teamId ||
    args.request.sourceProjectVersionId !== args.application.submittedProjectVersionId ||
    args.request.applicationContentVersion !== args.application.contentVersion
  ) {
    throw new ConvexError({
      code: "INFORMATION_REQUEST_CHANGED",
      message: "That information request is no longer current.",
    });
  }
  if (args.request.version !== args.expectedRequestVersion || args.request.state !== "open") {
    throw new ConvexError({
      code: "INFORMATION_REQUEST_CHANGED",
      message: "That information request changed. Refresh before submitting.",
    });
  }
  const answers = normalizeInformationAnswers(args.request, args.answers);
  const [team, project, member, admissionConfiguration] = await Promise.all([
    ctx.db.get(args.application.teamId),
    ctx.db.get(args.application.submittedProjectVersionId),
    ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index
          .eq("eventId", args.event._id)
          .eq("membershipId", args.membership._id)
          .eq("status", "active"),
      )
      .unique(),
    loadPublishedAdmissionConfiguration(ctx, args.event),
  ]);
  if (
    !team ||
    !project ||
    !member ||
    member.teamId !== team._id ||
    !project.lockedTeamMemberIds.includes(member._id) ||
    member.role !== "lead" ||
    team.leadMembershipId !== args.membership._id ||
    project.lockedLeadMembershipId !== args.membership._id
  ) {
    throw new ConvexError({
      code: "LOCKED_LEAD_REQUIRED",
      message: "The locked team lead must submit this response.",
    });
  }
  if (
    team.lockedProjectVersionId !== project._id ||
    admissionConfiguration.policy._id !== args.application.admissionPolicyVersionId
  ) {
    throw new Error("The locked application context is inconsistent.");
  }
  const [previousProjectVersion, activeReviews, activeAssignments, priorRecommendation] =
    await Promise.all([
      ctx.db
        .query("projectVersions")
        .withIndex("by_team_version", (index) => index.eq("teamId", team._id))
        .order("desc")
        .first(),
      ctx.db
        .query("admissionHumanReviews")
        .withIndex("by_application_status", (index) =>
          index.eq("applicationId", args.application._id).eq("status", "active"),
        )
        .collect(),
      ctx.db
        .query("admissionReviewAssignments")
        .withIndex("by_application_state_assigned", (index) =>
          index.eq("applicationId", args.application._id).eq("state", "active"),
        )
        .collect(),
      args.application.aiRecommendationId
        ? ctx.db.get(args.application.aiRecommendationId)
        : Promise.resolve(null),
    ]);
  if (!previousProjectVersion || previousProjectVersion._id !== project._id) {
    throw new Error("The application does not point to the latest project version.");
  }
  const projectAnswers = args.request.questions.map((question) => {
    const answer = answers.find((candidate) => candidate.questionKey === question.questionKey);
    if (!answer) throw new Error("A normalized information answer is missing.");
    return { ...answer, question: question.question };
  });
  const nextContentVersion = args.application.contentVersion + 1;
  const responseProjectVersionId = await ctx.db.insert("projectVersions", {
    eventId: project.eventId,
    teamId: project.teamId,
    version: project.version + 1,
    initialIdea: project.initialIdea,
    intakePolicyVersionId: project.intakePolicyVersionId,
    intakeResponses: project.intakeResponses,
    coreTrackVersionId: project.coreTrackVersionId,
    sponsorTrackVersionIds: project.sponsorTrackVersionIds,
    lockedTeamMemberIds: project.lockedTeamMemberIds,
    lockedLeadMembershipId: project.lockedLeadMembershipId,
    freshForEventAttestation: project.freshForEventAttestation,
    finalConfirmation: project.finalConfirmation,
    participantPolicyVersionId: project.participantPolicyVersionId,
    admissionPolicyVersionId: project.admissionPolicyVersionId,
    admissionInformationResponses: [
      ...(project.admissionInformationResponses ?? []),
      {
        requestId: args.request._id,
        sourceProjectVersionId: project._id,
        answers: projectAnswers,
        respondedByMembershipId: args.membership._id,
        respondedAt: args.now,
      },
    ],
    sourceDraftVersion: project.sourceDraftVersion,
    submittedByMembershipId: args.membership._id,
    submittedAt: args.now,
  });
  const responseProject = await ctx.db.get(responseProjectVersionId);
  if (!responseProject) throw new Error("The information-response project did not persist.");
  for (const review of activeReviews) {
    await ctx.db.patch(review._id, { status: "superseded" });
  }
  for (const assignment of activeAssignments) {
    await ctx.db.patch(assignment._id, {
      applicationContentVersion: nextContentVersion,
      version: assignment.version + 1,
    });
  }
  if (
    priorRecommendation &&
    (priorRecommendation.state === "pending" || priorRecommendation.state === "running")
  ) {
    await ctx.db.patch(priorRecommendation._id, {
      state: "stale",
      completedAt: args.now,
      failureCategory: "information_response_submitted",
    });
  }
  await ctx.db.patch(args.request._id, {
    state: "answered",
    answers,
    responseProjectVersionId,
    respondedByMembershipId: args.membership._id,
    respondedAt: args.now,
    version: args.request.version + 1,
  });
  await ctx.db.patch(team._id, {
    lockedProjectVersionId: responseProjectVersionId,
    version: team.version + 1,
    updatedAt: args.now,
  });
  await ctx.db.patch(args.application._id, {
    submittedProjectVersionId: responseProjectVersionId,
    state: "under_review",
    humanDecision: undefined,
    humanReasonCode: undefined,
    aiDisposition: undefined,
    aiRecommendationId: undefined,
    decidedByPersonId: undefined,
    decidedAt: undefined,
    assignedReviewCount: activeAssignments.length,
    completedReviewCount: 0,
    contentVersion: nextContentVersion,
    version: args.application.version + 1,
  });
  const updatedApplication = await ctx.db.get(args.application._id);
  if (!updatedApplication) throw new Error("The updated application did not persist.");
  await createAdmissionRecommendation(ctx, {
    application: updatedApplication,
    project: responseProject,
    policy: admissionConfiguration.policy,
    modelConfig: admissionConfiguration.model,
    now: args.now,
  });
  return {
    responseProjectVersionId,
    applicationVersion: args.application.version + 1,
    applicationContentVersion: nextContentVersion,
    requestVersion: args.request.version + 1,
  };
}

export const respondToInformationRequest = mutation({
  args: {
    eventSlug: v.string(),
    applicationId: v.id("applications"),
    expectedApplicationVersion: v.number(),
    requestId: v.id("admissionInformationRequests"),
    expectedRequestVersion: v.number(),
    answers: v.array(
      v.object({
        questionKey: v.string(),
        answer: v.string(),
      }),
    ),
    clientOperationId: v.string(),
  },
  returns: v.object({ responseProjectVersionId: v.id("projectVersions") }),
  handler: async (ctx, args) => {
    const { event, person, subject, application } = await applicationContext(ctx, args);
    const requestFingerprint = operationFingerprint([
      args.applicationId,
      args.expectedApplicationVersion,
      args.requestId,
      args.expectedRequestVersion,
      JSON.stringify(args.answers),
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.information.respond",
      requestFingerprint,
    });
    if (prior) {
      const responseProjectVersionId = ctx.db.normalizeId("projectVersions", prior.targetId);
      if (!responseProjectVersionId || !(await ctx.db.get(responseProjectVersionId))) {
        throw new Error("The prior information response no longer resolves.");
      }
      return { responseProjectVersionId };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.information.respond",
      scopeType: "team",
      scopeId: application.teamId,
    });
    const [membership, request] = await Promise.all([
      requireMembership(ctx, event._id, person._id),
      ctx.db.get(args.requestId),
    ]);
    if (!request) {
      throw new ConvexError({
        code: "INFORMATION_REQUEST_NOT_FOUND",
        message: "That information request is unavailable.",
      });
    }
    const now = Date.now();
    const result = await respondToAdmissionInformationRequest(ctx, {
      event,
      application,
      expectedApplicationVersion: args.expectedApplicationVersion,
      request,
      expectedRequestVersion: args.expectedRequestVersion,
      membership,
      answers: args.answers,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.information.respond",
      requestFingerprint,
      targetType: "project_version",
      targetId: result.responseProjectVersionId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "application.information.respond",
      grantIds,
      scopeType: "team",
      scopeId: application.teamId,
      action: "admission.information_response_submitted",
      targetType: "application",
      targetId: application._id,
      previousSummary: JSON.stringify({
        state: application.state,
        applicationVersion: application.version,
        contentVersion: application.contentVersion,
        requestId: request._id,
        requestVersion: request.version,
      }),
      nextSummary: JSON.stringify({
        state: "under_review",
        applicationVersion: result.applicationVersion,
        contentVersion: result.applicationContentVersion,
        requestVersion: result.requestVersion,
        responseProjectVersionId: result.responseProjectVersionId,
        answerCount: args.answers.length,
      }),
      reason: "Submitted the requested application information",
    });
    return { responseProjectVersionId: result.responseProjectVersionId };
  },
});

const offerMutationResult = v.object({
  offerId: v.id("admissionOffers"),
  offerState: admissionOfferState,
  offerVersion: v.number(),
  applicationState,
  applicationVersion: v.number(),
});

function offerResult(
  offer: Doc<"admissionOffers">,
  application: Doc<"applications">,
) {
  return {
    offerId: offer._id,
    offerState: offer.state,
    offerVersion: offer.version,
    applicationState: application.state,
    applicationVersion: application.version,
  };
}

function requireOfferExpiry(
  event: Doc<"events">,
  expiresAt: number,
  now: number,
) {
  const latestAllowedExpiry = Math.min(
    event.startsAt ?? now + 30 * 24 * 60 * 60 * 1_000,
    now + 30 * 24 * 60 * 60 * 1_000,
  );
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > latestAllowedExpiry
  ) {
    throw new ConvexError({
      code: "INVALID_OFFER_EXPIRY",
      message: "Choose a future offer deadline no later than the event start or 30 days from now.",
    });
  }
}

async function requireActiveOfferReservation(
  ctx: MutationCtx,
  offer: Doc<"admissionOffers">,
) {
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
    args.offer.offeredTeamMemberIds.length !== args.project.lockedTeamMemberIds.length ||
    args.offer.offeredTeamMemberIds.some(
      (teamMemberId, index) => teamMemberId !== args.project.lockedTeamMemberIds[index],
    )
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
      ...(args.actorPersonId !== undefined
        ? { releasedByPersonId: args.actorPersonId }
        : {}),
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
    ...(args.transition === "confirmed"
      ? { confirmedTeamMemberIds: args.project.lockedTeamMemberIds }
      : {}),
    ...(args.actorPersonId !== undefined
      ? { decidedByPersonId: args.actorPersonId }
      : {}),
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
  for (const teamMemberId of args.offer.offeredTeamMemberIds) {
    const teamMember = await ctx.db.get(teamMemberId);
    if (!teamMember || teamMember.teamId !== args.team._id || teamMember.status !== "active") {
      throw new Error("The offered roster no longer matches an active locked team member.");
    }
    await ctx.db.patch(teamMember.membershipId, {
      onboardingStatus: onboardingStatusAfter,
      updatedAt: args.now,
    });
  }
  if (args.transition === "confirmed") {
    await initializeAttendanceTeamAvailability(ctx, {
      eventId: args.offer.eventId,
      teamId: args.team._id,
      activeMemberCount: args.offer.offeredTeamMemberIds.length,
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
    await enqueueApplicationNotifications(ctx, {
      eventId: args.offer.eventId,
      applicationId: args.application._id,
      teamId: args.team._id,
      lockedTeamMemberIds: args.project.lockedTeamMemberIds,
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
    offeredTeamMemberIds: args.project.lockedTeamMemberIds,
    participantCount: args.project.lockedTeamMemberIds.length,
    reservedCoreTrackVersionId: args.project.coreTrackVersionId,
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
  for (const teamMemberId of args.project.lockedTeamMemberIds) {
    const teamMember = await ctx.db.get(teamMemberId);
    if (
      !teamMember ||
      teamMember.teamId !== args.team._id ||
      teamMember.status !== "active"
    ) {
      throw new Error("The locked team roster changed before the offer was sent.");
    }
    await ctx.db.patch(teamMember.membershipId, {
      onboardingStatus: "offer_pending",
      updatedAt: args.now,
    });
  }
  await enqueueApplicationNotifications(ctx, {
    eventId: args.event._id,
    applicationId: args.application._id,
    teamId: args.team._id,
    lockedTeamMemberIds: args.project.lockedTeamMemberIds,
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
      const offerId = ctx.db.normalizeId("admissionOffers", prior.targetId);
      const offer = offerId ? await ctx.db.get(offerId) : null;
      const currentApplication = offer ? await ctx.db.get(offer.applicationId) : null;
      if (!offer || !currentApplication || currentApplication.eventId !== event._id) {
        throw new Error("Prior offer result no longer resolves.");
      }
      return offerResult(offer, currentApplication);
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.offer.manage",
      scopeType: "application",
      scopeId: application._id,
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
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
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.offer.send",
      requestFingerprint,
      targetType: "admission_offer",
      targetId: offerId,
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
        participantCount: project.lockedTeamMemberIds.length,
        expiresAt: args.expiresAt,
      }),
      reason: "Sent an admission offer to the locked team",
    });
    return offerResult(created.offer, created.application);
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
        index
          .eq("eventId", event._id)
          .eq("membershipId", membership._id)
          .eq("status", "active"),
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
      application.currentOfferId
        ? ctx.db.get(application.currentOfferId)
        : Promise.resolve(null),
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
      const priorOfferId = ctx.db.normalizeId("admissionOffers", prior.targetId);
      const priorOffer = priorOfferId ? await ctx.db.get(priorOfferId) : null;
      const priorApplication = priorOffer
        ? await ctx.db.get(priorOffer.applicationId)
        : null;
      if (!priorOffer || !priorApplication) throw new Error("Prior offer response is missing.");
      return offerResult(priorOffer, priorApplication);
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
      offer.expiresAt <= now
        ? "expired"
        : args.response === "confirm"
          ? "confirmed"
          : "declined";
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
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.offer.respond",
      requestFingerprint,
      targetType: "admission_offer",
      targetId: offer._id,
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
    return offerResult(transitioned.offer, transitioned.application);
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
      const offerId = ctx.db.normalizeId("admissionOffers", prior.targetId);
      const offer = offerId ? await ctx.db.get(offerId) : null;
      const currentApplication = offer ? await ctx.db.get(offer.applicationId) : null;
      if (!offer || !currentApplication) throw new Error("Prior offer revocation is missing.");
      return offerResult(offer, currentApplication);
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.offer.manage",
      scopeType: "application",
      scopeId: application._id,
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    const [offer, project, team] = await Promise.all([
      application.currentOfferId
        ? ctx.db.get(application.currentOfferId)
        : Promise.resolve(null),
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
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "admissions.offer.revoke",
      requestFingerprint,
      targetType: "admission_offer",
      targetId: offer._id,
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
    return offerResult(transitioned.offer, transitioned.application);
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
    if (
      !offer ||
      offer.state !== "offered" ||
      offer.version !== args.expectedOfferVersion
    ) {
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
