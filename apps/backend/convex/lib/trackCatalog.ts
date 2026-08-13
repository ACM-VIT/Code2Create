import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { fingerprintText, normalizedText } from "./strings";

type ReadCtx = QueryCtx | MutationCtx;

export const trackCatalogTrackInput = v.object({
  stableKey: v.string(),
  slug: v.string(),
  displayName: v.string(),
  description: v.string(),
  examples: v.array(v.string()),
  displayOrder: v.number(),
  type: v.union(v.literal("core"), v.literal("sponsor")),
  eligibilityText: v.optional(v.string()),
});

export type TrackCatalogTrack = {
  stableKey: string;
  slug: string;
  displayName: string;
  description: string;
  examples: string[];
  displayOrder: number;
  type: "core" | "sponsor";
  eligibilityText?: string;
};

export const maximumCoreTrackCount = 10;
export const maximumSponsorTrackCount = 10;

function invalidCatalog(message: string): never {
  throw new ConvexError({ code: "INVALID_TRACK_CATALOG", message });
}

export function normalizeRequiredCoreTrackCount(value: number) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximumCoreTrackCount
  ) {
    invalidCatalog(
      `The required core-track count must be a whole number from 1 through ${maximumCoreTrackCount}.`,
    );
  }
  return value;
}

function normalizeStableKey(value: string) {
  const stableKey = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,59}$/.test(stableKey)) {
    invalidCatalog("Track keys must start with a letter and use lowercase letters, numbers, or underscores.");
  }
  return stableKey;
}

function normalizeSlug(value: string) {
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 60) {
    invalidCatalog("Track slugs must use lowercase words separated by single hyphens.");
  }
  return slug;
}

export function normalizeTrackCatalog(
  requiredCoreTrackCount: number,
  tracks: readonly TrackCatalogTrack[],
): TrackCatalogTrack[] {
  const coreCount = normalizeRequiredCoreTrackCount(requiredCoreTrackCount);
  if (tracks.length < coreCount || tracks.length > coreCount + maximumSponsorTrackCount) {
    invalidCatalog(
      `A catalog must contain ${coreCount} core tracks and no more than ${maximumSponsorTrackCount} sponsor tracks.`,
    );
  }
  const normalized = tracks.map((track) => {
    const maximumDisplayOrder = track.type === "core"
      ? maximumCoreTrackCount - 1
      : maximumSponsorTrackCount - 1;
    if (
      !Number.isSafeInteger(track.displayOrder) ||
      track.displayOrder < 0 ||
      track.displayOrder > maximumDisplayOrder
    ) {
      invalidCatalog(
        `A ${track.type} track position must be a whole number from zero through ${maximumDisplayOrder}.`,
      );
    }
    if (track.examples.length < 1 || track.examples.length > 4) {
      invalidCatalog("Each track needs between one and four short examples.");
    }
    const eligibilityText = track.eligibilityText?.trim()
      ? normalizedText(track.eligibilityText, "Track eligibility", 3, 500)
      : undefined;
    if (track.type === "sponsor" && eligibilityText === undefined) {
      invalidCatalog("Each sponsor track needs a plain eligibility statement.");
    }
    return {
      stableKey: normalizeStableKey(track.stableKey),
      slug: normalizeSlug(track.slug),
      displayName: normalizedText(track.displayName, "Track name", 2, 80),
      description: normalizedText(track.description, "Track description", 10, 500),
      examples: track.examples.map((example) =>
        normalizedText(example, "Track example", 2, 120),
      ),
      displayOrder: track.displayOrder,
      type: track.type,
      ...(eligibilityText !== undefined ? { eligibilityText } : {}),
    };
  });
  const issues = trackCatalogIssues(coreCount, normalized);
  const firstIssue = issues[0];
  if (firstIssue !== undefined) invalidCatalog(firstIssue);
  return normalized.toSorted((left, right) => {
    if (left.type !== right.type) return left.type === "core" ? -1 : 1;
    return left.displayOrder - right.displayOrder;
  });
}

export function trackCatalogIssues(
  requiredCoreTrackCount: number,
  tracks: readonly TrackCatalogTrack[],
) {
  const issues: string[] = [];
  const coreCount = normalizeRequiredCoreTrackCount(requiredCoreTrackCount);
  const coreTracks = tracks.filter((track) => track.type === "core");
  const sponsorTracks = tracks.filter((track) => track.type === "sponsor");
  if (coreTracks.length !== coreCount) {
    issues.push(`The catalog must contain exactly ${coreCount} core tracks.`);
  }
  if (sponsorTracks.length > maximumSponsorTrackCount) {
    issues.push(
      `The catalog cannot contain more than ${maximumSponsorTrackCount} sponsor tracks.`,
    );
  }
  if (new Set(tracks.map((track) => track.stableKey)).size !== tracks.length) {
    issues.push("Every track key must be unique.");
  }
  if (new Set(tracks.map((track) => track.slug)).size !== tracks.length) {
    issues.push("Every track URL slug must be unique.");
  }
  for (const type of ["core", "sponsor"] as const) {
    const ordered = tracks
      .filter((track) => track.type === type)
      .toSorted((left, right) => left.displayOrder - right.displayOrder);
    if (ordered.some((track, index) => track.displayOrder !== index)) {
      issues.push(`${type === "core" ? "Core" : "Sponsor"} track positions must start at zero with no gaps.`);
    }
  }
  return issues;
}

export function trackCatalogChecksum(
  requiredCoreTrackCount: number,
  tracks: readonly TrackCatalogTrack[],
) {
  return fingerprintText(JSON.stringify({ requiredCoreTrackCount, tracks }));
}

export async function loadTrackCatalogTracks(
  ctx: ReadCtx,
  catalogVersionId: Id<"trackCatalogVersions">,
) {
  const catalog = await ctx.db.get(catalogVersionId);
  if (!catalog) throw new Error("A track catalog version does not exist.");
  const requiredCoreTrackCount = normalizeRequiredCoreTrackCount(
    catalog.requiredCoreTrackCount,
  );
  const [core, sponsor] = await Promise.all([
    ctx.db
      .query("trackVersions")
      .withIndex("by_catalog_type_order", (index) =>
        index.eq("catalogVersionId", catalogVersionId).eq("type", "core"),
      )
      .take(requiredCoreTrackCount + 1),
    ctx.db
      .query("trackVersions")
      .withIndex("by_catalog_type_order", (index) =>
        index.eq("catalogVersionId", catalogVersionId).eq("type", "sponsor"),
      )
      .take(maximumSponsorTrackCount + 1),
  ]);
  if (
    core.length !== requiredCoreTrackCount ||
    sponsor.length > maximumSponsorTrackCount
  ) {
    throw new Error("A track catalog does not match its published track limits.");
  }
  return [...core, ...sponsor];
}

export async function requirePinnedTrackCatalog(
  ctx: ReadCtx,
  draft: Doc<"projectDrafts">,
) {
  const catalog = await ctx.db.get(draft.trackCatalogVersionId);
  if (
    !catalog ||
    catalog.eventId !== draft.eventId ||
    (catalog.status !== "published" && catalog.status !== "superseded")
  ) {
    throw new Error("A project draft references an invalid track catalog.");
  }
  const tracks = await loadTrackCatalogTracks(ctx, catalog._id);
  if (tracks.some((track) => track.eventId !== draft.eventId || track.status !== "published")) {
    throw new Error("A project draft's track catalog is incomplete.");
  }
  return { catalog, tracks };
}

export function requireSponsorTrackSelection(
  tracks: readonly Doc<"trackVersions">[],
  selectedIds: readonly Id<"trackVersions">[],
) {
  if (selectedIds.length > maximumSponsorTrackCount) {
    throw new ConvexError({
      code: "SPONSOR_TRACK_NOT_AVAILABLE",
      message: `Choose no more than ${maximumSponsorTrackCount} sponsor tracks.`,
    });
  }
  const selectedIdSet = new Set(selectedIds);
  if (selectedIdSet.size !== selectedIds.length) {
    throw new ConvexError({
      code: "SPONSOR_TRACK_NOT_AVAILABLE",
      message: "A sponsor track was selected more than once.",
    });
  }
  const selectedTracks = tracks.filter((track) => selectedIdSet.has(track._id));
  if (selectedTracks.length !== selectedIds.length) {
    throw new ConvexError({
      code: "SPONSOR_TRACK_NOT_AVAILABLE",
      message: "One of the selected sponsor tracks is not available in this project intake.",
    });
  }
  return selectedTracks.map((track) => {
    const eligibilityText = track.eligibilityText?.trim();
    if (track.type !== "sponsor" || track.status !== "published" || !eligibilityText) {
      throw new ConvexError({
        code: "SPONSOR_TRACK_NOT_AVAILABLE",
        message: "One of the selected sponsor tracks is not available in this project intake.",
      });
    }
    return { ...track, eligibilityText };
  });
}

export async function requireProjectTrackSelection(
  ctx: ReadCtx,
  project: Doc<"projectVersions">,
) {
  if (project.sponsorTrackVersionIds.length > maximumSponsorTrackCount) {
    throw new Error("A submitted project exceeds the sponsor-track limit.");
  }
  const coreTrack = await ctx.db.get(project.coreTrackVersionId);
  if (
    !coreTrack ||
    coreTrack.eventId !== project.eventId ||
    coreTrack.type !== "core" ||
    coreTrack.status !== "published"
  ) {
    throw new Error("A submitted project references an invalid core track.");
  }
  const sponsorTracks = await Promise.all(
    project.sponsorTrackVersionIds.map((trackId) => ctx.db.get(trackId)),
  );
  const sponsorIds = new Set(project.sponsorTrackVersionIds);
  if (sponsorIds.size !== project.sponsorTrackVersionIds.length) {
    throw new Error("A submitted project references an invalid sponsor track.");
  }
  const selectedSponsorTracks = sponsorTracks.map((track) => {
    const eligibilityText = track?.eligibilityText?.trim();
    if (
      !track ||
      track.eventId !== project.eventId ||
      track.catalogVersionId !== coreTrack.catalogVersionId ||
      track.type !== "sponsor" ||
      track.status !== "published" ||
      !eligibilityText
    ) {
      throw new Error("A submitted project references an invalid sponsor track.");
    }
    return { ...track, eligibilityText };
  });
  return { coreTrack, sponsorTracks: selectedSponsorTracks };
}

export async function saveTrackCatalogDraft(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    actorPersonId: Id<"people">;
    requiredCoreTrackCount: number;
    tracks: readonly TrackCatalogTrack[];
    expectedDraftCatalogId?: Id<"trackCatalogVersions">;
    now: number;
  },
) {
  const requiredCoreTrackCount = normalizeRequiredCoreTrackCount(
    args.requiredCoreTrackCount,
  );
  const tracks = normalizeTrackCatalog(requiredCoreTrackCount, args.tracks);
  const checksum = trackCatalogChecksum(requiredCoreTrackCount, tracks);
  const currentDraft = await ctx.db
    .query("trackCatalogVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", args.event._id).eq("status", "draft"),
    )
    .unique();
  if (currentDraft?._id !== args.expectedDraftCatalogId) {
    throw new ConvexError({
      code: "TRACK_DRAFT_CHANGED",
      message: "The track draft changed in another session. Refresh before saving.",
    });
  }
  if (currentDraft?.checksum === checksum) {
    return {
      catalogVersionId: currentDraft._id,
      catalogVersion: currentDraft.version,
      checksum,
      changed: false,
    };
  }

  const latestCatalog = await ctx.db
    .query("trackCatalogVersions")
    .withIndex("by_event_version", (index) => index.eq("eventId", args.event._id))
    .order("desc")
    .first();
  const version = (latestCatalog?.version ?? 0) + 1;
  if (currentDraft) {
    const currentTracks = await loadTrackCatalogTracks(ctx, currentDraft._id);
    await ctx.db.patch(currentDraft._id, { status: "retired" });
    for (const track of currentTracks) await ctx.db.patch(track._id, { status: "retired" });
  }
  const catalogVersionId = await ctx.db.insert("trackCatalogVersions", {
    eventId: args.event._id,
    version,
    status: "draft",
    requiredCoreTrackCount,
    checksum,
    createdByPersonId: args.actorPersonId,
    createdAt: args.now,
  });
  for (const track of tracks) {
    await ctx.db.insert("trackVersions", {
      eventId: args.event._id,
      catalogVersionId,
      ...track,
      status: "draft",
      createdAt: args.now,
    });
  }
  return { catalogVersionId, catalogVersion: version, checksum, changed: true };
}

export async function publishTrackCatalog(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    draftCatalogId: Id<"trackCatalogVersions">;
    expectedDraftChecksum: string;
    now: number;
  },
) {
  const draft = await ctx.db.get(args.draftCatalogId);
  const currentDraft = await ctx.db
    .query("trackCatalogVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", args.event._id).eq("status", "draft"),
    )
    .unique();
  if (
    !draft ||
    draft.eventId !== args.event._id ||
    currentDraft?._id !== draft._id ||
    draft.checksum !== args.expectedDraftChecksum
  ) {
    throw new ConvexError({
      code: "TRACK_DRAFT_CHANGED",
      message: "The track draft changed in another session. Refresh before publishing.",
    });
  }
  const tracks = await loadTrackCatalogTracks(ctx, draft._id);
  const normalizedTracks = normalizeTrackCatalog(
    draft.requiredCoreTrackCount,
    tracks.map((track) => ({
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
    })),
  );
  if (
    trackCatalogChecksum(draft.requiredCoreTrackCount, normalizedTracks) !==
    draft.checksum
  ) {
    throw new Error("The track draft checksum does not match its rows.");
  }
  const publishedCatalogId = args.event.publishedTrackCatalogId;
  const publishedCatalog = publishedCatalogId
    ? await ctx.db.get(publishedCatalogId)
    : null;
  if (
    !publishedCatalog ||
    publishedCatalog.eventId !== args.event._id ||
    publishedCatalog.status !== "published"
  ) {
    throw new Error("The event's published track catalog is invalid.");
  }
  await ctx.db.patch(publishedCatalog._id, { status: "superseded" });
  await ctx.db.patch(draft._id, { status: "published", publishedAt: args.now });
  for (const track of tracks) await ctx.db.patch(track._id, { status: "published" });
  await ctx.db.patch(args.event._id, {
    publishedTrackCatalogId: draft._id,
    version: args.event.version + 1,
    updatedAt: args.now,
  });
  return { catalogVersionId: draft._id, catalogVersion: draft.version };
}
