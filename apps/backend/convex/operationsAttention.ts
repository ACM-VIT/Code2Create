import { v } from "convex/values";

import { query } from "./_generated/server";
import {
  type AttentionRow,
  reviewAttentionRows,
  sortAttentionRows,
} from "./lib/operationsAttention";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { requirePermission } from "./lib/permissions";
import { buildReviewOverview, buildRoundBoard } from "./reviewOperations";

/** Round boards are the heaviest read on this page, so only live rounds load. */
const openRoundLimit = 2;

const attentionRow = v.object({
  key: v.string(),
  job: v.union(
    v.literal("panel_seats"),
    v.literal("team_queue"),
    v.literal("active_reviews"),
  ),
  severity: v.union(v.literal("critical"), v.literal("attention"), v.literal("watch")),
  subject: v.string(),
  context: v.optional(v.string()),
  statement: v.string(),
  since: v.optional(v.number()),
  route: v.string(),
  actionLabel: v.string(),
  canAct: v.boolean(),
});

/**
 * The work the Overview leads with.
 *
 * Rows come from projections that already filter by grant, so a row can only
 * exist when the caller can open the workspace it links to. `canAct` is the
 * finer distinction: whether they also hold the command permission, or are
 * only looking.
 */
export const overview = query({
  args: { eventSlug: v.string(), refreshBucket: v.number() },
  returns: v.object({
    generatedAt: v.number(),
    rows: v.array(attentionRow),
    summary: v.object({
      rowCount: v.number(),
      criticalCount: v.number(),
      attentionCount: v.number(),
      watchCount: v.number(),
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
    const generatedAt = Date.now();
    const { rounds } = await buildReviewOverview(ctx, args.eventSlug);
    const liveRounds = rounds
      .filter((round) => round.status === "open" || round.status === "closing")
      .slice(0, openRoundLimit);

    const rows: AttentionRow[] = [];
    for (const round of liveRounds) {
      const board = await buildRoundBoard(ctx, event.slug, round.id);
      const configuration = await ctx.db.get(round.id);
      if (!configuration) continue;
      rows.push(
        ...reviewAttentionRows({
          roundId: round.id,
          roundName: board.round.name,
          requiredPanelSize: configuration.requiredPanelSize,
          reviewDurationSeconds: configuration.reviewDurationSeconds,
          panels: board.panels,
          teams: board.teams,
          now: board.serverNow,
        }),
      );
    }

    const sorted = sortAttentionRows(rows);
    return {
      generatedAt,
      rows: sorted,
      summary: {
        rowCount: sorted.length,
        criticalCount: sorted.filter((row) => row.severity === "critical").length,
        attentionCount: sorted.filter((row) => row.severity === "attention").length,
        watchCount: sorted.filter((row) => row.severity === "watch").length,
      },
    };
  },
});
