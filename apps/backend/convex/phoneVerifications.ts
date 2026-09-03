import { normalizeParticipantPhone, participantPhoneValidationError } from "@code2create/domain";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug, requireRegistrationOpen } from "./lib/events";
import {
  requireCurrentPerson,
  requireEligibleMembership,
  requireEventSubject,
  requireMembership,
} from "./lib/identity";
import {
  constantTimeDigestEqual,
  isPhoneVerificationCode,
  maskedPhone,
  phoneVerificationCodeDigest,
  phoneVerificationLifetimeMs,
  phoneVerificationMaximumAttempts,
  phoneVerificationMaximumHourlyRequests,
  phoneVerificationRequestWindowMs,
  phoneVerificationResendDelayMs,
  requirePhoneVerificationSecret,
} from "./lib/phoneVerification";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { requirePermission } from "./lib/permissions";

const activeDeliveryStates = new Set<Doc<"participantPhoneVerifications">["status"]>([
  "queued",
  "sending",
  "sent",
  "send_failed",
]);

const clientVerificationState = v.union(
  v.literal("queued"),
  v.literal("sending"),
  v.literal("sent"),
  v.literal("verified"),
  v.literal("send_failed"),
  v.literal("expired"),
  v.literal("locked"),
);

const verificationView = v.object({
  verificationId: v.id("participantPhoneVerifications"),
  maskedPhone: v.string(),
  state: clientVerificationState,
  resendAvailableAt: v.number(),
  expiresAt: v.optional(v.number()),
  attemptsRemaining: v.number(),
  canVerify: v.boolean(),
  verifiedAt: v.optional(v.number()),
});

const verificationResult = v.union(
  v.object({
    outcome: v.literal("verified"),
    verificationId: v.id("participantPhoneVerifications"),
    maskedPhone: v.string(),
    verifiedAt: v.number(),
  }),
  v.object({
    outcome: v.literal("incorrect"),
    verificationId: v.id("participantPhoneVerifications"),
    maskedPhone: v.string(),
    attemptsRemaining: v.number(),
  }),
  v.object({
    outcome: v.literal("locked"),
    verificationId: v.id("participantPhoneVerifications"),
    maskedPhone: v.string(),
    attemptsRemaining: v.number(),
  }),
);

type VerificationResult =
  | {
      outcome: "verified";
      verificationId: Id<"participantPhoneVerifications">;
      maskedPhone: string;
      verifiedAt: number;
    }
  | {
      outcome: "incorrect";
      verificationId: Id<"participantPhoneVerifications">;
      maskedPhone: string;
      attemptsRemaining: number;
    }
  | {
      outcome: "locked";
      verificationId: Id<"participantPhoneVerifications">;
      maskedPhone: string;
      attemptsRemaining: number;
    };

function storedVerificationResult(
  resultJson: string | undefined,
  verificationId: Id<"participantPhoneVerifications">,
): VerificationResult {
  let result: unknown;
  try {
    result = JSON.parse(resultJson ?? "");
  } catch {
    throw new Error("The stored phone verification result is invalid.");
  }
  if (!result || typeof result !== "object") {
    throw new Error("The stored phone verification result is invalid.");
  }
  const candidate = result as Record<string, unknown>;
  if (candidate.verificationId !== verificationId || typeof candidate.maskedPhone !== "string") {
    throw new Error("The stored phone verification result is invalid.");
  }
  if (
    candidate.outcome === "verified" &&
    typeof candidate.verifiedAt === "number" &&
    Number.isFinite(candidate.verifiedAt)
  ) {
    return {
      outcome: "verified",
      verificationId,
      maskedPhone: candidate.maskedPhone,
      verifiedAt: candidate.verifiedAt,
    };
  }
  if (
    (candidate.outcome === "incorrect" || candidate.outcome === "locked") &&
    typeof candidate.attemptsRemaining === "number" &&
    Number.isSafeInteger(candidate.attemptsRemaining) &&
    candidate.attemptsRemaining >= 0 &&
    candidate.attemptsRemaining < phoneVerificationMaximumAttempts
  ) {
    return {
      outcome: candidate.outcome,
      verificationId,
      maskedPhone: candidate.maskedPhone,
      attemptsRemaining: candidate.attemptsRemaining,
    };
  }
  throw new Error("The stored phone verification result is invalid.");
}

type VerificationAccess = {
  event: Doc<"events">;
  person: Doc<"people">;
  membership: Doc<"eventMemberships">;
  grantIds: Id<"permissionGrants">[];
};

async function requireVerificationAccess(
  ctx: QueryCtx | MutationCtx,
  eventSlug: string,
  permissionKey: "participant.profile.read" | "participant.profile.write",
): Promise<VerificationAccess> {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const membership = requireEligibleMembership(await requireMembership(ctx, event._id, person._id));
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const grantIds = await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey,
    scopeType: "self",
    scopeId: membership._id,
  });
  return { event, person, membership, grantIds };
}

function verifiedState(verification: Doc<"participantPhoneVerifications">, now = Date.now()) {
  if (
    activeDeliveryStates.has(verification.status) &&
    verification.expiresAt !== undefined &&
    verification.expiresAt <= now
  ) {
    return "expired" as const;
  }
  if (verification.status === "superseded") return null;
  return verification.status;
}

function verificationProjection(
  verification: Doc<"participantPhoneVerifications">,
  now = Date.now(),
) {
  const state = verifiedState(verification, now);
  if (!state) return null;
  return {
    verificationId: verification._id,
    maskedPhone: maskedPhone(verification.phone),
    state,
    resendAvailableAt: verification.resendAvailableAt,
    ...(verification.expiresAt !== undefined ? { expiresAt: verification.expiresAt } : {}),
    attemptsRemaining: Math.max(0, phoneVerificationMaximumAttempts - verification.attemptCount),
    canVerify: Boolean(
      verification.codeDigest &&
      verification.expiresAt !== undefined &&
      verification.expiresAt > now &&
      verification.attemptCount < phoneVerificationMaximumAttempts,
    ),
    ...(verification.verifiedAt !== undefined ? { verifiedAt: verification.verifiedAt } : {}),
  };
}

function normalizedPhone(phone: string) {
  const validationError = participantPhoneValidationError(phone);
  if (validationError) {
    throw new ConvexError({ code: "INVALID_PHONE", message: validationError });
  }
  return normalizeParticipantPhone(phone);
}

async function latestForPhone(
  ctx: QueryCtx | MutationCtx,
  membershipId: Id<"eventMemberships">,
  phone: string,
) {
  return ctx.db
    .query("participantPhoneVerifications")
    .withIndex("by_membership_phone", (index) =>
      index.eq("membershipId", membershipId).eq("phone", phone),
    )
    .order("desc")
    .first();
}

export const status = query({
  args: { eventSlug: v.string(), phone: v.string() },
  returns: v.union(v.null(), verificationView),
  handler: async (ctx, args) => {
    const phone = normalizedPhone(args.phone);
    const { membership } = await requireVerificationAccess(
      ctx,
      args.eventSlug,
      "participant.profile.read",
    );
    const verification = await latestForPhone(ctx, membership._id, phone);
    return verification ? verificationProjection(verification) : null;
  },
});

export const request = mutation({
  args: {
    eventSlug: v.string(),
    phone: v.string(),
    clientOperationId: v.string(),
  },
  returns: verificationView,
  handler: async (ctx, args) => {
    const phone = normalizedPhone(args.phone);
    const { event, person, membership, grantIds } = await requireVerificationAccess(
      ctx,
      args.eventSlug,
      "participant.profile.write",
    );
    requireRegistrationOpen(event, membership.participantClass);
    const requestFingerprint = operationFingerprint([phone]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "participant.phone.request",
      requestFingerprint,
    });
    if (prior) {
      const verificationId = ctx.db.normalizeId("participantPhoneVerifications", prior.targetId);
      const verification = verificationId ? await ctx.db.get(verificationId) : null;
      if (
        !verification ||
        verification.eventId !== event._id ||
        verification.membershipId !== membership._id ||
        verification.phone !== phone
      ) {
        throw new Error("The stored phone verification request is invalid.");
      }
      const projection = verificationProjection(verification);
      if (!projection) {
        throw new Error("The stored phone verification request was superseded.");
      }
      return projection;
    }

    const now = Date.now();
    const latest = await latestForPhone(ctx, membership._id, phone);
    if (
      latest?.status === "verified" ||
      (latest && latest.resendAvailableAt > now && latest.status !== "superseded")
    ) {
      const projection = verificationProjection(latest, now);
      if (!projection) throw new Error("The active phone verification is invalid.");
      await recordOperation(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        clientOperationId: args.clientOperationId,
        commandName: "participant.phone.request",
        requestFingerprint,
        targetType: "participant_phone_verification",
        targetId: latest._id,
        createdAt: now,
      });
      return projection;
    }

    const windowStart = now - phoneVerificationRequestWindowMs;
    const [membershipRequests, phoneRequests] = await Promise.all([
      ctx.db
        .query("participantPhoneVerifications")
        .withIndex("by_membership", (index) =>
          index.eq("membershipId", membership._id).gte("_creationTime", windowStart),
        )
        .take(phoneVerificationMaximumHourlyRequests + 1),
      ctx.db
        .query("participantPhoneVerifications")
        .withIndex("by_event_phone", (index) =>
          index.eq("eventId", event._id).eq("phone", phone).gte("_creationTime", windowStart),
        )
        .take(phoneVerificationMaximumHourlyRequests + 1),
    ]);
    if (
      membershipRequests.length >= phoneVerificationMaximumHourlyRequests ||
      phoneRequests.length >= phoneVerificationMaximumHourlyRequests
    ) {
      throw new ConvexError({
        code: "PHONE_VERIFICATION_RATE_LIMITED",
        message: "Too many codes were requested. Wait an hour before trying again.",
      });
    }

    const latestMembershipRequest = await ctx.db
      .query("participantPhoneVerifications")
      .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
      .order("desc")
      .first();
    if (
      latestMembershipRequest &&
      activeDeliveryStates.has(latestMembershipRequest.status) &&
      latestMembershipRequest.status !== "superseded"
    ) {
      await ctx.db.patch(latestMembershipRequest._id, {
        status: "superseded",
        codeDigest: undefined,
        updatedAt: now,
      });
    }

    const verificationId = await ctx.db.insert("participantPhoneVerifications", {
      eventId: event._id,
      membershipId: membership._id,
      personId: person._id,
      phone,
      status: "queued",
      resendAvailableAt: now + phoneVerificationResendDelayMs,
      attemptCount: 0,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.phoneVerificationActions.deliver, {
      verificationId,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "participant.phone.request",
      requestFingerprint,
      targetType: "participant_phone_verification",
      targetId: verificationId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "participant.profile.write",
      grantIds,
      scopeType: "self",
      scopeId: membership._id,
      action: "participant.phone_verification.requested",
      targetType: "participant_phone_verification",
      targetId: verificationId,
      nextSummary: JSON.stringify({ phone: maskedPhone(phone) }),
      reason: "Participant requested phone verification",
    });
    const verification = await ctx.db.get(verificationId);
    if (!verification) throw new Error("Phone verification creation did not persist.");
    const projection = verificationProjection(verification, now);
    if (!projection) throw new Error("Phone verification creation is invalid.");
    return projection;
  },
});

export const verify = mutation({
  args: {
    eventSlug: v.string(),
    verificationId: v.id("participantPhoneVerifications"),
    code: v.string(),
    clientOperationId: v.string(),
  },
  returns: verificationResult,
  handler: async (ctx, args) => {
    if (!isPhoneVerificationCode(args.code)) {
      throw new ConvexError({
        code: "INVALID_PHONE_CODE",
        message: "Enter the six-digit code from the text message.",
      });
    }
    const { event, person, membership, grantIds } = await requireVerificationAccess(
      ctx,
      args.eventSlug,
      "participant.profile.write",
    );
    requireRegistrationOpen(event, membership.participantClass);
    const verification = await ctx.db.get(args.verificationId);
    if (
      !verification ||
      verification.eventId !== event._id ||
      verification.membershipId !== membership._id ||
      verification.personId !== person._id
    ) {
      throw new ConvexError({
        code: "PHONE_VERIFICATION_NOT_FOUND",
        message: "Request a new verification code.",
      });
    }
    const codeDigest = phoneVerificationCodeDigest({
      secret: requirePhoneVerificationSecret(),
      verificationId: verification._id,
      phone: verification.phone,
      code: args.code,
    });
    const requestFingerprint = operationFingerprint([args.verificationId, codeDigest]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "participant.phone.verify",
      requestFingerprint,
    });
    if (prior) {
      if (prior.targetId !== verification._id) {
        throw new Error("The stored phone verification result is invalid.");
      }
      return storedVerificationResult(prior.resultJson, verification._id);
    }
    if (verification.status === "verified" && verification.verifiedAt !== undefined) {
      return {
        outcome: "verified" as const,
        verificationId: verification._id,
        maskedPhone: maskedPhone(verification.phone),
        verifiedAt: verification.verifiedAt,
      };
    }
    if (verification.status === "superseded") {
      throw new ConvexError({
        code: "PHONE_CODE_SUPERSEDED",
        message: "That code was replaced. Use the most recent text message.",
      });
    }
    if (verification.status === "locked") {
      throw new ConvexError({
        code: "PHONE_CODE_LOCKED",
        message: "Too many incorrect attempts. Request a new code.",
      });
    }
    if (!verification.codeDigest || !verification.expiresAt) {
      throw new ConvexError({
        code: "PHONE_CODE_NOT_READY",
        message:
          verification.status === "send_failed"
            ? "The text message could not be sent. Request another code."
            : "The text message is still being sent. Try again in a moment.",
      });
    }
    const now = Date.now();
    if (verification.expiresAt <= now) {
      throw new ConvexError({
        code: "PHONE_CODE_EXPIRED",
        message: "That code has expired. Request a new one.",
      });
    }
    if (verification.attemptCount >= phoneVerificationMaximumAttempts) {
      await ctx.db.patch(verification._id, { status: "locked", updatedAt: now });
      const result: VerificationResult = {
        outcome: "locked" as const,
        verificationId: verification._id,
        maskedPhone: maskedPhone(verification.phone),
        attemptsRemaining: 0 as const,
      };
      await recordOperation(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        clientOperationId: args.clientOperationId,
        commandName: "participant.phone.verify",
        requestFingerprint,
        targetType: "participant_phone_verification",
        targetId: verification._id,
        resultJson: JSON.stringify(result),
        createdAt: now,
      });
      return result;
    }
    if (!constantTimeDigestEqual(verification.codeDigest, codeDigest)) {
      const attemptCount = verification.attemptCount + 1;
      const attemptsRemaining = Math.max(0, phoneVerificationMaximumAttempts - attemptCount);
      await ctx.db.patch(verification._id, {
        attemptCount,
        ...(attemptCount >= phoneVerificationMaximumAttempts ? { status: "locked" } : {}),
        updatedAt: now,
      });
      const result: VerificationResult = {
        outcome:
          attemptCount >= phoneVerificationMaximumAttempts
            ? ("locked" as const)
            : ("incorrect" as const),
        verificationId: verification._id,
        maskedPhone: maskedPhone(verification.phone),
        attemptsRemaining,
      };
      await recordOperation(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        clientOperationId: args.clientOperationId,
        commandName: "participant.phone.verify",
        requestFingerprint,
        targetType: "participant_phone_verification",
        targetId: verification._id,
        resultJson: JSON.stringify(result),
        createdAt: now,
      });
      return result;
    }

    await ctx.db.patch(verification._id, {
      status: "verified",
      codeDigest: undefined,
      verifiedAt: now,
      updatedAt: now,
    });
    const result: VerificationResult = {
      outcome: "verified" as const,
      verificationId: verification._id,
      maskedPhone: maskedPhone(verification.phone),
      verifiedAt: now,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "participant.phone.verify",
      requestFingerprint,
      targetType: "participant_phone_verification",
      targetId: verification._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "participant.profile.write",
      grantIds,
      scopeType: "self",
      scopeId: membership._id,
      action: "participant.phone_verification.verified",
      targetType: "participant_phone_verification",
      targetId: verification._id,
      nextSummary: JSON.stringify({ phone: maskedPhone(verification.phone), verifiedAt: now }),
      reason: "Participant verified phone",
    });
    return result;
  },
});

export const prepareDelivery = internalMutation({
  args: {
    verificationId: v.id("participantPhoneVerifications"),
    codeDigest: v.string(),
    expiresAt: v.number(),
  },
  returns: v.union(v.null(), v.object({ phone: v.string() })),
  handler: async (ctx, args) => {
    const verification = await ctx.db.get(args.verificationId);
    if (!verification || verification.status !== "queued") return null;
    const now = Date.now();
    if (
      !/^[a-f0-9]{64}$/u.test(args.codeDigest) ||
      args.expiresAt < now + phoneVerificationLifetimeMs - 30_000 ||
      args.expiresAt > now + phoneVerificationLifetimeMs + 30_000
    ) {
      throw new Error("The prepared phone verification code is invalid.");
    }
    await ctx.db.patch(verification._id, {
      status: "sending",
      codeDigest: args.codeDigest,
      expiresAt: args.expiresAt,
      failureCode: undefined,
      updatedAt: now,
    });
    return { phone: verification.phone };
  },
});

export const readPhoneForDelivery = internalQuery({
  args: { verificationId: v.id("participantPhoneVerifications") },
  returns: v.union(v.null(), v.object({ phone: v.string() })),
  handler: async (ctx, args) => {
    const verification = await ctx.db.get(args.verificationId);
    return verification?.status === "queued" ? { phone: verification.phone } : null;
  },
});

export const completeDelivery = internalMutation({
  args: {
    verificationId: v.id("participantPhoneVerifications"),
    providerMessageId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const verification = await ctx.db.get(args.verificationId);
    if (!verification || verification.status === "superseded") return null;
    if (!args.providerMessageId.trim() || args.providerMessageId.length > 256) {
      throw new Error("The AWS SMS message ID is invalid.");
    }
    const now = Date.now();
    await ctx.db.patch(verification._id, {
      ...(verification.status === "sending" ? { status: "sent" } : {}),
      providerMessageId: args.providerMessageId,
      sentAt: now,
      failureCode: undefined,
      updatedAt: now,
    });
    return null;
  },
});

export const failDelivery = internalMutation({
  args: {
    verificationId: v.id("participantPhoneVerifications"),
    failureCode: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const verification = await ctx.db.get(args.verificationId);
    if (
      !verification ||
      verification.status === "verified" ||
      verification.status === "locked" ||
      verification.status === "superseded"
    ) {
      return null;
    }
    if (!/^[a-z_]{1,64}$/u.test(args.failureCode)) {
      throw new Error("The phone verification failure code is invalid.");
    }
    await ctx.db.patch(verification._id, {
      status: "send_failed",
      failureCode: args.failureCode,
      updatedAt: Date.now(),
    });
    return null;
  },
});
