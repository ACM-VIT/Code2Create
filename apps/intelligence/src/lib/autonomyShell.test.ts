import { describe, expect, test } from 'vitest';

import { classifyAutonomyShellSettlement } from './autonomyShell.ts';

describe('autonomy shell settlement', () => {
	test('keeps a model omission recoverable so a later submission can run the work item', () => {
		expect(classifyAutonomyShellSettlement([])).toBe('recoverable_missing_tool');
		expect(classifyAutonomyShellSettlement([{
			tool: 'run_autonomy_work_item',
			isError: false,
		}])).toBe('completed');
	});

	test('keeps provider and transport tool failures recoverable', () => {
		expect(classifyAutonomyShellSettlement([{
			tool: 'run_autonomy_work_item',
			isError: true,
		}])).toBe('recoverable_tool_failure');
	});
});
