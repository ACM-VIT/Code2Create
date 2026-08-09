import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "dispatch Figma metadata checks",
  { seconds: 15 },
  internal.figmaIntegrations.dispatchMetadataChecks,
  {},
);

crons.interval(
  "repair permission grant lifecycle",
  { seconds: 15 },
  internal.permissionGrantLifecycle.sweep,
  {},
);

/**
 * The deterministic attention ledger. Thirty seconds is fast enough that an
 * empty seat reaches the desk before the queue behind it notices, and slow
 * enough that the clear delay still takes three passes to resolve a flapping
 * condition.
 */
crons.interval(
  "sweep review operations attention",
  { seconds: 30 },
  internal.operationsAttentionSweep.sweepReviewDomain,
  {},
);

crons.interval(
  "evaluate proactive operations intelligence",
  { minutes: 1 },
  internal.operationsIntelligenceAutomation.evaluateDue,
  {},
);

export default crons;
