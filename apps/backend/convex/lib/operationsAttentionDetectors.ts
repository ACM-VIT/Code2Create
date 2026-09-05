/** Pure deterministic detectors over typed projections and server timestamps. */

import {
  countPhrase,
  durationPhrase,
  joinNames,
  type DetectedAttentionItem,
} from "./operationsAttention.ts";
import { proposeCommand, type AttentionProposal,
} from "./operationsAttentionProposals.ts";
import { observedPace } from "./queueEstimate.ts";
import type { AttentionSeverity } from "../values.ts";

type Clock = { now: number };

/** Four minutes of silence is an operational signal, not proof of absence. */
const staleHeartbeatMs = 4 * 60 * 1_000;
/** A token can be replaced by the app within a minute of being rejected. */
const invalidTokenGraceMs = 2 * 60 * 1_000;
/** A seat is briefly empty during an ordinary swap. */
const seatEmptyPersistenceMs = 60 * 1_000;
/** Reviewers walking to a table take a minute or two to scan in. */
const presencePersistenceMs = 3 * 60 * 1_000;
/** A team assembles at the door; below-minimum right at queue time is normal. */
const belowMinimumPersistenceMs = 2 * 60 * 1_000;
/** A short hold is ordinary operating, not a problem to lead the board with. */
const heldPersistenceMs = 5 * 60 * 1_000;
/** A team queued for two reviews' worth of time is being passed over. */
const waitingMultiplier = 2;
/** Below this the forecast is inside the noise of a single long review. */
const forecastOverrunFloorMs = 10 * 60 * 1_000;
const forecastAttentionOverrunMs = 30 * 60 * 1_000;
const forecastCriticalOverrunMs = 60 * 60 * 1_000;
/** One panel has to be this far behind the middle before it is the bottleneck. */
const bottleneckMarginMs = 15 * 60 * 1_000;
/** Scorecards are written at the table; a few minutes after is not late. */
const scorecardChasePersistenceMs = 5 * 60 * 1_000;
const scorecardChaseAttentionMs = 15 * 60 * 1_000;
const scorecardChaseCriticalMs = 45 * 60 * 1_000;

export type ClockInStatus =
  | "not_clocked_in"
  | "present"
  | "temporarily_unavailable"
  | "clocked_out"
  | "no_show";

export type PanelMemberProjection = {
  panelMemberId: string;
  personId: string;
  displayName: string;
  clockInStatus: ClockInStatus;
  clockInVersion: number;
  expectedReturnAt?: number;
  lastHeartbeatAt?: number;
  deviceCount: number;
  pushTokenStatus?: "not_registered" | "active" | "invalid";
  pushTokenInvalidatedAt?: number;
};

export type QueuedTeamProjection = {
  teamRoundStateId: string;
  version: number;
  teamName: string;
  queuedAt: number;
};

export type PanelProjection = {
  panelId: string;
  name: string;
  status: "draft" | "ready" | "needs_reviewer" | "paused" | "closed";
  version: number;
  statusSince: number;
  /** The seat `startPageChain` would fill, present only while one is vacant. */
  vacantPanelMemberId?: string;
  hasActivePageChain: boolean;
  /** A running timer blocks both `markNoShow` and `startPageChain`. */
  hasRunningReview: boolean;
  members: readonly PanelMemberProjection[];
  queuedTeams: readonly QueuedTeamProjection[];
  activeReviewPlannedEndAt?: number;
  completedDurationsSeconds: readonly number[];
};

export type ReviewProjection = {
  reviewSessionId: string;
  version: number;
  status: "awaiting_presence" | "active" | "scoring" | "completed" | "cancelled";
  createdAt: number;
  plannedEndAt?: number;
  reviewerPresenceCount: number;
  reviewerCount: number;
  canExtend: boolean;
};

export type TeamProjection = {
  teamRoundStateId: string;
  version: number;
  teamId: string;
  teamName: string;
  panelId?: string;
  state:
    | "unassigned"
    | "queued"
    | "called"
    | "at_table"
    | "in_review"
    | "completed"
    | "held"
    | "missed"
    | "withdrawn";
  queuedAt?: number;
  calledAt?: number;
  heldAt?: number;
  holdReason?: string;
  missedEligibleAt?: number;
  updatedAt: number;
  availableCount: number;
  requiredCount: number;
  availabilityWaived: boolean;
  review: ReviewProjection | null;
};

export type ReviewFloorProjection = Clock & {
  roundId: string;
  roundName: string;
  roundEndsAt: number;
  reviewerReportAt: number;
  reviewerNoShowGraceSeconds: number;
  requiredPanelSize: number;
  reviewDurationSeconds: number;
  scoringBufferSeconds: number;
  /** A round paused under an incident is expected to run behind. */
  isPaused: boolean;
  panels: readonly PanelProjection[];
  teams: readonly TeamProjection[];
};

export type OutstandingScorecardProjection = {
  reviewSessionId: string;
  teamName: string;
  panelName: string;
  completedAt: number;
  reviewers: readonly {
    displayName: string;
    lastHeartbeatAt?: number;
    clockInStatus: ClockInStatus;
  }[];
};

export type ScorecardChaseProjection = Clock & {
  roundId: string;
  roundName: string;
  sessions: readonly OutstandingScorecardProjection[];
};

export function reviewFloorItems(input: ReviewFloorProjection,
): DetectedAttentionItem[] {
  return [...reviewPanelItems(input), ...reviewTeamItems(input)];
}

type PanelDetectorProjection = Omit<ReviewFloorProjection, "teams">;

/** Detects panel-owned conditions without requiring team attendance reads. */
export function reviewPanelItems(input: PanelDetectorProjection,
): DetectedAttentionItem[] {
  const route = `/reviews/${input.roundId}`;
  const visibility = {
    permissionKey: "round.read",
    scopeType: "round" as const,
    scopeId: input.roundId,
  };
  const items: DetectedAttentionItem[] = [];

  for (const panel of input.panels) {
    if (panel.status === "draft" || panel.status === "closed") continue;
    const queuedCount = panel.queuedTeams.length;
    const seated = panel.members.filter((member) => member.clockInStatus === "present",
    ).length;
    const missing = input.requiredPanelSize - seated;

    if (
      (panel.status === "needs_reviewer" || missing > 0) &&
      input.now - panel.statusSince >= seatEmptyPersistenceMs
    ) {
      const shortBy = Math.max(1, missing);
      const proposal: AttentionProposal | undefined =
        panel.status === "needs_reviewer" &&
        panel.vacantPanelMemberId !== undefined &&
        !panel.hasActivePageChain &&
        !panel.hasRunningReview
          ? proposeCommand(
              {
                name: "reviewSubstitutions.startPageChain",
                missingPanelMemberId: panel.vacantPanelMemberId,
                expectedPanelVersion: panel.version,
                reason: `${panel.name} is short ${countPhrase(shortBy, "reviewer", "reviewers")} with ${countPhrase(queuedCount, "team", "teams")} queued.`,
              },
              { scopeType: "panel", scopeId: panel.panelId },
              input.now,
            )
          : undefined;
      items.push({
        detectorKey: "panel_seat_empty",
        dedupeKey: `panel_seat_empty:${panel.panelId}`,
        subjectType: "panel",
        subjectId: panel.panelId,
        severity: "critical",
        statement:
          `${panel.name} is short ${countPhrase(shortBy, "reviewer", "reviewers")}` +
          (queuedCount > 0
            ? `, and ${countPhrase(queuedCount, "team is", "teams are")} queued behind it. Reviews here cannot start.`
            : ". Reviews here cannot start."),
        route,
        actionLabel: proposal ? "Page a substitute" : "Open the panel",
        visibility,
        evidenceJson: JSON.stringify({
          panelStatus: panel.status,
          requiredPanelSize: input.requiredPanelSize,
          seated,
          queuedCount,
          statusSince: panel.statusSince,
        }),
        scopes: [`panel:${panel.panelId}`],
        ...(proposal ? { proposal } : {}),
      });
    }

    if (queuedCount > 0) {
      for (const member of panel.members) {
        const risk = seatRisk(member, input.now, input.reviewerNoShowGraceSeconds,
        );
        if (!risk) continue;
        const noShowEligibleAt =
          member.clockInStatus === "temporarily_unavailable"
            ? member.expectedReturnAt === undefined
              ? undefined
              : member.expectedReturnAt + input.reviewerNoShowGraceSeconds * 1_000
            : input.reviewerReportAt + input.reviewerNoShowGraceSeconds * 1_000;
        const proposal: AttentionProposal | undefined =
          member.clockInStatus !== "present" &&
          noShowEligibleAt !== undefined &&
          input.now >= noShowEligibleAt &&
          panel.status === "ready" &&
          !panel.hasRunningReview
            ? proposeCommand(
                {
                  name: "reviewSubstitutions.markNoShow",
                  panelMemberId: member.panelMemberId,
                  expectedPanelVersion: panel.version,
                  expectedClockInVersion: member.clockInVersion,
                  reason: `${member.displayName} ${risk.reasonFragment}`,
                },
                { scopeType: "round", scopeId: input.roundId },
                input.now,
              )
            : undefined;
        items.push({
          detectorKey: "seat_at_risk",
          dedupeKey: `seat_at_risk:${panel.panelId}:${member.personId}`,
          subjectType: "panel_member",
          subjectId: member.panelMemberId,
          severity: "attention",
          statement: `${risk.statement} ${panel.name} has ${countPhrase(queuedCount, "team", "teams")} queued. Confirm before freeing the seat.`,
          route,
          actionLabel: proposal ? "Confirm and free the seat" : "Open the panel",
          visibility,
          evidenceJson: JSON.stringify({
            personId: member.personId,
            clockInStatus: member.clockInStatus,
            ...(member.lastHeartbeatAt === undefined
              ? {}
              : { lastHeartbeatAt: member.lastHeartbeatAt }),
            ...(member.expectedReturnAt === undefined
              ? {}
              : { expectedReturnAt: member.expectedReturnAt }),
            ...(member.pushTokenStatus === undefined
              ? {}
              : { pushTokenStatus: member.pushTokenStatus }),
            queuedCount,
            cause: risk.cause,
          }),
          scopes: [`panel:${panel.panelId}`, `person:${member.personId}`],
          ...(proposal ? { proposal } : {}),
        });
      }
    }
  }

  return items;
}

type TeamDetectorProjection = Omit<ReviewFloorProjection, "panels">;

/** Detects team-owned conditions without requiring panel membership reads. */
export function reviewTeamItems(input: TeamDetectorProjection,
): DetectedAttentionItem[] {
  const route = `/reviews/${input.roundId}`;
  const visibility = {
    permissionKey: "round.read",
    scopeType: "round" as const,
    scopeId: input.roundId,
  };
  const items: DetectedAttentionItem[] = [];

  for (const team of input.teams) {
    const roundName = input.roundName;
    const teamScopes = team.panelId
      ? [`team:${team.teamId}`, `panel:${team.panelId}`]
      : [`team:${team.teamId}`];

    if (!input.isPaused && team.review?.status === "scoring" &&
      team.review.plannedEndAt !== undefined &&
      input.now >= team.review.plannedEndAt + input.scoringBufferSeconds * 1000
    ) {
      const review = team.review;
      const overdueBy = review.plannedEndAt === undefined ? 0 : input.now - review.plannedEndAt;
      items.push({
        detectorKey: "review_overdue",
        dedupeKey: `review_overdue:${review.reviewSessionId}`,
        subjectType: "review",
        subjectId: review.reviewSessionId,
        severity: "attention",
        statement: `${team.teamName} in ${roundName} has been finishing scores and comments for ${durationPhrase(overdueBy)}.`,
        route,
        actionLabel: "Finish scorecards",
        visibility,
        evidenceJson: JSON.stringify({
          teamId: team.teamId,
          ...(review.plannedEndAt === undefined ? {} : { plannedEndAt: review.plannedEndAt }),
          canExtend: review.canExtend,
        }),
        scopes: teamScopes,
      });
    }

    if (
      team.review?.status === "awaiting_presence" &&
      team.review.reviewerPresenceCount < team.review.reviewerCount &&
      input.now - team.review.createdAt >= presencePersistenceMs
    ) {
      const review = team.review;
      items.push({
        detectorKey: "review_presence_incomplete",
        dedupeKey: `review_presence_incomplete:${review.reviewSessionId}`,
        subjectType: "review",
        subjectId: review.reviewSessionId,
        severity: "attention",
        statement: `${review.reviewerPresenceCount} of ${review.reviewerCount} reviewers have scanned in for ${roundName}, so ${team.teamName} cannot start after waiting ${durationPhrase(input.now - review.createdAt)}.`,
        route,
        actionLabel: "Check the table",
        visibility,
        evidenceJson: JSON.stringify({
          teamId: team.teamId,
          reviewerPresenceCount: review.reviewerPresenceCount,
          reviewerCount: review.reviewerCount,
          createdAt: review.createdAt,
        }),
        scopes: teamScopes,
      });
    }

    const blockedStates = ["queued", "called", "at_table"] as const;
    const isBlockedState = blockedStates.some((state) => state === team.state);
    const stateSince = team.queuedAt ?? team.calledAt ?? team.updatedAt;
    if (
      isBlockedState &&
      team.availableCount < team.requiredCount &&
      !team.availabilityWaived &&
      input.now - stateSince >= belowMinimumPersistenceMs
    ) {
      items.push({
        detectorKey: "team_below_minimum",
        dedupeKey: `team_below_minimum:${team.teamRoundStateId}`,
        subjectType: "team",
        subjectId: team.teamId,
        severity: "attention",
        statement: `${team.teamName} has ${team.availableCount} of the ${team.requiredCount} people this round needs inside the hall, so the desk cannot call them.`,
        route,
        actionLabel: "Record an exception",
        visibility,
        evidenceJson: JSON.stringify({
          teamRoundStateId: team.teamRoundStateId,
          availableCount: team.availableCount,
          requiredCount: team.requiredCount,
          state: team.state,
        }),
        scopes: teamScopes,
      });
    }

    if (
      team.state === "held" &&
      team.heldAt !== undefined &&
      input.now - team.heldAt >= heldPersistenceMs
    ) {
      items.push({
        detectorKey: "team_held",
        dedupeKey: `team_held:${team.teamRoundStateId}`,
        subjectType: "team",
        subjectId: team.teamId,
        severity: "attention",
        statement: team.holdReason
          ? `${team.teamName} has been on hold for ${durationPhrase(input.now - team.heldAt)}: ${team.holdReason}`
          : `${team.teamName} has been on hold for ${durationPhrase(input.now - team.heldAt)} with no reason recorded.`,
        route,
        actionLabel: "Take them off hold",
        visibility,
        evidenceJson: JSON.stringify({
          teamRoundStateId: team.teamRoundStateId,
          heldAt: team.heldAt,
          ...(team.holdReason === undefined ? {} : { holdReason: team.holdReason }),
        }),
        scopes: teamScopes,
        proposal: proposeCommand(
          {
            name: "reviewExceptions.resumeTeam",
            teamRoundStateId: team.teamRoundStateId,
            expectedVersion: team.version,
            reason: `${team.teamName} has been on hold for ${durationPhrase(input.now - team.heldAt)}.`,
          },
          { scopeType: "team", scopeId: team.teamId },
          input.now,
        ),
      });
    }

    if (
      !input.isPaused &&
      team.state === "called" &&
      team.missedEligibleAt !== undefined &&
      input.now > team.missedEligibleAt
    ) {
      items.push({
        detectorKey: "team_call_overdue",
        dedupeKey: `team_call_overdue:${team.teamRoundStateId}`,
        subjectType: "team",
        subjectId: team.teamId,
        severity: "attention",
        statement: `${team.teamName} was called for ${roundName} and the grace period ran out ${durationPhrase(input.now - team.missedEligibleAt)} ago.`,
        route,
        actionLabel: "Mark them missed",
        visibility,
        evidenceJson: JSON.stringify({
          teamRoundStateId: team.teamRoundStateId,
          missedEligibleAt: team.missedEligibleAt,
        }),
        scopes: teamScopes,
        proposal: proposeCommand(
          {
            name: "reviewExceptions.markMissed",
            teamRoundStateId: team.teamRoundStateId,
            expectedVersion: team.version,
            reason: `${team.teamName} did not arrive for ${roundName} within the grace period.`,
          },
          { scopeType: "team", scopeId: team.teamId },
          input.now,
        ),
      });
    }

    if (!input.isPaused && team.state === "queued" && team.queuedAt !== undefined) {
      const waitedFor = input.now - team.queuedAt;
      if (waitedFor > waitingMultiplier * input.reviewDurationSeconds * 1_000) {
        items.push({
          detectorKey: "team_waiting_long",
          dedupeKey: `team_waiting_long:${team.teamRoundStateId}`,
          subjectType: "team",
          subjectId: team.teamId,
          severity: "watch",
          statement: `${team.teamName} has been queued for ${durationPhrase(waitedFor)}, longer than two reviews' worth of time.`,
          route,
          actionLabel: "Move them up the queue",
          visibility,
          evidenceJson: JSON.stringify({
            teamRoundStateId: team.teamRoundStateId,
            queuedAt: team.queuedAt,
            reviewDurationSeconds: input.reviewDurationSeconds,
          }),
          scopes: teamScopes,
        });
      }
    }
  }

  return items;
}

type SeatRisk = { statement: string; reasonFragment: string; cause: string };

/** Reports observed risk signals without treating clock-in status as proof of presence. */
function seatRisk(
  member: PanelMemberProjection,
  now: number,
  reviewerNoShowGraceSeconds: number,
): SeatRisk | null {
  const clockedIn =
    member.clockInStatus === "present" || member.clockInStatus === "temporarily_unavailable";
  if (!clockedIn) return null;

  if (
    member.clockInStatus === "temporarily_unavailable" &&
    member.expectedReturnAt !== undefined &&
    now - member.expectedReturnAt >= reviewerNoShowGraceSeconds * 1_000
  ) {
    const late = durationPhrase(now - member.expectedReturnAt);
    return {
      statement: `${member.displayName} stepped away and is ${late} past the time they gave for coming back.`,
      reasonFragment: `is ${late} past the return time they recorded.`,
      cause: "late_return",
    };
  }

  if (member.lastHeartbeatAt !== undefined && now - member.lastHeartbeatAt >= staleHeartbeatMs) {
    const silent = durationPhrase(now - member.lastHeartbeatAt);
    return {
      statement: `${member.displayName}'s reviewer app has not checked in for ${silent}, which is a signal and not proof they left the table.`,
      reasonFragment: `has had no reviewer app contact for ${silent}.`,
      cause: "stale_heartbeat",
    };
  }

  if (
    member.deviceCount === 1 &&
    member.pushTokenStatus === "invalid" &&
    member.pushTokenInvalidatedAt !== undefined &&
    now - member.pushTokenInvalidatedAt >= invalidTokenGraceMs
  ) {
    return {
      statement: `${member.displayName}'s only registered device stopped accepting pages, so a substitute page would not reach them.`,
      reasonFragment: "has no device that can receive a page.",
      cause: "invalid_push_token",
    };
  }

  return null;
}

/** Forecasts from the shared bounded pace and suppresses thin samples. */
export function roundForecastItems(input: ReviewFloorProjection,
): DetectedAttentionItem[] {
  if (input.isPaused) return [];
  const route = `/reviews/${input.roundId}`;
  const visibility = {
    permissionKey: "round.read",
    scopeType: "round" as const,
    scopeId: input.roundId,
  };
  const working = input.panels.filter(
    (panel) => panel.status === "ready" || panel.status === "needs_reviewer",
  );
  if (working.length === 0) return [];

  const forecasts = working.map((panel) => {
    const pace = observedPace(input.reviewDurationSeconds + input.scoringBufferSeconds,
      panel.completedDurationsSeconds,
    );
    const activeRemainingMs =
      panel.activeReviewPlannedEndAt === undefined
        ? 0
        : Math.max(0, panel.activeReviewPlannedEndAt +
              input.scoringBufferSeconds * 1000 -
              input.now,
          );
    return {
      panel,
      pace,
      finishAt: input.now + activeRemainingMs + panel.queuedTeams.length * pace.paceSeconds * 1_000,
    };
  });
  const totalSamples = forecasts.reduce(
    (running, forecast) => running + forecast.pace.sampleSize,
    0,
  );
  if (totalSamples < 3) return [];

  const remainingTeams = forecasts.reduce(
    (running, forecast) => running + forecast.panel.queuedTeams.length,
    0,
  );
  if (remainingTeams === 0) return [];

  const paceSeconds =
    forecasts.reduce(
      (running, forecast) =>
        running + forecast.pace.paceSeconds * forecast.panel.queuedTeams.length,
      0,
    ) / remainingTeams;
  const finishAt = Math.max(...forecasts.map((forecast) => forecast.finishAt));
  const overrunMs = finishAt - input.roundEndsAt;
  const items: DetectedAttentionItem[] = [];

  if (overrunMs >= forecastOverrunFloorMs) {
    items.push({
      detectorKey: "round_finish_forecast",
      dedupeKey: `round_finish_forecast:${input.roundId}`,
      subjectType: "round",
      subjectId: input.roundId,
      severity: overrunSeverity(overrunMs),
      statement: `At the current pace, ${durationPhrase(paceSeconds * 1_000)} per review across ${countPhrase(working.length, "panel", "panels")}, the ${remainingTeams} remaining teams finish ${durationPhrase(overrunMs)} after this round's window closes.`,
      route,
      actionLabel: "Open the round",
      visibility,
      evidenceJson: JSON.stringify({
        paceSeconds: Math.round(paceSeconds),
        panelCount: working.length,
        remainingTeams,
        sampleSize: totalSamples,
        forecastFinishAt: Math.round(finishAt),
        roundEndsAt: input.roundEndsAt,
      }),
      scopes: [`round:${input.roundId}`],
    });
  }

  const sorted = [...forecasts].sort((left, right) => left.finishAt - right.finishAt,
  );
  const slowest = sorted[sorted.length - 1];
  const earliest = sorted[0];
  const middle = sorted[Math.floor(sorted.length / 2)];
  if (
    slowest === undefined ||
    earliest === undefined ||
    middle === undefined ||
    sorted.length < 2 ||
    overrunMs < forecastOverrunFloorMs ||
    slowest.finishAt - middle.finishAt < bottleneckMarginMs
  ) {
    return items;
  }

  const behindBy = slowest.finishAt - middle.finishAt;
  const lastQueued = [...slowest.panel.queuedTeams].sort(
    (left, right) => right.queuedAt - left.queuedAt,
  )[0];
  const proposal: AttentionProposal | undefined =
    lastQueued !== undefined && earliest.panel.status === "ready"
      ? proposeCommand(
          {
            name: "reviewExceptions.moveQueuedTeam",
            teamRoundStateId: lastQueued.teamRoundStateId,
            targetPanelId: earliest.panel.panelId,
            expectedVersion: lastQueued.version,
            reason: `${slowest.panel.name} finishes ${durationPhrase(behindBy)} after the middle of the round; ${earliest.panel.name} finishes first.`,
          },
          { scopeType: "panel", scopeId: slowest.panel.panelId },
          input.now,
        )
      : undefined;

  items.push({
    detectorKey: "panel_bottleneck",
    dedupeKey: `panel_bottleneck:${slowest.panel.panelId}`,
    subjectType: "panel",
    subjectId: slowest.panel.panelId,
    severity: "attention",
    statement: `${slowest.panel.name} finishes ${durationPhrase(behindBy)} after the middle of the round with ${countPhrase(slowest.panel.queuedTeams.length, "team", "teams")} queued.${proposal ? ` ${earliest.panel.name} finishes first and can take ${lastQueued?.teamName ?? "one of them"}.` : ""}`,
    route,
    actionLabel: proposal ? "Move a team across" : "Open the round",
    visibility,
    evidenceJson: JSON.stringify({
      panelFinishAt: Math.round(slowest.finishAt),
      medianPanelFinishAt: Math.round(middle.finishAt),
      earliestPanelId: earliest.panel.panelId,
      queuedTeamCount: slowest.panel.queuedTeams.length,
    }),
    scopes: [`panel:${slowest.panel.panelId}`, `round:${input.roundId}`],
    ...(proposal ? { proposal } : {}),
  });

  return items;
}

function overrunSeverity(overrunMs: number): AttentionSeverity {
  if (overrunMs >= forecastCriticalOverrunMs) return "critical";
  if (overrunMs >= forecastAttentionOverrunMs) return "attention";
  return "watch";
}

/**
 * Reviewer attendance is unknown, so scorecard alerts report only elapsed time
 * and the last app status.
 */
export function scorecardChaseItems(input: ScorecardChaseProjection,
): DetectedAttentionItem[] {
  const route = `/reviews/${input.roundId}`;
  const visibility = {
    permissionKey: "round.read",
    scopeType: "round" as const,
    scopeId: input.roundId,
  };
  const items: DetectedAttentionItem[] = [];

  for (const session of input.sessions) {
    if (session.reviewers.length === 0) continue;
    const since = input.now - session.completedAt;
    if (since < scorecardChasePersistenceMs) continue;
    const names = session.reviewers.map((reviewer) => reviewer.displayName);
    const contact = session.reviewers
      .map((reviewer) =>
        reviewer.lastHeartbeatAt === undefined
          ? `${reviewer.displayName} has no reviewer app contact recorded`
          : `${reviewer.displayName}'s app last checked in ${durationPhrase(input.now - reviewer.lastHeartbeatAt)} ago`,
      )
      .join("; ");
    items.push({
      detectorKey: "scorecard_outstanding",
      dedupeKey: `scorecard_outstanding:${session.reviewSessionId}`,
      subjectType: "review",
      subjectId: session.reviewSessionId,
      severity: chaseSeverity(since),
      statement: `${joinNames(names)} ${names.length === 1 ? "has" : "have"} not submitted for ${session.teamName} at ${session.panelName}, ${durationPhrase(since)} after that review ended. ${contact}.`,
      route,
      actionLabel: "Open the round",
      visibility,
      evidenceJson: JSON.stringify({
        completedAt: session.completedAt,
        outstandingCount: session.reviewers.length,
        reviewers: session.reviewers.map((reviewer) => ({
          displayName: reviewer.displayName,
          clockInStatus: reviewer.clockInStatus,
          ...(reviewer.lastHeartbeatAt === undefined
            ? {}
            : { lastHeartbeatAt: reviewer.lastHeartbeatAt }),
        })),
      }),
      scopes: [`review:${session.reviewSessionId}`],
    });
  }

  return items;
}

function chaseSeverity(sinceMs: number): AttentionSeverity {
  if (sinceMs >= scorecardChaseCriticalMs) return "critical";
  if (sinceMs >= scorecardChaseAttentionMs) return "attention";
  return "watch";
}
