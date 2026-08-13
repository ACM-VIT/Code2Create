import { cloudflareBindingProvider } from '@flue/runtime/cloudflare/workers-ai';
import { describe, expect, test, vi } from 'vitest';

const modelId = '@cf/moonshotai/kimi-k2.6';

function providerReturning(response: Response) {
	return cloudflareBindingProvider({
		binding: {
			async run() {
				return response;
			},
		},
		gateway: false,
		streamIdleTimeoutMs: 1_000,
	});
}

async function consume(response: Response) {
	const provider = providerReturning(response);
	const model = provider.getModels().find((candidate) => candidate.id === modelId);
	if (model === undefined) throw new Error('The pinned Workers AI model is missing.');
	const events: string[] = [];
	for await (const event of provider.streamSimple(model, {
		messages: [{ role: 'user', content: 'test', timestamp: 1 }],
	}, { maxTokens: 8 })) {
		events.push(JSON.stringify(event));
	}
	return events.join('\n');
}

describe('patched Workers AI privacy boundary', () => {
	test('does not log malformed SSE payload content', async () => {
		const sentinel = 'private-model-output-sentinel';
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const events = await consume(new Response(`data: ${sentinel}\n\n`, {
			status: 200,
			headers: { 'content-type': 'text/event-stream' },
		}));

		expect(error).toHaveBeenCalledWith(
			'Workers AI: dropping an unparseable SSE data payload.',
		);
		expect(JSON.stringify(error.mock.calls)).not.toContain(sentinel);
		expect(events).not.toContain(sentinel);
		error.mockRestore();
	});

	test('reports only status for a non-OK response without reading its body', async () => {
		const sentinel = 'private-provider-error-sentinel';
		const response = new Response(sentinel, {
			status: 503,
			statusText: sentinel,
		});
		const readBody = vi.spyOn(response, 'text');
		const events = await consume(response);

		expect(readBody).not.toHaveBeenCalled();
		expect(events).toContain('503');
		expect(events).not.toContain(sentinel);
	});
});
