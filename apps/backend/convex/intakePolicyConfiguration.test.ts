import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

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
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

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
    expect(() => normalizeIntakePolicy({
      ...defaultDeterministicIntakePolicy,
      minimumFollowUpCount: 1,
    })).toThrow("must ask exactly two follow-up questions");
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
      providerAvailable: false,
    });
    const first = await currentQuestion(backend, fixture.projectDraftId, 1);
    expect(first.text).toBe(defaultDeterministicIntakePolicy.fallbackQuestions[0]?.text);
    await answerQuestion(backend, fixture, first._id, "Local student teams would use it first.");
    await backend.mutation(internal.intelligence.beginIntakeInterpretation, {
      draftId: fixture.projectDraftId,
      providerAvailable: false,
    });
    const second = await currentQuestion(backend, fixture.projectDraftId, 2);
    expect(second.text).toBe(defaultDeterministicIntakePolicy.fallbackQuestions[1]?.text);
    expect(second.source).toBe("fallback");
  });

  test("an assisted policy generates the third total question before review", async () => {
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
    const firstAnswerId = await answerQuestion(
      backend,
      fixture,
      first._id,
      "Student volunteers would use it first.",
    );
    const secondContext = await beginAssisted(backend, fixture.projectDraftId);
    await backend.mutation(internal.intelligence.finishIntakeInterpretation, {
      interpretationId: secondContext.interpretationId,
      inputFingerprint: secondContext.inputFingerprint,
      state: "succeeded",
      coveragePurposeKeys: ["user", "problem"],
      nextQuestionText: "What useful result should happen after a volunteer accepts the request?",
      nextQuestionPurposeKey: "problem",
      nextQuestionAnswerLength: "medium",
      nextQuestionSourceAnswerVersionIds: [firstAnswerId],
      stopReason: "needs_question",
      latencyMs: 18,
    });
    const second = await currentQuestion(backend, fixture.projectDraftId, 2);
    expect(second).toMatchObject({
      ordinal: 2,
      source: "model",
      validationCategory: "model_output_validated",
    });
    await answerQuestion(
      backend,
      fixture,
      second._id,
      "The request should reach a suitable volunteer and return a clear completion update.",
    );
    const result = await backend.run(async (ctx) => ({
      draft: await ctx.db.get(fixture.projectDraftId),
      questions: await ctx.db
        .query("intakeGeneratedQuestions")
        .withIndex("by_draft_ordinal", (index) => index.eq("draftId", fixture.projectDraftId))
        .collect(),
    }));
    expect(result.draft?.stage).toBe("review");
    expect(result.questions.map((question) => question.source)).toEqual(["model", "model"]);
  });

  test("the OpenAI action generates both assisted follow-ups through the provider contract", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "assisted");
    vi.stubEnv("OPENAI_API_KEY", "intake-provider-test-key");
    let sourceAnswerId = fixture.initialAnswerId;
    let requestCount = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.openai.com/v1/responses");
      expect(String(init?.body)).toContain('"strict":true');
      requestCount += 1;
      const firstRequest = requestCount === 1;
      return openAiResponse(JSON.stringify({
        coveragePurposeKeys: firstRequest ? ["user"] : ["user", "event_goal"],
        nextQuestion: {
          text: firstRequest
            ? "Who would use this project first?"
            : "What working result should your team finish during Code2Create?",
          purposeKey: firstRequest ? "user" : "event_goal",
          answerLength: firstRequest ? "short" : "medium",
          sourceAnswerVersionIds: [sourceAnswerId],
        },
        matchedIdeaPatternKey: null,
        stopReason: "needs_question",
      }));
    });

    await backend.action(internal.intelligence.interpretIdea, {
      draftId: fixture.projectDraftId,
    });
    const first = await currentQuestion(backend, fixture.projectDraftId, 1);
    sourceAnswerId = await answerQuestion(
      backend,
      fixture,
      first._id,
      "Student volunteers would use it first.",
    );
    await backend.action(internal.intelligence.interpretIdea, {
      draftId: fixture.projectDraftId,
    });
    const second = await currentQuestion(backend, fixture.projectDraftId, 2);

    expect(requestCount).toBe(2);
    expect([first, second].map((question) => ({
      ordinal: question.ordinal,
      source: question.source,
      validationCategory: question.validationCategory,
    }))).toEqual([
      { ordinal: 1, source: "model", validationCategory: "model_output_validated" },
      { ordinal: 2, source: "model", validationCategory: "model_output_validated" },
    ]);
  });

  test("a provider transport failure immediately publishes the deterministic fallback", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "assisted");
    vi.stubEnv("OPENAI_API_KEY", "intake-provider-test-key");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("The provider connection is unavailable.");
    });

    await backend.action(internal.intelligence.interpretIdea, {
      draftId: fixture.projectDraftId,
    });

    const question = await currentQuestion(backend, fixture.projectDraftId, 1);
    const interpretation = await backend.run((ctx) => ctx.db
      .query("intakeInterpretations")
      .withIndex("by_draft_created", (index) => index.eq("draftId", fixture.projectDraftId))
      .unique());
    expect(question).toMatchObject({
      source: "fallback",
      text: defaultDeterministicIntakePolicy.fallbackQuestions[0]?.text,
    });
    expect(interpretation).toMatchObject({
      state: "failed",
      failureCategory: "provider_request_failed",
    });
  });

  test("the settlement deadline publishes one fallback and rejects a late provider result", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "assisted");
    const context = await beginAssisted(backend, fixture.projectDraftId);

    await backend.mutation(internal.intelligence.expireIntakeInterpretation, {
      interpretationId: context.interpretationId,
      inputFingerprint: context.inputFingerprint,
    });
    await backend.mutation(internal.intelligence.finishIntakeInterpretation, {
      interpretationId: context.interpretationId,
      inputFingerprint: context.inputFingerprint,
      state: "succeeded",
      coveragePurposeKeys: ["user"],
      nextQuestionText: "Who would use this project first?",
      nextQuestionPurposeKey: "user",
      nextQuestionAnswerLength: "short",
      nextQuestionSourceAnswerVersionIds: [fixture.initialAnswerId],
      stopReason: "needs_question",
      latencyMs: 16_000,
    });

    const result = await backend.run(async (ctx) => ({
      interpretation: await ctx.db.get(context.interpretationId),
      questions: await ctx.db
        .query("intakeGeneratedQuestions")
        .withIndex("by_draft_ordinal", (index) => index.eq("draftId", fixture.projectDraftId))
        .collect(),
    }));
    expect(result.interpretation).toMatchObject({
      state: "timed_out",
      failureCategory: "settlement_deadline_exceeded",
    });
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toMatchObject({
      source: "fallback",
      validationCategory: "published_fallback",
    });
  });

  test("a premature assisted stop cannot omit the third total question", async () => {
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
    await answerQuestion(
      backend,
      fixture,
      first._id,
      "Student volunteers would use it first.",
    );
    const secondContext = await beginAssisted(backend, fixture.projectDraftId);
    await backend.mutation(internal.intelligence.finishIntakeInterpretation, {
      interpretationId: secondContext.interpretationId,
      inputFingerprint: secondContext.inputFingerprint,
      state: "succeeded",
      coveragePurposeKeys: ["user"],
      nextQuestionSourceAnswerVersionIds: [],
      stopReason: "enough_context",
      latencyMs: 18,
    });

    const second = await currentQuestion(backend, fixture.projectDraftId, 2);
    expect(second).toMatchObject({
      ordinal: 2,
      source: "fallback",
      text: defaultDeterministicIntakePolicy.fallbackQuestions[1]?.text,
    });
    const interpretation = await backend.run((ctx) =>
      ctx.db.get(secondContext.interpretationId),
    );
    expect(interpretation).toMatchObject({
      state: "invalid",
      failureCategory: "policy_validation_failed",
    });
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
      providerAvailable: false,
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

function openAiResponse(outputText: string) {
  return new Response(JSON.stringify({
    id: "resp_intake_test",
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 500,
    model: "intake-test-model",
    output: [{
      id: "msg_intake_test",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        text: outputText,
        annotations: [],
        logprobs: [],
      }],
    }],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: "json_schema" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 40,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 140,
    },
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-intake-test",
    },
  });
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
    },
  };
}

async function beginAssisted(backend: BackendTest, draftId: Id<"projectDrafts">) {
  const context = await backend.mutation(
    internal.intelligence.beginIntakeInterpretation,
    { draftId, providerAvailable: true },
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
      stage: question.ordinal < 2 ? "follow_up" : "review",
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
