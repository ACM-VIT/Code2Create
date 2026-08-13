import {
	operationsIntelligenceCallbackSignatureContext,
	signServiceBody,
	type OperationsIntelligenceCallback,
} from '@code2create/domain';
import * as v from 'valibot';

import { readBoundedJsonResponse } from './boundedHttpBody.ts';
import { requireStrongServiceSecret } from './serviceSecret.ts';
import { serviceUrl } from './serviceUrl.ts';

type CallbackBindings = Pick<
	Cloudflare.Env,
	'CONVEX_INTELLIGENCE_CALLBACK_URL' | 'INTELLIGENCE_CALLBACK_SECRET'
>;

const callbackReceiptSchema = v.strictObject({
	state: v.picklist(['accepted', 'already_settled']),
});

export async function deliverCallback(
	payload: OperationsIntelligenceCallback,
	bindings: CallbackBindings,
	request: typeof fetch = fetch,
) {
	const secret = requireStrongServiceSecret(
		bindings.INTELLIGENCE_CALLBACK_SECRET,
		'INTELLIGENCE_CALLBACK_SECRET',
	);
	const body = JSON.stringify(payload);
	const timestamp = Date.now().toString();
	const signature = await signServiceBody({
		context: operationsIntelligenceCallbackSignatureContext,
		secret,
		timestamp,
		body,
	});
	const response = await request(
		serviceUrl(bindings.CONVEX_INTELLIGENCE_CALLBACK_URL, 'Convex intelligence callback'),
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
		throw new Error(`Convex rejected the intelligence callback with HTTP ${response.status}.`);
	}
	const receipt = v.safeParse(
		callbackReceiptSchema,
		await readBoundedJsonResponse(response, 8 * 1_024),
	);
	if (!receipt.success) {
		throw new Error('The Convex intelligence callback receipt is invalid.');
	}
	return { delivered: true } as const;
}
