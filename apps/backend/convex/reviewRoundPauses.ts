import { ConvexError, v } from "convex/values";
import { z } from "zod";

import { mutation } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireFreshAuthSession,
  sensitiveCommandSessionMaxAgeMs,
} from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
} from "./lib/operations";
import { requirePermission } from "./lib/permissions";
import { activeRoundPause } from "./lib/reviewRoundPauses";
import { normalizedText } from "./lib/strings";

const pauseResult = v.object({
  pauseId: v.id("reviewRoundPauses"),
  pauseVersion: v.number(),
  roundVersion: v.number(),
});

const pauseOperationResult = z
  .object({
    pauseVersion: z.number().int().positive(),
    roundVersion: z.number().int().positive(),
  })
  .strict();

export const pause = mutation({
  args: {
    eventSlug: v.string(),
    roundId: v.id("reviewRounds"),
    incidentId: v.id("incidents"),
    expectedRoundVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: pauseResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const reason = normalizedText(args.reason, "Pause reason", 5, 300);
    const requestFingerprint = operationFingerprint([
      args.roundId,
      args.incidentId,
      args.expectedRoundVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round.pause",
      requestFingerprint,
    });
    if (prior) {
      const pauseId = ctx.db.normalizeId("reviewRoundPauses", prior.targetId);
      if (!pauseId) throw new Error("Prior round pause result is invalid.");
      return {
        pauseId,
        ...storedOperationResult(
          prior.resultJson,
          "round-pause",
          pauseOperationResult,
        ),
      };
    }

    const subject = await requireEventSubject(ctx, event._id, person._id);
    const [round, incident] = await Promise.all([
      ctx.db.get("reviewRounds", args.roundId),
      ctx.db.get("incidents", args.incidentId),
    ]);
    if (!round || round.eventId !== event._id) {
      throw new ConvexError({
        code: "ROUND_NOT_FOUND",
        message: "That review round is unavailable.",
      });
    }
    if (!incident || incident.eventId !== event._id) {
      throw new ConvexError({
        code: "INCIDENT_NOT_FOUND",
        message: "That incident is unavailable.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.round.pause",
      scopeType: "round",
      scopeId: round._id,
    });
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "incident.read",
      scopeType: "incident",
      scopeId: incident._id,
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    if (round.status !== "open" || round.version !== args.expectedRoundVersion) {
      throw new ConvexError({
        code: "ROUND_CHANGED",
        message: "Only the current open round can be paused. Refresh and try again.",
      });
    }
    if (incident.affectedService !== "review_backend" || incident.state === "resolved") {
      throw new ConvexError({
        code: "INCIDENT_NOT_ACTIVE",
        message: "Choose an active review incident.",
      });
    }
    if (await activeRoundPause(ctx, round._id)) {
      throw new ConvexError({
        code: "ROUND_ALREADY_PAUSED",
        message: "New review starts are already paused for this round.",
      });
    }

    const now = Date.now();
    const pauseId = await ctx.db.insert("reviewRoundPauses", {
      eventId: event._id,
      roundId: round._id,
      incidentId: incident._id,
      state: "active",
      reason,
      pausedByPersonId: person._id,
      pausedAt: now,
      version: 1,
    });
    const roundVersion = round.version + 1;
    await ctx.db.patch("reviewRounds", round._id, { version: roundVersion });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round.pause",
      requestFingerprint,
      targetType: "review_round_pause",
      targetId: pauseId,
      resultJson: JSON.stringify({ pauseVersion: 1, roundVersion }),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.round.pause",
      grantIds,
      scopeType: "round",
      scopeId: round._id,
      action: "review.round_paused",
      targetType: "review_round_pause",
      targetId: pauseId,
      previousSummary: JSON.stringify({
        status: round.status,
        version: round.version,
      }),
      nextSummary: JSON.stringify({
        status: round.status,
        version: roundVersion,
        incidentId: incident._id,
        pauseId,
      }),
      reason,
    });
    return { pauseId, pauseVersion: 1, roundVersion };
  },
});

export const resume = mutation({
  args: {
    eventSlug: v.string(),
    pauseId: v.id("reviewRoundPauses"),
    expectedPauseVersion: v.number(),
    expectedRoundVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: pauseResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const reason = normalizedText(args.reason, "Resume reason", 5, 300);
    const requestFingerprint = operationFingerprint([
      args.pauseId,
      args.expectedPauseVersion,
      args.expectedRoundVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round.resume",
      requestFingerprint,
    });
    if (prior) {
      const pauseId = ctx.db.normalizeId("reviewRoundPauses", prior.targetId);
      if (!pauseId) throw new Error("Prior round resume result is invalid.");
      return {
        pauseId,
        ...storedOperationResult(
          prior.resultJson,
          "round-resume",
          pauseOperationResult,
        ),
      };
    }

    const subject = await requireEventSubject(ctx, event._id, person._id);
    const pause = await ctx.db.get("reviewRoundPauses", args.pauseId);
    if (!pause || pause.eventId !== event._id) {
      throw new ConvexError({
        code: "ROUND_PAUSE_NOT_FOUND",
        message: "That round pause is unavailable.",
      });
    }
    const round = await ctx.db.get("reviewRounds", pause.roundId);
    if (!round || round.eventId !== event._id) {
      throw new Error("The paused round no longer resolves.");
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.round.resume",
      scopeType: "round",
      scopeId: round._id,
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    if (
      pause.state !== "active" ||
      pause.version !== args.expectedPauseVersion ||
      round.status !== "open" ||
      round.version !== args.expectedRoundVersion
    ) {
      throw new ConvexError({
        code: "ROUND_PAUSE_CHANGED",
        message: "The round or its pause changed. Refresh and try again.",
      });
    }

    const now = Date.now();
    const pauseVersion = pause.version + 1;
    const roundVersion = round.version + 1;
    await Promise.all([
      ctx.db.patch("reviewRoundPauses", pause._id, {
        state: "resolved",
        resumedByPersonId: person._id,
        resumedAt: now,
        resumeReason: reason,
        version: pauseVersion,
      }),
      ctx.db.patch("reviewRounds", round._id, { version: roundVersion }),
    ]);
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round.resume",
      requestFingerprint,
      targetType: "review_round_pause",
      targetId: pause._id,
      resultJson: JSON.stringify({ pauseVersion, roundVersion }),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.round.resume",
      grantIds,
      scopeType: "round",
      scopeId: round._id,
      action: "review.round_resumed",
      targetType: "review_round_pause",
      targetId: pause._id,
      previousSummary: JSON.stringify({
        status: pause.state,
        pauseVersion: pause.version,
        roundVersion: round.version,
      }),
      nextSummary: JSON.stringify({
        status: "resolved",
        pauseVersion,
        roundVersion,
      }),
      reason,
    });
    return { pauseId: pause._id, pauseVersion, roundVersion };
  },
});
