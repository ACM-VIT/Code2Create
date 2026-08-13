import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

function installedDispatchSource() {
	const runtimeEntry = fileURLToPath(import.meta.resolve('@flue/runtime'));
	const distributionDirectory = dirname(runtimeEntry);
	const dispatchFilename = readdirSync(distributionDirectory)
		.find((filename) => /^dispatch-.+\.mjs$/u.test(filename));
	if (dispatchFilename === undefined) {
		throw new Error('The installed Flue runtime dispatch module is missing.');
	}
	return readFileSync(join(distributionDirectory, dispatchFilename), 'utf8');
}

describe('patched Flue history projection', () => {
	test('limits and pages native history before the router serializes it', () => {
		const source = installedDispatchSource();

		expect(source).toContain('x-flue-history-message-limit');
		expect(source).toContain('latestMessageProjection');
		expect(source).toContain('messages.slice(-messageLimit)');
		expect(source).toContain('x-flue-history-before-message-key');
		expect(source).toContain('x-flue-history-earliest-message-key');
		expect(source).toContain('x-flue-history-has-earlier');
		expect(source).toContain(
			'projectAgentConversationSnapshot(options.state, options.messageLimit)',
		);
	});
});
