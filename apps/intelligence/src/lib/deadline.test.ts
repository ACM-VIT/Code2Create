import { describe, expect, test } from 'vitest';

import { OperationDeadlineError, settleWithin } from './deadline.ts';

describe('operation admission deadline', () => {
	test('returns a settled admission and rejects a stalled admission', async () => {
		await expect(settleWithin(Promise.resolve('accepted'), 100)).resolves.toBe('accepted');
		await expect(settleWithin(new Promise(() => undefined), 1))
			.rejects.toBeInstanceOf(OperationDeadlineError);
	});
});
