import type {
	OperationsHealthSeverity,
} from '@code2create/domain';
import * as v from 'valibot';

import {
	operationsBriefOutputSchema,
	operationsBriefSelectionSchema,
	type OperationsIntelligenceInput,
} from '../protocol.ts';

type OperationsBriefSelection = v.InferOutput<typeof operationsBriefSelectionSchema>;
type FrozenHealthSignal = OperationsIntelligenceInput['snapshot']['signals'][number];

const severityRank: Record<OperationsHealthSeverity, number> = {
	watch: 0,
	attention: 1,
	critical: 2,
};

function normalizeWhitespace(value: string) {
	return value.replaceAll(/\s+/gu, ' ').trim();
}

function boundedSourceText(value: string, maximumCharacters: number) {
	const normalized = normalizeWhitespace(value);
	const characters = Array.from(normalized);
	if (characters.length <= maximumCharacters) return normalized;
	const candidate = characters.slice(0, maximumCharacters - 1).join('');
	const lastSpace = candidate.lastIndexOf(' ');
	const clipped = lastSpace >= Math.floor(maximumCharacters * 0.6)
		? candidate.slice(0, lastSpace)
		: candidate;
	return `${clipped}…`;
}

function authoritativeSignal(signals: readonly FrozenHealthSignal[]) {
	const first = signals[0];
	if (first === undefined) throw new Error('A brief priority must cite at least one signal.');
	return signals.slice(1).reduce(
		(current, candidate) =>
			severityRank[candidate.severity] > severityRank[current.severity] ||
			(severityRank[candidate.severity] === severityRank[current.severity] &&
				candidate.key.localeCompare(current.key) < 0)
				? candidate
				: current,
		first,
	);
}

/**
 * Converts a model's key-only grouping into the full callback from trusted
 * snapshot fields. The model cannot author an operational fact or action.
 */
export function buildGroundedOperationsBrief(
	input: OperationsIntelligenceInput,
	selection: OperationsBriefSelection,
) {
	const parsedSelection = v.parse(operationsBriefSelectionSchema, selection);
	const signalsByKey = new Map<string, FrozenHealthSignal>();
	for (const signal of input.snapshot.signals) {
		if (signalsByKey.has(signal.key)) {
			throw new Error(`The frozen snapshot repeats signal key ${signal.key}.`);
		}
		signalsByKey.set(signal.key, signal);
	}

	if (signalsByKey.size === 0 && parsedSelection.prioritySignalGroups.length !== 0) {
		throw new Error('An empty snapshot cannot produce a priority.');
	}
	if (signalsByKey.size > 0 && parsedSelection.prioritySignalGroups.length === 0) {
		throw new Error('A snapshot with current signals requires at least one priority.');
	}

	const citedAcrossPriorities = new Set<string>();
	const priorities = parsedSelection.prioritySignalGroups.map((signalKeys) => {
		const citedSignals = signalKeys.map((key) => {
			if (citedAcrossPriorities.has(key)) {
				throw new Error(`Signal key ${key} is cited by more than one priority.`);
			}
			const signal = signalsByKey.get(key);
			if (signal === undefined) {
				throw new Error(`Signal key ${key} is not present in the frozen snapshot.`);
			}
			citedAcrossPriorities.add(key);
			return signal;
		});
		const authoritative = authoritativeSignal(citedSignals);
		return {
			severity: authoritative.severity,
			title: boundedSourceText(`Operational priority: ${authoritative.title}`, 120),
			why: boundedSourceText(
				`The frozen snapshot reports ${authoritative.atLeast ? 'at least ' : ''}${authoritative.count} for ${authoritative.title}.`,
				300,
			),
			owner: authoritative.owner,
			nextAction: authoritative.nextAction,
			signalKeys,
		};
	}).sort((left, right) => severityRank[right.severity] - severityRank[left.severity]);

	const selectedSignalCount = priorities.reduce(
		(total, priority) => total + priority.signalKeys.length,
		0,
	);
	const criticalSignalCount = input.snapshot.signals.filter(
		(signal) => signal.severity === 'critical',
	).length;
	const attentionSignalCount = input.snapshot.signals.filter(
		(signal) => signal.severity === 'attention',
	).length;
	const watchSignalCount = input.snapshot.signals.length -
		criticalSignalCount - attentionSignalCount;
	const headline = priorities.length === 0
		? 'No current operational priorities'
		: priorities.length === 1
			? boundedSourceText(priorities[0]?.title ?? 'One current operational priority', 100)
			: `${priorities.length} current operational priorities`;
	const summary = priorities.length === 0
		? 'The frozen health snapshot contains no current operational signals.'
		: [
			`The frozen health snapshot contains ${input.snapshot.signals.length} current signals:`,
			`${criticalSignalCount} critical,`,
			`${attentionSignalCount} attention, and`,
			`${watchSignalCount} watch.`,
			`This brief covers ${selectedSignalCount} signals in ${priorities.length} priorities.`,
		].join(' ');

	return v.parse(operationsBriefOutputSchema, { headline, summary, priorities });
}
