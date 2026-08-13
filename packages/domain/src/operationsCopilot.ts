import { operationsIntelligenceProtocolVersion } from "./intelligenceProtocol.ts";
import { signServiceBody } from "./intelligenceSigning.ts";

export const operationsCopilotIngressSignatureContext =
  "code2create.operations-copilot.ingress.v1";
export const operationsCopilotRecommendationSignatureContext =
  "code2create.operations-copilot.recommendation.v1";
export const operationsCopilotConversationIdSignatureContext =
  "code2create.operations-copilot.conversation-id.v1";

export type OperationsCopilotTurnReceipt = {
  state: "accepted";
  conversationId: string;
  instanceId: string;
  submissionId: string;
  acceptedAt: string;
  uid: string;
  deduplicated: boolean;
};

export function operationsCopilotConversationIdentity(args: {
  eventId: string;
  eventAccessSubjectId: string;
}) {
  return JSON.stringify({
    protocolVersion: operationsIntelligenceProtocolVersion,
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
  });
}

export async function deriveOperationsCopilotConversationId(args: {
  secret: string;
  eventId: string;
  eventAccessSubjectId: string;
}) {
  const digest = await signServiceBody({
    context: operationsCopilotConversationIdSignatureContext,
    secret: args.secret,
    timestamp: "0",
    body: operationsCopilotConversationIdentity(args),
  });
  return `cv_${digest}`;
}

export function operationsCopilotInstanceId(args: {
  eventSlug: string;
  conversationId: string;
}) {
  return `copilot:${args.eventSlug}:${args.conversationId}`;
}
