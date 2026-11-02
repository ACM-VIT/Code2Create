import {
  githubSyncMaximumRetryAfterMs,
  githubSyncProtocolVersion,
  type GithubRepositoryObservation,
  type GithubRepositorySyncCallback,
  type GithubRepositorySyncFailureCode,
  type GithubRepositorySyncRequest,
} from "@code2create/domain";
import * as v from "valibot";

import {
  GithubProviderError,
  GithubResponseInvalidError,
  repositoryInstallationRequester,
  type GithubAppConfiguration,
  type GithubRequester,
} from "./githubApp.ts";

const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const sha = v.pipe(v.string(), v.minLength(1), v.maxLength(100));
const repositorySchema = v.object({
  id: v.pipe(v.number(), v.integer(), v.minValue(1)),
  name: v.pipe(v.string(), v.minLength(1)),
  full_name: v.pipe(v.string(), v.minLength(1)),
  html_url: v.pipe(v.string(), v.url()),
  private: v.boolean(),
  fork: v.boolean(),
  default_branch: v.pipe(v.string(), v.minLength(1)),
  owner: v.object({ login: v.pipe(v.string(), v.minLength(1)) }),
});
const topicsSchema = v.object({ names: v.array(v.string()) });
const languagesSchema = v.record(v.string(), count);
const branchSchema = v.object({
  commit: v.object({
    sha,
    commit: v.object({
      committer: v.nullish(v.object({ date: v.nullish(v.string()) })),
      author: v.nullish(v.object({ date: v.nullish(v.string()) })),
    }),
  }),
});
const comparisonSchema = v.object({
  total_commits: count,
  commits: v.array(v.object({ sha })),
  files: v.optional(
    v.array(v.object({ filename: v.string(), additions: count, deletions: count })),
  ),
});

function parsed<TSchema extends v.GenericSchema>(schema: TSchema, value: unknown, label: string) {
  const result = v.safeParse(schema, value);
  if (!result.success) throw new GithubResponseInvalidError(label);
  return result.output;
}

function providerTime(value: string | null | undefined) {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function encodedPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Reads one repository at its tracked head and compares it with the baseline commit. */
async function observeRepository(
  request: GithubRepositorySyncRequest,
  requester: GithubRequester,
): Promise<GithubRepositoryObservation> {
  const owner = encodeURIComponent(request.owner);
  const name = encodeURIComponent(request.name);
  const [repository, topics, languages, branch] = await Promise.all([
    requester(`/repos/${owner}/${name}`).then((r) => parsed(repositorySchema, r.value, "repository")),
    requester(`/repos/${owner}/${name}/topics`).then((r) => parsed(topicsSchema, r.value, "topic list")),
    requester(`/repos/${owner}/${name}/languages`).then((r) =>
      parsed(languagesSchema, r.value, "language list"),
    ),
    requester(`/repos/${owner}/${name}/branches/${encodeURIComponent(request.trackedBranch)}`).then(
      (r) => parsed(branchSchema, r.value, "branch"),
    ),
  ]);
  if (String(repository.id) !== request.repositoryId) {
    throw new GithubResponseInvalidError("repository identity");
  }
  const repositoryOwner = encodeURIComponent(repository.owner.login);
  const repositoryName = encodeURIComponent(repository.name);
  const headSha = branch.commit.sha;
  if (request.rootPath !== undefined) {
    await requester(
      `/repos/${repositoryOwner}/${repositoryName}/contents/${encodedPath(request.rootPath)}?ref=${encodeURIComponent(headSha)}`,
    );
  }
  let commitCount = 0;
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;
  let compareTruncated = false;
  let observedCommitShas: string[] = [];
  let commitIdentityComplete = true;
  let completeness: GithubRepositoryObservation["completeness"] = "complete";
  if (headSha !== request.baselineSha) {
    const comparison = parsed(
      comparisonSchema,
      (
        await requester(
          `/repos/${repositoryOwner}/${repositoryName}/compare/${encodeURIComponent(request.baselineSha)}...${encodeURIComponent(headSha)}?per_page=100&page=1`,
        )
      ).value,
      "comparison",
    );
    commitCount = comparison.total_commits;
    const files = comparison.files ?? [];
    const rootPath = request.rootPath;
    const relevantFiles =
      rootPath === undefined
        ? files
        : files.filter(
            (file) => file.filename === rootPath || file.filename.startsWith(`${rootPath}/`),
          );
    additions = relevantFiles.reduce((total, file) => total + file.additions, 0);
    deletions = relevantFiles.reduce((total, file) => total + file.deletions, 0);
    changedFiles = relevantFiles.length;
    compareTruncated = files.length >= 300;
    const returnedCommitShas = comparison.commits.map((commit) => commit.sha);
    observedCommitShas = rootPath === undefined ? returnedCommitShas : [];
    commitIdentityComplete =
      commitCount === 0 || (rootPath === undefined && returnedCommitShas.length === commitCount);
    if (compareTruncated || rootPath !== undefined || !commitIdentityComplete) {
      completeness = "partial";
    }
  }
  const providerCommitAt = providerTime(
    branch.commit.commit.committer?.date ?? branch.commit.commit.author?.date,
  );
  return {
    repositoryId: String(repository.id),
    owner: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
    url: repository.html_url,
    isPrivate: repository.private,
    isFork: repository.fork,
    defaultBranch: repository.default_branch,
    topicState:
      request.requiredTopic.length > 0 && topics.names.includes(request.requiredTopic)
        ? "present"
        : "missing",
    headSha,
    ...(providerCommitAt === undefined ? {} : { providerCommitAt }),
    commitCount,
    additions,
    deletions,
    changedFiles,
    observedCommitShas,
    commitIdentityComplete,
    languageBytes: Object.entries(languages)
      .map(([language, bytes]) => ({ language, bytes }))
      .sort((left, right) => right.bytes - left.bytes),
    completeness,
    compareTruncated,
  };
}

type SyncFailure =
  | { status: "rate_limited"; errorCode: "github_rate_limited"; retryAfterMs: number }
  | {
      status: "failed";
      errorCode: Exclude<GithubRepositorySyncFailureCode, "github_rate_limited">;
    };

function failure(error: unknown): SyncFailure {
  if (error instanceof GithubProviderError) {
    if (error.retryAfterMs !== undefined) {
      return {
        status: "rate_limited",
        errorCode: "github_rate_limited",
        retryAfterMs: Math.min(error.retryAfterMs, githubSyncMaximumRetryAfterMs),
      };
    }
    if (error.status === 401 || error.status === 403) {
      return { status: "failed", errorCode: "github_access_denied" };
    }
    if (error.status === 404) return { status: "failed", errorCode: "github_not_found" };
    if (error.status >= 500) return { status: "failed", errorCode: "github_unavailable" };
    return { status: "failed", errorCode: `github_http_${error.status}` };
  }
  if (error instanceof GithubResponseInvalidError) {
    return {
      status: "failed",
      errorCode:
        error.message === "GitHub returned an invalid repository identity."
          ? "repository_id_mismatch"
          : "github_response_invalid",
    };
  }
  return { status: "failed", errorCode: "github_request_failed" };
}

/** Produces the signed settlement Convex applies exactly once per sync revision. */
export async function reconcileRepository(
  request: GithubRepositorySyncRequest,
  configuration: GithubAppConfiguration,
  fetcher: typeof fetch,
  now = () => Date.now(),
): Promise<GithubRepositorySyncCallback> {
  const identity = {
    protocolVersion: githubSyncProtocolVersion,
    bindingId: request.bindingId,
    syncRevision: request.syncRevision,
  } as const;
  try {
    const requester = await repositoryInstallationRequester(
      configuration,
      request.installationId,
      request.repositoryId,
      fetcher,
    );
    const observation = await observeRepository(request, requester);
    return { ...identity, completedAt: now(), status: "succeeded", observation };
  } catch (error) {
    return { ...identity, completedAt: now(), ...failure(error) };
  }
}
