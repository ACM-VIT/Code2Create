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

crons.interval(
  "evaluate proactive operations intelligence",
  { minutes: 1 },
  internal.operationsIntelligenceAutomation.evaluateDue,
  {},
);

export default crons;
