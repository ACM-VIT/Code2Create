import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { advanceAccessVersion } from "./lib/accessVersion";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import {
  insertPermissionGrant,
  matchingPermissionGrantIds,
  requirePermission,
  revokeSourceGrants,
} from "./lib/permissions";
import { pushTokenFingerprint } from "./lib/pushTokens";
import { grantPanelMemberAccess, grantReviewAssignmentAccess } from "./lib/reviewAccess";
import { normalizedText } from "./lib/strings";

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
const activeChainState: "active" = "active";
const exhaustedChainState: "exhausted" = "exhausted";
const sentPageState: "sent" = "sent";
const openedPageState: "opened" = "opened";
const acceptedPageState: "accepted" = "accepted";
const declinedPageState: "declined" = "declined";
const expiredPageState: "expired" = "expired";

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
        .withIndex("by_person_state_expiry", (index) =>
          index.eq("targetPersonId", args.reserve.personId).eq("state", "sent"),
        )
        .collect(),
      ctx.db
        .query("reviewerPages")
        .withIndex("by_person_state_expiry", (index) =>
          index.eq("targetPersonId", args.reserve.personId).eq("state", "opened"),
        )
        .collect(),
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
    !clockIn ||
    clockIn.status !== "present" ||
    args.now - clockIn.lastHeartbeatAt > reviewerLivenessWindowMs ||
    activePanelMember
  ) {
    return null;
  }
  const profileKeys = new Set(profile.criterionKeys);
  if (args.requiredCriterionKeys.some((key) => !profileKeys.has(key))) return null;
  const hasOtherPage = [...sentPages, ...openedPages].some(
    (page) => page._id !== args.ignoredPageId && page.expiresAt > args.now,
  );
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
    .withIndex("by_person_status", (index) =>
      index.eq("reviewerPersonId", person._id).eq("status", "assigned"),
    )
    .collect();
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

async function sendNextPage(
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
      .collect(),
  ]);
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
    .collect();
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
    reason: `A reviewer seat at ${panel.tableLabel} needs coverage.`,
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
  }
  return { pageId, targetPersonId: candidate.person._id, expiresAt };
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
      const panelMemberId = ctx.db.normalizeId("reviewPanelMembers", prior.targetId);
      if (!panelMemberId) throw new Error("Prior no-show result is invalid.");
      const member = await ctx.db.get(panelMemberId);
      if (!member) throw new Error("Prior no-show result no longer resolves.");
      const panel = await ctx.db.get(member.panelId);
      if (!panel) throw new Error("Prior no-show panel no longer resolves.");
      return { panelId: panel._id, panelMemberId, panelVersion: panel.version };
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
    const sessions = await ctx.db
      .query("reviewSessions")
      .withIndex("by_panel_status", (index) => index.eq("panelId", panel._id))
      .collect();
    const liveSessions = sessions.filter((session) =>
      liveReviewStatuses.some((status) => status === session.status),
    );
    if (liveSessions.some((session) => session.status === "active" || session.status === "overdue")) {
      throw new ConvexError({
        code: "ACTIVE_REVIEW_ASSIGNED",
        message: "Do not replace a reviewer while their review timer is running.",
      });
    }
    const pendingSessions = liveSessions.filter((session) => session.status === "awaiting_presence");
    if (pendingSessions.length > 1) throw new Error("A panel has more than one pending review.");
    const pendingSession = pendingSessions[0];
    const now = Date.now();
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
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.reviewer.no_show",
      requestFingerprint,
      targetType: "review_panel_member",
      targetId: member._id,
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
    return { panelId: panel._id, panelMemberId: member._id, panelVersion: nextPanelVersion };
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
      const pageChainId = ctx.db.normalizeId("reviewerPageChains", prior.targetId);
      if (!pageChainId) throw new Error("Prior substitute-page result is invalid.");
      const chain = await ctx.db.get(pageChainId);
      if (!chain) throw new Error("Prior substitute-page result no longer resolves.");
      const pages = await ctx.db
        .query("reviewerPages")
        .withIndex("by_chain_state_rank", (index) => index.eq("pageChainId", chain._id))
        .collect();
      const latest = pages.sort((left, right) => right.rank - left.rank)[0];
      return {
        pageChainId,
        ...(latest ? { pageId: latest._id } : {}),
        state: chain.state === "active" ? activeChainState : exhaustedChainState,
      };
    }
    const missingMember = await ctx.db.get(args.missingPanelMemberId);
    if (!missingMember || missingMember.eventId !== event._id || missingMember.status !== "removed") {
      throw new ConvexError({
        code: "PANEL_VACANCY_CHANGED",
        message: "That panel vacancy no longer exists.",
      });
    }
    const [panel, round, activeChain, sessions] = await Promise.all([
      ctx.db.get(missingMember.panelId),
      ctx.db.get(missingMember.roundId),
      ctx.db
        .query("reviewerPageChains")
        .withIndex("by_panel_state", (index) =>
          index.eq("panelId", missingMember.panelId).eq("state", "active"),
        )
        .unique(),
      ctx.db
        .query("reviewSessions")
        .withIndex("by_panel_status", (index) => index.eq("panelId", missingMember.panelId))
        .collect(),
    ]);
    if (
      !panel ||
      !round ||
      panel.eventId !== event._id ||
      round.eventId !== event._id ||
      panel.status !== "needs_reviewer" ||
      panel.version !== args.expectedPanelVersion ||
      !["published", "open"].includes(round.status) ||
      activeChain
    ) {
      throw new ConvexError({
        code: "PANEL_VACANCY_CHANGED",
        message: "The panel vacancy, version, or existing page chain changed.",
      });
    }
    const pendingSessions = sessions.filter((session) => session.status === "awaiting_presence");
    if (pendingSessions.length > 1) throw new Error("A panel has more than one pending review.");
    if (sessions.some((session) => session.status === "active" || session.status === "overdue")) {
      throw new ConvexError({
        code: "ACTIVE_REVIEW_ASSIGNED",
        message: "A substitute page cannot change a panel during a running review.",
      });
    }
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
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.substitute.page",
      requestFingerprint,
      targetType: "reviewer_page_chain",
      targetId: pageChainId,
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
    return {
      pageChainId,
      ...(sent ? { pageId: sent.pageId } : {}),
      state: savedChain.state === "active" ? activeChainState : exhaustedChainState,
    };
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
      reason: v.string(),
      round: v.object({ id: v.id("reviewRounds"), name: v.string() }),
      panel: v.object({ id: v.id("reviewPanels"), name: v.string(), tableLabel: v.string() }),
      teamName: v.optional(v.string()),
      criteria: v.array(v.object({ id: v.id("reviewRubricCriteria"), label: v.string() })),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const [sentPages, openedPages] = await Promise.all([
      ctx.db
        .query("reviewerPages")
        .withIndex("by_person_state_expiry", (index) =>
          index.eq("targetPersonId", person._id).eq("state", "sent"),
        )
        .collect(),
      ctx.db
        .query("reviewerPages")
        .withIndex("by_person_state_expiry", (index) =>
          index.eq("targetPersonId", person._id).eq("state", "opened"),
        )
        .collect(),
    ]);
    const now = Date.now();
    const active = [...sentPages, ...openedPages].filter(
      (page) => page.eventId === event._id && page.expiresAt > now,
    );
    if (active.length > 1) throw new Error("A reviewer has more than one active substitute page.");
    const page = active[0];
    if (!page) return null;
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.page.respond",
      scopeType: "page",
      scopeId: page._id,
    });
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
    let teamName: string | undefined;
    if (page.reviewSessionId !== undefined) {
      const session = await ctx.db.get(page.reviewSessionId);
      if (!session || session.eventId !== event._id) {
        throw new Error("An active substitute page has an invalid review session.");
      }
      const team = await ctx.db.get(session.teamId);
      if (!team || team.eventId !== event._id) {
        throw new Error("An active substitute page has an invalid team.");
      }
      teamName = team.name;
    }
    return {
      id: page._id,
      state: page.state === "opened" ? openedPageState : sentPageState,
      version: page.version,
      expiresAt: page.expiresAt,
      reason: page.reason,
      round: { id: round._id, name: round.name },
      panel: { id: panel._id, name: panel.name, tableLabel: panel.tableLabel },
      ...(teamName !== undefined ? { teamName } : {}),
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
      const pageId = ctx.db.normalizeId("reviewerPages", prior.targetId);
      if (!pageId) throw new Error("Prior page response is invalid.");
      const saved = await ctx.db.get(pageId);
      if (!saved || !["accepted", "declined", "expired"].includes(saved.state)) {
        throw new Error("Prior page response no longer resolves.");
      }
      return {
        pageId,
        state:
          saved.state === "accepted"
            ? acceptedPageState
            : saved.state === "declined"
              ? declinedPageState
              : expiredPageState,
        ...(saved.acceptedPanelMemberId !== undefined
          ? { panelMemberId: saved.acceptedPanelMemberId }
          : {}),
        ...(saved.acceptedReviewAssignmentId !== undefined
          ? { reviewAssignmentId: saved.acceptedReviewAssignmentId }
          : {}),
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
      await recordOperation(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        clientOperationId: args.clientOperationId,
        commandName: "review.page.respond",
        requestFingerprint,
        targetType: "reviewer_page",
        targetId: page._id,
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
      return {
        pageId: page._id,
        state: expiredPageState,
        ...(next ? { nextPageId: next.pageId } : {}),
      };
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
      await recordOperation(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        clientOperationId: args.clientOperationId,
        commandName: "review.page.respond",
        requestFingerprint,
        targetType: "reviewer_page",
        targetId: page._id,
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
      return {
        pageId: page._id,
        state: declinedPageState,
        ...(next ? { nextPageId: next.pageId } : {}),
      };
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
    const panelMembers = await ctx.db
      .query("reviewPanelMembers")
      .withIndex("by_panel_status", (index) => index.eq("panelId", panel._id))
      .collect();
    const activeMembers = panelMembers.filter((member) => member.status === "active");
    if (
      activeMembers.length !== round.requiredPanelSize - 1 ||
      activeMembers.some((member) => member.personId === person._id)
    ) {
      throw new ConvexError({
        code: "PANEL_VACANCY_CHANGED",
        message: "The panel no longer has exactly one matching empty seat.",
      });
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
        .collect();
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
      .collect();
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
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.page.respond",
      requestFingerprint,
      targetType: "reviewer_page",
      targetId: page._id,
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
    return {
      pageId: page._id,
      state: acceptedPageState,
      panelMemberId,
      ...(reviewAssignmentId !== undefined ? { reviewAssignmentId } : {}),
    };
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
            clockInStatus: v.string(),
            clockInVersion: v.number(),
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
            state: v.string(),
            currentRank: v.number(),
            currentPage: v.union(
              v.null(),
              v.object({
                id: v.id("reviewerPages"),
                targetName: v.string(),
                state: v.string(),
                expiresAt: v.number(),
                push: v.union(
                  v.null(),
                  v.object({
                    state: v.string(),
                    attemptCount: v.number(),
                    providerErrorCode: v.optional(v.string()),
                  }),
                ),
              }),
            ),
          }),
        ),
        canStartPage: v.boolean(),
      }),
    ),
    reserves: v.array(
      v.object({
        reserveId: v.id("reviewRoundReserves"),
        displayName: v.string(),
        status: v.string(),
        clockInStatus: v.string(),
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
    const [panels, reserves] = await Promise.all([
      ctx.db
        .query("reviewPanels")
        .withIndex("by_round_status", (index) => index.eq("roundId", round._id))
        .collect(),
      ctx.db
        .query("reviewRoundReserves")
        .withIndex("by_round_status", (index) => index.eq("roundId", round._id))
        .collect(),
    ]);
    const panelRows = await Promise.all(
      panels.map(async (panel) => {
        const [members, chains, sessions] = await Promise.all([
          ctx.db
            .query("reviewPanelMembers")
            .withIndex("by_panel_status", (index) => index.eq("panelId", panel._id))
            .collect(),
          ctx.db
            .query("reviewerPageChains")
            .withIndex("by_panel_state", (index) => index.eq("panelId", panel._id))
            .collect(),
          ctx.db
            .query("reviewSessions")
            .withIndex("by_panel_status", (index) => index.eq("panelId", panel._id))
            .collect(),
        ]);
        const reviewIsRunning = sessions.some(
          (session) => session.status === "active" || session.status === "overdue",
        );
        const activeMembers = await Promise.all(
          members
            .filter((member) => member.status === "active")
            .map(async (member) => {
              const [reviewer, clockIn, permission] = await Promise.all([
                ctx.db.get(member.personId),
                ctx.db
                  .query("reviewerClockIns")
                  .withIndex("by_round_person", (index) =>
                    index
                      .eq("roundId", round._id)
                      .eq("reviewerPersonId", member.personId),
                  )
                  .unique(),
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
                clockInStatus: clockIn?.status ?? "not_clocked_in",
                clockInVersion: clockIn?.version ?? 0,
                canMarkNoShow:
                  permission !== null && panel.status === "ready" && !reviewIsRunning,
              };
            }),
        );
        const removed = members
          .filter((member) => member.status === "removed")
          .sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0))[0];
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
        const activeChain = chains.find((chain) => chain.state === "active");
        const latestChain =
          activeChain ??
          (vacancy
            ? chains.sort((left, right) => right.createdAt - left.createdAt)[0]
            : undefined);
        let pageChain: {
          id: Id<"reviewerPageChains">;
          state: string;
          currentRank: number;
          currentPage: {
            id: Id<"reviewerPages">;
            targetName: string;
            state: string;
            expiresAt: number;
            push: {
              state: string;
              attemptCount: number;
              providerErrorCode?: string;
            } | null;
          } | null;
        } | null = null;
        if (latestChain) {
          const pages = await ctx.db
            .query("reviewerPages")
            .withIndex("by_chain_state_rank", (index) =>
              index.eq("pageChainId", latestChain._id),
            )
            .collect();
          const currentPage = pages
            .filter((page) => page.state === "sent" || page.state === "opened")
            .sort((left, right) => right.rank - left.rank)[0];
          let currentPageView: {
            id: Id<"reviewerPages">;
              targetName: string;
              state: string;
              expiresAt: number;
              push: {
                state: string;
                attemptCount: number;
                providerErrorCode?: string;
              } | null;
            } | null = null;
          if (currentPage) {
            const [target, push] = await Promise.all([
              ctx.db.get(currentPage.targetPersonId),
              ctx.db
                .query("reviewerPushDeliveries")
                .withIndex("by_page", (index) => index.eq("pageId", currentPage._id))
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
                    attemptCount: push.attemptCount,
                    ...(push.providerErrorCode !== undefined
                      ? { providerErrorCode: push.providerErrorCode }
                      : {}),
                  }
                : null,
            };
          }
          pageChain = {
            id: latestChain._id,
            state: latestChain.state,
            currentRank: latestChain.currentRank,
            currentPage: currentPageView,
          };
        }
        const pendingSession = sessions.find((session) => session.status === "awaiting_presence");
        const permission = await substituteScope(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          panelId: panel._id,
          ...(pendingSession ? { reviewSessionId: pendingSession._id } : {}),
        });
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
        };
      }),
    );
    const reserveRows = await Promise.all(
      reserves
        .filter((reserve) => reserve.status !== "removed")
        .map(async (reserve) => {
          const [reviewer, clockIn] = await Promise.all([
            ctx.db.get(reserve.personId),
            ctx.db
              .query("reviewerClockIns")
              .withIndex("by_round_person", (index) =>
                index
                  .eq("roundId", round._id)
                  .eq("reviewerPersonId", reserve.personId),
              )
              .unique(),
          ]);
          if (!reviewer) throw new Error("A reserve reviewer no longer resolves to a person.");
          return {
            reserveId: reserve._id,
            displayName: reviewer.displayName,
            status: reserve.status,
            clockInStatus: clockIn?.status ?? "not_clocked_in",
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
