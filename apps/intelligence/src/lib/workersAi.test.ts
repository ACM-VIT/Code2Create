import { describe, expect, test, vi } from 'vitest';

import {
	createIntelligenceWorkersAiProvider,
	intelligenceWorkersAiModelId,
	runConfiguredWorkersAi,
} from './workersAi.ts';

function aiBinding() {
	const run = vi.fn();
	const ai: Cloudflare.Env['AI'] = {
		aiGatewayLogId: null,
		gateway: vi.fn(),
		aiSearch: vi.fn(),
		autorag: vi.fn(),
		run,
		models: vi.fn(),
		toMarkdown: vi.fn(),
	};
	return { ai, run };
}

describe('Workers AI policy', () => {
	test('pins the model, privacy, and cache without capping output or racing a timeout', async () => {
		const { ai, run } = aiBinding();
		run.mockResolvedValueOnce(new Response(null, { status: 200 }));
		const controller = new AbortController();
		await runConfiguredWorkersAi(ai, intelligenceWorkersAiModelId, {
			messages: [],
		}, { signal: controller.signal, extraHeaders: { 'x-session-affinity': 'session-1' } });

		expect(run).toHaveBeenCalledOnce();
		const invocation = run.mock.calls[0];
		if (invocation === undefined) throw new Error('Workers AI was not called.');
		expect(invocation[0]).toBe(intelligenceWorkersAiModelId);
		expect(invocation[1]).toEqual({ messages: [] });
		expect(invocation[2]).toMatchObject(
			{
				returnRawResponse: true,
				gateway: {
					id: 'default',
					collectLog: false,
					skipCache: true,
				},
				extraHeaders: { 'x-session-affinity': 'session-1' },
			},
		);
		expect(invocation[2]?.gateway).not.toHaveProperty('requestTimeoutMs');
		expect(invocation[1]).not.toHaveProperty('max_completion_tokens');
		expect(invocation[2]?.signal).toBe(controller.signal);
	});

	test('rejects every other model before calling the binding', async () => {
		const { ai, run } = aiBinding();
		await expect(runConfiguredWorkersAi(ai, '@cf/other/model', {}, undefined))
			.rejects.toThrow('not allowed');
		expect(run).not.toHaveBeenCalled();
	});

	test('resolves the pinned model from the installed catalog with context metadata', () => {
		const { ai } = aiBinding();
		const model = createIntelligenceWorkersAiProvider(ai)
			.getModels()
			.find((candidate) => candidate.id === intelligenceWorkersAiModelId);

		expect(model).toMatchObject({
			api: 'cloudflare-ai-binding',
			contextWindow: 262_144,
			maxTokens: 256_000,
			reasoning: true,
		});
	});
});
