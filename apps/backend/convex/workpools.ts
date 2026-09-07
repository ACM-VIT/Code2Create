import { Workpool } from "@convex-dev/workpool";

import { components } from "./_generated/api";

export const admissionWorkpool = new Workpool(components.admissionWorkpool, {
  // Recommendations are advisory and may trail submission, but the full
  // applicant cohort must drain before human review starts.
  maxParallelism: 16,
  retryActionsByDefault: false,
  defaultRetryBehavior: {
    maxAttempts: 2,
    initialBackoffMs: 1_500,
    base: 2,
  },
});

export const exportWorkpool = new Workpool(components.exportWorkpool, {
  maxParallelism: 2,
  retryActionsByDefault: true,
  defaultRetryBehavior: {
    maxAttempts: 3,
    initialBackoffMs: 2_000,
    base: 2,
  },
});

export const intelligenceWorkpool = new Workpool(components.intelligenceWorkpool, {
  maxParallelism: 2,
  retryActionsByDefault: true,
  defaultRetryBehavior: {
    maxAttempts: 3,
    initialBackoffMs: 2_000,
    base: 2,
  },
});
