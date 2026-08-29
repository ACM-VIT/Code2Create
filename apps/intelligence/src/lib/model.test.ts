import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { describe, expect, test } from 'vitest';

import {
	operationsIntelligenceModel,
	operationsIntelligenceModelId,
} from './model.ts';

describe('intelligence model', () => {
	test('pins an OpenAI Responses model with strict tools', () => {
		const provider = openaiProvider();
		const model = provider.getModels().find(
			(candidate) => candidate.id === operationsIntelligenceModelId,
		);

		expect(provider.id).toBe('openai');
		expect(operationsIntelligenceModel).toBe(`openai/${operationsIntelligenceModelId}`);
		expect(model).toMatchObject({
			api: 'openai-responses',
			provider: 'openai',
			reasoning: true,
			compat: {
				supportsOpenAIGrammarTools: true,
				supportsStrictMode: true,
			},
		});
	});
});
