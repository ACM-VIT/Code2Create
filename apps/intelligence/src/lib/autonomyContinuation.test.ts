import {
	ResultUnavailableError,
	type CallHandle,
	type FlueHarness,
	type PromptOptions,
	type PromptResponse,
	type PromptResultResponse,
	type PromptUsage,
	type Sandbox,
	type ToolStep,
} from '@flue/runtime';
import { describe, expect, test, vi } from 'vitest';
import * as v from 'valibot';

import {
	autonomyEvaluationInput,
	SignedAutonomyEvaluationBackend,
} from '../evals/autonomy-harness.ts';
import { memoryAutonomyArtifactStore } from './autonomyArtifacts.ts';
import { autonomyRunState, clearAutonomyRunForTests } from './autonomyContext.ts';
import {
	evidenceRecordsForDigest,
	type AutonomyEvidenceRecord,
} from './autonomyCatalog.ts';
import {
	autonomyEvidenceDigestSchema,
	type AutonomyEvidenceDigest,
} from './autonomyEvidence.ts';
import type { AutonomyCitation, AutonomyReadReceipt } from './autonomyExecution.ts';
import { runAutonomyWorkItem } from './autonomyOrchestration.ts';
import {
	autonomyProgressSchema,
	readingAutonomyProgress,
	type AutonomyProgress,
} from './autonomyTraversal.ts';

const usage: PromptUsage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const model = { provider: 'test', id: 'scripted' };

function callHandle<T>(promise: Promise<T>): CallHandle<T> {
	const controller = new AbortController();
	return Object.assign(promise, {
		signal: controller.signal,
		abort: (reason?: unknown) => controller.abort(reason),
	});
}

class ScriptedHarness implements FlueHarness {
	readonly name = 'scripted-autonomy-harness';
	readonly prompts: string[] = [];
	readonly #responses: unknown[] = [];

	enqueue(...responses: unknown[]) {
		this.#responses.push(...responses);
	}

	prompt<S extends v.GenericSchema>(
		text: string,
		options: PromptOptions<S> & { result: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	prompt(text: string, options?: PromptOptions): CallHandle<PromptResponse>;
	prompt<S extends v.GenericSchema>(
		text: string,
		options?: PromptOptions<S>,
	): CallHandle<PromptResultResponse<v.InferOutput<S>> | PromptResponse> {
		this.prompts.push(text);
		const next = this.#responses.shift();
		if (next instanceof Error) return callHandle(Promise.reject(next));
		if (options?.result !== undefined) {
			return callHandle(Promise.resolve({
				data: v.parse(options.result, next),
				usage,
				model,
			}));
		}
		return callHandle(Promise.resolve({ text: String(next ?? ''), usage, model }));
	}

	compact() {
		return Promise.resolve();
	}

	get sandbox(): Sandbox {
		throw new Error('The scripted autonomy harness has no sandbox.');
	}
}

const directStep: ToolStep = {
	do: async (_name, operation) => operation(),
};

function citation(args: {
	operationId: string;
	snapshot: string;
	itemId: string;
	version: number;
}): AutonomyCitation {
	return {
		read: 'operations_attention',
		generatedAt: 100,
		operationId: args.operationId,
		snapshot: args.snapshot,
		keys: [args.itemId, String(args.version)],
	};
}

function sourceDigest(args: {
	id: string;
	sourceOrdinal: number;
	itemId: string;
}): AutonomyEvidenceDigest {
	const source = citation({
		operationId: `read:${args.id}`,
		snapshot: `snapshot:${args.id}`,
		itemId: args.itemId,
		version: args.sourceOrdinal,
	});
	return v.parse(autonomyEvidenceDigestSchema, {
		digestId: `digest-${args.id.repeat(64)}`,
		recordScope: 'source',
		sourceOrdinal: args.sourceOrdinal,
		pageCount: 1,
		content: {
			summary: `Source evidence page for ${args.itemId}.`,
			findings: [{
				statement: `The exact source row ${args.itemId} remains available for synthesis.`,
				uncertainty: 'A later frozen source row can still change this relationship.',
				citations: [source],
			}],
			observedSignalKeys: ['projection_coverage_limited'],
		},
		candidates: [],
		children: [],
	});
}

function finding(record: AutonomyEvidenceRecord) {
	if (record.kind !== 'finding') throw new Error('The test evidence record is not a finding.');
	return record;
}

function coldProgress(progress: AutonomyProgress) {
	return v.parse(autonomyProgressSchema, JSON.parse(JSON.stringify(progress)));
}

function workArgs(args: {
	progress: AutonomyProgress;
	workItemId: string;
	harness: ScriptedHarness;
	artifacts: ReturnType<typeof memoryAutonomyArtifactStore>;
	backend: SignedAutonomyEvaluationBackend;
}) {
	const input = autonomyEvaluationInput();
	return {
		input,
		state: autonomyRunState(input),
		progress: args.progress,
		workItemId: args.workItemId,
		harness: args.harness,
		step: directStep,
		writeLifecycle: vi.fn(),
		agentVersion: 'operations-autopilot-test',
		model: 'cloudflare/scripted',
		bindings: args.backend.bindings,
		artifacts: args.artifacts,
	};
}

describe('autonomy durable model-output continuation', () => {
	test('persists a complete=false synthesis pass and retries the same source page after cold progress recovery', async () => {
		const input = autonomyEvaluationInput();
		const backend = new SignedAutonomyEvaluationBackend();
		vi.stubGlobal('fetch', backend.request);
		const artifacts = memoryAutonomyArtifactStore();
		const left = sourceDigest({ id: 'a', sourceOrdinal: 1, itemId: 'attention-left' });
		const right = sourceDigest({ id: 'b', sourceOrdinal: 2, itemId: 'attention-right' });
		await artifacts.putDigest(left);
		await artifacts.putDigest(right);
		const pairs = await artifacts.readSynthesisPairs({
			leftDigestId: left.digestId,
			rightDigestId: right.digestId,
			limit: 4,
		});
		const pair = pairs.pairs[0];
		if (pair === undefined) throw new Error('The synthesis fixture has no source pair.');
		const leftFinding = finding(pair.left);
		const harness = new ScriptedHarness();
		harness.enqueue({
			digest: {
				summary: 'The first bounded pass retains one unresolved source hypothesis.',
				findings: [{
					statement: 'The left source row may relate to the later source condition.',
					uncertainty: 'Another pass is required before this hypothesis is settled.',
					citations: leftFinding.finding.citations,
					supportRecordIds: [leftFinding.recordId],
				}],
				observedSignalKeys: ['projection_coverage_limited'],
			},
			candidates: [],
			reviewedPairIds: [`${pair.left.recordId}.${pair.right.recordId}`],
			complete: false,
		});
		const base = readingAutonomyProgress({
			workItemId: 'work-before-reduction',
			plan: {
				playbooks: ['attention-hygiene'],
				focusSignalKeys: ['projection_coverage_limited'],
				reads: ['operations_attention'],
			},
		});
		const progress = v.parse(autonomyProgressSchema, {
			...base,
			stage: 'reducing',
			pending: {
				phase: 'source',
				left: left.digestId,
				right: right.digestId,
				targetLevel: 1,
				resume: 'finalizing',
			},
		});

		const first = await runAutonomyWorkItem(workArgs({
			progress,
			workItemId: 'work-synthesis-1',
			harness,
			artifacts,
			backend,
		}));
		expect(first.outcome).toBe('continuing');
		if (first.progress.stage !== 'reducing') {
			throw new Error('The incomplete synthesis did not remain reducing.');
		}
		const partialId = first.progress.pending.partialDigestId;
		if (partialId === undefined) throw new Error('The incomplete synthesis has no partial digest.');
		const partial = await artifacts.getDigest(partialId);
		const priorFinding = finding((await evidenceRecordsForDigest(partial))[0] ?? pair.left);
		harness.enqueue({
			digest: {
				summary: 'The resumed bounded pass exhausts the exact source pair.',
				findings: [{
					statement: 'The durable prior hypothesis was reviewed against the same pair.',
					uncertainty: 'Only a future frozen snapshot can invalidate this exact review.',
					citations: priorFinding.finding.citations,
					supportRecordIds: [priorFinding.recordId],
				}],
				observedSignalKeys: ['projection_coverage_limited'],
			},
			candidates: [],
			reviewedPairIds: [`${pair.left.recordId}.${pair.right.recordId}`],
			complete: true,
		});
		const second = await runAutonomyWorkItem(workArgs({
			progress: coldProgress(first.progress),
			workItemId: 'work-synthesis-2',
			harness,
			artifacts,
			backend,
		}));

		expect(harness.prompts[1]).toContain(priorFinding.recordId);
		expect(second.progress.stage).not.toBe('terminal');
		expect(JSON.stringify(second.progress)).not.toContain(partialId);
		clearAutonomyRunForTests(input.runId);
		vi.unstubAllGlobals();
	});

	test('keeps investigation progress unchanged on ResultUnavailable and advances only after complete=true', async () => {
		const input = autonomyEvaluationInput();
		const backend = new SignedAutonomyEvaluationBackend();
		vi.stubGlobal('fetch', backend.request);
		const artifacts = memoryAutonomyArtifactStore();
		const receipt: AutonomyReadReceipt = {
			state: 'accepted',
			sequence: 1,
			read: 'operations_attention',
			data: {
				generatedAt: 100,
				atLeast: false,
				items: [{
					itemId: 'attention-continuation',
					detectorKey: 'review_backlog',
					subjectType: 'review_round',
					severity: 'attention',
					statement: 'The exact attention row requires exhaustive investigation.',
					state: 'open',
					version: 4,
					recurrenceCount: 1,
					firstObservedAt: 10,
					lastObservedAt: 20,
				}],
			},
			page: { isDone: true, snapshot: 'snapshot-investigation' },
			operationId: 'read:attention:continuation',
			byteLength: 512,
		};
		await artifacts.putTargets([]);
		const pageArtifactId = await artifacts.putReadPage(receipt);
		const reading = readingAutonomyProgress({
			workItemId: 'work-read',
			plan: {
				playbooks: ['attention-hygiene'],
				focusSignalKeys: [],
				reads: ['operations_attention'],
			},
		});
		const progress = v.parse(autonomyProgressSchema, {
			...reading,
			stage: 'investigating',
			pageArtifactId,
			investigationAreaIndex: 0,
		});
		const harness = new ScriptedHarness();
		harness.enqueue(new ResultUnavailableError('truncated structured output', ''));
		const serializedBefore = JSON.stringify(progress);
		await expect(runAutonomyWorkItem(workArgs({
			progress,
			workItemId: 'work-investigator-retry',
			harness,
			artifacts,
			backend,
		}))).rejects.toBeInstanceOf(ResultUnavailableError);
		expect(JSON.stringify(progress)).toBe(serializedBefore);

		const pageCitation = citation({
			operationId: receipt.operationId,
			snapshot: receipt.page.snapshot,
			itemId: 'attention-continuation',
			version: 4,
		});
		harness.enqueue({
			area: 'reviews',
			observedSignalKeys: [],
			digest: {
				summary: 'The retried bounded investigation preserves the exact row.',
				findings: [{
					statement: 'The exact attention item remains open at the cited version.',
					uncertainty: 'A later item version can supersede this frozen observation.',
					citations: [pageCitation],
				}],
				observedSignalKeys: [],
			},
			candidates: [],
			complete: false,
		}, {
			area: 'reviews',
			observedSignalKeys: [],
			digest: {
				summary: 'The second pass exhausts the exact attention evidence page.',
				findings: [{
					statement: 'The same exact item was reviewed again before page completion.',
					uncertainty: 'A future frozen read remains the only source of later truth.',
					citations: [pageCitation],
				}],
				observedSignalKeys: [],
			},
			candidates: [],
			complete: true,
		});
		const partial = await runAutonomyWorkItem(workArgs({
			progress: coldProgress(progress),
			workItemId: 'work-investigator-retry',
			harness,
			artifacts,
			backend,
		}));
		expect(partial.progress.stage).toBe('investigating');
		const complete = await runAutonomyWorkItem(workArgs({
			progress: coldProgress(partial.progress),
			workItemId: 'work-investigator-complete',
			harness,
			artifacts,
			backend,
		}));
		expect(complete.progress.stage).toBe('finalizing');
		if (complete.progress.stage !== 'finalizing') {
			throw new Error('The completed investigation did not reach finalization.');
		}
		await artifacts.prepareRootCatalog({
			rootDigestId: complete.progress.finalDigestId,
			limit: 16,
		});
		const findings = await artifacts.readFindingRecords({
			rootDigestId: complete.progress.finalDigestId,
			limit: 8,
		});
		expect(findings.records).toHaveLength(2);
		expect(harness.prompts.at(-1)).toContain('Prior bounded investigation pass');
		clearAutonomyRunForTests(input.runId);
		vi.unstubAllGlobals();
	});
});
