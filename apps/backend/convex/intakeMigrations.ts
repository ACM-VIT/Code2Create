import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import {
  defaultDeterministicIntakePolicy,
  intakePolicyChecksum,
  intakePolicyFromDocument,
  normalizeIntakePolicy,
} from "./lib/intakePolicy";
import {
  createFixedIntakeQuestion,
  loadActiveIntakeAnswers,
  replaceCurrentIntakeQuestions,
} from "./lib/intakeQuestions";
import {
  ideaQuestionRelease,
  ideaQuestionSystemInstruction,
} from "./lib/ideaSubmissionAi";

export const adoptFixedQuestionIntake = internalMutation({
  args: {
    eventSlug: v.string(),
    expectedPublishedPolicyId: v.id("intakePolicyVersions"),
  },
  returns: v.object({
    policyVersionId: v.id("intakePolicyVersions"),
    resetDraftCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    if (event.publishedIntakePolicyId !== args.expectedPublishedPolicyId) {
      throw new Error("The published intake policy changed before migration.");
    }
    const published = await ctx.db.get(args.expectedPublishedPolicyId);
    if (
      !published ||
      published.eventId !== event._id ||
      published.status !== "published"
    ) {
      throw new Error("The expected published intake policy is invalid.");
    }

    const latestPolicy = await ctx.db
      .query("intakePolicyVersions")
      .withIndex("by_event_version", (index) => index.eq("eventId", event._id))
      .order("desc")
      .first();
    const nextPolicy = normalizeIntakePolicy({
      ...intakePolicyFromDocument(published),
      minimumFollowUpCount: 2,
      maximumFollowUpCount: 4,
      deterministicFollowUpCount: 2,
      fallbackQuestions: defaultDeterministicIntakePolicy.fallbackQuestions,
      commonIdeaPatterns: [],
      model: {
        mode: "assisted",
        modelId: ideaQuestionRelease.modelId,
        systemInstruction: ideaQuestionSystemInstruction,
        instructionVersion: ideaQuestionRelease.instructionVersion,
        schemaVersion: ideaQuestionRelease.schemaVersion,
        redactionVersion: ideaQuestionRelease.redactionVersion,
        questionPolicyVersion: ideaQuestionRelease.questionPolicyVersion,
        evaluationSuiteVersion: ideaQuestionRelease.evaluationSuiteVersion,
      },
    });
    const now = Date.now();
    const policyVersionId = await ctx.db.insert("intakePolicyVersions", {
      eventId: event._id,
      version: (latestPolicy?.version ?? 0) + 1,
      status: "published",
      ...nextPolicy,
      checksum: intakePolicyChecksum(nextPolicy),
      createdByPersonId: published.createdByPersonId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(published._id, { status: "superseded" });

    const drafts = await ctx.db
      .query("projectDrafts")
      .withIndex("by_event_intake_policy", (index) =>
        index
          .eq("eventId", event._id)
          .eq("intakePolicyVersionId", published._id),
      )
      .collect();
    let resetDraftCount = 0;
    for (const draft of drafts) {
      if (draft.stage === "submitted") continue;
      await replaceCurrentIntakeQuestions(ctx, draft._id);
      const runningInterpretations = await ctx.db
        .query("intakeInterpretations")
        .withIndex("by_draft_created", (index) => index.eq("draftId", draft._id))
        .filter((filter) => filter.eq(filter.field("state"), "running"))
        .collect();
      for (const interpretation of runningInterpretations) {
        await ctx.db.patch(interpretation._id, {
          state: "stale",
          failureCategory: "intake_policy_migrated",
          completedAt: now,
        });
      }
      await ctx.db.patch(draft._id, {
        intakePolicyVersionId: policyVersionId,
        stage: draft.initialIdea ? "follow_up" : "opening",
        version: draft.version + 1,
        updatedAt: now,
      });
      if (draft.initialIdea) {
        const [updatedDraft, answers, policy] = await Promise.all([
          ctx.db.get(draft._id),
          loadActiveIntakeAnswers(ctx, draft._id),
          ctx.db.get(policyVersionId),
        ]);
        if (!updatedDraft || !policy) {
          throw new Error("The migrated intake route did not persist.");
        }
        const initialAnswer = answers.find(
          (answer) => answer.promptKey === "initial_idea",
        );
        if (!initialAnswer) {
          throw new Error("An active project draft has no initial idea answer.");
        }
        await createFixedIntakeQuestion(ctx, {
          draft: updatedDraft,
          policy,
          normalizedPolicy: nextPolicy,
          ordinal: 1,
          sourceAnswerVersionIds: [initialAnswer._id],
          now,
        });
      }
      resetDraftCount += 1;
    }
    await ctx.db.patch(event._id, {
      publishedIntakePolicyId: policyVersionId,
      version: event.version + 1,
      updatedAt: now,
    });
    return { policyVersionId, resetDraftCount };
  },
});
