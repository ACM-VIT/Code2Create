import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api.js";
import { createAdmissionOffer, transitionOffer } from "./admissions.ts";
import {
  communicationsPolicyChecksum,
  normalizeCommunicationsPolicy,
} from "./lib/communicationsPolicy.ts";
import { permissionCatalog } from "./lib/permissionCatalog.ts";
import { createTestSubmissionSnapshot } from "./lib/testSubmissionSnapshot.ts";
import {
  defaultParticipantPolicy,
  participantPolicyChecksum,
} from "./lib/participantPolicy.ts";
import { teamCanBeMapped } from "./lib/floor.ts";
import {
  defaultDeterministicIntakePolicy,
  intakePolicyChecksum,
} from "./lib/intakePolicy.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

type BackendTest = TestConvex<typeof schema>;

describe("admission offer lifecycle", () => {
  test("only exposes exact application management and exact-team response scopes", () => {
    expect(permissionCatalog["application.offer.manage"]).toEqual({
      scopes: ["application"],
      eventWide: true,
    });
    expect(permissionCatalog["application.offer.respond"]).toEqual({
      scopes: ["team"],
      eventWide: false,
    });
  });

  test("keeps hall mapping closed until the team confirms its offer", () => {
    expect(teamCanBeMapped("admitted")).toBe(false);
    expect(teamCanBeMapped("confirmed")).toBe(true);
    expect(teamCanBeMapped("checked_in")).toBe(true);
    expect(teamCanBeMapped("active")).toBe(true);
  });

  test("rejects admission evidence that is absent from the submitted intake", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedOfferedApplication(backend, Date.now() + 60_000);
    const recommendationId = await backend.run((ctx) =>
      ctx.db.insert("admissionAIRecommendations", {
        eventId: fixture.eventId,
        applicationId: fixture.applicationId,
        teamId: fixture.teamId,
        projectVersionId: fixture.projectId,
        admissionPolicyVersionId: fixture.policyId,
        applicationContentVersion: 1,
        sourceInputFingerprint: "admission-source-v1",
        experienceBand: "mixed_or_external",
        state: "running",
        criterionAssessments: [],
        strengths: [],
        concerns: [],
        proposedQuestions: [],
        limitations: [],
        createdAt: Date.now(),
      }),
    );
    await backend.run((ctx) =>
      ctx.db.patch(fixture.applicationId, { aiRecommendationId: recommendationId }),
    );
    await backend.mutation(internal.admissionIntelligence.finishRecommendation, {
      recommendationId,
      sourceInputFingerprint: "admission-source-v1",
      state: "succeeded",
      recommendation: "accept",
      criterionAssessments: [{
        criterionKey: "intent",
        assessment: "meets",
        sourceRefs: ["follow_up_2"],
      }],
      strengths: ["The intended venue workflow is clear."],
      concerns: [],
      proposedQuestions: [],
      confidence: "medium",
      limitations: [],
      latencyMs: 20,
    });
    const state = await backend.run(async (ctx) => ({
      recommendation: await ctx.db.get(recommendationId),
      application: await ctx.db.get(fixture.applicationId),
    }));
    expect(state.recommendation).toMatchObject({
      state: "invalid",
      failureCategory: "invalid_completion_payload",
      criterionAssessments: [],
    });
    expect(state.application?.aiDisposition).toBe("unavailable");
  });

  test("sending an offer reserves only the locked roster and moves it to offer pending", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedOfferedApplication(backend, Date.now() + 60_000);
    await enqueueRosterNotification(backend, fixture, "offer", 3);
    await updateRosterStatus(backend, fixture, "offer_pending");
    const state = await readOfferState(backend, fixture);

    expect(state.application).toMatchObject({
      state: "offer_sent",
      version: 3,
      currentOfferId: fixture.offerId,
    });
    expect(state.offer).toMatchObject({
      state: "offered",
      lockedRosterSnapshotId: fixture.lockedRosterSnapshotId,
      participantCount: 1,
    });
    expect(state.membership?.onboardingStatus).toBe("offer_pending");
    expect(state.reservation).toMatchObject({
      offerId: fixture.offerId,
      state: "active",
      participantCount: 1,
    });
    expect(state.capacity).toMatchObject({ reserved: 1, version: 2 });
    expect(state.deliveries).toHaveLength(1);
    expect(state.deliveries[0]).toMatchObject({
      templateKey: "offer",
      applicationVersion: 3,
    });
  });

  test("confirmation preserves the exact reservation and defeats a stale expiry", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedOfferedApplication(backend, Date.now() + 60_000);
    await enqueueRosterNotification(backend, fixture, "offer", 3);

    await backend.run(async (ctx) => {
      const [application, offer, project, team] = await Promise.all([
        ctx.db.get(fixture.applicationId),
        ctx.db.get(fixture.offerId),
        ctx.db.get(fixture.projectId),
        ctx.db.get(fixture.teamId),
      ]);
      if (!application || !offer || !project || !team) throw new Error("Offer fixture is incomplete.");
      await transitionOffer(ctx, {
        application,
        offer,
        project,
        team,
        transition: "confirmed",
        actorPersonId: fixture.personId,
        reason: "Fixture confirmation",
        now: Date.now(),
      });
    });
    await backend.mutation(internal.admissions.expireOffer, {
      offerId: fixture.offerId,
      expectedOfferVersion: 1,
    });
    await enqueueRosterNotification(backend, fixture, "offer_confirmed", 4);
    await updateRosterStatus(backend, fixture, "accepted");

    const state = await readOfferState(backend, fixture);
    expect(state.application).toMatchObject({ state: "confirmed", version: 4 });
    expect(state.offer).toMatchObject({
      state: "confirmed",
      version: 2,
      lockedRosterSnapshotId: fixture.lockedRosterSnapshotId,
    });
    expect(state.team).toMatchObject({ status: "confirmed", version: 3 });
    expect(state.membership?.onboardingStatus).toBe("accepted");
    expect(state.teamAvailability).toMatchObject({
      activeMemberCount: 1,
      insideMemberCount: 0,
      version: 1,
    });
    expect(state.reservation).toMatchObject({ state: "active", participantCount: 1 });
    expect(state.capacity).toMatchObject({ reserved: 1, version: 2 });
    expect(state.deliveries).toHaveLength(2);
    expect(state.deliveries.find((delivery) => delivery.templateKey === "offer_confirmed")).toMatchObject({
      templateKey: "offer_confirmed",
      applicationVersion: 4,
      state: "pending",
    });
  });

  test("expiry releases capacity once and keeps a repeated worker idempotent", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedOfferedApplication(backend, Date.now() - 1);
    await enqueueRosterNotification(backend, fixture, "offer", 3);

    await backend.mutation(internal.admissions.expireOffer, {
      offerId: fixture.offerId,
      expectedOfferVersion: 1,
    });
    await backend.mutation(internal.admissions.expireOffer, {
      offerId: fixture.offerId,
      expectedOfferVersion: 1,
    });
    await enqueueRosterNotification(backend, fixture, "offer_expired", 4);
    await updateRosterStatus(backend, fixture, "submitted");

    const state = await readOfferState(backend, fixture);
    expect(state.application).toMatchObject({ state: "offer_expired", version: 4 });
    expect(state.offer).toMatchObject({ state: "expired", version: 2 });
    expect(state.team).toMatchObject({ status: "withdrawn", version: 3 });
    expect(state.membership?.onboardingStatus).toBe("submitted");
    expect(state.reservation).toMatchObject({
      state: "released",
      releasedReason: "offer_expired",
    });
    expect(state.capacity).toMatchObject({ reserved: 0, version: 3 });
    expect(state.deliveries).toHaveLength(2);
    expect(state.deliveries.find((delivery) => delivery.templateKey === "offer_expired")).toMatchObject({
      templateKey: "offer_expired",
      applicationVersion: 4,
    });
    expect(state.audits.filter((entry) => entry.action === "admission.offer_expired")).toHaveLength(1);
  });

  test("declining releases capacity but never changes the locked roster", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedOfferedApplication(backend, Date.now() + 60_000);
    await enqueueRosterNotification(backend, fixture, "offer", 3);

    await backend.run(async (ctx) => {
      const [application, offer, project, team] = await Promise.all([
        ctx.db.get(fixture.applicationId),
        ctx.db.get(fixture.offerId),
        ctx.db.get(fixture.projectId),
        ctx.db.get(fixture.teamId),
      ]);
      if (!application || !offer || !project || !team) throw new Error("Offer fixture is incomplete.");
      await transitionOffer(ctx, {
        application,
        offer,
        project,
        team,
        transition: "declined",
        actorPersonId: fixture.personId,
        reason: "Fixture decline",
        now: Date.now(),
      });
    });
    await enqueueRosterNotification(backend, fixture, "offer_declined", 4);
    await updateRosterStatus(backend, fixture, "submitted");

    const state = await readOfferState(backend, fixture);
    expect(state.application).toMatchObject({
      state: "withdrawn",
      currentOfferId: fixture.offerId,
    });
    expect(state.offer).toMatchObject({ state: "declined" });
    expect(state.team).toMatchObject({
      status: "withdrawn",
      membershipLocked: true,
      lockedProjectVersionId: fixture.projectId,
    });
    expect(state.membership?.onboardingStatus).toBe("submitted");
    expect(state.reservation).toMatchObject({
      state: "released",
      releasedReason: "offer_declined",
    });
    expect(state.capacity?.reserved).toBe(0);
  });
});

async function seedOfferedApplication(backend: BackendTest, expiresAt: number) {
  const now = Date.now();
  return backend.run(async (ctx) => {
    const startsAt = now + 24 * 60 * 60 * 1_000;
    const endsAt = startsAt + 48 * 60 * 60 * 1_000;
    const eventId = await ctx.db.insert("events", {
      slug: `offer-fixture-${Math.abs(expiresAt)}`,
      name: "Code2Create offer fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
      startsAt,
      endsAt,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const personId = await ctx.db.insert("people", {
      authUserId: `offer-user-${expiresAt}`,
      googleSubject: `offer-subject-${expiresAt}`,
      verifiedEmail: `offer-${Math.abs(expiresAt)}@example.test`,
      displayName: "Aarav Menon",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
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
    await ctx.db.patch(eventId, { publishedParticipantPolicyId: participantPolicyId });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `offer-${Math.abs(expiresAt)}@example.test`,
      displayName: "Aarav Menon",
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
      onboardingStatus: "selected",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Quiet Circuit",
      publicCode: "OFFER01",
      leadMembershipId: membershipId,
      status: "admitted",
      activeMemberCount: 1,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 1,
      membershipLocked: true,
      version: 2,
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
    const policyId = await ctx.db.insert("admissionPolicyVersions", {
      eventId,
      version: "admission-v1",
      status: "published",
      aiRecommendationMode: "disabled",
      minimumHumanReviews: 1,
      overallParticipantCapacity: 100,
      criteria: [{
        criterionKey: "intent",
        label: "Intent",
        guidanceByBand: {
          firstYear: "The team explains a genuine problem and workable basic idea.",
          earlyYear: "The team explains a genuine problem and a coherent event-sized idea.",
          laterYear: "The team explains a clear problem, scope, feasibility, and differentiation.",
          postgraduateOrProfessional: "The team explains a credible plan, trade-offs, and differentiation.",
          mixedOrExternal: "The team explains a clear problem and workable event-sized approach.",
        },
      }],
      decisionReasonCodes: [],
      checksum: "offer-policy",
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
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
    const communicationsPolicy = normalizeCommunicationsPolicy({
      venueName: "Offer fixture hall",
      startsAt,
      endsAt,
      nextSteps: [
        {
          stableKey: "review_portal",
          title: "Review the portal",
          detail: "Check the latest event details before confirming the team's place.",
        },
      ],
      discordUrl: "https://discord.gg/offer-fixture",
      discordLabel: "Open event Discord",
      notificationProvider: "cloudflare_email",
      notificationSubject: "Code2Create application update",
      notificationIntro: "There is an update to your team's Code2Create application.",
    });
    const communicationsPolicyId = await ctx.db.insert("communicationsPolicyVersions", {
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
      publishedCommunicationsPolicyId: communicationsPolicyId,
    });
    const projectDraftId = await ctx.db.insert("projectDrafts", {
      eventId,
      teamId,
      intakePolicyVersionId: intakePolicyId,
      stage: "review",
      initialIdea: "A quiet, reliable venue coordination tool.",
      version: 1,
      lastEditedByMembershipId: membershipId,
      updatedAt: now,
    });
    const initialAnswerId = await ctx.db.insert("intakeAnswerVersions", {
      eventId,
      teamId,
      draftId: projectDraftId,
      promptKey: "initial_idea",
      answerVersion: 1,
      value: "A quiet, reliable venue coordination tool.",
      status: "active",
      writtenByMembershipId: membershipId,
      writtenAt: now,
      clientOperationId: "offer-fixture-initial",
    });
    const questionId = await ctx.db.insert("intakeGeneratedQuestions", {
      eventId,
      teamId,
      draftId: projectDraftId,
      ordinal: 1,
      text: "Who uses it first?",
      purposeKey: "user",
      answerLength: "short",
      source: "fallback",
      sourceAnswerVersionIds: [initialAnswerId],
      intakePolicyVersionId: intakePolicyId,
      state: "answered",
      validationCategory: "test_fixture",
      answeredAt: now,
      createdAt: now,
    });
    await ctx.db.insert("intakeAnswerVersions", {
      eventId,
      teamId,
      draftId: projectDraftId,
      promptKey: "introduction_follow_up_1",
      generatedQuestionId: questionId,
      answerVersion: 1,
      value: "The floor operations team.",
      status: "active",
      writtenByMembershipId: membershipId,
      writtenAt: now,
      clientOperationId: "offer-fixture-follow-up",
    });
    const lockedRosterSnapshotId = await createTestSubmissionSnapshot(ctx, {
      eventId,
      teamId,
      teamMemberIds: [teamMemberId],
      intakePolicyVersionId: intakePolicyId,
      participantPolicyVersionId: participantPolicyId,
      admissionPolicyVersionId: policyId,
      submittedAt: now,
    });
    const projectId = await ctx.db.insert("projectVersions", {
      eventId,
      teamId,
      version: 1,
      initialIdea: "A quiet, reliable venue coordination tool.",
      intakePolicyVersionId: intakePolicyId,
      intakeResponses: [
        {
          questionId,
          ordinal: 1,
          question: "Who uses it first?",
          purposeKey: "user",
          answerLength: "short",
          source: "fallback",
          answer: "The floor operations team.",
          skipped: false,
        },
      ],
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
      admissionPolicyVersionId: policyId,
      sourceDraftVersion: 1,
      submittedByMembershipId: membershipId,
      submittedAt: now,
    });
    await ctx.db.patch(teamId, { lockedProjectVersionId: projectId });
    const applicationId = await ctx.db.insert("applications", {
      eventId,
      teamId,
      submittedProjectVersionId: projectId,
      admissionPolicyVersionId: policyId,
      state: "accepted",
      experienceBand: "mixed_or_external",
      humanDecision: "accept",
      humanReasonCode: "fixture_accept",
      decidedByPersonId: personId,
      decidedAt: now,
      assignedReviewCount: 0,
      completedReviewCount: 0,
      contentVersion: 1,
      version: 2,
      submittedAt: now,
    });
    const capacityId = await ctx.db.insert("admissionCapacityBuckets", {
      eventId,
      admissionPolicyVersionId: policyId,
      capacity: 100,
      reserved: 0,
      version: 1,
      updatedAt: now,
    });
    const [event, application, project, policy, team] = await Promise.all([
      ctx.db.get(eventId),
      ctx.db.get(applicationId),
      ctx.db.get(projectId),
      ctx.db.get(policyId),
      ctx.db.get(teamId),
    ]);
    if (!event || !application || !project || !policy || !team) {
      throw new Error("Offer fixture context did not persist.");
    }
    const creationExpiry = expiresAt > now ? expiresAt : now + 60_000;
    const created = await createAdmissionOffer(ctx, {
      event,
      application,
      project,
      policy,
      team,
      actorPersonId: personId,
      grantIds: [],
      expiresAt: creationExpiry,
      now,
    });
    if (creationExpiry !== expiresAt) {
      await ctx.db.patch(created.offer._id, { expiresAt });
    }
    const reservation = await ctx.db
      .query("admissionCapacityReservations")
      .withIndex("by_offer", (index) => index.eq("offerId", created.offer._id))
      .unique();
    if (!reservation) throw new Error("Offer capacity reservation did not persist.");
    return {
      eventId,
      personId,
      membershipId,
      teamId,
      teamMemberId,
      lockedRosterSnapshotId,
      projectId,
      applicationId,
      policyId,
      communicationsPolicyId,
      offerId: created.offer._id,
      capacityId,
      reservationId: reservation._id,
    };
  });
}

async function readOfferState(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedOfferedApplication>>,
) {
  return backend.run(async (ctx) => ({
    application: await ctx.db.get(fixture.applicationId),
    offer: await ctx.db.get(fixture.offerId),
    team: await ctx.db.get(fixture.teamId),
    teamAvailability: await ctx.db
      .query("attendanceTeamAvailability")
      .withIndex("by_event_team", (index) =>
        index.eq("eventId", fixture.eventId).eq("teamId", fixture.teamId),
      )
      .unique(),
    membership: await ctx.db.get(fixture.membershipId),
    reservation: await ctx.db.get(fixture.reservationId),
    capacity: await ctx.db.get(fixture.capacityId),
    deliveries: await ctx.db.query("participantNotificationDeliveries").collect(),
    audits: await ctx.db.query("auditEvents").collect(),
  }));
}

async function updateRosterStatus(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedOfferedApplication>>,
  onboardingStatus: "submitted" | "offer_pending" | "accepted",
) {
  const application = await backend.run((ctx) => ctx.db.get(fixture.applicationId));
  if (!application) throw new Error("The offer fixture application is missing.");
  await backend.mutation(internal.admissions.updateRosterOnboardingStatus, {
    applicationId: application._id,
    expectedApplicationVersion: application.version,
    lockedRosterSnapshotId: fixture.lockedRosterSnapshotId,
    onboardingStatus,
    cursor: null,
  });
}

async function enqueueRosterNotification(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedOfferedApplication>>,
  templateKey: "offer" | "offer_confirmed" | "offer_declined" | "offer_expired",
  applicationVersion: number,
) {
  await backend.mutation(internal.participantNotifications.enqueueRosterBatch, {
    eventId: fixture.eventId,
    applicationId: fixture.applicationId,
    teamId: fixture.teamId,
    lockedRosterSnapshotId: fixture.lockedRosterSnapshotId,
    lockedMemberCount: 1,
    communicationsPolicyVersionId: fixture.communicationsPolicyId,
    templateKey,
    applicationVersion,
    cursor: null,
    processedMemberCount: 0,
  });
}
