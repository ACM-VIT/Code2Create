import {
	operationsAutonomyCallbackSignatureContext,
	operationsAutonomyReadSignatureContext,
	operationsAutonomyRecommendationEvidenceSignatureContext,
	operationsAutonomyRecommendationSignatureContext,
	operationsAutonomyWorkSignatureContext,
	signServiceBody,
	verifyServiceBody,
} from '@code2create/domain';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createAutonomyExecutionInterceptor } from '../lib/autonomyInstrumentation.ts';
import { autonomyRunState, clearAutonomyRunForTests } from '../lib/autonomyContext.ts';
import {
	deliverAutonomyCallback,
	deliverAutonomyRecommendation,
	deliverAutonomyRecommendationEvidence,
	performAutonomyRead,
} from '../lib/autonomyTransport.ts';
import { autonomyCitationIdentity } from '../lib/autonomyCatalog.ts';
import { autonomyOperationId } from '../lib/autonomyOperationId.ts';
import {
	autonomyEvaluationGeneratedAt,
	autonomyEvaluationInput,
	autonomyEvaluationInjection,
	autonomyEvaluationSnapshot,
	finalAttentionItem,
	SignedAutonomyEvaluationBackend,
} from './autonomy-harness.ts';

const contextsByPath = {
	'/work': { context: operationsAutonomyWorkSignatureContext, secret: 'read' },
	'/read': { context: operationsAutonomyReadSignatureContext, secret: 'read' },
	'/recommendation': {
		context: operationsAutonomyRecommendationSignatureContext,
		secret: 'callback',
	},
	'/recommendation-evidence': {
		context: operationsAutonomyRecommendationEvidenceSignatureContext,
		secret: 'callback',
	},
	'/callback': { context: operationsAutonomyCallbackSignatureContext, secret: 'callback' },
} as const;

function inspectionAuthority(pathname: string) {
	if (pathname === '/work') return contextsByPath['/work'];
	if (pathname === '/read') return contextsByPath['/read'];
	if (pathname === '/recommendation') return contextsByPath['/recommendation'];
	if (pathname === '/recommendation-evidence') {
		return contextsByPath['/recommendation-evidence'];
	}
	if (pathname === '/callback') return contextsByPath['/callback'];
	return undefined;
}

function requestBody(init: RequestInit | undefined) {
	if (typeof init?.body !== 'string') {
		throw new Error('The signed evaluation request body was not canonical JSON text.');
	}
	return init.body;
}

function signedBoundaryInspector(
	backend: SignedAutonomyEvaluationBackend,
	inspectedBodies: string[],
): typeof fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		const path = new URL(request.url).pathname;
		const authority = inspectionAuthority(path);
		if (authority === undefined) throw new Error(`Unexpected evaluation path: ${path}`);
		const body = requestBody(init);
		const timestamp = request.headers.get('x-c2c-timestamp') ?? '';
		const timestampNumber = Number(timestamp);
		const valid = Number.isSafeInteger(timestampNumber) && await verifyServiceBody({
			context: authority.context,
			secret: authority.secret === 'read'
				? backend.bindings.INTELLIGENCE_READ_SECRET
				: backend.bindings.INTELLIGENCE_CALLBACK_SECRET,
			timestamp,
			signature: request.headers.get('x-c2c-signature') ?? '',
			body,
			now: timestampNumber,
			maximumAgeMs: 1,
		});
		if (!valid) throw new Error(`The ${path} boundary was not signed with its exact context.`);
		inspectedBodies.push(body);
		return backend.request(input, init);
	};
}

describe('operations autonomy deterministic boundary evaluation', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('authorizes every model boundary, including after local context loss', async () => {
		const input = autonomyEvaluationInput();
		const backend = new SignedAutonomyEvaluationBackend();
		vi.stubGlobal('fetch', backend.request);
		const interceptor = createAutonomyExecutionInterceptor(backend.bindings);
		const executedTurns: string[] = [];

		await interceptor(
			{ type: 'model', turnId: 'turn-planner' },
			{ agentName: 'operations-autopilot', instanceId: input.runId, initialData: input },
			async () => {
				executedTurns.push('turn-planner');
				return 'planner-result';
			},
		);
		clearAutonomyRunForTests(input.runId);
		await interceptor(
			{ type: 'model', turnId: 'turn-investigator-after-restart' },
			{ agentName: 'operations-autopilot', instanceId: input.runId, initialData: input },
			async () => {
				executedTurns.push('turn-investigator-after-restart');
				return 'investigator-result';
			},
		);

		expect(executedTurns).toEqual([
			'turn-planner',
			'turn-investigator-after-restart',
		]);
		expect(backend.trace.filter((entry) => entry.boundary === 'work')).toHaveLength(2);
		expect(backend.trace.map((entry) => entry.sequence)).toEqual([1, 2]);
		clearAutonomyRunForTests(input.runId);
	});

	test('preserves a signed two-page snapshot and exact later-page provenance across restart', async () => {
		const input = autonomyEvaluationInput();
		const backend = new SignedAutonomyEvaluationBackend();
		const inspectedBodies: string[] = [];
		const request = signedBoundaryInspector(backend, inspectedBodies);
		let state = autonomyRunState(input);
		const firstOperationId = await autonomyOperationId('read', [input.runId, 'attention', '0']);
		const first = await performAutonomyRead({
			state,
			operationId: firstOperationId,
			read: 'operations_attention',
			bindings: backend.bindings,
			request,
		});
		if (first.read !== 'operations_attention') {
			throw new Error('The evaluation received the wrong first read projection.');
		}
		expect(first.page).toEqual({
			cursor: 'cursor-attention-page-2',
			isDone: false,
			snapshot: autonomyEvaluationSnapshot,
		});
		expect(first.data.items[0]?.statement).toBe(autonomyEvaluationInjection);

		clearAutonomyRunForTests(input.runId);
		state = autonomyRunState(input);
		const secondOperationId = await autonomyOperationId('read', [input.runId, 'attention', '1']);
		const nextCursor = first.page.cursor;
		if (nextCursor === undefined) {
			throw new Error('The first evaluation page did not expose its continuation cursor.');
		}
		const second = await performAutonomyRead({
			state,
			operationId: secondOperationId,
			read: 'operations_attention',
			cursor: nextCursor,
			bindings: backend.bindings,
			request,
		});
		expect(second.page).toEqual({
			isDone: true,
			snapshot: autonomyEvaluationSnapshot,
		});

		const proposalKey = 'proposal-attention-final-v7';
		const citation = {
			read: 'operations_attention' as const,
			generatedAt: autonomyEvaluationGeneratedAt,
			operationId: secondOperationId,
			snapshot: autonomyEvaluationSnapshot,
			keys: [String(finalAttentionItem.version), finalAttentionItem.itemId].sort(),
		};
		const citationIdentity = await autonomyCitationIdentity(citation);
		const evidenceSetId = await autonomyOperationId('recommendation', [
			input.runId,
			'evidence-set',
			proposalKey,
		]);
		const evidence = await deliverAutonomyRecommendationEvidence({
			state,
			content: {
				operationId: await autonomyOperationId('recommendation', [
					evidenceSetId,
					'evidence-page',
					'0',
				]),
				proposalKey,
				evidenceSetId,
				pageIndex: 0,
				citations: [citation],
				isDone: true,
			},
			bindings: backend.bindings,
			request,
		});
		if (evidence.seal === undefined) {
			throw new Error('The terminal evaluation evidence page did not seal.');
		}
		const recommendationOperationId = await autonomyOperationId('recommendation', [
			input.runId,
			finalAttentionItem.itemId,
			String(finalAttentionItem.version),
		]);
		const recommendation = await deliverAutonomyRecommendation({
			state,
			content: {
				operationId: recommendationOperationId,
				proposalKey,
				statement: 'The exact later-page attention item needs a human decision.',
				reasoning: 'The frozen second page carries the exact item and version.',
				evidenceSet: evidence.seal,
				targetCitationIdentity: citationIdentity,
				arguments: {
					kind: 'dismiss_attention_item',
					itemId: finalAttentionItem.itemId,
					expectedItemVersion: finalAttentionItem.version,
					reason: 'A cited versioned attention item needs an operator decision.',
				},
			},
			agentVersion: 'operations-autopilot-eval',
			model: 'cloudflare/eval-model',
			bindings: backend.bindings,
			request,
		});
		expect(recommendation.recommendationId).toBe('recommendation-autonomy-eval');
		expect(inspectedBodies.join('\n')).not.toContain('INTELLIGENCE_');
		expect(backend.trace.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);
		clearAutonomyRunForTests(input.runId);
	});

	test('replays an exact lost response after later work without repeating the effect', async () => {
		const input = autonomyEvaluationInput();
		const backend = new SignedAutonomyEvaluationBackend();
		const state = autonomyRunState(input);
		const operationId = await autonomyOperationId('callback', [input.runId, 'planning']);
		const args = {
			state,
			operationId,
			content: {
				status: 'running' as const,
				phase: 'planning' as const,
				observedSignalKeys: [],
			},
			agentVersion: 'operations-autopilot-eval',
			model: 'cloudflare/eval-model',
			bindings: backend.bindings,
			request: backend.request,
		};

		let dropFirstResponse = true;
		const loseCommittedResponse: typeof fetch = async (request, init) => {
			const response = await backend.request(request, init);
			if (dropFirstResponse) {
				dropFirstResponse = false;
				throw new TypeError('Simulated transport loss after the backend committed the callback.');
			}
			return response;
		};
		await expect(deliverAutonomyCallback({
			...args,
			request: loseCommittedResponse,
		})).rejects.toThrow('Simulated transport loss');
		const later = await performAutonomyRead({
			state,
			operationId: await autonomyOperationId('read', [input.runId, 'attention', 'later']),
			read: 'operations_attention',
			bindings: backend.bindings,
			request: backend.request,
		});
		const replay = await deliverAutonomyCallback(args);

		expect(replay.sequence).toBe(1);
		expect(later.sequence).toBeGreaterThan(replay.sequence);
		expect(backend.effectCount('callback', operationId)).toBe(1);
		expect(backend.trace.at(-1)).toMatchObject({
			boundary: 'callback',
			operationId,
			replayed: true,
			sequence: replay.sequence,
		});
		clearAutonomyRunForTests(input.runId);
	});

	test('rejects citation splicing before any consequential domain effect exists', async () => {
		const input = autonomyEvaluationInput();
		const backend = new SignedAutonomyEvaluationBackend();
		const state = autonomyRunState(input);
		const firstOperationId = await autonomyOperationId('read', [input.runId, 'attention', 'first']);
		await performAutonomyRead({
			state,
			operationId: firstOperationId,
			read: 'operations_attention',
			bindings: backend.bindings,
			request: backend.request,
		});
		const operationId = await autonomyOperationId('recommendation', [
			input.runId,
			'evidence-page',
			'spliced',
		]);

		await expect(deliverAutonomyRecommendationEvidence({
			state,
			content: {
				operationId,
				proposalKey: 'proposal-spliced',
				evidenceSetId: await autonomyOperationId('recommendation', [
					input.runId,
					'evidence-set',
					'spliced',
				]),
				pageIndex: 0,
				citations: [{
					read: 'operations_attention',
					generatedAt: autonomyEvaluationGeneratedAt,
					operationId: firstOperationId,
					snapshot: autonomyEvaluationSnapshot,
					keys: [String(finalAttentionItem.version), finalAttentionItem.itemId].sort(),
				}],
				isDone: true,
			},
			bindings: backend.bindings,
			request: backend.request,
		})).rejects.toMatchObject({ status: 422 });
		expect(backend.effectCount('recommendation_support', operationId)).toBe(0);
		clearAutonomyRunForTests(input.runId);
	});

	test('uses distinct HMAC domains rather than a generic signed endpoint', async () => {
		const body = JSON.stringify({ runId: 'run-autonomy-eval' });
		const timestamp = Date.now().toString();
		const secret = 'e'.repeat(64);
		const workSignature = await signServiceBody({
			context: operationsAutonomyWorkSignatureContext,
			secret,
			timestamp,
			body,
		});
		expect(await verifyServiceBody({
			context: operationsAutonomyRecommendationSignatureContext,
			secret,
			timestamp,
			signature: workSignature,
			body,
			now: Number(timestamp),
			maximumAgeMs: 1,
		})).toBe(false);
	});
});
