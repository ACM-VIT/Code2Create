import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.ts";
import {
  githubTopicVerificationIsCurrent,
  integrationPolicyChecksum,
  githubIntegrationFrozenAt,
  loadPublishedIntegrationPolicy,
  normalizeIntegrationPolicy,
  publishIntegrationPolicy,
  saveIntegrationPolicyDraft,
  type IntegrationPolicy,
} from "./lib/integrationPolicy.ts";
import { permissionCatalog } from "./lib/permissionCatalog.ts";
import { fingerprintText } from "./lib/strings.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("integration policy configuration", () => {
  test.each([false, true])("loads legacy Figma policy records without changing their checksums (freeze: %s)", async (withFreeze) => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, `legacy-${withFreeze}`);
    const legacy = {
      policyVersion: "integrations-v1",
      requiredGitHubTopic: "code2create-7",
      maxActiveGitHubRepositoriesPerTeam: 10,
      maxActiveFigmaFilesPerTeam: 10,
      ...(withFreeze ? { githubFreezeAt: fixture.now, figmaFreezeAt: fixture.now } : {}),
    };
    const checksum = fingerprintText(JSON.stringify(legacy));
    await backend.run((ctx) => ctx.db.patch(fixture.policyId, { ...legacy, checksum }));
    const loaded = await backend.run((ctx) => loadPublishedIntegrationPolicy(ctx, fixture.event));
    expect(loaded.policy.checksum).toBe(checksum);
    expect(loaded.normalized).toEqual({
      policyVersion: legacy.policyVersion,
      requiredGitHubTopic: legacy.requiredGitHubTopic,
      maxActiveGitHubRepositoriesPerTeam: legacy.maxActiveGitHubRepositoriesPerTeam,
      ...(withFreeze ? { githubFreezeAt: fixture.now } : {}),
    });
    const draft = await backend.run((ctx) => saveIntegrationPolicyDraft(ctx, {
      event: fixture.event, actorPersonId: fixture.personId,
      policy: { ...loaded.normalized, policyVersion: "integrations-v2" }, now: fixture.now + 1,
    }));
    const saved = await backend.run((ctx) => ctx.db.get(draft.policyVersionId));
    expect(saved).not.toHaveProperty("maxActiveFigmaFilesPerTeam");
    expect(saved).not.toHaveProperty("figmaFreezeAt");
  });

  test("publishes a legacy draft and still rejects altered legacy policy content", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "legacy-draft");
    const legacy = {
      policyVersion: "integrations-v2",
      requiredGitHubTopic: "code2create-7-0",
      maxActiveGitHubRepositoriesPerTeam: 10,
      maxActiveFigmaFilesPerTeam: 10,
      githubFreezeAt: fixture.now,
      figmaFreezeAt: fixture.now,
    };
    const checksum = fingerprintText(JSON.stringify(legacy));
    const draftId = await backend.run((ctx) => ctx.db.insert("integrationPolicyVersions", {
      ...legacy, checksum, eventId: fixture.event._id, version: 2, status: "draft",
      createdByPersonId: fixture.personId, createdAt: fixture.now,
    }));
    await backend.run((ctx) => publishIntegrationPolicy(ctx, {
      event: fixture.event, draftPolicyId: draftId, expectedDraftChecksum: checksum, now: fixture.now + 1,
    }));
    const event = { ...fixture.event, publishedIntegrationPolicyId: draftId };
    await backend.run((ctx) => loadPublishedIntegrationPolicy(ctx, event));
    await backend.run((ctx) => ctx.db.patch(draftId, { figmaFreezeAt: fixture.now + 1 }));
    await expect(backend.run((ctx) => loadPublishedIntegrationPolicy(ctx, event)))
      .rejects.toThrow("checksum is invalid");
    await backend.run((ctx) => ctx.db.patch(draftId, { figmaFreezeAt: fixture.now, requiredGitHubTopic: "changed" }));
    await expect(backend.run((ctx) => loadPublishedIntegrationPolicy(ctx, event)))
      .rejects.toThrow("checksum is invalid");
  });

  test("keeps read, draft, validation, and publication independently event scoped", () => {
    for (const permissionKey of [
      "configuration.integration.read",
      "configuration.integration.draft.create",
      "configuration.integration.validate",
      "configuration.integration.publish",
    ] as const) {
      expect(permissionCatalog[permissionKey]).toEqual({ scopes: [], eventWide: true });
    }
  });

  test("normalizes the topic and freezes at the exact server-time boundary", () => {
    const freezeAt = Date.UTC(2027, 7, 9, 3, 30);
    const normalized = normalizeIntegrationPolicy({
      ...policy("integrations-v2"),
      requiredGitHubTopic: "  Code2Create-7-0  ",
      githubFreezeAt: freezeAt,
    });
    expect(normalized.requiredGitHubTopic).toBe("code2create-7-0");
    expect(normalizeIntegrationPolicy({ ...policy("no-topic"), requiredGitHubTopic: "  " }).requiredGitHubTopic).toBe("");
    expect(githubIntegrationFrozenAt(normalized, freezeAt - 1)).toBe(false);
    expect(githubIntegrationFrozenAt(normalized, freezeAt)).toBe(true);
    expect(githubIntegrationFrozenAt(normalized, freezeAt + 1)).toBe(true);
    expect(() =>
      normalizeIntegrationPolicy({
        ...policy("integrations-v2"),
        requiredGitHubTopic: "code2create--7",
      }),
    ).toThrow("single hyphens");
  });

  test("does not treat a previous-policy or unverified topic as current", () => {
    const verified = {
      requiredTopic: "code2create-7-0",
      topicState: "present" as const,
    };
    expect(githubTopicVerificationIsCurrent(verified, "code2create-7-0")).toBe(true);
    expect(
      githubTopicVerificationIsCurrent(
        { ...verified, requiredTopic: "code2create-7" },
        "code2create-7-0",
      ),
    ).toBe(false);
    expect(
      githubTopicVerificationIsCurrent({ ...verified, topicState: "unknown" }, "code2create-7-0"),
    ).toBe(false);
  });

  test("allows only one competing draft from the same observed state", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "draft-race");
    const attempts = await Promise.allSettled([
      backend.run((ctx) =>
        saveIntegrationPolicyDraft(ctx, {
          event: fixture.event,
          actorPersonId: fixture.personId,
          policy: policy("integrations-alpha"),
          now: fixture.now + 1,
        }),
      ),
      backend.run((ctx) =>
        saveIntegrationPolicyDraft(ctx, {
          event: fixture.event,
          actorPersonId: fixture.personId,
          policy: policy("integrations-beta"),
          now: fixture.now + 1,
        }),
      ),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const drafts = await backend.run((ctx) =>
      ctx.db
        .query("integrationPolicyVersions")
        .withIndex("by_event_status", (index) =>
          index.eq("eventId", fixture.event._id).eq("status", "draft"),
        )
        .collect(),
    );
    expect(drafts).toHaveLength(1);
  });

  test("rejects cap reductions below active team projections", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "cap-reduction");
    await backend.run(async (ctx) => {
      await ctx.db.insert("githubTeamMetrics", githubMetric(fixture, 4));
    });
    const draft = await backend.run((ctx) =>
      saveIntegrationPolicyDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        policy: {
          ...policy("integrations-v2"),
          maxActiveGitHubRepositoriesPerTeam: 3,
          },
        now: fixture.now + 1,
      }),
    );
    await expect(
      backend.run((ctx) =>
        publishIntegrationPolicy(ctx, {
          event: fixture.event,
          draftPolicyId: draft.policyVersionId,
          expectedDraftChecksum: draft.checksum,
          now: fixture.now + 2,
        }),
      ),
    ).rejects.toThrow("already has 4 active GitHub repositories");
    const event = await backend.run((ctx) => ctx.db.get(fixture.event._id));
    expect(event?.publishedIntegrationPolicyId).toBe(fixture.policyId);
  });

  test("changing the optional topic does not invalidate an in-flight sync or repository evidence", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "topic-change");
    const bindingId = await backend.run(async (ctx) => {
      const connectionId = await ctx.db.insert("githubInstallationConnections", {
        eventId: fixture.event._id,
        teamId: fixture.teamId,
        installationId: "5001",
        accountId: "1001",
        accountLogin: "topic-change",
        targetType: "Organization",
        repositorySelection: "selected",
        state: "active",
        connectedByPersonId: fixture.personId,
        version: 1,
        connectedAt: fixture.now,
        lastVerifiedAt: fixture.now,
      });
      const bindingId = await ctx.db.insert("githubRepositoryBindings", {
        eventId: fixture.event._id,
        teamId: fixture.teamId,
        installationConnectionId: connectionId,
        repositoryId: "7001",
        repositoryNodeId: "R_topic_change",
        owner: "acmvit",
        name: "project",
        fullName: "acmvit/project",
        url: "https://github.com/acmvit/project",
        isPrivate: true,
        isFork: false,
        defaultBranch: "main",
        kind: "full_product",
        purpose: "Primary project repository",
        trackedBranch: "main",
        displayOrder: 1,
        requiredTopic: "code2create-7",
        topicState: "present",
        state: "active",
        baselineSha: "abc123",
        currentHeadSha: "abc123",
        lastReconciledAt: fixture.now,
        syncRevision: 1,
        syncedRevision: 0,
        syncState: "running",
        syncLeaseExpiresAt: fixture.now + 60_000,
        version: 1,
        providerCreatedAt: fixture.now,
        connectedAt: fixture.now,
        updatedAt: fixture.now,
      });
      await ctx.db.insert("githubRepositoryMetrics", {
        eventId: fixture.event._id,
        teamId: fixture.teamId,
        repositoryBindingId: bindingId,
        baselineSha: "abc123",
        currentHeadSha: "abc123",
        pushCount: 0,
        commitCount: 0,
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        observedCommitShas: [],
        commitIdentityComplete: true,
        languageBytes: [],
        completeness: "complete",
        compareTruncated: false,
        capturedAt: fixture.now,
        version: 1,
      });
      await ctx.db.insert("githubTeamMetrics", githubMetric(fixture, 1));
      return bindingId;
    });
    const firstDraft = await backend.run((ctx) =>
      saveIntegrationPolicyDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        policy: policy("integrations-v2"),
        now: fixture.now + 1,
      }),
    );
    await backend.run((ctx) =>
      publishIntegrationPolicy(ctx, {
        event: fixture.event,
        draftPolicyId: firstDraft.policyVersionId,
        expectedDraftChecksum: firstDraft.checksum,
        now: fixture.now + 2,
      }),
    );
    const eventAfterFirstPublication = await backend.run((ctx) => ctx.db.get(fixture.event._id));
    if (!eventAfterFirstPublication) throw new Error("The published event is missing.");
    const latestDraft = await backend.run((ctx) =>
      saveIntegrationPolicyDraft(ctx, {
        event: eventAfterFirstPublication,
        actorPersonId: fixture.personId,
        policy: policy("integrations-v3"),
        now: fixture.now + 3,
      }),
    );
    await backend.run((ctx) =>
      publishIntegrationPolicy(ctx, {
        event: eventAfterFirstPublication,
        draftPolicyId: latestDraft.policyVersionId,
        expectedDraftChecksum: latestDraft.checksum,
        now: fixture.now + 4,
      }),
    );
    await backend.mutation(internal.githubSync.apply, {
      settlement: {
        bindingId,
        syncRevision: 1,
        status: "succeeded",
        observation: {
          repositoryId: "7001",
          owner: "acmvit",
          name: "project",
          fullName: "acmvit/project",
          url: "https://github.com/acmvit/project",
          isPrivate: true,
          isFork: false,
          defaultBranch: "main",
          topicState: "present",
          headSha: "abc123",
          commitCount: 0,
          additions: 0,
          deletions: 0,
          changedFiles: 0,
          observedCommitShas: [],
          commitIdentityComplete: true,
          languageBytes: [],
          completeness: "complete",
          compareTruncated: false,
        },
      },
    });
    const result = await backend.run(async (ctx) => ({
      event: await ctx.db.get(fixture.event._id),
      prior: await ctx.db.get(fixture.policyId),
      firstPublication: await ctx.db.get(firstDraft.policyVersionId),
      published: await ctx.db.get(latestDraft.policyVersionId),
      binding: await ctx.db.get(bindingId),
      metric: await ctx.db
        .query("githubTeamMetrics")
        .withIndex("by_team", (index) => index.eq("teamId", fixture.teamId))
        .unique(),
    }));
    expect(result.event?.publishedIntegrationPolicyId).toBe(latestDraft.policyVersionId);
    expect(result.prior?.status).toBe("superseded");
    expect(result.firstPublication?.status).toBe("superseded");
    expect(result.published?.status).toBe("published");
    expect(result.binding).toMatchObject({
      requiredTopic: "code2create-7",
      topicState: "present",
      syncRevision: 1,
      syncState: "ready",
    });
    expect(result.metric).toMatchObject({
      health: "ready",
      topicUnknownCount: 0,
      completeRepositoryCount: 1,
    });
  });
});

function policy(policyVersion: string): IntegrationPolicy {
  return {
    policyVersion,
    requiredGitHubTopic: "code2create-7-0",
    maxActiveGitHubRepositoriesPerTeam: 10,
    };
}

async function seedFixture(backend: BackendTest, slug: string) {
  const now = Date.UTC(2027, 6, 1, 9, 0);
  return backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId: `integration-policy-${slug}`,
      googleSubject: `integration-policy-${slug}`,
      verifiedEmail: `${slug}@example.test`,
      displayName: "Integration policy fixture",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: `integration-policy-${slug}`,
      name: "Code2Create integration-policy fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: Date.now() + 86_400_000,
      createdByPersonId: personId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const initialPolicy = normalizeIntegrationPolicy({
      ...policy("integrations-v1"),
      requiredGitHubTopic: "code2create-7",
    });
    const policyId = await ctx.db.insert("integrationPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...initialPolicy,
      checksum: integrationPolicyChecksum(initialPolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, { publishedIntegrationPolicyId: policyId });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `${slug}@example.test`,
      displayName: "Integration policy fixture",
      status: "active",
      linkedBy: "access_invitation",
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
      name: "Integration policy fixture team",
      publicCode: `INT${slug.length}`,
      leadMembershipId: membershipId,
      status: "confirmed",
      activeMemberCount: 1,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 1,
      membershipLocked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("The integration-policy fixture event did not persist.");
    return { now, event, personId, policyId, teamId };
  });
}

function githubMetric(
  fixture: { event: Doc<"events">; teamId: Id<"teams">; now: number },
  repositoryCount: number,
): Omit<Doc<"githubTeamMetrics">, "_id" | "_creationTime"> {
  return {
    eventId: fixture.event._id,
    teamId: fixture.teamId,
    health: repositoryCount === 0 ? "not_connected" : "ready",
    installationCount: repositoryCount === 0 ? 0 : 1,
    repositoryCount,
    completeRepositoryCount: repositoryCount,
    topicPresentCount: repositoryCount,
    topicMissingCount: 0,
    topicUnknownCount: 0,
    kindCounts: repositoryCount === 0 ? [] : [{ kind: "full_product", count: repositoryCount }],
    pushCount: 0,
    uniqueObservedCommitCount: 0,
    commitOverlapCount: 0,
    commitIdentityComplete: true,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    languageBytes: [],
    completeness: repositoryCount === 0 ? "unknown" : "complete",
    incompleteRepositoryCount: 0,
    version: 1,
    updatedAt: fixture.now,
  };
}
