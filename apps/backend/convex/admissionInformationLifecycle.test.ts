import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api.js";
import {
  normalizeInformationAnswers,
  normalizeInformationQuestions,
  replaceAdmissionInformationRequest,
  respondToAdmissionInformationRequest,
} from "./admissions.ts";
import { admissionInformationSources } from "./admissionIntelligence.ts";
import {
  admissionPolicyChecksum,
  admissionPolicyForConfiguration,
  defaultAdmissionCriteria,
  defaultAdmissionReasonCodes,
  normalizeAdmissionConfiguration,
} from "./lib/admissionPolicy.ts";
import {
  defaultDeterministicIntakePolicy,
  intakePolicyChecksum,
} from "./lib/intakePolicy.ts";
import {
  defaultParticipantPolicy,
  participantPolicyChecksum,
} from "./lib/participantPolicy.ts";
import { permissionCatalog } from "./lib/permissionCatalog.ts";
import { createTestSubmissionSnapshot } from "./lib/testSubmissionSnapshot.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("admission information request lifecycle", () => {
  test("uses one exact-team lead response permission and bounded questions", () => {
    expect(permissionCatalog["application.information.respond"]).toEqual({
      scopes: ["team"],
      eventWide: false,
    });
    expect(() => normalizeInformationQuestions("needs_information", [])).toThrow(
      "one or two short questions",
    );
    expect(() =>
      normalizeInformationQuestions("accept", ["What should the team clarify?"]),
    ).toThrow("apply only to Needs information");
    expect(() =>
      normalizeInformationQuestions("needs_information", [
        "What should the team clarify?",
        "What should the team clarify?",
      ]),
    ).toThrow("two different questions");
  });

  test("replaces one open request without rewriting its history", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "replace");
    const replacement = await backend.run((ctx) =>
      replaceAdmissionInformationRequest(ctx, {
        event: fixture.event,
        application: fixture.application,
        project: fixture.project,
        decision: "needs_information",
        decisionReasonCode: "clarification_needed",
        informationQuestions: ["What happens immediately after a report is submitted?"],
        requestedByPersonId: fixture.person._id,
        now: fixture.now + 1,
      }),
    );
    const state = await backend.run(async (ctx) => ({
      oldRequest: await ctx.db.get(fixture.request._id),
      newRequest: replacement.informationRequestId
        ? await ctx.db.get(replacement.informationRequestId)
        : null,
    }));
    expect(state.oldRequest).toMatchObject({ state: "superseded", version: 2 });
    expect(state.newRequest).toMatchObject({
      state: "open",
      applicationContentVersion: 1,
      questions: [{
        questionKey: "question_1",
        question: "What happens immediately after a report is submitted?",
      }],
      version: 1,
    });
  });

  test("turns the lead response into a new application version and fresh analysis", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "respond");
    const result = await backend.run((ctx) =>
      respondToAdmissionInformationRequest(ctx, {
        event: fixture.event,
        application: fixture.application,
        expectedApplicationVersion: 2,
        request: fixture.request,
        expectedRequestVersion: 1,
        membership: fixture.membership,
        answers: [
          { questionKey: "question_1", answer: "The report is routed to the nearest hall coordinator." },
          { questionKey: "question_2", answer: "We will build reporting, triage, and status updates." },
        ],
        now: fixture.now + 2,
      }),
    );
    const state = await backend.run(async (ctx) => {
      const application = await ctx.db.get(fixture.application._id);
      return {
        application,
        request: await ctx.db.get(fixture.request._id),
        responseProject: await ctx.db.get(result.responseProjectVersionId),
        team: await ctx.db.get(fixture.team._id),
        priorRecommendation: await ctx.db.get(fixture.priorRecommendation._id),
        nextRecommendation: application?.aiRecommendationId
          ? await ctx.db.get(application.aiRecommendationId)
          : null,
        review: await ctx.db.get(fixture.review._id),
        assignment: await ctx.db.get(fixture.assignment._id),
      };
    });
    expect(state.application).toMatchObject({
      state: "under_review",
      submittedProjectVersionId: result.responseProjectVersionId,
      assignedReviewCount: 1,
      completedReviewCount: 0,
      contentVersion: 2,
      version: 3,
      aiDisposition: "unavailable",
    });
    expect(state.application?.humanDecision).toBeUndefined();
    expect(state.request).toMatchObject({
      state: "answered",
      responseProjectVersionId: result.responseProjectVersionId,
      version: 2,
    });
    expect(state.responseProject?.admissionInformationResponses).toMatchObject([{
      requestId: fixture.request._id,
      sourceProjectVersionId: fixture.project._id,
      answers: [
        {
          questionKey: "question_1",
          question: "What happens after a report?",
          answer: "The report is routed to the nearest hall coordinator.",
        },
        {
          questionKey: "question_2",
          question: "What will you finish during the event?",
          answer: "We will build reporting, triage, and status updates.",
        },
      ],
    }]);
    expect(
      admissionInformationSources(state.responseProject?.admissionInformationResponses),
    ).toEqual([
      {
        sourceRef: "requested_information_1_1",
        question: "What happens after a report?",
        answer: "The report is routed to the nearest hall coordinator.",
      },
      {
        sourceRef: "requested_information_1_2",
        question: "What will you finish during the event?",
        answer: "We will build reporting, triage, and status updates.",
      },
    ]);
    expect(state.team?.lockedProjectVersionId).toBe(result.responseProjectVersionId);
    expect(state.priorRecommendation).toMatchObject({
      state: "stale",
      failureCategory: "information_response_submitted",
    });
    expect(state.nextRecommendation).toMatchObject({
      state: "disabled",
      applicationContentVersion: 2,
      projectVersionId: result.responseProjectVersionId,
    });
    expect(state.review?.status).toBe("superseded");
    expect(state.assignment).toMatchObject({
      state: "active",
      applicationContentVersion: 2,
      version: 2,
    });

    await backend.mutation(internal.admissionIntelligence.finishRecommendation, {
      recommendationId: fixture.priorRecommendation._id,
      sourceInputFingerprint: fixture.priorRecommendation.sourceInputFingerprint,
      state: "failed",
      criterionAssessments: [],
      strengths: [],
      concerns: [],
      proposedQuestions: [],
      limitations: ["Old analysis finished late."],
      failureCategory: "late_old_job",
    });
    const afterLateCompletion = await backend.run((ctx) => ctx.db.get(fixture.application._id));
    expect(afterLateCompletion?.aiRecommendationId).toBe(state.nextRecommendation?._id);
    expect(afterLateCompletion?.aiDisposition).toBe("unavailable");
  });

  test("requires the complete ordered answer set and the locked lead", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "validation");
    expect(() => normalizeInformationAnswers(fixture.request, [
      { questionKey: "question_2", answer: "This answer is out of order." },
      { questionKey: "question_1", answer: "This answer is also out of order." },
    ])).toThrow("questions changed");
    const ordinaryMember = { ...fixture.membership };
    await backend.run((ctx) => ctx.db.patch(fixture.team._id, {
      leadMembershipId: fixture.otherMembership._id,
    }));
    await expect(backend.run((ctx) =>
      respondToAdmissionInformationRequest(ctx, {
        event: fixture.event,
        application: fixture.application,
        expectedApplicationVersion: 2,
        request: fixture.request,
        expectedRequestVersion: 1,
        membership: ordinaryMember,
        answers: validAnswers(),
        now: fixture.now + 2,
      }),
    )).rejects.toThrow("locked team lead");
  });

  test("accepts one of two simultaneous responses", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "race");
    const attempts = await Promise.allSettled([
      backend.run((ctx) => respondToAdmissionInformationRequest(ctx, {
        event: fixture.event,
        application: fixture.application,
        expectedApplicationVersion: 2,
        request: fixture.request,
        expectedRequestVersion: 1,
        membership: fixture.membership,
        answers: validAnswers(),
        now: fixture.now + 2,
      })),
      backend.run((ctx) => respondToAdmissionInformationRequest(ctx, {
        event: fixture.event,
        application: fixture.application,
        expectedApplicationVersion: 2,
        request: fixture.request,
        expectedRequestVersion: 1,
        membership: fixture.membership,
        answers: validAnswers(),
        now: fixture.now + 3,
      })),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const versions = await backend.run((ctx) => ctx.db.query("projectVersions").collect());
    expect(versions).toHaveLength(2);
  });
});

function validAnswers() {
  return [
    { questionKey: "question_1", answer: "The report reaches the nearest hall coordinator." },
    { questionKey: "question_2", answer: "We will finish the report, triage, and status loop." },
  ];
}

async function seedFixture(backend: BackendTest, slug: string) {
  const now = Date.UTC(2027, 6, 1, 9, 0);
  return backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId: `information-${slug}`,
      googleSubject: `information-${slug}`,
      verifiedEmail: `${slug}@example.test`,
      displayName: "Locked team lead",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const otherPersonId = await ctx.db.insert("people", {
      authUserId: `information-other-${slug}`,
      googleSubject: `information-other-${slug}`,
      verifiedEmail: `other-${slug}@example.test`,
      displayName: "Other team member",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: `information-${slug}`,
      name: "Code2Create information fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
      createdByPersonId: personId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `${slug}@example.test`,
      displayName: "Locked team lead",
      status: "active",
      linkedBy: "participant_provisioning",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const otherSubjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId: otherPersonId,
      emailNormalized: `other-${slug}@example.test`,
      displayName: "Other team member",
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
    const otherMembershipId = await ctx.db.insert("eventMemberships", {
      eventId,
      personId: otherPersonId,
      eventAccessSubjectId: otherSubjectId,
      participantClass: "external_participant",
      eligibilityStatus: "eligible",
      onboardingStatus: "submitted",
      acceptedParticipantPolicyVersionIds: [],
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
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Information fixture team",
      publicCode: slug.slice(0, 8).toUpperCase(),
      leadMembershipId: membershipId,
      status: "submitted",
      activeMemberCount: 2,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 2,
      membershipLocked: true,
      lockedAt: now,
      lockParticipantPolicyVersionId: participantPolicyId,
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
    await ctx.db.insert("teamMembers", {
      eventId,
      teamId,
      membershipId: otherMembershipId,
      role: "member",
      status: "active",
      joinedAt: now,
      source: "code",
    });
    const draftId = await ctx.db.insert("projectDrafts", {
      eventId,
      teamId,
      intakePolicyVersionId: intakePolicyId,
      stage: "submitted",
      initialIdea: "A hall issue reporting and response loop.",
      version: 2,
      lastEditedByMembershipId: membershipId,
      updatedAt: now,
    });
    const initialAnswerId = await ctx.db.insert("intakeAnswerVersions", {
      eventId,
      teamId,
      draftId,
      promptKey: "initial_idea",
      answerVersion: 1,
      value: "A hall issue reporting and response loop.",
      status: "active",
      writtenByMembershipId: membershipId,
      writtenAt: now,
      clientOperationId: `initial-${slug}`,
    });
    const questionId = await ctx.db.insert("intakeGeneratedQuestions", {
      eventId,
      teamId,
      draftId,
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
      initialIdea: "A hall issue reporting and response loop.",
      intakePolicyVersionId: intakePolicyId,
      intakeResponses: [{
        questionId,
        ordinal: 1,
        question: "Who uses it first?",
        purposeKey: "user",
        answerLength: "short",
        source: "fallback",
        answer: "People attending the event.",
      }],
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
      sourceDraftVersion: 2,
      submittedByMembershipId: membershipId,
      submittedAt: now,
    });
    await ctx.db.patch(teamId, { lockedProjectVersionId: projectId });
    const applicationId = await ctx.db.insert("applications", {
      eventId,
      teamId,
      submittedProjectVersionId: projectId,
      admissionPolicyVersionId: admissionPolicyId,
      state: "needs_information",
      decisionStage: "unrecorded",
      experienceBand: "mixed_or_external",
      humanDecision: "needs_information",
      humanReasonCode: "clarification_needed",
      aiDisposition: "unavailable",
      decidedByPersonId: personId,
      decidedAt: now,
      assignedReviewCount: 1,
      completedReviewCount: 1,
      contentVersion: 1,
      version: 2,
      submittedAt: now,
    });
    const requestId = await ctx.db.insert("admissionInformationRequests", {
      eventId,
      applicationId,
      teamId,
      sourceProjectVersionId: projectId,
      applicationContentVersion: 1,
      decisionReasonCode: "clarification_needed",
      questions: [
        { questionKey: "question_1", question: "What happens after a report?" },
        { questionKey: "question_2", question: "What will you finish during the event?" },
      ],
      state: "open",
      requestedByPersonId: personId,
      requestedAt: now,
      version: 1,
    });
    const priorRecommendationId = await ctx.db.insert("admissionAIRecommendations", {
      eventId,
      applicationId,
      teamId,
      projectVersionId: projectId,
      admissionPolicyVersionId: admissionPolicyId,
      applicationContentVersion: 1,
      sourceInputFingerprint: `information-fingerprint-${slug}`,
      experienceBand: "mixed_or_external",
      state: "running",
      criterionAssessments: [],
      strengths: [],
      concerns: [],
      proposedQuestions: [],
      limitations: [],
      createdAt: now,
    });
    await ctx.db.patch(applicationId, {
      currentInformationRequestId: requestId,
      aiRecommendationId: priorRecommendationId,
    });
    const reviewId = await ctx.db.insert("admissionHumanReviews", {
      eventId,
      applicationId,
      applicationContentVersion: 1,
      reviewerPersonId: otherPersonId,
      recommendation: "needs_information",
      reasonCode: "clarification_needed",
      status: "active",
      createdAt: now,
    });
    const assignmentId = await ctx.db.insert("admissionReviewAssignments", {
      eventId,
      applicationId,
      applicationContentVersion: 1,
      reviewerPersonId: otherPersonId,
      assignedByPersonId: personId,
      state: "active",
      version: 1,
      assignedAt: now,
    });
    await ctx.db.patch(eventId, {
      publishedParticipantPolicyId: participantPolicyId,
      publishedAdmissionPolicyId: admissionPolicyId,
    });
    const [event, person, membership, otherMembership, team, project, application, request, priorRecommendation, review, assignment] = await Promise.all([
      ctx.db.get(eventId),
      ctx.db.get(personId),
      ctx.db.get(membershipId),
      ctx.db.get(otherMembershipId),
      ctx.db.get(teamId),
      ctx.db.get(projectId),
      ctx.db.get(applicationId),
      ctx.db.get(requestId),
      ctx.db.get(priorRecommendationId),
      ctx.db.get(reviewId),
      ctx.db.get(assignmentId),
    ]);
    if (!event || !person || !membership || !otherMembership || !team || !project || !application || !request || !priorRecommendation || !review || !assignment) {
      throw new Error("The admission information fixture is incomplete.");
    }
    return { now, event, person, membership, otherMembership, team, project, application, request, priorRecommendation, review, assignment };
  });
}
