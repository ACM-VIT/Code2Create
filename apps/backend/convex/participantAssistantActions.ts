"use node";

import { Agent, createTool, stepCountIs } from "@convex-dev/agent";
import {
  openai,
  type OpenAIResponsesProviderOptions,
} from "@ai-sdk/openai";
import { v } from "convex/values";
import { z } from "zod";

import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import {
  participantAssistantModelId,
  participantAssistantName,
} from "./lib/participantAssistant";

const bringInEventTeam = createTool({
  description:
    "Bring the Code2Create event team into this same conversation and pass them its transcript. Call only when EVENT_CONTEXT.humanSupport.available is true and the participant explicitly asks for a person, a manual account or event action is needed, a safety or accessibility concern needs a human, a case-specific ruling is required, or trusted event context cannot resolve an important blocker. Answer ordinary questions yourself.",
  inputSchema: z.object({
    category: z.enum([
      "identity",
      "team",
      "project_intake",
      "attendance_credential",
      "missing_scan",
      "table_location",
      "integration",
      "queue",
      "accessibility",
      "safety",
    ]),
    summary: z
      .string()
      .min(10)
      .max(1_600)
      .describe(
        "A concise, factual handoff for the event team: what the participant needs, what is already known, what was tried, and what a human should do next.",
      ),
  }),
  execute: async (ctx, input) => {
    if (ctx.threadId === undefined) {
      throw new Error("The Guide conversation is unavailable for handoff.");
    }
    const transcript = await ctx.runQuery(
      internal.participantAssistant.escalationTranscript,
      { threadId: ctx.threadId },
    );
    return ctx.runMutation(internal.participantAssistant.escalateToHuman, {
      threadId: ctx.threadId,
      category: input.category,
      summary: input.summary,
      transcript,
    });
  },
});

const participantAssistant = new Agent(components.agent, {
  name: participantAssistantName,
  languageModel: openai.responses(participantAssistantModelId),
  contextOptions: {
    recentMessages: 40,
  },
  tools: { bringInEventTeam },
  stopWhen: stepCountIs(4),
});

export const generateReply = internalAction({
  args: { requestId: v.id("participantAssistantRequests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const request = await ctx.runMutation(
      internal.participantAssistant.beginGeneration,
      args,
    );
    if (request === null) return null;

    try {
      const grounding = await ctx.runQuery(
        internal.participantAssistant.generationInstructions,
        {
          requestId: request.requestId,
          generatedAt: Date.now(),
        },
      );
      if (grounding === null) {
        throw new Error("The participant assistant context is unavailable.");
      }

      const providerOptions = {
        openai: {
          reasoningEffort: "medium",
          // The portal shows the Guide's thinking as it works, so ask for the
          // model's own summary of it rather than inferring one.
          reasoningSummary: "auto",
          textVerbosity: "medium",
          store: false,
          safetyIdentifier: request.personId,
        } satisfies OpenAIResponsesProviderOptions,
      };
      const result = await participantAssistant.streamText(
        ctx,
        {
          threadId: request.threadId,
          userId: request.personId,
        },
        {
          promptMessageId: request.promptMessageId,
          instructions: grounding.instructions,
          maxOutputTokens: 1_600,
          abortSignal: AbortSignal.timeout(45_000),
          providerOptions,
        },
        {
          saveStreamDeltas: {
            chunking: "line",
            throttleMs: 250,
          },
        },
      );
      const answer = await result.text;
      if (answer.trim().length >= 2) {
        await ctx.runMutation(
          internal.participantAssistant.recordGuideReplyForHuman,
          {
            requestId: request.requestId,
            message: answer,
            createdAt: Date.now(),
          },
        );
      }

      await ctx.runMutation(internal.participantAssistant.finishGeneration, {
        requestId: request.requestId,
        state: "completed",
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      console.error("Participant assistant reply failed", {
        requestId: request.requestId,
        reason,
      });
      await ctx.runMutation(internal.participantAssistant.finishGeneration, {
        requestId: request.requestId,
        state: "failed",
        failureMessage:
          "I couldn’t finish that answer. Please try again, or ask me to bring in the event team.",
      });
    }
    return null;
  },
});
