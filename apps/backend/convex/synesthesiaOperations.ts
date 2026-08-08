import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { requirePermission } from "./lib/permissions";
import { normalizedText, optionalNormalizedText } from "./lib/strings";
import {
  activeGrantScopes,
  compareSongRequests,
  maximumRequestsPerWindow,
  scopeAllows,
} from "./lib/synesthesia";
import {
  songQueueMode,
  songRequestState,
  synesthesiaWindowStatus,
} from "./values";

type ReadCtx = QueryCtx | MutationCtx;

const reportView = v.object({
  id: v.id("synesthesiaReports"),
  reason: v.string(),
  version: v.number(),
  createdAt: v.number(),
});

const queueRequestView = v.object({
  id: v.id("songRequests"),
  title: v.string(),
  artist: v.string(),
  album: v.optional(v.string()),
  durationSeconds: v.number(),
  isExplicit: v.boolean(),
  energyTag: v.string(),
  note: v.optional(v.string()),
  state: songRequestState,
  voteCount: v.number(),
  openReportCount: v.number(),
  queueMode: songQueueMode,
  scheduledFor: v.optional(v.number()),
  publicReason: v.optional(v.string()),
  internalNote: v.optional(v.string()),
  requesterAccessState: v.union(v.literal("active"), v.literal("suspended")),
  requesterAccessVersion: v.number(),
  version: v.number(),
  createdAt: v.number(),
  openReports: v.array(reportView),
  reportsTruncated: v.boolean(),
  canModerate: v.boolean(),
  canSchedule: v.boolean(),
  canAcknowledgePlayback: v.boolean(),
  canReadReports: v.boolean(),
  canResolveReports: v.boolean(),
  canSuspendRequester: v.boolean(),
  canRestoreRequester: v.boolean(),
});

async function staffContext(ctx: ReadCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  return { event, person, subject };
}

export const queue = query({
  args: { eventSlug: v.string(), windowId: v.id("synesthesiaWindows") },
  returns: v.object({
    window: v.object({
      id: v.id("synesthesiaWindows"),
      name: v.string(),
      status: synesthesiaWindowStatus,
      startsAt: v.number(),
      endsAt: v.number(),
      playbackPaused: v.boolean(),
      playbackPauseReason: v.optional(v.string()),
      version: v.number(),
    }),
    requests: v.array(queueRequestView),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { event, subject } = await staffContext(ctx, args.eventSlug);
    const window = await ctx.db.get("synesthesiaWindows", args.windowId);
    if (!window || window.eventId !== event._id) {
      throw new ConvexError({ code: "WINDOW_NOT_FOUND", message: "Window not found." });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "synesthesia.queue.read",
      scopeType: "synesthesia_window",
      scopeId: window._id,
    });
    const [
      requests,
      openReports,
      moderate,
      schedule,
      playback,
      reportRead,
      reportResolve,
      suspend,
      restore,
    ] = await Promise.all([
      ctx.db
        .query("songRequests")
        .withIndex("by_window_created", (index) => index.eq("windowId", window._id))
        .take(maximumRequestsPerWindow + 1),
      ctx.db
        .query("synesthesiaReports")
        .withIndex("by_window_state_created", (index) =>
          index.eq("windowId", window._id).eq("state", "open"),
        )
        .take(maximumRequestsPerWindow),
      activeGrantScopes(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "synesthesia.request.moderate",
      }),
      activeGrantScopes(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "synesthesia.queue.schedule",
      }),
      activeGrantScopes(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "synesthesia.playback.acknowledge",
      }),
      activeGrantScopes(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "synesthesia.report.read",
      }),
      activeGrantScopes(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "synesthesia.report.resolve",
      }),
      activeGrantScopes(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "synesthesia.access.suspend",
      }),
      activeGrantScopes(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "synesthesia.access.restore",
      }),
    ]);
    const visibleRequests = requests.slice(0, maximumRequestsPerWindow);
    const membershipIds = [
      ...new Set(visibleRequests.map((request) => request.requestedByMembershipId)),
    ];
    const accessStates = await Promise.all(
      membershipIds.map(async (membershipId) => ({
        membershipId,
        state: await ctx.db
          .query("synesthesiaAccessStates")
          .withIndex("by_membership", (index) => index.eq("membershipId", membershipId))
          .unique(),
      })),
    );
    const accessByMembership = new Map(
      accessStates.map((entry) => [entry.membershipId, entry.state]),
    );
    const reportsByRequest = new Map<Id<"songRequests">, typeof openReports>();
    for (const report of openReports) {
      const current = reportsByRequest.get(report.requestId) ?? [];
      current.push(report);
      reportsByRequest.set(report.requestId, current);
    }
    return {
      window: {
        id: window._id,
        name: window.name,
        status: window.status,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        playbackPaused: window.playbackPaused,
        ...(window.playbackPauseReason !== undefined
          ? { playbackPauseReason: window.playbackPauseReason }
          : {}),
        version: window.version,
      },
      requests: visibleRequests.sort(compareSongRequests).map((request) => {
        const canModerate = scopeAllows(moderate, request._id);
        const canReadReports = scopeAllows(reportRead, request._id);
        const accessState = accessByMembership.get(request.requestedByMembershipId);
        const requestReports = reportsByRequest.get(request._id) ?? [];
        return {
          id: request._id,
          title: request.title,
          artist: request.artist,
          ...(request.album !== undefined ? { album: request.album } : {}),
          durationSeconds: request.durationSeconds,
          isExplicit: request.isExplicit,
          energyTag: request.energyTag,
          ...(request.note !== undefined ? { note: request.note } : {}),
          state: request.state,
          voteCount: request.voteCount,
          openReportCount: request.openReportCount,
          queueMode: request.queueMode,
          ...(request.scheduledFor !== undefined
            ? { scheduledFor: request.scheduledFor }
            : {}),
          ...(request.publicReason !== undefined
            ? { publicReason: request.publicReason }
            : {}),
          ...(canModerate && request.internalNote !== undefined
            ? { internalNote: request.internalNote }
            : {}),
          requesterAccessState: accessState?.state ?? "active",
          requesterAccessVersion: accessState?.version ?? 0,
          version: request.version,
          createdAt: request.createdAt,
          openReports: canReadReports
            ? requestReports.map((report) => ({
                id: report._id,
                reason: report.reason,
                version: report.version,
                createdAt: report.createdAt,
              }))
            : [],
          reportsTruncated:
            canReadReports && requestReports.length < request.openReportCount,
          canModerate,
          canSchedule: scopeAllows(schedule, request._id),
          canAcknowledgePlayback: scopeAllows(playback, request._id),
          canReadReports,
          canResolveReports: scopeAllows(reportResolve, request._id),
          canSuspendRequester:
            (accessState?.state ?? "active") === "active" &&
            scopeAllows(suspend, request.requestedByPersonId),
          canRestoreRequester:
            accessState?.state === "suspended" &&
            scopeAllows(restore, request.requestedByPersonId),
        };
      }),
      truncated: requests.length > maximumRequestsPerWindow,
    };
  },
});

export const moderateRequest = mutation({
  args: {
    eventSlug: v.string(),
    requestId: v.id("songRequests"),
    decision: v.union(v.literal("approve"), v.literal("reject"), v.literal("hide")),
    publicReason: v.optional(v.string()),
    internalNote: v.optional(v.string()),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ requestId: v.id("songRequests"), version: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject } = await staffContext(ctx, args.eventSlug);
    const publicReason = optionalNormalizedText(args.publicReason, "Public reason", 160);
    const internalNote = optionalNormalizedText(args.internalNote, "Internal note", 300);
    const reason = normalizedText(args.reason, "Moderation reason", 5, 200);
    if ((args.decision === "reject" || args.decision === "hide") && !publicReason) {
      throw new ConvexError({
        code: "PUBLIC_REASON_REQUIRED",
        message: "A short participant-facing reason is required.",
      });
    }
    const requestFingerprint = operationFingerprint([
      args.requestId,
      args.decision,
      publicReason ?? null,
      internalNote ?? null,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.request.moderate",
      requestFingerprint,
    });
    const request = await ctx.db.get("songRequests", args.requestId);
    if (!request || request.eventId !== event._id) {
      throw new ConvexError({ code: "REQUEST_NOT_FOUND", message: "Song request not found." });
    }
    if (prior) return { requestId: request._id, version: request.version };
    if (request.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "REQUEST_CHANGED",
        message: "The song request changed. Review it and try again.",
      });
    }
    const nextState =
      args.decision === "approve"
        ? "approved"
        : args.decision === "reject"
          ? "rejected"
          : "hidden";
    const valid =
      (args.decision === "approve" && request.state === "pending") ||
      ((args.decision === "reject" || args.decision === "hide") &&
        (request.state === "pending" ||
          request.state === "approved" ||
          request.state === "queued"));
    if (!valid) {
      throw new ConvexError({
        code: "INVALID_REQUEST_TRANSITION",
        message: "That moderation action is not valid from the current request state.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "synesthesia.request.moderate",
      scopeType: "song_request",
      scopeId: request._id,
    });
    const now = Date.now();
    const version = request.version + 1;
    await ctx.db.patch("songRequests", request._id, {
      state: nextState,
      queueMode: "normal",
      scheduledFor: undefined,
      publicReason,
      internalNote,
      moderatedByPersonId: person._id,
      moderatedAt: now,
      version,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.request.moderate",
      requestFingerprint,
      targetType: "song_request",
      targetId: request._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "synesthesia.request.moderate",
      grantIds,
      scopeType: "song_request",
      scopeId: request._id,
      action: `synesthesia.request_${args.decision}`,
      targetType: "song_request",
      targetId: request._id,
      previousSummary: JSON.stringify({ state: request.state, version: request.version }),
      nextSummary: JSON.stringify({ state: nextState, version }),
      reason,
    });
    return { requestId: request._id, version };
  },
});

export const scheduleRequest = mutation({
  args: {
    eventSlug: v.string(),
    requestId: v.id("songRequests"),
    mode: songQueueMode,
    scheduledFor: v.optional(v.number()),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ requestId: v.id("songRequests"), version: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject } = await staffContext(ctx, args.eventSlug);
    const reason = normalizedText(args.reason, "Queue reason", 5, 200);
    const requestFingerprint = operationFingerprint([
      args.requestId,
      args.mode,
      args.scheduledFor ?? null,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.queue.schedule",
      requestFingerprint,
    });
    const request = await ctx.db.get("songRequests", args.requestId);
    if (!request || request.eventId !== event._id) {
      throw new ConvexError({ code: "REQUEST_NOT_FOUND", message: "Song request not found." });
    }
    if (prior) return { requestId: request._id, version: request.version };
    if (
      request.version !== args.expectedVersion ||
      (request.state !== "approved" && request.state !== "queued")
    ) {
      throw new ConvexError({
        code: "REQUEST_CHANGED",
        message: "Only the current approved or queued request can be scheduled.",
      });
    }
    const window = await ctx.db.get("synesthesiaWindows", request.windowId);
    if (!window || window.eventId !== event._id || window.status !== "published") {
      throw new ConvexError({
        code: "WINDOW_NOT_AVAILABLE",
        message: "The request window is no longer published.",
      });
    }
    if (
      args.mode === "deferred" &&
      (args.scheduledFor === undefined ||
        !Number.isSafeInteger(args.scheduledFor) ||
        args.scheduledFor <= Date.now() ||
        args.scheduledFor >= window.endsAt)
    ) {
      throw new ConvexError({
        code: "INVALID_SCHEDULE_TIME",
        message: "A deferred item needs a future time inside the window.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "synesthesia.queue.schedule",
      scopeType: "song_request",
      scopeId: request._id,
    });
    const now = Date.now();
    const version = request.version + 1;
    await ctx.db.patch("songRequests", request._id, {
      state: "queued",
      queueMode: args.mode,
      scheduledFor: args.mode === "deferred" ? args.scheduledFor : undefined,
      version,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.queue.schedule",
      requestFingerprint,
      targetType: "song_request",
      targetId: request._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "synesthesia.queue.schedule",
      grantIds,
      scopeType: "song_request",
      scopeId: request._id,
      action: "synesthesia.request_scheduled",
      targetType: "song_request",
      targetId: request._id,
      previousSummary: JSON.stringify({
        state: request.state,
        queueMode: request.queueMode,
        version: request.version,
      }),
      nextSummary: JSON.stringify({
        state: "queued",
        queueMode: args.mode,
        scheduledFor: args.mode === "deferred" ? args.scheduledFor : null,
        version,
      }),
      reason,
    });
    return { requestId: request._id, version };
  },
});

export const acknowledgePlayback = mutation({
  args: {
    eventSlug: v.string(),
    requestId: v.id("songRequests"),
    action: v.union(v.literal("start"), v.literal("played"), v.literal("skip")),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ requestId: v.id("songRequests"), version: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject } = await staffContext(ctx, args.eventSlug);
    const reason = normalizedText(args.reason, "Playback reason", 5, 200);
    const requestFingerprint = operationFingerprint([
      args.requestId,
      args.action,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.playback.acknowledge",
      requestFingerprint,
    });
    const request = await ctx.db.get("songRequests", args.requestId);
    if (!request || request.eventId !== event._id) {
      throw new ConvexError({ code: "REQUEST_NOT_FOUND", message: "Song request not found." });
    }
    if (prior) return { requestId: request._id, version: request.version };
    if (request.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "REQUEST_CHANGED",
        message: "The song request changed. Review it and try again.",
      });
    }
    const window = await ctx.db.get("synesthesiaWindows", request.windowId);
    if (!window || window.eventId !== event._id || window.status !== "published") {
      throw new ConvexError({
        code: "WINDOW_NOT_AVAILABLE",
        message: "The request window is no longer published.",
      });
    }
    const now = Date.now();
    if (args.action === "start") {
      if (
        window.playbackPaused ||
        window.startsAt > now ||
        window.endsAt <= now ||
        (request.state !== "approved" && request.state !== "queued") ||
        (request.queueMode === "deferred" &&
          request.scheduledFor !== undefined &&
          request.scheduledFor > now)
      ) {
        throw new ConvexError({
          code: "PLAYBACK_NOT_READY",
          message: "That request is not ready to start.",
        });
      }
      const playing = await ctx.db
        .query("songRequests")
        .withIndex("by_window_state_created", (index) =>
          index.eq("windowId", window._id).eq("state", "playing"),
        )
        .first();
      if (playing) {
        throw new ConvexError({
          code: "PLAYBACK_ALREADY_ACTIVE",
          message: "Finish or skip the current item before starting another.",
        });
      }
    } else if (request.state !== "playing") {
      throw new ConvexError({
        code: "PLAYBACK_NOT_ACTIVE",
        message: "Only the currently playing item can be finished or skipped.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "synesthesia.playback.acknowledge",
      scopeType: "song_request",
      scopeId: request._id,
    });
    const nextState =
      args.action === "start" ? "playing" : args.action === "played" ? "played" : "skipped";
    const eventKind =
      args.action === "start" ? "started" : args.action === "played" ? "played" : "skipped";
    const version = request.version + 1;
    await ctx.db.patch("songRequests", request._id, {
      state: nextState,
      ...(args.action === "start"
        ? { playbackStartedAt: now }
        : { playbackFinishedAt: now }),
      ...(args.action === "skip" ? { publicReason: reason } : {}),
      version,
      updatedAt: now,
    });
    await ctx.db.insert("synesthesiaPlaybackEvents", {
      eventId: event._id,
      windowId: window._id,
      requestId: request._id,
      kind: eventKind,
      actorPersonId: person._id,
      requestVersion: version,
      reason,
      createdAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.playback.acknowledge",
      requestFingerprint,
      targetType: "song_request",
      targetId: request._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "synesthesia.playback.acknowledge",
      grantIds,
      scopeType: "song_request",
      scopeId: request._id,
      action: `synesthesia.playback_${eventKind}`,
      targetType: "song_request",
      targetId: request._id,
      previousSummary: JSON.stringify({ state: request.state, version: request.version }),
      nextSummary: JSON.stringify({ state: nextState, version }),
      reason,
    });
    return { requestId: request._id, version };
  },
});

export const resolveReport = mutation({
  args: {
    eventSlug: v.string(),
    reportId: v.id("synesthesiaReports"),
    disposition: v.union(v.literal("resolved"), v.literal("dismissed")),
    publicResolution: v.string(),
    internalResolution: v.optional(v.string()),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ reportId: v.id("synesthesiaReports"), version: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject } = await staffContext(ctx, args.eventSlug);
    const publicResolution = normalizedText(
      args.publicResolution,
      "Public resolution",
      3,
      160,
    );
    const internalResolution = optionalNormalizedText(
      args.internalResolution,
      "Internal resolution",
      300,
    );
    const reason = normalizedText(args.reason, "Resolution reason", 5, 200);
    const requestFingerprint = operationFingerprint([
      args.reportId,
      args.disposition,
      publicResolution,
      internalResolution ?? null,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.report.resolve",
      requestFingerprint,
    });
    const report = await ctx.db.get("synesthesiaReports", args.reportId);
    if (!report || report.eventId !== event._id) {
      throw new ConvexError({ code: "REPORT_NOT_FOUND", message: "Report not found." });
    }
    if (prior) return { reportId: report._id, version: report.version };
    if (report.state !== "open" || report.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "REPORT_CHANGED",
        message: "The report changed. Review it and try again.",
      });
    }
    const request = await ctx.db.get("songRequests", report.requestId);
    if (!request || request.eventId !== event._id) {
      throw new Error("The report's song request no longer resolves.");
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "synesthesia.report.resolve",
      scopeType: "song_request",
      scopeId: request._id,
    });
    const now = Date.now();
    const version = report.version + 1;
    await ctx.db.patch("synesthesiaReports", report._id, {
      state: args.disposition,
      publicResolution,
      internalResolution,
      resolvedByPersonId: person._id,
      resolvedAt: now,
      version,
      updatedAt: now,
    });
    await ctx.db.patch("songRequests", request._id, {
      openReportCount: Math.max(0, request.openReportCount - 1),
      version: request.version + 1,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.report.resolve",
      requestFingerprint,
      targetType: "synesthesia_report",
      targetId: report._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "synesthesia.report.resolve",
      grantIds,
      scopeType: "song_request",
      scopeId: request._id,
      action: `synesthesia.report_${args.disposition}`,
      targetType: "synesthesia_report",
      targetId: report._id,
      previousSummary: JSON.stringify({ state: report.state, version: report.version }),
      nextSummary: JSON.stringify({ state: args.disposition, version }),
      reason,
    });
    return { reportId: report._id, version };
  },
});

export const setRequesterAccess = mutation({
  args: {
    eventSlug: v.string(),
    requestId: v.id("songRequests"),
    state: v.union(v.literal("active"), v.literal("suspended")),
    expectedAccessVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ membershipId: v.id("eventMemberships"), version: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject } = await staffContext(ctx, args.eventSlug);
    const reason = normalizedText(args.reason, "Access reason", 5, 200);
    const permissionKey =
      args.state === "suspended"
        ? "synesthesia.access.suspend"
        : "synesthesia.access.restore";
    const requestFingerprint = operationFingerprint([
      args.requestId,
      args.state,
      args.expectedAccessVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: permissionKey,
      requestFingerprint,
    });
    const request = await ctx.db.get("songRequests", args.requestId);
    if (!request || request.eventId !== event._id) {
      throw new ConvexError({ code: "REQUEST_NOT_FOUND", message: "Song request not found." });
    }
    const membership = await ctx.db.get("eventMemberships", request.requestedByMembershipId);
    if (
      !membership ||
      membership.eventId !== event._id ||
      membership.personId !== request.requestedByPersonId
    ) {
      throw new Error("The requester's participant membership no longer resolves.");
    }
    const existing = await ctx.db
      .query("synesthesiaAccessStates")
      .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
      .unique();
    if (prior) {
      return { membershipId: membership._id, version: existing?.version ?? 0 };
    }
    const currentVersion = existing?.version ?? 0;
    const currentState = existing?.state ?? "active";
    if (currentVersion !== args.expectedAccessVersion) {
      throw new ConvexError({
        code: "SYNESTHESIA_ACCESS_CHANGED",
        message: "The participant's music access changed. Review it and try again.",
      });
    }
    if (currentState === args.state) {
      throw new ConvexError({
        code: "SYNESTHESIA_ACCESS_UNCHANGED",
        message:
          args.state === "suspended"
            ? "Music access is already suspended."
            : "Music access is already active.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey,
      scopeType: "person",
      scopeId: membership.personId,
    });
    const now = Date.now();
    const version = currentVersion + 1;
    if (existing) {
      await ctx.db.patch("synesthesiaAccessStates", existing._id, {
        state: args.state,
        reason,
        changedByPersonId: person._id,
        version,
        changedAt: now,
      });
    } else {
      await ctx.db.insert("synesthesiaAccessStates", {
        eventId: event._id,
        membershipId: membership._id,
        personId: membership.personId,
        state: args.state,
        reason,
        changedByPersonId: person._id,
        version,
        changedAt: now,
      });
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: permissionKey,
      requestFingerprint,
      targetType: "participant_membership",
      targetId: membership._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey,
      grantIds,
      scopeType: "person",
      scopeId: membership.personId,
      action:
        args.state === "suspended"
          ? "synesthesia.access_suspended"
          : "synesthesia.access_restored",
      targetType: "participant_membership",
      targetId: membership._id,
      previousSummary: JSON.stringify({ state: currentState, version: currentVersion }),
      nextSummary: JSON.stringify({ state: args.state, version }),
      reason,
    });
    return { membershipId: membership._id, version };
  },
});
