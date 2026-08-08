import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { refreshGithubTeamMetrics } from "./lib/githubTeamMetrics.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("GitHub team metrics", () => {
  test("deduplicates observed commits across repositories and materializes one team row", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);

    const summary = await backend.run((ctx) =>
      refreshGithubTeamMetrics(ctx, {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        now: fixture.now + 1,
      }),
    );

    expect(summary).toMatchObject({
      health: "ready",
      installationCount: 1,
      repositoryCount: 2,
      completeRepositoryCount: 2,
      topicPresentCount: 2,
      topicMissingCount: 0,
      kindCounts: [
        { kind: "frontend", count: 1 },
        { kind: "backend_api", count: 1 },
      ],
      pushCount: 5,
      uniqueObservedCommitCount: 3,
      commitOverlapCount: 1,
      commitIdentityComplete: true,
      additions: 170,
      deletions: 13,
      changedFiles: 12,
      languageBytes: [
        { language: "TypeScript", bytes: 1500 },
        { language: "CSS", bytes: 200 },
      ],
      completeness: "complete",
      incompleteRepositoryCount: 0,
      version: 1,
    });
    expect(await backend.run((ctx) => ctx.db.query("githubTeamMetrics").collect())).toHaveLength(1);
  });

  test("keeps last known totals but marks bounded or unhealthy repositories incomplete", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    await backend.run((ctx) =>
      refreshGithubTeamMetrics(ctx, {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        now: fixture.now + 1,
      }),
    );
    await backend.run(async (ctx) => {
      const binding = await ctx.db.get(fixture.apiRepositoryId);
      const metric = await ctx.db.get(fixture.apiMetricId);
      if (!binding || !metric) throw new Error("GitHub team metric fixture is incomplete.");
      await ctx.db.patch(binding._id, {
        topicState: "missing",
        syncState: "error",
        version: binding.version + 1,
      });
      await ctx.db.patch(metric._id, {
        commitIdentityComplete: false,
        completeness: "partial",
        version: metric.version + 1,
      });
    });

    const summary = await backend.run((ctx) =>
      refreshGithubTeamMetrics(ctx, {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        now: fixture.now + 2,
      }),
    );

    expect(summary).toMatchObject({
      health: "needs_attention",
      repositoryCount: 2,
      completeRepositoryCount: 1,
      topicPresentCount: 1,
      topicMissingCount: 1,
      uniqueObservedCommitCount: 3,
      commitOverlapCount: 1,
      commitIdentityComplete: false,
      completeness: "partial",
      incompleteRepositoryCount: 1,
      version: 2,
    });
  });
});

async function seedFixture(backend: BackendTest) {
  const now = Date.UTC(2027, 7, 8, 9, 0, 0);
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: `github-metrics-${now}`,
      name: "Code2Create GitHub metrics fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      startsAt: now,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const personId = await ctx.db.insert("people", {
      authUserId: `github-metrics-user-${now}`,
      googleSubject: `github-metrics-subject-${now}`,
      verifiedEmail: `github-metrics-${now}@example.test`,
      displayName: "Ria Nair",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `github-metrics-${now}@example.test`,
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
      publicCode: "METRIC1",
      leadMembershipId: membershipId,
      status: "confirmed",
      membershipLocked: true,
      trackLocked: true,
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
    const portalRepositoryId = await insertRepository(ctx, {
      eventId,
      teamId,
      connectionId,
      name: "portal",
      repositoryNumber: 1,
      kind: "frontend",
      now,
    });
    const apiRepositoryId = await insertRepository(ctx, {
      eventId,
      teamId,
      connectionId,
      name: "api",
      repositoryNumber: 2,
      kind: "backend_api",
      now,
    });
    const portalMetricId = await ctx.db.insert("githubRepositoryMetrics", {
      eventId,
      teamId,
      repositoryBindingId: portalRepositoryId,
      baselineSha: "0".repeat(40),
      currentHeadSha: "2".repeat(40),
      pushCount: 2,
      commitCount: 2,
      additions: 120,
      deletions: 8,
      changedFiles: 7,
      observedCommitShas: ["a".repeat(40), "b".repeat(40)],
      commitIdentityComplete: true,
      languageBytes: [
        { language: "TypeScript", bytes: 1000 },
        { language: "CSS", bytes: 200 },
      ],
      completeness: "complete",
      compareTruncated: false,
      capturedAt: now,
      version: 1,
    });
    const apiMetricId = await ctx.db.insert("githubRepositoryMetrics", {
      eventId,
      teamId,
      repositoryBindingId: apiRepositoryId,
      baselineSha: "0".repeat(40),
      currentHeadSha: "3".repeat(40),
      pushCount: 3,
      commitCount: 2,
      additions: 50,
      deletions: 5,
      changedFiles: 5,
      observedCommitShas: ["b".repeat(40), "c".repeat(40)],
      commitIdentityComplete: true,
      languageBytes: [{ language: "TypeScript", bytes: 500 }],
      completeness: "complete",
      compareTruncated: false,
      capturedAt: now,
      version: 1,
    });
    return {
      eventId,
      teamId,
      portalRepositoryId,
      apiRepositoryId,
      portalMetricId,
      apiMetricId,
      now,
    };
  });
}

async function insertRepository(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    teamId: Id<"teams">;
    connectionId: Id<"githubInstallationConnections">;
    name: string;
    repositoryNumber: number;
    kind: "frontend" | "backend_api";
    now: number;
  },
) {
  return ctx.db.insert("githubRepositoryBindings", {
    eventId: args.eventId,
    teamId: args.teamId,
    installationConnectionId: args.connectionId,
    repositoryId: `metrics-repository-${args.repositoryNumber}`,
    repositoryNodeId: `MR_${args.repositoryNumber}`,
    owner: "measured-moon",
    name: args.name,
    fullName: `measured-moon/${args.name}`,
    url: `https://github.com/measured-moon/${args.name}`,
    isPrivate: true,
    isFork: args.repositoryNumber === 2,
    defaultBranch: "main",
    kind: args.kind,
    purpose: `${args.name} project surface`,
    trackedBranch: "main",
    displayOrder: args.repositoryNumber,
    requiredTopic: "code2create-7-0",
    topicState: "present",
    state: "active",
    baselineSha: "0".repeat(40),
    currentHeadSha: `${args.repositoryNumber + 1}`.repeat(40),
    lastReconciledAt: args.now,
    syncRevision: 1,
    syncedRevision: 1,
    syncState: "ready",
    version: 1,
    providerCreatedAt: args.now,
    connectedAt: args.now,
    updatedAt: args.now,
  });
}
