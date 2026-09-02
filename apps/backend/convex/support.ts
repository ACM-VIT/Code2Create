import { ConvexError, v } from "convex/values";
import { z } from "zod";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
} from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
  storedOperationVersion,
} from "./lib/operations";
import { appendSupportCaseReadFactById } from "./lib/operationsAutonomyReadFacts";
import {
  boundedActivePermissionGrants,
  matchingPermissionGrantIds,
  requirePermission,
} from "./lib/permissions";
import { normalizedLongText, normalizedText } from "./lib/strings";
import {
  applySupportCaseCounterChange,
  canTransitionSupportCase,
  emptySupportCaseCounters,
  isActiveSupportCaseState,
  supportCaseCounterShardCount,
  supportCaseCounterShardFor,
  type SupportCaseCounterSource,
  type SupportCaseCounters,
  type SupportCaseState,
} from "./lib/supportCases";
import { supportCaseCategory, supportCaseState } from "./values";

type ReadCtx = QueryCtx | MutationCtx;
type SupportCaseDoc = Doc<"supportCases">;
type SupportPermissionKey = "support.case.read" | "support.case.manage";

const supportCaseOrigin = v.union(
  v.literal("participant"),
  v.literal("reviewer"),
  v.literal("staff"),
);

const staffStateFilter = v.union(
  v.literal("active"),
  v.literal("resolved"),
  v.literal("closed"),
  v.literal("all"),
);

type StaffStateFilter = "active" | "resolved" | "closed" | "all";

const caseView = v.object({
  id: v.id("supportCases"),
  publicCode: v.string(),
  category: supportCaseCategory,
  description: v.string(),
  origin: supportCaseOrigin,
  reporterName: v.string(),
  contactEmail: v.string(),
  subjectName: v.optional(v.string()),
  teamName: v.optional(v.string()),
  roundName: v.optional(v.string()),
  reviewSessionId: v.optional(v.id("reviewSessions")),
  attendanceSessionId: v.optional(v.id("attendanceSessions")),
  ownerPersonId: v.optional(v.id("people")),
  ownerName: v.optional(v.string()),
  ownedByViewer: v.boolean(),
  state: supportCaseState,
  version: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  lastActionAt: v.number(),
  firstResponseAt: v.optional(v.number()),
  awaitingStaffReply: v.boolean(),
  canReply: v.boolean(),
  canManage: v.boolean(),
});

/** Counts all readable cases, independently of pagination. */
const staffTotals = v.object({
  open: v.number(),
  investigating: v.number(),
  waiting: v.number(),
  resolved: v.number(),
  closed: v.number(),
  unowned: v.number(),
  awaitingStaffReply: v.number(),
  safety: v.number(),
});

const ownerCandidate = v.object({
  personId: v.id("people"),
  displayName: v.string(),
});

const actionView = v.object({
  id: v.id("supportCaseActions"),
  kind: v.union(
    v.literal("opened"),
    v.literal("reporter_reply"),
    v.literal("public_note"),
    v.literal("internal_note"),
    v.literal("state_changed"),
    v.literal("owner_changed"),
  ),
  visibility: v.union(v.literal("reporter"), v.literal("internal")),
  actorName: v.string(),
  body: v.optional(v.string()),
  previousState: v.optional(supportCaseState),
  nextState: v.optional(supportCaseState),
  previousOwnerName: v.optional(v.string()),
  nextOwnerName: v.optional(v.string()),
  createdAt: v.number(),
});

const detailView = v.object({
  viewer: v.union(v.literal("reporter"), v.literal("staff")),
  supportCase: caseView,
  actions: v.array(actionView),
});

const createResult = v.object({
  id: v.id("supportCases"),
  publicCode: v.string(),
  version: v.number(),
});

const createOperationResult = z
  .object({
    id: z.string().min(1),
    publicCode: z.string().min(1),
    version: z.number().int().positive(),
  })
  .strict();

const activeCaseStates = ["open", "investigating", "waiting"] as const;
const supportSummaryLimit = 20;

/** How many rows one staff page carries. Totals are counted separately. */
const staffPageSize = 80;
const ownerCandidateLimit = 80;
const maximumActiveSupportPermissionGrants = 2_000;

function isLiveState(state: SupportCaseState) {
  return isActiveSupportCaseState(state);
}

function matchesStaffFilter(state: SupportCaseState, filter: StaffStateFilter) {
  if (filter === "all") return true;
  if (filter === "active") return isLiveState(state);
  return state === filter;
}

function randomSupportCode() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  const suffix = Array.from(
    bytes,
    (byte) => alphabet.charAt(byte % alphabet.length),
  ).join("");
  return `C2C-${suffix}`;
}

async function unusedSupportCode(ctx: MutationCtx, eventId: Id<"events">) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = randomSupportCode();
    const existing = await ctx.db
      .query("supportCases")
      .withIndex("by_event_code", (index) =>
        index.eq("eventId", eventId).eq("publicCode", code),
      )
      .unique();
    if (!existing) return code;
  }
  throw new Error("Could not allocate a unique support code.");
}

function optionalLongText(value: string | undefined, field: string) {
  if (value === undefined || value.trim().length === 0) return undefined;
  return normalizedLongText(value, field, 2, 2_000);
}

async function activePermissionGrants(
  ctx: ReadCtx,
  eventId: Id<"events">,
  eventAccessSubjectId: Id<"eventAccessSubjects">,
  permissionKey: SupportPermissionKey,
) {
  return boundedActivePermissionGrants(ctx, {
    eventId,
    eventAccessSubjectId,
    permissionKey,
    maximumGrantCount: maximumActiveSupportPermissionGrants,
  });
}

function hasEventGrant(grants: Doc<"permissionGrants">[]) {
  return grants.some(
    (grant) => grant.scopeType === "event" && grant.scopeId === undefined,
  );
}

function exactCaseGrantIds(grants: Doc<"permissionGrants">[]) {
  return new Set(
    grants.flatMap((grant) =>
      grant.scopeType === "support_case" && grant.scopeId !== undefined
        ? [grant.scopeId]
        : [],
    ),
  );
}

async function toCaseView(
  ctx: ReadCtx,
  supportCase: SupportCaseDoc,
  viewerPersonId: Id<"people">,
  canReply: boolean,
  canManage: boolean,
) {
  const [reporter, subject, team, round, owner] = await Promise.all([
    ctx.db.get("people", supportCase.reporterPersonId),
    supportCase.subjectPersonId === undefined
      ? Promise.resolve(null)
      : ctx.db.get("people", supportCase.subjectPersonId),
    supportCase.teamId === undefined
      ? Promise.resolve(null)
      : ctx.db.get("teams", supportCase.teamId),
    supportCase.roundId === undefined
      ? Promise.resolve(null)
      : ctx.db.get("reviewRounds", supportCase.roundId),
    supportCase.ownerPersonId === undefined
      ? Promise.resolve(null)
      : ctx.db.get("people", supportCase.ownerPersonId),
  ]);
  return {
    id: supportCase._id,
    publicCode: supportCase.publicCode,
    category: supportCase.category,
    description: supportCase.description,
    origin: supportCase.origin,
    reporterName: reporter?.displayName ?? "Event member",
    contactEmail: supportCase.contactEmail,
    ...(subject !== null ? { subjectName: subject.displayName } : {}),
    ...(team !== null ? { teamName: team.name } : {}),
    ...(round !== null ? { roundName: round.name } : {}),
    ...(supportCase.reviewSessionId !== undefined
      ? { reviewSessionId: supportCase.reviewSessionId }
      : {}),
    ...(supportCase.attendanceSessionId !== undefined
      ? { attendanceSessionId: supportCase.attendanceSessionId }
      : {}),
    ...(supportCase.ownerPersonId !== undefined
      ? { ownerPersonId: supportCase.ownerPersonId }
      : {}),
    ...(owner !== null ? { ownerName: owner.displayName } : {}),
    ownedByViewer: supportCase.ownerPersonId === viewerPersonId,
    state: supportCase.state,
    version: supportCase.version,
    createdAt: supportCase.createdAt,
    updatedAt: supportCase.updatedAt,
    lastActionAt: supportCase.lastActionAt,
    ...(supportCase.firstResponseAt !== undefined
      ? { firstResponseAt: supportCase.firstResponseAt }
      : {}),
    awaitingStaffReply: supportCase.awaitingStaffReply,
    canReply,
    canManage,
  };
}

function counterSource(
  supportCase: Pick<
    SupportCaseDoc,
    "state" | "category" | "ownerPersonId" | "awaitingStaffReply"
  >,
): SupportCaseCounterSource {
  return {
    state: supportCase.state,
    category: supportCase.category,
    ...(supportCase.ownerPersonId !== undefined
      ? { ownerPersonId: supportCase.ownerPersonId }
      : {}),
    awaitingStaffReply: supportCase.awaitingStaffReply,
  };
}

function statsCounters(stats: Doc<"supportCaseStatShards">): SupportCaseCounters {
  return {
    open: stats.open,
    investigating: stats.investigating,
    waiting: stats.waiting,
    resolved: stats.resolved,
    closed: stats.closed,
    unowned: stats.unowned,
    awaitingStaffReply: stats.awaitingStaffReply,
    safety: stats.safety,
  };
}

function sameCounters(left: SupportCaseCounters, right: SupportCaseCounters) {
  return (
    left.open === right.open &&
    left.investigating === right.investigating &&
    left.waiting === right.waiting &&
    left.resolved === right.resolved &&
    left.closed === right.closed &&
    left.unowned === right.unowned &&
    left.awaitingStaffReply === right.awaitingStaffReply &&
    left.safety === right.safety
  );
}

async function updateSupportCaseStats(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    supportCaseId: Id<"supportCases">;
    before?: SupportCaseCounterSource;
    after?: SupportCaseCounterSource;
    now: number;
  },
) {
  const shard = supportCaseCounterShardFor(args.supportCaseId);
  const stats = await ctx.db
    .query("supportCaseStatShards")
    .withIndex("by_event_shard", (index) =>
      index.eq("eventId", args.eventId).eq("shard", shard),
    )
    .unique();
  if (stats === null) {
    if (args.before !== undefined) {
      throw new Error("Support case statistics are missing for an existing case.");
    }
    const counters = applySupportCaseCounterChange(
      emptySupportCaseCounters(),
      undefined,
      args.after,
    );
    await ctx.db.insert("supportCaseStatShards", {
      eventId: args.eventId,
      shard,
      ...counters,
      version: 1,
      updatedAt: args.now,
    });
    return;
  }
  const current = statsCounters(stats);
  const counters = applySupportCaseCounterChange(
    current,
    args.before,
    args.after,
  );
  if (sameCounters(current, counters)) return;
  await ctx.db.patch(stats._id, {
    ...counters,
    version: stats.version + 1,
    updatedAt: args.now,
  });
}

function sumStatShards(stats: readonly Doc<"supportCaseStatShards">[]) {
  if (stats.length > supportCaseCounterShardCount) {
    throw new Error("Support statistics exceed the configured shard count.");
  }
  const totals = emptySupportCaseCounters();
  for (const shard of stats) {
    const counters = statsCounters(shard);
    for (const state of activeCaseStates) totals[state] += counters[state];
    totals.resolved += counters.resolved;
    totals.closed += counters.closed;
    totals.unowned += counters.unowned;
    totals.awaitingStaffReply += counters.awaitingStaffReply;
    totals.safety += counters.safety;
  }
  return totals;
}

function countersForCases(cases: readonly SupportCaseDoc[]) {
  let counters = emptySupportCaseCounters();
  for (const supportCase of cases) {
    counters = applySupportCaseCounterChange(
      counters,
      undefined,
      counterSource(supportCase),
    );
  }
  return counters;
}

async function caseActions(
  ctx: ReadCtx,
  supportCase: SupportCaseDoc,
  includeInternal: boolean,
) {
  const candidates = await ctx.db
    .query("supportCaseActions")
    .withIndex("by_case_time", (index) =>
      index.eq("supportCaseId", supportCase._id),
    )
    .order("desc")
    .take(100);
  const actions = candidates
    .filter((action) => includeInternal || action.visibility === "reporter")
    .reverse();
  const personIds = new Set<Id<"people">>();
  for (const action of actions) {
    personIds.add(action.actorPersonId);
    if (action.previousOwnerPersonId !== undefined) {
      personIds.add(action.previousOwnerPersonId);
    }
    if (action.nextOwnerPersonId !== undefined) {
      personIds.add(action.nextOwnerPersonId);
    }
  }
  const people = await Promise.all(
    [...personIds].map((personId) => ctx.db.get("people", personId)),
  );
  const names = new Map(
    people.flatMap((person) =>
      person === null ? [] : [[person._id, person.displayName] as const],
    ),
  );
  return actions.map((action) => ({
    id: action._id,
    kind: action.kind,
    visibility: action.visibility,
    actorName:
      action.kind === "internal_note" &&
      action.body?.startsWith("Code2Create Guide") === true
        ? "Code2Create Guide"
        : includeInternal || action.actorPersonId === supportCase.reporterPersonId
        ? names.get(action.actorPersonId) ?? "Event member"
        : "Support",
    ...(action.body !== undefined ? { body: action.body } : {}),
    ...(action.previousState !== undefined
      ? { previousState: action.previousState }
      : {}),
    ...(action.nextState !== undefined ? { nextState: action.nextState } : {}),
    ...(action.previousOwnerPersonId !== undefined
      ? {
          previousOwnerName:
            names.get(action.previousOwnerPersonId) ?? "Event member",
        }
      : {}),
    ...(action.nextOwnerPersonId !== undefined
      ? {
          nextOwnerName:
            names.get(action.nextOwnerPersonId) ?? "Event member",
        }
      : {}),
    createdAt: action.createdAt,
  }));
}

async function selfContext(
  ctx: ReadCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
  reviewSessionId: Id<"reviewSessions"> | undefined,
  attendanceSessionId: Id<"attendanceSessions"> | undefined,
) {
  const membership = await ctx.db
    .query("eventMemberships")
    .withIndex("by_event_person", (index) =>
      index.eq("eventId", eventId).eq("personId", personId),
    )
    .unique();
  const member = membership
    ? await ctx.db
        .query("teamMembers")
        .withIndex("by_event_membership_status", (index) =>
          index
            .eq("eventId", eventId)
            .eq("membershipId", membership._id)
            .eq("status", "active"),
        )
        .unique()
    : null;
  const reviewerProfile = membership
    ? null
    : await ctx.db
        .query("reviewerProfiles")
        .withIndex("by_event_person", (index) =>
          index.eq("eventId", eventId).eq("personId", personId),
        )
        .unique();
  let teamId = member?.teamId;
  let roundId: Id<"reviewRounds"> | undefined;

  if (reviewSessionId !== undefined) {
    const review = await ctx.db.get("reviewSessions", reviewSessionId);
    if (!review || review.eventId !== eventId) {
      throw new ConvexError({
        code: "INVALID_SUPPORT_CONTEXT",
        message: "That review is not part of this event.",
      });
    }
    const assignment = await ctx.db
      .query("reviewAssignments")
      .withIndex("by_session_person", (index) =>
        index
          .eq("reviewSessionId", review._id)
          .eq("reviewerPersonId", personId),
      )
      .unique();
    const belongsToTeam = teamId !== undefined && teamId === review.teamId;
    if (assignment?.status !== "assigned" && !belongsToTeam) {
      throw new ConvexError({
        code: "INVALID_SUPPORT_CONTEXT",
        message: "That review is not assigned to this account or team.",
      });
    }
    teamId = review.teamId;
    roundId = review.roundId;
  }

  if (attendanceSessionId !== undefined) {
    const session = await ctx.db.get("attendanceSessions", attendanceSessionId);
    if (!session || session.eventId !== eventId) {
      throw new ConvexError({
        code: "INVALID_SUPPORT_CONTEXT",
        message: "That attendance session is not part of this event.",
      });
    }
    if (!membership) {
      throw new ConvexError({
        code: "INVALID_SUPPORT_CONTEXT",
        message: "Only an included participant can attach an attendance session to their own case.",
      });
    }
    const participation = await ctx.db
      .query("attendanceSessionParticipants")
      .withIndex("by_session_membership", (index) =>
        index
          .eq("sessionId", session._id)
          .eq("membershipId", membership._id),
      )
      .unique();
    if (!participation) {
      throw new ConvexError({
        code: "INVALID_SUPPORT_CONTEXT",
        message: "That attendance session does not include this participant.",
      });
    }
  }

  return {
    origin:
      membership !== null
        ? ("participant" as const)
        : reviewerProfile?.status === "active"
          ? ("reviewer" as const)
          : ("staff" as const),
    subjectPersonId: personId,
    ...(teamId !== undefined ? { teamId } : {}),
    ...(roundId !== undefined ? { roundId } : {}),
    ...(reviewSessionId !== undefined ? { reviewSessionId } : {}),
    ...(attendanceSessionId !== undefined ? { attendanceSessionId } : {}),
  };
}

async function staffContext(
  ctx: MutationCtx,
  eventId: Id<"events">,
  args: {
    subjectPersonId?: Id<"people">;
    teamId?: Id<"teams">;
    roundId?: Id<"reviewRounds">;
    reviewSessionId?: Id<"reviewSessions">;
    attendanceSessionId?: Id<"attendanceSessions">;
  },
) {
  const subjectPersonId = args.subjectPersonId;
  if (subjectPersonId !== undefined) {
    const subject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (index) =>
        index
          .eq("eventId", eventId)
          .eq("personId", subjectPersonId),
      )
      .unique();
    if (!subject) {
      throw new ConvexError({
        code: "INVALID_SUPPORT_CONTEXT",
        message: "The referenced person is outside this event.",
      });
    }
  }
  const team =
    args.teamId === undefined ? null : await ctx.db.get("teams", args.teamId);
  if (args.teamId !== undefined && (!team || team.eventId !== eventId)) {
    throw new ConvexError({
      code: "INVALID_SUPPORT_CONTEXT",
      message: "The referenced team is outside this event.",
    });
  }
  const round =
    args.roundId === undefined
      ? null
      : await ctx.db.get("reviewRounds", args.roundId);
  if (args.roundId !== undefined && (!round || round.eventId !== eventId)) {
    throw new ConvexError({
      code: "INVALID_SUPPORT_CONTEXT",
      message: "The referenced round is outside this event.",
    });
  }
  const review =
    args.reviewSessionId === undefined
      ? null
      : await ctx.db.get("reviewSessions", args.reviewSessionId);
  if (
    args.reviewSessionId !== undefined &&
    (!review ||
      review.eventId !== eventId ||
      (args.teamId !== undefined && review.teamId !== args.teamId) ||
      (args.roundId !== undefined && review.roundId !== args.roundId))
  ) {
    throw new ConvexError({
      code: "INVALID_SUPPORT_CONTEXT",
      message: "The referenced review does not match this event context.",
    });
  }
  const attendanceSession =
    args.attendanceSessionId === undefined
      ? null
      : await ctx.db.get("attendanceSessions", args.attendanceSessionId);
  if (
    args.attendanceSessionId !== undefined &&
    (!attendanceSession || attendanceSession.eventId !== eventId)
  ) {
    throw new ConvexError({
      code: "INVALID_SUPPORT_CONTEXT",
      message: "The referenced attendance session is outside this event.",
    });
  }
  return {
    ...(args.subjectPersonId !== undefined
      ? { subjectPersonId: args.subjectPersonId }
      : {}),
    ...(review !== null
      ? { teamId: review.teamId, roundId: review.roundId, reviewSessionId: review._id }
      : {
          ...(team !== null ? { teamId: team._id } : {}),
          ...(round !== null ? { roundId: round._id } : {}),
        }),
    ...(attendanceSession !== null
      ? { attendanceSessionId: attendanceSession._id }
      : {}),
  };
}

async function insertSupportCase(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    category: SupportCaseDoc["category"];
    description: string;
    origin: SupportCaseDoc["origin"];
    reporterPersonId: Id<"people">;
    reporterEventAccessSubjectId: Id<"eventAccessSubjects">;
    contactEmail: string;
    subjectPersonId?: Id<"people">;
    teamId?: Id<"teams">;
    roundId?: Id<"reviewRounds">;
    reviewSessionId?: Id<"reviewSessions">;
    attendanceSessionId?: Id<"attendanceSessions">;
    now: number;
  },
) {
  const publicCode = await unusedSupportCode(ctx, args.eventId);
  const supportCaseId = await ctx.db.insert("supportCases", {
    eventId: args.eventId,
    publicCode,
    category: args.category,
    description: args.description,
    origin: args.origin,
    reporterPersonId: args.reporterPersonId,
    reporterEventAccessSubjectId: args.reporterEventAccessSubjectId,
    contactEmail: args.contactEmail,
    ...(args.subjectPersonId !== undefined
      ? { subjectPersonId: args.subjectPersonId }
      : {}),
    ...(args.teamId !== undefined ? { teamId: args.teamId } : {}),
    ...(args.roundId !== undefined ? { roundId: args.roundId } : {}),
    ...(args.reviewSessionId !== undefined
      ? { reviewSessionId: args.reviewSessionId }
      : {}),
    ...(args.attendanceSessionId !== undefined
      ? { attendanceSessionId: args.attendanceSessionId }
      : {}),
    state: "open",
    lastActionAt: args.now,
    awaitingStaffReply: true,
    version: 1,
    createdAt: args.now,
    updatedAt: args.now,
  });
  await appendSupportCaseReadFactById(ctx, {
    caseId: supportCaseId,
    now: args.now,
  });
  await ctx.db.insert("supportCaseActions", {
    eventId: args.eventId,
    supportCaseId,
    kind: "opened",
    visibility: "reporter",
    actorPersonId: args.reporterPersonId,
    body: args.description,
    createdAt: args.now,
  });
  await updateSupportCaseStats(ctx, {
    eventId: args.eventId,
    supportCaseId,
    after: {
      state: "open",
      category: args.category,
      awaitingStaffReply: true,
    },
    now: args.now,
  });
  return { id: supportCaseId, publicCode, version: 1 };
}

export async function openParticipantAssistantSupportCase(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    personId: Id<"people">;
    category: SupportCaseDoc["category"];
    summary: string;
    transcript: string;
    now: number;
  },
) {
  const [person, subject] = await Promise.all([
    ctx.db.get(args.personId),
    requireEventSubject(ctx, args.eventId, args.personId),
  ]);
  if (person === null) {
    throw new Error("The participant for this Guide conversation is unavailable.");
  }
  const summary = normalizedLongText(
    args.summary,
    "Handoff summary",
    10,
    1_600,
  );
  const transcript = normalizedLongText(
    args.transcript,
    "Guide conversation",
    2,
    16_000,
  );
  const grantIds = await requirePermission(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: subject._id,
    permissionKey: "support.case.create",
    scopeType: "self",
    scopeId: subject._id,
  });
  const context = await selfContext(
    ctx,
    args.eventId,
    args.personId,
    undefined,
    undefined,
  );
  const result = await insertSupportCase(ctx, {
    eventId: args.eventId,
    category: args.category,
    description: `Guide handoff: ${summary}`,
    reporterPersonId: args.personId,
    reporterEventAccessSubjectId: subject._id,
    contactEmail: person.verifiedEmail,
    ...context,
    now: args.now,
  });
  await ctx.db.insert("supportCaseActions", {
    eventId: args.eventId,
    supportCaseId: result.id,
    kind: "internal_note",
    visibility: "internal",
    actorPersonId: args.personId,
    body: `Code2Create Guide handoff\n\n${summary}\n\nConversation so far\n${transcript}`,
    createdAt: args.now + 1,
  });
  await writeAuditEvent(ctx, {
    eventId: args.eventId,
    actorPersonId: args.personId,
    permissionKey: "support.case.create",
    grantIds,
    scopeType: "self",
    scopeId: subject._id,
    action: "support.case_opened",
    targetType: "support_case",
    targetId: result.id,
    nextSummary: JSON.stringify({
      publicCode: result.publicCode,
      category: args.category,
      state: "open",
      source: "participant_guide",
    }),
    reason: "The participant Guide brought the event team into the conversation.",
  });
  return result;
}

export async function appendParticipantAssistantSupportMessage(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    personId: Id<"people">;
    supportCaseId: Id<"supportCases">;
    message: string;
    now: number;
  },
) {
  const message = normalizedLongText(
    args.message,
    "Conversation message",
    2,
    1_600,
  );
  const subject = await requireEventSubject(ctx, args.eventId, args.personId);
  const grantIds = await requirePermission(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: subject._id,
    permissionKey: "support.case.reply",
    scopeType: "self",
    scopeId: subject._id,
  });
  const supportCase = await ctx.db.get(args.supportCaseId);
  if (
    supportCase === null ||
    supportCase.eventId !== args.eventId ||
    supportCase.reporterPersonId !== args.personId
  ) {
    throw new Error("The human support conversation is unavailable.");
  }

  const nextState: SupportCaseState =
    supportCase.state === "waiting" ||
    supportCase.state === "resolved" ||
    supportCase.state === "closed"
      ? "open"
      : supportCase.state;
  const beforeCounters = counterSource(supportCase);
  const afterCounters: SupportCaseCounterSource = {
    state: nextState,
    category: supportCase.category,
    ...(supportCase.ownerPersonId !== undefined
      ? { ownerPersonId: supportCase.ownerPersonId }
      : {}),
    awaitingStaffReply: true,
  };
  await ctx.db.patch(supportCase._id, {
    state: nextState,
    ...(nextState !== supportCase.state
      ? { resolvedAt: undefined, closedAt: undefined }
      : {}),
    lastActionAt: args.now,
    awaitingStaffReply: true,
    version: supportCase.version + 1,
    updatedAt: args.now,
  });
  await appendSupportCaseReadFactById(ctx, {
    caseId: supportCase._id,
    before: supportCase,
    now: args.now,
  });
  await ctx.db.insert("supportCaseActions", {
    eventId: args.eventId,
    supportCaseId: supportCase._id,
    kind: "reporter_reply",
    visibility: "reporter",
    actorPersonId: args.personId,
    body: message,
    createdAt: args.now,
  });
  if (nextState !== supportCase.state) {
    await ctx.db.insert("supportCaseActions", {
      eventId: args.eventId,
      supportCaseId: supportCase._id,
      kind: "state_changed",
      visibility: "reporter",
      actorPersonId: args.personId,
      previousState: supportCase.state,
      nextState,
      createdAt: args.now,
    });
  }
  await updateSupportCaseStats(ctx, {
    eventId: args.eventId,
    supportCaseId: supportCase._id,
    before: beforeCounters,
    after: afterCounters,
    now: args.now,
  });
  await writeAuditEvent(ctx, {
    eventId: args.eventId,
    actorPersonId: args.personId,
    permissionKey: "support.case.reply",
    grantIds,
    scopeType: "self",
    scopeId: subject._id,
    action: "support.reporter_replied",
    targetType: "support_case",
    targetId: supportCase._id,
    previousSummary: JSON.stringify({
      state: supportCase.state,
      version: supportCase.version,
    }),
    nextSummary: JSON.stringify({
      state: nextState,
      version: supportCase.version + 1,
      source: "participant_guide",
    }),
    reason: "The participant continued their shared Guide and event-team conversation.",
  });
}

export async function appendParticipantAssistantGuideReply(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    personId: Id<"people">;
    supportCaseId: Id<"supportCases">;
    message: string;
    now: number;
  },
) {
  const supportCase = await ctx.db.get(args.supportCaseId);
  if (
    supportCase === null ||
    supportCase.eventId !== args.eventId ||
    supportCase.reporterPersonId !== args.personId
  ) {
    throw new Error("The human support conversation is unavailable.");
  }
  const message = normalizedLongText(
    args.message,
    "Guide reply",
    2,
    12_000,
  );
  await ctx.db.insert("supportCaseActions", {
    eventId: args.eventId,
    supportCaseId: supportCase._id,
    kind: "internal_note",
    visibility: "internal",
    actorPersonId: args.personId,
    body: `Code2Create Guide reply\n\n${message}`,
    createdAt: args.now,
  });
}

export const mine = query({
  args: { eventSlug: v.string() },
  returns: v.array(caseView),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const readGrantIds = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "support.case.read",
      scopeType: "self",
      scopeId: subject._id,
    });
    if (readGrantIds.length === 0) return [];
    const replyGrants = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "support.case.reply",
      scopeType: "self",
      scopeId: subject._id,
    });
    const cases = await ctx.db
      .query("supportCases")
      .withIndex("by_event_reporter_updated", (index) =>
        index.eq("eventId", event._id).eq("reporterPersonId", person._id),
      )
      .order("desc")
      .take(20);
    return Promise.all(
      cases.map(async (supportCase) =>
        toCaseView(
          ctx,
          supportCase,
          person._id,
          replyGrants.length > 0 && supportCase.state !== "closed",
          false,
        ),
      ),
    );
  },
});

export const mineSummary = query({
  args: { eventSlug: v.string() },
  returns: v.object({ openCount: v.number(), countIsLowerBound: v.boolean() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const readGrantIds = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "support.case.read",
      scopeType: "self",
      scopeId: subject._id,
    });
    if (readGrantIds.length === 0) {
      return { openCount: 0, countIsLowerBound: false };
    }
    const activeCases = (
      await Promise.all(
        activeCaseStates.map((state) =>
          ctx.db
            .query("supportCases")
            .withIndex("by_event_reporter_state_updated", (index) =>
              index
                .eq("eventId", event._id)
                .eq("reporterPersonId", person._id)
                .eq("state", state),
            )
            .take(supportSummaryLimit + 1),
        ),
      )
    ).flat();
    return {
      openCount: Math.min(activeCases.length, supportSummaryLimit),
      countIsLowerBound: activeCases.length > supportSummaryLimit,
    };
  },
});

export const staffList = query({
  args: { eventSlug: v.string(), state: staffStateFilter },
  returns: v.object({
    serverNow: v.number(),
    currentPersonId: v.id("people"),
    canCreate: v.boolean(),
    totals: staffTotals,
    cases: v.array(caseView),
    caseLimitReached: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const [readGrants, manageGrants, createGrants] = await Promise.all([
      activePermissionGrants(ctx, event._id, subject._id, "support.case.read"),
      activePermissionGrants(ctx, event._id, subject._id, "support.case.manage"),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "support.case.create",
        scopeType: "event",
      }),
    ]);
    const canReadEvent = hasEventGrant(readGrants);
    const exactReadIds = exactCaseGrantIds(readGrants);
    const canManageEvent = hasEventGrant(manageGrants);
    const exactManageIds = exactCaseGrantIds(manageGrants);
    let totals: SupportCaseCounters;
    let candidates: SupportCaseDoc[];
    if (canReadEvent) {
      const stats = await ctx.db
        .query("supportCaseStatShards")
        .withIndex("by_event_shard", (index) => index.eq("eventId", event._id))
        .take(supportCaseCounterShardCount + 1);
      totals = sumStatShards(stats);
      if (args.state === "all") {
        candidates = await ctx.db
          .query("supportCases")
          .withIndex("by_event_updated", (index) => index.eq("eventId", event._id))
          .order("desc")
          .take(staffPageSize + 1);
      } else if (args.state === "active") {
        candidates = (
          await Promise.all(
            activeCaseStates.map((state) =>
              ctx.db
                .query("supportCases")
                .withIndex("by_event_state_updated", (index) =>
                  index.eq("eventId", event._id).eq("state", state),
                )
                .order("desc")
                .take(staffPageSize + 1),
            ),
          )
        ).flat();
      } else {
        const state = args.state;
        candidates = await ctx.db
          .query("supportCases")
          .withIndex("by_event_state_updated", (index) =>
            index.eq("eventId", event._id).eq("state", state),
          )
          .order("desc")
          .take(staffPageSize + 1);
      }
    } else {
      if (exactReadIds.size > staffPageSize) {
        throw new ConvexError({
          code: "SUPPORT_CASE_GRANT_LIMIT_EXCEEDED",
          message: "This account has too many individually granted support cases. Use an event-wide support role.",
        });
      }
      const readableCases = (
        await Promise.all(
          [...exactReadIds].map((scopeId) => {
            const supportCaseId = ctx.db.normalizeId("supportCases", scopeId);
            return supportCaseId
              ? ctx.db.get("supportCases", supportCaseId)
              : Promise.resolve(null);
          }),
        )
      ).flatMap((supportCase) =>
        supportCase !== null && supportCase.eventId === event._id
          ? [supportCase]
          : [],
      );
      totals = countersForCases(readableCases);
      candidates = readableCases.filter((supportCase) =>
        matchesStaffFilter(supportCase.state, args.state),
      );
    }

    const ordered = candidates.sort((left, right) => right.updatedAt - left.updatedAt);
    const caseLimitReached = ordered.length > staffPageSize;
    const rows = ordered.slice(0, staffPageSize);

    return {
      serverNow: Date.now(),
      currentPersonId: person._id,
      canCreate: createGrants.length > 0,
      totals,
      caseLimitReached,
      cases: await Promise.all(
        rows.map(async (supportCase) =>
          toCaseView(
            ctx,
            supportCase,
            person._id,
            false,
            canManageEvent || exactManageIds.has(supportCase._id),
          ),
        ),
      ),
    };
  },
});

/** Returns active event accounts with event-wide support.case.manage authority. */
export const owners = query({
  args: { eventSlug: v.string() },
  returns: v.array(ownerCandidate),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const viewerGrants = await activePermissionGrants(
      ctx,
      event._id,
      subject._id,
      "support.case.manage",
    );
    if (viewerGrants.length === 0) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account cannot hand a support case to anyone.",
      });
    }
    const now = Date.now();
    const grants = await ctx.db
      .query("permissionGrants")
      .withIndex("by_event_permission_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("permissionKey", "support.case.manage")
          .eq("status", "active"),
      )
      .take(ownerCandidateLimit + 1);
    if (grants.length > ownerCandidateLimit) {
      throw new ConvexError({
        code: "SUPPORT_OWNER_LIMIT_EXCEEDED",
        message: "Too many support-manager grants are active. Retire duplicate grants before assigning an owner.",
      });
    }
    const subjects = await Promise.all(
      grants
        .filter(
          (grant) =>
            grant.scopeType === "event" &&
            grant.scopeId === undefined &&
            grant.validFrom <= now &&
            (grant.validUntil === undefined || grant.validUntil > now),
        )
        .map((grant) => ctx.db.get(grant.eventAccessSubjectId)),
    );
    const candidates = new Map<Id<"people">, string>();
    for (const candidate of subjects) {
      if (candidate?.eventId === event._id && candidate.status === "active") {
        candidates.set(candidate.personId, candidate.displayName);
      }
    }
    return [...candidates]
      .map(([personId, displayName]) => ({ personId, displayName }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  },
});

async function supportCaseDetail(
  ctx: QueryCtx,
  args: {
    eventId: Id<"events">;
    personId: Id<"people">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    supportCase: SupportCaseDoc;
  },
) {
  const supportCase = args.supportCase;
  const isReporter = supportCase.reporterPersonId === args.personId;
  const staffReadGrants = await matchingPermissionGrantIds(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    permissionKey: "support.case.read",
    scopeType: "support_case",
    scopeId: supportCase._id,
  });
  const [reporterReadGrants, replyGrants, manageGrants] = await Promise.all([
    isReporter
      ? matchingPermissionGrantIds(ctx, {
          eventId: args.eventId,
          eventAccessSubjectId: args.eventAccessSubjectId,
          permissionKey: "support.case.read",
          scopeType: "self",
          scopeId: args.eventAccessSubjectId,
        })
      : Promise.resolve([]),
    isReporter
      ? matchingPermissionGrantIds(ctx, {
          eventId: args.eventId,
          eventAccessSubjectId: args.eventAccessSubjectId,
          permissionKey: "support.case.reply",
          scopeType: "self",
          scopeId: args.eventAccessSubjectId,
        })
      : Promise.resolve([]),
    matchingPermissionGrantIds(ctx, {
      eventId: args.eventId,
      eventAccessSubjectId: args.eventAccessSubjectId,
      permissionKey: "support.case.manage",
      scopeType: "support_case",
      scopeId: supportCase._id,
    }),
  ]);
  if (staffReadGrants.length === 0 && reporterReadGrants.length === 0) return null;
  const staffViewer = staffReadGrants.length > 0;
  const viewer: "reporter" | "staff" = staffViewer ? "staff" : "reporter";
  return {
    viewer,
    supportCase: await toCaseView(
      ctx,
      supportCase,
      args.personId,
      isReporter && replyGrants.length > 0 && supportCase.state !== "closed",
      manageGrants.length > 0,
    ),
    actions: await caseActions(ctx, supportCase, staffViewer),
  };
}

export const detail = query({
  args: { eventSlug: v.string(), supportCaseId: v.id("supportCases") },
  returns: v.union(v.null(), detailView),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const supportCase = await ctx.db.get("supportCases", args.supportCaseId);
    if (!supportCase || supportCase.eventId !== event._id) {
      throw new ConvexError({
        code: "SUPPORT_CASE_NOT_FOUND",
        message: "Support case not found.",
      });
    }
    return await supportCaseDetail(ctx, {
      eventId: event._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
      supportCase,
    });
  },
});

export const detailByPublicCode = query({
  args: { eventSlug: v.string(), publicCode: v.string() },
  returns: v.union(v.null(), detailView),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const publicCode = normalizedText(args.publicCode, "Support code", 3, 40);
    const supportCase = await ctx.db
      .query("supportCases")
      .withIndex("by_event_code", (index) =>
        index.eq("eventId", event._id).eq("publicCode", publicCode),
      )
      .unique();
    if (!supportCase) {
      throw new ConvexError({
        code: "SUPPORT_CASE_NOT_FOUND",
        message: "Support case not found.",
      });
    }
    return await supportCaseDetail(ctx, {
      eventId: event._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
      supportCase,
    });
  },
});

export const createSelf = mutation({
  args: {
    eventSlug: v.string(),
    category: supportCaseCategory,
    description: v.string(),
    reviewSessionId: v.optional(v.id("reviewSessions")),
    attendanceSessionId: v.optional(v.id("attendanceSessions")),
    clientOperationId: v.string(),
  },
  returns: createResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const description = normalizedLongText(
      args.description,
      "Support description",
      10,
      2_000,
    );
    const operationId = normalizedText(
      args.clientOperationId,
      "Operation ID",
      8,
      100,
    );
    const requestFingerprint = operationFingerprint([
      args.category,
      description,
      args.reviewSessionId ?? null,
      args.attendanceSessionId ?? null,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "support.createSelf",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "support case creation",
        createOperationResult,
      );
      const supportCaseId = ctx.db.normalizeId("supportCases", result.id);
      if (!supportCaseId || supportCaseId !== prior.targetId) {
        throw new Error("The stored support case creation is invalid.");
      }
      return {
        id: supportCaseId,
        publicCode: result.publicCode,
        version: result.version,
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "support.case.create",
      scopeType: "self",
      scopeId: subject._id,
    });
    const context = await selfContext(
      ctx,
      event._id,
      person._id,
      args.reviewSessionId,
      args.attendanceSessionId,
    );
    const now = Date.now();
    const result = await insertSupportCase(ctx, {
      eventId: event._id,
      category: args.category,
      description,
      reporterPersonId: person._id,
      reporterEventAccessSubjectId: subject._id,
      contactEmail: person.verifiedEmail,
      ...context,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "support.createSelf",
      requestFingerprint,
      targetType: "support_case",
      targetId: result.id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "support.case.create",
      grantIds,
      scopeType: "self",
      scopeId: subject._id,
      action: "support.case_opened",
      targetType: "support_case",
      targetId: result.id,
      nextSummary: JSON.stringify({
        publicCode: result.publicCode,
        category: args.category,
        state: "open",
      }),
      reason: "Participant opened a support case.",
    });
    return result;
  },
});

export const createStaff = mutation({
  args: {
    eventSlug: v.string(),
    category: supportCaseCategory,
    description: v.string(),
    subjectPersonId: v.optional(v.id("people")),
    teamId: v.optional(v.id("teams")),
    roundId: v.optional(v.id("reviewRounds")),
    reviewSessionId: v.optional(v.id("reviewSessions")),
    attendanceSessionId: v.optional(v.id("attendanceSessions")),
    clientOperationId: v.string(),
  },
  returns: createResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const description = normalizedLongText(
      args.description,
      "Support description",
      10,
      2_000,
    );
    const operationId = normalizedText(
      args.clientOperationId,
      "Operation ID",
      8,
      100,
    );
    const requestFingerprint = operationFingerprint([
      args.category,
      description,
      args.subjectPersonId ?? null,
      args.teamId ?? null,
      args.roundId ?? null,
      args.reviewSessionId ?? null,
      args.attendanceSessionId ?? null,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "support.createStaff",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "staff support case creation",
        createOperationResult,
      );
      const supportCaseId = ctx.db.normalizeId("supportCases", result.id);
      if (!supportCaseId || supportCaseId !== prior.targetId) {
        throw new Error("The stored staff support case creation is invalid.");
      }
      return {
        id: supportCaseId,
        publicCode: result.publicCode,
        version: result.version,
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "support.case.create",
      scopeType: "event",
    });
    const context = await staffContext(ctx, event._id, {
      ...(args.subjectPersonId !== undefined
        ? { subjectPersonId: args.subjectPersonId }
        : {}),
      ...(args.teamId !== undefined ? { teamId: args.teamId } : {}),
      ...(args.roundId !== undefined ? { roundId: args.roundId } : {}),
      ...(args.reviewSessionId !== undefined
        ? { reviewSessionId: args.reviewSessionId }
        : {}),
      ...(args.attendanceSessionId !== undefined
        ? { attendanceSessionId: args.attendanceSessionId }
        : {}),
    });
    const now = Date.now();
    const result = await insertSupportCase(ctx, {
      eventId: event._id,
      category: args.category,
      description,
      origin: "staff",
      reporterPersonId: person._id,
      reporterEventAccessSubjectId: subject._id,
      contactEmail: person.verifiedEmail,
      ...context,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "support.createStaff",
      requestFingerprint,
      targetType: "support_case",
      targetId: result.id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "support.case.create",
      grantIds,
      scopeType: "event",
      action: "support.case_opened_by_staff",
      targetType: "support_case",
      targetId: result.id,
      nextSummary: JSON.stringify({
        publicCode: result.publicCode,
        category: args.category,
        state: "open",
      }),
      reason: "Staff opened a support case.",
    });
    return result;
  },
});

export const replySelf = mutation({
  args: {
    eventSlug: v.string(),
    supportCaseId: v.id("supportCases"),
    expectedVersion: v.number(),
    message: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ id: v.id("supportCases"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const message = normalizedLongText(args.message, "Reply", 2, 2_000);
    const operationId = normalizedText(
      args.clientOperationId,
      "Operation ID",
      8,
      100,
    );
    const requestFingerprint = operationFingerprint([
      args.supportCaseId,
      args.expectedVersion,
      message,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "support.replySelf",
      requestFingerprint,
    });
    if (prior) {
      const supportCaseId = ctx.db.normalizeId("supportCases", prior.targetId);
      if (!supportCaseId) throw new Error("The stored support reply is invalid.");
      return {
        id: supportCaseId,
        version: storedOperationVersion(prior.resultJson, "support-case"),
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "support.case.reply",
      scopeType: "self",
      scopeId: subject._id,
    });
    const supportCase = await ctx.db.get("supportCases", args.supportCaseId);
    if (
      !supportCase ||
      supportCase.eventId !== event._id ||
      supportCase.reporterPersonId !== person._id
    ) {
      throw new ConvexError({
        code: "SUPPORT_CASE_NOT_FOUND",
        message: "Support case not found.",
      });
    }
    if (supportCase.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "SUPPORT_CASE_CHANGED",
        message: "This support case changed. Review it before replying.",
      });
    }
    if (supportCase.state === "closed") {
      throw new ConvexError({
        code: "SUPPORT_CASE_CLOSED",
        message: "This case is closed. Open a new case if help is still needed.",
      });
    }
    const nextState: SupportCaseState =
      supportCase.state === "waiting" || supportCase.state === "resolved"
        ? "open"
        : supportCase.state;
    const now = Date.now();
    const beforeCounters = counterSource(supportCase);
    const afterCounters: SupportCaseCounterSource = {
      state: nextState,
      category: supportCase.category,
      ...(supportCase.ownerPersonId !== undefined
        ? { ownerPersonId: supportCase.ownerPersonId }
        : {}),
      awaitingStaffReply: true,
    };
    await ctx.db.patch("supportCases", supportCase._id, {
      state: nextState,
      ...(supportCase.state === "resolved" ? { resolvedAt: undefined } : {}),
      lastActionAt: now,
      awaitingStaffReply: true,
      version: supportCase.version + 1,
      updatedAt: now,
    });
    await appendSupportCaseReadFactById(ctx, {
      caseId: supportCase._id,
      before: supportCase,
      now,
    });
    await ctx.db.insert("supportCaseActions", {
      eventId: event._id,
      supportCaseId: supportCase._id,
      kind: "reporter_reply",
      visibility: "reporter",
      actorPersonId: person._id,
      body: message,
      createdAt: now,
    });
    if (nextState !== supportCase.state) {
      await ctx.db.insert("supportCaseActions", {
        eventId: event._id,
        supportCaseId: supportCase._id,
        kind: "state_changed",
        visibility: "reporter",
        actorPersonId: person._id,
        previousState: supportCase.state,
        nextState,
        createdAt: now,
      });
    }
    await updateSupportCaseStats(ctx, {
      eventId: event._id,
      supportCaseId: supportCase._id,
      before: beforeCounters,
      after: afterCounters,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "support.replySelf",
      requestFingerprint,
      targetType: "support_case",
      targetId: supportCase._id,
      resultJson: String(supportCase.version + 1),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "support.case.reply",
      grantIds,
      scopeType: "self",
      scopeId: subject._id,
      action: "support.reporter_replied",
      targetType: "support_case",
      targetId: supportCase._id,
      previousSummary: JSON.stringify({
        state: supportCase.state,
        version: supportCase.version,
      }),
      nextSummary: JSON.stringify({
        state: nextState,
        version: supportCase.version + 1,
      }),
      reason: "Reporter added a support reply.",
    });
    return { id: supportCase._id, version: supportCase.version + 1 };
  },
});

export const updateStaff = mutation({
  args: {
    eventSlug: v.string(),
    supportCaseId: v.id("supportCases"),
    expectedVersion: v.number(),
    nextState: v.optional(supportCaseState),
    nextOwnerPersonId: v.optional(v.id("people")),
    clearOwner: v.boolean(),
    publicNote: v.optional(v.string()),
    internalNote: v.optional(v.string()),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ id: v.id("supportCases"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const reason = normalizedText(args.reason, "Audit reason", 5, 300);
    const publicNote = optionalLongText(args.publicNote, "Public note");
    const internalNote = optionalLongText(args.internalNote, "Internal note");
    if (args.clearOwner && args.nextOwnerPersonId !== undefined) {
      throw new ConvexError({
        code: "INVALID_OWNER_CHANGE",
        message: "Choose an owner or clear the owner, not both.",
      });
    }
    const operationId = normalizedText(
      args.clientOperationId,
      "Operation ID",
      8,
      100,
    );
    const requestFingerprint = operationFingerprint([
      args.supportCaseId,
      args.expectedVersion,
      args.nextState ?? null,
      args.nextOwnerPersonId ?? null,
      args.clearOwner,
      publicNote ?? null,
      internalNote ?? null,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "support.updateStaff",
      requestFingerprint,
    });
    if (prior) {
      const supportCaseId = ctx.db.normalizeId("supportCases", prior.targetId);
      if (!supportCaseId) throw new Error("The stored support update is invalid.");
      return {
        id: supportCaseId,
        version: storedOperationVersion(prior.resultJson, "support-case"),
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const supportCase = await ctx.db.get("supportCases", args.supportCaseId);
    if (!supportCase || supportCase.eventId !== event._id) {
      throw new ConvexError({
        code: "SUPPORT_CASE_NOT_FOUND",
        message: "Support case not found.",
      });
    }
    if (supportCase.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "SUPPORT_CASE_CHANGED",
        message: "This support case changed. Review it before saving.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "support.case.manage",
      scopeType: "support_case",
      scopeId: supportCase._id,
    });
    const requestedState = args.nextState;
    const stateChanged =
      requestedState !== undefined && requestedState !== supportCase.state;
    if (
      stateChanged &&
      !canTransitionSupportCase(supportCase.state, requestedState)
    ) {
      throw new ConvexError({
        code: "INVALID_SUPPORT_TRANSITION",
        message: `A ${supportCase.state.replaceAll("_", " ")} case cannot move directly to ${requestedState.replaceAll("_", " ")}.`,
      });
    }
    let nextOwnerPersonId = supportCase.ownerPersonId;
    if (args.clearOwner) nextOwnerPersonId = undefined;
    const requestedOwnerPersonId = args.nextOwnerPersonId;
    if (requestedOwnerPersonId !== undefined) {
      const ownerSubject = await ctx.db
        .query("eventAccessSubjects")
        .withIndex("by_event_person", (index) =>
          index
            .eq("eventId", event._id)
            .eq("personId", requestedOwnerPersonId),
        )
        .unique();
      if (!ownerSubject || ownerSubject.status !== "active") {
        throw new ConvexError({
          code: "INVALID_SUPPORT_OWNER",
          message: "The selected owner does not have active event access.",
        });
      }
      nextOwnerPersonId = requestedOwnerPersonId;
    }
    const ownerChanged = nextOwnerPersonId !== supportCase.ownerPersonId;
    if (!stateChanged && !ownerChanged && !publicNote && !internalNote) {
      throw new ConvexError({
        code: "NO_SUPPORT_CHANGE",
        message: "Choose a state or owner change, or add a note.",
      });
    }
    const nextState = requestedState ?? supportCase.state;
    const now = Date.now();
    const firstResponseAt =
      publicNote !== undefined && supportCase.firstResponseAt === undefined
        ? now
        : supportCase.firstResponseAt;
    const awaitingStaffReply = publicNote === undefined
      ? supportCase.awaitingStaffReply
      : false;
    const beforeCounters = counterSource(supportCase);
    const afterCounters: SupportCaseCounterSource = {
      state: nextState,
      category: supportCase.category,
      ...(nextOwnerPersonId !== undefined ? { ownerPersonId: nextOwnerPersonId } : {}),
      awaitingStaffReply,
    };
    const lifecycle = stateChanged
      ? nextState === "resolved"
        ? { resolvedAt: now, closedAt: undefined }
        : nextState === "closed"
          ? { closedAt: now }
          : { resolvedAt: undefined, closedAt: undefined }
      : {};
    await ctx.db.patch("supportCases", supportCase._id, {
      ...(stateChanged ? { state: nextState } : {}),
      ...(ownerChanged ? { ownerPersonId: nextOwnerPersonId } : {}),
      ...lifecycle,
      lastActionAt: now,
      ...(firstResponseAt !== supportCase.firstResponseAt
        ? { firstResponseAt }
        : {}),
      awaitingStaffReply,
      version: supportCase.version + 1,
      updatedAt: now,
    });
    await appendSupportCaseReadFactById(ctx, {
      caseId: supportCase._id,
      before: supportCase,
      now,
    });
    if (stateChanged) {
      await ctx.db.insert("supportCaseActions", {
        eventId: event._id,
        supportCaseId: supportCase._id,
        kind: "state_changed",
        visibility: "reporter",
        actorPersonId: person._id,
        previousState: supportCase.state,
        nextState,
        createdAt: now,
      });
    }
    if (ownerChanged) {
      await ctx.db.insert("supportCaseActions", {
        eventId: event._id,
        supportCaseId: supportCase._id,
        kind: "owner_changed",
        visibility: "internal",
        actorPersonId: person._id,
        ...(supportCase.ownerPersonId !== undefined
          ? { previousOwnerPersonId: supportCase.ownerPersonId }
          : {}),
        ...(nextOwnerPersonId !== undefined
          ? { nextOwnerPersonId }
          : {}),
        createdAt: now,
      });
    }
    if (publicNote) {
      await ctx.db.insert("supportCaseActions", {
        eventId: event._id,
        supportCaseId: supportCase._id,
        kind: "public_note",
        visibility: "reporter",
        actorPersonId: person._id,
        body: publicNote,
        createdAt: now,
      });
    }
    if (internalNote) {
      await ctx.db.insert("supportCaseActions", {
        eventId: event._id,
        supportCaseId: supportCase._id,
        kind: "internal_note",
        visibility: "internal",
        actorPersonId: person._id,
        body: internalNote,
        createdAt: now,
      });
    }
    await updateSupportCaseStats(ctx, {
      eventId: event._id,
      supportCaseId: supportCase._id,
      before: beforeCounters,
      after: afterCounters,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "support.updateStaff",
      requestFingerprint,
      targetType: "support_case",
      targetId: supportCase._id,
      resultJson: String(supportCase.version + 1),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "support.case.manage",
      grantIds,
      scopeType: "support_case",
      scopeId: supportCase._id,
      action: "support.case_updated",
      targetType: "support_case",
      targetId: supportCase._id,
      previousSummary: JSON.stringify({
        state: supportCase.state,
        ownerPersonId: supportCase.ownerPersonId ?? null,
        version: supportCase.version,
      }),
      nextSummary: JSON.stringify({
        state: nextState,
        ownerPersonId: nextOwnerPersonId ?? null,
        publicNoteAdded: publicNote !== undefined,
        internalNoteAdded: internalNote !== undefined,
        version: supportCase.version + 1,
      }),
      reason,
    });
    return { id: supportCase._id, version: supportCase.version + 1 };
  },
});
