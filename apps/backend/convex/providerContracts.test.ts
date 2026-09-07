import {
  defaultParticipantEmailTemplates,
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
import { defaultDeterministicIntakePolicy, intakePolicyChecksum } from "./lib/intakePolicy";
import { defaultParticipantPolicy, participantPolicyChecksum } from "./lib/participantPolicy";
import { createTestSubmissionSnapshot } from "./lib/testSubmissionSnapshot";
import { walletUrlOrEmpty, withoutUnavailableWalletActions } from "./participantEmail";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const originalEmailEventCallbackSecret = process.env.EMAIL_EVENT_CALLBACK_SECRET;
const originalAuthSiteUrl = process.env.AUTH_SITE_URL;
const originalParticipantSiteUrl = process.env.PARTICIPANT_SITE_URL;
const originalOperationsSiteUrl = process.env.OPERATIONS_SITE_URL;

process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";

type BackendTest = TestConvex<typeof schema>;

afterEach(() => {
  restoreEnvironment("EMAIL_EVENT_CALLBACK_SECRET", originalEmailEventCallbackSecret);
});

afterAll(() => {
  restoreEnvironment("AUTH_SITE_URL", originalAuthSiteUrl);
  restoreEnvironment("PARTICIPANT_SITE_URL", originalParticipantSiteUrl);
  restoreEnvironment("OPERATIONS_SITE_URL", originalOperationsSiteUrl);
});

describe("GitHub provider contract", () => {
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


describe("Cloudflare participant-email contract", () => {
  test("keeps wallet failures from rejecting event-pass email generation", async () => {
    await expect(
      walletUrlOrEmpty(async () => {
        throw new Error("wallet provider unavailable");
      }),
    ).resolves.toBe("");
    await expect(walletUrlOrEmpty(async () => "https://wallet.example.test/pass")).resolves.toBe(
      "https://wallet.example.test/pass",
    );
  });

  test("keeps the external pass email QR-only even when wallet providers are configured", () => {
    const template = defaultParticipantEmailTemplates().find(
      (candidate) => candidate.templateKey === "external_event_pass",
    );
    if (!template) throw new Error("The external event-pass template is missing.");

    const withoutWallets = withoutUnavailableWalletActions(template.html, {
      google_wallet_url: "",
      apple_wallet_url: "",
    });
    expect(withoutWallets).toContain("event-pass-qr.png");
    expect(withoutWallets).not.toContain("Add to Google Wallet");
    expect(withoutWallets).not.toContain("Add to Apple Wallet");

    const withWallets = withoutUnavailableWalletActions(template.html, {
      google_wallet_url: "https://pay.google.com/example",
      apple_wallet_url: "https://example.test/apple-pass",
    });
    expect(withWallets).toContain("event-pass-qr.png");
    expect(withWallets).not.toContain("Add to Google Wallet");
    expect(withWallets).not.toContain("Add to Apple Wallet");
    expect(withWallets).not.toContain("https://pay.google.com/example");
    expect(withWallets).not.toContain("https://example.test/apple-pass");
  });

  test.each([
    ["email.delivered", false, "delivered"],
    ["email.bounced", true, "bounced"],
    ["email.complained", true, "suppressed"],
    ["email.suppressed", true, "suppressed"],
  ] as const)("applies %s using saved policy provenance when the provider pin is absent", async (eventType, disableDestination, expectedState) => {
    const backend = convexTest(schema, modules);
    const fixture = await seedParticipantDelivery(backend, { state: "sending", attemptId: "unpinned" });
    await backend.run((ctx) => ctx.db.patch(fixture.deliveryId, {
      state: "sent", attemptId: undefined, providerMessageId: fixture.providerMessageId,
    }));
    const event = {
      eventId: "unpinned-callback", providerMessageId: fixture.providerMessageId,
      recipientEmailNormalized: "fixture@example.test", eventType,
      providerAt: fixture.now + 1_000, disableDestination, payloadHash: "fixture-event-hash",
    };
    expect(await backend.mutation(internal.participantNotificationState.recordProviderEvent, event))
      .toEqual({ duplicate: false, matched: true });
    const state = await participantDeliveryState(backend, fixture.deliveryId, fixture.destinationId);
    expect(state.delivery).toMatchObject({ state: expectedState, provider: "cloudflare_email" });
    expect(state.destination?.status).toBe(disableDestination ? "disabled" : "active");
    expect(await backend.mutation(internal.participantNotificationState.recordProviderEvent, event))
      .toEqual({ duplicate: true, matched: true });
    expect((await participantDeliveryState(backend, fixture.deliveryId, fixture.destinationId)).delivery?.version)
      .toBe(state.delivery?.version);
  });

  test("reconciles a previously unmatched callback, but never applies Cloudflare events to SES", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedParticipantDelivery(backend, { state: "sending", attemptId: "unmatched" });
    const event = {
      eventId: "unmatched-callback", providerMessageId: fixture.providerMessageId,
      recipientEmailNormalized: "fixture@example.test", eventType: "email.bounced" as const,
      providerAt: fixture.now + 1_000, disableDestination: true, payloadHash: "fixture-event-hash",
    };
    expect(await backend.mutation(internal.participantNotificationState.recordProviderEvent, event))
      .toEqual({ duplicate: false, matched: false });
    await backend.run((ctx) => ctx.db.patch(fixture.deliveryId, {
      state: "sent", attemptId: undefined, providerMessageId: fixture.providerMessageId,
    }));
    expect(await backend.mutation(internal.participantNotificationState.recordProviderEvent, event))
      .toEqual({ duplicate: true, matched: true });

    await backend.run(async (ctx) => {
      await ctx.db.patch(fixture.deliveryId, { provider: undefined });
      await ctx.db.patch(fixture.communicationsPolicyVersionId, { notificationProvider: "aws_ses" });
    });
    expect(await backend.mutation(internal.participantNotificationState.recordProviderEvent, {
      ...event, eventId: "ses-mismatch", providerAt: event.providerAt + 1,
    })).toEqual({ duplicate: false, matched: false });
  });

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
      provider: "cloudflare_email",
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
      applicationsCloseAt: Date.now() + 86_400_000,
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
      emailTemplates: defaultParticipantEmailTemplates(),
    });
    const communicationsPolicyVersionId = await ctx.db.insert("communicationsPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...communicationsPolicy,
      checksum: communicationsPolicyChecksum(communicationsPolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
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
      intakePolicyVersionId: intakePolicyId,
      stage: "review",
      initialIdea: "A fixture project",
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
        },
      ],
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
      decisionStage: "released",
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
    protocolVersion: "participant-email-v1",
    eventId: args.eventId,
    messageId: args.messageId,
    recipient: "fixture@example.test",
    eventType: args.type,
    providerAt: args.providerAt,
    disableDestination: args.disableDestination,
    ...(args.providerErrorCode !== undefined ? { providerErrorCode: args.providerErrorCode } : {}),
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


function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
