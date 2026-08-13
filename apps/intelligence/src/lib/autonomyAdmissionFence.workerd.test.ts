import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { Miniflare } from 'miniflare';
import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { build } from 'vite';

const fenceDebugStateSchema = v.strictObject({
	revoked: v.boolean(),
	pending: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
	settled: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
	abortRecorded: v.boolean(),
	dispatches: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
	aborts: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
	closed: v.boolean(),
	terminalDeliveries: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
	terminalPending: v.boolean(),
});
const stateOnlySchema = v.object({ state: v.string() });

let miniflare: Miniflare;
let bundleCode = '';
let persistencePath = '';

function autonomyInput(runId: string, eventSlug = 'code2create-7') {
	return {
		protocolVersion: '2026-08-13',
		trigger: 'manual',
		runId,
		eventSlug,
		policy: {
			policyVersionId: 'policy-1',
			policyVersion: 1,
			policyChecksum: 'a'.repeat(64),
			mode: 'observe',
			escalationSeverity: 'attention',
			allowedReadTools: ['operations_health'],
			allowedRecommendationKinds: [],
		},
		source: {
			sourceChecksum: 'b'.repeat(64),
			snapshot: {
				generatedAt: 1,
				event: {
					slug: eventSlug,
					name: 'Code2Create',
					timezone: 'Asia/Dubai',
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
		},
	};
}

function terminalSettlement(runId: string) {
	const input = autonomyInput(runId);
	return {
		protocolVersion: input.protocolVersion,
		runId,
		policyVersionId: input.policy.policyVersionId,
		policyChecksum: input.policy.policyChecksum,
		sourceChecksum: input.source.sourceChecksum,
		operationId: `callback:${runId}`,
		agentVersion: 'operations-autopilot-test',
		model: 'model-test',
		observedSignalKeys: [],
		status: 'no_op',
		phase: 'terminal',
	};
}

async function request(
	path: string,
	runId: string,
	body?: object,
) {
	return miniflare.dispatchFetch(
		`https://fence.test${path}${path.includes('?') ? '&' : '?'}runId=${encodeURIComponent(runId)}`,
		body === undefined
			? undefined
			: {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			},
	);
}

async function json(response: Awaited<ReturnType<Miniflare['dispatchFetch']>>) {
	return response.json();
}

async function debug(runId: string) {
	return v.parse(fenceDebugStateSchema, await json(await request('/inspect', runId)));
}

async function waitForTerminalDeliveries(runId: string, expected: number) {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		const state = await debug(runId);
		if (state.terminalDeliveries >= expected) return state;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error('The durable terminal outbox did not reach its expected delivery count.');
}

function createMiniflare() {
	return new Miniflare({
		name: 'fence-workerd-test',
		// Miniflare 4's bundled workerd currently supports this date; the signed
		// protocol literal exercised by the fixture remains 2026-08-13.
		compatibilityDate: '2026-05-22',
		compatibilityFlags: ['nodejs_compat'],
		modules: [{ type: 'ESModule', path: 'index.mjs', contents: bundleCode }],
		durableObjectsPersist: persistencePath,
		durableObjects: {
			FENCE: {
				className: 'TestOperationsAutonomyAdmissionFence',
				useSQLite: true,
			},
		},
	});
}

async function restartWorkerd() {
	await miniflare.dispose();
	miniflare = createMiniflare();
	await miniflare.ready;
}

beforeAll(async () => {
	const built = await build({
		configFile: false,
		logLevel: 'silent',
		build: {
			write: false,
			minify: false,
			lib: {
				entry: resolve('src/lib/autonomyAdmissionFence.workerd-fixture.ts'),
				formats: ['es'],
			},
			rollupOptions: { external: ['cloudflare:workers'] },
		},
	});
	const builds = Array.isArray(built) ? built : [built];
	const output = builds.flatMap((result) => 'output' in result ? result.output : []);
	const entry = output.find((item) => item.type === 'chunk' && item.isEntry);
	if (entry?.type !== 'chunk') {
		throw new Error('The admission-fence fixture produced no entry chunk.');
	}
	bundleCode = entry.code;
	persistencePath = await mkdtemp(resolve(tmpdir(), 'c2c-autonomy-fence-'));
	miniflare = createMiniflare();
	await miniflare.ready;
}, 30_000);

afterAll(async () => {
	await miniflare?.dispose();
	if (persistencePath !== '') await rm(persistencePath, { recursive: true, force: true });
});

describe('durable autonomy admission fence', () => {
	test('persists an accepted receipt across cold-object recreation and rejects drift', async () => {
		const runId = 'run-cold-receipt';
		await request('/configure?mode=accept', runId);
		const input = autonomyInput(runId);
		const first = await json(await request('/initial', runId, input));
		await restartWorkerd();
		const replay = await json(await request('/initial', runId, input));
		const conflict = await json(await request(
			'/initial',
			runId,
			autonomyInput(runId, 'code2create-8'),
		));

		expect(replay).toEqual(first);
		expect(conflict).toEqual({ state: 'conflict' });
		expect(await debug(runId)).toMatchObject({ dispatches: 1, pending: 0, settled: 1 });
		const retained = v.parse(v.array(v.string()), await json(await request('/retained', runId)));
		expect(retained).toHaveLength(1);
		expect(retained[0]).not.toContain('code2create-7');
		expect(retained[0]).not.toContain('sourceChecksum');
	});

	test('keeps active exact replay indefinitely and terminal settlement leaves only a closed tombstone', async () => {
		const runId = 'run-terminal-receipt-retention';
		await request('/configure?mode=accept', runId);
		const input = autonomyInput(runId);
		const receipt = await json(await request('/initial', runId, input));
		await restartWorkerd();
		expect(await json(await request('/initial', runId, input))).toEqual(receipt);

		await request('/terminal', runId, terminalSettlement(runId));
		expect(await debug(runId)).toMatchObject({ revoked: true, pending: 0, settled: 0 });
		expect(await json(await request('/initial', runId, input))).toEqual({ state: 'revoked' });
	});

	test('retries a terminal callback outbox across cold alarms before closing admission', async () => {
		const runId = 'run-terminal-outbox-recovery';
		await request('/configure?mode=accept', runId);
		await request('/configure-terminal?failures=3', runId);
		await request('/initial', runId, autonomyInput(runId));

		await request('/terminal', runId, terminalSettlement(runId));
		expect(await debug(runId)).toMatchObject({
			revoked: false,
			closed: false,
			terminalPending: true,
			terminalDeliveries: 1,
			settled: 1,
		});
		const retainedTerminal = v.parse(
			v.string(),
			await json(await request('/terminal-retained', runId)),
		);
		expect(retainedTerminal).toContain('callback:run-terminal-outbox-recovery');
		expect(retainedTerminal).not.toContain('Code2Create');
		expect(retainedTerminal).not.toContain('snapshot');
		expect(await json(await request('/initial', runId, autonomyInput(runId)))).toEqual({
			state: 'revoked',
		});

		// The first alarm was committed atomically with terminalPending. After a
		// cold restart, each consumed alarm pre-arms its own successor before I/O.
		await restartWorkerd();
		expect(await waitForTerminalDeliveries(runId, 4)).toMatchObject({
			revoked: true,
			closed: true,
			terminalPending: false,
			terminalDeliveries: 4,
			settled: 0,
		});
		expect(await json(await request('/initial', runId, autonomyInput(runId)))).toEqual({
			state: 'revoked',
		});
	}, 10_000);

	test('atomically closes admission with terminal outbox deletion before bounded receipt cleanup', async () => {
		const runId = 'run-terminal-atomic-close';
		await request('/configure?mode=accept', runId);
		for (let index = 0; index < 65; index += 1) {
			const result = v.parse(stateOnlySchema, await json(await request('/continue', runId, {
				protocolVersion: '2026-08-13',
				runId,
				operationId: `continue:atomic:${index}`,
				priorSubmissionId: `submission:atomic:${index}`,
				workItemId: `work:atomic:${index}`,
			})));
			expect(result.state).toBe('accepted');
		}

		await request('/terminal', runId, terminalSettlement(runId));
		const afterReceipt = await debug(runId);
		expect(afterReceipt).toMatchObject({
			revoked: true,
			closed: true,
			terminalPending: false,
			terminalDeliveries: 1,
		});
		// Receipt cleanup is deliberately paged after the atomic close, proving
		// that an isolate loss cannot reopen admission while cleanup is unfinished.
		expect(afterReceipt.settled).toBeGreaterThan(0);
		expect(await json(await request('/terminal-retained', runId))).toBeNull();

		await restartWorkerd();
		expect(await json(await request('/initial', runId, autonomyInput(runId)))).toEqual({
			state: 'revoked',
		});
		expect(await debug(runId)).toMatchObject({
			revoked: true,
			closed: true,
			terminalPending: false,
		});
	});

	test('never resumes a cold ambiguous admission after durable revocation', async () => {
		const runId = 'run-revoked-cold-alarm';
		await request('/configure?mode=fail', runId);
		expect(await json(await request('/initial', runId, autonomyInput(runId)))).toEqual({
			state: 'unavailable',
		});
		expect(await debug(runId)).toMatchObject({ dispatches: 1, pending: 1 });
		expect(await json(await request('/revoke', runId, {
			protocolVersion: '2026-08-13',
			runId,
			reason: 'kill_switch',
			operationId: 'abort:run-revoked-cold-alarm',
		}))).toEqual({ state: 'pending' });

		await restartWorkerd();
		await request('/alarm', runId);

		expect(await debug(runId)).toEqual({
			revoked: true,
			pending: 0,
			settled: 0,
			abortRecorded: true,
			dispatches: 1,
			aborts: 1,
			closed: true,
			terminalDeliveries: 0,
			terminalPending: false,
		});
		expect(await json(await request('/initial', runId, autonomyInput(runId)))).toEqual({
			state: 'revoked',
		});
		expect((await debug(runId)).dispatches).toBe(1);
	});

	test('cold alarm reconciles the same non-revoked idempotency key once', async () => {
		const runId = 'run-cold-reconcile';
		const input = autonomyInput(runId);
		await request('/configure?mode=fail', runId);
		expect(await json(await request('/initial', runId, input))).toEqual({
			state: 'unavailable',
		});
		await restartWorkerd();
		await request('/configure?mode=accept', runId);
		await request('/alarm', runId);
		const receipt = await json(await request('/initial', runId, input));
		const replay = await json(await request('/initial', runId, input));

		expect(replay).toEqual(receipt);
		expect(await debug(runId)).toMatchObject({
			revoked: false,
			pending: 0,
			settled: 1,
			dispatches: 2,
		});
		expect(await json(await request(
			'/initial',
			runId,
			autonomyInput(runId, 'code2create-9'),
		))).toEqual({ state: 'conflict' });
		expect((await debug(runId)).dispatches).toBe(2);
	});

	test('holds abort pending while a pre-revocation admission is physically active', async () => {
		const runId = 'run-active-race';
		await request('/configure?mode=defer', runId);
		const admission = request('/initial', runId, autonomyInput(runId));
		for (let attempt = 0; attempt < 20; attempt += 1) {
			if ((await debug(runId)).dispatches === 1) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const abort = await json(await request('/revoke', runId, {
			protocolVersion: '2026-08-13',
			runId,
			reason: 'policy_superseded',
			operationId: 'abort:run-active-race',
		}));
		expect(abort).toEqual({ state: 'pending' });
		expect(await debug(runId)).toMatchObject({ revoked: true, pending: 1, aborts: 0 });

		await request('/release', runId);
		expect(await json(await admission)).toMatchObject({ state: 'accepted' });
		expect(await debug(runId)).toMatchObject({
			revoked: true,
			pending: 0,
			abortRecorded: true,
			dispatches: 1,
			aborts: 1,
		});
	});

	test('revocation during a pre-dispatch wait prevents physical admission', async () => {
		const runId = 'run-revoke-before-dispatch';
		await request('/configure?mode=defer_before_dispatch', runId);
		const admission = request('/initial', runId, autonomyInput(runId));
		for (let attempt = 0; attempt < 20; attempt += 1) {
			if ((await debug(runId)).pending === 1) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(await json(await request('/revoke', runId, {
			protocolVersion: '2026-08-13',
			runId,
			reason: 'owner_revoked',
			operationId: 'abort:run-revoke-before-dispatch',
		}))).toEqual({ state: 'pending' });
		await request('/release', runId);
		expect(await json(await admission)).toEqual({ state: 'revoked' });
		expect(await debug(runId)).toMatchObject({
			revoked: true,
			pending: 0,
			dispatches: 0,
			abortRecorded: true,
		});
	});

	test('an alarm-owned admission stays tracked while revoke races it', async () => {
		const runId = 'run-alarm-active-race';
		await request('/configure?mode=fail', runId);
		expect(await json(await request('/initial', runId, autonomyInput(runId)))).toEqual({
			state: 'unavailable',
		});
		await restartWorkerd();
		await request('/configure?mode=defer', runId);
		const alarm = request('/alarm', runId);
		for (let attempt = 0; attempt < 20; attempt += 1) {
			if ((await debug(runId)).dispatches === 2) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(await json(await request('/revoke', runId, {
			protocolVersion: '2026-08-13',
			runId,
			reason: 'kill_switch',
			operationId: 'abort:run-alarm-active-race',
		}))).toEqual({ state: 'pending' });
		await request('/release', runId);
		expect((await alarm).status).toBe(200);
		expect(await debug(runId)).toMatchObject({
			revoked: true,
			pending: 0,
			dispatches: 2,
			aborts: 1,
			abortRecorded: true,
		});
	});

	test('keeps settled continuation history out of the hot pending index and purges it on revocation', async () => {
		const runId = 'run-many-settled';
		await request('/configure?mode=accept', runId);
		for (let index = 0; index < 40; index += 1) {
			const result = v.parse(stateOnlySchema, await json(await request('/continue', runId, {
				protocolVersion: '2026-08-13',
				runId,
				operationId: `continue:${index}`,
				priorSubmissionId: `submission:${index}`,
				workItemId: `work:${index}`,
			})));
			expect(result.state).toBe('accepted');
		}
		expect(await debug(runId)).toMatchObject({ pending: 0, settled: 40 });
		expect(await json(await request('/revoke', runId, {
			protocolVersion: '2026-08-13',
			runId,
			reason: 'event_not_live',
			operationId: 'abort:run-many-settled',
		}))).toEqual({ state: 'accepted' });
		expect(await debug(runId)).toMatchObject({ pending: 0, settled: 0, aborts: 1 });
	});
});
