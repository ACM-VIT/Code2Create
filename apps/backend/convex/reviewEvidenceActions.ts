"use node";

import { ConvexError, v } from "convex/values";
import { RequestError } from "octokit";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action } from "./_generated/server";
import {
  readStoredArtifactText,
  signArtifactDownload,
  signFigmaPreview,
} from "./lib/artifactStorage";
import {
  browseFigmaEvidence,
  FigmaEvidenceBrowseError,
  type FigmaEvidenceBrowserPage,
} from "./lib/figmaEvidenceBrowser";
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

type FigmaAccessContext = {
  artifactId: Id<"integrationArtifacts">;
  snapshotId: Id<"figmaFileSnapshots">;
  objectKey: string;
  storageRegion: string;
  storageBucket: string;
  storedBytes: number;
  uncompressedBytes: number;
  sha256: string;
  capturedAt: number;
  providerVersionId: string;
};

type FigmaPreviewListResult = {
  providerVersionId: string;
  previewSetId: Id<"figmaPreviewSets">;
  state: "pending" | "running" | "ready" | "partial" | "rate_limited" | "failed";
  discoveredNodeCount: number;
  selectedNodeCount: number;
  availableCount: number;
  failedCount: number;
  truncated: boolean;
  capturedAt: number;
  facts: Array<{
    id: Id<"figmaNodeFacts">;
    pageId: string;
    pageName: string;
    pageOrder: number;
    nodeId: string;
    nodeName: string;
    nodeType: string;
    nodeOrder: number;
    descendantCount: number;
    changeState: "new" | "changed" | "unchanged" | "unknown";
    renderState: "pending" | "available" | "failed";
    width?: number;
    height?: number;
  }>;
};

type FigmaArtifactResult = {
  url: string;
  expiresAt: number;
  serverNow: number;
  sha256: string;
  capturedAt: number;
  providerVersionId: string;
};

type FigmaBrowseResult = FigmaEvidenceBrowserPage & {
  capturedAt: number;
  providerVersionId: string;
};

type FigmaPreviewAccessContext = {
  factId: Id<"figmaNodeFacts">;
  snapshotId: Id<"figmaFileSnapshots">;
  previewSetId: Id<"figmaPreviewSets">;
  objectKey: string;
  storageRegion: string;
  storageBucket: string;
  byteCount: number;
  sha256: string;
  width: number;
  height: number;
  nodeName: string;
  capturedAt: number;
  providerVersionId: string;
};

type FigmaPreviewResult = {
  url: string;
  expiresAt: number;
  serverNow: number;
  sha256: string;
  width: number;
  height: number;
  nodeName: string;
  capturedAt: number;
  providerVersionId: string;
};

type FigmaActivityResult = {
  providerVersionId: string;
  capturedAt: number;
  versionCount: number;
  capturedVersionCount: number;
  versionsComplete: boolean;
  commentCount: number;
  capturedCommentCount: number;
  commentsComplete: boolean;
  replyCount: number;
  resolvedThreadCount: number;
  unresolvedThreadCount: number;
  versions: Array<{
    versionId: string;
    label: string;
    description: string;
    descriptionTruncated: boolean;
    userHandle: string;
    providerCreatedAt: number;
  }>;
  comments: Array<{
    commentId: string;
    parentCommentId?: string;
    userHandle: string;
    message: string;
    messageTruncated: boolean;
    providerCreatedAt: number;
    resolvedAt?: number;
    orderId?: number;
    reactionCount: number;
  }>;
};

type FigmaComparisonResult = {
  current: {
    checkpointSetId: Id<"reviewEvidenceCheckpointSets">;
    snapshotId: Id<"figmaFileSnapshots">;
    providerVersionId: string;
    capturedAt: number;
    truncated: boolean;
  };
  previous: {
    checkpointSetId: Id<"reviewEvidenceCheckpointSets">;
    snapshotId?: Id<"figmaFileSnapshots">;
    providerVersionId?: string;
    capturedAt: number;
    truncated: boolean;
  };
  counts: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
    uncertain: number;
  };
  rows: Array<{
    nodeId: string;
    nodeName: string;
    nodeType: string;
    pageName: string;
    state: "added" | "removed" | "changed" | "unchanged" | "uncertain";
    currentFactId?: Id<"figmaNodeFacts">;
    currentRenderState?: "pending" | "available" | "failed";
    previousFactId?: Id<"figmaNodeFacts">;
    previousRenderState?: "pending" | "available" | "failed";
  }>;
};

type FigmaComparisonPreviewResult = {
  current?: FigmaPreviewResult;
  previous?: FigmaPreviewResult;
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

const githubContentResponse = z.union([z.array(githubContentEntry).max(1_000), githubContentEntry]);

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
    reason: v.union(v.literal("binary"), v.literal("too_large"), v.literal("content_unavailable")),
  }),
);

const figmaPreviewListResult = v.object({
  previewSetId: v.id("figmaPreviewSets"),
  providerVersionId: v.string(),
  state: v.union(
    v.literal("pending"),
    v.literal("running"),
    v.literal("ready"),
    v.literal("partial"),
    v.literal("rate_limited"),
    v.literal("failed"),
  ),
  discoveredNodeCount: v.number(),
  selectedNodeCount: v.number(),
  availableCount: v.number(),
  failedCount: v.number(),
  truncated: v.boolean(),
  capturedAt: v.number(),
  facts: v.array(
    v.object({
      id: v.id("figmaNodeFacts"),
      pageId: v.string(),
      pageName: v.string(),
      pageOrder: v.number(),
      nodeId: v.string(),
      nodeName: v.string(),
      nodeType: v.string(),
      nodeOrder: v.number(),
      descendantCount: v.number(),
      changeState: v.union(
        v.literal("new"),
        v.literal("changed"),
        v.literal("unchanged"),
        v.literal("unknown"),
      ),
      renderState: v.union(v.literal("pending"), v.literal("available"), v.literal("failed")),
      width: v.optional(v.number()),
      height: v.optional(v.number()),
    }),
  ),
});

const figmaActivityResult = v.object({
  providerVersionId: v.string(),
  capturedAt: v.number(),
  versionCount: v.number(),
  capturedVersionCount: v.number(),
  versionsComplete: v.boolean(),
  commentCount: v.number(),
  capturedCommentCount: v.number(),
  commentsComplete: v.boolean(),
  replyCount: v.number(),
  resolvedThreadCount: v.number(),
  unresolvedThreadCount: v.number(),
  versions: v.array(
    v.object({
      versionId: v.string(),
      label: v.string(),
      description: v.string(),
      descriptionTruncated: v.boolean(),
      userHandle: v.string(),
      providerCreatedAt: v.number(),
    }),
  ),
  comments: v.array(
    v.object({
      commentId: v.string(),
      parentCommentId: v.optional(v.string()),
      userHandle: v.string(),
      message: v.string(),
      messageTruncated: v.boolean(),
      providerCreatedAt: v.number(),
      resolvedAt: v.optional(v.number()),
      orderId: v.optional(v.number()),
      reactionCount: v.number(),
    }),
  ),
});

const previewState = v.union(v.literal("pending"), v.literal("available"), v.literal("failed"));

const figmaComparisonResult = v.object({
  current: v.object({
    checkpointSetId: v.id("reviewEvidenceCheckpointSets"),
    snapshotId: v.id("figmaFileSnapshots"),
    providerVersionId: v.string(),
    capturedAt: v.number(),
    truncated: v.boolean(),
  }),
  previous: v.object({
    checkpointSetId: v.id("reviewEvidenceCheckpointSets"),
    snapshotId: v.optional(v.id("figmaFileSnapshots")),
    providerVersionId: v.optional(v.string()),
    capturedAt: v.number(),
    truncated: v.boolean(),
  }),
  counts: v.object({
    added: v.number(),
    removed: v.number(),
    changed: v.number(),
    unchanged: v.number(),
    uncertain: v.number(),
  }),
  rows: v.array(
    v.object({
      nodeId: v.string(),
      nodeName: v.string(),
      nodeType: v.string(),
      pageName: v.string(),
      state: v.union(
        v.literal("added"),
        v.literal("removed"),
        v.literal("changed"),
        v.literal("unchanged"),
        v.literal("uncertain"),
      ),
      currentFactId: v.optional(v.id("figmaNodeFacts")),
      currentRenderState: v.optional(previewState),
      previousFactId: v.optional(v.id("figmaNodeFacts")),
      previousRenderState: v.optional(previewState),
    }),
  ),
});

const figmaPreviewResult = v.object({
  url: v.string(),
  expiresAt: v.number(),
  serverNow: v.number(),
  sha256: v.string(),
  width: v.number(),
  height: v.number(),
  nodeName: v.string(),
  capturedAt: v.number(),
  providerVersionId: v.string(),
});

const figmaNodeSummary = v.object({
  id: v.string(),
  name: v.string(),
  type: v.string(),
  visible: v.boolean(),
  childCount: v.number(),
  interactionCount: v.number(),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
  layoutMode: v.optional(v.string()),
  componentId: v.optional(v.string()),
  textPreview: v.optional(v.string()),
});

const figmaNodeDetails = v.object({
  id: v.string(),
  name: v.string(),
  type: v.string(),
  visible: v.boolean(),
  childCount: v.number(),
  interactionCount: v.number(),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
  layoutMode: v.optional(v.string()),
  componentId: v.optional(v.string()),
  textPreview: v.optional(v.string()),
  locked: v.optional(v.boolean()),
  opacity: v.optional(v.number()),
  blendMode: v.optional(v.string()),
  x: v.optional(v.number()),
  y: v.optional(v.number()),
  horizontalConstraint: v.optional(v.string()),
  verticalConstraint: v.optional(v.string()),
  horizontalSizing: v.optional(v.string()),
  verticalSizing: v.optional(v.string()),
  primaryAxisAlignment: v.optional(v.string()),
  counterAxisAlignment: v.optional(v.string()),
  itemSpacing: v.optional(v.number()),
  paddingTop: v.optional(v.number()),
  paddingRight: v.optional(v.number()),
  paddingBottom: v.optional(v.number()),
  paddingLeft: v.optional(v.number()),
  cornerRadius: v.optional(v.number()),
  strokeWeight: v.optional(v.number()),
  fillCount: v.number(),
  strokeCount: v.number(),
  effectCount: v.number(),
  annotationCount: v.number(),
  textCharacterCount: v.optional(v.number()),
  textPreviewTruncated: v.optional(v.boolean()),
  component: v.optional(
    v.object({
      nodeId: v.string(),
      name: v.optional(v.string()),
      description: v.optional(v.string()),
      key: v.optional(v.string()),
      remote: v.optional(v.boolean()),
      componentSetId: v.optional(v.string()),
    }),
  ),
  styleReferences: v.array(
    v.object({
      kind: v.string(),
      styleId: v.string(),
    }),
  ),
});

const figmaBrowseResult = v.object({
  capturedAt: v.number(),
  providerVersionId: v.string(),
  current: figmaNodeDetails,
  breadcrumbs: v.array(
    v.object({
      id: v.string(),
      name: v.string(),
      type: v.string(),
    }),
  ),
  breadcrumbsTruncated: v.boolean(),
  children: v.array(figmaNodeSummary),
  childOffset: v.number(),
  totalChildren: v.number(),
  previousOffset: v.optional(v.number()),
  nextOffset: v.optional(v.number()),
  interactions: v.array(
    v.object({
      trigger: v.string(),
      action: v.string(),
      navigation: v.optional(v.string()),
      destinationNodeId: v.optional(v.string()),
    }),
  ),
  interactionsTruncated: v.boolean(),
  flowStartingPoints: v.array(
    v.object({
      name: v.string(),
      nodeId: v.string(),
    }),
  ),
  flowStartingPointsTruncated: v.boolean(),
});

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
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
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
    throw new Error("GitHub returned a path outside the fixed repository root.");
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
    const requestedPath = providerPath(context.rootPath, args.path);
    let decoded: unknown;
    try {
      const octokit = await repositoryOctokit(context.installationId, context.repositoryId);
      const response = await octokit.rest.repos.getContent({
        owner: context.owner,
        repo: context.name,
        path: requestedPath,
        ref: context.headSha,
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
        path: relativePath(args.path),
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
  },
});

export const figmaPreviews = action({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    bindingId: v.id("figmaFileBindings"),
  },
  returns: v.union(v.null(), figmaPreviewListResult),
  handler: async (
    ctx: ActionCtx,
    args: {
      eventSlug: string;
      reviewSessionId: Id<"reviewSessions">;
      bindingId: Id<"figmaFileBindings">;
    },
  ): Promise<FigmaPreviewListResult | null> => {
    return ctx.runQuery(internal.reviewEvidence.figmaPreviewListContext, args);
  },
});

export const figmaActivity = action({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    bindingId: v.id("figmaFileBindings"),
  },
  returns: v.union(v.null(), figmaActivityResult),
  handler: async (
    ctx: ActionCtx,
    args: {
      eventSlug: string;
      reviewSessionId: Id<"reviewSessions">;
      bindingId: Id<"figmaFileBindings">;
    },
  ): Promise<FigmaActivityResult | null> => {
    return ctx.runQuery(internal.reviewEvidence.figmaActivityContext, args);
  },
});

export const figmaComparison = action({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    bindingId: v.id("figmaFileBindings"),
  },
  returns: v.union(v.null(), figmaComparisonResult),
  handler: async (
    ctx: ActionCtx,
    args: {
      eventSlug: string;
      reviewSessionId: Id<"reviewSessions">;
      bindingId: Id<"figmaFileBindings">;
    },
  ): Promise<FigmaComparisonResult | null> => {
    return ctx.runQuery(internal.reviewEvidence.figmaComparisonListContext, args);
  },
});

export const browseFigma = action({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    bindingId: v.id("figmaFileBindings"),
    nodeId: v.optional(v.string()),
    childOffset: v.number(),
  },
  returns: figmaBrowseResult,
  handler: async (
    ctx: ActionCtx,
    args: {
      eventSlug: string;
      reviewSessionId: Id<"reviewSessions">;
      bindingId: Id<"figmaFileBindings">;
      nodeId?: string;
      childOffset: number;
    },
  ): Promise<FigmaBrowseResult> => {
    const context: FigmaAccessContext = await ctx.runQuery(
      internal.reviewEvidence.figmaAccessContext,
      {
        eventSlug: args.eventSlug,
        reviewSessionId: args.reviewSessionId,
        bindingId: args.bindingId,
      },
    );
    const rawJson = await readStoredArtifactText(context);
    try {
      return {
        capturedAt: context.capturedAt,
        providerVersionId: context.providerVersionId,
        ...browseFigmaEvidence(rawJson, context.providerVersionId, args.nodeId, args.childOffset),
      };
    } catch (error) {
      if (error instanceof FigmaEvidenceBrowseError) {
        throw new ConvexError({
          code: `FIGMA_EVIDENCE_${error.code.toUpperCase()}`,
          message: error.message,
        });
      }
      throw error;
    }
  },
});

export const openFigmaArtifact = action({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    bindingId: v.id("figmaFileBindings"),
  },
  returns: v.object({
    url: v.string(),
    expiresAt: v.number(),
    serverNow: v.number(),
    sha256: v.string(),
    capturedAt: v.number(),
    providerVersionId: v.string(),
  }),
  handler: async (
    ctx: ActionCtx,
    args: {
      eventSlug: string;
      reviewSessionId: Id<"reviewSessions">;
      bindingId: Id<"figmaFileBindings">;
    },
  ): Promise<FigmaArtifactResult> => {
    const context: FigmaAccessContext = await ctx.runQuery(
      internal.reviewEvidence.figmaAccessContext,
      args,
    );
    const expiresAt = Date.now() + 60_000;
    const url = await signArtifactDownload(context);
    const access = await ctx.runMutation(internal.reviewEvidence.recordFigmaArtifactAccess, {
      ...args,
      artifactId: context.artifactId,
      snapshotId: context.snapshotId,
      expectedObjectKey: context.objectKey,
      expectedStorageRegion: context.storageRegion,
      expectedStorageBucket: context.storageBucket,
      expectedStoredBytes: context.storedBytes,
      expectedUncompressedBytes: context.uncompressedBytes,
      expectedSha256: context.sha256,
      expectedCapturedAt: context.capturedAt,
      expectedProviderVersionId: context.providerVersionId,
      signedUrlExpiresAt: expiresAt,
    });
    return {
      url,
      expiresAt,
      serverNow: access.serverNow,
      sha256: context.sha256,
      capturedAt: context.capturedAt,
      providerVersionId: context.providerVersionId,
    };
  },
});

export const openFigmaPreview = action({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    bindingId: v.id("figmaFileBindings"),
    factId: v.id("figmaNodeFacts"),
  },
  returns: v.object({
    url: v.string(),
    expiresAt: v.number(),
    serverNow: v.number(),
    sha256: v.string(),
    width: v.number(),
    height: v.number(),
    nodeName: v.string(),
    capturedAt: v.number(),
    providerVersionId: v.string(),
  }),
  handler: async (
    ctx: ActionCtx,
    args: {
      eventSlug: string;
      reviewSessionId: Id<"reviewSessions">;
      bindingId: Id<"figmaFileBindings">;
      factId: Id<"figmaNodeFacts">;
    },
  ): Promise<FigmaPreviewResult> => {
    const context: FigmaPreviewAccessContext = await ctx.runQuery(
      internal.reviewEvidence.figmaPreviewAccessContext,
      args,
    );
    const expiresAt = Date.now() + 60_000;
    const url = await signFigmaPreview(context);
    const access = await ctx.runMutation(internal.reviewEvidence.recordFigmaPreviewAccess, {
      ...args,
      expected: context,
      signedUrlExpiresAt: expiresAt,
    });
    return {
      url,
      expiresAt,
      serverNow: access.serverNow,
      sha256: context.sha256,
      width: context.width,
      height: context.height,
      nodeName: context.nodeName,
      capturedAt: context.capturedAt,
      providerVersionId: context.providerVersionId,
    };
  },
});

export const openFigmaComparison = action({
  args: {
    eventSlug: v.string(),
    reviewSessionId: v.id("reviewSessions"),
    bindingId: v.id("figmaFileBindings"),
    currentFactId: v.optional(v.id("figmaNodeFacts")),
    previousFactId: v.optional(v.id("figmaNodeFacts")),
  },
  returns: v.object({
    current: v.optional(figmaPreviewResult),
    previous: v.optional(figmaPreviewResult),
  }),
  handler: async (
    ctx: ActionCtx,
    args: {
      eventSlug: string;
      reviewSessionId: Id<"reviewSessions">;
      bindingId: Id<"figmaFileBindings">;
      currentFactId?: Id<"figmaNodeFacts">;
      previousFactId?: Id<"figmaNodeFacts">;
    },
  ): Promise<FigmaComparisonPreviewResult> => {
    const context: {
      current?: FigmaPreviewAccessContext;
      previous?: FigmaPreviewAccessContext;
    } = await ctx.runQuery(internal.reviewEvidence.figmaComparisonPreviewAccessContext, args);
    const expiresAt = Date.now() + 60_000;
    const [currentUrl, previousUrl] = await Promise.all([
      context.current ? signFigmaPreview(context.current) : Promise.resolve(null),
      context.previous ? signFigmaPreview(context.previous) : Promise.resolve(null),
    ]);
    const access = await ctx.runMutation(
      internal.reviewEvidence.recordFigmaComparisonPreviewAccess,
      {
        ...args,
        ...(context.current ? { expectedCurrent: context.current } : {}),
        ...(context.previous ? { expectedPrevious: context.previous } : {}),
        signedUrlExpiresAt: expiresAt,
      },
    );
    return {
      ...(context.current && currentUrl
        ? {
            current: {
              url: currentUrl,
              expiresAt,
              serverNow: access.serverNow,
              sha256: context.current.sha256,
              width: context.current.width,
              height: context.current.height,
              nodeName: context.current.nodeName,
              capturedAt: context.current.capturedAt,
              providerVersionId: context.current.providerVersionId,
            },
          }
        : {}),
      ...(context.previous && previousUrl
        ? {
            previous: {
              url: previousUrl,
              expiresAt,
              serverNow: access.serverNow,
              sha256: context.previous.sha256,
              width: context.previous.width,
              height: context.previous.height,
              nodeName: context.previous.nodeName,
              capturedAt: context.previous.capturedAt,
              providerVersionId: context.previous.providerVersionId,
            },
          }
        : {}),
    };
  },
});
