import { ConvexError, v, type Infer } from "convex/values";
import { z } from "zod";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { loadPublishedAdmissionConfiguration } from "./lib/admissionPolicy";
import { createAdmissionRecommendation } from "./lib/admissionRecommendation";
import { applicationsCloseAtFor, requireEventBySlug, requireRegistrationOpen } from "./lib/events";
import {
  findCurrentPerson,
  requireCurrentPerson,
  requireEventSubject,
  requireMembership,
} from "./lib/identity";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
} from "./lib/operations";
import {
  isProfileCompleteForPolicy,
  loadPublishedParticipantPolicy,
  normalizeParticipantPolicy,
  participantPolicyAccepted,
  participantPolicyChecksum,
  participantPolicyFromDocument,
} from "./lib/participantPolicy";
import { normalizeEmail, normalizedLongText } from "./lib/strings";
import { noveltyInputFingerprint } from "./lib/novelty";
import { invalidateTeamNoveltyIndex } from "./lib/noveltyIndex";
import { participantNoveltyConfig, savedNoveltySignal } from "./lib/participantNovelty";
import {
  intakePolicyChecksum,
  intakePolicyFromDocument,
  normalizeIntakePolicy,
  requirePinnedIntakePolicy,
  requirePublishedIntakePolicy,
} from "./lib/intakePolicy";
import {
  createFixedIntakeQuestion,
  intakeSequenceComplete,
  loadActiveIntakeAnswers,
  loadCurrentIntakeResponses,
  nextQuestionOrdinal,
  replaceIntakeQuestionsAfter,
} from "./lib/intakeQuestions";
import { reconcileWorkingFieldsAfterDraftVersionChange } from "./lib/intakeWorkingFields";
import { ideaQuestionEndToEndDeadlineMs } from "./lib/ideaSubmissionAi";
import { teamClassesMeetPolicy, teamRosterCounts } from "./lib/teamRoster";
import {
  admissionOfferState,
  applicationState,
  projectDraftStage,
} from "./values";

const additionalInformationMaxLength = 4_000;
// Every persisted revision schedules a scorer, but only the revision that is
// still current after this quiet period reaches the embedding and Luna calls.
const draftNoveltyStableDelayMs = 2_500;
const draftNoveltyIndexSpreadMs = 500;

function draftNoveltyIndexDelayMs(
  draftId: Id<"projectDrafts">,
  inputFingerprint: string,
  sourceUpdatedAt: number,
) {
  let hash = 2_166_136_261;
  const key = `${draftId}:${inputFingerprint}:${sourceUpdatedAt}`;
  for (const character of key) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  }
  return draftNoveltyStableDelayMs + ((hash >>> 0) % draftNoveltyIndexSpreadMs);
}

function normalizedAdditionalInformation(value: string) {
  const normalized = value.trim().replace(/\r\n/g, "\n");
  if (normalized.length > additionalInformationMaxLength) {
    throw new ConvexError({
      code: "INVALID_FIELD",
      field: "Additional information",
      message: `Additional information must be at most ${additionalInformationMaxLength} characters.`,
    });
  }
  return normalized || undefined;
}

const participantNoveltySignal = v.object({
  score: v.number(),
  band: v.union(v.literal("familiar"), v.literal("developing"), v.literal("distinct")),
  nearestThemeLabel: v.string(),
  reflectionPrompt: v.string(),
  evaluatedAt: v.number(),
});

const currentDraftView = v.object({
  id: v.id("projectDrafts"),
  intakePolicyVersionId: v.id("intakePolicyVersions"),
  intakePolicy: v.object({
    openingText: v.string(),
    initialPrompt: v.string(),
    initialHelpText: v.string(),
    initialIdeaMinLength: v.number(),
    initialIdeaMaxLength: v.number(),
    followUpAnswerMinLength: v.number(),
    followUpAnswerMaxLength: v.number(),
    minimumFollowUpCount: v.number(),
    maximumFollowUpCount: v.number(),
  }),
  additionalInformationMaxLength: v.number(),
  stage: projectDraftStage,
  initialIdea: v.optional(v.string()),
  additionalInformation: v.optional(v.string()),
  adaptiveQuestionDeadlineAt: v.optional(v.number()),
  novelty: v.union(
    v.null(),
    v.object({
      corpusVersionId: v.id("noveltyCorpusVersions"),
      corpusVersion: v.number(),
      corpusLabel: v.string(),
      comparedProjectCount: v.number(),
      minimumIdeaLength: v.number(),
      debounceMs: v.number(),
    }),
  ),
  noveltySignal: v.union(v.null(), participantNoveltySignal),
  followUps: v.array(
    v.object({
      id: v.id("intakeGeneratedQuestions"),
      ordinal: v.number(),
      question: v.string(),
      purposeKey: v.string(),
      answerLength: v.union(v.literal("short"), v.literal("medium")),
      source: v.union(v.literal("fixed"), v.literal("model"), v.literal("fallback")),
      state: v.union(v.literal("active"), v.literal("answered")),
      answer: v.optional(v.string()),
    }),
  ),
  freshnessAttested: v.boolean(),
  lastEditedByMembershipId: v.id("eventMemberships"),
  version: v.number(),
});

const intakeWorkingField = v.union(
  v.object({ kind: v.literal("idea") }),
  v.object({
    kind: v.literal("follow_up"),
    questionId: v.id("intakeGeneratedQuestions"),
  }),
);

const intakeWorkingFieldView = v.object({
  kind: v.union(v.literal("idea"), v.literal("follow_up")),
  questionId: v.optional(v.id("intakeGeneratedQuestions")),
  value: v.string(),
  baseDraftVersion: v.number(),
  revision: v.number(),
  writtenByMembershipId: v.id("eventMemberships"),
  updatedAt: v.number(),
});

const participantApplicationView = v.object({
  id: v.id("applications"),
  state: applicationState,
  version: v.number(),
  contentVersion: v.number(),
  submittedAt: v.number(),
  currentOffer: v.union(
    v.null(),
    v.object({
      id: v.id("admissionOffers"),
      state: admissionOfferState,
      sentAt: v.number(),
      expiresAt: v.number(),
      version: v.number(),
    }),
  ),
});

const proposalRevisionResponseInput = v.object({
  questionId: v.id("intakeGeneratedQuestions"),
  answer: v.string(),
});

const proposalRevisionResult = v.object({
  projectVersionId: v.id("projectVersions"),
  projectVersion: v.number(),
  applicationVersion: v.number(),
  applicationContentVersion: v.number(),
});

const storedProposalRevisionResult = z.object({
  projectVersionId: z.string().min(1),
  projectVersion: z.number().int().positive(),
  applicationVersion: z.number().int().positive(),
  applicationContentVersion: z.number().int().positive(),
});

const submittedRevisionDraftResult = v.object({
  draftId: v.id("projectDrafts"),
  draftVersion: v.number(),
});

type ReadCtx = QueryCtx | MutationCtx;

function requiredIntakeAnswerValue(answer: Doc<"intakeAnswerVersions"> | null) {
  if (!answer) {
    throw new Error("An answered intake question has no active answer version.");
  }
  return answer.value;
}

const participantNoveltyConfiguration = v.object({
  corpusVersionId: v.id("noveltyCorpusVersions"),
  corpusVersion: v.number(),
  corpusLabel: v.string(),
  comparedProjectCount: v.number(),
  minimumIdeaLength: v.number(),
  debounceMs: v.number(),
});

export async function currentReadTeamContext(ctx: QueryCtx, eventSlug: string) {
  const person = await findCurrentPerson(ctx);
  if (!person) return null;
  const event = await requireEventBySlug(ctx, eventSlug);
  const membership = await ctx.db
    .query("eventMemberships")
    .withIndex("by_event_person", (index) =>
      index.eq("eventId", event._id).eq("personId", person._id),
    )
    .unique();
  if (!membership) return null;
  const member = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index.eq("eventId", event._id).eq("membershipId", membership._id).eq("status", "active"),
    )
    .unique();
  if (!member) return null;
  const team = await ctx.db.get(member.teamId);
  if (!team || team.eventId !== event._id) return null;
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const readGrantIds = await matchingPermissionGrantIds(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "team.read",
    scopeType: "team",
    scopeId: team._id,
  });
  if (readGrantIds.length === 0) return null;
  return { event, membership, member, team };
}

function participantApplicationState(event: Doc<"events">, application: Doc<"applications">) {
  // Project the released decision while its batch is being finalized. Once
  // finalized, preserve the offer's live state, including RSVP and expiry.
  if (
    event.admissionResultsReleasedAt !== undefined &&
    application.decisionStage === "recorded" &&
    application.state === "under_review" &&
    application.humanDecision !== undefined
  ) {
    return application.humanDecision === "accept"
      ? ("accepted" as const)
      : application.humanDecision === "waitlist"
        ? ("waitlisted" as const)
        : ("declined" as const);
  }
  return application.state;
}

async function participantApplicationForTeam(
  ctx: ReadCtx,
  event: Doc<"events">,
  team: Doc<"teams">,
) {
  const application = await ctx.db
    .query("applications")
    .withIndex("by_team", (index) => index.eq("teamId", team._id))
    .unique();
  if (!application) return null;
  if (application.eventId !== event._id) {
    throw new Error("A participant application belongs to another event.");
  }
  const currentOffer = application.currentOfferId
    ? await ctx.db.get(application.currentOfferId)
    : null;
  if (
    application.currentOfferId !== undefined &&
    (!currentOffer ||
      currentOffer.eventId !== event._id ||
      currentOffer.applicationId !== application._id ||
      currentOffer.teamId !== team._id)
  ) {
    throw new Error("A participant application has an invalid current offer.");
  }
  return {
    application,
    view: {
      id: application._id,
      state: participantApplicationState(event, application),
      version: application.version,
      contentVersion: application.contentVersion,
      submittedAt: application.submittedAt,
      currentOffer: currentOffer
        ? {
            id: currentOffer._id,
            state: currentOffer.state,
            sentAt: currentOffer.sentAt,
            expiresAt: currentOffer.expiresAt,
            version: currentOffer.version,
          }
        : null,
    },
  };
}

export const opening = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    openingText: v.string(),
    initialPrompt: v.string(),
    initialHelpText: v.string(),
    initialIdeaMinLength: v.number(),
    initialIdeaMaxLength: v.number(),
    novelty: v.union(v.null(), participantNoveltyConfiguration),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { normalized } = await requirePublishedIntakePolicy(ctx, event);
    return {
      openingText: normalized.openingText,
      initialPrompt: normalized.initialPrompt,
      initialHelpText: normalized.initialHelpText,
      initialIdeaMinLength: normalized.initialIdeaMinLength,
      initialIdeaMaxLength: normalized.initialIdeaMaxLength,
      novelty: await participantNoveltyConfig(ctx, event),
    };
  },
});

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      serverNow: v.number(),
      teamId: v.id("teams"),
      teamVersion: v.number(),
      applicationsCloseAt: v.number(),
      currentRole: v.union(v.literal("lead"), v.literal("member")),
      draft: v.union(v.null(), currentDraftView),
      workingFields: v.array(intakeWorkingFieldView),
      application: v.union(v.null(), participantApplicationView),
    }),
  ),
  handler: async (ctx, args) => {
    const context = await currentReadTeamContext(ctx, args.eventSlug);
    if (!context) return null;
    const { event, membership, member, team } = context;
    const draft = await ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", team._id))
      .unique();
    const [participantApplication, storedWorkingFields] = await Promise.all([
      participantApplicationForTeam(ctx, event, team),
      ctx.db
        .query("intakeWorkingFields")
        .withIndex("by_team_base_version", (index) =>
          index.eq("teamId", team._id).eq("baseDraftVersion", draft?.version ?? 0),
        )
        .take(5),
    ]);
    let visibleDraft: Infer<typeof currentDraftView> | null = null;
    if (draft) {
      const [pinnedPolicy, followUps, novelty] = await Promise.all([
        requirePinnedIntakePolicy(ctx, draft),
        loadCurrentIntakeResponses(ctx, draft._id),
        participantNoveltyConfig(ctx, event, draft),
      ]);
      visibleDraft = {
        id: draft._id,
        intakePolicyVersionId: draft.intakePolicyVersionId,
        intakePolicy: {
          openingText: pinnedPolicy.normalized.openingText,
          initialPrompt: pinnedPolicy.normalized.initialPrompt,
          initialHelpText: pinnedPolicy.normalized.initialHelpText,
          initialIdeaMinLength: pinnedPolicy.normalized.initialIdeaMinLength,
          initialIdeaMaxLength: pinnedPolicy.normalized.initialIdeaMaxLength,
          followUpAnswerMinLength: pinnedPolicy.normalized.followUpAnswerMinLength,
          followUpAnswerMaxLength: pinnedPolicy.normalized.followUpAnswerMaxLength,
          minimumFollowUpCount: pinnedPolicy.normalized.minimumFollowUpCount,
          maximumFollowUpCount: pinnedPolicy.normalized.maximumFollowUpCount,
        },
        additionalInformationMaxLength,
        stage: draft.stage,
        ...(draft.initialIdea !== undefined ? { initialIdea: draft.initialIdea } : {}),
        ...(draft.additionalInformation !== undefined
          ? { additionalInformation: draft.additionalInformation }
          : {}),
        ...(draft.adaptiveQuestionDeadlineAt !== undefined
          ? { adaptiveQuestionDeadlineAt: draft.adaptiveQuestionDeadlineAt }
          : {}),
        novelty,
        noveltySignal: draft.initialIdea
          ? savedNoveltySignal(draft, draft.initialIdea, novelty?.corpusVersionId)
          : null,
        followUps: followUps.map(({ question, answer }) => ({
          id: question._id,
          ordinal: question.ordinal,
          question: question.text,
          purposeKey: question.purposeKey,
          answerLength: question.answerLength,
          source: question.source,
          state: question.state,
          ...(answer ? { answer: answer.value } : {}),
        })),
        freshnessAttested: Boolean(draft.freshnessAttestedAt),
        lastEditedByMembershipId: draft.lastEditedByMembershipId,
        version: draft.version,
      };
    }
    return {
      serverNow: Date.now(),
      teamId: team._id,
      teamVersion: team.version,
      applicationsCloseAt: applicationsCloseAtFor(event, membership.participantClass),
      currentRole: member.role,
      draft: visibleDraft,
      workingFields: participantApplication && draft?.stage === "submitted"
        ? []
        : storedWorkingFields.map((field) => ({
            kind: field.kind,
            ...(field.questionId !== undefined ? { questionId: field.questionId } : {}),
            value: field.value,
            baseDraftVersion: field.baseDraftVersion,
            revision: field.revision,
            writtenByMembershipId: field.writtenByMembershipId,
            updatedAt: field.updatedAt,
          })),
      application: participantApplication?.view ?? null,
    };
  },
});

export const submitted = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      serverNow: v.number(),
      currentRole: v.union(v.literal("lead"), v.literal("member")),
      project: v.object({
        id: v.id("projectVersions"),
        initialIdea: v.string(),
        additionalInformation: v.optional(v.string()),
        intakeResponses: v.array(
          v.object({
            questionId: v.id("intakeGeneratedQuestions"),
            ordinal: v.number(),
            question: v.string(),
            answer: v.string(),
          }),
        ),
        version: v.number(),
      }),
      editRules: v.object({
        initialIdeaMinLength: v.number(),
        initialIdeaMaxLength: v.number(),
        followUpAnswerMinLength: v.number(),
        followUpAnswerMaxLength: v.number(),
        deterministicFollowUpCount: v.number(),
        maximumFollowUpCount: v.number(),
        additionalInformationMaxLength: v.number(),
      }),
      applicationsCloseAt: v.number(),
      canEdit: v.boolean(),
      // The published corpus the revision editor previews against, as the
      // writing screen has it from `opening`.
      novelty: v.union(v.null(), participantNoveltyConfiguration),
      noveltySignal: v.union(v.null(), participantNoveltySignal),
      application: participantApplicationView,
    }),
  ),
  handler: async (ctx, args) => {
    const context = await currentReadTeamContext(ctx, args.eventSlug);
    if (!context) return null;
    const { event, membership, member, team } = context;
    const now = Date.now();
    const applicationsCloseAt = applicationsCloseAtFor(event, membership.participantClass);
    const participantApplication = await participantApplicationForTeam(ctx, event, team);
    if (!participantApplication) return null;
    const project = await ctx.db.get(participantApplication.application.submittedProjectVersionId);
    if (!project || project.eventId !== event._id || project.teamId !== team._id) {
      throw new Error("A participant application has an invalid submitted project.");
    }
    const submittedIdeaFingerprint = noveltyInputFingerprint(project.initialIdea);
    const [intakePolicy, draft, novelty] = await Promise.all([
      ctx.db.get(project.intakePolicyVersionId),
      ctx.db
        .query("projectDrafts")
        .withIndex("by_team", (index) => index.eq("teamId", team._id))
        .filter((query) =>
          query.eq(query.field("noveltyEvaluatedInputFingerprint"), submittedIdeaFingerprint),
        )
        .order("desc")
        .first(),
      participantNoveltyConfig(ctx, event),
    ]);
    if (
      !intakePolicy ||
      intakePolicy.eventId !== event._id ||
      (intakePolicy.status !== "published" && intakePolicy.status !== "superseded")
    ) {
      throw new Error("A submitted project references an invalid intake policy.");
    }
    const normalizedPolicy = normalizeIntakePolicy(intakePolicyFromDocument(intakePolicy));
    if (intakePolicyChecksum(normalizedPolicy) !== intakePolicy.checksum) {
      throw new Error("A submitted project's intake policy checksum is invalid.");
    }
    return {
      serverNow: now,
      currentRole: member.role,
      project: {
        id: project._id,
        initialIdea: project.initialIdea,
        ...(project.additionalInformation !== undefined
          ? { additionalInformation: project.additionalInformation }
          : {}),
        intakeResponses: project.intakeResponses.map((response) => ({
          questionId: response.questionId,
          ordinal: response.ordinal,
          question: response.question,
          answer: response.answer,
        })),
        version: project.version,
      },
      editRules: {
        initialIdeaMinLength: normalizedPolicy.initialIdeaMinLength,
        initialIdeaMaxLength: normalizedPolicy.initialIdeaMaxLength,
        followUpAnswerMinLength: normalizedPolicy.followUpAnswerMinLength,
        followUpAnswerMaxLength: normalizedPolicy.followUpAnswerMaxLength,
        deterministicFollowUpCount: normalizedPolicy.deterministicFollowUpCount,
        maximumFollowUpCount: normalizedPolicy.maximumFollowUpCount,
        additionalInformationMaxLength,
      },
      applicationsCloseAt,
      canEdit:
        member.role === "lead" &&
        now < applicationsCloseAt &&
        ["submitted", "under_review"].includes(participantApplication.application.state),
      novelty,
      noveltySignal:
        draft && novelty
          ? savedNoveltySignal(draft, project.initialIdea, novelty.corpusVersionId)
          : null,
      application: participantApplication.view,
    };
  },
});

function proposalRegenerationBoundary(args: {
  project: Doc<"projectVersions">;
  initialIdea: string;
  intakeResponses: Doc<"projectVersions">["intakeResponses"];
  deterministicFollowUpCount: number;
  maximumFollowUpCount: number;
}) {
  let boundary: number | null =
    args.project.initialIdea !== args.initialIdea &&
    args.deterministicFollowUpCount < args.maximumFollowUpCount
      ? args.deterministicFollowUpCount
      : null;
  for (const [index, response] of args.intakeResponses.entries()) {
    const previous = args.project.intakeResponses[index];
    if (!previous || previous.answer === response.answer) continue;
    const responseBoundary = Math.max(response.ordinal, args.deterministicFollowUpCount);
    if (responseBoundary >= args.maximumFollowUpCount) continue;
    boundary = boundary === null ? responseBoundary : Math.min(boundary, responseBoundary);
  }
  return boundary;
}

async function commitSubmittedProposalRevision(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    application: Doc<"applications">;
    project: Doc<"projectVersions">;
    team: Doc<"teams">;
    membershipId: Id<"eventMemberships">;
    initialIdea: string;
    additionalInformation?: string;
    intakeResponses: Doc<"projectVersions">["intakeResponses"];
    sourceDraftVersion: number;
    now: number;
  },
) {
  await invalidateTeamNoveltyIndex(ctx, {
    teamId: args.team._id,
    sourceUpdatedAt: args.now,
  });

  const [admissionConfiguration, activeReviews, activeAssignments, priorRecommendation] =
    await Promise.all([
      loadPublishedAdmissionConfiguration(ctx, args.event),
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
  if (admissionConfiguration.policy._id !== args.application.admissionPolicyVersionId) {
    throw new Error("The application admission policy is no longer current.");
  }
  const projectVersionId = await ctx.db.insert("projectVersions", {
    eventId: args.event._id,
    teamId: args.team._id,
    version: args.project.version + 1,
    initialIdea: args.initialIdea,
    ...(args.additionalInformation !== undefined
      ? { additionalInformation: args.additionalInformation }
      : {}),
    intakePolicyVersionId: args.project.intakePolicyVersionId,
    intakeResponses: args.intakeResponses,
    lockedRosterSnapshotId: args.project.lockedRosterSnapshotId,
    lockedMemberCount: args.project.lockedMemberCount,
    lockedLeadMembershipId: args.project.lockedLeadMembershipId,
    ...(args.project.freshForEventAttestation === null
      ? { freshForEventAttestation: null, finalConfirmation: null, organizerImport: args.project.organizerImport }
      : { freshForEventAttestation: args.project.freshForEventAttestation, finalConfirmation: args.project.finalConfirmation }),
    participantPolicyVersionId: args.project.participantPolicyVersionId,
    admissionPolicyVersionId: args.project.admissionPolicyVersionId,
    proposalRevision: {
      sourceProjectVersionId: args.project._id,
      editedByMembershipId: args.membershipId,
      editedAt: args.now,
    },
    sourceDraftVersion: args.sourceDraftVersion,
    submittedByMembershipId: args.membershipId,
    submittedAt: args.now,
  });
  const nextContentVersion = args.application.contentVersion + 1;
  await Promise.all([
    ...activeReviews.map((review) => ctx.db.patch(review._id, { status: "superseded" })),
    ...activeAssignments.map((assignment) =>
      ctx.db.patch(assignment._id, {
        applicationContentVersion: nextContentVersion,
        version: assignment.version + 1,
      }),
    ),
  ]);
  if (
    priorRecommendation &&
    (priorRecommendation.state === "pending" || priorRecommendation.state === "running")
  ) {
    await ctx.db.patch(priorRecommendation._id, {
      state: "stale",
      completedAt: args.now,
      failureCategory: "proposal_revised",
    });
  }
  await Promise.all([
    ctx.db.patch(args.team._id, {
      lockedProjectVersionId: projectVersionId,
      version: args.team.version + 1,
      updatedAt: args.now,
    }),
    ctx.db.patch(args.application._id, {
      submittedProjectVersionId: projectVersionId,
      aiDisposition: undefined,
      aiRecommendationId: undefined,
      assignedReviewCount: activeAssignments.length,
      completedReviewCount: 0,
      contentVersion: nextContentVersion,
      version: args.application.version + 1,
    }),
  ]);
  await ctx.scheduler.runAfter(0, internal.novelty.indexSubmittedProjectIdea, {
    projectVersionId,
    inputFingerprint: noveltyInputFingerprint(args.initialIdea),
    sourceUpdatedAt: args.now,
  });
  const [updatedApplication, updatedProject] = await Promise.all([
    ctx.db.get(args.application._id),
    ctx.db.get(projectVersionId),
  ]);
  if (!updatedApplication || !updatedProject) {
    throw new Error("The revised proposal did not persist.");
  }
  await createAdmissionRecommendation(ctx, {
    application: updatedApplication,
    project: updatedProject,
    policy: admissionConfiguration.policy,
    modelConfig: admissionConfiguration.model,
    now: args.now,
  });
  return {
    result: {
      projectVersionId,
      projectVersion: updatedProject.version,
      applicationVersion: updatedApplication.version,
      applicationContentVersion: updatedApplication.contentVersion,
    },
    supersededHumanReviewCount: activeReviews.length,
  };
}

export const reviseSubmission = mutation({
  args: {
    eventSlug: v.string(),
    applicationId: v.id("applications"),
    expectedApplicationContentVersion: v.number(),
    expectedProjectVersionId: v.id("projectVersions"),
    expectedProjectVersion: v.number(),
    initialIdea: v.string(),
    additionalInformation: v.string(),
    responses: v.array(proposalRevisionResponseInput),
    clientOperationId: v.string(),
  },
  returns: proposalRevisionResult,
  handler: async (ctx, args) => {
    const { event, person, subject, membership, member, team } = await currentTeamContext(
      ctx,
      args.eventSlug,
    );
    const requestFingerprint = operationFingerprint([
      args.applicationId,
      args.expectedApplicationContentVersion,
      args.expectedProjectVersionId,
      args.expectedProjectVersion,
      args.initialIdea,
      args.additionalInformation,
      JSON.stringify(args.responses),
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "intake.submission.revise",
      requestFingerprint,
    });
    if (prior) {
      const stored = storedOperationResult(
        prior.resultJson,
        "proposal revision",
        storedProposalRevisionResult,
      );
      const projectVersionId = ctx.db.normalizeId("projectVersions", stored.projectVersionId);
      if (!projectVersionId || projectVersionId !== prior.targetId) {
        throw new Error("The stored proposal revision is invalid.");
      }
      return { ...stored, projectVersionId };
    }

    const now = Date.now();
    if (now >= applicationsCloseAtFor(event, membership.participantClass)) {
      throw new ConvexError({
        code: "APPLICATION_DEADLINE_PASSED",
        message: "The application deadline has passed.",
      });
    }
    if (member.role !== "lead" || team.leadMembershipId !== membership._id) {
      throw new ConvexError({
        code: "TEAM_LEAD_REQUIRED",
        message: "Only the current team lead can edit the proposal.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.submit",
      scopeType: "team",
      scopeId: team._id,
    });
    const application = await ctx.db.get(args.applicationId);
    if (!application || application.eventId !== event._id || application.teamId !== team._id) {
      throw new ConvexError({
        code: "APPLICATION_NOT_FOUND",
        message: "That application is unavailable.",
      });
    }
    if (application.contentVersion !== args.expectedApplicationContentVersion) {
      throw new ConvexError({
        code: "APPLICATION_CHANGED",
        message: "The application changed. Review the current proposal before saving.",
      });
    }
    if (application.state !== "submitted" && application.state !== "under_review") {
      throw new ConvexError({
        code: "APPLICATION_NOT_EDITABLE",
        message: "This application can no longer be edited.",
      });
    }
    const project = await ctx.db.get(application.submittedProjectVersionId);
    if (
      !project ||
      project._id !== args.expectedProjectVersionId ||
      project.version !== args.expectedProjectVersion ||
      project.eventId !== event._id ||
      project.teamId !== team._id ||
      team.lockedProjectVersionId !== project._id ||
      !team.membershipLocked
    ) {
      throw new ConvexError({
        code: "PROJECT_CHANGED",
        message: "The proposal changed. Review the current version before saving.",
      });
    }
    const latestProject = await ctx.db
      .query("projectVersions")
      .withIndex("by_team_version", (index) => index.eq("teamId", team._id))
      .order("desc")
      .first();
    if (latestProject?._id !== project._id) {
      throw new Error("The application does not point to the latest project version.");
    }
    const draft = await ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", team._id))
      .unique();
    if (!draft || draft.stage !== "submitted") {
      throw new ConvexError({
        code: "PROPOSAL_REVISION_IN_PROGRESS",
        message: "Finish the question update already in progress before editing again.",
      });
    }
    const intakePolicy = await ctx.db.get(project.intakePolicyVersionId);
    if (
      !intakePolicy ||
      intakePolicy.eventId !== event._id ||
      (intakePolicy.status !== "published" && intakePolicy.status !== "superseded")
    ) {
      throw new Error("The proposal references an invalid intake policy.");
    }
    const policy = normalizeIntakePolicy(intakePolicyFromDocument(intakePolicy));
    if (intakePolicyChecksum(policy) !== intakePolicy.checksum) {
      throw new Error("The proposal's intake policy checksum is invalid.");
    }
    const initialIdea = normalizedLongText(
      args.initialIdea,
      "Project idea",
      policy.initialIdeaMinLength,
      policy.initialIdeaMaxLength,
    );
    const additionalInformation = normalizedAdditionalInformation(args.additionalInformation);
    if (
      args.responses.length !== project.intakeResponses.length ||
      args.responses.some(
        (response, index) => response.questionId !== project.intakeResponses[index]?.questionId,
      )
    ) {
      throw new ConvexError({
        code: "PROJECT_RESPONSES_CHANGED",
        message: "The proposal questions changed. Refresh before saving.",
      });
    }
    const intakeResponses = project.intakeResponses.map((response, index) => {
      const input = args.responses[index];
      if (!input) throw new Error("A validated proposal response is missing.");
      const answer = normalizedLongText(
        input.answer,
        "Follow-up answer",
        policy.followUpAnswerMinLength,
        policy.followUpAnswerMaxLength,
      );
      return {
        questionId: response.questionId,
        ordinal: response.ordinal,
        question: response.question,
        purposeKey: response.purposeKey,
        answerLength: response.answerLength,
        source: response.source,
        answer,
      };
    });
    const unchanged =
      project.initialIdea === initialIdea &&
      project.additionalInformation === additionalInformation &&
      project.intakeResponses.every((response, index) => {
        const next = intakeResponses[index];
        return (
          next !== undefined &&
          response.questionId === next.questionId &&
          response.answer === next.answer
        );
      });
    if (unchanged) {
      const result = {
        projectVersionId: project._id,
        projectVersion: project.version,
        applicationVersion: application.version,
        applicationContentVersion: application.contentVersion,
      };
      await recordOperation(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        clientOperationId: args.clientOperationId,
        commandName: "intake.submission.revise",
        requestFingerprint,
        targetType: "project_version",
        targetId: project._id,
        resultJson: JSON.stringify(result),
        createdAt: now,
      });
      return result;
    }
    if (
      proposalRegenerationBoundary({
        project,
        initialIdea,
        intakeResponses,
        deterministicFollowUpCount: policy.deterministicFollowUpCount,
        maximumFollowUpCount: policy.maximumFollowUpCount,
      }) !== null
    ) {
      throw new ConvexError({
        code: "QUESTION_REGENERATION_REQUIRED",
        message: "This change affects later questions. Regenerate them before saving the revision.",
      });
    }

    const { result, supersededHumanReviewCount } = await commitSubmittedProposalRevision(ctx, {
      event,
      application,
      project,
      team,
      membershipId: membership._id,
      initialIdea,
      ...(additionalInformation !== undefined ? { additionalInformation } : {}),
      intakeResponses,
      sourceDraftVersion: project.sourceDraftVersion,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "intake.submission.revise",
      requestFingerprint,
      targetType: "project_version",
      targetId: result.projectVersionId,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "application.submit",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "application.proposal_revised",
      targetType: "application",
      targetId: application._id,
      previousSummary: JSON.stringify({
        projectVersionId: project._id,
        projectVersion: project.version,
        applicationContentVersion: application.contentVersion,
      }),
      nextSummary: JSON.stringify({
        projectVersionId: result.projectVersionId,
        projectVersion: result.projectVersion,
        applicationContentVersion: result.applicationContentVersion,
        supersededHumanReviewCount,
      }),
      reason: "Team lead revised the proposal before the application deadline",
    });
    return result;
  },
});

export const beginSubmittedRevision = mutation({
  args: {
    eventSlug: v.string(),
    applicationId: v.id("applications"),
    expectedApplicationContentVersion: v.number(),
    expectedProjectVersionId: v.id("projectVersions"),
    expectedProjectVersion: v.number(),
    initialIdea: v.string(),
    additionalInformation: v.string(),
    responses: v.array(proposalRevisionResponseInput),
    clientOperationId: v.string(),
  },
  returns: submittedRevisionDraftResult,
  handler: async (ctx, args) => {
    const { event, person, subject, membership, member, team } = await currentTeamContext(
      ctx,
      args.eventSlug,
    );
    const requestFingerprint = operationFingerprint([
      args.applicationId,
      args.expectedApplicationContentVersion,
      args.expectedProjectVersionId,
      args.expectedProjectVersion,
      args.initialIdea,
      args.additionalInformation,
      JSON.stringify(args.responses),
    ]);
    const replay = await replayDraftOperation(
      ctx,
      event._id,
      person._id,
      args.clientOperationId,
      "intake.submission.revision.begin",
      requestFingerprint,
    );
    if (replay) return { draftId: replay._id, draftVersion: replay.version };

    const now = Date.now();
    requireRegistrationOpen(event, membership.participantClass, now);
    if (member.role !== "lead" || team.leadMembershipId !== membership._id) {
      throw new ConvexError({
        code: "TEAM_LEAD_REQUIRED",
        message: "Only the current team lead can edit the proposal.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.submit",
      scopeType: "team",
      scopeId: team._id,
    });
    const [application, draft] = await Promise.all([
      ctx.db.get(args.applicationId),
      ctx.db
        .query("projectDrafts")
        .withIndex("by_team", (index) => index.eq("teamId", team._id))
        .unique(),
    ]);
    if (!application || application.eventId !== event._id || application.teamId !== team._id) {
      throw new ConvexError({
        code: "APPLICATION_NOT_FOUND",
        message: "That application is unavailable.",
      });
    }
    if (
      application.contentVersion !== args.expectedApplicationContentVersion ||
      (application.state !== "submitted" && application.state !== "under_review")
    ) {
      throw new ConvexError({
        code: "APPLICATION_CHANGED",
        message: "The application changed. Review the current proposal before saving.",
      });
    }
    const project = await ctx.db.get(application.submittedProjectVersionId);
    if (
      !project ||
      project._id !== args.expectedProjectVersionId ||
      project.version !== args.expectedProjectVersion ||
      project.eventId !== event._id ||
      project.teamId !== team._id ||
      team.lockedProjectVersionId !== project._id ||
      !team.membershipLocked
    ) {
      throw new ConvexError({
        code: "PROJECT_CHANGED",
        message: "The proposal changed. Review the current version before saving.",
      });
    }
    if (!draft || draft.stage !== "submitted" || draft.intakePolicyVersionId !== project.intakePolicyVersionId) {
      throw new ConvexError({
        code: "PROPOSAL_REVISION_IN_PROGRESS",
        message: "Finish the question update already in progress before editing again.",
      });
    }
    const [latestProject, intakePolicy, currentResponses, activeAnswers] = await Promise.all([
      ctx.db
        .query("projectVersions")
        .withIndex("by_team_version", (index) => index.eq("teamId", team._id))
        .order("desc")
        .first(),
      ctx.db.get(project.intakePolicyVersionId),
      loadCurrentIntakeResponses(ctx, draft._id),
      loadActiveIntakeAnswers(ctx, draft._id),
    ]);
    if (latestProject?._id !== project._id) {
      throw new Error("The application does not point to the latest project version.");
    }
    if (
      !intakePolicy ||
      intakePolicy.eventId !== event._id ||
      (intakePolicy.status !== "published" && intakePolicy.status !== "superseded")
    ) {
      throw new Error("The proposal references an invalid intake policy.");
    }
    const policy = normalizeIntakePolicy(intakePolicyFromDocument(intakePolicy));
    if (intakePolicyChecksum(policy) !== intakePolicy.checksum) {
      throw new Error("The proposal's intake policy checksum is invalid.");
    }
    const initialIdea = normalizedLongText(
      args.initialIdea,
      "Project idea",
      policy.initialIdeaMinLength,
      policy.initialIdeaMaxLength,
    );
    const additionalInformation = normalizedAdditionalInformation(args.additionalInformation);
    if (
      args.responses.length !== project.intakeResponses.length ||
      currentResponses.length !== project.intakeResponses.length ||
      args.responses.some(
        (response, index) => response.questionId !== project.intakeResponses[index]?.questionId,
      ) ||
      currentResponses.some(
        ({ question }, index) => question._id !== project.intakeResponses[index]?.questionId,
      )
    ) {
      throw new ConvexError({
        code: "PROJECT_RESPONSES_CHANGED",
        message: "The proposal questions changed. Refresh before saving.",
      });
    }
    const intakeResponses = project.intakeResponses.map((response, index) => {
      const input = args.responses[index];
      if (!input) throw new Error("A validated proposal response is missing.");
      return {
        ...response,
        answer: normalizedLongText(
          input.answer,
          "Follow-up answer",
          policy.followUpAnswerMinLength,
          policy.followUpAnswerMaxLength,
        ),
      };
    });
    const regenerateAfterOrdinal = proposalRegenerationBoundary({
      project,
      initialIdea,
      intakeResponses,
      deterministicFollowUpCount: policy.deterministicFollowUpCount,
      maximumFollowUpCount: policy.maximumFollowUpCount,
    });
    if (regenerateAfterOrdinal === null) {
      throw new ConvexError({
        code: "QUESTION_REGENERATION_NOT_REQUIRED",
        message: "These changes can be saved directly without regenerating questions.",
      });
    }

    const currentInitialAnswer = activeAnswers.find(
      (answer) => answer.promptKey === "initial_idea" && answer.generatedQuestionId === undefined,
    );
    if (!currentInitialAnswer) {
      throw new Error("The submitted project has no active initial-idea answer.");
    }
    const initialAnswer =
      currentInitialAnswer.value === initialIdea
        ? currentInitialAnswer
        : await saveAnswerVersion(ctx, {
            eventId: event._id,
            teamId: team._id,
            draftId: draft._id,
            membershipId: membership._id,
            promptKey: "initial_idea",
            value: initialIdea,
            clientOperationId: args.clientOperationId,
          });
    const retainedAnswerIds: Id<"intakeAnswerVersions">[] = [];
    for (const [index, response] of currentResponses.entries()) {
      if (response.question.ordinal > regenerateAfterOrdinal) break;
      const desired = intakeResponses[index];
      if (!desired || !response.answer) {
        throw new Error("A retained submitted response is incomplete.");
      }
      const answer =
        response.answer.value === desired.answer
          ? response.answer
          : await saveAnswerVersion(ctx, {
              eventId: event._id,
              teamId: team._id,
              draftId: draft._id,
              membershipId: membership._id,
              promptKey: `introduction_follow_up_${response.question.ordinal}`,
              value: desired.answer,
              generatedQuestionId: response.question._id,
              clientOperationId: args.clientOperationId,
            });
      await ctx.db.patch(response.question._id, {
        sourceAnswerVersionIds: [initialAnswer._id, ...retainedAnswerIds],
      });
      retainedAnswerIds.push(answer._id);
    }
    await replaceIntakeQuestionsAfter(ctx, draft._id, regenerateAfterOrdinal);
    const draftVersion = draft.version + 1;
    await reconcileWorkingFieldsAfterDraftVersionChange(ctx, {
      teamId: team._id,
      previousDraftVersion: draft.version,
      nextDraftVersion: draftVersion,
      removeIdea: true,
      removedQuestionIds: currentResponses.map(({ question }) => question._id),
    });
    const ideaChangedInDraft = draft.initialIdea !== initialIdea;
    await ctx.db.patch(draft._id, {
      initialIdea,
      additionalInformation,
      stage: "follow_up",
      adaptiveQuestionDeadlineAt: undefined,
      freshnessAttestedByMembershipId: project.freshForEventAttestation?.acceptedByMembershipId,
      freshnessAttestedAt: project.freshForEventAttestation?.acceptedAt,
      ...(ideaChangedInDraft
        ? {
            noveltyEvaluatedInputFingerprint: undefined,
            noveltyScore: undefined,
            noveltyBand: undefined,
            noveltyNearestThemeLabel: undefined,
            noveltyReflectionPrompt: undefined,
            noveltyScoringVersion: undefined,
            noveltyRefinementFailureCategory: undefined,
            noveltyPreviewRequestId: undefined,
            noveltyEvaluatedAt: undefined,
          }
        : {}),
      version: draftVersion,
      lastEditedByMembershipId: membership._id,
      updatedAt: now,
    });
    await enqueueIntakeInterpretation(ctx, {
      draftId: draft._id,
      draftVersion,
      enqueuedAt: now,
    });
    await recordDraftOperation(ctx, {
      eventId: event._id,
      personId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "intake.submission.revision.begin",
      requestFingerprint,
      draftId: draft._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "application.submit",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "application.proposal_revision_started",
      targetType: "application",
      targetId: application._id,
      previousSummary: JSON.stringify({
        projectVersionId: project._id,
        projectVersion: project.version,
        applicationContentVersion: application.contentVersion,
      }),
      nextSummary: JSON.stringify({
        draftId: draft._id,
        draftVersion,
        regenerateAfterOrdinal,
      }),
      reason: "Team lead changed proposal content that determines later questions",
    });
    return { draftId: draft._id, draftVersion };
  },
});

export const completeSubmittedRevision = mutation({
  args: {
    eventSlug: v.string(),
    expectedDraftVersion: v.number(),
    expectedTeamVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: proposalRevisionResult,
  handler: async (ctx, args) => {
    const { event, person, subject, membership, member, team } = await currentTeamContext(
      ctx,
      args.eventSlug,
    );
    const requestFingerprint = operationFingerprint([
      args.expectedDraftVersion,
      args.expectedTeamVersion,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "intake.submission.revision.complete",
      requestFingerprint,
    });
    if (prior) {
      const stored = storedOperationResult(
        prior.resultJson,
        "completed proposal revision",
        storedProposalRevisionResult,
      );
      const projectVersionId = ctx.db.normalizeId("projectVersions", stored.projectVersionId);
      if (!projectVersionId || projectVersionId !== prior.targetId) {
        throw new Error("The stored completed proposal revision is invalid.");
      }
      return { ...stored, projectVersionId };
    }

    const now = Date.now();
    requireRegistrationOpen(event, membership.participantClass, now);
    if (member.role !== "lead" || team.leadMembershipId !== membership._id) {
      throw new ConvexError({
        code: "TEAM_LEAD_REQUIRED",
        message: "Only the current team lead can save the revised proposal.",
      });
    }
    if (team.version !== args.expectedTeamVersion || !team.membershipLocked) {
      throw new ConvexError({
        code: "TEAM_CHANGED",
        message: "The team changed. Review the revision again.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.submit",
      scopeType: "team",
      scopeId: team._id,
    });
    const [application, draft] = await Promise.all([
      ctx.db
        .query("applications")
        .withIndex("by_team", (index) => index.eq("teamId", team._id))
        .unique(),
      ctx.db
        .query("projectDrafts")
        .withIndex("by_team", (index) => index.eq("teamId", team._id))
        .unique(),
    ]);
    if (
      !application ||
      (application.state !== "submitted" && application.state !== "under_review")
    ) {
      throw new ConvexError({
        code: "APPLICATION_NOT_EDITABLE",
        message: "This application can no longer be edited.",
      });
    }
    const project = await ctx.db.get(application.submittedProjectVersionId);
    if (
      !project ||
      project.eventId !== event._id ||
      project.teamId !== team._id ||
      team.lockedProjectVersionId !== project._id
    ) {
      throw new ConvexError({
        code: "PROJECT_CHANGED",
        message: "The submitted proposal changed. Review the revision again.",
      });
    }
    if (
      !draft ||
      draft.version !== args.expectedDraftVersion ||
      draft.stage !== "review" ||
      !draft.initialIdea ||
      !draft.freshnessAttestedAt ||
      !draft.freshnessAttestedByMembershipId ||
      draft.intakePolicyVersionId !== project.intakePolicyVersionId
    ) {
      throw new ConvexError({
        code: "DRAFT_INCOMPLETE",
        message: "Complete every revised project question first.",
      });
    }
    const [latestProject, pinnedPolicy, intakeResponses] = await Promise.all([
      ctx.db
        .query("projectVersions")
        .withIndex("by_team_version", (index) => index.eq("teamId", team._id))
        .order("desc")
        .first(),
      requirePinnedIntakePolicy(ctx, draft),
      loadCurrentIntakeResponses(ctx, draft._id),
    ]);
    if (latestProject?._id !== project._id) {
      throw new Error("The application does not point to the latest project version.");
    }
    if (!intakeSequenceComplete(pinnedPolicy.normalized, intakeResponses)) {
      throw new ConvexError({
        code: "DRAFT_INCOMPLETE",
        message: "Complete every revised project question first.",
      });
    }
    const { result, supersededHumanReviewCount } = await commitSubmittedProposalRevision(ctx, {
      event,
      application,
      project,
      team,
      membershipId: membership._id,
      initialIdea: draft.initialIdea,
      ...(draft.additionalInformation !== undefined
        ? { additionalInformation: draft.additionalInformation }
        : {}),
      intakeResponses: intakeResponses.map(({ question, answer }) => ({
        questionId: question._id,
        ordinal: question.ordinal,
        question: question.text,
        purposeKey: question.purposeKey,
        answerLength: question.answerLength,
        source: question.source,
        answer: requiredIntakeAnswerValue(answer),
      })),
      sourceDraftVersion: draft.version,
      now,
    });
    await ctx.db.patch(draft._id, {
      stage: "submitted",
      adaptiveQuestionDeadlineAt: undefined,
      version: draft.version + 1,
      lastEditedByMembershipId: membership._id,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "intake.submission.revision.complete",
      requestFingerprint,
      targetType: "project_version",
      targetId: result.projectVersionId,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "application.submit",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "application.proposal_revised",
      targetType: "application",
      targetId: application._id,
      previousSummary: JSON.stringify({
        projectVersionId: project._id,
        projectVersion: project.version,
        applicationContentVersion: application.contentVersion,
      }),
      nextSummary: JSON.stringify({
        projectVersionId: result.projectVersionId,
        projectVersion: result.projectVersion,
        applicationContentVersion: result.applicationContentVersion,
        supersededHumanReviewCount,
      }),
      reason: "Team lead completed regenerated questions for a revised proposal",
    });
    return result;
  },
});

export const status = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      applicationState: v.union(v.null(), v.string()),
      revisionInProgress: v.boolean(),
      submissionState: v.union(v.null(), v.literal("validating"), v.literal("failed")),
      submissionFailureMessage: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const context = await currentReadTeamContext(ctx, args.eventSlug);
    if (!context) return null;
    const { team } = context;
    const [application, draft] = await Promise.all([
      ctx.db
        .query("applications")
        .withIndex("by_team", (index) => index.eq("teamId", team._id))
        .unique(),
      ctx.db
        .query("projectDrafts")
        .withIndex("by_team", (index) => index.eq("teamId", team._id))
        .unique(),
    ]);
    const attempt = team.submissionAttemptId ? await ctx.db.get(team.submissionAttemptId) : null;
    const submissionState =
      !application && attempt?.state === "failed"
        ? ("failed" as const)
        : !application && (attempt?.state === "validating" || attempt?.state === "finalizing")
          ? ("validating" as const)
          : null;
    const visibleState = application ? participantApplicationState(context.event, application) : null;
    return {
      applicationState: visibleState,
      revisionInProgress:
        application !== null &&
        (visibleState === "submitted" || visibleState === "under_review") &&
        draft !== null &&
        draft.stage !== "submitted",
      submissionState,
      ...(attempt?.state === "failed" && attempt.failureMessage !== undefined
        ? { submissionFailureMessage: attempt.failureMessage }
        : {}),
    };
  },
});

export async function currentTeamContext(ctx: MutationCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const membership = await requireMembership(ctx, event._id, person._id);
  const member = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index.eq("eventId", event._id).eq("membershipId", membership._id).eq("status", "active"),
    )
    .unique();
  if (!member) {
    throw new ConvexError({ code: "TEAM_REQUIRED", message: "Create or join a team first." });
  }
  const team = await ctx.db.get(member.teamId);
  if (!team) throw new Error("Team membership references a missing team.");
  const grantIds = await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "team.project.write",
    scopeType: "team",
    scopeId: team._id,
  });
  return { event, person, subject, membership, member, team, grantIds };
}

async function requireEditableTeamDraft(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    subjectId: Id<"eventAccessSubjects">;
    membership: Doc<"eventMemberships">;
    member: Doc<"teamMembers">;
    team: Doc<"teams">;
  },
) {
  const [application, draft] = await Promise.all([
    ctx.db
      .query("applications")
      .withIndex("by_team", (index) => index.eq("teamId", args.team._id))
      .unique(),
    ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", args.team._id))
      .unique(),
  ]);
  if (!application && !args.team.membershipLocked) return draft;
  if (
    application &&
    args.team.membershipLocked &&
    draft !== null &&
    draft.stage !== "submitted" &&
    args.member.role === "lead" &&
    args.team.leadMembershipId === args.membership._id &&
    (application.state === "submitted" || application.state === "under_review")
  ) {
    await requirePermission(ctx, {
      eventId: args.event._id,
      eventAccessSubjectId: args.subjectId,
      permissionKey: "application.submit",
      scopeType: "team",
      scopeId: args.team._id,
    });
    return draft;
  }
  throw new ConvexError({
    code: application ? "APPLICATION_ALREADY_SUBMITTED" : "SUBMISSION_LOCKED",
    message: application
      ? "This application has been submitted. Edit its current proposal instead."
      : "This team has submitted and the project intake is locked.",
  });
}

async function replayDraftOperation(
  ctx: MutationCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
  clientOperationId: string,
  commandName: string,
  requestFingerprint: string,
) {
  const operation = await findOperation(ctx, {
    eventId,
    actorPersonId: personId,
    clientOperationId,
    commandName,
    requestFingerprint,
  });
  if (!operation) return null;
  const draftId = ctx.db.normalizeId("projectDrafts", operation.targetId);
  if (!draftId) throw new Error("The prior intake result is invalid.");
  const draft = await ctx.db.get(draftId);
  if (!draft) throw new Error("The prior intake result no longer resolves.");
  return draft;
}

async function recordDraftOperation(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    personId: Id<"people">;
    clientOperationId: string;
    commandName: string;
    requestFingerprint: string;
    draftId: Id<"projectDrafts">;
    createdAt: number;
  },
) {
  await recordOperation(ctx, {
    eventId: args.eventId,
    actorPersonId: args.personId,
    clientOperationId: args.clientOperationId,
    commandName: args.commandName,
    requestFingerprint: args.requestFingerprint,
    targetType: "project_draft",
    targetId: args.draftId,
    createdAt: args.createdAt,
  });
}

function requireDraftVersion(actual: number, expected: number) {
  if (actual !== expected) {
    throw new ConvexError({
      code: "DRAFT_CHANGED",
      message: "The project changed in another session. Review it and try again.",
    });
  }
}

async function enqueueIntakeInterpretation(
  ctx: MutationCtx,
  args: {
    draftId: Id<"projectDrafts">;
    draftVersion: number;
    enqueuedAt: number;
  },
) {
  const deadlineAt = args.enqueuedAt + ideaQuestionEndToEndDeadlineMs;
  const draft = await ctx.db.get(args.draftId);
  if (!draft?.initialIdea || draft.stage !== "follow_up" || draft.version !== args.draftVersion) {
    return;
  }
  const [{ normalized }, responses] = await Promise.all([
    requirePinnedIntakePolicy(ctx, draft),
    loadCurrentIntakeResponses(ctx, draft._id),
  ]);
  const ordinal = nextQuestionOrdinal(responses);
  if (ordinal === null) return;
  if (ordinal <= normalized.deterministicFollowUpCount) {
    await ctx.runMutation(internal.intelligence.beginIntakeInterpretation, {
      draftId: draft._id,
      provider: { kind: "available" },
    });
    return;
  }
  if (ordinal > normalized.maximumFollowUpCount) return;
  await ctx.db.patch(draft._id, { adaptiveQuestionDeadlineAt: deadlineAt });
  await ctx.scheduler.runAfter(0, internal.intelligenceActions.interpretIdea, {
    draftId: args.draftId,
  });
  await ctx.scheduler.runAfter(
    ideaQuestionEndToEndDeadlineMs,
    internal.intelligence.expireQueuedIntakeInterpretation,
    {
      draftId: args.draftId,
      draftVersion: args.draftVersion,
      deadlineAt,
    },
  );
}

export const settleAdaptiveQuestionDeadline = mutation({
  args: {
    eventSlug: v.string(),
    expectedDraftVersion: v.number(),
    deadlineAt: v.number(),
  },
  returns: v.object({
    state: v.union(v.literal("waiting"), v.literal("settled"), v.literal("stale")),
    serverNow: v.number(),
  }),
  handler: async (ctx, args) => {
    const { team } = await currentTeamContext(ctx, args.eventSlug);
    const draft = await ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", team._id))
      .unique();
    const now = Date.now();
    if (
      !draft?.initialIdea ||
      draft.stage !== "follow_up" ||
      draft.version !== args.expectedDraftVersion ||
      draft.adaptiveQuestionDeadlineAt !== args.deadlineAt
    ) {
      return { state: "stale" as const, serverNow: now };
    }
    if (now < args.deadlineAt) {
      return { state: "waiting" as const, serverNow: now };
    }
    await ctx.runMutation(internal.intelligence.expireQueuedIntakeInterpretation, {
      draftId: draft._id,
      draftVersion: draft.version,
      deadlineAt: args.deadlineAt,
    });
    return { state: "settled" as const, serverNow: Date.now() };
  },
});

async function saveAnswerVersion(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    teamId: Id<"teams">;
    draftId: Id<"projectDrafts">;
    membershipId: Id<"eventMemberships">;
    promptKey: string;
    value: string;
    generatedQuestionId?: Id<"intakeGeneratedQuestions">;
    clientOperationId: string;
  },
) {
  const active = await ctx.db
    .query("intakeAnswerVersions")
    .withIndex("by_draft_prompt_status", (index) =>
      index.eq("draftId", args.draftId).eq("promptKey", args.promptKey).eq("status", "active"),
    )
    .unique();
  if (active?.clientOperationId === args.clientOperationId) return active;
  const latest = await ctx.db
    .query("intakeAnswerVersions")
    .withIndex("by_team_prompt_version", (index) =>
      index.eq("teamId", args.teamId).eq("promptKey", args.promptKey),
    )
    .order("desc")
    .first();
  if (active) await ctx.db.patch(active._id, { status: "superseded" });
  const answerVersionId = await ctx.db.insert("intakeAnswerVersions", {
    eventId: args.eventId,
    teamId: args.teamId,
    draftId: args.draftId,
    promptKey: args.promptKey,
    ...(args.generatedQuestionId !== undefined
      ? { generatedQuestionId: args.generatedQuestionId }
      : {}),
    answerVersion: (latest?.answerVersion ?? 0) + 1,
    value: args.value,
    ...(active ? { supersedesAnswerVersionId: active._id } : {}),
    status: "active",
    writtenByMembershipId: args.membershipId,
    writtenAt: Date.now(),
    clientOperationId: args.clientOperationId,
  });
  const answerVersion = await ctx.db.get(answerVersionId);
  if (!answerVersion) throw new Error("Intake answer did not persist.");
  return answerVersion;
}

function workingFieldQuestionId(field: Infer<typeof intakeWorkingField>) {
  return field.kind === "follow_up" ? field.questionId : undefined;
}

async function findWorkingField(
  ctx: ReadCtx,
  teamId: Id<"teams">,
  field: Infer<typeof intakeWorkingField>,
) {
  return await ctx.db
    .query("intakeWorkingFields")
    .withIndex("by_team_kind_question", (index) =>
      index
        .eq("teamId", teamId)
        .eq("kind", field.kind)
        .eq("questionId", workingFieldQuestionId(field)),
    )
    .unique();
}

async function deleteWorkingField(
  ctx: MutationCtx,
  teamId: Id<"teams">,
  field: Infer<typeof intakeWorkingField>,
) {
  const workingField = await findWorkingField(ctx, teamId, field);
  if (workingField) await ctx.db.delete(workingField._id);
}

export const autosaveWorkingField = mutation({
  args: {
    eventSlug: v.string(),
    field: intakeWorkingField,
    value: v.string(),
    baseDraftVersion: v.number(),
    baseCommittedValue: v.string(),
    expectedRevision: v.number(),
  },
  returns: v.object({ revision: v.number(), updatedAt: v.number() }),
  handler: async (ctx, args) => {
    const { event, subject, membership, member, team } = await currentTeamContext(
      ctx,
      args.eventSlug,
    );
    requireRegistrationOpen(event, membership.participantClass);
    const draft = await requireEditableTeamDraft(ctx, {
      event,
      subjectId: subject._id,
      membership,
      member,
      team,
    });
    const draftVersion = draft?.version ?? 0;
    const pinnedPolicy = draft
      ? await requirePinnedIntakePolicy(ctx, draft)
      : await requirePublishedIntakePolicy(ctx, event);
    const maximumLength =
      args.field.kind === "idea"
        ? pinnedPolicy.normalized.initialIdeaMaxLength
        : pinnedPolicy.normalized.followUpAnswerMaxLength;
    if (args.value.length > maximumLength) {
      throw new ConvexError({
        code: "DRAFT_TOO_LONG",
        message: `Keep this response within ${maximumLength} characters.`,
      });
    }
    let followUpQuestion: Doc<"intakeGeneratedQuestions"> | null = null;
    let followUpCommittedValue = "";
    if (args.field.kind === "follow_up") {
      const questionId = args.field.questionId;
      followUpQuestion = await ctx.db.get(questionId);
      const response = draft
        ? (await loadCurrentIntakeResponses(ctx, draft._id)).find(
            ({ question }) => question._id === questionId,
          )
        : undefined;
      const editingActiveQuestion =
        draft?.stage === "follow_up" && followUpQuestion?.state === "active";
      const editingReviewAnswer =
        draft?.stage === "review" &&
        followUpQuestion?.state === "answered" &&
        response?.answer !== null &&
        response?.answer !== undefined;
      const delayedReviewAnswerStillCurrent =
        draft !== null &&
        draft.version !== args.baseDraftVersion &&
        followUpQuestion?.state === "answered" &&
        response?.answer?.value === args.baseCommittedValue;
      if (
        !draft ||
        !followUpQuestion ||
        followUpQuestion.eventId !== event._id ||
        followUpQuestion.teamId !== team._id ||
        followUpQuestion.draftId !== draft._id ||
        (!editingActiveQuestion && !editingReviewAnswer && !delayedReviewAnswerStillCurrent)
      ) {
        throw new ConvexError({
          code: "FOLLOW_UP_CHANGED",
          message: "That follow-up changed. Your text is still on this device.",
        });
      }
      followUpCommittedValue = response?.answer?.value ?? "";
    }
    if (draftVersion !== args.baseDraftVersion) {
      const committedValueUnchanged =
        args.field.kind === "idea"
          ? (draft?.initialIdea ?? "") === args.baseCommittedValue
          : followUpCommittedValue === args.baseCommittedValue;
      if (!committedValueUnchanged) {
        requireDraftVersion(draftVersion, args.baseDraftVersion);
      }
    }
    const existing = await findWorkingField(ctx, team._id, args.field);
    if ((existing?.revision ?? 0) !== args.expectedRevision) {
      throw new ConvexError({
        code: "WORKING_FIELD_CHANGED",
        message: "A teammate saved newer text in this field. Your text is still here.",
      });
    }
    if (existing?.value === args.value && existing.baseDraftVersion === draftVersion) {
      return { revision: existing.revision, updatedAt: existing.updatedAt };
    }
    const now = Date.now();
    const revision = (existing?.revision ?? 0) + 1;
    if (existing) {
      await ctx.db.patch(existing._id, {
        value: args.value,
        baseDraftVersion: draftVersion,
        revision,
        writtenByMembershipId: membership._id,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("intakeWorkingFields", {
        eventId: event._id,
        teamId: team._id,
        kind: args.field.kind,
        ...(args.field.kind === "follow_up" ? { questionId: args.field.questionId } : {}),
        value: args.value,
        baseDraftVersion: draftVersion,
        revision,
        writtenByMembershipId: membership._id,
        updatedAt: now,
      });
    }
    return { revision, updatedAt: now };
  },
});

export const saveInitialIdea = mutation({
  args: {
    eventSlug: v.string(),
    idea: v.string(),
    expectedDraftVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ draftId: v.id("projectDrafts"), draftVersion: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject, membership, member, team, grantIds } = await currentTeamContext(
      ctx,
      args.eventSlug,
    );
    const requestFingerprint = operationFingerprint([
      team._id,
      args.expectedDraftVersion,
      args.idea,
    ]);
    const replay = await replayDraftOperation(
      ctx,
      event._id,
      person._id,
      args.clientOperationId,
      "intake.idea.save",
      requestFingerprint,
    );
    if (replay) return { draftId: replay._id, draftVersion: replay.version };
    requireRegistrationOpen(event, membership.participantClass);
    const existing = await requireEditableTeamDraft(ctx, {
      event,
      subjectId: subject._id,
      membership,
      member,
      team,
    });
    requireDraftVersion(existing?.version ?? 0, args.expectedDraftVersion);
    const novelty = await participantNoveltyConfig(ctx, event, existing ?? undefined);
    const pinnedPolicy = existing
      ? await requirePinnedIntakePolicy(ctx, existing)
      : await requirePublishedIntakePolicy(ctx, event);
    const idea = normalizedLongText(
      args.idea,
      "Project idea",
      pinnedPolicy.normalized.initialIdeaMinLength,
      pinnedPolicy.normalized.initialIdeaMaxLength,
    );
    const now = Date.now();
    if (existing?.initialIdea === idea) {
      await deleteWorkingField(ctx, team._id, { kind: "idea" });
      await recordDraftOperation(ctx, {
        eventId: event._id,
        personId: person._id,
        clientOperationId: args.clientOperationId,
        commandName: "intake.idea.save",
        requestFingerprint,
        draftId: existing._id,
        createdAt: now,
      });
      return { draftId: existing._id, draftVersion: existing.version };
    }
    const draftVersion = (existing?.version ?? 0) + 1;
    if (!team.membershipLocked) {
      await invalidateTeamNoveltyIndex(ctx, {
        teamId: team._id,
        sourceUpdatedAt: now,
      });
    }
    const currentResponses = existing ? await loadCurrentIntakeResponses(ctx, existing._id) : [];
    const fixedResponses = currentResponses.filter(({ question }) => question.source === "fixed");
    const invalidatedResponses = currentResponses.filter(
      ({ question }) => question.ordinal > pinnedPolicy.normalized.deterministicFollowUpCount,
    );
    const fixedSequenceComplete =
      fixedResponses.length === pinnedPolicy.normalized.deterministicFollowUpCount &&
      fixedResponses.every(
        ({ question }, index) => question.ordinal === index + 1 && question.state === "answered",
      );
    const shouldGenerateAdaptiveQuestion =
      fixedSequenceComplete &&
      pinnedPolicy.normalized.deterministicFollowUpCount <
        pinnedPolicy.normalized.maximumFollowUpCount;
    let draftId: Id<"projectDrafts">;
    if (existing) {
      await replaceIntakeQuestionsAfter(
        ctx,
        existing._id,
        pinnedPolicy.normalized.deterministicFollowUpCount,
      );
      await reconcileWorkingFieldsAfterDraftVersionChange(ctx, {
        teamId: team._id,
        previousDraftVersion: existing.version,
        nextDraftVersion: draftVersion,
        removeIdea: true,
        removedQuestionIds: invalidatedResponses.map(({ question }) => question._id),
      });
      await ctx.db.patch(existing._id, {
        stage: fixedSequenceComplete && !shouldGenerateAdaptiveQuestion ? "review" : "follow_up",
        initialIdea: idea,
        noveltyCorpusVersionId: novelty?.corpusVersionId,
        noveltyEvaluatedInputFingerprint: undefined,
        noveltyScore: undefined,
        noveltyBand: undefined,
        noveltyNearestThemeLabel: undefined,
        noveltyReflectionPrompt: undefined,
        noveltyScoringVersion: undefined,
        noveltyRefinementFailureCategory: undefined,
        noveltyPreviewRequestId: undefined,
        noveltyEvaluatedAt: undefined,
        adaptiveQuestionDeadlineAt: undefined,
        version: draftVersion,
        lastEditedByMembershipId: membership._id,
        updatedAt: now,
      });
      draftId = existing._id;
    } else {
      draftId = await ctx.db.insert("projectDrafts", {
        eventId: event._id,
        teamId: team._id,
        intakePolicyVersionId: pinnedPolicy.policy._id,
        ...(novelty ? { noveltyCorpusVersionId: novelty.corpusVersionId } : {}),
        stage: "follow_up",
        initialIdea: idea,
        version: draftVersion,
        lastEditedByMembershipId: membership._id,
        updatedAt: now,
      });
    }

    const initialAnswer = await saveAnswerVersion(ctx, {
      eventId: event._id,
      teamId: team._id,
      draftId,
      membershipId: membership._id,
      promptKey: "initial_idea",
      value: idea,
      clientOperationId: args.clientOperationId,
    });
    const persistedDraft = await ctx.db.get(draftId);
    if (!persistedDraft) throw new Error("The project draft did not persist.");
    if (existing) {
      for (const { question } of fixedResponses) {
        const earlierFixedAnswerIds = fixedResponses.flatMap((response) =>
          response.question.ordinal < question.ordinal && response.answer
            ? [response.answer._id]
            : [],
        );
        await ctx.db.patch(question._id, {
          sourceAnswerVersionIds: [initialAnswer._id, ...earlierFixedAnswerIds],
        });
      }
    } else {
      await createFixedIntakeQuestion(ctx, {
        draft: persistedDraft,
        policy: pinnedPolicy.policy,
        normalizedPolicy: pinnedPolicy.normalized,
        ordinal: 1,
        sourceAnswerVersionIds: [initialAnswer._id],
        now,
      });
    }
    if (!existing) {
      await deleteWorkingField(ctx, team._id, { kind: "idea" });
    }

    if (shouldGenerateAdaptiveQuestion) {
      await enqueueIntakeInterpretation(ctx, { draftId, draftVersion, enqueuedAt: now });
    }

    if (!team.membershipLocked) {
      const inputFingerprint = noveltyInputFingerprint(idea);
      await ctx.scheduler.runAfter(
        draftNoveltyIndexDelayMs(draftId, inputFingerprint, now),
        internal.novelty.indexDraftIdea,
        {
          draftId,
          inputFingerprint,
          sourceUpdatedAt: now,
        },
      );
    }

    await recordDraftOperation(ctx, {
      eventId: event._id,
      personId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "intake.idea.save",
      requestFingerprint,
      draftId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "team.project.write",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "intake.initial_idea_saved",
      targetType: "project_draft",
      targetId: draftId,
      nextSummary: JSON.stringify({
        draftVersion,
        stage: "follow_up",
        noveltyCorpusVersionId: novelty?.corpusVersionId ?? null,
      }),
      reason: "Team saved its initial project idea",
    });
    return { draftId, draftVersion };
  },
});

export const respondToFollowUp = mutation({
  args: {
    eventSlug: v.string(),
    questionId: v.id("intakeGeneratedQuestions"),
    answer: v.string(),
    expectedDraftVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ draftVersion: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject, membership, member, team } = await currentTeamContext(
      ctx,
      args.eventSlug,
    );
    const requestFingerprint = operationFingerprint([
      team._id,
      args.questionId,
      args.expectedDraftVersion,
      args.answer,
    ]);
    const replay = await replayDraftOperation(
      ctx,
      event._id,
      person._id,
      args.clientOperationId,
      "intake.follow_up.respond",
      requestFingerprint,
    );
    if (replay) return { draftVersion: replay.version };
    requireRegistrationOpen(event, membership.participantClass);
    const draft = await requireEditableTeamDraft(ctx, {
      event,
      subjectId: subject._id,
      membership,
      member,
      team,
    });
    if (!draft?.initialIdea || draft.stage !== "follow_up") {
      throw new ConvexError({
        code: "FOLLOW_UP_NOT_READY",
        message: "Wait for the current project question before answering.",
      });
    }
    requireDraftVersion(draft.version, args.expectedDraftVersion);
    const question = await ctx.db.get(args.questionId);
    if (
      !question ||
      question.draftId !== draft._id ||
      question.teamId !== team._id ||
      question.eventId !== event._id ||
      question.state !== "active"
    ) {
      throw new ConvexError({
        code: "FOLLOW_UP_CHANGED",
        message: "That follow-up is no longer active. Review the current question.",
      });
    }
    const { normalized: policy } = await requirePinnedIntakePolicy(ctx, draft);
    const responses = await loadCurrentIntakeResponses(ctx, draft._id);
    if (
      responses.some(
        ({ question: row }) => row.ordinal < question.ordinal && row.state !== "answered",
      )
    ) {
      throw new ConvexError({
        code: "FOLLOW_UP_OUT_OF_ORDER",
        message: "Complete the earlier follow-up first.",
      });
    }
    const answer = normalizedLongText(
      args.answer,
      "Follow-up answer",
      policy.followUpAnswerMinLength,
      policy.followUpAnswerMaxLength,
    );
    await saveAnswerVersion(ctx, {
      eventId: event._id,
      teamId: team._id,
      draftId: draft._id,
      membershipId: membership._id,
      promptKey: `introduction_follow_up_${question.ordinal}`,
      value: answer,
      generatedQuestionId: question._id,
      clientOperationId: args.clientOperationId,
    });
    const draftVersion = draft.version + 1;
    const now = Date.now();
    await reconcileWorkingFieldsAfterDraftVersionChange(ctx, {
      teamId: team._id,
      previousDraftVersion: draft.version,
      nextDraftVersion: draftVersion,
      removedQuestionIds: [question._id],
    });
    await ctx.db.patch(question._id, {
      state: "answered",
      answeredAt: now,
    });
    const nextOrdinal = question.ordinal + 1;
    const needsAnotherInterpretation = nextOrdinal <= policy.maximumFollowUpCount;
    if (nextOrdinal <= policy.deterministicFollowUpCount) {
      const activeAnswers = await loadActiveIntakeAnswers(ctx, draft._id);
      await createFixedIntakeQuestion(ctx, {
        draft,
        policy: (await requirePinnedIntakePolicy(ctx, draft)).policy,
        normalizedPolicy: policy,
        ordinal: nextOrdinal,
        sourceAnswerVersionIds: activeAnswers.map((answer) => answer._id),
        now,
      });
    }
    await ctx.db.patch(draft._id, {
      stage: needsAnotherInterpretation ? "follow_up" : "additional_information",
      adaptiveQuestionDeadlineAt: undefined,
      version: draftVersion,
      lastEditedByMembershipId: membership._id,
      updatedAt: now,
    });
    if (needsAnotherInterpretation && nextOrdinal > policy.deterministicFollowUpCount) {
      await enqueueIntakeInterpretation(ctx, {
        draftId: draft._id,
        draftVersion,
        enqueuedAt: now,
      });
    }
    await recordDraftOperation(ctx, {
      eventId: event._id,
      personId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "intake.follow_up.respond",
      requestFingerprint,
      draftId: draft._id,
      createdAt: now,
    });
    return { draftVersion };
  },
});

export const reviseFollowUp = mutation({
  args: {
    eventSlug: v.string(),
    questionId: v.id("intakeGeneratedQuestions"),
    answer: v.string(),
    expectedDraftVersion: v.number(),
    expectedWorkingRevision: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ draftVersion: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject, membership, member, team } = await currentTeamContext(
      ctx,
      args.eventSlug,
    );
    const requestFingerprint = operationFingerprint([
      team._id,
      args.questionId,
      args.expectedDraftVersion,
      args.expectedWorkingRevision,
      args.answer,
    ]);
    const replay = await replayDraftOperation(
      ctx,
      event._id,
      person._id,
      args.clientOperationId,
      "intake.follow_up.revise",
      requestFingerprint,
    );
    if (replay) return { draftVersion: replay.version };
    requireRegistrationOpen(event, membership.participantClass);
    const draft = await requireEditableTeamDraft(ctx, {
      event,
      subjectId: subject._id,
      membership,
      member,
      team,
    });
    if (!draft?.initialIdea || draft.stage !== "review") {
      throw new ConvexError({
        code: "FOLLOW_UP_NOT_EDITABLE",
        message: "Follow-up answers can be edited from the final review before submission.",
      });
    }
    requireDraftVersion(draft.version, args.expectedDraftVersion);
    const responses = await loadCurrentIntakeResponses(ctx, draft._id);
    const response = responses.find(({ question }) => question._id === args.questionId);
    if (
      !response ||
      response.question.teamId !== team._id ||
      response.question.eventId !== event._id ||
      response.question.state !== "answered"
    ) {
      throw new ConvexError({
        code: "FOLLOW_UP_CHANGED",
        message: "That follow-up is no longer part of the current introduction.",
      });
    }
    const { normalized: policy } = await requirePinnedIntakePolicy(ctx, draft);
    const answer = normalizedLongText(
      args.answer,
      "Follow-up answer",
      policy.followUpAnswerMinLength,
      policy.followUpAnswerMaxLength,
    );
    const unchanged = response.answer?.value === answer;
    const workingField = await findWorkingField(ctx, team._id, {
      kind: "follow_up",
      questionId: response.question._id,
    });
    const workingValue = workingField?.value.trim().replace(/\r\n/g, "\n");
    if (
      (workingField?.revision ?? 0) !== args.expectedWorkingRevision ||
      (workingField !== null && workingValue !== answer) ||
      (!workingField && !unchanged)
    ) {
      throw new ConvexError({
        code: "WORKING_FIELD_CHANGED",
        message: "A teammate saved newer text in this field. Your text is still here.",
      });
    }
    const now = Date.now();
    if (unchanged) {
      if (workingField) await ctx.db.delete(workingField._id);
      await recordDraftOperation(ctx, {
        eventId: event._id,
        personId: person._id,
        clientOperationId: args.clientOperationId,
        commandName: "intake.follow_up.revise",
        requestFingerprint,
        draftId: draft._id,
        createdAt: now,
      });
      return { draftVersion: draft.version };
    }

    await saveAnswerVersion(ctx, {
      eventId: event._id,
      teamId: team._id,
      draftId: draft._id,
      membershipId: membership._id,
      promptKey: `introduction_follow_up_${response.question.ordinal}`,
      value: answer,
      generatedQuestionId: response.question._id,
      clientOperationId: args.clientOperationId,
    });
    await ctx.db.patch(response.question._id, {
      state: "answered",
      answeredAt: now,
    });
    const regenerateAfterOrdinal = Math.max(
      response.question.ordinal,
      policy.deterministicFollowUpCount,
    );
    const invalidatedQuestionIds = responses.flatMap(({ question }) =>
      question.ordinal > regenerateAfterOrdinal ? [question._id] : [],
    );
    await replaceIntakeQuestionsAfter(ctx, draft._id, regenerateAfterOrdinal);
    const needsAnotherInterpretation = regenerateAfterOrdinal < policy.maximumFollowUpCount;
    const draftVersion = draft.version + 1;
    await reconcileWorkingFieldsAfterDraftVersionChange(ctx, {
      teamId: team._id,
      previousDraftVersion: draft.version,
      nextDraftVersion: draftVersion,
      removedQuestionIds: [response.question._id, ...invalidatedQuestionIds],
    });
    await ctx.db.patch(draft._id, {
      stage: needsAnotherInterpretation ? "follow_up" : "review",
      adaptiveQuestionDeadlineAt: undefined,
      version: draftVersion,
      lastEditedByMembershipId: membership._id,
      updatedAt: now,
    });
    if (needsAnotherInterpretation) {
      await enqueueIntakeInterpretation(ctx, {
        draftId: draft._id,
        draftVersion,
        enqueuedAt: now,
      });
    }
    await recordDraftOperation(ctx, {
      eventId: event._id,
      personId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "intake.follow_up.revise",
      requestFingerprint,
      draftId: draft._id,
      createdAt: now,
    });
    return { draftVersion };
  },
});

export const saveAdditionalInformation = mutation({
  args: {
    eventSlug: v.string(),
    value: v.string(),
    baseValue: v.string(),
    expectedDraftVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ draftVersion: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject, membership, member, team } = await currentTeamContext(
      ctx,
      args.eventSlug,
    );
    const requestFingerprint = operationFingerprint([
      team._id,
      args.expectedDraftVersion,
      args.baseValue,
      args.value,
    ]);
    const replay = await replayDraftOperation(
      ctx,
      event._id,
      person._id,
      args.clientOperationId,
      "intake.additional_information.save",
      requestFingerprint,
    );
    if (replay) return { draftVersion: replay.version };
    requireRegistrationOpen(event, membership.participantClass);
    const draft = await requireEditableTeamDraft(ctx, {
      event,
      subjectId: subject._id,
      membership,
      member,
      team,
    });
    if (
      !draft?.initialIdea ||
      (draft.stage !== "additional_information" && draft.stage !== "review")
    ) {
      throw new ConvexError({
        code: "ADDITIONAL_INFORMATION_NOT_EDITABLE",
        message: "Additional information can be edited after the project questions are complete.",
      });
    }
    const additionalInformation = normalizedAdditionalInformation(args.value);
    const baseAdditionalInformation = normalizedAdditionalInformation(args.baseValue);
    if (
      draft.version !== args.expectedDraftVersion &&
      draft.additionalInformation !== baseAdditionalInformation
    ) {
      requireDraftVersion(draft.version, args.expectedDraftVersion);
    }
    const now = Date.now();
    const completingStep = draft.stage === "additional_information";
    if (draft.additionalInformation === additionalInformation && !completingStep) {
      await recordDraftOperation(ctx, {
        eventId: event._id,
        personId: person._id,
        clientOperationId: args.clientOperationId,
        commandName: "intake.additional_information.save",
        requestFingerprint,
        draftId: draft._id,
        createdAt: now,
      });
      return { draftVersion: draft.version };
    }
    const draftVersion = draft.version + 1;
    await reconcileWorkingFieldsAfterDraftVersionChange(ctx, {
      teamId: team._id,
      previousDraftVersion: draft.version,
      nextDraftVersion: draftVersion,
    });
    await ctx.db.patch(draft._id, {
      additionalInformation,
      stage: "review",
      version: draftVersion,
      lastEditedByMembershipId: membership._id,
      updatedAt: now,
    });
    await recordDraftOperation(ctx, {
      eventId: event._id,
      personId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "intake.additional_information.save",
      requestFingerprint,
      draftId: draft._id,
      createdAt: now,
    });
    return { draftVersion };
  },
});

export const setFreshnessAttestation = mutation({
  args: {
    eventSlug: v.string(),
    accepted: v.boolean(),
    expectedDraftVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ draftVersion: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject, membership, member, team } = await currentTeamContext(
      ctx,
      args.eventSlug,
    );
    const requestFingerprint = operationFingerprint([
      team._id,
      args.accepted,
      args.expectedDraftVersion,
    ]);
    const replay = await replayDraftOperation(
      ctx,
      event._id,
      person._id,
      args.clientOperationId,
      "intake.freshness.set",
      requestFingerprint,
    );
    if (replay) return { draftVersion: replay.version };
    requireRegistrationOpen(event, membership.participantClass);
    const draft = await requireEditableTeamDraft(ctx, {
      event,
      subjectId: subject._id,
      membership,
      member,
      team,
    });
    if (!draft)
      throw new ConvexError({ code: "DRAFT_REQUIRED", message: "Start the project intake first." });
    requireDraftVersion(draft.version, args.expectedDraftVersion);
    const now = Date.now();
    const acceptedAt = args.accepted ? now : undefined;
    const draftVersion = draft.version + 1;
    await reconcileWorkingFieldsAfterDraftVersionChange(ctx, {
      teamId: team._id,
      previousDraftVersion: draft.version,
      nextDraftVersion: draftVersion,
    });
    await ctx.db.patch(draft._id, {
      freshnessAttestedByMembershipId: args.accepted ? membership._id : undefined,
      freshnessAttestedAt: acceptedAt,
      version: draftVersion,
      lastEditedByMembershipId: membership._id,
      updatedAt: now,
    });
    await recordDraftOperation(ctx, {
      eventId: event._id,
      personId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "intake.freshness.set",
      requestFingerprint,
      draftId: draft._id,
      createdAt: now,
    });
    return { draftVersion };
  },
});

export const submissionPreview = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      teamId: v.id("teams"),
      teamName: v.string(),
      teamVersion: v.number(),
      draftVersion: v.number(),
      lastEditedByMembershipId: v.id("eventMemberships"),
      applicationsCloseAt: v.number(),
      initialIdea: v.optional(v.string()),
      additionalInformation: v.optional(v.string()),
      additionalInformationMaxLength: v.number(),
      followUps: v.array(
        v.object({
          id: v.id("intakeGeneratedQuestions"),
          ordinal: v.number(),
          question: v.string(),
          purposeKey: v.string(),
          source: v.union(v.literal("fixed"), v.literal("model"), v.literal("fallback")),
          answer: v.string(),
        }),
      ),
      freshnessAttested: v.boolean(),
      memberCount: v.number(),
      members: v.array(
        v.object({
          membershipId: v.id("eventMemberships"),
          displayName: v.string(),
          role: v.union(v.literal("lead"), v.literal("member")),
          submissionReady: v.boolean(),
        }),
      ),
      blockers: v.array(v.string()),
      participantPolicyVersionId: v.id("participantPolicyVersions"),
      warning: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const person = await findCurrentPerson(ctx);
    if (!person) return null;
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const membership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (!membership) return null;
    const member = await ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index.eq("eventId", event._id).eq("membershipId", membership._id).eq("status", "active"),
      )
      .unique();
    if (!member) return null;
    const team = await ctx.db.get(member.teamId);
    if (!team) return null;
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.read",
      scopeType: "team",
      scopeId: team._id,
    });
    const draft = await ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", team._id))
      .unique();
    if (!draft) return null;
    const participantPolicy = await loadPublishedParticipantPolicy(ctx, event);
    const rosterCounts = teamRosterCounts(team);
    const [pinnedPolicy, followUps, activeMembers] = await Promise.all([
      requirePinnedIntakePolicy(ctx, draft),
      loadCurrentIntakeResponses(ctx, draft._id),
      ctx.db
        .query("teamMembers")
        .withIndex("by_team_status", (index) => index.eq("teamId", team._id).eq("status", "active"))
        .take(rosterCounts.activeMemberCount + 1),
    ]);
    if (activeMembers.length !== rosterCounts.activeMemberCount) {
      throw new Error("The team roster count does not match its active members.");
    }
    const previewMembers = await Promise.all(
      activeMembers.map(async (activeMember) => {
        if (activeMember.eventId !== event._id) {
          throw new Error("An active team member belongs to another event.");
        }
        const eventMembership = await ctx.db.get(activeMember.membershipId);
        if (!eventMembership || eventMembership.eventId !== event._id) {
          throw new Error("An active team member references an invalid event membership.");
        }
        const [memberPerson, profile, policyAccepted] = await Promise.all([
          ctx.db.get(eventMembership.personId),
          ctx.db
            .query("participantProfiles")
            .withIndex("by_membership", (index) => index.eq("membershipId", eventMembership._id))
            .unique(),
          participantPolicyAccepted(ctx, eventMembership, participantPolicy.policy),
        ]);
        if (!memberPerson) {
          throw new Error("An active team member references a missing person.");
        }
        return {
          membershipId: eventMembership._id,
          displayName: profile?.fullName ?? memberPerson.displayName,
          role: activeMember.role,
          submissionReady:
            eventMembership.eligibilityStatus === "eligible" &&
            memberPerson.status === "active" &&
            policyAccepted &&
            isProfileCompleteForPolicy(profile, eventMembership, participantPolicy.policy),
        };
      }),
    );
    previewMembers.sort((left, right) => {
      if (left.role !== right.role) return left.role === "lead" ? -1 : 1;
      return left.displayName.localeCompare(right.displayName, "en");
    });
    const blockers: string[] = [];
    if (rosterCounts.activeMemberCount < participantPolicy.normalized.teamMinimumSize) {
      blockers.push(
        `At least ${participantPolicy.normalized.teamMinimumSize} members are required.`,
      );
    }
    if (!teamClassesMeetPolicy(team, participantPolicy.normalized)) {
      blockers.push("The current participant policy does not allow mixed VIT and external teams.");
    }
    if (!draft.initialIdea) blockers.push("The initial project idea is missing.");
    if (!intakeSequenceComplete(pinnedPolicy.normalized, followUps)) {
      blockers.push("Complete the project follow-ups.");
    }
    if (previewMembers.some((member) => !member.submissionReady)) {
      blockers.push(
        "Every team member must be eligible, accept the current policy, and finish their profile.",
      );
    }
    const applicationsCloseAt = applicationsCloseAtFor(event, membership.participantClass);
    if (Date.now() >= applicationsCloseAt) blockers.push("The application deadline has passed.");
    return {
      teamId: team._id,
      teamName: team.name,
      teamVersion: team.version,
      draftVersion: draft.version,
      lastEditedByMembershipId: draft.lastEditedByMembershipId,
      applicationsCloseAt,
      ...(draft.initialIdea !== undefined ? { initialIdea: draft.initialIdea } : {}),
      ...(draft.additionalInformation !== undefined
        ? { additionalInformation: draft.additionalInformation }
        : {}),
      additionalInformationMaxLength,
      followUps: followUps.map(({ question, answer }) => ({
        id: question._id,
        ordinal: question.ordinal,
        question: question.text,
        purposeKey: question.purposeKey,
        source: question.source,
        answer: requiredIntakeAnswerValue(answer),
      })),
      freshnessAttested: Boolean(draft.freshnessAttestedAt),
      memberCount: rosterCounts.activeMemberCount,
      members: previewMembers,
      blockers,
      participantPolicyVersionId: participantPolicy.policy._id,
      warning: participantPolicy.normalized.finalSubmissionWarning,
    };
  },
});

function submissionExperienceBand(attempt: Doc<"teamSubmissionAttempts">) {
  if (attempt.processedExternalMemberCount > 0) return "mixed_or_external" as const;
  if (attempt.hasPostgraduateYear || attempt.hasNotApplicableYear) {
    return "postgraduate_or_professional" as const;
  }
  if (attempt.hasFirstYear && !attempt.hasSecondYear && !attempt.hasLaterYear) {
    return "first_year" as const;
  }
  if (!attempt.hasLaterYear && (attempt.hasFirstYear || attempt.hasSecondYear)) {
    return "early_year" as const;
  }
  if (attempt.hasLaterYear && !attempt.hasFirstYear && !attempt.hasSecondYear)
    return "later_year" as const;
  return "mixed_or_external" as const;
}

const submissionResult = v.object({
  state: v.union(v.literal("validating"), v.literal("complete"), v.literal("failed")),
  submissionAttemptId: v.id("teamSubmissionAttempts"),
  applicationId: v.optional(v.id("applications")),
  projectVersionId: v.optional(v.id("projectVersions")),
  submittedAt: v.optional(v.number()),
  failureMessage: v.optional(v.string()),
});

export const submit = mutation({
  args: {
    eventSlug: v.string(),
    expectedDraftVersion: v.number(),
    expectedTeamVersion: v.number(),
    participantPolicyVersionId: v.id("participantPolicyVersions"),
    clientOperationId: v.string(),
  },
  returns: submissionResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.expectedDraftVersion,
      args.expectedTeamVersion,
      args.participantPolicyVersionId,
    ]);
    const priorAttempt = await ctx.db
      .query("teamSubmissionAttempts")
      .withIndex("by_event_and_requester_and_client_operation", (index) =>
        index
          .eq("eventId", event._id)
          .eq("requestedByPersonId", person._id)
          .eq("clientOperationId", args.clientOperationId),
      )
      .unique();
    if (priorAttempt) {
      if (priorAttempt.requestFingerprint !== requestFingerprint) {
        throw new ConvexError({
          code: "OPERATION_ID_REUSED",
          message: "That operation ID belongs to a different submission request.",
        });
      }
      const state =
        priorAttempt.state === "complete"
          ? ("complete" as const)
          : priorAttempt.state === "failed"
            ? ("failed" as const)
            : ("validating" as const);
      return {
        state,
        submissionAttemptId: priorAttempt._id,
        ...(priorAttempt.applicationId !== undefined
          ? { applicationId: priorAttempt.applicationId }
          : {}),
        ...(priorAttempt.projectVersionId !== undefined
          ? { projectVersionId: priorAttempt.projectVersionId }
          : {}),
        ...(priorAttempt.completedAt !== undefined
          ? { submittedAt: priorAttempt.completedAt }
          : {}),
        ...(priorAttempt.failureMessage !== undefined
          ? { failureMessage: priorAttempt.failureMessage }
          : {}),
      };
    }

    const participantPolicy = await loadPublishedParticipantPolicy(ctx, event);
    if (participantPolicy.policy._id !== args.participantPolicyVersionId) {
      throw new ConvexError({
        code: "PARTICIPANT_POLICY_CHANGED",
        message: "The participant policy changed. Review the team and submission warning again.",
      });
    }

    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    requireRegistrationOpen(event, membership.participantClass);
    const member = await ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index.eq("eventId", event._id).eq("membershipId", membership._id).eq("status", "active"),
      )
      .unique();
    if (!member || member.role !== "lead") {
      throw new ConvexError({
        code: "TEAM_LEAD_REQUIRED",
        message: "Only the team lead can submit.",
      });
    }
    const team = await ctx.db.get(member.teamId);
    if (!team || team.membershipLocked) {
      throw new ConvexError({
        code: "SUBMISSION_LOCKED",
        message: "This application has already been submitted.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "application.submit",
      scopeType: "team",
      scopeId: team._id,
    });
    if (team.version !== args.expectedTeamVersion) {
      throw new ConvexError({
        code: "TEAM_CHANGED",
        message: "The team changed. Review it again.",
      });
    }
    const draft = await ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", team._id))
      .unique();
    if (!draft || draft.version !== args.expectedDraftVersion) {
      throw new ConvexError({
        code: "DRAFT_CHANGED",
        message: "The project changed. Review it again.",
      });
    }
    if (
      !draft.initialIdea ||
      !draft.freshnessAttestedAt ||
      !draft.freshnessAttestedByMembershipId
    ) {
      throw new ConvexError({
        code: "DRAFT_INCOMPLETE",
        message: "Complete every project step first.",
      });
    }
    const [pinnedPolicy, intakeResponses] = await Promise.all([
      requirePinnedIntakePolicy(ctx, draft),
      loadCurrentIntakeResponses(ctx, draft._id),
    ]);
    if (
      draft.stage !== "review" ||
      !intakeSequenceComplete(pinnedPolicy.normalized, intakeResponses)
    ) {
      throw new ConvexError({
        code: "DRAFT_INCOMPLETE",
        message: "Complete every project follow-up first.",
      });
    }
    const rosterCounts = teamRosterCounts(team);
    if (
      rosterCounts.activeMemberCount < participantPolicy.normalized.teamMinimumSize ||
      rosterCounts.activeMemberCount > participantPolicy.normalized.teamMaximumSize
    ) {
      throw new ConvexError({
        code: "TEAM_SIZE",
        message: "The team does not meet the published size policy.",
      });
    }
    if (!teamClassesMeetPolicy(team, participantPolicy.normalized)) {
      throw new ConvexError({
        code: "MIXED_TEAM_NOT_ALLOWED",
        message: "The current participant policy does not allow mixed VIT and external teams.",
      });
    }
    const admissionConfiguration = await loadPublishedAdmissionConfiguration(ctx, event);
    const now = Date.now();
    const lockedTeamVersion = team.version + 1;
    const submissionAttemptId = await ctx.db.insert("teamSubmissionAttempts", {
      eventId: event._id,
      teamId: team._id,
      draftId: draft._id,
      requestedByPersonId: person._id,
      requestedByMembershipId: membership._id,
      authorizingGrantIds: grantIds,
      clientOperationId: args.clientOperationId,
      requestFingerprint,
      state: "validating",
      sourceTeamVersion: team.version,
      lockedTeamVersion,
      sourceDraftVersion: draft.version,
      participantPolicyVersionId: participantPolicy.policy._id,
      admissionPolicyVersionId: admissionConfiguration.policy._id,
      processedMemberCount: 0,
      processedVitMemberCount: 0,
      processedExternalMemberCount: 0,
      hasFirstYear: false,
      hasSecondYear: false,
      hasLaterYear: false,
      hasPostgraduateYear: false,
      hasNotApplicableYear: false,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(team._id, {
      membershipLocked: true,
      submissionAttemptId,
      lockedAt: now,
      lockParticipantPolicyVersionId: participantPolicy.policy._id,
      version: lockedTeamVersion,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.intake.materializeSubmissionRoster, {
      submissionAttemptId,
    });
    return { state: "validating" as const, submissionAttemptId };
  },
});

const submissionRosterBatchSize = 100;

async function failSubmissionAttempt(
  ctx: MutationCtx,
  attempt: Doc<"teamSubmissionAttempts">,
  code: string,
  message: string,
  now: number,
) {
  const team = await ctx.db.get(attempt.teamId);
  if (
    team &&
    team.submissionAttemptId === attempt._id &&
    team.lockedProjectVersionId === undefined
  ) {
    await ctx.db.patch(team._id, {
      membershipLocked: false,
      lockedAt: undefined,
      lockParticipantPolicyVersionId: undefined,
      version: team.version + 1,
      updatedAt: now,
    });
  }
  await ctx.db.patch(attempt._id, {
    state: "failed",
    failureCode: code,
    failureMessage: message,
    updatedAt: now,
    completedAt: now,
  });
}

export const materializeSubmissionRoster = internalMutation({
  args: { submissionAttemptId: v.id("teamSubmissionAttempts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attempt = await ctx.db.get(args.submissionAttemptId);
    if (!attempt || attempt.state !== "validating") return null;
    const [event, team, draft, participantPolicy] = await Promise.all([
      ctx.db.get(attempt.eventId),
      ctx.db.get(attempt.teamId),
      ctx.db.get(attempt.draftId),
      ctx.db.get(attempt.participantPolicyVersionId),
    ]);
    const now = Date.now();
    if (
      !event ||
      !team ||
      !draft ||
      !participantPolicy ||
      team.eventId !== attempt.eventId ||
      draft.teamId !== team._id ||
      participantPolicy.eventId !== event._id ||
      team.submissionAttemptId !== attempt._id ||
      !team.membershipLocked ||
      team.version !== attempt.lockedTeamVersion ||
      draft.version !== attempt.sourceDraftVersion
    ) {
      await failSubmissionAttempt(
        ctx,
        attempt,
        "SUBMISSION_CONTEXT_CHANGED",
        "The team or project changed while the roster was being validated.",
        now,
      );
      return null;
    }
    const normalizedPolicy = normalizeParticipantPolicy(
      participantPolicyFromDocument(participantPolicy),
    );
    if (
      (participantPolicy.status !== "published" && participantPolicy.status !== "superseded") ||
      participantPolicyChecksum(normalizedPolicy) !== participantPolicy.checksum
    ) {
      await failSubmissionAttempt(
        ctx,
        attempt,
        "PARTICIPANT_POLICY_CHANGED",
        "The participant policy changed while the roster was being validated.",
        now,
      );
      return null;
    }
    const page = await ctx.db
      .query("teamMembers")
      .withIndex("by_team_status", (index) => index.eq("teamId", team._id).eq("status", "active"))
      .paginate({
        numItems: submissionRosterBatchSize,
        cursor: attempt.cursor ?? null,
      });
    let processedMemberCount = attempt.processedMemberCount;
    let processedVitMemberCount = attempt.processedVitMemberCount;
    let processedExternalMemberCount = attempt.processedExternalMemberCount;
    let hasFirstYear = attempt.hasFirstYear;
    let hasSecondYear = attempt.hasSecondYear;
    let hasLaterYear = attempt.hasLaterYear;
    let hasPostgraduateYear = attempt.hasPostgraduateYear;
    let hasNotApplicableYear = attempt.hasNotApplicableYear;
    for (const teamMember of page.page) {
      if (teamMember.eventId !== event._id || teamMember.teamId !== team._id) {
        throw new Error("The active team roster contains a foreign member.");
      }
      const existing = await ctx.db
        .query("teamSubmissionMembers")
        .withIndex("by_submission_attempt_and_team_member", (index) =>
          index.eq("submissionAttemptId", attempt._id).eq("teamMemberId", teamMember._id),
        )
        .unique();
      if (existing) continue;
      const membership = await ctx.db.get(teamMember.membershipId);
      if (
        !membership ||
        membership.eventId !== event._id ||
        membership.eligibilityStatus !== "eligible" ||
        !(await participantPolicyAccepted(ctx, membership, participantPolicy))
      ) {
        await failSubmissionAttempt(
          ctx,
          attempt,
          "MEMBER_NOT_ELIGIBLE",
          "Every team member must remain eligible and accept the current policy.",
          now,
        );
        return null;
      }
      const [profile, memberPerson] = await Promise.all([
        ctx.db
          .query("participantProfiles")
          .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
          .unique(),
        ctx.db.get(membership.personId),
      ]);
      if (
        !profile ||
        !memberPerson ||
        memberPerson.status !== "active" ||
        !isProfileCompleteForPolicy(profile, membership, participantPolicy)
      ) {
        await failSubmissionAttempt(
          ctx,
          attempt,
          "PROFILE_INCOMPLETE",
          "Every team member must finish their profile before submission.",
          now,
        );
        return null;
      }
      processedMemberCount += 1;
      if (membership.participantClass === "vit_student") {
        processedVitMemberCount += 1;
      } else {
        processedExternalMemberCount += 1;
      }
      hasFirstYear ||= profile.yearOfStudy === "first";
      hasSecondYear ||= profile.yearOfStudy === "second";
      hasLaterYear ||= ["third", "fourth", "fifth_or_later"].includes(profile.yearOfStudy);
      hasPostgraduateYear ||= profile.yearOfStudy === "postgraduate";
      hasNotApplicableYear ||= profile.yearOfStudy === "not_applicable";
      await ctx.db.insert("teamSubmissionMembers", {
        eventId: event._id,
        submissionAttemptId: attempt._id,
        teamId: team._id,
        ordinal: processedMemberCount,
        teamMemberId: teamMember._id,
        membershipId: membership._id,
        personId: membership.personId,
        role: teamMember.role,
        participantClass: membership.participantClass,
        displayName: profile.fullName ?? memberPerson.displayName,
        institution: profile.institution,
        yearOfStudy: profile.yearOfStudy,
        profileVersion: profile.profileVersion,
        destinationEmailNormalized: normalizeEmail(memberPerson.verifiedEmail),
        materializedAt: now,
      });
    }
    await ctx.db.patch(attempt._id, {
      cursor: page.isDone ? undefined : page.continueCursor,
      processedMemberCount,
      processedVitMemberCount,
      processedExternalMemberCount,
      hasFirstYear,
      hasSecondYear,
      hasLaterYear,
      hasPostgraduateYear,
      hasNotApplicableYear,
      updatedAt: now,
    });
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.intake.materializeSubmissionRoster, {
        submissionAttemptId: attempt._id,
      });
      return null;
    }
    const counts = teamRosterCounts(team);
    if (
      processedMemberCount !== counts.activeMemberCount ||
      processedVitMemberCount !== counts.activeVitMemberCount ||
      processedExternalMemberCount !== counts.activeExternalMemberCount ||
      processedMemberCount < normalizedPolicy.teamMinimumSize ||
      processedMemberCount > normalizedPolicy.teamMaximumSize ||
      (!normalizedPolicy.mixedParticipantClassesAllowed &&
        processedVitMemberCount > 0 &&
        processedExternalMemberCount > 0)
    ) {
      await failSubmissionAttempt(
        ctx,
        attempt,
        "ROSTER_VALIDATION_FAILED",
        "The validated roster does not match the team's published size and class policy.",
        now,
      );
      return null;
    }
    await ctx.db.patch(attempt._id, { state: "finalizing", updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.intake.finalizeSubmission, {
      submissionAttemptId: attempt._id,
    });
    return null;
  },
});

export const finalizeSubmission = internalMutation({
  args: { submissionAttemptId: v.id("teamSubmissionAttempts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attempt = await ctx.db.get(args.submissionAttemptId);
    if (!attempt || attempt.state !== "finalizing") return null;
    const [event, team, draft] = await Promise.all([
      ctx.db.get(attempt.eventId),
      ctx.db.get(attempt.teamId),
      ctx.db.get(attempt.draftId),
    ]);
    const now = Date.now();
    if (
      !event ||
      !team ||
      !draft ||
      team.submissionAttemptId !== attempt._id ||
      team.version !== attempt.lockedTeamVersion ||
      draft.version !== attempt.sourceDraftVersion ||
      !draft.initialIdea ||
      !draft.freshnessAttestedAt ||
      !draft.freshnessAttestedByMembershipId
    ) {
      await failSubmissionAttempt(
        ctx,
        attempt,
        "SUBMISSION_CONTEXT_CHANGED",
        "The frozen submission context is no longer valid.",
        now,
      );
      return null;
    }
    const [participantPolicy, admissionPolicy, pinnedPolicy, intakeResponses] = await Promise.all([
      ctx.db.get(attempt.participantPolicyVersionId),
      ctx.db.get(attempt.admissionPolicyVersionId),
      requirePinnedIntakePolicy(ctx, draft),
      loadCurrentIntakeResponses(ctx, draft._id),
    ]);
    if (
      !participantPolicy ||
      !admissionPolicy ||
      participantPolicy.eventId !== event._id ||
      admissionPolicy.eventId !== event._id ||
      draft.stage !== "review" ||
      !intakeSequenceComplete(pinnedPolicy.normalized, intakeResponses)
    ) {
      await failSubmissionAttempt(
        ctx,
        attempt,
        "SUBMISSION_CONTEXT_CHANGED",
        "The frozen project or policy context is no longer valid.",
        now,
      );
      return null;
    }
    const admissionConfiguration = await loadPublishedAdmissionConfiguration(ctx, event);
    if (admissionConfiguration.policy._id !== admissionPolicy._id) {
      await failSubmissionAttempt(
        ctx,
        attempt,
        "ADMISSION_POLICY_CHANGED",
        "The admission release changed before submission completed.",
        now,
      );
      return null;
    }
    const previousProjectVersion = await ctx.db
      .query("projectVersions")
      .withIndex("by_team_version", (index) => index.eq("teamId", team._id))
      .order("desc")
      .first();
    const projectVersionId = await ctx.db.insert("projectVersions", {
      eventId: event._id,
      teamId: team._id,
      version: (previousProjectVersion?.version ?? 0) + 1,
      initialIdea: draft.initialIdea,
      ...(draft.additionalInformation !== undefined
        ? { additionalInformation: draft.additionalInformation }
        : {}),
      intakePolicyVersionId: pinnedPolicy.policy._id,
      intakeResponses: intakeResponses.map(({ question, answer }) => ({
        questionId: question._id,
        ordinal: question.ordinal,
        question: question.text,
        purposeKey: question.purposeKey,
        answerLength: question.answerLength,
        source: question.source,
        answer: requiredIntakeAnswerValue(answer),
      })),
      lockedRosterSnapshotId: attempt._id,
      lockedMemberCount: attempt.processedMemberCount,
      lockedLeadMembershipId: team.leadMembershipId,
      freshForEventAttestation: {
        participantPolicyVersionId: participantPolicy._id,
        acceptedByMembershipId: draft.freshnessAttestedByMembershipId,
        acceptedAt: draft.freshnessAttestedAt,
      },
      finalConfirmation: {
        participantPolicyVersionId: participantPolicy._id,
        previewedDraftVersion: attempt.sourceDraftVersion,
        previewedTeamVersion: attempt.sourceTeamVersion,
        confirmedByMembershipId: attempt.requestedByMembershipId,
        confirmedAt: attempt.createdAt,
      },
      participantPolicyVersionId: participantPolicy._id,
      admissionPolicyVersionId: admissionPolicy._id,
      sourceDraftVersion: draft.version,
      submittedByMembershipId: attempt.requestedByMembershipId,
      submittedAt: now,
    });
    const applicationId = await ctx.db.insert("applications", {
      eventId: event._id,
      teamId: team._id,
      submittedProjectVersionId: projectVersionId,
      admissionPolicyVersionId: admissionPolicy._id,
      state: "submitted",
      decisionStage: "unrecorded",
      experienceBand: submissionExperienceBand(attempt),
      ...(admissionConfiguration.model ? {} : { aiDisposition: "unavailable" }),
      assignedReviewCount: 0,
      completedReviewCount: 0,
      contentVersion: 1,
      version: 1,
      submittedAt: now,
    });
    const [application, projectVersion] = await Promise.all([
      ctx.db.get(applicationId),
      ctx.db.get(projectVersionId),
    ]);
    if (!application || !projectVersion) {
      throw new Error("Submitted application context did not persist.");
    }
    await createAdmissionRecommendation(ctx, {
      application,
      project: projectVersion,
      policy: admissionPolicy,
      modelConfig: admissionConfiguration.model,
      now,
    });
    await ctx.db.patch(team._id, {
      status: "submitted",
      lockedProjectVersionId: projectVersionId,
      updatedAt: now,
    });
    await ctx.db.patch(draft._id, {
      stage: "submitted",
      adaptiveQuestionDeadlineAt: undefined,
      version: draft.version + 1,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.novelty.indexSubmittedProjectIdea, {
      projectVersionId,
      inputFingerprint: noveltyInputFingerprint(draft.initialIdea),
      sourceUpdatedAt: now,
    });
    await ctx.db.patch(attempt._id, {
      state: "complete",
      projectVersionId,
      applicationId,
      updatedAt: now,
      completedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: attempt.requestedByPersonId,
      clientOperationId: attempt.clientOperationId,
      commandName: "intake.submit",
      requestFingerprint: attempt.requestFingerprint,
      targetType: "application",
      targetId: applicationId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: attempt.requestedByPersonId,
      permissionKey: "application.submit",
      grantIds: attempt.authorizingGrantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "application.submitted",
      targetType: "application",
      targetId: applicationId,
      previousSummary: JSON.stringify({
        teamVersion: attempt.sourceTeamVersion,
        draftVersion: attempt.sourceDraftVersion,
      }),
      nextSummary: JSON.stringify({
        projectVersionId,
        memberCount: attempt.processedMemberCount,
        submittedAt: attempt.createdAt,
      }),
      reason: "Team lead explicitly confirmed final submission",
    });
    await ctx.scheduler.runAfter(0, internal.admissions.updateRosterOnboardingStatus, {
      applicationId,
      expectedApplicationVersion: 1,
      lockedRosterSnapshotId: attempt._id,
      onboardingStatus: "submitted",
      cursor: null,
    });
    return null;
  },
});
