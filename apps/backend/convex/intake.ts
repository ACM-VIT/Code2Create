import { ConvexError, v, type Infer } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { loadPublishedAdmissionConfiguration } from "./lib/admissionPolicy";
import { createAdmissionRecommendation } from "./lib/admissionRecommendation";
import { requireEventBySlug, requireRegistrationOpen } from "./lib/events";
import {
  findCurrentPerson,
  requireCurrentPerson,
  requireEventSubject,
  requireMembership,
} from "./lib/identity";
import { requirePermission } from "./lib/permissions";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import {
  isProfileCompleteForPolicy,
  loadPublishedParticipantPolicy,
  participantClassesMeetPolicy,
} from "./lib/participantPolicy";
import { normalizedLongText } from "./lib/strings";
import {
  requirePinnedIntakePolicy,
  requirePublishedIntakePolicy,
} from "./lib/intakePolicy";
import {
  deactivateCurrentQuestionAnswer,
  intakeSequenceComplete,
  loadCurrentIntakeResponses,
  replaceIntakeQuestionsAfter,
  replaceCurrentIntakeQuestions,
} from "./lib/intakeQuestions";
import {
  requirePinnedTrackCatalog,
  requireSponsorTrackSelection,
} from "./lib/trackCatalog";
import { intakeWorkpool } from "./workpools";

const currentDraftView = v.object({
  id: v.id("projectDrafts"),
  trackCatalogVersionId: v.id("trackCatalogVersions"),
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
  tracks: v.array(
    v.object({
      id: v.id("trackVersions"),
      stableKey: v.string(),
      slug: v.string(),
      displayName: v.string(),
      description: v.string(),
      examples: v.array(v.string()),
      displayOrder: v.number(),
      type: v.union(v.literal("core"), v.literal("sponsor")),
      eligibilityText: v.optional(v.string()),
    }),
  ),
  stage: v.string(),
  initialIdea: v.optional(v.string()),
  chosenCoreTrackVersionId: v.optional(v.id("trackVersions")),
  chosenSponsorTrackVersionIds: v.array(v.id("trackVersions")),
  recommendedCoreTrackVersionId: v.optional(v.id("trackVersions")),
  recommendationReason: v.optional(v.string()),
  recommendationState: v.string(),
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
  noveltySignal: v.union(
    v.null(),
    v.object({
      score: v.number(),
      band: v.union(
        v.literal("familiar"),
        v.literal("developing"),
        v.literal("distinct"),
      ),
      nearestThemeLabel: v.string(),
      reflectionPrompt: v.string(),
      evaluatedAt: v.number(),
    }),
  ),
  followUps: v.array(
    v.object({
      id: v.id("intakeGeneratedQuestions"),
      ordinal: v.number(),
      question: v.string(),
      purposeKey: v.string(),
      answerLength: v.union(v.literal("short"), v.literal("medium")),
      source: v.union(v.literal("model"), v.literal("fallback")),
      state: v.union(v.literal("active"), v.literal("answered"), v.literal("skipped")),
      answer: v.optional(v.string()),
    }),
  ),
  freshnessAttested: v.boolean(),
  version: v.number(),
});

type ReadCtx = QueryCtx | MutationCtx;

const participantNoveltyConfiguration = v.object({
  corpusVersionId: v.id("noveltyCorpusVersions"),
  corpusVersion: v.number(),
  corpusLabel: v.string(),
  comparedProjectCount: v.number(),
  minimumIdeaLength: v.number(),
  debounceMs: v.number(),
});

async function participantNoveltyConfig(
  ctx: ReadCtx,
  event: Doc<"events">,
  draft?: Doc<"projectDrafts">,
) {
  const corpusVersionId = draft?.noveltyCorpusVersionId
    ?? event.publishedNoveltyCorpusVersionId;
  if (!corpusVersionId) return null;
  const corpus = await ctx.db.get(corpusVersionId);
  const validStatus = draft?.noveltyCorpusVersionId
    ? corpus?.status === "published" || corpus?.status === "superseded"
    : corpus?.status === "published";
  if (
    !corpus ||
    corpus.eventId !== event._id ||
    !validStatus ||
    corpus.importState !== "ready" ||
    !corpus.checksum ||
    corpus.entryCount < 1
  ) {
    return null;
  }
  return {
    corpusVersionId: corpus._id,
    corpusVersion: corpus.version,
    corpusLabel: corpus.label,
    comparedProjectCount: corpus.entryCount,
    minimumIdeaLength: corpus.minimumIdeaLength,
    debounceMs: corpus.debounceMs,
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
      teamId: v.id("teams"),
      teamVersion: v.number(),
      currentRole: v.union(v.literal("lead"), v.literal("member")),
      draft: v.union(v.null(), currentDraftView),
      application: v.union(
        v.null(),
        v.object({
          id: v.id("applications"),
          state: v.string(),
          version: v.number(),
          submittedAt: v.number(),
          humanDecision: v.optional(v.string()),
          humanReasonCode: v.optional(v.string()),
          informationRequest: v.union(
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
              version: v.number(),
            }),
          ),
          currentOffer: v.union(
            v.null(),
            v.object({
              id: v.id("admissionOffers"),
              state: v.string(),
              sentAt: v.number(),
              expiresAt: v.number(),
              version: v.number(),
            }),
          ),
        }),
      ),
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
        index
          .eq("eventId", event._id)
          .eq("membershipId", membership._id)
          .eq("status", "active"),
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
    const application = await ctx.db
      .query("applications")
      .withIndex("by_team", (index) => index.eq("teamId", team._id))
      .unique();
    const [currentOffer, informationRequest] = await Promise.all([
      application?.currentOfferId
        ? ctx.db.get(application.currentOfferId)
        : Promise.resolve(null),
      application?.currentInformationRequestId
        ? ctx.db.get(application.currentInformationRequestId)
        : Promise.resolve(null),
    ]);
    let visibleDraft: Infer<typeof currentDraftView> | null = null;
    if (draft) {
      const [pinnedCatalog, pinnedPolicy, followUps, novelty] = await Promise.all([
        requirePinnedTrackCatalog(ctx, draft),
        requirePinnedIntakePolicy(ctx, draft),
        loadCurrentIntakeResponses(ctx, draft._id),
        participantNoveltyConfig(ctx, event, draft),
      ]);
      visibleDraft = {
        id: draft._id,
        trackCatalogVersionId: draft.trackCatalogVersionId,
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
        tracks: pinnedCatalog.tracks.map((track) => ({
          id: track._id,
          stableKey: track.stableKey,
          slug: track.slug,
          displayName: track.displayName,
          description: track.description,
          examples: track.examples,
          displayOrder: track.displayOrder,
          type: track.type,
          ...(track.eligibilityText !== undefined
            ? { eligibilityText: track.eligibilityText }
            : {}),
        })),
        stage: draft.stage,
        ...(draft.initialIdea !== undefined ? { initialIdea: draft.initialIdea } : {}),
        ...(draft.chosenCoreTrackVersionId !== undefined
          ? { chosenCoreTrackVersionId: draft.chosenCoreTrackVersionId }
          : {}),
        chosenSponsorTrackVersionIds: draft.chosenSponsorTrackVersionIds,
        ...(draft.recommendedCoreTrackVersionId !== undefined
          ? { recommendedCoreTrackVersionId: draft.recommendedCoreTrackVersionId }
          : {}),
        ...(draft.recommendationReason !== undefined
          ? { recommendationReason: draft.recommendationReason }
          : {}),
        recommendationState: draft.recommendationState,
        novelty,
        noveltySignal:
          draft.initialIdea &&
          draft.noveltyEvaluatedInputFingerprint &&
          draft.noveltyScore !== undefined &&
          draft.noveltyBand &&
          draft.noveltyNearestThemeLabel &&
          draft.noveltyReflectionPrompt &&
          draft.noveltyEvaluatedAt !== undefined
            ? {
                score: draft.noveltyScore,
                band: draft.noveltyBand,
                nearestThemeLabel: draft.noveltyNearestThemeLabel,
                reflectionPrompt: draft.noveltyReflectionPrompt,
                evaluatedAt: draft.noveltyEvaluatedAt,
              }
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
        version: draft.version,
      };
    }
    return {
      teamId: team._id,
      teamVersion: team.version,
      currentRole: member.role,
      draft: visibleDraft,
      application: application
        ? {
            id: application._id,
            state: application.state,
            version: application.version,
            submittedAt: application.submittedAt,
            ...(application.humanDecision !== undefined
              ? { humanDecision: application.humanDecision }
              : {}),
            ...(application.humanReasonCode !== undefined
              ? { humanReasonCode: application.humanReasonCode }
              : {}),
            informationRequest:
              informationRequest &&
              informationRequest.eventId === event._id &&
              informationRequest.applicationId === application._id &&
              informationRequest.teamId === team._id
                ? {
                    id: informationRequest._id,
                    state: informationRequest.state,
                    questions: informationRequest.questions,
                    ...(informationRequest.answers !== undefined
                      ? { answers: informationRequest.answers }
                      : {}),
                    version: informationRequest.version,
                  }
                : null,
            currentOffer:
              currentOffer &&
              currentOffer.eventId === event._id &&
              currentOffer.applicationId === application._id &&
              currentOffer.teamId === team._id
                ? {
                    id: currentOffer._id,
                    state: currentOffer.state,
                    sentAt: currentOffer.sentAt,
                    expiresAt: currentOffer.expiresAt,
                    version: currentOffer.version,
                  }
                : null,
          }
        : null,
    };
  },
});

async function currentTeamContext(ctx: MutationCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const membership = await requireMembership(ctx, event._id, person._id);
  const member = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index
        .eq("eventId", event._id)
        .eq("membershipId", membership._id)
        .eq("status", "active"),
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

function requireEditableTeam(team: Doc<"teams">) {
  if (team.membershipLocked || team.trackLocked) {
    throw new ConvexError({
      code: "SUBMISSION_LOCKED",
      message: "This team has submitted and the project intake is locked.",
    });
  }
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

function sameTrackIds(
  left: readonly Id<"trackVersions">[],
  right: readonly Id<"trackVersions">[],
) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

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
      index
        .eq("draftId", args.draftId)
        .eq("promptKey", args.promptKey)
        .eq("status", "active"),
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

export const saveInitialIdea = mutation({
  args: {
    eventSlug: v.string(),
    idea: v.string(),
    noveltyCorpusVersionId: v.optional(v.id("noveltyCorpusVersions")),
    expectedDraftVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ draftId: v.id("projectDrafts"), draftVersion: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, membership, team, grantIds } = await currentTeamContext(
      ctx,
      args.eventSlug,
    );
    const requestFingerprint = operationFingerprint([
      team._id,
      args.expectedDraftVersion,
      args.idea,
      args.noveltyCorpusVersionId ?? null,
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
    requireRegistrationOpen(event);
    requireEditableTeam(team);
    const existing = await ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", team._id))
      .unique();
    requireDraftVersion(existing?.version ?? 0, args.expectedDraftVersion);
    const novelty = await participantNoveltyConfig(ctx, event, existing ?? undefined);
    if (novelty?.corpusVersionId !== args.noveltyCorpusVersionId) {
      throw new ConvexError({
        code: "NOVELTY_CORPUS_CHANGED",
        message: "The project comparison set changed. Refresh and submit the idea again.",
      });
    }
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
    if (
      existing?.initialIdea === idea &&
      existing.noveltyCorpusVersionId === novelty?.corpusVersionId
    ) {
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
    let draftId: Id<"projectDrafts">;
    if (existing) {
      await requirePinnedTrackCatalog(ctx, existing);
      await replaceCurrentIntakeQuestions(ctx, existing._id);
      await ctx.db.patch(existing._id, {
        stage: "track_selection",
        initialIdea: idea,
        noveltyCorpusVersionId: novelty?.corpusVersionId,
        noveltyEvaluatedInputFingerprint: undefined,
        noveltyScore: undefined,
        noveltyBand: undefined,
        noveltyNearestThemeLabel: undefined,
        noveltyReflectionPrompt: undefined,
        noveltyPreviewRequestId: undefined,
        noveltyEvaluatedAt: undefined,
        recommendedCoreTrackVersionId: undefined,
        recommendationReason: undefined,
        recommendationState: "pending",
        version: draftVersion,
        lastEditedByMembershipId: membership._id,
        updatedAt: now,
      });
      draftId = existing._id;
    } else {
      const trackCatalogVersionId = event.publishedTrackCatalogId;
      const trackCatalog = trackCatalogVersionId
        ? await ctx.db.get(trackCatalogVersionId)
        : null;
      if (
        !trackCatalogVersionId ||
        !trackCatalog ||
        trackCatalog.eventId !== event._id ||
        trackCatalog.status !== "published"
      ) {
        throw new ConvexError({
          code: "TRACK_CATALOG_UNAVAILABLE",
          message: "The event track catalog is unavailable. Try again after operations fixes it.",
        });
      }
      draftId = await ctx.db.insert("projectDrafts", {
        eventId: event._id,
        teamId: team._id,
        trackCatalogVersionId,
        intakePolicyVersionId: pinnedPolicy.policy._id,
        ...(novelty ? { noveltyCorpusVersionId: novelty.corpusVersionId } : {}),
        stage: "track_selection",
        initialIdea: idea,
        chosenSponsorTrackVersionIds: [],
        recommendationState: "pending",
        version: draftVersion,
        lastEditedByMembershipId: membership._id,
        updatedAt: now,
      });
    }

    await saveAnswerVersion(ctx, {
      eventId: event._id,
      teamId: team._id,
      draftId,
      membershipId: membership._id,
      promptKey: "initial_idea",
      value: idea,
      clientOperationId: args.clientOperationId,
    });

    await intakeWorkpool.enqueueAction(
      ctx,
      internal.intelligence.interpretIdea,
      { draftId },
      { retry: false },
    );
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
        stage: "track_selection",
        noveltyCorpusVersionId: novelty?.corpusVersionId ?? null,
      }),
      reason: "Team saved its initial project idea",
    });
    return { draftId, draftVersion };
  },
});

export const chooseTrack = mutation({
  args: {
    eventSlug: v.string(),
    trackVersionId: v.id("trackVersions"),
    expectedDraftVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ draftVersion: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, membership, team } = await currentTeamContext(ctx, args.eventSlug);
    const requestFingerprint = operationFingerprint([
      team._id,
      args.trackVersionId,
      args.expectedDraftVersion,
    ]);
    const replay = await replayDraftOperation(
      ctx,
      event._id,
      person._id,
      args.clientOperationId,
      "intake.track.choose",
      requestFingerprint,
    );
    if (replay) return { draftVersion: replay.version };
    requireRegistrationOpen(event);
    requireEditableTeam(team);
    const draft = await ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", team._id))
      .unique();
    if (!draft?.initialIdea) {
      throw new ConvexError({ code: "IDEA_REQUIRED", message: "Describe the project first." });
    }
    requireDraftVersion(draft.version, args.expectedDraftVersion);
    await requirePinnedTrackCatalog(ctx, draft);
    await requirePinnedIntakePolicy(ctx, draft);
    const track = await ctx.db.get(args.trackVersionId);
    if (
      !track ||
      track.eventId !== event._id ||
      track.catalogVersionId !== draft.trackCatalogVersionId ||
      track.type !== "core" ||
      track.status !== "published"
    ) {
      throw new ConvexError({ code: "TRACK_NOT_AVAILABLE", message: "That track is not available." });
    }
    const responses = await loadCurrentIntakeResponses(ctx, draft._id);
    const hasActiveQuestion = responses.some(({ question }) => question.state === "active");
    const stage = hasActiveQuestion
      ? "follow_up" as const
      : draft.stage === "review"
        ? "review" as const
        : draft.stage === "follow_up"
          ? "follow_up" as const
          : "track_selection" as const;
    const now = Date.now();
    const changed =
      draft.chosenCoreTrackVersionId !== track._id || draft.stage !== stage;
    const draftVersion = changed ? draft.version + 1 : draft.version;
    if (changed) {
      await ctx.db.patch(draft._id, {
        chosenCoreTrackVersionId: track._id,
        stage,
        version: draftVersion,
        lastEditedByMembershipId: membership._id,
        updatedAt: now,
      });
    }
    await recordDraftOperation(ctx, {
      eventId: event._id,
      personId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "intake.track.choose",
      requestFingerprint,
      draftId: draft._id,
      createdAt: now,
    });
    return { draftVersion };
  },
});

export const setSponsorTracks = mutation({
  args: {
    eventSlug: v.string(),
    sponsorTrackVersionIds: v.array(v.id("trackVersions")),
    expectedDraftVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ draftVersion: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, membership, team } = await currentTeamContext(ctx, args.eventSlug);
    const requestFingerprint = operationFingerprint([
      team._id,
      args.expectedDraftVersion,
      JSON.stringify([...args.sponsorTrackVersionIds].toSorted()),
    ]);
    const replay = await replayDraftOperation(
      ctx,
      event._id,
      person._id,
      args.clientOperationId,
      "intake.sponsor_tracks.set",
      requestFingerprint,
    );
    if (replay) return { draftVersion: replay.version };
    requireRegistrationOpen(event);
    requireEditableTeam(team);
    const draft = await ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", team._id))
      .unique();
    if (!draft?.initialIdea) {
      throw new ConvexError({ code: "IDEA_REQUIRED", message: "Describe the project first." });
    }
    requireDraftVersion(draft.version, args.expectedDraftVersion);
    const pinnedCatalog = await requirePinnedTrackCatalog(ctx, draft);
    const sponsorTracks = requireSponsorTrackSelection(
      pinnedCatalog.tracks,
      args.sponsorTrackVersionIds,
    );
    const sponsorTrackVersionIds = sponsorTracks.map((track) => track._id);
    const now = Date.now();
    const draftVersion = sameTrackIds(
      draft.chosenSponsorTrackVersionIds,
      sponsorTrackVersionIds,
    )
      ? draft.version
      : draft.version + 1;
    if (draftVersion !== draft.version) {
      await ctx.db.patch(draft._id, {
        chosenSponsorTrackVersionIds: sponsorTrackVersionIds,
        version: draftVersion,
        lastEditedByMembershipId: membership._id,
        updatedAt: now,
      });
    }
    await recordDraftOperation(ctx, {
      eventId: event._id,
      personId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "intake.sponsor_tracks.set",
      requestFingerprint,
      draftId: draft._id,
      createdAt: now,
    });
    return { draftVersion };
  },
});

export const respondToFollowUp = mutation({
  args: {
    eventSlug: v.string(),
    questionId: v.id("intakeGeneratedQuestions"),
    answer: v.optional(v.string()),
    skipped: v.boolean(),
    expectedDraftVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ draftVersion: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, membership, team } = await currentTeamContext(ctx, args.eventSlug);
    const requestFingerprint = operationFingerprint([
      team._id,
      args.questionId,
      args.expectedDraftVersion,
      args.answer ?? null,
      args.skipped,
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
    requireRegistrationOpen(event);
    requireEditableTeam(team);
    const draft = await ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", team._id))
      .unique();
    if (!draft?.chosenCoreTrackVersionId) {
      throw new ConvexError({
        code: "FOLLOW_UP_NOT_READY",
        message: "Choose a track before answering the follow-up.",
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
    if (args.skipped ? args.answer !== undefined : args.answer === undefined) {
      throw new ConvexError({
        code: "INVALID_FOLLOW_UP_RESPONSE",
        message: "Answer the question or skip it, but not both.",
      });
    }
    const { normalized: policy } = await requirePinnedIntakePolicy(ctx, draft);
    const responses = await loadCurrentIntakeResponses(ctx, draft._id);
    if (
      responses.some(
        ({ question: row }) =>
          row.ordinal < question.ordinal &&
          row.state !== "answered" &&
          row.state !== "skipped",
      )
    ) {
      throw new ConvexError({
        code: "FOLLOW_UP_OUT_OF_ORDER",
        message: "Complete the earlier follow-up first.",
      });
    }
    if (args.answer !== undefined) {
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
    }
    const draftVersion = draft.version + 1;
    const now = Date.now();
    await ctx.db.patch(question._id, {
      state: args.skipped ? "skipped" : "answered",
      answeredAt: now,
    });
    const needsAnotherInterpretation =
      question.ordinal < policy.maximumFollowUpCount &&
      (policy.model.mode === "assisted" ||
        question.ordinal < policy.deterministicFollowUpCount);
    await ctx.db.patch(draft._id, {
      stage: needsAnotherInterpretation ? "follow_up" : "review",
      version: draftVersion,
      lastEditedByMembershipId: membership._id,
      updatedAt: now,
    });
    if (needsAnotherInterpretation) {
      await intakeWorkpool.enqueueAction(
        ctx,
        internal.intelligence.interpretIdea,
        { draftId: draft._id },
        { retry: false },
      );
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
    answer: v.optional(v.string()),
    skipped: v.boolean(),
    expectedDraftVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ draftVersion: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, membership, team } = await currentTeamContext(ctx, args.eventSlug);
    const requestFingerprint = operationFingerprint([
      team._id,
      args.questionId,
      args.expectedDraftVersion,
      args.answer ?? null,
      args.skipped,
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
    requireRegistrationOpen(event);
    requireEditableTeam(team);
    const draft = await ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", team._id))
      .unique();
    if (!draft?.chosenCoreTrackVersionId || draft.stage !== "review") {
      throw new ConvexError({
        code: "FOLLOW_UP_NOT_EDITABLE",
        message: "Follow-up answers can be edited from the final review before submission.",
      });
    }
    requireDraftVersion(draft.version, args.expectedDraftVersion);
    if (args.skipped ? args.answer !== undefined : args.answer === undefined) {
      throw new ConvexError({
        code: "INVALID_FOLLOW_UP_RESPONSE",
        message: "Answer the question or skip it, but not both.",
      });
    }
    const responses = await loadCurrentIntakeResponses(ctx, draft._id);
    const response = responses.find(({ question }) => question._id === args.questionId);
    if (
      !response ||
      response.question.teamId !== team._id ||
      response.question.eventId !== event._id ||
      (response.question.state !== "answered" && response.question.state !== "skipped")
    ) {
      throw new ConvexError({
        code: "FOLLOW_UP_CHANGED",
        message: "That follow-up is no longer part of the current introduction.",
      });
    }
    const { normalized: policy } = await requirePinnedIntakePolicy(ctx, draft);
    const answer = args.answer === undefined
      ? null
      : normalizedLongText(
          args.answer,
          "Follow-up answer",
          policy.followUpAnswerMinLength,
          policy.followUpAnswerMaxLength,
        );
    const unchanged = args.skipped
      ? response.question.state === "skipped"
      : response.question.state === "answered" && response.answer?.value === answer;
    const now = Date.now();
    if (unchanged) {
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

    if (answer === null) {
      await deactivateCurrentQuestionAnswer(ctx, response.question._id);
    } else {
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
    }
    await ctx.db.patch(response.question._id, {
      state: args.skipped ? "skipped" : "answered",
      answeredAt: now,
    });
    await replaceIntakeQuestionsAfter(ctx, draft._id, response.question.ordinal);
    const needsAnotherInterpretation =
      response.question.ordinal < policy.maximumFollowUpCount &&
      (policy.model.mode === "assisted" ||
        response.question.ordinal < policy.deterministicFollowUpCount);
    const draftVersion = draft.version + 1;
    await ctx.db.patch(draft._id, {
      stage: needsAnotherInterpretation ? "follow_up" : "review",
      version: draftVersion,
      lastEditedByMembershipId: membership._id,
      updatedAt: now,
    });
    if (needsAnotherInterpretation) {
      await intakeWorkpool.enqueueAction(
        ctx,
        internal.intelligence.interpretIdea,
        { draftId: draft._id },
        { retry: false },
      );
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

export const setFreshnessAttestation = mutation({
  args: {
    eventSlug: v.string(),
    accepted: v.boolean(),
    expectedDraftVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ draftVersion: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, membership, team } = await currentTeamContext(ctx, args.eventSlug);
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
    requireRegistrationOpen(event);
    requireEditableTeam(team);
    const draft = await ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", team._id))
      .unique();
    if (!draft) throw new ConvexError({ code: "DRAFT_REQUIRED", message: "Start the project intake first." });
    requireDraftVersion(draft.version, args.expectedDraftVersion);
    const now = Date.now();
    const acceptedAt = args.accepted ? now : undefined;
    const draftVersion = draft.version + 1;
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

const previewMember = v.object({
  teamMemberId: v.id("teamMembers"),
  membershipId: v.id("eventMemberships"),
  displayName: v.string(),
  role: v.union(v.literal("lead"), v.literal("member")),
  profileComplete: v.boolean(),
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
      track: v.union(
        v.null(),
        v.object({ id: v.id("trackVersions"), name: v.string(), description: v.string() }),
      ),
      sponsorTracks: v.array(
        v.object({
          id: v.id("trackVersions"),
          name: v.string(),
          eligibilityText: v.string(),
        }),
      ),
      initialIdea: v.optional(v.string()),
      followUps: v.array(
        v.object({
          id: v.id("intakeGeneratedQuestions"),
          ordinal: v.number(),
          question: v.string(),
          purposeKey: v.string(),
          source: v.union(v.literal("model"), v.literal("fallback")),
          answer: v.optional(v.string()),
          skipped: v.boolean(),
        }),
      ),
      freshnessAttested: v.boolean(),
      members: v.array(previewMember),
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
        index
          .eq("eventId", event._id)
          .eq("membershipId", membership._id)
          .eq("status", "active"),
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
    const memberRows = await ctx.db
      .query("teamMembers")
      .withIndex("by_team_status", (index) => index.eq("teamId", team._id).eq("status", "active"))
      .collect();
    const memberEntries = await Promise.all(
      memberRows.map(async (teamMember) => {
        const eventMembership = await ctx.db.get(teamMember.membershipId);
        if (!eventMembership) throw new Error("Team member membership is missing.");
        const memberPerson = await ctx.db.get(eventMembership.personId);
        if (!memberPerson) throw new Error("Team member person is missing.");
        const profile = await ctx.db
          .query("participantProfiles")
          .withIndex("by_membership", (index) => index.eq("membershipId", teamMember.membershipId))
          .unique();
        return {
          teamMemberId: teamMember._id,
          membershipId: teamMember.membershipId,
          displayName: profile?.preferredName ?? profile?.fullName ?? memberPerson.displayName,
          role: teamMember.role,
          profileComplete: isProfileCompleteForPolicy(
            profile,
            eventMembership,
            participantPolicy.policy,
          ),
          participantClass: eventMembership.participantClass,
        };
      }),
    );
    const members = memberEntries.map((entry) => ({
      teamMemberId: entry.teamMemberId,
      membershipId: entry.membershipId,
      displayName: entry.displayName,
      role: entry.role,
      profileComplete: entry.profileComplete,
    }));
    const track = draft.chosenCoreTrackVersionId
      ? await ctx.db.get(draft.chosenCoreTrackVersionId)
      : null;
    const [pinnedCatalog, pinnedPolicy, followUps] = await Promise.all([
      requirePinnedTrackCatalog(ctx, draft),
      requirePinnedIntakePolicy(ctx, draft),
      loadCurrentIntakeResponses(ctx, draft._id),
    ]);
    const sponsorTracks = requireSponsorTrackSelection(
      pinnedCatalog.tracks,
      draft.chosenSponsorTrackVersionIds,
    );
    if (
      track &&
      (track.eventId !== event._id ||
        track.catalogVersionId !== draft.trackCatalogVersionId ||
        track.type !== "core" ||
        track.status !== "published")
    ) {
      throw new Error("The project draft's selected track is invalid.");
    }
    const blockers: string[] = [];
    if (memberRows.length < participantPolicy.normalized.teamMinimumSize) {
      blockers.push(`At least ${participantPolicy.normalized.teamMinimumSize} members are required.`);
    }
    if (memberRows.length > participantPolicy.normalized.teamMaximumSize) {
      blockers.push(`At most ${participantPolicy.normalized.teamMaximumSize} members are allowed.`);
    }
    if (
      !participantClassesMeetPolicy(
        memberEntries.map((entry) => entry.participantClass),
        participantPolicy.normalized,
      )
    ) {
      blockers.push("The current participant policy does not allow mixed VIT and external teams.");
    }
    if (members.some((entry) => !entry.profileComplete)) blockers.push("Every member must complete their profile.");
    if (!draft.initialIdea) blockers.push("The initial project idea is missing.");
    if (!draft.chosenCoreTrackVersionId) blockers.push("Choose one core track.");
    if (!intakeSequenceComplete(pinnedPolicy.normalized, followUps)) {
      blockers.push("Complete the project follow-ups.");
    }
    if (!draft.freshnessAttestedAt) blockers.push("Accept the fresh-project rule.");
    return {
      teamId: team._id,
      teamName: team.name,
      teamVersion: team.version,
      draftVersion: draft.version,
      track: track ? { id: track._id, name: track.displayName, description: track.description } : null,
      sponsorTracks: sponsorTracks.map((sponsorTrack) => ({
        id: sponsorTrack._id,
        name: sponsorTrack.displayName,
        eligibilityText: sponsorTrack.eligibilityText,
      })),
      ...(draft.initialIdea !== undefined ? { initialIdea: draft.initialIdea } : {}),
      followUps: followUps.map(({ question, answer }) => ({
        id: question._id,
        ordinal: question.ordinal,
        question: question.text,
        purposeKey: question.purposeKey,
        source: question.source,
        ...(answer ? { answer: answer.value } : {}),
        skipped: question.state === "skipped",
      })),
      freshnessAttested: Boolean(draft.freshnessAttestedAt),
      members,
      blockers,
      participantPolicyVersionId: participantPolicy.policy._id,
      warning: participantPolicy.normalized.finalSubmissionWarning,
    };
  },
});

function deriveExperienceBand(
  memberships: Doc<"eventMemberships">[],
  profiles: Doc<"participantProfiles">[],
) {
  if (memberships.some((membership) => membership.participantClass === "external_participant")) {
    return "mixed_or_external" as const;
  }
  const years = new Set(profiles.map((profile) => profile.yearOfStudy));
  if (years.has("postgraduate") || years.has("not_applicable")) {
    return "postgraduate_or_professional" as const;
  }
  if (years.size === 1 && years.has("first")) return "first_year" as const;
  if ([...years].every((year) => year === "first" || year === "second")) {
    return "early_year" as const;
  }
  if ([...years].every((year) => ["third", "fourth", "fifth_or_later"].includes(year))) {
    return "later_year" as const;
  }
  return "mixed_or_external" as const;
}

export const submit = mutation({
  args: {
    eventSlug: v.string(),
    expectedDraftVersion: v.number(),
    expectedTeamVersion: v.number(),
    expectedTrackVersionId: v.id("trackVersions"),
    expectedSponsorTrackVersionIds: v.array(v.id("trackVersions")),
    participantPolicyVersionId: v.id("participantPolicyVersions"),
    clientOperationId: v.string(),
  },
  returns: v.object({
    applicationId: v.id("applications"),
    projectVersionId: v.id("projectVersions"),
    submittedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.expectedDraftVersion,
      args.expectedTeamVersion,
      args.expectedTrackVersionId,
      JSON.stringify(args.expectedSponsorTrackVersionIds),
      args.participantPolicyVersionId,
    ]);
    const priorOperation = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "intake.submit",
      requestFingerprint,
    });
    if (priorOperation) {
      const applicationId = ctx.db.normalizeId("applications", priorOperation.targetId);
      if (!applicationId) throw new Error("Prior application result is invalid.");
      const application = await ctx.db.get(applicationId);
      if (!application) throw new Error("Prior application no longer resolves.");
      return {
        applicationId,
        projectVersionId: application.submittedProjectVersionId,
        submittedAt: application.submittedAt,
      };
    }

    requireRegistrationOpen(event);

    const participantPolicy = await loadPublishedParticipantPolicy(ctx, event);
    if (participantPolicy.policy._id !== args.participantPolicyVersionId) {
      throw new ConvexError({
        code: "PARTICIPANT_POLICY_CHANGED",
        message: "The participant policy changed. Review the team and submission warning again.",
      });
    }

    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    const member = await ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("membershipId", membership._id)
          .eq("status", "active"),
      )
      .unique();
    if (!member || member.role !== "lead") {
      throw new ConvexError({ code: "TEAM_LEAD_REQUIRED", message: "Only the team lead can submit." });
    }
    const team = await ctx.db.get(member.teamId);
    if (!team || team.membershipLocked || team.trackLocked) {
      throw new ConvexError({ code: "SUBMISSION_LOCKED", message: "This team is already locked." });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.members.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    if (team.version !== args.expectedTeamVersion) {
      throw new ConvexError({ code: "TEAM_CHANGED", message: "The team changed. Review it again." });
    }
    const draft = await ctx.db
      .query("projectDrafts")
      .withIndex("by_team", (index) => index.eq("teamId", team._id))
      .unique();
    if (
      !draft ||
      draft.version !== args.expectedDraftVersion ||
      draft.chosenCoreTrackVersionId !== args.expectedTrackVersionId ||
      !sameTrackIds(
        draft.chosenSponsorTrackVersionIds,
        args.expectedSponsorTrackVersionIds,
      )
    ) {
      throw new ConvexError({ code: "DRAFT_CHANGED", message: "The project changed. Review it again." });
    }
    if (
      !draft.initialIdea ||
      !draft.freshnessAttestedAt ||
      !draft.freshnessAttestedByMembershipId
    ) {
      throw new ConvexError({ code: "DRAFT_INCOMPLETE", message: "Complete every project step first." });
    }
    const track = await ctx.db.get(args.expectedTrackVersionId);
    const [pinnedCatalog, pinnedPolicy, intakeResponses] = await Promise.all([
      requirePinnedTrackCatalog(ctx, draft),
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
    const sponsorTracks = requireSponsorTrackSelection(
      pinnedCatalog.tracks,
      draft.chosenSponsorTrackVersionIds,
    );
    if (
      !track ||
      track.eventId !== event._id ||
      track.catalogVersionId !== draft.trackCatalogVersionId ||
      track.type !== "core" ||
      track.status !== "published"
    ) {
      throw new ConvexError({ code: "TRACK_NOT_AVAILABLE", message: "The selected track is unavailable." });
    }
    const activeMembers = await ctx.db
      .query("teamMembers")
      .withIndex("by_team_status", (index) => index.eq("teamId", team._id).eq("status", "active"))
      .collect();
    if (
      activeMembers.length < participantPolicy.normalized.teamMinimumSize ||
      activeMembers.length > participantPolicy.normalized.teamMaximumSize
    ) {
      throw new ConvexError({ code: "TEAM_SIZE", message: "The team does not meet the published size policy." });
    }
    const memberMemberships: Doc<"eventMemberships">[] = [];
    const profiles: Doc<"participantProfiles">[] = [];
    for (const activeMember of activeMembers) {
      const activeMembership = await ctx.db.get(activeMember.membershipId);
      if (!activeMembership || activeMembership.eligibilityStatus !== "eligible") {
        throw new ConvexError({ code: "MEMBER_NOT_ELIGIBLE", message: "Every member must be eligible." });
      }
      const profile = await ctx.db
        .query("participantProfiles")
        .withIndex("by_membership", (index) => index.eq("membershipId", activeMembership._id))
        .unique();
      if (!profile || !isProfileCompleteForPolicy(
        profile,
        activeMembership,
        participantPolicy.policy,
      )) {
        throw new ConvexError({ code: "PROFILE_INCOMPLETE", message: "Every member must finish their profile." });
      }
      memberMemberships.push(activeMembership);
      profiles.push(profile);
    }
    if (
      !participantClassesMeetPolicy(
        memberMemberships.map((activeMembership) => activeMembership.participantClass),
        participantPolicy.normalized,
      )
    ) {
      throw new ConvexError({
        code: "MIXED_TEAM_NOT_ALLOWED",
        message: "The current participant policy does not allow mixed VIT and external teams.",
      });
    }

    const admissionConfiguration = await loadPublishedAdmissionConfiguration(ctx, event);
    const admissionPolicy = admissionConfiguration.policy;
    const admissionModelConfig = admissionConfiguration.model;

    const now = Date.now();
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
      intakePolicyVersionId: pinnedPolicy.policy._id,
      intakeResponses: intakeResponses.map(({ question, answer }) => ({
        questionId: question._id,
        ordinal: question.ordinal,
        question: question.text,
        purposeKey: question.purposeKey,
        answerLength: question.answerLength,
        source: question.source,
        ...(answer ? { answer: answer.value } : {}),
        skipped: question.state === "skipped",
      })),
      coreTrackVersionId: track._id,
      sponsorTrackVersionIds: sponsorTracks.map((sponsorTrack) => sponsorTrack._id),
      lockedTeamMemberIds: activeMembers.map((activeMember) => activeMember._id),
      lockedLeadMembershipId: team.leadMembershipId,
      freshForEventAttestation: {
        participantPolicyVersionId: participantPolicy.policy._id,
        acceptedByMembershipId: draft.freshnessAttestedByMembershipId,
        acceptedAt: draft.freshnessAttestedAt,
      },
      finalConfirmation: {
        participantPolicyVersionId: participantPolicy.policy._id,
        previewedDraftVersion: args.expectedDraftVersion,
        previewedTeamVersion: args.expectedTeamVersion,
        previewedTrackVersionId: args.expectedTrackVersionId,
        previewedSponsorTrackVersionIds: sponsorTracks.map(
          (sponsorTrack) => sponsorTrack._id,
        ),
        confirmedByMembershipId: membership._id,
        confirmedAt: now,
      },
      participantPolicyVersionId: participantPolicy.policy._id,
      admissionPolicyVersionId: admissionPolicy._id,
      sourceDraftVersion: draft.version,
      submittedByMembershipId: membership._id,
      submittedAt: now,
    });
    const applicationId = await ctx.db.insert("applications", {
      eventId: event._id,
      teamId: team._id,
      submittedProjectVersionId: projectVersionId,
      admissionPolicyVersionId: admissionPolicy._id,
      state: "submitted",
      experienceBand: deriveExperienceBand(memberMemberships, profiles),
      ...(admissionModelConfig ? {} : { aiDisposition: "unavailable" }),
      assignedReviewCount: 0,
      completedReviewCount: 0,
      contentVersion: 1,
      version: 1,
      submittedAt: now,
    });
    const application = await ctx.db.get(applicationId);
    const projectVersion = await ctx.db.get(projectVersionId);
    if (!application || !projectVersion) {
      throw new Error("Submitted application context did not persist.");
    }
    await createAdmissionRecommendation(ctx, {
      application,
      project: projectVersion,
      policy: admissionPolicy,
      modelConfig: admissionModelConfig,
      now,
    });
    await ctx.db.patch(team._id, {
      status: "submitted",
      membershipLocked: true,
      trackLocked: true,
      lockedProjectVersionId: projectVersionId,
      lockedAt: now,
      lockParticipantPolicyVersionId: participantPolicy.policy._id,
      version: team.version + 1,
      updatedAt: now,
    });
    await ctx.db.patch(draft._id, {
      stage: "submitted",
      version: draft.version + 1,
      updatedAt: now,
    });
    for (const activeMembership of memberMemberships) {
      await ctx.db.patch(activeMembership._id, { onboardingStatus: "submitted", updatedAt: now });
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "intake.submit",
      requestFingerprint,
      targetType: "application",
      targetId: applicationId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "team.members.manage",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "application.submitted_and_team_locked",
      targetType: "application",
      targetId: applicationId,
      previousSummary: JSON.stringify({ teamVersion: team.version, draftVersion: draft.version }),
      nextSummary: JSON.stringify({
        projectVersionId,
        memberCount: activeMembers.length,
        trackVersionId: track._id,
        sponsorTrackVersionIds: sponsorTracks.map((sponsorTrack) => sponsorTrack._id),
        lockedAt: now,
      }),
      reason: "Team lead explicitly confirmed final submission",
    });

    return { applicationId, projectVersionId, submittedAt: now };
  },
});
