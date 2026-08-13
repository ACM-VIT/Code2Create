import type { AutonomyAdmissionControllerDebugState } from './autonomyAdmissionController.ts';
import type { AutonomyTerminalSettlement } from './autonomyAdmissionController.ts';
import {
	AutonomyAdmissionFenceState,
	type AutonomyFenceAdmissionRequest,
} from './autonomyAdmissionFenceState.ts';

type TestDispatchMode = 'accept' | 'fail' | 'defer' | 'defer_before_dispatch';

export class TestOperationsAutonomyAdmissionFence
	extends AutonomyAdmissionFenceState<TestEnvironment> {
	#releaseDispatch: (() => void) | undefined;

	async configure(mode: TestDispatchMode) {
		await this.ctx.storage.put('test:mode', mode);
	}

	releaseDispatch() {
		this.#releaseDispatch?.();
		this.#releaseDispatch = undefined;
	}

	async inspect(): Promise<AutonomyAdmissionControllerDebugState & {
		dispatches: number;
		aborts: number;
		closed: boolean;
		terminalDeliveries: number;
		terminalPending: boolean;
	}> {
		const pending = await this.ctx.storage.list({ prefix: 'pending:' });
		const admissions = await this.ctx.storage.list({ prefix: 'admission:' });
		return {
			revoked: await this.ctx.storage.get<boolean>('revoked') === true,
			pending: pending.size,
			settled: admissions.size - pending.size,
			abortRecorded: await this.ctx.storage.get<boolean>('abortRecorded') === true,
			dispatches: await this.ctx.storage.get<number>('test:dispatches') ?? 0,
			aborts: await this.ctx.storage.get<number>('test:aborts') ?? 0,
			closed: await this.ctx.storage.get<boolean>('closed') === true,
			terminalDeliveries: await this.ctx.storage.get<number>('test:terminalDeliveries') ?? 0,
			terminalPending: await this.ctx.storage.get<boolean>('terminalPending') === true,
		};
	}

	async configureTerminalFailures(failures: number) {
		await this.ctx.storage.put('test:terminalFailures', failures);
	}

	async retainedAdmissionJson() {
		return [...(await this.ctx.storage.list({ prefix: 'admission:' })).values()]
			.map((value) => JSON.stringify(value));
	}

	async retainedTerminalSettlementJson() {
		const value = await this.ctx.storage.get('terminalSettlement');
		return value === undefined ? null : JSON.stringify(value);
	}

	runAlarmForTest() {
		return this.alarm();
	}

	protected async dispatchAdmission(
		request: AutonomyFenceAdmissionRequest,
		mayDispatch: () => Promise<boolean>,
	) {
		const mode = await this.ctx.storage.get<TestDispatchMode>('test:mode') ?? 'accept';
		if (mode === 'defer_before_dispatch') {
			await new Promise<void>((resolve) => {
				this.#releaseDispatch = resolve;
			});
		}
		if (!(await mayDispatch())) return undefined;
		const dispatches = await this.ctx.storage.get<number>('test:dispatches') ?? 0;
		await this.ctx.storage.put('test:dispatches', dispatches + 1);
		if (mode === 'fail') throw new Error('simulated unavailable admission');
		if (mode === 'defer') {
			await new Promise<void>((resolve) => {
				this.#releaseDispatch = resolve;
			});
		}
		return {
			submissionId: `submission-${request.operationId}`,
			acceptedAt: '2026-08-13T00:00:00.000Z',
			uid: `uid-${request.payload.runId}`,
		};
	}

	protected async abortRun() {
		const aborts = await this.ctx.storage.get<number>('test:aborts') ?? 0;
		await this.ctx.storage.put('test:aborts', aborts + 1);
		return 'not_found' as const;
	}

	protected async deliverTerminalSettlement(_settlement: AutonomyTerminalSettlement) {
		const deliveries = await this.ctx.storage.get<number>('test:terminalDeliveries') ?? 0;
		const next = deliveries + 1;
		await this.ctx.storage.put('test:terminalDeliveries', next);
		const failures = await this.ctx.storage.get<number>('test:terminalFailures') ?? 0;
		if (next <= failures) throw new Error('simulated unavailable terminal callback');
	}

	protected dispatchConflict() {
		return undefined;
	}
}

interface TestEnvironment {
	FENCE: DurableObjectNamespace<TestOperationsAutonomyAdmissionFence>;
}

export default {
	async fetch(request: Request, environment: TestEnvironment) {
		const url = new URL(request.url);
		const runId = url.searchParams.get('runId') ?? 'run-workerd';
		const fence = environment.FENCE.getByName(runId);
		if (url.pathname === '/configure') {
			const mode = url.searchParams.get('mode');
			if (
				mode !== 'accept' && mode !== 'fail' && mode !== 'defer' &&
				mode !== 'defer_before_dispatch'
			) {
				return Response.json({ error: 'invalid_mode' }, { status: 422 });
			}
			await fence.configure(mode);
			return Response.json({ ok: true });
		}
		if (url.pathname === '/initial') {
			return Response.json(await fence.admitInitial(await request.json()));
		}
		if (url.pathname === '/continue') {
			return Response.json(await fence.admitContinuation(await request.json()));
		}
		if (url.pathname === '/revoke') {
			return Response.json(await fence.revoke(await request.json()));
		}
		if (url.pathname === '/configure-terminal') {
			const failures = Number(url.searchParams.get('failures'));
			if (!Number.isSafeInteger(failures) || failures < 0) {
				return Response.json({ error: 'invalid_failures' }, { status: 422 });
			}
			await fence.configureTerminalFailures(failures);
			return Response.json({ ok: true });
		}
		if (url.pathname === '/terminal') {
			await fence.enqueueTerminalSettlement(await request.json());
			return Response.json({ ok: true });
		}
		if (url.pathname === '/alarm') {
			await fence.runAlarmForTest();
			return Response.json({ ok: true });
		}
		if (url.pathname === '/release') {
			fence.releaseDispatch();
			return Response.json({ ok: true });
		}
		if (url.pathname === '/inspect') {
			return Response.json(await fence.inspect());
		}
		if (url.pathname === '/retained') {
			return Response.json(await fence.retainedAdmissionJson());
		}
		if (url.pathname === '/terminal-retained') {
			return Response.json(await fence.retainedTerminalSettlementJson());
		}
		return Response.json({ error: 'not_found' }, { status: 404 });
	},
};
