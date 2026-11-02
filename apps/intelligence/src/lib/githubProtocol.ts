import { githubSyncProtocolVersion, type GithubWebhookEvent } from "@code2create/domain";
import * as v from "valibot";

const identifier = v.pipe(v.string(), v.regex(/^\d{1,20}$/u));
const sha = v.pipe(v.string(), v.minLength(1), v.maxLength(100));
const text = (max: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(max));

export const githubSyncRequestSchema = v.strictObject({
  protocolVersion: v.literal(githubSyncProtocolVersion),
  bindingId: text(200),
  syncRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  installationId: identifier,
  repositoryId: identifier,
  owner: text(100),
  name: text(200),
  trackedBranch: text(500),
  rootPath: v.optional(text(500)),
  baselineSha: sha,
  requiredTopic: v.pipe(v.string(), v.maxLength(100)),
});

const providerId = v.object({ id: v.pipe(v.number(), v.integer(), v.minValue(1)) });

const githubPushPayloadSchema = v.object({
  installation: providerId,
  repository: providerId,
  ref: text(1_024),
  before: sha,
  after: sha,
  created: v.boolean(),
  deleted: v.boolean(),
  forced: v.boolean(),
  commits: v.pipe(v.array(v.object({ id: sha })), v.maxLength(2_048)),
  head_commit: v.nullish(v.object({ timestamp: text(80) })),
});

const githubInstallationPayloadSchema = v.object({
  action: text(80),
  installation: providerId,
});

const githubInstallationRepositoriesPayloadSchema = v.object({
  action: text(80),
  installation: providerId,
  repositories_added: v.pipe(v.array(providerId), v.maxLength(500)),
  repositories_removed: v.pipe(v.array(providerId), v.maxLength(500)),
});

const githubPingPayloadSchema = v.object({ zen: v.optional(v.string()) });

function providerTime(value: string | null | undefined) {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

/** Normalizes one supported provider payload; unsupported events return null. */
export function normalizedGithubWebhookEvent(
  eventName: string,
  payload: unknown,
): GithubWebhookEvent | null | "invalid" {
  if (eventName === "push") {
    const parsed = v.safeParse(githubPushPayloadSchema, payload);
    if (!parsed.success) return "invalid";
    const providerAt = providerTime(parsed.output.head_commit?.timestamp);
    return {
      kind: "push",
      installationId: String(parsed.output.installation.id),
      repositoryId: String(parsed.output.repository.id),
      ref: parsed.output.ref,
      beforeSha: parsed.output.before,
      afterSha: parsed.output.after,
      created: parsed.output.created,
      deleted: parsed.output.deleted,
      forced: parsed.output.forced,
      pushedCommitCount: parsed.output.commits.length,
      ...(providerAt === undefined ? {} : { providerAt }),
    };
  }
  if (eventName === "installation") {
    const parsed = v.safeParse(githubInstallationPayloadSchema, payload);
    if (!parsed.success) return "invalid";
    return {
      kind: "installation",
      installationId: String(parsed.output.installation.id),
      action: parsed.output.action,
    };
  }
  if (eventName === "installation_repositories") {
    const parsed = v.safeParse(githubInstallationRepositoriesPayloadSchema, payload);
    if (!parsed.success) return "invalid";
    return {
      kind: "installation_repositories",
      installationId: String(parsed.output.installation.id),
      action: parsed.output.action,
      addedRepositoryIds: parsed.output.repositories_added.map((item) => String(item.id)),
      removedRepositoryIds: parsed.output.repositories_removed.map((item) => String(item.id)),
    };
  }
  if (eventName === "ping") {
    return v.safeParse(githubPingPayloadSchema, payload).success ? { kind: "ping" } : "invalid";
  }
  return null;
}
