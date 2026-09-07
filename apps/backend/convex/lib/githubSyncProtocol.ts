import {
  githubSyncMaximumRetryAfterMs,
  githubSyncProtocolVersion,
  githubWebhookProtocolVersion,
} from "@code2create/domain";
import { z } from "zod";

const identifier = z.string().regex(/^\d{1,20}$/u);
const sha = z.string().min(1).max(100);
const count = z.number().int().min(0);

export const githubRepositoryObservationSchema = z
  .object({
    repositoryId: identifier,
    owner: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    fullName: z.string().min(1).max(300),
    url: z.url().max(2_000),
    isPrivate: z.boolean(),
    isFork: z.boolean(),
    defaultBranch: z.string().min(1).max(500),
    topicState: z.enum(["present", "missing"]),
    headSha: sha,
    providerCommitAt: z.number().int().min(0).optional(),
    commitCount: count,
    additions: count,
    deletions: count,
    changedFiles: count,
    observedCommitShas: z.array(sha).max(100),
    commitIdentityComplete: z.boolean(),
    languageBytes: z
      .array(z.object({ language: z.string().min(1).max(100), bytes: count }).strict())
      .max(200),
    completeness: z.enum(["complete", "partial", "unknown"]),
    compareTruncated: z.boolean(),
  })
  .strict();

const callbackIdentity = {
  protocolVersion: z.literal(githubSyncProtocolVersion),
  bindingId: z.string().min(1).max(200),
  syncRevision: z.number().int().min(1),
  completedAt: z.number().int().min(0),
};

export const githubRepositorySyncCallbackSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...callbackIdentity,
      status: z.literal("succeeded"),
      observation: githubRepositoryObservationSchema,
    })
    .strict(),
  z
    .object({
      ...callbackIdentity,
      status: z.literal("rate_limited"),
      errorCode: z.literal("github_rate_limited"),
      retryAfterMs: z.number().int().min(0).max(githubSyncMaximumRetryAfterMs),
    })
    .strict(),
  z
    .object({
      ...callbackIdentity,
      status: z.literal("failed"),
      errorCode: z
        .string()
        .regex(/^(github_[a-z0-9_]{1,40}|repository_id_mismatch)$/u),
    })
    .strict(),
]);

export type GithubRepositorySyncCallbackInput = z.infer<typeof githubRepositorySyncCallbackSchema>;

const webhookEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("push"),
      installationId: identifier,
      repositoryId: identifier,
      ref: z.string().min(1).max(1_024),
      beforeSha: sha,
      afterSha: sha,
      created: z.boolean(),
      deleted: z.boolean(),
      forced: z.boolean(),
      pushedCommitCount: z.number().int().min(0).max(2_048),
      providerAt: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("installation"),
      installationId: identifier,
      action: z.string().min(1).max(80),
    })
    .strict(),
  z
    .object({
      kind: z.literal("installation_repositories"),
      installationId: identifier,
      action: z.string().min(1).max(80),
      addedRepositoryIds: z.array(identifier).max(500),
      removedRepositoryIds: z.array(identifier).max(500),
    })
    .strict(),
  z.object({ kind: z.literal("ping") }).strict(),
]);

export const githubWebhookCallbackSchema = z
  .object({
    protocolVersion: z.literal(githubWebhookProtocolVersion),
    deliveryId: z.string().min(1).max(100),
    eventName: z.string().min(1).max(80),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
    event: webhookEventSchema,
  })
  .strict();

export type GithubWebhookCallbackInput = z.infer<typeof githubWebhookCallbackSchema>;
