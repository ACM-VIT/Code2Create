import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
  defaultDeterministicIntakePolicy,
  intakePolicyChecksum,
  normalizeIntakePolicy,
  publishIntakePolicy,
  requirePinnedIntakePolicy,
  saveIntakePolicyDraft,
  type IntakePolicy,
} from "./lib/intakePolicy.ts";
import { replaceCurrentIntakeQuestions } from "./lib/intakeQuestions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("intake policy configuration", () => {
  test("rejects unsafe or contradictory policy input", () => {
    expect(() => normalizeIntakePolicy({
      ...defaultDeterministicIntakePolicy,
      initialIdeaMaxLength: 200,
    })).toThrow("whole number from 500 through 8000");
    expect(() => normalizeIntakePolicy({
      ...defaultDeterministicIntakePolicy,
      blockedTerms: defaultDeterministicIntakePolicy.blockedTerms.filter(
        (term) => term !== "score",
      ),
    })).toThrow("Blocked wording must include");
    expect(() => normalizeIntakePolicy({
      ...defaultDeterministicIntakePolicy,
      fallbackQuestions: defaultDeterministicIntakePolicy.fallbackQuestions.map(
        (question) => ({ ...question, ordinal: 1 }),
      ),
    })).toThrow("ordinals must start at one");
  });

  test("publishes a new default without moving an active participant draft", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "deterministic");
    const draft = await backend.run((ctx) => saveIntakePolicyDraft(ctx, {
      event: fixture.event,
      actorPersonId: fixture.personId,
      policy: {
        ...defaultDeterministicIntakePolicy,
        initialHelpText: "A sentence or two is enough. Start with the problem and intended user.",
      },
      now: fixture.now + 1,
    }));
    await backend.run((ctx) => publishIntakePolicy(ctx, {
      event: fixture.event,
      draftPolicyId: draft.policyVersionId,
      expectedDraftChecksum: draft.checksum,
      now: fixture.now + 2,
    }));

    const result = await backend.run(async (ctx) => {
      const event = await ctx.db.get(fixture.event._id);
      const participantDraft = await ctx.db.get(fixture.projectDraftId);
      if (!participantDraft) throw new Error("The participant draft is missing.");
      const pin = await requirePinnedIntakePolicy(ctx, participantDraft);
      return {
        publishedPolicyId: event?.publishedIntakePolicyId,
        eventVersion: event?.version,
        participantPolicyId: pin.policy._id,
        participantHelpText: pin.normalized.initialHelpText,
      };
    });
    expect(result).toEqual({
      publishedPolicyId: draft.policyVersionId,
      eventVersion: 2,
      participantPolicyId: fixture.policyId,
      participantHelpText: defaultDeterministicIntakePolicy.initialHelpText,
    });
  });

  test("rejects a replaced policy draft", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "deterministic");
    const first = await backend.run((ctx) => saveIntakePolicyDraft(ctx, {
      event: fixture.event,
      actorPersonId: fixture.personId,
      policy: policyWithHelp("First reviewed participant help text for this event."),
      now: fixture.now + 1,
    }));
    const second = await backend.run((ctx) => saveIntakePolicyDraft(ctx, {
      event: fixture.event,
      actorPersonId: fixture.personId,
      policy: policyWithHelp("Second reviewed participant help text for this event."),
      expectedDraftPolicyId: first.policyVersionId,
      now: fixture.now + 2,
    }));

    await expect(backend.run((ctx) => publishIntakePolicy(ctx, {
      event: fixture.event,
      draftPolicyId: first.policyVersionId,
      expectedDraftChecksum: first.checksum,
      now: fixture.now + 3,
    }))).rejects.toThrow("changed in another session");
    const states = await backend.run(async (ctx) => ({
      first: (await ctx.db.get(first.policyVersionId))?.status,
      second: (await ctx.db.get(second.policyVersionId))?.status,
    }));
    expect(states).toEqual({ first: "retired", second: "draft" });
  });

  test("allows one concurrent draft creation from the same observed state", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "deterministic");
    const attempts = await Promise.allSettled([
      backend.run((ctx) => saveIntakePolicyDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        policy: policyWithHelp("Alpha participant guidance with a practical amount of detail."),
        now: fixture.now + 1,
      })),
      backend.run((ctx) => saveIntakePolicyDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        policy: policyWithHelp("Beta participant guidance with a practical amount of detail."),
        now: fixture.now + 1,
      })),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const drafts = await backend.run((ctx) => ctx.db
      .query("intakePolicyVersions")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", fixture.event._id).eq("status", "draft"),
      )
      .collect());
    expect(drafts).toHaveLength(1);
  });

  test("uses the two published fallback questions in sequence", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "deterministic");
    await backend.mutation(internal.intelligence.beginIntakeInterpretation, {
      draftId: fixture.projectDraftId,
      modelAvailable: false,
    });
    const first = await currentQuestion(backend, fixture.projectDraftId, 1);
    expect(first.text).toBe(defaultDeterministicIntakePolicy.fallbackQuestions[0]?.text);
    await answerQuestion(backend, fixture, first._id, "Local student teams would use it first.");
    await backend.mutation(internal.intelligence.beginIntakeInterpretation, {
      draftId: fixture.projectDraftId,
      modelAvailable: false,
    });
    const second = await currentQuestion(backend, fixture.projectDraftId, 2);
    expect(second.text).toBe(defaultDeterministicIntakePolicy.fallbackQuestions[1]?.text);
    expect(second.source).toBe("fallback");
  });

  test("an assisted policy can stop after one useful answer", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "assisted");
    const firstContext = await beginAssisted(backend, fixture.projectDraftId);
    await backend.mutation(internal.intelligence.finishIntakeInterpretation, {
      interpretationId: firstContext.interpretationId,
      inputFingerprint: firstContext.inputFingerprint,
      state: "succeeded",
      coveragePurposeKeys: ["user"],
      nextQuestionText: "Who would use this project first?",
      nextQuestionPurposeKey: "user",
      nextQuestionAnswerLength: "short",
      nextQuestionSourceAnswerVersionIds: [fixture.initialAnswerId],
      stopReason: "needs_question",
      latencyMs: 20,
    });
    const first = await currentQuestion(backend, fixture.projectDraftId, 1);
    await answerQuestion(backend, fixture, first._id, "Student volunteers would use it first.");
    const secondContext = await beginAssisted(backend, fixture.projectDraftId);
    await backend.mutation(internal.intelligence.finishIntakeInterpretation, {
      interpretationId: secondContext.interpretationId,
      inputFingerprint: secondContext.inputFingerprint,
      state: "succeeded",
      coveragePurposeKeys: ["user", "problem"],
      nextQuestionSourceAnswerVersionIds: [],
      stopReason: "enough_context",
      latencyMs: 18,
    });
    const result = await backend.run(async (ctx) => ({
      draft: await ctx.db.get(fixture.projectDraftId),
      questions: await ctx.db
        .query("intakeGeneratedQuestions")
        .withIndex("by_draft_ordinal", (index) => index.eq("draftId", fixture.projectDraftId))
        .collect(),
    }));
    expect(result.draft?.stage).toBe("review");
    expect(result.questions.filter((question) => question.ordinal === 2)).toHaveLength(0);
  });

  test("a failed assisted run settles once and cannot replace its fallback later", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "assisted");
    const context = await beginAssisted(backend, fixture.projectDraftId);
    await backend.mutation(internal.intelligence.finishIntakeInterpretation, {
      interpretationId: context.interpretationId,
      inputFingerprint: context.inputFingerprint,
      state: "failed",
      coveragePurposeKeys: [],
      nextQuestionSourceAnswerVersionIds: [],
      latencyMs: 25,
      failureCategory: "provider_request_failed",
    });
    await backend.mutation(internal.intelligence.finishIntakeInterpretation, {
      interpretationId: context.interpretationId,
      inputFingerprint: context.inputFingerprint,
      state: "succeeded",
      coveragePurposeKeys: ["problem"],
      nextQuestionText: "What different outcome should this project make possible?",
      nextQuestionPurposeKey: "problem",
      nextQuestionAnswerLength: "medium",
      nextQuestionSourceAnswerVersionIds: [fixture.initialAnswerId],
      stopReason: "needs_question",
      latencyMs: 40,
    });
    const questions = await backend.run((ctx) => ctx.db
      .query("intakeGeneratedQuestions")
      .withIndex("by_draft_ordinal", (index) => index.eq("draftId", fixture.projectDraftId))
      .collect());
    expect(questions).toHaveLength(1);
    expect(questions[0]?.source).toBe("fallback");
    expect(questions[0]?.text).toBe(defaultDeterministicIntakePolicy.fallbackQuestions[0]?.text);
  });

  test("replacing an idea removes routed questions and answers together", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "deterministic");
    await backend.mutation(internal.intelligence.beginIntakeInterpretation, {
      draftId: fixture.projectDraftId,
      modelAvailable: false,
    });
    const question = await currentQuestion(backend, fixture.projectDraftId, 1);
    const answerId = await answerQuestion(
      backend,
      fixture,
      question._id,
      "Campus volunteers would use this first.",
    );
    await backend.run((ctx) => replaceCurrentIntakeQuestions(ctx, fixture.projectDraftId));
    const result = await backend.run(async (ctx) => ({
      question: await ctx.db.get(question._id),
      answer: await ctx.db.get(answerId),
    }));
    expect(result.question?.state).toBe("replaced");
    expect(result.answer?.status).toBe("inactive_for_route");
  });
});

function policyWithHelp(initialHelpText: string): IntakePolicy {
  return { ...defaultDeterministicIntakePolicy, initialHelpText };
}

function assistedPolicy(): IntakePolicy {
  return {
    ...defaultDeterministicIntakePolicy,
    model: {
      mode: "assisted",
      modelId: "intake-test-model",
      systemInstruction:
        "Ask one supportive plain-language question grounded only in supplied project answers. Never judge, rank, reject, discourage, or request personal information.",
      instructionVersion: "test-v1",
      schemaVersion: "test-v1",
      redactionVersion: "test-v1",
      questionPolicyVersion: "test-v1",
      evaluationSuiteVersion: "test-v1",
      maxOutputTokens: 500,
      timeoutMs: 8_000,
    },
  };
}

async function beginAssisted(backend: BackendTest, draftId: Id<"projectDrafts">) {
  const context = await backend.mutation(
    internal.intelligence.beginIntakeInterpretation,
    { draftId, modelAvailable: true },
  );
  if (!context) throw new Error("The assisted interpretation did not begin.");
  return context;
}

async function currentQuestion(
  backend: BackendTest,
  draftId: Id<"projectDrafts">,
  ordinal: number,
) {
  const question = await backend.run((ctx) => ctx.db
    .query("intakeGeneratedQuestions")
    .withIndex("by_draft_ordinal", (index) =>
      index.eq("draftId", draftId).eq("ordinal", ordinal),
    )
    .filter((filter) => filter.neq(filter.field("state"), "replaced"))
    .unique());
  if (!question) throw new Error(`Question ${ordinal} did not persist.`);
  return question;
}

async function answerQuestion(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  questionId: Id<"intakeGeneratedQuestions">,
  value: string,
) {
  return backend.run(async (ctx) => {
    const question = await ctx.db.get(questionId);
    const draft = await ctx.db.get(fixture.projectDraftId);
    if (!question || !draft) throw new Error("The intake response fixture is missing.");
    const answerId = await ctx.db.insert("intakeAnswerVersions", {
      eventId: fixture.event._id,
      teamId: fixture.teamId,
      draftId: fixture.projectDraftId,
      promptKey: `introduction_follow_up_${question.ordinal}`,
      generatedQuestionId: question._id,
      answerVersion: 1,
      value,
      status: "active",
      writtenByMembershipId: fixture.membershipId,
      writtenAt: fixture.now + question.ordinal,
      clientOperationId: `answer-${question.ordinal}`,
    });
    await ctx.db.patch(question._id, {
      state: "answered",
      answeredAt: fixture.now + question.ordinal,
    });
    await ctx.db.patch(draft._id, {
      stage: "follow_up",
      version: draft.version + 1,
      updatedAt: fixture.now + question.ordinal,
    });
    return answerId;
  });
}

async function seedFixture(
  backend: BackendTest,
  mode: "deterministic" | "assisted",
) {
  const now = Date.UTC(2027, 9, 14, 9, 0, 0);
  return backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId: `intake-policy-${mode}-${now}`,
      googleSubject: `intake-policy-subject-${mode}-${now}`,
      verifiedEmail: `intake-policy-${mode}-${now}@example.test`,
      displayName: "Asha Rao",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: `intake-policy-${mode}-${now}`,
      name: "Code2Create intake policy fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
      createdByPersonId: personId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const normalizedPolicy = normalizeIntakePolicy(
      mode === "assisted" ? assistedPolicy() : defaultDeterministicIntakePolicy,
    );
    const policyId = await ctx.db.insert("intakePolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...normalizedPolicy,
      checksum: intakePolicyChecksum(normalizedPolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, {
      publishedIntakePolicyId: policyId,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `intake-policy-${mode}-${now}@example.test`,
      displayName: "Asha Rao",
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
      onboardingStatus: "project_required",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Policy Petals",
      publicCode: `POLICY${mode === "assisted" ? "A" : "D"}`,
      leadMembershipId: membershipId,
      status: "forming",
      activeMemberCount: 0,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 0,
      membershipLocked: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const projectDraftId = await ctx.db.insert("projectDrafts", {
      eventId,
      teamId,
      intakePolicyVersionId: policyId,
      stage: "follow_up",
      initialIdea: "A shared campus workflow that helps volunteers route practical requests.",
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
      value: "A shared campus workflow that helps volunteers route practical requests.",
      status: "active",
      writtenByMembershipId: membershipId,
      writtenAt: now,
      clientOperationId: "intake-policy-initial",
    });
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("The intake-policy event did not persist.");
    return {
      event,
      personId,
      policyId,
      teamId,
      membershipId,
      projectDraftId,
      initialAnswerId,
      now,
    };
  });
}
