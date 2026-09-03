import { convexTest, type TestConvex } from "convex-test";
import workpoolTest from "@convex-dev/workpool/test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.ts";
import {
  githubTopicVerificationIsCurrent,
  integrationPolicyChecksum,
  integrationProviderFrozenAt,
  normalizeIntegrationPolicy,
  publishIntegrationPolicy,
  saveIntegrationPolicyDraft,
  type IntegrationPolicy,
} from "./lib/integrationPolicy.ts";
import { permissionCatalog } from "./lib/permissionCatalog.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("integration policy configuration", () => {
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
    expect(integrationProviderFrozenAt(normalized, "github", freezeAt - 1)).toBe(false);
    expect(integrationProviderFrozenAt(normalized, "github", freezeAt)).toBe(true);
    expect(integrationProviderFrozenAt(normalized, "github", freezeAt + 1)).toBe(true);
    expect(integrationProviderFrozenAt(normalized, "figma", freezeAt + 1)).toBe(false);
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
      await ctx.db.insert("figmaTeamMetrics", figmaMetric(fixture, 3));
    });
    const draft = await backend.run((ctx) =>
      saveIntegrationPolicyDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        policy: {
          ...policy("integrations-v2"),
          maxActiveGitHubRepositoriesPerTeam: 3,
          maxActiveFigmaFilesPerTeam: 2,
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

  test("a delayed topic job follows the newest immutable policy release", async () => {
    const backend = convexTest(schema, modules);
    workpoolTest.register(backend, "integrationWorkpool");
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
        syncedRevision: 1,
        syncState: "running",
        syncLeaseId: "old-topic-lease",
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
    await backend.mutation(internal.githubIntegrations.revalidateRequiredTopic, {
      eventId: fixture.event._id,
      cursor: null,
    });
    await backend.mutation(internal.githubIntegrations.finishRepositorySync, {
      bindingId,
      leaseId: "old-topic-lease",
      syncRevision: 1,
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
      requiredTopic: "code2create-7-0",
      topicState: "unknown",
      syncRevision: 2,
      syncState: "pending",
    });
    expect(result.metric).toMatchObject({
      health: "needs_attention",
      topicUnknownCount: 1,
      completeRepositoryCount: 0,
    });
  });
});

function policy(policyVersion: string): IntegrationPolicy {
  return {
    policyVersion,
    requiredGitHubTopic: "code2create-7-0",
    maxActiveGitHubRepositoriesPerTeam: 10,
    maxActiveFigmaFilesPerTeam: 10,
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

function figmaMetric(
  fixture: { event: Doc<"events">; teamId: Id<"teams">; now: number },
  fileCount: number,
): Omit<Doc<"figmaTeamMetrics">, "_id" | "_creationTime"> {
  return {
    eventId: fixture.event._id,
    teamId: fixture.teamId,
    health: fileCount === 0 ? "not_connected" : "ready",
    authorizationCount: fileCount === 0 ? 0 : 1,
    fileCount,
    completeFileCount: fileCount,
    incompleteFileCount: 0,
    dirtyCount: 0,
    webhookActiveCount: fileCount,
    webhookUnavailableCount: 0,
    rateLimitedCount: 0,
    previewReadyCount: fileCount,
    previewPendingCount: 0,
    previewAttentionCount: 0,
    selectedPreviewCount: 0,
    availablePreviewCount: 0,
    pageCount: 0,
    frameCount: 0,
    componentCount: 0,
    componentSetCount: 0,
    styleCount: 0,
    nodeCount: 0,
    prototypeInteractionCount: 0,
    commentCount: 0,
    unresolvedCommentCount: 0,
    versionCount: 0,
    completeness: fileCount === 0 ? "unknown" : "complete",
    version: 1,
    updatedAt: fixture.now,
  };
}
