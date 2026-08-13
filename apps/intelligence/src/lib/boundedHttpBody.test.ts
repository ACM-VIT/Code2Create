import { describe, expect, test } from 'vitest';

import {
	HttpBodyInvalidEncodingError,
	HttpBodyTooLargeError,
	readBoundedJsonResponse,
	readBoundedRequestText,
} from './boundedHttpBody.ts';

describe('bounded HTTP bodies', () => {
	test('parses a bounded JSON response', async () => {
		await expect(
			readBoundedJsonResponse(Response.json({ state: 'accepted' }), 1_024),
		).resolves.toEqual({ state: 'accepted' });
	});

	test('rejects a declared or streamed response above its limit', async () => {
		await expect(
			readBoundedJsonResponse(
				new Response('{}', {
					headers: { 'content-length': '9', 'content-type': 'application/json' },
				}),
				8,
			),
		).rejects.toBeInstanceOf(HttpBodyTooLargeError);

		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"value":"'));
				controller.enqueue(new TextEncoder().encode('too large"}'));
				controller.close();
			},
		});
		await expect(
			readBoundedJsonResponse(
				new Response(body, { headers: { 'content-type': 'application/json' } }),
				10,
			),
		).rejects.toBeInstanceOf(HttpBodyTooLargeError);
	});

	test('bounds an undeclared request body before decoding', async () => {
		await expect(
			readBoundedRequestText(
				new Request('https://example.test', { method: 'POST', body: '123456789' }),
				8,
			),
		).rejects.toBeInstanceOf(HttpBodyTooLargeError);
	});

	test('rejects non-JSON remote responses', async () => {
		await expect(
			readBoundedJsonResponse(
				new Response('{}', { headers: { 'content-type': 'text/plain' } }),
				8,
			),
		).rejects.toThrow('not JSON');
	});

	test('rejects malformed UTF-8 request bytes', async () => {
		await expect(
			readBoundedRequestText(
				new Request('https://example.test', {
					method: 'POST',
					body: Uint8Array.from([0xc3, 0x28]),
				}),
				8,
			),
		).rejects.toBeInstanceOf(HttpBodyInvalidEncodingError);
	});
});
