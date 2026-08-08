import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { optionalNormalizedText } from "./lib/strings";
import {
  activeSynesthesiaWindow,
  compareSongRequests,
  maximumCatalogSearchResults,
  maximumRequestsPerWindow,
  requireSynesthesiaParticipant,
  synesthesiaParticipantContext,
  trackFitsWindow,
} from "./lib/synesthesia";
import { songRequestState, synesthesiaWindowKind } from "./values";

const participantWindow = v.object({
  id: v.id("synesthesiaWindows"),
  name: v.string(),
  kind: synesthesiaWindowKind,
  customKindLabel: v.optional(v.string()),
  startsAt: v.number(),
  endsAt: v.number(),
  requestsOpen: v.boolean(),
  votingOpen: v.boolean(),
  playbackPaused: v.boolean(),
  catalogSourceLabel: v.string(),
  maxRequestsPerParticipant: v.number(),
  maxVotesPerParticipant: v.number(),
  version: v.number(),
});

const participantRequest = v.object({
  id: v.id("songRequests"),
  title: v.string(),
  artist: v.string(),
  album: v.optional(v.string()),
  durationSeconds: v.number(),
  isExplicit: v.boolean(),
  energyTag: v.string(),
  state: songRequestState,
  voteCount: v.number(),
  publicReason: v.optional(v.string()),
  scheduledFor: v.optional(v.number()),
  isMine: v.boolean(),
  hasVoted: v.boolean(),
  hasReported: v.boolean(),
  canVote: v.boolean(),
  canReport: v.boolean(),
  version: v.number(),
  createdAt: v.number(),
});

const catalogTrack = v.object({
  id: v.id("synesthesiaCatalogTracks"),
  provider: v.string(),
  providerTrackId: v.string(),
  title: v.string(),
  artist: v.string(),
  album: v.optional(v.string()),
  durationSeconds: v.number(),
  isExplicit: v.boolean(),
  energyTag: v.string(),
});

function isParticipantVisible(
  request: Doc<"songRequests">,
  membershipId: Id<"eventMemberships">,
) {
  if (request.state === "hidden") return false;
  if (request.state === "rejected") {
    return request.requestedByMembershipId === membershipId;
  }
  return true;
}

function requestAllowsVote(state: Doc<"songRequests">["state"]) {
  return state === "pending" || state === "approved" || state === "queued";
}

async function participantWindowForWrite(
  ctx: MutationCtx,
  eventId: Id<"events">,
  windowId: Id<"synesthesiaWindows">,
) {
  const window = await ctx.db.get("synesthesiaWindows", windowId);
  const now = Date.now();
  if (
    !window ||
    window.eventId !== eventId ||
    window.status !== "published" ||
    window.startsAt > now ||
    window.endsAt <= now
  ) {
    throw new ConvexError({
      code: "SYNESTHESIA_WINDOW_CLOSED",
      message: "That music-request window is not open.",
    });
  }
  return window;
}

export const state = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    eligible: v.boolean(),
    suspended: v.boolean(),
    window: v.union(v.null(), participantWindow),
    usage: v.object({ requests: v.number(), votes: v.number() }),
    requests: v.array(participantRequest),
  }),
  handler: async (ctx, args) => {
    const context = await synesthesiaParticipantContext(ctx, args.eventSlug);
    const suspended = context.accessState?.state === "suspended";
    if (!context.eligible) {
      return {
        eligible: false,
        suspended,
        window: null,
        usage: { requests: 0, votes: 0 },
        requests: [],
      };
    }
    const window = await activeSynesthesiaWindow(ctx, context.event._id, Date.now());
    if (!window) {
      return {
        eligible: true,
        suspended,
        window: null,
        usage: { requests: 0, votes: 0 },
        requests: [],
      };
    }
    const [requests, votes, reports, ownRequests] = await Promise.all([
      ctx.db
        .query("songRequests")
        .withIndex("by_window_created", (index) => index.eq("windowId", window._id))
        .take(maximumRequestsPerWindow),
      ctx.db
        .query("songVotes")
        .withIndex("by_window_member_state", (index) =>
          index
            .eq("windowId", window._id)
            .eq("membershipId", context.membership._id)
            .eq("state", "active"),
        )
        .take(window.maxVotesPerParticipant + 1),
      ctx.db
        .query("synesthesiaReports")
        .withIndex("by_window_reporter", (index) =>
          index
            .eq("windowId", window._id)
            .eq("reporterMembershipId", context.membership._id),
        )
        .take(maximumRequestsPerWindow),
      ctx.db
        .query("songRequests")
        .withIndex("by_window_requester_created", (index) =>
          index
            .eq("windowId", window._id)
            .eq("requestedByMembershipId", context.membership._id),
        )
        .take(window.maxRequestsPerParticipant + 1),
    ]);
    const votedRequestIds = new Set(votes.map((vote) => vote.requestId));
    const reportedRequestIds = new Set(reports.map((report) => report.requestId));
    const canChangeVotes = window.votingOpen && !suspended;
    return {
      eligible: true,
      suspended,
      window: {
        id: window._id,
        name: window.name,
        kind: window.kind,
        ...(window.customKindLabel !== undefined
          ? { customKindLabel: window.customKindLabel }
          : {}),
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        requestsOpen: window.requestsOpen,
        votingOpen: window.votingOpen,
        playbackPaused: window.playbackPaused,
        catalogSourceLabel: window.catalogSourceLabel,
        maxRequestsPerParticipant: window.maxRequestsPerParticipant,
        maxVotesPerParticipant: window.maxVotesPerParticipant,
        version: window.version,
      },
      usage: { requests: ownRequests.length, votes: votes.length },
      requests: requests
        .filter((request) => isParticipantVisible(request, context.membership._id))
        .sort(compareSongRequests)
        .map((request) => ({
          id: request._id,
          title: request.title,
          artist: request.artist,
          ...(request.album !== undefined ? { album: request.album } : {}),
          durationSeconds: request.durationSeconds,
          isExplicit: request.isExplicit,
          energyTag: request.energyTag,
          state: request.state,
          voteCount: request.voteCount,
          ...(request.publicReason !== undefined
            ? { publicReason: request.publicReason }
            : {}),
          ...(request.scheduledFor !== undefined
            ? { scheduledFor: request.scheduledFor }
            : {}),
          isMine: request.requestedByMembershipId === context.membership._id,
          hasVoted: votedRequestIds.has(request._id),
          hasReported: reportedRequestIds.has(request._id),
          canVote: canChangeVotes && requestAllowsVote(request.state),
          canReport:
            !suspended && request.state !== "hidden" && request.state !== "rejected",
          version: request.version,
          createdAt: request.createdAt,
        })),
    };
  },
});

export const searchCatalog = query({
  args: { eventSlug: v.string(), query: v.string() },
  returns: v.array(catalogTrack),
  handler: async (ctx, args) => {
    const context = await synesthesiaParticipantContext(ctx, args.eventSlug);
    if (!context.eligible || context.accessState?.state === "suspended") return [];
    const window = await activeSynesthesiaWindow(ctx, context.event._id, Date.now());
    if (!window || !window.requestsOpen) return [];
    const search = args.query.trim().replace(/\s+/g, " ");
    if (search.length > 80 || search.split(" ").filter(Boolean).length > 16) {
      throw new ConvexError({
        code: "INVALID_SEARCH",
        message: "Use at most 16 short search terms.",
      });
    }
    const candidates = search
      ? await ctx.db
          .query("synesthesiaCatalogTracks")
          .withSearchIndex("search_event_catalog", (index) =>
            index
              .search("searchText", search)
              .eq("eventId", context.event._id)
              .eq("status", "active"),
          )
          .take(60)
      : await ctx.db
          .query("synesthesiaCatalogTracks")
          .withIndex("by_event_status_title", (index) =>
            index.eq("eventId", context.event._id).eq("status", "active"),
          )
          .take(maximumCatalogSearchResults);
    return candidates
      .filter((track) => trackFitsWindow(track, window))
      .slice(0, maximumCatalogSearchResults)
      .map((track) => ({
        id: track._id,
        provider: track.provider,
        providerTrackId: track.providerTrackId,
        title: track.title,
        artist: track.artist,
        ...(track.album !== undefined ? { album: track.album } : {}),
        durationSeconds: track.durationSeconds,
        isExplicit: track.isExplicit,
        energyTag: track.energyTag,
      }));
  },
});

export const requestTrack = mutation({
  args: {
    eventSlug: v.string(),
    windowId: v.id("synesthesiaWindows"),
    trackId: v.id("synesthesiaCatalogTracks"),
    note: v.optional(v.string()),
    clientOperationId: v.string(),
  },
  returns: v.object({ requestId: v.id("songRequests"), created: v.boolean() }),
  handler: async (ctx, args) => {
    const context = await requireSynesthesiaParticipant(ctx, args.eventSlug);
    const note = optionalNormalizedText(args.note, "Request note", 160);
    const requestFingerprint = operationFingerprint([
      args.windowId,
      args.trackId,
      note ?? null,
    ]);
    const prior = await findOperation(ctx, {
      eventId: context.event._id,
      actorPersonId: context.person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.request_track",
      requestFingerprint,
    });
    if (prior) {
      const requestId = ctx.db.normalizeId("songRequests", prior.targetId);
      const request = requestId ? await ctx.db.get("songRequests", requestId) : null;
      if (!request || request.eventId !== context.event._id) {
        throw new Error("The prior song request no longer resolves.");
      }
      return { requestId: request._id, created: prior.resultJson === "created" };
    }
    const window = await participantWindowForWrite(
      ctx,
      context.event._id,
      args.windowId,
    );
    if (!window.requestsOpen) {
      throw new ConvexError({
        code: "REQUESTS_CLOSED",
        message: "New requests are closed for this window.",
      });
    }
    const track = await ctx.db.get("synesthesiaCatalogTracks", args.trackId);
    if (!track || track.eventId !== context.event._id || !trackFitsWindow(track, window)) {
      throw new ConvexError({
        code: "TRACK_NOT_ALLOWED",
        message: "That track is not allowed in the current ambience window.",
      });
    }
    const existing = await ctx.db
      .query("songRequests")
      .withIndex("by_window_track", (index) =>
        index.eq("windowId", window._id).eq("catalogTrackId", track._id),
      )
      .unique();
    const now = Date.now();
    if (existing) {
      if (existing.state === "hidden" || existing.state === "rejected") {
        throw new ConvexError({
          code: "TRACK_UNAVAILABLE",
          message: "That track cannot be requested again in this window.",
        });
      }
      await recordOperation(ctx, {
        eventId: context.event._id,
        actorPersonId: context.person._id,
        clientOperationId: args.clientOperationId,
        commandName: "synesthesia.request_track",
        requestFingerprint,
        targetType: "song_request",
        targetId: existing._id,
        resultJson: "existing",
        createdAt: now,
      });
      return { requestId: existing._id, created: false };
    }
    const [totalRequests, ownRequests] = await Promise.all([
      ctx.db
        .query("songRequests")
        .withIndex("by_window_created", (index) => index.eq("windowId", window._id))
        .take(window.maxRequestsTotal),
      ctx.db
        .query("songRequests")
        .withIndex("by_window_requester_created", (index) =>
          index
            .eq("windowId", window._id)
            .eq("requestedByMembershipId", context.membership._id),
        )
        .take(window.maxRequestsPerParticipant),
    ]);
    if (totalRequests.length >= window.maxRequestsTotal) {
      throw new ConvexError({
        code: "WINDOW_REQUEST_LIMIT",
        message: "This request window has reached its published limit.",
      });
    }
    if (ownRequests.length >= window.maxRequestsPerParticipant) {
      throw new ConvexError({
        code: "PARTICIPANT_REQUEST_LIMIT",
        message: "You have used your request limit for this window.",
      });
    }
    const requestId = await ctx.db.insert("songRequests", {
      eventId: context.event._id,
      windowId: window._id,
      catalogTrackId: track._id,
      requestedByMembershipId: context.membership._id,
      requestedByPersonId: context.person._id,
      provider: track.provider,
      providerTrackId: track.providerTrackId,
      title: track.title,
      artist: track.artist,
      ...(track.album !== undefined ? { album: track.album } : {}),
      durationSeconds: track.durationSeconds,
      isExplicit: track.isExplicit,
      energyTag: track.energyTag,
      ...(note !== undefined ? { note } : {}),
      state: window.autoApproveRequests ? "approved" : "pending",
      voteCount: 0,
      openReportCount: 0,
      queueMode: "normal",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: context.event._id,
      actorPersonId: context.person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.request_track",
      requestFingerprint,
      targetType: "song_request",
      targetId: requestId,
      resultJson: "created",
      createdAt: now,
    });
    return { requestId, created: true };
  },
});

async function changeVote(
  ctx: MutationCtx,
  args: {
    eventSlug: string;
    requestId: Id<"songRequests">;
    active: boolean;
    clientOperationId: string;
  },
) {
  const context = await requireSynesthesiaParticipant(ctx, args.eventSlug);
  const requestFingerprint = operationFingerprint([args.requestId, args.active]);
  const commandName = args.active
    ? "synesthesia.vote"
    : "synesthesia.remove_vote";
  const prior = await findOperation(ctx, {
    eventId: context.event._id,
    actorPersonId: context.person._id,
    clientOperationId: args.clientOperationId,
    commandName,
    requestFingerprint,
  });
  const request = await ctx.db.get("songRequests", args.requestId);
  if (!request || request.eventId !== context.event._id) {
    throw new ConvexError({ code: "REQUEST_NOT_FOUND", message: "Song request not found." });
  }
  if (prior) return { requestId: request._id, voteCount: request.voteCount };
  const window = await participantWindowForWrite(ctx, context.event._id, request.windowId);
  if (!window.votingOpen || !requestAllowsVote(request.state)) {
    throw new ConvexError({
      code: "VOTING_CLOSED",
      message: "Voting is closed for that request.",
    });
  }
  const existing = await ctx.db
    .query("songVotes")
    .withIndex("by_request_member", (index) =>
      index.eq("requestId", request._id).eq("membershipId", context.membership._id),
    )
    .unique();
  const alreadyActive = existing?.state === "active";
  if (alreadyActive === args.active) {
    const now = Date.now();
    await recordOperation(ctx, {
      eventId: context.event._id,
      actorPersonId: context.person._id,
      clientOperationId: args.clientOperationId,
      commandName,
      requestFingerprint,
      targetType: existing ? "song_vote" : "song_request",
      targetId: existing?._id ?? request._id,
      resultJson: args.active ? "active" : "removed",
      createdAt: now,
    });
    return { requestId: request._id, voteCount: request.voteCount };
  }
  if (args.active) {
    const activeVotes = await ctx.db
      .query("songVotes")
      .withIndex("by_window_member_state", (index) =>
        index
          .eq("windowId", window._id)
          .eq("membershipId", context.membership._id)
          .eq("state", "active"),
      )
      .take(window.maxVotesPerParticipant);
    if (activeVotes.length >= window.maxVotesPerParticipant) {
      throw new ConvexError({
        code: "PARTICIPANT_VOTE_LIMIT",
        message: "You have used your vote limit for this window.",
      });
    }
  }
  const now = Date.now();
  let voteId: Id<"songVotes">;
  if (existing) {
    await ctx.db.patch("songVotes", existing._id, {
      state: args.active ? "active" : "removed",
      version: existing.version + 1,
      updatedAt: now,
    });
    voteId = existing._id;
  } else {
    if (!args.active) {
      await recordOperation(ctx, {
        eventId: context.event._id,
        actorPersonId: context.person._id,
        clientOperationId: args.clientOperationId,
        commandName,
        requestFingerprint,
        targetType: "song_request",
        targetId: request._id,
        resultJson: "removed",
        createdAt: now,
      });
      return { requestId: request._id, voteCount: request.voteCount };
    }
    voteId = await ctx.db.insert("songVotes", {
      eventId: context.event._id,
      windowId: window._id,
      requestId: request._id,
      membershipId: context.membership._id,
      personId: context.person._id,
      state: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }
  const voteCount = args.active
    ? request.voteCount + 1
    : Math.max(0, request.voteCount - 1);
  await ctx.db.patch("songRequests", request._id, {
    voteCount,
    version: request.version + 1,
    updatedAt: now,
  });
  await recordOperation(ctx, {
    eventId: context.event._id,
    actorPersonId: context.person._id,
    clientOperationId: args.clientOperationId,
    commandName,
    requestFingerprint,
    targetType: "song_vote",
    targetId: voteId,
    resultJson: args.active ? "active" : "removed",
    createdAt: now,
  });
  return { requestId: request._id, voteCount };
}

export const vote = mutation({
  args: {
    eventSlug: v.string(),
    requestId: v.id("songRequests"),
    clientOperationId: v.string(),
  },
  returns: v.object({ requestId: v.id("songRequests"), voteCount: v.number() }),
  handler: (ctx, args) => changeVote(ctx, { ...args, active: true }),
});

export const removeVote = mutation({
  args: {
    eventSlug: v.string(),
    requestId: v.id("songRequests"),
    clientOperationId: v.string(),
  },
  returns: v.object({ requestId: v.id("songRequests"), voteCount: v.number() }),
  handler: (ctx, args) => changeVote(ctx, { ...args, active: false }),
});

export const reportRequest = mutation({
  args: {
    eventSlug: v.string(),
    requestId: v.id("songRequests"),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ reportId: v.id("synesthesiaReports"), created: v.boolean() }),
  handler: async (ctx, args) => {
    const context = await requireSynesthesiaParticipant(ctx, args.eventSlug);
    const reason = args.reason.trim().replace(/\s+/g, " ");
    if (reason.length < 5 || reason.length > 300) {
      throw new ConvexError({
        code: "INVALID_REPORT",
        message: "Report reason must be between 5 and 300 characters.",
      });
    }
    const requestFingerprint = operationFingerprint([args.requestId, reason]);
    const prior = await findOperation(ctx, {
      eventId: context.event._id,
      actorPersonId: context.person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.report",
      requestFingerprint,
    });
    if (prior) {
      const reportId = ctx.db.normalizeId("synesthesiaReports", prior.targetId);
      const report = reportId
        ? await ctx.db.get("synesthesiaReports", reportId)
        : null;
      if (!report || report.eventId !== context.event._id) {
        throw new Error("The prior song report no longer resolves.");
      }
      return { reportId: report._id, created: prior.resultJson === "created" };
    }
    const request = await ctx.db.get("songRequests", args.requestId);
    if (
      !request ||
      request.eventId !== context.event._id ||
      request.state === "hidden" ||
      request.state === "rejected"
    ) {
      throw new ConvexError({
        code: "REQUEST_NOT_REPORTABLE",
        message: "That request is no longer available to report.",
      });
    }
    await participantWindowForWrite(ctx, context.event._id, request.windowId);
    const existing = await ctx.db
      .query("synesthesiaReports")
      .withIndex("by_request_reporter", (index) =>
        index
          .eq("requestId", request._id)
          .eq("reporterMembershipId", context.membership._id),
      )
      .unique();
    const now = Date.now();
    if (existing) {
      await recordOperation(ctx, {
        eventId: context.event._id,
        actorPersonId: context.person._id,
        clientOperationId: args.clientOperationId,
        commandName: "synesthesia.report",
        requestFingerprint,
        targetType: "synesthesia_report",
        targetId: existing._id,
        resultJson: "existing",
        createdAt: now,
      });
      return { reportId: existing._id, created: false };
    }
    const reportId = await ctx.db.insert("synesthesiaReports", {
      eventId: context.event._id,
      windowId: request.windowId,
      requestId: request._id,
      reporterMembershipId: context.membership._id,
      reporterPersonId: context.person._id,
      reason,
      state: "open",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch("songRequests", request._id, {
      openReportCount: request.openReportCount + 1,
      version: request.version + 1,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: context.event._id,
      actorPersonId: context.person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.report",
      requestFingerprint,
      targetType: "synesthesia_report",
      targetId: reportId,
      resultJson: "created",
      createdAt: now,
    });
    return { reportId, created: true };
  },
});
