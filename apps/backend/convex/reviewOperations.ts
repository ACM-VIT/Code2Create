import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireFreshAuthSession,
  sensitiveCommandSessionMaxAgeMs,
} from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { grantReviewAssignmentAccess } from "./lib/reviewAccess";
import {
  createReviewParticipantAvailabilityWaiver,
  findReviewParticipantAvailabilityWaiver,
  readReviewParticipantAvailability,
} from "./lib/reviewParticipantAvailability";
import { activeRoundPause as findActiveRoundPause } from "./lib/reviewRoundPauses";
import { computeReviewEvaluation } from "./lib/reviewScores";
import { normalizedText } from "./lib/strings";
import {
  reviewPanelStatus,
  reviewRoundStatus,
  reviewSessionStatus,
  teamRoundState,
} from "./values";

const liveReviewStatuses = ["awaiting_presence", "active", "overdue"] as const;
type EvidenceCompleteness = "complete" | "partial" | "missing";
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
    tableLabel: string;
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

function isLiveReviewStatus(status: Doc<"reviewSessions">["status"]) {
  return liveReviewStatuses.some((candidate) => candidate === status);
}

function isReviewableTeam(team: Doc<"teams">) {
  return (
    ["confirmed", "checked_in", "active"].includes(team.status) &&
    team.membershipLocked &&
    team.trackLocked &&
    team.lockedProjectVersionId !== undefined
  );
}

async function requireRound(
  ctx: MutationCtx,
  eventId: Id<"events">,
  roundId: Id<"reviewRounds">,
) {
  const round = await ctx.db.get(roundId);
  if (!round || round.eventId !== eventId) {
    throw new ConvexError({ code: "ROUND_NOT_FOUND", message: "That review round is unavailable." });
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
    throw new ConvexError({ code: "PANEL_NOT_FOUND", message: "That review panel is unavailable." });
  }
  return panel;
}

async function requireReviewTeam(
  ctx: MutationCtx,
  eventId: Id<"events">,
  teamId: Id<"teams">,
) {
  const team = await ctx.db.get(teamId);
  if (
    !team ||
    team.eventId !== eventId ||
    !isReviewableTeam(team)
  ) {
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
    throw new ConvexError({ code: "PANEL_NOT_READY", message: "This panel is not ready to receive a team." });
  }
  const members = await ctx.db
    .query("reviewPanelMembers")
    .withIndex("by_panel_status", (index) =>
      index.eq("panelId", panel._id).eq("status", "active"),
    )
    .collect();
  if (members.length !== round.requiredPanelSize) {
    throw new ConvexError({ code: "PANEL_INCOMPLETE", message: "This panel does not have its published reviewer count." });
  }
  for (const member of members) {
    const conflict = await ctx.db
      .query("reviewerConflicts")
      .withIndex("by_reviewer_team_status", (index) =>
        index
          .eq("reviewerPersonId", member.personId)
          .eq("teamId", teamId)
          .eq("status", "active"),
      )
      .first();
    if (conflict) {
      throw new ConvexError({
        code: "PANEL_CONFLICT",
        message: "A current panel member has an active conflict with this team.",
      });
    }
  }
  return members;
}

async function latestGithubSnapshot(
  ctx: MutationCtx,
  bindingId: Id<"githubRepositoryBindings">,
) {
  return ctx.db
    .query("githubRepositorySnapshots")
    .withIndex("by_binding_time", (index) => index.eq("repositoryBindingId", bindingId))
    .order("desc")
    .first();
}

async function latestFigmaSnapshot(
  ctx: MutationCtx,
  bindingId: Id<"figmaFileBindings">,
) {
  return ctx.db
    .query("figmaFileSnapshots")
    .withIndex("by_binding_time", (index) => index.eq("figmaFileBindingId", bindingId))
    .order("desc")
    .first();
}

export async function createEvidenceCheckpoint(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    round: Doc<"reviewRounds">;
    team: Doc<"teams">;
    actorPersonId: Id<"people">;
    createdAt: number;
  },
) {
  const projectVersionId = args.team.lockedProjectVersionId;
  if (!projectVersionId) throw new Error("Validated review team has no project version.");
  const [githubBindings, figmaBindings, previousCheckpoint, teamCheckpointSubmission] = await Promise.all([
    ctx.db
      .query("githubRepositoryBindings")
      .withIndex("by_team_state", (index) => index.eq("teamId", args.team._id))
      .collect(),
    ctx.db
      .query("figmaFileBindings")
      .withIndex("by_team_state", (index) => index.eq("teamId", args.team._id))
      .collect(),
    ctx.db
      .query("reviewEvidenceCheckpointSets")
      .withIndex("by_team_round_sequence_created", (index) =>
        index.eq("teamId", args.team._id).lt("roundSequence", args.round.sequence),
      )
      .order("desc")
      .first(),
    ctx.db
      .query("teamCheckpointSubmissions")
      .withIndex("by_team_submitted", (index) =>
        index.eq("teamId", args.team._id).lte("submittedAt", args.createdAt),
      )
      .order("desc")
      .first(),
  ]);
  if (previousCheckpoint && previousCheckpoint.eventId !== args.eventId) {
    throw new Error("A previous evidence checkpoint belongs to another event.");
  }
  const activeGithub = githubBindings
    .filter((binding) => binding.state !== "archived")
    .sort((left, right) => left.displayOrder - right.displayOrder);
  const activeFigma = figmaBindings
    .filter((binding) => binding.state !== "archived")
    .sort((left, right) => left.connectedAt - right.connectedAt);
  const githubEntries = await Promise.all(
    activeGithub.map(async (binding) => {
      const snapshot = await latestGithubSnapshot(ctx, binding._id);
      return {
        bindingId: binding._id,
        ...(snapshot ? { snapshotId: snapshot._id } : {}),
        repositoryName: binding.fullName,
        repositoryUrl: binding.url,
        kind: binding.kind,
        purpose: binding.purpose,
        trackedBranch: binding.trackedBranch,
        ...(binding.rootPath !== undefined ? { rootPath: binding.rootPath } : {}),
        requiredTopic: binding.requiredTopic,
        stateAtCapture: binding.state,
      };
    }),
  );
  const figmaEntries = await Promise.all(
    activeFigma.map(async (binding) => {
      const snapshot = await latestFigmaSnapshot(ctx, binding._id);
      return {
        bindingId: binding._id,
        ...(snapshot ? { snapshotId: snapshot._id } : {}),
        fileName: binding.name,
        fileUrl: binding.url,
        role: binding.role,
        editorType: binding.editorType,
        stateAtCapture: binding.state,
      };
    }),
  );
  const expectedResourceCount = githubEntries.length + figmaEntries.length;
  const capturedResourceCount =
    githubEntries.filter((entry) => entry.snapshotId !== undefined).length +
    figmaEntries.filter((entry) => entry.snapshotId !== undefined).length;
  const completeness: EvidenceCompleteness =
    expectedResourceCount === 0 || capturedResourceCount === expectedResourceCount
      ? "complete"
      : capturedResourceCount === 0
        ? "missing"
        : "partial";
  const checksum = operationFingerprint([
    projectVersionId,
    teamCheckpointSubmission?._id ?? "no_team_checkpoint",
    previousCheckpoint?._id ?? "first_checkpoint",
    JSON.stringify(githubEntries),
    JSON.stringify(figmaEntries),
  ]);
  const checkpointId = await ctx.db.insert("reviewEvidenceCheckpointSets", {
    eventId: args.eventId,
    roundId: args.round._id,
    roundSequence: args.round.sequence,
    teamId: args.team._id,
    projectVersionId,
    ...(teamCheckpointSubmission
      ? { teamCheckpointSubmissionId: teamCheckpointSubmission._id }
      : {}),
    ...(previousCheckpoint ? { previousCheckpointSetId: previousCheckpoint._id } : {}),
    githubEntries,
    figmaEntries,
    expectedResourceCount,
    capturedResourceCount,
    completeness,
    checksum,
    createdByPersonId: args.actorPersonId,
    createdAt: args.createdAt,
  });
  return { checkpointId, projectVersionId, completeness };
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
            tableLabel: v.string(),
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
  const [rounds, eventTeams] = await Promise.all([
    ctx.db
      .query("reviewRounds")
      .withIndex("by_event_status_start", (index) => index.eq("eventId", event._id))
      .collect(),
    ctx.db
      .query("teams")
      .withIndex("by_event_status", (index) => index.eq("eventId", event._id))
      .collect(),
  ]);
  const reviewableTeams = eventTeams.filter(isReviewableTeam);
  const visible: OverviewRoundView[] = [];
  for (const round of rounds) {
    const grants = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.read",
      scopeType: "round",
      scopeId: round._id,
    });
    if (grants.length === 0) continue;
    const [manageGrants, panels, states, pause] = await Promise.all([
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
        .collect(),
      ctx.db
        .query("teamRoundStates")
        .withIndex("by_round_state_priority_queued", (index) => index.eq("roundId", round._id))
        .collect(),
      findActiveRoundPause(ctx, round._id),
    ]);
    const panelRows = await Promise.all(
      panels.map(async (panel) => {
        const [queued, sessions] = await Promise.all([
          ctx.db
            .query("teamRoundStates")
            .withIndex("by_panel_state_priority_queued", (index) =>
              index.eq("panelId", panel._id),
            )
            .collect(),
          ctx.db
            .query("reviewSessions")
            .withIndex("by_panel_status", (index) => index.eq("panelId", panel._id))
            .collect(),
        ]);
        return {
          id: panel._id,
          name: panel.name,
          tableLabel: panel.tableLabel,
          status: panel.status,
          queuedCount: queued.filter((state) => state.state === "queued").length,
          activeReviewCount: sessions.filter((session) => isLiveReviewStatus(session.status)).length,
        };
      }),
    );
    const stateTeamIds = new Set(states.map((state) => state.teamId));
    visible.push({
      id: round._id,
      name: round.name,
      status: round.status,
      startsAt: round.startsAt,
      endsAt: round.endsAt,
      version: round.version,
      canManage: manageGrants.length > 0,
      isPaused: pause !== null,
      panels: panelRows,
      stateCounts: {
        unassigned:
          states.filter((state) => state.state === "unassigned").length +
          reviewableTeams.filter((team) => !stateTeamIds.has(team._id)).length,
        queued: states.filter((state) => state.state === "queued").length,
        called: states.filter((state) => state.state === "called" || state.state === "at_table").length,
        inReview: states.filter((state) => state.state === "in_review").length,
        completed: states.filter((state) => state.state === "completed").length,
        held: states.filter((state) => state.state === "held").length,
      },
    });
  }
  return { rounds: visible.sort((left, right) => left.startsAt - right.startsAt) };
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
        tableLabel: v.string(),
        status: reviewPanelStatus,
        version: v.number(),
        canManageQueue: v.boolean(),
        canPrepareReview: v.boolean(),
        canPause: v.boolean(),
        reviewers: v.array(
          v.object({
            personId: v.id("people"),
            displayName: v.string(),
            isCoordinator: v.boolean(),
            clockInStatus: v.string(),
            unavailableReason: v.optional(v.string()),
            expectedReturnAt: v.optional(v.number()),
            lastHeartbeatAt: v.optional(v.number()),
            appBuild: v.optional(v.number()),
            encryptedDraftReady: v.optional(v.boolean()),
            deviceLastSeenAt: v.optional(v.number()),
          }),
        ),
      }),
    ),
    teams: v.array(
      v.object({
        stateId: v.optional(v.id("teamRoundStates")),
        teamId: v.id("teams"),
        teamName: v.string(),
        trackName: v.string(),
        state: teamRoundState,
        version: v.number(),
        queuedAt: v.optional(v.number()),
        panelId: v.optional(v.id("reviewPanels")),
        tableLabel: v.optional(v.string()),
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
        review: v.union(
          v.null(),
          v.object({
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
          }),
        ),
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
    throw new ConvexError({ code: "ROUND_NOT_FOUND", message: "That review round is unavailable." });
  }
  await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "round.read",
    scopeType: "round",
    scopeId: round._id,
  });
  const [panels, states, actorGrants, eventTeams, activePause] = await Promise.all([
    ctx.db
      .query("reviewPanels")
      .withIndex("by_round_status", (index) => index.eq("roundId", round._id))
      .collect(),
    ctx.db
      .query("teamRoundStates")
      .withIndex("by_round_state_priority_queued", (index) => index.eq("roundId", round._id))
      .collect(),
    ctx.db
      .query("permissionGrants")
      .withIndex("by_subject_permission_status", (index) =>
        index.eq("eventAccessSubjectId", subject._id),
      )
      .collect(),
    ctx.db
      .query("teams")
      .withIndex("by_event_status", (index) => index.eq("eventId", event._id))
      .collect(),
    findActiveRoundPause(ctx, round._id),
  ]);
  const statesByTeamId = new Map<Id<"teams">, Doc<"teamRoundStates">>();
  for (const state of states) {
    if (statesByTeamId.has(state.teamId)) {
      throw new Error("A team has more than one state in this review round.");
    }
    statesByTeamId.set(state.teamId, state);
  }
  const roundTeams = eventTeams.filter(
    (team) => statesByTeamId.has(team._id) || isReviewableTeam(team),
  );
  const now = Date.now();
  const activeActorGrants = actorGrants.filter(
    (grant) =>
      grant.eventId === event._id &&
      grant.status === "active" &&
      grant.validFrom <= now &&
      (grant.validUntil === undefined || grant.validUntil > now),
  );
  const allows = (
    permissionKey: string,
    scopes: ReadonlyArray<{ type: Doc<"permissionGrants">["scopeType"]; id: string }>,
  ) =>
    activeActorGrants.some(
      (grant) =>
        grant.permissionKey === permissionKey &&
        (grant.scopeType === "event" ||
          scopes.some(
            (scope) => grant.scopeType === scope.type && grant.scopeId === scope.id,
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
      canResume: allows("review.round.resume", [{ type: "round", id: round._id }]),
    };
  }
  const panelViews = await Promise.all(
    panels.map(async (panel) => {
      const [queueGrants, prepareGrants, members] = await Promise.all([
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "queue.manage",
          scopeType: "panel",
          scopeId: panel._id,
        }),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "review.prepare",
          scopeType: "panel",
          scopeId: panel._id,
        }),
        ctx.db
          .query("reviewPanelMembers")
          .withIndex("by_panel_status", (index) =>
            index.eq("panelId", panel._id).eq("status", "active"),
          )
          .collect(),
      ]);
      const reviewers = await Promise.all(
        members.map(async (member) => {
          const [person, clockIn, devices] = await Promise.all([
            ctx.db.get(member.personId),
            ctx.db
              .query("reviewerClockIns")
              .withIndex("by_round_person", (index) =>
                index
                  .eq("roundId", round._id)
                  .eq("reviewerPersonId", member.personId),
              )
              .unique(),
            ctx.db
              .query("reviewerDevices")
              .withIndex("by_event_person_status", (index) =>
                index
                  .eq("eventId", event._id)
                  .eq("personId", member.personId)
                  .eq("status", "active"),
              )
              .collect(),
          ]);
          if (!person) throw new Error("A review panel member no longer resolves to a person.");
          const device = devices.sort((left, right) => right.lastSeenAt - left.lastSeenAt)[0];
          return {
            personId: person._id,
            displayName: person.displayName,
            isCoordinator: member.isCoordinator,
            clockInStatus: clockIn?.status ?? "not_clocked_in",
            ...(clockIn?.unavailableReason !== undefined
              ? { unavailableReason: clockIn.unavailableReason }
              : {}),
            ...(clockIn?.expectedReturnAt !== undefined
              ? { expectedReturnAt: clockIn.expectedReturnAt }
              : {}),
            ...(clockIn?.lastHeartbeatAt !== undefined
              ? { lastHeartbeatAt: clockIn.lastHeartbeatAt }
              : {}),
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
      return {
        id: panel._id,
        name: panel.name,
        tableLabel: panel.tableLabel,
        status: panel.status,
        version: panel.version,
        canManageQueue: queueGrants.length > 0,
        canPrepareReview: prepareGrants.length > 0 && activePause === null,
        canPause: allows("review.panel.pause", [{ type: "panel", id: panel._id }]),
        reviewers,
      };
    }),
  );
  const teamRows = await Promise.all(
    roundTeams.map(async (team) => {
      const state = statesByTeamId.get(team._id);
      if (!team.lockedProjectVersionId) {
        throw new Error("A review queue row references an invalid team.");
      }
      const project = await ctx.db.get(team.lockedProjectVersionId);
      if (!project) throw new Error("A review queue team has no locked project.");
      const track = await ctx.db.get(project.coreTrackVersionId);
      if (!track) throw new Error("A review queue team has no published track.");
      const sessions = await ctx.db
        .query("reviewSessions")
        .withIndex("by_round_team_status", (index) =>
          index.eq("roundId", round._id).eq("teamId", team._id),
        )
        .collect();
      const review =
        sessions.find((session) => isLiveReviewStatus(session.status)) ??
        sessions
          .filter((session) => session.status === "completed")
          .sort((left, right) => right.createdAt - left.createdAt)[0] ??
        null;
      const [participantAvailability, participantAvailabilityWaiver] = await Promise.all([
        readReviewParticipantAvailability(ctx, {
          eventId: event._id,
          teamId: team._id,
        }),
        review
          ? findReviewParticipantAvailabilityWaiver(ctx, review._id)
          : Promise.resolve(null),
      ]);
      let reviewView: RoundBoardReviewView | null = null;
      if (review) {
        const [assignments, presences, scorecards, startGrants, completeGrants, waiveGrants] =
          await Promise.all([
            ctx.db
              .query("reviewAssignments")
              .withIndex("by_session_person", (index) =>
                index.eq("reviewSessionId", review._id),
              )
              .collect(),
            ctx.db
              .query("reviewPresence")
              .withIndex("by_session_reviewer", (index) =>
                index.eq("reviewSessionId", review._id),
              )
              .collect(),
            ctx.db
              .query("scorecards")
              .withIndex("by_session_status", (index) =>
                index.eq("reviewSessionId", review._id),
              )
              .collect(),
            matchingPermissionGrantIds(ctx, {
              eventId: event._id,
              eventAccessSubjectId: subject._id,
              permissionKey: "review.start",
              scopeType: "review",
              scopeId: review._id,
            }),
            matchingPermissionGrantIds(ctx, {
              eventId: event._id,
              eventAccessSubjectId: subject._id,
              permissionKey: "review.complete",
              scopeType: "review",
              scopeId: review._id,
            }),
            matchingPermissionGrantIds(ctx, {
              eventId: event._id,
              eventAccessSubjectId: subject._id,
              permissionKey: "review.presence.waive",
              scopeType: "review",
              scopeId: review._id,
            }),
          ]);
        const assigned = assignments.filter((assignment) => assignment.status === "assigned");
        const reviewerRows = [];
        for (const assignment of assigned) {
          const reviewer = await ctx.db.get(assignment.reviewerPersonId);
          if (!reviewer) throw new Error("A fixed review assignment references a missing reviewer.");
          const presence = presences.find(
            (row) => row.reviewerPersonId === assignment.reviewerPersonId,
          );
          reviewerRows.push({
            personId: reviewer._id,
            displayName: reviewer.displayName,
            ...(presence ? { presenceMethod: presence.method } : {}),
          });
        }
        reviewView = {
          id: review._id,
          status: review.status,
          version: review.version,
          ...(review.startedAt !== undefined ? { startedAt: review.startedAt } : {}),
          ...(review.plannedEndAt !== undefined
            ? { plannedEndAt: review.plannedEndAt }
            : {}),
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
            Boolean(review.sharedFindings?.trim() && review.sharedCommitments?.trim()),
          canStart: startGrants.length > 0 && activePause === null,
          canComplete: completeGrants.length > 0,
          canWaivePresence: waiveGrants.length > 0,
          reviewers: reviewerRows,
        };
      }
      const exceptionScopes = state
        ? [
            { type: "team" as const, id: state.teamId },
            { type: "round" as const, id: state.roundId },
            ...(state.panelId
              ? [{ type: "panel" as const, id: state.panelId }]
              : []),
          ]
        : [];
      const lastCallAt = state?.lastCallAttemptAt ?? state?.calledAt;
      return {
        ...(state ? { stateId: state._id } : {}),
        teamId: team._id,
        teamName: team.name,
        trackName: track.displayName,
        state: state?.state ?? "unassigned",
        version: state?.version ?? 0,
        ...(state?.queuedAt !== undefined ? { queuedAt: state.queuedAt } : {}),
        ...(state?.panelId !== undefined ? { panelId: state.panelId } : {}),
        ...(state?.tableLabel !== undefined ? { tableLabel: state.tableLabel } : {}),
        ...(state?.holdReason !== undefined ? { holdReason: state.holdReason } : {}),
        callAttemptCount: state?.callAttemptCount ?? 0,
        ...(lastCallAt !== undefined
          ? { missedEligibleAt: lastCallAt + round.missedCallGraceSeconds * 1_000 }
          : {}),
        canHold: state !== undefined && allows("review.queue.hold", exceptionScopes),
        canResume: state !== undefined && allows("review.queue.resume", exceptionScopes),
        canMarkMissed: state !== undefined && allows("review.queue.miss", exceptionScopes),
        canMove: state !== undefined && allows("review.queue.move", exceptionScopes),
        participantAvailability: {
          ...participantAvailability,
          requiredCount: round.minimumPresentParticipants,
          isMet:
            participantAvailability.availableCount >= round.minimumPresentParticipants,
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
    teams: teamRows.sort(
      (left, right) =>
        Number(right.state === "unassigned") - Number(left.state === "unassigned") ||
        (left.queuedAt ?? Number.MAX_SAFE_INTEGER) -
          (right.queuedAt ?? Number.MAX_SAFE_INTEGER) ||
        left.teamName.localeCompare(right.teamName),
    ),
  };
}


export const openRound = mutation({
  args: {
    eventSlug: v.string(),
    roundId: v.id("reviewRounds"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ roundId: v.id("reviewRounds"), status: v.literal("open"), version: v.number() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ roundId: Id<"reviewRounds">; status: "open"; version: number }> => {
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
      const saved = await ctx.db.get(roundId);
      if (!saved || saved.status !== "open") throw new Error("Prior open round no longer resolves.");
      return { roundId, status: "open", version: saved.version };
    }
    const round = await requireRound(ctx, event._id, args.roundId);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.manage",
      scopeType: "round",
      scopeId: round._id,
    });
    if (event.status !== "live" || round.status !== "published" || round.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "ROUND_NOT_OPENABLE",
        message: "The live event, published round, or expected version changed.",
      });
    }
    const now = Date.now();
    await ctx.db.patch(round._id, { status: "open", openedAt: now, version: round.version + 1 });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round.open",
      requestFingerprint,
      targetType: "review_round",
      targetId: round._id,
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
      previousSummary: JSON.stringify({ status: round.status, version: round.version }),
      nextSummary: JSON.stringify({ status: "open", version: round.version + 1 }),
      reason: normalizedText(args.reason, "Reason", 3, 300),
    });
    return { roundId: round._id, status: "open", version: round.version + 1 };
  },
});

export const queueTeam = mutation({
  args: {
    eventSlug: v.string(),
    roundId: v.id("reviewRounds"),
    panelId: v.id("reviewPanels"),
    teamId: v.id("teams"),
    expectedTeamRoundVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ teamRoundStateId: v.id("teamRoundStates"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Reason", 3, 300);
    const requestFingerprint = operationFingerprint([
      args.roundId,
      args.panelId,
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
      const teamRoundStateId = ctx.db.normalizeId("teamRoundStates", prior.targetId);
      if (!teamRoundStateId) throw new Error("Prior queue result is invalid.");
      const saved = await ctx.db.get(teamRoundStateId);
      if (!saved) throw new Error("Prior queue result no longer resolves.");
      return { teamRoundStateId, version: saved.version };
    }
    const [round, panel, team] = await Promise.all([
      requireRound(ctx, event._id, args.roundId),
      requirePanel(ctx, event._id, args.roundId, args.panelId),
      requireReviewTeam(ctx, event._id, args.teamId),
    ]);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "queue.manage",
      scopeType: "panel",
      scopeId: panel._id,
    });
    if (round.status !== "open") {
      throw new ConvexError({ code: "ROUND_NOT_OPEN", message: "This review round is not open." });
    }
    await ensurePanelReady(ctx, round, panel, team._id);
    const state = await ctx.db
      .query("teamRoundStates")
      .withIndex("by_round_team", (index) =>
        index.eq("roundId", round._id).eq("teamId", team._id),
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
      : await ctx.db.insert("teamRoundStates", {
          eventId: event._id,
          roundId: round._id,
          teamId: team._id,
          panelId: panel._id,
          state: "queued",
          tableLabel: panel.tableLabel,
          queuedAt: now,
          callAttemptCount: 0,
          priority: 0,
          version: nextVersion,
          updatedByPersonId: person._id,
          updatedAt: now,
        });
    if (state) {
      await ctx.db.patch(state._id, {
        panelId: panel._id,
        state: "queued",
        tableLabel: panel.tableLabel,
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
        ? { previousSummary: JSON.stringify({ state: state.state, version: state.version }) }
        : {}),
      nextSummary: JSON.stringify({ state: "queued", panelId: panel._id, version: nextVersion }),
      reason,
    });
    return { teamRoundStateId, version: nextVersion };
  },
});

export const callTeam = mutation({
  args: {
    eventSlug: v.string(),
    roundId: v.id("reviewRounds"),
    panelId: v.id("reviewPanels"),
    teamId: v.id("teams"),
    expectedTeamRoundVersion: v.number(),
    reason: v.string(),
    participantAvailabilityOverrideReason: v.optional(v.string()),
    clientOperationId: v.string(),
  },
  returns: v.object({
    reviewSessionId: v.id("reviewSessions"),
    evidenceCompleteness: v.union(
      v.literal("complete"),
      v.literal("partial"),
      v.literal("missing"),
    ),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    reviewSessionId: Id<"reviewSessions">;
    evidenceCompleteness: EvidenceCompleteness;
  }> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
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
      const reviewSessionId = ctx.db.normalizeId("reviewSessions", prior.targetId);
      if (!reviewSessionId) throw new Error("Prior call-team result is invalid.");
      const session = await ctx.db.get(reviewSessionId);
      if (!session) throw new Error("Prior call-team result no longer resolves.");
      const checkpoint = await ctx.db.get(session.evidenceCheckpointSetId);
      if (!checkpoint) throw new Error("Prior call-team evidence no longer resolves.");
      return { reviewSessionId, evidenceCompleteness: checkpoint.completeness };
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
      throw new ConvexError({ code: "ROUND_NOT_OPEN", message: "This review round is not open." });
    }
    if (await findActiveRoundPause(ctx, round._id)) {
      throw new ConvexError({
        code: "ROUND_PAUSED",
        message: "New review calls are paused for this round.",
      });
    }
    const members = await ensurePanelReady(ctx, round, panel, team._id);
    const state = await ctx.db
      .query("teamRoundStates")
      .withIndex("by_round_team", (index) =>
        index.eq("roundId", round._id).eq("teamId", team._id),
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
      const clockIn = await ctx.db
        .query("reviewerClockIns")
        .withIndex("by_round_person", (index) =>
          index.eq("roundId", round._id).eq("reviewerPersonId", member.personId),
        )
        .unique();
      if (!clockIn || clockIn.status !== "present") {
        throw new ConvexError({
          code: "PANEL_REVIEWER_NOT_PRESENT",
          message: "Every assigned reviewer must be clocked in before a team is called.",
        });
      }
    }
    const [panelSessions, teamSessions] = await Promise.all([
      ctx.db
        .query("reviewSessions")
        .withIndex("by_panel_status", (index) => index.eq("panelId", panel._id))
        .collect(),
      ctx.db
        .query("reviewSessions")
        .withIndex("by_round_team_status", (index) =>
          index.eq("roundId", round._id).eq("teamId", team._id),
        )
        .collect(),
    ]);
    if (
      panelSessions.some((session) => isLiveReviewStatus(session.status)) ||
      teamSessions.some((session) => isLiveReviewStatus(session.status))
    ) {
      throw new ConvexError({
        code: "REVIEW_ALREADY_ACTIVE",
        message: "The panel or team already has a live review.",
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
      await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
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
    await ctx.db.patch(state._id, {
      state: "called",
      calledAt: now,
      callAttemptCount: state.callAttemptCount + 1,
      lastCallAttemptAt: now,
      version: state.version + 1,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.team.call",
      requestFingerprint,
      targetType: "review_session",
      targetId: reviewSessionId,
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
    return { reviewSessionId, evidenceCompleteness: evidence.completeness };
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
      const reviewSessionId = ctx.db.normalizeId("reviewSessions", prior.targetId);
      if (!reviewSessionId) throw new Error("Prior start-review result is invalid.");
      const saved = await ctx.db.get(reviewSessionId);
      if (!saved?.startedAt || !saved.plannedEndAt) {
        throw new Error("Prior started review no longer resolves.");
      }
      return {
        reviewSessionId,
        startedAt: saved.startedAt,
        plannedEndAt: saved.plannedEndAt,
        serverNow: Date.now(),
        version: saved.version,
      };
    }
    const session = await ctx.db.get(args.reviewSessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({ code: "REVIEW_NOT_FOUND", message: "That review is unavailable." });
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
      throw new ConvexError({ code: "ROUND_NOT_OPEN", message: "This review round is not open." });
    }
    if (await findActiveRoundPause(ctx, round._id)) {
      throw new ConvexError({
        code: "ROUND_PAUSED",
        message: "New review starts are paused for this round.",
      });
    }
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
      .withIndex("by_session_person", (index) => index.eq("reviewSessionId", session._id))
      .collect();
    const assigned = assignments.filter((assignment) => assignment.status === "assigned");
    if (assigned.length !== round.requiredPanelSize) {
      throw new ConvexError({ code: "REVIEW_ASSIGNMENT_INCOMPLETE", message: "The fixed reviewer assignment is incomplete." });
    }
    for (const assignment of assigned) {
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
          message: "A fixed reviewer has an active conflict with this team. Reroute the team.",
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
    if (!state || !["called", "at_table"].includes(state.state) || state.panelId !== session.panelId) {
      throw new ConvexError({ code: "QUEUE_STATE_CHANGED", message: "The team is no longer called to this panel." });
    }
    const plannedEndAt = now + round.reviewDurationSeconds * 1_000;
    await ctx.db.patch(session._id, {
      status: "active",
      startedAt: now,
      plannedEndAt,
      version: session.version + 1,
      updatedAt: now,
    });
    await ctx.db.patch(state._id, {
      state: "in_review",
      version: state.version + 1,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(plannedEndAt, internal.reviewOperations.markOverdue, {
      reviewSessionId: session._id,
      expectedPlannedEndAt: plannedEndAt,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.session.start",
      requestFingerprint,
      targetType: "review_session",
      targetId: session._id,
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
      previousSummary: JSON.stringify({ status: session.status, version: session.version }),
      nextSummary: JSON.stringify({
        status: "active",
        startedAt: now,
        plannedEndAt,
        version: session.version + 1,
      }),
      reason: normalizedText(args.reason, "Reason", 3, 300),
    });
    return {
      reviewSessionId: session._id,
      startedAt: now,
      plannedEndAt,
      serverNow: now,
      version: session.version + 1,
    };
  },
});

export const markOverdue = internalMutation({
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
      status: "overdue",
      version: session.version + 1,
      updatedAt: Date.now(),
    });
    return null;
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
  returns: v.object({ plannedEndAt: v.number(), extensionCount: v.number(), version: v.number() }),
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
      const reviewSessionId = ctx.db.normalizeId("reviewSessions", prior.targetId);
      if (!reviewSessionId) throw new Error("Prior extension result is invalid.");
      const saved = await ctx.db.get(reviewSessionId);
      if (!saved?.plannedEndAt) throw new Error("Prior extension no longer resolves.");
      return {
        plannedEndAt: saved.plannedEndAt,
        extensionCount: saved.extensionCount,
        version: saved.version,
      };
    }
    const session = await ctx.db.get(args.reviewSessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({ code: "REVIEW_NOT_FOUND", message: "That review is unavailable." });
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
      !["active", "overdue"].includes(session.status) ||
      !session.plannedEndAt ||
      session.version !== args.expectedVersion ||
      round.ordinaryExtensionSeconds < 1 ||
      session.extensionCount >= round.maximumOrdinaryExtensions
    ) {
      throw new ConvexError({ code: "EXTENSION_NOT_AVAILABLE", message: "The ordinary extension is not available." });
    }
    const now = Date.now();
    const plannedEndAt = session.plannedEndAt + round.ordinaryExtensionSeconds * 1_000;
    const extensionCount = session.extensionCount + 1;
    await ctx.db.patch(session._id, {
      status: plannedEndAt > now ? "active" : "overdue",
      plannedEndAt,
      extensionCount,
      extensionSeconds: session.extensionSeconds + round.ordinaryExtensionSeconds,
      version: session.version + 1,
      updatedAt: now,
    });
    if (plannedEndAt > now) {
      await ctx.scheduler.runAt(plannedEndAt, internal.reviewOperations.markOverdue, {
        reviewSessionId: session._id,
        expectedPlannedEndAt: plannedEndAt,
      });
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.session.extend",
      requestFingerprint,
      targetType: "review_session",
      targetId: session._id,
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
      nextSummary: JSON.stringify({ plannedEndAt, extensionCount, version: session.version + 1 }),
      reason: normalizedText(args.reason, "Reason", 3, 300),
    });
    return { plannedEndAt, extensionCount, version: session.version + 1 };
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
      const reviewSessionId = ctx.db.normalizeId("reviewSessions", prior.targetId);
      if (!reviewSessionId) throw new Error("Prior shared-notes result is invalid.");
      const saved = await ctx.db.get(reviewSessionId);
      if (!saved) throw new Error("Prior shared-notes result no longer resolves.");
      return { sharedNotesVersion: saved.sharedNotesVersion };
    }
    const session = await ctx.db.get(args.reviewSessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({ code: "REVIEW_NOT_FOUND", message: "That review is unavailable." });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.shared_notes.write",
      scopeType: "review",
      scopeId: session._id,
    });
    if (
      !["active", "overdue"].includes(session.status) ||
      session.sharedNotesVersion !== args.expectedNotesVersion
    ) {
      throw new ConvexError({
        code: "SHARED_NOTES_CHANGED",
        message: "The review or shared notes changed. Refresh before saving.",
      });
    }
    const findings = normalizedText(args.findings, "Findings", 1, 2_000);
    const commitments = normalizedText(args.commitments, "Commitments", 1, 2_000);
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
      previousSummary: JSON.stringify({ sharedNotesVersion: session.sharedNotesVersion }),
      nextSummary: JSON.stringify({ sharedNotesVersion: session.sharedNotesVersion + 1 }),
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
  returns: v.object({ reviewSessionId: v.id("reviewSessions"), completedAt: v.number() }),
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
      const reviewSessionId = ctx.db.normalizeId("reviewSessions", prior.targetId);
      if (!reviewSessionId) throw new Error("Prior completion result is invalid.");
      const saved = await ctx.db.get(reviewSessionId);
      if (!saved?.completedAt) throw new Error("Prior completed review no longer resolves.");
      return { reviewSessionId, completedAt: saved.completedAt };
    }
    const session = await ctx.db.get(args.reviewSessionId);
    if (!session || session.eventId !== event._id) {
      throw new ConvexError({ code: "REVIEW_NOT_FOUND", message: "That review is unavailable." });
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
      !["active", "overdue"].includes(session.status) ||
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
      .withIndex("by_session", (index) => index.eq("reviewSessionId", session._id))
      .unique();
    if (existingEvaluation) throw new Error("An evaluation already exists for an open review.");
    const evaluation = await computeReviewEvaluation(ctx, { round, session, rubric });
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
      throw new Error("The active review no longer matches the team queue state.");
    }
    await ctx.db.patch(state._id, {
      state: "completed",
      completedAt: now,
      version: state.version + 1,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.session.complete",
      requestFingerprint,
      targetType: "review_session",
      targetId: session._id,
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
      previousSummary: JSON.stringify({ status: session.status, version: session.version }),
      nextSummary: JSON.stringify({
        status: "completed",
        scorecardCount: evaluation.submittedScorecardCount,
        criterionCount: evaluation.criterionResults.length,
        version: session.version + 1,
      }),
      reason: normalizedText(args.reason, "Reason", 3, 300),
    });
    return { reviewSessionId: session._id, completedAt: now };
  },
});
