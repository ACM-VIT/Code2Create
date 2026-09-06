/// <reference types="vite/client" />
import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest } from "convex-test";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { api, components } from "./_generated/api";
import { integrationPolicyChecksum } from "./lib/integrationPolicy";
import { insertPermissionGrant } from "./lib/permissions";
import schema from "./schema";

const provider = vi.hoisted(() => ({
  authorize: vi.fn(({ state, redirectUrl }: { state: string; redirectUrl: string }) => ({
    url: `https://github.com/login/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUrl)}`,
  })),
  install: vi.fn(async ({ state }: { state: string }) => `https://github.com/apps/code2create/installations/new?state=${state}`),
  token: vi.fn(async () => ({ authentication: { token: "fixture-user-token" } })),
  list: vi.fn(),
  repositories: vi.fn(async () => ({ data: { repositories: [] } })),
  installation: vi.fn(),
}));

vi.mock("./lib/githubClient", async (original) => {
  const actual = await original<typeof import("./lib/githubClient")>();
  return {
    ...actual,
    githubConfiguration: () => ({ appId: "123", privateKey: "fixture", clientId: "fixture", clientSecret: "fixture" }),
    githubApp: () => ({
      getInstallationUrl: provider.install,
      oauth: { getWebFlowAuthorizationUrl: provider.authorize, createToken: provider.token },
      octokit: { rest: { apps: { getInstallation: provider.installation } } },
    }),
    GitHubOctokit: class {
      rest = { apps: {
        listInstallationsForAuthenticatedUser: provider.list,
        listInstallationReposForAuthenticatedUser: provider.repositories,
      } };
    },
  };
});

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob("../node_modules/@convex-dev/better-auth/src/component/**/*.ts");
const account = (id = 456, login = "project-owner") => ({
  id, app_id: 123, account: { id: 789, login }, suspended_at: null,
  target_type: "Organization", repository_selection: "all",
  permissions: { contents: "read", metadata: "read" }, events: ["push"],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PARTICIPANT_SITE_URL", "https://c2c.sh");
  vi.stubEnv("C2C_DEPLOYMENT_ENVIRONMENT", "local");
  provider.list.mockResolvedValue({ data: { total_count: 1, installations: [account()] } });
  provider.installation.mockResolvedValue({ data: account() });
});
afterEach(() => vi.unstubAllEnvs());

describe("GitHub installation connection", () => {
  test("authorizes an existing App, accepts a callback without installation_id, and asks which account to connect", async () => {
    const f = await fixture();
    const state = await f.start();
    expect(provider.authorize).toHaveBeenCalledWith({ state, redirectUrl: "https://c2c.sh/integrations/github/callback" });
    expect(provider.install).not.toHaveBeenCalled();
    expect(await f.complete(state)).toEqual({ kind: "choose_installation", installations: [{ installationId: "456", accountLogin: "project-owner" }] });
    expect(await f.connections()).toEqual([]);
    expect(provider.repositories).not.toHaveBeenCalled();
    await expect(f.complete(state)).rejects.toThrow("Start the GitHub connection again");
    expect(provider.token).toHaveBeenCalledTimes(1);
  });

  test("verifies a selected installation afresh, connects before build start, and replays idempotently", async () => {
    const f = await fixture();
    const state = await f.start({ installationId: "456" });
    const result = await f.complete(state);
    expect(result.kind).toBe("connected");
    expect(provider.repositories).toHaveBeenCalledWith({ installation_id: 456, per_page: 1, page: 1 });
    expect(provider.installation).toHaveBeenCalledWith({ installation_id: 456 });
    expect(await f.connections()).toMatchObject([{ installationId: "456", repositorySelection: "all", state: "active" }]);
    expect(await f.complete(state)).toEqual(result);
    expect(provider.token).toHaveBeenCalledTimes(1);
  });

  test("retains new-installation callbacks without automatically submitting repositories", async () => {
    const f = await fixture();
    const state = await f.start({ install: true });
    expect(provider.install).toHaveBeenCalledWith({ state });
    expect(provider.authorize).not.toHaveBeenCalled();
    expect((await f.complete(state, "456")).kind).toBe("connected");
    expect(await f.backend.run(ctx => ctx.db.query("githubRepositoryBindings").collect())).toEqual([]);
  });

  test("offers installation when the user has no accessible App installation", async () => {
    provider.list.mockResolvedValue({ data: { total_count: 0, installations: [] } });
    const f = await fixture();
    expect(await f.complete(await f.start())).toEqual({ kind: "choose_installation", installations: [] });
  });

  test("includes all pages but excludes suspended installations and other Apps", async () => {
    provider.list.mockResolvedValueOnce({ data: { total_count: 101, installations: [account(), { ...account(457), suspended_at: "today" }, { ...account(458), app_id: 999 }] } });
    provider.list.mockResolvedValueOnce({ data: { total_count: 101, installations: [account(459, "second-owner")] } });
    const f = await fixture();
    expect(await f.complete(await f.start())).toEqual({ kind: "choose_installation", installations: [
      { installationId: "456", accountLogin: "project-owner" }, { installationId: "459", accountLogin: "second-owner" },
    ] });
    expect(provider.list).toHaveBeenLastCalledWith({ per_page: 100, page: 2 });
  });

  test("rejects unknown state before exchanging a GitHub code", async () => {
    const f = await fixture();
    await expect(f.complete("x".repeat(43))).rejects.toThrow("invalid");
    expect(provider.token).not.toHaveBeenCalled();
  });

  test("rejects expired intent before exchanging a GitHub code", async () => {
    const f = await fixture();
    const state = await f.start();
    await f.backend.run(async ctx => {
      const intent = await ctx.db.query("githubSetupIntents").unique();
      if (!intent) throw new Error("Missing intent");
      await ctx.db.patch(intent._id, { expiresAt: Date.now() - 1 });
    });
    await expect(f.complete(state)).rejects.toThrow("Start the GitHub connection again");
    expect(provider.token).not.toHaveBeenCalled();
  });

  test("does not silently truncate a large installation list", async () => {
    const f = await fixture();
    provider.list.mockResolvedValue({ data: { total_count: 1001, installations: [account()] } });
    await expect(f.complete(await f.start())).rejects.toThrow("too many installations");
    expect(provider.list).toHaveBeenCalledTimes(10);
    expect(await f.connections()).toEqual([]);
  });

  test("does not trust a callback installation that differs from the selected account", async () => {
    const f = await fixture();
    await expect(f.complete(await f.start({ installationId: "456" }), "999")).rejects.toThrow("different installation");
    expect(await f.connections()).toEqual([]);
  });

  test("does not connect when the user's access has been revoked", async () => {
    const f = await fixture();
    provider.repositories.mockRejectedValueOnce(new Error("Access revoked"));
    await expect(f.complete(await f.start({ installationId: "456" }))).rejects.toThrow("could not verify");
    expect(await f.connections()).toEqual([]);
    expect(provider.installation).not.toHaveBeenCalled();
  });

  test("rejects suspended or underscoped installations", async () => {
    for (const data of [{ ...account(), suspended_at: "today" }, { ...account(), permissions: {} }]) {
      const f = await fixture();
      provider.installation.mockResolvedValueOnce({ data });
      await expect(f.complete(await f.start({ installationId: "456" }))).rejects.toThrow();
      expect(await f.connections()).toEqual([]);
    }
  });

  test("requires the team permission before initiating OAuth", async () => {
    const f = await fixture(false);
    await expect(f.start()).rejects.toThrow();
    expect(await f.backend.run(ctx => ctx.db.query("githubSetupIntents").collect())).toEqual([]);
  });
});

async function fixture(grant = true) {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const now = Date.now();
  const email = "lead@example.test";
  const userId = documentId(await backend.mutation(components.betterAuth.adapter.create, {
    input: { model: "user", data: { name: "Lead", email, emailVerified: true, createdAt: now, updatedAt: now } },
  }));
  const sessionId = documentId(await backend.mutation(components.betterAuth.adapter.create, {
    input: { model: "session", data: { userId, token: crypto.randomUUID(), expiresAt: now + 3600000, createdAt: now, updatedAt: now } },
  }));
  const eventSlug = "github-test";
  await backend.run(async ctx => {
    const eventId = await ctx.db.insert("events", { slug: eventSlug, name: "GitHub fixture", timezone: "Asia/Kolkata", status: "registration_closed", vitEmailDomains: ["vitstudent.ac.in"], applicationsCloseAt: now - 1000, startsAt: now + 3600000, version: 1, createdAt: now, updatedAt: now });
    const personId = await ctx.db.insert("people", { authUserId: userId, googleSubject: "fixture", verifiedEmail: email, displayName: "Lead", status: "active", createdAt: now, updatedAt: now });
    const subjectId = await ctx.db.insert("eventAccessSubjects", { eventId, personId, emailNormalized: email, displayName: "Lead", status: "active", linkedBy: "access_invitation", accessVersion: 1, createdAt: now, updatedAt: now });
    const membershipId = await ctx.db.insert("eventMemberships", { eventId, personId, eventAccessSubjectId: subjectId, participantClass: "external_participant", eligibilityStatus: "eligible", onboardingStatus: "accepted", acceptedParticipantPolicyVersionIds: [], createdAt: now, updatedAt: now });
    const teamId = await ctx.db.insert("teams", { eventId, name: "Fixture", publicCode: "GHFIX", leadMembershipId: membershipId, status: "confirmed", activeMemberCount: 1, activeVitMemberCount: 0, activeExternalMemberCount: 1, membershipLocked: true, version: 1, createdAt: now, updatedAt: now });
    await ctx.db.insert("teamMembers", { eventId, teamId, membershipId, role: "lead", status: "active", source: "created", joinedAt: now });
    const policy = { policyVersion: "fixture", requiredGitHubTopic: "code2create-7-0", maxActiveGitHubRepositoriesPerTeam: 10 };
    const policyId = await ctx.db.insert("integrationPolicyVersions", { ...policy, eventId, version: 1, status: "published", checksum: integrationPolicyChecksum(policy), createdByPersonId: personId, createdAt: now, publishedAt: now });
    await ctx.db.patch(eventId, { publishedIntegrationPolicyId: policyId });
    if (grant) await insertPermissionGrant(ctx, { eventId, personId, eventAccessSubjectId: subjectId, permissionKey: "integration.github.manage", scopeType: "team", scopeId: teamId, sourceType: "event_subject", sourceId: subjectId, reason: "Test team lead", validFrom: now - 1 });
  });
  const lead = backend.withIdentity({ subject: userId, sessionId });
  return {
    backend,
    async start(options: { installationId?: string; install?: boolean } = {}) {
      const result = await lead.action(api.githubActions.beginConnection, { eventSlug, ...options });
      const state = new URL(result.installUrl).searchParams.get("state");
      if (!state) throw new Error("Missing setup state");
      return state;
    },
    complete: (state: string, installationId?: string) => lead.action(api.githubActions.completeConnection, { eventSlug, state, code: "fixture-code", ...(installationId ? { installationId } : {}) }),
    connections: () => backend.run(ctx => ctx.db.query("githubInstallationConnections").collect()),
  };
}

function documentId(value: unknown): string {
  if (typeof value !== "object" || !value || !("_id" in value) || typeof value._id !== "string") throw new Error("Missing auth fixture ID");
  return value._id;
}
