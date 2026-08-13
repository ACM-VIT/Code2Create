import { cloudflareBindingProvider } from '@flue/runtime/cloudflare/workers-ai';

export const intelligenceWorkersAiModelId = '@cf/moonshotai/kimi-k2.6';
export const operationsIntelligenceModel = `cloudflare/${intelligenceWorkersAiModelId}`;
export const maximumModelOutputTokens = 2_048;
export const modelRequestTimeoutMs = 60_000;
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
	const timeoutSignal = AbortSignal.timeout(modelRequestTimeoutMs);
	const signals: AbortSignal[] = [timeoutSignal];
	if (callerSignal instanceof AbortSignal) signals.push(callerSignal);
	const signal = signals.length === 1 ? timeoutSignal : AbortSignal.any(signals);
	const extraHeaders = options?.['extraHeaders'];
	return ai.run(modelId, {
		...inputs,
		max_completion_tokens: maximumModelOutputTokens,
	}, {
		returnRawResponse: true,
		gateway: {
			id: 'default',
			collectLog: false,
			skipCache: true,
			requestTimeoutMs: modelRequestTimeoutMs,
		},
		signal,
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
