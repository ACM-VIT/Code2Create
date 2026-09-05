import {
  discordSupportAcknowledgeSignatureContext,
  discordSupportBridgeProtocolVersion,
  discordSupportPullSignatureContext,
  discordSupportRejectSignatureContext,
  discordSupportReplySignatureContext,
  verifyServiceBody,
} from "@code2create/domain";
import { v } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { env, httpAction, internalMutation } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { HttpBodyTooLargeError, readBoundedRequestText } from "./lib/boundedHttpBody";
import { requireEventBySlug } from "./lib/events";
import { bridgeSettingsOf, findBridgeSettings } from "./supportDiscordConfiguration";
import { requireEventSubject } from "./lib/identity";
import { requirePermission } from "./lib/permissions";
import { normalizedLongText, normalizedText } from "./lib/strings";
import { insertSupportCaseAction } from "./lib/supportCaseActions";
import {
  supportCaseCounterSource,
  updateSupportCaseStats,
} from "./support";
import { supportCaseCategory, supportCaseState } from "./values";

const maximumSignatureAgeMs = 5 * 60 * 1_000;
const claimLeaseMs = 30_000;
const maximumClaimCandidates = 16;
const maximumExpiredClaimsPerPull = 8;

const supportActionKind = v.union(
  v.literal("opened"),
  v.literal("reporter_reply"),
  v.literal("public_note"),
  v.literal("internal_note"),
  v.literal("state_changed"),
  v.literal("owner_changed"),
);

const discordDelivery = v.object({
  id: v.id("supportDiscordOutbox"),
  claimId: v.string(),
  action: v.object({
    id: v.id("supportCaseActions"),
    kind: supportActionKind,
    visibility: v.union(v.literal("reporter"), v.literal("internal")),
    actorName: v.string(),
    body: v.optional(v.string()),
    previousState: v.optional(supportCaseState),
    nextState: v.optional(supportCaseState),
    previousOwnerName: v.optional(v.string()),
    nextOwnerName: v.optional(v.string()),
    createdAt: v.number(),
  }),
  supportCase: v.object({
    id: v.id("supportCases"),
    publicCode: v.string(),
    category: supportCaseCategory,
    origin: v.union(v.literal("participant"), v.literal("reviewer"), v.literal("staff")),
    state: supportCaseState,
    reporterName: v.string(),
    contactEmail: v.string(),
    teamName: v.optional(v.string()),
    roundName: v.optional(v.string()),
    createdAt: v.number(),
  }),
  discordChannelId: v.optional(v.string()),
});

const pullSchema = z
  .object({
    protocolVersion: z.literal(discordSupportBridgeProtocolVersion),
    eventSlug: z.string().min(2).max(80),
  })
  .strict();

const acknowledgeSchema = z
  .object({
    protocolVersion: z.literal(discordSupportBridgeProtocolVersion),
    deliveryId: z.string().min(1).max(200),
    claimId: z.uuid(),
    discordGuildId: z.string().regex(/^\d{6,32}$/u),
    discordChannelId: z.string().regex(/^\d{6,32}$/u),
    discordMessageId: z.string().regex(/^\d{6,32}$/u),
  })
  .strict();

const rejectSchema = z
  .object({
    protocolVersion: z.literal(discordSupportBridgeProtocolVersion),
    deliveryId: z.string().min(1).max(200),
    claimId: z.uuid(),
    errorCode: z.string().regex(/^[a-z0-9_]{2,80}$/u),
  })
  .strict();

const replySchema = z
  .object({
    protocolVersion: z.literal(discordSupportBridgeProtocolVersion),
    eventSlug: z.string().min(2).max(80),
    discordGuildId: z.string().regex(/^\d{6,32}$/u),
    discordChannelId: z.string().regex(/^\d{6,32}$/u),
    discordMessageId: z.string().regex(/^\d{6,32}$/u),
    discordUserId: z.string().regex(/^\d{6,32}$/u),
    discordDisplayName: z.string().min(1).max(80),
    message: z.string().min(1).max(2_000),
  })
  .strict();

function bridgeSecret() {
  const secret = env.DISCORD_SUPPORT_BRIDGE_SECRET?.trim();
  if (!secret || new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error("DISCORD_SUPPORT_BRIDGE_SECRET is unavailable.");
  }
  return secret;
}

function bridgeActorEmail() {
  const email = env.DISCORD_SUPPORT_ACTOR_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error("DISCORD_SUPPORT_ACTOR_EMAIL is unavailable.");
  return email;
}

async function verifiedBody(request: Request, context: string) {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    return { response: Response.json({ error: "unsupported_media_type" }, { status: 415 }) };
  }
  let body: string;
  try {
    body = await readBoundedRequestText(request, 16 * 1_024);
  } catch (error) {
    if (error instanceof HttpBodyTooLargeError) {
      return { response: Response.json({ error: "payload_too_large" }, { status: 413 }) };
    }
    throw error;
  }
  let verified = false;
  try {
    verified = await verifyServiceBody({
      context,
      secret: bridgeSecret(),
      timestamp: request.headers.get("x-c2c-timestamp") ?? "",
      signature: request.headers.get("x-c2c-signature") ?? "",
      body,
      now: Date.now(),
      maximumAgeMs: maximumSignatureAgeMs,
    });
  } catch {
    return { response: Response.json({ error: "service_unavailable" }, { status: 503 }) };
  }
  if (!verified) return { response: Response.json({ error: "unauthorized" }, { status: 401 }) };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { response: Response.json({ error: "invalid_json" }, { status: 400 }) };
  }
  return { json };
}

async function deliveryView(
  ctx: MutationCtx,
  delivery: Doc<"supportDiscordOutbox">,
  supportCase: Doc<"supportCases">,
  action: Doc<"supportCaseActions">,
  channel: Doc<"supportDiscordChannels"> | null,
) {
  const [reporter, actor, team, round, previousOwner, nextOwner] = await Promise.all([
    ctx.db.get("people", supportCase.reporterPersonId),
    ctx.db.get("people", action.actorPersonId),
    supportCase.teamId === undefined ? null : ctx.db.get("teams", supportCase.teamId),
    supportCase.roundId === undefined ? null : ctx.db.get("reviewRounds", supportCase.roundId),
    action.previousOwnerPersonId === undefined
      ? null
      : ctx.db.get("people", action.previousOwnerPersonId),
    action.nextOwnerPersonId === undefined
      ? null
      : ctx.db.get("people", action.nextOwnerPersonId),
  ]);
  return {
    id: delivery._id,
    claimId: delivery.claimId ?? "",
    action: {
      id: action._id,
      kind: action.kind,
      visibility: action.visibility,
      actorName: action.externalActor?.displayName ?? actor?.displayName ?? "Event member",
      ...(action.body === undefined ? {} : { body: action.body }),
      ...(action.previousState === undefined ? {} : { previousState: action.previousState }),
      ...(action.nextState === undefined ? {} : { nextState: action.nextState }),
      ...(previousOwner === null ? {} : { previousOwnerName: previousOwner.displayName }),
      ...(nextOwner === null ? {} : { nextOwnerName: nextOwner.displayName }),
      createdAt: action.createdAt,
    },
    supportCase: {
      id: supportCase._id,
      publicCode: supportCase.publicCode,
      category: supportCase.category,
      origin: supportCase.origin,
      state: supportCase.state,
      reporterName: reporter?.displayName ?? "Event member",
      contactEmail: supportCase.contactEmail,
      ...(team === null ? {} : { teamName: team.name }),
      ...(round === null ? {} : { roundName: round.name }),
      createdAt: supportCase.createdAt,
    },
    ...(channel === null ? {} : { discordChannelId: channel.discordChannelId }),
  };
}

/**
 * The bridge settings ride along with every poll rather than having an endpoint
 * of their own: the bot already asks for work continuously, so this is the
 * channel that is always open, and it costs nothing to answer with.
 */
const bridgeSettings = v.object({
  reactionsEnabled: v.boolean(),
  allowedRoleIds: v.array(v.string()),
});

export const claimNext = internalMutation({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.object({ state: v.literal("idle"), settings: bridgeSettings }),
    v.object({
      state: v.literal("work"),
      delivery: discordDelivery,
      settings: bridgeSettings,
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const now = Date.now();
    const expired = await ctx.db
      .query("supportDiscordOutbox")
      .withIndex("by_event_and_state_and_claim_expiry", (index) =>
        index
          .eq("eventId", event._id)
          .eq("state", "claimed")
          .lte("claimExpiresAt", now),
      )
      .take(maximumExpiredClaimsPerPull);
    for (const row of expired) {
      await ctx.db.patch(row._id, {
        state: "pending",
        claimId: undefined,
        claimExpiresAt: undefined,
        nextAttemptAt: now,
        updatedAt: now,
      });
    }
    const settings = bridgeSettingsOf(await findBridgeSettings(ctx, event._id));
    const candidates = await ctx.db
      .query("supportDiscordOutbox")
      .withIndex("by_event_and_state_and_next_attempt", (index) =>
        index.eq("eventId", event._id).eq("state", "pending").lte("nextAttemptAt", now),
      )
      .take(maximumClaimCandidates);
    for (const delivery of candidates) {
      const [supportCase, action, channel] = await Promise.all([
        ctx.db.get("supportCases", delivery.supportCaseId),
        ctx.db.get("supportCaseActions", delivery.supportCaseActionId),
        ctx.db
          .query("supportDiscordChannels")
          .withIndex("by_support_case", (index) =>
            index.eq("supportCaseId", delivery.supportCaseId),
          )
          .unique(),
      ]);
      if (supportCase === null || action === null) {
        throw new Error("A Discord support delivery lost its source action.");
      }
      if (action.kind !== "opened" && channel === null) continue;
      const claimId = crypto.randomUUID();
      await ctx.db.patch(delivery._id, {
        state: "claimed",
        claimId,
        claimExpiresAt: now + claimLeaseMs,
        attemptCount: delivery.attemptCount + 1,
        updatedAt: now,
      });
      const claimed = { ...delivery, claimId, attemptCount: delivery.attemptCount + 1 };
      return {
        state: "work" as const,
        delivery: await deliveryView(ctx, claimed, supportCase, action, channel),
        settings,
      };
    }
    return { state: "idle" as const, settings };
  },
});

export const acknowledgeDelivery = internalMutation({
  args: {
    deliveryId: v.string(),
    claimId: v.string(),
    discordGuildId: v.string(),
    discordChannelId: v.string(),
    discordMessageId: v.string(),
  },
  returns: v.union(v.literal("accepted"), v.literal("already_delivered"), v.literal("stale_claim")),
  handler: async (ctx, args) => {
    const deliveryId = ctx.db.normalizeId("supportDiscordOutbox", args.deliveryId);
    if (deliveryId === null) return "stale_claim" as const;
    const delivery = await ctx.db.get("supportDiscordOutbox", deliveryId);
    if (delivery === null) return "stale_claim" as const;
    if (delivery.state === "delivered") return "already_delivered" as const;
    if (delivery.state !== "claimed" || delivery.claimId !== args.claimId) {
      return "stale_claim" as const;
    }
    const action = await ctx.db.get("supportCaseActions", delivery.supportCaseActionId);
    if (action === null) throw new Error("The Discord delivery source action is missing.");
    const existingChannel = await ctx.db
      .query("supportDiscordChannels")
      .withIndex("by_support_case", (index) => index.eq("supportCaseId", delivery.supportCaseId))
      .unique();
    if (action.kind === "opened") {
      if (existingChannel === null) {
        const duplicateChannel = await ctx.db
          .query("supportDiscordChannels")
          .withIndex("by_discord_channel", (index) =>
            index.eq("discordChannelId", args.discordChannelId),
          )
          .unique();
        if (duplicateChannel !== null) {
          throw new Error("A Discord channel is already linked to another support case.");
        }
        const now = Date.now();
        await ctx.db.insert("supportDiscordChannels", {
          eventId: delivery.eventId,
          supportCaseId: delivery.supportCaseId,
          discordGuildId: args.discordGuildId,
          discordChannelId: args.discordChannelId,
          createdAt: now,
          updatedAt: now,
        });
      } else if (
        existingChannel.discordGuildId !== args.discordGuildId ||
        existingChannel.discordChannelId !== args.discordChannelId
      ) {
        throw new Error("The support case is already linked to another Discord channel.");
      }
    } else if (
      existingChannel === null ||
      existingChannel.discordGuildId !== args.discordGuildId ||
      existingChannel.discordChannelId !== args.discordChannelId
    ) {
      throw new Error("The Discord delivery does not match its support channel.");
    }
    const now = Date.now();
    await ctx.db.patch(delivery._id, {
      state: "delivered",
      claimId: undefined,
      claimExpiresAt: undefined,
      discordMessageId: args.discordMessageId,
      updatedAt: now,
      deliveredAt: now,
    });
    return "accepted" as const;
  },
});

export const rejectDelivery = internalMutation({
  args: {
    deliveryId: v.string(),
    claimId: v.string(),
    errorCode: v.string(),
  },
  returns: v.union(v.literal("accepted"), v.literal("stale_claim")),
  handler: async (ctx, args) => {
    const deliveryId = ctx.db.normalizeId("supportDiscordOutbox", args.deliveryId);
    if (deliveryId === null) return "stale_claim" as const;
    const delivery = await ctx.db.get("supportDiscordOutbox", deliveryId);
    if (
      delivery === null ||
      delivery.state !== "claimed" ||
      delivery.claimId !== args.claimId
    ) {
      return "stale_claim" as const;
    }
    const now = Date.now();
    const delayMs = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(delivery.attemptCount, 8));
    await ctx.db.patch(delivery._id, {
      state: "pending",
      claimId: undefined,
      claimExpiresAt: undefined,
      nextAttemptAt: now + delayMs,
      lastErrorCode: normalizedText(args.errorCode, "Discord delivery error", 2, 80),
      updatedAt: now,
    });
    return "accepted" as const;
  },
});

export const recordReply = internalMutation({
  args: {
    eventSlug: v.string(),
    discordGuildId: v.string(),
    discordChannelId: v.string(),
    discordMessageId: v.string(),
    discordUserId: v.string(),
    discordDisplayName: v.string(),
    message: v.string(),
  },
  returns: v.union(
    v.object({ state: v.literal("accepted"), publicCode: v.string(), version: v.number() }),
    v.object({ state: v.literal("already_recorded"), publicCode: v.string(), version: v.number() }),
    v.object({ state: v.literal("case_closed"), publicCode: v.string(), version: v.number() }),
    v.object({ state: v.literal("channel_not_found") }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const channel = await ctx.db
      .query("supportDiscordChannels")
      .withIndex("by_discord_channel", (index) =>
        index.eq("discordChannelId", args.discordChannelId),
      )
      .unique();
    if (
      channel === null ||
      channel.eventId !== event._id ||
      channel.discordGuildId !== args.discordGuildId
    ) {
      return { state: "channel_not_found" as const };
    }
    const supportCase = await ctx.db.get("supportCases", channel.supportCaseId);
    if (supportCase === null || supportCase.eventId !== event._id) {
      throw new Error("The Discord support channel lost its support case.");
    }
    const prior = await ctx.db
      .query("supportDiscordInboundMessages")
      .withIndex("by_discord_message", (index) =>
        index.eq("discordMessageId", args.discordMessageId),
      )
      .unique();
    if (prior !== null) {
      if (prior.supportCaseId !== supportCase._id) {
        throw new Error("A Discord message is already attached to another support case.");
      }
      return {
        state: "already_recorded" as const,
        publicCode: supportCase.publicCode,
        version: supportCase.version,
      };
    }
    if (supportCase.state === "closed") {
      return {
        state: "case_closed" as const,
        publicCode: supportCase.publicCode,
        version: supportCase.version,
      };
    }
    const actor = await ctx.db
      .query("people")
      .withIndex("by_verified_email", (index) => index.eq("verifiedEmail", bridgeActorEmail()))
      .unique();
    if (actor === null || actor.status !== "active") {
      throw new Error("The Discord support actor is unavailable.");
    }
    const subject = await requireEventSubject(ctx, event._id, actor._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "support.case.manage",
      scopeType: "support_case",
      scopeId: supportCase._id,
    });
    const message = normalizedLongText(args.message, "Discord reply", 2, 2_000);
    const discordDisplayName = normalizedText(
      args.discordDisplayName,
      "Discord display name",
      1,
      80,
    );
    const now = Date.now();
    const beforeCounters = supportCaseCounterSource(supportCase);
    const afterCounters = {
      state: supportCase.state,
      category: supportCase.category,
      ...(supportCase.ownerPersonId === undefined
        ? {}
        : { ownerPersonId: supportCase.ownerPersonId }),
      awaitingStaffReply: false,
    };
    await ctx.db.patch(supportCase._id, {
      lastActionAt: now,
      ...(supportCase.firstResponseAt === undefined ? { firstResponseAt: now } : {}),
      awaitingStaffReply: false,
      version: supportCase.version + 1,
      updatedAt: now,
    });
    const actionId = await insertSupportCaseAction(
      ctx,
      {
        eventId: event._id,
        supportCaseId: supportCase._id,
        kind: "public_note",
        visibility: "reporter",
        actorPersonId: actor._id,
        body: message,
        externalActor: {
          provider: "discord",
          providerUserId: args.discordUserId,
          displayName: discordDisplayName,
        },
        createdAt: now,
      },
      { syncToDiscord: false },
    );
    await ctx.db.insert("supportDiscordInboundMessages", {
      eventId: event._id,
      supportCaseId: supportCase._id,
      supportCaseActionId: actionId,
      discordMessageId: args.discordMessageId,
      discordUserId: args.discordUserId,
      discordDisplayName,
      createdAt: now,
    });
    await updateSupportCaseStats(ctx, {
      eventId: event._id,
      supportCaseId: supportCase._id,
      before: beforeCounters,
      after: afterCounters,
      now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: actor._id,
      permissionKey: "support.case.manage",
      grantIds,
      scopeType: "support_case",
      scopeId: supportCase._id,
      action: "support.case_updated",
      targetType: "support_case",
      targetId: supportCase._id,
      previousSummary: JSON.stringify({
        state: supportCase.state,
        version: supportCase.version,
      }),
      nextSummary: JSON.stringify({
        state: supportCase.state,
        publicNoteAdded: true,
        source: "discord",
        discordUserId: args.discordUserId,
        version: supportCase.version + 1,
      }),
      reason: `Discord support reply from ${discordDisplayName}.`,
    });
    return {
      state: "accepted" as const,
      publicCode: supportCase.publicCode,
      version: supportCase.version + 1,
    };
  },
});

export const pullEndpoint = httpAction(async (ctx, request) => {
  const body = await verifiedBody(request, discordSupportPullSignatureContext);
  if (body.response) return body.response;
  const parsed = pullSchema.safeParse(body.json);
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 422 });
  const result = await ctx.runMutation(internal.supportDiscordBridge.claimNext, {
    eventSlug: parsed.data.eventSlug,
  });
  return Response.json(result);
});

export const acknowledgeEndpoint = httpAction(async (ctx, request) => {
  const body = await verifiedBody(request, discordSupportAcknowledgeSignatureContext);
  if (body.response) return body.response;
  const parsed = acknowledgeSchema.safeParse(body.json);
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 422 });
  const result = await ctx.runMutation(internal.supportDiscordBridge.acknowledgeDelivery, {
    deliveryId: parsed.data.deliveryId,
    claimId: parsed.data.claimId,
    discordGuildId: parsed.data.discordGuildId,
    discordChannelId: parsed.data.discordChannelId,
    discordMessageId: parsed.data.discordMessageId,
  });
  return Response.json({ state: result }, { status: result === "stale_claim" ? 409 : 202 });
});

export const rejectEndpoint = httpAction(async (ctx, request) => {
  const body = await verifiedBody(request, discordSupportRejectSignatureContext);
  if (body.response) return body.response;
  const parsed = rejectSchema.safeParse(body.json);
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 422 });
  const result = await ctx.runMutation(internal.supportDiscordBridge.rejectDelivery, {
    deliveryId: parsed.data.deliveryId,
    claimId: parsed.data.claimId,
    errorCode: parsed.data.errorCode,
  });
  return Response.json({ state: result }, { status: result === "stale_claim" ? 409 : 202 });
});

export const replyEndpoint = httpAction(async (ctx, request) => {
  const body = await verifiedBody(request, discordSupportReplySignatureContext);
  if (body.response) return body.response;
  const parsed = replySchema.safeParse(body.json);
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 422 });
  const result = await ctx.runMutation(internal.supportDiscordBridge.recordReply, {
    eventSlug: parsed.data.eventSlug,
    discordGuildId: parsed.data.discordGuildId,
    discordChannelId: parsed.data.discordChannelId,
    discordMessageId: parsed.data.discordMessageId,
    discordUserId: parsed.data.discordUserId,
    discordDisplayName: parsed.data.discordDisplayName,
    message: parsed.data.message,
  });
  const status = result.state === "channel_not_found" ? 404 : result.state === "case_closed" ? 409 : 202;
  return Response.json(result, { status });
});
