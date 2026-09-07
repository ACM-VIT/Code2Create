import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { ConvexError, v, type Infer } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { action, internalQuery, mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
  storedOperationVersion,
} from "./lib/operations";
import {
  matchingPermissionGrantIds,
  requirePermission,
  revokeSourceGrants,
} from "./lib/permissions";
import { normalizeNativePushRegistration, pushTokenFingerprint,
} from "./lib/pushTokens";
import { patchTeamRoundState } from "./lib/reviewQueueProjection";
import { activeRoundPause } from "./lib/reviewRoundPauses";
import {
  maximumReviewerAssignmentsPerEvent,
  maximumReviewRoundsPerEvent,
} from "./lib/reviewLimits";
import {
  activeAssignmentScorecards,
  cleanAssignedRatings,
  recomputeReviewEvaluation,
  requireCompleteAssignedRatings,
  requireFinalComment,
} from "./lib/reviewScores";
import { normalizedText } from "./lib/strings";
import { repositoryKind } from "./values";

type ReadCtx = QueryCtx | MutationCtx;

const reviewerConflictOperationResult = z
  .object({
    conflictId: z.string().min(1),
    teamName: z.string(),
  })
  .strict();

const reviewPresenceOperationResult = z
  .object({
    reviewSessionId: z.string().min(1),
    teamName: z.string(),
    roundName: z.string(),
    reviewerPresenceCount: z.number().int().nonnegative(),
    reviewerCount: z.number().int().nonnegative(),
    confirmedAt: z.number().int().nonnegative(),
  })
  .strict();

const scorecardSubmissionOperationResult = z
  .object({
    scorecardId: z.string().min(1),
    scorecardVersionId: z.string().min(1),
    submittedAt: z.number().int().nonnegative(),
  })
  .strict();

type PanelContext = {
  membership: Doc<"reviewPanelMembers">;
  round: Doc<"reviewRounds">;
  panel: Doc<"reviewPanels">;
};
type PanelView = {
  id: Id<"reviewPanels">;
  name: string;
  isCoordinator: boolean;
  round: {
    id: Id<"reviewRounds">;
    name: string;
    status: string;
    startsAt: number;
    endsAt: number;
    reviewerReportAt: number;
    minimumReviewerBuild: number;
    requiresCamera: boolean;
    requiresNotifications: boolean;
    isPaused: boolean;
  };
};
type ReserveView = {
  id: Id<"reviewRoundReserves">;
  status: "available" | "paged";
  round: PanelView["round"];
};
type ActiveAssignmentContext = {
  assignment: Doc<"reviewAssignments">;
  session: Doc<"reviewSessions">;
};
type CurrentReviewContext = ActiveAssignmentContext & {
  correctionScorecard: Doc<"scorecards"> | null;
};

const priorReviewHistoryLimit = 20;

const ratingInput = v.object({
  criterionId: v.id("reviewRubricCriteria"),
  score: v.number(),
  evidenceNote: v.optional(v.string()),
});

function reviewTokenDigest(value: string) {
  return bytesToHex(sha256(utf8ToBytes(value)));
}

function liveReview(status: Doc<"reviewSessions">["status"]) {
  return ["awaiting_presence", "active", "scoring"].includes(status);
}

async function requireReviewerDevice(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    personId: Id<"people">;
    installationId: string;
  },
) {
  const device = await ctx.db
    .query("reviewerDevices")
    .withIndex("by_event_installation", (index) =>
      index.eq("eventId", args.eventId).eq("installationId", args.installationId),
    )
    .unique();
  if (!device || device.personId !== args.personId || device.status !== "active") {
    throw new ConvexError({
      code: "REVIEWER_DEVICE_REQUIRED",
      message: "Register this phone for the signed-in reviewer before continuing.",
    });
  }
  return device;
}

async function currentPanelContexts(ctx: QueryCtx, eventId: Id<"events">, personId: Id<"people">,
) {
  const memberships = await ctx.db
    .query("reviewPanelMembers")
    .withIndex("by_event_person_status", (index) =>
      index.eq("eventId", eventId).eq("personId", personId).eq("status", "active"),
    )
    .take(maximumReviewRoundsPerEvent + 1);
  if (memberships.length > maximumReviewRoundsPerEvent) {
    throw new Error("A reviewer exceeds the event review-round limit.");
  }
  const contexts = (
    await Promise.all(
      memberships.map(async (membership) => {
        const [round, panel] = await Promise.all([
          ctx.db.get(membership.roundId),
          ctx.db.get(membership.panelId),
        ]);
        if (!round || !panel || round.eventId !== eventId || panel.eventId !== eventId) {
          throw new Error("A current panel membership has an invalid round or panel.",
          );
        }
        if (!["published", "open", "closing"].includes(round.status) || panel.status === "closed") {
          return null;
        }
        return { membership, round, panel };
      }),
    )
  ).filter((context): context is PanelContext => context !== null);
  return contexts.sort((left, right) => left.round.sequence - right.round.sequence,
  );
}

async function currentReserveContexts(
  ctx: QueryCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
) {
  const [available, paged] = await Promise.all([
    ctx.db
      .query("reviewRoundReserves")
      .withIndex("by_event_person_status", (index) =>
        index.eq("eventId", eventId).eq("personId", personId).eq("status", "available"),
      )
      .take(maximumReviewRoundsPerEvent + 1),
    ctx.db
      .query("reviewRoundReserves")
      .withIndex("by_event_person_status", (index) =>
        index.eq("eventId", eventId).eq("personId", personId).eq("status", "paged"),
      )
      .take(maximumReviewRoundsPerEvent + 1),
  ]);
  const reserves = [...available, ...paged];
  if (reserves.length > maximumReviewRoundsPerEvent) {
    throw new Error("A reviewer exceeds the event review-round limit.");
  }
  const contexts = await Promise.all(
    reserves.map(async (reserve) => {
      if (reserve.status !== "available" && reserve.status !== "paged") {
        throw new Error("A current reserve index returned a terminal assignment.",
        );
      }
      const round = await ctx.db.get(reserve.roundId);
      if (!round || round.eventId !== eventId) {
        throw new Error("A current reserve assignment has an invalid round.");
      }
      if (!["published", "open", "closing"].includes(round.status)) return null;
      return {
        reserveId: reserve._id,
        reserveStatus: reserve.status,
        round,
      };
    }),
  );
  return contexts
    .filter((context): context is NonNullable<typeof context> => context !== null,
    )
    .sort((left, right) => left.round.sequence - right.round.sequence);
}

async function currentReviewContext(
  ctx: QueryCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
): Promise<CurrentReviewContext | null> {
  const assignments = await ctx.db
    .query("reviewAssignments")
    .withIndex("by_event_person_status", (index) =>
      index.eq("eventId", eventId).eq("reviewerPersonId", personId).eq("status", "assigned"),
    )
    .take(maximumReviewerAssignmentsPerEvent + 1);
  if (assignments.length > maximumReviewerAssignmentsPerEvent) {
    throw new Error("A reviewer exceeds the event review-assignment limit.");
  }
  const liveAssignments = (
    await Promise.all(
      assignments.map(async (assignment) => {
        const session = await ctx.db.get(assignment.reviewSessionId);
        if (!session || session.eventId !== eventId) {
          throw new Error("A review assignment has an invalid session.");
        }
        return liveReview(session.status) ? { assignment, session } : null;
      }),
    )
  ).filter((context): context is ActiveAssignmentContext => context !== null);
  if (liveAssignments.length > 1) {
    throw new Error("A reviewer has more than one live review assignment.");
  }
  if (liveAssignments[0]) {
    return { ...liveAssignments[0], correctionScorecard: null };
  }
  const corrections = await ctx.db
    .query("scorecards")
    .withIndex("by_event_reviewer_status", (index) =>
      index.eq("eventId", eventId).eq("reviewerPersonId", personId).eq("status", "correction_open"),
    )
    .take(2);
  if (corrections.length > 1) {
    throw new Error("A reviewer has more than one open scorecard correction.");
  }
  const correctionScorecard = corrections[0];
  if (!correctionScorecard) return null;
  const [assignment, session] = await Promise.all([
    ctx.db.get(correctionScorecard.assignmentId),
    ctx.db.get(correctionScorecard.reviewSessionId),
  ]);
  if (
    !assignment ||
    !session ||
    assignment.status !== "assigned" ||
    assignment.reviewerPersonId !== personId ||
    assignment.reviewSessionId !== session._id ||
    session.eventId !== eventId ||
    session.status !== "completed"
  ) {
    throw new Error("An open scorecard correction has an invalid review assignment.",
    );
  }
  return { assignment, session, correctionScorecard };
}

async function firstReadablePanelContext(
  ctx: QueryCtx,
  eventId: Id<"events">,
  eventAccessSubjectId: Id<"eventAccessSubjects">,
  contexts: readonly PanelContext[],
) {
  const readable = await Promise.all(
    contexts.map(async (context) => {
      const grantIds = await matchingPermissionGrantIds(ctx, {
        eventId,
        eventAccessSubjectId,
        permissionKey: "panel.read",
        scopeType: "panel",
        scopeId: context.panel._id,
      });
      return grantIds.length > 0 ? context : null;
    }),
  );
  return (
    readable.find((context): context is PanelContext => context !== null) ?? null
  );
}

async function firstReadableReserveContext(
  ctx: QueryCtx,
  eventId: Id<"events">,
  eventAccessSubjectId: Id<"eventAccessSubjects">,
  contexts: Awaited<ReturnType<typeof currentReserveContexts>>,
) {
  const readable = await Promise.all(
    contexts.map(async (context) => {
      const grantIds = await matchingPermissionGrantIds(ctx, {
        eventId,
        eventAccessSubjectId,
        permissionKey: "round.read",
        scopeType: "round",
        scopeId: context.round._id,
      });
      return grantIds.length > 0 ? context : null;
    }),
  );
  return readable.find((context) => context !== null) ?? null;
}

async function canReadReview(
  ctx: QueryCtx,
  eventId: Id<"events">,
  eventAccessSubjectId: Id<"eventAccessSubjects">,
  reviewSessionId: Id<"reviewSessions">,
) {
  const grantIds = await matchingPermissionGrantIds(ctx, {
    eventId,
    eventAccessSubjectId,
    permissionKey: "review.read",
    scopeType: "review",
    scopeId: reviewSessionId,
  });
  return grantIds.length > 0;
}

export const registerDevice = mutation({
  args: {
    eventSlug: v.string(),
    installationId: v.string(),
    name: v.string(),
    platform: v.union(v.literal("android"), v.literal("ios")),
    appBuild: v.number(),
    cameraReady: v.boolean(),
    pushToken: v.optional(v.string()),
    pushProvider: v.optional(v.union(v.literal("fcm"), v.literal("apns"))),
    pushEnvironment: v.optional(v.union(v.literal("development"), v.literal("production")),
    ),
    encryptedDraftReady: v.boolean(),
    expectedVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ deviceId: v.id("reviewerDevices"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const installationId = args.installationId.trim().toLowerCase();
    const requestedPush = normalizeNativePushRegistration({
      token: args.pushToken,
      provider: args.pushProvider,
      environment: args.pushEnvironment,
      platform: args.platform,
    });
    const requestedPushFingerprint = requestedPush
      ? pushTokenFingerprint(requestedPush.token)
      : undefined;
    if (
      !/^[a-f0-9-]{36}$/.test(installationId) ||
      !Number.isInteger(args.appBuild) ||
      args.appBuild < 1
    ) {
      throw new ConvexError({
        code: "INVALID_REVIEWER_DEVICE",
        message: "The reviewer device identifier or build is invalid.",
      });
    }
    const requestFingerprint = operationFingerprint([
      installationId,
      args.name,
      args.platform,
      args.appBuild,
      args.cameraReady,
      requestedPush?.token ?? null,
      requestedPush?.provider ?? null,
      requestedPush?.environment ?? null,
      args.encryptedDraftReady,
      args.expectedVersion,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "reviewer.device.register",
      requestFingerprint,
    });
    if (prior) {
      const deviceId = ctx.db.normalizeId("reviewerDevices", prior.targetId);
      if (!deviceId) throw new Error("Prior reviewer-device result is invalid.");
      return {
        deviceId,
        version: storedOperationVersion(prior.resultJson, "reviewer device"),
      };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "reviewer.device.register",
      scopeType: "self",
      scopeId: subject._id,
    });
    const current = await ctx.db
      .query("reviewerDevices")
      .withIndex("by_event_installation", (index) =>
        index.eq("eventId", event._id).eq("installationId", installationId),
      )
      .unique();
    const tokenDevice = requestedPushFingerprint
      ? await ctx.db
          .query("reviewerDevices")
          .withIndex("by_event_push_fingerprint", (index) =>
            index.eq("eventId", event._id).eq("pushTokenFingerprint", requestedPushFingerprint),
          )
          .unique()
      : null;
    if (current && (current.personId !== person._id || current.status !== "active")) {
      throw new ConvexError({
        code: "REVIEWER_DEVICE_UNAVAILABLE",
        message: "This device registration is unavailable. Ask operations to review it.",
      });
    }
    if ((current?.version ?? 0) !== args.expectedVersion) {
      throw new ConvexError({
        code: "REVIEWER_DEVICE_CHANGED",
        message: "The device registration changed. Refresh before continuing.",
      });
    }
    if (
      requestedPush !== undefined &&
      tokenDevice?.pushTokenStatus === "invalid" &&
      tokenDevice.pushToken === requestedPush.token
    ) {
      throw new ConvexError({
        code: "PUSH_TOKEN_REJECTED",
        message:
          "The notification provider rejected this phone token. Re-enable notifications or reinstall the signed build before retrying.",
      });
    }
    const now = Date.now();
    const pushTokenStatus = requestedPush ? ("active" as const) : ("not_registered" as const);
    if (tokenDevice && tokenDevice._id !== current?._id) {
      await ctx.db.patch(tokenDevice._id, {
        pushToken: undefined,
        pushTokenFingerprint: undefined,
        pushProvider: undefined,
        pushEnvironment: undefined,
        pushTokenStatus: "not_registered",
        pushTokenUpdatedAt: now,
        pushTokenInvalidatedAt: undefined,
        pushTokenFailureCode: undefined,
        version: tokenDevice.version + 1,
      });
    }
    const fields = {
      eventId: event._id,
      personId: person._id,
      installationId,
      name: normalizedText(args.name, "Device name", 2, 80),
      platform: args.platform,
      appBuild: args.appBuild,
      cameraReady: args.cameraReady,
      encryptedDraftReady: args.encryptedDraftReady,
      ...(requestedPush
        ? {
            pushToken: requestedPush.token,
            pushTokenFingerprint: pushTokenFingerprint(requestedPush.token),
            pushProvider: requestedPush.provider,
            pushEnvironment: requestedPush.environment,
          }
        : {}),
      pushTokenStatus,
      pushTokenUpdatedAt: now,
      status: "active" as const,
      version: args.expectedVersion + 1,
      lastSeenAt: now,
    };
    const deviceId = current
      ? current._id
      : await ctx.db.insert("reviewerDevices", { ...fields, registeredAt: now,
        });
    if (current) {
      await ctx.db.patch(current._id, {
        ...fields,
        ...(requestedPush === undefined
          ? {
              pushToken: undefined,
              pushTokenFingerprint: undefined,
              pushProvider: undefined,
              pushEnvironment: undefined,
            }
          : {}),
        pushTokenInvalidatedAt: undefined,
        pushTokenFailureCode: undefined,
      });
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "reviewer.device.register",
      requestFingerprint,
      targetType: "reviewer_device",
      targetId: deviceId,
      resultJson: String(args.expectedVersion + 1),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "reviewer.device.register",
      grantIds,
      scopeType: "self",
      scopeId: subject._id,
      action: "reviewer.device_registered",
      targetType: "reviewer_device",
      targetId: deviceId,
      ...(current
        ? { previousSummary: JSON.stringify({ build: current.appBuild, version: current.version,
            }),
          }
        : {}),
      nextSummary: JSON.stringify({
        build: args.appBuild,
        pushTokenStatus,
        version: args.expectedVersion + 1,
        ...(tokenDevice && tokenDevice._id !== current?._id
          ? { replacedPushDeviceId: tokenDevice._id }
          : {}),
      }),
      reason: "Reviewer registered the current signed app installation",
    });
    return { deviceId, version: args.expectedVersion + 1 };
  },
});

const criterionView = v.object({
  id: v.id("reviewRubricCriteria"),
  stableKey: v.string(),
  label: v.string(),
  question: v.string(),
  guidance: v.string(),
  weight: v.number(),
  displayOrder: v.number(),
  anchors: v.object({
    zero: v.string(),
    one: v.string(),
    two: v.string(),
    three: v.string(),
    four: v.string(),
  }),
});

const reviewerProjectView = v.object({
  initialIdea: v.string(),
  additionalInformation: v.optional(v.string()),
  intakeResponses: v.array(
    v.object({
      ordinal: v.number(),
      question: v.string(),
      answer: v.string(),
    }),
  ),
  submittedAt: v.number(),
  latestCheckpoint: v.union(
    v.null(),
    v.object({
      checkpointKey: v.string(),
      displayName: v.string(),
      updateText: v.string(),
      followUpQuestion: v.string(),
      followUpAnswer: v.string(),
      timing: v.union(v.literal("on_time"), v.literal("late")),
      submittedAt: v.number(),
    }),
  ),
});

const reviewerEvidenceView = v.object({
  id: v.id("reviewEvidenceCheckpointSets"),
  completeness: v.union(v.literal("complete"), v.literal("partial"), v.literal("missing"),
  ),
  capturedResourceCount: v.number(),
  expectedResourceCount: v.number(),
  github: v.array(
    v.object({
      bindingId: v.id("githubRepositoryBindings"),
      repositoryName: v.string(),
      repositoryUrl: v.string(),
      kind: repositoryKind,
      purpose: v.string(),
      trackedBranch: v.string(),
      rootPath: v.optional(v.string()),
      requiredTopic: v.string(),
      stateAtCapture: v.string(),
      snapshot: v.union(
        v.null(),
        v.object({
          id: v.id("githubRepositorySnapshots"),
          headSha: v.string(),
          topicState: v.string(),
          commitCount: v.number(),
          additions: v.number(),
          deletions: v.number(),
          changedFiles: v.number(),
          languageBytes: v.array(v.object({ language: v.string(), bytes: v.number() }),
          ),
          completeness: v.string(),
          compareTruncated: v.boolean(),
          providerCommitAt: v.optional(v.number()),
          capturedAt: v.number(),
        }),
      ),
    }),
  ),
  figmaFileUrl: v.optional(v.string()),
});

const reviewerWorkspaceDataView = v.object({
  id: v.id("reviewSessions"),
  project: reviewerProjectView,
  evidence: reviewerEvidenceView,
  criteria: v.array(criterionView),
});

const reviewerTeamContextView = v.object({
  team: v.object({
    id: v.id("teams"),
    name: v.string(),
    publicCode: v.string(),
    memberCount: v.number(),
    projectVersion: v.number(),
    projectSubmittedAt: v.number(),
  }),
  priorReviews: v.array(
    v.object({
      id: v.id("reviewSessions"),
      roundName: v.string(),
      roundSequence: v.number(),
      panelName: v.string(),
      outcome: v.union(v.literal("completed"), v.literal("cancelled")),
      startedAt: v.optional(v.number()),
      endedAt: v.number(),
      sharedFindings: v.optional(v.string()),
      sharedCommitments: v.optional(v.string()),
    }),
  ),
});

const reviewerWorkspaceView = v.object({
  id: v.id("reviewSessions"),
  project: reviewerProjectView,
  evidence: reviewerEvidenceView,
  criteria: v.array(criterionView),
  teamContext: reviewerTeamContextView,
});

export const dutyStatus = query({
  args: { eventSlug: v.string(), installationId: v.string() },
  returns: v.object({
    deviceRegistered: v.boolean(),
    assignment: v.union(v.literal("panel"), v.literal("reserve"), v.null()),
    review: v.union(
      v.null(),
      v.object({
        reviewerPresenceConfirmed: v.boolean(),
        scoredCount: v.number(),
        criterionCount: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const installationId = args.installationId.trim().toLowerCase();
    const [device, panelContexts, reserveContexts, candidateReviewContext] = await Promise.all([
      ctx.db
        .query("reviewerDevices")
        .withIndex("by_event_installation", (index) =>
          index.eq("eventId", event._id).eq("installationId", installationId),
        )
        .unique(),
      currentPanelContexts(ctx, event._id, person._id),
      currentReserveContexts(ctx, event._id, person._id),
      currentReviewContext(ctx, event._id, person._id),
    ]);
    if (device && (device.personId !== person._id || device.status !== "active")) {
      throw new ConvexError({
        code: "REVIEWER_DEVICE_UNAVAILABLE",
        message: "This device registration is unavailable to the signed-in account.",
      });
    }
    const [panelContext, reserveContext, reviewContextReadable] = await Promise.all([
      firstReadablePanelContext(ctx, event._id, subject._id, panelContexts),
      firstReadableReserveContext(ctx, event._id, subject._id, reserveContexts,
        ),
      candidateReviewContext
        ? canReadReview(ctx, event._id, subject._id, candidateReviewContext.session._id,
            )
        : Promise.resolve(false),
    ]);
    const reviewContext = reviewContextReadable ? candidateReviewContext : null;
    let review = null;
    if (reviewContext) {
      const [scorecard, presence] = await Promise.all([
        reviewContext.correctionScorecard ??
          ctx.db
            .query("scorecards")
            .withIndex("by_session_reviewer", (index) =>
              index
                .eq("reviewSessionId", reviewContext.session._id)
                .eq("reviewerPersonId", person._id),
            )
            .unique(),
        ctx.db
          .query("reviewPresence")
          .withIndex("by_session_reviewer", (index) =>
            index
              .eq("reviewSessionId", reviewContext.session._id)
              .eq("reviewerPersonId", person._id),
          )
          .unique(),
      ]);
      if (
        !scorecard ||
        scorecard.eventId !== event._id ||
        scorecard.assignmentId !== reviewContext.assignment._id
      ) {
        throw new Error("A current review has an invalid scorecard.");
      }
      review = {
        reviewerPresenceConfirmed: presence !== null,
        scoredCount: scorecard.ratings.length,
        criterionCount: reviewContext.assignment.assignedCriterionIds.length,
      };
    }
    return {
      deviceRegistered: device !== null,
      assignment: panelContext ? "panel" as const : reserveContext ? "reserve" as const : null,
      review,
    };
  },
});

export const now = query({
  args: { eventSlug: v.string(), installationId: v.string() },
  returns: v.object({
    serverNow: v.number(),
    device: v.union(
      v.null(),
      v.object({
        id: v.id("reviewerDevices"),
        name: v.string(),
        appBuild: v.number(),
        cameraReady: v.boolean(),
        notificationsReady: v.boolean(),
        pushTokenStatus: v.union(
          v.literal("not_registered"),
          v.literal("active"),
          v.literal("invalid"),
        ),
        pushTokenFingerprint: v.optional(v.string()),
        encryptedDraftReady: v.boolean(),
        version: v.number(),
      }),
    ),
    panel: v.union(
      v.null(),
      v.object({
        id: v.id("reviewPanels"),
        name: v.string(),
        isCoordinator: v.boolean(),
        round: v.object({
          id: v.id("reviewRounds"),
          name: v.string(),
          status: v.string(),
          startsAt: v.number(),
          endsAt: v.number(),
          reviewerReportAt: v.number(),
          minimumReviewerBuild: v.number(),
          requiresCamera: v.boolean(),
          requiresNotifications: v.boolean(),
          isPaused: v.boolean(),
        }),
      }),
    ),
    reserve: v.union(
      v.null(),
      v.object({
        id: v.id("reviewRoundReserves"),
        status: v.union(v.literal("available"), v.literal("paged")),
        round: v.object({
          id: v.id("reviewRounds"),
          name: v.string(),
          status: v.string(),
          startsAt: v.number(),
          endsAt: v.number(),
          reviewerReportAt: v.number(),
          minimumReviewerBuild: v.number(),
          requiresCamera: v.boolean(),
          requiresNotifications: v.boolean(),
          isPaused: v.boolean(),
        }),
      }),
    ),
    review: v.union(
      v.null(),
      v.object({
        id: v.id("reviewSessions"),
        status: v.string(),
        version: v.number(),
        startedAt: v.optional(v.number()),
        plannedEndAt: v.optional(v.number()),
        extensionCount: v.number(),
        submittedScorecardCount: v.number(),
        sharedNotesComplete: v.boolean(),
        sharedFindings: v.optional(v.string()),
        sharedCommitments: v.optional(v.string()),
        sharedNotesVersion: v.number(),
        // The panel walks to the team, so the table hangs off the team.
        team: v.object({
          id: v.id("teams"),
          name: v.string(),
        }),
        round: v.object({ id: v.id("reviewRounds"), name: v.string() }),
        panel: v.object({ id: v.id("reviewPanels"), name: v.string() }),
        assignment: v.object({
          id: v.id("reviewAssignments"),
          isCoordinator: v.boolean(),
          reviewerPresenceConfirmed: v.boolean(),
          reviewerPresenceCount: v.number(),
          reviewerCount: v.number(),
          submittedScorecardCount: v.number(),
          completionReady: v.boolean(),
        }),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const installationId = args.installationId.trim().toLowerCase();
    const device = await ctx.db
      .query("reviewerDevices")
      .withIndex("by_event_installation", (index) =>
        index.eq("eventId", event._id).eq("installationId", installationId),
      )
      .unique();
    if (device && (device.personId !== person._id || device.status !== "active")) {
      throw new ConvexError({
        code: "REVIEWER_DEVICE_UNAVAILABLE",
        message: "This device registration is unavailable to the signed-in account.",
      });
    }
    const deviceView = device
      ? {
          id: device._id,
          name: device.name,
          appBuild: device.appBuild,
          cameraReady: device.cameraReady,
          notificationsReady: device.pushTokenStatus === "active",
          pushTokenStatus: device.pushTokenStatus,
          ...(device.pushToken !== undefined
            ? { pushTokenFingerprint: pushTokenFingerprint(device.pushToken) }
            : {}),
          encryptedDraftReady: device.encryptedDraftReady,
          version: device.version,
        }
      : null;
    const panelMemberships = await ctx.db
      .query("reviewPanelMembers")
      .withIndex("by_event_person_status", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id).eq("status", "active"),
      )
      .take(maximumReviewRoundsPerEvent + 1);
    if (panelMemberships.length > maximumReviewRoundsPerEvent) {
      throw new Error("A reviewer exceeds the event review-round limit.");
    }
    const panelContexts: PanelContext[] = [];
    for (const membership of panelMemberships) {
      const [round, panel] = await Promise.all([
        ctx.db.get(membership.roundId),
        ctx.db.get(membership.panelId),
      ]);
      if (
        round &&
        panel &&
        round.eventId === event._id &&
        panel.eventId === event._id &&
        ["published", "open", "closing"].includes(round.status) &&
        panel.status !== "closed"
      ) {
        panelContexts.push({ membership, round, panel });
      }
    }
    panelContexts.sort((left, right) => left.round.sequence - right.round.sequence,
    );
    const panelContext = await firstReadablePanelContext(
      ctx,
      event._id,
      subject._id,
      panelContexts,
    );
    let panelView: PanelView | null = null;
    if (panelContext) {
      const roundPause = await activeRoundPause(ctx, panelContext.round._id);
      panelView = {
        id: panelContext.panel._id,
        name: panelContext.panel.name,
        isCoordinator: panelContext.membership.isCoordinator,
        round: {
          id: panelContext.round._id,
          name: panelContext.round.name,
          status: panelContext.round.status,
          startsAt: panelContext.round.startsAt,
          endsAt: panelContext.round.endsAt,
          reviewerReportAt: panelContext.round.reviewerReportAt,
          minimumReviewerBuild: panelContext.round.minimumReviewerBuild,
          requiresCamera: panelContext.round.requiresCamera,
          requiresNotifications: panelContext.round.requiresNotifications,
          isPaused: roundPause !== null,
        },
      };
    }

    const [availableReserves, pagedReserves] = await Promise.all([
      ctx.db
        .query("reviewRoundReserves")
        .withIndex("by_event_person_status", (index) =>
          index.eq("eventId", event._id).eq("personId", person._id).eq("status", "available"),
        )
        .take(maximumReviewRoundsPerEvent + 1),
      ctx.db
        .query("reviewRoundReserves")
        .withIndex("by_event_person_status", (index) =>
          index.eq("eventId", event._id).eq("personId", person._id).eq("status", "paged"),
        )
        .take(maximumReviewRoundsPerEvent + 1),
    ]);
    const reserveRows = [...availableReserves, ...pagedReserves];
    if (reserveRows.length > maximumReviewRoundsPerEvent) {
      throw new Error("A reviewer exceeds the event review-round limit.");
    }
    const reserveContexts: Array<{
      reserveId: Id<"reviewRoundReserves">;
      reserveStatus: "available" | "paged";
      round: Doc<"reviewRounds">;
    }> = [];
    for (const reserve of reserveRows) {
      if (reserve.status !== "available" && reserve.status !== "paged") {
        throw new Error("A current reserve index returned a terminal assignment.",
        );
      }
      const round = await ctx.db.get(reserve.roundId);
      if (round && ["published", "open", "closing"].includes(round.status)) {
        reserveContexts.push({
          reserveId: reserve._id,
          reserveStatus: reserve.status,
          round,
        });
      }
    }
    reserveContexts.sort((left, right) => left.round.sequence - right.round.sequence,
    );
    const reserveContext = await firstReadableReserveContext(
      ctx,
      event._id,
      subject._id,
      reserveContexts,
    );
    let reserveView: ReserveView | null = null;
    if (reserveContext && !panelContext) {
      const roundPause = await activeRoundPause(ctx, reserveContext.round._id);
      reserveView = {
        id: reserveContext.reserveId,
        status: reserveContext.reserveStatus,
        round: {
          id: reserveContext.round._id,
          name: reserveContext.round.name,
          status: reserveContext.round.status,
          startsAt: reserveContext.round.startsAt,
          endsAt: reserveContext.round.endsAt,
          reviewerReportAt: reserveContext.round.reviewerReportAt,
          minimumReviewerBuild: reserveContext.round.minimumReviewerBuild,
          requiresCamera: reserveContext.round.requiresCamera,
          requiresNotifications: reserveContext.round.requiresNotifications,
          isPaused: roundPause !== null,
        },
      };
    }

    const assignments = await ctx.db
      .query("reviewAssignments")
      .withIndex("by_event_person_status", (index) =>
        index.eq("eventId", event._id).eq("reviewerPersonId", person._id).eq("status", "assigned"),
      )
      .take(maximumReviewerAssignmentsPerEvent + 1);
    if (assignments.length > maximumReviewerAssignmentsPerEvent) {
      throw new Error("A reviewer exceeds the event review-assignment limit.");
    }
    const activeAssignments: ActiveAssignmentContext[] = [];
    for (const assignment of assignments) {
      const session = await ctx.db.get(assignment.reviewSessionId);
      if (session && session.eventId === event._id && liveReview(session.status)) {
        activeAssignments.push({ assignment, session });
      }
    }
    if (activeAssignments.length > 1) {
      throw new Error("A reviewer has more than one live review assignment.");
    }
    let active = activeAssignments[0] ?? null;
    if (!active) {
      const correctionScorecards = await ctx.db
        .query("scorecards")
        .withIndex("by_event_reviewer_status", (index) =>
          index
            .eq("eventId", event._id)
            .eq("reviewerPersonId", person._id)
            .eq("status", "correction_open"),
        )
        .take(2);
      if (correctionScorecards.length > 1) {
        throw new Error("A reviewer has more than one open scorecard correction.",
        );
      }
      const correctionScorecard = correctionScorecards[0];
      if (correctionScorecard) {
        const [assignment, session] = await Promise.all([
          ctx.db.get(correctionScorecard.assignmentId),
          ctx.db.get(correctionScorecard.reviewSessionId),
        ]);
        if (
          !assignment ||
          !session ||
          assignment.status !== "assigned" ||
          assignment.reviewerPersonId !== person._id ||
          assignment.reviewSessionId !== session._id ||
          session.status !== "completed"
        ) {
          throw new Error("An open scorecard correction has an invalid review assignment.",
          );
        }
        active = { assignment, session };
      }
    }
    const activeIsReadable = active
      ? await canReadReview(ctx, event._id, subject._id, active.session._id)
      : false;
    if (!active || !activeIsReadable) {
      return {
        serverNow: Date.now(),
        device: deviceView,
        panel: panelView,
        reserve: reserveView,
        review: null,
      };
    }
    const [team, round, panel, assignmentRows, presences, scorecards] = await Promise.all([
      ctx.db.get(active.session.teamId),
      ctx.db.get(active.session.roundId),
      ctx.db.get(active.session.panelId),
      ctx.db
        .query("reviewAssignments")
        .withIndex("by_session_person", (index) => index.eq("reviewSessionId", active.session._id))
        .take(maximumReviewerAssignmentsPerEvent + 1),
      ctx.db
        .query("reviewPresence")
        .withIndex("by_session_reviewer", (index) => index.eq("reviewSessionId", active.session._id))
        .take(maximumReviewerAssignmentsPerEvent + 1),
      ctx.db
        .query("scorecards")
        .withIndex("by_session_reviewer", (index) => index.eq("reviewSessionId", active.session._id))
        .take(maximumReviewerAssignmentsPerEvent + 1),
    ]);
    if (!team || !round || !panel) {
      throw new Error("The active review context is incomplete.");
    }
    if (
      assignmentRows.length > maximumReviewerAssignmentsPerEvent ||
      presences.length > maximumReviewerAssignmentsPerEvent ||
      scorecards.length > maximumReviewerAssignmentsPerEvent
    ) {
      throw new Error("The active review exceeds the event assignment limit.");
    }
    const activeScorecards = activeAssignmentScorecards(assignmentRows, scorecards);
    const assignedRows = activeScorecards.assignments;
    const assignedReviewerIds = new Set(
      assignedRows.map((assignment) => assignment.reviewerPersonId),
    );
    const currentPresences = presences.filter((presence) =>
      assignedReviewerIds.has(presence.reviewerPersonId),
    );
    const submittedReviewerIds = new Set(
      activeScorecards.scorecards
        .filter(
          (scorecard) =>
            scorecard.status === "submitted" &&
            scorecard.submittedVersionId !== undefined,
        )
        .map((scorecard) => scorecard.reviewerPersonId),
    );
    const submittedScorecardCount = submittedReviewerIds.size;
    const completionReady =
      assignedRows.length === round.requiredPanelSize &&
      submittedScorecardCount === assignedRows.length &&
      (!round.requiresSharedCommitments ||
        Boolean(active.session.sharedFindings?.trim() && active.session.sharedCommitments?.trim()));
    return {
      serverNow: Date.now(),
      device: deviceView,
      panel: panelView,
      reserve: reserveView,
      review: {
        id: active.session._id,
        status: active.session.status,
        version: active.session.version,
        ...(active.session.startedAt !== undefined ? { startedAt: active.session.startedAt } : {}),
        ...(active.session.plannedEndAt !== undefined
          ? { plannedEndAt: active.session.plannedEndAt }
          : {}),
        extensionCount: active.session.extensionCount,
        submittedScorecardCount,
        sharedNotesComplete:
          !round.requiresSharedCommitments ||
          Boolean(
            active.session.sharedFindings?.trim() &&
            active.session.sharedCommitments?.trim(),
          ),
        ...(active.session.sharedFindings !== undefined
          ? { sharedFindings: active.session.sharedFindings }
          : {}),
        ...(active.session.sharedCommitments !== undefined
          ? { sharedCommitments: active.session.sharedCommitments }
          : {}),
        sharedNotesVersion: active.session.sharedNotesVersion,
        team: {
          id: team._id,
          name: team.name,
        },
        round: { id: round._id, name: round.name },
        panel: { id: panel._id, name: panel.name },
        assignment: {
          id: active.assignment._id,
          isCoordinator: active.assignment.isCoordinator,
          reviewerPresenceConfirmed: currentPresences.some(
            (presence) => presence.reviewerPersonId === person._id,
          ),
          reviewerPresenceCount: new Set(
            currentPresences.map((presence) => presence.reviewerPersonId),
          ).size,
          reviewerCount: assignedRows.length,
          submittedScorecardCount,
          completionReady,
        },
      },
    };
  },
});

export const reviewWorkspaceData = internalQuery({
  args: { eventSlug: v.string(), reviewSessionId: v.id("reviewSessions") },
  returns: reviewerWorkspaceDataView,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const session = await ctx.db.get(args.reviewSessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({ code: "REVIEW_NOT_FOUND", message: "That review is unavailable.",
      });
    }
    const assignment = await ctx.db
      .query("reviewAssignments")
      .withIndex("by_session_person", (index) =>
        index.eq("reviewSessionId", session._id).eq("reviewerPersonId", person._id),
      )
      .unique();
    if (!assignment || assignment.status !== "assigned") {
      throw new ConvexError({
        code: "REVIEW_ASSIGNMENT_REQUIRED",
        message: "Only a reviewer assigned to this review can read its fixed workspace.",
      });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.read",
      scopeType: "review",
      scopeId: session._id,
    });
    const [team, project, evidence] = await Promise.all([
      ctx.db.get(session.teamId),
      ctx.db.get(session.projectVersionId),
      ctx.db.get(session.evidenceCheckpointSetId),
    ]);
    if (!team || !project || !evidence || team.eventId !== event._id) {
      throw new Error("The fixed review workspace is incomplete.");
    }
    if (
      project.eventId !== event._id ||
      project.teamId !== team._id ||
      evidence.eventId !== event._id ||
      evidence.roundId !== session.roundId ||
      evidence.teamId !== team._id ||
      evidence.projectVersionId !== project._id
    ) {
      throw new Error("The fixed review workspace does not match its session.");
    }
    const teamCheckpoint = evidence.teamCheckpointSubmissionId
      ? await ctx.db.get(evidence.teamCheckpointSubmissionId)
      : null;
    if (
      teamCheckpoint &&
      (teamCheckpoint.eventId !== event._id || teamCheckpoint.teamId !== team._id)
    ) {
      throw new Error("The pinned team checkpoint does not match the review workspace.",
      );
    }
    const githubEvidence = await Promise.all(
      evidence.githubEntries.map(async (entry) => {
        const snapshot = entry.snapshotId ? await ctx.db.get(entry.snapshotId) : null;
        if (entry.snapshotId !== undefined && !snapshot) {
          throw new Error("A pinned GitHub snapshot no longer resolves.");
        }
        if (
          snapshot &&
          (snapshot.eventId !== event._id ||
            snapshot.teamId !== team._id ||
            snapshot.repositoryBindingId !== entry.bindingId)
        ) {
          throw new Error("A pinned GitHub snapshot does not match its evidence entry.",
          );
        }
        return {
          bindingId: entry.bindingId,
          repositoryName: entry.repositoryName,
          repositoryUrl: entry.repositoryUrl,
          kind: entry.kind,
          purpose: entry.purpose,
          trackedBranch: entry.trackedBranch,
          ...(entry.rootPath !== undefined ? { rootPath: entry.rootPath } : {}),
          requiredTopic: entry.requiredTopic,
          stateAtCapture: entry.stateAtCapture,
          snapshot: snapshot
            ? {
                id: snapshot._id,
                headSha: snapshot.headSha,
                topicState: snapshot.topicState,
                commitCount: snapshot.commitCount,
                additions: snapshot.additions,
                deletions: snapshot.deletions,
                changedFiles: snapshot.changedFiles,
                languageBytes: snapshot.languageBytes,
                completeness: snapshot.completeness,
                compareTruncated: snapshot.compareTruncated,
                ...(snapshot.providerCommitAt !== undefined
                  ? { providerCommitAt: snapshot.providerCommitAt }
                  : {}),
                capturedAt: snapshot.capturedAt,
              }
            : null,
        };
      }),
    );
    const criteria: Doc<"reviewRubricCriteria">[] = [];
    for (const criterionId of assignment.assignedCriterionIds) {
      const criterion = await ctx.db.get(criterionId);
      if (!criterion || criterion.rubricVersionId !== session.rubricVersionId) {
        throw new Error("The fixed criterion assignment is invalid.");
      }
      criteria.push(criterion);
    }
    criteria.sort((left, right) => left.displayOrder - right.displayOrder);
    return {
      id: session._id,
      project: {
        initialIdea: project.initialIdea,
        ...(project.additionalInformation !== undefined
          ? { additionalInformation: project.additionalInformation }
          : {}),
        intakeResponses: project.intakeResponses.map((response) => ({
          ordinal: response.ordinal,
          question: response.question,
          answer: response.answer,
        })),
        submittedAt: project.submittedAt,
        latestCheckpoint: teamCheckpoint
          ? {
              checkpointKey: teamCheckpoint.checkpointKey,
              displayName: teamCheckpoint.displayName,
              updateText: teamCheckpoint.updateText,
              followUpQuestion: teamCheckpoint.followUpQuestion,
              followUpAnswer: teamCheckpoint.followUpAnswer,
              timing: teamCheckpoint.timing,
              submittedAt: teamCheckpoint.submittedAt,
            }
          : null,
      },
      evidence: {
        id: evidence._id,
        completeness: evidence.completeness,
        capturedResourceCount: evidence.capturedResourceCount,
        expectedResourceCount: evidence.expectedResourceCount,
        github: githubEvidence,
        ...(evidence.figmaFileUrl ? { figmaFileUrl: evidence.figmaFileUrl } : {}),
      },
      criteria: criteria.map((criterion) => ({
        id: criterion._id,
        stableKey: criterion.stableKey,
        label: criterion.label,
        question: criterion.question,
        guidance: criterion.guidance,
        weight: criterion.weight,
        displayOrder: criterion.displayOrder,
        anchors: criterion.anchors,
      })),
    };
  },
});

export const scorecard = query({
  args: { eventSlug: v.string(), reviewSessionId: v.id("reviewSessions") },
  returns: v.object({
    id: v.id("scorecards"),
    status: v.string(),
    draftVersion: v.number(),
    ratings: v.array(ratingInput),
    privateNote: v.optional(v.string()),
    finalComment: v.optional(v.string()),
    requiresFinalComment: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const session = await ctx.db.get(args.reviewSessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({ code: "REVIEW_NOT_FOUND", message: "That review is unavailable.",
      });
    }
    const [assignment, scorecard] = await Promise.all([
      ctx.db
        .query("reviewAssignments")
        .withIndex("by_session_person", (index) =>
          index.eq("reviewSessionId", session._id).eq("reviewerPersonId", person._id),
        )
        .unique(),
      ctx.db
        .query("scorecards")
        .withIndex("by_session_reviewer", (index) =>
          index.eq("reviewSessionId", session._id).eq("reviewerPersonId", person._id),
        )
        .unique(),
    ]);
    if (
      !assignment ||
      assignment.status !== "assigned" ||
      !scorecard ||
      scorecard.eventId !== event._id ||
      scorecard.assignmentId !== assignment._id
    ) {
      throw new ConvexError({
        code: "REVIEW_ASSIGNMENT_REQUIRED",
        message: "Only a reviewer assigned to this review can read its scorecard.",
      });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.read",
      scopeType: "review",
      scopeId: session._id,
    });
    const round = await ctx.db.get(scorecard.roundId);
    if (!round) throw new Error("The scorecard round is missing.");
    return {
      id: scorecard._id,
      requiresFinalComment: round.requiresFinalComment,
      status: scorecard.status,
      draftVersion: scorecard.draftVersion,
      ratings: scorecard.ratings,
      ...(scorecard.privateNote !== undefined ? { privateNote: scorecard.privateNote }
        : {}),
      ...(scorecard.finalComment !== undefined
        ? { finalComment: scorecard.finalComment } : {}),
    };
  },
});

// Expose only shared prior-review artifacts; prior scores could bias the next panel.
export const teamContextData = internalQuery({
  args: { eventSlug: v.string(), reviewSessionId: v.id("reviewSessions") },
  returns: reviewerTeamContextView,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const session = await ctx.db.get(args.reviewSessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({ code: "REVIEW_NOT_FOUND", message: "That review is unavailable.",
      });
    }
    const assignment = await ctx.db
      .query("reviewAssignments")
      .withIndex("by_session_person", (index) =>
        index.eq("reviewSessionId", session._id).eq("reviewerPersonId", person._id),
      )
      .unique();
    if (!assignment || assignment.status !== "assigned") {
      throw new ConvexError({
        code: "REVIEW_ASSIGNMENT_REQUIRED",
        message: "Only a reviewer assigned to this review can read its team context.",
      });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.read",
      scopeType: "review",
      scopeId: session._id,
    });
    const [team, project, teamSessions] = await Promise.all([
      ctx.db.get(session.teamId),
      ctx.db.get(session.projectVersionId),
      ctx.db
        .query("reviewSessions")
        .withIndex("by_team_created", (index) => index.eq("teamId", session.teamId),
        )
        .order("desc")
        .take(priorReviewHistoryLimit + 1),
    ]);
    if (!team || !project || team.eventId !== event._id || project.teamId !== team._id) {
      throw new Error("The review team context is incomplete.");
    }
    const priorReviews = [];
    for (const prior of teamSessions) {
      // A cancelled session is history; another active session is not.
      if (prior._id === session._id || prior.eventId !== event._id) continue;
      if (prior.status !== "completed" && prior.status !== "cancelled") continue;
      const [round, panel] = await Promise.all([
        ctx.db.get(prior.roundId),
        ctx.db.get(prior.panelId),
      ]);
      if (!round || !panel || round.eventId !== event._id || panel.eventId !== event._id) {
        throw new Error("A prior review references a round or panel outside this event.",
        );
      }
      const completed = prior.status === "completed";
      priorReviews.push({
        id: prior._id,
        roundName: round.name,
        roundSequence: round.sequence,
        panelName: panel.name,
        outcome: prior.status,
        ...(prior.startedAt !== undefined ? { startedAt: prior.startedAt } : {}),
        endedAt: (completed ? prior.completedAt : prior.cancelledAt) ?? prior.updatedAt,
        // Only completed sessions expose the panel's final shared notes.
        ...(completed && prior.sharedFindings !== undefined
          ? { sharedFindings: prior.sharedFindings }
          : {}),
        ...(completed && prior.sharedCommitments !== undefined
          ? { sharedCommitments: prior.sharedCommitments }
          : {}),
      });
      if (priorReviews.length === priorReviewHistoryLimit) break;
    }
    return {
      team: {
        id: team._id,
        name: team.name,
        publicCode: team.publicCode,
        memberCount: project.lockedMemberCount,
        projectVersion: project.version,
        projectSubmittedAt: project.submittedAt,
      },
      priorReviews,
    };
  },
});

export const reviewWorkspace = action({
  args: { eventSlug: v.string(), reviewSessionId: v.id("reviewSessions") },
  returns: reviewerWorkspaceView,
  handler: async (ctx, args): Promise<Infer<typeof reviewerWorkspaceView>> => {
    const [workspace, teamContext] = await Promise.all([
      ctx.runQuery(internal.reviewer.reviewWorkspaceData, args),
      ctx.runQuery(internal.reviewer.teamContextData, args),
    ]);
    return { ...workspace, teamContext };
  },
});

export const confirmPresence = mutation({
  args: {
    eventSlug: v.string(),
    installationId: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    payload: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    reviewSessionId: v.id("reviewSessions"),
    teamName: v.string(),
    roundName: v.string(),
    reviewerPresenceCount: v.number(),
    reviewerCount: v.number(),
    confirmedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const payload = args.payload.trim();
    const isQrPayload = /^c2c-review-v1\.[a-f0-9]{64}$/.test(payload);
    const manualCode = payload.toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
    if (!isQrPayload && !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/.test(manualCode)) {
      throw new ConvexError({
        code: "INVALID_TEAM_QR",
        message: "This is not a current Code2Create team code.",
      });
    }
    const requestFingerprint = operationFingerprint([args.reviewSessionId, args.installationId,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.presence.confirm",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "review presence confirmation",
        reviewPresenceOperationResult,
      );
      const reviewSessionId = ctx.db.normalizeId("reviewSessions", result.reviewSessionId,
      );
      if (!reviewSessionId || reviewSessionId !== prior.targetId) {
        throw new Error("The stored review presence confirmation is invalid.");
      }
      return {
        reviewSessionId,
        teamName: result.teamName,
        roundName: result.roundName,
        reviewerPresenceCount: result.reviewerPresenceCount,
        reviewerCount: result.reviewerCount,
        confirmedAt: result.confirmedAt,
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const token = isQrPayload
      ? await ctx.db
          .query("reviewTeamQrTokens")
          .withIndex("by_digest", (index) => index.eq("tokenDigest", reviewTokenDigest(payload)),
          )
          .unique()
      : await ctx.db
          .query("reviewTeamQrTokens")
          .withIndex("by_manual_digest", (index) =>
            index.eq("manualCodeDigest", reviewTokenDigest(manualCode)),
          )
          .unique();
    if (
      !token ||
      token.eventId !== event._id ||
      token.state !== "active" ||
      token.expiresAt <= Date.now()
    ) {
      throw new ConvexError({
        code: "TEAM_QR_EXPIRED",
        message: "This team QR expired. Ask the team to refresh it.",
      });
    }
    if (token.reviewSessionId !== args.reviewSessionId) {
      throw new ConvexError({
        code: "REVIEW_QR_SESSION_MISMATCH",
        message:
          "This code belongs to a different review. Scan the code shown by the current team.",
      });
    }
    const session = await ctx.db.get(args.reviewSessionId);
    if (
      !session ||
      session.eventId !== event._id ||
      session.teamId !== token.teamId ||
      session.status !== "awaiting_presence"
    ) {
      throw new ConvexError({
        code: "REVIEW_NOT_WAITING",
        message: "This team is no longer waiting for reviewer scans.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.presence.confirm",
      scopeType: "review",
      scopeId: session._id,
    });
    const [device, assignment, currentPresence, team, round, panel] = await Promise.all([
      requireReviewerDevice(ctx, {
        eventId: event._id,
        personId: person._id,
        installationId: args.installationId,
      }),
      ctx.db
        .query("reviewAssignments")
        .withIndex("by_session_person", (index) =>
          index.eq("reviewSessionId", session._id).eq("reviewerPersonId", person._id),
        )
        .unique(),
      ctx.db
        .query("reviewPresence")
        .withIndex("by_session_reviewer", (index) =>
          index.eq("reviewSessionId", session._id).eq("reviewerPersonId", person._id),
        )
        .unique(),
      ctx.db.get(session.teamId),
      ctx.db.get(session.roundId),
      ctx.db.get(session.panelId),
    ]);
    if (!assignment || assignment.status !== "assigned" || !team || !round || !panel) {
      throw new ConvexError({
        code: "REVIEW_ASSIGNMENT_CHANGED",
        message: "This reviewer is no longer assigned to the scanned team.",
      });
    }
    const assignedRows = await ctx.db
      .query("reviewAssignments")
      .withIndex("by_session_person", (index) => index.eq("reviewSessionId", session._id),
      )
      .collect();
    if (currentPresence) {
      const allPresence = await ctx.db
        .query("reviewPresence")
        .withIndex("by_session_reviewer", (index) => index.eq("reviewSessionId", session._id),
        )
        .collect();
      const result = {
        reviewSessionId: session._id,
        teamName: team.name,
        roundName: round.name,
        reviewerPresenceCount: allPresence.length,
        reviewerCount: assignedRows.filter((row) => row.status === "assigned").length,
        confirmedAt: currentPresence.confirmedAt,
      };
      await recordOperation(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        clientOperationId: args.clientOperationId,
        commandName: "review.presence.confirm",
        requestFingerprint,
        targetType: "review_session",
        targetId: session._id,
        resultJson: JSON.stringify(result),
        createdAt: Date.now(),
      });
      return result;
    }
    const state = await ctx.db
      .query("teamRoundStates")
      .withIndex("by_round_team", (index) => index.eq("roundId", round._id).eq("teamId", team._id),
      )
      .unique();
    if (!state || !["called", "at_table"].includes(state.state) || state.panelId !== panel._id) {
      throw new ConvexError({
        code: "QUEUE_STATE_CHANGED",
        message: "The team is not currently called to this panel.",
      });
    }
    const now = Date.now();
    await ctx.db.insert("reviewPresence", {
      eventId: event._id,
      reviewSessionId: session._id,
      reviewerPersonId: person._id,
      reviewerDeviceId: device._id,
      method: isQrPayload ? "qr" : "fallback_code",
      tokenVersion: token.tokenVersion,
      confirmedAt: now,
    });
    if (state.state === "called") {
      await patchTeamRoundState(ctx, state, {
        state: "at_table",
        version: state.version + 1,
        updatedByPersonId: person._id,
        updatedAt: now,
      });
    }
    await ctx.db.patch(device._id, { lastSeenAt: now, version: device.version + 1,
    });
    const allPresence = await ctx.db
      .query("reviewPresence")
      .withIndex("by_session_reviewer", (index) => index.eq("reviewSessionId", session._id),
      )
      .collect();
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.presence.confirm",
      grantIds,
      scopeType: "review",
      scopeId: session._id,
      action: "review.reviewer_presence_confirmed",
      targetType: "review_presence",
      targetId: assignment._id,
      nextSummary: JSON.stringify({
        reviewSessionId: session._id,
        tokenVersion: token.tokenVersion,
        reviewerPresenceCount: allPresence.length,
      }),
      reason: "Assigned reviewer scanned the current team QR",
    });
    const result = {
      reviewSessionId: session._id,
      teamName: team.name,
      roundName: round.name,
      reviewerPresenceCount: allPresence.length,
      reviewerCount: assignedRows.filter((row) => row.status === "assigned").length,
      confirmedAt: now,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.presence.confirm",
      requestFingerprint,
      targetType: "review_session",
      targetId: session._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    return result;
  },
});

export const reportConflict = mutation({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ conflictId: v.id("reviewerConflicts"), teamName: v.string(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Conflict reason", 3, 500);
    const requestFingerprint = operationFingerprint([args.reviewSessionId, person._id, reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "reviewer.conflict.report",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "reviewer conflict",
        reviewerConflictOperationResult,
      );
      const conflictId = ctx.db.normalizeId("reviewerConflicts", result.conflictId,
      );
      if (!conflictId || conflictId !== prior.targetId) {
        throw new Error("The stored reviewer-conflict result is invalid.");
      }
      return { conflictId, teamName: result.teamName };
    }
    const session = await ctx.db.get(args.reviewSessionId);
    if (!session || session.eventId !== event._id || session.status !== "awaiting_presence") {
      throw new ConvexError({
        code: "CONFLICT_REPORT_WINDOW_CLOSED",
        message: "A reviewer conflict must be reported before the review starts.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.conflict.report",
      scopeType: "review",
      scopeId: session._id,
    });
    const [team, assignment, state, assignments, scorecards, tokens, existingConflict,
    ] =
      await Promise.all([
        ctx.db.get(session.teamId),
        ctx.db
          .query("reviewAssignments")
          .withIndex("by_session_person", (index) =>
            index.eq("reviewSessionId", session._id).eq("reviewerPersonId", person._id),
          )
          .unique(),
        ctx.db
          .query("teamRoundStates")
          .withIndex("by_round_team", (index) =>
            index.eq("roundId", session.roundId).eq("teamId", session.teamId),
          )
          .unique(),
        ctx.db
          .query("reviewAssignments")
          .withIndex("by_session_person", (index) => index.eq("reviewSessionId", session._id),
        )
          .collect(),
        ctx.db
          .query("scorecards")
          .withIndex("by_session_status", (index) => index.eq("reviewSessionId", session._id),
        )
          .collect(),
        ctx.db
          .query("reviewTeamQrTokens")
          .withIndex("by_session_state", (index) => index.eq("reviewSessionId", session._id),
        )
          .collect(),
        ctx.db
          .query("reviewerConflicts")
          .withIndex("by_reviewer_team_status", (index) =>
            index
              .eq("reviewerPersonId", person._id)
              .eq("teamId", session.teamId)
              .eq("status", "active"),
          )
          .first(),
      ]);
    if (
      !team ||
      !assignment ||
      assignment.status !== "assigned" ||
      !state ||
      !["called", "at_table"].includes(state.state) ||
      state.panelId !== session.panelId
    ) {
      throw new ConvexError({
        code: "REVIEW_ASSIGNMENT_CHANGED",
        message: "The called team or reviewer assignment changed before the conflict was saved.",
      });
    }
    const now = Date.now();
    const conflictId =
      existingConflict?._id ??
      (await ctx.db.insert("reviewerConflicts", {
        eventId: event._id,
        reviewerPersonId: person._id,
        teamId: team._id,
        kind: "declared",
        reason,
        status: "active",
        createdByPersonId: person._id,
        createdAt: now,
      }));
    for (const row of assignments) {
      await ctx.db.patch(row._id, {
        status: row.reviewerPersonId === person._id ? "conflict" : "removed",
        endedAt: now,
      });
      await revokeSourceGrants(ctx, {
        eventId: event._id,
        sourceType: "panel_assignment",
        sourceId: row._id,
        revokedByPersonId: person._id,
        reason: "Review cancelled after a declared reviewer conflict",
      });
    }
    for (const scorecard of scorecards) {
      await ctx.db.patch(scorecard._id, {
        status: "void",
        version: scorecard.version + 1,
        updatedAt: now,
      });
    }
    for (const token of tokens.filter((candidate) => candidate.state === "active",
    )) {
      await ctx.db.patch(token._id, { state: "superseded" });
    }
    await ctx.db.patch(session._id, {
      status: "cancelled",
      cancelledAt: now,
      version: session.version + 1,
      updatedAt: now,
    });
    await patchTeamRoundState(ctx, state, {
      panelId: undefined,
      state: "unassigned",
      queuedAt: undefined,
      calledAt: undefined,
      callAttemptCount: 0,
      lastCallAttemptAt: undefined,
      holdReason: undefined,
      stateBeforeHold: undefined,
      heldAt: undefined,
      missedAt: undefined,
      version: state.version + 1,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    const result = { conflictId, teamName: team.name };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "reviewer.conflict.report",
      requestFingerprint,
      targetType: "reviewer_conflict",
      targetId: conflictId,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.conflict.report",
      grantIds,
      scopeType: "review",
      scopeId: session._id,
      action: "reviewer.conflict_declared",
      targetType: "reviewer_conflict",
      targetId: conflictId,
      previousSummary: JSON.stringify({
        reviewSessionId: session._id,
        reviewStatus: session.status,
        teamRoundState: state.state,
      }),
      nextSummary: JSON.stringify({
        reviewSessionId: session._id,
        reviewStatus: "cancelled",
        teamRoundState: "unassigned",
      }),
      reason,
    });
    return result;
  },
});

async function scorecardWriteContext(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    personId: Id<"people">;
    installationId: string;
    scorecardId: Id<"scorecards">;
  },
) {
  const [device, scorecard] = await Promise.all([
    requireReviewerDevice(ctx, {
      eventId: args.eventId,
      personId: args.personId,
      installationId: args.installationId,
    }),
    ctx.db.get(args.scorecardId),
  ]);
  if (
    !scorecard ||
    scorecard.eventId !== args.eventId ||
    scorecard.reviewerPersonId !== args.personId
  ) {
    throw new ConvexError({
      code: "SCORECARD_NOT_FOUND",
      message: "That scorecard is unavailable.",
    });
  }
  const [session, assignment, rubric, round] = await Promise.all([
    ctx.db.get(scorecard.reviewSessionId),
    ctx.db.get(scorecard.assignmentId),
    ctx.db.get(scorecard.rubricVersionId),
    ctx.db.get(scorecard.roundId),
  ]);
  if (
    !session ||
    !assignment ||
    !rubric ||
    !round ||
    round.eventId !== args.eventId ||
    round.status !== "open" ||
    rubric.eventId !== args.eventId ||
    assignment.status !== "assigned" ||
    assignment.reviewSessionId !== session._id ||
    assignment.reviewerPersonId !== args.personId
  ) {
    throw new ConvexError({
      code: "SCORECARD_ASSIGNMENT_CHANGED",
      message: "The fixed scorecard assignment is no longer active.",
    });
  }
  return { device, scorecard, session, assignment, rubric, round };
}

async function scorecardWriteMode(
  ctx: MutationCtx,
  context: Awaited<ReturnType<typeof scorecardWriteContext>>,
) {
  const [draftManualRecord, submittedManualRecord] = await Promise.all([
    ctx.db
      .query("manualReviewRecords")
      .withIndex("by_review_status_created", (index) =>
        index.eq("reviewSessionId", context.session._id).eq("status", "draft"),
      )
      .first(),
    ctx.db
      .query("manualReviewRecords")
      .withIndex("by_review_status_created", (index) =>
        index.eq("reviewSessionId", context.session._id).eq("status", "submitted"),
      )
      .first(),
  ]);
  if (draftManualRecord || submittedManualRecord) {
    throw new ConvexError({
      code: "PAPER_REVIEW_PENDING",
      message: "A paper review record is awaiting independent verification.",
    });
  }
  if (context.scorecard.status === "draft" &&
    ["active", "scoring"].includes(context.session.status)) {
    return { kind: "live" as const };
  }
  const correctionCaseId = context.scorecard.activeCorrectionCaseId;
  if (
    context.scorecard.status !== "correction_open" ||
    context.session.status !== "completed" ||
    !correctionCaseId
  ) {
    throw new ConvexError({
      code: "SCORECARD_NOT_WRITABLE",
      message: "This scorecard is not open for editing.",
    });
  }
  const [correctionCase, round, evaluation] = await Promise.all([
    ctx.db.get(correctionCaseId),
    ctx.db.get(context.scorecard.roundId),
    ctx.db
      .query("reviewEvaluations")
      .withIndex("by_session", (index) => index.eq("reviewSessionId", context.session._id),
      )
      .unique(),
  ]);
  if (
    !correctionCase ||
    correctionCase.kind !== "correction" ||
    correctionCase.state !== "open" ||
    correctionCase.scorecardId !== context.scorecard._id ||
    context.scorecard.submittedVersionId !== correctionCase.originalVersionId ||
    !round ||
    round.status !== "open" ||
    context.rubric._id !== round.rubricVersionId ||
    !evaluation ||
    evaluation.state !== "complete"
  ) {
    throw new ConvexError({
      code: "CORRECTION_CHANGED",
      message: "The correction window or review result changed. Refresh before editing.",
    });
  }
  return {
    kind: "correction" as const,
    correctionCase,
    round,
    rubric: context.rubric,
    evaluation,
  };
}

export const saveDraft = mutation({
  args: {
    eventSlug: v.string(),
    installationId: v.string(),
    scorecardId: v.id("scorecards"),
    ratings: v.array(ratingInput),
    privateNote: v.optional(v.string()),
    finalComment: v.optional(v.string()),
    expectedDraftVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ scorecardId: v.id("scorecards"), draftVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const requestFingerprint = operationFingerprint([
      args.scorecardId,
      args.expectedDraftVersion,
      JSON.stringify(args.ratings),
      args.privateNote ?? null,
      args.finalComment ?? null,
      args.installationId,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "scorecard.draft.save",
      requestFingerprint,
    });
    if (prior) {
      const scorecardId = ctx.db.normalizeId("scorecards", prior.targetId);
      if (!scorecardId) throw new Error("Prior scorecard draft result is invalid.");
      return {
        scorecardId,
        draftVersion: storedOperationVersion(prior.resultJson, "scorecard draft",
        ),
      };
    }
    const context = await scorecardWriteContext(ctx, {
      eventId: event._id,
      personId: person._id,
      installationId: args.installationId,
      scorecardId: args.scorecardId,
    });
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "scorecard.draft.write",
      scopeType: "scorecard",
      scopeId: context.scorecard._id,
    });
    await scorecardWriteMode(ctx, context);
    if (context.scorecard.draftVersion !== args.expectedDraftVersion) {
      throw new ConvexError({
        code: "SCORECARD_CHANGED",
        message: "The review or scorecard changed. Compare the current draft before saving.",
      });
    }
    const ratings = cleanAssignedRatings(
      args.ratings,
      context.assignment.assignedCriterionIds,
      context.rubric.scoreMinimum,
      context.rubric.scoreMaximum,
    );
    const privateNote = args.privateNote?.trim();
    const now = Date.now();
    await ctx.db.patch(context.scorecard._id, {
      ratings,
      finalComment: requireFinalComment(args.finalComment, false),
      ...(privateNote
        ? { privateNote: normalizedText(privateNote, "Private note", 1, 2_000) }
        : { privateNote: undefined }),
      draftVersion: context.scorecard.draftVersion + 1,
      version: context.scorecard.version + 1,
      updatedAt: now,
    });
    await ctx.db.patch(context.device._id, {
      lastSeenAt: now,
      version: context.device.version + 1,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "scorecard.draft.save",
      requestFingerprint,
      targetType: "scorecard",
      targetId: context.scorecard._id,
      resultJson: String(context.scorecard.draftVersion + 1),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "scorecard.draft.write",
      grantIds,
      scopeType: "scorecard",
      scopeId: context.scorecard._id,
      action: "scorecard.draft_saved",
      targetType: "scorecard",
      targetId: context.scorecard._id,
      previousSummary: JSON.stringify({
        draftVersion: context.scorecard.draftVersion,
        answeredCriteria: context.scorecard.ratings.length,
      }),
      nextSummary: JSON.stringify({
        draftVersion: context.scorecard.draftVersion + 1,
        answeredCriteria: ratings.length,
      }),
      reason: "Reviewer saved their own scorecard draft",
    });
    return {
      scorecardId: context.scorecard._id,
      draftVersion: context.scorecard.draftVersion + 1,
    };
  },
});

export const submitScorecard = mutation({
  args: {
    eventSlug: v.string(),
    installationId: v.string(),
    scorecardId: v.id("scorecards"),
    expectedDraftVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    scorecardId: v.id("scorecards"),
    scorecardVersionId: v.id("scorecardVersions"),
    submittedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const requestFingerprint = operationFingerprint([
      args.scorecardId,
      args.expectedDraftVersion,
      args.installationId,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "scorecard.submit",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "scorecard submission",
        scorecardSubmissionOperationResult,
      );
      const scorecardId = ctx.db.normalizeId("scorecards", result.scorecardId);
      const scorecardVersionId = ctx.db.normalizeId("scorecardVersions", result.scorecardVersionId,
      );
      if (!scorecardId || !scorecardVersionId || scorecardVersionId !== prior.targetId) {
        throw new Error("The stored scorecard submission is invalid.");
      }
      return {
        scorecardId,
        scorecardVersionId,
        submittedAt: result.submittedAt,
      };
    }
    const context = await scorecardWriteContext(ctx, {
      eventId: event._id,
      personId: person._id,
      installationId: args.installationId,
      scorecardId: args.scorecardId,
    });
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "scorecard.submit",
      scopeType: "scorecard",
      scopeId: context.scorecard._id,
    });
    const writeMode = await scorecardWriteMode(ctx, context);
    if (context.scorecard.draftVersion !== args.expectedDraftVersion) {
      throw new ConvexError({
        code: "SCORECARD_CHANGED",
        message: "The review or scorecard changed. Refresh before submitting.",
      });
    }
    if (
      writeMode.kind === "live" &&
      context.session.status === "active" &&
      context.session.plannedEndAt !== undefined &&
      Date.now() < context.session.plannedEndAt
    ) {
      throw new ConvexError({
        code: "DISCUSSION_IN_PROGRESS",
        message: "Submit after the discussion ends. Your draft stays saved.",
      });
    }
    const ratings = requireCompleteAssignedRatings(
      cleanAssignedRatings(
        context.scorecard.ratings,
        context.assignment.assignedCriterionIds,
        context.rubric.scoreMinimum,
        context.rubric.scoreMaximum,
      ),
      context.assignment.assignedCriterionIds,
      context.rubric.scoreMinimum,
      context.rubric.scoreMaximum,
    );
    const finalComment = requireFinalComment(
      context.scorecard.finalComment,
      context.round.requiresFinalComment,
    );
    const previousVersion = await ctx.db
      .query("scorecardVersions")
      .withIndex("by_scorecard_version", (index) => index.eq("scorecardId", context.scorecard._id),
      )
      .order("desc")
      .first();
    const version = (previousVersion?.version ?? 0) + 1;
    const now = Date.now();
    const checksum = operationFingerprint([
      context.scorecard._id,
      context.scorecard.rubricVersionId,
      version,
      JSON.stringify(ratings),
      context.scorecard.privateNote ?? null,
      finalComment ?? null,
    ]);
    const scorecardVersionId = await ctx.db.insert("scorecardVersions", {
      eventId: event._id,
      roundId: context.scorecard.roundId,
      reviewSessionId: context.session._id,
      scorecardId: context.scorecard._id,
      reviewerPersonId: person._id,
      version,
      rubricVersionId: context.scorecard.rubricVersionId,
      ratings,
      ...(context.scorecard.privateNote !== undefined
        ? { privateNote: context.scorecard.privateNote }
        : {}),
      ...(finalComment !== undefined ? { finalComment }
        : {}),
      checksum,
      clientOperationId: args.clientOperationId,
      ...(writeMode.kind === "correction"
        ? {
            correctionCaseId: writeMode.correctionCase._id,
            supersedesVersionId: writeMode.correctionCase.originalVersionId,
          }
        : {}),
      submittedAt: now,
    });
    await ctx.db.patch(context.scorecard._id, {
      status: "submitted",
      submittedVersionId: scorecardVersionId,
      activeCorrectionCaseId: undefined,
      submittedAt: now,
      version: context.scorecard.version + 1,
      updatedAt: now,
    });
    if (writeMode.kind === "correction") {
      await ctx.db.patch(writeMode.correctionCase._id, {
        state: "closed",
        replacementVersionId: scorecardVersionId,
        closedAt: now,
        version: writeMode.correctionCase.version + 1,
      });
      await recomputeReviewEvaluation(ctx, {
        round: writeMode.round,
        session: context.session,
        rubric: writeMode.rubric,
        evaluation: writeMode.evaluation,
        computedAt: now,
      });
    }
    await ctx.db.patch(context.device._id, {
      lastSeenAt: now,
      version: context.device.version + 1,
    });
    const result = {
      scorecardId: context.scorecard._id,
      scorecardVersionId,
      submittedAt: now,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "scorecard.submit",
      requestFingerprint,
      targetType: "scorecard_version",
      targetId: scorecardVersionId,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "scorecard.submit",
      grantIds,
      scopeType: "scorecard",
      scopeId: context.scorecard._id,
      action: "scorecard.submitted",
      targetType: "scorecard_version",
      targetId: scorecardVersionId,
      previousSummary: JSON.stringify({
        status: context.scorecard.status,
        draftVersion: context.scorecard.draftVersion,
      }),
      nextSummary: JSON.stringify({
        status: "submitted",
        scorecardVersion: version,
        criterionCount: ratings.length,
        checksum,
        ...(writeMode.kind === "correction"
          ? {
              correctionCaseId: writeMode.correctionCase._id,
              supersedesVersionId: writeMode.correctionCase.originalVersionId,
              evaluationVersion: writeMode.evaluation.version + 1,
            }
          : {}),
      }),
      reason:
        writeMode.kind === "correction"
          ? "Reviewer submitted the authorised scorecard correction"
          : "Reviewer submitted their own complete scorecard",
    });
    return result;
  },
});
