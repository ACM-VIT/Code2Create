'use agent';

import {
	defineSkill,
	defineTool,
	useAgentFinish,
	useAgentStart,
	useDataWriter,
	useDelivery,
	useInitialData,
	useModel,
	usePersistentState,
	useSkill,
	useTool,
} from '@flue/runtime';
import { env } from 'cloudflare:workers';
import * as v from 'valibot';

import {
	operationsEpisodeAnalysisSchema,
	operationsEpisodeCounterfactualsDataSchema,
	operationsEpisodeHypothesesDataSchema,
	operationsEpisodeInitialDataSchema,
	operationsEpisodePredictionsDataSchema,
	operationsEpisodeStateDataSchema,
	type OperationsEpisodeInitialData,
} from '../lib/episodeProtocol.ts';
import {
	deliverEpisodeAnalysis,
	readEpisodeProjection,
} from '../lib/episodeTransport.ts';
import { operationsIntelligenceModel } from '../lib/model.ts';

export const operationsEpisodeModel = operationsIntelligenceModel;
export const operationsEpisodeAgentVersion = 'operations-episode-v1';

const emptyInputSchema = v.strictObject({});
const completedOutputSchema = v.strictObject({
	completed: v.literal(true),
	revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
const memorySchema = v.strictObject({
	lastAnalyzedRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
	analysisCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const causalAnalysisSkill = defineSkill({
	name: 'episode-causal-analysis',
	description: 'Analyze a bounded operational episode using competing, evidence-cited hypotheses.',
	instructions: [
		'Distinguish observations from hypotheses.',
		'Return one leading hypothesis and at least one credible alternative when evidence permits.',
		'Reject a hypothesis only when a cited fact directly contradicts it.',
		'Never infer sensitive personal traits or rank people.',
	].join('\n'),
});

const forecastSkill = defineSkill({
	name: 'episode-forecasting',
	description: 'Make short-horizon, falsifiable forecasts about an operational situation.',
	instructions: [
		'Forecast the episode state, not a person.',
		'Use a horizon between five minutes and seven days after the supplied current time.',
		'Choose probabilities conservatively and make each statement falsifiable at its horizon.',
		'Do not claim certainty from bounded or at-least counts.',
	].join('\n'),
});

function analysisPrompt(projection: Awaited<ReturnType<typeof readEpisodeProjection>>) {
	const factKeys = projection.facts.map((fact) => fact.factKey);
	return [
		'# Episode analysis',
		`Current time: ${Date.now()}.`,
		`Episode projection: ${JSON.stringify(projection)}.`,
		`Allowed evidence fact keys: ${JSON.stringify(factKeys)}.`,
		'Produce one to three competing hypotheses, zero to three falsifiable predictions, and zero to three counterfactual interventions.',
		'Every hypothesis and prediction must cite only allowed fact keys.',
		'The suggested action is advice for a human operator, not an executed command.',
		'Use the episode-causal-analysis and episode-forecasting skills.',
	].join('\n\n');
}

export function OperationsEpisode() {
	const input = useInitialData<OperationsEpisodeInitialData>();
	const delivery = useDelivery();
	const [rawMemory, setMemory] = usePersistentState('episode-memory-v1', {
		lastAnalyzedRevision: 0,
		analysisCount: 0,
	});
	const memory = v.parse(memorySchema, rawMemory);
	const writeState = useDataWriter('episode-state', { schema: operationsEpisodeStateDataSchema });
	const writeHypotheses = useDataWriter('episode-hypotheses', {
		schema: operationsEpisodeHypothesesDataSchema,
	});
	const writePredictions = useDataWriter('episode-predictions', {
		schema: operationsEpisodePredictionsDataSchema,
	});
	const writeCounterfactuals = useDataWriter('episode-counterfactuals', {
		schema: operationsEpisodeCounterfactualsDataSchema,
	});
	useModel(operationsEpisodeModel, {
		thinkingLevel: 'minimal',
		compaction: { reserveTokens: 24_000, keepRecentTokens: 12_000 },
	});
	useSkill(causalAnalysisSkill);
	useSkill(forecastSkill);

	useAgentStart(async ({ append }) => {
		const requestedRevision = delivery.kind === 'signal'
			? delivery.attributes?.revision ?? 'current'
			: 'current';
		const projection = await readEpisodeProjection({
			episodeId: input.episodeId,
			operationId: `hydrate:${input.episodeId}:${requestedRevision}`,
			bindings: env,
		});
		writeState({
			episodeId: projection.episodeId,
			revision: projection.revision,
			phase: 'hydrating',
			state: projection.state,
			severity: projection.severity,
			relevanceScore: projection.relevanceScore,
		});
		append({
			kind: 'signal',
			type: 'operations.episode.projection',
			body: JSON.stringify(projection),
			attributes: {
				episodeId: projection.episodeId,
				revision: String(projection.revision),
			},
		});
	});

	useTool(defineTool<typeof emptyInputSchema, typeof completedOutputSchema, true, true>({
		name: 'analyze_current_episode',
		description: 'Hydrate, analyze, forecast, and publish the current authorized episode revision. Call exactly once.',
		input: emptyInputSchema,
		output: completedOutputSchema,
		harness: true,
		durable: true,
		async run({ harness, step, signal }) {
			const projection = await step.do(
				`read-episode:${input.episodeId}`,
				() => readEpisodeProjection({
					episodeId: input.episodeId,
					operationId: `analyze-read:${input.episodeId}:${delivery.kind === 'signal' ? delivery.attributes?.revision ?? 'current' : 'current'}`,
					bindings: env,
				}),
			);
			writeState({
				episodeId: projection.episodeId,
				revision: projection.revision,
				phase: 'analyzing',
				state: projection.state,
				severity: projection.severity,
				relevanceScore: projection.relevanceScore,
			});
			const analysis = await step.do(`analyze-episode:${projection.revision}`, async () => {
				const response = await harness.prompt(analysisPrompt(projection), {
					result: operationsEpisodeAnalysisSchema,
					thinkingLevel: 'high',
					...(signal === undefined ? {} : { signal }),
				});
				return response.data;
			});
			writeHypotheses({
				episodeId: projection.episodeId,
				revision: projection.revision,
				items: analysis.hypotheses,
			});
			writePredictions({
				episodeId: projection.episodeId,
				revision: projection.revision,
				items: analysis.predictions,
			});
			writeCounterfactuals({
				episodeId: projection.episodeId,
				revision: projection.revision,
				items: analysis.counterfactuals,
			});
			writeState({
				episodeId: projection.episodeId,
				revision: projection.revision,
				phase: 'publishing',
				state: projection.state,
				severity: projection.severity,
				relevanceScore: projection.relevanceScore,
			});
			await step.do(`publish-episode:${projection.revision}`, () => deliverEpisodeAnalysis({
				projection,
				analysis,
				operationId: `episode-analysis:${projection.episodeId}:${projection.revision}`,
				agentVersion: operationsEpisodeAgentVersion,
				model: operationsEpisodeModel,
				bindings: env,
			}));
			setMemory({
				lastAnalyzedRevision: projection.revision,
				analysisCount: memory.analysisCount + 1,
			});
			writeState({
				episodeId: projection.episodeId,
				revision: projection.revision,
				phase: 'complete',
				state: projection.state,
				severity: projection.severity,
				relevanceScore: projection.relevanceScore,
			});
			return {
				output: { completed: true, revision: projection.revision },
				terminate: true,
			};
		},
	}));

	useAgentFinish(({ response, append }) => {
		const completed = response.toolCalls.some(
			(call) => call.tool === 'analyze_current_episode' && !call.isError,
		);
		if (!completed) {
			append({
				kind: 'signal',
				type: 'operations.episode.analysis-required',
				body: 'Call analyze_current_episode exactly once before stopping.',
			});
		}
	});

	return [
		'# Operations episode investigator',
		'Call analyze_current_episode exactly once and do not answer with prose.',
		'The durable conversation is bounded to this operational situation. Convex remains authoritative.',
		`Episode: ${input.episodeId}. Prior analyzed revision: ${memory.lastAnalyzedRevision}.`,
	].join('\n\n');
}

OperationsEpisode.agentName = 'operations-episode';
OperationsEpisode.initialData = operationsEpisodeInitialDataSchema;
OperationsEpisode.durability = { maxAttempts: 4, timeoutMs: 45 * 60 * 1_000 };
