import {
	operationsCopilotIngressSignatureContext,
	operationsIntelligenceIngressSignatureContext,
	verifyServiceBody,
} from '@code2create/domain';
import { AgentInstanceExistsError, AgentRunError, dispatch, init, instrument } from '@flue/runtime';
import { createCloudflareTracing } from '@flue/runtime/cloudflare';
import { Hono } from 'hono';
import * as v from 'valibot';

import { OperationsBrief } from './agents/operations-brief.ts';
import { OperationsCopilot } from './agents/operations-copilot.ts';
import {
	operationsCopilotRequestSchema,
	operationsIntelligenceRequestSchema,
} from './protocol.ts';

const maximumBodyBytes = 64 * 1_024;
const maximumCopilotBodyBytes = 16 * 1_024;
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

app.post('/v1/operations-copilot/turns', async (context) => {
	if (context.req.header('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
		return context.json({ error: 'unsupported_media_type' }, 415);
	}
	const declaredLength = Number(context.req.header('content-length') ?? '0');
	if (Number.isFinite(declaredLength) && declaredLength > maximumCopilotBodyBytes) {
		return context.json({ error: 'payload_too_large' }, 413);
	}
	const body = await context.req.text();
	if (new TextEncoder().encode(body).byteLength > maximumCopilotBodyBytes) {
		return context.json({ error: 'payload_too_large' }, 413);
	}
	// Same ingress secret as the brief route, but a distinct signature context:
	// a captured brief dispatch can never be replayed as a conversation turn.
	const verified = await verifyServiceBody({
		context: operationsCopilotIngressSignatureContext,
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
	const parsed = v.safeParse(operationsCopilotRequestSchema, json);
	if (!parsed.success) return context.json({ error: 'invalid_request' }, 422);
	// The instance id binds the conversation to its event, so a later turn for
	// the same conversation id but another event addresses a different
	// instance instead of quietly changing this one's subject. Initial data
	// only seeds the instance on the send that creates it.
	const handle = init(OperationsCopilot, {
		id: `copilot:${parsed.output.eventSlug}:${parsed.output.conversationId}`,
	});
	const receipt = await handle.dispatch({
		initialData: {
			conversationId: parsed.output.conversationId,
			eventSlug: parsed.output.eventSlug,
		},
		message: { kind: 'user', body: parsed.output.message },
	});
	try {
		const reply = await handle.read(receipt);
		return context.json(
			{
				state: 'replied' as const,
				submissionId: receipt.submissionId,
				reply: reply.text,
			},
			200,
		);
	} catch (error) {
		if (error instanceof AgentRunError) {
			return context.json(
				{ state: 'failed' as const, outcome: error.outcome, submissionId: error.submissionId },
				502,
			);
		}
		throw error;
	}
});

app.onError(() => new Response(JSON.stringify({ error: 'internal_error' }), {
	status: 500,
	headers: { 'content-type': 'application/json' },
}));

export default app;
