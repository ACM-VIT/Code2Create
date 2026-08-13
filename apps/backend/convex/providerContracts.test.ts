import { createHash, createHmac } from "node:crypto";

import {
  participantEmailEventSignatureContext,
  signServiceBody,
} from "@code2create/domain";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, afterEach, describe, expect, test } from "vitest";

import { internal } from "./_generated/api";
import {
  communicationsPolicyChecksum,
  normalizeCommunicationsPolicy,
} from "./lib/communicationsPolicy";
import {
  defaultDeterministicIntakePolicy,
  intakePolicyChecksum,
} from "./lib/intakePolicy";
import {
  defaultParticipantPolicy,
  participantPolicyChecksum,
} from "./lib/participantPolicy";
import { createTestSubmissionSnapshot } from "./lib/testSubmissionSnapshot";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const originalGitHubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const originalEmailEventCallbackSecret = process.env.EMAIL_EVENT_CALLBACK_SECRET;
const originalAuthSiteUrl = process.env.AUTH_SITE_URL;
const originalParticipantSiteUrl = process.env.PARTICIPANT_SITE_URL;
const originalOperationsSiteUrl = process.env.OPERATIONS_SITE_URL;
const originalHandbookSiteUrl = process.env.HANDBOOK_SITE_URL;

process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";
process.env.HANDBOOK_SITE_URL = "http://localhost:4175";

type BackendTest = TestConvex<typeof schema>;

afterEach(() => {
  restoreEnvironment("GITHUB_WEBHOOK_SECRET", originalGitHubWebhookSecret);
  restoreEnvironment("EMAIL_EVENT_CALLBACK_SECRET", originalEmailEventCallbackSecret);
});

afterAll(() => {
  restoreEnvironment("AUTH_SITE_URL", originalAuthSiteUrl);
  restoreEnvironment("PARTICIPANT_SITE_URL", originalParticipantSiteUrl);
  restoreEnvironment("OPERATIONS_SITE_URL", originalOperationsSiteUrl);
  restoreEnvironment("HANDBOOK_SITE_URL", originalHandbookSiteUrl);
});

describe("GitHub provider contract", () => {
  test("verifies the signed HTTP payload and deduplicates the delivery", async () => {
    const backend = convexTest(schema, modules);
    const secret = "github-provider-fixture-secret";
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    process.env.GITHUB_WEBHOOK_SECRET = secret;

    const first = await backend.fetch("/integrations/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "github-delivery-ping-1",
        "x-github-event": "ping",
        "x-hub-signature-256": githubSignature(secret, body),
      },
      body,
    });
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toEqual({ accepted: true });

    const duplicate = await backend.fetch("/integrations/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "github-delivery-ping-1",
        "x-github-event": "ping",
        "x-hub-signature-256": githubSignature(secret, body),
      },
      body,
    });
    expect(duplicate.status).toBe(202);

    const deliveries = await backend.run((ctx) =>
      ctx.db.query("githubWebhookDeliveries").collect(),
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      deliveryId: "github-delivery-ping-1",
      eventName: "ping",
      state: "accepted",
      reasonCode: "ping",
    });

    const invalid = await backend.fetch("/integrations/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "github-delivery-ping-2",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=00",
      },
      body,
    });
    expect(invalid.status).toBe(401);
  });

  test("suspends every matching installation binding once", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedIntegrationTeam(backend);
    const connectionId = await backend.run((ctx) =>
      ctx.db.insert("githubInstallationConnections", {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        installationId: "771",
        accountId: "12",
        accountLogin: "code2create-fixture",
        targetType: "Organization",
        repositorySelection: "selected",
        state: "active",
        connectedByPersonId: fixture.personId,
        connectedAt: fixture.now,
        lastVerifiedAt: fixture.now,
        version: 1,
      }),
    );
    const bindingId = await backend.run((ctx) =>
      ctx.db.insert("githubRepositoryBindings", {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        installationConnectionId: connectionId,
        repositoryId: "991",
        repositoryNodeId: "R_fixture",
        owner: "code2create-fixture",
        name: "participant-app",
        fullName: "code2create-fixture/participant-app",
        url: "https://github.com/code2create-fixture/participant-app",
        isPrivate: true,
        isFork: false,
        defaultBranch: "main",
        kind: "frontend",
        purpose: "Participant portal fixture",
        trackedBranch: "main",
        displayOrder: 0,
        requiredTopic: "code2create-7-0",
        topicState: "present",
        state: "active",
        currentHeadSha: "a".repeat(40),
        syncRevision: 1,
        syncedRevision: 1,
        syncState: "ready",
        version: 1,
        providerCreatedAt: fixture.now,
        connectedAt: fixture.now,
        updatedAt: fixture.now,
      }),
    );
    await backend.run((ctx) =>
      ctx.db.insert("githubRepositoryMetrics", {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        repositoryBindingId: bindingId,
        baselineSha: "a".repeat(40),
        currentHeadSha: "a".repeat(40),
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
      }),
    );

    const args = {
      deliveryId: "github-installation-suspend-1",
      eventName: "installation",
      payloadHash: "payload-hash-1",
      event: {
        kind: "installation" as const,
        installationId: "771",
        action: "suspend",
      },
    };
    const first = await backend.mutation(internal.githubIntegrations.acceptWebhook, args);
    expect(first).toEqual({ duplicate: false, affectedBindings: 1 });

    const duplicate = await backend.mutation(internal.githubIntegrations.acceptWebhook, args);
    expect(duplicate).toEqual({ duplicate: true, affectedBindings: 0 });

    const state = await backend.run(async (ctx) => ({
      connection: await ctx.db.get(connectionId),
      binding: await ctx.db.get(bindingId),
    }));
    expect(state.connection).toMatchObject({ state: "suspended", version: 2 });
    expect(state.binding).toMatchObject({
      state: "inaccessible",
      syncState: "error",
      syncErrorCode: "installation_suspend",
      version: 2,
    });

    await expect(
      backend.mutation(internal.githubIntegrations.acceptWebhook, {
        ...args,
        payloadHash: "different-payload",
      }),
    ).rejects.toThrow(/delivery ID was reused/i);
  });
});

describe("Figma provider contract", () => {
  test("accepts a passcode-bound ping and file update without replaying either", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedIntegrationTeam(backend);
    const passcode = "figma-fixture-passcode";
    const credentialId = await backend.run((ctx) =>
      ctx.db.insert("figmaOAuthCredentials", {
        figmaUserId: "figma-user-1",
        accessTokenCiphertext: "encrypted-access-token",
        refreshTokenCiphertext: "encrypted-refresh-token",
        tokenExpiresAt: fixture.now + 3_600_000,
        tokenReceivedAt: fixture.now,
        scopes: ["file_content:read", "webhooks:write"],
        status: "active",
        authorizedByPersonId: fixture.personId,
        version: 1,
        createdAt: fixture.now,
        updatedAt: fixture.now,
      }),
    );
    const connectionId = await backend.run((ctx) =>
      ctx.db.insert("figmaCredentialConnections", {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        credentialId,
        state: "active",
        connectedByPersonId: fixture.personId,
        connectedAt: fixture.now,
        lastVerifiedAt: fixture.now,
        version: 1,
      }),
    );
    const bindingId = await backend.run((ctx) =>
      ctx.db.insert("figmaFileBindings", {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        credentialId,
        credentialConnectionId: connectionId,
        fileKey: "figma-file-key",
        url: "https://www.figma.com/design/figma-file-key/Fixture",
        name: "Fixture",
        role: "owner",
        linkAccess: "view",
        editorType: "figma",
        versionId: "version-1",
        lastTouchedAt: fixture.now,
        state: "active",
        webhookId: "figma-webhook-1",
        webhookPasscodeDigest: sha256(passcode),
        webhookState: "pending",
        lastMetadataCheckAt: fixture.now,
        lastFullCaptureAt: fixture.now,
        contentDirty: false,
        syncRevision: 1,
        syncedRevision: 1,
        syncState: "ready",
        version: 1,
        connectedAt: fixture.now,
        updatedAt: fixture.now,
      }),
    );
    await backend.run(async (ctx) => {
      await ctx.db.insert("figmaFileMetrics", {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        figmaFileBindingId: bindingId,
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
        completeness: "complete",
        capturedAt: fixture.now,
        version: 1,
      });
      const artifactId = await ctx.db.insert("integrationArtifacts", {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        provider: "figma",
        figmaFileBindingId: bindingId,
        resourceKey: "figma-file-key",
        providerVersionId: "version-1",
        objectKey: "figma/figma-file-key/version-1.json.gz",
        storageRegion: "ap-south-1",
        storageBucket: "figma-fixtures",
        contentType: "application/json",
        contentEncoding: "gzip",
        uncompressedBytes: 100,
        storedBytes: 50,
        sha256: "b".repeat(64),
        state: "available",
        createdAt: fixture.now,
      });
      const snapshotId = await ctx.db.insert("figmaFileSnapshots", {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        figmaFileBindingId: bindingId,
        reason: "baseline",
        providerVersionId: "version-1",
        providerLastTouchedAt: fixture.now,
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
        completeness: "complete",
        artifactId,
        capturedAt: fixture.now,
      });
      await ctx.db.insert("figmaPreviewSets", {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        figmaFileBindingId: bindingId,
        snapshotId,
        providerVersionId: "version-1",
        state: "ready",
        discoveredNodeCount: 0,
        selectedNodeCount: 0,
        availableCount: 0,
        failedCount: 0,
        truncated: false,
        createdAt: fixture.now,
        updatedAt: fixture.now,
        completedAt: fixture.now,
      });
    });

    const pingBody = JSON.stringify({
      event_type: "PING",
      passcode,
      timestamp: new Date(fixture.now).toISOString(),
      webhook_id: "figma-webhook-1",
    });
    const ping = await backend.fetch("/integrations/figma/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: pingBody,
    });
    expect(ping.status).toBe(200);
    await expect(ping.json()).resolves.toEqual({ accepted: true, duplicate: false });

    const duplicatePing = await backend.fetch("/integrations/figma/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: pingBody,
    });
    await expect(duplicatePing.json()).resolves.toEqual({ accepted: true, duplicate: true });

    const updateBody = JSON.stringify({
      event_type: "FILE_UPDATE",
      passcode,
      timestamp: new Date(fixture.now + 1_000).toISOString(),
      webhook_id: "figma-webhook-1",
      file_key: "figma-file-key",
    });
    const update = await backend.fetch("/integrations/figma/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: updateBody,
    });
    expect(update.status).toBe(200);

    const state = await backend.run(async (ctx) => ({
      binding: await ctx.db.get(bindingId),
      summary: await ctx.db
        .query("figmaTeamMetrics")
        .withIndex("by_team", (index) => index.eq("teamId", fixture.teamId))
        .unique(),
      deliveries: await ctx.db.query("figmaWebhookDeliveries").collect(),
    }));
    expect(state.binding).toMatchObject({
      webhookState: "active",
      contentDirty: true,
      syncRevision: 2,
      version: 3,
    });
    expect(state.summary).toMatchObject({
      health: "needs_attention",
      fileCount: 1,
      dirtyCount: 1,
      webhookActiveCount: 1,
      version: 2,
    });
    expect(state.deliveries).toHaveLength(2);

    const invalidBody = JSON.stringify({
      event_type: "PING",
      passcode: "wrong-passcode",
      timestamp: new Date(fixture.now + 2_000).toISOString(),
      webhook_id: "figma-webhook-1",
    });
    const invalid = await backend.fetch("/integrations/figma/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: invalidBody,
    });
    expect(invalid.status).toBe(400);
    const deliveriesAfterInvalid = await backend.run((ctx) =>
      ctx.db.query("figmaWebhookDeliveries").collect(),
    );
    expect(deliveriesAfterInvalid).toHaveLength(2);
  });
});

describe("Cloudflare participant-email contract", () => {
  test("converges event-before-response, duplicate, out-of-order, and bounce events", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedParticipantDelivery(backend, {
      state: "sending",
      attemptId: "send-attempt-1",
    });
    const callbackSecret = "cloudflare-email-callback-fixture-secret-32";
    process.env.EMAIL_EVENT_CALLBACK_SECRET = callbackSecret;

    const deliveredAt = new Date(fixture.now + 10_000);
    const delivered = await sendCloudflareEmailEvent(backend, {
      eventId: "cloudflare-email-event-1",
      messageId: fixture.providerMessageId,
      type: "email.delivered",
      providerAt: deliveredAt.getTime(),
      disableDestination: false,
      callbackSecret,
    });
    expect(delivered.status).toBe(200);
    await expect(delivered.json()).resolves.toEqual({
      accepted: true,
      duplicate: false,
      matched: false,
    });

    await backend.mutation(internal.participantNotificationState.recordSent, {
      deliveryId: fixture.deliveryId,
      attemptId: "send-attempt-1",
      providerMessageId: fixture.providerMessageId,
      initialOutcome: "queued",
    });
    let state = await participantDeliveryState(backend, fixture.deliveryId, fixture.destinationId);
    expect(state.delivery).toMatchObject({
      state: "delivered",
      providerMessageId: fixture.providerMessageId,
      lastProviderEventAt: deliveredAt.getTime(),
    });

    const duplicate = await sendCloudflareEmailEvent(backend, {
      eventId: "cloudflare-email-event-1",
      messageId: fixture.providerMessageId,
      type: "email.delivered",
      providerAt: deliveredAt.getTime(),
      disableDestination: false,
      callbackSecret,
    });
    await expect(duplicate.json()).resolves.toEqual({
      accepted: true,
      duplicate: true,
      matched: true,
    });

    const olderDelayed = await sendCloudflareEmailEvent(backend, {
      eventId: "cloudflare-email-event-2",
      messageId: fixture.providerMessageId,
      type: "email.delivery_delayed",
      providerAt: fixture.now + 5_000,
      disableDestination: false,
      providerErrorCode: "cloudflare_email_deferred",
      callbackSecret,
    });
    expect(olderDelayed.status).toBe(200);
    state = await participantDeliveryState(backend, fixture.deliveryId, fixture.destinationId);
    expect(state.delivery).toMatchObject({
      state: "delivered",
      lastProviderEventAt: deliveredAt.getTime(),
    });

    const softBouncedAt = fixture.now + 20_000;
    const softBounced = await sendCloudflareEmailEvent(backend, {
      eventId: "cloudflare-email-event-3",
      messageId: fixture.providerMessageId,
      type: "email.bounced",
      providerAt: softBouncedAt,
      disableDestination: false,
      providerErrorCode: "cloudflare_email_bounced_soft",
      callbackSecret,
    });
    expect(softBounced.status).toBe(200);
    state = await participantDeliveryState(backend, fixture.deliveryId, fixture.destinationId);
    expect(state.delivery).toMatchObject({
      state: "bounced",
      providerErrorCode: "cloudflare_email_bounced_soft",
      lastProviderEventAt: softBouncedAt,
    });
    expect(state.destination).toMatchObject({ status: "active", version: 1 });

    const hardBouncedAt = fixture.now + 30_000;
    const hardBounced = await sendCloudflareEmailEvent(backend, {
      eventId: "cloudflare-email-event-4",
      messageId: fixture.providerMessageId,
      type: "email.bounced",
      providerAt: hardBouncedAt,
      disableDestination: true,
      providerErrorCode: "cloudflare_email_bounced_hard",
      callbackSecret,
    });
    expect(hardBounced.status).toBe(200);
    state = await participantDeliveryState(backend, fixture.deliveryId, fixture.destinationId);
    expect(state.delivery).toMatchObject({
      state: "bounced",
      providerErrorCode: "cloudflare_email_bounced_hard",
      lastProviderEventAt: hardBouncedAt,
    });
    expect(state.destination).toMatchObject({
      status: "disabled",
      disabledReasonCode: "cloudflare_email_bounced_hard",
      version: 2,
    });
    expect(state.providerEvents).toHaveLength(4);
    expect(state.providerEvents.every((event) => event.appliedAt !== undefined)).toBe(true);
  });
});

async function seedIntegrationTeam(backend: BackendTest) {
  const now = Date.now();
  return backend.run(async (ctx) => {
    const startsAt = now + 24 * 60 * 60 * 1_000;
    const endsAt = startsAt + 48 * 60 * 60 * 1_000;
    const eventId = await ctx.db.insert("events", {
      slug: "code2create-provider-fixture",
      name: "Code2Create provider fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      startsAt,
      endsAt,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const personId = await ctx.db.insert("people", {
      authUserId: "provider-fixture-user",
      googleSubject: "provider-fixture-subject",
      verifiedEmail: "fixture@example.test",
      displayName: "Provider Fixture",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const accessSubjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: "fixture@example.test",
      displayName: "Provider Fixture",
      status: "active",
      linkedBy: "participant_provisioning",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const participantPolicyVersionId = await ctx.db.insert("participantPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...defaultParticipantPolicy,
      checksum: participantPolicyChecksum(defaultParticipantPolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    const communicationsPolicy = normalizeCommunicationsPolicy({
      venueName: "Fixture hall",
      startsAt,
      endsAt,
      nextSteps: [
        {
          stableKey: "open_portal",
          title: "Open the portal",
          detail: "Review the current application update in the signed-in portal.",
        },
      ],
      discordUrl: "https://discord.gg/provider-fixture",
      discordLabel: "Open event Discord",
      notificationProvider: "cloudflare_email",
      notificationSubject: "Code2Create application update",
      notificationIntro: "There is an update to your team's Code2Create application.",
    });
    const communicationsPolicyVersionId = await ctx.db.insert(
      "communicationsPolicyVersions",
      {
        eventId,
        version: 1,
        status: "published",
        ...communicationsPolicy,
        checksum: communicationsPolicyChecksum(communicationsPolicy),
        createdByPersonId: personId,
        createdAt: now,
        publishedAt: now,
      },
    );
    await ctx.db.patch(eventId, {
      publishedParticipantPolicyId: participantPolicyVersionId,
      publishedCommunicationsPolicyId: communicationsPolicyVersionId,
    });
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId,
      personId,
      eventAccessSubjectId: accessSubjectId,
      participantClass: "external_participant",
      eligibilityStatus: "eligible",
      onboardingStatus: "accepted",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Provider Fixture Team",
      publicCode: "FIXTURE1",
      leadMembershipId: membershipId,
      status: "admitted",
      activeMemberCount: 1,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 1,
      membershipLocked: true,
      trackLocked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    return {
      now,
      eventId,
      personId,
      membershipId,
      teamId,
      participantPolicyVersionId,
      communicationsPolicyVersionId,
    };
  });
}

async function seedParticipantDelivery(
  backend: BackendTest,
  initial: { state: "sending"; attemptId: string },
) {
  const fixture = await seedIntegrationTeam(backend);
  return backend.run(async (ctx) => {
    const teamMemberId = await ctx.db.insert("teamMembers", {
      eventId: fixture.eventId,
      teamId: fixture.teamId,
      membershipId: fixture.membershipId,
      role: "lead",
      status: "active",
      joinedAt: fixture.now,
      source: "created",
    });
    const catalogId = await ctx.db.insert("trackCatalogVersions", {
      eventId: fixture.eventId,
      version: 1,
      status: "published",
      requiredCoreTrackCount: 1,
      checksum: "catalog-checksum",
      createdByPersonId: fixture.personId,
      createdAt: fixture.now,
      publishedAt: fixture.now,
    });
    const trackId = await ctx.db.insert("trackVersions", {
      eventId: fixture.eventId,
      catalogVersionId: catalogId,
      stableKey: "open-innovation",
      slug: "open-innovation",
      displayName: "Open innovation",
      description: "Fixture track",
      examples: [],
      displayOrder: 0,
      type: "core",
      status: "published",
      createdAt: fixture.now,
    });
    const policyId = await ctx.db.insert("admissionPolicyVersions", {
      eventId: fixture.eventId,
      version: "admission-v1",
      status: "published",
      aiRecommendationMode: "disabled",
      minimumHumanReviews: 1,
      overallParticipantCapacity: 1_000,
      criteria: [],
      decisionReasonCodes: [],
      checksum: "admission-policy-checksum",
      createdByPersonId: fixture.personId,
      createdAt: fixture.now,
      publishedAt: fixture.now,
    });
    const intakePolicyId = await ctx.db.insert("intakePolicyVersions", {
      eventId: fixture.eventId,
      version: 1,
      status: "published",
      ...defaultDeterministicIntakePolicy,
      checksum: intakePolicyChecksum(defaultDeterministicIntakePolicy),
      createdByPersonId: fixture.personId,
      createdAt: fixture.now,
      publishedAt: fixture.now,
    });
    const projectDraftId = await ctx.db.insert("projectDrafts", {
      eventId: fixture.eventId,
      teamId: fixture.teamId,
      trackCatalogVersionId: catalogId,
      intakePolicyVersionId: intakePolicyId,
      stage: "review",
      initialIdea: "A fixture project",
      chosenCoreTrackVersionId: trackId,
      chosenSponsorTrackVersionIds: [],
      recommendationState: "unavailable",
      version: 1,
      lastEditedByMembershipId: fixture.membershipId,
      updatedAt: fixture.now,
    });
    const initialAnswerId = await ctx.db.insert("intakeAnswerVersions", {
      eventId: fixture.eventId,
      teamId: fixture.teamId,
      draftId: projectDraftId,
      promptKey: "initial_idea",
      answerVersion: 1,
      value: "A fixture project",
      status: "active",
      writtenByMembershipId: fixture.membershipId,
      writtenAt: fixture.now,
      clientOperationId: "provider-fixture-initial",
    });
    const questionId = await ctx.db.insert("intakeGeneratedQuestions", {
      eventId: fixture.eventId,
      teamId: fixture.teamId,
      draftId: projectDraftId,
      ordinal: 1,
      text: "Who needs it?",
      purposeKey: "user",
      answerLength: "short",
      source: "fallback",
      sourceAnswerVersionIds: [initialAnswerId],
      intakePolicyVersionId: intakePolicyId,
      state: "answered",
      validationCategory: "test_fixture",
      answeredAt: fixture.now,
      createdAt: fixture.now,
    });
    await ctx.db.insert("intakeAnswerVersions", {
      eventId: fixture.eventId,
      teamId: fixture.teamId,
      draftId: projectDraftId,
      promptKey: "introduction_follow_up_1",
      generatedQuestionId: questionId,
      answerVersion: 1,
      value: "Event participants",
      status: "active",
      writtenByMembershipId: fixture.membershipId,
      writtenAt: fixture.now,
      clientOperationId: "provider-fixture-follow-up",
    });
    const lockedRosterSnapshotId = await createTestSubmissionSnapshot(ctx, {
      eventId: fixture.eventId,
      teamId: fixture.teamId,
      teamMemberIds: [teamMemberId],
      intakePolicyVersionId: intakePolicyId,
      participantPolicyVersionId: fixture.participantPolicyVersionId,
      admissionPolicyVersionId: policyId,
      coreTrackVersionId: trackId,
      submittedAt: fixture.now,
    });
    const projectVersionId = await ctx.db.insert("projectVersions", {
      eventId: fixture.eventId,
      teamId: fixture.teamId,
      version: 1,
      initialIdea: "A fixture project",
      intakePolicyVersionId: intakePolicyId,
      intakeResponses: [
        {
          questionId,
          ordinal: 1,
          question: "Who needs it?",
          purposeKey: "user",
          answerLength: "short",
          source: "fallback",
          answer: "Event participants",
          skipped: false,
        },
      ],
      coreTrackVersionId: trackId,
      sponsorTrackVersionIds: [],
      lockedRosterSnapshotId,
      lockedMemberCount: 1,
      lockedLeadMembershipId: fixture.membershipId,
      freshForEventAttestation: {
        participantPolicyVersionId: fixture.participantPolicyVersionId,
        acceptedByMembershipId: fixture.membershipId,
        acceptedAt: fixture.now,
      },
      finalConfirmation: {
        participantPolicyVersionId: fixture.participantPolicyVersionId,
        previewedDraftVersion: 1,
        previewedTeamVersion: 1,
        previewedTrackVersionId: trackId,
        previewedSponsorTrackVersionIds: [],
        confirmedByMembershipId: fixture.membershipId,
        confirmedAt: fixture.now,
      },
      participantPolicyVersionId: fixture.participantPolicyVersionId,
      admissionPolicyVersionId: policyId,
      sourceDraftVersion: 1,
      submittedByMembershipId: fixture.membershipId,
      submittedAt: fixture.now,
    });
    const applicationId = await ctx.db.insert("applications", {
      eventId: fixture.eventId,
      teamId: fixture.teamId,
      submittedProjectVersionId: projectVersionId,
      admissionPolicyVersionId: policyId,
      state: "accepted",
      experienceBand: "mixed_or_external",
      humanDecision: "accept",
      humanReasonCode: "fixture_accept",
      decidedByPersonId: fixture.personId,
      decidedAt: fixture.now,
      assignedReviewCount: 0,
      completedReviewCount: 0,
      contentVersion: 1,
      version: 2,
      submittedAt: fixture.now,
    });
    const destinationId = await ctx.db.insert("participantNotificationDestinations", {
      eventId: fixture.eventId,
      membershipId: fixture.membershipId,
      personId: fixture.personId,
      channel: "verified_email",
      emailNormalized: "fixture@example.test",
      status: "active",
      version: 1,
      createdAt: fixture.now,
      updatedAt: fixture.now,
    });
    const providerMessageId = "cloudflare-message-fixture-1";
    const deliveryId = await ctx.db.insert("participantNotificationDeliveries", {
      eventId: fixture.eventId,
      applicationId,
      teamId: fixture.teamId,
      membershipId: fixture.membershipId,
      personId: fixture.personId,
      destinationId,
      communicationsPolicyVersionId: fixture.communicationsPolicyVersionId,
      channel: "verified_email",
      destinationEmailNormalized: "fixture@example.test",
      templateKey: "accept",
      applicationVersion: 2,
      portalPath: "/submitted",
      rootNotificationKey: "fixture-notification",
      retryNumber: 0,
      state: initial.state,
      attemptCount: 1,
      attemptId: initial.attemptId,
      claimExpiresAt: fixture.now + 30_000,
      version: 1,
      createdAt: fixture.now,
      updatedAt: fixture.now,
    });
    return { ...fixture, applicationId, destinationId, deliveryId, providerMessageId };
  });
}

async function participantDeliveryState(
  backend: BackendTest,
  deliveryId: Awaited<ReturnType<typeof seedParticipantDelivery>>["deliveryId"],
  destinationId: Awaited<ReturnType<typeof seedParticipantDelivery>>["destinationId"],
) {
  return backend.run(async (ctx) => ({
    delivery: await ctx.db.get(deliveryId),
    destination: await ctx.db.get(destinationId),
    providerEvents: await ctx.db.query("participantNotificationProviderEvents").collect(),
  }));
}

async function sendCloudflareEmailEvent(
  backend: BackendTest,
  args: {
    eventId: string;
    messageId: string;
    type: "email.delivered" | "email.delivery_delayed" | "email.bounced";
    providerAt: number;
    disableDestination: boolean;
    providerErrorCode?: string;
    callbackSecret: string;
  },
) {
  const payload = JSON.stringify({
    protocolVersion: "2026-08-08",
    eventId: args.eventId,
    messageId: args.messageId,
    recipient: "fixture@example.test",
    eventType: args.type,
    providerAt: args.providerAt,
    disableDestination: args.disableDestination,
    ...(args.providerErrorCode !== undefined
      ? { providerErrorCode: args.providerErrorCode }
      : {}),
  });
  const timestamp = String(Date.now());
  const signature = await signServiceBody({
    context: participantEmailEventSignatureContext,
    secret: args.callbackSecret,
    timestamp,
    body: payload,
  });
  return backend.fetch("/communications/cloudflare-email/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-c2c-timestamp": timestamp,
      "x-c2c-signature": signature,
    },
    body: payload,
  });
}

function githubSignature(secret: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
