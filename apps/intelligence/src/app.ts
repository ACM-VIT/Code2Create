import {
	operationsIntelligenceIngressSignatureContext,
	verifyServiceBody,
} from '@code2create/domain';
import { AgentInstanceExistsError, dispatch, instrument } from '@flue/runtime';
import { createCloudflareTracing } from '@flue/runtime/cloudflare';
import { Hono } from 'hono';
import * as v from 'valibot';

import { OperationsBrief } from './agents/operations-brief.ts';
import { operationsIntelligenceRequestSchema } from './protocol.ts';

const maximumBodyBytes = 64 * 1_024;
const maximumSignatureAgeMs = 5 * 60 * 1_000;

instrument(createCloudflareTracing({ content: false }));

const app = new Hono<{ Bindings: Cloudflare.Env }>();

app.get('/health', (context) => context.json({ ok: true }));

app.post('/v1/operations-briefs', async (context) => {
	if (context.req.header('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
		return context.json({ error: 'unsupported_media_type' }, 415);
	}
	const declaredLength = Number(context.req.header('content-length') ?? '0');
	if (Number.isFinite(declaredLength) && declaredLength > maximumBodyBytes) {
		return context.json({ error: 'payload_too_large' }, 413);
	}
	const body = await context.req.text();
	if (new TextEncoder().encode(body).byteLength > maximumBodyBytes) {
		return context.json({ error: 'payload_too_large' }, 413);
	}
	const verified = await verifyServiceBody({
		context: operationsIntelligenceIngressSignatureContext,
		secret: context.env.INTELLIGENCE_INGRESS_SECRET,
		timestamp: context.req.header('x-c2c-timestamp') ?? '',
		signature: context.req.header('x-c2c-signature') ?? '',
		body,
		now: Date.now(),
		maximumAgeMs: maximumSignatureAgeMs,
	});
	if (!verified) return context.json({ error: 'unauthorized' }, 401);
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		return context.json({ error: 'invalid_json' }, 400);
	}
	const parsed = v.safeParse(operationsIntelligenceRequestSchema, json);
	if (!parsed.success) return context.json({ error: 'invalid_request' }, 422);
	try {
		const receipt = await dispatch(OperationsBrief, {
			id: parsed.output.briefId,
			uid: null,
			initialData: parsed.output,
			message: {
				kind: 'signal',
				type: 'operations.health.snapshot',
				body: 'Prepare the bounded brief from this instance\'s frozen source snapshot.',
				attributes: {
					briefId: parsed.output.briefId,
					sourceChecksum: parsed.output.sourceChecksum,
				},
			},
		});
		return context.json(
			{
				state: 'accepted' as const,
				submissionId: receipt.submissionId,
				acceptedAt: receipt.acceptedAt,
			},
			202,
		);
	} catch (error) {
		if (error instanceof AgentInstanceExistsError) {
			return context.json({ state: 'already_exists' as const }, 202);
		}
		throw error;
	}
});

app.onError(() => new Response(JSON.stringify({ error: 'internal_error' }), {
	status: 500,
	headers: { 'content-type': 'application/json' },
}));

export default app;
