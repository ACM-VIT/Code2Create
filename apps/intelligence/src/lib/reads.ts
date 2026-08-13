import {
	operationsCopilotRecommendationSignatureContext,
	operationsIntelligenceProtocolVersion,
	operationsIntelligenceReadSignatureContext,
	signServiceBody,
	type OperationsIntelligenceReadRequest,
	type OperationsIntelligenceReadName,
} from '@code2create/domain';
import * as v from 'valibot';

import {
	platformReadEnvelopeSchema,
	platformReadSchemas,
	type CopilotProposal,
} from '../protocol.ts';
import { readBoundedJsonResponse } from './boundedHttpBody.ts';
import { requireStrongServiceSecret } from './serviceSecret.ts';
import { serviceUrl } from './serviceUrl.ts';

type ReadBindings = Pick<
	Cloudflare.Env,
	'CONVEX_INTELLIGENCE_READ_URL' | 'INTELLIGENCE_READ_SECRET'
>;

type ProposalBindings = Pick<
	Cloudflare.Env,
	'CONVEX_INTELLIGENCE_RECOMMENDATION_URL' | 'INTELLIGENCE_CALLBACK_SECRET'
>;

const maximumPlatformReadResponseBytes = 256 * 1_024;

export type PlatformReadResult = v.InferOutput<
	(typeof platformReadSchemas)[OperationsIntelligenceReadName]
>;

/** Performs one signed, whitelisted platform read and validates its response. */
export async function performPlatformRead(
	name: OperationsIntelligenceReadName,
	context: { eventSlug: string; conversationId: string },
	bindings: ReadBindings,
	request: typeof fetch = fetch,
): Promise<PlatformReadResult> {
	const secret = requireStrongServiceSecret(
		bindings.INTELLIGENCE_READ_SECRET,
		'INTELLIGENCE_READ_SECRET',
	);
	const readRequest: OperationsIntelligenceReadRequest = name === 'recommendation_history'
		? {
			protocolVersion: operationsIntelligenceProtocolVersion,
			read: name,
			eventSlug: context.eventSlug,
			conversationId: context.conversationId,
		}
		: {
			protocolVersion: operationsIntelligenceProtocolVersion,
			read: name,
			eventSlug: context.eventSlug,
		};
	const body = JSON.stringify(readRequest);
	const timestamp = Date.now().toString();
	const signature = await signServiceBody({
		context: operationsIntelligenceReadSignatureContext,
		secret,
		timestamp,
		body,
	});
	const response = await request(
		serviceUrl(bindings.CONVEX_INTELLIGENCE_READ_URL, 'Convex intelligence read'),
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
	if (response.status !== 200) {
		throw new Error(`Convex refused the ${name} read with HTTP ${response.status}.`);
	}
	const parsedEnvelope = v.safeParse(
		platformReadEnvelopeSchema,
		await readBoundedJsonResponse(response, maximumPlatformReadResponseBytes),
	);
	if (!parsedEnvelope.success) {
		throw new Error(`The Convex ${name} read envelope is invalid.`);
	}
	const envelope = parsedEnvelope.output;
	if (envelope.read !== name) {
		throw new Error(`Convex answered the ${name} read with ${envelope.read} data.`);
	}
	const parsedData = v.safeParse(platformReadSchemas[name], envelope.data);
	if (!parsedData.success) {
		throw new Error(`The Convex ${name} read data is invalid.`);
	}
	return parsedData.output;
}

const proposalReceiptSchema = v.strictObject({
	state: v.picklist(['accepted', 'already_exists']),
});

export type ProposalReceipt = v.InferOutput<typeof proposalReceiptSchema>;

/** Delivers a proposed row; Convex deduplicates at-least-once tool retries. */
export async function deliverProposal(
	proposal: CopilotProposal,
	bindings: ProposalBindings,
	request: typeof fetch = fetch,
): Promise<ProposalReceipt> {
	const secret = requireStrongServiceSecret(
		bindings.INTELLIGENCE_CALLBACK_SECRET,
		'INTELLIGENCE_CALLBACK_SECRET',
	);
	const body = JSON.stringify(proposal);
	const timestamp = Date.now().toString();
	const signature = await signServiceBody({
		context: operationsCopilotRecommendationSignatureContext,
		secret,
		timestamp,
		body,
	});
	const response = await request(
		serviceUrl(bindings.CONVEX_INTELLIGENCE_RECOMMENDATION_URL, 'Convex recommendation'),
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
	if (response.status !== 202) {
		throw new Error(`Convex rejected the recommendation proposal with HTTP ${response.status}.`);
	}
	const receipt = v.safeParse(
		proposalReceiptSchema,
		await readBoundedJsonResponse(response, 8 * 1_024),
	);
	if (!receipt.success) {
		throw new Error('The Convex recommendation receipt is invalid.');
	}
	return receipt.output;
}
