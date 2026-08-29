import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import workpoolTest from "@convex-dev/workpool/test";
import presenceTest from "@convex-dev/presence/test";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  admissionPolicyChecksum,
  admissionPolicyForConfiguration,
  defaultAdmissionCriteria,
  defaultAdmissionReasonCodes,
  normalizeAdmissionConfiguration,
} from "./lib/admissionPolicy";
import {
  defaultDeterministicIntakePolicy,
  intakePolicyChecksum,
  normalizeIntakePolicy,
} from "./lib/intakePolicy";
import {
  defaultParticipantPolicy,
  normalizeParticipantPolicy,
  participantPolicyChecksum,
} from "./lib/participantPolicy";
import { insertPermissionGrant } from "./lib/permissions";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

describe("participant intake lifecycle", () => {
  test("moves one real application from idea through submission and a deadline-safe revision", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    workpoolTest.register(backend, "intakeWorkpool");
    presenceTest.register(backend, "intakePresence");
    const fixture = await seedFixture(backend);
    const participant = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });

    await participant.mutation(api.participants.acceptPolicy, {
      eventSlug: fixture.eventSlug,
      participantPolicyVersionId: fixture.participantPolicyId,
      accepted: true,
      clientOperationId: "intake-policy-accept",
    });
    await participant.mutation(api.participants.saveProfile, {
      eventSlug: fixture.eventSlug,
      participantPolicyVersionId: fixture.participantPolicyId,
      fullName: "Anika Shah",
      institution: "Example Institute of Technology",
      yearOfStudy: "first",
      externalCountry: "India",
      expectedProfileVersion: 0,
      clientOperationId: "intake-profile-save",
    });
    const team = await participant.mutation(api.teams.create, {
      eventSlug: fixture.eventSlug,
      name: "Plain Petals",
      clientOperationId: "intake-team-create",
    });
    const raviAuthUserId = await createAuthUser(
      backend,
      Date.now(),
      "Ravi Menon",
      "ravi@example.test",
    );
    const raviAuthSessionId = await createAuthSession(
      backend,
      raviAuthUserId,
      Date.now(),
      "ravi-intake-session-token",
    );
    const secondMembershipId = await backend.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (index) => index.eq("slug", fixture.eventSlug))
        .unique();
      const currentTeam = await ctx.db.get(team.teamId);
      if (!event || !currentTeam) throw new Error("The intake team fixture is incomplete.");
      const personId = await ctx.db.insert("people", {
        authUserId: raviAuthUserId,
        googleSubject: "ravi-intake-google-subject",
        verifiedEmail: "ravi@example.test",
        displayName: "Ravi Menon",
        status: "active",
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      });
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId: event._id,
        personId,
        emailNormalized: "ravi@example.test",
        displayName: "Ravi Menon",
        status: "active",
        linkedBy: "participant_provisioning",
        accessVersion: 1,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      });
      const membershipId = await ctx.db.insert("eventMemberships", {
        eventId: event._id,
        personId,
        eventAccessSubjectId: subjectId,
        participantClass: "external_participant",
        eligibilityStatus: "eligible",
        onboardingStatus: "project_required",
        acceptedParticipantPolicyVersionIds: [fixture.participantPolicyId],
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      });
      await ctx.db.insert("teamMembers", {
        eventId: event._id,
        teamId: currentTeam._id,
        membershipId,
        role: "member",
        status: "active",
        joinedAt: event.createdAt,
        source: "code",
      });
      for (const permissionKey of ["team.read", "team.project.write"] as const) {
        await insertPermissionGrant(ctx, {
          eventId: event._id,
          personId,
          eventAccessSubjectId: subjectId,
          permissionKey,
          scopeType: "team",
          scopeId: currentTeam._id,
          sourceType: "team_membership",
          sourceId: membershipId,
          reason: "Participant intake presence fixture",
        });
      }
      await ctx.db.patch(currentTeam._id, {
        activeMemberCount: 2,
        activeExternalMemberCount: 2,
        version: currentTeam.version + 1,
        updatedAt: event.createdAt,
      });
      return membershipId;
    });

    await participant.mutation(api.intakePresence.heartbeat, {
      eventSlug: fixture.eventSlug,
      surface: "idea",
      sessionId: "anika-idea-session",
    });
    expect(await participant.query(api.intakePresence.list, {
      eventSlug: fixture.eventSlug,
    })).toEqual([]);

    const secondParticipant = backend.withIdentity({
      subject: raviAuthUserId,
      sessionId: raviAuthSessionId,
    });
    const secondPresence = await secondParticipant.mutation(api.intakePresence.heartbeat, {
      eventSlug: fixture.eventSlug,
      surface: "idea",
      sessionId: "ravi-idea-session",
    });
    expect(await participant.query(api.intakePresence.list, {
      eventSlug: fixture.eventSlug,
    })).toEqual([
      { membershipId: secondMembershipId, surface: "idea" },
    ]);
    await secondParticipant.mutation(api.intakePresence.disconnect, {
      sessionToken: secondPresence.sessionToken,
    });
    expect(await participant.query(api.intakePresence.list, {
      eventSlug: fixture.eventSlug,
    })).toEqual([]);

    const idea = "A shared campus tool that routes accessibility requests to volunteers who can help.";
    const savedIdea = await participant.mutation(api.intake.saveInitialIdea, {
      eventSlug: fixture.eventSlug,
      idea,
      expectedDraftVersion: 0,
      clientOperationId: "intake-idea-save",
    });
    expect(savedIdea.draftVersion).toBe(1);

    await backend.mutation(internal.intelligence.beginIntakeInterpretation, {
      draftId: savedIdea.draftId,
      modelAvailable: false,
    });
    const withQuestion = await participant.query(api.intake.current, {
      eventSlug: fixture.eventSlug,
    });
    const activeQuestion = withQuestion?.draft?.followUps.find(
      (question) => question.state === "active",
    );
    if (!withQuestion?.draft || !activeQuestion) {
      throw new Error("The deterministic intake question did not become visible.");
    }
    expect(withQuestion.draft.stage).toBe("follow_up");

    await participant.mutation(api.intake.respondToFollowUp, {
      eventSlug: fixture.eventSlug,
      questionId: activeQuestion.id,
      answer: "Students with temporary or permanent access needs would use it first.",
      skipped: false,
      expectedDraftVersion: withQuestion.draft.version,
      clientOperationId: "intake-follow-up-answer",
    });
    await backend.mutation(internal.intelligence.beginIntakeInterpretation, {
      draftId: savedIdea.draftId,
      modelAvailable: false,
    });
    const withThirdQuestion = await participant.query(api.intake.current, {
      eventSlug: fixture.eventSlug,
    });
    const thirdQuestion = withThirdQuestion?.draft?.followUps.find(
      (question) => question.ordinal === 2 && question.state === "active",
    );
    if (!withThirdQuestion?.draft || !thirdQuestion) {
      throw new Error("The third total intake question did not become visible.");
    }
    const answeredThirdQuestion = await participant.mutation(api.intake.respondToFollowUp, {
      eventSlug: fixture.eventSlug,
      questionId: thirdQuestion.id,
      answer: "We want to finish a reliable request handoff and completion update.",
      skipped: false,
      expectedDraftVersion: withThirdQuestion.draft.version,
      clientOperationId: "intake-third-question-answer",
    });
    const freshness = await participant.mutation(api.intake.setFreshnessAttestation, {
      eventSlug: fixture.eventSlug,
      accepted: true,
      expectedDraftVersion: answeredThirdQuestion.draftVersion,
      clientOperationId: "intake-freshness-confirm",
    });

    const blockedPreview = await participant.query(api.intake.submissionPreview, {
      eventSlug: fixture.eventSlug,
    });
    expect(blockedPreview).toMatchObject({
      memberCount: 2,
      members: [
        { displayName: "Anika Shah", role: "lead", submissionReady: true },
        { displayName: "Ravi Menon", role: "member", submissionReady: false },
      ],
      blockers: [
        "Every team member must be eligible, accept the current policy, and finish their profile.",
      ],
    });
    await backend.run(async (ctx) => {
      const membership = await ctx.db.get(secondMembershipId);
      if (!membership) throw new Error("The second intake membership is missing.");
      await ctx.db.insert("participantProfiles", {
        eventId: membership.eventId,
        membershipId: membership._id,
        participantClass: "external_participant",
        fullName: "Ravi Menon",
        institution: "Example Institute of Technology",
        yearOfStudy: "first",
        externalCountry: "India",
        profileVersion: 1,
        updatedAt: Date.now(),
      });
    });

    const preview = await participant.query(api.intake.submissionPreview, {
      eventSlug: fixture.eventSlug,
    });
    if (!preview) throw new Error("The final submission preview is incomplete.");
    expect(preview).toMatchObject({
      teamId: team.teamId,
      teamVersion: 2,
      draftVersion: freshness.draftVersion,
      initialIdea: idea,
      freshnessAttested: true,
      memberCount: 2,
      members: [
        {
          displayName: "Anika Shah",
          role: "lead",
          submissionReady: true,
        },
        {
          displayName: "Ravi Menon",
          role: "member",
          submissionReady: true,
        },
      ],
      blockers: [],
    });
    expect(preview.followUps).toHaveLength(2);

    const submitRequest = {
      eventSlug: fixture.eventSlug,
      expectedDraftVersion: preview.draftVersion,
      expectedTeamVersion: preview.teamVersion,
      participantPolicyVersionId: preview.participantPolicyVersionId,
      clientOperationId: "intake-final-submit",
    } as const;
    const submitGrantId = await backend.run(async (ctx) => {
      const membership = await ctx.db.get(fixture.membershipId);
      if (!membership) throw new Error("The participant membership is missing.");
      const grant = await ctx.db
        .query("permissionGrants")
        .withIndex("by_subject_permission_status", (index) =>
          index
            .eq("eventAccessSubjectId", membership.eventAccessSubjectId)
            .eq("permissionKey", "application.submit")
            .eq("status", "active"),
        )
        .unique();
      if (!grant || grant.scopeType !== "team" || grant.scopeId !== team.teamId) {
        throw new Error("The exact application-submit grant is missing.");
      }
      await ctx.db.patch(grant._id, {
        status: "revoked",
        revokedAt: Date.now(),
        revokedByPersonId: membership.personId,
        revokeReason: "Application-submit permission test",
      });
      return grant._id;
    });
    await expect(
      participant.mutation(api.intake.submit, submitRequest),
    ).rejects.toThrow("permission");
    await expect(
      participant.query(api.teams.current, { eventSlug: fixture.eventSlug }),
    ).resolves.toMatchObject({
      canManageMembers: true,
      canSubmitApplication: false,
    });
    await backend.run(async (ctx) => {
      await ctx.db.patch(submitGrantId, {
        status: "active",
        revokedAt: undefined,
        revokedByPersonId: undefined,
        revokeReason: undefined,
      });
    });
    await expect(
      participant.query(api.teams.current, { eventSlug: fixture.eventSlug }),
    ).resolves.toMatchObject({ canSubmitApplication: true });
    const started = await participant.mutation(api.intake.submit, submitRequest);
    expect(started.state).toBe("validating");

    const lockedTeam = await backend.run((ctx) => ctx.db.get(team.teamId));
    expect(lockedTeam).toMatchObject({
      membershipLocked: true,
      version: 3,
      submissionAttemptId: started.submissionAttemptId,
    });
    await expect(participant.mutation(api.intake.saveInitialIdea, {
      eventSlug: fixture.eventSlug,
      idea: `${idea} Updated after confirmation.`,
      expectedDraftVersion: preview.draftVersion,
      clientOperationId: "intake-write-after-lock",
    })).rejects.toThrow("locked");

    await backend.mutation(internal.intake.materializeSubmissionRoster, {
      submissionAttemptId: started.submissionAttemptId,
    });
    await backend.mutation(internal.intake.finalizeSubmission, {
      submissionAttemptId: started.submissionAttemptId,
    });

    const replay = await participant.mutation(api.intake.submit, submitRequest);
    expect(replay.state).toBe("complete");
    expect(replay.applicationId).toBeDefined();
    expect(replay.projectVersionId).toBeDefined();

    const submitted = await participant.query(api.intake.submitted, {
      eventSlug: fixture.eventSlug,
    });
    expect(submitted).toMatchObject({
      currentRole: "lead",
      project: {
        initialIdea: idea,
      },
      application: { state: "submitted", contentVersion: 1 },
      canEdit: true,
    });
    if (!submitted) throw new Error("The submitted application did not persist.");
    await expect(participant.mutation(api.intakePresence.heartbeat, {
      eventSlug: fixture.eventSlug,
      surface: "idea",
      sessionId: "locked-idea-session",
    })).rejects.toThrow("locked");
    await expect(participant.mutation(api.intakePresence.heartbeat, {
      eventSlug: fixture.eventSlug,
      surface: "proposal_revision",
      sessionId: "proposal-session",
    })).resolves.toMatchObject({ sessionToken: expect.any(String) });
    const reviewFixture = await backend.run(async (ctx) => {
      const membership = await ctx.db.get(fixture.membershipId);
      if (!membership) throw new Error("The participant membership is missing.");
      const humanReviewId = await ctx.db.insert("admissionHumanReviews", {
        eventId: membership.eventId,
        applicationId: submitted.application.id,
        applicationContentVersion: submitted.application.contentVersion,
        reviewerPersonId: membership.personId,
        recommendation: "accept",
        reasonCode: "clear_problem",
        status: "active",
        createdAt: Date.now(),
      });
      const assignmentId = await ctx.db.insert("admissionReviewAssignments", {
        eventId: membership.eventId,
        applicationId: submitted.application.id,
        applicationContentVersion: submitted.application.contentVersion,
        reviewerPersonId: membership.personId,
        assignedByPersonId: membership.personId,
        state: "active",
        version: 1,
        assignedAt: Date.now(),
      });
      await ctx.db.patch(submitted.application.id, {
        state: "under_review",
        assignedReviewCount: 1,
        completedReviewCount: 1,
      });
      return { humanReviewId, assignmentId };
    });
    const revisedIdea = `${idea} It also shows volunteers which request needs help next.`;
    const revisionRequest = {
      eventSlug: fixture.eventSlug,
      applicationId: submitted.application.id,
      expectedApplicationVersion: submitted.application.version,
      expectedApplicationContentVersion: submitted.application.contentVersion,
      expectedProjectVersionId: submitted.project.id,
      expectedProjectVersion: submitted.project.version,
      initialIdea: revisedIdea,
      responses: submitted.project.intakeResponses.map((response) => ({
        questionId: response.questionId,
        answer: "Students with access needs would use the updated workflow first.",
        skipped: false,
      })),
      clientOperationId: "intake-proposal-revision",
    } as const;
    const revision = await participant.mutation(
      api.intake.reviseSubmission,
      revisionRequest,
    );
    expect(revision).toMatchObject({
      projectVersion: 2,
      applicationVersion: submitted.application.version + 1,
      applicationContentVersion: 2,
    });
    await expect(
      participant.mutation(api.intake.reviseSubmission, revisionRequest),
    ).resolves.toEqual(revision);
    await expect(
      participant.query(api.intake.submitted, { eventSlug: fixture.eventSlug }),
    ).resolves.toMatchObject({
      project: { id: revision.projectVersionId, initialIdea: revisedIdea, version: 2 },
      application: { contentVersion: 2 },
    });

    const stored = await backend.run(async (ctx) => {
      const finalTeam = await ctx.db.get(team.teamId);
      const project = finalTeam?.lockedProjectVersionId
        ? await ctx.db.get(finalTeam.lockedProjectVersionId)
        : null;
      const [attempt, application, humanReview, assignment] = await Promise.all([
        ctx.db.get(started.submissionAttemptId),
        ctx.db.get(submitted.application.id),
        ctx.db.get(reviewFixture.humanReviewId),
        ctx.db.get(reviewFixture.assignmentId),
      ]);
      const recommendation = application?.aiRecommendationId
        ? await ctx.db.get(application.aiRecommendationId)
        : null;
      return { finalTeam, project, attempt, application, humanReview, assignment, recommendation };
    });
    expect(stored.finalTeam).toMatchObject({
      status: "submitted",
      membershipLocked: true,
    });
    expect(stored.attempt?.state).toBe("complete");
    expect(stored.application).toMatchObject({
      state: "under_review",
      assignedReviewCount: 1,
      completedReviewCount: 0,
      contentVersion: 2,
    });
    expect(stored.humanReview?.status).toBe("superseded");
    expect(stored.assignment).toMatchObject({
      state: "active",
      applicationContentVersion: 2,
      version: 2,
    });
    expect(stored.recommendation).toMatchObject({
      projectVersionId: revision.projectVersionId,
      applicationContentVersion: 2,
    });
    expect(stored.project?.finalConfirmation).toEqual({
      participantPolicyVersionId: fixture.participantPolicyId,
      previewedDraftVersion: preview.draftVersion,
      previewedTeamVersion: preview.teamVersion,
      confirmedByMembershipId: fixture.membershipId,
      confirmedAt: stored.attempt?.createdAt,
    });
  }, 15_000);
});

async function seedFixture(backend: BackendTest) {
  const now = Date.UTC(2027, 9, 18, 9, 0, 0);
  const eventSlug = "participant-intake-lifecycle";
  const authUserId = await createAuthUser(backend, now);
  const authSessionId = await createAuthSession(backend, authUserId, now);
  return backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId,
      googleSubject: "participant-intake-google-subject",
      verifiedEmail: "anika@example.test",
      displayName: "Anika Shah",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Code2Create intake lifecycle fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
      createdByPersonId: personId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    const participantPolicy = normalizeParticipantPolicy(defaultParticipantPolicy);
    const participantPolicyId = await ctx.db.insert("participantPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...participantPolicy,
      checksum: participantPolicyChecksum(participantPolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    const intakePolicy = normalizeIntakePolicy({
      ...defaultDeterministicIntakePolicy,
      deterministicFollowUpCount: 2,
    });
    const intakePolicyId = await ctx.db.insert("intakePolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...intakePolicy,
      checksum: intakePolicyChecksum(intakePolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });

    const admissionConfiguration = normalizeAdmissionConfiguration({
      version: "admission-v1",
      minimumHumanReviews: 1,
      overallParticipantCapacity: 100,
      criteria: defaultAdmissionCriteria,
      decisionReasonCodes: defaultAdmissionReasonCodes,
      model: null,
    });
    const admissionPolicy = admissionPolicyForConfiguration(admissionConfiguration);
    const admissionPolicyId = await ctx.db.insert("admissionPolicyVersions", {
      eventId,
      ...admissionPolicy,
      status: "published",
      checksum: admissionPolicyChecksum(admissionPolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.insert("admissionCapacityBuckets", {
      eventId,
      admissionPolicyVersionId: admissionPolicyId,
      capacity: admissionConfiguration.overallParticipantCapacity,
      reserved: 0,
      version: 1,
      updatedAt: now,
    });
    await ctx.db.patch(eventId, {
      publishedParticipantPolicyId: participantPolicyId,
      publishedIntakePolicyId: intakePolicyId,
      publishedAdmissionPolicyId: admissionPolicyId,
    });

    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: "anika@example.test",
      displayName: "Anika Shah",
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
      onboardingStatus: "profile_required",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    for (const permissionKey of ["participant.profile.write", "team.join"] as const) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "self",
        scopeId: membershipId,
        sourceType: "participant_membership",
        sourceId: membershipId,
        reason: "Participant intake lifecycle fixture",
      });
    }
    return {
      eventSlug,
      authUserId,
      authSessionId,
      membershipId,
      participantPolicyId,
    };
  });
}

async function createAuthUser(
  backend: BackendTest,
  now: number,
  name = "Anika Shah",
  email = "anika@example.test",
) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name,
        email,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return documentId(result, "Better Auth user");
}

async function createAuthSession(
  backend: BackendTest,
  userId: string,
  now: number,
  token = "participant-intake-session-token",
) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: now + 60 * 60 * 1_000,
        token,
        createdAt: now,
        updatedAt: now,
        userId,
      },
    },
  });
  return documentId(result, "Better Auth session");
}

function documentId(value: unknown, label: string): string {
  if (typeof value !== "object" || value === null || !("_id" in value)) {
    throw new Error(`${label} did not return a document ID.`);
  }
  const id = value._id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} returned an invalid document ID.`);
  }
  return id;
}
