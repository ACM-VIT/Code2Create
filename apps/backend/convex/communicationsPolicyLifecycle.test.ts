import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { defaultParticipantEmailTemplates } from "@code2create/domain";

import { internal } from "./_generated/api.js";
import {
  communicationsPolicyChecksum,
  normalizeCommunicationsPolicy,
  publishCommunicationsPolicy,
  saveCommunicationsPolicyDraft,
  type CommunicationsPolicy,
} from "./lib/communicationsPolicy.ts";
import { defaultDeterministicIntakePolicy, intakePolicyChecksum } from "./lib/intakePolicy.ts";
import { permissionCatalog } from "./lib/permissionCatalog.ts";
import { defaultParticipantPolicy, participantPolicyChecksum } from "./lib/participantPolicy.ts";
import { enqueueApplicationNotifications } from "./lib/participantNotificationDelivery.ts";
import { createTestSubmissionSnapshot } from "./lib/testSubmissionSnapshot.ts";
import { acceptedTeamCommunicationsForTeam } from "./participantCommunications.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("communications policy lifecycle", () => {
  test("keeps configuration capabilities independently event scoped", () => {
    expect(permissionCatalog["configuration.communications.read"]).toEqual({
      scopes: [],
      eventWide: true,
    });
    expect(permissionCatalog["configuration.communications.draft.create"]).toEqual({
      scopes: [],
      eventWide: true,
    });
    expect(permissionCatalog["configuration.communications.validate"]).toEqual({
      scopes: [],
      eventWide: true,
    });
    expect(permissionCatalog["configuration.communications.publish"]).toEqual({
      scopes: [],
      eventWide: true,
    });
  });

  test("rejects non-Discord destinations and unsafe email HTML", () => {
    const startsAt = Date.UTC(2027, 7, 8, 3, 30);
    const endsAt = startsAt + 48 * 60 * 60 * 1_000;
    expect(() =>
      normalizeCommunicationsPolicy({
        ...policy(startsAt, endsAt, "initial"),
        discordUrl: "https://example.test/community",
      }),
    ).toThrow("must use discord.gg");
    expect(() =>
      normalizeCommunicationsPolicy({
        ...policy(startsAt, endsAt, "initial"),
        emailTemplates: policy(startsAt, endsAt, "initial").emailTemplates.map((template) =>
          template.templateKey === "accept"
            ? { ...template, html: "<script>alert('no')</script>" }
            : template,
        ),
      }),
    ).toThrow("unsafe HTML");
  });

  test("allows one competing draft from the same observed state", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "draft-race");
    const attempts = await Promise.allSettled([
      backend.run((ctx) =>
        saveCommunicationsPolicyDraft(ctx, {
          event: fixture.event,
          actorPersonId: fixture.personId,
          policy: policy(fixture.startsAt, fixture.endsAt, "alpha"),
          now: fixture.now + 1,
        }),
      ),
      backend.run((ctx) =>
        saveCommunicationsPolicyDraft(ctx, {
          event: fixture.event,
          actorPersonId: fixture.personId,
          policy: policy(fixture.startsAt, fixture.endsAt, "beta"),
          now: fixture.now + 1,
        }),
      ),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const drafts = await backend.run((ctx) =>
      ctx.db
        .query("communicationsPolicyVersions")
        .withIndex("by_event_status", (index) =>
          index.eq("eventId", fixture.event._id).eq("status", "draft"),
        )
        .collect(),
    );
    expect(drafts).toHaveLength(1);
  });

  test("updates eligible portals while queued email keeps its pinned wording", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "publication");
    const beforeDecision = await backend.run((ctx) =>
      acceptedTeamCommunicationsForTeam(ctx, fixture.event, fixture.teamId),
    );
    expect(beforeDecision).toBeNull();

    await backend.run((ctx) =>
      ctx.db.patch(fixture.applicationId, {
        state: "accepted",
        decisionStage: "released",
        humanDecision: "accept",
        humanReasonCode: "reviewed_accept",
        decidedByPersonId: fixture.personId,
        decidedAt: fixture.now,
        version: 2,
      }),
    );
    await backend.run((ctx) =>
      enqueueApplicationNotifications(ctx, {
        eventId: fixture.event._id,
        applicationId: fixture.applicationId,
        teamId: fixture.teamId,
        lockedRosterSnapshotId: fixture.lockedRosterSnapshotId,
        lockedMemberCount: 1,
        communicationsPolicyVersionId: fixture.communicationsPolicyId,
        templateKey: "accept",
        applicationVersion: 2,
        now: fixture.now + 1,
        schedule: false,
      }),
    );
    const deliveryId = await runQueuedNotificationBatch(backend, fixture);

    const draft = await backend.run((ctx) =>
      saveCommunicationsPolicyDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        policy: policy(fixture.startsAt, fixture.endsAt, "new"),
        now: fixture.now + 2,
      }),
    );
    await backend.run((ctx) =>
      publishCommunicationsPolicy(ctx, {
        event: fixture.event,
        draftPolicyId: draft.policyVersionId,
        expectedDraftChecksum: draft.checksum,
        now: fixture.now + 3,
      }),
    );

    const result = await backend.run(async (ctx) => {
      const event = await ctx.db.get(fixture.event._id);
      if (!event) throw new Error("The fixture event is missing.");
      return {
        projection: await acceptedTeamCommunicationsForTeam(ctx, event, fixture.teamId),
        delivery: await ctx.db.get(deliveryId),
        oldPolicy: await ctx.db.get(fixture.communicationsPolicyId),
      };
    });
    const claim = await backend.mutation(internal.participantNotificationState.claimDelivery, {
      deliveryId,
      attemptId: "communications-policy-test-attempt",
    });

    expect(result.projection).toMatchObject({
      policyVersionId: draft.policyVersionId,
      venueName: "New hall",
      discordLabel: "Open new Discord",
    });
    expect(result.oldPolicy?.status).toBe("superseded");
    expect(result.delivery?.communicationsPolicyVersionId).toBe(fixture.communicationsPolicyId);
    expect(claim).toMatchObject({
      subjectTemplate: "Code2Create initial accept update",
      textTemplate: "The initial accept update for {{team_name}} is ready: {{portal_url}}",
      participantName: "Communications fixture",
      teamName: "Quiet team",
    });
  });

  test("makes an ambiguous Cloudflare send terminal instead of risking a duplicate", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "ambiguous-send");
    const deliveryId = await queueAcceptedNotification(backend, fixture);
    const claim = await backend.mutation(internal.participantNotificationState.claimDelivery, {
      deliveryId,
      attemptId: "ambiguous-send-attempt",
    });
    if (!claim) throw new Error("The notification delivery was not claimed.");

    await backend.mutation(internal.participantNotificationState.recordSendFailure, {
      deliveryId,
      attemptId: "ambiguous-send-attempt",
      errorCode: "cloudflare_email_request_ambiguous",
      retryable: true,
      ambiguous: true,
    });

    const delivery = await backend.run((ctx) => ctx.db.get(deliveryId));
    expect(delivery).toMatchObject({
      state: "unknown",
      attemptCount: 1,
      providerErrorCode: "cloudflare_email_request_ambiguous",
    });
    expect(delivery?.attemptId).toBeUndefined();
    expect(delivery?.nextAttemptAt).toBeUndefined();
  });

  test("keeps a released result email valid when an accepted application advances to an offer", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "advanced-application");
    const deliveryId = await queueAcceptedNotification(backend, fixture);
    await backend.run((ctx) =>
      ctx.db.patch(fixture.applicationId, {
        state: "offer_sent",
        version: 3,
      }),
    );

    const claim = await backend.mutation(internal.participantNotificationState.claimDelivery, {
      deliveryId,
      attemptId: "send-released-acceptance",
    });
    const delivery = await backend.run((ctx) => ctx.db.get(deliveryId));

    expect(claim).toMatchObject({
      deliveryId,
      subjectTemplate: "Code2Create initial accept update",
    });
    expect(delivery).toMatchObject({
      state: "sending",
      attemptCount: 1,
    });
  });

  test("drops a stale roster batch before it creates delivery rows", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "stale-roster-batch");
    await backend.run((ctx) =>
      ctx.db.patch(fixture.applicationId, {
        state: "offer_sent",
        humanDecision: "accept",
        version: 3,
      }),
    );

    await backend.mutation(internal.participantNotifications.enqueueRosterBatch, {
      eventId: fixture.event._id,
      applicationId: fixture.applicationId,
      teamId: fixture.teamId,
      lockedRosterSnapshotId: fixture.lockedRosterSnapshotId,
      lockedMemberCount: 1,
      communicationsPolicyVersionId: fixture.communicationsPolicyId,
      templateKey: "accept",
      applicationVersion: 2,
      cursor: null,
      processedMemberCount: 0,
    });

    const deliveries = await backend.run((ctx) =>
      ctx.db.query("participantNotificationDeliveries").collect(),
    );
    expect(deliveries).toEqual([]);
  });

  test("settles an expired Cloudflare send lease as unknown without reclaiming it", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "expired-send");
    const deliveryId = await queueAcceptedNotification(backend, fixture);
    const firstClaim = await backend.mutation(internal.participantNotificationState.claimDelivery, {
      deliveryId,
      attemptId: "expired-send-attempt",
    });
    if (!firstClaim) throw new Error("The notification delivery was not claimed.");
    await backend.run((ctx) => ctx.db.patch(deliveryId, { claimExpiresAt: 0 }));

    const reclaimed = await backend.mutation(internal.participantNotificationState.claimDelivery, {
      deliveryId,
      attemptId: "must-not-send",
    });
    const delivery = await backend.run((ctx) => ctx.db.get(deliveryId));
    expect(reclaimed).toBeNull();
    expect(delivery).toMatchObject({
      state: "unknown",
      attemptCount: 1,
      providerErrorCode: "cloudflare_email_send_outcome_unknown",
    });
    expect(delivery?.attemptId).toBeUndefined();
  });

  test("bounds retries for provider rejections that prove non-acceptance", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "bounded-send-retry");
    const deliveryId = await queueAcceptedNotification(backend, fixture);

    for (const attemptId of ["retry-attempt-1", "retry-attempt-2", "retry-attempt-3"]) {
      const claim = await backend.mutation(internal.participantNotificationState.claimDelivery, {
        deliveryId,
        attemptId,
      });
      if (!claim) throw new Error(`The delivery was not claimed for ${attemptId}.`);
      await backend.mutation(internal.participantNotificationState.recordSendFailure, {
        deliveryId,
        attemptId,
        errorCode: "cloudflare_email_10004",
        retryable: true,
        ambiguous: false,
      });
      await backend.run(async (ctx) => {
        const delivery = await ctx.db.get(deliveryId);
        if (delivery?.state === "retry_wait") {
          await ctx.db.patch(deliveryId, { nextAttemptAt: 0 });
        }
      });
    }

    const delivery = await backend.run((ctx) => ctx.db.get(deliveryId));
    expect(delivery).toMatchObject({
      state: "failed",
      attemptCount: 3,
      providerErrorCode: "cloudflare_email_10004",
    });
    expect(delivery?.attemptId).toBeUndefined();
    expect(delivery?.nextAttemptAt).toBeUndefined();
  });
});

function policy(startsAt: number, endsAt: number, label: string): CommunicationsPolicy {
  return {
    venueName: `${title(label)} hall`,
    startsAt,
    endsAt,
    nextSteps: [
      {
        stableKey: `review_${label.replaceAll("-", "_")}`,
        title: `Review ${label} details`,
        detail: `Open the portal and review the ${label} event information.`,
      },
    ],
    discordUrl: `https://discord.gg/${label}-fixture`,
    discordLabel: `Open ${label} Discord`,
    notificationProvider: "cloudflare_email",
    emailTemplates: defaultParticipantEmailTemplates().map((template) => ({
      ...template,
      subject: `Code2Create ${label} ${template.templateKey} update`,
      text: `The ${label} ${template.templateKey} update for {{team_name}} is ready: {{portal_url}}`,
    })),
  };
}

function title(value: string) {
  return `${value.slice(0, 1).toLocaleUpperCase("en")}${value.slice(1)}`;
}

async function queueAcceptedNotification(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedFixture>>,
) {
  await backend.run((ctx) =>
    ctx.db.patch(fixture.applicationId, {
      state: "accepted",
      decisionStage: "released",
      humanDecision: "accept",
      humanReasonCode: "reviewed_accept",
      decidedByPersonId: fixture.personId,
      decidedAt: fixture.now,
      version: 2,
    }),
  );
  await backend.run((ctx) =>
    enqueueApplicationNotifications(ctx, {
      eventId: fixture.event._id,
      applicationId: fixture.applicationId,
      teamId: fixture.teamId,
      lockedRosterSnapshotId: fixture.lockedRosterSnapshotId,
      lockedMemberCount: 1,
      communicationsPolicyVersionId: fixture.communicationsPolicyId,
      templateKey: "accept",
      applicationVersion: 2,
      now: fixture.now + 1,
      schedule: false,
    }),
  );
  return runQueuedNotificationBatch(backend, fixture);
}

async function runQueuedNotificationBatch(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedFixture>>,
) {
  await backend.mutation(internal.participantNotifications.enqueueRosterBatch, {
    eventId: fixture.event._id,
    applicationId: fixture.applicationId,
    teamId: fixture.teamId,
    lockedRosterSnapshotId: fixture.lockedRosterSnapshotId,
    lockedMemberCount: 1,
    communicationsPolicyVersionId: fixture.communicationsPolicyId,
    templateKey: "accept",
    applicationVersion: 2,
    cursor: null,
    processedMemberCount: 0,
  });
  const delivery = await backend.run((ctx) =>
    ctx.db.query("participantNotificationDeliveries").first(),
  );
  if (!delivery) throw new Error("The fixture notification was not queued.");
  return delivery._id;
}

async function seedFixture(backend: BackendTest, slug: string) {
  const now = Date.UTC(2027, 6, 1, 9, 0);
  const startsAt = Date.UTC(2027, 7, 8, 3, 30);
  const endsAt = startsAt + 48 * 60 * 60 * 1_000;
  return backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId: `communications-${slug}`,
      googleSubject: `communications-${slug}`,
      verifiedEmail: `${slug}@example.test`,
      displayName: "Communications fixture",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: `communications-${slug}`,
      name: "Code2Create communications fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: Date.now() + 86_400_000,
      startsAt,
      endsAt,
      createdByPersonId: personId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const initialPolicy = normalizeCommunicationsPolicy(policy(startsAt, endsAt, "initial"));
    const participantPolicyId = await ctx.db.insert("participantPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...defaultParticipantPolicy,
      checksum: participantPolicyChecksum(defaultParticipantPolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    const communicationsPolicyId = await ctx.db.insert("communicationsPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...initialPolicy,
      checksum: communicationsPolicyChecksum(initialPolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, {
      publishedParticipantPolicyId: participantPolicyId,
      publishedCommunicationsPolicyId: communicationsPolicyId,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `${slug}@example.test`,
      displayName: "Communications fixture",
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
      onboardingStatus: "submitted",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Quiet team",
      publicCode: `COMM${slug.length}`,
      leadMembershipId: membershipId,
      status: "submitted",
      activeMemberCount: 1,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 1,
      membershipLocked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const teamMemberId = await ctx.db.insert("teamMembers", {
      eventId,
      teamId,
      membershipId,
      role: "lead",
      status: "active",
      joinedAt: now,
      source: "created",
    });
    const intakePolicyId = await ctx.db.insert("intakePolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...defaultDeterministicIntakePolicy,
      checksum: intakePolicyChecksum(defaultDeterministicIntakePolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    const admissionPolicyId = await ctx.db.insert("admissionPolicyVersions", {
      eventId,
      version: "admission-v1",
      status: "published",
      aiRecommendationMode: "disabled",
      minimumHumanReviews: 1,
      overallParticipantCapacity: 100,
      criteria: [],
      decisionReasonCodes: [],
      checksum: "communications-admission-policy",
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    const lockedRosterSnapshotId = await createTestSubmissionSnapshot(ctx, {
      eventId,
      teamId,
      teamMemberIds: [teamMemberId],
      intakePolicyVersionId: intakePolicyId,
      participantPolicyVersionId: participantPolicyId,
      admissionPolicyVersionId: admissionPolicyId,
      submittedAt: now,
    });
    const projectId = await ctx.db.insert("projectVersions", {
      eventId,
      teamId,
      version: 1,
      initialIdea: "A practical event communications project.",
      intakePolicyVersionId: intakePolicyId,
      intakeResponses: [],
      lockedRosterSnapshotId,
      lockedMemberCount: 1,
      lockedLeadMembershipId: membershipId,
      freshForEventAttestation: {
        participantPolicyVersionId: participantPolicyId,
        acceptedByMembershipId: membershipId,
        acceptedAt: now,
      },
      finalConfirmation: {
        participantPolicyVersionId: participantPolicyId,
        previewedDraftVersion: 1,
        previewedTeamVersion: 1,
        confirmedByMembershipId: membershipId,
        confirmedAt: now,
      },
      participantPolicyVersionId: participantPolicyId,
      admissionPolicyVersionId: admissionPolicyId,
      sourceDraftVersion: 1,
      submittedByMembershipId: membershipId,
      submittedAt: now,
    });
    const applicationId = await ctx.db.insert("applications", {
      eventId,
      teamId,
      submittedProjectVersionId: projectId,
      admissionPolicyVersionId: admissionPolicyId,
      state: "submitted",
      decisionStage: "unrecorded",
      experienceBand: "mixed_or_external",
      assignedReviewCount: 0,
      completedReviewCount: 0,
      contentVersion: 1,
      version: 1,
      submittedAt: now,
    });
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("The communications fixture event did not persist.");
    return {
      now,
      startsAt,
      endsAt,
      event,
      personId,
      teamId,
      teamMemberId,
      lockedRosterSnapshotId,
      applicationId,
      communicationsPolicyId,
    };
  });
}
