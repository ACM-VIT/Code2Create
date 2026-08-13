import {
	operationsCopilotInstanceId,
	operationsCopilotIngressSignatureContext,
	verifyServiceBody,
	type OperationsCopilotTurnReceipt,
} from '@code2create/domain';
import { init, SubmissionConflictError, type DispatchReceipt } from '@flue/runtime';
import { Hono } from 'hono';
import * as v from 'valibot';

import { OperationsCopilot } from '../agents/operations-copilot.ts';
import {
	HttpBodyInvalidEncodingError,
	HttpBodyTooLargeError,
	readBoundedRequestText,
} from '../lib/boundedHttpBody.ts';
import { OperationDeadlineError, settleWithin } from '../lib/deadline.ts';
import { requireStrongServiceSecret } from '../lib/serviceSecret.ts';
import { operationsCopilotRequestSchema } from '../protocol.ts';

const maximumBodyBytes = 16 * 1_024;
const maximumSignatureAgeMs = 5 * 60 * 1_000;
const admissionWaitMs = 10_000;

export const copilotRoutes = new Hono<{ Bindings: Cloudflare.Env }>();

copilotRoutes.post('/v1/operations-copilot/turns', async (context) => {
	if (context.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
		return context.json({ error: 'unsupported_media_type' }, 415);
	}
	let body: string;
	try {
		body = await readBoundedRequestText(context.req.raw, maximumBodyBytes);
	} catch (error) {
		if (error instanceof HttpBodyTooLargeError) {
			return context.json({ error: 'payload_too_large' }, 413);
		}
		if (error instanceof HttpBodyInvalidEncodingError) {
			return context.json({ error: 'invalid_encoding' }, 400);
		}
		throw error;
	}
	const verified = await verifyServiceBody({
		context: operationsCopilotIngressSignatureContext,
		secret: requireStrongServiceSecret(
			context.env.INTELLIGENCE_INGRESS_SECRET,
			'INTELLIGENCE_INGRESS_SECRET',
		),
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
	const instanceId = operationsCopilotInstanceId({
		eventSlug: parsed.output.eventSlug,
		conversationId: parsed.output.conversationId,
	});
	const handle = init(OperationsCopilot, { id: instanceId });
	let receipt: DispatchReceipt;
	try {
		receipt = await settleWithin(handle.dispatch({
			initialData: {
				conversationId: parsed.output.conversationId,
				eventSlug: parsed.output.eventSlug,
			},
			idempotencyKey: parsed.output.turnId,
			message: { kind: 'user', body: parsed.output.message },
		}), admissionWaitMs);
	} catch (error) {
		if (error instanceof OperationDeadlineError) {
			return context.json({ error: 'service_unavailable' }, 503, { 'retry-after': '1' });
		}
		if (error instanceof SubmissionConflictError) {
			return context.json({ error: 'turn_conflict', submissionId: error.submissionId }, 409);
		}
		throw error;
	}
	const response: OperationsCopilotTurnReceipt = {
		state: 'accepted',
		conversationId: parsed.output.conversationId,
		instanceId,
		submissionId: receipt.submissionId,
		acceptedAt: receipt.acceptedAt,
		uid: receipt.uid,
		deduplicated: receipt.deduplicated === true,
	};
	return context.json(response, 202);
});
