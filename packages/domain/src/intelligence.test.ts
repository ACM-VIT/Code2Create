import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveOperationsCopilotConversationId,
  encodeOperationsIntelligenceStreamTicket,
  operationsCopilotInstanceId,
  operationsIntelligenceStreamCapability,
  operationsIntelligenceStreamTicketHeaders,
  operationsIntelligenceProtocolVersion,
  operationsBriefStreamTicketSignatureContext,
  operationsCopilotStreamTicketSignatureContext,
  serializeOperationsIntelligenceStreamTicket,
  signServiceBody,
  verifyServiceBody,
} from "./intelligence.ts";
import { intelligenceAgentDefinition } from "./intelligenceAgents.ts";
import {
  ideaIntelligenceAnalysisPolicyViolation,
  type IdeaIntelligenceAnalysis,
} from "./ideaIntelligence.ts";

const signingSecret = "s".repeat(32);

const validIdeaAnalysis: IdeaIntelligenceAnalysis = {
  recommendation: "needs_information",
  criterionAssessments: [
    {
      criterionKey: "problem_clarity",
      assessment: "partly_meets",
      sourceRefs: ["initial_idea"],
    },
  ],
  strengths: ["The proposal identifies a concrete operational problem."],
  concerns: ["The user validation approach is not yet described."],
  proposedQuestions: ["How will the team validate the need with intended users?"],
  confidence: "medium",
  limitations: ["Only the submitted project answers were available."],
};

test("idea analysis policy accepts only exact, grounded, non-scoring output", () => {
  const firstAssessment = validIdeaAnalysis.criterionAssessments[0];
  if (firstAssessment === undefined) {
    throw new Error("The valid analysis fixture needs one criterion assessment.");
  }
  const context = {
    criterionKeys: ["problem_clarity"],
    sourceRefs: ["initial_idea"],
  };
  assert.equal(
    ideaIntelligenceAnalysisPolicyViolation({ analysis: validIdeaAnalysis, ...context }),
    null,
  );
  assert.equal(
    ideaIntelligenceAnalysisPolicyViolation({
      analysis: {
        ...validIdeaAnalysis,
        criterionAssessments: [
          {
            ...firstAssessment,
            sourceRefs: ["invented_source"],
          },
        ],
      },
      ...context,
    }),
    "evidence_mismatch",
  );
  assert.equal(
    ideaIntelligenceAnalysisPolicyViolation({
      analysis: {
        ...validIdeaAnalysis,
        strengths: ["This proposal deserves a high score."],
      },
      ...context,
    }),
    "prohibited_language",
  );
});

test("service signing measures multibyte secrets in UTF-8 bytes", async () => {
  const secret = "é".repeat(16);
  const timestamp = "1000";
  const signature = await signServiceBody({
    context: "test-context",
    secret,
    timestamp,
    body: "test-body",
  });

  assert.equal(secret.length, 16);
  assert.equal(new TextEncoder().encode(secret).byteLength, 32);
  assert.equal(
    await verifyServiceBody({
      context: "test-context",
      secret,
      timestamp,
      signature,
      body: "test-body",
      now: 1_000,
      maximumAgeMs: 1_000,
    }),
    true,
  );
});

test("copilot conversation identities are stable and subject scoped", async () => {
  const first = await deriveOperationsCopilotConversationId({
    secret: signingSecret,
    eventId: "event-one",
    eventAccessSubjectId: "subject-one",
  });
  const retry = await deriveOperationsCopilotConversationId({
    secret: signingSecret,
    eventId: "event-one",
    eventAccessSubjectId: "subject-one",
  });
  const otherSubject = await deriveOperationsCopilotConversationId({
    secret: signingSecret,
    eventId: "event-one",
    eventAccessSubjectId: "subject-two",
  });

  assert.equal(first, retry);
  assert.notEqual(first, otherSubject);
  assert.match(first, /^cv_[a-f0-9]{64}$/u);
  assert.equal(
    operationsCopilotInstanceId({ eventSlug: "code2create-7", conversationId: first }),
    `copilot:code2create-7:${first}`,
  );
});

test("stream tickets have one canonical signed representation", () => {
  const ticket = {
    protocolVersion: operationsIntelligenceProtocolVersion,
    eventSlug: "code2create-7",
    conversationId: "cv_abc",
    instanceId: "copilot:code2create-7:cv_abc",
    agentName: "operations-copilot" as const,
    capability: operationsIntelligenceStreamCapability,
    issuedAt: 1_000,
    expiresAt: 61_000,
    nonce: "nonce_123",
  };
  const serialized = serializeOperationsIntelligenceStreamTicket(ticket);

  assert.equal(
    serialized,
    '{"protocolVersion":"operations-intelligence-v1","eventSlug":"code2create-7","instanceId":"copilot:code2create-7:cv_abc","agentName":"operations-copilot","capability":"read","issuedAt":1000,"expiresAt":61000,"nonce":"nonce_123","conversationId":"cv_abc"}',
  );
  assert.equal(
    Buffer.from(encodeOperationsIntelligenceStreamTicket(ticket), "base64url").toString("utf-8"),
    serialized,
  );
  assert.deepEqual(operationsIntelligenceStreamTicketHeaders, {
    ticket: "x-c2c-stream-ticket",
    timestamp: "x-c2c-timestamp",
    signature: "x-c2c-signature",
  });
});

test("brief tickets cannot carry copilot conversation coordinates", () => {
  const serialized = serializeOperationsIntelligenceStreamTicket({
    protocolVersion: operationsIntelligenceProtocolVersion,
    eventSlug: "code2create-7",
    instanceId: "brief-id",
    agentName: "operations-brief",
    briefId: "brief-id",
    capability: operationsIntelligenceStreamCapability,
    issuedAt: 1_000,
    expiresAt: 61_000,
    nonce: "nonce_456",
  });

  assert.match(serialized, /"briefId":"brief-id"/u);
  assert.doesNotMatch(serialized, /conversationId/u);
  assert.notEqual(
    operationsBriefStreamTicketSignatureContext,
    operationsCopilotStreamTicketSignatureContext,
  );
});

test("the copilot release uses one generalized command protocol without per-request skills", () => {
  const copilot = intelligenceAgentDefinition("operations-copilot");
  const systemPrompt = copilot.prompts.find((prompt) => prompt.name === "System prompt")?.text;
  assert.equal(copilot.version, "operations-copilot-v1");
  if (systemPrompt === undefined || systemPrompt.length === 0) {
    throw new Error("The copilot agent needs a system prompt.");
  }
  assert.match(systemPrompt, /first call inspect_event_commands/u);
  assert.match(systemPrompt, /only write is propose_event_command/u);
  assert.match(systemPrompt, /Never invent a command or argument/u);
  assert.match(systemPrompt, /current grants, fresh authentication, lifecycle locks/u);
  assert.doesNotMatch(systemPrompt, /manage-admission-policy/u);
  assert.doesNotMatch(systemPrompt, /minimumHumanReviews/u);
  assert.doesNotMatch(systemPrompt, /under \d+ words|at most \d+ total tool calls/u);
  assert.match(
    systemPrompt,
    /do not impose an artificial response, token, turn, or tool-call ceiling/u,
  );
  assert.ok(copilot.tools.includes("scoped event-command catalog"));
  assert.ok(copilot.tools.includes("propose_event_command"));
});

test("the idea agent may iterate until it publishes a valid assessment", () => {
  const ideaAgent = intelligenceAgentDefinition("idea-submission");
  const systemPrompt = ideaAgent.prompts.find((prompt) => prompt.name === "System prompt")?.text;

  if (systemPrompt === undefined || systemPrompt.length === 0) {
    throw new Error("The idea agent needs a system prompt.");
  }
  assert.match(systemPrompt, /as many reasoning and tool turns as needed/u);
  assert.match(systemPrompt, /correct it and retry/u);
  assert.doesNotMatch(systemPrompt, /exactly once|at most \d+ .*calls?/u);
  assert.ok(ideaAgent.tools.includes("publish_idea_analysis"));
});
