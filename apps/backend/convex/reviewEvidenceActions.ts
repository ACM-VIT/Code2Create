"use node";

import { ConvexError, v } from "convex/values";
import { RequestError } from "octokit";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action } from "./_generated/server";
import { repositoryOctokit } from "./lib/githubClient";

const maximumDirectoryEntries = 500;
const maximumTextFileBytes = 256 * 1024;

type GitHubAccessContext = {
  installationId: string;
  repositoryId: string;
  owner: string;
  name: string;
  headSha: string;
  rootPath?: string;
};

type GithubBrowseResult =
  | {
      kind: "directory";
      path: string;
      entries: Array<{
        name: string;
        path: string;
        type: "file" | "directory" | "symlink" | "submodule";
        sha: string;
        size: number;
      }>;
      truncated: boolean;
    }
  | {
      kind: "text_file";
      name: string;
      path: string;
      sha: string;
      size: number;
      text: string;
    }
  | {
      kind: "metadata_only";
      name: string;
      path: string;
      type: string;
      sha: string;
      size: number;
      reason: "binary" | "too_large" | "content_unavailable";
    };

const githubContentEntry = z.object({
  type: z.enum(["file", "dir", "symlink", "submodule"]),
  name: z.string().min(1).max(1_024),
  path: z.string().max(4_096),
  sha: z.string().min(1).max(128),
  size: z
    .number()
    .int()
    .nonnegative()
    .max(100 * 1024 * 1024),
  encoding: z.string().max(32).optional(),
  content: z
    .string()
    .max(2 * 1024 * 1024)
    .optional(),
});

const githubContentResponse = z.union([z.array(githubContentEntry).max(1_000), githubContentEntry,
]);

const githubBrowseResult = v.union(
  v.object({
    kind: v.literal("directory"),
    path: v.string(),
    entries: v.array(
      v.object({
        name: v.string(),
        path: v.string(),
        type: v.union(
          v.literal("file"),
          v.literal("directory"),
          v.literal("symlink"),
          v.literal("submodule"),
        ),
        sha: v.string(),
        size: v.number(),
      }),
    ),
    truncated: v.boolean(),
  }),
  v.object({
    kind: v.literal("text_file"),
    name: v.string(),
    path: v.string(),
    sha: v.string(),
    size: v.number(),
    text: v.string(),
  }),
  v.object({
    kind: v.literal("metadata_only"),
    name: v.string(),
    path: v.string(),
    type: v.string(),
    sha: v.string(),
    size: v.number(),
    reason: v.union(v.literal("binary"), v.literal("too_large"), v.literal("content_unavailable"),
    ),
  }),
);

function relativePath(value: string) {
  const path = value.trim().replaceAll("\\", "/");
  if (path === "") return "";
  if (path.length > 512 || path.startsWith("/") || path.endsWith("/")) {
    throw new ConvexError({
      code: "GITHUB_PATH_INVALID",
      message: "Choose a repository path from the pinned file browser.",
    });
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..",
    )) {
    throw new ConvexError({
      code: "GITHUB_PATH_INVALID",
      message: "Choose a repository path from the pinned file browser.",
    });
  }
  return segments.join("/");
}

function providerPath(rootPath: string | undefined, selectedPath: string) {
  const root = rootPath === undefined ? "" : relativePath(rootPath);
  const selected = relativePath(selectedPath);
  if (!root) return selected;
  if (!selected) return root;
  return `${root}/${selected}`;
}

function checkpointPath(rootPath: string | undefined, path: string) {
  const root = rootPath === undefined ? "" : relativePath(rootPath);
  if (!root) return path;
  if (path === root) return "";
  const prefix = `${root}/`;
  if (!path.startsWith(prefix)) {
    throw new Error("GitHub returned a path outside the fixed repository root.",
    );
  }
  return path.slice(prefix.length);
}

function githubError(error: unknown) {
  if (error instanceof RequestError) {
    if (error.status === 404) {
      return new ConvexError({
        code: "GITHUB_PATH_UNAVAILABLE",
        message: "That path is unavailable at the pinned commit.",
      });
    }
    if (error.status === 401 || error.status === 403) {
      return new ConvexError({
        code: "GITHUB_ACCESS_UNAVAILABLE",
        message: "GitHub no longer permits the App to read this pinned repository.",
      });
    }
    if (error.status === 429 || error.status >= 500) {
      return new ConvexError({
        code: "GITHUB_TEMPORARILY_UNAVAILABLE",
        message: "GitHub is temporarily unavailable. The fixed snapshot metadata is unchanged.",
      });
    }
  }
  return new ConvexError({
    code: "GITHUB_CONTENT_UNAVAILABLE",
    message: "The pinned repository content could not be loaded.",
  });
}

function directoryType(value: z.infer<typeof githubContentEntry>["type"]) {
  return value === "dir" ? ("directory" as const) : value;
}

function decodeTextFile(content: string) {
  const compact = content.replaceAll(/\s/gu, "");
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)) {
    return null;
  }
  const bytes = Buffer.from(compact, "base64");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export async function readPinnedGithubPath(
  context: GitHubAccessContext,
  requestedRelativePath: string,
  signal?: AbortSignal,
): Promise<GithubBrowseResult> {
  const requestedPath = providerPath(context.rootPath, requestedRelativePath);
    let decoded: unknown;
    try {
      const octokit = await repositoryOctokit(context.installationId, context.repositoryId,
    );
      const response = await octokit.rest.repos.getContent({
        owner: context.owner,
        repo: context.name,
        path: requestedPath,
        ref: context.headSha,
      ...(signal ? { request: { signal } } : {}),
      });
      decoded = response.data;
    } catch (error) {
      throw githubError(error);
    }
    const parsed = githubContentResponse.safeParse(decoded);
    if (!parsed.success) {
      throw new ConvexError({
        code: "GITHUB_RESPONSE_INVALID",
        message: "GitHub returned an unsupported response for this pinned path.",
      });
    }
    if (Array.isArray(parsed.data)) {
      const sorted = parsed.data.toSorted(
        (left, right) =>
          Number(right.type === "dir") - Number(left.type === "dir") ||
          left.name.localeCompare(right.name),
      );
      return {
        kind: "directory",
        path: relativePath(requestedRelativePath),
        entries: sorted.slice(0, maximumDirectoryEntries).map((entry) => ({
          name: entry.name,
          path: checkpointPath(context.rootPath, entry.path),
          type: directoryType(entry.type),
          sha: entry.sha,
          size: entry.size,
        })),
        truncated: sorted.length > maximumDirectoryEntries || sorted.length === 1_000,
      };
    }
    const entry = parsed.data;
    const path = checkpointPath(context.rootPath, entry.path);
    if (entry.type !== "file" || entry.size > maximumTextFileBytes) {
      return {
        kind: "metadata_only",
        name: entry.name,
        path,
        type: directoryType(entry.type),
        sha: entry.sha,
        size: entry.size,
        reason: entry.size > maximumTextFileBytes ? "too_large" : "content_unavailable",
      };
    }
    if (entry.encoding !== "base64" || entry.content === undefined) {
      return {
        kind: "metadata_only",
        name: entry.name,
        path,
        type: entry.type,
        sha: entry.sha,
        size: entry.size,
        reason: "content_unavailable",
      };
    }
    const text = decodeTextFile(entry.content);
    if (text === null) {
      return {
        kind: "metadata_only",
        name: entry.name,
        path,
        type: entry.type,
        sha: entry.sha,
        size: entry.size,
        reason: "binary",
      };
    }
    return {
      kind: "text_file",
      name: entry.name,
      path,
      sha: entry.sha,
      size: entry.size,
      text,
    };
}

export const browseGithub = action({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    bindingId: v.id("githubRepositoryBindings"),
    path: v.string(),
  },
  returns: githubBrowseResult,
  handler: async (
    ctx: ActionCtx,
    args: {
      eventSlug: string;
      reviewSessionId: Id<"reviewSessions">;
      bindingId: Id<"githubRepositoryBindings">;
      path: string;
    },
  ): Promise<GithubBrowseResult> => {
    const context: GitHubAccessContext = await ctx.runQuery(
      internal.reviewEvidence.githubAccessContext,
      {
        eventSlug: args.eventSlug,
        reviewSessionId: args.reviewSessionId,
        bindingId: args.bindingId,
      },
    );
    return readPinnedGithubPath(context, args.path);
  },
});
