import {
	operationsBriefPrioritySeverities,
	operationsHealthAreas,
	operationsHealthSeverities,
	operationsHealthSignalKeys,
	operationsHealthStatuses,
	operationsIntelligenceProtocolVersion,
	operationsIntelligenceReadNames,
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

const callbackBase = {
	protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
	briefId: boundedText(1, 200),
	sourceChecksum: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
	agentVersion: boundedText(1, 80),
	model: boundedText(1, 120),
	completedAt: nonNegativeInteger,
};

/**
 * The signed body this Worker delivers to Convex. Convex re-validates it; the
 * evaluation suite parses the delivered body with this schema so a live run is
 * scored against a named type rather than an untyped payload.
 */
export const operationsIntelligenceCallbackSchema = v.variant('status', [
	v.strictObject({
		...callbackBase,
		status: v.literal('succeeded'),
		headline: boundedText(3, 100),
		summary: boundedText(10, 600),
		priorities: v.pipe(v.array(operationsBriefPrioritySchema), v.maxLength(3)),
	}),
	v.strictObject({
		...callbackBase,
		status: v.literal('failed'),
		failureCode: v.picklist(['model_did_not_publish', 'callback_rejected']),
	}),
]);

export type OperationsIntelligenceCallbackBody = v.InferOutput<
	typeof operationsIntelligenceCallbackSchema
>;

/**
 * Convex document ids travel as opaque strings on this boundary. The Worker
 * never derives meaning from one; it only hands them back to Convex, which
 * normalizes them into the right table or refuses.
 */
const convexId = boundedText(1, 64);

export const operationsCopilotRequestSchema = v.strictObject({
	protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
	conversationId: boundedText(1, 200),
	eventSlug: boundedText(1, 120),
	message: boundedText(1, 4_000),
});

export type OperationsCopilotRequest = v.InferOutput<typeof operationsCopilotRequestSchema>;

export const operationsCopilotInitialDataSchema = v.strictObject({
	conversationId: boundedText(1, 200),
	eventSlug: boundedText(1, 120),
});

export type OperationsCopilotInitialData = v.InferOutput<
	typeof operationsCopilotInitialDataSchema
>;

/**
 * What Convex returns for each whitelisted read, re-validated on this side so
 * the model only ever sees data that matches the shape Convex promised.
 * Aggregate counts, operational labels, statuses, ids, and timestamps; the
 * enums Convex owns (detector keys, statuses that may grow) are validated as
 * bounded text so a new backend value does not break a deployed Worker.
 */
const attentionSeverity = v.picklist(['critical', 'attention', 'watch']);

const reviewStateCounts = v.strictObject({
	unassigned: nonNegativeInteger,
	queued: nonNegativeInteger,
	called: nonNegativeInteger,
	inReview: nonNegativeInteger,
	completed: nonNegativeInteger,
	held: nonNegativeInteger,
	missed: nonNegativeInteger,
	withdrawn: nonNegativeInteger,
});

const attendanceStateCounts = v.strictObject({
	expected: nonNegativeInteger,
	confirmationDue: nonNegativeInteger,
	present: nonNegativeInteger,
	temporarilyOut: nonNegativeInteger,
	complete: nonNegativeInteger,
	excused: nonNegativeInteger,
	needsReview: nonNegativeInteger,
	late: nonNegativeInteger,
});

export const platformReadSchemas = {
	operations_health: operationsHealthSnapshotSchema,
	operations_attention: v.strictObject({
		generatedAt: nonNegativeInteger,
		items: v.array(
			v.strictObject({
				itemId: convexId,
				detectorKey: boundedText(1, 80),
				subjectType: boundedText(1, 40),
				severity: attentionSeverity,
				statement: boundedText(1, 500),
				state: v.picklist(['open', 'acknowledged']),
				recurrenceCount: nonNegativeInteger,
				firstObservedAt: nonNegativeInteger,
				lastObservedAt: nonNegativeInteger,
			}),
		),
	}),
	review_rounds: v.strictObject({
		generatedAt: nonNegativeInteger,
		rounds: v.array(
			v.strictObject({
				roundId: convexId,
				name: boundedText(1, 160),
				status: boundedText(1, 40),
				startsAt: nonNegativeInteger,
				endsAt: nonNegativeInteger,
				isPaused: v.boolean(),
				stateCounts: reviewStateCounts,
				panels: v.array(
					v.strictObject({
						panelId: convexId,
						name: boundedText(1, 160),
						status: boundedText(1, 40),
						queuedCount: nonNegativeInteger,
						activeReviewCount: nonNegativeInteger,
					}),
				),
			}),
		),
	}),
	review_exceptions: v.strictObject({
		generatedAt: nonNegativeInteger,
		vacancies: v.array(
			v.strictObject({
				missingPanelMemberId: convexId,
				panelId: convexId,
				panelName: boundedText(1, 160),
				roundId: convexId,
				roundName: boundedText(1, 160),
				vacantSince: v.optional(nonNegativeInteger),
			}),
		),
		teams: v.array(
			v.strictObject({
				teamRoundStateId: convexId,
				roundId: convexId,
				state: boundedText(1, 40),
				callAttemptCount: nonNegativeInteger,
				queuedAt: v.optional(nonNegativeInteger),
				heldAt: v.optional(nonNegativeInteger),
				missedAt: v.optional(nonNegativeInteger),
				tableLabel: v.optional(boundedText(1, 80)),
			}),
		),
		atLeast: v.boolean(),
	}),
	attendance_counts: v.strictObject({
		generatedAt: nonNegativeInteger,
		venueCheckedIn: nonNegativeInteger,
		sessions: v.array(
			v.strictObject({
				sessionId: convexId,
				name: boundedText(1, 160),
				kind: boundedText(1, 40),
				status: boundedText(1, 40),
				startsAt: nonNegativeInteger,
				endsAt: nonNegativeInteger,
				counts: attendanceStateCounts,
			}),
		),
	}),
	floor_mapping_progress: v.strictObject({
		generatedAt: nonNegativeInteger,
		plan: v.nullable(
			v.strictObject({
				name: boundedText(1, 160),
				planNumber: nonNegativeInteger,
				mappingState: boundedText(1, 40),
			}),
		),
		eligibleTeamCount: nonNegativeInteger,
		mappedTeamCount: nonNegativeInteger,
		unmappedTeamCount: nonNegativeInteger,
		lastMappedAt: v.optional(nonNegativeInteger),
		zones: v.array(
			v.strictObject({
				zoneId: convexId,
				name: boundedText(1, 160),
				mappedTeamCount: nonNegativeInteger,
			}),
		),
	}),
	support_load: v.strictObject({
		generatedAt: nonNegativeInteger,
		byState: v.strictObject({
			open: nonNegativeInteger,
			investigating: nonNegativeInteger,
			waiting: nonNegativeInteger,
			resolved: nonNegativeInteger,
			closed: nonNegativeInteger,
		}),
		openByCategory: v.array(
			v.strictObject({ category: boundedText(1, 60), count: nonNegativeInteger }),
		),
		unassignedOpenCount: nonNegativeInteger,
		oldestOpenAt: v.optional(nonNegativeInteger),
		atLeast: v.boolean(),
	}),
	recommendation_history: v.strictObject({
		generatedAt: nonNegativeInteger,
		recommendations: v.array(
			v.strictObject({
				proposalKey: boundedText(1, 200),
				kind: boundedText(1, 60),
				statement: boundedText(1, 300),
				status: v.picklist(['proposed', 'approved', 'rejected', 'superseded']),
				operatorNote: v.optional(boundedText(1, 1_000)),
				proposedAt: nonNegativeInteger,
				decidedAt: v.optional(nonNegativeInteger),
			}),
		),
	}),
} as const;

export const platformReadEnvelopeSchema = v.strictObject({
	read: v.picklist(operationsIntelligenceReadNames),
	data: v.unknown(),
});

/**
 * The support-case categories Convex accepts, restated for the proposal
 * schema: this one enum is load-bearing on a write path, so the Worker
 * refuses an unknown category before it travels.
 */
export const copilotSupportCaseCategories = [
	'identity',
	'team',
	'project_intake',
	'track_configuration',
	'attendance_credential',
	'missing_scan',
	'scanner_device',
	'table_location',
	'integration',
	'queue',
	'reviewer_device',
	'scorecard',
	'accessibility',
	'safety',
] as const;

export const copilotRecommendationArgumentsSchema = v.variant('kind', [
	v.strictObject({
		kind: v.literal('hold_review_team'),
		teamRoundStateId: convexId,
		reason: boundedText(5, 500),
	}),
	v.strictObject({
		kind: v.literal('page_reserve_reviewer'),
		missingPanelMemberId: convexId,
		reason: boundedText(5, 500),
	}),
	v.strictObject({
		kind: v.literal('open_support_case'),
		category: v.picklist(copilotSupportCaseCategories),
		description: boundedText(10, 2_000),
		roundId: v.optional(convexId),
		teamId: v.optional(convexId),
	}),
	v.strictObject({
		kind: v.literal('dismiss_attention_item'),
		itemId: convexId,
		reason: boundedText(5, 500),
	}),
]);

export const copilotCitationSchema = v.strictObject({
	read: v.picklist(operationsIntelligenceReadNames),
	generatedAt: nonNegativeInteger,
	keys: v.pipe(v.array(boundedText(1, 200)), v.minLength(1), v.maxLength(16)),
});

/**
 * The model-facing half of a proposal. The Worker adds the envelope facts —
 * protocol version, conversation, event, agent version, model — so the model
 * cannot claim to be a different agent or aim at a different event.
 */
export const copilotProposalInputSchema = v.strictObject({
	proposalKey: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{7,99}$/)),
	statement: boundedText(10, 300),
	reasoning: boundedText(10, 1_500),
	citations: v.pipe(v.array(copilotCitationSchema), v.minLength(1), v.maxLength(8)),
	arguments: copilotRecommendationArgumentsSchema,
});

export const copilotProposalSchema = v.strictObject({
	protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
	proposalKey: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{7,99}$/)),
	conversationId: boundedText(1, 200),
	eventSlug: boundedText(1, 120),
	agentVersion: boundedText(1, 80),
	model: boundedText(3, 160),
	statement: boundedText(10, 300),
	reasoning: boundedText(10, 1_500),
	citations: v.pipe(v.array(copilotCitationSchema), v.minLength(1), v.maxLength(8)),
	arguments: copilotRecommendationArgumentsSchema,
});

export type CopilotProposal = v.InferOutput<typeof copilotProposalSchema>;
