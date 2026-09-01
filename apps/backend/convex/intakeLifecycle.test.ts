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
      phone: "+91 90000 00000",
      gender: "female",
      yearOfStudy: "first",
      externalUniversity: "Example University",
      externalCollege: "Example Institute of Technology",
      expectedProfileVersion: 0,
      clientOperationId: "intake-profile-save",
    });
    await backend.run(async (ctx) => {
      const membership = await ctx.db.get(fixture.membershipId);
      if (!membership) throw new Error("The intake membership is missing.");
      await ctx.db.insert("githubStarCompletions", {
        eventId: membership.eventId,
        membershipId: fixture.membershipId,
        personId: membership.personId,
        githubUserId: "intake-github-user-1",
        githubLogin: "anika-intake",
        repositoryOwner: "sgl-project",
        repositoryName: "sglang",
        completedAt: Date.now(),
      });
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
      for (const permissionKey of [
        "team.read",
        "team.project.write",
        "team.lead.accept",
      ] as const) {
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
      {
        membershipId: secondMembershipId,
        surface: "idea",
        label: "the idea",
      },
    ]);
    await secondParticipant.mutation(api.intakePresence.disconnect, {
      sessionToken: secondPresence.sessionToken,
    });
    expect(await participant.query(api.intakePresence.list, {
      eventSlug: fixture.eventSlug,
    })).toEqual([]);

    const initialIdea = "A shared campus tool that routes accessibility requests to volunteers who can help.";
    const idea = `${initialIdea} It prioritizes requests by the help needed.`;
    await expect(participant.mutation(api.intake.autosaveWorkingField, {
      eventSlug: fixture.eventSlug,
      field: { kind: "idea" },
      value: initialIdea,
      baseDraftVersion: 0,
      baseCommittedValue: "",
      expectedRevision: 0,
    })).resolves.toMatchObject({ revision: 1 });
    await expect(participant.query(api.intake.current, {
      eventSlug: fixture.eventSlug,
    })).resolves.toMatchObject({
      workingFields: [{
        kind: "idea",
        value: initialIdea,
        baseDraftVersion: 0,
        revision: 1,
        writtenByMembershipId: fixture.membershipId,
      }],
    });
    const shortenedWorkingIdea = "A campus tool that routes accessibility requests to volunteers.";
    await expect(participant.mutation(api.intake.autosaveWorkingField, {
      eventSlug: fixture.eventSlug,
      field: { kind: "idea" },
      value: shortenedWorkingIdea,
      baseDraftVersion: 0,
      baseCommittedValue: "",
      expectedRevision: 1,
    })).resolves.toMatchObject({ revision: 2 });
    await expect(participant.query(api.intake.current, {
      eventSlug: fixture.eventSlug,
    })).resolves.toMatchObject({
      workingFields: [{
        kind: "idea",
        value: shortenedWorkingIdea,
        baseDraftVersion: 0,
        revision: 2,
        writtenByMembershipId: fixture.membershipId,
      }],
    });
    await expect(participant.mutation(api.intake.autosaveWorkingField, {
      eventSlug: fixture.eventSlug,
      field: { kind: "idea" },
      value: "",
      baseDraftVersion: 0,
      baseCommittedValue: "",
      expectedRevision: 2,
    })).resolves.toMatchObject({ revision: 3 });
    await expect(participant.query(api.intake.current, {
      eventSlug: fixture.eventSlug,
    })).resolves.toMatchObject({
      workingFields: [{
        kind: "idea",
        value: "",
        baseDraftVersion: 0,
        revision: 3,
        writtenByMembershipId: fixture.membershipId,
      }],
    });
    await expect(secondParticipant.mutation(api.intake.autosaveWorkingField, {
      eventSlug: fixture.eventSlug,
      field: { kind: "idea" },
      value: `${initialIdea} A conflicting rewrite.`,
      baseDraftVersion: 0,
      baseCommittedValue: "",
      expectedRevision: 0,
    })).rejects.toThrow("newer text");
    const savedIdea = await participant.mutation(api.intake.saveInitialIdea, {
      eventSlug: fixture.eventSlug,
      idea: initialIdea,
      expectedDraftVersion: 0,
      clientOperationId: "intake-idea-save",
    });
    expect(savedIdea.draftVersion).toBe(1);
    await expect(participant.query(api.intake.current, {
      eventSlug: fixture.eventSlug,
    })).resolves.toMatchObject({ workingFields: [] });

    await backend.mutation(internal.intelligence.beginIntakeInterpretation, {
      draftId: savedIdea.draftId,
      providerAvailable: false,
    });
    const firstQuestionState = await participant.query(api.intake.current, {
      eventSlug: fixture.eventSlug,
    });
    const firstQuestion = firstQuestionState?.draft?.followUps.find(
      (question) => question.state === "active",
    );
    if (!firstQuestionState?.draft || !firstQuestion) {
      throw new Error("The first idea did not produce its follow-up.");
    }
    await participant.mutation(api.intake.autosaveWorkingField, {
      eventSlug: fixture.eventSlug,
      field: { kind: "idea" },
      value: idea,
      baseDraftVersion: firstQuestionState.draft.version,
      baseCommittedValue: initialIdea,
      expectedRevision: 0,
    });
    await expect(participant.query(api.intake.current, {
      eventSlug: fixture.eventSlug,
    })).resolves.toMatchObject({
      draft: { followUps: [{ id: firstQuestion.id, state: "active" }] },
    });
    const revisedIdeaSave = await participant.mutation(api.intake.saveInitialIdea, {
      eventSlug: fixture.eventSlug,
      idea,
      expectedDraftVersion: firstQuestionState.draft.version,
      clientOperationId: "intake-idea-revise",
    });
    expect(revisedIdeaSave.draftVersion).toBe(firstQuestionState.draft.version + 1);
    await expect(participant.query(api.intake.current, {
      eventSlug: fixture.eventSlug,
    })).resolves.toMatchObject({
      draft: { followUps: [{ state: "active", source: "fixed" }] },
      workingFields: [],
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

    await expect(
      secondParticipant.mutation(api.intakePresence.heartbeat, {
        eventSlug: fixture.eventSlug,
        surface: "follow_up",
        sessionId: "ravi-missing-question-session",
      }),
    ).rejects.toThrow("requires its exact question");
    const secondFollowUpPresence = await secondParticipant.mutation(
      api.intakePresence.heartbeat,
      {
        eventSlug: fixture.eventSlug,
        surface: "follow_up",
        questionId: activeQuestion.id,
        sessionId: "ravi-follow-up-session",
      },
    );
    await expect(
      participant.query(api.intakePresence.list, { eventSlug: fixture.eventSlug }),
    ).resolves.toEqual([
      {
        membershipId: secondMembershipId,
        surface: "follow_up",
        questionId: activeQuestion.id,
        label: activeQuestion.question,
      },
    ]);
    await secondParticipant.mutation(api.intakePresence.disconnect, {
      sessionToken: secondFollowUpPresence.sessionToken,
    });

    await expect(
      participant.mutation(api.intake.respondToFollowUp, {
        eventSlug: fixture.eventSlug,
        questionId: activeQuestion.id,
        answer: "",
        expectedDraftVersion: withQuestion.draft.version,
        clientOperationId: "intake-follow-up-empty-answer",
      }),
    ).rejects.toThrow("Follow-up answer must be between");

    const firstFollowUpAnswer =
      "Students with temporary or permanent access needs would use it first.";
    await expect(participant.mutation(api.intake.autosaveWorkingField, {
      eventSlug: fixture.eventSlug,
      field: { kind: "follow_up", questionId: activeQuestion.id },
      value: firstFollowUpAnswer,
      baseDraftVersion: withQuestion.draft.version,
      baseCommittedValue: "",
      expectedRevision: 0,
    })).resolves.toMatchObject({ revision: 1 });
    await participant.mutation(api.intake.respondToFollowUp, {
      eventSlug: fixture.eventSlug,
      questionId: activeQuestion.id,
      answer: firstFollowUpAnswer,
      expectedDraftVersion: withQuestion.draft.version,
      clientOperationId: "intake-follow-up-answer",
    });
    await expect(participant.query(api.intake.current, {
      eventSlug: fixture.eventSlug,
    })).resolves.toMatchObject({ workingFields: [] });
    const withThirdQuestion = await participant.query(api.intake.current, {
      eventSlug: fixture.eventSlug,
    });
    const thirdQuestion = withThirdQuestion?.draft?.followUps.find(
      (question) => question.ordinal === 2 && question.state === "active",
    );
    if (!withThirdQuestion?.draft || !thirdQuestion) {
      throw new Error("The third total intake question did not become visible.");
    }
    await participant.mutation(api.intake.respondToFollowUp, {
      eventSlug: fixture.eventSlug,
      questionId: thirdQuestion.id,
      answer: "We want to finish a reliable request handoff and completion update.",
      expectedDraftVersion: withThirdQuestion.draft.version,
      clientOperationId: "intake-third-question-answer",
    });
    await backend.mutation(internal.intelligence.beginIntakeInterpretation, {
      draftId: savedIdea.draftId,
      providerAvailable: false,
    });
    const adaptiveFixture = await backend.run(async (ctx) => {
      const draft = await ctx.db.get(savedIdea.draftId);
      if (!draft) throw new Error("The intake draft is missing before adaptive-question setup.");
      const activeAnswers = await ctx.db
        .query("intakeAnswerVersions")
        .withIndex("by_draft_status", (index) =>
          index.eq("draftId", draft._id).eq("status", "active"),
        )
        .collect();
      const now = Date.now();
      const questionId = await ctx.db.insert("intakeGeneratedQuestions", {
        eventId: draft.eventId,
        teamId: draft.teamId,
        draftId: draft._id,
        ordinal: 3,
        text: "What would make this useful beyond the first request?",
        purposeKey: "experience",
        answerLength: "short",
        source: "model",
        sourceAnswerVersionIds: activeAnswers.map((answer) => answer._id),
        intakePolicyVersionId: draft.intakePolicyVersionId,
        state: "answered",
        validationCategory: "test_adaptive_question",
        answeredAt: now,
        createdAt: now,
      });
      const answerId = await ctx.db.insert("intakeAnswerVersions", {
        eventId: draft.eventId,
        teamId: draft.teamId,
        draftId: draft._id,
        promptKey: "introduction_follow_up_3",
        generatedQuestionId: questionId,
        answerVersion: 1,
        value: "It coordinates the handoff and confirms that somebody actually responded.",
        status: "active",
        writtenByMembershipId: fixture.membershipId,
        writtenAt: now,
        clientOperationId: "intake-adaptive-answer-fixture",
      });
      return { answerId, questionId };
    });
    const reviewBeforeAnswerEdit = await participant.query(api.intake.current, {
      eventSlug: fixture.eventSlug,
    });
    const firstAnsweredQuestion = reviewBeforeAnswerEdit?.draft?.followUps[0];
    if (!reviewBeforeAnswerEdit?.draft || !firstAnsweredQuestion) {
      throw new Error("The review did not retain its answered questions.");
    }
    const fixedResponsesBeforeIdeaEdit = reviewBeforeAnswerEdit.draft.followUps.filter(
      (question) => question.source === "fixed",
    );
    const questionIdsBeforeAnswerEdit = fixedResponsesBeforeIdeaEdit.map(
      (question) => question.id,
    );
    const answersBeforeIdeaEdit = fixedResponsesBeforeIdeaEdit.map(
      (question) => question.answer,
    );
    const ideaAfterFixedAnswers = `${idea} A small wording update clarifies the expected demand signal.`;
    const ideaRevision = await participant.mutation(api.intake.saveInitialIdea, {
      eventSlug: fixture.eventSlug,
      idea: ideaAfterFixedAnswers,
      expectedDraftVersion: reviewBeforeAnswerEdit.draft.version,
      clientOperationId: "intake-idea-revise-after-fixed-answers",
    });
    expect(ideaRevision.draftVersion).toBe(reviewBeforeAnswerEdit.draft.version + 1);
    const reviewAfterIdeaEdit = await participant.query(api.intake.current, {
      eventSlug: fixture.eventSlug,
    });
    if (!reviewAfterIdeaEdit?.draft) {
      throw new Error("The idea revision did not retain the fixed responses.");
    }
    expect(reviewAfterIdeaEdit.draft).toMatchObject({
      stage: "follow_up",
      initialIdea: ideaAfterFixedAnswers,
      followUps: questionIdsBeforeAnswerEdit.map((id, index) => ({
        id,
        source: "fixed",
        state: "answered",
        answer: answersBeforeIdeaEdit[index],
      })),
    });
    await expect(backend.run(async (ctx) => ({
      answer: await ctx.db.get(adaptiveFixture.answerId),
      question: await ctx.db.get(adaptiveFixture.questionId),
    }))).resolves.toMatchObject({
      answer: { status: "inactive_for_route" },
      question: { state: "replaced" },
    });
    await backend.mutation(internal.intelligence.beginIntakeInterpretation, {
      draftId: savedIdea.draftId,
      providerAvailable: false,
    });
    const reviewAfterIdeaRegeneration = await participant.query(api.intake.current, {
      eventSlug: fixture.eventSlug,
    });
    if (!reviewAfterIdeaRegeneration?.draft) {
      throw new Error("The revised idea did not complete question regeneration.");
    }
    expect(reviewAfterIdeaRegeneration.draft).toMatchObject({
      stage: "review",
      initialIdea: ideaAfterFixedAnswers,
      followUps: questionIdsBeforeAnswerEdit.map((id, index) => ({
        id,
        source: "fixed",
        state: "answered",
        answer: answersBeforeIdeaEdit[index],
      })),
    });
    await participant.mutation(api.intake.reviseFollowUp, {
      eventSlug: fixture.eventSlug,
      questionId: firstAnsweredQuestion.id,
      answer: `${firstFollowUpAnswer} The first release focuses on mobility requests.`,
      expectedDraftVersion: reviewAfterIdeaRegeneration.draft.version,
      clientOperationId: "intake-follow-up-revise",
    });
    await backend.mutation(internal.intelligence.beginIntakeInterpretation, {
      draftId: savedIdea.draftId,
      providerAvailable: false,
    });
    const reviewAfterAnswerEdit = await participant.query(api.intake.current, {
      eventSlug: fixture.eventSlug,
    });
    if (!reviewAfterAnswerEdit?.draft) {
      throw new Error("The revised intake did not return to review.");
    }
    await expect(participant.query(api.intake.current, {
      eventSlug: fixture.eventSlug,
    })).resolves.toMatchObject({
      draft: {
        stage: "review",
        followUps: questionIdsBeforeAnswerEdit.map((id) => ({ id })),
      },
    });
    const additionalInformation =
      "Our working notes and demo links are at https://example.com/accessibility-demo.";
    await expect(participant.mutation(api.intake.saveAdditionalInformation, {
      eventSlug: fixture.eventSlug,
      value: "x".repeat(4_001),
      baseValue: "",
      expectedDraftVersion: reviewAfterAnswerEdit.draft.version,
      clientOperationId: "intake-additional-information-too-long",
    })).rejects.toThrow("at most 4000 characters");
    const freshness = await participant.mutation(api.intake.setFreshnessAttestation, {
      eventSlug: fixture.eventSlug,
      accepted: true,
      expectedDraftVersion: reviewAfterAnswerEdit.draft.version,
      clientOperationId: "intake-freshness-confirm",
    });
    await expect(participant.mutation(api.intake.autosaveWorkingField, {
      eventSlug: fixture.eventSlug,
      field: { kind: "idea" },
      value: ideaAfterFixedAnswers,
      baseDraftVersion: reviewAfterAnswerEdit.draft.version,
      baseCommittedValue: ideaAfterFixedAnswers,
      expectedRevision: 0,
    })).resolves.toMatchObject({ revision: 1 });
    await participant.mutation(api.intake.saveInitialIdea, {
      eventSlug: fixture.eventSlug,
      idea: ideaAfterFixedAnswers,
      expectedDraftVersion: freshness.draftVersion,
      clientOperationId: "intake-idea-acknowledge-after-unrelated-edit",
    });
    await expect(participant.mutation(api.intake.autosaveWorkingField, {
      eventSlug: fixture.eventSlug,
      field: { kind: "idea" },
      value: `${ideaAfterFixedAnswers} A conflicting local edit.`,
      baseDraftVersion: reviewAfterAnswerEdit.draft.version,
      baseCommittedValue: idea,
      expectedRevision: 0,
    })).rejects.toThrow("changed in another session");
    const additionalInformationSave = await participant.mutation(
      api.intake.saveAdditionalInformation,
      {
        eventSlug: fixture.eventSlug,
        value: `  ${additionalInformation}  `,
        baseValue: "",
        expectedDraftVersion: reviewAfterAnswerEdit.draft.version,
        clientOperationId: "intake-additional-information-save",
      },
    );
    await expect(participant.mutation(api.intake.saveAdditionalInformation, {
      eventSlug: fixture.eventSlug,
      value: "A different stale edit must not replace the saved information.",
      baseValue: "",
      expectedDraftVersion: reviewAfterAnswerEdit.draft.version,
      clientOperationId: "intake-additional-information-conflict",
    })).rejects.toThrow("changed in another session");

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
        phone: "+91 90000 00001",
        gender: "male",
        institution: "Example Institute of Technology",
        yearOfStudy: "first",
        externalUniversity: "Example University",
        externalCollege: "Example Institute of Technology",
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
      draftVersion: additionalInformationSave.draftVersion,
      initialIdea: ideaAfterFixedAnswers,
      additionalInformation,
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
    await backend.run(async (ctx) => {
      const membership = await ctx.db.get(secondMembershipId);
      if (!membership) throw new Error("The second participant membership is missing.");
      await insertPermissionGrant(ctx, {
        eventId: membership.eventId,
        personId: membership.personId,
        eventAccessSubjectId: membership.eventAccessSubjectId,
        permissionKey: "application.submit",
        scopeType: "team",
        scopeId: team.teamId,
        sourceType: "manual",
        sourceId: membership._id,
        reason: "Prove that submission still requires current team leadership",
      });
    });
    await expect(
      secondParticipant.query(api.teams.current, { eventSlug: fixture.eventSlug }),
    ).resolves.toMatchObject({
      currentRole: "member",
      canSubmitApplication: false,
    });
    await expect(
      secondParticipant.mutation(api.intake.submit, {
        ...submitRequest,
        clientOperationId: "intake-member-cannot-submit",
      }),
    ).rejects.toThrow("Only the team lead can submit");
    const answeredQuestion = preview.followUps[0];
    if (!answeredQuestion) throw new Error("The submission preview has no follow-up question.");
    const editingPresence = await secondParticipant.mutation(
      api.intakePresence.heartbeat,
      {
        eventSlug: fixture.eventSlug,
        surface: "follow_up",
        questionId: answeredQuestion.id,
        sessionId: "ravi-editing-before-submit",
      },
    );
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
    await secondParticipant.mutation(api.intakePresence.disconnect, {
      sessionToken: editingPresence.sessionToken,
    });

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
    })).rejects.toThrow("submitted");

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
        initialIdea: ideaAfterFixedAnswers,
        additionalInformation,
      },
      application: { state: "submitted", contentVersion: 1 },
      canEdit: true,
    });
    if (!submitted) throw new Error("The submitted application did not persist.");
    await expect(participant.mutation(api.intakePresence.heartbeat, {
      eventSlug: fixture.eventSlug,
      surface: "idea",
      sessionId: "locked-idea-session",
    })).rejects.toThrow("submitted");
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
        version: submitted.application.version + 1,
      });
      return { humanReviewId, assignmentId };
    });
    const revisedIdea = `${ideaAfterFixedAnswers} It also shows volunteers which request needs help next.`;
    const revisedAdditionalInformation =
      "Updated demo: https://example.com/accessibility-demo-v2\nRepository: https://example.com/repo";
    const revisionRequest = {
      eventSlug: fixture.eventSlug,
      applicationId: submitted.application.id,
      expectedApplicationContentVersion: submitted.application.contentVersion,
      expectedProjectVersionId: submitted.project.id,
      expectedProjectVersion: submitted.project.version,
      initialIdea: revisedIdea,
      additionalInformation: revisedAdditionalInformation,
      responses: submitted.project.intakeResponses.map((response) => ({
        questionId: response.questionId,
        answer: "Students with access needs would use the updated workflow first.",
      })),
      clientOperationId: "intake-proposal-revision",
    } as const;
    const revision = await participant.mutation(
      api.intake.reviseSubmission,
      revisionRequest,
    );
    expect(revision).toMatchObject({
      projectVersion: 2,
      applicationVersion: submitted.application.version + 2,
      applicationContentVersion: 2,
    });
    await expect(
      participant.mutation(api.intake.reviseSubmission, revisionRequest),
    ).resolves.toEqual(revision);
    await expect(
      participant.query(api.intake.submitted, { eventSlug: fixture.eventSlug }),
    ).resolves.toMatchObject({
      project: {
        id: revision.projectVersionId,
        initialIdea: revisedIdea,
        additionalInformation: revisedAdditionalInformation,
        version: 2,
      },
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

    const thirdAuthUserId = await createAuthUser(
      backend,
      Date.now(),
      "Meera Kapoor",
      "meera@example.test",
    );
    const thirdAuthSessionId = await createAuthSession(
      backend,
      thirdAuthUserId,
      Date.now(),
      "meera-intake-session-token",
    );
    const thirdMembershipId = await backend.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (index) => index.eq("slug", fixture.eventSlug))
        .unique();
      if (!event) throw new Error("The intake event is missing.");
      const personId = await ctx.db.insert("people", {
        authUserId: thirdAuthUserId,
        googleSubject: "meera-intake-google-subject",
        verifiedEmail: "meera@example.test",
        displayName: "Meera Kapoor",
        status: "active",
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      });
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId: event._id,
        personId,
        emailNormalized: "meera@example.test",
        displayName: "Meera Kapoor",
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
      await ctx.db.insert("participantProfiles", {
        eventId: event._id,
        membershipId,
        participantClass: "external_participant",
        fullName: "Meera Kapoor",
        phone: "+91 90000 00002",
        gender: "female",
        institution: "Example Institute of Technology",
        yearOfStudy: "first",
        externalUniversity: "Example University",
        externalCollege: "Example Institute of Technology",
        profileVersion: 1,
        updatedAt: event.createdAt,
      });
      await ctx.db.insert("githubStarCompletions", {
        eventId: event._id,
        membershipId,
        personId,
        githubUserId: "intake-github-user-3",
        githubLogin: "meera-intake",
        repositoryOwner: "sgl-project",
        repositoryName: "sglang",
        completedAt: event.createdAt,
      });
      await insertPermissionGrant(ctx, {
        eventId: event._id,
        personId,
        eventAccessSubjectId: subjectId,
        permissionKey: "team.join",
        scopeType: "self",
        scopeId: membershipId,
        sourceType: "participant_membership",
        sourceId: membershipId,
        reason: "Submitted roster revision fixture",
      });
      return membershipId;
    });
    const thirdParticipant = backend.withIdentity({
      subject: thirdAuthUserId,
      sessionId: thirdAuthSessionId,
    });
    await thirdParticipant.mutation(api.teams.join, {
      eventSlug: fixture.eventSlug,
      code: team.publicCode,
      clientOperationId: "join-after-final-submission",
    });
    const afterJoin = await participant.query(api.intake.submitted, {
      eventSlug: fixture.eventSlug,
    });
    expect(afterJoin).toMatchObject({
      application: { contentVersion: 3 },
      project: { version: 3 },
    });
    const rosterAfterJoin = await participant.query(api.teams.members, {
      eventSlug: fixture.eventSlug,
      paginationOpts: { numItems: 5, cursor: null },
    });
    const thirdTeamMember = rosterAfterJoin.page.find(
      (member) => member.membershipId === thirdMembershipId,
    );
    const secondTeamMember = rosterAfterJoin.page.find(
      (member) => member.membershipId === secondMembershipId,
    );
    if (!thirdTeamMember) throw new Error("The joined submitted-team member is missing.");
    if (!secondTeamMember) throw new Error("The existing submitted-team member is missing.");
    const teamAfterJoin = await participant.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    if (!teamAfterJoin) throw new Error("The submitted team disappeared after a member joined.");
    await participant.mutation(api.teams.removeMember, {
      eventSlug: fixture.eventSlug,
      teamId: team.teamId,
      targetTeamMemberId: thirdTeamMember.teamMemberId,
      expectedTeamVersion: teamAfterJoin.version,
      clientOperationId: "remove-after-final-submission",
    });
    await expect(participant.query(api.intake.submitted, {
      eventSlug: fixture.eventSlug,
    })).resolves.toMatchObject({
      application: { contentVersion: 4 },
      project: { version: 4 },
    });

    const minimumSizeTeam = await participant.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    if (!minimumSizeTeam) throw new Error("The submitted team is missing at minimum size.");
    await expect(participant.mutation(api.teams.removeMember, {
      eventSlug: fixture.eventSlug,
      teamId: team.teamId,
      targetTeamMemberId: secondTeamMember.teamMemberId,
      expectedTeamVersion: minimumSizeTeam.version,
      clientOperationId: "reject-invalid-submitted-roster",
    })).rejects.toThrow("must keep 2 to 5 eligible members");
    await expect(participant.query(api.intake.submitted, {
      eventSlug: fixture.eventSlug,
    })).resolves.toMatchObject({
      application: { contentVersion: 4 },
      project: { version: 4 },
    });

    const teamBeforeTransfer = await participant.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    if (!teamBeforeTransfer) throw new Error("The submitted team is missing before transfer.");
    const transfer = await participant.mutation(api.teams.requestLeadershipTransfer, {
      eventSlug: fixture.eventSlug,
      toMembershipId: secondMembershipId,
      expectedTeamVersion: teamBeforeTransfer.version,
      clientOperationId: "transfer-after-final-submission",
    });
    await secondParticipant.mutation(api.teams.respondToLeadershipTransfer, {
      eventSlug: fixture.eventSlug,
      transferId: transfer.transferId,
      accept: true,
      clientOperationId: "accept-transfer-after-final-submission",
    });
    await expect(secondParticipant.query(api.intake.submitted, {
      eventSlug: fixture.eventSlug,
    })).resolves.toMatchObject({
      currentRole: "lead",
      application: { contentVersion: 5 },
      project: { version: 5 },
    });
    const currentSnapshot = await backend.run(async (ctx) => {
      const currentTeam = await ctx.db.get(team.teamId);
      const currentProject = currentTeam?.lockedProjectVersionId
        ? await ctx.db.get(currentTeam.lockedProjectVersionId)
        : null;
      return { currentTeam, currentProject };
    });
    expect(currentSnapshot.currentProject).toMatchObject({
      lockedMemberCount: 2,
      lockedLeadMembershipId: secondMembershipId,
      rosterRevision: {
        changedByMembershipId: secondMembershipId,
      },
    });

    await backend.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (index) => index.eq("slug", fixture.eventSlug))
        .unique();
      if (!event) throw new Error("The intake event is missing at deadline close.");
      await ctx.db.patch(event._id, {
        externalApplicationsCloseAt: Date.now() - 1,
        version: event.version + 1,
        updatedAt: Date.now(),
      });
    });
    const closedTeam = await secondParticipant.query(api.teams.current, {
      eventSlug: fixture.eventSlug,
    });
    if (!closedTeam) throw new Error("The submitted team is missing after the deadline.");
    await expect(secondParticipant.mutation(api.teams.requestLeadershipTransfer, {
      eventSlug: fixture.eventSlug,
      toMembershipId: fixture.membershipId,
      expectedTeamVersion: closedTeam.version,
      clientOperationId: "transfer-after-deadline",
    })).rejects.toThrow("Applications are closed");
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
      externalApplicationsCloseAt: Date.now() + 86_400_000,
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
