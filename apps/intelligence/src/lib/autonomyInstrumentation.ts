import type { FlueExecutionInterceptor, FlueInstrumentation } from '@flue/runtime';
import * as v from 'valibot';

import { operationsAutonomyDispatchRequestSchema } from './autonomyProtocol.ts';
import {
	autonomyRunState,
	cachedModelAuthorization,
	runWithAutonomyOperation,
} from './autonomyContext.ts';
import { authorizeAutonomyWork, type AutonomyBindings } from './autonomyTransport.ts';
import { autonomyOperationId } from './autonomyOperationId.ts';

const instrumentationKey = Symbol.for('code2create.operations-autonomy-authority.v1');

export function createAutonomyExecutionInterceptor(
	bindings: AutonomyBindings,
): FlueExecutionInterceptor {
	return async (operation, context, next) => {
		if (context.agentName !== 'operations-autopilot') return next();
		if (operation.type === 'task') {
			throw new Error('Native Flue task delegation is disabled for autonomous runs.');
		}
		if (operation.type !== 'model') return next();

		const input = v.safeParse(operationsAutonomyDispatchRequestSchema, context.initialData);
		if (!input.success || context.instanceId !== input.output.runId) {
			throw new Error('The autonomous model execution context is invalid.');
		}
		const state = autonomyRunState(input.output);
		const operationId = await autonomyOperationId('model', [
			input.output.runId,
			operation.turnId,
		]);
		return runWithAutonomyOperation(state, operationId, async () => {
			await cachedModelAuthorization(state.input.runId, operationId, async () => {
				const receipt = await authorizeAutonomyWork({
					state,
					operationId,
					operation: { kind: 'model' },
					bindings,
				});
				return receipt.sequence;
			});
			return next();
		});
	};
}

export function createAutonomyInstrumentation(
	bindings: AutonomyBindings,
): FlueInstrumentation {
	return {
		key: instrumentationKey,
		observe: () => {},
		interceptor: createAutonomyExecutionInterceptor(bindings),
		dispose: () => {},
	};
}
