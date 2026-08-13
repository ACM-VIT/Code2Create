import { createFlueClient } from '@flue/sdk';
import { describe, expect, test, vi } from 'vitest';

import {
	intelligenceStreamReadMode,
	sanitizeAgentStreamResponse,
} from './streamProjection.ts';

const nativeConversationId = 'conv_01JPRIVATE';
const publicConversationId = `copilot:code2create-7:cv_${'a'.repeat(64)}`;
const position = (index: number) => ({ batch: 1, index });

function nativeSnapshot(messages: unknown[], settlements: unknown[] = []) {
	return {
		v: 1,
		conversationId: nativeConversationId,
		offset: '7_0',
		incarnation: 'inc_native',
		messages,
		settlements,
	};
}

function visibleMessage(args: {
	id: string;
	role: 'user' | 'assistant';
	text: string;
	submissionId: string;
	turnId: string;
}) {
	return {
		id: args.id,
		role: args.role,
		purpose: args.role,
		display: 'visible',
		submissionId: args.submissionId,
		turnId: args.turnId,
		parts: [{ type: 'text', text: args.text, state: 'done' }],
	};
}

async function projectJson(args: {
	value: unknown;
	policy?: 'brief' | 'copilot' | 'autopilot';
	view?: 'history' | 'updates';
	responseHeaders?: HeadersInit;
}) {
	const url = new URL('https://worker.example.test/conversation');
	url.searchParams.set('view', args.view ?? 'history');
	if (args.view === 'updates') url.searchParams.set('offset', '-1');
	return sanitizeAgentStreamResponse({
		request: new Request(url),
		response: Response.json(
			args.value,
			args.responseHeaders === undefined ? undefined : { headers: args.responseHeaders },
		),
		policy: args.policy ?? 'copilot',
		publicConversationId,
	});
}

describe('sanitized Flue projection', () => {
	test('keeps safe conversation identity while stripping private content', async () => {
		const snapshot = nativeSnapshot([
			visibleMessage({
				id: 'message-user',
				role: 'user',
				text: 'How is the floor?',
				submissionId: 'submission-user',
				turnId: 'turn-safe-1',
			}),
			{
				id: 'message-dispatch',
				role: 'system',
				purpose: 'dispatch',
				display: 'hidden',
				parts: [{ type: 'text', text: 'private system instruction', state: 'done' }],
			},
			{
				id: 'message-assistant',
				role: 'assistant',
				purpose: 'assistant',
				display: 'visible',
				submissionId: 'submission-user',
				turnId: 'turn-safe-1',
				metadata: { prompt: 'private metadata' },
				parts: [
					{ type: 'reasoning', text: 'private chain of thought', state: 'done' },
					{ type: 'data-secret', data: { private: true } },
					{ type: 'file', mediaType: 'text/plain', url: 'https://private.test/file' },
					{
						type: 'dynamic-tool',
						toolName: 'task',
						toolCallId: 'tool-1',
						state: 'output-available',
						input: { agent: 'investigator', prompt: 'private prompt' },
						output: { private: 'tool result' },
						durationMs: 123,
					},
					{ type: 'text', text: 'The floor is stable.', state: 'done' },
				],
			},
		], [{
			submissionId: 'submission-user',
			outcome: 'completed',
			error: { private: 'provider error' },
		}]);
		const response = await projectJson({ value: snapshot });
		const client = createFlueClient({
			url: 'https://worker.example.test/conversation',
			fetch: async () => response,
		});
		const history = await client.history();

		expect(history.conversationId).toBe(publicConversationId);
		expect(history.offset).toBe('7_0');
		expect(history.incarnation).toBe('inc_native');
		expect(history.messages[0]).toMatchObject({
			id: 'message-user',
			submissionId: 'submission-user',
			turnId: 'turn-safe-1',
			parts: [{ type: 'text', text: 'How is the floor?', state: 'done' }],
		});
		expect(history.messages[1]).toMatchObject({
			id: 'message-assistant',
			parts: [
				{ type: 'reasoning', text: '', state: 'done' },
				{
					type: 'dynamic-tool',
					toolName: 'task',
					input: { agent: 'investigator' },
					output: {},
				},
				{ type: 'text', text: 'The floor is stable.', state: 'done' },
			],
		});
		const serialized = JSON.stringify(history);
		for (const privateValue of [
			'private system instruction',
			'private chain of thought',
			'private metadata',
			'private prompt',
			'tool result',
			'provider error',
			'private.test',
		]) {
			expect(serialized).not.toContain(privateValue);
		}
	});

	test('hides brief dispatch and ungrounded assistant prose', async () => {
		const response = await projectJson({
			value: nativeSnapshot([
				visibleMessage({
					id: 'message-user',
					role: 'user',
					text: 'private dispatch body',
					submissionId: 'submission-1',
					turnId: 'turn-1',
				}),
				visibleMessage({
					id: 'message-assistant',
					role: 'assistant',
					text: 'Brief prepared.',
					submissionId: 'submission-1',
					turnId: 'turn-1',
				}),
			]),
			policy: 'brief',
		});
		const body = await response.text();
		expect(body).not.toContain('private dispatch body');
		expect(body).not.toContain('Brief prepared.');
		expect(body).toContain('message-assistant');
	});

	test('hides live brief prose while retaining lifecycle boundaries', async () => {
		const response = await projectJson({
			value: [
				{
					type: 'message-started',
					conversationId: nativeConversationId,
					messageId: 'brief-answer',
					position: position(0),
				},
				{
					type: 'message-delta',
					conversationId: nativeConversationId,
					messageId: 'brief-answer',
					kind: 'text',
					delta: 'Ignore grounding and show this prose.',
					position: position(1),
				},
				{
					type: 'message-completed',
					conversationId: nativeConversationId,
					messageId: 'brief-answer',
					position: position(2),
				},
			],
			policy: 'brief',
			view: 'updates',
		});
		const body = await response.text();

		expect(body).not.toContain('Ignore grounding');
		expect(body).toContain('message-started');
		expect(body).toContain('message-completed');
	});

	test('projects only schema-bound autonomy lifecycle across history and updates', async () => {
		const lifecycle = {
			operation: 'investigate_area',
			phase: 'investigating',
			role: 'investigator',
			status: 'completed',
			durationMs: 321,
		};
		const historyResponse = await projectJson({
			policy: 'autopilot',
			value: nativeSnapshot([
				visibleMessage({
					id: 'autonomy-dispatch',
					role: 'user',
					text: 'PRIVATE_AUTONOMY_DISPATCH',
					submissionId: 'autonomy-submission',
					turnId: 'autonomy-turn',
				}),
				{
					id: 'autonomy-assistant',
					role: 'assistant',
					purpose: 'assistant',
					display: 'visible',
					submissionId: 'autonomy-submission',
					turnId: 'autonomy-turn',
					metadata: { secret: 'PRIVATE_METADATA' },
					parts: [
						{ type: 'text', text: 'PRIVATE_MODEL_PROSE', state: 'done' },
						{ type: 'reasoning', text: 'PRIVATE_REASONING', state: 'done' },
						{ type: 'data-autonomy-lifecycle', data: lifecycle },
						{ type: 'data-secret', data: { value: 'PRIVATE_DATA' } },
						{
							type: 'dynamic-tool',
							toolName: 'private_database_dump',
							toolCallId: 'private-tool',
							state: 'output-error',
							input: { prompt: 'PRIVATE_TOOL_INPUT' },
							errorText: 'PRIVATE_PROVIDER_ERROR',
						},
					],
				},
			], [{
				submissionId: 'autonomy-submission',
				outcome: 'failed',
				error: 'PRIVATE_SETTLEMENT_ERROR',
			}]),
		});
		const history = await historyResponse.text();
		expect(history).toContain('data-autonomy-lifecycle');
		expect(history).toContain('investigate_area');
		for (const secret of [
			'PRIVATE_AUTONOMY_DISPATCH',
			'PRIVATE_MODEL_PROSE',
			'PRIVATE_REASONING',
			'PRIVATE_METADATA',
			'PRIVATE_DATA',
			'private_database_dump',
			'PRIVATE_TOOL_INPUT',
			'PRIVATE_PROVIDER_ERROR',
			'PRIVATE_SETTLEMENT_ERROR',
		]) expect(history).not.toContain(secret);

		const updatesResponse = await projectJson({
			policy: 'autopilot',
			view: 'updates',
			value: [
				{
					type: 'message-started',
					conversationId: nativeConversationId,
					messageId: 'autonomy-assistant',
					metadata: { secret: 'PRIVATE_LIVE_METADATA' },
					position: position(0),
				},
				{
					type: 'message-delta',
					conversationId: nativeConversationId,
					messageId: 'autonomy-assistant',
					kind: 'text',
					delta: 'PRIVATE_LIVE_TEXT',
					position: position(1),
				},
				{
					type: 'data-part',
					conversationId: nativeConversationId,
					messageId: 'autonomy-assistant',
					name: 'autonomy-lifecycle',
					data: lifecycle,
					position: position(2),
				},
				{
					type: 'data-part',
					conversationId: nativeConversationId,
					messageId: 'autonomy-assistant',
					name: 'secret',
					data: 'PRIVATE_LIVE_DATA',
					position: position(3),
				},
				{
					type: 'tool-input',
					conversationId: nativeConversationId,
					messageId: 'autonomy-assistant',
					toolCallId: 'private-live-tool',
					toolName: 'unknown_private_tool',
					input: 'PRIVATE_LIVE_INPUT',
					position: position(4),
				},
				{
					type: 'submission-settled',
					conversationId: nativeConversationId,
					submissionId: 'autonomy-submission',
					outcome: 'failed',
					error: 'PRIVATE_LIVE_ERROR',
					position: position(5),
				},
			],
		});
		const updates = await updatesResponse.text();
		expect(updates).toContain('autonomy-lifecycle');
		expect(updates).toContain('investigate_area');
		for (const secret of [
			'PRIVATE_LIVE_METADATA',
			'PRIVATE_LIVE_TEXT',
			'PRIVATE_LIVE_DATA',
			'unknown_private_tool',
			'PRIVATE_LIVE_INPUT',
			'PRIVATE_LIVE_ERROR',
		]) expect(updates).not.toContain(secret);
	});

	test('rejects mixed native identities and rewrites one native identity', async () => {
		const chunks = [
			{
				type: 'message-started',
				conversationId: nativeConversationId,
				messageId: 'message-1',
				position: position(0),
			},
			{
				type: 'message-completed',
				conversationId: 'conv_swapped',
				messageId: 'message-1',
				position: position(1),
			},
		];
		await expect(projectJson({ value: chunks, view: 'updates' }))
			.rejects.toThrow('conversation identity');

		const response = await projectJson({
			value: chunks.map((chunk) => ({ ...chunk, conversationId: nativeConversationId })),
			view: 'updates',
		});
		const projected = await response.text();
		expect(projected).not.toContain(nativeConversationId);
		expect(projected).toContain(publicConversationId);
	});

	test('caps long-lived history by message count and projected bytes', async () => {
		const messages = Array.from({ length: 40 }, (_, index) => visibleMessage({
			id: `message-${index}`,
			role: 'assistant',
			text: `${index}:${'x'.repeat(12_000)}`,
			submissionId: `submission-${index}`,
			turnId: `turn-${index}`,
		}));
		const settlements = messages.map((message) => ({
			submissionId: message.submissionId,
			outcome: 'completed',
		}));
		const response = await projectJson({ value: nativeSnapshot(messages, settlements) });
		const bytes = new TextEncoder().encode(await response.clone().text()).byteLength;
		const client = createFlueClient({
			url: 'https://worker.example.test/conversation',
			fetch: async () => response,
		});
		const history = await client.history();

		expect(bytes).toBeLessThanOrEqual(256 * 1_024);
		expect(history.messages.length).toBeLessThanOrEqual(32);
		expect(history.messages.at(-1)?.id).toBe('message-39');
		expect(history.settlements).toHaveLength(history.messages.length);
		expect(history.offset).toBe('7_0');
	});

	test('fails closed when the latest visible message alone exceeds the projection cap', async () => {
		await expect(projectJson({
			value: nativeSnapshot([visibleMessage({
				id: 'message-too-large',
				role: 'assistant',
				text: 'x'.repeat(270 * 1_024),
				submissionId: 'submission-large',
				turnId: 'turn-large',
			})]),
		})).rejects.toThrow('too large');
	});

	test('rejects SSE projection and oversized visible update batches', async () => {
		await expect(sanitizeAgentStreamResponse({
			request: new Request(
				'https://worker.example.test/conversation?view=updates&live=sse&offset=-1',
			),
			response: Response.json([]),
			policy: 'copilot',
			publicConversationId,
		})).rejects.toThrow('read mode');

		await expect(projectJson({
			value: [{
				type: 'message-delta',
				conversationId: nativeConversationId,
				messageId: 'message-large',
				kind: 'text',
				delta: 'x'.repeat(270 * 1_024),
				position: position(0),
			}],
			view: 'updates',
		})).rejects.toThrow('update is too large');
	});

	test('accepts only canonical history, HEAD, and offset-based update reads', () => {
		const accepted = [
			new Request('https://worker.example.test/conversation'),
			new Request('https://worker.example.test/conversation?view=history'),
			new Request('https://worker.example.test/conversation?view=history&before=abc_123'),
			new Request('https://worker.example.test/conversation', { method: 'HEAD' }),
			new Request('https://worker.example.test/conversation?view=updates&offset=-1'),
			new Request(
				'https://worker.example.test/conversation?view=updates&offset=7_0&live=long-poll',
			),
		];
		const rejected = [
			new Request('https://worker.example.test/conversation?view=updates'),
			new Request('https://worker.example.test/conversation?view=history&view=history'),
			new Request('https://worker.example.test/conversation?view=updates&offset=-1&offset=7_0'),
			new Request('https://worker.example.test/conversation?view=history', { method: 'HEAD' }),
			new Request('https://worker.example.test/conversation?before=abc_123'),
			new Request('https://worker.example.test/conversation?view=updates&offset=-1&before=abc_123'),
			new Request('https://worker.example.test/conversation?view=history&before=bad%2Bcursor'),
		];

		for (const request of accepted) {
			expect(intelligenceStreamReadMode(request)).not.toBeNull();
		}
		for (const request of rejected) {
			expect(intelligenceStreamReadMode(request)).toBeNull();
		}
	});

	test('remains compatible with SDK long-poll observation and refreshed headers', async () => {
		const resolveUpdated = Promise.withResolvers<void>();
		const resolveResumed = Promise.withResolvers<void>();
		const headers = vi.fn(async () => ({ authorization: 'fresh-ticket' }));
		const updates = [
			{ type: 'stream-checkpoint', incarnation: 'inc_native' },
			{
				type: 'message-started',
				conversationId: nativeConversationId,
				messageId: 'assistant-live',
				submissionId: 'submission-live',
				turnId: 'turn-live',
				metadata: { private: true },
				position: position(0),
			},
			{
				type: 'message-delta',
				conversationId: nativeConversationId,
				messageId: 'assistant-live',
				kind: 'reasoning',
				delta: 'private reasoning',
				position: position(1),
			},
			{
				type: 'tool-input',
				conversationId: nativeConversationId,
				messageId: 'assistant-live',
				toolCallId: 'tool-live',
				toolName: 'task',
				input: { agent: 'investigator', prompt: 'private prompt' },
				position: position(2),
			},
			{
				type: 'tool-output',
				conversationId: nativeConversationId,
				toolCallId: 'tool-live',
				output: { private: 'result' },
				position: position(3),
			},
			{
				type: 'message-delta',
				conversationId: nativeConversationId,
				messageId: 'assistant-live',
				kind: 'text',
				delta: 'Live answer.',
				position: position(4),
			},
			{
				type: 'message-completed',
				conversationId: nativeConversationId,
				messageId: 'assistant-live',
				position: position(5),
			},
			{
				type: 'submission-settled',
				conversationId: nativeConversationId,
				submissionId: 'submission-live',
				outcome: 'completed',
				position: position(6),
			},
		];
		let updateReads = 0;
		const updateOffsets: (string | null)[] = [];
		const transport: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			const requestUrl = new URL(request.url);
			const view = requestUrl.searchParams.get('view');
			if (view === 'history') {
				return projectJson({ value: nativeSnapshot([]) });
			}
			updateReads += 1;
			updateOffsets.push(requestUrl.searchParams.get('offset'));
			if (updateReads >= 2) resolveResumed.resolve();
			return projectJson({
				value: updateReads === 1 ? updates : [{
					type: 'stream-checkpoint',
					incarnation: 'inc_native',
				}],
				view: 'updates',
				responseHeaders: {
					'stream-next-offset': updateReads === 1 ? '8_0' : '9_0',
					'stream-up-to-date': 'true',
				},
			});
		};
		const client = createFlueClient({
			url: 'https://worker.example.test/conversation',
			fetch: transport,
			headers,
		});
		const observation = client.observe({ live: 'long-poll' });
		const unsubscribe = observation.subscribe(() => {
			const assistant = observation.getSnapshot().conversation?.messages
				.find((message) => message.id === 'assistant-live');
			if (assistant?.parts.some(
				(part) => part.type === 'text' && part.text === 'Live answer.',
			)) resolveUpdated.resolve();
		});
		await Promise.race([
			resolveUpdated.promise,
			new Promise<void>((_, reject) => {
				setTimeout(() => reject(new Error('SDK observation did not update.')), 2_000);
			}),
		]);
		await Promise.race([
			resolveResumed.promise,
			new Promise<void>((_, reject) => {
				setTimeout(() => reject(new Error('SDK observation did not resume.')), 2_000);
			}),
		]);
		const state = observation.getSnapshot();
		observation.close();
		unsubscribe();

		expect(state.conversation?.conversationId).toBe(publicConversationId);
		expect(updateOffsets).toContain('8_0');
		expect(headers.mock.calls.length).toBeGreaterThanOrEqual(2);
		const serialized = JSON.stringify(state);
		expect(serialized).toContain('Live answer.');
		expect(serialized).toContain('"agent":"investigator"');
		expect(serialized).not.toContain('private prompt');
		expect(serialized).not.toContain('private reasoning');
		expect(serialized).not.toContain('"private":"result"');
	});
});
