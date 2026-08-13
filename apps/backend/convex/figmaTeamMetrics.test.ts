import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { refreshFigmaTeamMetrics } from "./lib/figmaTeamMetrics.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("Figma team metrics", () => {
  test("materializes file, preview, and design totals into one team row", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);

    const summary = await backend.run((ctx) =>
      refreshFigmaTeamMetrics(ctx, {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        now: fixture.now + 1,
      }),
    );

    expect(summary).toMatchObject({
      health: "ready",
      authorizationCount: 1,
      fileCount: 2,
      completeFileCount: 2,
      incompleteFileCount: 0,
      dirtyCount: 0,
      webhookActiveCount: 1,
      webhookUnavailableCount: 1,
      rateLimitedCount: 0,
      previewReadyCount: 2,
      previewPendingCount: 0,
      previewAttentionCount: 0,
      selectedPreviewCount: 9,
      availablePreviewCount: 9,
      pageCount: 5,
      frameCount: 18,
      componentCount: 11,
      componentSetCount: 3,
      styleCount: 16,
      nodeCount: 1_500,
      prototypeInteractionCount: 12,
      commentCount: 9,
      unresolvedCommentCount: 3,
      versionCount: 7,
      completeness: "complete",
      version: 1,
    });
    expect(await backend.run((ctx) => ctx.db.query("figmaTeamMetrics").collect())).toHaveLength(1);
  });

  test("keeps totals visible while a dirty partial file needs attention", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    await backend.run((ctx) =>
      refreshFigmaTeamMetrics(ctx, {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        now: fixture.now + 1,
      }),
    );
    await backend.run(async (ctx) => {
      const binding = await ctx.db.get(fixture.prototypeBindingId);
      const metric = await ctx.db.get(fixture.prototypeMetricId);
      const preview = await ctx.db.get(fixture.prototypePreviewId);
      if (!binding || !metric || !preview) throw new Error("Figma team metric fixture is incomplete.");
      await ctx.db.patch(binding._id, {
        contentDirty: true,
        syncState: "error",
        version: binding.version + 1,
      });
      await ctx.db.patch(metric._id, {
        completeness: "partial",
        version: metric.version + 1,
      });
      await ctx.db.patch(preview._id, {
        state: "partial",
        availableCount: 2,
        failedCount: 2,
        updatedAt: fixture.now + 2,
      });
    });

    const summary = await backend.run((ctx) =>
      refreshFigmaTeamMetrics(ctx, {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        now: fixture.now + 3,
      }),
    );

    expect(summary).toMatchObject({
      health: "needs_attention",
      fileCount: 2,
      completeFileCount: 1,
      incompleteFileCount: 1,
      dirtyCount: 1,
      previewReadyCount: 1,
      previewAttentionCount: 1,
      availablePreviewCount: 7,
      completeness: "partial",
      version: 2,
    });
  });
});

async function seedFixture(backend: BackendTest) {
  const now = Date.UTC(2027, 7, 8, 10, 0, 0);
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: `figma-metrics-${now}`,
      name: "Code2Create Figma metrics fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      startsAt: now,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const personId = await ctx.db.insert("people", {
      authUserId: `figma-metrics-user-${now}`,
      googleSubject: `figma-metrics-subject-${now}`,
      verifiedEmail: `figma-metrics-${now}@example.test`,
      displayName: "Mira Shah",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `figma-metrics-${now}@example.test`,
      displayName: "Mira Shah",
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
      name: "Measured Petal",
      publicCode: "FIGMA01",
      leadMembershipId: membershipId,
      status: "confirmed",
      activeMemberCount: 0,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 0,
      membershipLocked: true,
      trackLocked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const credentialId = await ctx.db.insert("figmaOAuthCredentials", {
      figmaUserId: "figma-metrics-user",
      accessTokenCiphertext: "encrypted-access-token",
      refreshTokenCiphertext: "encrypted-refresh-token",
      tokenExpiresAt: now + 3_600_000,
      tokenReceivedAt: now,
      scopes: ["file_content:read"],
      status: "active",
      authorizedByPersonId: personId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const connectionId = await ctx.db.insert("figmaCredentialConnections", {
      eventId,
      teamId,
      credentialId,
      state: "active",
      connectedByPersonId: personId,
      connectedAt: now,
      lastVerifiedAt: now,
      version: 1,
    });
    await insertFile(ctx, {
      eventId,
      teamId,
      credentialId,
      connectionId,
      fileNumber: 1,
      name: "Product",
      webhookState: "active",
      metrics: {
        pageCount: 3,
        frameCount: 10,
        componentCount: 7,
        componentSetCount: 2,
        styleCount: 10,
        nodeCount: 1_000,
        prototypeInteractionCount: 8,
        commentCount: 5,
        unresolvedCommentCount: 1,
        versionCount: 4,
      },
      previewCount: 5,
      now,
    });
    const prototype = await insertFile(ctx, {
      eventId,
      teamId,
      credentialId,
      connectionId,
      fileNumber: 2,
      name: "Prototype",
      webhookState: "unavailable",
      metrics: {
        pageCount: 2,
        frameCount: 8,
        componentCount: 4,
        componentSetCount: 1,
        styleCount: 6,
        nodeCount: 500,
        prototypeInteractionCount: 4,
        commentCount: 4,
        unresolvedCommentCount: 2,
        versionCount: 3,
      },
      previewCount: 4,
      now,
    });
    return {
      eventId,
      teamId,
      prototypeBindingId: prototype.bindingId,
      prototypeMetricId: prototype.metricId,
      prototypePreviewId: prototype.previewId,
      now,
    };
  });
}

async function insertFile(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    teamId: Id<"teams">;
    credentialId: Id<"figmaOAuthCredentials">;
    connectionId: Id<"figmaCredentialConnections">;
    fileNumber: number;
    name: string;
    webhookState: "active" | "unavailable";
    metrics: {
      pageCount: number;
      frameCount: number;
      componentCount: number;
      componentSetCount: number;
      styleCount: number;
      nodeCount: number;
      prototypeInteractionCount: number;
      commentCount: number;
      unresolvedCommentCount: number;
      versionCount: number;
    };
    previewCount: number;
    now: number;
  },
) {
  const fileKey = `figma-metrics-file-${args.fileNumber}`;
  const versionId = `figma-metrics-version-${args.fileNumber}`;
  const bindingId = await ctx.db.insert("figmaFileBindings", {
    eventId: args.eventId,
    teamId: args.teamId,
    credentialId: args.credentialId,
    credentialConnectionId: args.connectionId,
    fileKey,
    url: `https://www.figma.com/design/${fileKey}/Fixture`,
    name: args.name,
    role: "owner",
    linkAccess: "view",
    editorType: "figma",
    versionId,
    observedVersionId: versionId,
    lastTouchedAt: args.now,
    lastProviderObservedAt: args.now,
    state: "active",
    webhookState: args.webhookState,
    lastMetadataCheckAt: args.now,
    lastFullCaptureAt: args.now,
    contentDirty: false,
    syncRevision: 1,
    syncedRevision: 1,
    syncState: "ready",
    version: 1,
    connectedAt: args.now,
    updatedAt: args.now,
  });
  const metricId = await ctx.db.insert("figmaFileMetrics", {
    eventId: args.eventId,
    teamId: args.teamId,
    figmaFileBindingId: bindingId,
    ...args.metrics,
    completeness: "complete",
    capturedAt: args.now,
    version: 1,
  });
  const artifactId = await ctx.db.insert("integrationArtifacts", {
    eventId: args.eventId,
    teamId: args.teamId,
    provider: "figma",
    figmaFileBindingId: bindingId,
    resourceKey: fileKey,
    providerVersionId: versionId,
    objectKey: `figma/${fileKey}/${versionId}.json.gz`,
    storageRegion: "ap-south-1",
    storageBucket: "figma-fixtures",
    contentType: "application/json",
    contentEncoding: "gzip",
    uncompressedBytes: 1_000,
    storedBytes: 500,
    sha256: `${args.fileNumber}`.repeat(64),
    state: "available",
    createdAt: args.now,
  });
  const snapshotId = await ctx.db.insert("figmaFileSnapshots", {
    eventId: args.eventId,
    teamId: args.teamId,
    figmaFileBindingId: bindingId,
    reason: "baseline",
    providerVersionId: versionId,
    providerLastTouchedAt: args.now,
    ...args.metrics,
    completeness: "complete",
    artifactId,
    capturedAt: args.now,
  });
  const previewId = await ctx.db.insert("figmaPreviewSets", {
    eventId: args.eventId,
    teamId: args.teamId,
    figmaFileBindingId: bindingId,
    snapshotId,
    providerVersionId: versionId,
    state: "ready",
    discoveredNodeCount: args.previewCount,
    selectedNodeCount: args.previewCount,
    availableCount: args.previewCount,
    failedCount: 0,
    truncated: false,
    createdAt: args.now,
    updatedAt: args.now,
    completedAt: args.now,
  });
  return { bindingId, metricId, previewId };
}
