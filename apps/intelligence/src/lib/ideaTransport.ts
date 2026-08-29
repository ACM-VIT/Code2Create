import {
	ideaIntelligenceCallbackSignatureContext,
	ideaIntelligenceReadSignatureContext,
	operationsIntelligenceProtocolVersion,
	signServiceBody,
	type IdeaIntelligenceCallback,
} from '@code2create/domain';
import * as v from 'valibot';

import { readBoundedJsonResponse } from './boundedHttpBody.ts';
import {
	ideaIntelligenceProjectionSchema,
	type IdeaIntelligenceAnalysis,
	type IdeaIntelligenceProjection,
} from './ideaProtocol.ts';
import { requireStrongServiceSecret } from './serviceSecret.ts';
import { serviceUrl } from './serviceUrl.ts';

type IdeaReadBindings = Pick<
	Cloudflare.Env,
	'CONVEX_INTELLIGENCE_IDEA_READ_URL' | 'INTELLIGENCE_READ_SECRET'
>;

type IdeaCallbackBindings = Pick<
	Cloudflare.Env,
	'CONVEX_INTELLIGENCE_IDEA_CALLBACK_URL' | 'INTELLIGENCE_CALLBACK_SECRET'
>;

export async function readIdeaProjection(args: {
	applicationId: string;
	eventId: string;
	recommendationId?: string;
	operationId: string;
	bindings: IdeaReadBindings;
	request?: typeof fetch;
}): Promise<IdeaIntelligenceProjection> {
	const body = JSON.stringify({
		protocolVersion: operationsIntelligenceProtocolVersion,
		applicationId: args.applicationId,
		eventId: args.eventId,
		...(args.recommendationId === undefined ? {} : { recommendationId: args.recommendationId }),
		operationId: args.operationId,
	});
	const timestamp = String(Date.now());
	const signature = await signServiceBody({
		context: ideaIntelligenceReadSignatureContext,
		secret: requireStrongServiceSecret(
			args.bindings.INTELLIGENCE_READ_SECRET,
			'INTELLIGENCE_READ_SECRET',
		),
		timestamp,
		body,
	});
	const response = await (args.request ?? fetch)(
		serviceUrl(args.bindings.CONVEX_INTELLIGENCE_IDEA_READ_URL, 'Convex idea read'),
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
		throw new Error(`Convex refused the idea read with HTTP ${response.status}.`);
	}
	const parsed = v.safeParse(
		ideaIntelligenceProjectionSchema,
		await readBoundedJsonResponse(response, 128 * 1_024),
	);
	if (
		!parsed.success ||
		parsed.output.applicationId !== args.applicationId ||
		parsed.output.eventId !== args.eventId ||
		(
			args.recommendationId !== undefined &&
			parsed.output.recommendationId !== args.recommendationId
		)
	) {
		throw new Error('Convex returned an invalid idea projection.');
	}
	return parsed.output;
}

const callbackReceiptSchema = v.strictObject({
	state: v.picklist(['accepted', 'already_exists']),
});

export async function deliverIdeaAnalysis(args: {
	projection: IdeaIntelligenceProjection;
	analysis: IdeaIntelligenceAnalysis;
	operationId: string;
	agentVersion: string;
	model: string;
	bindings: IdeaCallbackBindings;
	request?: typeof fetch;
}) {
	const callback: IdeaIntelligenceCallback = {
		protocolVersion: operationsIntelligenceProtocolVersion,
		recommendationId: args.projection.recommendationId,
		applicationId: args.projection.applicationId,
		contentVersion: args.projection.contentVersion,
		sourceInputFingerprint: args.projection.sourceInputFingerprint,
		operationId: args.operationId,
		...args.analysis,
		agentVersion: args.agentVersion,
		model: args.model,
		completedAt: Date.now(),
	};
	const body = JSON.stringify(callback);
	const timestamp = String(Date.now());
	const signature = await signServiceBody({
		context: ideaIntelligenceCallbackSignatureContext,
		secret: requireStrongServiceSecret(
			args.bindings.INTELLIGENCE_CALLBACK_SECRET,
			'INTELLIGENCE_CALLBACK_SECRET',
		),
		timestamp,
		body,
	});
	const response = await (args.request ?? fetch)(
		serviceUrl(args.bindings.CONVEX_INTELLIGENCE_IDEA_CALLBACK_URL, 'Convex idea callback'),
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
		throw new Error(`Convex rejected the idea analysis with HTTP ${response.status}.`);
	}
	const receipt = v.safeParse(
		callbackReceiptSchema,
		await readBoundedJsonResponse(response, 8 * 1_024),
	);
	if (!receipt.success) throw new Error('Convex returned an invalid idea callback receipt.');
	return receipt.output;
}
