import {
	operationsIntelligenceCallbackSignatureContext,
	operationsIntelligenceProtocolVersion,
	verifyServiceBody,
	type OperationsHealthSnapshot,
} from '@code2create/domain';
import { AgentRunError, init } from '@flue/runtime';
import { start, type Flue } from '@flue/runtime/node';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as v from 'valibot';

import { OperationsBrief } from '../agents/operations-brief.ts';
import {
	operationsIntelligenceCallbackSchema,
	operationsIntelligenceRequestSchema,
	type OperationsIntelligenceCallbackBody,
} from '../protocol.ts';
import type { BriefRun, DeliveredCallback } from './contract.ts';

/**
 * Drives the real agent — real instructions, real model, real tools — the same
 * way the Worker does, and captures the signed callback it delivers. Nothing
 * here inspects prompts or model output; the scorer only sees the payload the
 * agent published.
 */

type Delivery =
	| { briefId: string; signatureValid: boolean; payload: OperationsIntelligenceCallbackBody }
	| { briefId: string; signatureValid: boolean; malformed: string };

export type EvaluationRuntime = {
	stop(): Promise<void>;
	deliveriesFor(briefId: string): readonly Delivery[];
};

function briefIdOf(value: unknown): string {
	if (typeof value !== 'object' || value === null) return 'unattributed';
	const record: Record<string, unknown> = { ...value };
	const briefId = record['briefId'];
	return typeof briefId === 'string' ? briefId : 'unattributed';
}

async function readBody(request: NodeJS.ReadableStream) {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
}

function listen(server: Server) {
	return new Promise<number>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address: string | AddressInfo | null = server.address();
			if (address === null || typeof address === 'string') {
				reject(new Error('The evaluation callback server did not bind a port.'));
				return;
			}
			resolve(address.port);
		});
	});
}

/**
 * Boots the Flue runtime in this process and a local stand-in for the Convex
 * callback endpoint. The agent reaches the endpoint through the same bindings
 * the Worker uses, so the signed callback path is exercised end to end.
 */
export async function startEvaluationRuntime(): Promise<EvaluationRuntime> {
	const secret = randomBytes(32).toString('hex');
	const deliveries: Delivery[] = [];
	const server = createServer((request, response) => {
		void (async () => {
			const body = await readBody(request);
			const timestamp = request.headers['x-c2c-timestamp'];
			const signature = request.headers['x-c2c-signature'];
			const signatureValid = await verifyServiceBody({
				context: operationsIntelligenceCallbackSignatureContext,
				secret,
				timestamp: typeof timestamp === 'string' ? timestamp : '',
				signature: typeof signature === 'string' ? signature : '',
				body,
				now: Date.now(),
				maximumAgeMs: 5 * 60 * 1_000,
			});
			let json: unknown;
			try {
				json = JSON.parse(body);
			} catch {
				deliveries.push({
					briefId: 'unattributed',
					signatureValid,
					malformed: 'the callback body was not JSON',
				});
				response.writeHead(400).end();
				return;
			}
			const parsed = v.safeParse(operationsIntelligenceCallbackSchema, json);
			deliveries.push(
				parsed.success
					? { briefId: parsed.output.briefId, signatureValid, payload: parsed.output }
					: {
						briefId: briefIdOf(json),
						signatureValid,
						malformed: parsed.issues.map((issue) => issue.message).join('; '),
					},
			);
			response
				.writeHead(202, { 'content-type': 'application/json' })
				.end(JSON.stringify({ state: 'accepted' }));
		})();
	});
	const port = await listen(server);

	process.env['INTELLIGENCE_CALLBACK_SECRET'] = secret;
	process.env['CONVEX_INTELLIGENCE_CALLBACK_URL'] =
		`http://127.0.0.1:${port}/intelligence/operations-briefs/callback`;

	let flue: Flue | undefined = await start({ agents: [OperationsBrief] });

	return {
		deliveriesFor: (briefId) => deliveries.filter((delivery) => delivery.briefId === briefId),
		async stop() {
			await flue?.stop();
			flue = undefined;
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}

/** One live run of the agent over one frozen snapshot. */
export async function runOperationsBrief(
	runtime: EvaluationRuntime,
	snapshot: OperationsHealthSnapshot,
	label: string,
): Promise<BriefRun> {
	const briefId = `eval-${label}-${randomUUID()}`;
	const sourceChecksum = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
	const request = v.parse(operationsIntelligenceRequestSchema, {
		protocolVersion: operationsIntelligenceProtocolVersion,
		briefId,
		sourceChecksum,
		snapshot,
	});

	const toolCalls: string[] = [];
	const toolErrors: string[] = [];
	const agent = init(OperationsBrief, { id: briefId, uid: null });
	const receipt = await agent.dispatch({
		message: {
			kind: 'signal',
			type: 'operations.health.snapshot',
			body: "Prepare the bounded brief from this instance's frozen source snapshot.",
			attributes: { briefId, sourceChecksum },
		},
		initialData: request,
	});

	let replyText = '';
	let runError: string | null = null;
	try {
		const reply = await agent.read(receipt, {
			onEvent(chunk) {
				if (chunk.type === 'tool-input') toolCalls.push(chunk.toolName);
				if (chunk.type === 'tool-output-error') toolErrors.push(chunk.errorText);
			},
		});
		replyText = reply.text;
	} catch (error) {
		if (!(error instanceof AgentRunError)) throw error;
		runError = `the submission settled ${error.outcome}`;
	}

	const delivered = runtime.deliveriesFor(briefId);
	const callbacks: DeliveredCallback[] = [];
	const malformedCallbacks: string[] = [];
	for (const delivery of delivered) {
		if ('payload' in delivery) {
			callbacks.push({ signatureValid: delivery.signatureValid, payload: delivery.payload });
		} else {
			malformedCallbacks.push(delivery.malformed);
		}
	}

	return {
		briefId,
		sourceChecksum,
		snapshot,
		toolCalls,
		toolErrors,
		replyText,
		callbacks,
		malformedCallbacks,
		runError,
	};
}
