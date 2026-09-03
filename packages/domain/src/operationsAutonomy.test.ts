import assert from "node:assert/strict";
import test from "node:test";

import {
  operationsIntelligenceProtocolVersion,
  operationsIntelligenceReadSignatureContext,
  operationsIntelligenceStreamCapability,
  operationsBriefStreamTicketSignatureContext,
  operationsCopilotStreamTicketSignatureContext,
  serializeOperationsIntelligenceStreamTicket,
} from "./intelligence.ts";
import {
  operationsAutonomyAdmissionSignatureMaximumAgeMs,
  operationsAutonomyAbortSignatureContext,
  operationsAutonomyContinuationSignatureContext,
  operationsAutonomyModes,
  operationsAutonomyPublicLifecycleOperations,
  operationsAutonomyPublicLifecycleRoles,
  operationsAutonomyPublicLifecycleStatuses,
  operationsAutonomyReadTools,
  operationsAutonomyReadSignatureContext,
  operationsAutonomyRecommendationSignatureContext,
  operationsAutonomyRecommendationEvidenceSignatureContext,
  operationsAutonomyRecommendationEvidenceChunkMaximumCitations,
  operationsAutonomyStreamTicketSignatureContext,
  operationsAutonomyWorkSignatureContext,
  operationsAutopilotInstanceId,
  type OperationsAutonomyContinuationRequest,
} from "./operationsAutonomy.ts";

test("autopilot tickets are run-scoped and use a distinct signature context", () => {
  const runId = "autonomy-run-id";
  const serialized = serializeOperationsIntelligenceStreamTicket({
    protocolVersion: operationsIntelligenceProtocolVersion,
    eventSlug: "code2create-7",
    instanceId: operationsAutopilotInstanceId({ runId }),
    agentName: "operations-autopilot",
    runId,
    capability: operationsIntelligenceStreamCapability,
    issuedAt: 1_000,
    expiresAt: 61_000,
    nonce: "nonce_789",
  });

  assert.match(serialized, /"runId":"autonomy-run-id"/u);
  assert.doesNotMatch(serialized, /briefId|conversationId/u);
  assert.notEqual(
    operationsAutonomyStreamTicketSignatureContext,
    operationsBriefStreamTicketSignatureContext,
  );
  assert.notEqual(
    operationsAutonomyStreamTicketSignatureContext,
    operationsCopilotStreamTicketSignatureContext,
  );
});

test("the first autonomy contract exposes no unattended execution mode", () => {
  assert.deepEqual(operationsAutonomyModes, ["observe", "recommend"]);
});

test("the autonomy read frontier is closed, modular, and excludes private conversation history", () => {
  assert.deepEqual(operationsAutonomyReadTools, [
    "operations_health",
    "operations_attention",
    "review_rounds",
    "review_exceptions",
    "attendance_counts",
    "support_load",
    "intake_jobs",
    "admission_jobs",
    "participant_deliveries",
    "integration_jobs",
    "round_export_jobs",
    "synesthesia_operations",
    "incident_readiness",
    "attendance_operations",
  ]);
  assert.equal(new Set(operationsAutonomyReadTools).size, operationsAutonomyReadTools.length);
  assert.doesNotMatch(JSON.stringify(operationsAutonomyReadTools), /recommendation_history/u);
});

test("the public autonomy trace has one closed content-free vocabulary", () => {
  assert.deepEqual(operationsAutonomyPublicLifecycleOperations, [
    "plan_operations",
    "read_operations_data",
    "investigate_area",
    "critique_plan",
    "propose_recommendation",
  ]);
  assert.equal(
    new Set(operationsAutonomyPublicLifecycleOperations).size,
    operationsAutonomyPublicLifecycleOperations.length,
  );
  assert.equal(
    new Set(operationsAutonomyPublicLifecycleRoles).size,
    operationsAutonomyPublicLifecycleRoles.length,
  );
  assert.deepEqual(operationsAutonomyPublicLifecycleStatuses, ["started", "completed", "failed"]);
});

test("autonomy boundaries have route-specific signature contexts", () => {
  const contexts = [
    operationsAutonomyAbortSignatureContext,
    operationsAutonomyContinuationSignatureContext,
    operationsAutonomyReadSignatureContext,
    operationsAutonomyRecommendationSignatureContext,
    operationsAutonomyRecommendationEvidenceSignatureContext,
    operationsAutonomyStreamTicketSignatureContext,
    operationsAutonomyWorkSignatureContext,
  ];

  assert.equal(new Set(contexts).size, contexts.length);
  assert.equal(contexts.includes(operationsIntelligenceReadSignatureContext), false);
});

test("recommendation evidence uses bounded chunks and an unbounded sealed chain", () => {
  assert.equal(operationsAutonomyRecommendationEvidenceChunkMaximumCitations, 4);
  assert.notEqual(
    operationsAutonomyRecommendationEvidenceSignatureContext,
    operationsAutonomyRecommendationSignatureContext,
  );
});

test("autonomy admission signatures have one shared short acceptance window", () => {
  assert.equal(operationsAutonomyAdmissionSignatureMaximumAgeMs, 30_000);
});

test("a continuation is bound to the settled Flue submission it follows", () => {
  const request: OperationsAutonomyContinuationRequest = {
    protocolVersion: operationsIntelligenceProtocolVersion,
    runId: "run_123",
    operationId: "callback:continuing:7",
    priorSubmissionId: "submission_7",
    workItemId: "work_8",
  };

  assert.equal(request.priorSubmissionId, "submission_7");
});
