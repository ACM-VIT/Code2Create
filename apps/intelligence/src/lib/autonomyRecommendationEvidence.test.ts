import { describe, expect, test } from 'vitest';

import {
	autonomyCitationIdentity,
	canonicalAutonomyCitation,
} from './autonomyCatalog.ts';
import type { AutonomyCandidate, AutonomyCitation } from './autonomyExecution.ts';
import { findAutonomyTargetSourceLeaf } from './autonomyRecommendationEvidence.ts';

const candidateCitation: AutonomyCitation = {
	read: 'operations_attention',
	generatedAt: 19,
	operationId: 'read:attention:2',
	snapshot: 'snapshot-attention',
	keys: ['attention-7', '4'],
};

function candidate(): AutonomyCandidate {
	return {
		statement: 'Dismiss the grounded attention item after human review.',
		reasoning: 'The exact item and expected version are grounded in the source page.',
		citations: [candidateCitation],
		arguments: {
			kind: 'dismiss_attention_item',
			itemId: 'attention-7',
			expectedItemVersion: 4,
			reason: 'The operator should review the exact current attention item.',
		},
	};
}

describe('autonomy recommendation evidence', () => {
	test('uses the exact source-leaf identity when the candidate cites a key subset', async () => {
		const value = candidate();
		const unrelated = canonicalAutonomyCitation({
			...candidateCitation,
			operationId: 'read:attention:1',
			keys: ['attention-other', '1'],
		});
		const exactSourceLeaf = canonicalAutonomyCitation({
			...candidateCitation,
			keys: ['queue-critical', '4', 'attention-7'],
		});
		const unrelatedIdentity = await autonomyCitationIdentity(unrelated);
		const sourceIdentity = await autonomyCitationIdentity(exactSourceLeaf);
		const derivedSubsetIdentity = await autonomyCitationIdentity(candidateCitation);

		expect(findAutonomyTargetSourceLeaf({
			candidate: value,
			leaves: [{ identity: unrelatedIdentity, citation: unrelated }],
		})).toBeUndefined();
		expect(findAutonomyTargetSourceLeaf({
			candidate: value,
			leaves: [{ identity: sourceIdentity, citation: exactSourceLeaf }],
		})).toEqual({ identity: sourceIdentity, citation: exactSourceLeaf });
		expect(sourceIdentity).not.toBe(derivedSubsetIdentity);
	});
});
