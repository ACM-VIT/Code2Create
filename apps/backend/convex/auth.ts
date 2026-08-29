import { expo } from "@better-auth/expo";
import { verifyGoogleIdToken } from "@better-auth/core/social-providers";
import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import { bearer } from "better-auth/plugins";

import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";

function requiredEnvironmentValue(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required before authentication can accept requests.`);
  }
  return value;
}

function requiredWebOrigin(name: string) {
  const value = requiredEnvironmentValue(name);
  const url = new URL(value);
  if (url.origin !== value || (url.protocol !== "https:" && url.hostname !== "localhost")) {
    throw new Error(`${name} must be an HTTPS origin, or an HTTP localhost origin for development.`);
  }
  return url.origin;
}

export const authComponent = createClient<DataModel>(components.betterAuth);

async function recordGoogleIdentity(
  ctx: GenericCtx<DataModel>,
  account: {
    accountId: string;
    idToken?: string | null | undefined;
    providerId: string;
    userId: string;
  },
  googleClientId: string,
) {
  if (account.providerId !== "google" || !account.idToken) return;
  if (!("runMutation" in ctx)) {
    throw new Error("Google identity capture requires a Convex action context.");
  }
  const claims = await verifyGoogleIdToken({
    token: account.idToken,
    audience: googleClientId,
  });
  if (
    !claims ||
    typeof claims.sub !== "string" ||
    claims.sub !== account.accountId ||
    typeof claims.email !== "string" ||
    claims.email_verified !== true ||
    typeof claims.name !== "string" ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number" ||
    (claims.hd !== undefined && typeof claims.hd !== "string")
  ) {
    throw new Error("Google returned identity claims that could not be verified.");
  }
  await ctx.runMutation(internal.identityClaims.recordVerifiedGoogleIdentity, {
    authUserId: account.userId,
    googleSubject: claims.sub,
    verifiedEmail: claims.email,
    displayName: claims.name,
    ...(claims.hd !== undefined ? { hostedDomain: claims.hd } : {}),
    tokenIssuedAt: claims.iat * 1_000,
    tokenExpiresAt: claims.exp * 1_000,
    verifiedAt: Date.now(),
  });
}

export function createAuth(ctx: GenericCtx<DataModel>) {
  const participantSiteUrl = requiredWebOrigin("PARTICIPANT_SITE_URL");
  const operationsSiteUrl = requiredWebOrigin("OPERATIONS_SITE_URL");
  const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const googleProvider =
    googleClientId && googleClientSecret
      ? {
          google: {
            clientId: googleClientId,
            clientSecret: googleClientSecret,
            prompt: "select_account" as const,
          },
        }
      : {};

  return betterAuth({
    appName: "Code2Create",
    baseURL: requiredWebOrigin("AUTH_SITE_URL"),
    trustedOrigins: [
      participantSiteUrl,
      operationsSiteUrl,
      "code2create-ops://",
    ],
    database: authComponent.adapter(ctx),
    socialProviders: googleProvider,
    databaseHooks: {
      account: {
        create: {
          after: (account) => recordGoogleIdentity(ctx, account, googleClientId ?? ""),
        },
        update: {
          after: (account) => recordGoogleIdentity(ctx, account, googleClientId ?? ""),
        },
      },
    },
    plugins: [
      expo(),
      bearer(),
      crossDomain({ siteUrl: participantSiteUrl }),
      convex({ authConfig }),
    ],
  });
}
