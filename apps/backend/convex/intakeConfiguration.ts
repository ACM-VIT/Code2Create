import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
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
import { normalizedText } from "./lib/strings";
import {
  loadTrackCatalogTracks,
  publishTrackCatalog,
  saveTrackCatalogDraft,
  trackCatalogChecksum,
  trackCatalogIssues,
  trackCatalogTrackInput,
  type TrackCatalogTrack,
} from "./lib/trackCatalog";

const catalogTrackView = v.object({
  id: v.id("trackVersions"),
  stableKey: v.string(),
  slug: v.string(),
  displayName: v.string(),
  description: v.string(),
  examples: v.array(v.string()),
  displayOrder: v.number(),
  type: v.union(v.literal("core"), v.literal("sponsor")),
  eligibilityText: v.optional(v.string()),
});

const catalogView = v.object({
  id: v.id("trackCatalogVersions"),
  version: v.number(),
  status: v.union(
    v.literal("draft"),
    v.literal("published"),
    v.literal("superseded"),
    v.literal("retired"),
  ),
  checksum: v.string(),
  createdAt: v.number(),
  publishedAt: v.optional(v.number()),
  activeDraftCount: v.number(),
  tracks: v.array(catalogTrackView),
});

function trackInput(track: Doc<"trackVersions">): TrackCatalogTrack {
  return {
    stableKey: track.stableKey,
    slug: track.slug,
    displayName: track.displayName,
    description: track.description,
    examples: track.examples,
    displayOrder: track.displayOrder,
    type: track.type,
    ...(track.eligibilityText !== undefined
      ? { eligibilityText: track.eligibilityText }
      : {}),
  };
}

async function activeDraftCount(ctx: QueryCtx, catalog: Doc<"trackCatalogVersions">) {
  const drafts = await ctx.db
    .query("projectDrafts")
    .withIndex("by_event_catalog", (index) =>
      index
        .eq("eventId", catalog.eventId)
        .eq("trackCatalogVersionId", catalog._id),
    )
    .collect();
  return drafts.filter((draft) => draft.stage !== "submitted").length;
}

async function readCatalog(ctx: QueryCtx, catalog: Doc<"trackCatalogVersions">) {
  const tracks = await loadTrackCatalogTracks(ctx, catalog._id);
  if (tracks.some((track) => track.eventId !== catalog.eventId)) {
    throw new Error("A track catalog contains a foreign row.");
  }
  return {
    id: catalog._id,
    version: catalog.version,
    status: catalog.status,
    checksum: catalog.checksum,
    createdAt: catalog.createdAt,
    ...(catalog.publishedAt !== undefined ? { publishedAt: catalog.publishedAt } : {}),
    activeDraftCount: await activeDraftCount(ctx, catalog),
    tracks: tracks.map((track) => ({
      id: track._id,
      ...trackInput(track),
    })),
  };
}

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    eventVersion: v.number(),
    publishedCatalog: catalogView,
    draftCatalog: v.union(v.null(), catalogView),
    canDraft: v.boolean(),
    canValidate: v.boolean(),
    canPublish: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.read",
      scopeType: "event",
    });
    const publishedCatalogId = event.publishedTrackCatalogId;
    const publishedCatalog = publishedCatalogId
      ? await ctx.db.get(publishedCatalogId)
      : null;
    if (
      !publishedCatalog ||
      publishedCatalog.eventId !== event._id ||
      publishedCatalog.status !== "published"
    ) {
      throw new Error("The event's published track catalog is invalid.");
    }
    const draftCatalog = await ctx.db
      .query("trackCatalogVersions")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", event._id).eq("status", "draft"),
      )
      .unique();
    const [draftGrantIds, validateGrantIds, publishGrantIds] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.draft.create",
        scopeType: "event",
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.validate",
        scopeType: "event",
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.publish",
        scopeType: "event",
      }),
    ]);
    return {
      eventVersion: event.version,
      publishedCatalog: await readCatalog(ctx, publishedCatalog),
      draftCatalog: draftCatalog ? await readCatalog(ctx, draftCatalog) : null,
      canDraft: draftGrantIds.length > 0,
      canValidate: validateGrantIds.length > 0,
      canPublish: publishGrantIds.length > 0,
    };
  },
});

export const validateDraft = query({
  args: {
    eventSlug: v.string(),
    draftCatalogId: v.id("trackCatalogVersions"),
  },
  returns: v.object({
    valid: v.boolean(),
    issues: v.array(v.string()),
    changes: v.array(v.string()),
    pinnedParticipantDraftCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.validate",
      scopeType: "event",
    });
    const draft = await ctx.db.get(args.draftCatalogId);
    if (!draft || draft.eventId !== event._id || draft.status !== "draft") {
      throw new ConvexError({
        code: "TRACK_DRAFT_CHANGED",
        message: "That track draft is no longer current.",
      });
    }
    const publishedId = event.publishedTrackCatalogId;
    const published = publishedId ? await ctx.db.get(publishedId) : null;
    if (!published || published.eventId !== event._id || published.status !== "published") {
      throw new Error("The event's published track catalog is invalid.");
    }
    const [draftRows, publishedRows] = await Promise.all([
      loadTrackCatalogTracks(ctx, draft._id),
      loadTrackCatalogTracks(ctx, published._id),
    ]);
    const draftTracks = draftRows.map(trackInput);
    const issues = trackCatalogIssues(draftTracks);
    if (trackCatalogChecksum(draftTracks) !== draft.checksum) {
      issues.push("The draft checksum does not match its track rows.");
    }
    return {
      valid: issues.length === 0,
      issues,
      changes: describeChanges(publishedRows.map(trackInput), draftTracks),
      pinnedParticipantDraftCount: await activeDraftCount(ctx, published),
    };
  },
});

function describeChanges(
  published: readonly TrackCatalogTrack[],
  draft: readonly TrackCatalogTrack[],
) {
  const changes: string[] = [];
  const publishedByKey = new Map(published.map((track) => [track.stableKey, track]));
  const draftByKey = new Map(draft.map((track) => [track.stableKey, track]));
  for (const track of draft) {
    const prior = publishedByKey.get(track.stableKey);
    if (!prior) changes.push(`Add ${track.displayName}.`);
    else if (JSON.stringify(prior) !== JSON.stringify(track)) {
      changes.push(`Update ${track.displayName}.`);
    }
  }
  for (const track of published) {
    if (!draftByKey.has(track.stableKey)) changes.push(`Remove ${track.displayName} from new intakes.`);
  }
  return changes.length > 0 ? changes : ["No participant-visible track changes."];
}

export const createDraft = mutation({
  args: {
    eventSlug: v.string(),
    tracks: v.array(trackCatalogTrackInput),
    expectedEventVersion: v.number(),
    expectedDraftCatalogId: v.optional(v.id("trackCatalogVersions")),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    catalogVersionId: v.id("trackCatalogVersions"),
    catalogVersion: v.number(),
    checksum: v.string(),
    changed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.expectedEventVersion,
      args.expectedDraftCatalogId ?? null,
      JSON.stringify(args.tracks),
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.track_catalog.draft",
      requestFingerprint,
    });
    if (prior) {
      const catalogVersionId = ctx.db.normalizeId("trackCatalogVersions", prior.targetId);
      if (!catalogVersionId) throw new Error("The prior track-draft result is invalid.");
      const catalog = await ctx.db.get(catalogVersionId);
      if (!catalog) throw new Error("The prior track draft no longer resolves.");
      return {
        catalogVersionId,
        catalogVersion: catalog.version,
        checksum: catalog.checksum,
        changed: false,
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.draft.create",
      scopeType: "event",
    });
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before saving the track draft.",
      });
    }
    const reason = normalizedText(args.reason, "Draft reason", 5, 500);
    const result = await saveTrackCatalogDraft(ctx, {
      event,
      actorPersonId: person._id,
      tracks: args.tracks,
      ...(args.expectedDraftCatalogId !== undefined
        ? { expectedDraftCatalogId: args.expectedDraftCatalogId }
        : {}),
      now: Date.now(),
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.track_catalog.draft",
      requestFingerprint,
      targetType: "track_catalog",
      targetId: result.catalogVersionId,
      createdAt: Date.now(),
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.draft.create",
      grantIds,
      scopeType: "event",
      action: "configuration.track_catalog_drafted",
      targetType: "track_catalog",
      targetId: result.catalogVersionId,
      nextSummary: JSON.stringify({
        catalogVersion: result.catalogVersion,
        checksum: result.checksum,
        changed: result.changed,
      }),
      reason,
    });
    return result;
  },
});

export const publish = mutation({
  args: {
    eventSlug: v.string(),
    draftCatalogId: v.id("trackCatalogVersions"),
    expectedDraftChecksum: v.string(),
    expectedEventVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    catalogVersionId: v.id("trackCatalogVersions"),
    catalogVersion: v.number(),
    eventVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.draftCatalogId,
      args.expectedDraftChecksum,
      args.expectedEventVersion,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.track_catalog.publish",
      requestFingerprint,
    });
    if (prior) {
      const catalogVersionId = ctx.db.normalizeId("trackCatalogVersions", prior.targetId);
      if (!catalogVersionId) throw new Error("The prior track-publication result is invalid.");
      const catalog = await ctx.db.get(catalogVersionId);
      if (!catalog) throw new Error("The prior published track catalog no longer resolves.");
      return {
        catalogVersionId,
        catalogVersion: catalog.version,
        eventVersion: event.version,
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.publish",
      scopeType: "event",
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before publishing the track catalog.",
      });
    }
    const reason = normalizedText(args.reason, "Publication reason", 5, 500);
    const previousCatalogId = event.publishedTrackCatalogId;
    const result = await publishTrackCatalog(ctx, {
      event,
      draftCatalogId: args.draftCatalogId,
      expectedDraftChecksum: args.expectedDraftChecksum,
      now: Date.now(),
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.track_catalog.publish",
      requestFingerprint,
      targetType: "track_catalog",
      targetId: result.catalogVersionId,
      createdAt: Date.now(),
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.publish",
      grantIds,
      scopeType: "event",
      action: "configuration.track_catalog_published",
      targetType: "track_catalog",
      targetId: result.catalogVersionId,
      previousSummary: JSON.stringify({ catalogVersionId: previousCatalogId }),
      nextSummary: JSON.stringify({
        catalogVersionId: result.catalogVersionId,
        catalogVersion: result.catalogVersion,
      }),
      reason,
    });
    return { ...result, eventVersion: event.version + 1 };
  },
});
