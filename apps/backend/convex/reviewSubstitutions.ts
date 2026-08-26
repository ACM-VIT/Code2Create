import { ConvexError, v } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import {
  reviewerCallConsentPolicyVersion,
  reviewerCallScriptPolicyVersion,
} from "./outboundCallConsents";
import { advanceAccessVersion } from "./lib/accessVersion";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { teamRoundTableLabel } from "./lib/floor";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
} from "./lib/operations";
import { appendReviewPanelVacancyReadFactById } from "./lib/operationsAutonomyReadFacts";
import {
  insertPermissionGrant,
  matchingPermissionGrantIds,
  requirePermission,
  revokeSourceGrants,
} from "./lib/permissions";
import { pushTokenFingerprint } from "./lib/pushTokens";
import { grantPanelMemberAccess, grantReviewAssignmentAccess } from "./lib/reviewAccess";
import {
  reviewerCoversStaffingWindow,
  reviewerNoShowBoundary,
} from "./lib/reviewerAvailability";
import {
  maximumReviewPanelsPerRound,
  maximumReviewerAssignmentsPerEvent,
  maximumReviewersPerPanel,
  maximumReviewReservesPerRound,
} from "./lib/reviewLimits";
import { normalizedText } from "./lib/strings";
import {
  enqueueOutboundCall,
  reviewerPageCallScript,
} from "./lib/outboundCalls";
import {
  reviewerPageChainState,
  reviewerPageState,
  reviewerPushDeliveryState,
  outboundCallDeliveryState,
  reviewRoundReserveStatus,
} from "./values";

type ReadCtx = QueryCtx | MutationCtx;
type SubstituteScope = {
  pageGrantIds: Id<"permissionGrants">[];
  assignmentGrantIds: Id<"permissionGrants">[];
  scopeType: "panel" | "review";
  scopeId: string;
};
type EligibleReserve = {
  reserve: Doc<"reviewRoundReserves">;
  person: Doc<"people">;
  subject: Doc<"eventAccessSubjects">;
  clockIn: Doc<"reviewerClockIns">;
  device: Doc<"reviewerDevices">;
};
type SentPage = {
  pageId: Id<"reviewerPages">;
  targetPersonId: Id<"people">;
  expiresAt: number;
} | null;

const liveReviewStatuses = ["awaiting_presence", "active", "overdue"] as const;
const reviewerLivenessWindowMs = 120_000;
const activeChainState = "active" as const;
const exhaustedChainState = "exhausted" as const;
const sentPageState = "sent" as const;
const openedPageState = "opened" as const;
const acceptedPageState = "accepted" as const;
const declinedPageState = "declined" as const;
const expiredPageState = "expired" as const;

const reviewerNoShowOperationResult = z
  .object({
    panelId: z.string().min(1),
    panelMemberId: z.string().min(1),
    panelVersion: z.number().int().positive(),
  })
  .strict();

const pageChainOperationResult = z
  .object({
    pageChainId: z.string().min(1),
    pageId: z.string().min(1).optional(),
    state: z.enum(["active", "exhausted"]),
  })
  .strict();

const pageResponseOperationResult = z
  .object({
    pageId: z.string().min(1),
    state: z.enum(["accepted", "declined", "expired"]),
    panelMemberId: z.string().min(1).optional(),
    reviewAssignmentId: z.string().min(1).optional(),
    nextPageId: z.string().min(1).optional(),
  })
  .strict();

async function substituteScope(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    panelId: Id<"reviewPanels">;
    reviewSessionId?: Id<"reviewSessions">;
  },
): Promise<SubstituteScope | null> {
  if (args.reviewSessionId !== undefined) {
    const [pageGrantIds, assignmentGrantIds] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        eventId: args.eventId,
        eventAccessSubjectId: args.eventAccessSubjectId,
        permissionKey: "review.substitute.page",
        scopeType: "review",
        scopeId: args.reviewSessionId,
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: args.eventId,
        eventAccessSubjectId: args.eventAccessSubjectId,
        permissionKey: "review.substitute.assign",
        scopeType: "review",
        scopeId: args.reviewSessionId,
      }),
    ]);
    if (pageGrantIds.length > 0 && assignmentGrantIds.length > 0) {
      return {
        pageGrantIds,
        assignmentGrantIds,
        scopeType: "review",
        scopeId: args.reviewSessionId,
      };
    }
  }
  const [pageGrantIds, assignmentGrantIds] = await Promise.all([
    matchingPermissionGrantIds(ctx, {
      eventId: args.eventId,
      eventAccessSubjectId: args.eventAccessSubjectId,
      permissionKey: "review.substitute.page",
      scopeType: "panel",
      scopeId: args.panelId,
    }),
    matchingPermissionGrantIds(ctx, {
      eventId: args.eventId,
      eventAccessSubjectId: args.eventAccessSubjectId,
      permissionKey: "review.substitute.assign",
      scopeType: "panel",
      scopeId: args.panelId,
    }),
  ]);
  return pageGrantIds.length > 0 && assignmentGrantIds.length > 0
    ? { pageGrantIds, assignmentGrantIds, scopeType: "panel", scopeId: args.panelId }
    : null;
}

async function noShowScope(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    roundId: Id<"reviewRounds">;
    reviewerPersonId: Id<"people">;
  },
) {
  const personGrantIds = await matchingPermissionGrantIds(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    permissionKey: "review.reviewer.no_show",
    scopeType: "person",
    scopeId: args.reviewerPersonId,
  });
  if (personGrantIds.length > 0) {
    return {
      grantIds: personGrantIds,
      scopeType: "person" as const,
      scopeId: args.reviewerPersonId,
    };
  }
  const roundGrantIds = await matchingPermissionGrantIds(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    permissionKey: "review.reviewer.no_show",
    scopeType: "round",
    scopeId: args.roundId,
  });
  return roundGrantIds.length > 0
    ? { grantIds: roundGrantIds, scopeType: "round" as const, scopeId: args.roundId }
    : null;
}

async function criterionKeys(
  ctx: ReadCtx,
  round: Doc<"reviewRounds">,
  criterionIds: readonly Id<"reviewRubricCriteria">[],
) {
  const keys: string[] = [];
  for (const criterionId of criterionIds) {
    const criterion = await ctx.db.get(criterionId);
    if (
      !criterion ||
      criterion.eventId !== round.eventId ||
      criterion.rubricVersionId !== round.rubricVersionId
    ) {
      throw new Error("A substitute request references an invalid published criterion.");
    }
    keys.push(criterion.stableKey);
  }
  if (keys.length === 0 || new Set(keys).size !== keys.length) {
    throw new Error("A substitute request must preserve distinct published criteria.");
  }
  return keys;
}

async function eligibleReserve(
  ctx: ReadCtx,
  args: {
    reserve: Doc<"reviewRoundReserves">;
    round: Doc<"reviewRounds">;
    requiredCriterionKeys: readonly string[];
    now: number;
    status: "available" | "paged";
    teamId?: Id<"teams">;
    ignoredPageId?: Id<"reviewerPages">;
    installationId?: string;
  },
): Promise<EligibleReserve | null> {
  if (
    args.reserve.eventId !== args.round.eventId ||
    args.reserve.roundId !== args.round._id ||
    args.reserve.status !== args.status
  ) {
    return null;
  }
  const [person, subject, profile, clockIn, activePanelMember, sentPages, openedPages] =
    await Promise.all([
      ctx.db.get(args.reserve.personId),
      ctx.db.get(args.reserve.eventAccessSubjectId),
      ctx.db
        .query("reviewerProfiles")
        .withIndex("by_event_person", (index) =>
          index.eq("eventId", args.round.eventId).eq("personId", args.reserve.personId),
        )
        .unique(),
      ctx.db
        .query("reviewerClockIns")
        .withIndex("by_round_person", (index) =>
          index
            .eq("roundId", args.round._id)
            .eq("reviewerPersonId", args.reserve.personId),
        )
        .unique(),
      ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_round_person_status", (index) =>
          index
            .eq("roundId", args.round._id)
            .eq("personId", args.reserve.personId)
            .eq("status", "active"),
        )
        .unique(),
      ctx.db
        .query("reviewerPages")
        .withIndex("by_event_person_state_expiry", (index) =>
          index
            .eq("eventId", args.round.eventId)
            .eq("targetPersonId", args.reserve.personId)
            .eq("state", "sent")
            .gt("expiresAt", args.now),
        )
        .take(2),
      ctx.db
        .query("reviewerPages")
        .withIndex("by_event_person_state_expiry", (index) =>
          index
            .eq("eventId", args.round.eventId)
            .eq("targetPersonId", args.reserve.personId)
            .eq("state", "opened")
            .gt("expiresAt", args.now),
        )
        .take(2),
    ]);
  if (
    !person ||
    person.status !== "active" ||
    !subject ||
    subject.eventId !== args.round.eventId ||
    subject.personId !== person._id ||
    subject.status !== "active" ||
    !profile ||
    profile.status !== "active" ||
    profile.trainingStatus !== "complete" ||
    !reviewerCoversStaffingWindow(profile.availabilityWindows, args.round) ||
    !clockIn ||
    clockIn.status !== "present" ||
    args.now - clockIn.lastHeartbeatAt > reviewerLivenessWindowMs ||
    activePanelMember
  ) {
    return null;
  }
  const profileKeys = new Set(profile.criterionKeys);
  if (args.requiredCriterionKeys.some((key) => !profileKeys.has(key))) return null;
  const activePages = [...sentPages, ...openedPages];
  if (activePages.length > 1) {
    throw new Error("A reviewer has more than one active substitute page in this event.");
  }
  const hasOtherPage = activePages.some((page) => page._id !== args.ignoredPageId);
  if (hasOtherPage) return null;
  const device = await ctx.db.get(clockIn.reviewerDeviceId);
  if (
    !device ||
    device.eventId !== args.round.eventId ||
    device.personId !== person._id ||
    device.status !== "active" ||
    device.appBuild < args.round.minimumReviewerBuild ||
    !device.encryptedDraftReady ||
    (args.round.requiresCamera && !device.cameraReady) ||
    (args.round.requiresNotifications && device.pushTokenStatus !== "active") ||
    args.now - device.lastSeenAt > reviewerLivenessWindowMs ||
    (args.installationId !== undefined && device.installationId !== args.installationId)
  ) {
    return null;
  }
  const assignments = await ctx.db
    .query("reviewAssignments")
    .withIndex("by_event_person_status", (index) =>
      index
        .eq("eventId", args.round.eventId)
        .eq("reviewerPersonId", person._id)
        .eq("status", "assigned"),
    )
    .take(maximumReviewerAssignmentsPerEvent + 1);
  if (assignments.length > maximumReviewerAssignmentsPerEvent) {
    throw new Error("A reviewer exceeds the event assignment limit.");
  }
  for (const assignment of assignments) {
    const session = await ctx.db.get(assignment.reviewSessionId);
    if (
      session &&
      session.eventId === args.round.eventId &&
      liveReviewStatuses.some((status) => status === session.status)
    ) {
      return null;
    }
  }
  const teamId = args.teamId;
  if (teamId !== undefined) {
    const conflict = await ctx.db
      .query("reviewerConflicts")
      .withIndex("by_reviewer_team_status", (index) =>
        index
          .eq("reviewerPersonId", person._id)
          .eq("teamId", teamId)
          .eq("status", "active"),
      )
      .first();
    if (conflict) return null;
  }
  return { reserve: args.reserve, person, subject, clockIn, device };
}

/** Internal entry point used only by page handling and local fixtures. */
export async function sendNextPage(
  ctx: MutationCtx,
  pageChainId: Id<"reviewerPageChains">,
  now: number,
): Promise<SentPage> {
  const chain = await ctx.db.get(pageChainId);
  if (!chain || chain.state !== "active") return null;
  const [round, panel, missingMember, priorPages] = await Promise.all([
    ctx.db.get(chain.roundId),
    ctx.db.get(chain.panelId),
    ctx.db.get(chain.missingPanelMemberId),
    ctx.db
      .query("reviewerPages")
      .withIndex("by_chain_state_rank", (index) => index.eq("pageChainId", chain._id))
      .take(maximumReviewReservesPerRound + 1),
  ]);
  if (priorPages.length > maximumReviewReservesPerRound) {
    throw new Error("A substitute page chain exceeds the published reserve limit.");
  }
  if (
    !round ||
    !panel ||
    !missingMember ||
    round.eventId !== chain.eventId ||
    panel.eventId !== chain.eventId ||
    missingMember.eventId !== chain.eventId ||
    panel.status !== "needs_reviewer" ||
    missingMember.status !== "removed" ||
    !["published", "open"].includes(round.status) ||
    now >= round.endsAt
  ) {
    await ctx.db.patch(chain._id, {
      state: "cancelled",
      version: chain.version + 1,
      completedAt: now,
    });
    return null;
  }
  let teamId: Id<"teams"> | undefined;
  if (chain.reviewSessionId !== undefined) {
    const session = await ctx.db.get(chain.reviewSessionId);
    if (!session || session.eventId !== chain.eventId || session.status !== "awaiting_presence") {
      await ctx.db.patch(chain._id, {
        state: "cancelled",
        version: chain.version + 1,
        completedAt: now,
      });
      return null;
    }
    teamId = session.teamId;
  }
  const requiredKeys = await criterionKeys(ctx, round, chain.requiredCriterionIds);
  const attemptedPersonIds = new Set(priorPages.map((page) => page.targetPersonId));
  const reserves = await ctx.db
    .query("reviewRoundReserves")
    .withIndex("by_round_status", (index) =>
      index.eq("roundId", round._id).eq("status", "available"),
    )
    .take(maximumReviewReservesPerRound + 1);
  if (reserves.length > maximumReviewReservesPerRound) {
    throw new Error("A review round exceeds the published reserve limit.");
  }
  reserves.sort(
    (left, right) =>
      left.pageCount - right.pageCount ||
      (left.lastPagedAt ?? 0) - (right.lastPagedAt ?? 0) ||
      String(left.personId).localeCompare(String(right.personId)),
  );
  let candidate: EligibleReserve | null = null;
  for (const reserve of reserves) {
    if (attemptedPersonIds.has(reserve.personId)) continue;
    candidate = await eligibleReserve(ctx, {
      reserve,
      round,
      requiredCriterionKeys: requiredKeys,
      now,
      status: "available",
      ...(teamId !== undefined ? { teamId } : {}),
    });
    if (candidate) break;
  }
  if (!candidate) {
    await ctx.db.patch(chain._id, {
      state: "exhausted",
      version: chain.version + 1,
      completedAt: now,
    });
    return null;
  }
  const rank = chain.currentRank + 1;
  const expiresAt = now + chain.responseWindowSeconds * 1_000;
  const pageId = await ctx.db.insert("reviewerPages", {
    eventId: chain.eventId,
    roundId: chain.roundId,
    panelId: chain.panelId,
    ...(chain.reviewSessionId !== undefined
      ? { reviewSessionId: chain.reviewSessionId }
      : {}),
    pageChainId: chain._id,
    targetPersonId: candidate.person._id,
    targetEventAccessSubjectId: candidate.subject._id,
    reserveId: candidate.reserve._id,
    requiredCriterionIds: chain.requiredCriterionIds,
    rank,
    reason: `A reviewer seat on ${panel.name} needs coverage.`,
    state: "sent",
    expiresAt,
    version: 1,
    createdAt: now,
  });
  const activePushToken =
    candidate.device.pushTokenStatus === "active" &&
    candidate.device.pushProvider !== undefined &&
    candidate.device.pushEnvironment !== undefined
      ? candidate.device.pushToken
      : undefined;
  const pushAvailable = activePushToken !== undefined;
  const pushDeliveryId = await ctx.db.insert("reviewerPushDeliveries", {
    eventId: chain.eventId,
    pageId,
    targetPersonId: candidate.person._id,
    reviewerDeviceId: candidate.device._id,
    purpose: "substitute_page",
    logicalAttempt: 1,
    ...(pushAvailable
      ? { tokenFingerprint: pushTokenFingerprint(activePushToken) }
      : {}),
    state: pushAvailable ? "pending" : "unavailable",
    attemptCount: 0,
    ...(!pushAvailable ? { providerErrorCode: "push_token_unavailable", completedAt: now } : {}),
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const pageGrant = await insertPermissionGrant(ctx, {
    eventId: chain.eventId,
    personId: candidate.person._id,
    eventAccessSubjectId: candidate.subject._id,
    permissionKey: "review.page.respond",
    scopeType: "page",
    scopeId: pageId,
    sourceType: "page_assignment",
    sourceId: pageId,
    grantedByPersonId: chain.createdByPersonId,
    reason: "Active substitute page",
    validUntil: expiresAt,
  });
  if (pageGrant.created) {
    await advanceAccessVersion(ctx, candidate.subject._id, now);
  }
  await ctx.db.patch(candidate.reserve._id, {
    status: "paged",
    pageCount: candidate.reserve.pageCount + 1,
    lastPagedAt: now,
    version: candidate.reserve.version + 1,
    updatedAt: now,
  });
  await ctx.db.patch(chain._id, {
    currentRank: rank,
    version: chain.version + 1,
  });
  await ctx.scheduler.runAt(expiresAt, internal.reviewSubstitutions.expirePage, {
    pageId,
  });
  if (pushAvailable) {
    await ctx.scheduler.runAfter(0, internal.reviewPush.deliverPage, {
      deliveryId: pushDeliveryId,
    });
    /* Repeat the page until it is answered or its response window closes. */
    await ctx.scheduler.runAfter(repageIntervalMs, internal.reviewSubstitutions.repage, {
      pageId,
      logicalAttempt: 2,
    });
  } else {
    await enqueueReviewerPageCall(ctx, pageId, now);
  }
  return { pageId, targetPersonId: candidate.person._id, expiresAt };
}

async function enqueueReviewerPageCall(
  ctx: MutationCtx,
  pageId: Id<"reviewerPages">,
  now: number,
) {
  const page = await ctx.db.get(pageId);
  if (!page || (page.state !== "sent" && page.state !== "opened") || page.expiresAt <= now) {
    return null;
  }
  const [chain, round, consent] = await Promise.all([
    ctx.db.get(page.pageChainId),
    ctx.db.get(page.roundId),
    ctx.db
      .query("outboundCallConsents")
      .withIndex("by_event_person_purpose", (index) =>
        index
          .eq("eventId", page.eventId)
          .eq("personId", page.targetPersonId)
          .eq("purpose", "reviewer_substitute_page"),
      )
      .unique(),
  ]);
  if (!chain || !round || round.eventId !== page.eventId) {
    throw new Error("A reviewer page has invalid call context.");
  }
  let tableLabel: string | undefined;
  if (page.reviewSessionId !== undefined) {
    const session = await ctx.db.get(page.reviewSessionId);
    if (!session || session.eventId !== page.eventId) {
      throw new Error("A reviewer page has an invalid review session.");
    }
    tableLabel = await teamRoundTableLabel(ctx, page.roundId, session.teamId);
  }
  const currentConsent = consent?.state === "granted" &&
      consent.consentPolicyVersion === reviewerCallConsentPolicyVersion &&
      consent.scriptPolicyVersion === reviewerCallScriptPolicyVersion &&
      consent.destinationPhoneE164 !== undefined
    ? consent
    : null;
  return enqueueOutboundCall(ctx, {
    eventId: page.eventId,
    targetPersonId: page.targetPersonId,
    sourceType: "reviewer_page",
    sourceId: page._id,
    purpose: "reviewer_substitute_page",
    ...(currentConsent !== null
      ? { destinationPhone: currentConsent.destinationPhoneE164 }
      : {}),
    script: reviewerPageCallScript({
      roundName: round.name,
      ...(tableLabel !== undefined ? { tableLabel } : {}),
      responseWindowSeconds: chain.responseWindowSeconds,
    }),
    locale: "en-IN",
    scriptPolicyVersion: reviewerCallScriptPolicyVersion,
    ...(currentConsent !== null
      ? { consent: { id: currentConsent._id, version: currentConsent.version } }
      : {}),
    authorizationGrantIds: chain.pageGrantIds,
    now,
  });
}

async function expireActivePage(
  ctx: MutationCtx,
  page: Doc<"reviewerPages">,
  now: number,
  revokedByPersonId?: Id<"people">,
): Promise<SentPage> {
  if (page.state !== "sent" && page.state !== "opened") return null;
  const [chain, reserve] = await Promise.all([
    ctx.db.get(page.pageChainId),
    ctx.db.get(page.reserveId),
  ]);
  await ctx.db.patch(page._id, {
    state: "expired",
    respondedAt: now,
    version: page.version + 1,
  });
  if (reserve && reserve.status === "paged" && reserve.personId === page.targetPersonId) {
    await ctx.db.patch(reserve._id, {
      status: "available",
      version: reserve.version + 1,
      updatedAt: now,
    });
  }
  await revokeSourceGrants(ctx, {
    eventId: page.eventId,
    sourceType: "page_assignment",
    sourceId: page._id,
    ...(revokedByPersonId !== undefined ? { revokedByPersonId } : {}),
    reason: "Substitute page expired",
  });
  if (!chain || chain.state !== "active") return null;
  await ctx.db.patch(chain._id, { version: chain.version + 1 });
  return sendNextPage(ctx, chain._id, now);
}

export const markNoShow = mutation({
  args: {
    eventSlug: v.string(),
    panelMemberId: v.id("reviewPanelMembers"),
    expectedPanelVersion: v.number(),
    expectedClockInVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    panelId: v.id("reviewPanels"),
    panelMemberId: v.id("reviewPanelMembers"),
    panelVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "No-show reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.panelMemberId,
      args.expectedPanelVersion,
      args.expectedClockInVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.reviewer.no_show",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "reviewer no-show",
        reviewerNoShowOperationResult,
      );
      const panelId = ctx.db.normalizeId("reviewPanels", result.panelId);
      const panelMemberId = ctx.db.normalizeId(
        "reviewPanelMembers",
        result.panelMemberId,
      );
      if (!panelId || !panelMemberId || panelMemberId !== prior.targetId) {
        throw new Error("The stored reviewer no-show result is invalid.");
      }
      return { panelId, panelMemberId, panelVersion: result.panelVersion };
    }
    const member = await ctx.db.get(args.panelMemberId);
    if (!member || member.eventId !== event._id || member.status !== "active") {
      throw new ConvexError({
        code: "PANEL_MEMBER_CHANGED",
        message: "That reviewer is no longer an active member of this panel.",
      });
    }
    const [panel, round, clockIn] = await Promise.all([
      ctx.db.get(member.panelId),
      ctx.db.get(member.roundId),
      ctx.db
        .query("reviewerClockIns")
        .withIndex("by_round_person", (index) =>
          index
            .eq("roundId", member.roundId)
            .eq("reviewerPersonId", member.personId),
        )
        .unique(),
    ]);
    if (
      !panel ||
      !round ||
      panel.eventId !== event._id ||
      round.eventId !== event._id ||
      panel.status !== "ready" ||
      panel.version !== args.expectedPanelVersion ||
      !["published", "open"].includes(round.status) ||
      (clockIn?.version ?? 0) !== args.expectedClockInVersion
    ) {
      throw new ConvexError({
        code: "PANEL_CHANGED",
        message: "The panel, round, or reviewer arrival state changed. Refresh before continuing.",
      });
    }
    const permission = await noShowScope(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      roundId: round._id,
      reviewerPersonId: member.personId,
    });
    if (!permission) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account cannot mark that exact reviewer or round as a no-show.",
      });
    }
    if (clockIn?.status === "present") {
      throw new ConvexError({
        code: "REVIEWER_PRESENT",
        message: "A reviewer who is present cannot be marked as a no-show.",
      });
    }
    const now = Date.now();
    if (now < reviewerNoShowBoundary(round, clockIn)) {
      throw new ConvexError({
        code: "NO_SHOW_TOO_EARLY",
        message: "The published reviewer no-show grace period has not ended.",
      });
    }
    const [pendingSessions, activeSessions, overdueSessions] = await Promise.all([
      ctx.db
        .query("reviewSessions")
        .withIndex("by_panel_status", (index) =>
          index.eq("panelId", panel._id).eq("status", "awaiting_presence"),
        )
        .take(2),
      ctx.db
        .query("reviewSessions")
        .withIndex("by_panel_status", (index) =>
          index.eq("panelId", panel._id).eq("status", "active"),
        )
        .take(2),
      ctx.db
        .query("reviewSessions")
        .withIndex("by_panel_status", (index) =>
          index.eq("panelId", panel._id).eq("status", "overdue"),
        )
        .take(2),
    ]);
    if (activeSessions.length > 0 || overdueSessions.length > 0) {
      throw new ConvexError({
        code: "ACTIVE_REVIEW_ASSIGNED",
        message: "Do not replace a reviewer while their review timer is running.",
      });
    }
    if (pendingSessions.length > 1) throw new Error("A panel has more than one pending review.");
    const pendingSession = pendingSessions[0];
    const nextPanelVersion = panel.version + 1;
    if (pendingSession) {
      const [assignment, scorecard] = await Promise.all([
        ctx.db
          .query("reviewAssignments")
          .withIndex("by_session_person", (index) =>
            index
              .eq("reviewSessionId", pendingSession._id)
              .eq("reviewerPersonId", member.personId),
          )
          .unique(),
        ctx.db
          .query("scorecards")
          .withIndex("by_session_reviewer", (index) =>
            index
              .eq("reviewSessionId", pendingSession._id)
              .eq("reviewerPersonId", member.personId),
          )
          .unique(),
      ]);
      if (!assignment || assignment.status !== "assigned" || !scorecard || scorecard.status !== "draft") {
        throw new Error("The pending review does not contain the expected draft assignment.");
      }
      await ctx.db.patch(assignment._id, { status: "removed", endedAt: now });
      await revokeSourceGrants(ctx, {
        eventId: event._id,
        sourceType: "panel_assignment",
        sourceId: assignment._id,
        revokedByPersonId: person._id,
        reason,
      });
      await ctx.db.patch(scorecard._id, {
        status: "void",
        version: scorecard.version + 1,
        updatedAt: now,
      });
      await ctx.db.patch(pendingSession._id, {
        panelVersion: nextPanelVersion,
        version: pendingSession.version + 1,
        updatedAt: now,
      });
    }
    await ctx.db.patch(member._id, { status: "removed", endedAt: now });
    await revokeSourceGrants(ctx, {
      eventId: event._id,
      sourceType: "panel_assignment",
      sourceId: member._id,
      revokedByPersonId: person._id,
      reason,
    });
    if (clockIn) {
      await ctx.db.patch(clockIn._id, {
        status: "no_show",
        version: clockIn.version + 1,
      });
    }
    await ctx.db.patch(panel._id, {
      status: "needs_reviewer",
      version: nextPanelVersion,
      updatedAt: now,
    });
    await appendReviewPanelVacancyReadFactById(ctx, panel._id, now);
    const result = {
      panelId: panel._id,
      panelMemberId: member._id,
      panelVersion: nextPanelVersion,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.reviewer.no_show",
      requestFingerprint,
      targetType: "review_panel_member",
      targetId: member._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.reviewer.no_show",
      grantIds: permission.grantIds,
      scopeType: permission.scopeType,
      scopeId: permission.scopeId,
      action: "review.reviewer_marked_no_show",
      targetType: "review_panel_member",
      targetId: member._id,
      previousSummary: JSON.stringify({ panelStatus: panel.status, panelVersion: panel.version }),
      nextSummary: JSON.stringify({
        panelStatus: "needs_reviewer",
        panelVersion: nextPanelVersion,
        pendingReviewSessionId: pendingSession?._id ?? null,
      }),
      reason,
    });
    return result;
  },
});

export const startPageChain = mutation({
  args: {
    eventSlug: v.string(),
    missingPanelMemberId: v.id("reviewPanelMembers"),
    expectedPanelVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    pageChainId: v.id("reviewerPageChains"),
    pageId: v.optional(v.id("reviewerPages")),
    state: v.union(v.literal("active"), v.literal("exhausted")),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Substitute reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.missingPanelMemberId,
      args.expectedPanelVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.substitute.page",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "substitute page chain",
        pageChainOperationResult,
      );
      const pageChainId = ctx.db.normalizeId("reviewerPageChains", result.pageChainId);
      const pageId = result.pageId
        ? ctx.db.normalizeId("reviewerPages", result.pageId)
        : undefined;
      if (!pageChainId || pageChainId !== prior.targetId || (result.pageId && !pageId)) {
        throw new Error("The stored substitute-page result is invalid.");
      }
      return {
        pageChainId,
        ...(pageId ? { pageId } : {}),
        state: result.state,
      };
    }
    const missingMember = await ctx.db.get(args.missingPanelMemberId);
    if (!missingMember || missingMember.eventId !== event._id || missingMember.status !== "removed") {
      throw new ConvexError({
        code: "PANEL_VACANCY_CHANGED",
        message: "That panel vacancy no longer exists.",
      });
    }
    const [
      panel,
      round,
      latestRemovedMember,
      activeChain,
      pendingSessions,
      activeSessions,
      overdueSessions,
    ] = await Promise.all([
      ctx.db.get(missingMember.panelId),
      ctx.db.get(missingMember.roundId),
      ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status_ended", (index) =>
          index.eq("panelId", missingMember.panelId).eq("status", "removed"),
        )
        .order("desc")
        .first(),
      ctx.db
        .query("reviewerPageChains")
        .withIndex("by_panel_state", (index) =>
          index.eq("panelId", missingMember.panelId).eq("state", "active"),
        )
        .unique(),
      ctx.db
        .query("reviewSessions")
        .withIndex("by_panel_status", (index) =>
          index.eq("panelId", missingMember.panelId).eq("status", "awaiting_presence"),
        )
        .take(2),
      ctx.db
        .query("reviewSessions")
        .withIndex("by_panel_status", (index) =>
          index.eq("panelId", missingMember.panelId).eq("status", "active"),
        )
        .take(2),
      ctx.db
        .query("reviewSessions")
        .withIndex("by_panel_status", (index) =>
          index.eq("panelId", missingMember.panelId).eq("status", "overdue"),
        )
        .take(2),
    ]);
    if (
      !panel ||
      !round ||
      panel.eventId !== event._id ||
      round.eventId !== event._id ||
      panel.status !== "needs_reviewer" ||
      panel.version !== args.expectedPanelVersion ||
      latestRemovedMember?._id !== missingMember._id ||
      !["published", "open"].includes(round.status) ||
      activeChain
    ) {
      throw new ConvexError({
        code: "PANEL_VACANCY_CHANGED",
        message: "The panel vacancy, version, or existing page chain changed.",
      });
    }
    if (activeSessions.length > 0 || overdueSessions.length > 0) {
      throw new ConvexError({
        code: "ACTIVE_REVIEW_ASSIGNED",
        message: "Do not page a replacement while the review timer is running.",
      });
    }
    if (pendingSessions.length > 1) throw new Error("A panel has more than one pending review.");
    const pendingSession = pendingSessions[0];
    const permission = await substituteScope(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      panelId: panel._id,
      ...(pendingSession ? { reviewSessionId: pendingSession._id } : {}),
    });
    if (!permission) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "Paging and assigning authority are both required on the exact panel or review.",
      });
    }
    await criterionKeys(ctx, round, missingMember.assignedCriterionIds);
    const now = Date.now();
    const pageChainId = await ctx.db.insert("reviewerPageChains", {
      eventId: event._id,
      roundId: round._id,
      panelId: panel._id,
      ...(pendingSession ? { reviewSessionId: pendingSession._id } : {}),
      missingPanelMemberId: missingMember._id,
      requiredCriterionIds: missingMember.assignedCriterionIds,
      reason,
      responseWindowSeconds: round.substituteResponseSeconds,
      state: "active",
      currentRank: 0,
      version: 1,
      createdByPersonId: person._id,
      pageGrantIds: permission.pageGrantIds,
      assignmentGrantIds: permission.assignmentGrantIds,
      resolvedScopeType: permission.scopeType,
      resolvedScopeId: permission.scopeId,
      createdAt: now,
    });
    const sent = await sendNextPage(ctx, pageChainId, now);
    const savedChain = await ctx.db.get(pageChainId);
    if (!savedChain) throw new Error("Created substitute page chain no longer resolves.");
    const result = {
      pageChainId,
      ...(sent ? { pageId: sent.pageId } : {}),
      state: savedChain.state === "active" ? activeChainState : exhaustedChainState,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.substitute.page",
      requestFingerprint,
      targetType: "reviewer_page_chain",
      targetId: pageChainId,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.substitute.page",
      grantIds: permission.pageGrantIds,
      scopeType: permission.scopeType,
      scopeId: permission.scopeId,
      action: "review.substitute_page_started",
      targetType: "reviewer_page_chain",
      targetId: pageChainId,
      nextSummary: JSON.stringify({
        panelId: panel._id,
        missingPanelMemberId: missingMember._id,
        pageId: sent?.pageId ?? null,
        targetPersonId: sent?.targetPersonId ?? null,
        state: savedChain.state,
      }),
      reason,
    });
    return result;
  },
});

export const currentPage = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      id: v.id("reviewerPages"),
      state: v.union(v.literal("sent"), v.literal("opened")),
      version: v.number(),
      expiresAt: v.number(),
      // Server time prevents an incorrect device clock skewing the countdown.
      serverNow: v.number(),
      sentAt: v.number(),
      reason: v.string(),
      round: v.object({ id: v.id("reviewRounds"), name: v.string() }),
      panel: v.object({ id: v.id("reviewPanels"), name: v.string() }),
      // A page has no destination until it is tied to a team review session.
      team: v.union(
        v.null(),
        v.object({
          id: v.id("teams"),
          name: v.string(),
          tableLabel: v.optional(v.string()),
        }),
      ),
      criteria: v.array(v.object({ id: v.id("reviewRubricCriteria"), label: v.string() })),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const now = Date.now();
    const [sentPages, openedPages] = await Promise.all([
      ctx.db
        .query("reviewerPages")
        .withIndex("by_event_person_state_expiry", (index) =>
          index
            .eq("eventId", event._id)
            .eq("targetPersonId", person._id)
            .eq("state", "sent")
            .gt("expiresAt", now),
        )
        .take(2),
      ctx.db
        .query("reviewerPages")
        .withIndex("by_event_person_state_expiry", (index) =>
          index
            .eq("eventId", event._id)
            .eq("targetPersonId", person._id)
            .eq("state", "opened")
            .gt("expiresAt", now),
        )
        .take(2),
    ]);
    const active = [...sentPages, ...openedPages];
    if (active.length > 1) throw new Error("A reviewer has more than one active substitute page.");
    const page = active[0];
    if (!page) return null;
    const grantIds = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.page.respond",
      scopeType: "page",
      scopeId: page._id,
    });
    if (grantIds.length === 0) return null;
    const [round, panel] = await Promise.all([
      ctx.db.get(page.roundId),
      ctx.db.get(page.panelId),
    ]);
    if (!round || !panel || round.eventId !== event._id || panel.eventId !== event._id) {
      throw new Error("An active substitute page has an invalid round or panel.");
    }
    const criteria: Array<{ id: Id<"reviewRubricCriteria">; label: string }> = [];
    for (const criterionId of page.requiredCriterionIds) {
      const criterion = await ctx.db.get(criterionId);
      if (!criterion || criterion.rubricVersionId !== round.rubricVersionId) {
        throw new Error("An active substitute page has an invalid criterion.");
      }
      criteria.push({ id: criterion._id, label: criterion.label });
    }
    let pageTeam: { id: Id<"teams">; name: string; tableLabel?: string } | null = null;
    if (page.reviewSessionId !== undefined) {
      const session = await ctx.db.get(page.reviewSessionId);
      if (!session || session.eventId !== event._id) {
        throw new Error("An active substitute page has an invalid review session.");
      }
      const team = await ctx.db.get(session.teamId);
      if (!team || team.eventId !== event._id) {
        throw new Error("An active substitute page has an invalid team.");
      }
      const tableLabel = await teamRoundTableLabel(ctx, session.roundId, team._id);
      pageTeam = {
        id: team._id,
        name: team.name,
        ...(tableLabel !== undefined ? { tableLabel } : {}),
      };
    }
    return {
      id: page._id,
      state: page.state === "opened" ? openedPageState : sentPageState,
      version: page.version,
      expiresAt: page.expiresAt,
      serverNow: now,
      sentAt: page._creationTime,
      reason: page.reason,
      round: { id: round._id, name: round.name },
      panel: { id: panel._id, name: panel.name },
      team: pageTeam,
      criteria,
    };
  },
});

export const openPage = mutation({
  args: {
    eventSlug: v.string(),
    pageId: v.id("reviewerPages"),
    expectedVersion: v.number(),
  },
  returns: v.object({ pageId: v.id("reviewerPages"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const page = await ctx.db.get(args.pageId);
    if (
      !page ||
      page.eventId !== event._id ||
      page.targetPersonId !== person._id ||
      page.expiresAt <= Date.now() ||
      (page.state !== "sent" && page.state !== "opened")
    ) {
      throw new ConvexError({ code: "PAGE_CHANGED", message: "This substitute page is no longer active." });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.page.respond",
      scopeType: "page",
      scopeId: page._id,
    });
    if (page.state === "opened") return { pageId: page._id, version: page.version };
    if (page.version !== args.expectedVersion) {
      throw new ConvexError({ code: "PAGE_CHANGED", message: "This substitute page changed." });
    }
    const now = Date.now();
    await ctx.db.patch(page._id, {
      state: "opened",
      openedAt: now,
      version: page.version + 1,
    });
    return { pageId: page._id, version: page.version + 1 };
  },
});

export const respondToPage = mutation({
  args: {
    eventSlug: v.string(),
    pageId: v.id("reviewerPages"),
    response: v.union(v.literal("accept"), v.literal("decline")),
    reason: v.optional(v.string()),
    installationId: v.string(),
    expectedVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    pageId: v.id("reviewerPages"),
    state: v.union(v.literal("accepted"), v.literal("declined"), v.literal("expired")),
    panelMemberId: v.optional(v.id("reviewPanelMembers")),
    reviewAssignmentId: v.optional(v.id("reviewAssignments")),
    nextPageId: v.optional(v.id("reviewerPages")),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const declineReason = args.response === "decline"
      ? normalizedText(args.reason ?? "", "Decline reason", 3, 300)
      : undefined;
    const installationId = args.installationId.trim().toLowerCase();
    const requestFingerprint = operationFingerprint([
      args.pageId,
      args.response,
      declineReason ?? null,
      installationId,
      args.expectedVersion,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.page.respond",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "substitute page response",
        pageResponseOperationResult,
      );
      const pageId = ctx.db.normalizeId("reviewerPages", result.pageId);
      const panelMemberId = result.panelMemberId
        ? ctx.db.normalizeId("reviewPanelMembers", result.panelMemberId)
        : undefined;
      const reviewAssignmentId = result.reviewAssignmentId
        ? ctx.db.normalizeId("reviewAssignments", result.reviewAssignmentId)
        : undefined;
      const nextPageId = result.nextPageId
        ? ctx.db.normalizeId("reviewerPages", result.nextPageId)
        : undefined;
      if (
        !pageId ||
        pageId !== prior.targetId ||
        (result.panelMemberId && !panelMemberId) ||
        (result.reviewAssignmentId && !reviewAssignmentId) ||
        (result.nextPageId && !nextPageId)
      ) {
        throw new Error("The stored substitute-page response is invalid.");
      }
      return {
        pageId,
        state: result.state,
        ...(panelMemberId ? { panelMemberId } : {}),
        ...(reviewAssignmentId ? { reviewAssignmentId } : {}),
        ...(nextPageId ? { nextPageId } : {}),
      };
    }
    const page = await ctx.db.get(args.pageId);
    if (
      !page ||
      page.eventId !== event._id ||
      page.targetPersonId !== person._id ||
      (page.state !== "sent" && page.state !== "opened") ||
      page.version !== args.expectedVersion
    ) {
      throw new ConvexError({ code: "PAGE_CHANGED", message: "This substitute page changed." });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.page.respond",
      scopeType: "page",
      scopeId: page._id,
    });
    const chain = await ctx.db.get(page.pageChainId);
    if (!chain || chain.eventId !== event._id || chain.state !== "active") {
      throw new ConvexError({ code: "PAGE_CHAIN_CHANGED", message: "The panel vacancy was already resolved." });
    }
    const now = Date.now();
    if (page.expiresAt <= now) {
      const next = await expireActivePage(ctx, page, now, person._id);
      const result = {
        pageId: page._id,
        state: expiredPageState,
        ...(next ? { nextPageId: next.pageId } : {}),
      };
      await recordOperation(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        clientOperationId: args.clientOperationId,
        commandName: "review.page.respond",
        requestFingerprint,
        targetType: "reviewer_page",
        targetId: page._id,
        resultJson: JSON.stringify(result),
        createdAt: now,
      });
      await writeAuditEvent(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        permissionKey: "review.page.respond",
        grantIds,
        scopeType: "page",
        scopeId: page._id,
        action: "review.substitute_page_response_late",
        targetType: "reviewer_page",
        targetId: page._id,
        nextSummary: JSON.stringify({ state: "expired", nextPageId: next?.pageId ?? null }),
        reason: "The response arrived after the published response window",
      });
      return result;
    }
    const reserve = await ctx.db.get(page.reserveId);
    if (!reserve || reserve.personId !== person._id) {
      throw new Error("The active substitute page has an invalid reserve assignment.");
    }
    if (args.response === "decline") {
      await ctx.db.patch(page._id, {
        state: declinedPageState,
        respondedAt: now,
        responseReason: declineReason,
        version: page.version + 1,
      });
      if (reserve.status === "paged") {
        await ctx.db.patch(reserve._id, {
          status: "available",
          version: reserve.version + 1,
          updatedAt: now,
        });
      }
      await revokeSourceGrants(ctx, {
        eventId: event._id,
        sourceType: "page_assignment",
        sourceId: page._id,
        revokedByPersonId: person._id,
        reason: declineReason ?? "Substitute page declined",
      });
      await ctx.db.patch(chain._id, { version: chain.version + 1 });
      const next = await sendNextPage(ctx, chain._id, now);
      const result = {
        pageId: page._id,
        state: declinedPageState,
        ...(next ? { nextPageId: next.pageId } : {}),
      };
      await recordOperation(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        clientOperationId: args.clientOperationId,
        commandName: "review.page.respond",
        requestFingerprint,
        targetType: "reviewer_page",
        targetId: page._id,
        resultJson: JSON.stringify(result),
        createdAt: now,
      });
      await writeAuditEvent(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        permissionKey: "review.page.respond",
        grantIds,
        scopeType: "page",
        scopeId: page._id,
        action: "review.substitute_page_declined",
        targetType: "reviewer_page",
        targetId: page._id,
        nextSummary: JSON.stringify({ state: "declined", nextPageId: next?.pageId ?? null }),
        reason: declineReason ?? "Substitute page declined",
      });
      return result;
    }
    const [round, panel, missingMember] = await Promise.all([
      ctx.db.get(page.roundId),
      ctx.db.get(page.panelId),
      ctx.db.get(chain.missingPanelMemberId),
    ]);
    if (
      !round ||
      !panel ||
      !missingMember ||
      round.eventId !== event._id ||
      panel.eventId !== event._id ||
      missingMember.eventId !== event._id ||
      panel.status !== "needs_reviewer" ||
      missingMember.status !== "removed" ||
      !["published", "open"].includes(round.status)
    ) {
      throw new ConvexError({
        code: "PANEL_VACANCY_CHANGED",
        message: "The panel vacancy was already resolved or the round is no longer available.",
      });
    }
    const requiredKeys = await criterionKeys(ctx, round, page.requiredCriterionIds);
    let teamId: Id<"teams"> | undefined;
    let session: Doc<"reviewSessions"> | null = null;
    if (chain.reviewSessionId !== undefined) {
      session = await ctx.db.get(chain.reviewSessionId);
      if (!session || session.eventId !== event._id || session.status !== "awaiting_presence") {
        throw new ConvexError({
          code: "REVIEW_CHANGED",
          message: "The pending review changed before this page was accepted.",
        });
      }
      teamId = session.teamId;
    }
    const eligible = await eligibleReserve(ctx, {
      reserve,
      round,
      requiredCriterionKeys: requiredKeys,
      now,
      status: "paged",
      ignoredPageId: page._id,
      installationId,
      ...(teamId !== undefined ? { teamId } : {}),
    });
    if (!eligible) {
      throw new ConvexError({
        code: "RESERVE_NO_LONGER_ELIGIBLE",
        message: "Clock in on the paged phone and remain available before accepting this seat.",
      });
    }
    const activeMembers = await ctx.db
      .query("reviewPanelMembers")
      .withIndex("by_panel_status", (index) =>
        index.eq("panelId", panel._id).eq("status", "active"),
      )
      .take(maximumReviewersPerPanel + 1);
    if (activeMembers.length > maximumReviewersPerPanel) {
      throw new Error("A review panel exceeds the published reviewer limit.");
    }
    if (
      activeMembers.length !== round.requiredPanelSize - 1 ||
      activeMembers.some((member) => member.personId === person._id)
    ) {
      throw new ConvexError({
        code: "PANEL_VACANCY_CHANGED",
        message: "The panel no longer has exactly one matching empty seat.",
      });
    }
    if (session) {
      const assignmentCapacity = await ctx.db
        .query("reviewAssignments")
        .withIndex("by_event_person_status", (index) =>
          index
            .eq("eventId", event._id)
            .eq("reviewerPersonId", person._id)
            .eq("status", "assigned"),
        )
        .take(maximumReviewerAssignmentsPerEvent);
      if (assignmentCapacity.length === maximumReviewerAssignmentsPerEvent) {
        throw new ConvexError({
          code: "REVIEWER_ASSIGNMENT_LIMIT_REACHED",
          message: `A reviewer can receive at most ${maximumReviewerAssignmentsPerEvent} review assignments in one event.`,
        });
      }
    }
    const newPanelVersion = panel.version + 1;
    const panelMemberId = await ctx.db.insert("reviewPanelMembers", {
      eventId: event._id,
      roundId: round._id,
      panelId: panel._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
      assignedCriterionIds: page.requiredCriterionIds,
      isCoordinator: missingMember.isCoordinator,
      status: "active",
      assignedAt: now,
    });
    await grantPanelMemberAccess(ctx, {
      eventId: event._id,
      roundId: round._id,
      panelId: panel._id,
      panelMemberId,
      reviewerPersonId: person._id,
      eventAccessSubjectId: subject._id,
      grantedByPersonId: chain.createdByPersonId,
      isCoordinator: missingMember.isCoordinator,
      reason: "Accepted substitute panel assignment",
    });
    let reviewAssignmentId: Id<"reviewAssignments"> | undefined;
    if (session) {
      const assignments = await ctx.db
        .query("reviewAssignments")
        .withIndex("by_session_person", (index) =>
          index.eq("reviewSessionId", session._id),
        )
        .take(maximumReviewerAssignmentsPerEvent + 1);
      if (assignments.length > maximumReviewerAssignmentsPerEvent) {
        throw new Error("A review exceeds the event assignment limit.");
      }
      const assigned = assignments.filter((assignment) => assignment.status === "assigned");
      if (
        assigned.length !== round.requiredPanelSize - 1 ||
        assigned.some((assignment) => assignment.reviewerPersonId === person._id)
      ) {
        throw new ConvexError({
          code: "REVIEW_ASSIGNMENT_CHANGED",
          message: "The pending review assignment changed before acceptance.",
        });
      }
      reviewAssignmentId = await ctx.db.insert("reviewAssignments", {
        eventId: event._id,
        roundId: round._id,
        panelId: panel._id,
        reviewSessionId: session._id,
        reviewerPersonId: person._id,
        eventAccessSubjectId: subject._id,
        assignedCriterionIds: page.requiredCriterionIds,
        isCoordinator: missingMember.isCoordinator,
        status: "assigned",
        assignedAt: now,
      });
      const scorecardId = await ctx.db.insert("scorecards", {
        eventId: event._id,
        roundId: round._id,
        reviewSessionId: session._id,
        reviewerPersonId: person._id,
        assignmentId: reviewAssignmentId,
        rubricVersionId: round.rubricVersionId,
        status: "draft",
        ratings: [],
        draftVersion: 0,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      await grantReviewAssignmentAccess(ctx, {
        eventId: event._id,
        reviewSessionId: session._id,
        scorecardId,
        assignmentId: reviewAssignmentId,
        reviewerPersonId: person._id,
        eventAccessSubjectId: subject._id,
        grantedByPersonId: chain.createdByPersonId,
        isCoordinator: missingMember.isCoordinator,
      });
      await ctx.db.patch(session._id, {
        panelVersion: newPanelVersion,
        version: session.version + 1,
        updatedAt: now,
      });
    }
    await ctx.db.patch(missingMember._id, { status: "replaced" });
    await ctx.db.patch(panel._id, {
      ...(missingMember.isCoordinator ? { coordinatorPersonId: person._id } : {}),
      status: "ready",
      version: newPanelVersion,
      updatedAt: now,
    });
    await appendReviewPanelVacancyReadFactById(ctx, panel._id, now);
    await ctx.db.patch(reserve._id, {
      status: "assigned",
      version: reserve.version + 1,
      updatedAt: now,
    });
    await revokeSourceGrants(ctx, {
      eventId: event._id,
      sourceType: "reserve_assignment",
      sourceId: reserve._id,
      revokedByPersonId: person._id,
      reason: "Reserve accepted a fixed panel seat",
    });
    await ctx.db.patch(page._id, {
      state: acceptedPageState,
      respondedAt: now,
      version: page.version + 1,
      acceptedPanelMemberId: panelMemberId,
      ...(reviewAssignmentId !== undefined
        ? { acceptedReviewAssignmentId: reviewAssignmentId }
        : {}),
    });
    await revokeSourceGrants(ctx, {
      eventId: event._id,
      sourceType: "page_assignment",
      sourceId: page._id,
      revokedByPersonId: person._id,
      reason: "Substitute page accepted",
    });
    const competingPages = await ctx.db
      .query("reviewerPages")
      .withIndex("by_chain_state_rank", (index) => index.eq("pageChainId", chain._id))
      .take(maximumReviewReservesPerRound + 1);
    if (competingPages.length > maximumReviewReservesPerRound) {
      throw new Error("A substitute page chain exceeds the published reserve limit.");
    }
    for (const competing of competingPages) {
      if (
        competing._id !== page._id &&
        (competing.state === "sent" || competing.state === "opened")
      ) {
        await ctx.db.patch(competing._id, {
          state: "cancelled",
          respondedAt: now,
          version: competing.version + 1,
        });
        const competingReserve = await ctx.db.get(competing.reserveId);
        if (competingReserve?.status === "paged") {
          await ctx.db.patch(competingReserve._id, {
            status: "available",
            version: competingReserve.version + 1,
            updatedAt: now,
          });
        }
        await revokeSourceGrants(ctx, {
          eventId: event._id,
          sourceType: "page_assignment",
          sourceId: competing._id,
          revokedByPersonId: person._id,
          reason: "Another reserve filled the panel vacancy",
        });
      }
    }
    await ctx.db.patch(chain._id, {
      state: "filled",
      version: chain.version + 1,
      completedAt: now,
    });
    const result = {
      pageId: page._id,
      state: acceptedPageState,
      panelMemberId,
      ...(reviewAssignmentId !== undefined ? { reviewAssignmentId } : {}),
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.page.respond",
      requestFingerprint,
      targetType: "reviewer_page",
      targetId: page._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.page.respond",
      grantIds,
      scopeType: "page",
      scopeId: page._id,
      action: "review.substitute_page_accepted",
      targetType: "reviewer_page",
      targetId: page._id,
      nextSummary: JSON.stringify({
        panelMemberId,
        reviewAssignmentId: reviewAssignmentId ?? null,
        panelVersion: newPanelVersion,
      }),
      reason: "Reserve accepted the fixed panel seat",
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: chain.createdByPersonId,
      permissionKey: "review.substitute.assign",
      grantIds: chain.assignmentGrantIds,
      scopeType: chain.resolvedScopeType,
      scopeId: chain.resolvedScopeId,
      action: "review.substitute_assigned",
      targetType: "review_panel_member",
      targetId: panelMemberId,
      previousSummary: JSON.stringify({ missingPanelMemberId: missingMember._id }),
      nextSummary: JSON.stringify({
        replacementPersonId: person._id,
        panelId: panel._id,
        reviewAssignmentId: reviewAssignmentId ?? null,
      }),
      reason: chain.reason,
    });
    return result;
  },
});

/** Delay before retrying an unanswered page. */
const repageIntervalMs = 30 * 1_000;

export const repage = internalMutation({
  args: {
    pageId: v.id("reviewerPages"),
    logicalAttempt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!Number.isSafeInteger(args.logicalAttempt) || args.logicalAttempt < 2) {
      throw new Error("Reviewer page attempt is invalid.");
    }
    const page = await ctx.db.get(args.pageId);
    if (!page || (page.state !== "sent" && page.state !== "opened")) return null;
    const now = Date.now();
    if (page.expiresAt <= now) return null;

    const existing = await ctx.db
      .query("reviewerPushDeliveries")
      .withIndex("by_page_attempt", (index) =>
        index.eq("pageId", page._id).eq("logicalAttempt", args.logicalAttempt),
      )
      .unique();
    if (existing) return null;
    const prior = await ctx.db
      .query("reviewerPushDeliveries")
      .withIndex("by_page_attempt", (index) =>
        index.eq("pageId", page._id).eq("logicalAttempt", args.logicalAttempt - 1),
      )
      .unique();
    if (!prior) throw new Error("The previous reviewer page attempt is missing.");
    const device = await ctx.db.get(prior.reviewerDeviceId);
    const pushToken =
      device &&
      device.eventId === page.eventId &&
      device.personId === page.targetPersonId &&
      device.status === "active" &&
      device.pushTokenStatus === "active" &&
      device.pushProvider !== undefined &&
      device.pushEnvironment !== undefined
        ? device.pushToken
        : undefined;
    const pushAvailable = pushToken !== undefined;
    const deliveryId = await ctx.db.insert("reviewerPushDeliveries", {
      eventId: page.eventId,
      pageId: page._id,
      targetPersonId: page.targetPersonId,
      reviewerDeviceId: prior.reviewerDeviceId,
      purpose: "substitute_page",
      logicalAttempt: args.logicalAttempt,
      ...(pushAvailable ? { tokenFingerprint: pushTokenFingerprint(pushToken) } : {}),
      state: pushAvailable ? "pending" : "unavailable",
      attemptCount: 0,
      ...(!pushAvailable
        ? { providerErrorCode: "push_token_unavailable", completedAt: now }
        : {}),
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    if (pushAvailable) {
      await ctx.scheduler.runAfter(0, internal.reviewPush.deliverPage, {
        deliveryId,
      });
    }
    if (args.logicalAttempt === 2) {
      await enqueueReviewerPageCall(ctx, page._id, now);
    }
    if (now + repageIntervalMs < page.expiresAt) {
      await ctx.scheduler.runAfter(repageIntervalMs, internal.reviewSubstitutions.repage, {
        pageId: page._id,
        logicalAttempt: args.logicalAttempt + 1,
      });
    }
    return null;
  },
});

export const expirePage = internalMutation({
  args: { pageId: v.id("reviewerPages") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db.get(args.pageId);
    if (
      !page ||
      (page.state !== "sent" && page.state !== "opened") ||
      page.expiresAt > Date.now()
    ) {
      return null;
    }
    const chain = await ctx.db.get(page.pageChainId);
    const now = Date.now();
    const next = await expireActivePage(ctx, page, now);
    if (chain) {
      await writeAuditEvent(ctx, {
        eventId: page.eventId,
        actorPersonId: chain.createdByPersonId,
        permissionKey: "review.substitute.page",
        grantIds: chain.pageGrantIds,
        scopeType: chain.resolvedScopeType,
        scopeId: chain.resolvedScopeId,
        action: "review.substitute_page_expired",
        targetType: "reviewer_page",
        targetId: page._id,
        previousSummary: JSON.stringify({ state: page.state, version: page.version }),
        nextSummary: JSON.stringify({ state: "expired", nextPageId: next?.pageId ?? null }),
        reason: "The published substitute response window elapsed",
      });
    }
    return null;
  },
});

export const roundStatus = query({
  args: { eventSlug: v.string(), roundId: v.id("reviewRounds") },
  returns: v.object({
    serverNow: v.number(),
    panels: v.array(
      v.object({
        panelId: v.id("reviewPanels"),
        panelVersion: v.number(),
        activeMembers: v.array(
          v.object({
            panelMemberId: v.id("reviewPanelMembers"),
            personId: v.id("people"),
            displayName: v.string(),
            isCoordinator: v.boolean(),
            canMarkNoShow: v.boolean(),
          }),
        ),
        vacancy: v.union(
          v.null(),
          v.object({
            panelMemberId: v.id("reviewPanelMembers"),
            displayName: v.string(),
            isCoordinator: v.boolean(),
            criterionLabels: v.array(v.string()),
          }),
        ),
        pageChain: v.union(
          v.null(),
          v.object({
            id: v.id("reviewerPageChains"),
            state: reviewerPageChainState,
            currentRank: v.number(),
            currentPage: v.union(
              v.null(),
              v.object({
                id: v.id("reviewerPages"),
                targetName: v.string(),
                state: reviewerPageState,
                expiresAt: v.number(),
                push: v.union(
                  v.null(),
                  v.object({
                    state: reviewerPushDeliveryState,
                  }),
                ),
                call: v.union(
                  v.null(),
                  v.object({ state: outboundCallDeliveryState }),
                ),
              }),
            ),
          }),
        ),
        canStartPage: v.boolean(),
        canSwapMembers: v.boolean(),
      }),
    ),
    reserves: v.array(
      v.object({
        reserveId: v.id("reviewRoundReserves"),
        personId: v.id("people"),
        displayName: v.string(),
        status: reviewRoundReserveStatus,
        pageCount: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const round = await ctx.db.get(args.roundId);
    if (!round || round.eventId !== event._id) {
      throw new ConvexError({ code: "ROUND_NOT_FOUND", message: "That review round is unavailable." });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.read",
      scopeType: "round",
      scopeId: round._id,
    });
    const [panels, availableReserves, pagedReserves, assignedReserves] = await Promise.all([
      ctx.db
        .query("reviewPanels")
        .withIndex("by_round_status", (index) => index.eq("roundId", round._id))
        .take(maximumReviewPanelsPerRound + 1),
      ctx.db
        .query("reviewRoundReserves")
        .withIndex("by_round_status", (index) =>
          index.eq("roundId", round._id).eq("status", "available"),
        )
        .take(maximumReviewReservesPerRound + 1),
      ctx.db
        .query("reviewRoundReserves")
        .withIndex("by_round_status", (index) =>
          index.eq("roundId", round._id).eq("status", "paged"),
        )
        .take(maximumReviewReservesPerRound + 1),
      ctx.db
        .query("reviewRoundReserves")
        .withIndex("by_round_status", (index) =>
          index.eq("roundId", round._id).eq("status", "assigned"),
        )
        .take(maximumReviewReservesPerRound + 1),
    ]);
    const reserves = [...availableReserves, ...pagedReserves, ...assignedReserves];
    if (panels.length > maximumReviewPanelsPerRound) {
      throw new Error("A review round exceeds the published panel limit.");
    }
    if (reserves.length > maximumReviewReservesPerRound) {
      throw new Error("A review round exceeds the published reserve limit.");
    }
    const panelRows = await Promise.all(
      panels.map(async (panel) => {
        const [members, removed, activeChain, latestChain, awaitingSessions, activeSessions, overdueSessions] = await Promise.all([
          ctx.db
            .query("reviewPanelMembers")
            .withIndex("by_panel_status", (index) =>
              index.eq("panelId", panel._id).eq("status", "active"),
            )
            .take(maximumReviewersPerPanel + 1),
          ctx.db
            .query("reviewPanelMembers")
            .withIndex("by_panel_status_ended", (index) =>
              index.eq("panelId", panel._id).eq("status", "removed"),
            )
            .order("desc")
            .first(),
          ctx.db
            .query("reviewerPageChains")
            .withIndex("by_panel_state", (index) =>
              index.eq("panelId", panel._id).eq("state", "active"),
            )
            .unique(),
          ctx.db
            .query("reviewerPageChains")
            .withIndex("by_panel_created", (index) => index.eq("panelId", panel._id))
            .order("desc")
            .first(),
          ctx.db
            .query("reviewSessions")
            .withIndex("by_panel_status", (index) =>
              index.eq("panelId", panel._id).eq("status", "awaiting_presence"),
            )
            .take(2),
          ctx.db
            .query("reviewSessions")
            .withIndex("by_panel_status", (index) =>
              index.eq("panelId", panel._id).eq("status", "active"),
            )
            .take(2),
          ctx.db
            .query("reviewSessions")
            .withIndex("by_panel_status", (index) =>
              index.eq("panelId", panel._id).eq("status", "overdue"),
            )
            .take(2),
        ]);
        if (members.length > maximumReviewersPerPanel) {
          throw new Error("A review panel exceeds the published reviewer limit.");
        }
        const liveSessions = [...awaitingSessions, ...activeSessions, ...overdueSessions];
        if (liveSessions.length > 1) {
          throw new Error("A review panel has more than one live review.");
        }
        const pendingSession = awaitingSessions[0];
        const reviewIsRunning = activeSessions.length > 0 || overdueSessions.length > 0;
        const activeMembers = await Promise.all(
          members.map(async (member) => {
              const [reviewer, permission] = await Promise.all([
                ctx.db.get(member.personId),
                noShowScope(ctx, {
                  eventId: event._id,
                  eventAccessSubjectId: subject._id,
                  roundId: round._id,
                  reviewerPersonId: member.personId,
                }),
              ]);
              if (!reviewer) throw new Error("A panel member no longer resolves to a person.");
              return {
                panelMemberId: member._id,
                personId: reviewer._id,
                displayName: reviewer.displayName,
                isCoordinator: member.isCoordinator,
                canMarkNoShow:
                  permission !== null && panel.status === "ready" && !reviewIsRunning,
              };
            }),
        );
        let vacancy: {
          panelMemberId: Id<"reviewPanelMembers">;
          displayName: string;
          isCoordinator: boolean;
          criterionLabels: string[];
        } | null = null;
        if (removed) {
          const missingPerson = await ctx.db.get(removed.personId);
          if (!missingPerson) throw new Error("A removed panel member no longer resolves.");
          const labels: string[] = [];
          for (const criterionId of removed.assignedCriterionIds) {
            const criterion = await ctx.db.get(criterionId);
            if (!criterion) throw new Error("A removed panel member has an invalid criterion.");
            labels.push(criterion.label);
          }
          vacancy = {
            panelMemberId: removed._id,
            displayName: missingPerson.displayName,
            isCoordinator: removed.isCoordinator,
            criterionLabels: labels,
          };
        }
        const displayedChain = activeChain ?? (vacancy ? latestChain : null);
        let pageChain: {
          id: Id<"reviewerPageChains">;
          state: Doc<"reviewerPageChains">["state"];
          currentRank: number;
          currentPage: {
            id: Id<"reviewerPages">;
            targetName: string;
            state: Doc<"reviewerPages">["state"];
            expiresAt: number;
            push: {
              state: Doc<"reviewerPushDeliveries">["state"];
            } | null;
            call: {
              state: Doc<"outboundCallDeliveries">["state"];
            } | null;
          } | null;
        } | null = null;
        if (displayedChain) {
          const [sentPages, openedPages] = await Promise.all([
            ctx.db
              .query("reviewerPages")
              .withIndex("by_chain_state_rank", (index) =>
                index.eq("pageChainId", displayedChain._id).eq("state", "sent"),
              )
              .take(2),
            ctx.db
              .query("reviewerPages")
              .withIndex("by_chain_state_rank", (index) =>
                index.eq("pageChainId", displayedChain._id).eq("state", "opened"),
              )
              .take(2),
          ]);
          const currentPages = [...sentPages, ...openedPages];
          if (currentPages.length > 1) {
            throw new Error("A substitute page chain has more than one active page.");
          }
          const currentPage = currentPages[0];
          let currentPageView: {
            id: Id<"reviewerPages">;
              targetName: string;
              state: Doc<"reviewerPages">["state"];
              expiresAt: number;
              push: {
                state: Doc<"reviewerPushDeliveries">["state"];
              } | null;
              call: {
                state: Doc<"outboundCallDeliveries">["state"];
              } | null;
            } | null = null;
          if (currentPage) {
            const [target, push, call] = await Promise.all([
              ctx.db.get(currentPage.targetPersonId),
              ctx.db
                .query("reviewerPushDeliveries")
                .withIndex("by_page", (index) => index.eq("pageId", currentPage._id))
                .order("desc")
                .first(),
              ctx.db
                .query("outboundCallDeliveries")
                .withIndex("by_source", (index) =>
                  index
                    .eq("eventId", currentPage.eventId)
                    .eq("sourceType", "reviewer_page")
                    .eq("sourceId", currentPage._id)
                    .eq("purpose", "reviewer_substitute_page"),
                )
                .unique(),
            ]);
            if (!target) throw new Error("A substitute page target no longer resolves.");
            currentPageView = {
              id: currentPage._id,
              targetName: target.displayName,
              state: currentPage.state,
              expiresAt: currentPage.expiresAt,
              push: push
                ? {
                    state: push.state,
                }
                : null,
              call: call ? { state: call.state } : null,
            };
          }
          pageChain = {
            id: displayedChain._id,
            state: displayedChain.state,
            currentRank: displayedChain.currentRank,
            currentPage: currentPageView,
          };
        }
        const [permission, assignGrantIds] = await Promise.all([
          substituteScope(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            panelId: panel._id,
            ...(pendingSession ? { reviewSessionId: pendingSession._id } : {}),
          }),
          matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: "review.substitute.assign",
            scopeType: "panel",
            scopeId: panel._id,
          }),
        ]);
        return {
          panelId: panel._id,
          panelVersion: panel.version,
          activeMembers,
          vacancy,
          pageChain,
          canStartPage:
            permission !== null &&
            panel.status === "needs_reviewer" &&
            vacancy !== null &&
            activeChain === undefined,
          canSwapMembers:
            assignGrantIds.length > 0 &&
            ["ready", "needs_reviewer", "paused"].includes(panel.status) &&
            ["published", "open"].includes(round.status) &&
            activeChain === undefined &&
            liveSessions.length === 0,
        };
      }),
    );
    const reserveRows = await Promise.all(
      reserves
        .map(async (reserve) => {
          const reviewer = await ctx.db.get(reserve.personId);
          if (!reviewer) throw new Error("A reserve reviewer no longer resolves to a person.");
          return {
            reserveId: reserve._id,
            personId: reviewer._id,
            displayName: reviewer.displayName,
            status: reserve.status,
            pageCount: reserve.pageCount,
          };
        }),
    );
    return {
      serverNow: Date.now(),
      panels: panelRows,
      reserves: reserveRows.sort((left, right) => left.displayName.localeCompare(right.displayName)),
    };
  },
});
