import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";

const credentialSecret = v.object({
  id: v.id("figmaOAuthCredentials"),
  accessTokenCiphertext: v.string(),
  refreshTokenCiphertext: v.string(),
  version: v.number(),
});

const intentSecret = v.object({
  id: v.id("figmaSetupIntents"),
  pkceVerifierCiphertext: v.string(),
  expiresAt: v.number(),
  status: v.union(v.literal("pending"), v.literal("verifying")),
});

export const activeCredentialPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(credentialSecret),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("figmaOAuthCredentials")
      .withIndex("by_status", (index) => index.eq("status", "active"))
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((credential) => ({
        id: credential._id,
        accessTokenCiphertext: credential.accessTokenCiphertext,
        refreshTokenCiphertext: credential.refreshTokenCiphertext,
        version: credential.version,
      })),
    };
  },
});

export const liveIntentPage = internalQuery({
  args: {
    status: v.union(v.literal("pending"), v.literal("verifying")),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(intentSecret),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("figmaSetupIntents")
      .withIndex("by_status", (index) => index.eq("status", args.status))
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((intent) => ({
        id: intent._id,
        pkceVerifierCiphertext: intent.pkceVerifierCiphertext,
        expiresAt: intent.expiresAt,
        status: args.status,
      })),
    };
  },
});

export const commitCredentialRotations = internalMutation({
  args: {
    rotations: v.array(
      v.object({
        credentialId: v.id("figmaOAuthCredentials"),
        expectedVersion: v.number(),
        expectedAccessTokenCiphertext: v.string(),
        expectedRefreshTokenCiphertext: v.string(),
        accessTokenCiphertext: v.string(),
        refreshTokenCiphertext: v.string(),
      }),
    ),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    let rotated = 0;
    const now = Date.now();
    for (const rotation of args.rotations) {
      const credential = await ctx.db.get(rotation.credentialId);
      if (
        !credential ||
        credential.status !== "active" ||
        credential.version !== rotation.expectedVersion ||
        credential.accessTokenCiphertext !== rotation.expectedAccessTokenCiphertext ||
        credential.refreshTokenCiphertext !== rotation.expectedRefreshTokenCiphertext
      ) {
        continue;
      }
      await ctx.db.patch(credential._id, {
        accessTokenCiphertext: rotation.accessTokenCiphertext,
        refreshTokenCiphertext: rotation.refreshTokenCiphertext,
        version: credential.version + 1,
        updatedAt: now,
      });
      rotated += 1;
    }
    return rotated;
  },
});

export const commitIntentRotations = internalMutation({
  args: {
    now: v.number(),
    rotations: v.array(
      v.object({
        intentId: v.id("figmaSetupIntents"),
        expectedStatus: v.union(v.literal("pending"), v.literal("verifying")),
        expectedPkceVerifierCiphertext: v.string(),
        pkceVerifierCiphertext: v.string(),
      }),
    ),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    let rotated = 0;
    for (const rotation of args.rotations) {
      const intent = await ctx.db.get(rotation.intentId);
      if (
        !intent ||
        intent.status !== rotation.expectedStatus ||
        intent.expiresAt <= args.now ||
        intent.pkceVerifierCiphertext !== rotation.expectedPkceVerifierCiphertext
      ) {
        continue;
      }
      await ctx.db.patch(intent._id, {
        pkceVerifierCiphertext: rotation.pkceVerifierCiphertext,
      });
      rotated += 1;
    }
    return rotated;
  },
});
