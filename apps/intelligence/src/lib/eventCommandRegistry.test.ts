import { describe, expect, test } from 'vitest';

import { eventCommandCatalog, resolveEventCommand } from './eventCommandRegistry.ts';

describe('event command registry', () => {
	test('returns only the relevant command slice instead of loading every schema', () => {
		const result = eventCommandCatalog('change admission human reviews');
		expect(result.commands).toEqual([
			expect.objectContaining({
				command: 'configuration.admission.minimum_human_reviews.set',
			}),
		]);
	});

	test('resolves a catalog command to the strict signed transport shape', () => {
		expect(resolveEventCommand(
			'configuration.admission.minimum_human_reviews.set',
			JSON.stringify({ minimumHumanReviews: 1, reason: 'Use one organizer review.' }),
		)).toEqual({
			kind: 'set_admission_minimum_human_reviews',
			minimumHumanReviews: 1,
			reason: 'Use one organizer review.',
		});
	});

	test('rejects unknown commands and arguments outside the registered contract', () => {
		expect(() => resolveEventCommand('event.do_anything', '{}')).toThrow(
			'That event command is not registered',
		);
		expect(() => resolveEventCommand(
			'configuration.admission.minimum_human_reviews.set',
			JSON.stringify({ minimumHumanReviews: 0, reason: 'Too low to be valid.' }),
		)).toThrow();
	});
});
