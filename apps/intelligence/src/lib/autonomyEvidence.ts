import * as v from 'valibot';

import {
	autonomyCitationSchema,
	autonomyCandidateRecommendationSchema,
	autonomyDigestMergeResultSchema,
	autonomyEvidenceDigestContentSchema,
	type OperationsAutonomyInput,
} from './autonomyProtocol.ts';
import type {
	AutonomyCandidate,
	AutonomyCitation,
	AutonomyInvestigation,
	AutonomyReadReceipt,
} from './autonomyExecution.ts';
import {
	evidenceRecordsForDigest,
	type AutonomyEvidenceRecord,
} from './autonomyCatalog.ts';

const positiveInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const nonNegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const digestId = v.pipe(v.string(), v.regex(/^digest-[a-f0-9]{64}$/u));
const boundedId = v.pipe(v.string(), v.minLength(1), v.maxLength(200));

const evidenceTargetSchema = v.variant('kind', [
	v.strictObject({
		kind: v.literal('dismiss_attention_item'),
		itemId: boundedId,
		expectedItemVersion: positiveInteger,
		citation: autonomyCitationSchema,
	}),
	v.strictObject({
		kind: v.literal('hold_review_team'),
		teamRoundStateId: boundedId,
		expectedTeamRoundStateVersion: positiveInteger,
		citation: autonomyCitationSchema,
	}),
	v.strictObject({
		kind: v.literal('page_reserve_reviewer'),
		missingPanelMemberId: boundedId,
		expectedPanelVersion: positiveInteger,
		citation: autonomyCitationSchema,
	}),
	v.strictObject({
		kind: v.literal('open_support_case_round'),
		roundId: boundedId,
		citation: autonomyCitationSchema,
	}),
	v.strictObject({
		kind: v.literal('open_support_case_scope'),
		teamId: v.optional(boundedId),
		roundId: v.optional(boundedId),
		citation: autonomyCitationSchema,
	}),
]);

export type AutonomyEvidenceTarget = v.InferOutput<typeof evidenceTargetSchema>;

export const autonomyEvidenceTargetSchema = evidenceTargetSchema;

export const autonomyEvidenceDigestSchema = v.pipe(
	v.strictObject({
		digestId,
		recordScope: v.picklist(['source', 'derived', 'none']),
		sourceOrdinal: v.optional(nonNegativeInteger),
		pageCount: nonNegativeInteger,
		content: autonomyEvidenceDigestContentSchema,
		candidates: v.pipe(v.array(autonomyCandidateRecommendationSchema), v.maxLength(16)),
		children: v.pipe(v.array(digestId), v.maxLength(3)),
	}),
	v.check(
		(digest) => digest.recordScope !== 'derived' || [
			...digest.content.findings,
			...digest.candidates,
		].every((record) => record.supportRecordIds !== undefined),
		'Derived evidence records require exact direct support records.',
	),
	v.check(
		(digest) => digest.recordScope !== 'source' || [
			...digest.content.findings,
			...digest.candidates,
		].every((record) => record.supportRecordIds === undefined),
		'Source evidence records cannot claim derived support records.',
	),
);

export type AutonomyEvidenceDigest = v.InferOutput<typeof autonomyEvidenceDigestSchema>;

const encoder = new TextEncoder();

function hexadecimal(bytes: Uint8Array) {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function autonomyEvidenceDigestId(value: unknown) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		encoder.encode(JSON.stringify(value)),
	);
	return `digest-${hexadecimal(new Uint8Array(digest))}`;
}

export async function pageEvidenceDigest(args: {
	receipt: AutonomyReadReceipt;
	investigation: AutonomyInvestigation;
	sourceOrdinal: number;
	previousDigestId?: string;
}) {
	return {
		digestId: await autonomyEvidenceDigestId([
			'page',
			args.receipt.operationId,
			args.investigation.digest,
			args.investigation.candidates,
			args.previousDigestId,
		]),
		recordScope: 'source' as const,
		sourceOrdinal: args.sourceOrdinal,
		pageCount: args.investigation.complete ? 1 : 0,
		content: args.investigation.digest,
		candidates: args.investigation.candidates,
		children: args.previousDigestId === undefined ? [] : [args.previousDigestId],
	} satisfies AutonomyEvidenceDigest;
}

function citationForPage(
	receipt: AutonomyReadReceipt,
	keys: string[],
): AutonomyCitation {
	return {
		read: receipt.read,
		generatedAt: receipt.data.generatedAt,
		operationId: receipt.operationId,
		snapshot: receipt.page.snapshot,
		keys,
	};
}

export function evidenceTargetsForPage(
	receipt: AutonomyReadReceipt,
): AutonomyEvidenceTarget[] {
	if (receipt.read === 'operations_attention') {
		return receipt.data.items.map((item) => ({
			kind: 'dismiss_attention_item',
			itemId: item.itemId,
			expectedItemVersion: item.version,
			citation: citationForPage(receipt, [item.itemId, String(item.version)]),
		}));
	}
	if (receipt.read === 'review_rounds') {
		return receipt.data.rounds.map((round) => ({
			kind: 'open_support_case_round',
			roundId: round.roundId,
			citation: citationForPage(receipt, [round.roundId]),
		}));
	}
	if (receipt.read === 'review_exceptions') {
		return [
			...receipt.data.vacancies.flatMap((vacancy) => [
				{
					kind: 'page_reserve_reviewer' as const,
					missingPanelMemberId: vacancy.missingPanelMemberId,
					expectedPanelVersion: vacancy.panelVersion,
					citation: citationForPage(receipt, [
						vacancy.missingPanelMemberId,
						String(vacancy.panelVersion),
					]),
				},
				{
					kind: 'open_support_case_round' as const,
					roundId: vacancy.roundId,
					citation: citationForPage(receipt, [vacancy.roundId]),
				},
			]),
			...receipt.data.teams.flatMap((team) => [
				{
					kind: 'hold_review_team' as const,
					teamRoundStateId: team.teamRoundStateId,
					expectedTeamRoundStateVersion: team.version,
					citation: citationForPage(receipt, [
						team.teamRoundStateId,
						String(team.version),
					]),
				},
				{
					kind: 'open_support_case_round' as const,
					roundId: team.roundId,
					citation: citationForPage(receipt, [team.roundId]),
				},
			]),
		];
	}
	if (receipt.read === 'support_load') {
		return receipt.data.cases.flatMap((supportCase) => {
			const keys = [
				...(supportCase.teamId === undefined ? [] : [supportCase.teamId]),
				...(supportCase.roundId === undefined ? [] : [supportCase.roundId]),
			];
			return keys.length === 0 ? [] : [{
				kind: 'open_support_case_scope' as const,
				...(supportCase.teamId === undefined ? {} : { teamId: supportCase.teamId }),
				...(supportCase.roundId === undefined ? {} : { roundId: supportCase.roundId }),
				citation: citationForPage(receipt, keys),
			}];
		});
	}
	return [];
}

function citationIdentity(citation: AutonomyCitation) {
	return [
		citation.operationId,
		citation.snapshot,
		citation.read,
		String(citation.generatedAt),
	].join('\u0000');
}

function citationsFromDigest(digest: AutonomyEvidenceDigest) {
	const citations = new Map<string, AutonomyCitation[]>();
	for (const finding of digest.content.findings) {
		for (const citation of finding.citations) {
			const identity = citationIdentity(citation);
			const values = citations.get(identity) ?? [];
			values.push(citation);
			citations.set(identity, values);
		}
	}
	for (const candidate of digest.candidates) {
		for (const citation of candidate.citations) {
			const identity = citationIdentity(citation);
			const values = citations.get(identity) ?? [];
			values.push(citation);
			citations.set(identity, values);
		}
	}
	return citations;
}

function citationsFromRecord(record: AutonomyEvidenceRecord) {
	return record.kind === 'finding'
		? record.finding.citations
		: record.candidate.citations;
}

function recordCitationsById(records: readonly AutonomyEvidenceRecord[]) {
	return new Map(records.map((record) => [record.recordId, citationsFromRecord(record)]));
}

function citationsComeFromDeclaredSupport(args: {
	citations: readonly AutonomyCitation[];
	supportRecordIds: readonly string[];
	records: readonly AutonomyEvidenceRecord[];
}) {
	const byId = recordCitationsById(args.records);
	const available = new Map<string, AutonomyCitation[]>();
	for (const recordId of args.supportRecordIds) {
		for (const citation of byId.get(recordId) ?? []) {
			const identity = citationIdentity(citation);
			available.set(identity, [...(available.get(identity) ?? []), citation]);
		}
	}
	return args.citations.every((citation) => citationComesFrom(citation, available));
}

function citationComesFrom(
	citation: AutonomyCitation,
	available: Map<string, AutonomyCitation[]>,
) {
	return (available.get(citationIdentity(citation)) ?? []).some((source) =>
		citation.keys.every((key) => source.keys.includes(key))
	);
}

function targetCitation(
	citation: AutonomyCitation,
	keys: string[],
): AutonomyCitation {
	return { ...citation, keys };
}

async function candidateTargetExists(
	candidate: AutonomyCandidate,
	hasTarget: (target: AutonomyEvidenceTarget) => Promise<boolean>,
) {
	const value = candidate.arguments;
	if (value.kind === 'dismiss_attention_item') {
		for (const citation of candidate.citations) {
			const keys = [value.itemId, String(value.expectedItemVersion)];
			if (keys.every((key) => citation.keys.includes(key)) && await hasTarget({
				kind: value.kind,
				itemId: value.itemId,
				expectedItemVersion: value.expectedItemVersion,
				citation: targetCitation(citation, keys),
			})) return true;
		}
		return false;
	}
	if (value.kind === 'hold_review_team') {
		for (const citation of candidate.citations) {
			const keys = [value.teamRoundStateId, String(value.expectedTeamRoundStateVersion)];
			if (keys.every((key) => citation.keys.includes(key)) && await hasTarget({
				kind: value.kind,
				teamRoundStateId: value.teamRoundStateId,
				expectedTeamRoundStateVersion: value.expectedTeamRoundStateVersion,
				citation: targetCitation(citation, keys),
			})) return true;
		}
		return false;
	}
	if (value.kind === 'page_reserve_reviewer') {
		for (const citation of candidate.citations) {
			const keys = [value.missingPanelMemberId, String(value.expectedPanelVersion)];
			if (keys.every((key) => citation.keys.includes(key)) && await hasTarget({
				kind: value.kind,
				missingPanelMemberId: value.missingPanelMemberId,
				expectedPanelVersion: value.expectedPanelVersion,
				citation: targetCitation(citation, keys),
			})) return true;
		}
		return false;
	}
	if (value.teamId !== undefined) {
		for (const citation of candidate.citations) {
			const keys = [value.teamId, ...(value.roundId === undefined ? [] : [value.roundId])];
			if (keys.every((key) => citation.keys.includes(key)) && await hasTarget({
				kind: 'open_support_case_scope',
				teamId: value.teamId,
				...(value.roundId === undefined ? {} : { roundId: value.roundId }),
				citation: targetCitation(citation, keys),
			})) return true;
		}
		return false;
	}
	if (value.roundId === undefined) return true;
	for (const citation of candidate.citations) {
		if (!citation.keys.includes(value.roundId)) continue;
		if (await hasTarget({
			kind: 'open_support_case_round',
			roundId: value.roundId,
			citation: targetCitation(citation, [value.roundId]),
		})) return true;
		if (await hasTarget({
			kind: 'open_support_case_scope',
			roundId: value.roundId,
			citation: targetCitation(citation, [value.roundId]),
		})) return true;
	}
	return false;
}

export async function validateMergedEvidence(args: {
	input: OperationsAutonomyInput;
	left: AutonomyEvidenceDigest;
	right: AutonomyEvidenceDigest;
	result: v.InferOutput<typeof autonomyDigestMergeResultSchema>;
	hasTarget: (target: AutonomyEvidenceTarget) => Promise<boolean>;
}) {
	const records = [
		...await evidenceRecordsForDigest(args.left),
		...await evidenceRecordsForDigest(args.right),
	];
	return validateSynthesizedEvidence({
		input: args.input,
		digests: [args.left, args.right],
		records,
		result: args.result,
		hasTarget: args.hasTarget,
	});
}

export function validateSynthesizedEvidence(args: {
	input: OperationsAutonomyInput;
	digests: readonly AutonomyEvidenceDigest[];
	records: readonly AutonomyEvidenceRecord[];
	result: v.InferOutput<typeof autonomyDigestMergeResultSchema>;
	hasTarget: (target: AutonomyEvidenceTarget) => Promise<boolean>;
}) {
	const inputRecordIds = new Set(args.records.map((record) => record.recordId));
	for (const record of [...args.result.digest.findings, ...args.result.candidates]) {
		if (
			record.supportRecordIds === undefined ||
			record.supportRecordIds.some((recordId) => !inputRecordIds.has(recordId))
		) throw new Error('The evidence merge cited a support record outside its exact input.');
		if (!citationsComeFromDeclaredSupport({
			citations: record.citations,
			supportRecordIds: record.supportRecordIds,
			records: args.records,
		})) throw new Error('The evidence merge laundered a citation outside declared support.');
	}
	const available = new Map<string, AutonomyCitation[]>();
	for (const digest of args.digests) {
		for (const [identity, citations] of citationsFromDigest(digest)) {
			available.set(identity, [...(available.get(identity) ?? []), ...citations]);
		}
	}
	for (const record of args.records) {
		for (const citation of citationsFromRecord(record)) {
			const identity = citationIdentity(citation);
			available.set(identity, [...(available.get(identity) ?? []), citation]);
		}
	}
	const allowedSignals = new Set(args.digests.flatMap(
		(digest) => digest.content.observedSignalKeys,
	));
	if (args.result.digest.observedSignalKeys.some((key) => !allowedSignals.has(key))) {
		throw new Error('The evidence merge fabricated an observed signal key.');
	}
	for (const finding of args.result.digest.findings) {
		if (finding.citations.some((citation) => !citationComesFrom(citation, available))) {
			throw new Error('The evidence merge fabricated a page citation.');
		}
	}
	return Promise.all(args.result.candidates.map(async (candidate) => {
		if (args.input.policy.mode !== 'recommend') {
			throw new Error('Observe mode cannot produce a merged recommendation.');
		}
		if (!args.input.policy.allowedRecommendationKinds.includes(candidate.arguments.kind)) {
			throw new Error('The evidence merge requested an effect outside the frozen policy.');
		}
		if (
			candidate.citations.some((citation) => !citationComesFrom(citation, available)) ||
			!await candidateTargetExists(candidate, args.hasTarget)
		) throw new Error('The merged recommendation is not grounded in its page citations.');
		if (!candidate.supportRecordIds?.some((recordId) => {
			const support = args.records.find((record) => record.recordId === recordId);
			return support?.kind === 'finding' && candidate.citations.some((candidateCitation) =>
				support.finding.citations.some((findingCitation) =>
					citationIdentity(findingCitation) === citationIdentity(candidateCitation) &&
					candidateCitation.keys.every((key) => findingCitation.keys.includes(key))
				)
			);
		})) throw new Error('The merged recommendation has no exact supporting finding record.');
	}));
}
