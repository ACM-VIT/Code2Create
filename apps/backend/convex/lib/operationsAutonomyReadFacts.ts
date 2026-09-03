import { supportCaseCategoryOrder } from "@code2create/domain";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  closeOperationsAutonomyFactVersion as closePriorFactVersion,
  nextOperationsAutonomyFactSequence as nextSequence,
} from "./operationsAutonomyReadFactLedger";
import { enqueueOperationsAutonomySignal } from "./operationsAutonomyInbox";

export function operationsAttentionIntelligenceStatement(
  detectorKey: Doc<"operationsAttentionItems">["detectorKey"],
) {
  switch (detectorKey) {
    case "panel_seat_empty":
      return "A review panel has an unfilled required seat.";
    case "seat_at_risk":
      return "A staffed review seat has an availability, heartbeat, or paging risk that needs confirmation.";
    case "review_overdue":
      return "A review is past its planned end time.";
    case "review_presence_incomplete":
      return "A review is waiting for required reviewer presence.";
    case "team_below_minimum":
      return "A queued team is below the round's participant-availability minimum.";
    case "team_held":
      return "A team is on hold in the review queue.";
    case "team_call_overdue":
      return "A called team has passed its arrival grace period.";
    case "team_waiting_long":
      return "A team has waited longer than two configured review durations.";
    case "round_finish_forecast":
      return "The current review pace is forecast to finish after the round window.";
    case "panel_bottleneck":
      return "One review panel is forecast to finish materially later than the other panels.";
    case "scorecard_outstanding":
      return "A completed review is still waiting for one or more reviewer submissions.";
  }
}

export async function appendOperationsAttentionReadFact(
  ctx: MutationCtx,
  row: Doc<"operationsAttentionItems">,
  now: number,
) {
  const source = "operations_attention" as const;
  const entityKey = `attention:${row._id}`;
  const sequence = await nextSequence(ctx, row.eventId, source, now);
  await closePriorFactVersion(ctx, { eventId: row.eventId, source, entityKey, sequence });
  await ctx.db.insert("operationsAutonomyReadFacts", {
    eventId: row.eventId,
    source,
    entityKey,
    sequence,
    value: {
      itemId: row._id,
      detectorKey: row.detectorKey,
      subjectType: row.subjectType,
      severity: row.severity,
      state: row.state,
      version: row.version,
      recurrenceCount: row.recurrenceCount,
      firstObservedAt: row.firstObservedAt,
      lastObservedAt: row.lastObservedAt,
    },
    createdAt: now,
  });
}

export async function appendOperationsAttentionReadFactById(
  ctx: MutationCtx,
  itemId: Id<"operationsAttentionItems">,
  now: number,
) {
  const row = await ctx.db.get(itemId);
  if (!row) throw new Error("The operations-attention item is missing after its write.");
  await appendOperationsAttentionReadFact(ctx, row, now);
}

function reviewTeamFact(row: Doc<"teamRoundStates">) {
  return {
    kind: "team" as const,
    teamRoundStateId: row._id,
    roundId: row.roundId,
    state: row.state,
    version: row.version,
    callAttemptCount: row.callAttemptCount,
    ...(row.queuedAt === undefined ? {} : { queuedAt: row.queuedAt }),
    ...(row.heldAt === undefined ? {} : { heldAt: row.heldAt }),
    ...(row.missedAt === undefined ? {} : { missedAt: row.missedAt }),
    ...(row.tableLabel === undefined ? {} : { tableLabel: row.tableLabel }),
  };
}

export async function appendTeamRoundStateReadFact(
  ctx: MutationCtx,
  row: Doc<"teamRoundStates">,
  now: number,
) {
  const source = "review_exceptions" as const;
  const entityKey = `team:${row._id}`;
  const sequence = await nextSequence(ctx, row.eventId, source, now);
  await closePriorFactVersion(ctx, { eventId: row.eventId, source, entityKey, sequence });
  await ctx.db.insert("operationsAutonomyReadFacts", {
    eventId: row.eventId,
    source,
    entityKey,
    sequence,
    value: reviewTeamFact(row),
    createdAt: now,
  });
}

export async function appendReviewPanelVacancyReadFact(
  ctx: MutationCtx,
  panel: Doc<"reviewPanels">,
  now: number,
) {
  const source = "review_exceptions" as const;
  const entityKey = `vacancy:${panel._id}`;
  const sequence = await nextSequence(ctx, panel.eventId, source, now);
  await closePriorFactVersion(ctx, { eventId: panel.eventId, source, entityKey, sequence });
  const [round, removedMember] =
    panel.status === "needs_reviewer"
      ? await Promise.all([
          ctx.db.get(panel.roundId),
          ctx.db
            .query("reviewPanelMembers")
            .withIndex("by_panel_status_ended", (index) =>
              index.eq("panelId", panel._id).eq("status", "removed"),
            )
            .order("desc")
            .first(),
        ])
      : [null, null];
  if (round && round.eventId !== panel.eventId) {
    throw new Error("The review panel round is outside its event.");
  }
  await ctx.db.insert("operationsAutonomyReadFacts", {
    eventId: panel.eventId,
    source,
    entityKey,
    sequence,
    value:
      round && removedMember
        ? {
            kind: "vacancy" as const,
            missingPanelMemberId: removedMember._id,
            panelId: panel._id,
            panelName: panel.name,
            panelVersion: panel.version,
            roundId: round._id,
            roundName: round.name,
            ...(removedMember.endedAt === undefined ? {} : { vacantSince: removedMember.endedAt }),
          }
        : { kind: "absent" as const },
    createdAt: now,
  });
}

export async function appendReviewPanelVacancyReadFactById(
  ctx: MutationCtx,
  panelId: Id<"reviewPanels">,
  now: number,
) {
  const panel = await ctx.db.get(panelId);
  if (!panel) throw new Error("The review panel is missing after its write.");
  await appendReviewPanelVacancyReadFact(ctx, panel, now);
}

function activeSupportState(state: Doc<"supportCases">["state"]) {
  return state === "open" || state === "investigating" || state === "waiting";
}

function emptySupportState() {
  return {
    open: 0,
    investigating: 0,
    waiting: 0,
    resolved: 0,
    closed: 0,
  } satisfies Record<Doc<"supportCases">["state"], number>;
}

function supportCategoryCounts(
  current: Extract<Doc<"operationsAutonomyReadFactStates">, { source: "support_load" }> | null,
) {
  const counts = new Map(
    supportCaseCategoryOrder.map((category) => [category, 0 as number] as const),
  );
  for (const row of current?.openByCategory ?? []) counts.set(row.category, row.count);
  return counts;
}

export async function appendSupportCaseReadFact(
  ctx: MutationCtx,
  args: {
    before?: Doc<"supportCases">;
    after: Doc<"supportCases">;
    now: number;
  },
) {
  const { before, after, now } = args;
  if (before && before._id !== after._id) {
    throw new Error("A support read fact cannot change case identity.");
  }
  const source = "support_load" as const;
  const current = await ctx.db
    .query("operationsAutonomyReadFactStates")
    .withIndex("by_event_source", (index) =>
      index.eq("eventId", after.eventId).eq("source", source),
    )
    .unique();
  if (current && current.source !== source) {
    throw new Error("The support read fact state has the wrong source shape.");
  }
  if (!current && before) {
    throw new Error("Support read facts are missing for an existing support case.");
  }
  const byState = current ? { ...current.byState } : emptySupportState();
  const categories = supportCategoryCounts(current);
  let unassignedActiveCount = current?.unassignedActiveCount ?? 0;
  if (before) {
    byState[before.state] -= 1;
    if (before.state === "open") {
      categories.set(before.category, (categories.get(before.category) ?? 0) - 1);
    }
    if (activeSupportState(before.state) && before.ownerPersonId === undefined) {
      unassignedActiveCount -= 1;
    }
  }
  byState[after.state] += 1;
  if (after.state === "open") {
    categories.set(after.category, (categories.get(after.category) ?? 0) + 1);
  }
  if (activeSupportState(after.state) && after.ownerPersonId === undefined) {
    unassignedActiveCount += 1;
  }
  const values = [...Object.values(byState), ...categories.values(), unassignedActiveCount];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("A support autonomy counter would become invalid.");
  }
  const oldestOpen = await ctx.db
    .query("supportCases")
    .withIndex("by_event_state_created", (index) =>
      index.eq("eventId", after.eventId).eq("state", "open"),
    )
    .order("asc")
    .first();
  const sequence = (current?.sequence ?? 0) + 1;
  const state = {
    sequence,
    byState,
    openByCategory: supportCaseCategoryOrder.flatMap((category) => {
      const count = categories.get(category) ?? 0;
      return count === 0 ? [] : [{ category, count }];
    }),
    unassignedActiveCount,
    ...(oldestOpen ? { oldestOpenAt: oldestOpen.createdAt } : {}),
    updatedAt: now,
  };
  if (current) await ctx.db.patch(current._id, state);
  else
    await ctx.db.insert("operationsAutonomyReadFactStates", {
      eventId: after.eventId,
      source,
      ...state,
    });
  const health = await ctx.db
    .query("operationsHealthSnapshots")
    .withIndex("by_event", (index) => index.eq("eventId", after.eventId))
    .unique();
  if (health) {
    await enqueueOperationsAutonomySignal(ctx, {
      eventId: after.eventId,
      snapshot: health.snapshot,
      now,
    });
  }
  const entityKey = `case:${after._id}`;
  await closePriorFactVersion(ctx, {
    eventId: after.eventId,
    source,
    entityKey,
    sequence,
  });
  await ctx.db.insert("operationsAutonomyReadFacts", {
    eventId: after.eventId,
    source,
    entityKey,
    sequence,
    value: {
      caseId: after._id,
      category: after.category,
      state: after.state,
      createdAt: after.createdAt,
      ...(after.teamId === undefined ? {} : { teamId: after.teamId }),
      ...(after.roundId === undefined ? {} : { roundId: after.roundId }),
    },
    createdAt: now,
  });
}

export async function appendSupportCaseReadFactById(
  ctx: MutationCtx,
  args: {
    caseId: Id<"supportCases">;
    before?: Doc<"supportCases">;
    now: number;
  },
) {
  const after = await ctx.db.get(args.caseId);
  if (!after) throw new Error("The support case is missing after its write.");
  await appendSupportCaseReadFact(ctx, {
    ...(args.before === undefined ? {} : { before: args.before }),
    after,
    now: args.now,
  });
}
