import { ConvexError, v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireMembership,
} from "./lib/identity";
import { revokeActivePortalQrTokens } from "./lib/attendancePortalQrLifecycle";
import { requirePermission } from "./lib/permissions";

const tokenLifetimeMs = 60_000;

export const mint = internalMutation({
  args: {
    eventSlug: v.string(),
    sessionId: v.optional(v.id("attendanceSessions")),
    tokenHash: v.string(),
  },
  returns: v.object({
    tokenId: v.id("attendancePortalQrTokens"),
    expiresAt: v.number(),
    serverNow: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = await requireMembership(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.portal_qr.mint",
      scopeType: "self",
      scopeId: membership._id,
    });
    if (
      membership.eligibilityStatus !== "eligible" ||
      membership.onboardingStatus !== "accepted"
    ) {
      throw new ConvexError({
        code: "ATTENDANCE_NOT_AVAILABLE",
        message: "Attendance credentials are available to accepted participants.",
      });
    }
    if (!/^[a-f0-9]{64}$/u.test(args.tokenHash)) {
      throw new Error("Portal QR token hash is invalid.");
    }
    if (args.sessionId !== undefined) {
      const session = await ctx.db.get(args.sessionId);
      if (!session || session.eventId !== event._id || session.status !== "open") {
        throw new ConvexError({
          code: "SESSION_NOT_OPEN",
          message: "That attendance session is not open.",
        });
      }
      const expected = await ctx.db
        .query("attendanceSessionParticipants")
        .withIndex("by_session_membership", (index) =>
          index.eq("sessionId", session._id).eq("membershipId", membership._id),
        )
        .unique();
      if (!expected) {
        throw new ConvexError({
          code: "SESSION_NOT_AVAILABLE",
          message: "This attendance session is not assigned to you.",
        });
      }
    }
    const collision = await ctx.db
      .query("attendancePortalQrTokens")
      .withIndex("by_event_token", (index) =>
        index.eq("eventId", event._id).eq("tokenHash", args.tokenHash),
      )
      .unique();
    if (collision) throw new Error("Portal QR token collision.");

    const now = Date.now();
    await revokeActivePortalQrTokens(ctx, membership._id);
    const existingCredential = await ctx.db
      .query("attendancePortalCredentials")
      .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
      .unique();
    if (existingCredential?.state === "suspended") {
      throw new ConvexError({
        code: "PORTAL_CREDENTIAL_SUSPENDED",
        message: "Your attendance QR is suspended. Ask event support for help.",
      });
    }
    const portalCredentialId = existingCredential
      ? existingCredential._id
      : await ctx.db.insert("attendancePortalCredentials", {
          eventId: event._id,
          membershipId: membership._id,
          version: 1,
          state: "active",
          updatedAt: now,
        });
    const credentialVersion = existingCredential?.version ?? 1;
    const expiresAt = now + tokenLifetimeMs;
    const tokenId = await ctx.db.insert("attendancePortalQrTokens", {
      eventId: event._id,
      membershipId: membership._id,
      portalCredentialId,
      credentialVersion,
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      tokenHash: args.tokenHash,
      state: "active",
      issuedAt: now,
      expiresAt,
    });
    return { tokenId, expiresAt, serverNow: now };
  },
});
