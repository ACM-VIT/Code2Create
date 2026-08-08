import {
	operationsIntelligenceCallbackSignatureContext,
	signServiceBody,
	type OperationsIntelligenceCallback,
} from '@code2create/domain';

type CallbackBindings = Pick<
	Cloudflare.Env,
	'CONVEX_INTELLIGENCE_CALLBACK_URL' | 'INTELLIGENCE_CALLBACK_SECRET'
>;

function callbackUrl(value: string) {
	const url = new URL(value);
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
		throw new Error('The Convex intelligence callback must use HTTPS outside local development.');
	}
	return url;
}

export async function deliverCallback(
	payload: OperationsIntelligenceCallback,
	bindings: CallbackBindings,
	request: typeof fetch = fetch,
) {
	const body = JSON.stringify(payload);
	const timestamp = Date.now().toString();
	const signature = await signServiceBody({
		context: operationsIntelligenceCallbackSignatureContext,
		secret: bindings.INTELLIGENCE_CALLBACK_SECRET,
		timestamp,
		body,
	});
	const response = await request(callbackUrl(bindings.CONVEX_INTELLIGENCE_CALLBACK_URL), {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-c2c-signature': signature,
			'x-c2c-timestamp': timestamp,
		},
		body,
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) {
		throw new Error(`Convex rejected the intelligence callback with HTTP ${response.status}.`);
	}
	return { delivered: true } as const;
}
