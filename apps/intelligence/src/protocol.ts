import {
  admissionIntelligenceReadNames,
  operationsBriefPrioritySeverities,
  operationsHealthAreas,
  operationsHealthSeverities,
  operationsHealthSignalKeys,
  operationsHealthStatuses,
  operationsIntelligenceProtocolVersion,
  operationsIntelligenceReadNames,
  supportCaseCategoryOrder,
} from "@code2create/domain";
import * as v from "valibot";

import { autonomyDeepReadSchemas } from "./lib/autonomyDeepReadSchemas.ts";

const boundedText = (minimum: number, maximum: number) =>
  v.pipe(v.string(), v.minLength(minimum), v.maxLength(maximum));

const nonNegativeInteger = v.pipe(v.number(), v.integer(), v.minValue(0));
const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));
const maximumAttentionRows = 100;
const maximumReviewRounds = 20;
const maximumReviewPanelsPerRound = 100;
const maximumReviewExceptionRows = 100;
const maximumAttendanceSessions = 64;
const maximumAutonomySupportRows = 4;
const maximumRecommendationHistoryRows = 50;
const maximumAdmissionSearchRows = 25;
const maximumAdmissionPolicyCriteria = 20;
const maximumAdmissionCohortCandidates = 48;

const healthSignal = v.strictObject({
  key: v.picklist(operationsHealthSignalKeys),
  area: v.picklist(operationsHealthAreas),
  severity: v.picklist(operationsHealthSeverities),
  title: boundedText(1, 160),
  detail: boundedText(1, 500),
  owner: boundedText(2, 80),
  nextAction: boundedText(4, 240),
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
    status: v.picklist(["draft", "registration_open", "registration_closed", "live", "complete"]),
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

/** The only model-authored input accepted by the authoritative brief renderer. */
export const operationsBriefSelectionSchema = v.strictObject({
  prioritySignalGroups: v.pipe(
    v.array(
      v.pipe(v.array(v.picklist(operationsHealthSignalKeys)), v.minLength(1), v.maxLength(6)),
    ),
    v.maxLength(3),
  ),
});

export type OperationsIntelligenceInput = v.InferOutput<typeof operationsIntelligenceRequestSchema>;

const callbackBase = {
  protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
  briefId: boundedText(1, 200),
  sourceChecksum: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  agentVersion: boundedText(1, 80),
  model: boundedText(1, 120),
  completedAt: nonNegativeInteger,
};

/** Shared validation for signed callbacks at Convex and in live evaluations. */
export const operationsIntelligenceCallbackSchema = v.variant("status", [
  v.strictObject({
    ...callbackBase,
    status: v.literal("succeeded"),
    headline: boundedText(3, 100),
    summary: boundedText(10, 600),
    priorities: v.pipe(v.array(operationsBriefPrioritySchema), v.maxLength(3)),
  }),
  v.strictObject({
    ...callbackBase,
    status: v.literal("failed"),
    failureCode: v.picklist(["model_did_not_publish", "callback_rejected"]),
  }),
]);

export type OperationsIntelligenceCallbackBody = v.InferOutput<
  typeof operationsIntelligenceCallbackSchema
>;

/** Keeps Convex IDs opaque until Convex validates their table and ownership. */
const convexId = boundedText(1, 64);

export const operationsCopilotRequestSchema = v.strictObject({
  protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
  conversationId: v.pipe(v.string(), v.regex(/^cv_[a-f0-9]{64}$/u)),
  turnId: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(200),
    v.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  ),
  eventSlug: v.pipe(boundedText(1, 120), v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)),
  message: boundedText(1, 4_000),
});

export type OperationsCopilotRequest = v.InferOutput<typeof operationsCopilotRequestSchema>;

export const operationsCopilotInitialDataSchema = v.strictObject({
  conversationId: v.pipe(v.string(), v.regex(/^cv_[a-f0-9]{64}$/u)),
  eventSlug: v.pipe(boundedText(1, 120), v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)),
});

export type OperationsCopilotInitialData = v.InferOutput<typeof operationsCopilotInitialDataSchema>;

/** Validates redacted operations-read responses before model access. */
const attentionSeverity = v.picklist(["critical", "attention", "watch"]);

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
    atLeast: v.boolean(),
    items: v.pipe(
      v.array(
        v.strictObject({
          itemId: convexId,
          detectorKey: boundedText(1, 80),
          subjectType: boundedText(1, 40),
          severity: attentionSeverity,
          statement: boundedText(1, 500),
          state: v.picklist(["open", "acknowledged"]),
          version: positiveInteger,
          recurrenceCount: nonNegativeInteger,
          firstObservedAt: nonNegativeInteger,
          lastObservedAt: nonNegativeInteger,
        }),
      ),
      v.maxLength(maximumAttentionRows),
    ),
  }),
  review_rounds: v.strictObject({
    generatedAt: nonNegativeInteger,
    rounds: v.pipe(
      v.array(
        v.strictObject({
          roundId: convexId,
          name: boundedText(1, 160),
          status: v.picklist(["draft", "published", "open", "closing", "closed"]),
          startsAt: nonNegativeInteger,
          endsAt: nonNegativeInteger,
          isPaused: v.boolean(),
          stateCounts: reviewStateCounts,
          panels: v.pipe(
            v.array(
              v.strictObject({
                panelId: convexId,
                name: boundedText(1, 160),
                status: v.picklist(["draft", "ready", "needs_reviewer", "paused", "closed"]),
                queuedCount: nonNegativeInteger,
                activeReviewCount: nonNegativeInteger,
              }),
            ),
            v.maxLength(maximumReviewPanelsPerRound),
          ),
        }),
      ),
      v.maxLength(maximumReviewRounds),
    ),
  }),
  review_exceptions: v.strictObject({
    generatedAt: nonNegativeInteger,
    vacancies: v.pipe(
      v.array(
        v.strictObject({
          missingPanelMemberId: convexId,
          panelId: convexId,
          panelName: boundedText(1, 160),
          panelVersion: positiveInteger,
          roundId: convexId,
          roundName: boundedText(1, 160),
          vacantSince: v.optional(nonNegativeInteger),
        }),
      ),
      v.maxLength(maximumReviewExceptionRows),
    ),
    teams: v.pipe(
      v.array(
        v.strictObject({
          teamRoundStateId: convexId,
          roundId: convexId,
          state: v.picklist(["queued", "called", "at_table", "held", "missed"]),
          version: positiveInteger,
          callAttemptCount: nonNegativeInteger,
          queuedAt: v.optional(nonNegativeInteger),
          heldAt: v.optional(nonNegativeInteger),
          missedAt: v.optional(nonNegativeInteger),
        }),
      ),
      v.maxLength(maximumReviewExceptionRows),
    ),
    atLeast: v.boolean(),
  }),
  attendance_counts: v.strictObject({
    generatedAt: nonNegativeInteger,
    venueCheckedIn: nonNegativeInteger,
    sessions: v.pipe(
      v.array(
        v.strictObject({
          sessionId: convexId,
          name: boundedText(1, 160),
          kind: v.picklist([
            "hacking",
            "briefing",
            "review_preparation",
            "overnight_access",
            "workshop",
            "other",
          ]),
          status: v.picklist([
            "scheduled",
            "preparing",
            "ready",
            "open",
            "closing",
            "closed",
            "cancelled",
          ]),
          startsAt: nonNegativeInteger,
          endsAt: nonNegativeInteger,
          counts: attendanceStateCounts,
        }),
      ),
      v.maxLength(maximumAttendanceSessions),
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
    openByCategory: v.pipe(
      v.array(
        v.strictObject({
          category: v.picklist(supportCaseCategoryOrder),
          count: nonNegativeInteger,
        }),
      ),
      v.maxLength(supportCaseCategoryOrder.length),
    ),
    unassignedActiveCount: nonNegativeInteger,
    oldestOpenAt: v.optional(nonNegativeInteger),
    atLeast: v.boolean(),
    cases: v.pipe(
      v.array(
        v.strictObject({
          caseId: convexId,
          category: v.picklist(supportCaseCategoryOrder),
          state: v.picklist(["open", "investigating", "waiting", "resolved", "closed"]),
          createdAt: nonNegativeInteger,
          teamId: v.optional(convexId),
          roundId: v.optional(convexId),
        }),
      ),
      v.maxLength(maximumAutonomySupportRows),
    ),
  }),
  ...autonomyDeepReadSchemas,
  recommendation_history: v.strictObject({
    generatedAt: nonNegativeInteger,
    recommendations: v.pipe(
      v.array(
        v.strictObject({
          proposalKey: boundedText(1, 200),
          kind: v.picklist([
            "hold_review_team",
            "page_reserve_reviewer",
            "open_support_case",
            "dismiss_attention_item",
          ]),
          statement: boundedText(1, 300),
          status: v.picklist(["proposed", "approved", "rejected", "superseded"]),
          operatorNote: v.optional(boundedText(1, 1_000)),
          proposedAt: nonNegativeInteger,
          decidedAt: v.optional(nonNegativeInteger),
        }),
      ),
      v.maxLength(maximumRecommendationHistoryRows),
    ),
  }),
} as const;

export const platformReadEnvelopeSchema = v.strictObject({
  read: v.picklist(operationsIntelligenceReadNames),
  data: v.unknown(),
});

/** Validates redacted admission-read responses before model access. */
const admissionReviewCoverage = v.strictObject({
  assigned: nonNegativeInteger,
  completed: nonNegativeInteger,
  required: nonNegativeInteger,
  decidable: v.boolean(),
  shortfall: nonNegativeInteger,
});

const admissionNoveltySignal = v.nullable(
  v.strictObject({
    score: v.pipe(nonNegativeInteger, v.maxValue(100)),
    band: v.picklist(["familiar", "developing", "distinct"]),
    nearestThemeLabel: boundedText(1, 160),
    nearestSimilarity: v.optional(v.pipe(v.number(), v.minValue(-1), v.maxValue(1))),
  }),
);

const admissionCohortCandidate = v.strictObject({
  applicationId: convexId,
  teamId: convexId,
  teamName: boundedText(1, 160),
  state: v.picklist([
    "submitted",
    "under_review",
    "needs_information",
    "accepted",
    "waitlisted",
    "declined",
    "offer_sent",
    "confirmed",
    "offer_expired",
    "withdrawn",
  ]),
  submittedAt: nonNegativeInteger,
  experienceBand: v.picklist([
    "first_year",
    "early_year",
    "later_year",
    "postgraduate_or_professional",
    "mixed_or_external",
  ]),
  teamSize: positiveInteger,
  reviewCoverage: admissionReviewCoverage,
  reviewSignal: v.strictObject({
    accept: nonNegativeInteger,
    waitlist: nonNegativeInteger,
    decline: nonNegativeInteger,
    needsInformation: nonNegativeInteger,
  }),
  aiRecommendation: v.optional(
    v.strictObject({
      state: v.picklist([
        "pending",
        "running",
        "succeeded",
        "refused",
        "invalid",
        "timed_out",
        "rate_limited",
        "failed",
        "stale",
        "disabled",
      ]),
      current: v.boolean(),
      recommendation: v.optional(
        v.picklist(["accept", "waitlist", "decline", "needs_information"]),
      ),
      confidence: v.optional(v.picklist(["low", "medium", "high"])),
      criterionAssessments: v.pipe(
        v.array(
          v.strictObject({
            criterionKey: boundedText(1, 80),
            assessment: v.picklist(["meets", "partly_meets", "not_yet_clear"]),
          }),
        ),
        v.maxLength(maximumAdmissionPolicyCriteria),
      ),
    }),
  ),
  novelty: admissionNoveltySignal,
  rank: positiveInteger,
  cumulativePeople: positiveInteger,
  entryCapacityPeople: positiveInteger,
  suggestedIn: v.boolean(),
});

export const admissionReadSchemas = {
  admission_cohort: v.strictObject({
    generatedAt: nonNegativeInteger,
    capacityPeople: nonNegativeInteger,
    policy: v.strictObject({
      version: boundedText(1, 80),
      minimumHumanReviews: nonNegativeInteger,
      overallParticipantCapacity: nonNegativeInteger,
      criteria: v.pipe(
        v.array(
          v.strictObject({
            criterionKey: boundedText(1, 80),
            label: boundedText(1, 160),
          }),
        ),
        v.maxLength(maximumAdmissionPolicyCriteria),
      ),
    }),
    summary: v.strictObject({
      capacityPeople: nonNegativeInteger,
      committedPeople: nonNegativeInteger,
      suggestedPeople: nonNegativeInteger,
      remainingPeople: v.pipe(v.number(), v.integer()),
      suggestedInTeamCount: nonNegativeInteger,
      suggestedInNotYetDecidableCount: nonNegativeInteger,
      bandMix: v.pipe(
        v.array(
          v.strictObject({
            band: v.picklist([
              "first_year",
              "early_year",
              "later_year",
              "postgraduate_or_professional",
              "mixed_or_external",
            ]),
            teamsIn: nonNegativeInteger,
            peopleIn: nonNegativeInteger,
            teamsOut: nonNegativeInteger,
            peopleOut: nonNegativeInteger,
          }),
        ),
        v.maxLength(5),
      ),
    }),
    counts: v.strictObject({
      committedTeams: nonNegativeInteger,
      decidedOutTeams: nonNegativeInteger,
      candidateTeams: nonNegativeInteger,
    }),
    window: v.strictObject({
      startRank: nonNegativeInteger,
      endRank: nonNegativeInteger,
      hasEarlier: v.boolean(),
      hasLater: v.boolean(),
    }),
    candidates: v.pipe(
      v.array(admissionCohortCandidate),
      v.maxLength(maximumAdmissionCohortCandidates),
    ),
  }),
  admission_submission_search: v.strictObject({
    generatedAt: nonNegativeInteger,
    searchQuery: boundedText(1, 200),
    matches: v.pipe(
      v.array(
        v.strictObject({
          applicationId: convexId,
          teamId: convexId,
          teamName: boundedText(1, 160),
          state: v.picklist([
            "submitted",
            "under_review",
            "needs_information",
            "accepted",
            "waitlisted",
            "declined",
            "offer_sent",
            "confirmed",
            "offer_expired",
            "withdrawn",
          ]),
          experienceBand: v.picklist([
            "first_year",
            "early_year",
            "later_year",
            "postgraduate_or_professional",
            "mixed_or_external",
          ]),
          teamSize: positiveInteger,
          ideaExcerpt: v.pipe(v.string(), v.maxLength(320)),
          novelty: admissionNoveltySignal,
          reviewCoverage: admissionReviewCoverage,
        }),
      ),
      v.maxLength(maximumAdmissionSearchRows),
    ),
    truncated: v.boolean(),
  }),
} as const;

export const admissionReadEnvelopeSchema = v.strictObject({
  read: v.picklist(admissionIntelligenceReadNames),
  data: v.unknown(),
});

/** Rejects unsupported support categories before proposal delivery. */
export const autonomyRecommendationArgumentsSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("hold_review_team"),
    teamRoundStateId: convexId,
    expectedTeamRoundStateVersion: positiveInteger,
    reason: boundedText(5, 500),
  }),
  v.strictObject({
    kind: v.literal("page_reserve_reviewer"),
    missingPanelMemberId: convexId,
    expectedPanelVersion: positiveInteger,
    reason: boundedText(5, 500),
  }),
  v.strictObject({
    kind: v.literal("open_support_case"),
    category: v.picklist(supportCaseCategoryOrder),
    description: boundedText(10, 2_000),
    roundId: v.optional(convexId),
    teamId: v.optional(convexId),
  }),
  v.strictObject({
    kind: v.literal("dismiss_attention_item"),
    itemId: convexId,
    expectedItemVersion: positiveInteger,
    reason: boundedText(5, 500),
  }),
]);

export const copilotRecommendationArgumentsSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("hold_review_team"),
    teamRoundStateId: convexId,
    expectedTeamRoundStateVersion: positiveInteger,
    reason: boundedText(5, 500),
  }),
  v.strictObject({
    kind: v.literal("page_reserve_reviewer"),
    missingPanelMemberId: convexId,
    expectedPanelVersion: positiveInteger,
    reason: boundedText(5, 500),
  }),
  v.strictObject({
    kind: v.literal("open_support_case"),
    category: v.picklist(supportCaseCategoryOrder),
    description: boundedText(10, 2_000),
    roundId: v.optional(convexId),
    teamId: v.optional(convexId),
  }),
  v.strictObject({
    kind: v.literal("dismiss_attention_item"),
    itemId: convexId,
    expectedItemVersion: positiveInteger,
    reason: boundedText(5, 500),
  }),
  v.strictObject({
    kind: v.literal("set_admission_minimum_human_reviews"),
    minimumHumanReviews: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5)),
    reason: boundedText(5, 500),
  }),
]);

export const copilotCitationSchema = v.strictObject({
  read: v.picklist([...operationsIntelligenceReadNames, ...admissionIntelligenceReadNames]),
  generatedAt: nonNegativeInteger,
  keys: v.pipe(v.array(boundedText(1, 200)), v.minLength(1), v.maxLength(16)),
});

/** The Worker supplies envelope identity so the model cannot choose its agent or event. */
export const copilotProposalInputSchema = v.strictObject({
  proposalKey: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{7,99}$/)),
  statement: boundedText(10, 300),
  reasoning: boundedText(10, 1_500),
  citations: v.pipe(v.array(copilotCitationSchema), v.minLength(1), v.maxLength(8)),
  command: boundedText(3, 160),
  argumentsJson: boundedText(2, 4_000),
});

export const copilotProposalSchema = v.strictObject({
  protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
  proposalKey: boundedText(8, 200),
  conversationId: v.pipe(v.string(), v.regex(/^cv_[a-f0-9]{64}$/u)),
  eventSlug: v.pipe(boundedText(1, 120), v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)),
  agentVersion: boundedText(1, 80),
  model: boundedText(3, 160),
  statement: boundedText(10, 300),
  reasoning: boundedText(10, 1_500),
  citations: v.pipe(v.array(copilotCitationSchema), v.minLength(1), v.maxLength(8)),
  arguments: copilotRecommendationArgumentsSchema,
});

export type CopilotProposal = v.InferOutput<typeof copilotProposalSchema>;
