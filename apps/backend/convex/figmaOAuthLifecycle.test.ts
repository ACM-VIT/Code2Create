/// <reference types="vite/client" />

import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, components } from "./_generated/api";
import { figmaOAuthScopes } from "./lib/figmaOAuthAccount";
import {
  integrationPolicyChecksum,
  normalizeIntegrationPolicy,
} from "./lib/integrationPolicy";
import { insertPermissionGrant } from "./lib/permissions";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
const baseTime = Date.UTC(2026, 8, 5, 6, 0, 0);
const tokenReceivedAt = baseTime + 1_000;
const accountReceivedAt = baseTime + 5_000;
type BackendTest = TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(baseTime);
  vi.stubEnv("FIGMA_CLIENT_ID", "figma-client-id");
  vi.stubEnv("FIGMA_CLIENT_SECRET", "figma-client-secret");
  vi.stubEnv("PARTICIPANT_SITE_URL", "https://participant.example.test");
  vi.stubEnv("CONVEX_SITE_URL", "https://convex.example.test");
  vi.stubEnv("PROVIDER_TOKEN_ENCRYPTION_KEY_VERSION", "figma-test-v1");
  vi.stubEnv("PROVIDER_TOKEN_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("Figma OAuth lifecycle", () => {
  test("verifies the provider account, persists its handle, and keeps its stable ID private", async () => {
    const { backend, participant, eventSlug } = await createFixture();
    const { state } = await beginConnection(participant, eventSlug);
    const providerRequest = installFigmaProvider({
      id: "00123",
      handle: "Design Lead",
      img_url: "https://figma.example.test/avatar.png",
      email: "designer@example.test",
    });

    await expect(
      participant.action(api.figmaActions.completeConnection, {
        eventSlug,
        state,
        code: "authorization-code",
      }),
    ).resolves.toMatchObject({ credentialConnectionId: expect.any(String) });

    expect(providerRequest).toHaveBeenCalledTimes(2);
    const credential = await backend.run((ctx) =>
      ctx.db.query("figmaOAuthCredentials").withIndex("by_figma_user").unique(),
    );
    expect(credential).toMatchObject({
      figmaUserId: "00123",
      figmaUserHandle: "Design Lead",
      tokenReceivedAt,
      scopes: [...figmaOAuthScopes],
      status: "active",
    });

    const current = await participant.query(api.figmaIntegrations.current, { eventSlug });
    expect(current?.connections).toHaveLength(1);
    expect(current?.connections[0]).toMatchObject({ figmaUserHandle: "Design Lead" });
    expect(current?.connections[0]).not.toHaveProperty("figmaUserId");
  });

  test.each([
    {
      name: "rejects a mismatched provider identity",
      account: {
        id: "different-user",
        handle: "Different User",
        img_url: "https://figma.example.test/different.png",
        email: "different@example.test",
      },
      message: /inconsistent account identity/i,
      failureCode: "figma_state_rejected",
    },
    {
      name: "rejects an invalid current-user response",
      account: {
        id: "00123",
        handle: "Incomplete User",
        img_url: "https://figma.example.test/incomplete.png",
      },
      message: /could not complete this request/i,
      failureCode: "figma_response_invalid",
    },
  ])("$name and fails the one-time setup", async ({ account, message, failureCode }) => {
    const { backend, participant, eventSlug } = await createFixture();
    const { state } = await beginConnection(participant, eventSlug);
    installFigmaProvider(account);

    await expect(
      participant.action(api.figmaActions.completeConnection, {
        eventSlug,
        state,
        code: "authorization-code",
      }),
    ).rejects.toThrow(message);

    const result = await backend.run(async (ctx) => ({
      intent: await ctx.db.query("figmaSetupIntents").withIndex("by_state_digest").unique(),
      credentials: await ctx.db.query("figmaOAuthCredentials").collect(),
    }));
    expect(result.intent).toMatchObject({ status: "failed", failureCode });
    expect(result.credentials).toEqual([]);
  });

  test("does not let a slower account lookup make an older authorization replace a newer one", async () => {
    const { backend, participant, eventSlug } = await createFixture();
    const first = await beginConnection(participant, eventSlug);
    installFigmaProvider({
      id: "00123",
      handle: "Original Account",
      img_url: "https://figma.example.test/original.png",
      email: "original@example.test",
    });
    await participant.action(api.figmaActions.completeConnection, {
      eventSlug,
      state: first.state,
      code: "first-authorization-code",
    });

    const newerTokenReceivedAt = baseTime + 8_000;
    const newerCredential = await backend.run(async (ctx) => {
      const credential = await ctx.db
        .query("figmaOAuthCredentials")
        .withIndex("by_figma_user")
        .unique();
      if (!credential) throw new Error("The first Figma credential was not stored.");
      await ctx.db.patch(credential._id, {
        figmaUserHandle: "Newest Account",
        tokenReceivedAt: newerTokenReceivedAt,
      });
      return { accessTokenCiphertext: credential.accessTokenCiphertext, version: credential.version };
    });

    vi.setSystemTime(baseTime + 3_000);
    const second = await beginConnection(participant, eventSlug);
    installFigmaProvider(
      {
        id: "00123",
        handle: "Stale Account",
        img_url: "https://figma.example.test/stale.png",
        email: "stale@example.test",
      },
      {
        accessToken: "stale-access-token",
        tokenTime: baseTime + 4_000,
        accountTime: baseTime + 9_000,
      },
    );
    await participant.action(api.figmaActions.completeConnection, {
      eventSlug,
      state: second.state,
      code: "second-authorization-code",
    });

    const credential = await backend.run((ctx) =>
      ctx.db.query("figmaOAuthCredentials").withIndex("by_figma_user").unique(),
    );
    expect(credential).toMatchObject({
      figmaUserHandle: "Newest Account",
      tokenReceivedAt: newerTokenReceivedAt,
      accessTokenCiphertext: newerCredential.accessTokenCiphertext,
      version: newerCredential.version,
    });
  });
});

function installFigmaProvider(
  account: object,
  options: {
    accessToken?: string;
    tokenTime?: number;
    accountTime?: number;
  } = {},
) {
  const accessToken = options.accessToken ?? "access-token";
  const providerRequest = vi.fn(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      if (url === "https://api.figma.com/v1/oauth/token") {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Basic ${Buffer.from("figma-client-id:figma-client-secret").toString("base64")}`,
        );
        if (!(init?.body instanceof URLSearchParams)) {
          throw new Error("Figma token exchange did not use a URL-encoded body.");
        }
        expect(init.body.get("grant_type")).toBe("authorization_code");
        expect(init.body.get("code_verifier")).not.toBeNull();
        expect(init.body.get("redirect_uri")).toBe(
          "https://participant.example.test/integrations/figma/callback",
        );
        vi.setSystemTime(options.tokenTime ?? tokenReceivedAt);
        return jsonResponse({
          user_id_string: "00123",
          access_token: accessToken,
          refresh_token: "refresh-token",
          token_type: "bearer",
          expires_in: 3_600,
        });
      }
      if (url === "https://api.figma.com/v1/me") {
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
        vi.setSystemTime(options.accountTime ?? accountReceivedAt);
        return jsonResponse(account);
      }
      throw new Error(`Unexpected Figma request: ${url}`);
    },
  );
  vi.stubGlobal("fetch", providerRequest);
  return providerRequest;
}

async function beginConnection(
  participant: ReturnType<BackendTest["withIdentity"]>,
  eventSlug: string,
) {
  const result = await participant.action(api.figmaActions.beginConnection, { eventSlug });
  const authorizeUrl = new URL(result.authorizeUrl);
  expect(authorizeUrl.origin).toBe("https://www.figma.com");
  expect(authorizeUrl.searchParams.get("scope")).toBe(figmaOAuthScopes.join(","));
  const state = authorizeUrl.searchParams.get("state");
  if (!state) throw new Error("Figma authorization did not return OAuth state.");
  return { state };
}

async function createFixture() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const identity = await createIdentity(backend);
  const eventSlug = `figma-oauth-${crypto.randomUUID()}`;
  await backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId: identity.authUserId,
      googleSubject: `google:${identity.authUserId}`,
      verifiedEmail: "figma-oauth@example.test",
      displayName: "Figma OAuth participant",
      status: "active",
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Figma OAuth fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: baseTime + 86_400_000,
      startsAt: baseTime - 60_000,
      endsAt: baseTime + 86_400_000,
      version: 1,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: "figma-oauth@example.test",
      displayName: "Figma OAuth participant",
      status: "active",
      linkedBy: "participant_provisioning",
      accessVersion: 1,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      participantClass: "external_participant",
      eligibilityStatus: "eligible",
      onboardingStatus: "accepted",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Figma OAuth team",
      publicCode: "FIGMA01",
      leadMembershipId: membershipId,
      status: "admitted",
      activeMemberCount: 1,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 1,
      membershipLocked: true,
      version: 1,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    await ctx.db.insert("teamMembers", {
      eventId,
      teamId,
      membershipId,
      role: "lead",
      status: "active",
      joinedAt: baseTime,
      source: "created",
    });
    const policy = normalizeIntegrationPolicy({
      policyVersion: "figma-oauth-v1",
      requiredGitHubTopic: "code2create-7-0",
      maxActiveGitHubRepositoriesPerTeam: 10,
      maxActiveFigmaFilesPerTeam: 10,
    });
    const policyId = await ctx.db.insert("integrationPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...policy,
      checksum: integrationPolicyChecksum(policy),
      createdByPersonId: personId,
      createdAt: baseTime,
      publishedAt: baseTime,
    });
    await ctx.db.patch(eventId, { publishedIntegrationPolicyId: policyId });
    for (const permissionKey of ["integration.read", "integration.figma.manage"] as const) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "team",
        scopeId: teamId,
        sourceType: "team_lead",
        sourceId: membershipId,
        reason: "Figma OAuth lifecycle fixture",
        validFrom: baseTime - 1,
      });
    }
  });
  return {
    backend,
    eventSlug,
    participant: backend.withIdentity({
      subject: identity.authUserId,
      sessionId: identity.authSessionId,
    }),
  };
}

async function createIdentity(backend: BackendTest) {
  const user: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Figma OAuth participant",
        email: "figma-oauth@example.test",
        emailVerified: true,
        createdAt: baseTime,
        updatedAt: baseTime,
      },
    },
  });
  const authUserId = documentId(user, "Better Auth user");
  const session: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: baseTime + 3_600_000,
        token: crypto.randomUUID(),
        createdAt: baseTime,
        updatedAt: baseTime,
        userId: authUserId,
      },
    },
  });
  return { authUserId, authSessionId: documentId(session, "Better Auth session") };
}

function documentId(value: unknown, label: string) {
  if (typeof value !== "object" || value === null || !("_id" in value)) {
    throw new Error(`${label} did not return a document ID.`);
  }
  const id = value._id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} returned an invalid document ID.`);
  }
  return id;
}

function requestUrl(input: string | URL | Request) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonResponse(body: object) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
