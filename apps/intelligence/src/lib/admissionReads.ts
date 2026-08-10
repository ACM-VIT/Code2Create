import {
	admissionIntelligenceReadSignatureContext,
	operationsIntelligenceProtocolVersion,
	signServiceBody,
	type AdmissionIntelligenceReadName,
} from '@code2create/domain';
import * as v from 'valibot';

import { admissionReadEnvelopeSchema, admissionReadSchemas } from '../protocol.ts';

type AdmissionReadBindings = Pick<
	Cloudflare.Env,
	'CONVEX_INTELLIGENCE_READ_URL' | 'INTELLIGENCE_READ_SECRET'
>;

export type AdmissionReadParameters = {
	capacityPeople?: number;
	query?: string;
	limit?: number;
};

/**
 * The admission reads live beside the operations reads on the same Convex
 * deployment, so their route is derived from the one configured read URL
 * rather than a second binding: the last path segment `operations-reads`
 * becomes `admission-reads`. Trailing slashes are stripped first so a
 * configuration written either way resolves to the same route.
 */
function admissionReadUrl(configured: string) {
	const url = new URL(configured);
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
		throw new Error('The Convex admission read endpoint must use HTTPS outside local development.');
	}
	url.pathname = url.pathname.replace(/\/+$/u, '');
	return new URL('admission-reads', url);
}

export type AdmissionReadResult = v.InferOutput<
	(typeof admissionReadSchemas)[AdmissionIntelligenceReadName]
>;

/**
 * Ask Convex for one whitelisted admission read. Identical discipline to
 * `performPlatformRead`: the request names the read, the event, and bounded
 * parameters — no query language crosses this boundary — it is signed under
 * this route's own context with the shared read secret, and the response is
 * re-parsed against the read's declared shape before any of it can reach a
 * model.
 */
export async function performAdmissionRead(
	name: AdmissionIntelligenceReadName,
	eventSlug: string,
	parameters: AdmissionReadParameters,
	bindings: AdmissionReadBindings,
	request: typeof fetch = fetch,
): Promise<AdmissionReadResult> {
	const body = JSON.stringify({
		protocolVersion: operationsIntelligenceProtocolVersion,
		read: name,
		eventSlug,
		...(parameters.capacityPeople !== undefined
			? { capacityPeople: parameters.capacityPeople }
			: {}),
		...(parameters.query !== undefined ? { query: parameters.query } : {}),
		...(parameters.limit !== undefined ? { limit: parameters.limit } : {}),
	});
	const timestamp = Date.now().toString();
	const signature = await signServiceBody({
		context: admissionIntelligenceReadSignatureContext,
		secret: bindings.INTELLIGENCE_READ_SECRET,
		timestamp,
		body,
	});
	const response = await request(admissionReadUrl(bindings.CONVEX_INTELLIGENCE_READ_URL), {
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
		throw new Error(`Convex refused the ${name} read with HTTP ${response.status}.`);
	}
	const envelope = v.parse(admissionReadEnvelopeSchema, await response.json());
	if (envelope.read !== name) {
		throw new Error(`Convex answered the ${name} read with ${envelope.read} data.`);
	}
	return v.parse(admissionReadSchemas[name], envelope.data);
}
