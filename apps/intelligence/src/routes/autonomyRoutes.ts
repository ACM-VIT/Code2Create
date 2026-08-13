import {
	operationsAutonomyAdmissionSignatureMaximumAgeMs,
	operationsAutonomyAbortSignatureContext,
	operationsAutonomyContinuationSignatureContext,
	operationsAutonomyIngressSignatureContext,
	verifyServiceBody,
	type OperationsAutonomyContinuationReceipt,
	type OperationsAutonomyTurnReceipt,
} from '@code2create/domain';
import { Hono } from 'hono';
import * as v from 'valibot';

import { admissionControllerForRun } from '../lib/autonomyAdmissionController.ts';
import { clearAutonomyRun } from '../lib/autonomyContext.ts';
import {
	operationsAutonomyAbortRequestSchema,
	operationsAutonomyContinuationRequestSchema,
	operationsAutonomyDispatchRequestSchema,
} from '../lib/autonomyProtocol.ts';
import {
	HttpBodyInvalidEncodingError,
	HttpBodyTooLargeError,
	readBoundedRequestText,
} from '../lib/boundedHttpBody.ts';
import { OperationDeadlineError, settleWithin } from '../lib/deadline.ts';
import { requireStrongServiceSecret } from '../lib/serviceSecret.ts';

const maximumAdmissionBodyBytes = 96 * 1_024;
const maximumControlBodyBytes = 16 * 1_024;
const abortSignatureMaximumAgeMs = 5 * 60 * 1_000;
const admissionWaitMs = 10_000;

async function readJsonBody(
	request: Request,
	maximumBytes: number,
): Promise<{ state: 'accepted'; body: string } | {
	state: 'error';
	response: Response;
}> {
	if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
		return {
			state: 'error',
			response: Response.json({ error: 'unsupported_media_type' }, { status: 415 }),
		};
	}
	try {
		return {
			state: 'accepted',
			body: await readBoundedRequestText(request, maximumBytes),
		};
	} catch (error) {
		if (error instanceof HttpBodyTooLargeError) {
			return {
				state: 'error',
				response: Response.json({ error: 'payload_too_large' }, { status: 413 }),
			};
		}
		if (error instanceof HttpBodyInvalidEncodingError) {
			return {
				state: 'error',
				response: Response.json({ error: 'invalid_encoding' }, { status: 400 }),
			};
		}
		throw error;
	}
}

function parsedJson(body: string) {
	try {
		const value: unknown = JSON.parse(body);
		return { state: 'accepted' as const, value };
	} catch {
		return { state: 'error' as const };
	}
}

function unavailable() {
	return Response.json(
		{ error: 'service_unavailable' },
		{ status: 503, headers: { 'retry-after': '1' } },
	);
}

export const autonomyRoutes = new Hono<{ Bindings: Cloudflare.Env }>();

autonomyRoutes.post('/v1/operations-autonomy-runs', async (context) => {
	const read = await readJsonBody(context.req.raw, maximumAdmissionBodyBytes);
	if (read.state === 'error') return read.response;
	const verified = await verifyServiceBody({
		context: operationsAutonomyIngressSignatureContext,
		secret: requireStrongServiceSecret(
			context.env.INTELLIGENCE_INGRESS_SECRET,
			'INTELLIGENCE_INGRESS_SECRET',
		),
		timestamp: context.req.header('x-c2c-timestamp') ?? '',
		signature: context.req.header('x-c2c-signature') ?? '',
		body: read.body,
		now: Date.now(),
		maximumAgeMs: operationsAutonomyAdmissionSignatureMaximumAgeMs,
	});
	if (!verified) return context.json({ error: 'unauthorized' }, 401);
	const json = parsedJson(read.body);
	if (json.state === 'error') return context.json({ error: 'invalid_json' }, 400);
	const parsed = v.safeParse(operationsAutonomyDispatchRequestSchema, json.value);
	if (!parsed.success) return context.json({ error: 'invalid_request' }, 422);
	let admission;
	try {
		admission = await settleWithin(
			admissionControllerForRun(context.env, parsed.output.runId).admitInitial(parsed.output),
			admissionWaitMs,
		);
	} catch (error) {
		if (error instanceof OperationDeadlineError) return unavailable();
		throw error;
	}
	if (admission.state === 'revoked') {
		return context.json({ error: 'authority_revoked' }, 409);
	}
	if (admission.state === 'unavailable') return unavailable();
	if (admission.state === 'conflict') {
		return context.json({
			error: 'run_conflict',
			...(admission.submissionId === undefined ? {} : { submissionId: admission.submissionId }),
		}, 409);
	}
	const receipt = admission.receipt;
	const response: OperationsAutonomyTurnReceipt = {
		state: 'accepted',
		runId: parsed.output.runId,
		instanceId: parsed.output.runId,
		submissionId: receipt.submissionId,
		acceptedAt: receipt.acceptedAt,
		uid: receipt.uid,
	};
	return context.json(response, 202);
});

autonomyRoutes.post('/v1/operations-autonomy-runs/:runId/continue', async (context) => {
	const read = await readJsonBody(context.req.raw, maximumControlBodyBytes);
	if (read.state === 'error') return read.response;
	const verified = await verifyServiceBody({
		context: operationsAutonomyContinuationSignatureContext,
		secret: requireStrongServiceSecret(
			context.env.INTELLIGENCE_INGRESS_SECRET,
			'INTELLIGENCE_INGRESS_SECRET',
		),
		timestamp: context.req.header('x-c2c-timestamp') ?? '',
		signature: context.req.header('x-c2c-signature') ?? '',
		body: read.body,
		now: Date.now(),
		maximumAgeMs: operationsAutonomyAdmissionSignatureMaximumAgeMs,
	});
	if (!verified) return context.json({ error: 'unauthorized' }, 401);
	const json = parsedJson(read.body);
	if (json.state === 'error') return context.json({ error: 'invalid_json' }, 400);
	const parsed = v.safeParse(operationsAutonomyContinuationRequestSchema, json.value);
	if (!parsed.success || parsed.output.runId !== context.req.param('runId')) {
		return context.json({ error: 'invalid_request' }, 422);
	}
	let admission;
	try {
		admission = await settleWithin(
			admissionControllerForRun(context.env, parsed.output.runId)
				.admitContinuation(parsed.output),
			admissionWaitMs,
		);
	} catch (error) {
		if (error instanceof OperationDeadlineError) return unavailable();
		throw error;
	}
	if (admission.state === 'revoked') {
		return context.json({ error: 'authority_revoked' }, 409);
	}
	if (admission.state === 'unavailable') return unavailable();
	if (admission.state === 'conflict') {
		return context.json({
			error: 'continuation_conflict',
			...(admission.submissionId === undefined ? {} : { submissionId: admission.submissionId }),
		}, 409);
	}
	const receipt = admission.receipt;
	const response: OperationsAutonomyContinuationReceipt = {
		state: 'accepted',
		runId: parsed.output.runId,
		instanceId: parsed.output.runId,
		submissionId: receipt.submissionId,
		acceptedAt: receipt.acceptedAt,
		uid: receipt.uid,
	};
	return context.json(response, 202);
});

autonomyRoutes.post('/v1/operations-autonomy-runs/:runId/abort', async (context) => {
	const read = await readJsonBody(context.req.raw, maximumControlBodyBytes);
	if (read.state === 'error') return read.response;
	const verified = await verifyServiceBody({
		context: operationsAutonomyAbortSignatureContext,
		secret: requireStrongServiceSecret(
			context.env.INTELLIGENCE_INGRESS_SECRET,
			'INTELLIGENCE_INGRESS_SECRET',
		),
		timestamp: context.req.header('x-c2c-timestamp') ?? '',
		signature: context.req.header('x-c2c-signature') ?? '',
		body: read.body,
		now: Date.now(),
		maximumAgeMs: abortSignatureMaximumAgeMs,
	});
	if (!verified) return context.json({ error: 'unauthorized' }, 401);
	const json = parsedJson(read.body);
	if (json.state === 'error') return context.json({ error: 'invalid_json' }, 400);
	const parsed = v.safeParse(operationsAutonomyAbortRequestSchema, json.value);
	if (!parsed.success || parsed.output.runId !== context.req.param('runId')) {
		return context.json({ error: 'invalid_request' }, 422);
	}
	let abort;
	try {
		abort = await settleWithin(
			admissionControllerForRun(context.env, parsed.output.runId).revoke(parsed.output),
			admissionWaitMs,
		);
	} catch (error) {
		if (error instanceof OperationDeadlineError) return unavailable();
		throw error;
	}
	if (abort.state === 'pending') {
		return context.json({ error: 'admission_pending' }, 503, { 'retry-after': '1' });
	}
	try {
		await context.env.FLUE_OPERATIONS_AUTOPILOT_AGENT
			.getByName(parsed.output.runId)
			.requestAutonomyArtifactPurge();
	} catch {
		return unavailable();
	}
	clearAutonomyRun(parsed.output.runId);
	return context.json({
		state: 'accepted' as const,
		runId: parsed.output.runId,
		operationId: parsed.output.operationId,
	}, 202);
});
