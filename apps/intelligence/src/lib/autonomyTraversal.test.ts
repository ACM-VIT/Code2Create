import { describe, expect, test } from 'vitest';
import * as v from 'valibot';

import { memoryAutonomyArtifactStore } from './autonomyArtifacts.ts';
import { operationsAutonomyDispatchRequestSchema } from './autonomyProtocol.ts';
import { completeAutonomyPlan, type AutonomyPlan } from './autonomyExecution.ts';
import {
	acceptTraversalPage,
	currentTraversalRead,
	queueAutonomyDigest,
	readingAutonomyProgress,
	resumeReadingAfterInvestigation,
	traversalIsComplete,
	autonomyProgressSchema,
	validateTraversalPage,
} from './autonomyTraversal.ts';

const checksumA = 'a'.repeat(64);
const checksumB = 'b'.repeat(64);

function input(allowedReadTools: ('operations_health' | 'operations_attention' | 'support_load')[]) {
	return v.parse(operationsAutonomyDispatchRequestSchema, {
		protocolVersion: '2026-08-13',
		trigger: 'manual',
		runId: 'run-pagination',
		eventSlug: 'code2create-7',
		policy: {
			policyVersionId: 'policy-1',
			policyVersion: 1,
			policyChecksum: checksumA,
			mode: 'observe',
			escalationSeverity: 'attention',
			allowedReadTools,
			allowedRecommendationKinds: [],
		},
		source: {
			sourceChecksum: checksumB,
			snapshot: {
				generatedAt: 1,
				event: {
					slug: 'code2create-7',
					name: 'Code2Create',
					timezone: 'Asia/Dubai',
					status: 'live',
				},
				summary: {
					status: 'healthy',
					signalCount: 0,
					criticalSignalCount: 0,
					attentionSignalCount: 0,
					watchSignalCount: 0,
				},
				signals: [],
			},
		},
	});
}

function healthPage(args: {
	operationId: string;
	cursor?: string;
	isDone: boolean;
	snapshot?: string;
}) {
	return {
		state: 'accepted' as const,
		sequence: 1,
		read: 'operations_health' as const,
		data: {
			generatedAt: 2,
			event: {
				slug: 'code2create-7',
				name: 'Code2Create',
				timezone: 'Asia/Dubai',
				status: 'live' as const,
			},
			summary: {
				status: 'healthy' as const,
				signalCount: 0,
				criticalSignalCount: 0,
				attentionSignalCount: 0,
				watchSignalCount: 0,
			},
			signals: [],
		},
		page: {
			...(args.cursor === undefined ? {} : { cursor: args.cursor }),
			isDone: args.isDone,
			snapshot: args.snapshot ?? 'snapshot-health',
		},
		operationId: args.operationId,
		byteLength: 256,
	};
}

describe('autonomy traversal', () => {
	test('trusted code expands an empty model suggestion to every policy read', () => {
		const parsedInput = input([
			'operations_health',
			'operations_attention',
			'support_load',
		]);
		const suggestion: AutonomyPlan = {
			playbooks: [],
			focusSignalKeys: [],
			reads: [],
		};

		const plan = completeAutonomyPlan(parsedInput, suggestion);

		expect(plan.reads).toEqual([
			'operations_health',
			'operations_attention',
			'support_load',
		]);
		expect(plan.playbooks).toEqual(expect.arrayContaining([
			'health-triage',
			'attention-hygiene',
			'support-load',
		]));
	});

	test('advances every page with one stable snapshot before declaring completion', () => {
		const parsedInput = input(['operations_health']);
		const plan = completeAutonomyPlan(parsedInput, {
			playbooks: [],
			focusSignalKeys: [],
			reads: [],
		});
		let progress = readingAutonomyProgress({ workItemId: 'work-plan', plan });

		progress = acceptTraversalPage({
			progress,
			receipt: healthPage({
				operationId: 'run-pagination:read:operations_health:0',
				cursor: 'cursor-1',
				isDone: false,
			}),
			workItemId: 'work-page-1',
		});
		expect(traversalIsComplete(progress)).toBe(false);
		expect(progress.traversal.cursor).toBe('cursor-1');

		progress = acceptTraversalPage({
			progress,
			receipt: healthPage({
				operationId: 'run-pagination:read:operations_health:1',
				cursor: 'cursor-2',
				isDone: false,
			}),
			workItemId: 'work-page-2',
		});
		expect(progress.traversal.pageIndex).toBe(2);

		progress = acceptTraversalPage({
			progress,
			receipt: healthPage({
				operationId: 'run-pagination:read:operations_health:2',
				isDone: true,
			}),
			workItemId: 'work-page-3',
		});
		expect(traversalIsComplete(progress)).toBe(true);
	});

	test('rejects snapshot drift and lets the durable claim store detect cursor cycles', async () => {
		const parsedInput = input(['operations_health']);
		const plan = completeAutonomyPlan(parsedInput, {
			playbooks: [],
			focusSignalKeys: [],
			reads: [],
		});
		const first = acceptTraversalPage({
			progress: readingAutonomyProgress({ workItemId: 'work-plan', plan }),
			receipt: healthPage({ operationId: 'read-0', cursor: 'cursor-1', isDone: false }),
			workItemId: 'work-1',
		});

		expect(() => validateTraversalPage(first, healthPage({
			operationId: 'read-1',
			cursor: 'cursor-2',
			isDone: false,
			snapshot: 'swapped-snapshot',
		}))).toThrow(/changed snapshots/u);
		const artifacts = memoryAutonomyArtifactStore();
		const claim = {
			claimId: 'read-0',
			read: 'operations_health',
			snapshot: 'snapshot-health',
			cursor: 'cursor-1',
		};
		await expect(artifacts.claimCursor(claim)).resolves.toBe(true);
		await expect(artifacts.claimCursor(claim)).resolves.toBe(true);
		await expect(artifacts.claimCursor({
			...claim,
			claimId: 'read-1',
		})).resolves.toBe(false);
		expect(currentTraversalRead(first)).toBe('operations_health');
	});

	test('removes page-only fields before a cold reading-state continuation', () => {
		const parsedInput = input(['operations_health']);
		const plan = completeAutonomyPlan(parsedInput, {
			playbooks: [],
			focusSignalKeys: [],
			reads: [],
		});
		const reading = readingAutonomyProgress({ workItemId: 'work-plan', plan });
		const recovered = v.parse(autonomyProgressSchema, JSON.parse(JSON.stringify(
			resumeReadingAfterInvestigation({
				...reading,
				stage: 'investigating',
				pageArtifactId: 'read-page-operations-health-1',
				investigationAreaIndex: 0,
				partialDigestId: `digest-${'a'.repeat(64)}`,
			}),
		)));

		expect(recovered).toMatchObject({
			stage: 'reading',
			completedWorkItemId: 'work-plan',
		});
		expect(recovered).not.toHaveProperty('pageArtifactId');
		expect(recovered).not.toHaveProperty('investigationAreaIndex');
		expect(recovered).not.toHaveProperty('partialDigestId');
	});

	test('removes reducer-only pending state before cold reading and finalizing continuations', () => {
		const parsedInput = input(['operations_health']);
		const plan = completeAutonomyPlan(parsedInput, {
			playbooks: [],
			focusSignalKeys: [],
			reads: [],
		});
		const reading = readingAutonomyProgress({ workItemId: 'work-plan', plan });
		const reducing = v.parse(autonomyProgressSchema, {
			...reading,
			stage: 'reducing',
			pending: {
				phase: 'source',
				left: `digest-${'a'.repeat(64)}`,
				right: `digest-${'b'.repeat(64)}`,
				targetLevel: 1,
				resume: 'reading',
			},
		});
		if (reducing.stage !== 'reducing') {
			throw new Error('The reducer fixture did not parse as reducing progress.');
		}

		const resumedReading = v.parse(autonomyProgressSchema, JSON.parse(JSON.stringify(
			queueAutonomyDigest({
				progress: reducing,
				digestId: `digest-${'c'.repeat(64)}`,
				level: 0,
				resume: 'reading',
				workItemId: 'work-reduction-reading',
			}),
		)));
		expect(resumedReading).toMatchObject({
			stage: 'reading',
			completedWorkItemId: 'work-reduction-reading',
		});
		expect(resumedReading).not.toHaveProperty('pending');

		const finalizing = v.parse(autonomyProgressSchema, JSON.parse(JSON.stringify(
			queueAutonomyDigest({
				progress: reducing,
				digestId: `digest-${'d'.repeat(64)}`,
				level: 0,
				resume: 'finalizing',
				workItemId: 'work-reduction-finalizing',
			}),
		)));
		expect(finalizing).toMatchObject({
			stage: 'finalizing',
			completedWorkItemId: 'work-reduction-finalizing',
			finalDigestId: `digest-${'d'.repeat(64)}`,
		});
		expect(finalizing).not.toHaveProperty('pending');
	});
});
