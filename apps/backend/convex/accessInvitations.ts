import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import {
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  ensureGooglePerson,
  requireAuthUser,
  requireCurrentPerson,
  requireEventSubject,
} from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
} from "./lib/operations";
import { requirePermission } from "./lib/permissions";
import {
  normalizeEmail,
  normalizedText,
} from "./lib/strings";

const invitationEmail = z.email().max(254);
const minimumInvitationLifetimeMs = 5 * 60 * 1_000;
const maximumInvitationLifetimeMs = 30 * 24 * 60 * 60 * 1_000;
const invitedOutcome = "invited" as const;
const alreadyPendingOutcome = "already_pending" as const;
const alreadyLinkedOutcome = "already_linked" as const;
const claimedOutcome = "claimed" as const;
const alreadyClaimedOutcome = "already_claimed" as const;
const revokedStatus = "revoked" as const;

const invitationListItem = v.object({
  id: v.id("eventAccessInvitations"),
  email: v.string(),
  status: v.union(v.literal("pending"), v.literal("expired")),
  validUntil: v.number(),
  version: v.number(),
  reason: v.string(),
  createdAt: v.number(),
  createdBy: v.string(),
});

const inviteResult = v.union(
  v.object({
    outcome: v.literal("invited"),
    invitationId: v.id("eventAccessInvitations"),
  }),
  v.object({
    outcome: v.literal("already_pending"),
    invitationId: v.id("eventAccessInvitations"),
  }),
  v.object({
    outcome: v.literal("already_linked"),
  }),
);

const invitationOperationResult = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("invited"),
      invitationId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("already_pending"),
      invitationId: z.string().min(1),
    })
    .strict(),
  z.object({ outcome: z.literal("already_linked") }).strict(),
]);

const invitationClaimOperationResult = z
  .object({
    outcome: z.enum(["claimed", "already_claimed"]),
    personId: z.string().min(1),
    eventAccessSubjectId: z.string().min(1),
  })
  .strict();

function exactInvitationEmail(value: string) {
  const email = normalizeEmail(value);
  if (!invitationEmail.safeParse(email).success) {
    throw new ConvexError({
      code: "INVALID_EMAIL",
      message: "Enter one complete Google account email address.",
    });
  }
  return email;
}

function checkedInvitationExpiry(validUntil: number, now: number) {
  if (!Number.isSafeInteger(validUntil)) {
    throw new ConvexError({
      code: "INVALID_EXPIRY",
      message: "Invitation expiry is invalid.",
    });
  }
  const lifetime = validUntil - now;
  if (
    lifetime < minimumInvitationLifetimeMs ||
    lifetime > maximumInvitationLifetimeMs
  ) {
    throw new ConvexError({
      code: "INVALID_EXPIRY",
      message: "Invitation expiry must be between five minutes and 30 days from now.",
    });
  }
  return validUntil;
}

export const mine = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      id: v.id("eventAccessInvitations"),
      eventName: v.string(),
      email: v.string(),
      validUntil: v.number(),
      version: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const user = await requireAuthUser(ctx);
    const email = normalizeEmail(user.email);
    const invitation = await ctx.db
      .query("eventAccessInvitations")
      .withIndex("by_event_email_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("emailNormalized", email)
          .eq("status", "pending"),
      )
      .unique();
    if (!invitation || invitation.validUntil <= Date.now()) return null;
    return {
      id: invitation._id,
      eventName: event.name,
      email: invitation.emailNormalized,
      validUntil: invitation.validUntil,
      version: invitation.version,
    };
  },
});

export const open = query({
  args: {
    eventSlug: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(invitationListItem),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "access.subjects.invite",
      scopeType: "event",
    });
    const now = Date.now();
    const page = await ctx.db
      .query("eventAccessInvitations")
      .withIndex("by_event_status_created", (index) =>
        index.eq("eventId", event._id).eq("status", "pending"),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    const invitations = await Promise.all(
      page.page.map(async (invitation) => {
        const creator = await ctx.db.get(invitation.createdByPersonId);
        return {
          id: invitation._id,
          email: invitation.emailNormalized,
          status: invitation.validUntil > now ? "pending" : "expired",
          validUntil: invitation.validUntil,
          version: invitation.version,
          reason: invitation.reason,
          createdAt: invitation.createdAt,
          createdBy: creator?.displayName ?? "Event operator",
        } as const;
      }),
    );
    return { ...page, page: invitations };
  },
});

export const create = mutation({
  args: {
    eventSlug: v.string(),
    email: v.string(),
    validUntil: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: inviteResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    const email = exactInvitationEmail(args.email);
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const operationId = normalizedText(
      args.clientOperationId,
      "Client operation ID",
      10,
      100,
    );
    const now = Date.now();
    const validUntil = checkedInvitationExpiry(args.validUntil, now);
    const requestFingerprint = operationFingerprint([
      email,
      validUntil,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "accessInvitations.create",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "access invitation",
        invitationOperationResult,
      );
      if (result.outcome === "already_linked") {
        const linkedSubjectId = ctx.db.normalizeId("eventAccessSubjects", prior.targetId);
        if (!linkedSubjectId) throw new Error("The stored linked-account result is invalid.");
        return { outcome: alreadyLinkedOutcome };
      }
      const invitationId = ctx.db.normalizeId(
        "eventAccessInvitations",
        result.invitationId,
      );
      if (!invitationId || invitationId !== prior.targetId) {
        throw new Error("The stored invitation result is invalid.");
      }
      return { outcome: result.outcome, invitationId };
    }
    const authorizingGrantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: actorSubject._id,
      permissionKey: "access.subjects.invite",
      scopeType: "event",
    });

    const linkedSubject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_email", (index) =>
        index.eq("eventId", event._id).eq("emailNormalized", email),
      )
      .unique();
    if (linkedSubject) {
      if (linkedSubject.status !== "active") {
        throw new ConvexError({
          code: "EVENT_ACCESS_NOT_ACTIVE",
          message: "That event account exists but is not active. Use the separate reactivation workflow.",
        });
      }
      const result = { outcome: alreadyLinkedOutcome };
      await recordOperation(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        clientOperationId: operationId,
        commandName: "accessInvitations.create",
        requestFingerprint,
        targetType: "event_access_subject",
        targetId: linkedSubject._id,
        resultJson: JSON.stringify(result),
        createdAt: now,
      });
      return result;
    }

    const existing = await ctx.db
      .query("eventAccessInvitations")
      .withIndex("by_event_email_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("emailNormalized", email)
          .eq("status", "pending"),
      )
      .unique();
    if (existing && existing.validUntil > now) {
      const result = {
        outcome: alreadyPendingOutcome,
        invitationId: existing._id,
      };
      await recordOperation(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        clientOperationId: operationId,
        commandName: "accessInvitations.create",
        requestFingerprint,
        targetType: "event_access_invitation",
        targetId: existing._id,
        resultJson: JSON.stringify(result),
        createdAt: now,
      });
      return result;
    }
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: "expired",
        version: existing.version + 1,
      });
    }

    const invitationId = await ctx.db.insert("eventAccessInvitations", {
      eventId: event._id,
      emailNormalized: email,
      status: "pending",
      validUntil,
      version: 1,
      createdByPersonId: person._id,
      creationOperationId: operationId,
      reason,
      createdAt: now,
    });
    await ctx.scheduler.runAt(validUntil, internal.accessInvitations.expire, {
      invitationId,
      expectedVersion: 1,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "access.subjects.invite",
      grantIds: authorizingGrantIds,
      scopeType: "event",
      action: "access.invitation_created",
      targetType: "event_access_invitation",
      targetId: invitationId,
      nextSummary: JSON.stringify({ email, validUntil, status: "pending" }),
      reason,
    });
    const result = { outcome: invitedOutcome, invitationId };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "accessInvitations.create",
      requestFingerprint,
      targetType: "event_access_invitation",
      targetId: invitationId,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    return result;
  },
});

export const claim = mutation({
  args: {
    eventSlug: v.string(),
    invitationId: v.id("eventAccessInvitations"),
    expectedVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    outcome: v.union(v.literal("claimed"), v.literal("already_claimed")),
    personId: v.id("people"),
    eventAccessSubjectId: v.id("eventAccessSubjects"),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await ensureGooglePerson(ctx);
    const operationId = normalizedText(
      args.clientOperationId,
      "Client operation ID",
      10,
      100,
    );
    const requestFingerprint = operationFingerprint([
      args.invitationId,
      args.expectedVersion,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "accessInvitations.claim",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "invitation claim",
        invitationClaimOperationResult,
      );
      const personId = ctx.db.normalizeId("people", result.personId);
      const eventAccessSubjectId = ctx.db.normalizeId(
        "eventAccessSubjects",
        result.eventAccessSubjectId,
      );
      if (
        !personId ||
        !eventAccessSubjectId ||
        personId !== person._id ||
        eventAccessSubjectId !== prior.targetId
      ) {
        throw new Error("The stored invitation claim is invalid.");
      }
      return {
        outcome: result.outcome,
        personId,
        eventAccessSubjectId,
      };
    }

    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation || invitation.eventId !== event._id) {
      throw new ConvexError({
        code: "INVITATION_NOT_FOUND",
        message: "That event invitation is unavailable.",
      });
    }
    if (invitation.emailNormalized !== person.verifiedEmail) {
      throw new ConvexError({
        code: "INVITATION_IDENTITY_MISMATCH",
        message: "Sign in with the exact Google account named on the invitation.",
      });
    }
    if (
      invitation.status === "claimed" &&
      invitation.claimedByPersonId === person._id &&
      invitation.claimedEventAccessSubjectId !== undefined
    ) {
      const result = {
        outcome: alreadyClaimedOutcome,
        personId: person._id,
        eventAccessSubjectId: invitation.claimedEventAccessSubjectId,
      };
      await recordOperation(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        clientOperationId: operationId,
        commandName: "accessInvitations.claim",
        requestFingerprint,
        targetType: "event_access_subject",
        targetId: invitation.claimedEventAccessSubjectId,
        resultJson: JSON.stringify(result),
        createdAt: Date.now(),
      });
      return result;
    }
    if (invitation.status !== "pending") {
      throw new ConvexError({
        code: "INVITATION_NOT_PENDING",
        message: "That event invitation can no longer be claimed.",
      });
    }
    if (invitation.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "INVITATION_CHANGED",
        message: "The invitation changed. Refresh before claiming it.",
      });
    }
    const now = Date.now();
    if (invitation.validUntil <= now) {
      throw new ConvexError({
        code: "INVITATION_EXPIRED",
        message: "That invitation expired. Ask the sender to create a new one.",
      });
    }

    const emailOwner = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_email", (index) =>
        index
          .eq("eventId", event._id)
          .eq("emailNormalized", person.verifiedEmail),
      )
      .unique();
    if (emailOwner && emailOwner.personId !== person._id) {
      throw new ConvexError({
        code: "EVENT_EMAIL_CONFLICT",
        message: "That verified email is already linked to another event account.",
      });
    }
    let subject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (subject && subject.status !== "active") {
      throw new ConvexError({
        code: "EVENT_ACCESS_NOT_ACTIVE",
        message: "This event account is not active. Ask an access administrator to reactivate it.",
      });
    }
    if (!subject) {
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId: event._id,
        personId: person._id,
        emailNormalized: person.verifiedEmail,
        displayName: person.displayName,
        status: "active",
        linkedBy: "access_invitation",
        accessVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      subject = await ctx.db.get(subjectId);
    } else if (
      subject.emailNormalized !== person.verifiedEmail ||
      subject.displayName !== person.displayName
    ) {
      await ctx.db.patch(subject._id, {
        emailNormalized: person.verifiedEmail,
        displayName: person.displayName,
        updatedAt: now,
      });
      subject = await ctx.db.get(subject._id);
    }
    if (!subject) throw new Error("Event account creation did not persist.");

    await ctx.db.patch(invitation._id, {
      status: "claimed",
      version: invitation.version + 1,
      claimedByPersonId: person._id,
      claimedEventAccessSubjectId: subject._id,
      claimOperationId: operationId,
      claimedAt: now,
    });
    const result = {
      outcome: claimedOutcome,
      personId: person._id,
      eventAccessSubjectId: subject._id,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "accessInvitations.claim",
      requestFingerprint,
      targetType: "event_access_subject",
      targetId: subject._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await ctx.db.insert("auditEvents", {
      eventId: event._id,
      actorPersonId: person._id,
      authorizingPermissionKey: "verified_google_identity",
      authorizingGrantIds: [],
      resolvedScopeType: "person",
      resolvedScopeId: person._id,
      action: "access.invitation_claimed",
      targetType: "event_access_subject",
      targetId: subject._id,
      previousSummary: JSON.stringify({ invitationId: invitation._id }),
      nextSummary: JSON.stringify({
        personId: person._id,
        email: person.verifiedEmail,
        status: "active",
      }),
      reason: "Exact-email invitation claimed by the authenticated Google account.",
      serverTime: now,
    });
    return result;
  },
});

export const revoke = mutation({
  args: {
    eventSlug: v.string(),
    invitationId: v.id("eventAccessInvitations"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    invitationId: v.id("eventAccessInvitations"),
    status: v.literal("revoked"),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const operationId = normalizedText(
      args.clientOperationId,
      "Client operation ID",
      10,
      100,
    );
    const requestFingerprint = operationFingerprint([
      args.invitationId,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "accessInvitations.revoke",
      requestFingerprint,
    });
    if (prior) {
      const invitationId = ctx.db.normalizeId(
        "eventAccessInvitations",
        prior.targetId,
      );
      if (!invitationId) throw new Error("Prior invitation revocation is invalid.");
      return { invitationId, status: revokedStatus };
    }
    const authorizingGrantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "access.subjects.invite",
      scopeType: "event",
    });
    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation || invitation.eventId !== event._id) {
      throw new ConvexError({
        code: "INVITATION_NOT_FOUND",
        message: "That event invitation is unavailable.",
      });
    }
    if (invitation.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "INVITATION_CHANGED",
        message: "The invitation changed. Refresh before revoking it.",
      });
    }
    if (invitation.status !== "pending" || invitation.validUntil <= Date.now()) {
      throw new ConvexError({
        code: "INVITATION_NOT_PENDING",
        message: "Only a current pending invitation can be revoked.",
      });
    }
    const now = Date.now();
    await ctx.db.patch(invitation._id, {
      status: "revoked",
      version: invitation.version + 1,
      revokedByPersonId: person._id,
      revokeOperationId: operationId,
      revokedAt: now,
      revokeReason: reason,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "access.subjects.invite",
      grantIds: authorizingGrantIds,
      scopeType: "event",
      action: "access.invitation_revoked",
      targetType: "event_access_invitation",
      targetId: invitation._id,
      previousSummary: JSON.stringify({
        email: invitation.emailNormalized,
        status: invitation.status,
        validUntil: invitation.validUntil,
      }),
      nextSummary: JSON.stringify({ status: "revoked", revokedAt: now }),
      reason,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "accessInvitations.revoke",
      requestFingerprint,
      targetType: "event_access_invitation",
      targetId: invitation._id,
      createdAt: now,
    });
    return { invitationId: invitation._id, status: revokedStatus };
  },
});

export const expire = internalMutation({
  args: {
    invitationId: v.id("eventAccessInvitations"),
    expectedVersion: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const invitation = await ctx.db.get(args.invitationId);
    if (
      invitation &&
      invitation.status === "pending" &&
      invitation.version === args.expectedVersion &&
      invitation.validUntil <= Date.now()
    ) {
      await ctx.db.patch(invitation._id, {
        status: "expired",
        version: invitation.version + 1,
      });
    }
    return null;
  },
});
