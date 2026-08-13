import {
	registerDigestCandidateEffects,
} from './autonomyCandidateOwnership.ts';
import type {
	AutonomyEvidencePair,
	AutonomyEvidenceRecord,
} from './autonomyCatalog.ts';
import type { AutonomyEvidenceDigest } from './autonomyEvidence.ts';
import {
	deliverRunningCheckpoint,
	lifecycleDuration,
	observedKeys,
} from './autonomyLifecycle.ts';
import {
	indexAutonomyEvidence,
	synthesizeAutonomyEvidencePairs,
	synthesizeAutonomyHypothesisPage,
} from './autonomySynthesis.ts';
import {
	queueAutonomyDigest,
	type AutonomyReducingProgress,
} from './autonomyTraversal.ts';
import type {
	AutonomyOrchestrationResult,
	RunAutonomyWorkItemArgs,
} from './autonomyWorkItem.ts';

const synthesisPairPageSize = 4;
const hypothesisPageSize = 4;

async function storeDigest(
	args: RunAutonomyWorkItemArgs,
	digest: AutonomyEvidenceDigest,
) {
	await args.artifacts.putDigest(digest);
	await registerDigestCandidateEffects({
		eventSlug: args.input.eventSlug,
		digest,
		artifacts: args.artifacts,
	});
	return digest.digestId;
}

async function appendAccumulator(args: {
	context: RunAutonomyWorkItemArgs;
	accumulatorDigestId?: string;
	digest: AutonomyEvidenceDigest;
}) {
	if (args.accumulatorDigestId === undefined) return args.digest;
	const previous = await args.context.artifacts.getDigest(args.accumulatorDigestId);
	const accumulator = await indexAutonomyEvidence({
		kind: 'accumulator',
		digests: [previous, args.digest],
	});
	await args.context.artifacts.putDigest(accumulator);
	return accumulator;
}

async function finishReduction(args: {
	context: RunAutonomyWorkItemArgs;
	progress: AutonomyReducingProgress;
	left: AutonomyEvidenceDigest;
	right: AutonomyEvidenceDigest;
	accumulator?: AutonomyEvidenceDigest;
}): Promise<AutonomyOrchestrationResult> {
	const root = await indexAutonomyEvidence({
		kind: 'root',
		digests: [
			args.left,
			args.right,
			...(args.accumulator === undefined ? [] : [args.accumulator]),
		],
	});
	await args.context.step.do('store-reduction-root', () =>
		storeDigest(args.context, root)
	);
	return {
		progress: queueAutonomyDigest({
			progress: args.progress,
			digestId: root.digestId,
			level: args.progress.pending.targetLevel,
			resume: args.progress.pending.resume,
			workItemId: args.context.workItemId,
		}),
		outcome: 'continuing',
	};
}

async function advanceSourcePair(args: {
	context: RunAutonomyWorkItemArgs;
	progress: AutonomyReducingProgress;
	left: AutonomyEvidenceDigest;
	right: AutonomyEvidenceDigest;
	pairPage: Awaited<ReturnType<RunAutonomyWorkItemArgs['artifacts']['readSynthesisPairs']>>;
	accumulator: AutonomyEvidenceDigest;
}): Promise<AutonomyOrchestrationResult> {
	if (args.pairPage.isDone) {
		return finishReduction({
			context: args.context,
			progress: args.progress,
			left: args.left,
			right: args.right,
			accumulator: args.accumulator,
		});
	}
	const cursor = args.pairPage.cursor;
	if (cursor === undefined) {
		throw new Error('The incomplete autonomy synthesis page has no cursor.');
	}
	return {
		progress: {
			...args.progress,
			completedWorkItemId: args.context.workItemId,
			pending: {
				phase: 'source',
				left: args.progress.pending.left,
				right: args.progress.pending.right,
				targetLevel: args.progress.pending.targetLevel,
				resume: args.progress.pending.resume,
				cursor,
				accumulatorDigestId: args.accumulator.digestId,
			},
		},
		outcome: 'continuing',
	};
}

function sourceRecords(pairs: readonly AutonomyEvidencePair[]) {
	const records = new Map<string, AutonomyEvidenceRecord>();
	for (const pair of pairs) {
		records.set(pair.left.recordId, pair.left);
		records.set(pair.right.recordId, pair.right);
	}
	return [...records.values()];
}

async function reduceSourcePage(args: {
	context: RunAutonomyWorkItemArgs;
	progress: AutonomyReducingProgress & { pending: Extract<AutonomyReducingProgress['pending'], { phase: 'source' }> };
	left: AutonomyEvidenceDigest;
	right: AutonomyEvidenceDigest;
	pairPage: Awaited<ReturnType<RunAutonomyWorkItemArgs['artifacts']['readSynthesisPairs']>>;
}): Promise<AutonomyOrchestrationResult> {
	const hypothesisRootDigestIds = [
		args.progress.pending.left,
		args.progress.pending.right,
		...(args.progress.pending.accumulatorDigestId === undefined
			? []
			: [args.progress.pending.accumulatorDigestId]),
	];
	const prior = args.progress.pending.partialDigestId === undefined
		? undefined
		: await args.context.artifacts.getDigest(args.progress.pending.partialDigestId);
	const synthesized = await args.context.step.do('synthesize-source-evidence-page', () =>
		synthesizeAutonomyEvidencePairs({
			input: args.context.input,
			left: args.left,
			right: args.right,
			pairs: args.pairPage.pairs,
			...(prior === undefined ? {} : { prior }),
			harness: args.context.harness,
			hasTarget: (target) => args.context.artifacts.hasTarget(target),
			...(args.context.signal === undefined ? {} : { signal: args.context.signal }),
		})
	);
	await args.context.step.do('store-source-synthesis-page', () =>
		storeDigest(args.context, synthesized.digest)
	);
	if (!synthesized.complete) {
		return {
			progress: {
				...args.progress,
				completedWorkItemId: args.context.workItemId,
				pending: {
					...args.progress.pending,
					partialDigestId: synthesized.digest.digestId,
				},
			},
			outcome: 'continuing',
		};
	}
	const accumulator = await args.context.step.do('index-source-synthesis-page', async () =>
		appendAccumulator({
			context: args.context,
			...(args.progress.pending.accumulatorDigestId === undefined
				? {}
				: { accumulatorDigestId: args.progress.pending.accumulatorDigestId }),
			digest: synthesized.digest,
		})
	);
	return {
		progress: {
			...args.progress,
			completedWorkItemId: args.context.workItemId,
			pending: {
				phase: 'hypotheses',
				left: args.progress.pending.left,
				right: args.progress.pending.right,
				targetLevel: args.progress.pending.targetLevel,
				resume: args.progress.pending.resume,
				...(args.progress.pending.cursor === undefined
					? {}
					: { cursor: args.progress.pending.cursor }),
				accumulatorDigestId: accumulator.digestId,
				hypothesisRootDigestIds,
			},
		},
		outcome: 'continuing',
	};
}

async function reduceHypothesisPage(args: {
	context: RunAutonomyWorkItemArgs;
	progress: AutonomyReducingProgress & { pending: Extract<AutonomyReducingProgress['pending'], { phase: 'hypotheses' }> };
	left: AutonomyEvidenceDigest;
	right: AutonomyEvidenceDigest;
	pairPage: Awaited<ReturnType<RunAutonomyWorkItemArgs['artifacts']['readSynthesisPairs']>>;
}): Promise<AutonomyOrchestrationResult> {
	const page = await args.context.artifacts.readHypothesisRecords({
		rootDigestIds: args.progress.pending.hypothesisRootDigestIds,
		...(args.progress.pending.hypothesisCursor === undefined
			? {}
			: { afterRecordId: args.progress.pending.hypothesisCursor }),
		limit: hypothesisPageSize,
	});
	const accumulator = await args.context.artifacts.getDigest(
		args.progress.pending.accumulatorDigestId,
	);
	if (page.records.length === 0) {
		if (!page.isDone || args.progress.pending.partialDigestId !== undefined) {
			throw new Error('The autonomy hypothesis catalog returned an invalid empty page.');
		}
		return advanceSourcePair({
			context: args.context,
			progress: args.progress,
			left: args.left,
			right: args.right,
			pairPage: args.pairPage,
			accumulator,
		});
	}
	const prior = args.progress.pending.partialDigestId === undefined
		? undefined
		: await args.context.artifacts.getDigest(args.progress.pending.partialDigestId);
	const synthesized = await args.context.step.do('synthesize-hypothesis-page', () =>
		synthesizeAutonomyHypothesisPage({
			input: args.context.input,
			hypotheses: page.records,
			sourceRecords: sourceRecords(args.pairPage.pairs),
			left: args.left,
			right: args.right,
			...(prior === undefined ? {} : { prior }),
			harness: args.context.harness,
			hasTarget: (target) => args.context.artifacts.hasTarget(target),
			...(args.context.signal === undefined ? {} : { signal: args.context.signal }),
		})
	);
	await args.context.step.do('store-hypothesis-synthesis-page', () =>
		storeDigest(args.context, synthesized.digest)
	);
	if (!synthesized.complete) {
		return {
			progress: {
				...args.progress,
				completedWorkItemId: args.context.workItemId,
				pending: {
					...args.progress.pending,
					partialDigestId: synthesized.digest.digestId,
				},
			},
			outcome: 'continuing',
		};
	}
	const nextAccumulator = await args.context.step.do(
		'index-hypothesis-synthesis-page',
		() => appendAccumulator({
			context: args.context,
			accumulatorDigestId: accumulator.digestId,
			digest: synthesized.digest,
		}),
	);
	if (page.isDone) {
		return advanceSourcePair({
			context: args.context,
			progress: args.progress,
			left: args.left,
			right: args.right,
			pairPage: args.pairPage,
			accumulator: nextAccumulator,
		});
	}
	const hypothesisCursor = page.nextRecordId;
	if (hypothesisCursor === undefined) {
		throw new Error('The incomplete autonomy hypothesis page has no cursor.');
	}
	return {
		progress: {
			...args.progress,
			completedWorkItemId: args.context.workItemId,
			pending: {
				...args.progress.pending,
				accumulatorDigestId: nextAccumulator.digestId,
				hypothesisCursor,
				partialDigestId: undefined,
			},
		},
		outcome: 'continuing',
	};
}

/**
 * Processes one bounded durable synthesis slice. Source records are enumerated
 * exactly once; every earlier hypothesis is then paged against the new source
 * page before its cursor can advance. Newly derived hypotheses are above the
 * frozen watermark and become eligible on later source pages, preventing both
 * silent loss and recursive same-page amplification.
 */
export async function reduceAutonomyEvidenceWorkItem(
	args: RunAutonomyWorkItemArgs & { progress: AutonomyReducingProgress },
): Promise<AutonomyOrchestrationResult> {
	await deliverRunningCheckpoint({
		...args,
		phase: 'criticizing',
		observedSignalKeys: observedKeys(args.progress),
	});
	const startedAt = Date.now();
	args.writeLifecycle({
		operation: 'critique_plan',
		phase: 'criticizing',
		role: 'critic',
		status: 'started',
	});
	const left = await args.artifacts.getDigest(args.progress.pending.left);
	const right = await args.artifacts.getDigest(args.progress.pending.right);
	const pairPage = await args.artifacts.readSynthesisPairs({
		leftDigestId: left.digestId,
		rightDigestId: right.digestId,
		...(args.progress.pending.cursor === undefined
			? {}
			: { cursor: args.progress.pending.cursor }),
		limit: synthesisPairPageSize,
	});
	if (pairPage.pairs.length === 0) {
		if (!pairPage.isDone || args.progress.pending.partialDigestId !== undefined) {
			throw new Error('The autonomy synthesis catalog returned an invalid empty page.');
		}
		const accumulator = args.progress.pending.accumulatorDigestId === undefined
			? undefined
			: await args.artifacts.getDigest(args.progress.pending.accumulatorDigestId);
		return finishReduction({
			context: args,
			progress: args.progress,
			left,
			right,
			...(accumulator === undefined ? {} : { accumulator }),
		});
	}
	const result = args.progress.pending.phase === 'source'
		? await reduceSourcePage({
			context: args,
			progress: { ...args.progress, pending: args.progress.pending },
			left,
			right,
			pairPage,
		})
		: await reduceHypothesisPage({
			context: args,
			progress: { ...args.progress, pending: args.progress.pending },
			left,
			right,
			pairPage,
		});
	args.writeLifecycle({
		operation: 'critique_plan',
		phase: 'criticizing',
		role: 'critic',
		status: 'completed',
		durationMs: lifecycleDuration(startedAt),
	});
	return result;
}
