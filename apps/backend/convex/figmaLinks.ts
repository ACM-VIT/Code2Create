import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import {
  findCurrentPerson,
  requireCurrentPerson,
  requireEventSubject,
  requireMembership,
} from "./lib/identity";
import { currentTeamForMembership } from "./lib/teamMembership";
import {
  matchingPermissionGrantIds,
  requirePermission,
} from "./lib/permissions";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { writeAuditEvent } from "./lib/audit";

export function normalizeFigmaLink(input: string) {
  const value = input.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConvexError({
      code: "INVALID_FIGMA_LINK",
      message: "Paste a complete Figma file link.",
    });
  }
  if (
    value.length > 2000 ||
    url.protocol !== "https:" ||
    !["figma.com", "www.figma.com"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/(design|file|proto)\/[A-Za-z0-9]+(?:\/|$)/.test(url.pathname)
  ) {
    throw new ConvexError({
      code: "INVALID_FIGMA_LINK",
      message: "Use an HTTPS link to a Figma design, file or prototype.",
    });
  }
  return url.toString();
}

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      fileUrl: v.union(v.string(), v.null()),
      version: v.number(),
      canEdit: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const person = await findCurrentPerson(ctx);
    if (!person) return null;
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const membership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (q) =>
        q.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (!membership) return null;
    const context = await currentTeamForMembership(
      ctx,
      event._id,
      membership._id,
    );
    if (!context) return null;
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const permission = {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      scopeType: "team" as const,
      scopeId: context.team._id,
    };
    const readGrants = await matchingPermissionGrantIds(ctx, {
      ...permission,
      permissionKey: "integration.read",
    });
    if (!readGrants.length) return null;
    const [link, grants] = await Promise.all([
      ctx.db
        .query("teamFigmaLinks")
        .withIndex("by_event_team", (q) =>
          q.eq("eventId", event._id).eq("teamId", context.team._id),
        )
        .unique(),
      matchingPermissionGrantIds(ctx, {
        ...permission,
        permissionKey: "integration.figma.manage",
      }),
    ]);
    return {
      fileUrl: link?.fileUrl ?? null,
      version: link?.version ?? 0,
      canEdit:
        grants.length > 0 &&
        event.status !== "complete" &&
        ["admitted", "confirmed", "checked_in", "active"].includes(
          context.team.status,
        ),
    };
  },
});

export const save = mutation({
  args: {
    eventSlug: v.string(),
    fileUrl: v.string(),
    expectedVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    const context = await currentTeamForMembership(
      ctx,
      event._id,
      membership._id,
    );
    if (!context)
      throw new ConvexError({
        code: "TEAM_REQUIRED",
        message: "Join a team first.",
      });
    const { team } = context;
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.figma.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    const fileUrl = normalizeFigmaLink(args.fileUrl);
    const operation = {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "team.figma_link.save",
      requestFingerprint: operationFingerprint([
        team._id,
        fileUrl ?? null,
        args.expectedVersion,
      ]),
    };
    const prior = await findOperation(ctx, operation);
    if (prior)
      return {
        version: storedOperationVersion(prior.resultJson, "Figma link"),
      };
    if (
      event.status === "complete" ||
      !["admitted", "confirmed", "checked_in", "active"].includes(team.status)
    )
      throw new ConvexError({
        code: "LINK_NOT_EDITABLE",
        message:
          "Figma links can be updated by accepted teams until the event ends.",
      });
    const current = await ctx.db
      .query("teamFigmaLinks")
      .withIndex("by_event_team", (q) =>
        q.eq("eventId", event._id).eq("teamId", team._id),
      )
      .unique();
    if ((current?.version ?? 0) !== args.expectedVersion)
      throw new ConvexError({
        code: "LINK_CHANGED",
        message: "A teammate changed this link. Refresh before saving.",
      });
    const now = Date.now();
    const version = args.expectedVersion + 1;
    const fields = {
      ...(fileUrl ? { fileUrl } : {}),
      version,
      updatedByPersonId: person._id,
      updatedAt: now,
    };
    const id =
      current?._id ??
      (await ctx.db.insert("teamFigmaLinks", {
        eventId: event._id,
        teamId: team._id,
        ...fields,
      }));
    if (current) await ctx.db.patch(current._id, { ...fields, fileUrl });
    await recordOperation(ctx, {
      ...operation,
      targetType: "team_figma_link",
      targetId: id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "integration.figma.manage",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "team.figma_link_saved",
      reason: fileUrl
        ? "Team updated its Figma file link"
        : "Team removed its Figma file link",
      targetType: "team_figma_link",
      targetId: id,
      previousSummary: JSON.stringify({
        fileUrl: current?.fileUrl ?? null,
        version: current?.version ?? 0,
      }),
      nextSummary: JSON.stringify({ fileUrl: fileUrl ?? null, version }),
    });
    return { version };
  },
});
