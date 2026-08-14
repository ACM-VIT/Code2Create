import { cloudflareBindingProvider } from '@flue/runtime/cloudflare/workers-ai';

export const intelligenceWorkersAiModelId = '@cf/moonshotai/kimi-k2.6';
export const operationsIntelligenceModel = `cloudflare/${intelligenceWorkersAiModelId}`;
export const modelStreamIdleTimeoutMs = 75_000;

export async function runConfiguredWorkersAi(
	ai: Cloudflare.Env['AI'],
	modelId: string,
	inputs: Record<string, unknown>,
	options?: Record<string, unknown>,
) {
	if (modelId !== intelligenceWorkersAiModelId) {
		throw new Error('The configured Workers AI model is not allowed.');
	}
	const callerSignal = options?.['signal'];
	const extraHeaders = options?.['extraHeaders'];
	return ai.run(modelId, inputs, {
		returnRawResponse: true,
		gateway: {
			id: 'default',
			collectLog: false,
			skipCache: true,
		},
		...(callerSignal instanceof AbortSignal ? { signal: callerSignal } : {}),
		...(typeof extraHeaders === 'object' && extraHeaders !== null
			? { extraHeaders }
			: {}),
	});
}

export function createIntelligenceWorkersAiProvider(ai: Cloudflare.Env['AI']) {
	return cloudflareBindingProvider({
		binding: {
			run: (modelId, inputs, options) =>
				runConfiguredWorkersAi(ai, modelId, inputs, options),
		},
		// The binding adapter applies the fixed gateway policy above.
		gateway: false,
		streamIdleTimeoutMs: modelStreamIdleTimeoutMs,
	});
}
