import { signServiceBody } from '@code2create/domain';
import * as v from 'valibot';

import { requireStrongServiceSecret } from './serviceSecret.ts';

const historyCursorSignatureContext = 'code2create.intelligence.history-cursor.v1';
const maximumEncodedCursorLength = 2_048;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

function hasNoControlCharacters(value: string) {
	return [...value].every((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
	});
}

const cursorPayloadSchema = v.strictObject({
	v: v.literal(1),
	instanceId: v.pipe(v.string(), v.minLength(1), v.maxLength(400)),
	messageKey: v.pipe(
		v.string(),
		v.maxLength(600),
		v.regex(/^(?:assistant|message):.{1,512}$/su),
		v.check(hasNoControlCharacters),
	),
});

const cursorEnvelopeSchema = v.strictObject({
	payload: v.pipe(v.string(), v.minLength(1), v.maxLength(1_200)),
	signature: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
});

function encodeBase64Url(value: string) {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64Url(value: string) {
	if (
		value.length === 0 ||
		value.length > maximumEncodedCursorLength ||
		!/^[A-Za-z0-9_-]+$/u.test(value)
	) throw new Error('The intelligence history cursor encoding is invalid.');
	const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
	const binary = atob(padded);
	const decoded = decoder.decode(
		Uint8Array.from(binary, (character) => character.charCodeAt(0)),
	);
	if (encodeBase64Url(decoded) !== value) {
		throw new Error('The intelligence history cursor is not canonical.');
	}
	return decoded;
}

function signaturesMatch(left: string, right: string) {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) {
		difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return difference === 0;
}

export const intelligenceHistoryPageHeaders = {
	before: 'Intelligence-History-Before',
	hasEarlier: 'Intelligence-History-Has-Earlier',
} as const;

export const internalFlueHistoryPageHeaders = {
	beforeMessageKey: 'x-flue-history-before-message-key',
	earliestMessageKey: 'x-flue-history-earliest-message-key',
	hasEarlier: 'x-flue-history-has-earlier',
} as const;

export function isIntelligenceHistoryCursorEncoding(value: string) {
	return value.length <= maximumEncodedCursorLength && /^[A-Za-z0-9_-]+$/u.test(value);
}

export async function createIntelligenceHistoryCursor(args: {
	instanceId: string;
	messageKey: string;
	secret: string;
}) {
	const payload = JSON.stringify(v.parse(cursorPayloadSchema, {
		v: 1,
		instanceId: args.instanceId,
		messageKey: args.messageKey,
	}));
	const signature = await signServiceBody({
		context: historyCursorSignatureContext,
		secret: requireStrongServiceSecret(args.secret, 'INTELLIGENCE_STREAM_SECRET'),
		timestamp: '0',
		body: payload,
	});
	return encodeBase64Url(JSON.stringify({ payload, signature }));
}

export async function readIntelligenceHistoryCursor(args: {
	cursor: string;
	instanceId: string;
	secret: string;
}) {
	let envelopeValue: unknown;
	try {
		envelopeValue = JSON.parse(decodeBase64Url(args.cursor));
	} catch {
		return null;
	}
	const envelope = v.safeParse(cursorEnvelopeSchema, envelopeValue);
	if (!envelope.success) return null;
	let payloadValue: unknown;
	try {
		payloadValue = JSON.parse(envelope.output.payload);
	} catch {
		return null;
	}
	const payload = v.safeParse(cursorPayloadSchema, payloadValue);
	if (
		!payload.success ||
		JSON.stringify(payload.output) !== envelope.output.payload ||
		payload.output.instanceId !== args.instanceId
	) return null;
	const expected = await signServiceBody({
		context: historyCursorSignatureContext,
		secret: requireStrongServiceSecret(args.secret, 'INTELLIGENCE_STREAM_SECRET'),
		timestamp: '0',
		body: envelope.output.payload,
	});
	return signaturesMatch(expected, envelope.output.signature)
		? payload.output.messageKey
		: null;
}
