import {
	operationsCopilotRecommendationSignatureContext,
	operationsIntelligenceProtocolVersion,
	operationsIntelligenceReadSignatureContext,
	signServiceBody,
	type OperationsIntelligenceReadName,
} from '@code2create/domain';
import * as v from 'valibot';

import {
	platformReadEnvelopeSchema,
	platformReadSchemas,
	type CopilotProposal,
} from '../protocol.ts';

type ReadBindings = Pick<
	Cloudflare.Env,
	'CONVEX_INTELLIGENCE_READ_URL' | 'INTELLIGENCE_READ_SECRET'
>;

type ProposalBindings = Pick<
	Cloudflare.Env,
	'CONVEX_INTELLIGENCE_RECOMMENDATION_URL' | 'INTELLIGENCE_CALLBACK_SECRET'
>;

function serviceUrl(value: string, label: string) {
	const url = new URL(value);
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
		throw new Error(`The Convex ${label} endpoint must use HTTPS outside local development.`);
	}
	return url;
}

export type PlatformReadResult = v.InferOutput<
	(typeof platformReadSchemas)[OperationsIntelligenceReadName]
>;

/**
 * Ask Convex for one whitelisted read. The request names the read and the
 * event and nothing else — there is no query language on this boundary — and
 * the response is re-parsed against the read's declared shape before any of
 * it can reach a model, so the platform's redaction contract is checked on
 * both sides of the wire.
 */
export async function performPlatformRead(
	name: OperationsIntelligenceReadName,
	eventSlug: string,
	bindings: ReadBindings,
	request: typeof fetch = fetch,
): Promise<PlatformReadResult> {
	const body = JSON.stringify({
		protocolVersion: operationsIntelligenceProtocolVersion,
		read: name,
		eventSlug,
	});
	const timestamp = Date.now().toString();
	const signature = await signServiceBody({
		context: operationsIntelligenceReadSignatureContext,
		secret: bindings.INTELLIGENCE_READ_SECRET,
		timestamp,
		body,
	});
	const response = await request(
		serviceUrl(bindings.CONVEX_INTELLIGENCE_READ_URL, 'intelligence read'),
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-c2c-signature': signature,
				'x-c2c-timestamp': timestamp,
			},
			body,
			signal: AbortSignal.timeout(20_000),
		},
	);
	if (!response.ok) {
		throw new Error(`Convex refused the ${name} read with HTTP ${response.status}.`);
	}
	const envelope = v.parse(platformReadEnvelopeSchema, await response.json());
	if (envelope.read !== name) {
		throw new Error(`Convex answered the ${name} read with ${envelope.read} data.`);
	}
	return v.parse(platformReadSchemas[name], envelope.data);
}

const proposalReceiptSchema = v.strictObject({
	state: v.picklist(['accepted', 'already_exists']),
});

export type ProposalReceipt = v.InferOutput<typeof proposalReceiptSchema>;

/**
 * Deliver one recommendation proposal for human triage. This is the copilot's
 * only write path, and it is not a write to event state: Convex records a
 * `proposed` row and every state it could ever move to belongs to a signed-in
 * operator's mutations. Delivery is at-least-once under durable-tool retry,
 * so Convex deduplicates on the proposal key.
 */
export async function deliverProposal(
	proposal: CopilotProposal,
	bindings: ProposalBindings,
	request: typeof fetch = fetch,
): Promise<ProposalReceipt> {
	const body = JSON.stringify(proposal);
	const timestamp = Date.now().toString();
	const signature = await signServiceBody({
		context: operationsCopilotRecommendationSignatureContext,
		secret: bindings.INTELLIGENCE_CALLBACK_SECRET,
		timestamp,
		body,
	});
	const response = await request(
		serviceUrl(bindings.CONVEX_INTELLIGENCE_RECOMMENDATION_URL, 'recommendation'),
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-c2c-signature': signature,
				'x-c2c-timestamp': timestamp,
			},
			body,
			signal: AbortSignal.timeout(20_000),
		},
	);
	if (!response.ok) {
		throw new Error(`Convex rejected the recommendation proposal with HTTP ${response.status}.`);
	}
	return v.parse(proposalReceiptSchema, await response.json());
}
