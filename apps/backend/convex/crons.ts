import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval(
  "call overdue outing participants",
  { minutes: 1 },
  internal.serviceQueues.sweepOverdueCalls,
  { cursor: null },
);
crons.interval(
  "prepare published review questions",
  { seconds: 30 },
  internal.reviewQuestions.dispatch,
  { status: "published" },
);
crons.interval(
  "refresh open review questions",
  { seconds: 30 },
  internal.reviewQuestions.dispatch,
  { status: "open" },
);

crons.interval(
  "advance review queues",
  { seconds: 5 },
  internal.reviewQueueAutomation.dispatch,
  {},
);

crons.interval(
  "staff published review panels",
  { seconds: 5 },
  internal.reviewStaffing.dispatch,
  {
    status: "published",
  },
);
crons.interval(
  "staff open review panels",
  { seconds: 5 },
  internal.reviewStaffing.dispatch,
  {
    status: "open",
  },
);

crons.interval(
  "check reviewer venue absences",
  { seconds: 30 },
  internal.reviewerVenueEscalation.sweep,
  {},
);

crons.interval(
  "repair permission grant lifecycle",
  { seconds: 15 },
  internal.permissionGrantLifecycle.sweep,
  {},
);

crons.interval(
  "expire unfinished admission review claims",
  { seconds: 30 },
  internal.admissions.expireReviewAssignments,
  {},
);

crons.interval(
  "recover orphaned admission analyses",
  { minutes: 1 },
  internal.admissionIntelligence.recoverOrphanedAgentRecommendations,
  { cursor: null },
);

/** Thirty-second sweeps surface empty seats promptly and require three clear passes. */
crons.interval(
  "sweep review operations attention",
  { seconds: 30 },
  internal.operationsAttentionSweep.sweepReviewDomain,
  {},
);

crons.interval(
  "refresh operations health snapshot",
  { seconds: 30 },
  internal.operationsHealth.refresh,
  {},
);

crons.interval(
  "evaluate and monitor autonomous operations",
  { seconds: 5 },
  internal.operationsAutonomyActions.tick,
  {},
);

export default crons;
