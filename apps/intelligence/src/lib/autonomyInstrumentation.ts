import type { FlueExecutionInterceptor, FlueInstrumentation } from '@flue/runtime';
import * as v from 'valibot';

import { operationsAutonomyDispatchRequestSchema } from './autonomyProtocol.ts';
import { operationsEpisodeInitialDataSchema } from './episodeProtocol.ts';
import { readEpisodeProjection } from './episodeTransport.ts';
import { ideaIntelligenceInitialDataSchema } from './ideaProtocol.ts';
import { readIdeaProjection } from './ideaTransport.ts';
import {
	autonomyRunState,
	cachedModelAuthorization,
	runWithAutonomyOperation,
} from './autonomyContext.ts';
import { authorizeAutonomyWork, type AutonomyBindings } from './autonomyTransport.ts';
import { autonomyOperationId } from './autonomyOperationId.ts';

const instrumentationKey = Symbol.for('code2create.operations-autonomy-authority.v1');

type IntelligenceExecutionBindings = AutonomyBindings & Partial<Pick<
	Cloudflare.Env,
	| 'CONVEX_INTELLIGENCE_EPISODE_READ_URL'
	| 'CONVEX_INTELLIGENCE_EPISODE_CALLBACK_URL'
	| 'CONVEX_INTELLIGENCE_IDEA_READ_URL'
	| 'CONVEX_INTELLIGENCE_IDEA_CALLBACK_URL'
>>;

export function createAutonomyExecutionInterceptor(
	bindings: IntelligenceExecutionBindings,
): FlueExecutionInterceptor {
	return async (operation, context, next) => {
		if (context.agentName === 'idea-submission') {
			if (operation.type !== 'model' && operation.type !== 'task') return next();
			const input = v.safeParse(ideaIntelligenceInitialDataSchema, context.initialData);
			if (!input.success || context.instanceId !== input.output.applicationId) {
				throw new Error('The idea model execution context is invalid.');
			}
			if (bindings.CONVEX_INTELLIGENCE_IDEA_READ_URL === undefined) {
				throw new Error('The idea authority endpoint is unavailable.');
			}
			const executionId = operation.type === 'model' ? operation.turnId : operation.taskId;
			await readIdeaProjection({
				applicationId: input.output.applicationId,
				eventId: input.output.eventId,
				operationId: `authorize:${operation.type}:${executionId}`,
				bindings: {
					CONVEX_INTELLIGENCE_IDEA_READ_URL: bindings.CONVEX_INTELLIGENCE_IDEA_READ_URL,
					INTELLIGENCE_READ_SECRET: bindings.INTELLIGENCE_READ_SECRET,
				},
			});
			return next();
		}
		if (context.agentName === 'operations-episode') {
			if (operation.type !== 'model' && operation.type !== 'task') return next();
			const input = v.safeParse(operationsEpisodeInitialDataSchema, context.initialData);
			if (!input.success || context.instanceId !== input.output.episodeId) {
				throw new Error('The episode model execution context is invalid.');
			}
			if (bindings.CONVEX_INTELLIGENCE_EPISODE_READ_URL === undefined) {
				throw new Error('The episode authority endpoint is unavailable.');
			}
			const executionId = operation.type === 'model' ? operation.turnId : operation.taskId;
			await readEpisodeProjection({
				episodeId: input.output.episodeId,
				operationId: `authorize:${operation.type}:${executionId}`,
				bindings: {
					CONVEX_INTELLIGENCE_EPISODE_READ_URL:
						bindings.CONVEX_INTELLIGENCE_EPISODE_READ_URL,
					INTELLIGENCE_READ_SECRET: bindings.INTELLIGENCE_READ_SECRET,
				},
			});
			return next();
		}
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
	bindings: IntelligenceExecutionBindings,
): FlueInstrumentation {
	return {
		key: instrumentationKey,
		observe: () => {},
		interceptor: createAutonomyExecutionInterceptor(bindings),
		dispose: () => {},
	};
}
