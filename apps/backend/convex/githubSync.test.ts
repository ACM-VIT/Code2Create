import {
  githubSyncCallbackContext,
  githubSyncProtocolVersion,
  githubWebhookCallbackContext,
  githubWebhookProtocolVersion,
  signServiceBody,
} from "@code2create/domain";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, afterEach, describe, expect, test } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

const callbackSecret = "github-sync-callback-fixture-secret-0123456789";
const originalEnvironment = {
  INTELLIGENCE_CALLBACK_SECRET: process.env.INTELLIGENCE_CALLBACK_SECRET,
  AUTH_SITE_URL: process.env.AUTH_SITE_URL,
  PARTICIPANT_SITE_URL: process.env.PARTICIPANT_SITE_URL,
  OPERATIONS_SITE_URL: process.env.OPERATIONS_SITE_URL,
};

process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";

afterEach(() => {
  restoreEnvironment("INTELLIGENCE_CALLBACK_SECRET");
});

afterAll(() => {
  for (const name of ["AUTH_SITE_URL", "PARTICIPANT_SITE_URL", "OPERATIONS_SITE_URL"] as const) {
    restoreEnvironment(name);
  }
});

function restoreEnvironment(name: keyof typeof originalEnvironment) {
  const value = originalEnvironment[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const observation = {
  repositoryId: "9001",
  owner: "measured-moon",
  name: "portal",
  fullName: "measured-moon/portal",
  url: "https://github.com/measured-moon/portal",
  isPrivate: false,
  isFork: false,
  defaultBranch: "main",
  topicState: "present" as const,
  headSha: "b".repeat(40),
  providerCommitAt: Date.UTC(2027, 7, 8, 10, 0, 0),
  commitCount: 2,
  additions: 40,
  deletions: 5,
  changedFiles: 3,
  observedCommitShas: ["c".repeat(40), "d".repeat(40)],
  commitIdentityComplete: true,
  languageBytes: [{ language: "TypeScript", bytes: 1200 }],
  completeness: "complete" as const,
  compareTruncated: false,
};

describe("GitHub repository sync", () => {
  test("freezes one request per revision and refuses a second while it is in flight", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);

    const request = await backend.mutation(internal.githubSync.claimSyncRequest, {
      bindingId: fixture.bindingId,
    });
    expect(request).toEqual({
      protocolVersion: githubSyncProtocolVersion,
      bindingId: fixture.bindingId,
      syncRevision: 2,
      installationId: "52001",
      repositoryId: "9001",
      owner: "measured-moon",
      name: "portal",
      trackedBranch: "main",
      baselineSha: "a".repeat(40),
      requiredTopic: "code2create-7",
    });
    const running = await backend.run((ctx) => ctx.db.get(fixture.bindingId));
    expect(running).toMatchObject({ syncState: "running" });
    expect(running?.syncLeaseExpiresAt).toBeGreaterThan(Date.now());
    expect(
      await backend.mutation(internal.githubSync.claimSyncRequest, { bindingId: fixture.bindingId }),
    ).toBeNull();
  });

  test("marks a binding inaccessible when its installation is no longer active", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    await backend.run((ctx) => ctx.db.patch(fixture.connectionId, { state: "revoked" }));

    expect(
      await backend.mutation(internal.githubSync.claimSyncRequest, { bindingId: fixture.bindingId }),
    ).toBeNull();
    expect(await backend.run((ctx) => ctx.db.get(fixture.bindingId))).toMatchObject({
      state: "inaccessible",
      syncState: "error",
      syncErrorCode: "installation_unavailable",
    });
  });

  test("applies a settlement once, then reports the replay as already settled", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    await backend.mutation(internal.githubSync.claimSyncRequest, { bindingId: fixture.bindingId });

    const settlement = {
      bindingId: fixture.bindingId,
      syncRevision: 2,
      status: "succeeded" as const,
      observation,
    };
    expect(await backend.mutation(internal.githubSync.apply, { settlement })).toBe("accepted");
    expect(await backend.mutation(internal.githubSync.apply, { settlement })).toBe(
      "already_settled",
    );

    const result = await backend.run(async (ctx) => ({
      binding: await ctx.db.get(fixture.bindingId),
      metric: await ctx.db.get(fixture.metricId),
      snapshots: await ctx.db
        .query("githubRepositorySnapshots")
        .withIndex("by_binding_time", (index) => index.eq("repositoryBindingId", fixture.bindingId))
        .collect(),
      team: await ctx.db
        .query("githubTeamMetrics")
        .withIndex("by_team", (index) => index.eq("teamId", fixture.teamId))
        .unique(),
    }));
    expect(result.binding).toMatchObject({
      syncState: "ready",
      syncedRevision: 2,
      currentHeadSha: observation.headSha,
      topicState: "present",
    });
    expect(result.binding?.syncLeaseExpiresAt).toBeUndefined();
    expect(result.binding?.pendingHeadSha).toBeUndefined();
    expect(result.metric).toMatchObject({
      commitCount: 2,
      additions: 40,
      deletions: 5,
      changedFiles: 3,
      observedCommitShas: observation.observedCommitShas,
      lastProviderCommitAt: observation.providerCommitAt,
      version: 2,
    });
    expect(result.snapshots.map((snapshot) => snapshot.reason)).toEqual(["reconcile"]);
    expect(result.team).toMatchObject({ health: "ready", repositoryCount: 1 });
  });

  test("keeps a binding pending when a newer revision arrived during the sync", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    await backend.mutation(internal.githubSync.claimSyncRequest, { bindingId: fixture.bindingId });
    await backend.run(async (ctx) => {
      const binding = await ctx.db.get(fixture.bindingId);
      if (!binding) throw new Error("Binding fixture missing.");
      await ctx.db.patch(binding._id, { syncRevision: 3, pendingHeadSha: "e".repeat(40) });
    });

    expect(
      await backend.mutation(internal.githubSync.apply, {
        settlement: { bindingId: fixture.bindingId, syncRevision: 2, status: "succeeded", observation },
      }),
    ).toBe("accepted");
    expect(await backend.run((ctx) => ctx.db.get(fixture.bindingId))).toMatchObject({
      syncState: "pending",
      syncedRevision: 2,
      syncRevision: 3,
      topicState: "unknown",
      currentHeadSha: observation.headSha,
    });
  });

  test("records rate limits and failures without touching the last verified metrics", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    await backend.mutation(internal.githubSync.claimSyncRequest, { bindingId: fixture.bindingId });

    expect(
      await backend.mutation(internal.githubSync.apply, {
        settlement: {
          bindingId: fixture.bindingId,
          syncRevision: 2,
          status: "rate_limited",
          errorCode: "github_rate_limited",
          retryAfterMs: 90_000,
        },
      }),
    ).toBe("accepted");
    const rateLimited = await backend.run((ctx) => ctx.db.get(fixture.bindingId));
    expect(rateLimited).toMatchObject({ syncState: "rate_limited", syncedRevision: 1 });
    expect(rateLimited?.syncLeaseExpiresAt).toBeGreaterThan(Date.now() + 60_000);

    expect(
      await backend.mutation(internal.githubSync.apply, {
        settlement: {
          bindingId: fixture.bindingId,
          syncRevision: 2,
          status: "failed",
          errorCode: "github_not_found",
        },
      }),
    ).toBe("accepted");
    expect(await backend.run((ctx) => ctx.db.get(fixture.bindingId))).toMatchObject({
      syncState: "error",
      syncErrorCode: "github_not_found",
      syncedRevision: 1,
    });
    expect(await backend.run((ctx) => ctx.db.get(fixture.metricId))).toMatchObject({ version: 1 });
  });

  test("re-requests overdue and lost reconciliations from the sweep", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    await backend.run((ctx) =>
      ctx.db.patch(fixture.bindingId, {
        syncState: "running",
        syncLeaseExpiresAt: Date.now() - 1,
      }),
    );

    expect(await backend.mutation(internal.githubSync.sweep, {})).toBe(1);
    const swept = await backend.run((ctx) => ctx.db.get(fixture.bindingId));
    expect(swept).toMatchObject({ syncState: "pending" });
    expect(swept?.syncLeaseExpiresAt).toBeUndefined();
  });

  test("accepts only correctly signed Worker settlements over HTTP", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    process.env.INTELLIGENCE_CALLBACK_SECRET = callbackSecret;
    await backend.mutation(internal.githubSync.claimSyncRequest, { bindingId: fixture.bindingId });
    const body = JSON.stringify({
      protocolVersion: githubSyncProtocolVersion,
      bindingId: fixture.bindingId,
      syncRevision: 2,
      completedAt: Date.now(),
      status: "succeeded",
      observation,
    });

    const forged = await backend.fetch("/intelligence/github/repository-syncs", {
      method: "POST",
      headers: await signedHeaders(body, githubWebhookCallbackContext),
      body,
    });
    expect(forged.status).toBe(401);

    const accepted = await backend.fetch("/intelligence/github/repository-syncs", {
      method: "POST",
      headers: await signedHeaders(body, githubSyncCallbackContext),
      body,
    });
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toEqual({ state: "accepted" });

    const replay = await backend.fetch("/intelligence/github/repository-syncs", {
      method: "POST",
      headers: await signedHeaders(body, githubSyncCallbackContext),
      body,
    });
    await expect(replay.json()).resolves.toEqual({ state: "already_settled" });
  });

  test("forwards verified provider deliveries once and ignores unknown repositories", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    process.env.INTELLIGENCE_CALLBACK_SECRET = callbackSecret;
    const push = {
      protocolVersion: githubWebhookProtocolVersion,
      deliveryId: "delivery-push-1",
      eventName: "push",
      payloadHash: "1".repeat(64),
      event: {
        kind: "push",
        installationId: "52001",
        repositoryId: "9001",
        ref: "refs/heads/main",
        beforeSha: "a".repeat(40),
        afterSha: "f".repeat(40),
        created: false,
        deleted: false,
        forced: false,
        pushedCommitCount: 1,
      },
    };
    const body = JSON.stringify(push);

    const first = await backend.fetch("/intelligence/github/webhooks", {
      method: "POST",
      headers: await signedHeaders(body, githubWebhookCallbackContext),
      body,
    });
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toEqual({ state: "accepted" });
    const duplicate = await backend.fetch("/intelligence/github/webhooks", {
      method: "POST",
      headers: await signedHeaders(body, githubWebhookCallbackContext),
      body,
    });
    await expect(duplicate.json()).resolves.toEqual({ state: "duplicate" });

    const unknown = JSON.stringify({
      ...push,
      deliveryId: "delivery-push-2",
      event: { ...push.event, repositoryId: "1" },
    });
    const ignored = await backend.fetch("/intelligence/github/webhooks", {
      method: "POST",
      headers: await signedHeaders(unknown, githubWebhookCallbackContext),
      body: unknown,
    });
    await expect(ignored.json()).resolves.toEqual({ state: "ignored" });

    // The accepted push dispatches a Worker request immediately; without a
    // reachable Worker the dispatch releases the binding back to pending.
    await backend.finishInProgressScheduledFunctions();
    expect(await backend.run((ctx) => ctx.db.get(fixture.bindingId))).toMatchObject({
      syncRevision: 3,
      pendingHeadSha: "f".repeat(40),
      syncState: "pending",
    });
    expect(
      await backend.run((ctx) => ctx.db.query("githubWebhookDeliveries").collect()),
    ).toHaveLength(2);
  });
});

async function signedHeaders(body: string, context: string) {
  const timestamp = String(Date.now());
  return {
    "content-type": "application/json",
    "x-c2c-timestamp": timestamp,
    "x-c2c-signature": await signServiceBody({
      context,
      secret: callbackSecret,
      timestamp,
      body,
    }),
  };
}

async function seedFixture(backend: BackendTest) {
  const now = Date.UTC(2027, 7, 8, 9, 0, 0);
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: `github-sync-${now}`,
      name: "Code2Create GitHub sync fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: Date.now() + 86_400_000,
      startsAt: now,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const personId = await ctx.db.insert("people", {
      authUserId: `github-sync-user-${now}`,
      googleSubject: `github-sync-subject-${now}`,
      verifiedEmail: `github-sync-${now}@example.test`,
      displayName: "Ria Nair",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `github-sync-${now}@example.test`,
      displayName: "Ria Nair",
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
      name: "Measured Moon",
      publicCode: "SYNC01",
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
    const connectionId = await ctx.db.insert("githubInstallationConnections", {
      eventId,
      teamId,
      installationId: "52001",
      accountId: "41001",
      accountLogin: "measured-moon",
      targetType: "Organization",
      repositorySelection: "selected",
      state: "active",
      connectedByPersonId: personId,
      connectedAt: now,
      lastVerifiedAt: now,
      version: 1,
    });
    const bindingId: Id<"githubRepositoryBindings"> = await ctx.db.insert(
      "githubRepositoryBindings",
      {
        eventId,
        teamId,
        installationConnectionId: connectionId,
        repositoryId: "9001",
        repositoryNodeId: "R_portal",
        owner: "measured-moon",
        name: "portal",
        fullName: "measured-moon/portal",
        url: "https://github.com/measured-moon/portal",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        kind: "frontend",
        purpose: "Participant portal",
        trackedBranch: "main",
        displayOrder: 1,
        requiredTopic: "code2create-7",
        topicState: "present",
        state: "active",
        baselineSha: "a".repeat(40),
        currentHeadSha: "a".repeat(40),
        syncRevision: 2,
        syncedRevision: 1,
        syncState: "pending",
        version: 2,
        providerCreatedAt: now,
        connectedAt: now,
        updatedAt: now,
      },
    );
    const metricId = await ctx.db.insert("githubRepositoryMetrics", {
      eventId,
      teamId,
      repositoryBindingId: bindingId,
      baselineSha: "a".repeat(40),
      currentHeadSha: "a".repeat(40),
      pushCount: 1,
      commitCount: 0,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      observedCommitShas: [],
      commitIdentityComplete: true,
      languageBytes: [],
      completeness: "complete",
      compareTruncated: false,
      capturedAt: now,
      version: 1,
    });
    return { eventId, teamId, connectionId, bindingId, metricId, now };
  });
}
