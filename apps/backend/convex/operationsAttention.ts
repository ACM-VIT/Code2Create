/** Reads the durable attention ledger and filters visibility and actions by grant. */

import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type MutationCtx, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { sortAttentionItems } from "./lib/operationsAttention";
import { appendOperationsAttentionReadFactById } from "./lib/operationsAutonomyReadFacts";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import {
  assertPermissionKey,
  matchingPermissionGrantIds,
  requirePermission,
} from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import {
  attentionDetectorKey,
  attentionProposal,
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
  proposal: v.optional(attentionProposal),
});

/** The feed is deliberately a next-work queue, not an unbounded ledger export. */
export const maximumAttentionOverviewRows = 20;
const maximumCurrentAttentionRounds = 10;

export const overview = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    rows: v.array(attentionRow),
    summary: v.object({
      limit: v.number(),
      hasMore: v.boolean(),
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

    const sweepStates = await ctx.db
      .query("operationsAttentionSweepStates")
      .withIndex("by_event_state", (index) =>
        index.eq("eventId", event._id).eq("state", "active"),
      )
      .take(maximumCurrentAttentionRounds + 1);
    if (sweepStates.length > maximumCurrentAttentionRounds) {
      throw new Error("The attention feed exceeds the current-round limit.");
    }
    const readableRoundIds: Id<"reviewRounds">[] = [];
    for (const sweepState of sweepStates) {
      const grantIds = await matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "round.read",
        scopeType: "round",
        scopeId: sweepState.roundId,
      });
      if (grantIds.length > 0) readableRoundIds.push(sweepState.roundId);
    }

    const candidates: Doc<"operationsAttentionItems">[] = [];
    for (const roundId of readableRoundIds) {
      for (const state of ["open", "acknowledged"] as const) {
        for (const severity of ["critical", "attention", "watch"] as const) {
          candidates.push(
            ...(await ctx.db
              .query("operationsAttentionItems")
              .withIndex("by_round_state_severity_first", (index) =>
                index
                  .eq("roundId", roundId)
                  .eq("state", state)
                  .eq("severity", severity),
              )
              .take(maximumAttentionOverviewRows + 1)),
          );
        }
      }
    }
    for (const item of candidates) {
      if (
        item.eventId !== event._id ||
        item.roundId === undefined ||
        item.visibility.permissionKey !== "round.read" ||
        item.visibility.scopeType !== "round" ||
        item.visibility.scopeId !== item.roundId
      ) {
        throw new Error("A current attention row has an invalid visibility owner.");
      }
    }

    const visible = sortAttentionItems(candidates);
    const hasMore = visible.length > maximumAttentionOverviewRows;
    const now = Date.now();
    const rows = await Promise.all(visible.slice(0, maximumAttentionOverviewRows).map(async (item) => {
      const proposal =
        item.proposal !== undefined && item.proposal.expiresAt > now
          ? item.proposal
          : undefined;
      const canAct =
        proposal !== undefined &&
        (
          await matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: assertPermissionKey(proposal.permissionKey),
            scopeType: proposal.scopeType,
            scopeId: proposal.scopeId,
          })
        ).length > 0;
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
        canAct,
        ...(proposal === undefined
          ? {}
          : {
              proposal,
            }),
      };
    }));

    return {
      rows,
      summary: {
        limit: maximumAttentionOverviewRows,
        hasMore,
        rowCount: rows.length,
        criticalCount: rows.filter((row) => row.severity === "critical").length,
        attentionCount: rows.filter((row) => row.severity === "attention").length,
        watchCount: rows.filter((row) => row.severity === "watch").length,
        acknowledgedCount: rows.filter((row) => row.acknowledged).length,
      },
    };
  },
});

/** Acknowledgement assigns ownership; only a cleared condition resolves the item. */
export const acknowledge = mutation({
  args: {
    eventSlug: v.string(),
    itemId: v.id("operationsAttentionItems"),
    expectedVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const actor = await requireAttentionActor(ctx, args.eventSlug);
    const requestFingerprint = operationFingerprint([args.itemId, args.expectedVersion]);
    const prior = await findOperation(ctx, {
      eventId: actor.event._id,
      actorPersonId: actor.person._id,
      clientOperationId: args.clientOperationId,
      commandName: "operations.attention.acknowledge",
      requestFingerprint,
    });
    if (prior) return storedAttentionResult(prior.resultJson);
    const { event, person, item, grantIds } = await requireOpenItem(ctx, args, actor);
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
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "operations.attention.acknowledge",
      requestFingerprint,
      targetType: "operations_attention_item",
      targetId: item._id,
      resultJson: String(version),
      createdAt: now,
    });
    await appendOperationsAttentionReadFactById(ctx, item._id, now);
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

/** Dismissal hides this occurrence; a later recurrence creates a new item. */
export const dismiss = mutation({
  args: {
    eventSlug: v.string(),
    itemId: v.id("operationsAttentionItems"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const actor = await requireAttentionActor(ctx, args.eventSlug);
    const reason = normalizedText(args.reason, "Dismissal reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.itemId,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: actor.event._id,
      actorPersonId: actor.person._id,
      clientOperationId: args.clientOperationId,
      commandName: "operations.attention.dismiss",
      requestFingerprint,
    });
    if (prior) return storedAttentionResult(prior.resultJson);
    const { event, person, item, grantIds } = await requireOpenItem(ctx, args, actor);
    if (item.state !== "open" && item.state !== "acknowledged") {
      throw new ConvexError({
        code: "ATTENTION_ITEM_CHANGED",
        message: "That item is no longer live.",
      });
    }
    const now = Date.now();
    const version = item.version + 1;
    await ctx.db.patch(item._id, {
      state: "dismissed",
      dismissedByPersonId: person._id,
      dismissedAt: now,
      version,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "operations.attention.dismiss",
      requestFingerprint,
      targetType: "operations_attention_item",
      targetId: item._id,
      resultJson: String(version),
      createdAt: now,
    });
    await appendOperationsAttentionReadFactById(ctx, item._id, now);
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

/** Clearing requires both the operations grant and the item's visibility grant. */
async function requireOpenItem(
  ctx: MutationCtx,
  args: {
    itemId: Id<"operationsAttentionItems">;
    expectedVersion: number;
  },
  actor: Awaited<ReturnType<typeof requireAttentionActor>>,
) {
  const { event, person, subject } = actor;
  const grantIds = await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "operations.attention.manage",
    scopeType: "event",
  });
  const item = await ctx.db.get(args.itemId);
  if (!item || item.eventId !== event._id || item.roundId === undefined) {
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

async function requireAttentionActor(ctx: MutationCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  return { event, person, subject };
}

function storedAttentionResult(resultJson: string | undefined) {
  const version = Number(resultJson);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("The saved attention command result is invalid.");
  }
  return { version };
}
