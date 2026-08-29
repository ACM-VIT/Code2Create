import {
	encodeOperationsIntelligenceStreamTicket,
	operationsAutonomyAdmissionSignatureMaximumAgeMs,
	operationsAutonomyAbortSignatureContext,
	operationsAutonomyContinuationSignatureContext,
	operationsAutonomyIngressSignatureContext,
	operationsAutonomyStreamTicketSignatureContext,
	operationsBriefStreamTicketSignatureContext,
	operationsCopilotInstanceId,
	operationsCopilotIngressSignatureContext,
	operationsCopilotStreamTicketSignatureContext,
	operationsEpisodeIngressSignatureContext,
	operationsIntelligenceIngressSignatureContext,
	operationsIntelligenceProtocolVersion,
	operationsIntelligenceStreamTicketHeaders,
	serializeOperationsIntelligenceStreamTicket,
	signServiceBody,
	type OperationsIntelligenceStreamTicket,
} from '@code2create/domain';
import type { DispatchReceipt } from '@flue/runtime';
import { AgentInstanceExistsError, AgentRunError, SubmissionConflictError } from '@flue/runtime';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
	intelligenceHistoryPageHeaders,
	internalFlueHistoryPageHeaders,
} from './lib/historyCursor.ts';
import {
	memoryAutonomyAdmissionController,
	type AutonomyAdmissionController,
} from './lib/autonomyAdmissionController.ts';

type CopilotDispatchRequest = {
	initialData: { conversationId: string; eventSlug: string };
	idempotencyKey?: string;
	message: string | { kind: 'user'; body: string };
};

type AutonomyDispatchRequest = {
	initialData?: Record<string, unknown>;
	idempotencyKey?: string;
	message: {
		kind: 'signal';
		type: string;
		body: string;
		attributes?: Record<string, string>;
	};
};

const runtime = vi.hoisted(() => {
	const dispatchBrief = vi.fn<(
		agent: unknown,
		request: Record<string, unknown>
	) => Promise<DispatchReceipt>>();
	const dispatchTurn = vi.fn<(request: CopilotDispatchRequest) => Promise<DispatchReceipt>>();
	const dispatchAutonomy = vi.fn<(
		request: AutonomyDispatchRequest
	) => Promise<DispatchReceipt>>();
	const abortAutonomy = vi.fn<() => Promise<void>>();
	const readAutonomy = vi.fn<(submissionId: string) => Promise<{
		text: string;
		data: Record<string, unknown[]>;
		submissionId: string;
	}>>();
	const autopilotAgent = {};
	return {
		dispatchBrief,
		dispatchTurn,
		dispatchAutonomy,
		abortAutonomy,
		readAutonomy,
		autopilotAgent,
		init: vi.fn((agent: unknown, options: { id?: string }) => agent === autopilotAgent
			? { dispatch: dispatchAutonomy, abort: abortAutonomy, read: readAutonomy, options }
			: { dispatch: dispatchTurn, abort: vi.fn(), options }),
	};
});

const routers = vi.hoisted(() => {
	const briefFetch = vi.fn<(request: Request) => Promise<Response>>();
	const copilotFetch = vi.fn<(request: Request) => Promise<Response>>();
	const autopilotFetch = vi.fn<(request: Request) => Promise<Response>>();
	return { briefFetch, copilotFetch, autopilotFetch, created: 0 };
});

vi.mock('@flue/runtime', async (importOriginal) => {
	const original = await importOriginal<typeof import('@flue/runtime')>();
	return {
		...original,
		dispatch: runtime.dispatchBrief,
		init: runtime.init,
		instrument: vi.fn(),
	};
});

vi.mock('@flue/runtime/cloudflare', () => ({
	createCloudflareTracing: vi.fn(() => ({})),
}));

vi.mock('@flue/runtime/routing', () => ({
	createAgentRouter: vi.fn(() => {
		routers.created += 1;
		return {
			fetch: routers.created === 1
				? routers.briefFetch
				: routers.created === 2
					? routers.copilotFetch
					: routers.autopilotFetch,
		};
	}),
}));

vi.mock('cloudflare:workers', () => ({
	env: {},
}));

vi.mock('./agents/operations-brief.ts', () => ({ OperationsBrief: {} }));
vi.mock('./agents/operations-copilot.ts', () => ({ OperationsCopilot: {} }));
vi.mock('./agents/operations-autopilot.ts', () => ({
	OperationsAutopilot: runtime.autopilotAgent,
}));
vi.mock('./agents/operations-episode.ts', () => ({ OperationsEpisode: {} }));

import app from './app.ts';

const secret = 'f'.repeat(64);
const conversationId = `cv_${'a'.repeat(64)}`;
const copilotInstanceId = operationsCopilotInstanceId({
	eventSlug: 'code2create-7',
	conversationId,
});
const admissionControllers = new Map<string, AutonomyAdmissionController>();
const admissionControllerNamespace = {
	getByName(runId: string) {
		const existing = admissionControllers.get(runId);
		if (existing !== undefined) return existing;
		const controller = memoryAutonomyAdmissionController({
			dispatchInitial(input) {
				return runtime.dispatchAutonomy({
					initialData: input,
					idempotencyKey: input.runId,
					message: {
						kind: 'signal',
						type: 'operations.autonomy.run',
						body: 'Run the signed authorized operations work item.',
					},
				});
			},
			async dispatchContinuation(input) {
				try {
					await runtime.readAutonomy(input.priorSubmissionId);
				} catch (error) {
					if (!(error instanceof AgentRunError)) throw error;
				}
				return runtime.dispatchAutonomy({
					idempotencyKey: input.workItemId,
					message: {
						kind: 'signal',
						type: 'operations.autonomy.continue',
						body: 'Continue the next authorized operations work item.',
						attributes: {
							operationId: input.operationId,
							workItemId: input.workItemId,
						},
					},
				});
			},
			abort: runtime.abortAutonomy,
		});
		admissionControllers.set(runId, controller);
		return controller;
	},
};
const environment: Cloudflare.Env = {
	OPENAI_API_KEY: 'openai-test-key',
	FLUE_OPERATIONS_AUTOPILOT_AGENT: {
		getByName: () => ({ requestAutonomyArtifactPurge: vi.fn() }),
	},
	OPERATIONS_AUTONOMY_ADMISSION_FENCE: admissionControllerNamespace,
	INTELLIGENCE_INGRESS_SECRET: secret,
	INTELLIGENCE_CALLBACK_SECRET: secret,
	INTELLIGENCE_READ_SECRET: secret,
	INTELLIGENCE_STREAM_SECRET: secret,
	CONVEX_INTELLIGENCE_CALLBACK_URL: 'https://example.test/callback',
	CONVEX_INTELLIGENCE_READ_URL: 'https://example.test/reads',
	CONVEX_INTELLIGENCE_RECOMMENDATION_URL: 'https://example.test/recommendations',
	CONVEX_INTELLIGENCE_EPISODE_READ_URL: 'https://example.test/episodes/read',
	CONVEX_INTELLIGENCE_EPISODE_CALLBACK_URL: 'https://example.test/episodes/callback',
	CONVEX_INTELLIGENCE_AUTONOMY_CALLBACK_URL: 'https://example.test/autonomy/callback',
	CONVEX_INTELLIGENCE_AUTONOMY_READ_URL: 'https://example.test/autonomy/reads',
	CONVEX_INTELLIGENCE_AUTONOMY_WORK_URL: 'https://example.test/autonomy/work',
	CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_URL: 'https://example.test/autonomy/recommendations',
	CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_EVIDENCE_URL:
		'https://example.test/autonomy/recommendation-evidence',
	OPS_ORIGIN: 'https://ops.example.test',
};

describe('intelligence readiness', () => {
	test('reports readiness only when every signed boundary is configured', async () => {
		const ready = await app.request('/health', undefined, environment);
		const unready = await app.request('/health', undefined, {
			...environment,
			OPENAI_API_KEY: '',
		});

		expect(ready.status).toBe(200);
		expect(await ready.json()).toEqual({ ok: true });
		expect(unready.status).toBe(503);
		expect(await unready.json()).toEqual({ ok: false });
	});
});

describe('operations copilot ingress', () => {
	beforeEach(() => {
		runtime.dispatchBrief.mockReset();
		runtime.init.mockClear();
		runtime.dispatchTurn.mockReset();
		routers.briefFetch.mockReset();
		routers.copilotFetch.mockReset();
	});

	test('uses the signed turn id as the durable Flue submission key', async () => {
		const receipt: DispatchReceipt = {
			submissionId: 'submission-1',
			acceptedAt: '2026-08-12T00:00:00.000Z',
			uid: 'agent-uid',
		};
		runtime.dispatchTurn
			.mockResolvedValueOnce(receipt)
			.mockResolvedValueOnce({ ...receipt, deduplicated: true });
		const body = JSON.stringify({
			protocolVersion: operationsIntelligenceProtocolVersion,
			conversationId,
			turnId: 'turn-018fa6c1',
			eventSlug: 'code2create-7',
			message: 'How is review going?',
		});

		const first = await signedTurnRequest(body);
		const retry = await signedTurnRequest(body);

		expect(first.status).toBe(202);
		expect(retry.status).toBe(202);
		expect(await first.json()).toEqual({
			state: 'accepted',
			conversationId,
			instanceId: `copilot:code2create-7:${conversationId}`,
			submissionId: receipt.submissionId,
			acceptedAt: receipt.acceptedAt,
			uid: receipt.uid,
			deduplicated: false,
		});
		expect(await retry.json()).toMatchObject({ deduplicated: true });
		expect(runtime.init).toHaveBeenNthCalledWith(1, {}, {
			id: `copilot:code2create-7:${conversationId}`,
		});
		expect(runtime.init).toHaveBeenNthCalledWith(2, {}, {
			id: `copilot:code2create-7:${conversationId}`,
		});
		expect(runtime.dispatchTurn).toHaveBeenCalledTimes(2);
		for (const [request] of runtime.dispatchTurn.mock.calls) {
			expect(request).toEqual({
				initialData: { conversationId, eventSlug: 'code2create-7' },
				idempotencyKey: 'turn-018fa6c1',
				message: { kind: 'user', body: 'How is review going?' },
			});
		}
	});

	test('reports reuse of a turn id with a different signed message as a conflict', async () => {
		runtime.dispatchTurn.mockRejectedValueOnce(
			new SubmissionConflictError({ submissionId: 'submission-1' }),
		);
		const response = await signedTurnRequest(JSON.stringify({
			protocolVersion: operationsIntelligenceProtocolVersion,
			conversationId,
			turnId: 'turn-018fa6c1',
			eventSlug: 'code2create-7',
			message: 'This body differs from the original turn.',
		}));

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: 'turn_conflict',
			submissionId: 'submission-1',
		});
	});

	test.each([
		['/v1/operations-briefs', 64 * 1_024],
		['/v1/operations-copilot/turns', 16 * 1_024],
	])('rejects an undeclared oversized body on %s before authentication', async (path, limit) => {
		const response = await app.request(
			path,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: 'x'.repeat(limit + 1),
			},
			environment,
		);

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: 'payload_too_large' });
		expect(runtime.dispatchTurn).not.toHaveBeenCalled();
	});

	test('fails closed when the configured ingress HMAC key is too short', async () => {
		const body = JSON.stringify({
			protocolVersion: operationsIntelligenceProtocolVersion,
			conversationId,
			turnId: 'turn-weak-secret',
			eventSlug: 'code2create-7',
			message: 'How is review going?',
		});
		const timestamp = Date.now().toString();
		const signature = await signServiceBody({
			context: operationsCopilotIngressSignatureContext,
			secret,
			timestamp,
			body,
		});
		const response = await app.request(
			'/v1/operations-copilot/turns',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-c2c-timestamp': timestamp,
					'x-c2c-signature': signature,
				},
				body,
			},
			{ ...environment, INTELLIGENCE_INGRESS_SECRET: 'too-short' },
		);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: 'internal_error' });
		expect(runtime.dispatchTurn).not.toHaveBeenCalled();
	});
});

describe('operations brief ingress', () => {
	beforeEach(() => {
		runtime.dispatchBrief.mockReset();
	});

	test('admits one create-only brief and reports an existing retry without another run', async () => {
		const receipt: DispatchReceipt = {
			submissionId: 'brief-submission-1',
			acceptedAt: '2026-08-12T00:00:00.000Z',
			uid: 'brief-agent-uid',
		};
		runtime.dispatchBrief
			.mockResolvedValueOnce(receipt)
			.mockRejectedValueOnce(new AgentInstanceExistsError({
				id: 'brief-1',
				uid: receipt.uid,
			}));
		const body = JSON.stringify({
			protocolVersion: operationsIntelligenceProtocolVersion,
			briefId: 'brief-1',
			sourceChecksum: 'a'.repeat(64),
			snapshot: {
				generatedAt: 1,
				event: {
					slug: 'code2create-7',
					name: 'Code2Create 7.0',
					timezone: 'Asia/Dubai',
					status: 'live',
				},
				summary: {
					status: 'healthy',
					signalCount: 0,
					criticalSignalCount: 0,
					attentionSignalCount: 0,
					watchSignalCount: 0,
				},
				signals: [],
			},
		});

		const first = await signedBriefRequest(body);
		const retry = await signedBriefRequest(body);

		expect(first.status).toBe(202);
		expect(await first.json()).toEqual({
			state: 'accepted',
			submissionId: receipt.submissionId,
			acceptedAt: receipt.acceptedAt,
		});
		expect(retry.status).toBe(202);
		expect(await retry.json()).toEqual({ state: 'already_exists' });
		expect(runtime.dispatchBrief).toHaveBeenCalledTimes(2);
		expect(runtime.dispatchBrief.mock.calls[0]?.[1]).toMatchObject({
			id: 'brief-1',
			uid: null,
			message: { kind: 'signal', type: 'operations.health.snapshot' },
		});
	});
});

describe('operations episode ingress', () => {
	beforeEach(() => {
		runtime.dispatchBrief.mockReset();
	});

	test('admits a signed episode revision into its stable durable instance', async () => {
		const receipt: DispatchReceipt = {
			submissionId: 'episode-submission-1',
			acceptedAt: '2026-08-29T00:00:00.000Z',
			uid: 'episode-agent-uid',
		};
		runtime.dispatchBrief.mockResolvedValueOnce(receipt);
		const response = await signedEpisodeRequest(JSON.stringify({
			protocolVersion: operationsIntelligenceProtocolVersion,
			episodeId: 'episode-1',
			eventId: 'event-1',
			revision: 3,
		}));

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			state: 'accepted',
			episodeId: 'episode-1',
			instanceId: 'episode-1',
			submissionId: receipt.submissionId,
			acceptedAt: receipt.acceptedAt,
		});
		expect(runtime.dispatchBrief).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
			id: 'episode-1',
			initialData: expect.objectContaining({ episodeId: 'episode-1', eventId: 'event-1' }),
			message: expect.objectContaining({
				kind: 'signal',
				type: 'operations.episode.changed',
				attributes: { episodeId: 'episode-1', revision: '3' },
			}),
		}));
	});
});

describe('operations autonomy service routes', () => {
	beforeEach(() => {
		admissionControllers.clear();
		runtime.dispatchAutonomy.mockReset();
		runtime.abortAutonomy.mockReset();
		runtime.readAutonomy.mockReset();
		routers.autopilotFetch.mockReset();
	});

	test('idempotently admits the signed run with one durable Flue key', async () => {
		const receipt: DispatchReceipt = {
			submissionId: 'autonomy-submission-1',
			acceptedAt: '2026-08-13T00:00:00.000Z',
			uid: 'autonomy-uid-1',
		};
		runtime.dispatchAutonomy
			.mockResolvedValueOnce(receipt)
			.mockResolvedValueOnce({ ...receipt, deduplicated: true });
		const body = autonomyRequestBody('autonomy-run-1');

		const first = await signedAutonomyRequest(body);
		const retry = await signedAutonomyRequest(body);

		expect(first.status).toBe(202);
		expect(retry.status).toBe(202);
		const expected = {
			state: 'accepted',
			runId: 'autonomy-run-1',
			instanceId: 'autonomy-run-1',
			submissionId: receipt.submissionId,
			acceptedAt: receipt.acceptedAt,
			uid: receipt.uid,
		};
		expect(await first.json()).toEqual(expected);
		expect(await retry.json()).toEqual(expected);
		expect(runtime.dispatchAutonomy).toHaveBeenCalledTimes(1);
		for (const [request] of runtime.dispatchAutonomy.mock.calls) {
			expect(request.idempotencyKey).toBe('autonomy-run-1');
			expect(request.initialData).toMatchObject({ runId: 'autonomy-run-1' });
				expect(request.message).toEqual({
					kind: 'signal',
					type: 'operations.autonomy.run',
					body: 'Run the signed authorized operations work item.',
				});
		}
	});

	test('rejects a changed payload on the same run key without admitting work', async () => {
		runtime.dispatchAutonomy.mockRejectedValueOnce(
			new SubmissionConflictError({ submissionId: 'autonomy-submission-1' }),
		);
		const response = await signedAutonomyRequest(autonomyRequestBody('autonomy-run-1'));

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: 'run_conflict',
			submissionId: 'autonomy-submission-1',
		});
	});

	test('rejects initial and continuation admission just beyond the shared signature window', async () => {
		const signedAt = Date.now() - operationsAutonomyAdmissionSignatureMaximumAgeMs - 1;
		const initial = await signedAutonomyRequestAt(
			autonomyRequestBody('autonomy-expired-run'),
			signedAt,
		);
		const continuationBody = JSON.stringify({
			protocolVersion: operationsIntelligenceProtocolVersion,
			runId: 'autonomy-expired-run',
			operationId: 'autonomy-expired-run:continue:1',
			priorSubmissionId: 'autonomy-expired-submission',
			workItemId: 'autonomy-expired-run:work:2',
		});
		const continuation = await signedAutonomyContinuationRequestAt(
			'autonomy-expired-run',
			continuationBody,
			signedAt,
		);

		expect(initial.status).toBe(401);
		expect(continuation.status).toBe(401);
		expect(runtime.readAutonomy).not.toHaveBeenCalled();
		expect(runtime.dispatchAutonomy).not.toHaveBeenCalled();
	});

	test('rejects obsolete cognitive budgets and deadlines instead of silently accepting them', async () => {
		const current = JSON.parse(autonomyRequestBody('autonomy-obsolete-fields')) as Record<
			string,
			unknown
		>;
		const policy = current['policy'];
		if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
			throw new Error('The autonomy fixture policy is invalid.');
		}
		const response = await signedAutonomyRequest(JSON.stringify({
			...current,
			deadlineAt: Date.now() + 5_000,
			policy: { ...policy, budgets: { maximumToolCalls: 1 } },
		}));

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({ error: 'invalid_request' });
		expect(runtime.dispatchAutonomy).not.toHaveBeenCalled();
	});

	test('waits for the exact prior settlement and idempotently admits the next work item', async () => {
		const receipt: DispatchReceipt = {
			submissionId: 'autonomy-submission-2',
			acceptedAt: '2026-08-13T00:01:00.000Z',
			uid: 'autonomy-uid-1',
		};
		runtime.readAutonomy.mockResolvedValue({
			text: '',
			data: {},
			submissionId: 'autonomy-submission-1',
		});
		runtime.dispatchAutonomy
			.mockResolvedValueOnce(receipt)
			.mockResolvedValueOnce({ ...receipt, deduplicated: true });
		const body = JSON.stringify({
			protocolVersion: operationsIntelligenceProtocolVersion,
			runId: 'autonomy-run-1',
			operationId: 'autonomy-run-1:continue:1',
			priorSubmissionId: 'autonomy-submission-1',
			workItemId: 'autonomy-run-1:work:2',
		});

		const first = await signedAutonomyContinuationRequest('autonomy-run-1', body);
		const retry = await signedAutonomyContinuationRequest('autonomy-run-1', body);

		expect(first.status).toBe(202);
		expect(retry.status).toBe(202);
		expect(await first.json()).toEqual({
			state: 'accepted',
			runId: 'autonomy-run-1',
			instanceId: 'autonomy-run-1',
			submissionId: receipt.submissionId,
			acceptedAt: receipt.acceptedAt,
			uid: receipt.uid,
		});
		expect(runtime.readAutonomy).toHaveBeenNthCalledWith(1, 'autonomy-submission-1');
		expect(runtime.dispatchAutonomy).toHaveBeenCalledTimes(1);
		for (const [request] of runtime.dispatchAutonomy.mock.calls) {
			expect(request.idempotencyKey).toBe('autonomy-run-1:work:2');
			expect(request.initialData).toBeUndefined();
			expect(request.message).toMatchObject({
				kind: 'signal',
				type: 'operations.autonomy.continue',
				attributes: { workItemId: 'autonomy-run-1:work:2' },
			});
		}
	});

	test('does not dispatch a continuation while the prior submission is unsettled', async () => {
		runtime.readAutonomy.mockImplementation(() => new Promise(() => {}));
		const body = JSON.stringify({
			protocolVersion: operationsIntelligenceProtocolVersion,
			runId: 'autonomy-run-1',
			operationId: 'autonomy-run-1:continue:busy',
			priorSubmissionId: 'autonomy-submission-busy',
			workItemId: 'autonomy-run-1:work:busy',
		});
		const response = await signedAutonomyContinuationRequest('autonomy-run-1', body);

		expect(response.status).toBe(503);
		expect(runtime.dispatchAutonomy).not.toHaveBeenCalled();
	}, 15_000);

	test('continues after a settled failed submission, but rejects body and route mismatch', async () => {
		runtime.readAutonomy.mockRejectedValue(new AgentRunError({
			outcome: 'failed',
			submissionId: 'autonomy-submission-failed',
		}));
		runtime.dispatchAutonomy.mockResolvedValue({
			submissionId: 'autonomy-submission-retry',
			acceptedAt: '2026-08-13T00:02:00.000Z',
			uid: 'autonomy-uid-1',
		});
		const body = JSON.stringify({
			protocolVersion: operationsIntelligenceProtocolVersion,
			runId: 'autonomy-run-1',
			operationId: 'autonomy-run-1:continue:retry',
			priorSubmissionId: 'autonomy-submission-failed',
			workItemId: 'autonomy-run-1:work:retry',
		});
		const accepted = await signedAutonomyContinuationRequest('autonomy-run-1', body);
		const mismatch = await signedAutonomyContinuationRequest('another-run', body);

		expect(accepted.status).toBe(202);
		expect(mismatch.status).toBe(422);
	});

	test('rejects a changed continuation on the same work key and the wrong signature context', async () => {
		runtime.readAutonomy.mockResolvedValue({
			text: '',
			data: {},
			submissionId: 'autonomy-submission-1',
		});
		runtime.dispatchAutonomy.mockRejectedValueOnce(
			new SubmissionConflictError({ submissionId: 'autonomy-submission-2' }),
		);
		const body = JSON.stringify({
			protocolVersion: operationsIntelligenceProtocolVersion,
			runId: 'autonomy-run-1',
			operationId: 'autonomy-run-1:continue:conflict',
			priorSubmissionId: 'autonomy-submission-1',
			workItemId: 'autonomy-run-1:work:2',
		});

		const conflict = await signedAutonomyContinuationRequest('autonomy-run-1', body);
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toEqual({
			error: 'continuation_conflict',
			submissionId: 'autonomy-submission-2',
		});

		const timestamp = Date.now().toString();
		const wrongContextSignature = await signServiceBody({
			context: operationsAutonomyAbortSignatureContext,
			secret,
			timestamp,
			body,
		});
		const unauthorized = await app.request(
			'/v1/operations-autonomy-runs/autonomy-run-1/continue',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-c2c-timestamp': timestamp,
					'x-c2c-signature': wrongContextSignature,
				},
				body,
			},
			environment,
		);
		expect(unauthorized.status).toBe(401);
	});

	test('authenticates and idempotently aborts the exact durable run instance', async () => {
		runtime.abortAutonomy.mockResolvedValue();
		const body = JSON.stringify({
			protocolVersion: operationsIntelligenceProtocolVersion,
			runId: 'autonomy-run-1',
			reason: 'kill_switch',
			operationId: 'abort:autonomy-run-1:1',
		});
		const first = await signedAutonomyAbortRequest('autonomy-run-1', body);
		const retry = await signedAutonomyAbortRequest('autonomy-run-1', body);

		expect(first.status).toBe(202);
		expect(retry.status).toBe(202);
		expect(await first.json()).toEqual({
			state: 'accepted',
			runId: 'autonomy-run-1',
			operationId: 'abort:autonomy-run-1:1',
		});
		expect(runtime.abortAutonomy).toHaveBeenCalledTimes(1);
	});
});

describe('read-only intelligence streams', () => {
	beforeEach(() => {
		routers.briefFetch.mockReset();
		routers.copilotFetch.mockReset();
		routers.autopilotFetch.mockReset();
	});

	test('serves a route-bound sanitized history with exact CORS', async () => {
		routers.copilotFetch.mockResolvedValueOnce(Response.json({
			v: 1,
			conversationId: 'conv_native',
			offset: '3_0',
			incarnation: 'inc_native',
			messages: [],
			settlements: [],
		}));
		const response = await streamRequest({
			method: 'GET',
			instanceId: copilotInstanceId,
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('access-control-allow-origin'))
			.toBe(environment.OPS_ORIGIN);
		expect(response.headers.get('access-control-allow-credentials')).toBeNull();
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toMatchObject({
			conversationId: copilotInstanceId,
			offset: '3_0',
		});
		expect(routers.copilotFetch).toHaveBeenCalledOnce();
		const internalRequest = routers.copilotFetch.mock.calls[0]?.[0];
		expect(internalRequest?.method).toBe('GET');
		expect(internalRequest?.headers.get(operationsIntelligenceStreamTicketHeaders.ticket))
			.toBeNull();
		expect(internalRequest?.headers.get('x-flue-history-message-limit')).toBe('6');
		expect(new URL(internalRequest?.url ?? 'https://invalid.test').pathname)
			.toBe(`/${encodeURIComponent(copilotInstanceId)}`);
	});

	test('serves brief runs through their distinct ticket and hides dispatch text', async () => {
		const briefId = 'brief-1';
		routers.briefFetch.mockResolvedValueOnce(Response.json({
			v: 1,
			conversationId: 'conv_native_brief',
			offset: '2_0',
			messages: [
				{
					id: 'brief-dispatch',
					role: 'user',
					purpose: 'user',
					display: 'visible',
					submissionId: 'brief-submission',
					turnId: 'brief-turn',
					parts: [{ type: 'text', text: 'private frozen dispatch', state: 'done' }],
				},
				{
					id: 'brief-answer',
					role: 'assistant',
					purpose: 'assistant',
					display: 'visible',
					submissionId: 'brief-submission',
					turnId: 'brief-turn',
					parts: [{ type: 'text', text: 'Brief prepared.', state: 'done' }],
				},
			],
			settlements: [{ submissionId: 'brief-submission', outcome: 'completed' }],
		}));
		const response = await briefStreamRequest(briefId);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).not.toContain('Brief prepared.');
		expect(body).toContain(`"conversationId":"${briefId}"`);
		expect(body).not.toContain('private frozen dispatch');
		expect(routers.briefFetch).toHaveBeenCalledOnce();
		expect(new URL(routers.briefFetch.mock.calls[0]?.[0].url ?? 'https://invalid.test').pathname)
			.toBe(`/${briefId}`);
	});

	test('serves autonomy history only through its run-bound ticket and route', async () => {
		routers.autopilotFetch.mockResolvedValueOnce(Response.json({
			v: 1,
			conversationId: 'conv_native_autonomy',
			offset: '1_0',
			messages: [],
			settlements: [],
		}));
		const response = await autonomyStreamRequest('autonomy-run-1');

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ conversationId: 'autonomy-run-1' });
		expect(new URL(
			routers.autopilotFetch.mock.calls[0]?.[0].url ?? 'https://invalid.test',
		).pathname).toBe('/autonomy-run-1');
	});

	test('pages every sanitized autonomy lifecycle message across a cold reconnect', async () => {
		const messages = Array.from({ length: 40 }, (_, index) => ({
			id: `autonomy-message-${index}`,
			role: 'assistant',
			purpose: 'assistant',
			display: 'visible',
			metadata: { private: `PRIVATE_METADATA_${index}` },
			parts: [
				{ type: 'text', text: `PRIVATE_MODEL_TEXT_${index}`, state: 'done' },
				{
					type: 'data-autonomy-lifecycle',
					data: {
						operation: 'investigate_area',
						phase: 'investigating',
						role: 'investigator',
						status: 'completed',
						durationMs: index,
					},
				},
			],
		}));
		routers.autopilotFetch.mockImplementation(async (request) => {
			const nativeBefore = request.headers.get(
				internalFlueHistoryPageHeaders.beforeMessageKey,
			);
			const end = nativeBefore === null
				? messages.length
				: Number(nativeBefore.replace('message:autonomy-message-', ''));
			if (!Number.isSafeInteger(end) || end < 0 || end > messages.length) {
				return Response.json({ error: 'invalid_cursor' }, { status: 400 });
			}
			const start = Math.max(0, end - 6);
			const page = messages.slice(start, end);
			return Response.json({
				v: 1,
				conversationId: 'conv_native_autonomy',
				offset: '40_0',
				incarnation: 'inc_native_autonomy',
				messages: page,
				settlements: [],
			}, {
				headers: {
					[internalFlueHistoryPageHeaders.earliestMessageKey]:
						`message:autonomy-message-${start}`,
					[internalFlueHistoryPageHeaders.hasEarlier]: String(start > 0),
				},
			});
		});

		const recoveredIds: string[] = [];
		let before: string | undefined;
		for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
			const response = await autonomyStreamRequest('autonomy-run-history', before);
			expect(response.status).toBe(200);
			const body = await response.text();
			expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(256 * 1_024);
			expect(body).not.toContain('PRIVATE_');
			const snapshot = JSON.parse(body) as { messages?: Array<{ id?: string }> };
			for (const message of snapshot.messages ?? []) {
				if (message.id !== undefined) recoveredIds.push(message.id);
			}
			const hasEarlier = response.headers.get(intelligenceHistoryPageHeaders.hasEarlier);
			if (hasEarlier === 'false') break;
			expect(hasEarlier).toBe('true');
			before = response.headers.get(intelligenceHistoryPageHeaders.before) ?? undefined;
			expect(before).toBeDefined();
		}

		expect(new Set(recoveredIds)).toEqual(new Set(messages.map((message) => message.id)));
		expect(routers.autopilotFetch).toHaveBeenCalledTimes(7);
		for (const [request] of routers.autopilotFetch.mock.calls) {
			expect(new URL(request.url).searchParams.has('before')).toBe(false);
		}
	});

	test('permits only GET and HEAD on browser routes', async () => {
		const response = await streamRequest({
			method: 'POST',
			instanceId: copilotInstanceId,
		});

		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('GET, HEAD');
		expect(routers.copilotFetch).not.toHaveBeenCalled();

		routers.copilotFetch.mockResolvedValueOnce(new Response(null, {
			status: 200,
			headers: {
				'stream-next-offset': '3_0',
				'stream-up-to-date': 'true',
			},
		}));
		const head = await streamRequest({
			method: 'HEAD',
			instanceId: copilotInstanceId,
		});
		expect(head.status).toBe(200);
		expect(await head.text()).toBe('');
	});

	test('rejects a wrong origin, expired ticket, and ticket for another instance', async () => {
		const wrongOrigin = await streamRequest({
			method: 'GET',
			instanceId: copilotInstanceId,
			origin: 'https://attacker.example',
		});
		expect(wrongOrigin.status).toBe(403);

		const expired = await streamRequest({
			method: 'GET',
			instanceId: copilotInstanceId,
			issuedAt: Date.now() - 61_000,
		});
		expect(expired.status).toBe(401);

		const anotherConversationId = `cv_${'b'.repeat(64)}`;
		const anotherInstanceId = operationsCopilotInstanceId({
			eventSlug: 'code2create-7',
			conversationId: anotherConversationId,
		});
		const swapped = await streamRequest({
			method: 'GET',
			instanceId: copilotInstanceId,
			ticketInstanceId: anotherInstanceId,
			ticketConversationId: anotherConversationId,
		});
		expect(swapped.status).toBe(401);
		expect(routers.copilotFetch).not.toHaveBeenCalled();
	});

	test('preflights only the configured origin and ticket headers', async () => {
		const response = await app.request(
			`/v1/operations-copilot/conversations/${encodeURIComponent(copilotInstanceId)}`,
			{
				method: 'OPTIONS',
				headers: { origin: environment.OPS_ORIGIN },
			},
			environment,
		);

		expect(response.status).toBe(204);
		expect(response.headers.get('access-control-allow-methods')).toBe('GET, HEAD');
		expect(response.headers.get('access-control-allow-headers'))
			.toBe(Object.values(operationsIntelligenceStreamTicketHeaders).join(', '));
		expect(response.headers.get('access-control-allow-credentials')).toBeNull();
	});

	test('rejects SSE so every live request reauthorizes within one long-poll window', async () => {
		const response = await streamRequest({
			method: 'GET',
			instanceId: copilotInstanceId,
			query: '?view=updates&live=sse&offset=-1',
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'invalid_stream_read' });
		expect(routers.copilotFetch).not.toHaveBeenCalled();
	});

	test('returns a content-free CORS error when the native projection is invalid', async () => {
		routers.copilotFetch.mockResolvedValueOnce(Response.json({ private: 'native failure' }));
		const response = await streamRequest({
			method: 'GET',
			instanceId: copilotInstanceId,
		});

		expect(response.status).toBe(502);
		expect(response.headers.get('access-control-allow-origin')).toBe(environment.OPS_ORIGIN);
		expect(response.headers.get('retry-after')).toBe('1');
		expect(await response.json()).toEqual({ error: 'stream_unavailable' });
	});
});

async function signedTurnRequest(body: string) {
	const timestamp = Date.now().toString();
	const signature = await signServiceBody({
		context: operationsCopilotIngressSignatureContext,
		secret,
		timestamp,
		body,
	});
	return app.request(
		'/v1/operations-copilot/turns',
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-c2c-timestamp': timestamp,
				'x-c2c-signature': signature,
			},
			body,
		},
		environment,
	);
}

async function signedBriefRequest(body: string) {
	const timestamp = Date.now().toString();
	const signature = await signServiceBody({
		context: operationsIntelligenceIngressSignatureContext,
		secret,
		timestamp,
		body,
	});
	return app.request(
		'/v1/operations-briefs',
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-c2c-timestamp': timestamp,
				'x-c2c-signature': signature,
			},
			body,
		},
		environment,
	);
}

async function signedEpisodeRequest(body: string) {
	const timestamp = Date.now().toString();
	const signature = await signServiceBody({
		context: operationsEpisodeIngressSignatureContext,
		secret,
		timestamp,
		body,
	});
	return app.request(
		'/v1/operations-episodes',
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-c2c-timestamp': timestamp,
				'x-c2c-signature': signature,
			},
			body,
		},
		environment,
	);
}

async function streamRequest(args: {
	method: string;
	instanceId: string;
	origin?: string;
	issuedAt?: number;
	ticketInstanceId?: string;
	ticketConversationId?: string;
	query?: string;
}) {
	const issuedAt = args.issuedAt ?? Date.now();
	const ticket: OperationsIntelligenceStreamTicket = {
		protocolVersion: operationsIntelligenceProtocolVersion,
		eventSlug: 'code2create-7',
		instanceId: args.ticketInstanceId ?? args.instanceId,
		agentName: 'operations-copilot',
		capability: 'read',
		issuedAt,
		expiresAt: issuedAt + 60_000,
		nonce: 'nonce_1234567890abcdef',
		conversationId: args.ticketConversationId ?? conversationId,
	};
	const body = serializeOperationsIntelligenceStreamTicket(ticket);
	const timestamp = String(ticket.issuedAt);
	const signature = await signServiceBody({
		context: operationsCopilotStreamTicketSignatureContext,
		secret,
		timestamp,
		body,
	});
	return app.request(
		`/v1/operations-copilot/conversations/${encodeURIComponent(args.instanceId)}${args.query ?? (args.method === 'HEAD' ? '' : '?view=history')}`,
		{
			method: args.method,
			headers: {
				origin: args.origin ?? environment.OPS_ORIGIN,
				[operationsIntelligenceStreamTicketHeaders.ticket]:
					encodeOperationsIntelligenceStreamTicket(ticket),
				[operationsIntelligenceStreamTicketHeaders.timestamp]: timestamp,
				[operationsIntelligenceStreamTicketHeaders.signature]: signature,
			},
		},
		environment,
	);
}

async function briefStreamRequest(briefId: string) {
	const issuedAt = Date.now();
	const ticket: OperationsIntelligenceStreamTicket = {
		protocolVersion: operationsIntelligenceProtocolVersion,
		eventSlug: 'code2create-7',
		instanceId: briefId,
		agentName: 'operations-brief',
		capability: 'read',
		issuedAt,
		expiresAt: issuedAt + 60_000,
		nonce: 'brief_nonce_1234567890',
		briefId,
	};
	const body = serializeOperationsIntelligenceStreamTicket(ticket);
	const timestamp = String(ticket.issuedAt);
	const signature = await signServiceBody({
		context: operationsBriefStreamTicketSignatureContext,
		secret,
		timestamp,
		body,
	});
	return app.request(
		`/v1/operations-brief-runs/${encodeURIComponent(briefId)}?view=history`,
		{
			method: 'GET',
			headers: {
				origin: environment.OPS_ORIGIN,
				[operationsIntelligenceStreamTicketHeaders.ticket]:
					encodeOperationsIntelligenceStreamTicket(ticket),
				[operationsIntelligenceStreamTicketHeaders.timestamp]: timestamp,
				[operationsIntelligenceStreamTicketHeaders.signature]: signature,
			},
		},
		environment,
	);
}

function autonomyRequestBody(runId: string) {
	return JSON.stringify({
		protocolVersion: operationsIntelligenceProtocolVersion,
		trigger: 'manual',
		runId,
		eventSlug: 'code2create-7',
		policy: {
			policyVersionId: 'policy-1',
			policyVersion: 1,
			policyChecksum: 'a'.repeat(64),
			mode: 'observe',
			escalationSeverity: 'attention',
			allowedReadTools: ['operations_health'],
			allowedRecommendationKinds: [],
		},
		source: {
			sourceChecksum: 'b'.repeat(64),
			snapshot: {
				generatedAt: Date.now(),
				event: {
					slug: 'code2create-7',
					name: 'Code2Create',
					timezone: 'Asia/Dubai',
					status: 'live',
				},
				summary: {
					status: 'healthy',
					signalCount: 0,
					criticalSignalCount: 0,
					attentionSignalCount: 0,
					watchSignalCount: 0,
				},
				signals: [],
			},
		},
	});
}

async function signedAutonomyRequest(body: string) {
	return signedAutonomyRequestAt(body, Date.now());
}

async function signedAutonomyRequestAt(body: string, signedAt: number) {
	const timestamp = signedAt.toString();
	const signature = await signServiceBody({
		context: operationsAutonomyIngressSignatureContext,
		secret,
		timestamp,
		body,
	});
	return app.request('/v1/operations-autonomy-runs', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-c2c-timestamp': timestamp,
			'x-c2c-signature': signature,
		},
		body,
	}, environment);
}

async function signedAutonomyAbortRequest(runId: string, body: string) {
	const timestamp = Date.now().toString();
	const signature = await signServiceBody({
		context: operationsAutonomyAbortSignatureContext,
		secret,
		timestamp,
		body,
	});
	return app.request(`/v1/operations-autonomy-runs/${runId}/abort`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-c2c-timestamp': timestamp,
			'x-c2c-signature': signature,
		},
		body,
	}, environment);
}

async function signedAutonomyContinuationRequest(runId: string, body: string) {
	return signedAutonomyContinuationRequestAt(runId, body, Date.now());
}

async function signedAutonomyContinuationRequestAt(
	runId: string,
	body: string,
	signedAt: number,
) {
	const timestamp = signedAt.toString();
	const signature = await signServiceBody({
		context: operationsAutonomyContinuationSignatureContext,
		secret,
		timestamp,
		body,
	});
	return app.request(`/v1/operations-autonomy-runs/${runId}/continue`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-c2c-timestamp': timestamp,
			'x-c2c-signature': signature,
		},
		body,
	}, environment);
}

async function autonomyStreamRequest(runId: string, before?: string) {
	const issuedAt = Date.now();
	const ticket: OperationsIntelligenceStreamTicket = {
		protocolVersion: operationsIntelligenceProtocolVersion,
		eventSlug: 'code2create-7',
		instanceId: runId,
		agentName: 'operations-autopilot',
		capability: 'read',
		issuedAt,
		expiresAt: issuedAt + 60_000,
		nonce: 'autonomy_nonce_1234567890',
		runId,
	};
	const body = serializeOperationsIntelligenceStreamTicket(ticket);
	const timestamp = String(issuedAt);
	const signature = await signServiceBody({
		context: operationsAutonomyStreamTicketSignatureContext,
		secret,
		timestamp,
		body,
	});
	const search = new URLSearchParams({ view: 'history' });
	if (before !== undefined) search.set('before', before);
	return app.request(`/v1/operations-autonomy-runs/${runId}?${search}`, {
		method: 'GET',
		headers: {
			origin: environment.OPS_ORIGIN,
			[operationsIntelligenceStreamTicketHeaders.ticket]:
				encodeOperationsIntelligenceStreamTicket(ticket),
			[operationsIntelligenceStreamTicketHeaders.timestamp]: timestamp,
			[operationsIntelligenceStreamTicketHeaders.signature]: signature,
		},
	}, environment);
}
