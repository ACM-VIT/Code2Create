import { Buffer } from "node:buffer";

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { internal } from "./_generated/api";
import {
  decryptProviderSecret,
  encryptProviderSecret,
  providerSecretKeyVersion,
} from "./lib/providerSecrets";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

function key(fill: number) {
  return Buffer.alloc(32, fill).toString("base64url");
}

function useCurrent(version: string, value: string) {
  vi.stubEnv("PROVIDER_TOKEN_ENCRYPTION_KEY_VERSION", version);
  vi.stubEnv("PROVIDER_TOKEN_ENCRYPTION_KEY", value);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider secret rotation", () => {
  test("dry-runs and re-encrypts active credentials and every live OAuth intent", async () => {
    const oldKey = key(11);
    const newKey = key(12);
    useCurrent("provider-k1", oldKey);
    const encrypted = {
      access: encryptProviderSecret("access"),
      refresh: encryptProviderSecret("refresh"),
      pendingPkce: encryptProviderSecret("pending-pkce"),
      verifyingPkce: encryptProviderSecret("verifying-pkce"),
      expiredPkce: encryptProviderSecret("expired-pkce"),
    };

    const backend = convexTest(schema, modules);
    const now = Date.now();
    const ids = await backend.run(async (ctx) => {
      const eventId = await ctx.db.insert("events", {
        slug: `provider-rotation-${crypto.randomUUID()}`,
        name: "Provider rotation",
        timezone: "Asia/Kolkata",
        status: "draft",
        vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
        startsAt: now,
        endsAt: now + 1_000,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const personId = await ctx.db.insert("people", {
        authUserId: crypto.randomUUID(),
        googleSubject: crypto.randomUUID(),
        verifiedEmail: "rotation@example.test",
        displayName: "Rotation owner",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId,
        personId,
        emailNormalized: "rotation@example.test",
        displayName: "Rotation owner",
        status: "active",
        linkedBy: "participant_provisioning",
        accessVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      const membershipId = await ctx.db.insert("eventMemberships", {
        eventId,
        personId,
        eventAccessSubjectId: subjectId,
        participantClass: "external_participant",
        eligibilityStatus: "eligible",
        onboardingStatus: "accepted",
        acceptedParticipantPolicyVersionIds: [],
        createdAt: now,
        updatedAt: now,
      });
      const teamId = await ctx.db.insert("teams", {
        eventId,
        name: "Rotation team",
        publicCode: crypto.randomUUID(),
        leadMembershipId: membershipId,
        status: "confirmed",
        activeMemberCount: 0,
        activeVitMemberCount: 0,
        activeExternalMemberCount: 0,
        membershipLocked: true,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const credentialId = await ctx.db.insert("figmaOAuthCredentials", {
        figmaUserId: "figma-user",
        accessTokenCiphertext: encrypted.access,
        refreshTokenCiphertext: encrypted.refresh,
        tokenExpiresAt: now + 60_000,
        tokenReceivedAt: now,
        scopes: ["file_metadata:read"],
        status: "active",
        authorizedByPersonId: personId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const pendingIntentId = await ctx.db.insert("figmaSetupIntents", {
        eventId,
        teamId,
        personId,
        stateDigest: `pending-${crypto.randomUUID()}`,
        pkceVerifierCiphertext: encrypted.pendingPkce,
        redirectUri: "https://example.test/callback",
        status: "pending",
        expiresAt: now + 60_000,
        createdAt: now,
      });
      const verifyingIntentId = await ctx.db.insert("figmaSetupIntents", {
        eventId,
        teamId,
        personId,
        stateDigest: `verifying-${crypto.randomUUID()}`,
        pkceVerifierCiphertext: encrypted.verifyingPkce,
        redirectUri: "https://example.test/callback",
        status: "verifying",
        attemptId: crypto.randomUUID(),
        claimExpiresAt: now + 30_000,
        expiresAt: now + 60_000,
        createdAt: now,
      });
      await ctx.db.insert("figmaSetupIntents", {
        eventId,
        teamId,
        personId,
        stateDigest: `expired-${crypto.randomUUID()}`,
        pkceVerifierCiphertext: encrypted.expiredPkce,
        redirectUri: "https://example.test/callback",
        status: "pending",
        expiresAt: now - 1,
        createdAt: now - 60_000,
      });
      return { credentialId, pendingIntentId, verifyingIntentId };
    });

    useCurrent("provider-k2", newKey);
    vi.stubEnv("PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY_VERSION", "provider-k1");
    vi.stubEnv("PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY", oldKey);

    const dryRun = await backend.action(internal.figmaActions.rotateProviderSecrets, {
      owner: "active_credentials",
      limit: 10,
      dryRun: true,
    });
    expect(dryRun).toMatchObject({ needingRotation: 1, rotated: 0, isDone: true });

    for (const owner of ["active_credentials", "pending_intents", "verifying_intents"] as const) {
      const result = await backend.action(internal.figmaActions.rotateProviderSecrets, {
        owner,
        limit: 10,
        dryRun: false,
      });
      expect(result).toMatchObject({ needingRotation: 1, rotated: 1, isDone: true });
    }

    const stored = await backend.run(async (ctx) => ({
      credential: await ctx.db.get(ids.credentialId),
      pending: await ctx.db.get(ids.pendingIntentId),
      verifying: await ctx.db.get(ids.verifyingIntentId),
    }));
    expect(stored.credential?.version).toBe(2);
    for (const ciphertext of [
      stored.credential?.accessTokenCiphertext,
      stored.credential?.refreshTokenCiphertext,
      stored.pending?.pkceVerifierCiphertext,
      stored.verifying?.pkceVerifierCiphertext,
    ]) {
      expect(ciphertext).toBeDefined();
      if (ciphertext === undefined) throw new Error("Rotated ciphertext is missing.");
      expect(providerSecretKeyVersion(ciphertext)).toBe("provider-k2");
    }

    vi.stubEnv("PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY_VERSION", "");
    vi.stubEnv("PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY", "");
    expect(decryptProviderSecret(stored.credential?.accessTokenCiphertext ?? "")).toBe("access");
    expect(decryptProviderSecret(stored.credential?.refreshTokenCiphertext ?? "")).toBe("refresh");
    expect(decryptProviderSecret(stored.pending?.pkceVerifierCiphertext ?? "")).toBe(
      "pending-pkce",
    );
    expect(decryptProviderSecret(stored.verifying?.pkceVerifierCiphertext ?? "")).toBe(
      "verifying-pkce",
    );
  });
});
