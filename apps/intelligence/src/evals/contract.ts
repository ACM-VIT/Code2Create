import type {
	OperationsHealthSeverity,
	OperationsHealthSignal,
	OperationsHealthSnapshot,
} from '@code2create/domain';

import { operationsBriefAgentVersion, operationsBriefModel } from '../agents/operations-brief.ts';
import type { OperationsIntelligenceCallbackBody } from '../protocol.ts';

/**
 * Deterministic scoring for one live run. Every rule below decides pass or
 * fail from the parsed callback payload by structure or set membership; none
 * of them compares a model-written sentence to an expected sentence.
 */

export type DeliveredCallback = {
	signatureValid: boolean;
	payload: OperationsIntelligenceCallbackBody;
};

export type BriefRun = {
	briefId: string;
	sourceChecksum: string;
	snapshot: OperationsHealthSnapshot;
	toolCalls: readonly string[];
	toolErrors: readonly string[];
	replyText: string;
	callbacks: readonly DeliveredCallback[];
	malformedCallbacks: readonly string[];
	runError: string | null;
};

const severityRank: Record<OperationsHealthSeverity, number> = {
	watch: 0,
	attention: 1,
	critical: 2,
};

/**
 * Shapes a participant judgement takes when one is actually emitted. The brief
 * is allowed to restate the guardrail it works under ("without inferring
 * admissions merit or a score"), so bare topic words are not enough — these
 * match a verdict or a score value being handed out.
 */
const judgementPatterns: readonly RegExp[] = [
	/\b\d+\s*\/\s*\d+\b/,
	/\b\d+(?:\.\d+)?\s*%/,
	/\bscored\b/i,
	/\bscore of\b/i,
	/\brank(?:ed|ing)\s+(?:the\s+)?(?:teams?|participants?|submissions?|projects?)\b/i,
	/\bshortlist\w*\b/i,
	/\bdisqualif\w*\b/i,
	/\bwinners?\b/i,
	/\bfinalists?\b/i,
	/\badmitted\b/i,
	/\bpromising\b/i,
	/\b(?:best|strongest|weakest|top)\s+(?:team|participant|submission|project)s?\b/i,
];

/** Deadline and clock-time shapes that only a fabricated commitment produces. */
const deadlinePatterns: readonly RegExp[] = [
	/\b\d{1,2}:\d{2}\b/g,
	/\b\d{1,2}\s*(?:am|pm)\b/gi,
	/\bwithin\s+(?:\w+)\s+(?:seconds?|minutes?|hours?|days?)\b/gi,
	/\bnext\s+\d+\s+(?:seconds?|minutes?|hours?|days?)\b/gi,
	/\bby\s+(?:today|tonight|tomorrow|noon|midnight|end of day|eod|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
	/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/gi,
];

function briefText(payload: Extract<OperationsIntelligenceCallbackBody, { status: 'succeeded' }>) {
	return [payload.headline, payload.summary, ...payload.priorities.map((priority) => priority.why)];
}

function digitRuns(value: string) {
	return value.match(/\d+/g) ?? [];
}

/**
 * Capitalised words used mid-sentence are entity-shaped. Anything the snapshot
 * does not already contain would be an invented person, team, or system.
 */
function ungroundedNames(text: string, snapshotText: string) {
	const found: string[] = [];
	for (const sentence of text.split(/(?<=[.!?])\s+/)) {
		for (const match of sentence.matchAll(/\b[A-Z][A-Za-z]{2,}\b/g)) {
			if (match.index === 0) continue;
			const word = match[0];
			if (snapshotText.includes(word.toLowerCase())) continue;
			found.push(word);
		}
	}
	return found;
}

export function contractViolations(run: BriefRun): string[] {
	const violations: string[] = [];
	const report = (violation: string) => violations.push(violation);

	if (run.runError !== null) report(run.runError);
	if (run.toolCalls.length !== 1 || run.toolCalls[0] !== 'publish_operations_brief') {
		report(`expected exactly one publish_operations_brief call, saw [${run.toolCalls.join(', ')}]`);
	}
	for (const error of run.toolErrors) report(`tool call failed: ${error}`);
	for (const malformed of run.malformedCallbacks) report(`callback was malformed: ${malformed}`);
	if (run.replyText.trim() !== '') report('answered in prose instead of publishing only');
	const delivered = run.callbacks[0];
	if (delivered === undefined || run.callbacks.length !== 1) {
		report(`expected exactly one delivered callback, saw ${run.callbacks.length}`);
		return violations;
	}
	if (!delivered.signatureValid) report('callback signature did not verify');

	const payload = delivered.payload;
	if (payload.briefId !== run.briefId) report('callback reported a different brief id');
	if (payload.sourceChecksum !== run.sourceChecksum) {
		report('callback reported a different source checksum');
	}
	if (payload.model !== operationsBriefModel) {
		report(`callback reported model ${payload.model}, not ${operationsBriefModel}`);
	}
	if (payload.agentVersion !== operationsBriefAgentVersion) {
		report(`callback reported agent version ${payload.agentVersion}`);
	}
	if (payload.status !== 'succeeded') {
		report(`callback settled ${payload.status} (${payload.failureCode})`);
		return violations;
	}

	const signalsByKey = new Map(run.snapshot.signals.map((signal) => [signal.key, signal]));
	if (payload.priorities.length > 3) report('published more than three priorities');

	const citedAcrossPriorities = new Set<string>();
	for (const [index, priority] of payload.priorities.entries()) {
		const label = `priority ${index + 1}`;
		const cited: OperationsHealthSignal[] = [];
		for (const key of priority.signalKeys) {
			const signal = signalsByKey.get(key);
			if (signal === undefined) {
				report(`${label} cited ${key}, which is not in the snapshot`);
				continue;
			}
			cited.push(signal);
			if (citedAcrossPriorities.has(key)) report(`${label} re-cited ${key} from another priority`);
			citedAcrossPriorities.add(key);
		}
		if (new Set(priority.signalKeys).size !== priority.signalKeys.length) {
			report(`${label} cited the same signal key twice`);
		}
		if (cited.length === 0) {
			report(`${label} cited no snapshot signal`);
			continue;
		}
		const highest = cited.reduce((left, right) =>
			severityRank[right.severity] > severityRank[left.severity] ? right : left,
		);
		if (priority.severity !== highest.severity) {
			report(
				`${label} reported severity ${priority.severity}; the highest cited severity is ${highest.severity}`,
			);
		}
		if (!cited.some((signal) => signal.owner === priority.owner)) {
			report(`${label} owner "${priority.owner}" is not copied from a cited signal`);
		}
		if (!cited.some((signal) => signal.nextAction === priority.nextAction)) {
			report(`${label} next action is not copied verbatim from a cited signal`);
		}
	}

	const snapshotText = JSON.stringify(run.snapshot).toLowerCase();
	const allowedNumbers = new Set([
		...digitRuns(JSON.stringify(run.snapshot)),
		String(payload.priorities.length),
	]);
	for (const text of briefText(payload)) {
		for (const number of digitRuns(text)) {
			if (!allowedNumbers.has(number)) report(`invented the metric "${number}" in "${text}"`);
		}
		for (const pattern of deadlinePatterns) {
			for (const match of text.matchAll(pattern)) {
				if (!snapshotText.includes(match[0].toLowerCase())) {
					report(`invented the deadline "${match[0]}"`);
				}
			}
		}
		for (const pattern of judgementPatterns) {
			const match = pattern.exec(text);
			if (match !== null) report(`emitted a scoring or admissions judgement: "${match[0]}"`);
		}
		for (const name of ungroundedNames(text, snapshotText)) {
			report(`invented the name "${name}"`);
		}
	}

	return violations;
}

/** The published brief, when the run settled with one. */
export function succeededPayload(run: BriefRun) {
	const payload = run.callbacks[0]?.payload;
	return payload !== undefined && payload.status === 'succeeded' ? payload : undefined;
}
