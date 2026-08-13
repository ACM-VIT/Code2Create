import type {
	ConversationStreamChunk,
	FlueConversationMessage,
	FlueConversationPart,
	FlueConversationSnapshot,
} from '@flue/sdk';
import * as v from 'valibot';

import { autonomyLifecycleDataSchema } from './autonomyProtocol.ts';
import { readBoundedJsonResponse } from './boundedHttpBody.ts';
import { isIntelligenceHistoryCursorEncoding } from './historyCursor.ts';

const maximumJsonStreamBytes = 8 * 1_024 * 1_024;
const maximumProjectedHistoryBytes = 256 * 1_024;
const maximumProjectedHistoryMessages = 32;
const maximumProjectedUpdateBytes = 256 * 1_024;
const maximumNativeChunkTextBytes = 2 * 1_024 * 1_024;
const maximumVisibleDurationMs = 24 * 60 * 60 * 1_000;
const genericToolError = 'The operation did not complete.';

export type IntelligenceStreamProjectionPolicy = 'brief' | 'copilot' | 'autopilot';

const boundedString = (maximum: number) => v.pipe(v.string(), v.maxLength(maximum));
const opaqueId = v.pipe(v.string(), v.minLength(1), v.maxLength(512));
const offset = v.pipe(
	v.string(),
	v.maxLength(64),
	v.regex(/^(?:-1|\d+_\d+)$/u),
);
const nonNegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const nonNegativeNumber = v.pipe(v.number(), v.minValue(0));
const metadata = v.record(v.string(), v.unknown());
const messageState = v.picklist(['streaming', 'done']);

const textPartSchema = v.strictObject({
	type: v.literal('text'),
	text: boundedString(maximumJsonStreamBytes),
	state: messageState,
});
const reasoningPartSchema = v.strictObject({
	type: v.literal('reasoning'),
	text: boundedString(maximumJsonStreamBytes),
	state: messageState,
});
const dataPartSchema = v.strictObject({
	type: v.custom<`data-${string}`>(
		(input) => typeof input === 'string' && input.length <= 256 && /^data-.+/u.test(input),
	),
	data: v.unknown(),
});
const filePartSchema = v.strictObject({
	type: v.literal('file'),
	mediaType: boundedString(256),
	id: v.optional(opaqueId),
	size: v.optional(nonNegativeInteger),
	url: v.optional(boundedString(2_048)),
	filename: v.optional(boundedString(512)),
});
const toolInputPartSchema = v.strictObject({
	type: v.literal('dynamic-tool'),
	toolName: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
	toolCallId: opaqueId,
	state: v.literal('input-available'),
	input: v.unknown(),
});
const toolOutputPartSchema = v.strictObject({
	type: v.literal('dynamic-tool'),
	toolName: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
	toolCallId: opaqueId,
	state: v.literal('output-available'),
	input: v.unknown(),
	output: v.unknown(),
	durationMs: v.optional(nonNegativeNumber),
});
const toolErrorPartSchema = v.strictObject({
	type: v.literal('dynamic-tool'),
	toolName: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
	toolCallId: opaqueId,
	state: v.literal('output-error'),
	input: v.unknown(),
	errorText: boundedString(maximumJsonStreamBytes),
	durationMs: v.optional(nonNegativeNumber),
});
const nativePartSchema = v.union([
	textPartSchema,
	reasoningPartSchema,
	dataPartSchema,
	filePartSchema,
	toolInputPartSchema,
	toolOutputPartSchema,
	toolErrorPartSchema,
]);

const nativeMessageSchema = v.strictObject({
	id: opaqueId,
	role: v.picklist(['user', 'assistant', 'system']),
	purpose: v.picklist(['user', 'assistant', 'dispatch', 'advisory']),
	display: v.picklist(['visible', 'hidden', 'diagnostic']),
	submissionId: v.optional(opaqueId),
	turnId: v.optional(opaqueId),
	signal: v.optional(
		v.strictObject({
			tagName: v.optional(boundedString(256)),
			attributes: v.optional(v.record(v.string(), boundedString(2_048))),
		}),
	),
	settlement: v.optional(
		v.strictObject({ outcome: v.picklist(['failed', 'aborted']) }),
	),
	parts: v.array(nativePartSchema),
	metadata: v.optional(metadata),
});

const nativeSettlementSchema = v.strictObject({
	submissionId: opaqueId,
	outcome: v.picklist(['completed', 'failed', 'aborted']),
	error: v.optional(v.unknown()),
	answeredBySubmissionId: v.optional(opaqueId),
});

const nativeSnapshotSchema = v.strictObject({
	v: v.literal(1),
	conversationId: opaqueId,
	offset,
	incarnation: v.optional(opaqueId),
	messages: v.array(nativeMessageSchema),
	settlements: v.array(nativeSettlementSchema),
});

const positionSchema = v.strictObject({
	batch: nonNegativeInteger,
	index: nonNegativeInteger,
});
const timestampSchema = v.optional(boundedString(64));

const nativeChunkSchema = v.variant('type', [
	v.strictObject({
		type: v.literal('conversation-reset'),
		conversationId: opaqueId,
		snapshot: nativeSnapshotSchema,
		position: positionSchema,
	}),
	v.strictObject({
		type: v.literal('message-appended'),
		conversationId: opaqueId,
		message: nativeMessageSchema,
		position: positionSchema,
	}),
	v.strictObject({
		type: v.literal('message-started'),
		conversationId: opaqueId,
		messageId: opaqueId,
		submissionId: v.optional(opaqueId),
		turnId: v.optional(opaqueId),
		metadata: v.optional(metadata),
		timestamp: timestampSchema,
		position: positionSchema,
	}),
	v.strictObject({
		type: v.literal('message-metadata'),
		conversationId: opaqueId,
		messageId: opaqueId,
		metadata,
		position: positionSchema,
	}),
	v.strictObject({
		type: v.literal('data-part'),
		conversationId: opaqueId,
		messageId: opaqueId,
		name: boundedString(256),
		data: v.unknown(),
		position: positionSchema,
	}),
	v.strictObject({
		type: v.literal('message-delta'),
		conversationId: opaqueId,
		messageId: opaqueId,
		kind: v.picklist(['text', 'reasoning']),
		delta: boundedString(maximumNativeChunkTextBytes),
		position: positionSchema,
	}),
	v.strictObject({
		type: v.literal('tool-input'),
		conversationId: opaqueId,
		messageId: opaqueId,
		toolCallId: opaqueId,
		toolName: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
		input: v.unknown(),
		timestamp: timestampSchema,
		position: positionSchema,
	}),
	v.strictObject({
		type: v.literal('tool-output'),
		conversationId: opaqueId,
		toolCallId: opaqueId,
		output: v.unknown(),
		durationMs: v.optional(nonNegativeNumber),
		timestamp: timestampSchema,
		position: positionSchema,
	}),
	v.strictObject({
		type: v.literal('tool-output-error'),
		conversationId: opaqueId,
		toolCallId: opaqueId,
		errorText: boundedString(maximumNativeChunkTextBytes),
		durationMs: v.optional(nonNegativeNumber),
		timestamp: timestampSchema,
		position: positionSchema,
	}),
	v.strictObject({
		type: v.literal('message-completed'),
		conversationId: opaqueId,
		messageId: opaqueId,
		timestamp: timestampSchema,
		position: positionSchema,
	}),
	v.strictObject({
		type: v.literal('submission-settled'),
		conversationId: opaqueId,
		submissionId: opaqueId,
		outcome: v.picklist(['completed', 'failed', 'aborted']),
		error: v.optional(v.unknown()),
		answeredBySubmissionId: v.optional(opaqueId),
		timestamp: timestampSchema,
		position: positionSchema,
	}),
	v.strictObject({
		type: v.literal('stream-checkpoint'),
		incarnation: opaqueId,
	}),
]);

const nativeChunksSchema = v.array(nativeChunkSchema);
const publicToolNames = new Set([
	'activate_skill',
	'publish_operations_brief',
	'propose_recommendation',
	'read_admission_cohort',
	'read_attendance_counts',
	'read_floor_mapping_progress',
	'read_operations_attention',
	'read_operations_health',
	'read_recommendation_history',
	'read_review_exceptions',
	'read_review_rounds',
	'read_skill_resource',
	'read_support_load',
	'search_submissions',
	'task',
]);
const autopilotToolNames = new Set([
	'plan_operations',
	'read_operations_data',
	'investigate_area',
	'critique_plan',
	'propose_recommendation',
]);

type NativePart = v.InferOutput<typeof nativePartSchema>;
type NativeMessage = v.InferOutput<typeof nativeMessageSchema>;
type NativeSnapshot = v.InferOutput<typeof nativeSnapshotSchema>;
type NativeChunk = v.InferOutput<typeof nativeChunkSchema>;
type ConversationIdentityGuard = { conversationId?: string };

function publicToolName(
	toolName: string,
	policy: IntelligenceStreamProjectionPolicy,
) {
	if (policy === 'autopilot') {
		return autopilotToolNames.has(toolName) ? toolName : null;
	}
	return publicToolNames.has(toolName) ? toolName : 'operation';
}

function publicToolInput(toolName: string, input: unknown) {
	if (
		toolName === 'task' &&
		typeof input === 'object' &&
		input !== null &&
		!Array.isArray(input) &&
		'agent' in input &&
		input.agent === 'investigator'
	) {
		return { agent: 'investigator' };
	}
	return {};
}

function publicDuration(durationMs: number | undefined) {
	if (durationMs === undefined) return undefined;
	return Math.min(Math.round(durationMs), maximumVisibleDurationMs);
}

function sanitizeLifecyclePart(part: NativePart): FlueConversationPart | null {
	if (part.type !== 'data-autonomy-lifecycle') return null;
	const lifecycle = v.safeParse(autonomyLifecycleDataSchema, part.data);
	if (!lifecycle.success) return null;
	return { type: 'data-autonomy-lifecycle', data: lifecycle.output };
}

function sanitizePart(
	part: NativePart,
	policy: IntelligenceStreamProjectionPolicy,
): FlueConversationPart | null {
	if (policy === 'autopilot') {
		const lifecycle = sanitizeLifecyclePart(part);
		if (lifecycle !== null) return lifecycle;
		if (part.type !== 'dynamic-tool') return null;
	}
	if (part.type === 'text') return part;
	if (part.type === 'reasoning') {
		return { type: 'reasoning', text: '', state: part.state };
	}
	if (part.type !== 'dynamic-tool') return null;

	const toolName = publicToolName(part.toolName, policy);
	if (toolName === null) return null;
	const input = publicToolInput(toolName, part.input);
	if (part.state === 'input-available') {
		return {
			type: 'dynamic-tool',
			toolName,
			toolCallId: part.toolCallId,
			state: part.state,
			input,
		};
	}
	const durationMs = publicDuration(part.durationMs);
	if (part.state === 'output-available') {
		return {
			type: 'dynamic-tool',
			toolName,
			toolCallId: part.toolCallId,
			state: part.state,
			input,
			output: {},
			...(durationMs === undefined ? {} : { durationMs }),
		};
	}
	return {
		type: 'dynamic-tool',
		toolName,
		toolCallId: part.toolCallId,
		state: part.state,
		input,
		errorText: genericToolError,
		...(durationMs === undefined ? {} : { durationMs }),
	};
}

function sanitizeMessage(
	message: NativeMessage,
	policy: IntelligenceStreamProjectionPolicy,
): FlueConversationMessage | null {
	const visibleUser =
		policy === 'copilot' &&
		message.role === 'user' &&
		message.purpose === 'user' &&
		message.display === 'visible';
	const visibleAssistant =
		message.role === 'assistant' &&
		message.purpose === 'assistant' &&
		message.display === 'visible';
	if (!visibleUser && !visibleAssistant) return null;

	const parts: FlueConversationPart[] = [];
	for (const part of message.parts) {
		if (visibleUser && part.type !== 'text') continue;
		if ((policy === 'brief' || policy === 'autopilot') && part.type === 'text') continue;
		const sanitized = sanitizePart(part, policy);
		if (sanitized !== null) parts.push(sanitized);
	}
	return {
		id: message.id,
		role: visibleUser ? 'user' : 'assistant',
		purpose: visibleUser ? 'user' : 'assistant',
		display: 'visible',
		...(message.submissionId === undefined ? {} : { submissionId: message.submissionId }),
		...(message.turnId === undefined ? {} : { turnId: message.turnId }),
		parts,
	};
}

function sanitizeSnapshot(
	snapshot: NativeSnapshot,
	policy: IntelligenceStreamProjectionPolicy,
	identity: ConversationIdentityGuard,
	publicConversationId: string,
): FlueConversationSnapshot {
	requireConversationIdentity(snapshot.conversationId, identity);
	const sanitizedMessages: FlueConversationMessage[] = [];
	for (const message of snapshot.messages) {
		const sanitized = sanitizeMessage(message, policy);
		if (sanitized !== null) sanitizedMessages.push(sanitized);
	}
	const base: Pick<
		FlueConversationSnapshot,
		'v' | 'conversationId' | 'offset' | 'incarnation'
	> = {
		v: 1,
		conversationId: publicConversationId,
		offset: snapshot.offset,
		...(snapshot.incarnation === undefined ? {} : { incarnation: snapshot.incarnation }),
	};
	const sanitizedSettlements = policy === 'autopilot' ? [] : snapshot.settlements.map((settlement) => ({
			submissionId: settlement.submissionId,
			outcome: settlement.outcome,
			...(settlement.answeredBySubmissionId === undefined
				? {}
				: { answeredBySubmissionId: settlement.answeredBySubmissionId }),
		}));
	const messages: FlueConversationMessage[] = [];
	for (
		let index = sanitizedMessages.length - 1;
		index >= 0 && messages.length < maximumProjectedHistoryMessages;
		index -= 1
	) {
		const message = sanitizedMessages[index];
		if (message === undefined) continue;
		const nextMessages = [message, ...messages];
		const keptSubmissionIds = new Set(
			nextMessages.flatMap((candidate) =>
				candidate.submissionId === undefined ? [] : [candidate.submissionId],
			),
		);
		const settlements = sanitizedSettlements.filter((settlement) =>
			keptSubmissionIds.has(settlement.submissionId),
		);
		const byteLength = new TextEncoder().encode(
			JSON.stringify({ ...base, messages: nextMessages, settlements }),
		).byteLength;
		if (byteLength > maximumProjectedHistoryBytes) {
			if (messages.length === 0) {
				throw new Error('The latest intelligence message is too large to project safely.');
			}
			break;
		}
		messages.unshift(message);
	}
	const keptSubmissionIds = new Set(
		messages.flatMap((message) =>
			message.submissionId === undefined ? [] : [message.submissionId],
		),
	);
	let settlements = sanitizedSettlements.filter((settlement) =>
		keptSubmissionIds.has(settlement.submissionId),
	);
	if (settlements.length === 0 && messages.length === 0) {
		const latestSettlement = sanitizedSettlements.at(-1);
		if (latestSettlement !== undefined) settlements = [latestSettlement];
	}
	const projected: FlueConversationSnapshot = { ...base, messages, settlements };
	if (new TextEncoder().encode(JSON.stringify(projected)).byteLength > maximumProjectedHistoryBytes) {
		throw new Error('The latest intelligence history is too large to project safely.');
	}
	return projected;
}

function requireConversationIdentity(
	conversationId: string,
	identity: ConversationIdentityGuard,
) {
	if (identity.conversationId === undefined) {
		identity.conversationId = conversationId;
		return;
	}
	if (conversationId !== identity.conversationId) {
		throw new Error('The intelligence stream conversation identity is invalid.');
	}
}

function sanitizeChunk(
	chunk: NativeChunk,
	policy: IntelligenceStreamProjectionPolicy,
	identity: ConversationIdentityGuard,
	publicConversationId: string,
): ConversationStreamChunk | null {
	if (chunk.type === 'stream-checkpoint') return chunk;
	requireConversationIdentity(chunk.conversationId, identity);

	if (chunk.type === 'conversation-reset') {
		return {
			type: chunk.type,
			conversationId: publicConversationId,
			snapshot: sanitizeSnapshot(
				chunk.snapshot,
				policy,
				identity,
				publicConversationId,
			),
			position: chunk.position,
		};
	}
	if (chunk.type === 'message-appended') {
		const message = sanitizeMessage(chunk.message, policy);
		return message === null
			? null
			: {
				type: chunk.type,
				conversationId: publicConversationId,
				message,
				position: chunk.position,
			};
	}
	if (chunk.type === 'message-started') {
		return {
			type: chunk.type,
			conversationId: publicConversationId,
			messageId: chunk.messageId,
			...(chunk.submissionId === undefined ? {} : { submissionId: chunk.submissionId }),
			...(chunk.turnId === undefined ? {} : { turnId: chunk.turnId }),
			position: chunk.position,
		};
	}
	if (chunk.type === 'message-metadata') return null;
	if (chunk.type === 'data-part') {
		if (policy !== 'autopilot' || chunk.name !== 'autonomy-lifecycle') return null;
		const lifecycle = v.safeParse(autonomyLifecycleDataSchema, chunk.data);
		if (!lifecycle.success) return null;
		return {
			type: chunk.type,
			conversationId: publicConversationId,
			messageId: chunk.messageId,
			name: chunk.name,
			data: lifecycle.output,
			position: chunk.position,
		};
	}
	if (chunk.type === 'message-delta') {
		if (policy === 'autopilot' || policy === 'brief' && chunk.kind === 'text') return null;
		return {
			type: chunk.type,
			conversationId: publicConversationId,
			messageId: chunk.messageId,
			kind: chunk.kind,
			delta: chunk.kind === 'reasoning' ? '' : chunk.delta,
			position: chunk.position,
		};
	}
	if (chunk.type === 'tool-input') {
		const toolName = publicToolName(chunk.toolName, policy);
		if (toolName === null) return null;
		return {
			type: chunk.type,
			conversationId: publicConversationId,
			messageId: chunk.messageId,
			toolCallId: chunk.toolCallId,
			toolName,
			input: publicToolInput(toolName, chunk.input),
			position: chunk.position,
		};
	}
	if (chunk.type === 'tool-output') {
		if (policy === 'autopilot') return null;
		const durationMs = publicDuration(chunk.durationMs);
		return {
			type: chunk.type,
			conversationId: publicConversationId,
			toolCallId: chunk.toolCallId,
			output: {},
			...(durationMs === undefined ? {} : { durationMs }),
			position: chunk.position,
		};
	}
	if (chunk.type === 'tool-output-error') {
		if (policy === 'autopilot') return null;
		const durationMs = publicDuration(chunk.durationMs);
		return {
			type: chunk.type,
			conversationId: publicConversationId,
			toolCallId: chunk.toolCallId,
			errorText: genericToolError,
			...(durationMs === undefined ? {} : { durationMs }),
			position: chunk.position,
		};
	}
	if (chunk.type === 'message-completed') {
		return {
			type: chunk.type,
			conversationId: publicConversationId,
			messageId: chunk.messageId,
			position: chunk.position,
		};
	}
	if (policy === 'autopilot') return null;
	return {
		type: chunk.type,
		conversationId: publicConversationId,
		submissionId: chunk.submissionId,
		outcome: chunk.outcome,
		...(chunk.answeredBySubmissionId === undefined
			? {}
			: { answeredBySubmissionId: chunk.answeredBySubmissionId }),
		position: chunk.position,
	};
}

function sanitizeChunks(
	value: unknown,
	policy: IntelligenceStreamProjectionPolicy,
	identity: ConversationIdentityGuard,
	publicConversationId: string,
) {
	const parsed = v.parse(nativeChunksSchema, value);
	const chunks: ConversationStreamChunk[] = [];
	for (const chunk of parsed) {
		const sanitized = sanitizeChunk(
			chunk,
			policy,
			identity,
			publicConversationId,
		);
		if (sanitized !== null) chunks.push(sanitized);
	}
	if (new TextEncoder().encode(JSON.stringify(chunks)).byteLength > maximumProjectedUpdateBytes) {
		throw new Error('The intelligence stream update is too large to project safely.');
	}
	return chunks;
}

function safeResponseHeaders(response: Response) {
	const headers = new Headers({
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
	});
	const nextOffset = response.headers.get('stream-next-offset');
	if (nextOffset !== null && v.safeParse(offset, nextOffset).success) {
		headers.set('stream-next-offset', nextOffset);
	}
	if (response.headers.get('stream-up-to-date') === 'true') {
		headers.set('stream-up-to-date', 'true');
	}
	return headers;
}

export function intelligenceStreamReadMode(request: Request) {
	const parameters = new URL(request.url).searchParams;
	for (const key of parameters.keys()) {
		if (key !== 'view' && key !== 'live' && key !== 'offset' && key !== 'before') return null;
	}
	if (request.method === 'HEAD') {
		return parameters.size === 0 ? 'history' : null;
	}
	const views = parameters.getAll('view');
	const liveValues = parameters.getAll('live');
	const offsets = parameters.getAll('offset');
	const beforeValues = parameters.getAll('before');
	if (views.length === 0) {
		return liveValues.length === 0 && offsets.length === 0 && beforeValues.length === 0
			? 'history'
			: null;
	}
	if (views.length !== 1) return null;
	if (views[0] === 'history') {
		if (liveValues.length !== 0 || offsets.length !== 0 || beforeValues.length > 1) return null;
		const before = beforeValues[0];
		return before === undefined || isIntelligenceHistoryCursorEncoding(before)
			? 'history'
			: null;
	}
	if (
		views[0] !== 'updates' ||
		beforeValues.length !== 0 ||
		offsets.length !== 1 ||
		liveValues.length > 1 ||
		(liveValues.length === 1 && liveValues[0] !== 'long-poll')
	) {
		return null;
	}
	const requestedOffset = offsets[0];
	if (requestedOffset === undefined || !v.safeParse(offset, requestedOffset).success) return null;
	return 'updates';
}

export async function sanitizeAgentStreamResponse(args: {
	request: Request;
	response: Response;
	policy: IntelligenceStreamProjectionPolicy;
	publicConversationId: string;
}) {
	const headers = safeResponseHeaders(args.response);
	if (!args.response.ok) {
		headers.set('content-type', 'application/json; charset=UTF-8');
		return new Response(
			args.request.method === 'HEAD' ? null : JSON.stringify({ error: 'stream_unavailable' }),
			{ status: args.response.status, headers },
		);
	}
	if (args.request.method === 'HEAD') {
		return new Response(null, { status: args.response.status, headers });
	}

	const mode = intelligenceStreamReadMode(args.request);
	if (mode === null) throw new Error('The intelligence stream read mode is invalid.');
	const value = await readBoundedJsonResponse(args.response, maximumJsonStreamBytes);
	const identity: ConversationIdentityGuard = {};
	const projected = mode === 'updates'
		? sanitizeChunks(
			value,
			args.policy,
			identity,
			args.publicConversationId,
		)
		: sanitizeSnapshot(
			v.parse(nativeSnapshotSchema, value),
			args.policy,
			identity,
			args.publicConversationId,
		);
	headers.set('content-type', 'application/json; charset=UTF-8');
	return new Response(JSON.stringify(projected), { status: args.response.status, headers });
}
