/// <reference types="vite/client" />
import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { Buffer } from "node:buffer";
import { convexTest } from "convex-test";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import { integrationPolicyChecksum } from "./lib/integrationPolicy";
import { insertPermissionGrant } from "./lib/permissions";
import { refreshGithubTeamMetrics } from "./lib/githubTeamMetrics";
import schema from "./schema";

const provider = vi.hoisted(() => ({
  authorize: vi.fn(({ state, redirectUrl }: { state: string; redirectUrl: string }) => ({
    url: `https://github.com/login/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUrl)}`,
  })),
  install: vi.fn(async ({ state }: { state: string }) => `https://github.com/apps/code2create/installations/new?state=${state}`),
  token: vi.fn(async () => ({ authentication: { token: "fixture-user-token" } })),
  list: vi.fn(),
  repositories: vi.fn(async () => ({ data: { repositories: [], total_count: 0 } })),
  userClient: vi.fn(),
  user: vi.fn(async () => ({ data: { id: 789, login: "project-owner" } })),
  installation: vi.fn(),
  installationRepository: vi.fn(async () => ({ data: { id: 900 } })),
  repository: vi.fn(async () => ({ data: {
    id: 900, node_id: "fixture-repository", owner: { login: "project-owner" },
    name: "product", full_name: "project-owner/product", html_url: "https://github.com/project-owner/product",
    private: true, fork: false, default_branch: "main", created_at: "2026-09-01T00:00:00Z",
  } })),
  topics: vi.fn(async () => ({ data: { names: ["code2create-7-0"] } })),
  languages: vi.fn(async () => ({ data: { TypeScript: 100 } })),
  branch: vi.fn(async () => ({ data: { commit: { sha: "fixture-baseline", commit: { committer: { date: "2026-09-01T00:00:00Z" } } } } })),
}));

vi.mock("./lib/githubClient", async (original) => {
  const actual = await original<typeof import("./lib/githubClient")>();
  return {
    ...actual,
    githubConfiguration: () => ({ appId: "123", privateKey: "fixture", clientId: "fixture", clientSecret: "fixture" }),
    repositoryOctokit: async () => ({ rest: { repos: { get: provider.installationRepository } } }),
    githubApp: () => ({
      getInstallationUrl: provider.install,
      oauth: { getWebFlowAuthorizationUrl: provider.authorize, createToken: provider.token },
      octokit: { rest: { apps: { getInstallation: provider.installation } } },
    }),
    GitHubOctokit: class {
      constructor(options: { auth: string }) { provider.userClient(options.auth); }
      rest = { repos: {
        get: provider.repository, getAllTopics: provider.topics,
        listLanguages: provider.languages, getBranch: provider.branch,
      }, users: { getAuthenticated: provider.user }, apps: {
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
  vi.stubEnv("PROVIDER_TOKEN_ENCRYPTION_KEY_VERSION", "fixture-k1");
  vi.stubEnv("PROVIDER_TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 1).toString("base64url"));
  provider.list.mockResolvedValue({ data: { total_count: 1, installations: [account()] } });
  provider.installation.mockResolvedValue({ data: account() });
});
afterEach(() => vi.unstubAllEnvs());

describe("GitHub installation connection", () => {
  test("a missing optional topic counts fully in participant and operations summaries", async () => {
    const f = await connectedFixture();
    provider.topics.mockResolvedValue({ data: { names: [] } });
    await f.add();
    expect((await f.view())?.summary).toMatchObject({
      health: "ready", repositoryCount: 1, completeRepositoryCount: 1,
      completeness: "complete", incompleteRepositoryCount: 0,
    });
    const state = await f.backend.run(async ctx => {
      const binding = await ctx.db.query("githubRepositoryBindings").unique();
      if (!binding) throw new Error("Missing repository");
      // A changed suggestion must not hide otherwise valid evidence on reads.
      await ctx.db.patch(binding._id, { requiredTopic: "previous-event-topic", topicState: "unknown" });
      return { eventId: binding.eventId, teamId: binding.teamId };
    });
    expect((await f.view())?.summary).toMatchObject({ health: "ready", completeness: "complete" });
    const health = await f.backend.query(internal.operationsHealth.computeSnapshot, { eventId: state.eventId });
    expect(health.snapshot.signals.some(signal => signal.key === "github_unverified_topics")).toBe(false);
    await f.backend.run(async ctx => {
      const metric = await ctx.db.query("githubTeamMetrics").unique();
      if (!metric) throw new Error("Missing metric");
      await ctx.db.patch(metric._id, { health: "needs_attention", completeness: "partial", completeRepositoryCount: 0, incompleteRepositoryCount: 1 });
    });
    const before = await f.backend.run(async ctx => ({
      bindings: await ctx.db.query("githubRepositoryBindings").collect(),
      snapshots: await ctx.db.query("githubRepositorySnapshots").collect(),
    }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await f.backend.mutation(internal.githubIntegrations.refreshTeamMetrics, { eventSlug: "github-test", teamId: state.teamId });
    }
    expect((await f.view())?.summary).toMatchObject({ health: "ready", completeness: "complete", completeRepositoryCount: 1, incompleteRepositoryCount: 0 });
    const operations = await f.lead.query(api.integrationOperations.teams, { eventSlug: "github-test" });
    expect(operations.summary.attentionCount).toBe(0);
    expect(operations.teams[0]?.github).toMatchObject({ health: "ready", repositoryCount: 1, incompleteCount: 0 });
    expect(await f.backend.run(async ctx => ({
      bindings: await ctx.db.query("githubRepositoryBindings").collect(),
      snapshots: await ctx.db.query("githubRepositorySnapshots").collect(),
    }))).toEqual(before);
  });

  test.each(["registration_closed", "live"] as const)("adds an accepted team's repository during %s and captures its baseline once", async status => {
    const f = await connectedFixture();
    await f.backend.run(async ctx => {
      const event = await ctx.db.query("events").unique();
      if (!event) throw new Error("Missing event");
      await ctx.db.patch(event._id, { status });
    });
    const result = await f.add();
    expect(await f.add()).toEqual(result);
    expect(provider.repository).toHaveBeenCalledTimes(1);
    expect(provider.installationRepository).toHaveBeenCalledTimes(1);
    expect(provider.userClient).toHaveBeenLastCalledWith("fixture-user-token");
    expect(await f.backend.run(ctx => ctx.db.query("githubRepositoryBindings").unique())).toMatchObject({
      _id: result.bindingId, baselineSha: "fixture-baseline", state: "active", isPrivate: true,
    });
    expect(await f.backend.run(ctx => ctx.db.query("githubRepositorySnapshots").collect())).toMatchObject([
      { reason: "baseline", headSha: "fixture-baseline", commitCount: 0 },
    ]);
    expect((await f.view())?.repositories).toHaveLength(1);
  });

  test.each(["complete", "unselected", "frozen", "no_permission", "no_authorization"] as const)("still blocks repository adds for %s", async mode => {
    const f = await connectedFixture();
    await f.backend.run(async ctx => {
      const event = await ctx.db.query("events").unique();
      const team = await ctx.db.query("teams").unique();
      if (!event || !team) throw new Error("Missing fixture");
      if (mode === "complete") await ctx.db.patch(event._id, { status: "complete" });
      if (mode === "unselected") await ctx.db.patch(team._id, { status: "submitted" });
      if (mode === "frozen") {
        const policy = await ctx.db.query("integrationPolicyVersions").unique();
        if (!policy) throw new Error("Missing policy");
        await ctx.db.patch(policy._id, { githubFreezeAt: 1, checksum: integrationPolicyChecksum({ ...policy, githubFreezeAt: 1 }) });
      }
      if (mode === "no_permission") {
        const grants = await ctx.db.query("permissionGrants").collect();
        for (const grant of grants) await ctx.db.patch(grant._id, { status: "revoked" });
      }
      if (mode === "no_authorization") {
        const authorization = await ctx.db.query("githubRepositoryAuthorizations").unique();
        if (!authorization) throw new Error("Missing authorization");
        await ctx.db.delete(authorization._id);
      }
    });
    await expect(f.add()).rejects.toThrow();
    expect(provider.repository).not.toHaveBeenCalled();
    expect(provider.installationRepository).not.toHaveBeenCalled();
    expect(await f.backend.run(ctx => ctx.db.query("githubRepositoryBindings").collect())).toEqual([]);
  });

  test("rechecks the repository freeze at commit if it changes during provider reads", async () => {
    const f = await connectedFixture();
    provider.branch.mockImplementationOnce(async () => {
      await f.backend.run(async ctx => {
        const policy = await ctx.db.query("integrationPolicyVersions").unique();
        if (!policy) throw new Error("Missing policy");
        await ctx.db.patch(policy._id, { githubFreezeAt: 1, checksum: integrationPolicyChecksum({ ...policy, githubFreezeAt: 1 }) });
      });
      return { data: { commit: { sha: "fixture-baseline", commit: { committer: { date: "2026-09-01T00:00:00Z" } } } } };
    });
    await expect(f.add()).rejects.toThrow("frozen");
    expect(provider.repository).toHaveBeenCalledTimes(1);
    expect(await f.backend.run(ctx => ctx.db.query("githubRepositoryBindings").collect())).toEqual([]);
  });

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

  test("only offers the caller's personal installation and rejects another person's personal account", async () => {
    const f = await fixture();
    const own = { ...account(), target_type: "User" };
    const other = { ...account(999, "other-person"), target_type: "User", account: { id: 222, login: "other-person" } };
    provider.list.mockResolvedValueOnce({ data: { total_count: 2, installations: [own, other] } });
    expect(await f.complete(await f.start())).toEqual({ kind: "choose_installation", installations: [{ installationId: "456", accountLogin: "project-owner" }] });
    provider.installation.mockResolvedValueOnce({ data: other });
    await expect(f.complete(await f.start({ installationId: "999" }))).rejects.toThrow("Connect your own personal GitHub account");
    expect(await f.connections()).toEqual([]);
  });

  test("repository browsing uses the participant's encrypted user authorization, not installation-wide access", async () => {
    const f = await fixture();
    const result = await f.complete(await f.start({ installationId: "456" }));
    if (result.kind !== "connected") throw new Error("Expected connection");
    provider.repositories.mockClear();
    expect(await f.lead.action(api.githubActions.listAvailableRepositories, { eventSlug: "github-test", connectionId: result.connectionId, page: 1 })).toEqual({ repositories: [], totalCount: 0 });
    expect(provider.repositories).toHaveBeenCalledWith({ installation_id: 456, per_page: 50, page: 1 });
    expect(provider.userClient).toHaveBeenLastCalledWith("fixture-user-token");
    const authorization = await f.backend.run(ctx => ctx.db.query("githubRepositoryAuthorizations").unique());
    expect(authorization?.accessTokenCiphertext).not.toContain("fixture-user-token");
  });

  test("legacy, expired and another person's authorizations fail closed without provider calls", async () => {
    for (const mode of ["missing", "expired", "other_person"] as const) {
      const f = await fixture();
      const result = await f.complete(await f.start({ installationId: "456" }));
      if (result.kind !== "connected") throw new Error("Expected connection");
      await f.backend.run(async ctx => {
        const authorization = await ctx.db.query("githubRepositoryAuthorizations").unique();
        if (!authorization) throw new Error("Missing authorization");
        if (mode === "missing") await ctx.db.delete(authorization._id);
        else if (mode === "expired") await ctx.db.patch(authorization._id, { expiresAt: 1 });
        else {
          const person = await ctx.db.get(authorization.personId);
          if (!person) throw new Error("Missing person");
          const { _id, _creationTime, ...fields } = person;
          const otherId = await ctx.db.insert("people", { ...fields, authUserId: "other-user", verifiedEmail: "other@example.test" });
          await ctx.db.patch(authorization._id, { personId: otherId });
        }
      });
      provider.repositories.mockClear();
      await expect(f.lead.action(api.githubActions.listAvailableRepositories, { eventSlug: "github-test", connectionId: result.connectionId, page: 1 })).rejects.toThrow("Connect your own GitHub account");
      expect(provider.repositories).not.toHaveBeenCalled();
    }
  });

  test("cross-team connections are rejected even when an authorization exists", async () => {
    const f = await fixture();
    const result = await f.complete(await f.start({ installationId: "456" }));
    if (result.kind !== "connected") throw new Error("Expected connection");
    await f.backend.run(async ctx => {
      const connection = await ctx.db.get(result.connectionId);
      const team = connection ? await ctx.db.get(connection.teamId) : null;
      if (!team) throw new Error("Missing team");
      const { _id, _creationTime, ...fields } = team;
      const otherTeamId = await ctx.db.insert("teams", { ...fields, name: "Other team", publicCode: "OTHER" });
      await ctx.db.patch(result.connectionId, { teamId: otherTeamId });
    });
    provider.repositories.mockClear();
    await expect(f.lead.action(api.githubActions.listAvailableRepositories, { eventSlug: "github-test", connectionId: result.connectionId, page: 1 })).rejects.toThrow("Reconnect this GitHub account");
    expect(provider.repositories).not.toHaveBeenCalled();
  });

  test("an old expiration job cannot delete refreshed consent", async () => {
    const f = await fixture();
    await f.complete(await f.start({ installationId: "456" }));
    const authorization = await f.backend.run(ctx => ctx.db.query("githubRepositoryAuthorizations").unique());
    if (!authorization) throw new Error("Missing authorization");
    await f.backend.mutation(internal.githubIntegrations.expireRepositoryAuthorization, { authorizationId: authorization._id, expiresAt: 1 });
    expect(await f.backend.run(ctx => ctx.db.get(authorization._id))).not.toBeNull();
  });

  test("the participant account list hides empty legacy connections without deleting their history", async () => {
    const f = await fixture();
    await f.complete(await f.start({ installationId: "456" }));
    expect((await f.view())?.connections).toMatchObject([{ accountLogin: "project-owner", canBrowse: true }]);
    await f.backend.run(async ctx => {
      const authorization = await ctx.db.query("githubRepositoryAuthorizations").unique();
      if (!authorization) throw new Error("Missing authorization");
      await ctx.db.delete(authorization._id);
    });
    expect((await f.view())?.connections).toEqual([]);
    expect(await f.connections()).toHaveLength(1);
    expect((await f.view())?.repositories).toEqual([]);
  });

  test("another person's consent does not make an empty account appear in the viewer's list", async () => {
    const f = await fixture();
    await f.complete(await f.start({ installationId: "456" }));
    await f.backend.run(async ctx => {
      const authorization = await ctx.db.query("githubRepositoryAuthorizations").unique();
      const person = authorization ? await ctx.db.get(authorization.personId) : null;
      if (!authorization || !person) throw new Error("Missing authorization");
      const { _id, _creationTime, ...fields } = person;
      const otherId = await ctx.db.insert("people", { ...fields, authUserId: "teammate", verifiedEmail: "teammate@example.test" });
      await ctx.db.patch(authorization._id, { personId: otherId });
    });
    expect((await f.view())?.connections).toEqual([]);
  });

  test("an existing submitted repository retains its account when personal consent expires", async () => {
    const f = await fixture();
    const result = await f.complete(await f.start({ installationId: "456" }));
    if (result.kind !== "connected") throw new Error("Expected connection");
    await f.backend.run(async ctx => {
      const connection = await ctx.db.get(result.connectionId);
      const authorization = await ctx.db.query("githubRepositoryAuthorizations").unique();
      if (!connection || !authorization) throw new Error("Missing connection");
      const now = Date.now();
      const bindingId = await ctx.db.insert("githubRepositoryBindings", {
        eventId: connection.eventId, teamId: connection.teamId, installationConnectionId: connection._id,
        repositoryId: "123", repositoryNodeId: "R_123", owner: "project-owner", name: "submitted",
        fullName: "project-owner/submitted", url: "https://github.com/project-owner/submitted",
        isPrivate: true, isFork: false, defaultBranch: "main", kind: "full_product", purpose: "Team project",
        trackedBranch: "main", displayOrder: 0, requiredTopic: "code2create-7-0", topicState: "present",
        state: "active", baselineSha: "a".repeat(40), currentHeadSha: "a".repeat(40), syncRevision: 1,
        syncedRevision: 1, syncState: "ready", version: 1, providerCreatedAt: now, connectedAt: now, updatedAt: now,
      });
      await ctx.db.insert("githubRepositoryMetrics", {
        eventId: connection.eventId, teamId: connection.teamId, repositoryBindingId: bindingId,
        baselineSha: "a".repeat(40), currentHeadSha: "a".repeat(40), pushCount: 0, commitCount: 0,
        additions: 0, deletions: 0, changedFiles: 0, observedCommitShas: [], commitIdentityComplete: true,
        languageBytes: [], completeness: "complete", compareTruncated: false, version: 1, capturedAt: now,
      });
      await ctx.db.delete(authorization._id);
      await refreshGithubTeamMetrics(ctx, { eventId: connection.eventId, teamId: connection.teamId, now });
    });
    const view = await f.view();
    expect(view?.connections).toMatchObject([{ id: result.connectionId, canBrowse: false }]);
    expect(view?.repositories).toMatchObject([{ fullName: "project-owner/submitted" }]);
  });
});

async function connectedFixture() {
  const f = await fixture();
  const connection = await f.complete(await f.start({ installationId: "456" }));
  if (connection.kind !== "connected") throw new Error("Expected connection");
  const args = {
    eventSlug: "github-test", connectionId: connection.connectionId, repositoryId: "900",
    owner: "project-owner", name: "product", kind: "full_product" as const,
    purpose: "Whole product", trackedBranch: "main", clientOperationId: crypto.randomUUID(),
  };
  return { ...f, add: () => f.lead.action(api.githubActions.addRepository, args) };
}

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
    if (grant) {
      for (const permissionKey of ["integration.github.manage", "integration.read"] as const) {
        await insertPermissionGrant(ctx, { eventId, personId, eventAccessSubjectId: subjectId, permissionKey, scopeType: "team", scopeId: teamId, sourceType: "event_subject", sourceId: subjectId, reason: "Test team lead", validFrom: now - 1 });
      }
    }
  });
  const lead = backend.withIdentity({ subject: userId, sessionId });
  return {
    backend,
    lead,
    view: () => lead.query(api.githubIntegrations.current, { eventSlug }),
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
