import {
	encodeOperationsIntelligenceStreamTicket,
	operationsAutopilotInstanceId,
	operationsCopilotInstanceId,
	operationsIntelligenceProtocolVersion,
	operationsIntelligenceStreamCapability,
	operationsIntelligenceStreamTicketHeaders,
	operationsIntelligenceStreamTicketLifetimeMs,
	serializeOperationsIntelligenceStreamTicket,
	verifyServiceBody,
	type OperationsIntelligenceStreamAgentName,
	type OperationsIntelligenceStreamTicket,
} from '@code2create/domain';
import * as v from 'valibot';

import { requireStrongServiceSecret } from './serviceSecret.ts';

const boundedString = (minimum: number, maximum: number) =>
	v.pipe(v.string(), v.minLength(minimum), v.maxLength(maximum));

const eventSlug = v.pipe(
	boundedString(1, 120),
	v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
);
const conversationId = v.pipe(v.string(), v.regex(/^cv_[a-f0-9]{64}$/u));
const instanceId = v.pipe(
	boundedString(1, 400),
	v.regex(/^[A-Za-z0-9:_-]+$/u),
);
const briefId = v.pipe(boundedString(1, 64), v.regex(/^[A-Za-z0-9_-]+$/u));
const runId = v.pipe(boundedString(1, 64), v.regex(/^[A-Za-z0-9_-]+$/u));
const nonce = v.pipe(
	boundedString(16, 128),
	v.regex(/^[A-Za-z0-9_-]+$/u),
);
const timestamp = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

const streamTicketSchema = v.variant('agentName', [
	v.strictObject({
		protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
		eventSlug,
		instanceId,
		agentName: v.literal('operations-brief'),
		capability: v.literal(operationsIntelligenceStreamCapability),
		issuedAt: timestamp,
		expiresAt: timestamp,
		nonce,
		briefId,
	}),
	v.strictObject({
		protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
		eventSlug,
		instanceId,
		agentName: v.literal('operations-copilot'),
		capability: v.literal(operationsIntelligenceStreamCapability),
		issuedAt: timestamp,
		expiresAt: timestamp,
		nonce,
		conversationId,
	}),
	v.strictObject({
		protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
		eventSlug,
		instanceId,
		agentName: v.literal('operations-autopilot'),
		capability: v.literal(operationsIntelligenceStreamCapability),
		issuedAt: timestamp,
		expiresAt: timestamp,
		nonce,
		runId,
	}),
]);

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const maximumIssuerClockSkewMs = 5_000;

function decodeTicket(value: string): unknown {
	if (value.length > 4_096 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
		throw new Error('Invalid stream ticket encoding.');
	}
	const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
	const binary = atob(padded);
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	return JSON.parse(decoder.decode(bytes));
}

function hasValidIdentity(
	ticket: OperationsIntelligenceStreamTicket,
	agentName: OperationsIntelligenceStreamAgentName,
	routeInstanceId: string,
) {
	if (ticket.agentName !== agentName || ticket.instanceId !== routeInstanceId) return false;
	if (ticket.agentName === 'operations-brief') {
		return ticket.briefId === routeInstanceId;
	}
	if (ticket.agentName === 'operations-copilot') {
		return ticket.instanceId === operationsCopilotInstanceId({
			eventSlug: ticket.eventSlug,
			conversationId: ticket.conversationId,
		});
	}
	return ticket.instanceId === operationsAutopilotInstanceId({ runId: ticket.runId });
}

export async function verifyIntelligenceStreamTicket(args: {
	request: Request;
	secret: string;
	signatureContext: string;
	agentName: OperationsIntelligenceStreamAgentName;
	routeInstanceId: string;
	now: number;
}): Promise<OperationsIntelligenceStreamTicket | null> {
	const secret = requireStrongServiceSecret(
		args.secret,
		'INTELLIGENCE_STREAM_SECRET',
	);
	const encoded = args.request.headers.get(operationsIntelligenceStreamTicketHeaders.ticket);
	const timestampHeader = args.request.headers.get(
		operationsIntelligenceStreamTicketHeaders.timestamp,
	);
	const signature = args.request.headers.get(
		operationsIntelligenceStreamTicketHeaders.signature,
	);
	if (encoded === null || timestampHeader === null || signature === null) return null;

	let decoded: unknown;
	try {
		decoded = decodeTicket(encoded);
	} catch {
		return null;
	}
	const parsed = v.safeParse(streamTicketSchema, decoded);
	if (!parsed.success) return null;
	const ticket: OperationsIntelligenceStreamTicket = parsed.output;
	if (
		encodeOperationsIntelligenceStreamTicket(ticket) !== encoded ||
		timestampHeader !== String(ticket.issuedAt) ||
		ticket.issuedAt > args.now + maximumIssuerClockSkewMs ||
		ticket.expiresAt <= args.now ||
		ticket.expiresAt <= ticket.issuedAt ||
		ticket.expiresAt - ticket.issuedAt > operationsIntelligenceStreamTicketLifetimeMs ||
		ticket.expiresAt - args.now > operationsIntelligenceStreamTicketLifetimeMs ||
		!hasValidIdentity(ticket, args.agentName, args.routeInstanceId)
	) {
		return null;
	}

	const body = serializeOperationsIntelligenceStreamTicket(ticket);
	const verified = await verifyServiceBody({
		context: args.signatureContext,
		secret,
		timestamp: timestampHeader,
		signature,
		body,
		now: args.now,
		maximumAgeMs: operationsIntelligenceStreamTicketLifetimeMs,
	});
	return verified ? ticket : null;
}
