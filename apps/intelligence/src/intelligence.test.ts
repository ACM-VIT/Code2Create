import {
	operationsIntelligenceCallbackSignatureContext,
	operationsIntelligenceIngressSignatureContext,
	operationsIntelligenceProtocolVersion,
	signServiceBody,
	verifyServiceBody,
	type OperationsIntelligenceCallback,
} from '@code2create/domain';
import { describe, expect, test } from 'vitest';
import * as v from 'valibot';

import { deliverCallback } from './lib/callback.ts';
import { operationsIntelligenceRequestSchema } from './protocol.ts';

const secret = 'f'.repeat(64);

describe('operations intelligence transport', () => {
	test('accepts only a current signature over the exact body and context', async () => {
		const body = JSON.stringify({ briefId: 'brief-1' });
		const timestamp = Date.now().toString();
		const signature = await signServiceBody({
			context: operationsIntelligenceIngressSignatureContext,
			secret,
			timestamp,
			body,
		});

		expect(
			await verifyServiceBody({
				context: operationsIntelligenceIngressSignatureContext,
				secret,
				timestamp,
				signature,
				body,
				now: Number(timestamp),
				maximumAgeMs: 60_000,
			}),
		).toBe(true);
		expect(
			await verifyServiceBody({
				context: operationsIntelligenceCallbackSignatureContext,
				secret,
				timestamp,
				signature,
				body,
				now: Number(timestamp),
				maximumAgeMs: 60_000,
			}),
		).toBe(false);
		expect(
			await verifyServiceBody({
				context: operationsIntelligenceIngressSignatureContext,
				secret,
				timestamp,
				signature,
				body: `${body} `,
				now: Number(timestamp),
				maximumAgeMs: 60_000,
			}),
		).toBe(false);
	});

	test('rejects unknown fields at the signed request boundary', () => {
		const parsed = v.safeParse(operationsIntelligenceRequestSchema, {
			protocolVersion: operationsIntelligenceProtocolVersion,
			briefId: 'brief-1',
			sourceChecksum: 'a'.repeat(64),
			snapshot: {
				generatedAt: 1,
				event: {
					slug: 'code2create-7',
					name: 'Code2Create 7.0',
					timezone: 'Asia/Kolkata',
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
			unexpected: true,
		});
		expect(parsed.success).toBe(false);
	});

	test('signs the exact callback body sent to Convex', async () => {
		const payload: OperationsIntelligenceCallback = {
			protocolVersion: operationsIntelligenceProtocolVersion,
			briefId: 'brief-1',
			sourceChecksum: 'a'.repeat(64),
			agentVersion: 'operations-brief-v1',
			model: 'cloudflare/test-model',
			completedAt: Date.now(),
			status: 'succeeded',
			headline: 'No current signal',
			summary: 'The bounded source snapshot contains no current operations signal.',
			priorities: [],
		};
		let received = false;
		const request: typeof fetch = async (input, init) => {
			const outbound = new Request(input, init);
			const body = await outbound.text();
			const timestamp = outbound.headers.get('x-c2c-timestamp') ?? '';
			const signature = outbound.headers.get('x-c2c-signature') ?? '';
			received = await verifyServiceBody({
				context: operationsIntelligenceCallbackSignatureContext,
				secret,
				timestamp,
				signature,
				body,
				now: Number(timestamp),
				maximumAgeMs: 60_000,
			});
			return Response.json({ state: 'accepted' }, { status: 202 });
		};

		await deliverCallback(
			payload,
			{
				CONVEX_INTELLIGENCE_CALLBACK_URL: 'https://example.test/callback',
				INTELLIGENCE_CALLBACK_SECRET: secret,
			},
			request,
		);
		expect(received).toBe(true);
	});
});
