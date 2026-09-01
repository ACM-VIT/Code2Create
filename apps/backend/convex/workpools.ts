import { Workpool } from "@convex-dev/workpool";

import { components } from "./_generated/api";

export const intakeWorkpool = new Workpool(components.intakeWorkpool, {
  // Participant question generation is latency-sensitive and independent per
  // team. Keep enough slots to absorb an application-round burst while the
  // provider timeout still places a hard upper bound on concurrent work.
  maxParallelism: 32,
  retryActionsByDefault: false,
  defaultRetryBehavior: {
    maxAttempts: 2,
    initialBackoffMs: 750,
    base: 2,
  },
});

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

export const integrationWorkpool = new Workpool(components.integrationWorkpool, {
  maxParallelism: 6,
  retryActionsByDefault: false,
  defaultRetryBehavior: {
    maxAttempts: 2,
    initialBackoffMs: 2_000,
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
