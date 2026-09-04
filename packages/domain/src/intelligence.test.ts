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
  ideaIntelligenceRecoveryLeaseMs,
  ideaIntelligenceSubmissionTimeoutMs,
  type IdeaIntelligenceAnalysis,
} from "./ideaIntelligence.ts";

const signingSecret = "s".repeat(32);

const validIdeaAnalysis: IdeaIntelligenceAnalysis = {
  recommendation: "waitlist",
  centralProposalConsistency: {
    assessment: "consistent",
    sourceRefs: ["initial_idea"],
  },
  criterionAssessments: [
    {
      criterionKey: "problem_clarity",
      assessment: "partly_meets",
      sourceRefs: ["initial_idea"],
    },
  ],
  strengths: ["The proposal identifies a concrete operational problem."],
  concerns: ["The user validation approach is not yet described."],
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
  assert.equal(
    ideaIntelligenceAnalysisPolicyViolation({
      analysis: { ...validIdeaAnalysis, recommendation: "accept" },
      ...context,
    }),
    "recommendation_mismatch",
  );
  assert.equal(
    ideaIntelligenceAnalysisPolicyViolation({
      analysis: {
        ...validIdeaAnalysis,
        recommendation: "decline",
        concerns: [],
        criterionAssessments: [
          { ...firstAssessment, assessment: "not_yet_clear" },
        ],
      },
      ...context,
    }),
    "recommendation_mismatch",
  );
});

test("idea analysis policy enforces the strict recommendation ladder", () => {
  const context = {
    criterionKeys: ["problem_clarity", "feasibility"],
    sourceRefs: ["initial_idea"],
  };
  const analysis = (
    recommendation: IdeaIntelligenceAnalysis["recommendation"],
    first: IdeaIntelligenceAnalysis["criterionAssessments"][number]["assessment"],
    second: IdeaIntelligenceAnalysis["criterionAssessments"][number]["assessment"],
  ): IdeaIntelligenceAnalysis => ({
    recommendation,
    centralProposalConsistency: {
      assessment: "consistent",
      sourceRefs: ["initial_idea"],
    },
    criterionAssessments: [
      { criterionKey: "problem_clarity", assessment: first, sourceRefs: ["initial_idea"] },
      { criterionKey: "feasibility", assessment: second, sourceRefs: ["initial_idea"] },
    ],
    strengths: ["The submission identifies one supported project claim."],
    concerns: recommendation === "accept" ? [] : ["A material evidence gap remains."],
    confidence: "medium",
    limitations: ["Only the submitted answers were available."],
  });

  assert.equal(
    ideaIntelligenceAnalysisPolicyViolation({
      analysis: analysis("accept", "meets", "meets"),
      ...context,
    }),
    null,
  );
  assert.equal(
    ideaIntelligenceAnalysisPolicyViolation({
      analysis: analysis("waitlist", "meets", "partly_meets"),
      ...context,
    }),
    null,
  );
  assert.equal(
    ideaIntelligenceAnalysisPolicyViolation({
      analysis: analysis("decline", "partly_meets", "partly_meets"),
      ...context,
    }),
    null,
  );
  assert.equal(
    ideaIntelligenceAnalysisPolicyViolation({
      analysis: analysis("decline", "meets", "not_yet_clear"),
      ...context,
    }),
    null,
  );
  assert.equal(
    ideaIntelligenceAnalysisPolicyViolation({
      analysis: analysis("waitlist", "partly_meets", "partly_meets"),
      ...context,
    }),
    "recommendation_mismatch",
  );
  assert.equal(
    ideaIntelligenceAnalysisPolicyViolation({
      analysis: {
        ...analysis("decline", "meets", "meets"),
        centralProposalConsistency: {
          assessment: "contradictory",
          sourceRefs: ["initial_idea", "follow_up_1"],
        },
      },
      criterionKeys: context.criterionKeys,
      sourceRefs: ["initial_idea", "follow_up_1"],
    }),
    null,
  );
  assert.equal(
    ideaIntelligenceAnalysisPolicyViolation({
      analysis: {
        ...analysis("accept", "meets", "meets"),
        centralProposalConsistency: {
          assessment: "contradictory",
          sourceRefs: ["initial_idea", "follow_up_1"],
        },
      },
      criterionKeys: context.criterionKeys,
      sourceRefs: ["initial_idea", "follow_up_1"],
    }),
    "recommendation_mismatch",
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
  assert.equal(copilot.version, "operations-copilot-v2");
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
  assert.match(systemPrompt, /calm, experienced teammate/u);
  assert.match(systemPrompt, /quick question usually needs two or three sentences/u);
  assert.match(systemPrompt, /do not print read names/u);
  assert.match(systemPrompt, /provenance only when the operator asks/u);
  assert.match(systemPrompt, /recite every area that is empty or healthy/u);
  assert.doesNotMatch(systemPrompt, /Cite each material claim by naming the read/u);
  assert.ok(copilot.tools.includes("scoped event-command catalog"));
  assert.ok(copilot.tools.includes("propose_event_command"));
});

test("the idea agent may iterate until it publishes a valid assessment", () => {
  const ideaAgent = intelligenceAgentDefinition("idea-submission");
  const systemPrompt = ideaAgent.prompts.find((prompt) => prompt.name === "System prompt")?.text;
  const analysisPrompt = ideaAgent.prompts.find(
    (prompt) => prompt.name === "Structured analysis prompt",
  )?.text;

  if (
    systemPrompt === undefined ||
    systemPrompt.length === 0 ||
    analysisPrompt === undefined ||
    analysisPrompt.length === 0
  ) {
    throw new Error("The idea agent needs system and analysis prompts.");
  }
  assert.match(systemPrompt, /as many reasoning and tool turns as needed/u);
  assert.match(systemPrompt, /correct it and retry/u);
  assert.doesNotMatch(systemPrompt, /exactly once|at most \d+ .*calls?/u);
  assert.match(analysisPrompt, /Before publishing, call find_similar_ideas/u);
  assert.match(analysisPrompt, /other currently submitted ideas/u);
  assert.match(analysisPrompt, /Similarity bands are retrieval hints, not proof/u);
  assert.match(analysisPrompt, /Use search_public_web with focused concept terms/u);
  assert.match(analysisPrompt, /Formulaic-language stress test/u);
  assert.match(analysisPrompt, /Overused em dashes or semicolons/u);
  assert.match(analysisPrompt, /Never accuse a participant of using AI/u);
  assert.match(analysisPrompt, /grade such evidence lower because it is underspecified/u);
  assert.match(analysisPrompt, /overallParticipantCapacity is the event-wide number/u);
  assert.match(analysisPrompt, /Waitlist only when exactly one criterion partly meets/u);
  assert.match(analysisPrompt, /Do not use waitlist as a safe default/u);
  assert.ok(ideaAgent.tools.includes("search_public_web"));
  assert.ok(ideaAgent.tools.includes("find_similar_ideas"));
  assert.ok(ideaAgent.tools.includes("publish_idea_analysis"));
});

test("idea analysis recovery cannot overlap a live durable submission", () => {
  assert.equal(ideaIntelligenceSubmissionTimeoutMs, 60 * 60 * 1_000);
  assert.ok(ideaIntelligenceRecoveryLeaseMs > ideaIntelligenceSubmissionTimeoutMs);
});
