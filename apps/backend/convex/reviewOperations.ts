import { requireReviewProgression, reviewProgressionBlocker } from "./lib/reviewProgression";
import { hasReviewConflict } from "./lib/reviewConflict";
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  createEvidenceCheckpoint,
  type EvidenceCompleteness,
} from "./lib/reviewEvidenceCheckpoint";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
  storedOperationVersion,
} from "./lib/operations";
import { matchingPermissionGrantIds, requirePermission,
} from "./lib/permissions";
import { prepareQuestionSet } from "./reviewQuestions";
import { routeReviewTeam } from "./lib/reviewPanelRouting";
import { notifyReviewTeam } from "./lib/reviewTeamNotices";
import { grantReviewAssignmentAccess } from "./lib/reviewAccess";
import {
  insertTeamRoundState,
  patchTeamRoundState,
} from "./lib/reviewQueueProjection";
import {
  maximumActiveReviewGrantsPerPermission,
  maximumReviewPanelsPerRound,
  maximumReviewRoundsPerEvent,
  maximumReviewerAssignmentsPerEvent,
  maximumReviewersPerPanel,
  maximumReviewReservesPerRound,
  maximumReviewSessionsPerTeamRound,
  maximumReviewTeamsPerEvent,
} from "./lib/reviewLimits";
import {
  createReviewParticipantAvailabilityWaiver,
  findReviewParticipantAvailabilityWaiver,
  readReviewParticipantAvailability,
} from "./lib/reviewParticipantAvailability";
import { activeRoundPause as findActiveRoundPause } from "./lib/reviewRoundPauses";
import { computeReviewEvaluation } from "./lib/reviewScores";
import { reviewOverviewCounts } from "./lib/reviewOverviewCounts";
import { requireConfirmedReviewer } from "./lib/reviewConfirmation";
import { normalizedText } from "./lib/strings";
import {
  reviewPanelStatus,
  reviewRoundStatus,
  reviewSessionStatus,
  teamRoundState,
} from "./values";

const liveReviewStatuses = ["awaiting_presence", "active", "scoring"] as const;
const roundBoardPermissionKeys = [
  "queue.manage",
  "review.prepare",
  "review.panel.pause",
  "review.round.pause",
  "review.round.resume",
] as const;
const roundTeamPermissionKeys = [
  "application.read",
  "application.review.read",
  "round.manage",
  "review.queue.hold",
  "review.queue.resume",
  "review.queue.miss",
  "review.queue.move",
  "review.participant_availability.waive",
  "review.start",
  "review.complete",
  "review.presence.waive",
] as const;

const callTeamOperationResult = z
  .object({
    reviewSessionId: z.string().min(1),
    evidenceCompleteness: z.enum(["complete", "partial", "missing"]),
  })
  .strict();

const startReviewOperationResult = z
  .object({
    reviewSessionId: z.string().min(1),
    startedAt: z.number().int().nonnegative(),
    plannedEndAt: z.number().int().nonnegative(),
    serverNow: z.number().int().nonnegative(),
    version: z.number().int().positive(),
  })
  .strict();

const extendReviewOperationResult = z
  .object({
    plannedEndAt: z.number().int().nonnegative(),
    extensionCount: z.number().int().nonnegative(),
    version: z.number().int().positive(),
  })
  .strict();

const completeReviewOperationResult = z
  .object({
    reviewSessionId: z.string().min(1),
    completedAt: z.number().int().nonnegative(),
  })
  .strict();
type OverviewRoundView = {
  id: Id<"reviewRounds">;
  name: string;
  status: Doc<"reviewRounds">["status"];
  startsAt: number;
  endsAt: number;
  version: number;
  canManage: boolean;
  isPaused: boolean;
  panels: Array<{
    id: Id<"reviewPanels">;
    name: string;
    status: Doc<"reviewPanels">["status"];
    queuedCount: number;
    activeReviewCount: number;
  }>;
  stateCounts: {
    unassigned: number;
    queued: number;
    called: number;
    inReview: number;
    completed: number;
    held: number;
  };
};
type RoundBoardReviewView = {
  id: Id<"reviewSessions">;
  status: Doc<"reviewSessions">["status"];
  version: number;
  startedAt?: number;
  plannedEndAt?: number;
  reviewerPresenceCount: number;
  reviewerCount: number;
  submittedScorecardCount: number;
  requiresSharedCommitments: boolean;
  sharedNotesComplete: boolean;
  canStart: boolean;
  canComplete: boolean;
  canWaivePresence: boolean;
  reviewers: Array<{
    personId: Id<"people">;
    displayName: string;
    presenceMethod?: string;
  }>;
};

const roundBoardReviewValidator = v.object({
  id: v.id("reviewSessions"),
  status: reviewSessionStatus,
  version: v.number(),
  startedAt: v.optional(v.number()),
  plannedEndAt: v.optional(v.number()),
  reviewerPresenceCount: v.number(),
  reviewerCount: v.number(),
  submittedScorecardCount: v.number(),
  requiresSharedCommitments: v.boolean(),
  sharedNotesComplete: v.boolean(),
  canStart: v.boolean(),
  canComplete: v.boolean(),
  canWaivePresence: v.boolean(),
  reviewers: v.array(
    v.object({
      personId: v.id("people"),
      displayName: v.string(),
      presenceMethod: v.optional(v.string()),
    }),
  ),
});

const roundBoardTeamValidator = v.object({
  stateId: v.optional(v.id("teamRoundStates")),
  teamId: v.id("teams"),
  applicationId: v.optional(v.id("applications")),
  teamName: v.string(),
  skipReason: v.optional(v.string()),
  canSkip: v.boolean(),
  state: teamRoundState,
  version: v.number(),
  queuedAt: v.optional(v.number()),
  panelId: v.optional(v.id("reviewPanels")),
  holdReason: v.optional(v.string()),
  callAttemptCount: v.number(),
  missedEligibleAt: v.optional(v.number()),
  canHold: v.boolean(),
  canResume: v.boolean(),
  canMarkMissed: v.boolean(),
  canMove: v.boolean(),
  participantAvailability: v.object({
    activeCount: v.number(),
    availableCount: v.number(),
    requiredCount: v.number(),
    isMet: v.boolean(),
    isWaived: v.boolean(),
    canWaive: v.boolean(),
  }),
  review: v.union(v.null(), roundBoardReviewValidator),
});

function isLiveReviewStatus(status: Doc<"reviewSessions">["status"]) {
  return liveReviewStatuses.some((candidate) => candidate === status);
}

async function activeReviewOperationGrants(
  ctx: QueryCtx,
  eventId: Id<"events">,
  eventAccessSubjectId: Id<"eventAccessSubjects">,
  permissionKeys: readonly string[],
) {
  const rows = await Promise.all(
    permissionKeys.map((permissionKey) =>
      ctx.db
        .query("permissionGrants")
        .withIndex("by_subject_permission_status", (index) =>
          index
            .eq("eventAccessSubjectId", eventAccessSubjectId)
            .eq("permissionKey", permissionKey)
            .eq("status", "active"),
        )
        .take(maximumActiveReviewGrantsPerPermission + 1),
    ),
  );
  if (rows.some((grants) => grants.length > maximumActiveReviewGrantsPerPermission,
    )) {
    throw new Error("An operator exceeds the active review-grant limit for one permission.",
    );
  }
  const now = Date.now();
  return rows
    .flat()
    .filter(
      (grant) =>
        grant.eventId === eventId &&
        grant.validFrom <= now &&
        (grant.validUntil === undefined || grant.validUntil > now),
    );
}


function isReviewableTeam(team: Doc<"teams">) {
  return (
    team.competitionCategory !== "oc" &&
    ["confirmed", "checked_in", "active"].includes(team.status) &&
    team.membershipLocked &&
    team.lockedProjectVersionId !== undefined
  );
}

async function requireRound(ctx: MutationCtx, eventId: Id<"events">, roundId: Id<"reviewRounds">,
) {
  const round = await ctx.db.get(roundId);
  if (!round || round.eventId !== eventId) {
    throw new ConvexError({
      code: "ROUND_NOT_FOUND",
      message: "That review round is unavailable.",
    });
  }
  return round;
}

async function requirePanel(
  ctx: MutationCtx,
  eventId: Id<"events">,
  roundId: Id<"reviewRounds">,
  panelId: Id<"reviewPanels">,
) {
  const panel = await ctx.db.get(panelId);
  if (!panel || panel.eventId !== eventId || panel.roundId !== roundId) {
    throw new ConvexError({
      code: "PANEL_NOT_FOUND",
      message: "That review panel is unavailable.",
    });
  }
  return panel;
}

async function requireReviewTeam(ctx: MutationCtx, eventId: Id<"events">, teamId: Id<"teams">,
) {
  const team = await ctx.db.get(teamId);
  if (!team || team.eventId !== eventId || !isReviewableTeam(team)) {
    throw new ConvexError({
      code: "TEAM_NOT_REVIEWABLE",
      message: "The team must be confirmed with a locked project before review.",
    });
  }
  return team;
}

async function ensurePanelReady(
  ctx: MutationCtx,
  round: Doc<"reviewRounds">,
  panel: Doc<"reviewPanels">,
  teamId: Id<"teams">,
) {
  if (panel.status !== "ready") {
    throw new ConvexError({
      code: "PANEL_NOT_READY",
      message: "This panel is not ready to receive a team.",
    });
  }
  const members = await ctx.db
    .query("reviewPanelMembers")
    .withIndex("by_panel_status", (index) => index.eq("panelId", panel._id).eq("status", "active"),
    )
    .collect();
  if (members.length !== round.requiredPanelSize) {
    throw new ConvexError({
      code: "PANEL_INCOMPLETE",
      message: "This panel does not have its published reviewer count.",
    });
  }
  for (const member of members) {
    const profile = await ctx.db.query("reviewerProfiles").withIndex("by_event_person", q => q.eq("eventId", round.eventId).eq("personId", member.personId)).unique();
    if (!profile || profile.status !== "active") throw new ConvexError({ code: "REVIEWER_NOT_READY", message: "Every panel member needs an active reviewer profile." });
    const conflict = await hasReviewConflict(ctx, round.eventId, member.personId, teamId);
    if (conflict) {
      throw new ConvexError({
        code: "PANEL_CONFLICT",
        message: "A current panel member has an active conflict with this team.",
      });
    }
  }
  return members;
}

export const overview = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    rounds: v.array(
      v.object({
        id: v.id("reviewRounds"),
        name: v.string(),
        status: reviewRoundStatus,
        startsAt: v.number(),
        endsAt: v.number(),
        version: v.number(),
        canManage: v.boolean(),
        isPaused: v.boolean(),
        panels: v.array(
          v.object({
            id: v.id("reviewPanels"),
            name: v.string(),
            status: reviewPanelStatus,
            queuedCount: v.number(),
            activeReviewCount: v.number(),
          }),
        ),
        stateCounts: v.object({
          unassigned: v.number(),
          queued: v.number(),
          called: v.number(),
          inReview: v.number(),
          completed: v.number(),
          held: v.number(),
        }),
      }),
    ),
  }),
  handler: (ctx, args) => buildReviewOverview(ctx, args.eventSlug),
});

export async function buildReviewOverview(
  ctx: QueryCtx,
  eventSlug: string,
): Promise<{ rounds: OverviewRoundView[] }> {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const [rounds, confirmedTeams, checkedInTeams, activeTeams] = await Promise.all([
    ctx.db
      .query("reviewRounds")
      .withIndex("by_event_status_start", (index) => index.eq("eventId", event._id),
        )
      .take(maximumReviewRoundsPerEvent + 1),
    ctx.db
      .query("teams")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", event._id).eq("status", "confirmed"),
      )
      .take(maximumReviewTeamsPerEvent + 1),
    ctx.db
      .query("teams")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", event._id).eq("status", "checked_in"),
      )
      .take(maximumReviewTeamsPerEvent + 1),
    ctx.db
      .query("teams")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", event._id).eq("status", "active"),
      )
      .take(maximumReviewTeamsPerEvent + 1),
  ]);
  if (rounds.length > maximumReviewRoundsPerEvent) {
    throw new Error("An event exceeds the published review-round limit.");
  }
  const eventTeams = [...confirmedTeams, ...checkedInTeams, ...activeTeams];
  if (eventTeams.length > maximumReviewTeamsPerEvent) {
    throw new Error("An event exceeds the review operations team limit.");
  }
  const reviewableTeams = eventTeams.filter(isReviewableTeam);
  const visible = (
    await Promise.all(
      rounds.map(async (round): Promise<OverviewRoundView | null> => {
        const grants = await matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "round.read",
          scopeType: "round",
          scopeId: round._id,
        });
        if (grants.length === 0) return null;
        const [manageGrants, panels, states, awaitingSessions, activeSessions,
          scoringSessions,
          pause,
        ] =
          await Promise.all([
            matchingPermissionGrantIds(ctx, {
              eventId: event._id,
              eventAccessSubjectId: subject._id,
              permissionKey: "round.manage",
              scopeType: "round",
              scopeId: round._id,
            }),
            ctx.db
              .query("reviewPanels")
              .withIndex("by_round_status", (index) => index.eq("roundId", round._id))
              .take(maximumReviewPanelsPerRound + 1),
            ctx.db
              .query("teamRoundStates")
              .withIndex("by_round_state_priority_queued", (index) => index.eq("roundId", round._id))
              .take(maximumReviewTeamsPerEvent + 1),
            ctx.db
              .query("reviewSessions")
              .withIndex("by_round_status_updated", (index) =>
                index.eq("roundId", round._id).eq("status", "awaiting_presence"),
              )
              .take(maximumReviewPanelsPerRound + 1),
            ctx.db
              .query("reviewSessions")
              .withIndex("by_round_status_updated", (index) =>
                index.eq("roundId", round._id).eq("status", "active"),
              )
              .take(maximumReviewPanelsPerRound + 1),
            ctx.db
              .query("reviewSessions")
              .withIndex("by_round_status_updated", (index) =>
                index.eq("roundId", round._id).eq("status", "scoring"),
              )
              .take(maximumReviewPanelsPerRound + 1),
            findActiveRoundPause(ctx, round._id),
          ]);
        if (panels.length > maximumReviewPanelsPerRound) {
          throw new Error("A review round exceeds the published panel limit.");
        }
        if (states.length > maximumReviewTeamsPerEvent) {
          throw new Error("A review round exceeds the review operations team limit.");
        }
        const liveSessions = [...awaitingSessions, ...activeSessions, ...scoringSessions];
        if (liveSessions.length > maximumReviewPanelsPerRound) {
          throw new Error("A review round has more live reviews than published panels.");
        }
        const counts = reviewOverviewCounts({ states, liveSessions, reviewableTeams });
        const panelRows = panels.map((panel) => ({
          id: panel._id,
          name: panel.name,
          status: panel.status,
          queuedCount: counts.queuedByPanel.get(panel._id) ?? 0,
          activeReviewCount: counts.activeByPanel.get(panel._id) ?? 0,
        }));
        return {
          id: round._id,
          name: round.name,
          status: round.status,
          startsAt: round.startsAt,
          endsAt: round.endsAt,
          version: round.version,
          canManage: manageGrants.length > 0,
          isPaused: pause !== null,
          panels: panelRows,
          stateCounts: counts.stateCounts,
        };
      }),
    )
  ).flatMap((round) => (round === null ? [] : [round]));
  return { rounds: visible.sort((left, right) => left.startsAt - right.startsAt),
  };
}

export const roundBoard = query({
  args: { eventSlug: v.string(), roundId: v.id("reviewRounds") },
  returns: v.object({
    serverNow: v.number(),
    round: v.object({
      id: v.id("reviewRounds"),
      name: v.string(),
      status: reviewRoundStatus,
      version: v.number(),
      startsAt: v.number(),
      endsAt: v.number(),
      missedCallGraceSeconds: v.number(),
      requiredCallAttempts: v.number(),
      missedReentryPolicy: v.string(),
      minimumPresentParticipants: v.number(),
      canPause: v.boolean(),
      pause: v.union(
        v.null(),
        v.object({
          id: v.id("reviewRoundPauses"),
          version: v.number(),
          pausedAt: v.number(),
          incidentTitle: v.optional(v.string()),
          reason: v.optional(v.string()),
          canResume: v.boolean(),
        }),
      ),
    }),
    panels: v.array(
      v.object({
        id: v.id("reviewPanels"),
        name: v.string(),
        status: reviewPanelStatus,
        version: v.number(),
        canManageQueue: v.boolean(),
        canPrepareReview: v.boolean(),
        canPause: v.boolean(),
      }),
    ),
  }),
  handler: (ctx, args) => buildRoundBoard(ctx, args.eventSlug, args.roundId),
});

export async function buildRoundBoard(
  ctx: QueryCtx,
  eventSlug: string,
  roundId: Id<"reviewRounds">,
) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const round = await ctx.db.get(roundId);
  if (!round || round.eventId !== event._id) {
    throw new ConvexError({
      code: "ROUND_NOT_FOUND",
      message: "That review round is unavailable.",
    });
  }
  await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "round.read",
    scopeType: "round",
    scopeId: round._id,
  });
  const [panels, actorGrants, activePause] = await Promise.all([
    ctx.db
      .query("reviewPanels")
      .withIndex("by_round_status", (index) => index.eq("roundId", round._id))
      .take(maximumReviewPanelsPerRound + 1),
    activeReviewOperationGrants(ctx, event._id, subject._id, roundBoardPermissionKeys,
    ),
    findActiveRoundPause(ctx, round._id),
  ]);
  if (panels.length > maximumReviewPanelsPerRound) {
    throw new Error("A review round exceeds the published panel limit.");
  }
  const allows = (
    permissionKey: string,
    scopes: ReadonlyArray<{ type: Doc<"permissionGrants">["scopeType"]; id: string;
    }>,
  ) =>
    actorGrants.some(
      (grant) =>
        grant.permissionKey === permissionKey &&
        (grant.scopeType === "event" ||
          scopes.some((scope) => grant.scopeType === scope.type && grant.scopeId === scope.id,
          )),
    );
  let pauseView: {
    id: Id<"reviewRoundPauses">;
    version: number;
    pausedAt: number;
    incidentTitle?: string;
    reason?: string;
    canResume: boolean;
  } | null = null;
  if (activePause) {
    const incident = await ctx.db.get("incidents", activePause.incidentId);
    const incidentReadGrants = incident
      ? await matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "incident.read",
          scopeType: "incident",
          scopeId: incident._id,
        })
      : [];
    pauseView = {
      id: activePause._id,
      version: activePause.version,
      pausedAt: activePause.pausedAt,
      ...(incident && incidentReadGrants.length > 0
        ? { incidentTitle: incident.title, reason: activePause.reason }
        : {}),
      canResume: allows("review.round.resume", [{ type: "round", id: round._id },
      ]),
    };
  }
  const panelViews = await Promise.all(
    panels.map(async (panel) => {
      return {
        id: panel._id,
        name: panel.name,
        status: panel.status,
        version: panel.version,
        canManageQueue: allows("queue.manage", [{ type: "panel", id: panel._id },
        ]),
        canPrepareReview:
          allows("review.prepare", [{ type: "panel", id: panel._id }]) && activePause === null,
        canPause: allows("review.panel.pause", [{ type: "panel", id: panel._id },
        ]),
      };
    }),
  );
  return {
    serverNow: Date.now(),
    round: {
      id: round._id,
      name: round.name,
      status: round.status,
      version: round.version,
      startsAt: round.startsAt,
      endsAt: round.endsAt,
      missedCallGraceSeconds: round.missedCallGraceSeconds,
      requiredCallAttempts: round.requiredCallAttempts,
      missedReentryPolicy: round.missedReentryPolicy,
      minimumPresentParticipants: round.minimumPresentParticipants,
      canPause:
        round.status === "open" &&
        activePause === null &&
        allows("review.round.pause", [{ type: "round", id: round._id }]),
      pause: pauseView,
    },
    panels: panelViews,
  };
}

export const roundStaffing = query({
  args: { eventSlug: v.string(), roundId: v.id("reviewRounds") },
  returns: v.object({
    serverNow: v.number(),
    panels: v.array(
      v.object({
        panelId: v.id("reviewPanels"),
        reviewers: v.array(
          v.object({
            personId: v.id("people"),
            displayName: v.string(),
            isCoordinator: v.boolean(),
            appBuild: v.optional(v.number()),
            encryptedDraftReady: v.optional(v.boolean()),
            deviceLastSeenAt: v.optional(v.number()),
          }),
        ),
      }),
    ),
    reserves: v.array(v.object({ personId: v.id("people") })),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const round = await ctx.db.get(args.roundId);
    if (!round || round.eventId !== event._id) {
      throw new ConvexError({
        code: "ROUND_NOT_FOUND",
        message: "That review round is unavailable.",
      });
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
        .withIndex("by_round_status", (index) => index.eq("roundId", round._id),
          )
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
    const reserves = [...availableReserves, ...pagedReserves, ...assignedReserves,
    ];
    if (panels.length > maximumReviewPanelsPerRound) {
      throw new Error("A review round exceeds the published panel limit.");
    }
    if (reserves.length > maximumReviewReservesPerRound) {
      throw new Error("A review round exceeds the published reserve limit.");
    }
    const panelRows = await Promise.all(
      panels.map(async (panel) => {
        const members = await ctx.db
          .query("reviewPanelMembers")
          .withIndex("by_panel_status", (index) =>
            index.eq("panelId", panel._id).eq("status", "active"),
          )
          .take(maximumReviewersPerPanel + 1);
        if (members.length > maximumReviewersPerPanel) {
          throw new Error("A review panel exceeds the published reviewer limit.",
          );
        }
        const reviewers = await Promise.all(
          members.map(async (member) => {
            const [reviewer, device] = await Promise.all([
              ctx.db.get(member.personId),
              ctx.db
                .query("reviewerDevices")
                .withIndex("by_event_person_status_seen", (index) =>
                  index
                    .eq("eventId", event._id)
                    .eq("personId", member.personId)
                    .eq("status", "active"),
                )
                .order("desc")
                .first(),
            ]);
            if (!reviewer) throw new Error("A review panel member no longer resolves to a person.",
              );
            return {
              personId: reviewer._id,
              displayName: reviewer.displayName,
              isCoordinator: member.isCoordinator,
              ...(device
                ? {
                    appBuild: device.appBuild,
                    encryptedDraftReady: device.encryptedDraftReady,
                    deviceLastSeenAt: device.lastSeenAt,
                  }
                : {}),
            };
          }),
        );
        return { panelId: panel._id, reviewers };
      }),
    );
    const reserveRows = reserves.map((reserve) => ({ personId: reserve.personId }));
    return { serverNow: Date.now(), panels: panelRows, reserves: reserveRows };
  },
});

export const roundTeams = query({
  args: {
    eventSlug: v.string(),
    roundId: v.id("reviewRounds"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(roundBoardTeamValidator),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const round = await ctx.db.get(args.roundId);
    if (!round || round.eventId !== event._id) {
      throw new ConvexError({
        code: "ROUND_NOT_FOUND",
        message: "That review round is unavailable.",
      });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.read",
      scopeType: "round",
      scopeId: round._id,
    });
    const [page, actorGrants, activePause] = await Promise.all([
      ctx.db
        .query("teams")
        .withIndex("by_event_status", (index) => index.eq("eventId", event._id))
        .filter((filter) =>
          filter.and(
            filter.eq(filter.field("membershipLocked"), true),
            filter.neq(filter.field("competitionCategory"), "oc"),
            filter.neq(filter.field("lockedProjectVersionId"), undefined),
          ),
        )
        .paginate(args.paginationOpts),
      activeReviewOperationGrants(ctx, event._id, subject._id, roundTeamPermissionKeys,
      ),
      findActiveRoundPause(ctx, round._id),
    ]);
    const allows = (
      permissionKey: string,
      scopes: ReadonlyArray<{ type: Doc<"permissionGrants">["scopeType"]; id: string;
      }>,
    ) =>
      actorGrants.some(
        (grant) =>
          grant.permissionKey === permissionKey &&
          (grant.scopeType === "event" ||
            scopes.some((scope) => grant.scopeType === scope.type && grant.scopeId === scope.id,
            )),
      );
    const rows = await Promise.all(
      page.page.map(async (team) => {
        if (!team.lockedProjectVersionId) {
          throw new Error("A review queue row references an invalid team.");
        }
        const [state, project, sessions, participantAvailability, application] = await Promise.all([
          ctx.db
            .query("teamRoundStates")
            .withIndex("by_round_team", (index) =>
              index.eq("roundId", round._id).eq("teamId", team._id),
            )
            .unique(),
          ctx.db.get(team.lockedProjectVersionId),
          ctx.db
            .query("reviewSessions")
            .withIndex("by_round_team_status", (index) =>
              index.eq("roundId", round._id).eq("teamId", team._id),
            )
            .take(maximumReviewSessionsPerTeamRound + 1),
          readReviewParticipantAvailability(ctx, {
            eventId: event._id,
            teamId: team._id,
          }),
          ctx.db
            .query("applications")
            .withIndex("by_team", (index) => index.eq("teamId", team._id))
            .first(),
        ]);
        if (!project || project.eventId !== event._id || project.teamId !== team._id) {
          throw new Error("A review queue team has no locked project.");
        }
        if (!state && (!isReviewableTeam(team) || await reviewProgressionBlocker(ctx, round, team._id))) return null;
        if (sessions.length > maximumReviewSessionsPerTeamRound) {
          throw new Error("A team exceeds the review-attempt limit for this round.",
          );
        }
        const liveSessions = sessions.filter((session) => isLiveReviewStatus(session.status),
        );
        if (liveSessions.length > 1) {
          throw new Error("A team has more than one live review in this round.",
          );
        }
        const review =
          liveSessions[0] ??
          sessions
            .filter((session) => session.status === "completed")
            .sort((left, right) => right.createdAt - left.createdAt)[0] ??
          null;
        const participantAvailabilityWaiver = review
          ? await findReviewParticipantAvailabilityWaiver(ctx, review._id)
          : null;
        let reviewView: RoundBoardReviewView | null = null;
        if (review) {
          const [assignments, presences, scorecards] = await Promise.all([
            ctx.db
              .query("reviewAssignments")
              .withIndex("by_session_person", (index) => index.eq("reviewSessionId", review._id),
              )
              .take(maximumReviewersPerPanel + 1),
            ctx.db
              .query("reviewPresence")
              .withIndex("by_session_reviewer", (index) => index.eq("reviewSessionId", review._id),
              )
              .take(maximumReviewersPerPanel + 1),
            ctx.db
              .query("scorecards")
              .withIndex("by_session_status", (index) => index.eq("reviewSessionId", review._id),
              )
              .take(maximumReviewersPerPanel + 1),
          ]);
          if (
            assignments.length > maximumReviewersPerPanel ||
            presences.length > maximumReviewersPerPanel ||
            scorecards.length > maximumReviewersPerPanel
          ) {
            throw new Error("A review exceeds the published reviewer limit.");
          }
          const assigned = assignments.filter((assignment) => assignment.status === "assigned",
          );
          const reviewerRows = await Promise.all(
            assigned.map(async (assignment) => {
              const reviewer = await ctx.db.get(assignment.reviewerPersonId);
              if (!reviewer) {
                throw new Error("A fixed review assignment references a missing reviewer.",
                );
              }
              const presence = presences.find(
                (row) => row.reviewerPersonId === assignment.reviewerPersonId,
              );
              return {
                personId: reviewer._id,
                displayName: reviewer.displayName,
                ...(presence ? { presenceMethod: presence.method } : {}),
              };
            }),
          );
          reviewView = {
            id: review._id,
            status: review.status,
            version: review.version,
            ...(review.startedAt !== undefined ? { startedAt: review.startedAt } : {}),
            ...(review.plannedEndAt !== undefined ? { plannedEndAt: review.plannedEndAt } : {}),
            reviewerPresenceCount: assigned.filter((assignment) =>
              presences.some(
                (presence) => presence.reviewerPersonId === assignment.reviewerPersonId,
              ),
            ).length,
            reviewerCount: assigned.length,
            submittedScorecardCount: scorecards.filter(
              (scorecard) => scorecard.status === "submitted",
            ).length,
            requiresSharedCommitments: round.requiresSharedCommitments,
            sharedNotesComplete:
              !round.requiresSharedCommitments ||
              Boolean(review.sharedFindings?.trim() && review.sharedCommitments?.trim(),
              ),
            canStart:
              allows("review.start", [{ type: "review", id: review._id }]) && activePause === null,
            canComplete: allows("review.complete", [{ type: "review", id: review._id },
            ]),
            canWaivePresence: allows("review.presence.waive", [{ type: "review", id: review._id },
            ]),
            reviewers: reviewerRows,
          };
        }
        const exceptionScopes = state
          ? [
              { type: "team" as const, id: state.teamId },
              { type: "round" as const, id: state.roundId },
              ...(state.panelId ? [{ type: "panel" as const, id: state.panelId }] : []),
            ]
          : [];
        const canReadApplication =
          application !== null &&
          (allows("application.read", [{ type: "application", id: application._id },
          ]) ||
            allows("application.review.read", [{ type: "application", id: application._id },
            ]));
        const lastCallAt = state?.lastCallAttemptAt ?? state?.calledAt;
        return {
          ...(state ? { stateId: state._id } : {}),
          ...(canReadApplication ? { applicationId: application._id } : {}),
          teamId: team._id,
          teamName: team.name,
          ...(state?.skipReason ? { skipReason: state.skipReason } : {}),
          canSkip: allows("round.manage", [{ type: "round", id: round._id }]),
          state: state?.state ?? "unassigned",
          version: state?.version ?? 0,
          ...(state?.queuedAt !== undefined ? { queuedAt: state.queuedAt } : {}),
          ...(state?.panelId !== undefined ? { panelId: state.panelId } : {}),
          ...(state?.holdReason !== undefined ? { holdReason: state.holdReason } : {}),
          callAttemptCount: state?.callAttemptCount ?? 0,
          ...(lastCallAt !== undefined
            ? { missedEligibleAt: lastCallAt + round.missedCallGraceSeconds * 1_000,
              }
            : {}),
          canHold: state !== null && allows("review.queue.hold", exceptionScopes),
          canResume: state !== null && allows("review.queue.resume", exceptionScopes),
          canMarkMissed: state !== null && allows("review.queue.miss", exceptionScopes),
          canMove: state !== null && allows("review.queue.move", exceptionScopes),
          participantAvailability: {
            ...participantAvailability,
            requiredCount: round.minimumPresentParticipants,
            isMet: participantAvailability.availableCount >= round.minimumPresentParticipants,
            isWaived: participantAvailabilityWaiver !== null,
            canWaive: allows("review.participant_availability.waive", [
              { type: "team", id: team._id },
              ...(review ? [{ type: "review" as const, id: review._id }] : []),
            ]),
          },
          review: reviewView,
        };
      }),
    );
    return {
      ...page,
      page: rows.filter((row): row is NonNullable<typeof row> => row !== null),
    };
  },
});

export const openRound = mutation({
  args: {
    eventSlug: v.string(),
    roundId: v.id("reviewRounds"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    roundId: v.id("reviewRounds"),
    status: v.literal("open"),
    version: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ roundId: Id<"reviewRounds">; status: "open"; version: number;
  }> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const requestFingerprint = operationFingerprint([
      args.roundId,
      args.expectedVersion,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round.open",
      requestFingerprint,
    });
    if (prior) {
      const roundId = ctx.db.normalizeId("reviewRounds", prior.targetId);
      if (!roundId) throw new Error("Prior open-round result is invalid.");
      return {
        roundId,
        status: "open",
        version: storedOperationVersion(prior.resultJson, "open round"),
      };
    }
    const round = await requireRound(ctx, event._id, args.roundId);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.manage",
      scopeType: "round",
      scopeId: round._id,
    });
    if (
      event.status !== "live" ||
      round.status !== "published" ||
      round.version !== args.expectedVersion
    ) {
      throw new ConvexError({
        code: "ROUND_NOT_OPENABLE",
        message: "The live event, published round, or expected version changed.",
      });
    }
    const now = Date.now();
    await ctx.db.patch(round._id, { status: "open", openedAt: now, version: round.version + 1,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round.open",
      requestFingerprint,
      targetType: "review_round",
      targetId: round._id,
      resultJson: String(round.version + 1),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "round.manage",
      grantIds,
      scopeType: "round",
      scopeId: round._id,
      action: "review.round_opened",
      targetType: "review_round",
      targetId: round._id,
      previousSummary: JSON.stringify({ status: round.status, version: round.version,
      }),
      nextSummary: JSON.stringify({ status: "open", version: round.version + 1,
      }),
      reason: normalizedText(args.reason, "Reason", 3, 300),
    });
    return { roundId: round._id, status: "open", version: round.version + 1 };
  },
});

export const queueTeam = mutation({
  args: {
    eventSlug: v.string(),
    roundId: v.id("reviewRounds"),
    panelId: v.optional(v.id("reviewPanels")),
    teamId: v.id("teams"),
    expectedTeamRoundVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ teamRoundStateId: v.id("teamRoundStates"), version: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Reason", 3, 300);
    const requestFingerprint = operationFingerprint([
      args.roundId,
      args.panelId ?? "automatic",
      args.teamId,
      args.expectedTeamRoundVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.team.queue",
      requestFingerprint,
    });
    if (prior) {
      const teamRoundStateId = ctx.db.normalizeId("teamRoundStates", prior.targetId,
      );
      if (!teamRoundStateId) throw new Error("Prior queue result is invalid.");
      return {
        teamRoundStateId,
        version: storedOperationVersion(prior.resultJson, "team queue"),
      };
    }
    const [round, team] = await Promise.all([
      requireRound(ctx, event._id, args.roundId),
      requireReviewTeam(ctx, event._id, args.teamId),
    ]);
    await requireReviewProgression(ctx, round, team._id);
    const route =
      args.panelId === undefined
        ? await routeReviewTeam(ctx, round, team, subject)
        : undefined;
    const panel =
      args.panelId !== undefined
        ? await requirePanel(ctx, event._id, round._id, args.panelId)
        : route?.panel;
    if (!panel)
      throw new ConvexError({
        code: "NO_ELIGIBLE_PANEL",
        message:
          "No confirmed, staffed panel is available for this team. Check staffing or choose a panel after resolving its gaps.",
      });
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "queue.manage",
      scopeType: "panel",
      scopeId: panel._id,
    });
    if (round.status !== "open") {
      throw new ConvexError({ code: "ROUND_NOT_OPEN", message: "This review round is not open.",
      });
    }
    await ensurePanelReady(ctx, round, panel, team._id);
    const state = await ctx.db
      .query("teamRoundStates")
      .withIndex("by_round_team", (index) => index.eq("roundId", round._id).eq("teamId", team._id),
      )
      .unique();
    if (
      (state?.version ?? 0) !== args.expectedTeamRoundVersion ||
      (state !== null && state.state !== "unassigned")
    ) {
      throw new ConvexError({
        code: "TEAM_ALREADY_ROUTED",
        message: "The team has already entered this round. Refresh before placing it.",
      });
    }
    const now = Date.now();
    const nextVersion = (state?.version ?? 0) + 1;
    const teamRoundStateId = state
      ? state._id
      : await insertTeamRoundState(ctx, {
          eventId: event._id,
          roundId: round._id,
          teamId: team._id,
          panelId: panel._id,
          state: "queued",
          queuedAt: now,
          callAttemptCount: 0,
          priority: 0,
          version: nextVersion,
          updatedByPersonId: person._id,
          updatedAt: now,
        });
    if (state) {
      await patchTeamRoundState(ctx, state, {
        panelId: panel._id,
        state: "queued",
        queuedAt: now,
        calledAt: undefined,
        callAttemptCount: 0,
        lastCallAttemptAt: undefined,
        holdReason: undefined,
        stateBeforeHold: undefined,
        heldAt: undefined,
        missedAt: undefined,
        version: nextVersion,
        updatedByPersonId: person._id,
        updatedAt: now,
      });
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.team.queue",
      requestFingerprint,
      targetType: "team_round_state",
      targetId: teamRoundStateId,
      resultJson: String(nextVersion),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "queue.manage",
      grantIds,
      scopeType: "panel",
      scopeId: panel._id,
      action: "review.team_queued",
      targetType: "team_round_state",
      targetId: teamRoundStateId,
      ...(state
        ? { previousSummary: JSON.stringify({ state: state.state, version: state.version,
            }),
          }
        : {}),
      nextSummary: JSON.stringify({ state: "queued", panelId: panel._id, version: nextVersion,
        routing: route
          ? {
              rulesVersion: "planned-domain-and-pace-v2",
              selection: route.selection,
              planVersion: route.planVersion,
              matchedDomains: route.matchedDomains,
              estimatedWaitSeconds: route.estimatedWaitSeconds,
            }
          : "manual",
      }),
      reason,
    });
    return { teamRoundStateId, version: nextVersion };
  },
});

const callTeamArgs = {
    eventSlug: v.string(),
    roundId: v.id("reviewRounds"),
    panelId: v.id("reviewPanels"),
    teamId: v.id("teams"),
    expectedTeamRoundVersion: v.number(),
    reason: v.string(),
    participantAvailabilityOverrideReason: v.optional(v.string()),
    clientOperationId: v.string(),
  };
export async function callQueuedTeam(
  ctx: MutationCtx,
  args: Infer<typeof callTeamArgsValidator>,
  actorPersonId: Id<"people">,
  ): Promise<{
    reviewSessionId: Id<"reviewSessions">;
    evidenceCompleteness: EvidenceCompleteness;
  }> {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const person = await ctx.db.get(actorPersonId);
  if (!person) throw new Error("The review operator is missing.");
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Reason", 3, 300);
    const participantAvailabilityOverrideReason =
      args.participantAvailabilityOverrideReason === undefined
        ? undefined
        : normalizedText(
            args.participantAvailabilityOverrideReason,
            "Participant-availability exception reason",
            5,
            500,
          );
    const requestFingerprint = operationFingerprint([
      args.roundId,
      args.panelId,
      args.teamId,
      args.expectedTeamRoundVersion,
      reason,
      participantAvailabilityOverrideReason ?? "no_availability_exception",
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.team.call",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(prior.resultJson, "team call", callTeamOperationResult,
    );
      const reviewSessionId = ctx.db.normalizeId("reviewSessions", result.reviewSessionId,
    );
      if (!reviewSessionId || reviewSessionId !== prior.targetId) {
        throw new Error("The stored team-call result is invalid.");
      }
      return { reviewSessionId, evidenceCompleteness: result.evidenceCompleteness,
    };
    }
    const [round, panel, team] = await Promise.all([
      requireRound(ctx, event._id, args.roundId),
      requirePanel(ctx, event._id, args.roundId, args.panelId),
      requireReviewTeam(ctx, event._id, args.teamId),
    ]);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.prepare",
      scopeType: "panel",
      scopeId: panel._id,
    });
    if (round.status !== "open") {
      throw new ConvexError({ code: "ROUND_NOT_OPEN", message: "This review round is not open.",
    });
    }
    if (await findActiveRoundPause(ctx, round._id)) {
      throw new ConvexError({
        code: "ROUND_PAUSED",
        message: "New review calls are paused for this round.",
      });
    }
    await requireReviewProgression(ctx, round, team._id);
    const members = await ensurePanelReady(ctx, round, panel, team._id);
    const state = await ctx.db
      .query("teamRoundStates")
      .withIndex("by_round_team", (index) => index.eq("roundId", round._id).eq("teamId", team._id),
    )
      .unique();
    if (
      !state ||
      state.state !== "queued" ||
      state.panelId !== panel._id ||
      state.version !== args.expectedTeamRoundVersion
    ) {
      throw new ConvexError({
        code: "QUEUE_STATE_CHANGED",
        message: "The team or panel queue changed. Refresh before calling it.",
      });
    }
    for (const member of members) {
      await requireConfirmedReviewer(ctx, round, member.personId, Date.now());
    }
    const [awaitingPanelSessions, activePanelSessions,
    scoringPanelSessions,
    teamSessions,
  ] =
      await Promise.all([
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
            index.eq("panelId", panel._id).eq("status", "scoring"),
          )
          .take(2),
        ctx.db
          .query("reviewSessions")
          .withIndex("by_round_team_status", (index) =>
            index.eq("roundId", round._id).eq("teamId", team._id),
          )
          .take(maximumReviewSessionsPerTeamRound + 1),
      ]);
    const panelSessions = [
      ...awaitingPanelSessions,
      ...activePanelSessions,
      ...scoringPanelSessions,
    ];
    if (panelSessions.length > 1) {
      throw new Error("A review panel has more than one live review.");
    }
    if (teamSessions.length > maximumReviewSessionsPerTeamRound) {
      throw new Error("A team exceeds the review-attempt limit for this round.");
    }
    if (
      panelSessions.some((session) => isLiveReviewStatus(session.status)) ||
      teamSessions.some((session) => isLiveReviewStatus(session.status))
    ) {
      throw new ConvexError({
        code: "REVIEW_ALREADY_ACTIVE",
        message: "The panel or team already has a live review.",
      });
    }
    const assignmentCapacity = await Promise.all(
      members.map((member) =>
        ctx.db
          .query("reviewAssignments")
          .withIndex("by_event_person_status", (index) =>
            index
              .eq("eventId", event._id)
              .eq("reviewerPersonId", member.personId)
              .eq("status", "assigned"),
          )
          .take(maximumReviewerAssignmentsPerEvent),
      ),
    );
    if (assignmentCapacity.some((rows) => rows.length === maximumReviewerAssignmentsPerEvent,
    )) {
      throw new ConvexError({
        code: "REVIEWER_ASSIGNMENT_LIMIT_REACHED",
        message: `A reviewer can receive at most ${maximumReviewerAssignmentsPerEvent} review assignments in one event.`,
      });
    }
    if (!event.publishedAttendancePlanVersionId) {
      throw new ConvexError({
        code: "PARTICIPANT_PRESENCE_UNAVAILABLE",
        message: "Publish the attendance plan before calling teams.",
      });
    }
    const participantAvailability = await readReviewParticipantAvailability(ctx, {
      eventId: event._id,
      teamId: team._id,
    });
    let participantAvailabilityWaiverGrantIds: Array<Id<"permissionGrants">> = [];
    if (participantAvailability.availableCount < round.minimumPresentParticipants) {
      if (participantAvailabilityOverrideReason === undefined) {
        throw new ConvexError({
          code: "TEAM_REGROUP_REQUIRED",
          message: `Only ${participantAvailability.availableCount} team members are currently inside; this round requires ${round.minimumPresentParticipants}.`,
        });
      }
      participantAvailabilityWaiverGrantIds = await requirePermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "review.participant_availability.waive",
        scopeType: "team",
        scopeId: team._id,
      });
    } else if (participantAvailabilityOverrideReason !== undefined) {
      throw new ConvexError({
        code: "PARTICIPANT_AVAILABILITY_EXCEPTION_NOT_NEEDED",
        message: "The team already meets this round's participant-availability rule.",
      });
    }
    const now = Date.now();
    const evidence = await createEvidenceCheckpoint(ctx, {
      eventId: event._id,
      round,
      team,
      actorPersonId: person._id,
      createdAt: now,
    });
    const reviewSessionId = await ctx.db.insert("reviewSessions", {
      eventId: event._id,
      roundId: round._id,
      panelId: panel._id,
      teamId: team._id,
      projectVersionId: evidence.projectVersionId,
      evidenceCheckpointSetId: evidence.checkpointId,
      rubricVersionId: round.rubricVersionId,
      panelVersion: panel.version,
      status: "awaiting_presence",
      extensionCount: 0,
      extensionSeconds: 0,
      sharedNotesVersion: 0,
      version: 1,
      createdByPersonId: person._id,
      createdAt: now,
      updatedAt: now,
    });
    if (participantAvailabilityOverrideReason !== undefined) {
      await createReviewParticipantAvailabilityWaiver(ctx, {
        eventId: event._id,
        roundId: round._id,
        teamId: team._id,
        reviewSessionId,
        requiredCount: round.minimumPresentParticipants,
        observedCount: participantAvailability.availableCount,
        grantedByPersonId: person._id,
        grantIds: participantAvailabilityWaiverGrantIds,
        reason: participantAvailabilityOverrideReason,
        createdAt: now,
      });
      await writeAuditEvent(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        permissionKey: "review.participant_availability.waive",
        grantIds: participantAvailabilityWaiverGrantIds,
        scopeType: "team",
        scopeId: team._id,
        action: "review.participant_availability_waived",
        targetType: "review_session",
        targetId: reviewSessionId,
        nextSummary: JSON.stringify({
          requiredCount: round.minimumPresentParticipants,
          observedCount: participantAvailability.availableCount,
        }),
        reason: participantAvailabilityOverrideReason,
      });
    }
    for (const member of members) {
      const assignmentId = await ctx.db.insert("reviewAssignments", {
        eventId: event._id,
        roundId: round._id,
        panelId: panel._id,
        reviewSessionId,
        reviewerPersonId: member.personId,
        eventAccessSubjectId: member.eventAccessSubjectId,
        assignedCriterionIds: member.assignedCriterionIds,
        isCoordinator: member.isCoordinator,
        status: "assigned",
        assignedAt: now,
      });
      const scorecardId = await ctx.db.insert("scorecards", {
        eventId: event._id,
        roundId: round._id,
        reviewSessionId,
        reviewerPersonId: member.personId,
        assignmentId,
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
        reviewSessionId,
        scorecardId,
        assignmentId,
        reviewerPersonId: member.personId,
        eventAccessSubjectId: member.eventAccessSubjectId,
        grantedByPersonId: person._id,
        isCoordinator: member.isCoordinator,
      });
    }
    await patchTeamRoundState(ctx, state, {
      state: "called",
      calledAt: now,
      callAttemptCount: state.callAttemptCount + 1,
      lastCallAttemptAt: now,
      version: state.version + 1,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    const calledState = await ctx.db.get(state._id);
  if (!calledState) throw new Error("Called team state missing.");
  await notifyReviewTeam(ctx, calledState, "called", now);
  const result = {
      reviewSessionId,
      evidenceCompleteness: evidence.completeness,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.team.call",
      requestFingerprint,
      targetType: "review_session",
      targetId: reviewSessionId,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.prepare",
      grantIds,
      scopeType: "panel",
      scopeId: panel._id,
      action: "review.team_called",
      targetType: "review_session",
      targetId: reviewSessionId,
      nextSummary: JSON.stringify({
        teamId: team._id,
        panelId: panel._id,
        assignmentCount: members.length,
        evidenceCheckpointSetId: evidence.checkpointId,
        evidenceCompleteness: evidence.completeness,
      }),
      reason,
    });
    return result;
}
const callTeamArgsValidator = v.object(callTeamArgs);
export const callTeam = mutation({
  args: callTeamArgs,
  returns: v.object({
    reviewSessionId: v.id("reviewSessions"),
    evidenceCompleteness: v.union(
      v.literal("complete"),
      v.literal("partial"),
      v.literal("missing"),
    ),
  }),
  handler: async (ctx, args) => {
    const { person } = await requireCurrentPerson(ctx);
    return callQueuedTeam(ctx, args, person._id);
  },
});

export const startReview = mutation({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    reviewSessionId: v.id("reviewSessions"),
    startedAt: v.number(),
    plannedEndAt: v.number(),
    serverNow: v.number(),
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const requestFingerprint = operationFingerprint([
      args.reviewSessionId,
      args.expectedVersion,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.session.start",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "review start",
        startReviewOperationResult,
      );
      const reviewSessionId = ctx.db.normalizeId("reviewSessions", result.reviewSessionId,
      );
      if (!reviewSessionId || reviewSessionId !== prior.targetId) {
        throw new Error("The stored review-start result is invalid.");
      }
      return {
        reviewSessionId,
        startedAt: result.startedAt,
        plannedEndAt: result.plannedEndAt,
        serverNow: result.serverNow,
        version: result.version,
      };
    }
    const session = await ctx.db.get(args.reviewSessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({ code: "REVIEW_NOT_FOUND", message: "That review is unavailable.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.start",
      scopeType: "review",
      scopeId: session._id,
    });
    const [round, panel] = await Promise.all([
      ctx.db.get(session.roundId),
      ctx.db.get(session.panelId),
    ]);
    if (
      !round ||
      !panel ||
      round.eventId !== event._id ||
      panel.eventId !== event._id ||
      panel.status !== "ready" ||
      round.status !== "open"
    ) {
      throw new ConvexError({ code: "ROUND_NOT_OPEN", message: "This review round is not open.",
      });
    }
    if (await findActiveRoundPause(ctx, round._id)) {
      throw new ConvexError({
        code: "ROUND_PAUSED",
        message: "New review starts are paused for this round.",
      });
    }
    await requireReviewProgression(ctx, round, session.teamId);
    const now = Date.now();
    if (
      session.status !== "awaiting_presence" ||
      session.version !== args.expectedVersion ||
      now < round.startsAt ||
      now >= round.endsAt
    ) {
      throw new ConvexError({
        code: "REVIEW_NOT_STARTABLE",
        message: "The review state, version, or published round window changed.",
      });
    }
    const assignments = await ctx.db
      .query("reviewAssignments")
      .withIndex("by_session_person", (index) => index.eq("reviewSessionId", session._id),
      )
      .collect();
    const assigned = assignments.filter((assignment) => assignment.status === "assigned",
    );
    if (assigned.length !== round.requiredPanelSize) {
      throw new ConvexError({
        code: "REVIEW_ASSIGNMENT_INCOMPLETE",
        message: "The fixed reviewer assignment is incomplete.",
      });
    }
    await ensurePanelReady(ctx, round, panel, session.teamId);
    for (const assignment of assigned) {
      await requireConfirmedReviewer(
        ctx,
        round,
        assignment.reviewerPersonId,
        now,
      );
      const [presence, conflict] = await Promise.all([
        ctx.db
          .query("reviewPresence")
          .withIndex("by_session_reviewer", (index) =>
            index
              .eq("reviewSessionId", session._id)
              .eq("reviewerPersonId", assignment.reviewerPersonId),
          )
          .unique(),
        ctx.db
          .query("reviewerConflicts")
          .withIndex("by_reviewer_team_status", (index) =>
            index
              .eq("reviewerPersonId", assignment.reviewerPersonId)
              .eq("teamId", session.teamId)
              .eq("status", "active"),
          )
          .first(),
      ]);
      if (conflict) {
        throw new ConvexError({
          code: "REVIEWER_CONFLICT_ACTIVE",
          message:
            "A fixed reviewer has an active conflict with this team. Replace that reviewer before starting.",
        });
      }
      if (!presence) {
        throw new ConvexError({
          code: "REVIEWER_PRESENCE_INCOMPLETE",
          message: "Every assigned reviewer must scan this team before the review starts.",
        });
      }
    }
    if (!event.publishedAttendancePlanVersionId) {
      throw new ConvexError({
        code: "PARTICIPANT_PRESENCE_UNAVAILABLE",
        message: "Publish the attendance plan before starting reviews.",
      });
    }
    const [participantAvailability, participantAvailabilityWaiver] = await Promise.all([
      readReviewParticipantAvailability(ctx, {
        eventId: event._id,
        teamId: session.teamId,
      }),
      findReviewParticipantAvailabilityWaiver(ctx, session._id),
    ]);
    if (
      participantAvailability.availableCount < round.minimumPresentParticipants &&
      participantAvailabilityWaiver === null
    ) {
      throw new ConvexError({
        code: "TEAM_REGROUP_REQUIRED",
        message: `Only ${participantAvailability.availableCount} team members are currently inside; this round requires ${round.minimumPresentParticipants}.`,
      });
    }
    const state = await ctx.db
      .query("teamRoundStates")
      .withIndex("by_round_team", (index) =>
        index.eq("roundId", round._id).eq("teamId", session.teamId),
      )
      .unique();
    if (
      !state ||
      !["called", "at_table"].includes(state.state) ||
      state.panelId !== session.panelId
    ) {
      throw new ConvexError({
        code: "QUEUE_STATE_CHANGED",
        message: "The team is no longer called to this panel.",
      });
    }
    const plannedEndAt = now + round.reviewDurationSeconds * 1_000;
    const team = await ctx.db.get(session.teamId);
    if (!team) throw new Error("Review team is missing.");
    const evidence = await createEvidenceCheckpoint(ctx, {
      eventId: event._id,
      round,
      team,
      actorPersonId: person._id,
      createdAt: now,
    });
    const questionSetId = await prepareQuestionSet(
      ctx,
      round,
      team,
      evidence.snapshot,
    );
    await ctx.db.patch(session._id, {
      status: "active",
      questionSetId,
      projectVersionId: evidence.projectVersionId,
      evidenceCheckpointSetId: evidence.checkpointId,
      startedAt: now,
      plannedEndAt,
      version: session.version + 1,
      updatedAt: now,
    });
    await patchTeamRoundState(ctx, state, {
      state: "in_review",
      version: state.version + 1,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(plannedEndAt, internal.reviewOperations.finishDiscussionAtDeadline, {
      reviewSessionId: session._id,
      expectedPlannedEndAt: plannedEndAt,
    },
    );
    const result = {
      reviewSessionId: session._id,
      startedAt: now,
      plannedEndAt,
      serverNow: now,
      version: session.version + 1,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.session.start",
      requestFingerprint,
      targetType: "review_session",
      targetId: session._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.start",
      grantIds,
      scopeType: "review",
      scopeId: session._id,
      action: "review.session_started",
      targetType: "review_session",
      targetId: session._id,
      previousSummary: JSON.stringify({ status: session.status, version: session.version,
      }),
      nextSummary: JSON.stringify({
        status: "active",
        startedAt: now,
        plannedEndAt,
        version: session.version + 1,
      }),
      reason: normalizedText(args.reason, "Reason", 3, 300),
    });
    return result;
  },
});

export const finishDiscussionAtDeadline = internalMutation({
  args: {
    reviewSessionId: v.id("reviewSessions"),
    expectedPlannedEndAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.reviewSessionId);
    if (
      !session ||
      session.status !== "active" ||
      session.plannedEndAt !== args.expectedPlannedEndAt ||
      Date.now() < args.expectedPlannedEndAt
    ) {
      return null;
    }
    await ctx.db.patch(session._id, {
      status: "scoring",
      version: session.version + 1,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const endDiscussion = mutation({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    expectedVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const requestFingerprint = operationFingerprint([
      args.reviewSessionId,
      args.expectedVersion,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.discussion.end",
      requestFingerprint,
    });
    if (prior)
      return {
        version: storedOperationVersion(prior.resultJson, "discussion end"),
      };
    const session = await ctx.db.get(args.reviewSessionId);
    if (!session || session.eventId !== event._id)
      throw new ConvexError({
        code: "REVIEW_NOT_FOUND",
        message: "That review is unavailable.",
      });
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.complete",
      scopeType: "review",
      scopeId: session._id,
    });
    const round = await ctx.db.get(session.roundId);
    if (
      !round ||
      round.status !== "open" ||
      session.status !== "active" ||
      session.version !== args.expectedVersion
    ) {
      throw new ConvexError({
        code: "REVIEW_CHANGED",
        message: "The discussion or round changed. Refresh before ending it.",
      });
    }
    const now = Date.now();
    const version = session.version + 1;
    await ctx.db.patch(session._id, {
      status: "scoring",
      plannedEndAt: Math.min(now, session.plannedEndAt ?? now),
      version,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.discussion.end",
      requestFingerprint,
      targetType: "review_session",
      targetId: session._id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.complete",
      grantIds,
      scopeType: "review",
      scopeId: session._id,
      action: "review.discussion_ended",
      targetType: "review_session",
      targetId: session._id,
      previousSummary: JSON.stringify({ status: session.status }),
      nextSummary: JSON.stringify({ status: "scoring", version }),
      reason:
        "Coordinator ended the discussion; reviewers can finish scores and comments",
    });
    return { version };
  },
});

export const extendReview = mutation({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ plannedEndAt: v.number(), extensionCount: v.number(), version: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const requestFingerprint = operationFingerprint([
      args.reviewSessionId,
      args.expectedVersion,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.session.extend",
      requestFingerprint,
    });
    if (prior) {
      const reviewSessionId = ctx.db.normalizeId("reviewSessions", prior.targetId,
      );
      if (!reviewSessionId) throw new Error("The stored review extension is invalid.");
      return storedOperationResult(
        prior.resultJson,
        "review extension",
        extendReviewOperationResult,
      );
    }
    const session = await ctx.db.get(args.reviewSessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({ code: "REVIEW_NOT_FOUND", message: "That review is unavailable.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.timer.extend",
      scopeType: "review",
      scopeId: session._id,
    });
    const round = await ctx.db.get(session.roundId);
    if (
      !round ||
      session.status !== "active" ||
      !session.plannedEndAt ||
      Date.now() >= session.plannedEndAt ||
      session.version !== args.expectedVersion ||
      round.ordinaryExtensionSeconds < 1 ||
      session.extensionCount >= round.maximumOrdinaryExtensions
    ) {
      throw new ConvexError({
        code: "EXTENSION_NOT_AVAILABLE",
        message: "The ordinary extension is not available.",
      });
    }
    const now = Date.now();
    const plannedEndAt = session.plannedEndAt + round.ordinaryExtensionSeconds * 1_000;
    const extensionCount = session.extensionCount + 1;
    await ctx.db.patch(session._id, {
      status: "active",
      plannedEndAt,
      extensionCount,
      extensionSeconds: session.extensionSeconds + round.ordinaryExtensionSeconds,
      version: session.version + 1,
      updatedAt: now,
    });
    if (plannedEndAt > now) {
      await ctx.scheduler.runAt(plannedEndAt, internal.reviewOperations.finishDiscussionAtDeadline, {
        reviewSessionId: session._id,
        expectedPlannedEndAt: plannedEndAt,
      },
      );
    }
    const result = {
      plannedEndAt,
      extensionCount,
      version: session.version + 1,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.session.extend",
      requestFingerprint,
      targetType: "review_session",
      targetId: session._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.timer.extend",
      grantIds,
      scopeType: "review",
      scopeId: session._id,
      action: "review.session_extended",
      targetType: "review_session",
      targetId: session._id,
      previousSummary: JSON.stringify({
        plannedEndAt: session.plannedEndAt,
        extensionCount: session.extensionCount,
        version: session.version,
      }),
      nextSummary: JSON.stringify({ plannedEndAt, extensionCount, version: session.version + 1,
      }),
      reason: normalizedText(args.reason, "Reason", 3, 300),
    });
    return result;
  },
});

export const saveSharedNotes = mutation({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    findings: v.string(),
    commitments: v.string(),
    expectedNotesVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ sharedNotesVersion: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const requestFingerprint = operationFingerprint([
      args.reviewSessionId,
      args.findings,
      args.commitments,
      args.expectedNotesVersion,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.shared_notes.save",
      requestFingerprint,
    });
    if (prior) {
      const reviewSessionId = ctx.db.normalizeId("reviewSessions", prior.targetId,
      );
      if (!reviewSessionId) throw new Error("Prior shared-notes result is invalid.");
      return {
        sharedNotesVersion: storedOperationVersion(prior.resultJson, "shared notes",
        ),
      };
    }
    const session = await ctx.db.get(args.reviewSessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({ code: "REVIEW_NOT_FOUND", message: "That review is unavailable.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.shared_notes.write",
      scopeType: "review",
      scopeId: session._id,
    });
    if (
      !["active", "scoring"].includes(session.status) ||
      session.sharedNotesVersion !== args.expectedNotesVersion
    ) {
      throw new ConvexError({
        code: "SHARED_NOTES_CHANGED",
        message: "The review or shared notes changed. Refresh before saving.",
      });
    }
    const findings = normalizedText(args.findings, "Findings", 1, 2_000);
    const commitments = normalizedText(args.commitments, "Commitments", 1, 2_000,
    );
    const now = Date.now();
    await ctx.db.patch(session._id, {
      sharedFindings: findings,
      sharedCommitments: commitments,
      sharedNotesVersion: session.sharedNotesVersion + 1,
      sharedNotesByPersonId: person._id,
      version: session.version + 1,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.shared_notes.save",
      requestFingerprint,
      targetType: "review_session",
      targetId: session._id,
      resultJson: String(session.sharedNotesVersion + 1),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.shared_notes.write",
      grantIds,
      scopeType: "review",
      scopeId: session._id,
      action: "review.shared_notes_saved",
      targetType: "review_session",
      targetId: session._id,
      previousSummary: JSON.stringify({ sharedNotesVersion: session.sharedNotesVersion,
      }),
      nextSummary: JSON.stringify({ sharedNotesVersion: session.sharedNotesVersion + 1,
      }),
      reason: "Panel coordinator saved shared review notes",
    });
    return { sharedNotesVersion: session.sharedNotesVersion + 1 };
  },
});

export const completeReview = mutation({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ reviewSessionId: v.id("reviewSessions"), completedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const requestFingerprint = operationFingerprint([
      args.reviewSessionId,
      args.expectedVersion,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.session.complete",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "review completion",
        completeReviewOperationResult,
      );
      const reviewSessionId = ctx.db.normalizeId("reviewSessions", result.reviewSessionId,
      );
      if (!reviewSessionId || reviewSessionId !== prior.targetId) {
        throw new Error("The stored review-completion result is invalid.");
      }
      return { reviewSessionId, completedAt: result.completedAt };
    }
    const session = await ctx.db.get(args.reviewSessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({ code: "REVIEW_NOT_FOUND", message: "That review is unavailable.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.complete",
      scopeType: "review",
      scopeId: session._id,
    });
    const round = await ctx.db.get(session.roundId);
    const rubric = await ctx.db.get(session.rubricVersionId);
    if (
      !round ||
      !rubric ||
      round.status !== "open" ||
      !["active", "scoring"].includes(session.status) ||
      session.version !== args.expectedVersion
    ) {
      throw new ConvexError({
        code: "REVIEW_NOT_COMPLETABLE",
        message: "The review, round, rubric, or expected version changed.",
      });
    }
    if (
      round.requiresSharedCommitments &&
      (!session.sharedFindings?.trim() || !session.sharedCommitments?.trim())
    ) {
      throw new ConvexError({
        code: "SHARED_NOTES_REQUIRED",
        message: "Save the panel findings and next-checkpoint commitments first.",
      });
    }
    const [draftManualRecord, submittedManualRecord] = await Promise.all([
      ctx.db
        .query("manualReviewRecords")
        .withIndex("by_review_status_created", (index) =>
          index.eq("reviewSessionId", session._id).eq("status", "draft"),
        )
        .first(),
      ctx.db
        .query("manualReviewRecords")
        .withIndex("by_review_status_created", (index) =>
          index.eq("reviewSessionId", session._id).eq("status", "submitted"),
        )
        .first(),
    ]);
    if (draftManualRecord || submittedManualRecord) {
      throw new ConvexError({
        code: "PAPER_REVIEW_PENDING",
        message: "Reject or import the pending paper review before ordinary completion.",
      });
    }
    const existingEvaluation = await ctx.db
      .query("reviewEvaluations")
      .withIndex("by_session", (index) => index.eq("reviewSessionId", session._id),
      )
      .unique();
    if (existingEvaluation) throw new Error("An evaluation already exists for an open review.");
    const evaluation = await computeReviewEvaluation(ctx, { round, session, rubric,
    });
    const now = Date.now();
    await ctx.db.insert("reviewEvaluations", {
      eventId: event._id,
      roundId: round._id,
      reviewSessionId: session._id,
      teamId: session.teamId,
      rubricVersionId: rubric._id,
      criterionResults: evaluation.criterionResults,
      totalPoints: evaluation.totalPoints,
      state: "complete",
      inputChecksum: evaluation.inputChecksum,
      version: 1,
      computedAt: now,
    });
    await ctx.db.patch(session._id, {
      status: "completed",
      completedAt: now,
      version: session.version + 1,
      updatedAt: now,
    });
    const state = await ctx.db
      .query("teamRoundStates")
      .withIndex("by_round_team", (index) =>
        index.eq("roundId", round._id).eq("teamId", session.teamId),
      )
      .unique();
    if (!state || state.state !== "in_review" || state.panelId !== session.panelId) {
      throw new Error("The active review no longer matches the team queue state.",
      );
    }
    await patchTeamRoundState(ctx, state, {
      state: "completed",
      completedAt: now,
      version: state.version + 1,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    const result = { reviewSessionId: session._id, completedAt: now };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.session.complete",
      requestFingerprint,
      targetType: "review_session",
      targetId: session._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.complete",
      grantIds,
      scopeType: "review",
      scopeId: session._id,
      action: "review.session_completed",
      targetType: "review_session",
      targetId: session._id,
      previousSummary: JSON.stringify({ status: session.status, version: session.version,
      }),
      nextSummary: JSON.stringify({
        status: "completed",
        scorecardCount: evaluation.submittedScorecardCount,
        criterionCount: evaluation.criterionResults.length,
        version: session.version + 1,
      }),
      reason: normalizedText(args.reason, "Reason", 3, 300),
    });
    return result;
  },
});
