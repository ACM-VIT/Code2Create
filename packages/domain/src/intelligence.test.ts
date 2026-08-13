import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveOperationsCopilotConversationId,
  encodeOperationsIntelligenceStreamTicket,
  operationsCopilotInstanceId,
  operationsIntelligenceStreamCapability,
  operationsIntelligenceStreamTicketHeaders,
  operationsIntelligenceProtocolVersion,
  operationsIntelligenceReadSignatureContext,
  operationsBriefStreamTicketSignatureContext,
  operationsCopilotStreamTicketSignatureContext,
  serializeOperationsIntelligenceStreamTicket,
  signServiceBody,
  verifyServiceBody,
} from "./intelligence.ts";

const signingSecret = "s".repeat(32);

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
    agentName: 'operations-copilot' as const,
    capability: operationsIntelligenceStreamCapability,
    issuedAt: 1_000,
    expiresAt: 61_000,
    nonce: "nonce_123",
  };
  const serialized = serializeOperationsIntelligenceStreamTicket(ticket);

  assert.equal(
    serialized,
    '{"protocolVersion":"2026-08-13","eventSlug":"code2create-7","instanceId":"copilot:code2create-7:cv_abc","agentName":"operations-copilot","capability":"read","issuedAt":1000,"expiresAt":61000,"nonce":"nonce_123","conversationId":"cv_abc"}',
  );
  assert.equal(
    Buffer.from(encodeOperationsIntelligenceStreamTicket(ticket), "base64url").toString("utf8"),
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
