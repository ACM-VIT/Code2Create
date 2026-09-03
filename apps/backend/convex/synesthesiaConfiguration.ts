import { ConvexError, v } from "convex/values";

import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import {
  activeGrantScopes,
  catalogTrackFields,
  maximumSynesthesiaWindows,
  normalizedProvider,
  scopeAllows,
  synesthesiaWindowFields,
} from "./lib/synesthesia";
import { synesthesiaWindowKind, synesthesiaWindowStatus } from "./values";
import { appendSynesthesiaWindowReadFactById } from "./lib/operationsAutonomyReadFacts/synesthesiaOperations";

const maximumCatalogTracks = 500;
type ReadCtx = QueryCtx | MutationCtx;

const windowFields = {
  name: v.string(),
  kind: synesthesiaWindowKind,
  customKindLabel: v.optional(v.string()),
  startsAt: v.number(),
  endsAt: v.number(),
  requestsOpen: v.boolean(),
  votingOpen: v.boolean(),
  catalogSourceLabel: v.string(),
  autoApproveRequests: v.boolean(),
  maxRequestsPerParticipant: v.number(),
  maxVotesPerParticipant: v.number(),
  maxRequestsTotal: v.number(),
  maxTrackDurationSeconds: v.number(),
  allowExplicit: v.boolean(),
  allowedEnergyTags: v.array(v.string()),
};

const windowView = v.object({
  id: v.id("synesthesiaWindows"),
  name: v.string(),
  kind: synesthesiaWindowKind,
  customKindLabel: v.optional(v.string()),
  startsAt: v.number(),
  endsAt: v.number(),
  status: synesthesiaWindowStatus,
  requestsOpen: v.boolean(),
  votingOpen: v.boolean(),
  playbackPaused: v.boolean(),
  playbackPauseReason: v.optional(v.string()),
  catalogSourceLabel: v.string(),
  autoApproveRequests: v.boolean(),
  maxRequestsPerParticipant: v.number(),
  maxVotesPerParticipant: v.number(),
  maxRequestsTotal: v.number(),
  maxTrackDurationSeconds: v.number(),
  allowExplicit: v.boolean(),
  allowedEnergyTags: v.array(v.string()),
  version: v.number(),
  canManage: v.boolean(),
  canPublish: v.boolean(),
  canReadQueue: v.boolean(),
  canPausePlayback: v.boolean(),
});

const catalogTrackView = v.object({
  id: v.id("synesthesiaCatalogTracks"),
  provider: v.string(),
  providerTrackId: v.string(),
  title: v.string(),
  artist: v.string(),
  album: v.optional(v.string()),
  durationSeconds: v.number(),
  isExplicit: v.boolean(),
  energyTag: v.string(),
  status: v.union(v.literal("active"), v.literal("disabled")),
  version: v.number(),
});

async function staffContext(ctx: ReadCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  return { event, person, subject };
}

export const overview = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    eventName: v.string(),
    serverNow: v.number(),
    canReadCatalog: v.boolean(),
    canManageCatalog: v.boolean(),
    canCreateWindow: v.boolean(),
    windows: v.array(windowView),
  }),
  handler: async (ctx, args) => {
    const { event, subject } = await staffContext(ctx, args.eventSlug);
    const [
      catalogRead,
      catalogManage,
      windowRead,
      windowManage,
      windowPublish,
      queueRead,
      playbackPause,
      windows,
    ] = await Promise.all([
      activeGrantScopes(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "synesthesia.catalog.read",
        maximumScopeCount: maximumSynesthesiaWindows,
      }),
      activeGrantScopes(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "synesthesia.catalog.manage",
        maximumScopeCount: maximumSynesthesiaWindows,
      }),
      activeGrantScopes(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "synesthesia.window.read",
        maximumScopeCount: maximumSynesthesiaWindows,
      }),
      activeGrantScopes(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "synesthesia.window.manage",
        maximumScopeCount: maximumSynesthesiaWindows,
      }),
      activeGrantScopes(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "synesthesia.window.publish",
        maximumScopeCount: maximumSynesthesiaWindows,
      }),
      activeGrantScopes(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "synesthesia.queue.read",
        maximumScopeCount: maximumSynesthesiaWindows,
      }),
      activeGrantScopes(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "synesthesia.playback.pause",
        maximumScopeCount: maximumSynesthesiaWindows,
      }),
      ctx.db
        .query("synesthesiaWindows")
        .withIndex("by_event_start", (index) => index.eq("eventId", event._id))
        .order("desc")
        .take(maximumSynesthesiaWindows),
    ]);
    return {
      eventName: event.name,
      serverNow: Date.now(),
      canReadCatalog: catalogRead.eventWide,
      canManageCatalog: catalogManage.eventWide,
      canCreateWindow: windowManage.eventWide,
      windows: windows
        .filter(
          (window) => scopeAllows(windowRead, window._id) || scopeAllows(queueRead, window._id),
        )
        .map((window) => ({
          id: window._id,
          name: window.name,
          kind: window.kind,
          ...(window.customKindLabel !== undefined
            ? { customKindLabel: window.customKindLabel }
            : {}),
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          status: window.status,
          requestsOpen: window.requestsOpen,
          votingOpen: window.votingOpen,
          playbackPaused: window.playbackPaused,
          ...(window.playbackPauseReason !== undefined
            ? { playbackPauseReason: window.playbackPauseReason }
            : {}),
          catalogSourceLabel: window.catalogSourceLabel,
          autoApproveRequests: window.autoApproveRequests,
          maxRequestsPerParticipant: window.maxRequestsPerParticipant,
          maxVotesPerParticipant: window.maxVotesPerParticipant,
          maxRequestsTotal: window.maxRequestsTotal,
          maxTrackDurationSeconds: window.maxTrackDurationSeconds,
          allowExplicit: window.allowExplicit,
          allowedEnergyTags: window.allowedEnergyTags,
          version: window.version,
          canManage: scopeAllows(windowManage, window._id),
          canPublish: scopeAllows(windowPublish, window._id),
          canReadQueue: scopeAllows(queueRead, window._id),
          canPausePlayback: scopeAllows(playbackPause, window._id),
        })),
    };
  },
});

export const catalog = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    tracks: v.array(catalogTrackView),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { event, subject } = await staffContext(ctx, args.eventSlug);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "synesthesia.catalog.read",
      scopeType: "event",
    });
    const [active, disabled] = await Promise.all([
      ctx.db
        .query("synesthesiaCatalogTracks")
        .withIndex("by_event_status_title", (index) =>
          index.eq("eventId", event._id).eq("status", "active"),
        )
        .take(maximumCatalogTracks + 1),
      ctx.db
        .query("synesthesiaCatalogTracks")
        .withIndex("by_event_status_title", (index) =>
          index.eq("eventId", event._id).eq("status", "disabled"),
        )
        .take(maximumCatalogTracks + 1),
    ]);
    const tracks = [...active, ...disabled]
      .sort((left, right) => left.title.localeCompare(right.title))
      .slice(0, maximumCatalogTracks);
    return {
      tracks: tracks.map((track) => ({
        id: track._id,
        provider: track.provider,
        providerTrackId: track.providerTrackId,
        title: track.title,
        artist: track.artist,
        ...(track.album !== undefined ? { album: track.album } : {}),
        durationSeconds: track.durationSeconds,
        isExplicit: track.isExplicit,
        energyTag: track.energyTag,
        status: track.status,
        version: track.version,
      })),
      truncated: active.length + disabled.length > maximumCatalogTracks,
    };
  },
});

export const addCatalogTrack = mutation({
  args: {
    eventSlug: v.string(),
    provider: v.string(),
    providerTrackId: v.string(),
    title: v.string(),
    artist: v.string(),
    album: v.optional(v.string()),
    durationSeconds: v.number(),
    isExplicit: v.boolean(),
    energyTag: v.string(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ trackId: v.id("synesthesiaCatalogTracks"), version: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject } = await staffContext(ctx, args.eventSlug);
    const provider = normalizedProvider(args.provider);
    const providerTrackId = normalizedText(args.providerTrackId, "Provider track ID", 1, 180);
    const fields = catalogTrackFields(args);
    const reason = normalizedText(args.reason, "Reason", 5, 200);
    const requestFingerprint = operationFingerprint([
      provider,
      providerTrackId,
      JSON.stringify(fields),
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.catalog.add",
      requestFingerprint,
    });
    if (prior) {
      const trackId = ctx.db.normalizeId("synesthesiaCatalogTracks", prior.targetId);
      if (!trackId) throw new Error("The stored catalog-track result is invalid.");
      return {
        trackId,
        version: storedOperationVersion(prior.resultJson, "catalog-track"),
      };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "synesthesia.catalog.manage",
      scopeType: "event",
    });
    const existing = await ctx.db
      .query("synesthesiaCatalogTracks")
      .withIndex("by_event_provider_track", (index) =>
        index
          .eq("eventId", event._id)
          .eq("provider", provider)
          .eq("providerTrackId", providerTrackId),
      )
      .unique();
    if (existing) {
      throw new ConvexError({
        code: "CATALOG_TRACK_EXISTS",
        message: "That provider track is already in the event catalog.",
      });
    }
    const [active, disabled] = await Promise.all([
      ctx.db
        .query("synesthesiaCatalogTracks")
        .withIndex("by_event_status_title", (index) =>
          index.eq("eventId", event._id).eq("status", "active"),
        )
        .take(maximumCatalogTracks),
      ctx.db
        .query("synesthesiaCatalogTracks")
        .withIndex("by_event_status_title", (index) =>
          index.eq("eventId", event._id).eq("status", "disabled"),
        )
        .take(maximumCatalogTracks),
    ]);
    if (active.length + disabled.length >= maximumCatalogTracks) {
      throw new ConvexError({
        code: "CATALOG_LIMIT",
        message: "The event catalog has reached its 500-track release bound.",
      });
    }
    const now = Date.now();
    const trackId = await ctx.db.insert("synesthesiaCatalogTracks", {
      eventId: event._id,
      provider,
      providerTrackId,
      ...fields,
      status: "active",
      version: 1,
      createdByPersonId: person._id,
      updatedByPersonId: person._id,
      createdAt: now,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.catalog.add",
      requestFingerprint,
      targetType: "synesthesia_catalog_track",
      targetId: trackId,
      resultJson: "1",
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "synesthesia.catalog.manage",
      grantIds,
      scopeType: "event",
      action: "synesthesia.catalog_track_added",
      targetType: "synesthesia_catalog_track",
      targetId: trackId,
      nextSummary: JSON.stringify({ provider, providerTrackId, ...fields }),
      reason,
    });
    return { trackId, version: 1 };
  },
});

export const updateCatalogTrack = mutation({
  args: {
    eventSlug: v.string(),
    trackId: v.id("synesthesiaCatalogTracks"),
    title: v.string(),
    artist: v.string(),
    album: v.optional(v.string()),
    durationSeconds: v.number(),
    isExplicit: v.boolean(),
    energyTag: v.string(),
    status: v.union(v.literal("active"), v.literal("disabled")),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ trackId: v.id("synesthesiaCatalogTracks"), version: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject } = await staffContext(ctx, args.eventSlug);
    const fields = catalogTrackFields(args);
    const reason = normalizedText(args.reason, "Reason", 5, 200);
    const requestFingerprint = operationFingerprint([
      args.trackId,
      args.expectedVersion,
      JSON.stringify(fields),
      args.status,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.catalog.update",
      requestFingerprint,
    });
    const track = await ctx.db.get("synesthesiaCatalogTracks", args.trackId);
    if (!track || track.eventId !== event._id) {
      throw new ConvexError({ code: "TRACK_NOT_FOUND", message: "Catalog track not found." });
    }
    if (prior) {
      return {
        trackId: track._id,
        version: storedOperationVersion(prior.resultJson, "catalog-track"),
      };
    }
    if (track.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "CATALOG_TRACK_CHANGED",
        message: "The catalog track changed. Review it and try again.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "synesthesia.catalog.manage",
      scopeType: "event",
    });
    const now = Date.now();
    const version = track.version + 1;
    await ctx.db.patch("synesthesiaCatalogTracks", track._id, {
      ...fields,
      status: args.status,
      version,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.catalog.update",
      requestFingerprint,
      targetType: "synesthesia_catalog_track",
      targetId: track._id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "synesthesia.catalog.manage",
      grantIds,
      scopeType: "event",
      action: "synesthesia.catalog_track_updated",
      targetType: "synesthesia_catalog_track",
      targetId: track._id,
      previousSummary: JSON.stringify({
        title: track.title,
        artist: track.artist,
        durationSeconds: track.durationSeconds,
        isExplicit: track.isExplicit,
        energyTag: track.energyTag,
        status: track.status,
        version: track.version,
      }),
      nextSummary: JSON.stringify({ ...fields, status: args.status, version }),
      reason,
    });
    return { trackId: track._id, version };
  },
});

export const createWindow = mutation({
  args: {
    eventSlug: v.string(),
    ...windowFields,
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ windowId: v.id("synesthesiaWindows"), version: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject } = await staffContext(ctx, args.eventSlug);
    const fields = synesthesiaWindowFields(args);
    const reason = normalizedText(args.reason, "Reason", 5, 200);
    const requestFingerprint = operationFingerprint([JSON.stringify(fields), reason]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.window.create",
      requestFingerprint,
    });
    if (prior) {
      const windowId = ctx.db.normalizeId("synesthesiaWindows", prior.targetId);
      if (!windowId) throw new Error("The stored Synesthesia-window result is invalid.");
      return {
        windowId,
        version: storedOperationVersion(prior.resultJson, "Synesthesia-window"),
      };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "synesthesia.window.manage",
      scopeType: "event",
    });
    const windows = await ctx.db
      .query("synesthesiaWindows")
      .withIndex("by_event_start", (index) => index.eq("eventId", event._id))
      .take(maximumSynesthesiaWindows);
    if (windows.length >= maximumSynesthesiaWindows) {
      throw new ConvexError({
        code: "WINDOW_LIMIT",
        message: "The event has reached its 64-window release bound.",
      });
    }
    const now = Date.now();
    const windowId = await ctx.db.insert("synesthesiaWindows", {
      eventId: event._id,
      ...fields,
      status: "draft",
      playbackPaused: false,
      version: 1,
      createdByPersonId: person._id,
      updatedByPersonId: person._id,
      createdAt: now,
      updatedAt: now,
    });
    await appendSynesthesiaWindowReadFactById(ctx, windowId, now);
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.window.create",
      requestFingerprint,
      targetType: "synesthesia_window",
      targetId: windowId,
      resultJson: "1",
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "synesthesia.window.manage",
      grantIds,
      scopeType: "event",
      action: "synesthesia.window_created",
      targetType: "synesthesia_window",
      targetId: windowId,
      nextSummary: JSON.stringify({ ...fields, status: "draft", version: 1 }),
      reason,
    });
    return { windowId, version: 1 };
  },
});

export const updateWindow = mutation({
  args: {
    eventSlug: v.string(),
    windowId: v.id("synesthesiaWindows"),
    ...windowFields,
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ windowId: v.id("synesthesiaWindows"), version: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject } = await staffContext(ctx, args.eventSlug);
    const fields = synesthesiaWindowFields(args);
    const reason = normalizedText(args.reason, "Reason", 5, 200);
    const requestFingerprint = operationFingerprint([
      args.windowId,
      args.expectedVersion,
      JSON.stringify(fields),
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.window.update",
      requestFingerprint,
    });
    const window = await ctx.db.get("synesthesiaWindows", args.windowId);
    if (!window || window.eventId !== event._id) {
      throw new ConvexError({ code: "WINDOW_NOT_FOUND", message: "Window not found." });
    }
    if (prior) {
      return {
        windowId: window._id,
        version: storedOperationVersion(prior.resultJson, "Synesthesia-window"),
      };
    }
    if (window.status !== "draft") {
      throw new ConvexError({
        code: "WINDOW_IMMUTABLE",
        message: "Published windows are immutable. Close it and publish a new window.",
      });
    }
    if (window.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "WINDOW_CHANGED",
        message: "The window changed. Review it and try again.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "synesthesia.window.manage",
      scopeType: "synesthesia_window",
      scopeId: window._id,
    });
    const now = Date.now();
    const version = window.version + 1;
    await ctx.db.patch("synesthesiaWindows", window._id, {
      ...fields,
      customKindLabel: fields.customKindLabel,
      version,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    await appendSynesthesiaWindowReadFactById(ctx, window._id, Date.now());
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.window.update",
      requestFingerprint,
      targetType: "synesthesia_window",
      targetId: window._id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "synesthesia.window.manage",
      grantIds,
      scopeType: "synesthesia_window",
      scopeId: window._id,
      action: "synesthesia.window_updated",
      targetType: "synesthesia_window",
      targetId: window._id,
      previousSummary: JSON.stringify({
        name: window.name,
        kind: window.kind,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        version: window.version,
      }),
      nextSummary: JSON.stringify({ ...fields, version }),
      reason,
    });
    return { windowId: window._id, version };
  },
});

export const publishWindow = mutation({
  args: {
    eventSlug: v.string(),
    windowId: v.id("synesthesiaWindows"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ windowId: v.id("synesthesiaWindows"), version: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject } = await staffContext(ctx, args.eventSlug);
    const reason = normalizedText(args.reason, "Publication reason", 5, 200);
    const requestFingerprint = operationFingerprint([args.windowId, args.expectedVersion, reason]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.window.publish",
      requestFingerprint,
    });
    const window = await ctx.db.get("synesthesiaWindows", args.windowId);
    if (!window || window.eventId !== event._id) {
      throw new ConvexError({ code: "WINDOW_NOT_FOUND", message: "Window not found." });
    }
    if (prior) {
      return {
        windowId: window._id,
        version: storedOperationVersion(prior.resultJson, "Synesthesia-window"),
      };
    }
    if (window.status !== "draft" || window.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "WINDOW_CHANGED",
        message: "Only the current draft can be published.",
      });
    }
    if (window.endsAt <= Date.now()) {
      throw new ConvexError({
        code: "WINDOW_ENDED",
        message: "A window that has already ended cannot be published.",
      });
    }
    if (
      (event.startsAt !== undefined && window.startsAt < event.startsAt) ||
      (event.endsAt !== undefined && window.endsAt > event.endsAt)
    ) {
      throw new ConvexError({
        code: "WINDOW_OUTSIDE_EVENT",
        message: "The ambience window must stay inside the published event schedule.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "synesthesia.window.publish",
      scopeType: "synesthesia_window",
      scopeId: window._id,
    });
    const overlappingCandidates = await ctx.db
      .query("synesthesiaWindows")
      .withIndex("by_event_status_start", (index) =>
        index.eq("eventId", event._id).eq("status", "published").lt("startsAt", window.endsAt),
      )
      .take(maximumSynesthesiaWindows);
    if (
      overlappingCandidates.some(
        (candidate) => candidate._id !== window._id && candidate.endsAt > window.startsAt,
      )
    ) {
      throw new ConvexError({
        code: "WINDOW_OVERLAP",
        message: "Published Synesthesia windows cannot overlap.",
      });
    }
    const now = Date.now();
    const version = window.version + 1;
    await ctx.db.patch("synesthesiaWindows", window._id, {
      status: "published",
      version,
      publishedByPersonId: person._id,
      publishedAt: now,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    await appendSynesthesiaWindowReadFactById(ctx, window._id, Date.now());
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.window.publish",
      requestFingerprint,
      targetType: "synesthesia_window",
      targetId: window._id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "synesthesia.window.publish",
      grantIds,
      scopeType: "synesthesia_window",
      scopeId: window._id,
      action: "synesthesia.window_published",
      targetType: "synesthesia_window",
      targetId: window._id,
      previousSummary: JSON.stringify({ status: window.status, version: window.version }),
      nextSummary: JSON.stringify({ status: "published", version }),
      reason,
    });
    return { windowId: window._id, version };
  },
});

export const closeWindow = mutation({
  args: {
    eventSlug: v.string(),
    windowId: v.id("synesthesiaWindows"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ windowId: v.id("synesthesiaWindows"), version: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject } = await staffContext(ctx, args.eventSlug);
    const reason = normalizedText(args.reason, "Close reason", 5, 200);
    const requestFingerprint = operationFingerprint([args.windowId, args.expectedVersion, reason]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.window.close",
      requestFingerprint,
    });
    const window = await ctx.db.get("synesthesiaWindows", args.windowId);
    if (!window || window.eventId !== event._id) {
      throw new ConvexError({ code: "WINDOW_NOT_FOUND", message: "Window not found." });
    }
    if (prior) {
      return {
        windowId: window._id,
        version: storedOperationVersion(prior.resultJson, "Synesthesia-window"),
      };
    }
    if (window.status !== "published" || window.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "WINDOW_CHANGED",
        message: "Only the current published window can be closed.",
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
        code: "PLAYBACK_ACTIVE",
        message: "Finish or skip the playing item before closing the window.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "synesthesia.window.manage",
      scopeType: "synesthesia_window",
      scopeId: window._id,
    });
    const now = Date.now();
    const version = window.version + 1;
    await ctx.db.patch("synesthesiaWindows", window._id, {
      status: "closed",
      requestsOpen: false,
      votingOpen: false,
      playbackPaused: false,
      playbackPauseReason: undefined,
      version,
      closedByPersonId: person._id,
      closedAt: now,
      closeReason: reason,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    await appendSynesthesiaWindowReadFactById(ctx, window._id, Date.now());
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.window.close",
      requestFingerprint,
      targetType: "synesthesia_window",
      targetId: window._id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "synesthesia.window.manage",
      grantIds,
      scopeType: "synesthesia_window",
      scopeId: window._id,
      action: "synesthesia.window_closed",
      targetType: "synesthesia_window",
      targetId: window._id,
      previousSummary: JSON.stringify({ status: window.status, version: window.version }),
      nextSummary: JSON.stringify({ status: "closed", version }),
      reason,
    });
    return { windowId: window._id, version };
  },
});

export const setPlaybackPause = mutation({
  args: {
    eventSlug: v.string(),
    windowId: v.id("synesthesiaWindows"),
    paused: v.boolean(),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ windowId: v.id("synesthesiaWindows"), version: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject } = await staffContext(ctx, args.eventSlug);
    const reason = normalizedText(args.reason, "Playback reason", 5, 200);
    const requestFingerprint = operationFingerprint([
      args.windowId,
      args.paused,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.playback.pause",
      requestFingerprint,
    });
    const window = await ctx.db.get("synesthesiaWindows", args.windowId);
    if (!window || window.eventId !== event._id) {
      throw new ConvexError({ code: "WINDOW_NOT_FOUND", message: "Window not found." });
    }
    if (prior) {
      return {
        windowId: window._id,
        version: storedOperationVersion(prior.resultJson, "Synesthesia-window"),
      };
    }
    if (window.status !== "published" || window.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "WINDOW_CHANGED",
        message: "The published window changed. Review it and try again.",
      });
    }
    if (window.playbackPaused === args.paused) {
      throw new ConvexError({
        code: "PLAYBACK_STATE_UNCHANGED",
        message: args.paused ? "Playback is already paused." : "Playback is already open.",
      });
    }
    if (args.paused) {
      const playing = await ctx.db
        .query("songRequests")
        .withIndex("by_window_state_created", (index) =>
          index.eq("windowId", window._id).eq("state", "playing"),
        )
        .first();
      if (playing) {
        throw new ConvexError({
          code: "PLAYBACK_ACTIVE",
          message: "Finish or skip the playing item before pausing playback.",
        });
      }
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "synesthesia.playback.pause",
      scopeType: "synesthesia_window",
      scopeId: window._id,
    });
    const now = Date.now();
    const version = window.version + 1;
    await ctx.db.patch("synesthesiaWindows", window._id, {
      playbackPaused: args.paused,
      playbackPauseReason: args.paused ? reason : undefined,
      version,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    await appendSynesthesiaWindowReadFactById(ctx, window._id, Date.now());
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "synesthesia.playback.pause",
      requestFingerprint,
      targetType: "synesthesia_window",
      targetId: window._id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "synesthesia.playback.pause",
      grantIds,
      scopeType: "synesthesia_window",
      scopeId: window._id,
      action: args.paused ? "synesthesia.playback_paused" : "synesthesia.playback_resumed",
      targetType: "synesthesia_window",
      targetId: window._id,
      previousSummary: JSON.stringify({
        playbackPaused: window.playbackPaused,
        version: window.version,
      }),
      nextSummary: JSON.stringify({ playbackPaused: args.paused, version }),
      reason,
    });
    return { windowId: window._id, version };
  },
});
