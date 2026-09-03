import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { parseFigmaFileLocation } from "./lib/figmaFileLocation";
import { parseGitHubRepositoryLocation } from "./lib/githubRepositoryLocation";
import {
  findCurrentPerson,
  requireCurrentPerson,
  requireEventSubject,
  requireMembership,
} from "./lib/identity";
import { loadPublishedIntegrationPolicy } from "./lib/integrationPolicy";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
} from "./lib/operations";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { reviewLinkKind } from "./values";

type ReadCtx = QueryCtx | MutationCtx;

const reviewLink = v.object({
  id: v.id("teamReviewLinks"),
  kind: reviewLinkKind,
  url: v.string(),
  label: v.string(),
  version: v.number(),
});

const currentView = v.union(
  v.null(),
  v.object({
    canSubmit: v.boolean(),
    github: v.array(reviewLink),
    figma: v.array(reviewLink),
    githubLimit: v.number(),
    figmaLimit: v.number(),
  }),
);

function requireActiveTeam(team: Doc<"teams">) {
  if (team.status === "withdrawn" || team.status === "disqualified") {
    throw new ConvexError({
      code: "TEAM_UNAVAILABLE",
      message: "This team cannot submit review links.",
    });
  }
}

async function currentTeamContext(ctx: ReadCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const membership = await requireMembership(ctx, event._id, person._id);
  const member = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index.eq("eventId", event._id).eq("membershipId", membership._id).eq("status", "active"),
    )
    .unique();
  if (!member) {
    throw new ConvexError({ code: "TEAM_REQUIRED", message: "Create or join a team first." });
  }
  const team = await ctx.db.get(member.teamId);
  if (!team) throw new Error("Team membership references a missing team.");
  return { event, person, subject, team };
}

async function linkLimits(ctx: ReadCtx, event: Doc<"events">) {
  if (!event.publishedIntegrationPolicyId) {
    return { github: 4, figma: 4 };
  }
  const { normalized } = await loadPublishedIntegrationPolicy(ctx, event);
  return {
    github: normalized.maxActiveGitHubRepositoriesPerTeam,
    figma: normalized.maxActiveFigmaFilesPerTeam,
  };
}

async function activeLinks(
  ctx: ReadCtx,
  teamId: Id<"teams">,
  kind: "github" | "figma",
) {
  const links = await ctx.db
    .query("teamReviewLinks")
    .withIndex("by_team_state", (index) => index.eq("teamId", teamId).eq("state", "active"))
    .collect();
  return links
    .filter((link) => link.kind === kind)
    .toSorted((left, right) => left.createdAt - right.createdAt);
}

function presented(link: Doc<"teamReviewLinks">) {
  return {
    id: link._id,
    kind: link.kind,
    url: link.url,
    label: link.label,
    version: link.version,
  };
}

export const current = query({
  args: { eventSlug: v.string() },
  returns: currentView,
  handler: async (ctx, args) => {
    const person = await findCurrentPerson(ctx);
    if (!person) return null;
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const membership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (!membership) return null;
    const member = await ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("membershipId", membership._id)
          .eq("status", "active"),
      )
      .unique();
    if (!member) return null;
    const [team, subject] = await Promise.all([
      ctx.db.get(member.teamId),
      ctx.db.get(membership.eventAccessSubjectId),
    ]);
    if (!team || !subject || subject.status !== "active") return null;
    const readGrantIds = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.read",
      scopeType: "team",
      scopeId: team._id,
    });
    if (readGrantIds.length === 0) return null;
    const limits = await linkLimits(ctx, event);
    const [github, figma] = await Promise.all([
      activeLinks(ctx, team._id, "github"),
      activeLinks(ctx, team._id, "figma"),
    ]);
    return {
      canSubmit: team.status !== "withdrawn" && team.status !== "disqualified",
      github: github.map(presented),
      figma: figma.map(presented),
      githubLimit: limits.github,
      figmaLimit: limits.figma,
    };
  },
});

export const addGithub = mutation({
  args: {
    eventSlug: v.string(),
    repositoryUrl: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ linkId: v.id("teamReviewLinks") }),
  handler: async (ctx, args) => {
    const location = parseGitHubRepositoryLocation(args.repositoryUrl);
    return addLink(ctx, {
      eventSlug: args.eventSlug,
      kind: "github",
      canonicalKey: `${location.owner.toLocaleLowerCase("en")}/${location.name.toLocaleLowerCase("en")}`,
      url: location.url,
      label: `${location.owner}/${location.name}`,
      clientOperationId: args.clientOperationId,
    });
  },
});

export const addFigma = mutation({
  args: {
    eventSlug: v.string(),
    fileUrl: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ linkId: v.id("teamReviewLinks") }),
  handler: async (ctx, args) => {
    const location = parseFigmaFileLocation(args.fileUrl);
    return addLink(ctx, {
      eventSlug: args.eventSlug,
      kind: "figma",
      canonicalKey: location.fileKey,
      url: location.url,
      label: location.fileKey,
      clientOperationId: args.clientOperationId,
    });
  },
});

export const archive = mutation({
  args: {
    eventSlug: v.string(),
    linkId: v.id("teamReviewLinks"),
    expectedVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ linkId: v.id("teamReviewLinks") }),
  handler: async (ctx, args) => {
    const { event, person, subject, team } = await currentTeamContext(ctx, args.eventSlug);
    requireActiveTeam(team);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.read",
      scopeType: "team",
      scopeId: team._id,
    });
    const requestFingerprint = operationFingerprint([
      "review.link.archive",
      args.linkId,
      args.expectedVersion,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.link.archive",
      requestFingerprint,
    });
    if (prior) {
      const linkId = ctx.db.normalizeId("teamReviewLinks", prior.targetId);
      if (!linkId) throw new Error("The prior review-link archive result is invalid.");
      return { linkId };
    }
    const link = await ctx.db.get(args.linkId);
    if (!link || link.teamId !== team._id || link.eventId !== event._id) {
      throw new ConvexError({
        code: "REVIEW_LINK_UNAVAILABLE",
        message: "That review link is unavailable.",
      });
    }
    if (link.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "REVIEW_LINK_CHANGED",
        message: "That review link changed. Refresh and try again.",
      });
    }
    const now = Date.now();
    if (link.state !== "archived") {
      await ctx.db.patch(link._id, {
        state: "archived",
        version: link.version + 1,
        updatedAt: now,
        archivedAt: now,
      });
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.link.archive",
      requestFingerprint,
      targetType: "teamReviewLink",
      targetId: link._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "integration.read",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "review_link.archived",
      targetType: "teamReviewLink",
      targetId: link._id,
      nextSummary: JSON.stringify({ kind: link.kind, url: link.url }),
      reason: "Participant removed a review link",
    });
    return { linkId: link._id };
  },
});

async function addLink(
  ctx: MutationCtx,
  args: {
    eventSlug: string;
    kind: "github" | "figma";
    canonicalKey: string;
    url: string;
    label: string;
    clientOperationId: string;
  },
) {
  const { event, person, subject, team } = await currentTeamContext(ctx, args.eventSlug);
  requireActiveTeam(team);
  const grantIds = await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "integration.read",
    scopeType: "team",
    scopeId: team._id,
  });
  const requestFingerprint = operationFingerprint([
    "review.link.add",
    args.kind,
    args.canonicalKey,
  ]);
  const prior = await findOperation(ctx, {
    eventId: event._id,
    actorPersonId: person._id,
    clientOperationId: args.clientOperationId,
    commandName: "review.link.add",
    requestFingerprint,
  });
  if (prior) {
    const linkId = ctx.db.normalizeId("teamReviewLinks", prior.targetId);
    if (!linkId) throw new Error("The prior review-link result is invalid.");
    return { linkId };
  }
  const existing = await ctx.db
    .query("teamReviewLinks")
    .withIndex("by_team_kind_key", (index) =>
      index.eq("teamId", team._id).eq("kind", args.kind).eq("canonicalKey", args.canonicalKey),
    )
    .unique();
  const now = Date.now();
  if (existing?.state === "active") {
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.link.add",
      requestFingerprint,
      targetType: "teamReviewLink",
      targetId: existing._id,
      createdAt: now,
    });
    return { linkId: existing._id };
  }
  const limits = await linkLimits(ctx, event);
  const active = await activeLinks(ctx, team._id, args.kind);
  const limit = args.kind === "github" ? limits.github : limits.figma;
  if (active.length >= limit) {
    throw new ConvexError({
      code: "REVIEW_LINK_LIMIT",
      message:
        args.kind === "github"
          ? `This team already submitted ${limit} GitHub links.`
          : `This team already submitted ${limit} Figma links.`,
    });
  }
  if (existing) {
    await ctx.db.patch(existing._id, {
      state: "active",
      url: args.url,
      label: args.label,
      submittedByPersonId: person._id,
      version: existing.version + 1,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.link.add",
      requestFingerprint,
      targetType: "teamReviewLink",
      targetId: existing._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "integration.read",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "review_link.added",
      targetType: "teamReviewLink",
      targetId: existing._id,
      nextSummary: JSON.stringify({ kind: args.kind, url: args.url }),
      reason: "Participant restored a review link",
    });
    return { linkId: existing._id };
  }
  const linkId = await ctx.db.insert("teamReviewLinks", {
    eventId: event._id,
    teamId: team._id,
    kind: args.kind,
    canonicalKey: args.canonicalKey,
    url: args.url,
    label: args.label,
    state: "active",
    submittedByPersonId: person._id,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  await recordOperation(ctx, {
    eventId: event._id,
    actorPersonId: person._id,
    clientOperationId: args.clientOperationId,
    commandName: "review.link.add",
    requestFingerprint,
    targetType: "teamReviewLink",
    targetId: linkId,
    createdAt: now,
  });
  await writeAuditEvent(ctx, {
    eventId: event._id,
    actorPersonId: person._id,
    permissionKey: "integration.read",
    grantIds,
    scopeType: "team",
    scopeId: team._id,
    action: "review_link.added",
    targetType: "teamReviewLink",
    targetId: linkId,
    nextSummary: JSON.stringify({ kind: args.kind, url: args.url }),
    reason: "Participant submitted a review link",
  });
  return { linkId };
}

export const listForTeam = query({
  args: { eventSlug: v.string(), teamId: v.id("teams") },
  returns: v.array(reviewLink),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const team = await ctx.db.get(args.teamId);
    if (!team || team.eventId !== event._id) {
      throw new ConvexError({
        code: "TEAM_UNAVAILABLE",
        message: "This team is unavailable.",
      });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.read",
      scopeType: "team",
      scopeId: team._id,
    });
    const links = await ctx.db
      .query("teamReviewLinks")
      .withIndex("by_team_state", (index) => index.eq("teamId", team._id).eq("state", "active"))
      .collect();
    return links
      .toSorted((left, right) => left.createdAt - right.createdAt)
      .map(presented);
  },
});
