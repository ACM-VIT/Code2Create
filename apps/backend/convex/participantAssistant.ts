import {
  listUIMessages,
  saveMessage,
  syncStreams,
  vStreamArgs,
  createThread,
} from "@convex-dev/agent";
import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { applicationsCloseAtFor, requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { requirePublishedIntakePolicy } from "./lib/intakePolicy";
import {
  participantAssistantInstructions,
  participantAssistantPhaseDescription,
  participantAssistantPhaseForEvent,
  participantAssistantPhaseLabel,
  participantAssistantSuggestions,
} from "./lib/participantAssistant";
import { loadPublishedParticipantPolicy } from "./lib/participantPolicy";
import { loadPublishedPhaseSchedule } from "./lib/phaseSchedule";
import { loadPublishedProjectCheckpointPlan } from "./lib/projectCheckpointPlan";
import { acceptedTeamCommunicationsForTeam } from "./participantCommunications";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { normalizedLongText, normalizedText } from "./lib/strings";
import {
  participantAssistantPhase,
  participantAssistantRequestState,
  supportCaseCategory,
  supportCaseState,
  type ParticipantAssistantPhase,
} from "./values";
import {
  appendParticipantAssistantGuideReply,
  appendParticipantAssistantSupportMessage,
  openParticipantAssistantSupportCase,
} from "./support";

type ReadCtx = QueryCtx | MutationCtx;

const assistantFailureMessage =
  "I couldn’t finish that answer. Please try again, or ask me to bring in the event team.";

const assistantPhaseView = v.object({
  key: participantAssistantPhase,
  label: v.string(),
  description: v.string(),
  deadline: v.optional(v.number()),
});

const assistantRequestView = v.object({
  state: participantAssistantRequestState,
  failureMessage: v.optional(v.string()),
  createdAt: v.number(),
  completedAt: v.optional(v.number()),
});

const assistantLinkView = v.object({
  label: v.string(),
  href: v.string(),
});

const humanSupportMessageView = v.object({
  id: v.id("supportCaseActions"),
  body: v.string(),
  createdAt: v.number(),
});

const humanSupportView = v.object({
  state: supportCaseState,
  joinedAt: v.number(),
  messages: v.array(humanSupportMessageView),
});

const assistantConversationStateView = v.object({
  phase: assistantPhaseView,
  suggestions: v.array(v.string()),
  officialLinks: v.array(assistantLinkView),
  latestRequest: v.union(v.null(), assistantRequestView),
  humanSupport: v.union(v.null(), humanSupportView),
  humanSupportAvailable: v.boolean(),
});

const assistantRateLimiter = new RateLimiter(components.participantAssistantRateLimiter, {
  participantMessages: {
    kind: "token bucket",
    rate: 12,
    period: MINUTE,
    capacity: 4,
  },
  eventMessages: {
    kind: "token bucket",
    rate: 600,
    period: MINUTE,
    capacity: 40,
    shards: 10,
  },
});

function phaseView(phase: ParticipantAssistantPhase, deadline: number | undefined) {
  return {
    key: phase,
    label: participantAssistantPhaseLabel(phase),
    description: participantAssistantPhaseDescription(phase),
    ...(deadline === undefined ? {} : { deadline }),
  };
}

async function requireAssistantAccess(ctx: ReadCtx, eventId: Id<"events">, personId: Id<"people">) {
  const subject = await requireEventSubject(ctx, eventId, personId);
  await requirePermission(ctx, {
    eventId,
    eventAccessSubjectId: subject._id,
    permissionKey: "support.case.read",
    scopeType: "self",
    scopeId: subject._id,
  });
  return subject;
}

async function requireOwnedThread(
  ctx: ReadCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
  threadId: string,
) {
  const thread = await ctx.db
    .query("participantAssistantThreads")
    .withIndex("by_threadId", (index) => index.eq("threadId", threadId))
    .unique();
  if (!thread || thread.eventId !== eventId || thread.personId !== personId) {
    throw new ConvexError({
      code: "ASSISTANT_CONVERSATION_NOT_FOUND",
      message: "This conversation is no longer available. Refresh Help to start again.",
    });
  }
  return thread;
}

async function latestRequest(ctx: ReadCtx, threadId: string) {
  return ctx.db
    .query("participantAssistantRequests")
    .withIndex("by_threadId_and_updatedAt", (index) => index.eq("threadId", threadId))
    .order("desc")
    .first();
}

async function assistantHumanSupport(
  ctx: ReadCtx,
  conversation: Doc<"participantAssistantThreads">,
) {
  if (conversation.supportCaseId === undefined) return null;
  const supportCase = await ctx.db.get(conversation.supportCaseId);
  if (
    supportCase === null ||
    supportCase.eventId !== conversation.eventId ||
    supportCase.reporterPersonId !== conversation.personId
  ) {
    throw new Error("The Guide conversation has an invalid human support link.");
  }
  const actions = await ctx.db
    .query("supportCaseActions")
    .withIndex("by_case_time", (index) => index.eq("supportCaseId", supportCase._id))
    .order("desc")
    .take(100);
  return {
    state: supportCase.state,
    joinedAt: conversation.escalatedAt ?? supportCase.createdAt,
    messages: actions
      .filter((action) => action.kind === "public_note" && action.body !== undefined)
      .reverse()
      .map((action) => ({
        id: action._id,
        body: action.body ?? "",
        createdAt: action.createdAt,
      })),
  };
}

async function humanSupportIsAvailable(
  ctx: ReadCtx,
  eventId: Id<"events">,
  subjectId: Id<"eventAccessSubjects">,
  conversation: Doc<"participantAssistantThreads">,
) {
  const permissionKey =
    conversation.supportCaseId === undefined ? "support.case.create" : "support.case.reply";
  const grantIds = await matchingPermissionGrantIds(ctx, {
    eventId,
    eventAccessSubjectId: subjectId,
    permissionKey,
    scopeType: "self",
    scopeId: subjectId,
  });
  return grantIds.length > 0;
}

function requestView(request: Doc<"participantAssistantRequests"> | null) {
  return request === null
    ? null
    : {
        state: request.state,
        ...(request.failureMessage === undefined ? {} : { failureMessage: request.failureMessage }),
        createdAt: request.createdAt,
        ...(request.completedAt === undefined ? {} : { completedAt: request.completedAt }),
      };
}

export const openConversation = mutation({
  args: { eventSlug: v.string() },
  returns: v.object({
    threadId: v.string(),
    phase: assistantPhaseView,
    suggestions: v.array(v.string()),
    officialLinks: v.array(assistantLinkView),
    latestRequest: v.union(v.null(), assistantRequestView),
    humanSupport: v.union(v.null(), humanSupportView),
    humanSupportAvailable: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireAssistantAccess(ctx, event._id, person._id);

    const membership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    const now = Date.now();
    let conversation = await ctx.db
      .query("participantAssistantThreads")
      .withIndex("by_eventId_and_personId", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (conversation === null) {
      const threadId = await createThread(ctx, components.agent, {
        userId: person._id,
        title: `${event.name} participant help`,
      });
      const conversationId = await ctx.db.insert("participantAssistantThreads", {
        eventId: event._id,
        personId: person._id,
        threadId,
        createdAt: now,
        updatedAt: now,
      });
      conversation = await ctx.db.get(conversationId);
      if (conversation === null) {
        throw new Error("The participant assistant conversation did not persist.");
      }
    }

    const phase = participantAssistantPhaseForEvent(event);
    return {
      threadId: conversation.threadId,
      phase: phaseView(phase, assistantDeadline(event, membership, phase)),
      suggestions: participantAssistantSuggestions(phase),
      officialLinks: await assistantOfficialLinks(ctx, event, membership, phase),
      latestRequest: requestView(await latestRequest(ctx, conversation.threadId)),
      humanSupport: await assistantHumanSupport(ctx, conversation),
      humanSupportAvailable: await humanSupportIsAvailable(
        ctx,
        event._id,
        subject._id,
        conversation,
      ),
    };
  },
});

export const conversationState = query({
  args: { eventSlug: v.string(), threadId: v.string() },
  returns: assistantConversationStateView,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireAssistantAccess(ctx, event._id, person._id);
    const conversation = await requireOwnedThread(ctx, event._id, person._id, args.threadId);
    const membership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    const phase = participantAssistantPhaseForEvent(event);
    return {
      phase: phaseView(phase, assistantDeadline(event, membership, phase)),
      suggestions: participantAssistantSuggestions(phase),
      officialLinks: await assistantOfficialLinks(ctx, event, membership, phase),
      latestRequest: requestView(await latestRequest(ctx, args.threadId)),
      humanSupport: await assistantHumanSupport(ctx, conversation),
      humanSupportAvailable: await humanSupportIsAvailable(
        ctx,
        event._id,
        subject._id,
        conversation,
      ),
    };
  },
});

function assistantDeadline(
  event: Doc<"events">,
  membership: Doc<"eventMemberships"> | null,
  phase: ParticipantAssistantPhase,
) {
  if (phase === "in_event") return event.endsAt;
  return membership === null
    ? event.applicationsCloseAt
    : applicationsCloseAtFor(event, membership.participantClass);
}

async function assistantOfficialLinks(
  ctx: ReadCtx,
  event: Doc<"events">,
  membership: Doc<"eventMemberships"> | null,
  phase: ParticipantAssistantPhase,
) {
  if (phase === "idea_submission" || membership === null) return [];
  const member = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index.eq("eventId", event._id).eq("membershipId", membership._id).eq("status", "active"),
    )
    .unique();
  if (member === null) return [];
  const team = await ctx.db.get(member.teamId);
  if (team === null || team.eventId !== event._id) return [];
  const subject = await requireEventSubject(ctx, event._id, membership.personId);
  const canReadTeam = await hasTeamPermission(ctx, event._id, subject._id, team._id, "team.read");
  if (!canReadTeam) return [];
  const communications = await acceptedTeamCommunicationsForTeam(ctx, event, team._id);
  if (communications === null) return [];
  const links = [
    ...(communications.venueMapUrl === undefined
      ? []
      : [{ label: "Venue map", href: communications.venueMapUrl }]),
    { label: communications.discordLabel, href: communications.discordUrl },
    ...communications.nextSteps.flatMap((step) =>
      step.actionUrl === undefined ? [] : [{ label: step.title, href: step.actionUrl }],
    ),
  ];
  return links.filter(
    (link, index) => links.findIndex((candidate) => candidate.href === link.href) === index,
  );
}

export const listMessages = query({
  args: {
    eventSlug: v.string(),
    threadId: v.string(),
    paginationOpts: paginationOptsValidator,
    streamArgs: vStreamArgs,
  },
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    await requireAssistantAccess(ctx, event._id, person._id);
    await requireOwnedThread(ctx, event._id, person._id, args.threadId);
    const messages = await listUIMessages(ctx, components.agent, args);
    const streams = await syncStreams(ctx, components.agent, args);
    return { ...messages, streams };
  },
});

export const sendMessage = mutation({
  args: {
    eventSlug: v.string(),
    threadId: v.string(),
    message: v.string(),
    clientRequestId: v.string(),
  },
  returns: v.object({
    accepted: v.boolean(),
    requestId: v.id("participantAssistantRequests"),
    state: participantAssistantRequestState,
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireAssistantAccess(ctx, event._id, person._id);
    const conversation = await requireOwnedThread(ctx, event._id, person._id, args.threadId);
    const message = normalizedLongText(args.message, "Question", 2, 1_600);
    const clientRequestId = normalizedText(args.clientRequestId, "Request ID", 8, 100);
    const prior = await ctx.db
      .query("participantAssistantRequests")
      .withIndex("by_threadId_and_clientRequestId", (index) =>
        index.eq("threadId", conversation.threadId).eq("clientRequestId", clientRequestId),
      )
      .unique();
    if (prior !== null) {
      return { accepted: false, requestId: prior._id, state: prior.state };
    }

    const [scheduled, running] = await Promise.all([
      ctx.db
        .query("participantAssistantRequests")
        .withIndex("by_threadId_and_state_and_updatedAt", (index) =>
          index.eq("threadId", conversation.threadId).eq("state", "scheduled"),
        )
        .order("desc")
        .first(),
      ctx.db
        .query("participantAssistantRequests")
        .withIndex("by_threadId_and_state_and_updatedAt", (index) =>
          index.eq("threadId", conversation.threadId).eq("state", "running"),
        )
        .order("desc")
        .first(),
    ]);
    if (scheduled !== null || running !== null) {
      throw new ConvexError({
        code: "ASSISTANT_BUSY",
        message:
          "I’m still answering your last question. You can send another as soon as it appears.",
      });
    }

    const participantLimit = await assistantRateLimiter.limit(ctx, "participantMessages", {
      key: `${event._id}:${person._id}`,
    });
    if (!participantLimit.ok) {
      throw new ConvexError({
        code: "ASSISTANT_RATE_LIMITED",
        message: "Give me a short moment, then try your question again.",
      });
    }
    const eventLimit = await assistantRateLimiter.limit(ctx, "eventMessages", {
      key: event._id,
    });
    if (!eventLimit.ok) {
      throw new ConvexError({
        code: "ASSISTANT_AT_CAPACITY",
        message:
          "A lot of teams are asking for help right now. Try again in a moment, or ask me to bring in the event team.",
      });
    }

    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId: conversation.threadId,
      userId: person._id,
      prompt: message,
    });
    const now = Date.now();
    const canContinueHumanSupport = await humanSupportIsAvailable(
      ctx,
      event._id,
      subject._id,
      conversation,
    );
    if (conversation.supportCaseId !== undefined && canContinueHumanSupport) {
      await appendParticipantAssistantSupportMessage(ctx, {
        eventId: event._id,
        personId: person._id,
        supportCaseId: conversation.supportCaseId,
        message,
        now,
      });
    }
    const requestId = await ctx.db.insert("participantAssistantRequests", {
      eventId: event._id,
      personId: person._id,
      threadId: conversation.threadId,
      clientRequestId,
      promptMessageId: messageId,
      phaseAtRequest: participantAssistantPhaseForEvent(event),
      state: "scheduled",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(conversation._id, { updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.participantAssistantActions.generateReply, {
      requestId,
    });
    await ctx.scheduler.runAfter(90_000, internal.participantAssistant.expireGeneration, {
      requestId,
    });
    return { accepted: true, requestId, state: "scheduled" as const };
  },
});

const generationStart = v.object({
  requestId: v.id("participantAssistantRequests"),
  eventId: v.id("events"),
  personId: v.id("people"),
  threadId: v.string(),
  promptMessageId: v.string(),
});

export const beginGeneration = internalMutation({
  args: { requestId: v.id("participantAssistantRequests") },
  returns: v.union(v.null(), generationStart),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (request === null || request.state !== "scheduled") return null;
    await ctx.db.patch(request._id, { state: "running", updatedAt: Date.now() });
    return {
      requestId: request._id,
      eventId: request.eventId,
      personId: request.personId,
      threadId: request.threadId,
      promptMessageId: request.promptMessageId,
    };
  },
});

export const expireGeneration = internalMutation({
  args: { requestId: v.id("participantAssistantRequests") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (request === null || (request.state !== "scheduled" && request.state !== "running")) {
      return false;
    }
    const now = Date.now();
    await ctx.db.patch(request._id, {
      state: "failed",
      failureMessage: assistantFailureMessage,
      updatedAt: now,
      completedAt: now,
    });
    return true;
  },
});

export const generationInstructions = internalQuery({
  args: {
    requestId: v.id("participantAssistantRequests"),
    generatedAt: v.number(),
  },
  returns: v.union(
    v.null(),
    v.object({
      phase: participantAssistantPhase,
      instructions: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (request === null || request.state !== "running") return null;
    const [event, person, conversation] = await Promise.all([
      ctx.db.get(request.eventId),
      ctx.db.get(request.personId),
      ctx.db
        .query("participantAssistantThreads")
        .withIndex("by_threadId", (index) => index.eq("threadId", request.threadId))
        .unique(),
    ]);
    if (
      event === null ||
      person === null ||
      conversation === null ||
      conversation.eventId !== event._id ||
      conversation.personId !== person._id
    ) {
      return null;
    }

    const phase = participantAssistantPhaseForEvent(event);
    const eventContext = await buildEventContext(
      ctx,
      event,
      person,
      phase,
      args.generatedAt,
      conversation.supportCaseId,
    );
    return {
      phase,
      instructions: participantAssistantInstructions(phase, JSON.stringify(eventContext)),
    };
  },
});

export const finishGeneration = internalMutation({
  args: {
    requestId: v.id("participantAssistantRequests"),
    state: v.union(v.literal("completed"), v.literal("failed")),
    failureMessage: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (request === null || request.state !== "running") return false;
    const now = Date.now();
    await ctx.db.patch(request._id, {
      state: args.state,
      ...(args.failureMessage === undefined
        ? { failureMessage: undefined }
        : { failureMessage: args.failureMessage }),
      updatedAt: now,
      completedAt: now,
    });
    return true;
  },
});

export const escalationTranscript = internalQuery({
  args: { threadId: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db
      .query("participantAssistantThreads")
      .withIndex("by_threadId", (index) => index.eq("threadId", args.threadId))
      .unique();
    if (conversation === null) {
      throw new Error("The Guide conversation is unavailable.");
    }
    const result = await listUIMessages(ctx, components.agent, {
      threadId: args.threadId,
      paginationOpts: { cursor: null, numItems: 100 },
    });
    const transcript = result.page
      .filter(
        (message) =>
          (message.role === "user" || message.role === "assistant") &&
          message.text.trim().length > 0,
      )
      .sort((left, right) => left._creationTime - right._creationTime)
      .map((message) => {
        const speaker = message.role === "user" ? "Participant" : "Guide";
        return `${speaker}: ${message.text.trim()}`;
      })
      .join("\n\n");
    if (transcript.length <= 16_000) return transcript;
    return `[Earlier messages omitted only for length]\n\n${transcript.slice(-15_950)}`;
  },
});

export const escalateToHuman = internalMutation({
  args: {
    threadId: v.string(),
    category: supportCaseCategory,
    summary: v.string(),
    transcript: v.string(),
  },
  returns: v.object({
    status: v.union(v.literal("joined"), v.literal("already_joined")),
    state: supportCaseState,
  }),
  handler: async (ctx, args) => {
    const conversation = await ctx.db
      .query("participantAssistantThreads")
      .withIndex("by_threadId", (index) => index.eq("threadId", args.threadId))
      .unique();
    if (conversation === null) {
      throw new Error("The Guide conversation is unavailable.");
    }
    if (conversation.supportCaseId !== undefined) {
      const existing = await ctx.db.get(conversation.supportCaseId);
      if (
        existing === null ||
        existing.eventId !== conversation.eventId ||
        existing.reporterPersonId !== conversation.personId
      ) {
        throw new Error("The human support conversation is unavailable.");
      }
      return { status: "already_joined" as const, state: existing.state };
    }

    const now = Date.now();
    const supportCase = await openParticipantAssistantSupportCase(ctx, {
      eventId: conversation.eventId,
      personId: conversation.personId,
      category: args.category,
      summary: args.summary,
      transcript: args.transcript,
      now,
    });
    await ctx.db.patch(conversation._id, {
      supportCaseId: supportCase.id,
      escalatedAt: now,
      updatedAt: now,
    });
    return { status: "joined" as const, state: "open" as const };
  },
});

export const recordGuideReplyForHuman = internalMutation({
  args: {
    requestId: v.id("participantAssistantRequests"),
    message: v.string(),
    createdAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (request === null) return false;
    const conversation = await ctx.db
      .query("participantAssistantThreads")
      .withIndex("by_threadId", (index) => index.eq("threadId", request.threadId))
      .unique();
    if (conversation?.supportCaseId === undefined) return false;
    await appendParticipantAssistantGuideReply(ctx, {
      eventId: request.eventId,
      personId: request.personId,
      supportCaseId: conversation.supportCaseId,
      message: args.message,
      now: args.createdAt,
    });
    return true;
  },
});

async function hasTeamPermission(
  ctx: ReadCtx,
  eventId: Id<"events">,
  subjectId: Id<"eventAccessSubjects">,
  teamId: Id<"teams">,
  permissionKey: "team.read" | "project.checkpoint.read" | "integration.read",
) {
  const grantIds = await matchingPermissionGrantIds(ctx, {
    eventId,
    eventAccessSubjectId: subjectId,
    permissionKey,
    scopeType: "team",
    scopeId: teamId,
  });
  return grantIds.length > 0;
}

async function buildEventContext(
  ctx: QueryCtx,
  event: Doc<"events">,
  person: Doc<"people">,
  phase: ParticipantAssistantPhase,
  generatedAt: number,
  supportCaseId: Id<"supportCases"> | undefined,
) {
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const [membership, participantPolicy, intakePolicy] = await Promise.all([
    ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique(),
    loadPublishedParticipantPolicy(ctx, event),
    requirePublishedIntakePolicy(ctx, event),
  ]);

  const activeMember =
    membership === null
      ? null
      : await ctx.db
          .query("teamMembers")
          .withIndex("by_event_membership_status", (index) =>
            index
              .eq("eventId", event._id)
              .eq("membershipId", membership._id)
              .eq("status", "active"),
          )
          .unique();
  const rawTeam = activeMember === null ? null : await ctx.db.get(activeMember.teamId);
  const team = rawTeam !== null && rawTeam.eventId === event._id ? rawTeam : null;
  const canReadTeam =
    team === null
      ? false
      : await hasTeamPermission(ctx, event._id, subject._id, team._id, "team.read");
  const visibleTeam = canReadTeam ? team : null;
  const teamRoster =
    visibleTeam === null ? [] : await teamRosterContext(ctx, event._id, visibleTeam._id);
  const draft =
    visibleTeam === null
      ? null
      : await ctx.db
          .query("projectDrafts")
          .withIndex("by_team", (index) => index.eq("teamId", visibleTeam._id))
          .unique();
  const application =
    visibleTeam === null
      ? null
      : await ctx.db
          .query("applications")
          .withIndex("by_team", (index) => index.eq("teamId", visibleTeam._id))
          .unique();
  const questions =
    draft === null
      ? []
      : await ctx.db
          .query("intakeGeneratedQuestions")
          .withIndex("by_draft_ordinal", (index) => index.eq("draftId", draft._id))
          .take(12);
  const followUps = await Promise.all(
    questions.map(async (question) => {
      const answer = await ctx.db
        .query("intakeAnswerVersions")
        .withIndex("by_generated_question_status", (index) =>
          index.eq("generatedQuestionId", question._id).eq("status", "active"),
        )
        .unique();
      return {
        question: question.text,
        status: question.state,
        answer: answer?.value ?? null,
      };
    }),
  );
  const linkedSupportCase = supportCaseId === undefined ? null : await ctx.db.get(supportCaseId);
  if (supportCaseId !== undefined && linkedSupportCase === null) {
    throw new Error("The Guide conversation has a missing human support link.");
  }
  if (
    linkedSupportCase !== null &&
    (linkedSupportCase.eventId !== event._id || linkedSupportCase.reporterPersonId !== person._id)
  ) {
    throw new Error("The Guide conversation has an invalid human support link.");
  }
  const humanReplies =
    linkedSupportCase === null
      ? []
      : (
          await ctx.db
            .query("supportCaseActions")
            .withIndex("by_case_time", (index) => index.eq("supportCaseId", linkedSupportCase._id))
            .order("desc")
            .take(40)
        )
          .filter((action) => action.kind === "public_note" && action.body !== undefined)
          .reverse()
          .map((action) => ({
            message: action.body ?? "",
            sentAt: formatEventTime(action.createdAt, event.timezone),
          }));
  const humanSupportGrantIds = await matchingPermissionGrantIds(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: linkedSupportCase === null ? "support.case.create" : "support.case.reply",
    scopeType: "self",
    scopeId: subject._id,
  });
  const commonContext = {
    createdAt: formatEventTime(generatedAt, event.timezone),
    currentHelpScope: participantAssistantPhaseLabel(phase),
    event: {
      name: event.name,
      status: event.status,
      timezone: event.timezone,
      ideaSubmissionDeadline:
        membership === null
          ? formatEventTime(event.applicationsCloseAt, event.timezone)
          : formatEventTime(
              applicationsCloseAtFor(event, membership.participantClass),
              event.timezone,
            ),
      teamSize: {
        minimum: participantPolicy.normalized.teamMinimumSize,
        maximum: participantPolicy.normalized.teamMaximumSize,
      },
    },
    participant: {
      name: person.displayName,
      membership:
        membership === null
          ? null
          : {
              participantClass: membership.participantClass,
              eligibilityStatus: membership.eligibilityStatus,
              onboardingStatus: membership.onboardingStatus,
            },
    },
    ideaSubmission: {
      welcome: intakePolicy.normalized.openingText,
      prompt: intakePolicy.normalized.initialPrompt,
      help: intakePolicy.normalized.initialHelpText,
      ideaLength: {
        minimum: intakePolicy.normalized.initialIdeaMinLength,
        maximum: intakePolicy.normalized.initialIdeaMaxLength,
      },
      answerLength: {
        minimum: intakePolicy.normalized.followUpAnswerMinLength,
        maximum: intakePolicy.normalized.followUpAnswerMaxLength,
      },
      team:
        visibleTeam === null
          ? null
          : {
              name: visibleTeam.name,
              status: visibleTeam.status,
              memberCount: visibleTeam.activeMemberCount,
              joinCode: visibleTeam.publicCode,
              membershipLocked: visibleTeam.membershipLocked,
              yourRole: activeMember?.role ?? null,
              members: teamRoster,
              proposal:
                draft === null
                  ? null
                  : {
                      stage: draft.stage,
                      idea: draft.initialIdea ?? null,
                      additionalInformation: draft.additionalInformation ?? null,
                      freshnessConfirmed: draft.freshnessAttestedAt !== undefined,
                      followUps,
                    },
              application:
                application === null
                  ? null
                  : {
                      state: application.state,
                      submittedAt: formatEventTime(application.submittedAt, event.timezone),
                    },
            },
    },
    humanSupport: {
      available: humanSupportGrantIds.length > 0,
      joined:
        linkedSupportCase === null
          ? null
          : {
              status: linkedSupportCase.state,
              lastUpdated: formatEventTime(linkedSupportCase.updatedAt, event.timezone),
              repliesFromEventTeam: humanReplies,
            },
    },
  };

  if (phase === "idea_submission") return commonContext;

  const liveContext = await buildLiveEventContext(ctx, event, membership, visibleTeam, subject._id);
  return { ...commonContext, duringTheEvent: liveContext };
}

async function buildLiveEventContext(
  ctx: QueryCtx,
  event: Doc<"events">,
  membership: Doc<"eventMemberships"> | null,
  team: Doc<"teams"> | null,
  subjectId: Id<"eventAccessSubjects">,
) {
  const phaseSchedule = await loadPublishedPhaseSchedule(ctx, event);
  const communications =
    team === null ? null : await acceptedTeamCommunicationsForTeam(ctx, event, team._id);
  const schedule =
    phaseSchedule?.windows.map((window) => ({
      name: window.displayName,
      description: window.description,
      startsAt: formatEventTime(window.startsAt, event.timezone),
      endsAt: formatEventTime(window.endsAt, event.timezone),
    })) ?? [];
  if (team === null) {
    return {
      eventDetails: null,
      schedule,
      checkpoints: [],
      integrations: null,
      attendance: null,
    };
  }

  const [canReadCheckpoints, canReadIntegrations] = await Promise.all([
    hasTeamPermission(ctx, event._id, subjectId, team._id, "project.checkpoint.read"),
    hasTeamPermission(ctx, event._id, subjectId, team._id, "integration.read"),
  ]);
  const attendanceGrantIds =
    membership === null
      ? []
      : await matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subjectId,
          permissionKey: "attendance.self.read",
          scopeType: "self",
          scopeId: membership._id,
        });

  const checkpoints = canReadCheckpoints ? await checkpointContext(ctx, event, team._id) : [];
  const integrations = canReadIntegrations ? await integrationContext(ctx, team._id) : null;
  const attendance =
    membership !== null && attendanceGrantIds.length > 0
      ? await attendanceContext(ctx, event, membership._id)
      : null;
  const eventDetails =
    communications === null
      ? null
      : {
          venueName: communications.venueName,
          venueAddress: communications.venueAddress ?? null,
          startsAt: formatEventTime(communications.startsAt, event.timezone),
          endsAt: formatEventTime(communications.endsAt, event.timezone),
          nextSteps: communications.nextSteps.map((step) => ({
            title: step.title,
            detail: step.detail,
            dueAt: step.dueAt === undefined ? null : formatEventTime(step.dueAt, event.timezone),
            actionUrl: step.actionUrl ?? null,
          })),
          officialLinks: [
            ...(communications.venueMapUrl === undefined
              ? []
              : [{ label: "Venue map", href: communications.venueMapUrl }]),
            {
              label: communications.discordLabel,
              href: communications.discordUrl,
            },
          ],
        };
  return {
    eventDetails,
    schedule,
    checkpoints,
    integrations,
    attendance,
  };
}

async function teamRosterContext(ctx: QueryCtx, eventId: Id<"events">, teamId: Id<"teams">) {
  const members = await ctx.db
    .query("teamMembers")
    .withIndex("by_team_status", (index) => index.eq("teamId", teamId).eq("status", "active"))
    .take(50);
  return Promise.all(
    members.map(async (member) => {
      const membership = await ctx.db.get(member.membershipId);
      if (membership === null || membership.eventId !== eventId) {
        throw new Error("A visible team member belongs to an invalid event.");
      }
      const [memberPerson, profile] = await Promise.all([
        ctx.db.get(membership.personId),
        ctx.db
          .query("participantProfiles")
          .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
          .unique(),
      ]);
      if (memberPerson === null) {
        throw new Error("A visible team member does not have a person record.");
      }
      return {
        name: profile?.fullName ?? memberPerson.displayName,
        role: member.role,
        participantClass: membership.participantClass,
      };
    }),
  );
}

async function checkpointContext(ctx: QueryCtx, event: Doc<"events">, teamId: Id<"teams">) {
  const plan = await loadPublishedProjectCheckpointPlan(ctx, event);
  if (plan === null) return [];
  return Promise.all(
    plan.rows.map(async (definition) => {
      const [draft, submission] = await Promise.all([
        ctx.db
          .query("teamCheckpointDrafts")
          .withIndex("by_team_key", (index) =>
            index.eq("teamId", teamId).eq("checkpointKey", definition.checkpointKey),
          )
          .unique(),
        ctx.db
          .query("teamCheckpointSubmissions")
          .withIndex("by_team_key", (index) =>
            index.eq("teamId", teamId).eq("checkpointKey", definition.checkpointKey),
          )
          .order("desc")
          .first(),
      ]);
      return {
        name: definition.displayName,
        prompt: definition.prompt,
        followUpQuestion: definition.followUpQuestion,
        status: submission !== null ? "submitted" : (draft?.stage ?? "not_started"),
        latestSubmission:
          submission === null
            ? null
            : {
                submittedAt: formatEventTime(submission.submittedAt, event.timezone),
                timing: submission.timing,
              },
      };
    }),
  );
}

async function integrationContext(ctx: QueryCtx, teamId: Id<"teams">) {
  const [repositories, figmaFiles] = await Promise.all([
    ctx.db
      .query("githubRepositoryBindings")
      .withIndex("by_team_state", (index) => index.eq("teamId", teamId).eq("state", "active"))
      .take(20),
    ctx.db
      .query("figmaFileBindings")
      .withIndex("by_team_state", (index) => index.eq("teamId", teamId).eq("state", "active"))
      .take(20),
  ]);
  return {
    githubRepositories: repositories.map((repository) => ({
      name: repository.fullName,
      purpose: repository.purpose,
      topicStatus: repository.topicState,
      syncStatus: repository.syncState,
    })),
    figmaFiles: figmaFiles.map((file) => ({
      name: file.name,
      role: file.role,
      syncStatus: file.syncState,
    })),
  };
}

async function attendanceContext(
  ctx: QueryCtx,
  event: Doc<"events">,
  membershipId: Id<"eventMemberships">,
) {
  const participants = await ctx.db
    .query("attendanceSessionParticipants")
    .withIndex("by_membership", (index) => index.eq("membershipId", membershipId))
    .take(40);
  return Promise.all(
    participants.map(async (participant) => {
      const session = await ctx.db.get(participant.sessionId);
      if (session === null || session.eventId !== event._id) return null;
      const zone = await ctx.db.get(session.zoneId);
      return {
        name: session.name,
        status: session.status,
        requirement: session.requirement,
        startsAt: formatEventTime(session.startsAt, event.timezone),
        endsAt: formatEventTime(session.endsAt, event.timezone),
        checkInOpensAt: formatEventTime(session.checkInOpensAt, event.timezone),
        checkInClosesAt: formatEventTime(session.checkInClosesAt, event.timezone),
        zone: zone?.name ?? null,
        yourStatus: participant.state,
        late: participant.late,
      };
    }),
  ).then((sessions) => sessions.filter((session) => session !== null));
}

function formatEventTime(timestamp: number, timezone: string) {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(timestamp);
}
