/**
 * How the Discord support bridge behaves, owned by the operations dashboard.
 *
 * Both settings used to be deployment configuration the bot parsed once at
 * startup, so a role change or a quieter channel meant editing the environment
 * and restarting the service. They are decisions for whoever is running the
 * event, not for a deploy, so they live with the event and the bot reads them
 * on its next poll.
 *
 * There is no draft or publication step here: a switch and a list of roles take
 * effect when they are saved, the way the people using them expect. Every save
 * is still permissioned and audited.
 */

import {
  defaultDiscordSupportBridgeSettings,
  maximumDiscordAllowedRoles,
  normalizeDiscordAllowedRoleIds,
} from "@code2create/domain";
import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { requirePermission } from "./lib/permissions";

type ReadCtx = QueryCtx | MutationCtx;

const settingsView = v.object({
  reactionsEnabled: v.boolean(),
  allowedRoleIds: v.array(v.string()),
  /** 0 while the defaults stand, then bumped on every save. */
  revision: v.number(),
  updatedAt: v.union(v.number(), v.null()),
  /** Null until someone has saved: the row is absent and the defaults stand. */
  updatedByName: v.union(v.string(), v.null()),
});

/** The stored row for `eventId`, or null while the defaults still stand. */
export async function findBridgeSettings(ctx: ReadCtx, eventId: Id<"events">) {
  return await ctx.db
    .query("supportDiscordBridgeSettings")
    .withIndex("by_event", (index) => index.eq("eventId", eventId))
    .unique();
}

/**
 * The settings the bridge should act on, falling back to the published defaults
 * before anyone has saved. Read by the bot's poll as well as the dashboard.
 */
export function bridgeSettingsOf(row: Doc<"supportDiscordBridgeSettings"> | null) {
  return {
    reactionsEnabled: row?.reactionsEnabled ?? defaultDiscordSupportBridgeSettings.reactionsEnabled,
    allowedRoleIds: row?.allowedRoleIds ?? [...defaultDiscordSupportBridgeSettings.allowedRoleIds],
  };
}

/** The bridge settings for the dashboard, with who last changed them. */
export const settings = query({
  args: { eventSlug: v.string() },
  returns: settingsView,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "support.case.read",
      scopeType: "event",
    });

    const row = await findBridgeSettings(ctx, event._id);
    const current = bridgeSettingsOf(row);
    const editor = row ? await ctx.db.get(row.updatedByPersonId) : null;
    return {
      reactionsEnabled: current.reactionsEnabled,
      allowedRoleIds: current.allowedRoleIds,
      revision: row?.revision ?? 0,
      updatedAt: row?.updatedAt ?? null,
      updatedByName: editor?.displayName ?? null,
    };
  },
});

/**
 * Save the bridge settings.
 *
 * Roles are cleaned rather than rejected one by one — anything that is not a
 * Discord snowflake is dropped. A list that was meant to hold roles but cleans
 * down to nothing is refused instead, because an empty list is not "no roles":
 * it means the bot's deployed roles stand, which is the opposite of what
 * someone typing role names was asking for.
 *
 * `expectedRevision` is the revision the editor was looking at. A save made
 * against a stale one is refused rather than quietly replacing whatever the
 * other operator just wrote.
 */
export const saveSettings = mutation({
  args: {
    eventSlug: v.string(),
    reactionsEnabled: v.boolean(),
    allowedRoleIds: v.array(v.string()),
    expectedRevision: v.number(),
    reason: v.string(),
  },
  returns: settingsView,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "support.case.manage",
      scopeType: "event",
    });

    if (args.allowedRoleIds.length > maximumDiscordAllowedRoles) {
      throw new ConvexError({
        code: "TOO_MANY_DISCORD_ROLES",
        message: `A support bridge allows at most ${maximumDiscordAllowedRoles} roles.`,
      });
    }
    const allowedRoleIds = normalizeDiscordAllowedRoleIds(args.allowedRoleIds);
    if (args.allowedRoleIds.length > 0 && allowedRoleIds.length === 0) {
      throw new ConvexError({
        code: "INVALID_DISCORD_ROLE_ID",
        message: "A Discord role ID is 6 to 32 digits. None of those were.",
      });
    }
    const reason = args.reason.trim();
    if (reason.length < 3) {
      throw new ConvexError({
        code: "REASON_REQUIRED",
        message: "Say why the support bridge is changing.",
      });
    }

    const existing = await findBridgeSettings(ctx, event._id);
    const currentRevision = existing?.revision ?? 0;
    if (args.expectedRevision !== currentRevision) {
      throw new ConvexError({
        code: "STALE_DISCORD_BRIDGE_REVISION",
        message:
          "Someone else changed the support bridge while this was open. Reload to see their change before saving.",
      });
    }
    const previous = bridgeSettingsOf(existing);
    const revision = currentRevision + 1;
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        reactionsEnabled: args.reactionsEnabled,
        allowedRoleIds,
        revision,
        updatedAt: now,
        updatedByPersonId: person._id,
      });
    } else {
      await ctx.db.insert("supportDiscordBridgeSettings", {
        eventId: event._id,
        reactionsEnabled: args.reactionsEnabled,
        allowedRoleIds,
        revision,
        updatedAt: now,
        updatedByPersonId: person._id,
      });
    }

    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "support.case.manage",
      grantIds,
      scopeType: "event",
      action: "support.discord_bridge_configured",
      targetType: "event",
      targetId: event._id,
      previousSummary: JSON.stringify({ ...previous, revision: currentRevision }),
      nextSummary: JSON.stringify({
        reactionsEnabled: args.reactionsEnabled,
        allowedRoleIds,
        revision,
      }),
      reason,
    });

    return {
      reactionsEnabled: args.reactionsEnabled,
      allowedRoleIds,
      revision,
      updatedAt: now,
      updatedByName: person.displayName,
    };
  },
});
