import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import {
  matchingPermissionGrantIds,
  requirePermission,
} from "./lib/permissions";
import {
  maximumReviewRoundsPerEvent,
  maximumReviewTeamsPerEvent,
} from "./lib/reviewLimits";
import { normalizedText } from "./lib/strings";

const roundWeight = v.object({
  roundId: v.id("reviewRounds"),
  weight: v.number(),
});

export const configuration = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    version: v.number(),
    canPublish: v.boolean(),
    rounds: v.array(
      v.object({
        id: v.id("reviewRounds"),
        name: v.string(),
        sequence: v.number(),
        weight: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.configuration.read",
      scopeType: "event",
    });
    const [policy, rounds, grants] = await Promise.all([
      ctx.db
        .query("reviewAggregationPolicies")
        .withIndex("by_event_status", (q) =>
          q.eq("eventId", event._id).eq("status", "published"),
        )
        .unique(),
      ctx.db
        .query("reviewRounds")
        .withIndex("by_event_status_start", (q) => q.eq("eventId", event._id))
        .take(maximumReviewRoundsPerEvent + 1),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "review.configuration.publish",
        scopeType: "event",
      }),
    ]);
    if (rounds.length > maximumReviewRoundsPerEvent)
      throw new Error("Review round limit exceeded.");
    return {
      version: policy?.version ?? 0,
      canPublish: grants.length > 0,
      rounds: rounds
        .filter((round) => round.status !== "draft")
        .sort((a, b) => a.sequence - b.sequence)
        .map((round) => ({
          id: round._id,
          name: round.name,
          sequence: round.sequence,
          weight:
            policy?.rounds.find((entry) => entry.roundId === round._id)
              ?.weight ?? 0,
        })),
    };
  },
});

export const publish = mutation({
  args: {
    eventSlug: v.string(),
    rounds: v.array(roundWeight),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Reason", 3, 300);
    const requestFingerprint = operationFingerprint([
      JSON.stringify(args.rounds),
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.aggregation.publish",
      requestFingerprint,
    });
    if (prior)
      return {
        version: storedOperationVersion(prior.resultJson, "round weights"),
      };
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.configuration.publish",
      scopeType: "event",
    });
    if (
      args.rounds.length === 0 ||
      args.rounds.length > maximumReviewRoundsPerEvent ||
      new Set(args.rounds.map((entry) => entry.roundId)).size !==
        args.rounds.length ||
      args.rounds.some(
        (entry) =>
          !Number.isInteger(entry.weight) ||
          entry.weight < 1 ||
          entry.weight > 100,
      ) ||
      args.rounds.reduce((sum, entry) => sum + entry.weight, 0) !== 100
    ) {
      throw new ConvexError({
        code: "INVALID_ROUND_WEIGHTS",
        message:
          "Choose distinct rounds with positive whole-number weights totaling 100%.",
      });
    }
    const rounds = await Promise.all(
      args.rounds.map((entry) => ctx.db.get(entry.roundId)),
    );
    if (
      rounds.some(
        (round) =>
          !round || round.eventId !== event._id || round.status === "draft",
      )
    ) {
      throw new ConvexError({
        code: "INVALID_REVIEW_ROUND",
        message: "Every contributing round must be published for this event.",
      });
    }
    const current = await ctx.db
      .query("reviewAggregationPolicies")
      .withIndex("by_event_status", (q) =>
        q.eq("eventId", event._id).eq("status", "published"),
      )
      .unique();
    if ((current?.version ?? 0) !== args.expectedVersion) {
      throw new ConvexError({
        code: "AGGREGATION_CHANGED",
        message: "Round weights changed. Refresh before publishing.",
      });
    }
    const weights = [...args.rounds].sort((a, b) =>
      String(a.roundId).localeCompare(String(b.roundId)),
    );
    const now = Date.now();
    const version = args.expectedVersion + 1;
    if (current) await ctx.db.patch(current._id, { status: "superseded" });
    const policyId = await ctx.db.insert("reviewAggregationPolicies", {
      eventId: event._id,
      version,
      status: "published",
      rounds: weights,
      checksum: operationFingerprint([JSON.stringify(weights)]),
      publishedByPersonId: person._id,
      publishedAt: now,
      reason,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.aggregation.publish",
      requestFingerprint,
      targetType: "review_aggregation_policy",
      targetId: policyId,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.configuration.publish",
      grantIds,
      scopeType: "event",
      action: "review.aggregation_published",
      targetType: "review_aggregation_policy",
      targetId: policyId,
      ...(current
        ? {
            previousSummary: JSON.stringify({
              version: current.version,
              rounds: current.rounds,
            }),
          }
        : {}),
      nextSummary: JSON.stringify({ version, rounds: weights }),
      reason,
    });
    return { version };
  },
});

export const results = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    state: v.union(
      v.literal("unconfigured"),
      v.literal("hidden"),
      v.literal("awaiting_rounds"),
      v.literal("ready"),
    ),
    policyVersion: v.number(),
    rounds: v.array(
      v.object({
        roundId: v.id("reviewRounds"),
        name: v.string(),
        weight: v.number(),
      }),
    ),
    teams: v.array(
      v.object({
        teamId: v.id("teams"),
        name: v.string(),
        totalPoints: v.union(v.number(), v.null()),
        rounds: v.array(
          v.object({
            roundId: v.id("reviewRounds"),
            points: v.union(v.number(), v.null()),
            state: v.union(
              v.literal("result"),
              v.literal("excluded"),
              v.literal("withdrawn"),
              v.literal("missing"),
            ),
          }),
        ),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const policy = await ctx.db
      .query("reviewAggregationPolicies")
      .withIndex("by_event_status", (q) =>
        q.eq("eventId", event._id).eq("status", "published"),
      )
      .unique();
    if (!policy)
      return {
        state: "unconfigured" as const,
        policyVersion: 0,
        rounds: [],
        teams: [],
      };
    const grants = await Promise.all(
      policy.rounds.map((entry) =>
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "score.values.read",
          scopeType: "round",
          scopeId: entry.roundId,
        }),
      ),
    );
    if (grants.some((ids) => ids.length === 0))
      return {
        state: "hidden" as const,
        policyVersion: 0,
        rounds: [],
        teams: [],
      };
    const rounds = await Promise.all(
      policy.rounds.map(async (entry) => {
        const round = await ctx.db.get(entry.roundId);
        if (!round || round.eventId !== event._id)
          throw new Error("Aggregation round is missing.");
        return { ...entry, round };
      }),
    );
    rounds.sort((a, b) => a.round.sequence - b.round.sequence);
    const roundViews = rounds.map((entry) => ({
      roundId: entry.roundId,
      name: entry.round.name,
      weight: entry.weight,
    }));
    if (rounds.some((entry) => entry.round.status !== "closed")) {
      return {
        state: "awaiting_rounds" as const,
        policyVersion: policy.version,
        rounds: roundViews,
        teams: [],
      };
    }
    const teamIds = new Set<Id<"teams">>();
    const entriesByRound = await Promise.all(
      rounds.map(async ({ round }) => {
        const snapshotId = round.activeCloseSnapshotId;
        if (!snapshotId)
          throw new Error("A closed round has no selected outcome snapshot.");
        const entries = await ctx.db
          .query("roundCloseEntries")
          .withIndex("by_snapshot_team", (q) =>
            q.eq("closeSnapshotId", snapshotId),
          )
          .take(maximumReviewTeamsPerEvent + 1);
        if (entries.length > maximumReviewTeamsPerEvent)
          throw new Error("Review team limit exceeded.");
        const byTeam = new Map(entries.map((entry) => [entry.teamId, entry]));
        if (byTeam.size !== entries.length)
          throw new Error("A round contains duplicate team outcomes.");
        for (const entry of entries) teamIds.add(entry.teamId);
        return byTeam;
      }),
    );
    if (teamIds.size > maximumReviewTeamsPerEvent)
      throw new Error("Review team limit exceeded.");
    const teams = await Promise.all(
      [...teamIds].map(async (teamId) => {
        const team = await ctx.db.get(teamId);
        if (!team || team.eventId !== event._id)
          throw new Error("Aggregation team is missing.");
        let total = 0;
        let complete = true;
        const values = rounds.map((entry, index) => {
          const result = entriesByRound[index]?.get(teamId)?.payload;
          if (result?.kind === "result") {
            total += (result.totalPoints * entry.weight) / 100;
            return {
              roundId: entry.roundId,
              points: result.totalPoints,
              state: "result" as const,
            };
          }
          complete = false;
          return {
            roundId: entry.roundId,
            points: null,
            state: result?.kind ?? ("missing" as const),
          };
        });
        return {
          teamId,
          name: team.name,
          totalPoints: complete ? total : null,
          rounds: values,
        };
      }),
    );
    teams.sort(
      (a, b) =>
        (b.totalPoints ?? -1) - (a.totalPoints ?? -1) ||
        a.name.localeCompare(b.name),
    );
    return {
      state: "ready" as const,
      policyVersion: policy.version,
      rounds: roundViews,
      teams,
    };
  },
});
