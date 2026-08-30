import { ConvexError, v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { refreshExistingPersonIdentity } from "./lib/identity";
import { normalizeEmail, normalizedText } from "./lib/strings";

function normalizeHostedDomain(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (
    normalized.length > 253 ||
    normalized.includes("@") ||
    normalized.startsWith(".") ||
    normalized.endsWith(".")
  ) {
    throw new ConvexError({
      code: "GOOGLE_CLAIMS_INVALID",
      message: "Google returned an invalid hosted-domain claim.",
    });
  }
  return normalized;
}

export const recordVerifiedGoogleIdentity = internalMutation({
  args: {
    authUserId: v.string(),
    googleSubject: v.string(),
    verifiedEmail: v.string(),
    displayName: v.string(),
    hostedDomain: v.optional(v.string()),
    tokenIssuedAt: v.number(),
    tokenExpiresAt: v.number(),
    verifiedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.tokenIssuedAt >= args.tokenExpiresAt || args.verifiedAt >= args.tokenExpiresAt) {
      throw new ConvexError({
        code: "GOOGLE_CLAIMS_EXPIRED",
        message: "Google identity claims are no longer current.",
      });
    }
    const verifiedEmail = normalizeEmail(args.verifiedEmail);
    const displayName = normalizedText(args.displayName, "Google display name", 1, 100);
    const hostedDomain = normalizeHostedDomain(args.hostedDomain);
    const bySubject = await ctx.db
      .query("googleIdentityClaims")
      .withIndex("by_google_subject", (index) =>
        index.eq("googleSubject", args.googleSubject),
      )
      .unique();
    if (bySubject && bySubject.authUserId !== args.authUserId) {
      throw new ConvexError({
        code: "GOOGLE_IDENTITY_CONFLICT",
        message: "This Google identity is already linked to another account.",
      });
    }
    const byUser = await ctx.db
      .query("googleIdentityClaims")
      .withIndex("by_auth_user", (index) => index.eq("authUserId", args.authUserId))
      .unique();
    if (byUser && byUser.googleSubject !== args.googleSubject) {
      throw new ConvexError({
        code: "GOOGLE_IDENTITY_CONFLICT",
        message: "This account is already linked to another Google identity.",
      });
    }
    const values = {
      googleSubject: args.googleSubject,
      verifiedEmail,
      displayName,
      ...(hostedDomain !== undefined ? { hostedDomain } : {}),
      tokenIssuedAt: args.tokenIssuedAt,
      tokenExpiresAt: args.tokenExpiresAt,
      verifiedAt: args.verifiedAt,
    };
    if (byUser) {
      await ctx.db.patch(byUser._id, { ...values, hostedDomain });
    } else {
      await ctx.db.insert("googleIdentityClaims", {
        authUserId: args.authUserId,
        ...values,
      });
    }
    const person = await ctx.db
      .query("people")
      .withIndex("by_auth_user", (index) => index.eq("authUserId", args.authUserId))
      .unique();
    if (person) {
      if (person.googleSubject !== args.googleSubject) {
        throw new ConvexError({
          code: "GOOGLE_IDENTITY_CONFLICT",
          message: "This account is linked to another Google identity.",
        });
      }
      await refreshExistingPersonIdentity(ctx, {
        person,
        verifiedEmail,
        displayName,
        now: args.verifiedAt,
      });
    }
    return null;
  },
});
