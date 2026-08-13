import {
	operationsAutonomyCallbackSignatureContext,
	operationsAutonomyReadSignatureContext,
	operationsAutonomyRecommendationSignatureContext,
	operationsAutonomyRecommendationEvidenceSignatureContext,
	operationsAutonomyRecommendationEvidenceChunkMaximumCitations,
	operationsAutonomyWorkSignatureContext,
	operationsIntelligenceProtocolVersion,
	signServiceBody,
	type IntelligenceRecommendationArguments,
	type OperationsAutonomyRecommendationCitation,
	type OperationsAutonomyRecommendationEvidenceChunkReceipt,
	type OperationsAutonomyRecommendationEvidenceSeal,
	type OperationsAutonomyCallback,
	type OperationsAutonomyReadRequest,
	type OperationsAutonomyReadTool,
	type OperationsAutonomyRecommendationRequest,
	type OperationsAutonomyWorkRequest,
	type OperationsHealthSignalKey,
} from '@code2create/domain';
import * as v from 'valibot';

import {
	operationsAutonomyCallbackReceiptSchema,
	operationsAutonomyReadReceiptSchema,
	operationsAutonomyRecommendationReceiptSchema,
	operationsAutonomyWorkReceiptSchema,
} from './autonomyProtocol.ts';
import {
	applyAutonomyReceipt,
	runAutonomySerial,
	type AutonomyRunState,
} from './autonomyContext.ts';
import {
	readBoundedJsonResponse,
	readBoundedJsonResponseWithByteLength,
} from './boundedHttpBody.ts';
import { requireStrongServiceSecret } from './serviceSecret.ts';
import { serviceUrl } from './serviceUrl.ts';

export type AutonomyBindings = Pick<
	Cloudflare.Env,
	| 'CONVEX_INTELLIGENCE_AUTONOMY_CALLBACK_URL'
	| 'CONVEX_INTELLIGENCE_AUTONOMY_READ_URL'
	| 'CONVEX_INTELLIGENCE_AUTONOMY_WORK_URL'
	| 'CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_URL'
	| 'CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_EVIDENCE_URL'
	| 'INTELLIGENCE_CALLBACK_SECRET'
	| 'INTELLIGENCE_READ_SECRET'
>;

export type AutonomyRecommendationContent = {
	operationId: string;
	proposalKey: string;
	statement: string;
	reasoning: string;
	evidenceSet: OperationsAutonomyRecommendationEvidenceSeal;
	targetCitationIdentity?: string;
	arguments: IntelligenceRecommendationArguments;
};

const recommendationEvidenceReceiptSchema = v.strictObject({
	state: v.literal('accepted'),
	sequence: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
	evidenceSetId: v.pipe(v.string(), v.minLength(8), v.maxLength(200)),
	pageIndex: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
	pageHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
	isDone: v.boolean(),
	seal: v.optional(v.strictObject({
		evidenceSetId: v.pipe(v.string(), v.minLength(8), v.maxLength(200)),
		rootHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
		leafCount: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
		chunkCount: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
		sealedSequence: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
	})),
});

export { operationsAutonomyRecommendationEvidenceChunkMaximumCitations };

export async function deliverAutonomyRecommendationEvidence(args: {
	state: AutonomyRunState;
	content: {
		operationId: string;
		proposalKey: string;
		evidenceSetId: string;
		pageIndex: number;
		previousPageHash?: string;
		citations: OperationsAutonomyRecommendationCitation[];
		isDone: boolean;
	};
	bindings: AutonomyBindings;
	signal?: AbortSignal;
	request?: typeof fetch;
}): Promise<OperationsAutonomyRecommendationEvidenceChunkReceipt> {
	return runAutonomySerial(args.state.input.runId, async () => {
		const payload = {
			...authority(args.state),
			...args.content,
		};
		const response = await signedPost({
			url: args.bindings.CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_EVIDENCE_URL,
			label: 'Convex autonomy recommendation evidence',
			context: operationsAutonomyRecommendationEvidenceSignatureContext,
			secret: requireStrongServiceSecret(
				args.bindings.INTELLIGENCE_CALLBACK_SECRET,
				'INTELLIGENCE_CALLBACK_SECRET',
			),
			body: JSON.stringify(payload),
			signal: requestSignal(args.state, args.signal),
			...(args.request === undefined ? {} : { request: args.request }),
		});
		if (response.status !== 202) throw await refusal(response);
		const parsed = v.safeParse(
			recommendationEvidenceReceiptSchema,
			await readBoundedJsonResponse(response, maximumReceiptBytes),
		);
		if (!parsed.success) throw new Error('The autonomy evidence receipt is invalid.');
		applyAutonomyReceipt(args.state, parsed.output);
		return {
			state: parsed.output.state,
			sequence: parsed.output.sequence,
			evidenceSetId: parsed.output.evidenceSetId,
			pageIndex: parsed.output.pageIndex,
			pageHash: parsed.output.pageHash,
			isDone: parsed.output.isDone,
			...(parsed.output.seal === undefined ? {} : { seal: parsed.output.seal }),
		};
	});
}

export type AutonomyCallbackContent =
	| {
		status: 'running';
		phase: 'leased' | 'accepted' | 'planning' | 'reading' | 'investigating' |
			'criticizing' | 'proposing' | 'continuing' | 'finalizing';
		observedSignalKeys: OperationsHealthSignalKey[];
	}
	| {
		status: 'succeeded' | 'no_op' | 'escalated';
		phase: 'terminal';
		observedSignalKeys: OperationsHealthSignalKey[];
	}
	| {
		status: 'failed';
		phase: 'terminal';
		failureCode: 'provider_failed' | 'tool_failed' |
			'policy_violation' | 'callback_rejected';
		observedSignalKeys: OperationsHealthSignalKey[];
	};

const maximumReceiptBytes = 16 * 1_024;
const maximumReadResponseBytes = 272 * 1_024;
const serviceRequestTimeoutMs = 20_000;

const autonomyRefusalSchema = v.strictObject({
	error: v.picklist([
		'authority_revoked',
		'operation_conflict',
		'request_rejected',
		'run_terminal',
	]),
});
export type AutonomyServiceRefusalCode = v.InferOutput<
	typeof autonomyRefusalSchema
>['error'];

export class AutonomyServiceRefusalError extends Error {
	readonly status: number;
	readonly code: AutonomyServiceRefusalCode | 'service_refused';

	constructor(status: number, code: AutonomyServiceRefusalCode | 'service_refused') {
		super(`The autonomy service refused the operation with HTTP ${status}.`);
		this.name = 'AutonomyServiceRefusalError';
		this.status = status;
		this.code = code;
	}
}

async function refusal(response: Response) {
	let code: AutonomyServiceRefusalCode | 'service_refused' = 'service_refused';
	try {
		const parsed = v.safeParse(
			autonomyRefusalSchema,
			await readBoundedJsonResponse(response, maximumReceiptBytes),
		);
		if (parsed.success) code = parsed.output.error;
	} catch {
		// Provider/service bodies never cross the boundary or enter logs.
	}
	return new AutonomyServiceRefusalError(response.status, code);
}

function requestSignal(state: AutonomyRunState, signal?: AbortSignal) {
	void state;
	return AbortSignal.any([
		AbortSignal.timeout(serviceRequestTimeoutMs),
		...(signal === undefined ? [] : [signal]),
	]);
}

async function signedPost(args: {
	url: string;
	label: string;
	context: string;
	secret: string;
	body: string;
	signal: AbortSignal;
	request?: typeof fetch;
}) {
	const timestamp = Date.now().toString();
	const signature = await signServiceBody({
		context: args.context,
		secret: args.secret,
		timestamp,
		body: args.body,
	});
	return (args.request ?? fetch)(serviceUrl(args.url, args.label), {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-c2c-signature': signature,
			'x-c2c-timestamp': timestamp,
		},
		body: args.body,
		signal: args.signal,
	});
}

function authority(state: AutonomyRunState) {
	return {
		protocolVersion: operationsIntelligenceProtocolVersion,
		runId: state.input.runId,
		policyVersionId: state.input.policy.policyVersionId,
		policyChecksum: state.input.policy.policyChecksum,
		sourceChecksum: state.input.source.sourceChecksum,
	};
}

export async function authorizeAutonomyWork(args: {
	state: AutonomyRunState;
	operationId: string;
	operation: OperationsAutonomyWorkRequest['operation'];
	bindings: AutonomyBindings;
	signal?: AbortSignal;
	request?: typeof fetch;
}) {
	return runAutonomySerial(args.state.input.runId, async () => {
		const payload: OperationsAutonomyWorkRequest = {
			...authority(args.state),
			operationId: args.operationId,
			operation: args.operation,
		};
		const response = await signedPost({
			url: args.bindings.CONVEX_INTELLIGENCE_AUTONOMY_WORK_URL,
			label: 'Convex autonomy work authorization',
			context: operationsAutonomyWorkSignatureContext,
			secret: requireStrongServiceSecret(
				args.bindings.INTELLIGENCE_READ_SECRET,
				'INTELLIGENCE_READ_SECRET',
			),
			body: JSON.stringify(payload),
			signal: requestSignal(args.state, args.signal),
			...(args.request === undefined ? {} : { request: args.request }),
		});
		if (response.status !== 202 && response.status !== 200) {
			throw await refusal(response);
		}
		const parsed = v.safeParse(
			operationsAutonomyWorkReceiptSchema,
			await readBoundedJsonResponse(response, maximumReceiptBytes),
		);
		if (!parsed.success) throw new Error('The autonomy work receipt is invalid.');
		applyAutonomyReceipt(args.state, parsed.output);
		return parsed.output;
	});
}

export async function performAutonomyRead(args: {
	state: AutonomyRunState;
	operationId: string;
	read: OperationsAutonomyReadTool;
	cursor?: string;
	bindings: AutonomyBindings;
	signal?: AbortSignal;
	request?: typeof fetch;
}) {
	return runAutonomySerial(args.state.input.runId, async () => {
		const payload: OperationsAutonomyReadRequest = {
			...authority(args.state),
			operationId: args.operationId,
			read: args.read,
			...(args.cursor === undefined ? {} : { cursor: args.cursor }),
		};
		const response = await signedPost({
			url: args.bindings.CONVEX_INTELLIGENCE_AUTONOMY_READ_URL,
			label: 'Convex autonomy read',
			context: operationsAutonomyReadSignatureContext,
			secret: requireStrongServiceSecret(
				args.bindings.INTELLIGENCE_READ_SECRET,
				'INTELLIGENCE_READ_SECRET',
			),
			body: JSON.stringify(payload),
			signal: requestSignal(args.state, args.signal),
			...(args.request === undefined ? {} : { request: args.request }),
		});
		if (response.status !== 200) throw await refusal(response);
		const body = await readBoundedJsonResponseWithByteLength(
			response,
			maximumReadResponseBytes,
		);
		const receipt = v.safeParse(operationsAutonomyReadReceiptSchema, body.value);
		if (!receipt.success || receipt.output.read !== args.read) {
			throw new Error('The autonomy read receipt is invalid.');
		}
		applyAutonomyReceipt(args.state, receipt.output);
		return {
			...receipt.output,
			operationId: args.operationId,
			byteLength: body.byteLength,
		};
	});
}

export async function deliverAutonomyRecommendation(args: {
	state: AutonomyRunState;
	content: AutonomyRecommendationContent;
	agentVersion: string;
	model: string;
	bindings: AutonomyBindings;
	signal?: AbortSignal;
	request?: typeof fetch;
}) {
	return runAutonomySerial(args.state.input.runId, async () => {
		const payload: OperationsAutonomyRecommendationRequest = {
			...authority(args.state),
			operationId: args.content.operationId,
			proposalKey: args.content.proposalKey,
			eventSlug: args.state.input.eventSlug,
			agentVersion: args.agentVersion,
			model: args.model,
			statement: args.content.statement,
			reasoning: args.content.reasoning,
			evidenceSet: args.content.evidenceSet,
			...(args.content.targetCitationIdentity === undefined
				? {}
				: { targetCitationIdentity: args.content.targetCitationIdentity }),
			arguments: args.content.arguments,
		};
		const response = await signedPost({
			url: args.bindings.CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_URL,
			label: 'Convex autonomy recommendation',
			context: operationsAutonomyRecommendationSignatureContext,
			secret: requireStrongServiceSecret(
				args.bindings.INTELLIGENCE_CALLBACK_SECRET,
				'INTELLIGENCE_CALLBACK_SECRET',
			),
			body: JSON.stringify(payload),
			signal: requestSignal(args.state, args.signal),
			...(args.request === undefined ? {} : { request: args.request }),
		});
		if (response.status !== 202) throw await refusal(response);
		const parsed = v.safeParse(
			operationsAutonomyRecommendationReceiptSchema,
			await readBoundedJsonResponse(response, maximumReceiptBytes),
		);
		if (!parsed.success) throw new Error('The autonomy recommendation receipt is invalid.');
		applyAutonomyReceipt(args.state, parsed.output);
		return parsed.output;
	});
}

export async function deliverAutonomyCallback(args: {
	state: AutonomyRunState;
	operationId: string;
	content: AutonomyCallbackContent;
	agentVersion: string;
	model: string;
	bindings: AutonomyBindings;
	signal?: AbortSignal;
	request?: typeof fetch;
}) {
	return runAutonomySerial(args.state.input.runId, async () => {
		const base = {
			...authority(args.state),
			operationId: args.operationId,
			agentVersion: args.agentVersion,
			model: args.model,
			observedSignalKeys: args.content.observedSignalKeys,
		};
		let payload: OperationsAutonomyCallback;
		if (args.content.status === 'failed') {
			payload = { ...base, ...args.content };
		} else if (args.content.status === 'running') {
			payload = { ...base, ...args.content };
		} else {
			payload = { ...base, ...args.content };
		}
		const receipt = await deliverAutonomyCallbackPayload({
			payload,
			bindings: args.bindings,
			signal: requestSignal(args.state, args.signal),
			...(args.request === undefined ? {} : { request: args.request }),
		});
		applyAutonomyReceipt(args.state, receipt);
		return receipt;
	});
}

/** Sends an already materialized terminal outbox payload without retaining its source snapshot. */
export async function deliverAutonomyCallbackPayload(args: {
	payload: OperationsAutonomyCallback;
	bindings: AutonomyBindings;
	signal?: AbortSignal;
	request?: typeof fetch;
}) {
	const response = await signedPost({
		url: args.bindings.CONVEX_INTELLIGENCE_AUTONOMY_CALLBACK_URL,
		label: 'Convex autonomy callback',
		context: operationsAutonomyCallbackSignatureContext,
		secret: requireStrongServiceSecret(
			args.bindings.INTELLIGENCE_CALLBACK_SECRET,
			'INTELLIGENCE_CALLBACK_SECRET',
		),
		body: JSON.stringify(args.payload),
		signal: args.signal ?? AbortSignal.timeout(serviceRequestTimeoutMs),
		...(args.request === undefined ? {} : { request: args.request }),
	});
	if (response.status !== 202) throw await refusal(response);
	const parsed = v.safeParse(
		operationsAutonomyCallbackReceiptSchema,
		await readBoundedJsonResponse(response, maximumReceiptBytes),
	);
	if (!parsed.success) throw new Error('The autonomy callback receipt is invalid.');
	return parsed.output;
}
