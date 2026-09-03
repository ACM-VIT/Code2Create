import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
  defaultDeterministicIntakePolicy,
  fixedQuestionForOrdinal,
  intakePolicyChecksum,
  normalizeIntakePolicy,
  publishIntakePolicy,
  requirePinnedIntakePolicy,
  saveIntakePolicyDraft,
  type IntakePolicy,
} from "./lib/intakePolicy.ts";
import { ideaQuestionEndToEndDeadlineMs } from "./lib/ideaSubmissionAi.ts";
import { replaceCurrentIntakeQuestions } from "./lib/intakeQuestions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

function createBackend() {
  return convexTest(schema, modules);
}

describe("intake policy configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test("rejects unsafe or contradictory policy input", () => {
    expect(() =>
      normalizeIntakePolicy({
        ...defaultDeterministicIntakePolicy,
        initialIdeaMaxLength: 200,
      }),
    ).toThrow("whole number from 500 through 8000");
    expect(() =>
      normalizeIntakePolicy({
        ...defaultDeterministicIntakePolicy,
        blockedTerms: defaultDeterministicIntakePolicy.blockedTerms.filter(
          (term) => term !== "score",
        ),
      }),
    ).toThrow("Blocked wording must include");
    expect(() =>
      normalizeIntakePolicy({
        ...defaultDeterministicIntakePolicy,
        fallbackQuestions: defaultDeterministicIntakePolicy.fallbackQuestions.map((question) => ({
          ...question,
          ordinal: 1,
        })),
      }),
    ).toThrow("one fixed question for ordinals one and two");
    expect(() =>
      normalizeIntakePolicy({
        ...defaultDeterministicIntakePolicy,
        minimumFollowUpCount: 1,
      }),
    ).toThrow("two fixed questions and two generated questions");
    expect(() =>
      normalizeIntakePolicy({
        ...defaultDeterministicIntakePolicy,
        maximumFollowUpCount: 2,
        fallbackQuestions: defaultDeterministicIntakePolicy.fallbackQuestions.slice(0, 2),
      }),
    ).toThrow("two fixed questions and two generated questions");
  });

  test("selects stable fallback variants for each team", () => {
    const policy = defaultDeterministicIntakePolicy;
    const selected = Array.from(
      { length: 32 },
      (_, index) => fixedQuestionForOrdinal(policy, 3, `team-${index}`).text,
    );

    expect(new Set(selected).size).toBeGreaterThan(1);
    expect(fixedQuestionForOrdinal(policy, 3, "same-team")).toEqual(
      fixedQuestionForOrdinal(policy, 3, "same-team"),
    );
    expect(policy.fallbackQuestions.filter((question) => question.ordinal === 3)).toHaveLength(8);
    expect(policy.fallbackQuestions.filter((question) => question.ordinal === 4)).toHaveLength(8);
  });

  test("publishes a new default without moving an active participant draft", async () => {
    const backend = createBackend();
    const fixture = await seedFixture(backend, "deterministic");
    const draft = await backend.run((ctx) =>
      saveIntakePolicyDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        policy: {
          ...defaultDeterministicIntakePolicy,
          initialHelpText: "A sentence or two is enough. Start with the problem and intended user.",
        },
        now: fixture.now + 1,
      }),
    );
    await backend.run((ctx) =>
      publishIntakePolicy(ctx, {
        event: fixture.event,
        draftPolicyId: draft.policyVersionId,
        expectedDraftChecksum: draft.checksum,
        now: fixture.now + 2,
      }),
    );

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
    const backend = createBackend();
    const fixture = await seedFixture(backend, "deterministic");
    const first = await backend.run((ctx) =>
      saveIntakePolicyDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        policy: policyWithHelp("First reviewed participant help text for this event."),
        now: fixture.now + 1,
      }),
    );
    const second = await backend.run((ctx) =>
      saveIntakePolicyDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        policy: policyWithHelp("Second reviewed participant help text for this event."),
        expectedDraftPolicyId: first.policyVersionId,
        now: fixture.now + 2,
      }),
    );

    await expect(
      backend.run((ctx) =>
        publishIntakePolicy(ctx, {
          event: fixture.event,
          draftPolicyId: first.policyVersionId,
          expectedDraftChecksum: first.checksum,
          now: fixture.now + 3,
        }),
      ),
    ).rejects.toThrow("changed in another session");
    const states = await backend.run(async (ctx) => ({
      first: (await ctx.db.get(first.policyVersionId))?.status,
      second: (await ctx.db.get(second.policyVersionId))?.status,
    }));
    expect(states).toEqual({ first: "retired", second: "draft" });
  });

  test("allows one concurrent draft creation from the same observed state", async () => {
    const backend = createBackend();
    const fixture = await seedFixture(backend, "deterministic");
    const attempts = await Promise.allSettled([
      backend.run((ctx) =>
        saveIntakePolicyDraft(ctx, {
          event: fixture.event,
          actorPersonId: fixture.personId,
          policy: policyWithHelp("Alpha participant guidance with a practical amount of detail."),
          now: fixture.now + 1,
        }),
      ),
      backend.run((ctx) =>
        saveIntakePolicyDraft(ctx, {
          event: fixture.event,
          actorPersonId: fixture.personId,
          policy: policyWithHelp("Beta participant guidance with a practical amount of detail."),
          now: fixture.now + 1,
        }),
      ),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const drafts = await backend.run((ctx) =>
      ctx.db
        .query("intakePolicyVersions")
        .withIndex("by_event_status", (index) =>
          index.eq("eventId", fixture.event._id).eq("status", "draft"),
        )
        .collect(),
    );
    expect(drafts).toHaveLength(1);
  });

  test("uses the two published fixed questions before any model work", async () => {
    const backend = createBackend();
    const fixture = await seedFixture(backend, "deterministic");
    await backend.mutation(internal.intelligence.beginIntakeInterpretation, {
      draftId: fixture.projectDraftId,
      provider: { kind: "unavailable", reason: "api_key_not_configured" },
    });
    const first = await currentQuestion(backend, fixture.projectDraftId, 1);
    expect(first.text).toBe(defaultDeterministicIntakePolicy.fallbackQuestions[0]?.text);
    await answerQuestion(backend, fixture, first._id, "Local student teams would use it first.");
    await backend.mutation(internal.intelligence.beginIntakeInterpretation, {
      draftId: fixture.projectDraftId,
      provider: { kind: "unavailable", reason: "api_key_not_configured" },
    });
    const second = await currentQuestion(backend, fixture.projectDraftId, 2);
    expect(second.text).toBe(defaultDeterministicIntakePolicy.fallbackQuestions[1]?.text);
    expect(first.source).toBe("fixed");
    expect(second.source).toBe("fixed");
  });

  test("a deterministic policy never sends answers to an available provider", async () => {
    const backend = createBackend();
    const fixture = await seedFixture(backend, "deterministic");
    await answerFixedQuestions(backend, fixture);
    vi.stubEnv("OPENAI_API_KEY", "configured-provider-key");
    const providerRequest = vi.fn(() => {
      throw new Error("A deterministic policy attempted an external request.");
    });
    vi.stubGlobal("fetch", providerRequest);

    await backend.action(internal.intelligenceActions.interpretIdea, {
      draftId: fixture.projectDraftId,
    });

    const result = await backend.run(async (ctx) => ({
      draft: await ctx.db.get(fixture.projectDraftId),
      interpretations: await ctx.db
        .query("intakeInterpretations")
        .withIndex("by_draft_created", (index) => index.eq("draftId", fixture.projectDraftId))
        .collect(),
      questions: await ctx.db
        .query("intakeGeneratedQuestions")
        .withIndex("by_draft_ordinal", (index) => index.eq("draftId", fixture.projectDraftId))
        .collect(),
    }));
    expect(providerRequest).not.toHaveBeenCalled();
    expect(result.draft?.stage).toBe("follow_up");
    expect(result.interpretations).toEqual([]);
    expect(result.questions).toHaveLength(3);
    expect(result.questions.map((question) => question.source)).toEqual([
      "fixed",
      "fixed",
      "fallback",
    ]);
  });

  test("an assisted policy starts generation only after both fixed answers", async () => {
    const backend = createBackend();
    const fixture = await seedFixture(backend, "assisted");
    await answerFixedQuestions(backend, fixture);
    const firstContext = await beginAssisted(backend, fixture.projectDraftId);
    await backend.mutation(internal.intelligence.finishIntakeInterpretation, {
      interpretationId: firstContext.interpretationId,
      inputFingerprint: firstContext.inputFingerprint,
      state: "succeeded",
      coveragePurposeKeys: ["problem", "experience"],
      nextQuestionText: "How will an authority know which report needs action first?",
      nextQuestionPurposeKey: "tradeoff",
      nextQuestionAnswerLength: "medium",
      nextQuestionSourceAnswerVersionIds: firstContext.answers.map((answer) => answer.id),
      stopReason: "needs_question",
      latencyMs: 20,
    });
    const generated = await currentQuestion(backend, fixture.projectDraftId, 3);
    expect(generated).toMatchObject({
      ordinal: 3,
      source: "model",
      validationCategory: "model_output_validated",
    });
  });

  test("the OpenAI action can generate two additional questions through the provider contract", async () => {
    const backend = createBackend();
    const fixture = await seedFixture(backend, "assisted");
    await answerFixedQuestions(backend, fixture);
    vi.stubEnv("OPENAI_API_KEY", "intake-provider-test-key");
    let sourceAnswerIds: string[] = [];
    let requestCount = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.openai.com/v1/responses");
      expect(String(init?.body)).toContain('"strict":true');
      requestCount += 1;
      const firstRequest = requestCount === 1;
      return openAiResponse(
        JSON.stringify({
          coveragePurposeKeys: firstRequest
            ? ["problem", "experience"]
            : ["problem", "experience", "risk"],
          nextQuestion: {
            text: firstRequest
              ? "How will an authority know which report needs action first?"
              : "How will your team show that a reported issue was resolved?",
            purposeKey: firstRequest ? "tradeoff" : "experience",
            answerLength: "medium",
            sourceAnswerVersionIds: sourceAnswerIds,
            groundingTerms: [firstRequest ? "authority" : "report"],
          },
          matchedIdeaPatternKey: null,
          stopReason: "needs_question",
        }),
      );
    });

    sourceAnswerIds = await activeAnswerIds(backend, fixture.projectDraftId);
    await backend.action(internal.intelligenceActions.interpretIdea, {
      draftId: fixture.projectDraftId,
    });
    const first = await currentQuestion(backend, fixture.projectDraftId, 3);
    await answerQuestion(
      backend,
      fixture,
      first._id,
      "Reports with a verified location and safety risk would be handled first.",
    );
    sourceAnswerIds = await activeAnswerIds(backend, fixture.projectDraftId);
    await backend.action(internal.intelligenceActions.interpretIdea, {
      draftId: fixture.projectDraftId,
    });
    const second = await currentQuestion(backend, fixture.projectDraftId, 4);

    expect(requestCount).toBe(2);
    expect(
      [first, second].map((question) => ({
        ordinal: question.ordinal,
        source: question.source,
        validationCategory: question.validationCategory,
      })),
    ).toEqual([
      { ordinal: 3, source: "model", validationCategory: "model_output_validated" },
      { ordinal: 4, source: "model", validationCategory: "model_output_validated" },
    ]);
  });

  test("rejects a generated question that is not grounded in its source answers", async () => {
    const backend = createBackend();
    const fixture = await seedFixture(backend, "assisted");
    await answerFixedQuestions(backend, fixture);
    vi.stubEnv("OPENAI_API_KEY", "intake-provider-test-key");
    const sourceAnswerIds = await activeAnswerIds(backend, fixture.projectDraftId);
    vi.stubGlobal("fetch", async () =>
      openAiResponse(
        JSON.stringify({
          coveragePurposeKeys: ["problem", "experience"],
          nextQuestion: {
            text: "What would make this project successful?",
            purposeKey: "experience",
            answerLength: "short",
            sourceAnswerVersionIds: sourceAnswerIds,
            groundingTerms: ["success"],
          },
          matchedIdeaPatternKey: null,
          stopReason: "needs_question",
        }),
      ),
    );

    await backend.action(internal.intelligenceActions.interpretIdea, {
      draftId: fixture.projectDraftId,
    });

    const result = await backend.run(async (ctx) => ({
      draft: await ctx.db.get(fixture.projectDraftId),
      questions: await ctx.db
        .query("intakeGeneratedQuestions")
        .withIndex("by_draft_ordinal", (index) => index.eq("draftId", fixture.projectDraftId))
        .collect(),
      interpretation: await ctx.db
        .query("intakeInterpretations")
        .withIndex("by_draft_created", (index) => index.eq("draftId", fixture.projectDraftId))
        .order("desc")
        .first(),
    }));
    expect(result.questions).toHaveLength(3);
    expect(result.questions.at(-1)).toMatchObject({ ordinal: 3, source: "fallback" });
    expect(result.draft?.stage).toBe("follow_up");
    expect(result.interpretation).toMatchObject({
      state: "invalid",
      failureCategory: "invalid_or_disallowed_output",
    });
  });

  test("a provider failure fills the generated slot with its published fallback", async () => {
    const backend = createBackend();
    const fixture = await seedFixture(backend, "assisted");
    await answerFixedQuestions(backend, fixture);
    vi.stubEnv("OPENAI_API_KEY", "intake-provider-test-key");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("The provider connection is unavailable.");
    });

    await backend.action(internal.intelligenceActions.interpretIdea, {
      draftId: fixture.projectDraftId,
    });

    const result = await backend.run(async (ctx) => ({
      draft: await ctx.db.get(fixture.projectDraftId),
      interpretations: await ctx.db
        .query("intakeInterpretations")
        .withIndex("by_draft_created", (index) => index.eq("draftId", fixture.projectDraftId))
        .collect(),
      questions: await ctx.db
        .query("intakeGeneratedQuestions")
        .withIndex("by_draft_ordinal", (index) => index.eq("draftId", fixture.projectDraftId))
        .collect(),
    }));
    const interpretation = result.interpretations.at(-1);
    expect(result.draft?.stage).toBe("follow_up");
    expect(result.questions).toHaveLength(3);
    expect(result.questions.at(-1)).toMatchObject({ ordinal: 3, source: "fallback" });
    expect(interpretation).toMatchObject({
      state: "failed",
      failureCategory: "provider_request_failed",
    });
  });

  test("provider failures still produce exactly two fixed and two fallback questions", async () => {
    const backend = createBackend();
    const fixture = await seedFixture(backend, "assisted");
    await answerFixedQuestions(backend, fixture);

    for (const ordinal of [3, 4] as const) {
      const context = await beginAssisted(backend, fixture.projectDraftId);
      expect(context.ordinal).toBe(ordinal);
      await backend.mutation(internal.intelligence.finishIntakeInterpretation, {
        interpretationId: context.interpretationId,
        inputFingerprint: context.inputFingerprint,
        state: "failed",
        coveragePurposeKeys: [],
        nextQuestionSourceAnswerVersionIds: [],
        latencyMs: 25,
        failureCategory: "provider_request_failed",
      });
      const question = await currentQuestion(backend, fixture.projectDraftId, ordinal);
      expect(question.source).toBe("fallback");
      await answerQuestion(
        backend,
        fixture,
        question._id,
        ordinal === 3
          ? "The service should make the next useful action obvious to the reporter."
          : "The prototype should prove that a report reaches the right responsible group.",
      );
    }

    const result = await backend.run(async (ctx) => ({
      draft: await ctx.db.get(fixture.projectDraftId),
      questions: await ctx.db
        .query("intakeGeneratedQuestions")
        .withIndex("by_draft_ordinal", (index) => index.eq("draftId", fixture.projectDraftId))
        .collect(),
    }));
    expect(result.draft?.stage).toBe("additional_information");
    expect(result.questions.map((question) => [question.ordinal, question.source])).toEqual([
      [1, "fixed"],
      [2, "fixed"],
      [3, "fallback"],
      [4, "fallback"],
    ]);
  });

  test("a provider result arriving after its settlement deadline becomes the fallback", async () => {
    const backend = createBackend();
    const fixture = await seedFixture(backend, "assisted");
    await answerFixedQuestions(backend, fixture);
    const context = await beginAssisted(backend, fixture.projectDraftId);
    await backend.run((ctx) =>
      ctx.db.patch(context.interpretationId, {
        createdAt: Date.now() - 16_000,
      }),
    );

    await backend.mutation(internal.intelligence.finishIntakeInterpretation, {
      interpretationId: context.interpretationId,
      inputFingerprint: context.inputFingerprint,
      state: "succeeded",
      coveragePurposeKeys: ["problem", "experience"],
      nextQuestionText: "How will an authority know which report needs action first?",
      nextQuestionPurposeKey: "tradeoff",
      nextQuestionAnswerLength: "medium",
      nextQuestionSourceAnswerVersionIds: context.answers.map((answer) => answer.id),
      stopReason: "needs_question",
      latencyMs: 16_000,
    });

    const result = await backend.run(async (ctx) => ({
      interpretation: await ctx.db.get(context.interpretationId),
      question: await ctx.db
        .query("intakeGeneratedQuestions")
        .withIndex("by_draft_ordinal", (index) =>
          index.eq("draftId", fixture.projectDraftId).eq("ordinal", 3),
        )
        .filter((filter) => filter.neq(filter.field("state"), "replaced"))
        .unique(),
    }));
    expect(result.interpretation).toMatchObject({
      state: "timed_out",
      failureCategory: "settlement_deadline_exceeded",
    });
    expect(result.question).toMatchObject({ source: "fallback" });
  });

  test("the settlement deadline creates the fallback and rejects a late provider result", async () => {
    const backend = createBackend();
    const fixture = await seedFixture(backend, "assisted");
    await answerFixedQuestions(backend, fixture);
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
      nextQuestionText: "How will an authority know which report needs action first?",
      nextQuestionPurposeKey: "tradeoff",
      nextQuestionAnswerLength: "medium",
      nextQuestionSourceAnswerVersionIds: context.answers.map((answer) => answer.id),
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
    expect(result.questions).toHaveLength(3);
    expect(result.questions.at(-1)).toMatchObject({ ordinal: 3, source: "fallback" });
  });

  test("a queued interpretation cannot leave the participant waiting indefinitely", async () => {
    const backend = createBackend();
    const fixture = await seedFixture(backend, "assisted");
    await answerFixedQuestions(backend, fixture);
    const draft = await backend.run((ctx) => ctx.db.get(fixture.projectDraftId));
    if (!draft) throw new Error("The intake draft is missing.");
    const enqueuedAt = Date.now() - ideaQuestionEndToEndDeadlineMs;
    const deadlineAt = enqueuedAt + ideaQuestionEndToEndDeadlineMs;
    await backend.run((ctx) =>
      ctx.db.patch(draft._id, {
        adaptiveQuestionDeadlineAt: deadlineAt,
      }),
    );

    await backend.mutation(internal.intelligence.expireQueuedIntakeInterpretation, {
      draftId: draft._id,
      draftVersion: draft.version,
      deadlineAt,
    });

    const result = await backend.run(async (ctx) => ({
      draft: await ctx.db.get(fixture.projectDraftId),
      interpretations: await ctx.db
        .query("intakeInterpretations")
        .withIndex("by_draft_created", (index) => index.eq("draftId", fixture.projectDraftId))
        .collect(),
      questions: await ctx.db
        .query("intakeGeneratedQuestions")
        .withIndex("by_draft_ordinal", (index) => index.eq("draftId", fixture.projectDraftId))
        .collect(),
    }));
    expect(result.draft?.stage).toBe("follow_up");
    expect(result.questions).toHaveLength(3);
    expect(result.questions.at(-1)).toMatchObject({
      ordinal: 3,
      source: "fallback",
    });
    expect(result.interpretations.at(-1)).toMatchObject({
      state: "disabled",
      failureCategory: "action_start_deadline_exceeded",
      createdAt: enqueuedAt,
    });
    expect(
      await backend.mutation(internal.intelligence.beginIntakeInterpretation, {
        draftId: draft._id,
        provider: { kind: "available" },
      }),
    ).toBeNull();

    await backend.mutation(internal.intelligence.expireQueuedIntakeInterpretation, {
      draftId: draft._id,
      draftVersion: draft.version,
      deadlineAt,
    });
    const currentQuestions = await backend.run((ctx) =>
      ctx.db
        .query("intakeGeneratedQuestions")
        .withIndex("by_draft_ordinal", (index) => index.eq("draftId", fixture.projectDraftId))
        .filter((filter) => filter.neq(filter.field("state"), "replaced"))
        .collect(),
    );
    expect(currentQuestions).toHaveLength(3);
  });

  test("an obsolete queue deadline cannot change a newer draft version", async () => {
    const backend = createBackend();
    const fixture = await seedFixture(backend, "assisted");
    await answerFixedQuestions(backend, fixture);
    const draft = await backend.run((ctx) => ctx.db.get(fixture.projectDraftId));
    if (!draft) throw new Error("The intake draft is missing.");
    const deadlineAt = Date.now() - 1;
    await backend.run((ctx) =>
      ctx.db.patch(draft._id, {
        adaptiveQuestionDeadlineAt: deadlineAt + 10_000,
        version: draft.version + 1,
      }),
    );

    await backend.mutation(internal.intelligence.expireQueuedIntakeInterpretation, {
      draftId: draft._id,
      draftVersion: draft.version,
      deadlineAt,
    });

    const result = await backend.run(async (ctx) => ({
      draft: await ctx.db.get(fixture.projectDraftId),
      ordinalThree: await ctx.db
        .query("intakeGeneratedQuestions")
        .withIndex("by_draft_ordinal", (index) =>
          index.eq("draftId", fixture.projectDraftId).eq("ordinal", 3),
        )
        .collect(),
    }));
    expect(result.draft?.version).toBe(draft.version + 1);
    expect(result.ordinalThree).toEqual([]);
  });

  test("a model attempt to skip a generated slot is invalid and uses the fallback", async () => {
    const backend = createBackend();
    const fixture = await seedFixture(backend, "assisted");
    await answerFixedQuestions(backend, fixture);
    const secondContext = await beginAssisted(backend, fixture.projectDraftId);
    await backend.mutation(internal.intelligence.finishIntakeInterpretation, {
      interpretationId: secondContext.interpretationId,
      inputFingerprint: secondContext.inputFingerprint,
      state: "succeeded",
      coveragePurposeKeys: ["problem", "experience"],
      nextQuestionSourceAnswerVersionIds: [],
      stopReason: "enough_context",
      latencyMs: 18,
    });

    const interpretation = await backend.run((ctx) => ctx.db.get(secondContext.interpretationId));
    expect(interpretation).toMatchObject({ state: "invalid" });
    const result = await backend.run(async (ctx) => ({
      draft: await ctx.db.get(fixture.projectDraftId),
      question: await ctx.db
        .query("intakeGeneratedQuestions")
        .withIndex("by_draft_ordinal", (index) =>
          index.eq("draftId", fixture.projectDraftId).eq("ordinal", 3),
        )
        .filter((filter) => filter.eq(filter.field("state"), "active"))
        .unique(),
    }));
    expect(result.draft?.stage).toBe("follow_up");
    expect(result.question).toMatchObject({ source: "fallback" });
  });

  test("a failed assisted run settles once and cannot add a late question", async () => {
    const backend = createBackend();
    const fixture = await seedFixture(backend, "assisted");
    await answerFixedQuestions(backend, fixture);
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
      nextQuestionText: "How will an authority know which report needs action first?",
      nextQuestionPurposeKey: "tradeoff",
      nextQuestionAnswerLength: "medium",
      nextQuestionSourceAnswerVersionIds: context.answers.map((answer) => answer.id),
      stopReason: "needs_question",
      latencyMs: 40,
    });
    const questions = await backend.run((ctx) =>
      ctx.db
        .query("intakeGeneratedQuestions")
        .withIndex("by_draft_ordinal", (index) => index.eq("draftId", fixture.projectDraftId))
        .collect(),
    );
    expect(questions).toHaveLength(3);
    expect(questions.map((question) => question.source)).toEqual(["fixed", "fixed", "fallback"]);
  });

  test("replacing an idea removes routed questions and answers together", async () => {
    const backend = createBackend();
    const fixture = await seedFixture(backend, "deterministic");
    await backend.mutation(internal.intelligence.beginIntakeInterpretation, {
      draftId: fixture.projectDraftId,
      provider: { kind: "unavailable", reason: "api_key_not_configured" },
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
  return new Response(
    JSON.stringify({
      id: "resp_intake_test",
      object: "response",
      created_at: 1,
      status: "completed",
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: 500,
      model: "intake-test-model",
      output: [
        {
          id: "msg_intake_test",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: outputText,
              annotations: [],
              logprobs: [],
            },
          ],
        },
      ],
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
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "request-intake-test",
      },
    },
  );
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
  const context = await backend.mutation(internal.intelligence.beginIntakeInterpretation, {
    draftId,
    provider: { kind: "available" },
  });
  if (!context) throw new Error("The assisted interpretation did not begin.");
  return context;
}

async function answerFixedQuestions(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedFixture>>,
) {
  await backend.mutation(internal.intelligence.beginIntakeInterpretation, {
    draftId: fixture.projectDraftId,
    provider: { kind: "available" },
  });
  const first = await currentQuestion(backend, fixture.projectDraftId, 1);
  await answerQuestion(
    backend,
    fixture,
    first._id,
    "Residents and road users need damaged roads reported with a usable location.",
  );
  await backend.mutation(internal.intelligence.beginIntakeInterpretation, {
    draftId: fixture.projectDraftId,
    provider: { kind: "available" },
  });
  const second = await currentQuestion(backend, fixture.projectDraftId, 2);
  await answerQuestion(
    backend,
    fixture,
    second._id,
    "A person adds a photo and location, then the service routes the report to the responsible authority.",
  );
}

async function activeAnswerIds(backend: BackendTest, draftId: Id<"projectDrafts">) {
  const answers = await backend.run((ctx) =>
    ctx.db
      .query("intakeAnswerVersions")
      .withIndex("by_draft_status", (index) => index.eq("draftId", draftId).eq("status", "active"))
      .collect(),
  );
  return answers
    .toSorted((left, right) => left.writtenAt - right.writtenAt)
    .slice(-3)
    .map((answer) => answer._id);
}

async function currentQuestion(
  backend: BackendTest,
  draftId: Id<"projectDrafts">,
  ordinal: number,
) {
  const question = await backend.run((ctx) =>
    ctx.db
      .query("intakeGeneratedQuestions")
      .withIndex("by_draft_ordinal", (index) => index.eq("draftId", draftId).eq("ordinal", ordinal))
      .filter((filter) => filter.neq(filter.field("state"), "replaced"))
      .unique(),
  );
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
      stage: question.ordinal < 4 ? "follow_up" : "additional_information",
      version: draft.version + 1,
      updatedAt: fixture.now + question.ordinal,
    });
    return answerId;
  });
}

async function seedFixture(backend: BackendTest, mode: "deterministic" | "assisted") {
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
