import { operationsIntelligenceProtocolVersion } from "./intelligenceProtocol.ts";

export const operationsCopilotStreamTicketSignatureContext =
  "code2create.operations-copilot.stream-ticket.v1";
export const operationsBriefStreamTicketSignatureContext =
  "code2create.operations-brief.stream-ticket.v1";

export const operationsIntelligenceStreamAgentNames = [
  "operations-brief",
  "operations-copilot",
  "operations-autopilot",
] as const;
export type OperationsIntelligenceStreamAgentName =
  (typeof operationsIntelligenceStreamAgentNames)[number];
export const operationsIntelligenceStreamCapability = "read" as const;
export const operationsIntelligenceStreamTicketLifetimeMs = 60_000;
export const operationsIntelligenceStreamTicketHeaders = {
  ticket: "x-c2c-stream-ticket",
  timestamp: "x-c2c-timestamp",
  signature: "x-c2c-signature",
} as const;

type OperationsIntelligenceStreamTicketBase = {
  protocolVersion: typeof operationsIntelligenceProtocolVersion;
  eventSlug: string;
  instanceId: string;
  capability: typeof operationsIntelligenceStreamCapability;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

export type OperationsIntelligenceStreamTicket =
  | (OperationsIntelligenceStreamTicketBase & {
      agentName: "operations-brief";
      briefId: string;
    })
  | (OperationsIntelligenceStreamTicketBase & {
      agentName: "operations-copilot";
      conversationId: string;
    })
  | (OperationsIntelligenceStreamTicketBase & {
      agentName: "operations-autopilot";
      runId: string;
    });

export type OperationsIntelligenceStreamAccess = {
  conversationUrl: string;
  ticket: string;
  issuedAt: number;
  expiresAt: number;
  serverNow: number;
  signature: string;
};

export function serializeOperationsIntelligenceStreamTicket(
  ticket: OperationsIntelligenceStreamTicket,
) {
  const shared = {
    protocolVersion: ticket.protocolVersion,
    eventSlug: ticket.eventSlug,
    instanceId: ticket.instanceId,
    agentName: ticket.agentName,
    capability: ticket.capability,
    issuedAt: ticket.issuedAt,
    expiresAt: ticket.expiresAt,
    nonce: ticket.nonce,
  };
  if (ticket.agentName === "operations-brief") {
    return JSON.stringify({ ...shared, briefId: ticket.briefId });
  }
  if (ticket.agentName === "operations-copilot") {
    return JSON.stringify({ ...shared, conversationId: ticket.conversationId });
  }
  return JSON.stringify({ ...shared, runId: ticket.runId });
}

export function encodeOperationsIntelligenceStreamTicket(
  ticket: OperationsIntelligenceStreamTicket,
) {
  const bytes = new TextEncoder().encode(serializeOperationsIntelligenceStreamTicket(ticket));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
