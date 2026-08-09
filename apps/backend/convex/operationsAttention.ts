/**
 * The work the Overview leads with, read from the ledger.
 *
 * This used to recompute seven conditions inside the page query, which meant
 * the heaviest read on the dashboard ran on every refresh and the result had no
 * memory. The sweep now owns the detection; this is a plain indexed read of
 * what is open, filtered exactly as before by what the caller is allowed to
 * open. A row only exists for a caller who could already open the workspace it
 * links to, and `canAct` is the finer distinction: whether they also hold the
 * command grant behind its proposal, or are only looking.
 */

import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type MutationCtx, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { sortAttentionItems } from "./lib/operationsAttention";
import { assertPermissionKey, requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import {
  attentionDetectorKey,
  attentionScopeType,
  attentionSeverity,
  attentionSubjectType,
} from "./values";

const attentionRow = v.object({
  id: v.id("operationsAttentionItems"),
  detectorKey: attentionDetectorKey,
  subjectType: attentionSubjectType,
  subjectId: v.string(),
  severity: attentionSeverity,
  statement: v.string(),
  route: v.string(),
  actionLabel: v.string(),
  acknowledged: v.boolean(),
  recurrenceCount: v.number(),
  firstObservedAt: v.number(),
  lastObservedAt: v.number(),
  version: v.number(),
  /** False when the caller may look but holds no command grant for the fix. */
  canAct: v.boolean(),
  proposal: v.optional(
    v.object({
      commandName: v.string(),
      scopeType: attentionScopeType,
      scopeId: v.string(),
      argsJson: v.string(),
      expiresAt: v.number(),
    }),
  ),
});

type ActiveGrant = Doc<"permissionGrants">;

/**
 * A grant matches when it names the exact resource, or when it is event-wide.
 * This is the same rule `matchingPermissionGrantIds` applies, evaluated once
 * over the caller's grants instead of once per row.
 */
function grantMatcher(grants: readonly ActiveGrant[]) {
  return (permissionKey: string, scopeType: string, scopeId: string) =>
    grants.some(
      (grant) =>
        grant.permissionKey === permissionKey &&
        ((grant.scopeType === scopeType && grant.scopeId === scopeId) ||
          (grant.scopeType === "event" && grant.scopeId === undefined)),
    );
}

export const overview = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    rows: v.array(attentionRow),
    summary: v.object({
      rowCount: v.number(),
      criticalCount: v.number(),
      attentionCount: v.number(),
      watchCount: v.number(),
      acknowledgedCount: v.number(),
    }),
  }),
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

    const now = Date.now();
    const grants = await ctx.db
      .query("permissionGrants")
      .withIndex("by_subject_permission_status", (index) =>
        index.eq("eventAccessSubjectId", subject._id),
      )
      .collect();
    const allows = grantMatcher(
      grants.filter(
        (grant) =>
          grant.eventId === event._id &&
          grant.status === "active" &&
          grant.validFrom <= now &&
          (grant.validUntil === undefined || grant.validUntil > now),
      ),
    );

    const items: Doc<"operationsAttentionItems">[] = [];
    for (const state of ["open", "acknowledged"] as const) {
      items.push(
        ...(await ctx.db
          .query("operationsAttentionItems")
          .withIndex("by_event_state_severity_first", (index) =>
            index.eq("eventId", event._id).eq("state", state),
          )
          .collect()),
      );
    }
    const visible = items.filter((item) =>
      allows(item.visibility.permissionKey, item.visibility.scopeType, item.visibility.scopeId),
    );

    const rows = sortAttentionItems(visible).map((item) => {
      const proposal =
        item.proposal !== undefined && item.proposal.expiresAt > now
          ? item.proposal
          : undefined;
      return {
        id: item._id,
        detectorKey: item.detectorKey,
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        severity: item.severity,
        statement: item.statement,
        route: item.route,
        actionLabel: item.actionLabel,
        acknowledged: item.state === "acknowledged",
        recurrenceCount: item.recurrenceCount,
        firstObservedAt: item.firstObservedAt,
        lastObservedAt: item.lastObservedAt,
        version: item.version,
        canAct:
          proposal !== undefined &&
          allows(proposal.permissionKey, proposal.scopeType, proposal.scopeId),
        ...(proposal === undefined
          ? {}
          : {
              proposal: {
                commandName: proposal.commandName,
                scopeType: proposal.scopeType,
                scopeId: proposal.scopeId,
                argsJson: proposal.argsJson,
                expiresAt: proposal.expiresAt,
              },
            }),
      };
    });

    return {
      rows,
      summary: {
        rowCount: rows.length,
        criticalCount: rows.filter((row) => row.severity === "critical").length,
        attentionCount: rows.filter((row) => row.severity === "attention").length,
        watchCount: rows.filter((row) => row.severity === "watch").length,
        acknowledgedCount: rows.filter((row) => row.acknowledged).length,
      },
    };
  },
});

/**
 * "Somebody is on this." The item stays in the ledger and the sweep keeps
 * updating it; it simply stops being an unclaimed job. Resolution still belongs
 * to the sweep, because only the condition clearing proves it is over.
 */
export const acknowledge = mutation({
  args: {
    eventSlug: v.string(),
    itemId: v.id("operationsAttentionItems"),
    expectedVersion: v.number(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, item, grantIds } = await requireOpenItem(ctx, args);
    if (item.state !== "open") {
      throw new ConvexError({
        code: "ATTENTION_ITEM_CHANGED",
        message: "That item is no longer waiting to be picked up.",
      });
    }
    const now = Date.now();
    const version = item.version + 1;
    await ctx.db.patch(item._id, {
      state: "acknowledged",
      acknowledgedByPersonId: person._id,
      acknowledgedAt: now,
      version,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "operations.attention.manage",
      grantIds,
      scopeType: "event",
      action: "operations.attention_item_acknowledged",
      targetType: "operations_attention_item",
      targetId: item._id,
      previousSummary: JSON.stringify({ state: item.state }),
      nextSummary: JSON.stringify({ state: "acknowledged", version }),
      reason: item.statement,
    });
    return { version };
  },
});

/**
 * "This is not a problem." The sweep keeps the item current so the evidence
 * stays honest, but the board stops leading with it. If the condition clears
 * and later returns, the sweep opens a fresh item and the dismissal does not
 * carry over, because the second occurrence is a different judgement.
 */
export const dismiss = mutation({
  args: {
    eventSlug: v.string(),
    itemId: v.id("operationsAttentionItems"),
    expectedVersion: v.number(),
    reason: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, item, grantIds } = await requireOpenItem(ctx, args);
    if (item.state !== "open" && item.state !== "acknowledged") {
      throw new ConvexError({
        code: "ATTENTION_ITEM_CHANGED",
        message: "That item is no longer live.",
      });
    }
    const reason = normalizedText(args.reason, "Dismissal reason", 5, 500);
    const now = Date.now();
    const version = item.version + 1;
    await ctx.db.patch(item._id, {
      state: "dismissed",
      dismissedByPersonId: person._id,
      dismissedAt: now,
      version,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "operations.attention.manage",
      grantIds,
      scopeType: "event",
      action: "operations.attention_item_dismissed",
      targetType: "operations_attention_item",
      targetId: item._id,
      previousSummary: JSON.stringify({ state: item.state }),
      nextSummary: JSON.stringify({ state: "dismissed", version }),
      reason,
    });
    return { version };
  },
});

/**
 * Clearing a row is an operations command, so it needs the operations grant.
 * It also needs the same grant that let the caller see the row in the first
 * place, otherwise an operator could clear work in a workspace they cannot
 * open.
 */
async function requireOpenItem(
  ctx: MutationCtx,
  args: {
    eventSlug: string;
    itemId: Id<"operationsAttentionItems">;
    expectedVersion: number;
  },
) {
  const event = await requireEventBySlug(ctx, args.eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const grantIds = await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "operations.attention.manage",
    scopeType: "event",
  });
  const item = await ctx.db.get(args.itemId);
  if (!item || item.eventId !== event._id) {
    throw new ConvexError({
      code: "ATTENTION_ITEM_NOT_FOUND",
      message: "That attention item is unavailable.",
    });
  }
  await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: assertPermissionKey(item.visibility.permissionKey),
    scopeType: item.visibility.scopeType,
    scopeId: item.visibility.scopeId,
  });
  if (item.version !== args.expectedVersion) {
    throw new ConvexError({
      code: "ATTENTION_ITEM_CHANGED",
      message: "That item changed while you were looking at it. Refresh before continuing.",
    });
  }
  return { event, person, item, grantIds };
}
