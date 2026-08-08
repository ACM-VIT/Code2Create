import {
	operationsBriefPrioritySeverities,
	operationsHealthAreas,
	operationsHealthSeverities,
	operationsHealthSignalKeys,
	operationsHealthStatuses,
	operationsIntelligenceProtocolVersion,
} from '@code2create/domain';
import * as v from 'valibot';

const boundedText = (minimum: number, maximum: number) =>
	v.pipe(v.string(), v.minLength(minimum), v.maxLength(maximum));

const nonNegativeInteger = v.pipe(v.number(), v.integer(), v.minValue(0));

const healthSignal = v.strictObject({
	key: v.picklist(operationsHealthSignalKeys),
	area: v.picklist(operationsHealthAreas),
	severity: v.picklist(operationsHealthSeverities),
	title: boundedText(1, 160),
	detail: boundedText(1, 500),
	owner: boundedText(1, 100),
	nextAction: boundedText(1, 300),
	count: nonNegativeInteger,
	atLeast: v.boolean(),
	oldestAt: v.optional(nonNegativeInteger),
});

export const operationsHealthSnapshotSchema = v.strictObject({
	generatedAt: nonNegativeInteger,
	event: v.strictObject({
		slug: boundedText(1, 120),
		name: boundedText(1, 160),
		timezone: boundedText(1, 80),
		status: v.picklist([
			'draft',
			'registration_open',
			'registration_closed',
			'live',
			'complete',
		]),
	}),
	summary: v.strictObject({
		status: v.picklist(operationsHealthStatuses),
		signalCount: nonNegativeInteger,
		criticalSignalCount: nonNegativeInteger,
		attentionSignalCount: nonNegativeInteger,
		watchSignalCount: nonNegativeInteger,
	}),
	signals: v.pipe(v.array(healthSignal), v.maxLength(64)),
});

export const operationsIntelligenceRequestSchema = v.strictObject({
	protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
	briefId: boundedText(1, 200),
	sourceChecksum: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
	snapshot: operationsHealthSnapshotSchema,
});

export const operationsBriefPrioritySchema = v.strictObject({
	severity: v.picklist(operationsBriefPrioritySeverities),
	title: boundedText(3, 120),
	why: boundedText(8, 300),
	owner: boundedText(2, 80),
	nextAction: boundedText(4, 240),
	signalKeys: v.pipe(
		v.array(v.picklist(operationsHealthSignalKeys)),
		v.minLength(1),
		v.maxLength(6),
	),
});

export const operationsBriefOutputSchema = v.strictObject({
	headline: boundedText(3, 100),
	summary: boundedText(10, 600),
	priorities: v.pipe(v.array(operationsBriefPrioritySchema), v.maxLength(3)),
});

export type OperationsIntelligenceInput = v.InferOutput<
	typeof operationsIntelligenceRequestSchema
>;
