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
