/**
 * GitHub provider work runs in the intelligence Worker. Convex remains the
 * authority for repository bindings, metrics, and snapshots; it signals one
 * repository reconciliation at a time and applies the signed result once per
 * `syncRevision`. GitHub webhooks arrive at the Worker, which verifies the
 * provider signature and forwards one normalized event per delivery.
 */
export const githubSyncProtocolVersion = "github-sync-v1";
export const githubSyncIngressContext = "c2c:github-sync:request:v1";
export const githubSyncCallbackContext = "c2c:github-sync:callback:v1";
export const githubWebhookProtocolVersion = "github-webhook-v1";
export const githubWebhookCallbackContext = "c2c:github-webhook:callback:v1";
export const githubServiceSignatureMaximumAgeMs = 300_000;
/** Longest pause the backend honours before retrying a rate-limited repository. */
export const githubSyncMaximumRetryAfterMs = 30 * 60_000;

export type GithubRepositorySyncRequest = {
  protocolVersion: typeof githubSyncProtocolVersion;
  bindingId: string;
  syncRevision: number;
  installationId: string;
  repositoryId: string;
  owner: string;
  name: string;
  trackedBranch: string;
  rootPath?: string;
  baselineSha: string;
  requiredTopic: string;
};

export type GithubLanguageBytes = { language: string; bytes: number };

export type GithubRepositoryObservation = {
  repositoryId: string;
  owner: string;
  name: string;
  fullName: string;
  url: string;
  isPrivate: boolean;
  isFork: boolean;
  defaultBranch: string;
  topicState: "present" | "missing";
  headSha: string;
  providerCommitAt?: number;
  commitCount: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  observedCommitShas: string[];
  commitIdentityComplete: boolean;
  languageBytes: GithubLanguageBytes[];
  completeness: "complete" | "partial" | "unknown";
  compareTruncated: boolean;
};

export type GithubRepositorySyncFailureCode =
  | "github_rate_limited"
  | "github_access_denied"
  | "github_not_found"
  | "github_unavailable"
  | "github_request_failed"
  | "github_response_invalid"
  | "repository_id_mismatch"
  | `github_http_${number}`;

export type GithubRepositorySyncCallback = {
  protocolVersion: typeof githubSyncProtocolVersion;
  bindingId: string;
  syncRevision: number;
  completedAt: number;
} & (
  | { status: "succeeded"; observation: GithubRepositoryObservation }
  | { status: "rate_limited"; errorCode: "github_rate_limited"; retryAfterMs: number }
  | { status: "failed"; errorCode: Exclude<GithubRepositorySyncFailureCode, "github_rate_limited"> }
);

export type GithubRepositorySyncReceipt = { state: "accepted" | "already_settled" | "stale" };

export type GithubWebhookEvent =
  | {
      kind: "push";
      installationId: string;
      repositoryId: string;
      ref: string;
      beforeSha: string;
      afterSha: string;
      created: boolean;
      deleted: boolean;
      forced: boolean;
      pushedCommitCount: number;
      providerAt?: number;
    }
  | { kind: "installation"; installationId: string; action: string }
  | {
      kind: "installation_repositories";
      installationId: string;
      action: string;
      addedRepositoryIds: string[];
      removedRepositoryIds: string[];
    }
  | { kind: "ping" };

export type GithubWebhookCallback = {
  protocolVersion: typeof githubWebhookProtocolVersion;
  deliveryId: string;
  eventName: string;
  payloadHash: string;
  event: GithubWebhookEvent;
};

export type GithubWebhookReceipt = { state: "accepted" | "ignored" | "duplicate" };
