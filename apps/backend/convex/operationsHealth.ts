import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  boundedCount,
  buildOperationsHealth,
  emptyOperationsHealthCounts,
  type OperationsHealthCounts,
  type OperationsHealthSignal,
  type OperationsHealthSummary,
} from "./lib/operationsHealth";
import {
  operationsHealthSnapshot,
  operationsHealthSnapshotState as operationsHealthSnapshotStateValidator,
} from "./lib/operationsIntelligenceValidators";
import {
  operationsHealthMaximumAgeMs,
  operationsHealthSnapshotState,
} from "./lib/operationsHealthSnapshot";
import { enqueueOperationsAutonomySignal } from "./lib/operationsAutonomyInbox";
import { requirePermission } from "./lib/permissions";
import { activeSynesthesiaWindow } from "./lib/synesthesia";
import { reconcileOperationsEpisodes } from "./lib/operationsEpisodes";

const queryLimit = 101;
const reviewerHeartbeatWindowMs = 2 * 60 * 1_000;
const scannerHeartbeatWindowMs = 2 * 60 * 1_000;
const shortJobWindowMs = 5 * 60 * 1_000;
const exportWindowMs = 15 * 60 * 1_000;
const intakeJobWindowMs = 2 * 60 * 1_000;
const noveltyPreviewStallWindowMs = 20 * 1_000;
const recentModelFailureWindowMs = 15 * 60 * 1_000;
const playbackAcknowledgementAllowanceMs = 2 * 60 * 1_000;

type OperationsHealthOverview = {
  generatedAt: number;
  event: {
    slug: string;
    name: string;
    timezone: string;
    status: Doc<"events">["status"];
  };
  summary: OperationsHealthSummary;
  signals: OperationsHealthSignal[];
};

function coverageMarker(values: readonly object[], generatedAt: number) {
  return values.length === queryLimit ? [generatedAt] : [];
}

async function incidentHealth(ctx: QueryCtx, eventId: Id<"events">, generatedAt: number) {
  const [open, monitoring, pauses] = await Promise.all([
    ctx.db
      .query("incidents")
      .withIndex("by_event_state_opened", (index) =>
        index.eq("eventId", eventId).eq("state", "open"),
      )
      .take(queryLimit),
    ctx.db
      .query("incidents")
      .withIndex("by_event_state_opened", (index) =>
        index.eq("eventId", eventId).eq("state", "monitoring"),
      )
      .take(queryLimit),
    ctx.db
      .query("reviewRoundPauses")
      .withIndex("by_event_state_paused", (index) =>
        index.eq("eventId", eventId).eq("state", "active"),
      )
      .take(queryLimit),
  ]);
  const incidents = [...open, ...monitoring];
  return {
    counts: {
      critical_incidents: boundedCount(
        incidents
          .filter((incident) => incident.severity === "critical")
          .map((incident) => incident.openedAt),
      ),
      active_incidents: boundedCount(
        incidents
          .filter((incident) => incident.severity !== "critical")
          .map((incident) => incident.openedAt),
      ),
      active_round_pauses: boundedCount(pauses.map((pause) => pause.pausedAt)),
    },
    coverage: [
      ...coverageMarker(open, generatedAt),
      ...coverageMarker(monitoring, generatedAt),
      ...coverageMarker(pauses, generatedAt),
    ],
  };
}

async function reviewHealth(ctx: QueryCtx, eventId: Id<"events">, generatedAt: number) {
  const staleBefore = generatedAt - reviewerHeartbeatWindowMs;
  const [panels, overdueReviews, staleClockIns, sentPages, openedPages] = await Promise.all([
    ctx.db
      .query("reviewPanels")
      .withIndex("by_event_status_updated", (index) =>
        index.eq("eventId", eventId).eq("status", "needs_reviewer"),
      )
      .take(queryLimit),
    ctx.db
      .query("reviewSessions")
      .withIndex("by_event_status_updated", (index) =>
        index.eq("eventId", eventId).eq("status", "overdue"),
      )
      .take(queryLimit),
    ctx.db
      .query("reviewerClockIns")
      .withIndex("by_event_status_heartbeat", (index) =>
        index.eq("eventId", eventId).eq("status", "present").lt("lastHeartbeatAt", staleBefore),
      )
      .take(queryLimit),
    ctx.db
      .query("reviewerPages")
      .withIndex("by_event_state_expiry", (index) =>
        index.eq("eventId", eventId).eq("state", "sent").lt("expiresAt", generatedAt),
      )
      .take(queryLimit),
    ctx.db
      .query("reviewerPages")
      .withIndex("by_event_state_expiry", (index) =>
        index.eq("eventId", eventId).eq("state", "opened").lt("expiresAt", generatedAt),
      )
      .take(queryLimit),
  ]);
  const clockInRounds = await Promise.all(
    staleClockIns.map((clockIn) => ctx.db.get(clockIn.roundId)),
  );
  const staleHeartbeatTimes: number[] = [];
  for (let index = 0; index < staleClockIns.length; index += 1) {
    const clockIn = staleClockIns[index];
    const round = clockInRounds[index];
    if (
      clockIn !== undefined &&
      round !== null &&
      round !== undefined &&
      round.eventId === eventId &&
      round.status === "open"
    ) {
      staleHeartbeatTimes.push(clockIn.lastHeartbeatAt);
    }
  }
  return {
    counts: {
      panels_needing_reviewer: boundedCount(panels.map((panel) => panel.updatedAt)),
      stale_reviewer_heartbeats: boundedCount(staleHeartbeatTimes),
      overdue_reviews: boundedCount(overdueReviews.map((review) => review.updatedAt)),
      expired_reviewer_pages: boundedCount(
        [...sentPages, ...openedPages].map((page) => page.expiresAt),
      ),
    },
    coverage: [
      ...coverageMarker(panels, generatedAt),
      ...coverageMarker(overdueReviews, generatedAt),
      ...coverageMarker(staleClockIns, generatedAt),
      ...coverageMarker(sentPages, generatedAt),
      ...coverageMarker(openedPages, generatedAt),
    ],
  };
}

type IntakeFailureState = "refused" | "invalid" | "timed_out" | "rate_limited" | "failed";
type AdmissionFailureState = IntakeFailureState;

function intakeStateBefore(ctx: QueryCtx, eventId: Id<"events">, state: "running", before: number) {
  return ctx.db
    .query("intakeInterpretations")
    .withIndex("by_event_state_created", (index) =>
      index.eq("eventId", eventId).eq("state", state).lt("createdAt", before),
    )
    .take(queryLimit);
}

function intakeStateSince(
  ctx: QueryCtx,
  eventId: Id<"events">,
  state: IntakeFailureState,
  since: number,
) {
  return ctx.db
    .query("intakeInterpretations")
    .withIndex("by_event_state_created", (index) =>
      index.eq("eventId", eventId).eq("state", state).gt("createdAt", since),
    )
    .take(queryLimit);
}

function admissionStateBefore(
  ctx: QueryCtx,
  eventId: Id<"events">,
  state: "pending" | "running",
  before: number,
) {
  return ctx.db
    .query("admissionAIRecommendations")
    .withIndex("by_event_state_created", (index) =>
      index.eq("eventId", eventId).eq("state", state).lt("createdAt", before),
    )
    .take(queryLimit);
}

function noveltyStateBefore(
  ctx: QueryCtx,
  eventId: Id<"events">,
  state: "running",
  before: number,
) {
  return ctx.db
    .query("noveltyPreviewRequests")
    .withIndex("by_event_state_requested", (index) =>
      index.eq("eventId", eventId).eq("state", state).lt("requestedAt", before),
    )
    .take(queryLimit);
}

function noveltyStateSince(
  ctx: QueryCtx,
  eventId: Id<"events">,
  state: "unavailable" | "failed",
  since: number,
) {
  return ctx.db
    .query("noveltyPreviewRequests")
    .withIndex("by_event_state_requested", (index) =>
      index.eq("eventId", eventId).eq("state", state).gt("requestedAt", since),
    )
    .take(queryLimit);
}

function admissionStateSince(
  ctx: QueryCtx,
  eventId: Id<"events">,
  state: AdmissionFailureState,
  since: number,
) {
  return ctx.db
    .query("admissionAIRecommendations")
    .withIndex("by_event_state_created", (index) =>
      index.eq("eventId", eventId).eq("state", state).gt("createdAt", since),
    )
    .take(queryLimit);
}

async function intelligenceHealth(ctx: QueryCtx, eventId: Id<"events">, generatedAt: number) {
  const intakeFailureStates: IntakeFailureState[] = [
    "refused",
    "invalid",
    "timed_out",
    "rate_limited",
    "failed",
  ];
  const admissionFailureStates: AdmissionFailureState[] = [
    "refused",
    "invalid",
    "timed_out",
    "rate_limited",
    "failed",
  ];
  const [
    intakeStalls,
    noveltyStalls,
    noveltyUnavailable,
    noveltyFailed,
    pendingAdmissionStalls,
    runningAdmissionStalls,
    intakeFailures,
    admissionFailures,
  ] = await Promise.all([
    intakeStateBefore(ctx, eventId, "running", generatedAt - intakeJobWindowMs),
    noveltyStateBefore(ctx, eventId, "running", generatedAt - noveltyPreviewStallWindowMs),
    noveltyStateSince(ctx, eventId, "unavailable", generatedAt - recentModelFailureWindowMs),
    noveltyStateSince(ctx, eventId, "failed", generatedAt - recentModelFailureWindowMs),
    admissionStateBefore(ctx, eventId, "pending", generatedAt - shortJobWindowMs),
    admissionStateBefore(ctx, eventId, "running", generatedAt - shortJobWindowMs),
    Promise.all(
      intakeFailureStates.map((state) =>
        intakeStateSince(ctx, eventId, state, generatedAt - recentModelFailureWindowMs),
      ),
    ),
    Promise.all(
      admissionFailureStates.map((state) =>
        admissionStateSince(ctx, eventId, state, generatedAt - recentModelFailureWindowMs),
      ),
    ),
  ]);
  const flatIntakeFailures = intakeFailures.flat();
  const flatAdmissionFailures = admissionFailures.flat();
  return {
    counts: {
      intake_interpretation_stalls: boundedCount(
        intakeStalls.map((interpretation) => interpretation.createdAt),
      ),
      recent_intake_fallbacks: boundedCount(
        flatIntakeFailures.map((interpretation) => interpretation.createdAt),
      ),
      novelty_preview_stalls: boundedCount(noveltyStalls.map((request) => request.requestedAt)),
      recent_novelty_unavailable: boundedCount(
        [...noveltyUnavailable, ...noveltyFailed].map((request) => request.requestedAt),
      ),
      admission_analysis_stalls: boundedCount(
        [...pendingAdmissionStalls, ...runningAdmissionStalls].map(
          (recommendation) => recommendation.createdAt,
        ),
      ),
      recent_admission_fallbacks: boundedCount(
        flatAdmissionFailures.map((recommendation) => recommendation.createdAt),
      ),
    },
    coverage: [
      ...coverageMarker(intakeStalls, generatedAt),
      ...coverageMarker(noveltyStalls, generatedAt),
      ...coverageMarker(noveltyUnavailable, generatedAt),
      ...coverageMarker(noveltyFailed, generatedAt),
      ...coverageMarker(pendingAdmissionStalls, generatedAt),
      ...coverageMarker(runningAdmissionStalls, generatedAt),
      ...intakeFailures.flatMap((rows) => coverageMarker(rows, generatedAt)),
      ...admissionFailures.flatMap((rows) => coverageMarker(rows, generatedAt)),
    ],
  };
}

function attendanceJobState(
  session: Doc<"attendanceSessions">,
  job: Doc<"attendanceSessionJobs"> | null,
  stalledBefore: number,
  preparation: boolean,
) {
  const failed =
    job?.status === "failed" || (preparation && session.expectationBuildState === "failed");
  const observedAt = job?.updatedAt ?? session.updatedAt;
  return {
    failedAt: failed ? observedAt : undefined,
    stalledAt: !failed && observedAt < stalledBefore ? observedAt : undefined,
  };
}

async function attendanceHealth(ctx: QueryCtx, event: Doc<"events">, generatedAt: number) {
  const stalledBefore = generatedAt - shortJobWindowMs;
  const [preparingSessions, closingSessions] = await Promise.all([
    ctx.db
      .query("attendanceSessions")
      .withIndex("by_event_status_start", (index) =>
        index.eq("eventId", event._id).eq("status", "preparing"),
      )
      .take(queryLimit),
    ctx.db
      .query("attendanceSessions")
      .withIndex("by_event_status_start", (index) =>
        index.eq("eventId", event._id).eq("status", "closing"),
      )
      .take(queryLimit),
  ]);
  const [preparationJobs, finalizationJobs] = await Promise.all([
    Promise.all(
      preparingSessions.map((session) =>
        session.expectationJobId ? ctx.db.get(session.expectationJobId) : Promise.resolve(null),
      ),
    ),
    Promise.all(
      closingSessions.map((session) =>
        session.finalizationJobId ? ctx.db.get(session.finalizationJobId) : Promise.resolve(null),
      ),
    ),
  ]);
  const failedAt: number[] = [];
  const stalledAt: number[] = [];
  for (let index = 0; index < preparingSessions.length; index += 1) {
    const session = preparingSessions[index];
    const job = preparationJobs[index];
    if (session === undefined || job === undefined) continue;
    const state = attendanceJobState(session, job, stalledBefore, true);
    if (state.failedAt !== undefined) failedAt.push(state.failedAt);
    if (state.stalledAt !== undefined) stalledAt.push(state.stalledAt);
  }
  for (let index = 0; index < closingSessions.length; index += 1) {
    const session = closingSessions[index];
    const job = finalizationJobs[index];
    if (session === undefined || job === undefined) continue;
    const state = attendanceJobState(session, job, stalledBefore, false);
    if (state.failedAt !== undefined) failedAt.push(state.failedAt);
    if (state.stalledAt !== undefined) stalledAt.push(state.stalledAt);
  }

  const activeStations: Doc<"attendanceStations">[] =
    event.status === "live"
      ? await ctx.db
          .query("attendanceStations")
          .withIndex("by_event_status", (index) =>
            index.eq("eventId", event._id).eq("status", "active"),
          )
          .take(queryLimit)
      : [];
  const stationContexts = await Promise.all(
    activeStations.map(async (station) => ({
      station,
      device: station.deviceInstallationId ? await ctx.db.get(station.deviceInstallationId) : null,
    })),
  );
  const scannerStaleBefore = generatedAt - scannerHeartbeatWindowMs;
  const staleScannerTimes: number[] = [];
  const pendingReplayTimes: number[] = [];
  for (const context of stationContexts) {
    const { station, device } = context;
    const withinStationWindow =
      (station.validFrom === undefined || station.validFrom <= generatedAt) &&
      (station.validUntil === undefined || station.validUntil > generatedAt);
    if (!withinStationWindow) continue;
    const lastSeenAt = device?.lastSeenAt ?? device?.registeredAt ?? station.updatedAt;
    if (device === null || device.status !== "active" || lastSeenAt < scannerStaleBefore) {
      staleScannerTimes.push(lastSeenAt);
    }
    if (
      device?.status === "active" &&
      device.pendingReplayCount > 0 &&
      device.oldestPendingCapturedAt !== undefined
    ) {
      pendingReplayTimes.push(device.oldestPendingCapturedAt);
    }
  }
  return {
    counts: {
      attendance_job_failures: boundedCount(failedAt),
      attendance_job_stalls: boundedCount(stalledAt),
      stale_scanner_stations: boundedCount(staleScannerTimes),
      scanner_queues_awaiting_replay: boundedCount(pendingReplayTimes),
    },
    coverage: [
      ...coverageMarker(preparingSessions, generatedAt),
      ...coverageMarker(closingSessions, generatedAt),
      ...coverageMarker(activeStations, generatedAt),
    ],
  };
}

async function communicationsHealth(ctx: QueryCtx, eventId: Id<"events">, generatedAt: number) {
  const stalledBefore = generatedAt - shortJobWindowMs;
  const [failed, bounced, suppressed, unknown, pending, sending, retrying] = await Promise.all([
    ctx.db
      .query("participantNotificationDeliveries")
      .withIndex("by_event_state_updated", (index) =>
        index.eq("eventId", eventId).eq("state", "failed"),
      )
      .take(queryLimit),
    ctx.db
      .query("participantNotificationDeliveries")
      .withIndex("by_event_state_updated", (index) =>
        index.eq("eventId", eventId).eq("state", "bounced"),
      )
      .take(queryLimit),
    ctx.db
      .query("participantNotificationDeliveries")
      .withIndex("by_event_state_updated", (index) =>
        index.eq("eventId", eventId).eq("state", "suppressed"),
      )
      .take(queryLimit),
    ctx.db
      .query("participantNotificationDeliveries")
      .withIndex("by_event_state_updated", (index) =>
        index.eq("eventId", eventId).eq("state", "unknown"),
      )
      .take(queryLimit),
    ctx.db
      .query("participantNotificationDeliveries")
      .withIndex("by_event_state_updated", (index) =>
        index.eq("eventId", eventId).eq("state", "pending").lt("updatedAt", stalledBefore),
      )
      .take(queryLimit),
    ctx.db
      .query("participantNotificationDeliveries")
      .withIndex("by_event_state_claim", (index) =>
        index.eq("eventId", eventId).eq("state", "sending").lt("claimExpiresAt", generatedAt),
      )
      .take(queryLimit),
    ctx.db
      .query("participantNotificationDeliveries")
      .withIndex("by_event_state_next_attempt", (index) =>
        index.eq("eventId", eventId).eq("state", "retry_wait").lt("nextAttemptAt", generatedAt),
      )
      .take(queryLimit),
  ]);
  return {
    counts: {
      participant_delivery_failures: boundedCount(
        [...failed, ...bounced, ...suppressed].map((delivery) => delivery.updatedAt),
      ),
      participant_delivery_unknown: boundedCount(unknown.map((delivery) => delivery.updatedAt)),
      participant_delivery_stalls: boundedCount(
        [...pending, ...sending, ...retrying].map((delivery) => delivery.updatedAt),
      ),
    },
    coverage: [
      ...coverageMarker(failed, generatedAt),
      ...coverageMarker(bounced, generatedAt),
      ...coverageMarker(suppressed, generatedAt),
      ...coverageMarker(unknown, generatedAt),
      ...coverageMarker(pending, generatedAt),
      ...coverageMarker(sending, generatedAt),
      ...coverageMarker(retrying, generatedAt),
    ],
  };
}

type CurrentGithubState = "setup" | "active";
type GithubSyncState = "pending" | "running" | "rate_limited" | "error";
type GithubTopicState = "missing" | "unknown";

function githubSyncRows(
  ctx: QueryCtx,
  eventId: Id<"events">,
  state: CurrentGithubState,
  syncState: GithubSyncState,
  updatedBefore?: number,
) {
  return ctx.db
    .query("githubRepositoryBindings")
    .withIndex("by_event_state_sync_updated", (index) => {
      const range = index.eq("eventId", eventId).eq("state", state).eq("syncState", syncState);
      return updatedBefore === undefined ? range : range.lt("updatedAt", updatedBefore);
    })
    .take(queryLimit);
}

function githubLeaseRows(
  ctx: QueryCtx,
  eventId: Id<"events">,
  state: CurrentGithubState,
  expiresBefore: number,
) {
  return ctx.db
    .query("githubRepositoryBindings")
    .withIndex("by_event_state_sync_lease", (index) =>
      index
        .eq("eventId", eventId)
        .eq("state", state)
        .eq("syncState", "running")
        .lt("syncLeaseExpiresAt", expiresBefore),
    )
    .take(queryLimit);
}

function githubTopicRows(
  ctx: QueryCtx,
  eventId: Id<"events">,
  state: CurrentGithubState,
  topicState: GithubTopicState,
) {
  return ctx.db
    .query("githubRepositoryBindings")
    .withIndex("by_event_state_topic_updated", (index) =>
      index.eq("eventId", eventId).eq("state", state).eq("topicState", topicState),
    )
    .take(queryLimit);
}

type FigmaSyncState = "pending" | "running" | "rate_limited" | "error";
type FigmaWebhookState = "pending" | "unavailable" | "error";

function figmaSyncRows(
  ctx: QueryCtx,
  eventId: Id<"events">,
  syncState: FigmaSyncState,
  updatedBefore?: number,
) {
  return ctx.db
    .query("figmaFileBindings")
    .withIndex("by_event_state_sync_updated", (index) => {
      const range = index.eq("eventId", eventId).eq("state", "active").eq("syncState", syncState);
      return updatedBefore === undefined ? range : range.lt("updatedAt", updatedBefore);
    })
    .take(queryLimit);
}

function figmaLeaseRows(ctx: QueryCtx, eventId: Id<"events">, expiresBefore: number) {
  return ctx.db
    .query("figmaFileBindings")
    .withIndex("by_event_state_sync_lease", (index) =>
      index
        .eq("eventId", eventId)
        .eq("state", "active")
        .eq("syncState", "running")
        .lt("syncLeaseExpiresAt", expiresBefore),
    )
    .take(queryLimit);
}

function figmaWebhookRows(
  ctx: QueryCtx,
  eventId: Id<"events">,
  webhookState: FigmaWebhookState,
  updatedBefore?: number,
) {
  return ctx.db
    .query("figmaFileBindings")
    .withIndex("by_event_state_webhook_updated", (index) => {
      const range = index
        .eq("eventId", eventId)
        .eq("state", "active")
        .eq("webhookState", webhookState);
      return updatedBefore === undefined ? range : range.lt("updatedAt", updatedBefore);
    })
    .take(queryLimit);
}

async function integrationHealth(ctx: QueryCtx, event: Doc<"events">, generatedAt: number) {
  const eventId = event._id;
  const stalledBefore = generatedAt - shortJobWindowMs;
  const metadataStaleBefore =
    event.status === "live" ? generatedAt - 4 * 60 * 1_000 : generatedAt - 45 * 60 * 1_000;
  const currentGithubStates: CurrentGithubState[] = ["setup", "active"];
  const [
    githubInaccessible,
    figmaInaccessible,
    figmaErrors,
    figmaPending,
    figmaRunning,
    figmaRateLimited,
    figmaRateLimitWaits,
    figmaMetadataRateLimitWaits,
    figmaMetadataStale,
    figmaWebhookError,
    figmaWebhookPending,
    figmaWebhookUnavailable,
  ] = await Promise.all([
    ctx.db
      .query("githubRepositoryBindings")
      .withIndex("by_event_state_updated", (index) =>
        index.eq("eventId", eventId).eq("state", "inaccessible"),
      )
      .take(queryLimit),
    ctx.db
      .query("figmaFileBindings")
      .withIndex("by_event_state_updated", (index) =>
        index.eq("eventId", eventId).eq("state", "inaccessible"),
      )
      .take(queryLimit),
    figmaSyncRows(ctx, eventId, "error"),
    figmaSyncRows(ctx, eventId, "pending", stalledBefore),
    figmaLeaseRows(ctx, eventId, generatedAt),
    figmaSyncRows(ctx, eventId, "rate_limited"),
    ctx.db
      .query("figmaFileBindings")
      .withIndex("by_event_state_rate_limit", (index) =>
        index.eq("eventId", eventId).eq("state", "active").gt("rateLimitRetryAt", generatedAt),
      )
      .take(queryLimit),
    ctx.db
      .query("figmaFileBindings")
      .withIndex("by_event_state_metadata_rate_limit", (index) =>
        index
          .eq("eventId", eventId)
          .eq("state", "active")
          .gt("metadataRateLimitRetryAt", generatedAt),
      )
      .take(queryLimit),
    event.status === "draft" || event.status === "complete"
      ? Promise.resolve([])
      : ctx.db
          .query("figmaFileBindings")
          .withIndex("by_event_state_metadata_check", (index) =>
            index
              .eq("eventId", eventId)
              .eq("state", "active")
              .lt("lastMetadataCheckAt", metadataStaleBefore),
          )
          .take(queryLimit),
    figmaWebhookRows(ctx, eventId, "error"),
    figmaWebhookRows(ctx, eventId, "pending", stalledBefore),
    figmaWebhookRows(ctx, eventId, "unavailable"),
  ]);
  const githubGroups = await Promise.all(
    currentGithubStates.map(async (state) => {
      const [errors, pending, running, rateLimited, missingTopics, unknownTopics] =
        await Promise.all([
          githubSyncRows(ctx, eventId, state, "error"),
          githubSyncRows(ctx, eventId, state, "pending", stalledBefore),
          githubLeaseRows(ctx, eventId, state, generatedAt),
          githubSyncRows(ctx, eventId, state, "rate_limited"),
          githubTopicRows(ctx, eventId, state, "missing"),
          githubTopicRows(ctx, eventId, state, "unknown"),
        ]);
      return { errors, pending, running, rateLimited, missingTopics, unknownTopics };
    }),
  );
  const githubErrors = githubGroups.flatMap((group) => group.errors);
  const githubPending = githubGroups.flatMap((group) => group.pending);
  const githubRunning = githubGroups.flatMap((group) => group.running);
  const githubRateLimited = githubGroups.flatMap((group) => group.rateLimited);
  const githubTopics = githubGroups.flatMap((group) => [
    ...group.missingTopics,
    ...group.unknownTopics,
  ]);
  const githubCoverage = githubGroups.flatMap((group) => [
    ...coverageMarker(group.errors, generatedAt),
    ...coverageMarker(group.pending, generatedAt),
    ...coverageMarker(group.running, generatedAt),
    ...coverageMarker(group.rateLimited, generatedAt),
    ...coverageMarker(group.missingTopics, generatedAt),
    ...coverageMarker(group.unknownTopics, generatedAt),
  ]);
  const figmaRateLimitedById = new Map(
    [...figmaRateLimited, ...figmaRateLimitWaits, ...figmaMetadataRateLimitWaits].map((binding) => [
      binding._id,
      binding,
    ]),
  );
  return {
    counts: {
      github_inaccessible_repositories: boundedCount(
        githubInaccessible.map((binding) => binding.updatedAt),
      ),
      github_sync_errors: boundedCount(githubErrors.map((binding) => binding.updatedAt)),
      github_sync_stalls: boundedCount(
        [...githubPending, ...githubRunning].map((binding) => binding.updatedAt),
      ),
      github_rate_limits: boundedCount(githubRateLimited.map((binding) => binding.updatedAt)),
      github_unverified_topics: boundedCount(githubTopics.map((binding) => binding.updatedAt)),
      figma_inaccessible_files: boundedCount(figmaInaccessible.map((binding) => binding.updatedAt)),
      figma_sync_errors: boundedCount(figmaErrors.map((binding) => binding.updatedAt)),
      figma_sync_stalls: boundedCount(
        [...figmaPending, ...figmaRunning].map((binding) => binding.updatedAt),
      ),
      figma_rate_limits: boundedCount(
        [...figmaRateLimitedById.values()].map((binding) => binding.updatedAt),
      ),
      figma_metadata_stale: boundedCount(
        figmaMetadataStale.map((binding) => binding.lastMetadataCheckAt),
      ),
      figma_webhook_errors: boundedCount(
        [...figmaWebhookError, ...figmaWebhookPending].map((binding) => binding.updatedAt),
      ),
      figma_webhook_unavailable: boundedCount(
        figmaWebhookUnavailable.map((binding) => binding.updatedAt),
      ),
    },
    coverage: [
      ...coverageMarker(githubInaccessible, generatedAt),
      ...coverageMarker(figmaInaccessible, generatedAt),
      ...coverageMarker(figmaErrors, generatedAt),
      ...coverageMarker(figmaPending, generatedAt),
      ...coverageMarker(figmaRunning, generatedAt),
      ...coverageMarker(figmaRateLimited, generatedAt),
      ...coverageMarker(figmaRateLimitWaits, generatedAt),
      ...coverageMarker(figmaMetadataRateLimitWaits, generatedAt),
      ...coverageMarker(figmaMetadataStale, generatedAt),
      ...coverageMarker(figmaWebhookError, generatedAt),
      ...coverageMarker(figmaWebhookPending, generatedAt),
      ...coverageMarker(figmaWebhookUnavailable, generatedAt),
      ...githubCoverage,
    ],
  };
}

async function scoreHealth(ctx: QueryCtx, eventId: Id<"events">, generatedAt: number) {
  const stalledBefore = generatedAt - exportWindowMs;
  const closingRounds = await ctx.db
    .query("reviewRounds")
    .withIndex("by_event_status_start", (index) =>
      index.eq("eventId", eventId).eq("status", "closing"),
    )
    .take(queryLimit);
  const activeExports = await Promise.all(
    closingRounds.map((round) =>
      round.activeRoundExportId ? ctx.db.get(round.activeRoundExportId) : Promise.resolve(null),
    ),
  );
  const failedAt: number[] = [];
  const stalledAt: number[] = [];
  for (let index = 0; index < closingRounds.length; index += 1) {
    const round = closingRounds[index];
    const activeExport = activeExports[index];
    if (round === undefined || activeExport === undefined) continue;
    if (activeExport?.state === "failed") {
      failedAt.push(activeExport.updatedAt);
      continue;
    }
    const observedAt = activeExport?.updatedAt ?? round.closingAt ?? round.startsAt;
    if (
      observedAt < stalledBefore &&
      (activeExport === null || activeExport.state === "generating")
    ) {
      stalledAt.push(observedAt);
    }
  }
  return {
    counts: {
      round_export_failures: boundedCount(failedAt),
      round_export_stalls: boundedCount(stalledAt),
    },
    coverage: coverageMarker(closingRounds, generatedAt),
  };
}

async function emergencyPackHealth(ctx: QueryCtx, eventId: Id<"events">, generatedAt: number) {
  const stalledBefore = generatedAt - exportWindowMs;
  const [failed, pending] = await Promise.all([
    ctx.db
      .query("emergencyPacks")
      .withIndex("by_event_status_created", (index) =>
        index.eq("eventId", eventId).eq("status", "failed"),
      )
      .order("desc")
      .take(queryLimit),
    ctx.db
      .query("emergencyPacks")
      .withIndex("by_event_status_created", (index) =>
        index.eq("eventId", eventId).eq("status", "pending").lt("requestedAt", stalledBefore),
      )
      .take(queryLimit),
  ]);
  return {
    counts: {
      emergency_pack_failures: boundedCount(
        failed
          .filter((pack) => pack.expiresAt > generatedAt)
          .map((pack) => pack.failedAt ?? pack.requestedAt),
      ),
      emergency_pack_stalls: boundedCount(
        pending.filter((pack) => pack.expiresAt > generatedAt).map((pack) => pack.requestedAt),
      ),
    },
    coverage: [...coverageMarker(failed, generatedAt), ...coverageMarker(pending, generatedAt)],
  };
}

async function synesthesiaHealth(ctx: QueryCtx, eventId: Id<"events">, generatedAt: number) {
  const window = await activeSynesthesiaWindow(ctx, eventId, generatedAt);
  if (!window) {
    return {
      counts: {
        open_synesthesia_reports: boundedCount([]),
        stale_synesthesia_playback: boundedCount([]),
        synesthesia_playback_conflicts: boundedCount([]),
        synesthesia_playback_paused: boundedCount([]),
      },
      coverage: [],
    };
  }
  const [openReports, playingRequests] = await Promise.all([
    ctx.db
      .query("synesthesiaReports")
      .withIndex("by_window_state_created", (index) =>
        index.eq("windowId", window._id).eq("state", "open"),
      )
      .take(queryLimit),
    ctx.db
      .query("songRequests")
      .withIndex("by_window_state_created", (index) =>
        index.eq("windowId", window._id).eq("state", "playing"),
      )
      .take(queryLimit),
  ]);
  const stalePlaybackTimes = playingRequests
    .filter((request) => {
      const startedAt = request.playbackStartedAt;
      return (
        startedAt !== undefined &&
        startedAt + request.durationSeconds * 1_000 + playbackAcknowledgementAllowanceMs <
          generatedAt
      );
    })
    .map((request) => request.playbackStartedAt ?? request.updatedAt);
  return {
    counts: {
      open_synesthesia_reports: boundedCount(openReports.map((report) => report.createdAt)),
      stale_synesthesia_playback: boundedCount(stalePlaybackTimes),
      synesthesia_playback_conflicts: boundedCount(
        playingRequests.length > 1
          ? playingRequests.map((request) => request.playbackStartedAt ?? request.updatedAt)
          : [],
      ),
      synesthesia_playback_paused: boundedCount(window.playbackPaused ? [window.updatedAt] : []),
    },
    coverage: [
      ...coverageMarker(openReports, generatedAt),
      ...coverageMarker(playingRequests, generatedAt),
    ],
  };
}

async function buildOverview(
  ctx: QueryCtx,
  event: Doc<"events">,
): Promise<OperationsHealthOverview> {
  const generatedAt = Date.now();
  const [
    incidents,
    intelligence,
    reviews,
    attendance,
    communications,
    integrations,
    scores,
    emergencyPacks,
    synesthesia,
  ] = await Promise.all([
    incidentHealth(ctx, event._id, generatedAt),
    intelligenceHealth(ctx, event._id, generatedAt),
    reviewHealth(ctx, event._id, generatedAt),
    attendanceHealth(ctx, event, generatedAt),
    communicationsHealth(ctx, event._id, generatedAt),
    integrationHealth(ctx, event, generatedAt),
    scoreHealth(ctx, event._id, generatedAt),
    emergencyPackHealth(ctx, event._id, generatedAt),
    synesthesiaHealth(ctx, event._id, generatedAt),
  ]);
  const coverage = [
    ...incidents.coverage,
    ...intelligence.coverage,
    ...reviews.coverage,
    ...attendance.coverage,
    ...communications.coverage,
    ...integrations.coverage,
    ...scores.coverage,
    ...emergencyPacks.coverage,
    ...synesthesia.coverage,
  ];
  const counts: OperationsHealthCounts = {
    ...emptyOperationsHealthCounts(),
    ...incidents.counts,
    ...intelligence.counts,
    ...reviews.counts,
    ...attendance.counts,
    ...communications.counts,
    ...integrations.counts,
    ...scores.counts,
    ...emergencyPacks.counts,
    ...synesthesia.counts,
    projection_coverage_limited: boundedCount(coverage),
  };
  const health = buildOperationsHealth(counts);
  return {
    generatedAt,
    event: {
      slug: event.slug,
      name: event.name,
      timezone: event.timezone,
      status: event.status,
    },
    summary: health.summary,
    signals: health.signals,
  };
}

export const refreshTarget = internalQuery({
  args: {},
  returns: v.union(v.null(), v.object({ eventId: v.id("events") })),
  handler: async (ctx) => {
    const events = await ctx.db.query("events").take(2);
    if (events.length > 1) {
      throw new Error("An event deployment must contain exactly one event.");
    }
    const event = events[0];
    return event ? { eventId: event._id } : null;
  },
});

export const computeSnapshot = internalQuery({
  args: { eventId: v.id("events") },
  returns: v.object({
    eventVersion: v.number(),
    snapshot: operationsHealthSnapshot,
  }),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("The operations-health event no longer exists.");
    return {
      eventVersion: event.version,
      snapshot: await buildOverview(ctx, event),
    };
  },
});

const snapshotWriteResult = v.union(
  v.literal("created"),
  v.literal("updated"),
  v.literal("unchanged"),
  v.literal("stale"),
);
type SnapshotWriteResult = "created" | "updated" | "unchanged" | "stale";

export const upsertSnapshot = internalMutation({
  args: {
    eventId: v.id("events"),
    eventVersion: v.number(),
    snapshot: operationsHealthSnapshot,
  },
  returns: snapshotWriteResult,
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("The operations-health event no longer exists.");
    if (event.version !== args.eventVersion) return "stale";
    if (
      args.snapshot.event.slug !== event.slug ||
      args.snapshot.event.name !== event.name ||
      args.snapshot.event.timezone !== event.timezone ||
      args.snapshot.event.status !== event.status
    ) {
      throw new Error("The operations-health snapshot does not match its event.");
    }
    const existing = await ctx.db
      .query("operationsHealthSnapshots")
      .withIndex("by_event", (index) => index.eq("eventId", args.eventId))
      .unique();
    const staleAt = args.snapshot.generatedAt + operationsHealthMaximumAgeMs;
    if (!existing) {
      await ctx.db.insert("operationsHealthSnapshots", {
        ...args,
        state: "ready",
        staleAt,
      });
      await ctx.scheduler.runAt(staleAt, internal.operationsHealth.markSnapshotStale, {
        eventId: args.eventId,
        expectedGeneratedAt: args.snapshot.generatedAt,
      });
      await enqueueOperationsAutonomySignal(ctx, {
        eventId: args.eventId,
        snapshot: args.snapshot,
        now: args.snapshot.generatedAt,
      });
      await reconcileOperationsEpisodes(ctx, args.eventId, args.snapshot);
      return "created";
    }
    if (existing.snapshot.generatedAt > args.snapshot.generatedAt) return "stale";
    if (existing.snapshot.generatedAt === args.snapshot.generatedAt) {
      return existing.eventVersion === args.eventVersion &&
        JSON.stringify(existing.snapshot) === JSON.stringify(args.snapshot)
        ? "unchanged"
        : "stale";
    }
    await ctx.db.patch(existing._id, {
      eventVersion: args.eventVersion,
      snapshot: args.snapshot,
      state: "ready",
      staleAt,
    });
    await ctx.scheduler.runAt(staleAt, internal.operationsHealth.markSnapshotStale, {
      eventId: args.eventId,
      expectedGeneratedAt: args.snapshot.generatedAt,
    });
    await enqueueOperationsAutonomySignal(ctx, {
      eventId: args.eventId,
      snapshot: args.snapshot,
      now: args.snapshot.generatedAt,
    });
    await reconcileOperationsEpisodes(ctx, args.eventId, args.snapshot);
    return "updated";
  },
});

export const markSnapshotStale = internalMutation({
  args: {
    eventId: v.id("events"),
    expectedGeneratedAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const materialized = await ctx.db
      .query("operationsHealthSnapshots")
      .withIndex("by_event", (index) => index.eq("eventId", args.eventId))
      .unique();
    if (
      !materialized ||
      materialized.state === "stale" ||
      materialized.snapshot.generatedAt !== args.expectedGeneratedAt
    ) {
      return false;
    }
    await ctx.db.patch(materialized._id, { state: "stale" });
    return true;
  },
});

export const refresh = internalAction({
  args: {},
  returns: v.union(v.literal("no_event"), snapshotWriteResult),
  handler: async (ctx): Promise<"no_event" | SnapshotWriteResult> => {
    const target: { eventId: Id<"events"> } | null = await ctx.runQuery(
      internal.operationsHealth.refreshTarget,
      {},
    );
    if (!target) return "no_event";
    const computed: {
      eventVersion: number;
      snapshot: OperationsHealthOverview;
    } = await ctx.runQuery(internal.operationsHealth.computeSnapshot, {
      eventId: target.eventId,
    });
    return await ctx.runMutation(internal.operationsHealth.upsertSnapshot, {
      eventId: target.eventId,
      eventVersion: computed.eventVersion,
      snapshot: computed.snapshot,
    });
  },
});

export const materializedForEvent = internalQuery({
  args: { eventId: v.id("events"), now: v.number() },
  returns: operationsHealthSnapshotStateValidator,
  handler: async (ctx, args) => {
    return operationsHealthSnapshotState(ctx, args.eventId, args.now);
  },
});

export const overview = query({
  args: { eventSlug: v.string() },
  returns: operationsHealthSnapshotStateValidator,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "operations.health.read",
      scopeType: "event",
    });
    return operationsHealthSnapshotState(ctx, event._id, Date.now());
  },
});
