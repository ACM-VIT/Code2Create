import {
	encodeOperationsIntelligenceStreamTicket,
	operationsCopilotInstanceId,
	operationsCopilotStreamTicketSignatureContext,
	operationsIntelligenceProtocolVersion,
	operationsIntelligenceStreamTicketHeaders,
	serializeOperationsIntelligenceStreamTicket,
	signServiceBody,
	type OperationsIntelligenceStreamTicket,
} from '@code2create/domain';
import { describe, expect, test } from 'vitest';

import { verifyIntelligenceStreamTicket } from './streamTicket.ts';

const secret = 's'.repeat(64);
const now = 1_800_000_000_000;
const conversationId = `cv_${'a'.repeat(64)}`;
const instanceId = operationsCopilotInstanceId({
	eventSlug: 'code2create-7',
	conversationId,
});

async function requestFor(issuedAt: number) {
	const ticket: OperationsIntelligenceStreamTicket = {
		protocolVersion: operationsIntelligenceProtocolVersion,
		eventSlug: 'code2create-7',
		instanceId,
		agentName: 'operations-copilot',
		capability: 'read',
		issuedAt,
		expiresAt: issuedAt + 60_000,
		nonce: 'nonce_1234567890abcdef',
		conversationId,
	};
	const body = serializeOperationsIntelligenceStreamTicket(ticket);
	const timestamp = String(issuedAt);
	const signature = await signServiceBody({
		context: operationsCopilotStreamTicketSignatureContext,
		secret,
		timestamp,
		body,
	});
	return new Request(`https://worker.example.test/${encodeURIComponent(instanceId)}`, {
		headers: {
			[operationsIntelligenceStreamTicketHeaders.ticket]:
				encodeOperationsIntelligenceStreamTicket(ticket),
			[operationsIntelligenceStreamTicketHeaders.timestamp]: timestamp,
			[operationsIntelligenceStreamTicketHeaders.signature]: signature,
		},
	});
}

	describe('intelligence stream tickets', () => {
	test('allows only the explicit five-second issuer clock-skew window', async () => {
		const inside = await requestFor(now);
		const outside = await requestFor(now + 5_001);
		const verify = (request: Request) => verifyIntelligenceStreamTicket({
			request,
			secret,
			signatureContext: operationsCopilotStreamTicketSignatureContext,
			agentName: 'operations-copilot',
			routeInstanceId: instanceId,
			now,
		});

		await expect(verify(inside)).resolves.not.toBeNull();
		await expect(verify(outside)).resolves.toBeNull();
	});

	test('never grants more than sixty seconds from verification time', async () => {
		const futureIssued = await requestFor(now + 5_000);

		await expect(verifyIntelligenceStreamTicket({
			request: futureIssued,
			secret,
			signatureContext: operationsCopilotStreamTicketSignatureContext,
			agentName: 'operations-copilot',
			routeInstanceId: instanceId,
			now,
		})).resolves.toBeNull();
	});
});
