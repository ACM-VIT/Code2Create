import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireEventBySlug } from "./events";
import { requireCurrentPerson, requireEventSubject, requireMembership } from "./identity";
import { permissionCatalog, type PermissionKey } from "./permissionCatalog";
import { boundedActivePermissionScopeIds, matchingPermissionGrantIds } from "./permissions";
import { normalizedText, optionalNormalizedText } from "./strings";

type ReadCtx = QueryCtx | MutationCtx;

export const maximumSynesthesiaWindows = 64;
export const maximumRequestsPerWindow = 200;
export const maximumCatalogSearchResults = 20;

/** Tracks participants pull straight from YouTube; staff never classified them. */
export const youtubeProvider = "youtube";
export const unclassifiedEnergyTag = "unclassified";

const participatingTeamStatuses = new Set<Doc<"teams">["status"]>([
  "admitted",
  "confirmed",
  "checked_in",
  "active",
  "completed",
]);

export async function synesthesiaParticipantContext(ctx: ReadCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const membership = await requireMembership(ctx, event._id, person._id);
  const [teamMembership, accessState] = await Promise.all([
    ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index.eq("eventId", event._id).eq("membershipId", membership._id).eq("status", "active"),
      )
      .unique(),
    ctx.db
      .query("synesthesiaAccessStates")
      .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
      .unique(),
  ]);
  const team = teamMembership ? await ctx.db.get("teams", teamMembership.teamId) : null;
  // Being on a participating team is what makes someone a participant here;
  // a staff role on the same account does not take music away.
  const eligible =
    membership.eligibilityStatus === "eligible" &&
    team !== null &&
    team.eventId === event._id &&
    participatingTeamStatuses.has(team.status);
  return {
    event,
    person,
    subject,
    membership,
    team,
    eligible,
    accessState,
  };
}

export async function requireSynesthesiaParticipant(ctx: ReadCtx, eventSlug: string) {
  const context = await synesthesiaParticipantContext(ctx, eventSlug);
  if (!context.eligible) {
    throw new ConvexError({
      code: "SYNESTHESIA_NOT_AVAILABLE",
      message: "Music requests are available to selected participant teams during the event.",
    });
  }
  if (context.accessState?.state === "suspended") {
    throw new ConvexError({
      code: "SYNESTHESIA_ACCESS_SUSPENDED",
      message: "Music request access is paused for this participant. Ask event support for help.",
    });
  }
  return context;
}

export async function activeSynesthesiaWindow(ctx: ReadCtx, eventId: Id<"events">, now: number) {
  const candidates = await ctx.db
    .query("synesthesiaWindows")
    .withIndex("by_event_status_start", (index) =>
      index.eq("eventId", eventId).eq("status", "published").lte("startsAt", now),
    )
    .order("desc")
    .take(2);
  return candidates.find((window) => window.endsAt > now) ?? null;
}

export function trackFitsWindow(
  track: Doc<"synesthesiaCatalogTracks">,
  window: Doc<"synesthesiaWindows">,
) {
  // YouTube-sourced tracks arrive unclassified, so only the window's duration
  // and explicit-content rules apply to them.
  return (
    track.status === "active" &&
    track.durationSeconds <= window.maxTrackDurationSeconds &&
    (!track.isExplicit || window.allowExplicit) &&
    (track.provider === youtubeProvider || window.allowedEnergyTags.includes(track.energyTag))
  );
}

export async function activeGrantScopes(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    permissionKey: PermissionKey;
    maximumScopeCount: number;
  },
) {
  const definition = permissionCatalog[args.permissionKey];
  const [eventGrantIds, scopedIds] = await Promise.all([
    definition.eventWide
      ? matchingPermissionGrantIds(ctx, {
          eventId: args.eventId,
          eventAccessSubjectId: args.eventAccessSubjectId,
          permissionKey: args.permissionKey,
          scopeType: "event",
        })
      : Promise.resolve([]),
    Promise.all(
      definition.scopes.map((requestedScopeType) =>
        boundedActivePermissionScopeIds(ctx, {
          ...args,
          scopeType: requestedScopeType,
        }),
      ),
    ),
  ]);
  return {
    eventWide: eventGrantIds.length > 0,
    scopeIds: new Set(scopedIds.flatMap((ids) => [...ids])),
  };
}

export function scopeAllows(
  scopes: { eventWide: boolean; scopeIds: Set<string> },
  scopeId: string,
) {
  return scopes.eventWide || scopes.scopeIds.has(scopeId);
}

export function normalizedProvider(value: string) {
  const provider = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(provider) || provider.length > 40) {
    throw new ConvexError({
      code: "INVALID_PROVIDER",
      message: "Provider must be a short lowercase identifier.",
    });
  }
  return provider;
}

export function normalizedEnergyTags(values: string[]) {
  const tags = [...new Set(values.map((value) => value.trim().toLowerCase()))]
    .filter(Boolean)
    .sort();
  if (tags.length < 1 || tags.length > 12) {
    throw new ConvexError({
      code: "INVALID_ENERGY_TAGS",
      message: "Choose between one and twelve energy tags.",
    });
  }
  for (const tag of tags) {
    if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(tag) || tag.length > 32) {
      throw new ConvexError({
        code: "INVALID_ENERGY_TAGS",
        message: "Energy tags must be short lowercase identifiers.",
      });
    }
  }
  return tags;
}

export function catalogTrackFields(args: {
  title: string;
  artist: string;
  album?: string;
  durationSeconds: number;
  isExplicit: boolean;
  energyTag: string;
}) {
  const title = normalizedText(args.title, "Track title", 1, 120);
  const artist = normalizedText(args.artist, "Artist", 1, 120);
  const album = optionalNormalizedText(args.album, "Album", 120);
  if (
    !Number.isSafeInteger(args.durationSeconds) ||
    args.durationSeconds < 30 ||
    args.durationSeconds > 1_800
  ) {
    throw new ConvexError({
      code: "INVALID_DURATION",
      message: "Track duration must be between 30 and 1,800 seconds.",
    });
  }
  const [energyTag] = normalizedEnergyTags([args.energyTag]);
  if (!energyTag) throw new Error("Energy-tag normalization returned no value.");
  return {
    title,
    artist,
    ...(album !== undefined ? { album } : {}),
    durationSeconds: args.durationSeconds,
    isExplicit: args.isExplicit,
    energyTag,
    searchText: `${title} ${artist} ${album ?? ""}`.trim().toLowerCase(),
  };
}

export function synesthesiaWindowFields(args: {
  name: string;
  kind: Doc<"synesthesiaWindows">["kind"];
  customKindLabel?: string;
  startsAt: number;
  endsAt: number;
  requestsOpen: boolean;
  votingOpen: boolean;
  catalogSourceLabel: string;
  autoApproveRequests: boolean;
  maxRequestsPerParticipant: number;
  maxVotesPerParticipant: number;
  maxRequestsTotal: number;
  maxTrackDurationSeconds: number;
  allowExplicit: boolean;
  allowedEnergyTags: string[];
}) {
  const name = normalizedText(args.name, "Window name", 2, 80);
  const customKindLabel = optionalNormalizedText(args.customKindLabel, "Custom window kind", 60);
  if (args.kind === "custom" && customKindLabel === undefined) {
    throw new ConvexError({
      code: "CUSTOM_KIND_REQUIRED",
      message: "Name the custom ambience window kind.",
    });
  }
  if (
    !Number.isSafeInteger(args.startsAt) ||
    !Number.isSafeInteger(args.endsAt) ||
    args.endsAt <= args.startsAt ||
    args.endsAt - args.startsAt > 24 * 60 * 60 * 1_000
  ) {
    throw new ConvexError({
      code: "INVALID_WINDOW_TIME",
      message: "Window times must form a period no longer than 24 hours.",
    });
  }
  if (
    !Number.isSafeInteger(args.maxRequestsPerParticipant) ||
    args.maxRequestsPerParticipant < 0 ||
    args.maxRequestsPerParticipant > 10 ||
    !Number.isSafeInteger(args.maxVotesPerParticipant) ||
    args.maxVotesPerParticipant < 0 ||
    args.maxVotesPerParticipant > 50 ||
    !Number.isSafeInteger(args.maxRequestsTotal) ||
    args.maxRequestsTotal < 1 ||
    args.maxRequestsTotal > maximumRequestsPerWindow ||
    !Number.isSafeInteger(args.maxTrackDurationSeconds) ||
    args.maxTrackDurationSeconds < 60 ||
    args.maxTrackDurationSeconds > 900
  ) {
    throw new ConvexError({
      code: "INVALID_WINDOW_POLICY",
      message: "Window request, vote, or duration limits are outside the supported bounds.",
    });
  }
  if (args.requestsOpen && args.maxRequestsPerParticipant === 0) {
    throw new ConvexError({
      code: "INVALID_WINDOW_POLICY",
      message: "A request-open window needs a positive per-participant request limit.",
    });
  }
  if (args.votingOpen && args.maxVotesPerParticipant === 0) {
    throw new ConvexError({
      code: "INVALID_WINDOW_POLICY",
      message: "A voting-open window needs a positive per-participant vote limit.",
    });
  }
  return {
    name,
    kind: args.kind,
    ...(args.kind === "custom" && customKindLabel !== undefined ? { customKindLabel } : {}),
    startsAt: args.startsAt,
    endsAt: args.endsAt,
    requestsOpen: args.requestsOpen,
    votingOpen: args.votingOpen,
    catalogSourceLabel: normalizedText(args.catalogSourceLabel, "Catalog source", 2, 100),
    autoApproveRequests: args.autoApproveRequests,
    maxRequestsPerParticipant: args.maxRequestsPerParticipant,
    maxVotesPerParticipant: args.maxVotesPerParticipant,
    maxRequestsTotal: args.maxRequestsTotal,
    maxTrackDurationSeconds: args.maxTrackDurationSeconds,
    allowExplicit: args.allowExplicit,
    allowedEnergyTags: normalizedEnergyTags(args.allowedEnergyTags),
  };
}
