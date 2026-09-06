import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
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
import { normalizedText } from "./lib/strings";
import { writeAuditEvent } from "./lib/audit";
import { maximumReviewTeamsPerEvent } from "./lib/reviewLimits";
import { isProgressionPublished, requireProgressionEditable } from "./lib/reviewProgression";
import { reviewProgressionScoreReference } from "./values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

const mode = v.union(v.literal("all_advance"), v.literal("elimination"));
const outcome = v.union(v.literal("advance"), v.literal("eliminate"));
const decision = v.object({
  teamId: v.id("teams"),
  outcome,
  reason: v.string(),
});
const argsBase = { eventSlug: v.string(), roundId: v.id("reviewRounds") };

async function context(
  ctx: QueryCtx | MutationCtx,
  args: { eventSlug: string; roundId: Id<"reviewRounds"> },
) {
  const event = await requireEventBySlug(ctx, args.eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const round = await ctx.db.get(args.roundId);
  if (!round || round.eventId !== event._id)
    throw new ConvexError({
      code: "ROUND_NOT_FOUND",
      message: "Review round unavailable.",
    });
  return { event, person, subject, round };
}

async function results(
  ctx: QueryCtx | MutationCtx,
  round: Doc<"reviewRounds">,
) {
  if (round.status !== "closed" || !round.activeCloseSnapshotId) return [];
  const snapshotId = round.activeCloseSnapshotId;
  const entries = await ctx.db
    .query("roundCloseEntries")
    .withIndex("by_snapshot_team", (q) => q.eq("closeSnapshotId", snapshotId))
    .take(maximumReviewTeamsPerEvent + 1);
  if (entries.length > maximumReviewTeamsPerEvent)
    throw new Error("Review team limit exceeded.");
  const rows = await Promise.all(
    entries.map(async (entry) => {
      const team = await ctx.db.get(entry.teamId);
      if (!team || team.eventId !== round.eventId)
        throw new Error("Round result team unavailable.");
      if (team.competitionCategory === "oc") return null;
      return {
        teamId: team._id,
        name: team.name,
        kind: entry.payload.kind,
        points:
          entry.payload.kind === "result" ? entry.payload.totalPoints : null,
      };
    }),
  );
  return rows
    .filter((row) => row !== null)
    .sort(
      (a, b) =>
        (b.points ?? -1) - (a.points ?? -1) || a.name.localeCompare(b.name),
    );
}

export const workspace = query({
  args: argsBase,
  returns: v.object({
    roundId: v.id("reviewRounds"),
    roundName: v.string(),
    roundVersion: v.number(),
    roundStatus: v.string(),
    mode,
    version: v.number(),
    canManage: v.boolean(),
    canReadScores: v.boolean(),
    closeSnapshotId: v.union(v.id("roundCloseSnapshots"), v.null()),
    published: v.boolean(),
    teams: v.array(
      v.object({
        teamId: v.id("teams"),
        name: v.string(),
        kind: v.string(),
        points: v.union(v.number(), v.null()),
        outcome: v.union(outcome, v.null()),
        reason: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const { event, subject, round } = await context(ctx, args);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.read",
      scopeType: "round",
      scopeId: round._id,
    });
    const [policy, manage, scores] = await Promise.all([
      ctx.db
        .query("reviewProgressions")
        .withIndex("by_event_round", (q) =>
          q.eq("eventId", event._id).eq("roundId", round._id),
        )
        .unique(),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "round.close",
        scopeType: "round",
        scopeId: round._id,
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "score.values.read",
        scopeType: "round",
        scopeId: round._id,
      }),
    ]);
    const published = await isProgressionPublished(ctx, round, policy);
    const entries =
      policy && published
        ? await ctx.db
            .query("reviewProgressionEntries")
            .withIndex("by_progression_team", (q) =>
              q.eq("progressionId", policy._id),
            )
            .take(maximumReviewTeamsPerEvent + 1)
        : [];
    if (entries.length > maximumReviewTeamsPerEvent)
      throw new Error("Review team limit exceeded.");
    const byTeam = new Map(entries.map((entry) => [entry.teamId, entry]));
    return {
      roundId: round._id,
      roundName: round.name,
      roundVersion: round.version,
      roundStatus: round.status,
      mode: policy?.mode ?? ("all_advance" as const),
      version: policy?.version ?? 0,
      canManage: manage.length > 0,
      canReadScores: scores.length > 0,
      closeSnapshotId:
        round.status === "closed"
          ? (round.activeCloseSnapshotId ?? null)
          : null,
      published,
      teams: scores.length
        ? (await results(ctx, round)).map((row) => ({
            ...row,
            outcome: byTeam.get(row.teamId)?.outcome ?? null,
            reason: byTeam.get(row.teamId)?.reason ?? "",
          }))
        : [],
    };
  },
});

export const configure = mutation({
  args: {
    ...argsBase,
    mode,
    expectedVersion: v.number(),
    expectedRoundVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject, round } = await context(ctx, args);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.close",
      scopeType: "round",
      scopeId: round._id,
    });
    const reason = normalizedText(args.reason, "Reason", 5, 500);
    const operation = {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.progression.configure",
      requestFingerprint: operationFingerprint([
        round._id,
        args.mode,
        args.expectedVersion,
        args.expectedRoundVersion,
        reason,
      ]),
    };
    const prior = await findOperation(ctx, operation);
    if (prior)
      return {
        version: storedOperationVersion(prior.resultJson, "progression policy"),
      };
    const policy = await ctx.db
      .query("reviewProgressions")
      .withIndex("by_event_round", (q) =>
        q.eq("eventId", event._id).eq("roundId", round._id),
      )
      .unique();
    if (
      (policy?.version ?? 0) !== args.expectedVersion ||
      round.version !== args.expectedRoundVersion
    )
      throw new ConvexError({
        code: "PROGRESSION_CHANGED",
        message:
          "The round or progression settings changed. Refresh before saving.",
      });
    await requireProgressionEditable(ctx, round);
    const version = args.expectedVersion + 1;
    const now = Date.now();
    const fields = {
      mode: args.mode,
      version,
      updatedByPersonId: person._id,
      updatedAt: now,
      reason,
    };
    const id =
      policy?._id ??
      (await ctx.db.insert("reviewProgressions", {
        eventId: event._id,
        roundId: round._id,
        ...fields,
      }));
    if (policy)
      await ctx.db.patch(policy._id, {
        ...fields,
        closeSnapshotId: undefined,
        publishedAt: undefined,
        scoreReference: undefined,
      });
    await recordOperation(ctx, {
      ...operation,
      targetType: "review_progression",
      targetId: id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "round.close",
      grantIds,
      scopeType: "round",
      scopeId: round._id,
      action: "review.progression_configured",
      targetType: "review_progression",
      targetId: id,
      previousSummary: JSON.stringify({
        mode: policy?.mode ?? "all_advance",
        version: args.expectedVersion,
      }),
      nextSummary: JSON.stringify(fields),
      reason,
    });
    return { version };
  },
});

export const publish = mutation({
  args: {
    ...argsBase,
    expectedVersion: v.number(),
    expectedRoundVersion: v.number(),
    closeSnapshotId: v.id("roundCloseSnapshots"),
    decisions: v.array(decision),
    scoreReference: v.optional(reviewProgressionScoreReference),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject, round } = await context(ctx, args);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.close",
      scopeType: "round",
      scopeId: round._id,
    });
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "score.values.read",
      scopeType: "round",
      scopeId: round._id,
    });
    const reason = normalizedText(args.reason, "Decision reason", 5, 500);
    const operation = {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.progression.publish",
      requestFingerprint: operationFingerprint([
        round._id,
        args.expectedVersion,
        args.expectedRoundVersion,
        args.closeSnapshotId,
        JSON.stringify(args.decisions),
        JSON.stringify(args.scoreReference ?? null),
        reason,
      ]),
    };
    const prior = await findOperation(ctx, operation);
    if (prior)
      return {
        version: storedOperationVersion(
          prior.resultJson,
          "progression decisions",
        ),
      };
    const policy = await ctx.db
      .query("reviewProgressions")
      .withIndex("by_event_round", (q) =>
        q.eq("eventId", event._id).eq("roundId", round._id),
      )
      .unique();
    if (
      !policy ||
      policy.mode !== "elimination" ||
      policy.version !== args.expectedVersion ||
      round.version !== args.expectedRoundVersion
    )
      throw new ConvexError({
        code: "PROGRESSION_CHANGED",
        message:
          "The elimination settings or results changed. Refresh before applying decisions.",
      });
    if (
      round.status !== "closed" ||
      round.activeCloseSnapshotId !== args.closeSnapshotId
    )
      throw new ConvexError({
        code: "ROUND_NOT_FINAL",
        message: "Close and verify this round before deciding who advances.",
      });
    await requireProgressionEditable(ctx, round);
    if (args.scoreReference) {
      const aggregation = await ctx.db
        .query("reviewAggregationPolicies")
        .withIndex("by_event_status", (q) =>
          q.eq("eventId", event._id).eq("status", "published"),
        )
        .unique();
      const references = args.scoreReference.rounds;
      if (
        !aggregation ||
        aggregation.version !== args.scoreReference.policyVersion ||
        references.length !== aggregation.rounds.length ||
        new Set(references.map((r) => r.roundId)).size !== references.length ||
        aggregation.rounds.some(
          (r) => !references.some((ref) => ref.roundId === r.roundId),
        )
      )
        throw new ConvexError({
          code: "SCORE_REFERENCE_CHANGED",
          message:
            "The combined-score weights changed. Review the proposal again.",
        });
      for (const ref of references) {
        await requirePermission(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "score.values.read",
          scopeType: "round",
          scopeId: ref.roundId,
        });
        const source = await ctx.db.get(ref.roundId);
        if (
          !source ||
          source.eventId !== event._id ||
          source.status !== "closed" ||
          source.activeCloseSnapshotId !== ref.closeSnapshotId
        )
          throw new ConvexError({
            code: "SCORE_REFERENCE_CHANGED",
            message:
              "A contributing round changed. Review the combined scores again.",
          });
      }
    }
    const rows = await results(ctx, round);
    const byTeam = new Map(
      args.decisions.map((entry) => [entry.teamId, entry]),
    );
    if (
      !rows.length ||
      byTeam.size !== args.decisions.length ||
      rows.length !== byTeam.size ||
      rows.some((row) => !byTeam.has(row.teamId))
    )
      throw new ConvexError({
        code: "DECISIONS_INCOMPLETE",
        message:
          "Choose an outcome for every competitive team in this round, without duplicates or other teams.",
      });
    const normalized = args.decisions.map((entry) => ({
      ...entry,
      reason: normalizedText(entry.reason, "Team decision reason", 5, 500),
    }));
    const previous = await ctx.db
      .query("reviewProgressionEntries")
      .withIndex("by_progression_team", (q) =>
        q.eq("progressionId", policy._id),
      )
      .take(maximumReviewTeamsPerEvent + 1);
    if (previous.length > maximumReviewTeamsPerEvent)
      throw new Error("Review team limit exceeded.");
    for (const entry of previous) await ctx.db.delete(entry._id);
    for (const entry of normalized)
      await ctx.db.insert("reviewProgressionEntries", {
        eventId: event._id,
        roundId: round._id,
        progressionId: policy._id,
        ...entry,
      });
    const version = policy.version + 1;
    const now = Date.now();
    await ctx.db.patch(policy._id, {
      closeSnapshotId: args.closeSnapshotId,
      scoreReference: args.scoreReference,
      publishedAt: now,
      version,
      updatedByPersonId: person._id,
      updatedAt: now,
      reason,
    });
    await recordOperation(ctx, {
      ...operation,
      targetType: "review_progression",
      targetId: policy._id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "round.close",
      grantIds,
      scopeType: "round",
      scopeId: round._id,
      action: "review.progression_published",
      targetType: "review_progression",
      targetId: policy._id,
      previousSummary: JSON.stringify(
        previous.map(({ teamId, outcome, reason }) => ({
          teamId,
          outcome,
          reason,
        })),
      ),
      nextSummary: JSON.stringify({
        version,
        closeSnapshotId: args.closeSnapshotId,
        scoreReference: args.scoreReference,
        decisions: normalized,
      }),
      reason,
    });
    return { version };
  },
});
