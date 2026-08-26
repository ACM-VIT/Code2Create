"use node";

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { ConvexError, v } from "convex/values";
import { z } from "zod";

import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { action, internalAction } from "./_generated/server";
import {
  signArtifactDownload,
  storeFigmaPreviewArtifact,
  storeFigmaFileArtifact,
  type StoredArtifact,
  type StoredFigmaPreviewArtifact,
} from "./lib/artifactStorage";
import {
  HttpBodyTooLargeError,
  readBoundedJsonResponse,
  readBoundedResponseText,
} from "./lib/boundedHttpBody";
import {
  currentProviderSecretKeyVersion,
  decryptProviderSecret,
  encryptProviderSecret,
  providerSecretKeyVersion,
  reencryptProviderSecret,
} from "./lib/providerSecrets";
import {
  downloadFigmaPreview,
  FigmaPreviewDownloadError,
} from "./lib/figmaPreviewDownload";

const figmaApiOrigin = "https://api.figma.com";
const figmaAuthorizationUrl = "https://www.figma.com/oauth";
const maximumPreviewNodes = 48;
const maximumPreviewPages = 100;
const maximumPreviewBytes = 8 * 1024 * 1024;
const maximumPreviewSetBytes = 64 * 1024 * 1024;
const previewDownloadParallelism = 4;
const previewScale = "0.5";
const maximumCapturedVersions = 200;
const maximumCapturedComments = 400;
const maximumVersionPages = 100;
const previewableNodeTypes = new Set([
  "FRAME",
  "COMPONENT",
  "COMPONENT_SET",
  "SECTION",
  "INSTANCE",
]);
const figmaScopes = [
  "file_metadata:read",
  "file_content:read",
  "file_versions:read",
  "file_comments:read",
  "webhooks:write",
] as const;

export const rotateProviderSecrets = internalAction({
  args: {
    owner: v.union(
      v.literal("active_credentials"),
      v.literal("pending_intents"),
      v.literal("verifying_intents"),
    ),
    cursor: v.optional(v.string()),
    limit: v.number(),
    dryRun: v.boolean(),
  },
  returns: v.object({
    owner: v.union(
      v.literal("active_credentials"),
      v.literal("pending_intents"),
      v.literal("verifying_intents"),
    ),
    targetKeyVersion: v.string(),
    scanned: v.number(),
    live: v.number(),
    needingRotation: v.number(),
    rotated: v.number(),
    continueCursor: v.string(),
    isDone: v.boolean(),
    dryRun: v.boolean(),
  }),
  handler: async (ctx, args): Promise<ProviderSecretRotationResult> => {
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50) {
      throw new ConvexError({
        code: "INVALID_ROTATION_LIMIT",
        message: "Provider secret rotation batches must contain between 1 and 50 rows.",
      });
    }
    const targetKeyVersion = currentProviderSecretKeyVersion();
    const paginationOpts = {
      cursor: args.cursor ?? null,
      numItems: args.limit,
    };
    if (args.owner === "active_credentials") {
      const page: CredentialSecretRotationPage = await ctx.runQuery(
        internal.providerSecretRotation.activeCredentialPage,
        { paginationOpts },
      );
      const needingRotation = page.page.filter(
        (credential) =>
          providerSecretKeyVersion(credential.accessTokenCiphertext) !== targetKeyVersion ||
          providerSecretKeyVersion(credential.refreshTokenCiphertext) !== targetKeyVersion,
      );
      const rotated = args.dryRun
        ? 0
        : await ctx.runMutation(
            internal.providerSecretRotation.commitCredentialRotations,
            {
              rotations: needingRotation.map((credential) => ({
                credentialId: credential.id,
                expectedVersion: credential.version,
                expectedAccessTokenCiphertext: credential.accessTokenCiphertext,
                expectedRefreshTokenCiphertext: credential.refreshTokenCiphertext,
                accessTokenCiphertext: reencryptProviderSecret(
                  credential.accessTokenCiphertext,
                ),
                refreshTokenCiphertext: reencryptProviderSecret(
                  credential.refreshTokenCiphertext,
                ),
              })),
            },
          );
      return {
        owner: args.owner,
        targetKeyVersion,
        scanned: page.page.length,
        live: page.page.length,
        needingRotation: needingRotation.length,
        rotated,
        continueCursor: page.continueCursor,
        isDone: page.isDone,
        dryRun: args.dryRun,
      };
    }

    const status = args.owner === "pending_intents" ? "pending" : "verifying";
    const page: IntentSecretRotationPage = await ctx.runQuery(
      internal.providerSecretRotation.liveIntentPage,
      { status, paginationOpts },
    );
    const now = Date.now();
    const live = page.page.filter((intent) => intent.expiresAt > now);
    const needingRotation = live.filter(
      (intent) =>
        providerSecretKeyVersion(intent.pkceVerifierCiphertext) !== targetKeyVersion,
    );
    const rotated = args.dryRun
      ? 0
      : await ctx.runMutation(internal.providerSecretRotation.commitIntentRotations, {
          now,
          rotations: needingRotation.map((intent) => ({
            intentId: intent.id,
            expectedStatus: intent.status,
            expectedPkceVerifierCiphertext: intent.pkceVerifierCiphertext,
            pkceVerifierCiphertext: reencryptProviderSecret(
              intent.pkceVerifierCiphertext,
            ),
          })),
        });
    return {
      owner: args.owner,
      targetKeyVersion,
      scanned: page.page.length,
      live: live.length,
      needingRotation: needingRotation.length,
      rotated,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      dryRun: args.dryRun,
    };
  },
});

type FigmaConfiguration = {
  clientId: string;
  clientSecret: string;
  participantSiteUrl: URL;
  convexSiteUrl: URL;
};

type SetupClaim =
  | {
      kind: "verify";
      intentId: Id<"figmaSetupIntents">;
      pkceVerifierCiphertext: string;
      redirectUri: string;
    }
  | { kind: "completed"; credentialConnectionId: Id<"figmaCredentialConnections"> };

type ConnectionContext = {
  eventId: Id<"events">;
  teamId: Id<"teams">;
  integrationPolicyId: Id<"integrationPolicyVersions">;
  maxActiveFiles: number;
  credentialId: Id<"figmaOAuthCredentials">;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  tokenExpiresAt: number;
  credentialVersion: number;
};

type CredentialRefreshClaim =
  | { kind: "ready"; accessTokenCiphertext: string }
  | { kind: "wait"; retryAt: number }
  | {
      kind: "refresh";
      refreshTokenCiphertext: string;
      credentialVersion: number;
    };

type ProviderSecretRotationOwner =
  | "active_credentials"
  | "pending_intents"
  | "verifying_intents";

type ProviderSecretRotationResult = {
  owner: ProviderSecretRotationOwner;
  targetKeyVersion: string;
  scanned: number;
  live: number;
  needingRotation: number;
  rotated: number;
  continueCursor: string;
  isDone: boolean;
  dryRun: boolean;
};

type CredentialSecretRotationPage = {
  page: Array<{
    id: Id<"figmaOAuthCredentials">;
    accessTokenCiphertext: string;
    refreshTokenCiphertext: string;
    version: number;
  }>;
  continueCursor: string;
  isDone: boolean;
};

type IntentSecretRotationPage = {
  page: Array<{
    id: Id<"figmaSetupIntents">;
    pkceVerifierCiphertext: string;
    expiresAt: number;
    status: "pending" | "verifying";
  }>;
  continueCursor: string;
  isDone: boolean;
};

type FileSyncContext = {
  bindingId: Id<"figmaFileBindings">;
  eventId: Id<"events">;
  teamId: Id<"teams">;
  credentialId: Id<"figmaOAuthCredentials">;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  tokenExpiresAt: number;
  credentialVersion: number;
  fileKey: string;
  syncRevision: number;
};

type FileMetrics = {
  pageCount: number;
  frameCount: number;
  componentCount: number;
  componentSetCount: number;
  styleCount: number;
  nodeCount: number;
  prototypeInteractionCount: number;
  commentCount: number;
  unresolvedCommentCount: number;
  versionCount: number;
  completeness: "complete" | "partial" | "unknown";
};

type FigmaVersionCaptureFact = {
  versionId: string;
  label: string;
  description: string;
  descriptionTruncated: boolean;
  userId: string;
  userHandle: string;
  providerCreatedAt: number;
  displayOrder: number;
};

type FigmaCommentCaptureFact = {
  commentId: string;
  parentCommentId?: string;
  userId: string;
  userHandle: string;
  message: string;
  messageTruncated: boolean;
  providerCreatedAt: number;
  resolvedAt?: number;
  orderId?: number;
  reactionCount: number;
  displayOrder: number;
};

type FigmaActivityCapture = {
  versionCount: number;
  versionsComplete: boolean;
  versions: FigmaVersionCaptureFact[];
  commentCount: number;
  commentsComplete: boolean;
  replyCount: number;
  resolvedThreadCount: number;
  unresolvedThreadCount: number;
  comments: FigmaCommentCaptureFact[];
};

type FileCapture = {
  name: string;
  role: string;
  linkAccess: string;
  editorType: string;
  versionId: string;
  lastTouchedAt: number;
  providerObservedAt: number;
  thumbnailUrl?: string;
  mainFileKey?: string;
  metrics: FileMetrics;
  activity: FigmaActivityCapture;
  previewPlan: FigmaPreviewPlan;
  rawJson: string;
};

type FileMetadataCheckContext = {
  bindingId: Id<"figmaFileBindings">;
  credentialId: Id<"figmaOAuthCredentials">;
  fileKey: string;
};

type WebhookSetupContext = {
  bindingId: Id<"figmaFileBindings">;
  credentialId: Id<"figmaOAuthCredentials">;
  fileKey: string;
  role: string;
  webhookId?: string;
};

type FigmaPreviewCandidate = {
  pageId: string;
  pageName: string;
  pageOrder: number;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  nodeOrder: number;
  descendantCount: number;
  semanticHash: string;
  sourceWidth?: number;
  sourceHeight?: number;
};

type FigmaPreviewPlan = {
  discoveredNodeCount: number;
  truncated: boolean;
  candidates: FigmaPreviewCandidate[];
};

type PreviewRenderClaim = {
  previewSetId: Id<"figmaPreviewSets">;
  eventId: Id<"events">;
  teamId: Id<"teams">;
  credentialId: Id<"figmaOAuthCredentials">;
  fileKey: string;
  providerVersionId: string;
  nodes: Array<{ factId: Id<"figmaNodeFacts">; nodeId: string }>;
};

type PreviewRenderResult =
  | {
      factId: Id<"figmaNodeFacts">;
      state: "available";
      artifact: StoredFigmaPreviewArtifact;
    }
  | { factId: Id<"figmaNodeFacts">; state: "failed"; failureCode: string };

type ArtifactAccessContext = {
  artifactId: Id<"integrationArtifacts">;
  snapshotId: Id<"figmaFileSnapshots">;
  objectKey: string;
  storageRegion: string;
  storageBucket: string;
  sha256: string;
  capturedAt: number;
};

type ArtifactAccessReceipt = {
  serverNow: number;
};

type OpenFullCheckpointResult = {
  url: string;
  expiresAt: number;
  serverNow: number;
  sha256: string;
  capturedAt: number;
};

type FigmaFileLocation = {
  fileKey: string;
  url: string;
};

type ProviderFailure = {
  state: "rate_limited" | "error";
  code: string;
  retryAt?: number;
  planTier?: string;
  rateLimitType?: string;
};

const initialTokenResponse = z.object({
  user_id_string: z.string().min(1).max(128),
  access_token: z.string().min(1).max(8_192),
  refresh_token: z.string().min(1).max(8_192),
  token_type: z.string().toLowerCase().pipe(z.literal("bearer")),
  expires_in: z.number().int().positive().max(366 * 24 * 60 * 60),
});

const refreshTokenResponse = z.object({
  access_token: z.string().min(1).max(8_192),
  refresh_token: z.string().min(1).max(8_192).optional(),
  token_type: z.string().toLowerCase().pipe(z.literal("bearer")),
  expires_in: z.number().int().positive().max(366 * 24 * 60 * 60),
});

type FigmaNode = {
  type: string;
  interactions?: number | undefined;
  children?: FigmaNode[] | undefined;
};

const figmaNodeSchema: z.ZodType<FigmaNode> = z.lazy(() =>
  z.object({
    type: z.string(),
    interactions: z.array(z.object({})).transform((items) => items.length).optional(),
    children: z.array(figmaNodeSchema).optional(),
  }),
);

const countedMap = z
  .record(z.string(), z.object({}))
  .transform((entries) => Object.keys(entries).length);

const fileResponse = z.object({
  name: z.string().min(1).max(512),
  role: z.string().min(1).max(80),
  lastModified: z.string().min(1).max(80),
  editorType: z.string().min(1).max(80),
  linkAccess: z.string().min(1).max(80),
  thumbnailUrl: z.string().url().optional(),
  version: z.string().min(1).max(256),
  mainFileKey: z.string().min(1).max(256).optional(),
  document: figmaNodeSchema,
  components: countedMap,
  componentSets: countedMap,
  styles: countedMap,
});

const fileMetadataResponse = z.object({
  file: z.object({
    name: z.string().min(1).max(512),
    last_touched_at: z.string().min(1).max(80),
    thumbnail_url: z.string().url(),
    editorType: z.string().min(1).max(80),
    version: z.string().min(1).max(256),
    role: z.string().min(1).max(80),
    link_access: z.string().min(1).max(80),
  }),
});

const figmaUser = z.object({
  id: z.string().min(1).max(256),
  handle: z.string().max(4_096),
});

const commentsResponse = z.object({
  comments: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        parent_id: z.string().min(1).max(256).nullish(),
        user: figmaUser,
        created_at: z.string().min(1).max(80),
        resolved_at: z.string().min(1).max(80).nullish(),
        message: z.string().max(1_000_000),
        order_id: z.number().int().nonnegative().optional(),
        reactions: z.array(z.object({})).max(10_000).optional(),
      }),
    )
    .max(10_000),
});

const versionsResponse = z.object({
  versions: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        created_at: z.string().min(1).max(80),
        label: z.string().max(100_000),
        description: z.string().max(1_000_000),
        user: figmaUser,
      }),
    )
    .max(1_000),
  pagination: z
    .object({
      next_page: z.string().url().nullable().optional(),
    })
    .optional(),
});

const renderedImagesResponse = z.object({
  images: z.record(z.string(), z.string().url().nullable()),
  err: z.string().optional(),
  status: z.number().int().optional(),
});

const providerId = z
  .union([z.string().min(1).max(128), z.number().int().positive()])
  .transform((value) => String(value));

const webhookResponse = z.object({
  id: providerId,
  status: z.enum(["ACTIVE", "PAUSED"]),
});

class FigmaHttpError extends Error {
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly planTier?: string;
  readonly rateLimitType?: string;

  constructor(response: Response) {
    super(`Figma returned HTTP ${response.status}.`);
    this.name = "FigmaHttpError";
    this.status = response.status;
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfter = retryAfterHeader === null ? null : Number(retryAfterHeader);
    if (retryAfter !== null && Number.isSafeInteger(retryAfter) && retryAfter >= 0) {
      this.retryAfterSeconds = retryAfter;
    }
    const planTier = response.headers.get("x-figma-plan-tier")?.trim();
    if (planTier) this.planTier = planTier;
    const rateLimitType = response.headers.get("x-figma-rate-limit-type")?.trim();
    if (rateLimitType) this.rateLimitType = rateLimitType;
  }
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConvexError({
      code: "FIGMA_NOT_CONFIGURED",
      message: "Figma is not configured for this environment.",
    });
  }
  return value;
}

function configuredSiteUrl(name: string) {
  const raw = requiredEnvironment(name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConvexError({
      code: "FIGMA_NOT_CONFIGURED",
      message: "Figma is not configured for this environment.",
    });
  }
  const localHttp =
    url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ConvexError({
      code: "FIGMA_NOT_CONFIGURED",
      message: "Figma is not configured for this environment.",
    });
  }
  return url;
}

function figmaConfiguration(): FigmaConfiguration {
  return {
    clientId: requiredEnvironment("FIGMA_CLIENT_ID"),
    clientSecret: requiredEnvironment("FIGMA_CLIENT_SECRET"),
    participantSiteUrl: configuredSiteUrl("PARTICIPANT_SITE_URL"),
    convexSiteUrl: configuredSiteUrl("CONVEX_SITE_URL"),
  };
}

function redirectUri(configuration: FigmaConfiguration) {
  return new URL("/integrations/figma/callback", configuration.participantSiteUrl).toString();
}

function webhookEndpoint(configuration: FigmaConfiguration) {
  const endpoint = new URL(
    "/integrations/figma/webhook",
    configuration.convexSiteUrl,
  );
  return endpoint.protocol === "https:" ? endpoint.toString() : null;
}

function opaqueDigest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function tokenAuthorization(configuration: FigmaConfiguration) {
  return `Basic ${Buffer.from(
    `${configuration.clientId}:${configuration.clientSecret}`,
    "utf8",
  ).toString("base64")}`;
}

function tokenExpiresAt(expiresInSeconds: number, receivedAt: number) {
  return receivedAt + expiresInSeconds * 1_000;
}

function parseProviderTime(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ConvexError({
      code: "FIGMA_RESPONSE_INVALID",
      message: "Figma returned an invalid file timestamp.",
    });
  }
  return parsed;
}

function figmaPath(path: string) {
  if (!path.startsWith("/")) {
    throw new Error("Figma API paths must be relative to the provider origin.");
  }
  return new URL(path, figmaApiOrigin).toString();
}

type FigmaRequest = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: string;
  timeoutMs?: number;
};

async function figmaResponseText(
  accessToken: string,
  path: string,
  request: FigmaRequest,
  maximumBytes: number,
) {
  const response = await fetch(figmaPath(path), {
    method: request.method ?? "GET",
    signal: AbortSignal.timeout(request.timeoutMs ?? 120_000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(request.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(request.body !== undefined ? { body: request.body } : {}),
  });
  if (!response.ok) throw new FigmaHttpError(response);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw new ConvexError({
      code: "FIGMA_RESPONSE_INVALID",
      message: "Figma returned an unsupported response type.",
    });
  }
  try {
    return await readBoundedResponseText(response, maximumBytes);
  } catch (caught) {
    if (caught instanceof HttpBodyTooLargeError) {
      throw new ConvexError({
        code: "FIGMA_RESPONSE_TOO_LARGE",
        message: "The Figma response exceeds the supported checkpoint size.",
      });
    }
    throw caught;
  }
}

async function figmaRequest<T>(
  accessToken: string,
  path: string,
  schema: z.ZodType<T>,
  request: FigmaRequest = {},
  maximumBytes = 10 * 1024 * 1024,
) {
  const responseText = await figmaResponseText(accessToken, path, request, maximumBytes);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(responseText);
  } catch {
    throw new ConvexError({
      code: "FIGMA_RESPONSE_INVALID",
      message: "Figma returned an invalid response.",
    });
  }
  return schema.parse(parsedJson);
}

async function figmaTokenRequest<T>(
  configuration: FigmaConfiguration,
  body: URLSearchParams,
  schema: z.ZodType<T>,
) {
  const response = await fetch(`${figmaApiOrigin}/v1/oauth/token`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: tokenAuthorization(configuration),
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) throw new FigmaHttpError(response);
  let parsedJson: unknown;
  try {
    parsedJson = await readBoundedJsonResponse(response, 64 * 1_024);
  } catch {
    throw new ConvexError({
      code: "FIGMA_RESPONSE_INVALID",
      message: "Figma returned an invalid authorization response.",
    });
  }
  return schema.parse(parsedJson);
}

function providerFailure(error: unknown): ProviderFailure {
  if (error instanceof FigmaHttpError) {
    if (error.status === 429) {
      const retryAt = Date.now() + (error.retryAfterSeconds ?? 60) * 1_000;
      return {
        state: "rate_limited",
        code: "figma_rate_limited",
        retryAt,
        ...(error.planTier !== undefined ? { planTier: error.planTier } : {}),
        ...(error.rateLimitType !== undefined
          ? { rateLimitType: error.rateLimitType }
          : {}),
      };
    }
    if (error.status === 401) return { state: "error", code: "figma_authentication_failed" };
    if (error.status === 403) return { state: "error", code: "figma_access_denied" };
    if (error.status === 404) return { state: "error", code: "figma_file_not_found" };
    if (error.status >= 500) return { state: "error", code: "figma_unavailable" };
    return { state: "error", code: `figma_http_${error.status}` };
  }
  if (error instanceof z.ZodError) {
    return { state: "error", code: "figma_response_invalid" };
  }
  if (error instanceof ConvexError) {
    return { state: "error", code: "figma_state_rejected" };
  }
  return { state: "error", code: "figma_request_failed" };
}

function providerFacingError(error: unknown) {
  if (error instanceof ConvexError) return error;
  const failure = providerFailure(error);
  if (failure.state === "rate_limited") {
    return new ConvexError({
      code: "FIGMA_RATE_LIMITED",
      message: "Figma has limited this account for now. The portal shows when to try again.",
    });
  }
  return new ConvexError({
    code: "FIGMA_REQUEST_FAILED",
    message: "Figma could not complete this request. Check access to the file and try again.",
  });
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function freshAccessToken(ctx: ActionCtx, credentialId: Id<"figmaOAuthCredentials">) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const leaseId = randomUUID();
    const claim: CredentialRefreshClaim = await ctx.runMutation(
      internal.figmaIntegrations.claimCredentialRefresh,
      { credentialId, leaseId },
    );
    if (claim.kind === "ready") {
      return decryptProviderSecret(claim.accessTokenCiphertext);
    }
    if (claim.kind === "wait") {
      const remaining = claim.retryAt - Date.now();
      await wait(Math.min(500, Math.max(100, remaining)));
      continue;
    }
    try {
      const configuration = figmaConfiguration();
      const refreshed = await figmaTokenRequest(
        configuration,
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: decryptProviderSecret(claim.refreshTokenCiphertext),
        }),
        refreshTokenResponse,
      );
      const receivedAt = Date.now();
      const accessTokenCiphertext = encryptProviderSecret(refreshed.access_token);
      const finished: { accessTokenCiphertext: string } = await ctx.runMutation(
        internal.figmaIntegrations.finishCredentialRefresh,
        {
          credentialId,
          leaseId,
          expectedCredentialVersion: claim.credentialVersion,
          accessTokenCiphertext,
          ...(refreshed.refresh_token !== undefined
            ? { refreshTokenCiphertext: encryptProviderSecret(refreshed.refresh_token) }
            : {}),
          tokenExpiresAt: tokenExpiresAt(refreshed.expires_in, receivedAt),
          tokenReceivedAt: receivedAt,
        },
      );
      return decryptProviderSecret(finished.accessTokenCiphertext);
    } catch (error) {
      await ctx.runMutation(internal.figmaIntegrations.failCredentialRefresh, {
        credentialId,
        leaseId,
        invalidateCredential:
          error instanceof FigmaHttpError && [400, 401].includes(error.status),
      });
      throw error;
    }
  }
  throw new ConvexError({
    code: "FIGMA_REFRESH_BUSY",
    message: "Figma authorization is still being refreshed. Try again shortly.",
  });
}

export const beginConnection = action({
  args: { eventSlug: v.string() },
  returns: v.object({ authorizeUrl: v.string() }),
  handler: async (ctx, args): Promise<{ authorizeUrl: string }> => {
    const configuration = figmaConfiguration();
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(64).toString("base64url");
    const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
    const callback = redirectUri(configuration);
    await ctx.runMutation(internal.figmaIntegrations.createSetupIntent, {
      eventSlug: args.eventSlug,
      stateDigest: opaqueDigest(state),
      pkceVerifierCiphertext: encryptProviderSecret(verifier),
      redirectUri: callback,
    });
    const authorizeUrl = new URL(figmaAuthorizationUrl);
    authorizeUrl.search = new URLSearchParams({
      client_id: configuration.clientId,
      redirect_uri: callback,
      scope: figmaScopes.join(","),
      state,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return { authorizeUrl: authorizeUrl.toString() };
  },
});

export const completeConnection = action({
  args: { eventSlug: v.string(), state: v.string(), code: v.string() },
  returns: v.object({ credentialConnectionId: v.id("figmaCredentialConnections") }),
  handler: async (
    ctx,
    args,
  ): Promise<{ credentialConnectionId: Id<"figmaCredentialConnections"> }> => {
    if (
      args.state.length < 32 ||
      args.state.length > 256 ||
      args.code.length < 8 ||
      args.code.length > 2_048
    ) {
      throw new ConvexError({
        code: "SETUP_INVALID",
        message: "The Figma callback is incomplete or invalid.",
      });
    }
    const attemptId = randomUUID();
    const claim: SetupClaim = await ctx.runMutation(
      internal.figmaIntegrations.claimSetupIntent,
      {
        eventSlug: args.eventSlug,
        stateDigest: opaqueDigest(args.state),
        attemptId,
      },
    );
    if (claim.kind === "completed") {
      return { credentialConnectionId: claim.credentialConnectionId };
    }
    try {
      const configuration = figmaConfiguration();
      const token = await figmaTokenRequest(
        configuration,
        new URLSearchParams({
          redirect_uri: claim.redirectUri,
          code: args.code,
          grant_type: "authorization_code",
          code_verifier: decryptProviderSecret(claim.pkceVerifierCiphertext),
        }),
        initialTokenResponse,
      );
      const receivedAt = Date.now();
      return await ctx.runMutation(internal.figmaIntegrations.finishSetupIntent, {
        eventSlug: args.eventSlug,
        intentId: claim.intentId,
        attemptId,
        figmaUserId: token.user_id_string,
        accessTokenCiphertext: encryptProviderSecret(token.access_token),
        refreshTokenCiphertext: encryptProviderSecret(token.refresh_token),
        tokenExpiresAt: tokenExpiresAt(token.expires_in, receivedAt),
        tokenReceivedAt: receivedAt,
        scopes: [...figmaScopes],
      });
    } catch (error) {
      await ctx.runMutation(internal.figmaIntegrations.failSetupIntent, {
        intentId: claim.intentId,
        attemptId,
        failureCode: providerFailure(error).code,
      });
      throw providerFacingError(error);
    }
  },
});

function parseFigmaFileLocation(value: string): FigmaFileLocation {
  if (value.length > 2_048) {
    throw new ConvexError({
      code: "FIGMA_URL_INVALID",
      message: "Enter a Figma design or FigJam file link.",
    });
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ConvexError({
      code: "FIGMA_URL_INVALID",
      message: "Enter a Figma design or FigJam file link.",
    });
  }
  if (
    url.protocol !== "https:" ||
    !["figma.com", "www.figma.com"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new ConvexError({
      code: "FIGMA_URL_INVALID",
      message: "Enter a link from figma.com.",
    });
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const fileType = segments[0];
  const encodedFileKey = segments[1];
  if (!fileType || !["design", "file", "board"].includes(fileType) || !encodedFileKey) {
    throw new ConvexError({
      code: "FIGMA_URL_INVALID",
      message: "Enter a Figma design or FigJam file link.",
    });
  }
  let fileKey: string;
  try {
    fileKey = decodeURIComponent(encodedFileKey);
  } catch {
    throw new ConvexError({
      code: "FIGMA_URL_INVALID",
      message: "The Figma file key is invalid.",
    });
  }
  if (!/^[A-Za-z0-9_-]{6,256}$/.test(fileKey)) {
    throw new ConvexError({
      code: "FIGMA_URL_INVALID",
      message: "The Figma file key is invalid.",
    });
  }
  url.search = "";
  url.hash = "";
  return { fileKey, url: url.toString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedProviderString(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximumLength ? trimmed : null;
}

function sourceDimensions(value: Record<string, unknown>) {
  const bounds = value.absoluteBoundingBox;
  if (!isRecord(bounds)) return {};
  const width = bounds.width;
  const height = bounds.height;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 1_000_000 ||
    height > 1_000_000
  ) {
    return {};
  }
  return { sourceWidth: width, sourceHeight: height };
}

function descendantCount(value: Record<string, unknown>) {
  const pending = Array.isArray(value.children) ? [...value.children] : [];
  let count = 0;
  while (pending.length > 0) {
    const child = pending.pop();
    if (!isRecord(child)) continue;
    count += 1;
    if (Array.isArray(child.children)) pending.push(...child.children);
  }
  return count;
}

function previewCandidate(
  page: Record<string, unknown>,
  pageOrder: number,
  node: Record<string, unknown>,
  nodeOrder: number,
): FigmaPreviewCandidate | null {
  const pageId = boundedProviderString(page.id, 256);
  const pageName = boundedProviderString(page.name, 1_024);
  const nodeId = boundedProviderString(node.id, 256);
  const nodeName = boundedProviderString(node.name, 1_024);
  const nodeType = boundedProviderString(node.type, 128);
  if (!pageId || !pageName || !nodeId || !nodeName || !nodeType) return null;
  const serialized = JSON.stringify(node);
  if (!serialized) return null;
  return {
    pageId,
    pageName,
    pageOrder,
    nodeId,
    nodeName,
    nodeType,
    nodeOrder,
    descendantCount: descendantCount(node),
    semanticHash: opaqueDigest(serialized),
    ...sourceDimensions(node),
  };
}

function selectPreviewCandidates(parsedFile: unknown): FigmaPreviewPlan {
  if (!isRecord(parsedFile) || !isRecord(parsedFile.document)) {
    return { discoveredNodeCount: 0, truncated: false, candidates: [] };
  }
  const allPages = Array.isArray(parsedFile.document.children)
    ? parsedFile.document.children
    : [];
  const pages = allPages.slice(0, maximumPreviewPages);
  const candidatesByPage: FigmaPreviewCandidate[][] = [];
  let discoveredNodeCount = 0;
  for (let pageOrder = 0; pageOrder < pages.length; pageOrder += 1) {
    const page = pages[pageOrder];
    if (!isRecord(page)) continue;
    const children = Array.isArray(page.children) ? page.children : [];
    const pageCandidates = children.flatMap((child, nodeOrder) => {
      if (!isRecord(child) || child.visible === false) return [];
      const nodeType = boundedProviderString(child.type, 128);
      if (!nodeType || !previewableNodeTypes.has(nodeType)) return [];
      const candidate = previewCandidate(page, pageOrder, child, nodeOrder);
      return candidate ? [candidate] : [];
    });
    if (pageCandidates.length === 0 && page.visible !== false) {
      const pageCandidate = previewCandidate(page, pageOrder, page, 0);
      if (pageCandidate) pageCandidates.push(pageCandidate);
    }
    discoveredNodeCount += pageCandidates.length;
    if (pageCandidates.length > 0) candidatesByPage.push(pageCandidates);
  }
  const candidates: FigmaPreviewCandidate[] = [];
  for (let ordinal = 0; candidates.length < maximumPreviewNodes; ordinal += 1) {
    let found = false;
    for (const pageCandidates of candidatesByPage) {
      const candidate = pageCandidates[ordinal];
      if (!candidate) continue;
      found = true;
      candidates.push(candidate);
      if (candidates.length === maximumPreviewNodes) break;
    }
    if (!found) break;
  }
  return {
    discoveredNodeCount,
    truncated:
      allPages.length > maximumPreviewPages || discoveredNodeCount > candidates.length,
    candidates,
  };
}

function countDocument(document: FigmaNode) {
  let pageCount = 0;
  let frameCount = 0;
  let nodeCount = 0;
  let prototypeInteractionCount = 0;
  const pending = [document];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    nodeCount += 1;
    if (node.type === "CANVAS") pageCount += 1;
    if (node.type === "FRAME") frameCount += 1;
    prototypeInteractionCount += node.interactions ?? 0;
    if (node.children) pending.push(...node.children);
  }
  return { pageCount, frameCount, nodeCount, prototypeInteractionCount };
}

function versionsPaginationPath(value: string, fileKey: string) {
  const url = new URL(value);
  const expectedPath = `/v1/files/${encodeURIComponent(fileKey)}/versions`;
  if (url.origin !== figmaApiOrigin || url.pathname !== expectedPath) {
    throw new ConvexError({
      code: "FIGMA_RESPONSE_INVALID",
      message: "Figma returned an invalid version-history cursor.",
    });
  }
  return `${url.pathname}${url.search}`;
}

async function captureVersionHistory(accessToken: string, fileKey: string) {
  const versions = new Map<string, FigmaVersionCaptureFact>();
  const visitedPages = new Set<string>();
  let path = `/v1/files/${encodeURIComponent(fileKey)}/versions`;
  let paginationComplete = false;
  for (let page = 0; page < maximumVersionPages; page += 1) {
    if (visitedPages.has(path)) {
      break;
    }
    visitedPages.add(path);
    const response = await figmaRequest(accessToken, path, versionsResponse);
    for (const version of response.versions) {
      if (versions.has(version.id)) continue;
      const description = boundedActivityText(version.description, 4_000);
      versions.set(version.id, {
        versionId: version.id,
        label: boundedActivityText(version.label, 500).text,
        description: description.text,
        descriptionTruncated: description.truncated,
        userId: version.user.id,
        userHandle: boundedActivityText(version.user.handle, 256).text,
        providerCreatedAt: parseProviderTime(version.created_at),
        displayOrder: 0,
      });
    }
    const nextPage = response.pagination?.next_page;
    if (!nextPage) {
      paginationComplete = true;
      break;
    }
    path = versionsPaginationPath(nextPage, fileKey);
  }
  const ordered = [...versions.values()].toSorted(
    (left, right) =>
      right.providerCreatedAt - left.providerCreatedAt ||
      left.versionId.localeCompare(right.versionId),
  );
  const captured = ordered.slice(0, maximumCapturedVersions).map((version, displayOrder) => ({
    ...version,
    displayOrder,
  }));
  return {
    versionCount: versions.size,
    versions: captured,
    complete: paginationComplete && captured.length === versions.size,
  };
}

function boundedActivityText(value: string, maximumLength: number) {
  const normalized = value.normalize("NFC");
  return {
    text: normalized.slice(0, maximumLength),
    truncated: normalized.length > maximumLength,
  };
}

function captureComments(response: z.infer<typeof commentsResponse>) {
  const comments = new Map<string, FigmaCommentCaptureFact>();
  for (const comment of response.comments) {
    if (comments.has(comment.id)) continue;
    const message = boundedActivityText(comment.message, 4_000);
    comments.set(comment.id, {
      commentId: comment.id,
      ...(comment.parent_id ? { parentCommentId: comment.parent_id } : {}),
      userId: comment.user.id,
      userHandle: boundedActivityText(comment.user.handle, 256).text,
      message: message.text,
      messageTruncated: message.truncated,
      providerCreatedAt: parseProviderTime(comment.created_at),
      ...(comment.resolved_at
        ? { resolvedAt: parseProviderTime(comment.resolved_at) }
        : {}),
      ...(comment.order_id !== undefined ? { orderId: comment.order_id } : {}),
      reactionCount: comment.reactions?.length ?? 0,
      displayOrder: 0,
    });
  }
  const ordered = [...comments.values()].toSorted(
    (left, right) =>
      right.providerCreatedAt - left.providerCreatedAt ||
      left.commentId.localeCompare(right.commentId),
  );
  const captured = ordered.slice(0, maximumCapturedComments).map((comment, displayOrder) => ({
    ...comment,
    displayOrder,
  }));
  return {
    commentCount: comments.size,
    comments: captured,
    replyCount: ordered.filter((comment) => comment.parentCommentId !== undefined).length,
    resolvedThreadCount: ordered.filter(
      (comment) => comment.parentCommentId === undefined && comment.resolvedAt !== undefined,
    ).length,
    unresolvedThreadCount: ordered.filter(
      (comment) => comment.parentCommentId === undefined && comment.resolvedAt === undefined,
    ).length,
    complete:
      comments.size === response.comments.length && captured.length === comments.size,
  };
}

async function captureFile(accessToken: string, fileKey: string): Promise<FileCapture> {
  const rawJson = await figmaResponseText(
    accessToken,
    `/v1/files/${encodeURIComponent(fileKey)}?branch_data=true`,
    {},
    100 * 1024 * 1024,
  );
  const providerObservedAt = Date.now();
  let parsedFile: unknown;
  try {
    parsedFile = JSON.parse(rawJson);
  } catch {
    throw new ConvexError({
      code: "FIGMA_RESPONSE_INVALID",
      message: "Figma returned an invalid file response.",
    });
  }
  const file = fileResponse.parse(parsedFile);
  const [comments, versions] = await Promise.all([
    figmaRequest(
      accessToken,
      `/v1/files/${encodeURIComponent(fileKey)}/comments`,
      commentsResponse,
    ),
    captureVersionHistory(accessToken, fileKey),
  ]);
  const documentMetrics = countDocument(file.document);
  const capturedComments = captureComments(comments);
  return {
    name: file.name,
    role: file.role,
    linkAccess: file.linkAccess,
    editorType: file.editorType,
    versionId: file.version,
    lastTouchedAt: parseProviderTime(file.lastModified),
    providerObservedAt,
    ...(file.thumbnailUrl !== undefined ? { thumbnailUrl: file.thumbnailUrl } : {}),
    ...(file.mainFileKey !== undefined ? { mainFileKey: file.mainFileKey } : {}),
    metrics: {
      ...documentMetrics,
      componentCount: file.components,
      componentSetCount: file.componentSets,
      styleCount: file.styles,
      commentCount: capturedComments.commentCount,
      unresolvedCommentCount: capturedComments.unresolvedThreadCount,
      versionCount: versions.versionCount,
      completeness:
        versions.complete && capturedComments.complete ? "complete" : "partial",
    },
    activity: {
      versionCount: versions.versionCount,
      versionsComplete: versions.complete,
      versions: versions.versions,
      commentCount: capturedComments.commentCount,
      commentsComplete: capturedComments.complete,
      replyCount: capturedComments.replyCount,
      resolvedThreadCount: capturedComments.resolvedThreadCount,
      unresolvedThreadCount: capturedComments.unresolvedThreadCount,
      comments: capturedComments.comments,
    },
    previewPlan: selectPreviewCandidates(parsedFile),
    rawJson,
  };
}

async function removeWebhook(accessToken: string, webhookId: string) {
  try {
    await figmaRequest(
      accessToken,
      `/v2/webhooks/${encodeURIComponent(webhookId)}`,
      webhookResponse,
      { method: "DELETE", timeoutMs: 30_000 },
    );
  } catch {
    // A paused orphan is inert. Operations can remove it from Figma if provider cleanup fails.
  }
}

export const configureFileWebhook = internalAction({
  args: {
    bindingId: v.id("figmaFileBindings"),
    leaseId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const setup: WebhookSetupContext | null = await ctx.runMutation(
      internal.figmaIntegrations.beginWebhookSetup,
      args,
    );
    if (!setup) return null;

    let endpoint: string | null;
    try {
      endpoint = webhookEndpoint(figmaConfiguration());
    } catch (error) {
      await ctx.runMutation(internal.figmaIntegrations.failWebhookSetup, {
        bindingId: setup.bindingId,
        leaseId: args.leaseId,
        ...(setup.webhookId !== undefined
          ? { expectedWebhookId: setup.webhookId }
          : {}),
        state: "error",
      });
      throw error;
    }
    const normalizedRole = setup.role.trim().toLowerCase();
    if (!endpoint || !["owner", "editor"].includes(normalizedRole)) {
      await ctx.runMutation(internal.figmaIntegrations.failWebhookSetup, {
        bindingId: setup.bindingId,
        leaseId: args.leaseId,
        ...(setup.webhookId !== undefined
          ? { expectedWebhookId: setup.webhookId }
          : {}),
        state: "unavailable",
      });
      return null;
    }

    let accessToken: string | null = null;
    let webhookId = setup.webhookId;
    try {
      accessToken = await freshAccessToken(ctx, setup.credentialId);
      if (webhookId === undefined) {
        const passcode = randomBytes(32).toString("base64url");
        const webhook = await figmaRequest(
          accessToken,
          "/v2/webhooks",
          webhookResponse,
          {
            method: "POST",
            body: JSON.stringify({
              event_type: "FILE_UPDATE",
              context: "file",
              context_id: setup.fileKey,
              endpoint,
              passcode,
              status: "PAUSED",
              description: "Code2Create project file",
            }),
            timeoutMs: 30_000,
          },
        );
        webhookId = webhook.id;
        const attachment: { attached: boolean } = await ctx.runMutation(
          internal.figmaIntegrations.attachWebhook,
          {
            bindingId: setup.bindingId,
            leaseId: args.leaseId,
            webhookId,
            passcodeDigest: opaqueDigest(passcode),
          },
        );
        if (!attachment.attached) {
          await removeWebhook(accessToken, webhookId);
          return null;
        }
      }
      await figmaRequest(
        accessToken,
        `/v2/webhooks/${encodeURIComponent(webhookId)}`,
        webhookResponse,
        {
          method: "PUT",
          body: JSON.stringify({ status: "ACTIVE" }),
          timeoutMs: 30_000,
        },
      );
    } catch (error) {
      if (accessToken !== null && webhookId !== undefined) {
        await removeWebhook(accessToken, webhookId);
      }
      const unavailable = error instanceof FigmaHttpError && error.status === 403;
      await ctx.runMutation(internal.figmaIntegrations.failWebhookSetup, {
        bindingId: setup.bindingId,
        leaseId: args.leaseId,
        ...(webhookId !== undefined ? { expectedWebhookId: webhookId } : {}),
        state: unavailable ? "unavailable" : "error",
      });
      if (!unavailable) throw error;
      return null;
    }
    if (webhookId === undefined) {
      throw new Error("Figma webhook activation completed without a webhook ID.");
    }
    await ctx.runMutation(internal.figmaIntegrations.finishWebhookSetup, {
      bindingId: setup.bindingId,
      leaseId: args.leaseId,
      webhookId,
    });
    return null;
  },
});

export const addFile = action({
  args: {
    eventSlug: v.string(),
    credentialConnectionId: v.id("figmaCredentialConnections"),
    fileUrl: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ bindingId: v.id("figmaFileBindings") }),
  handler: async (ctx, args): Promise<{ bindingId: Id<"figmaFileBindings"> }> => {
    const location = parseFigmaFileLocation(args.fileUrl);
    const prior = await ctx.runQuery(internal.figmaIntegrations.fileAddReceipt, {
      eventSlug: args.eventSlug,
      credentialConnectionId: args.credentialConnectionId,
      fileKey: location.fileKey,
      clientOperationId: args.clientOperationId,
    });
    if (prior) return prior;
    const connection: ConnectionContext = await ctx.runQuery(
      internal.figmaIntegrations.connectionContext,
      {
        eventSlug: args.eventSlug,
        credentialConnectionId: args.credentialConnectionId,
        requireLiveEvent: true,
        serverNow: Date.now(),
      },
    );
    let accessToken: string;
    let capture: FileCapture;
    try {
      accessToken = await freshAccessToken(ctx, connection.credentialId);
      capture = await captureFile(accessToken, location.fileKey);
    } catch (error) {
      throw providerFacingError(error);
    }
    const result: { bindingId: Id<"figmaFileBindings"> } = await ctx.runMutation(
      internal.figmaIntegrations.commitFile,
      {
        eventSlug: args.eventSlug,
        credentialConnectionId: args.credentialConnectionId,
        integrationPolicyId: connection.integrationPolicyId,
        fileKey: location.fileKey,
        ...(capture.mainFileKey !== undefined ? { mainFileKey: capture.mainFileKey } : {}),
        url: location.url,
        name: capture.name,
        role: capture.role,
        linkAccess: capture.linkAccess,
        editorType: capture.editorType,
        versionId: capture.versionId,
        lastTouchedAt: capture.lastTouchedAt,
        providerObservedAt: capture.providerObservedAt,
        ...(capture.thumbnailUrl !== undefined ? { thumbnailUrl: capture.thumbnailUrl } : {}),
        metrics: capture.metrics,
        activity: capture.activity,
        previewPlan: capture.previewPlan,
        artifact: await storeFigmaFileArtifact({
          eventId: connection.eventId,
          teamId: connection.teamId,
          fileKey: location.fileKey,
          providerVersionId: capture.versionId,
          rawJson: capture.rawJson,
        }),
        clientOperationId: args.clientOperationId,
      },
    );
    return result;
  },
});

export const reconcileFile = internalAction({
  args: { bindingId: v.id("figmaFileBindings") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const leaseId = randomUUID();
    const sync: FileSyncContext | null = await ctx.runMutation(
      internal.figmaIntegrations.beginFileSync,
      { bindingId: args.bindingId, leaseId },
    );
    if (!sync) return null;
    try {
      const accessToken = await freshAccessToken(ctx, sync.credentialId);
      const capture = await captureFile(accessToken, sync.fileKey);
      const artifact: StoredArtifact = await storeFigmaFileArtifact({
        eventId: sync.eventId,
        teamId: sync.teamId,
        fileKey: sync.fileKey,
        providerVersionId: capture.versionId,
        rawJson: capture.rawJson,
      });
      await ctx.runMutation(internal.figmaIntegrations.finishFileSync, {
        bindingId: sync.bindingId,
        leaseId,
        syncRevision: sync.syncRevision,
        name: capture.name,
        role: capture.role,
        linkAccess: capture.linkAccess,
        editorType: capture.editorType,
        versionId: capture.versionId,
        lastTouchedAt: capture.lastTouchedAt,
        providerObservedAt: capture.providerObservedAt,
        ...(capture.thumbnailUrl !== undefined ? { thumbnailUrl: capture.thumbnailUrl } : {}),
        metrics: capture.metrics,
        activity: capture.activity,
        previewPlan: capture.previewPlan,
        artifact,
      });
    } catch (error) {
      const failure = providerFailure(error);
      await ctx.runMutation(internal.figmaIntegrations.failFileSync, {
        bindingId: sync.bindingId,
        leaseId,
        state: failure.state,
        errorCode: failure.code,
        ...(failure.retryAt !== undefined ? { retryAt: failure.retryAt } : {}),
        ...(failure.planTier !== undefined ? { planTier: failure.planTier } : {}),
        ...(failure.rateLimitType !== undefined
          ? { rateLimitType: failure.rateLimitType }
          : {}),
      });
      if (failure.retryAt !== undefined) {
        await ctx.scheduler.runAt(failure.retryAt, internal.figmaActions.reconcileFile, {
          bindingId: sync.bindingId,
        });
      }
    }
    return null;
  },
});

export const checkFileMetadata = internalAction({
  args: { bindingId: v.id("figmaFileBindings") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const leaseId = randomUUID();
    const check: FileMetadataCheckContext | null = await ctx.runMutation(
      internal.figmaIntegrations.beginMetadataCheck,
      { bindingId: args.bindingId, leaseId },
    );
    if (!check) return null;
    try {
      const accessToken = await freshAccessToken(ctx, check.credentialId);
      const response = await figmaRequest(
        accessToken,
        `/v1/files/${encodeURIComponent(check.fileKey)}/meta`,
        fileMetadataResponse,
        { timeoutMs: 30_000 },
        1024 * 1024,
      );
      const providerObservedAt = Date.now();
      await ctx.runMutation(internal.figmaIntegrations.finishMetadataCheck, {
        bindingId: check.bindingId,
        leaseId,
        name: response.file.name,
        role: response.file.role,
        linkAccess: response.file.link_access,
        editorType: response.file.editorType,
        versionId: response.file.version,
        lastTouchedAt: parseProviderTime(response.file.last_touched_at),
        thumbnailUrl: response.file.thumbnail_url,
        providerObservedAt,
      });
    } catch (error) {
      const failure = providerFailure(error);
      await ctx.runMutation(internal.figmaIntegrations.failMetadataCheck, {
        bindingId: check.bindingId,
        leaseId,
        state: failure.state,
        errorCode: failure.code,
        ...(failure.retryAt !== undefined ? { retryAt: failure.retryAt } : {}),
        ...(failure.planTier !== undefined ? { planTier: failure.planTier } : {}),
        ...(failure.rateLimitType !== undefined
          ? { rateLimitType: failure.rateLimitType }
          : {}),
      });
    }
    return null;
  },
});

async function renderPreviewResults(
  accessToken: string,
  claim: PreviewRenderClaim,
): Promise<PreviewRenderResult[]> {
  const query = new URLSearchParams({
    ids: claim.nodes.map((node) => node.nodeId).join(","),
    format: "png",
    scale: previewScale,
    contents_only: "true",
    version: claim.providerVersionId,
  });
  const rendered = await figmaRequest(
    accessToken,
    `/v1/images/${encodeURIComponent(claim.fileKey)}?${query.toString()}`,
    renderedImagesResponse,
  );
  const results: PreviewRenderResult[] = [];
  let acceptedBytes = 0;
  for (
    let offset = 0;
    offset < claim.nodes.length;
    offset += previewDownloadParallelism
  ) {
    const group = claim.nodes.slice(offset, offset + previewDownloadParallelism);
    const downloads = await Promise.all(
      group.map(async (node) => {
        const renderedUrl = rendered.images[node.nodeId];
        if (!renderedUrl) {
          return {
            factId: node.factId,
            nodeId: node.nodeId,
            state: "failed" as const,
            failureCode: "provider_render_failed",
          };
        }
        try {
          return {
            factId: node.factId,
            nodeId: node.nodeId,
            state: "downloaded" as const,
            bytes: await downloadFigmaPreview(renderedUrl, maximumPreviewBytes),
          };
        } catch (error) {
          return {
            factId: node.factId,
            nodeId: node.nodeId,
            state: "failed" as const,
            failureCode:
              error instanceof FigmaPreviewDownloadError
                ? error.code
                : "preview_download_failed",
          };
        }
      }),
    );
    const uploadable = downloads.flatMap((download) => {
      if (download.state === "failed") {
        results.push({
          factId: download.factId,
          state: "failed",
          failureCode: download.failureCode,
        });
        return [];
      }
      if (acceptedBytes + download.bytes.byteLength > maximumPreviewSetBytes) {
        results.push({
          factId: download.factId,
          state: "failed",
          failureCode: "preview_set_limit",
        });
        return [];
      }
      acceptedBytes += download.bytes.byteLength;
      return [download];
    });
    const stored = await Promise.all(
      uploadable.map(async (download): Promise<PreviewRenderResult> => {
        try {
          return {
            factId: download.factId,
            state: "available",
            artifact: await storeFigmaPreviewArtifact({
              eventId: claim.eventId,
              teamId: claim.teamId,
              fileKey: claim.fileKey,
              providerVersionId: claim.providerVersionId,
              nodeId: download.nodeId,
              png: download.bytes,
            }),
          };
        } catch {
          return {
            factId: download.factId,
            state: "failed",
            failureCode: "preview_store_failed",
          };
        }
      }),
    );
    results.push(...stored);
  }
  return results;
}

export const renderSnapshotPreviews = internalAction({
  args: { previewSetId: v.id("figmaPreviewSets") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const leaseId = randomUUID();
    const claim: PreviewRenderClaim | null = await ctx.runMutation(
      internal.figmaIntegrations.claimPreviewRender,
      { previewSetId: args.previewSetId, leaseId },
    );
    if (!claim) return null;
    try {
      const accessToken = await freshAccessToken(ctx, claim.credentialId);
      const results = await renderPreviewResults(accessToken, claim);
      await ctx.runMutation(internal.figmaIntegrations.finishPreviewRender, {
        previewSetId: claim.previewSetId,
        leaseId,
        results,
      });
    } catch (error) {
      const failure = providerFailure(error);
      await ctx.runMutation(internal.figmaIntegrations.failPreviewRender, {
        previewSetId: claim.previewSetId,
        leaseId,
        state: failure.state,
        errorCode: failure.code,
        ...(failure.retryAt !== undefined ? { retryAt: failure.retryAt } : {}),
      });
    }
    return null;
  },
});

export const openFullCheckpoint = action({
  args: { eventSlug: v.string(), bindingId: v.id("figmaFileBindings") },
  returns: v.object({
    url: v.string(),
    expiresAt: v.number(),
    serverNow: v.number(),
    sha256: v.string(),
    capturedAt: v.number(),
  }),
  handler: async (
    ctx: ActionCtx,
    args: { eventSlug: string; bindingId: Id<"figmaFileBindings"> },
  ): Promise<OpenFullCheckpointResult> => {
    const artifact: ArtifactAccessContext = await ctx.runQuery(
      internal.figmaIntegrations.artifactAccessContext,
      args,
    );
    const expiresAt = Date.now() + 60_000;
    const url = await signArtifactDownload({
      objectKey: artifact.objectKey,
      storageRegion: artifact.storageRegion,
      storageBucket: artifact.storageBucket,
    });
    const access: ArtifactAccessReceipt = await ctx.runMutation(
      internal.figmaIntegrations.recordArtifactAccess,
      {
        ...args,
        snapshotId: artifact.snapshotId,
        artifactId: artifact.artifactId,
        expectedObjectKey: artifact.objectKey,
        expectedStorageRegion: artifact.storageRegion,
        expectedStorageBucket: artifact.storageBucket,
        expectedSha256: artifact.sha256,
        expectedCapturedAt: artifact.capturedAt,
        signedUrlExpiresAt: expiresAt,
      },
    );
    return {
      url,
      expiresAt,
      serverNow: access.serverNow,
      sha256: artifact.sha256,
      capturedAt: artifact.capturedAt,
    };
  },
});

type WebhookCleanupContext = {
  bindingId: Id<"figmaFileBindings">;
  credentialId: Id<"figmaOAuthCredentials">;
  webhookId: string;
};

export const removeArchivedWebhook = internalAction({
  args: { bindingId: v.id("figmaFileBindings") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const cleanup: WebhookCleanupContext | null = await ctx.runQuery(
      internal.figmaIntegrations.webhookCleanupContext,
      { bindingId: args.bindingId },
    );
    if (!cleanup) return null;
    try {
      const accessToken = await freshAccessToken(ctx, cleanup.credentialId);
      await figmaRequest(
        accessToken,
        `/v2/webhooks/${encodeURIComponent(cleanup.webhookId)}`,
        webhookResponse,
        { method: "DELETE" },
      );
      await ctx.runMutation(internal.figmaIntegrations.finishWebhookCleanup, {
        bindingId: cleanup.bindingId,
        webhookId: cleanup.webhookId,
      });
    } catch (error) {
      if (error instanceof FigmaHttpError && error.status === 404) {
        await ctx.runMutation(internal.figmaIntegrations.finishWebhookCleanup, {
          bindingId: cleanup.bindingId,
          webhookId: cleanup.webhookId,
        });
      } else {
        const failure = providerFailure(error);
        if (failure.retryAt !== undefined) {
          await ctx.scheduler.runAt(
            failure.retryAt,
            internal.figmaActions.removeArchivedWebhook,
            { bindingId: cleanup.bindingId },
          );
        }
      }
    }
    return null;
  },
});

export type FigmaCredentialConnectionId = Id<"figmaCredentialConnections">;
