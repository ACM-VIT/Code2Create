import { ConvexError, v, type Infer } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  figmaMetadataDispatchBatchSize,
  figmaMetadataDispatchRecoveryMs,
  figmaMetadataLeaseDurationMs,
  nextFigmaMetadataCheckAt,
  nextFigmaMetadataFailureCheckAt,
  shouldAcceptFigmaObservation,
} from "./lib/figmaMetadataSchedule";
import { refreshFigmaTeamMetrics } from "./lib/figmaTeamMetrics";
import {
  integrationProviderFrozenAt,
  loadPublishedIntegrationPolicy,
} from "./lib/integrationPolicy";
import {
  findCurrentPerson,
  requireCurrentPerson,
  requireEventSubject,
  requireMembership,
} from "./lib/identity";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { appendFigmaIntegrationReadFactById } from "./lib/operationsAutonomyReadFacts/integrationJobs";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { normalizedText } from "./lib/strings";
import {
  eventStatus,
  figmaCredentialConnectionState,
  figmaCredentialState,
  figmaFileBindingState,
  figmaFileSyncState,
  figmaWebhookState,
  integrationMetricCompleteness,
  integrationProviderHealth,
  teamStatus,
} from "./values";
import { integrationWorkpool } from "./workpools";

type ReadCtx = QueryCtx | MutationCtx;
const maximumPreviewNodes = 48;
const maximumCapturedVersions = 200;
const maximumCapturedComments = 400;
const figmaWebhookSetupDispatchBatchSize = 32;
const figmaWebhookSetupLeaseDurationMs = 3 * 60 * 1_000;

const artifactInput = v.object({
  objectKey: v.string(),
  storageRegion: v.string(),
  storageBucket: v.string(),
  uncompressedBytes: v.number(),
  storedBytes: v.number(),
  sha256: v.string(),
});
type ArtifactInput = Infer<typeof artifactInput>;
const previewCandidateInput = v.object({
  pageId: v.string(),
  pageName: v.string(),
  pageOrder: v.number(),
  nodeId: v.string(),
  nodeName: v.string(),
  nodeType: v.string(),
  nodeOrder: v.number(),
  descendantCount: v.number(),
  semanticHash: v.string(),
  sourceWidth: v.optional(v.number()),
  sourceHeight: v.optional(v.number()),
});
const previewPlanInput = v.object({
  discoveredNodeCount: v.number(),
  truncated: v.boolean(),
  candidates: v.array(previewCandidateInput),
});
type PreviewPlanInput = Infer<typeof previewPlanInput>;
const previewArtifactInput = v.object({
  objectKey: v.string(),
  storageRegion: v.string(),
  storageBucket: v.string(),
  contentType: v.literal("image/png"),
  byteCount: v.number(),
  sha256: v.string(),
  width: v.number(),
  height: v.number(),
});
const previewRenderResultInput = v.union(
  v.object({
    factId: v.id("figmaNodeFacts"),
    state: v.literal("available"),
    artifact: previewArtifactInput,
  }),
  v.object({
    factId: v.id("figmaNodeFacts"),
    state: v.literal("failed"),
    failureCode: v.string(),
  }),
);
type PreviewRenderResultInput = Infer<typeof previewRenderResultInput>;

async function currentTeamContext(ctx: ReadCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const membership = await requireMembership(ctx, event._id, person._id);
  const member = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index
        .eq("eventId", event._id)
        .eq("membershipId", membership._id)
        .eq("status", "active"),
    )
    .unique();
  if (!member) {
    throw new ConvexError({ code: "TEAM_REQUIRED", message: "Create or join a team first." });
  }
  const team = await ctx.db.get(member.teamId);
  if (!team) throw new Error("Team membership references a missing team.");
  return { event, person, subject, membership, member, team };
}

async function requirePublishedPolicy(ctx: ReadCtx, event: Doc<"events">) {
  return (await loadPublishedIntegrationPolicy(ctx, event)).policy;
}

function requireAdmittedTeam(team: Doc<"teams">) {
  if (
    !["admitted", "confirmed", "checked_in", "active", "completed"].some(
      (status) => status === team.status,
    )
  ) {
    throw new ConvexError({
      code: "TEAM_NOT_ADMITTED",
      message: "Figma opens after the team is accepted.",
    });
  }
}

function requireFigmaWindow(
  event: Doc<"events">,
  team: Doc<"teams">,
  policy: Doc<"integrationPolicyVersions">,
  requireLiveEvent: boolean,
  serverNow: number,
) {
  requireAdmittedTeam(team);
  if (requireLiveEvent && event.status !== "live") {
    throw new ConvexError({
      code: "BUILD_NOT_STARTED",
      message: "Figma files can be added after the official build start.",
    });
  }
  if (integrationProviderFrozenAt(policy, "figma", serverNow)) {
    throw new ConvexError({
      code: "FIGMA_FROZEN",
      message: "Figma file changes are frozen for this event.",
    });
  }
}

function figmaFileAddOperationFingerprint(args: {
  credentialConnectionId: Id<"figmaCredentialConnections">;
  fileKey: string;
}) {
  return operationFingerprint([args.credentialConnectionId, args.fileKey]);
}

function figmaEnvironmentConfigured() {
  return Boolean(
    process.env.FIGMA_CLIENT_ID?.trim() &&
      process.env.FIGMA_CLIENT_SECRET?.trim() &&
      process.env.PROVIDER_TOKEN_ENCRYPTION_KEY_VERSION?.trim() &&
      process.env.PROVIDER_TOKEN_ENCRYPTION_KEY?.trim() &&
      process.env.PARTICIPANT_SITE_URL?.trim() &&
      process.env.CONVEX_SITE_URL?.trim() &&
      process.env.ARTIFACT_S3_REGION?.trim() === "ap-south-1" &&
      process.env.ARTIFACT_S3_BUCKET?.trim() &&
      process.env.ARTIFACT_S3_ACCESS_KEY_ID?.trim() &&
      process.env.ARTIFACT_S3_SECRET_ACCESS_KEY?.trim() &&
      process.env.ARTIFACT_S3_KMS_KEY_ID?.trim(),
  );
}

const currentView = v.union(
  v.null(),
  v.object({
    eventStatus,
    teamId: v.id("teams"),
    teamStatus,
    canManage: v.boolean(),
    figmaConfigured: v.boolean(),
    policy: v.union(
      v.null(),
      v.object({
        id: v.id("integrationPolicyVersions"),
        policyVersion: v.string(),
        maxActiveFiles: v.number(),
        figmaFreezeAt: v.optional(v.number()),
      }),
    ),
    connections: v.array(
      v.object({
        id: v.id("figmaCredentialConnections"),
        state: figmaCredentialConnectionState,
        credentialState: figmaCredentialState,
        lastVerifiedAt: v.number(),
        version: v.number(),
      }),
    ),
    summary: v.union(
      v.null(),
      v.object({
        health: integrationProviderHealth,
        authorizationCount: v.number(),
        fileCount: v.number(),
        completeFileCount: v.number(),
        incompleteFileCount: v.number(),
        dirtyCount: v.number(),
        webhookActiveCount: v.number(),
        webhookUnavailableCount: v.number(),
        rateLimitedCount: v.number(),
        previewReadyCount: v.number(),
        previewPendingCount: v.number(),
        previewAttentionCount: v.number(),
        selectedPreviewCount: v.number(),
        availablePreviewCount: v.number(),
        pageCount: v.number(),
        frameCount: v.number(),
        componentCount: v.number(),
        componentSetCount: v.number(),
        styleCount: v.number(),
        nodeCount: v.number(),
        prototypeInteractionCount: v.number(),
        commentCount: v.number(),
        unresolvedCommentCount: v.number(),
        versionCount: v.number(),
        completeness: integrationMetricCompleteness,
        oldestMetadataCheckAt: v.optional(v.number()),
        lastCaptureAt: v.optional(v.number()),
        lastActivityAt: v.optional(v.number()),
        version: v.number(),
        updatedAt: v.number(),
      }),
    ),
    files: v.array(
      v.object({
        id: v.id("figmaFileBindings"),
        credentialConnectionId: v.id("figmaCredentialConnections"),
        fileKey: v.string(),
        mainFileKey: v.optional(v.string()),
        url: v.string(),
        name: v.string(),
        role: v.string(),
        linkAccess: v.string(),
        editorType: v.string(),
        versionId: v.string(),
        observedVersionId: v.optional(v.string()),
        lastTouchedAt: v.number(),
        state: figmaFileBindingState,
        webhookState: figmaWebhookState,
        lastProviderEventAt: v.optional(v.number()),
        lastMetadataCheckAt: v.number(),
        nextMetadataCheckAt: v.optional(v.number()),
        metadataErrorCode: v.optional(v.string()),
        metadataRateLimitRetryAt: v.optional(v.number()),
        metadataRateLimitPlanTier: v.optional(v.string()),
        metadataRateLimitType: v.optional(v.string()),
        lastFullCaptureAt: v.number(),
        contentDirty: v.boolean(),
        rateLimitRetryAt: v.optional(v.number()),
        rateLimitPlanTier: v.optional(v.string()),
        rateLimitType: v.optional(v.string()),
        syncState: figmaFileSyncState,
        syncErrorCode: v.optional(v.string()),
        hasFullArtifact: v.boolean(),
        artifactCapturedAt: v.optional(v.number()),
        version: v.number(),
        metrics: v.object({
          pageCount: v.number(),
          frameCount: v.number(),
          componentCount: v.number(),
          componentSetCount: v.number(),
          styleCount: v.number(),
          nodeCount: v.number(),
          prototypeInteractionCount: v.number(),
          commentCount: v.number(),
          unresolvedCommentCount: v.number(),
          versionCount: v.number(),
          completeness: integrationMetricCompleteness,
          capturedAt: v.number(),
        }),
      }),
    ),
  }),
);

export const current = query({
  args: { eventSlug: v.string() },
  returns: currentView,
  handler: async (ctx, args) => {
    const person = await findCurrentPerson(ctx);
    if (!person) return null;
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const membership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (!membership) return null;
    const member = await ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("membershipId", membership._id)
          .eq("status", "active"),
      )
      .unique();
    if (!member) return null;
    const [team, subject] = await Promise.all([
      ctx.db.get(member.teamId),
      ctx.db.get(membership.eventAccessSubjectId),
    ]);
    if (!team || !subject || subject.status !== "active") return null;
    const readGrantIds = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.read",
      scopeType: "team",
      scopeId: team._id,
    });
    if (readGrantIds.length === 0) return null;
    const [policy, connections, bindings, teamMetric, manageGrantIds] = await Promise.all([
      event.publishedIntegrationPolicyId
        ? loadPublishedIntegrationPolicy(ctx, event).then((result) => result.policy)
        : Promise.resolve(null),
      ctx.db
        .query("figmaCredentialConnections")
        .withIndex("by_team_state", (index) => index.eq("teamId", team._id))
        .collect(),
      ctx.db
        .query("figmaFileBindings")
        .withIndex("by_team_state", (index) => index.eq("teamId", team._id))
        .collect(),
      ctx.db
        .query("figmaTeamMetrics")
        .withIndex("by_team", (index) => index.eq("teamId", team._id))
        .unique(),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "integration.figma.manage",
        scopeType: "team",
        scopeId: team._id,
      }),
    ]);
    const visibleBindings = bindings.filter((binding) => binding.state !== "archived");
    const [credentials, metrics, snapshots] = await Promise.all([
      Promise.all(connections.map((connection) => ctx.db.get(connection.credentialId))),
      Promise.all(
        visibleBindings.map((binding) =>
          ctx.db
            .query("figmaFileMetrics")
            .withIndex("by_binding", (index) => index.eq("figmaFileBindingId", binding._id))
            .unique(),
        ),
      ),
      Promise.all(
        visibleBindings.map((binding) =>
          ctx.db
            .query("figmaFileSnapshots")
            .withIndex("by_binding_time", (index) =>
              index.eq("figmaFileBindingId", binding._id),
            )
            .order("desc")
            .first(),
        ),
      ),
    ]);
    if (
      teamMetric &&
      (teamMetric.eventId !== event._id ||
        teamMetric.teamId !== team._id ||
        teamMetric.fileCount !== visibleBindings.length)
    ) {
      throw new Error("The Figma team summary does not match its file set.");
    }
    if ((connections.length > 0 || visibleBindings.length > 0) && !teamMetric) {
      throw new Error("A connected Figma team has no metrics summary.");
    }
    if (metrics.some((metric) => metric === null) || snapshots.some((snapshot) => snapshot === null)) {
      throw new Error("A Figma file has no complete evidence projection.");
    }
    const resolvedMetrics = metrics.filter((metric) => metric !== null);
    const resolvedSnapshots = snapshots.filter((snapshot) => snapshot !== null);
    return {
      eventStatus: event.status,
      teamId: team._id,
      teamStatus: team.status,
      canManage: manageGrantIds.length > 0,
      figmaConfigured: figmaEnvironmentConfigured(),
      policy:
        policy && policy.eventId === event._id && policy.status === "published"
          ? {
              id: policy._id,
              policyVersion: policy.policyVersion,
              maxActiveFiles: policy.maxActiveFigmaFilesPerTeam,
              ...(policy.figmaFreezeAt !== undefined ? { figmaFreezeAt: policy.figmaFreezeAt } : {}),
            }
          : null,
      connections: connections.map((connection, index) => {
        const credential = credentials[index];
        if (!credential) {
          throw new Error("A Figma connection references a missing credential.");
        }
        return {
          id: connection._id,
          state: connection.state,
          credentialState: credential.status,
          lastVerifiedAt: connection.lastVerifiedAt,
          version: connection.version,
        };
      }),
      summary: teamMetric
        ? {
            health: teamMetric.health,
            authorizationCount: teamMetric.authorizationCount,
            fileCount: teamMetric.fileCount,
            completeFileCount: teamMetric.completeFileCount,
            incompleteFileCount: teamMetric.incompleteFileCount,
            dirtyCount: teamMetric.dirtyCount,
            webhookActiveCount: teamMetric.webhookActiveCount,
            webhookUnavailableCount: teamMetric.webhookUnavailableCount,
            rateLimitedCount: teamMetric.rateLimitedCount,
            previewReadyCount: teamMetric.previewReadyCount,
            previewPendingCount: teamMetric.previewPendingCount,
            previewAttentionCount: teamMetric.previewAttentionCount,
            selectedPreviewCount: teamMetric.selectedPreviewCount,
            availablePreviewCount: teamMetric.availablePreviewCount,
            pageCount: teamMetric.pageCount,
            frameCount: teamMetric.frameCount,
            componentCount: teamMetric.componentCount,
            componentSetCount: teamMetric.componentSetCount,
            styleCount: teamMetric.styleCount,
            nodeCount: teamMetric.nodeCount,
            prototypeInteractionCount: teamMetric.prototypeInteractionCount,
            commentCount: teamMetric.commentCount,
            unresolvedCommentCount: teamMetric.unresolvedCommentCount,
            versionCount: teamMetric.versionCount,
            completeness: teamMetric.completeness,
            ...(teamMetric.oldestMetadataCheckAt !== undefined
              ? { oldestMetadataCheckAt: teamMetric.oldestMetadataCheckAt }
              : {}),
            ...(teamMetric.lastCaptureAt !== undefined
              ? { lastCaptureAt: teamMetric.lastCaptureAt }
              : {}),
            ...(teamMetric.lastActivityAt !== undefined
              ? { lastActivityAt: teamMetric.lastActivityAt }
              : {}),
            version: teamMetric.version,
            updatedAt: teamMetric.updatedAt,
          }
        : null,
      files: visibleBindings.map((binding, index) => {
        const metric = resolvedMetrics[index];
        const snapshot = resolvedSnapshots[index];
        if (!metric || !snapshot) throw new Error("A validated Figma file projection is missing.");
        return {
          id: binding._id,
          credentialConnectionId: binding.credentialConnectionId,
          fileKey: binding.fileKey,
          ...(binding.mainFileKey !== undefined ? { mainFileKey: binding.mainFileKey } : {}),
          url: binding.url,
          name: binding.name,
          role: binding.role,
          linkAccess: binding.linkAccess,
          editorType: binding.editorType,
          versionId: binding.versionId,
          ...(binding.observedVersionId !== undefined
            ? { observedVersionId: binding.observedVersionId }
            : {}),
          lastTouchedAt: binding.lastTouchedAt,
          state: binding.state,
          webhookState: binding.webhookState,
          ...(binding.lastProviderEventAt !== undefined
            ? { lastProviderEventAt: binding.lastProviderEventAt }
            : {}),
          lastMetadataCheckAt: binding.lastMetadataCheckAt,
          ...(binding.nextMetadataCheckAt !== undefined
            ? { nextMetadataCheckAt: binding.nextMetadataCheckAt }
            : {}),
          ...(binding.metadataErrorCode !== undefined
            ? { metadataErrorCode: binding.metadataErrorCode }
            : {}),
          ...(binding.metadataRateLimitRetryAt !== undefined
            ? { metadataRateLimitRetryAt: binding.metadataRateLimitRetryAt }
            : {}),
          ...(binding.metadataRateLimitPlanTier !== undefined
            ? { metadataRateLimitPlanTier: binding.metadataRateLimitPlanTier }
            : {}),
          ...(binding.metadataRateLimitType !== undefined
            ? { metadataRateLimitType: binding.metadataRateLimitType }
            : {}),
          lastFullCaptureAt: binding.lastFullCaptureAt,
          contentDirty: binding.contentDirty,
          ...(binding.rateLimitRetryAt !== undefined
            ? { rateLimitRetryAt: binding.rateLimitRetryAt }
            : {}),
          ...(binding.rateLimitPlanTier !== undefined
            ? { rateLimitPlanTier: binding.rateLimitPlanTier }
            : {}),
          ...(binding.rateLimitType !== undefined
            ? { rateLimitType: binding.rateLimitType }
            : {}),
          syncState: binding.syncState,
          ...(binding.syncErrorCode !== undefined
            ? { syncErrorCode: binding.syncErrorCode }
            : {}),
          hasFullArtifact: snapshot?.artifactId !== undefined,
          ...(snapshot.artifactId !== undefined
            ? { artifactCapturedAt: snapshot.capturedAt }
            : {}),
          version: binding.version,
          metrics: {
            pageCount: metric.pageCount,
            frameCount: metric.frameCount,
            componentCount: metric.componentCount,
            componentSetCount: metric.componentSetCount,
            styleCount: metric.styleCount,
            nodeCount: metric.nodeCount,
            prototypeInteractionCount: metric.prototypeInteractionCount,
            commentCount: metric.commentCount,
            unresolvedCommentCount: metric.unresolvedCommentCount,
            versionCount: metric.versionCount,
            completeness: metric.completeness,
            capturedAt: metric.capturedAt,
          },
        };
      }),
    };
  },
});

export const createSetupIntent = internalMutation({
  args: {
    eventSlug: v.string(),
    stateDigest: v.string(),
    pkceVerifierCiphertext: v.string(),
    redirectUri: v.string(),
  },
  returns: v.object({ intentId: v.id("figmaSetupIntents") }),
  handler: async (ctx, args) => {
    const { event, person, subject, team } = await currentTeamContext(ctx, args.eventSlug);
    const policy = await requirePublishedPolicy(ctx, event);
    requireFigmaWindow(event, team, policy, false, Date.now());
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.figma.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    const collision = await ctx.db
      .query("figmaSetupIntents")
      .withIndex("by_state_digest", (index) => index.eq("stateDigest", args.stateDigest))
      .unique();
    if (collision) throw new Error("Figma setup state collision.");
    const now = Date.now();
    const intentId = await ctx.db.insert("figmaSetupIntents", {
      eventId: event._id,
      teamId: team._id,
      personId: person._id,
      stateDigest: args.stateDigest,
      pkceVerifierCiphertext: args.pkceVerifierCiphertext,
      redirectUri: args.redirectUri,
      status: "pending",
      expiresAt: now + 10 * 60 * 1_000,
      createdAt: now,
    });
    return { intentId };
  },
});

const setupClaim = v.union(
  v.object({
    kind: v.literal("verify"),
    intentId: v.id("figmaSetupIntents"),
    pkceVerifierCiphertext: v.string(),
    redirectUri: v.string(),
  }),
  v.object({
    kind: v.literal("completed"),
    credentialConnectionId: v.id("figmaCredentialConnections"),
  }),
);
type SetupClaim = Infer<typeof setupClaim>;

export const claimSetupIntent = internalMutation({
  args: { eventSlug: v.string(), stateDigest: v.string(), attemptId: v.string() },
  returns: setupClaim,
  handler: async (ctx, args): Promise<SetupClaim> => {
    const { event, person, subject, team } = await currentTeamContext(ctx, args.eventSlug);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.figma.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    const intent = await ctx.db
      .query("figmaSetupIntents")
      .withIndex("by_state_digest", (index) => index.eq("stateDigest", args.stateDigest))
      .unique();
    if (!intent || intent.eventId !== event._id || intent.teamId !== team._id || intent.personId !== person._id) {
      throw new ConvexError({ code: "SETUP_INVALID", message: "This Figma setup link is invalid." });
    }
    if (intent.status === "completed" && intent.credentialConnectionId) {
      return { kind: "completed", credentialConnectionId: intent.credentialConnectionId };
    }
    const now = Date.now();
    if (intent.expiresAt <= now) {
      if (intent.status !== "expired") await ctx.db.patch(intent._id, { status: "expired" });
      throw new ConvexError({ code: "SETUP_EXPIRED", message: "Start the Figma connection again." });
    }
    if (intent.status === "verifying" && (intent.claimExpiresAt ?? 0) > now) {
      throw new ConvexError({
        code: "SETUP_IN_PROGRESS",
        message: "This Figma connection is already being verified.",
      });
    }
    if (intent.status === "failed") {
      throw new ConvexError({ code: "SETUP_FAILED", message: "Start the Figma connection again." });
    }
    await ctx.db.patch(intent._id, {
      status: "verifying",
      attemptId: args.attemptId,
      claimExpiresAt: now + 60_000,
    });
    return {
      kind: "verify",
      intentId: intent._id,
      pkceVerifierCiphertext: intent.pkceVerifierCiphertext,
      redirectUri: intent.redirectUri,
    };
  },
});

export const finishSetupIntent = internalMutation({
  args: {
    eventSlug: v.string(),
    intentId: v.id("figmaSetupIntents"),
    attemptId: v.string(),
    figmaUserId: v.string(),
    accessTokenCiphertext: v.string(),
    refreshTokenCiphertext: v.string(),
    tokenExpiresAt: v.number(),
    tokenReceivedAt: v.number(),
    scopes: v.array(v.string()),
  },
  returns: v.object({
    credentialId: v.id("figmaOAuthCredentials"),
    credentialConnectionId: v.id("figmaCredentialConnections"),
  }),
  handler: async (ctx, args) => {
    const { event, person, subject, team } = await currentTeamContext(ctx, args.eventSlug);
    const policy = await requirePublishedPolicy(ctx, event);
    requireFigmaWindow(event, team, policy, false, Date.now());
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.figma.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    const intent = await ctx.db.get(args.intentId);
    if (
      !intent ||
      intent.eventId !== event._id ||
      intent.teamId !== team._id ||
      intent.personId !== person._id ||
      intent.status !== "verifying" ||
      intent.attemptId !== args.attemptId ||
      intent.expiresAt <= Date.now()
    ) {
      throw new ConvexError({ code: "SETUP_STALE", message: "Start the Figma connection again." });
    }
    const now = Date.now();
    const existingCredential = await ctx.db
      .query("figmaOAuthCredentials")
      .withIndex("by_figma_user", (index) => index.eq("figmaUserId", args.figmaUserId))
      .unique();
    let credentialId: Id<"figmaOAuthCredentials">;
    if (existingCredential) {
      credentialId = existingCredential._id;
      if (args.tokenReceivedAt >= existingCredential.tokenReceivedAt) {
        await ctx.db.patch(existingCredential._id, {
          accessTokenCiphertext: args.accessTokenCiphertext,
          refreshTokenCiphertext: args.refreshTokenCiphertext,
          tokenExpiresAt: args.tokenExpiresAt,
          tokenReceivedAt: args.tokenReceivedAt,
          scopes: args.scopes,
          status: "active",
          authorizedByPersonId: person._id,
          refreshLeaseId: undefined,
          refreshLeaseExpiresAt: undefined,
          version: existingCredential.version + 1,
          updatedAt: now,
        });
      }
    } else {
      credentialId = await ctx.db.insert("figmaOAuthCredentials", {
        figmaUserId: args.figmaUserId,
        accessTokenCiphertext: args.accessTokenCiphertext,
        refreshTokenCiphertext: args.refreshTokenCiphertext,
        tokenExpiresAt: args.tokenExpiresAt,
        tokenReceivedAt: args.tokenReceivedAt,
        scopes: args.scopes,
        status: "active",
        authorizedByPersonId: person._id,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
    const existingConnection = await ctx.db
      .query("figmaCredentialConnections")
      .withIndex("by_team_credential", (index) =>
        index.eq("teamId", team._id).eq("credentialId", credentialId),
      )
      .unique();
    let credentialConnectionId: Id<"figmaCredentialConnections">;
    if (existingConnection) {
      credentialConnectionId = existingConnection._id;
      await ctx.db.patch(existingConnection._id, {
        state: "active",
        lastVerifiedAt: now,
        version: existingConnection.version + 1,
      });
    } else {
      credentialConnectionId = await ctx.db.insert("figmaCredentialConnections", {
        eventId: event._id,
        teamId: team._id,
        credentialId,
        state: "active",
        connectedByPersonId: person._id,
        connectedAt: now,
        lastVerifiedAt: now,
        version: 1,
      });
    }
    await ctx.db.patch(intent._id, {
      status: "completed",
      credentialId,
      credentialConnectionId,
      completedAt: now,
      claimExpiresAt: undefined,
    });
    await refreshFigmaTeamMetrics(ctx, { eventId: event._id, teamId: team._id, now });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "integration.figma.manage",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: existingConnection ? "figma.authorization_reconnected" : "figma.authorization_connected",
      targetType: "figma_credential_connection",
      targetId: credentialConnectionId,
      nextSummary: JSON.stringify({ credentialState: "active", scopes: args.scopes }),
      reason: "Connected a Figma authorization to the team",
    });
    return { credentialId, credentialConnectionId };
  },
});

export const failSetupIntent = internalMutation({
  args: { intentId: v.id("figmaSetupIntents"), attemptId: v.string(), failureCode: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.intentId);
    if (intent?.status === "verifying" && intent.attemptId === args.attemptId) {
      await ctx.db.patch(intent._id, {
        status: "failed",
        failureCode: args.failureCode,
        completedAt: Date.now(),
        claimExpiresAt: undefined,
      });
    }
    return null;
  },
});

export const fileAddReceipt = internalQuery({
  args: {
    eventSlug: v.string(),
    credentialConnectionId: v.id("figmaCredentialConnections"),
    fileKey: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({ bindingId: v.id("figmaFileBindings") }),
  ),
  handler: async (ctx, args) => {
    const { event, person, subject, team } = await currentTeamContext(ctx, args.eventSlug);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.figma.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    const priorOperation = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "figma.file.add",
      requestFingerprint: figmaFileAddOperationFingerprint(args),
    });
    if (!priorOperation) return null;
    const bindingId = ctx.db.normalizeId("figmaFileBindings", priorOperation.targetId);
    if (!bindingId) throw new Error("The prior Figma file result is invalid.");
    const binding = await ctx.db.get(bindingId);
    if (!binding || binding.teamId !== team._id) {
      throw new Error("The prior Figma file result is invalid.");
    }
    return { bindingId };
  },
});

export const connectionContext = internalQuery({
  args: {
    eventSlug: v.string(),
    credentialConnectionId: v.id("figmaCredentialConnections"),
    requireLiveEvent: v.boolean(),
    serverNow: v.number(),
  },
  returns: v.object({
    eventId: v.id("events"),
    teamId: v.id("teams"),
    integrationPolicyId: v.id("integrationPolicyVersions"),
    maxActiveFiles: v.number(),
    credentialId: v.id("figmaOAuthCredentials"),
    accessTokenCiphertext: v.string(),
    refreshTokenCiphertext: v.string(),
    tokenExpiresAt: v.number(),
    credentialVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const { event, subject, team } = await currentTeamContext(ctx, args.eventSlug);
    const policy = await requirePublishedPolicy(ctx, event);
    requireFigmaWindow(event, team, policy, args.requireLiveEvent, args.serverNow);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.figma.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    const connection = await ctx.db.get(args.credentialConnectionId);
    if (!connection || connection.teamId !== team._id || connection.state !== "active") {
      throw new ConvexError({
        code: "FIGMA_CONNECTION_UNAVAILABLE",
        message: "Reconnect Figma before continuing.",
      });
    }
    const credential = await ctx.db.get(connection.credentialId);
    if (!credential || credential.status !== "active") {
      throw new ConvexError({
        code: "FIGMA_AUTHORIZATION_UNAVAILABLE",
        message: "Reconnect Figma before continuing.",
      });
    }
    return {
      eventId: event._id,
      teamId: team._id,
      integrationPolicyId: policy._id,
      maxActiveFiles: policy.maxActiveFigmaFilesPerTeam,
      credentialId: credential._id,
      accessTokenCiphertext: credential.accessTokenCiphertext,
      refreshTokenCiphertext: credential.refreshTokenCiphertext,
      tokenExpiresAt: credential.tokenExpiresAt,
      credentialVersion: credential.version,
    };
  },
});

const credentialRefreshClaim = v.union(
  v.object({ kind: v.literal("ready"), accessTokenCiphertext: v.string() }),
  v.object({ kind: v.literal("wait"), retryAt: v.number() }),
  v.object({
    kind: v.literal("refresh"),
    refreshTokenCiphertext: v.string(),
    credentialVersion: v.number(),
  }),
);
type CredentialRefreshClaim = Infer<typeof credentialRefreshClaim>;

export const claimCredentialRefresh = internalMutation({
  args: { credentialId: v.id("figmaOAuthCredentials"), leaseId: v.string() },
  returns: credentialRefreshClaim,
  handler: async (ctx, args): Promise<CredentialRefreshClaim> => {
    const credential = await ctx.db.get(args.credentialId);
    if (!credential || credential.status !== "active") {
      throw new ConvexError({
        code: "FIGMA_AUTHORIZATION_UNAVAILABLE",
        message: "Reconnect Figma before continuing.",
      });
    }
    const now = Date.now();
    if (credential.tokenExpiresAt > now + 5 * 60 * 1_000) {
      return { kind: "ready", accessTokenCiphertext: credential.accessTokenCiphertext };
    }
    if ((credential.refreshLeaseExpiresAt ?? 0) > now) {
      return { kind: "wait", retryAt: credential.refreshLeaseExpiresAt ?? now };
    }
    await ctx.db.patch(credential._id, {
      refreshLeaseId: args.leaseId,
      refreshLeaseExpiresAt: now + 60_000,
    });
    return {
      kind: "refresh",
      refreshTokenCiphertext: credential.refreshTokenCiphertext,
      credentialVersion: credential.version,
    };
  },
});

export const finishCredentialRefresh = internalMutation({
  args: {
    credentialId: v.id("figmaOAuthCredentials"),
    leaseId: v.string(),
    expectedCredentialVersion: v.number(),
    accessTokenCiphertext: v.string(),
    refreshTokenCiphertext: v.optional(v.string()),
    tokenExpiresAt: v.number(),
    tokenReceivedAt: v.number(),
  },
  returns: v.object({ accessTokenCiphertext: v.string() }),
  handler: async (ctx, args) => {
    const credential = await ctx.db.get(args.credentialId);
    if (
      !credential ||
      credential.status !== "active" ||
      credential.version !== args.expectedCredentialVersion ||
      credential.refreshLeaseId !== args.leaseId
    ) {
      throw new ConvexError({
        code: "FIGMA_REFRESH_STALE",
        message: "Figma access changed while it was being refreshed.",
      });
    }
    await ctx.db.patch(credential._id, {
      accessTokenCiphertext: args.accessTokenCiphertext,
      ...(args.refreshTokenCiphertext !== undefined
        ? { refreshTokenCiphertext: args.refreshTokenCiphertext }
        : {}),
      tokenExpiresAt: args.tokenExpiresAt,
      tokenReceivedAt: args.tokenReceivedAt,
      refreshLeaseId: undefined,
      refreshLeaseExpiresAt: undefined,
      version: credential.version + 1,
      updatedAt: Date.now(),
    });
    return { accessTokenCiphertext: args.accessTokenCiphertext };
  },
});

export const failCredentialRefresh = internalMutation({
  args: {
    credentialId: v.id("figmaOAuthCredentials"),
    leaseId: v.string(),
    invalidateCredential: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const credential = await ctx.db.get(args.credentialId);
    if (credential?.refreshLeaseId === args.leaseId) {
      await ctx.db.patch(credential._id, {
        status: args.invalidateCredential ? "error" : credential.status,
        refreshLeaseId: undefined,
        refreshLeaseExpiresAt: undefined,
        version: args.invalidateCredential ? credential.version + 1 : credential.version,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

const fileMetrics = v.object({
  pageCount: v.number(),
  frameCount: v.number(),
  componentCount: v.number(),
  componentSetCount: v.number(),
  styleCount: v.number(),
  nodeCount: v.number(),
  prototypeInteractionCount: v.number(),
  commentCount: v.number(),
  unresolvedCommentCount: v.number(),
  versionCount: v.number(),
  completeness: integrationMetricCompleteness,
});
type FileMetricsInput = Infer<typeof fileMetrics>;

const versionFactInput = v.object({
  versionId: v.string(),
  label: v.string(),
  description: v.string(),
  descriptionTruncated: v.boolean(),
  userId: v.string(),
  userHandle: v.string(),
  providerCreatedAt: v.number(),
  displayOrder: v.number(),
});
const commentFactInput = v.object({
  commentId: v.string(),
  parentCommentId: v.optional(v.string()),
  userId: v.string(),
  userHandle: v.string(),
  message: v.string(),
  messageTruncated: v.boolean(),
  providerCreatedAt: v.number(),
  resolvedAt: v.optional(v.number()),
  orderId: v.optional(v.number()),
  reactionCount: v.number(),
  displayOrder: v.number(),
});
const snapshotActivityInput = v.object({
  versionCount: v.number(),
  versionsComplete: v.boolean(),
  versions: v.array(versionFactInput),
  commentCount: v.number(),
  commentsComplete: v.boolean(),
  replyCount: v.number(),
  resolvedThreadCount: v.number(),
  unresolvedThreadCount: v.number(),
  comments: v.array(commentFactInput),
});
type SnapshotActivityInput = Infer<typeof snapshotActivityInput>;

function validateArtifact(artifact: ArtifactInput) {
  if (
    !artifact.objectKey ||
    !artifact.storageRegion ||
    !artifact.storageBucket ||
    !Number.isSafeInteger(artifact.uncompressedBytes) ||
    artifact.uncompressedBytes < 1 ||
    !Number.isSafeInteger(artifact.storedBytes) ||
    artifact.storedBytes < 1 ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256)
  ) {
    throw new Error("The Figma artifact manifest is invalid.");
  }
}

async function recordFigmaArtifact(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    teamId: Id<"teams">;
    bindingId: Id<"figmaFileBindings">;
    fileKey: string;
    providerVersionId: string;
    artifact: ArtifactInput;
    createdAt: number;
  },
) {
  validateArtifact(args.artifact);
  const existing = await ctx.db
    .query("integrationArtifacts")
    .withIndex("by_object_key", (index) => index.eq("objectKey", args.artifact.objectKey))
    .unique();
  if (existing) {
    if (
      existing.eventId !== args.eventId ||
      existing.teamId !== args.teamId ||
      existing.figmaFileBindingId !== args.bindingId ||
      existing.resourceKey !== args.fileKey ||
      existing.providerVersionId !== args.providerVersionId ||
      existing.storageRegion !== args.artifact.storageRegion ||
      existing.storageBucket !== args.artifact.storageBucket ||
      existing.contentType !== "application/json" ||
      existing.contentEncoding !== "gzip" ||
      existing.uncompressedBytes !== args.artifact.uncompressedBytes ||
      existing.storedBytes !== args.artifact.storedBytes ||
      existing.sha256 !== args.artifact.sha256 ||
      existing.state !== "available"
    ) {
      throw new Error("The Figma artifact key is already used by another manifest.");
    }
    return existing._id;
  }
  return ctx.db.insert("integrationArtifacts", {
    eventId: args.eventId,
    teamId: args.teamId,
    provider: "figma",
    figmaFileBindingId: args.bindingId,
    resourceKey: args.fileKey,
    providerVersionId: args.providerVersionId,
    objectKey: args.artifact.objectKey,
    storageRegion: args.artifact.storageRegion,
    storageBucket: args.artifact.storageBucket,
    contentType: "application/json",
    contentEncoding: "gzip",
    uncompressedBytes: args.artifact.uncompressedBytes,
    storedBytes: args.artifact.storedBytes,
    sha256: args.artifact.sha256,
    state: "available",
    createdAt: args.createdAt,
  });
}

function validatePreviewPlan(plan: PreviewPlanInput) {
  if (
    !Number.isSafeInteger(plan.discoveredNodeCount) ||
    plan.discoveredNodeCount < plan.candidates.length ||
    plan.discoveredNodeCount > 100_000 ||
    plan.candidates.length > maximumPreviewNodes
  ) {
    throw new Error("The Figma preview plan is invalid.");
  }
  const nodeIds = new Set<string>();
  for (const candidate of plan.candidates) {
    if (
      candidate.pageId.length < 1 ||
      candidate.pageId.length > 256 ||
      candidate.pageName.length < 1 ||
      candidate.pageName.length > 1_024 ||
      candidate.nodeId.length < 1 ||
      candidate.nodeId.length > 256 ||
      candidate.nodeName.length < 1 ||
      candidate.nodeName.length > 1_024 ||
      candidate.nodeType.length < 1 ||
      candidate.nodeType.length > 128 ||
      !Number.isSafeInteger(candidate.pageOrder) ||
      candidate.pageOrder < 0 ||
      !Number.isSafeInteger(candidate.nodeOrder) ||
      candidate.nodeOrder < 0 ||
      !Number.isSafeInteger(candidate.descendantCount) ||
      candidate.descendantCount < 0 ||
      !/^[a-f0-9]{64}$/.test(candidate.semanticHash) ||
      nodeIds.has(candidate.nodeId) ||
      (candidate.sourceWidth === undefined) !==
        (candidate.sourceHeight === undefined) ||
      (candidate.sourceWidth !== undefined &&
        (!Number.isFinite(candidate.sourceWidth) || candidate.sourceWidth <= 0)) ||
      (candidate.sourceHeight !== undefined &&
        (!Number.isFinite(candidate.sourceHeight) || candidate.sourceHeight <= 0))
    ) {
      throw new Error("The Figma preview plan is invalid.");
    }
    nodeIds.add(candidate.nodeId);
  }
}

function validateSnapshotActivity(
  activity: SnapshotActivityInput,
  metrics: FileMetricsInput,
) {
  if (
    !Number.isSafeInteger(activity.versionCount) ||
    activity.versionCount < activity.versions.length ||
    activity.versionCount !== metrics.versionCount ||
    activity.versions.length > maximumCapturedVersions ||
    (activity.versionsComplete && activity.versionCount !== activity.versions.length) ||
    !Number.isSafeInteger(activity.commentCount) ||
    activity.commentCount < activity.comments.length ||
    activity.commentCount !== metrics.commentCount ||
    activity.comments.length > maximumCapturedComments ||
    (activity.commentsComplete && activity.commentCount !== activity.comments.length) ||
    !Number.isSafeInteger(activity.replyCount) ||
    activity.replyCount < 0 ||
    !Number.isSafeInteger(activity.resolvedThreadCount) ||
    activity.resolvedThreadCount < 0 ||
    !Number.isSafeInteger(activity.unresolvedThreadCount) ||
    activity.unresolvedThreadCount < 0 ||
    activity.replyCount + activity.resolvedThreadCount + activity.unresolvedThreadCount !==
      activity.commentCount ||
    activity.unresolvedThreadCount !== metrics.unresolvedCommentCount
  ) {
    throw new Error("The Figma activity snapshot is invalid.");
  }
  const versionIds = new Set<string>();
  for (const [displayOrder, version] of activity.versions.entries()) {
    if (
      version.versionId.length < 1 ||
      version.versionId.length > 256 ||
      version.label.length > 500 ||
      version.description.length > 4_000 ||
      version.userId.length < 1 ||
      version.userId.length > 256 ||
      version.userHandle.length > 256 ||
      !Number.isFinite(version.providerCreatedAt) ||
      version.displayOrder !== displayOrder ||
      versionIds.has(version.versionId)
    ) {
      throw new Error("The Figma version activity is invalid.");
    }
    versionIds.add(version.versionId);
  }
  const commentIds = new Set<string>();
  for (const [displayOrder, comment] of activity.comments.entries()) {
    if (
      comment.commentId.length < 1 ||
      comment.commentId.length > 256 ||
      comment.parentCommentId === comment.commentId ||
      (comment.parentCommentId !== undefined && comment.parentCommentId.length > 256) ||
      comment.userId.length < 1 ||
      comment.userId.length > 256 ||
      comment.userHandle.length > 256 ||
      comment.message.length > 4_000 ||
      !Number.isFinite(comment.providerCreatedAt) ||
      (comment.resolvedAt !== undefined && !Number.isFinite(comment.resolvedAt)) ||
      (comment.orderId !== undefined &&
        (!Number.isSafeInteger(comment.orderId) || comment.orderId < 0)) ||
      !Number.isSafeInteger(comment.reactionCount) ||
      comment.reactionCount < 0 ||
      comment.displayOrder !== displayOrder ||
      commentIds.has(comment.commentId)
    ) {
      throw new Error("The Figma comment activity is invalid.");
    }
    commentIds.add(comment.commentId);
  }
}

async function createFigmaSnapshot(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    teamId: Id<"teams">;
    bindingId: Id<"figmaFileBindings">;
    fileKey: string;
    reason: "baseline" | "provider_event" | "manual" | "reconcile";
    providerVersionId: string;
    providerLastTouchedAt: number;
    metrics: FileMetricsInput;
    activity: SnapshotActivityInput;
    artifact: ArtifactInput;
    previewPlan: PreviewPlanInput;
    createdAt: number;
  },
) {
  validatePreviewPlan(args.previewPlan);
  validateSnapshotActivity(args.activity, args.metrics);
  const previousSnapshot = await ctx.db
    .query("figmaFileSnapshots")
    .withIndex("by_binding_time", (index) =>
      index.eq("figmaFileBindingId", args.bindingId),
    )
    .order("desc")
    .first();
  const artifactId = await recordFigmaArtifact(ctx, {
    eventId: args.eventId,
    teamId: args.teamId,
    bindingId: args.bindingId,
    fileKey: args.fileKey,
    providerVersionId: args.providerVersionId,
    artifact: args.artifact,
    createdAt: args.createdAt,
  });
  const snapshotId = await ctx.db.insert("figmaFileSnapshots", {
    eventId: args.eventId,
    teamId: args.teamId,
    figmaFileBindingId: args.bindingId,
    ...(previousSnapshot ? { previousSnapshotId: previousSnapshot._id } : {}),
    reason: args.reason,
    providerVersionId: args.providerVersionId,
    providerLastTouchedAt: args.providerLastTouchedAt,
    ...args.metrics,
    artifactId,
    capturedAt: args.createdAt,
  });
  await ctx.db.insert("figmaSnapshotActivity", {
    eventId: args.eventId,
    teamId: args.teamId,
    figmaFileBindingId: args.bindingId,
    snapshotId,
    providerVersionId: args.providerVersionId,
    versionCount: args.activity.versionCount,
    capturedVersionCount: args.activity.versions.length,
    versionsComplete: args.activity.versionsComplete,
    commentCount: args.activity.commentCount,
    capturedCommentCount: args.activity.comments.length,
    commentsComplete: args.activity.commentsComplete,
    replyCount: args.activity.replyCount,
    resolvedThreadCount: args.activity.resolvedThreadCount,
    unresolvedThreadCount: args.activity.unresolvedThreadCount,
    capturedAt: args.createdAt,
  });
  for (const version of args.activity.versions) {
    await ctx.db.insert("figmaVersionFacts", {
      eventId: args.eventId,
      teamId: args.teamId,
      figmaFileBindingId: args.bindingId,
      snapshotId,
      providerVersionId: args.providerVersionId,
      ...version,
    });
  }
  for (const comment of args.activity.comments) {
    await ctx.db.insert("figmaCommentFacts", {
      eventId: args.eventId,
      teamId: args.teamId,
      figmaFileBindingId: args.bindingId,
      snapshotId,
      providerVersionId: args.providerVersionId,
      ...comment,
    });
  }
  const selectedNodeCount = args.previewPlan.candidates.length;
  const previewSetId = await ctx.db.insert("figmaPreviewSets", {
    eventId: args.eventId,
    teamId: args.teamId,
    figmaFileBindingId: args.bindingId,
    snapshotId,
    providerVersionId: args.providerVersionId,
    state: selectedNodeCount === 0 ? "ready" : "pending",
    discoveredNodeCount: args.previewPlan.discoveredNodeCount,
    selectedNodeCount,
    availableCount: 0,
    failedCount: 0,
    truncated: args.previewPlan.truncated,
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
    ...(selectedNodeCount === 0 ? { completedAt: args.createdAt } : {}),
  });
  const [previousFacts, previousPreviewSet] = previousSnapshot
    ? await Promise.all([
        ctx.db
          .query("figmaNodeFacts")
          .withIndex("by_snapshot_page_order", (index) =>
            index.eq("snapshotId", previousSnapshot._id),
          )
          .collect(),
        ctx.db
          .query("figmaPreviewSets")
          .withIndex("by_snapshot", (index) => index.eq("snapshotId", previousSnapshot._id))
          .unique(),
      ])
    : [[], null];
  const previousHashes = new Map(
    previousFacts.map((fact) => [fact.nodeId, fact.semanticHash]),
  );
  for (const candidate of args.previewPlan.candidates) {
    const previousHash = previousHashes.get(candidate.nodeId);
    const changeState = !previousSnapshot
      ? "new"
      : previousHash === undefined
        ? previousPreviewSet && !previousPreviewSet.truncated
          ? "new"
          : "unknown"
        : previousHash === candidate.semanticHash
          ? "unchanged"
          : "changed";
    await ctx.db.insert("figmaNodeFacts", {
      eventId: args.eventId,
      teamId: args.teamId,
      figmaFileBindingId: args.bindingId,
      snapshotId,
      previewSetId,
      providerVersionId: args.providerVersionId,
      ...candidate,
      changeState,
      render: { state: "pending" },
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
    });
  }
  if (selectedNodeCount > 0) {
    await integrationWorkpool.enqueueAction(
      ctx,
      internal.figmaActions.renderSnapshotPreviews,
      { previewSetId },
      { retry: false },
    );
  }
  return { snapshotId, previewSetId };
}

export const commitFile = internalMutation({
  args: {
    eventSlug: v.string(),
    credentialConnectionId: v.id("figmaCredentialConnections"),
    integrationPolicyId: v.id("integrationPolicyVersions"),
    fileKey: v.string(),
    mainFileKey: v.optional(v.string()),
    url: v.string(),
    name: v.string(),
    role: v.string(),
    linkAccess: v.string(),
    editorType: v.string(),
    versionId: v.string(),
    lastTouchedAt: v.number(),
    providerObservedAt: v.number(),
    thumbnailUrl: v.optional(v.string()),
    metrics: fileMetrics,
    activity: snapshotActivityInput,
    previewPlan: previewPlanInput,
    artifact: artifactInput,
    clientOperationId: v.string(),
  },
  returns: v.object({ bindingId: v.id("figmaFileBindings") }),
  handler: async (ctx, args) => {
    const { event, person, subject, team } = await currentTeamContext(ctx, args.eventSlug);
    const requestFingerprint = figmaFileAddOperationFingerprint(args);
    const priorOperation = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "figma.file.add",
      requestFingerprint,
    });
    if (priorOperation) {
      const bindingId = ctx.db.normalizeId("figmaFileBindings", priorOperation.targetId);
      if (!bindingId) throw new Error("The prior Figma file result is invalid.");
      const binding = await ctx.db.get(bindingId);
      if (!binding || binding.teamId !== team._id) {
        throw new Error("The prior Figma file result is invalid.");
      }
      return { bindingId };
    }
    const policy = await requirePublishedPolicy(ctx, event);
    if (policy._id !== args.integrationPolicyId) {
      throw new ConvexError({
        code: "INTEGRATION_POLICY_CHANGED",
        message: "The integration policy changed. Review it and try again.",
      });
    }
    requireFigmaWindow(event, team, policy, true, Date.now());
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.figma.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    const connection = await ctx.db.get(args.credentialConnectionId);
    if (!connection || connection.teamId !== team._id || connection.state !== "active") {
      throw new ConvexError({
        code: "FIGMA_CONNECTION_UNAVAILABLE",
        message: "Reconnect Figma before adding a file.",
      });
    }
    const credential = await ctx.db.get(connection.credentialId);
    if (!credential || credential.status !== "active") {
      throw new ConvexError({
        code: "FIGMA_AUTHORIZATION_UNAVAILABLE",
        message: "Reconnect Figma before adding a file.",
      });
    }
    const teamBindings = await ctx.db
      .query("figmaFileBindings")
      .withIndex("by_team_state", (index) => index.eq("teamId", team._id))
      .collect();
    const activeBindings = teamBindings.filter((binding) => binding.state !== "archived");
    if (activeBindings.length >= policy.maxActiveFigmaFilesPerTeam) {
      throw new ConvexError({
        code: "FIGMA_FILE_LIMIT",
        message: `This event allows ${policy.maxActiveFigmaFilesPerTeam} active Figma files per team.`,
      });
    }
    const eventBindings = await ctx.db
      .query("figmaFileBindings")
      .withIndex("by_event_file", (index) =>
        index.eq("eventId", event._id).eq("fileKey", args.fileKey),
      )
      .collect();
    const occupied = eventBindings.find((binding) => binding.state !== "archived");
    if (occupied) {
      throw new ConvexError({
        code: occupied.teamId === team._id ? "FIGMA_FILE_ALREADY_ADDED" : "FIGMA_FILE_IN_USE",
        message:
          occupied.teamId === team._id
            ? "This Figma file is already part of the team."
            : "This Figma file is already connected to another team in this event.",
      });
    }
    const now = Date.now();
    const bindingId = await ctx.db.insert("figmaFileBindings", {
      eventId: event._id,
      teamId: team._id,
      credentialId: credential._id,
      credentialConnectionId: connection._id,
      fileKey: args.fileKey,
      ...(args.mainFileKey !== undefined ? { mainFileKey: args.mainFileKey } : {}),
      url: args.url,
      name: normalizedText(args.name, "Figma file name", 1, 180),
      role: args.role,
      linkAccess: args.linkAccess,
      editorType: args.editorType,
      versionId: args.versionId,
      observedVersionId: args.versionId,
      lastTouchedAt: args.lastTouchedAt,
      lastProviderObservedAt: args.providerObservedAt,
      ...(args.thumbnailUrl !== undefined ? { thumbnailUrl: args.thumbnailUrl } : {}),
      state: "active",
      webhookState: "pending",
      webhookSetupRetryAt: now,
      lastMetadataCheckAt: now,
      nextMetadataCheckAt: nextFigmaMetadataCheckAt({
        from: now,
        eventStatus: event.status,
        webhookState: "pending",
        resourceKey: args.fileKey,
      }),
      lastFullCaptureAt: now,
      contentDirty: false,
      syncRevision: 1,
      syncedRevision: 1,
      syncState: "ready",
      version: 1,
      connectedAt: now,
      updatedAt: now,
    });
    await appendFigmaIntegrationReadFactById(ctx, bindingId, now);
    await ctx.db.insert("figmaFileMetrics", {
      eventId: event._id,
      teamId: team._id,
      figmaFileBindingId: bindingId,
      ...args.metrics,
      capturedAt: now,
      version: 1,
    });
    await createFigmaSnapshot(ctx, {
      eventId: event._id,
      teamId: team._id,
      bindingId,
      fileKey: args.fileKey,
      reason: "baseline",
      providerVersionId: args.versionId,
      providerLastTouchedAt: args.lastTouchedAt,
      metrics: args.metrics,
      activity: args.activity,
      artifact: args.artifact,
      previewPlan: args.previewPlan,
      createdAt: now,
    });
    await refreshFigmaTeamMetrics(ctx, { eventId: event._id, teamId: team._id, now });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "figma.file.add",
      requestFingerprint,
      targetType: "figma_file_binding",
      targetId: bindingId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "integration.figma.manage",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "figma.file_added",
      targetType: "figma_file_binding",
      targetId: bindingId,
      nextSummary: JSON.stringify({
        fileKey: args.fileKey,
        name: args.name,
        versionId: args.versionId,
        role: args.role,
      }),
      reason: "Added a team Figma file at its event baseline",
    });
    const webhookSetupLeaseId = operationFingerprint([
      bindingId,
      now,
      "figma_webhook_setup",
    ]);
    const webhookSetupLeaseExpiresAt = now + figmaWebhookSetupLeaseDurationMs;
    await ctx.db.patch(bindingId, {
      webhookSetupLeaseId,
      webhookSetupLeaseExpiresAt,
      webhookSetupRetryAt: webhookSetupLeaseExpiresAt,
    });
    await integrationWorkpool.enqueueAction(
      ctx,
      internal.figmaActions.configureFileWebhook,
      { bindingId, leaseId: webhookSetupLeaseId },
      { retry: true },
    );
    return { bindingId };
  },
});

const webhookSetupContext = v.object({
  bindingId: v.id("figmaFileBindings"),
  credentialId: v.id("figmaOAuthCredentials"),
  fileKey: v.string(),
  role: v.string(),
  webhookId: v.optional(v.string()),
});
type WebhookSetupContext = Infer<typeof webhookSetupContext>;

export const beginWebhookSetup = internalMutation({
  args: { bindingId: v.id("figmaFileBindings"), leaseId: v.string() },
  returns: v.union(v.null(), webhookSetupContext),
  handler: async (ctx, args): Promise<WebhookSetupContext | null> => {
    const binding = await ctx.db.get(args.bindingId);
    if (
      !binding ||
      binding.state !== "active" ||
      !["pending", "error"].includes(binding.webhookState) ||
      binding.webhookSetupLeaseId !== args.leaseId
    ) {
      return null;
    }
    const now = Date.now();
    const leaseExpiresAt = now + figmaWebhookSetupLeaseDurationMs;
    await ctx.db.patch(binding._id, {
      webhookSetupLeaseExpiresAt: leaseExpiresAt,
      webhookSetupRetryAt: leaseExpiresAt,
    });
    return {
      bindingId: binding._id,
      credentialId: binding.credentialId,
      fileKey: binding.fileKey,
      role: binding.role,
      ...(binding.webhookId !== undefined ? { webhookId: binding.webhookId } : {}),
    };
  },
});

export const attachWebhook = internalMutation({
  args: {
    bindingId: v.id("figmaFileBindings"),
    leaseId: v.string(),
    webhookId: v.string(),
    passcodeDigest: v.string(),
  },
  returns: v.object({ attached: v.boolean() }),
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.bindingId);
    if (
      !binding ||
      binding.state !== "active" ||
      binding.webhookSetupLeaseId !== args.leaseId ||
      binding.webhookId !== undefined
    ) {
      return { attached: false };
    }
    const now = Date.now();
    await ctx.db.patch(binding._id, {
      webhookId: args.webhookId,
      webhookPasscodeDigest: args.passcodeDigest,
      webhookState: "pending",
      version: binding.version + 1,
      updatedAt: now,
    });
    await appendFigmaIntegrationReadFactById(ctx, binding._id, now);
    await refreshFigmaTeamMetrics(ctx, {
      eventId: binding.eventId,
      teamId: binding.teamId,
      now,
    });
    return { attached: true };
  },
});

export const webhookCleanupContext = internalQuery({
  args: { bindingId: v.id("figmaFileBindings") },
  returns: v.union(
    v.null(),
    v.object({
      bindingId: v.id("figmaFileBindings"),
      credentialId: v.id("figmaOAuthCredentials"),
      webhookId: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.bindingId);
    if (!binding || binding.state !== "archived" || !binding.webhookId) return null;
    return {
      bindingId: binding._id,
      credentialId: binding.credentialId,
      webhookId: binding.webhookId,
    };
  },
});

async function requireArtifactAccess(
  ctx: ReadCtx,
  args: { eventSlug: string; bindingId: Id<"figmaFileBindings"> },
) {
  const event = await requireEventBySlug(ctx, args.eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const binding = await ctx.db.get(args.bindingId);
  if (!binding || binding.eventId !== event._id || binding.state === "archived") {
    throw new ConvexError({
      code: "FIGMA_FILE_UNAVAILABLE",
      message: "This Figma file is unavailable.",
    });
  }
  const grantIds = await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "integration.artifact.read",
    scopeType: "team",
    scopeId: binding.teamId,
  });
  const snapshot = await ctx.db
    .query("figmaFileSnapshots")
    .withIndex("by_binding_time", (index) =>
      index.eq("figmaFileBindingId", binding._id),
    )
    .order("desc")
    .first();
  if (
    !snapshot?.artifactId ||
    snapshot.eventId !== event._id ||
    snapshot.teamId !== binding.teamId
  ) {
    throw new ConvexError({
      code: "FIGMA_ARTIFACT_UNAVAILABLE",
      message: "This Figma checkpoint does not have a full-file artifact.",
    });
  }
  const artifact = await ctx.db.get(snapshot.artifactId);
  if (
    !artifact ||
    artifact.state !== "available" ||
    artifact.provider !== "figma" ||
    artifact.eventId !== event._id ||
    artifact.teamId !== binding.teamId ||
    artifact.figmaFileBindingId !== binding._id ||
    artifact.providerVersionId !== snapshot.providerVersionId
  ) {
    throw new ConvexError({
      code: "FIGMA_ARTIFACT_UNAVAILABLE",
      message: "This Figma checkpoint artifact is unavailable.",
    });
  }
  return { event, person, binding, snapshot, artifact, grantIds };
}

export const artifactAccessContext = internalQuery({
  args: { eventSlug: v.string(), bindingId: v.id("figmaFileBindings") },
  returns: v.object({
    artifactId: v.id("integrationArtifacts"),
    snapshotId: v.id("figmaFileSnapshots"),
    objectKey: v.string(),
    storageRegion: v.string(),
    storageBucket: v.string(),
    sha256: v.string(),
    capturedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const { artifact, snapshot } = await requireArtifactAccess(ctx, args);
    return {
      artifactId: artifact._id,
      snapshotId: snapshot._id,
      objectKey: artifact.objectKey,
      storageRegion: artifact.storageRegion,
      storageBucket: artifact.storageBucket,
      sha256: artifact.sha256,
      capturedAt: snapshot.capturedAt,
    };
  },
});

export const recordArtifactAccess = internalMutation({
  args: {
    eventSlug: v.string(),
    bindingId: v.id("figmaFileBindings"),
    snapshotId: v.id("figmaFileSnapshots"),
    artifactId: v.id("integrationArtifacts"),
    expectedObjectKey: v.string(),
    expectedStorageRegion: v.string(),
    expectedStorageBucket: v.string(),
    expectedSha256: v.string(),
    expectedCapturedAt: v.number(),
    signedUrlExpiresAt: v.number(),
  },
  returns: v.object({ serverNow: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, binding, snapshot, artifact, grantIds } =
      await requireArtifactAccess(ctx, args);
    if (
      snapshot._id !== args.snapshotId ||
      artifact._id !== args.artifactId ||
      artifact.objectKey !== args.expectedObjectKey ||
      artifact.storageRegion !== args.expectedStorageRegion ||
      artifact.storageBucket !== args.expectedStorageBucket ||
      artifact.sha256 !== args.expectedSha256 ||
      snapshot.capturedAt !== args.expectedCapturedAt
    ) {
      throw new ConvexError({
        code: "FIGMA_ARTIFACT_CHANGED",
        message: "The Figma checkpoint changed while the download was prepared. Try again.",
      });
    }
    const serverNow = Date.now();
    if (
      !Number.isSafeInteger(args.signedUrlExpiresAt) ||
      args.signedUrlExpiresAt <= serverNow ||
      args.signedUrlExpiresAt > serverNow + 60_000
    ) {
      throw new ConvexError({
        code: "FIGMA_ARTIFACT_LINK_EXPIRED",
        message: "The Figma checkpoint link expired while it was prepared. Try again.",
      });
    }
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "integration.artifact.read",
      grantIds,
      scopeType: "team",
      scopeId: binding.teamId,
      action: "figma.artifact_download_opened",
      targetType: "integration_artifact",
      targetId: artifact._id,
      nextSummary: JSON.stringify({
        bindingId: binding._id,
        snapshotId: snapshot._id,
        sha256: artifact.sha256,
        signedUrlExpiresAt: args.signedUrlExpiresAt,
      }),
      reason: "Opened a team Figma checkpoint",
    });
    return { serverNow };
  },
});

export const finishWebhookCleanup = internalMutation({
  args: { bindingId: v.id("figmaFileBindings"), webhookId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.bindingId);
    if (
      binding &&
      binding.state === "archived" &&
      binding.webhookId === args.webhookId
    ) {
      const now = Date.now();
      await ctx.db.patch(binding._id, {
        webhookId: undefined,
        webhookPasscodeDigest: undefined,
        webhookState: "unavailable",
        webhookSetupLeaseId: undefined,
        webhookSetupLeaseExpiresAt: undefined,
        webhookSetupRetryAt: undefined,
        version: binding.version + 1,
        updatedAt: now,
      });
      await appendFigmaIntegrationReadFactById(ctx, binding._id, now);
    }
    return null;
  },
});

export const finishWebhookSetup = internalMutation({
  args: {
    bindingId: v.id("figmaFileBindings"),
    leaseId: v.string(),
    webhookId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.bindingId);
    if (
      !binding ||
      binding.state !== "active" ||
      binding.webhookSetupLeaseId !== args.leaseId ||
      binding.webhookId !== args.webhookId
    ) {
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(binding._id, {
      webhookState: "active",
      webhookSetupLeaseId: undefined,
      webhookSetupLeaseExpiresAt: undefined,
      webhookSetupRetryAt: undefined,
      version: binding.version + 1,
      updatedAt: now,
    });
    await appendFigmaIntegrationReadFactById(ctx, binding._id, now);
    await refreshFigmaTeamMetrics(ctx, {
      eventId: binding.eventId,
      teamId: binding.teamId,
      now,
    });
    return null;
  },
});

export const failWebhookSetup = internalMutation({
  args: {
    bindingId: v.id("figmaFileBindings"),
    leaseId: v.string(),
    expectedWebhookId: v.optional(v.string()),
    state: v.union(v.literal("unavailable"), v.literal("error")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.bindingId);
    const expectedWebhookMatches =
      args.expectedWebhookId === undefined
        ? binding?.webhookId === undefined
        : binding?.webhookId === args.expectedWebhookId;
    if (
      !binding ||
      binding.state !== "active" ||
      binding.webhookSetupLeaseId !== args.leaseId ||
      !expectedWebhookMatches
    ) {
      return null;
    }
    const now = Date.now();
    const retryAt =
      args.state === "error" ? binding.webhookSetupLeaseExpiresAt : undefined;
    if (args.state === "error" && retryAt === undefined) {
      throw new Error("An active Figma webhook setup lease has no expiry.");
    }
    await ctx.db.patch(binding._id, {
      webhookId: undefined,
      webhookPasscodeDigest: undefined,
      webhookState: args.state,
      ...(args.state === "unavailable"
        ? {
            webhookSetupLeaseId: undefined,
            webhookSetupLeaseExpiresAt: undefined,
            webhookSetupRetryAt: undefined,
          }
        : { webhookSetupRetryAt: retryAt }),
      version: binding.version + 1,
      updatedAt: now,
    });
    await appendFigmaIntegrationReadFactById(ctx, binding._id, now);
    await refreshFigmaTeamMetrics(ctx, {
      eventId: binding.eventId,
      teamId: binding.teamId,
      now,
    });
    return null;
  },
});

export const refreshFile = mutation({
  args: {
    eventSlug: v.string(),
    bindingId: v.id("figmaFileBindings"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ bindingId: v.id("figmaFileBindings"), syncRevision: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject, team } = await currentTeamContext(ctx, args.eventSlug);
    const reason = normalizedText(args.reason, "Refresh reason", 3, 180);
    const clientOperationId = normalizedText(
      args.clientOperationId,
      "Client operation ID",
      8,
      120,
    );
    const requestFingerprint = operationFingerprint([
      args.bindingId,
      args.expectedVersion,
      reason,
    ]);
    const priorOperation = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "figma.file.refresh",
      requestFingerprint,
    });
    if (priorOperation) {
      const bindingId = ctx.db.normalizeId("figmaFileBindings", priorOperation.targetId);
      if (!bindingId) throw new Error("The stored Figma refresh is invalid.");
      return {
        bindingId,
        syncRevision: storedOperationVersion(priorOperation.resultJson, "Figma refresh"),
      };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.figma.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    const binding = await ctx.db.get(args.bindingId);
    if (!binding || binding.teamId !== team._id || binding.state !== "active") {
      throw new ConvexError({ code: "FIGMA_FILE_UNAVAILABLE", message: "This Figma file is unavailable." });
    }
    if (binding.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "FIGMA_FILE_CHANGED",
        message: "The Figma file changed in another session. Review it and try again.",
      });
    }
    if ((binding.rateLimitRetryAt ?? 0) > Date.now()) {
      throw new ConvexError({
        code: "FIGMA_RATE_LIMITED",
        message: "Figma has limited this file for now. Try again after the time shown.",
      });
    }
    const now = Date.now();
    const syncRevision = binding.syncRevision + 1;
    await ctx.db.patch(binding._id, {
      syncRevision,
      syncState: "pending",
      contentDirty: true,
      syncErrorCode: undefined,
      version: binding.version + 1,
      updatedAt: now,
    });
    await appendFigmaIntegrationReadFactById(ctx, binding._id, now);
    await refreshFigmaTeamMetrics(ctx, { eventId: event._id, teamId: team._id, now });
    await integrationWorkpool.enqueueAction(
      ctx,
      internal.figmaActions.reconcileFile,
      { bindingId: binding._id },
      { retry: false },
    );
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "figma.file.refresh",
      requestFingerprint,
      targetType: "figma_file_binding",
      targetId: binding._id,
      resultJson: String(syncRevision),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "integration.figma.manage",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "figma.file_refresh_requested",
      targetType: "figma_file_binding",
      targetId: binding._id,
      previousSummary: JSON.stringify({ syncRevision: binding.syncRevision, syncState: binding.syncState }),
      nextSummary: JSON.stringify({ syncRevision, syncState: "pending" }),
      reason,
    });
    return { bindingId: binding._id, syncRevision };
  },
});

export const archiveFile = mutation({
  args: {
    eventSlug: v.string(),
    bindingId: v.id("figmaFileBindings"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ bindingId: v.id("figmaFileBindings") }),
  handler: async (ctx, args) => {
    const { event, person, subject, team } = await currentTeamContext(ctx, args.eventSlug);
    const requestFingerprint = operationFingerprint([
      args.bindingId,
      args.expectedVersion,
      args.reason,
    ]);
    const priorOperation = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "figma.file.archive",
      requestFingerprint,
    });
    if (priorOperation) return { bindingId: args.bindingId };
    const policy = await requirePublishedPolicy(ctx, event);
    requireFigmaWindow(event, team, policy, false, Date.now());
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "integration.figma.manage",
      scopeType: "team",
      scopeId: team._id,
    });
    const binding = await ctx.db.get(args.bindingId);
    if (!binding || binding.teamId !== team._id || binding.state === "archived") {
      throw new ConvexError({ code: "FIGMA_FILE_UNAVAILABLE", message: "This Figma file is unavailable." });
    }
    if (binding.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "FIGMA_FILE_CHANGED",
        message: "The Figma file changed in another session. Review it and try again.",
      });
    }
    const reason = normalizedText(args.reason, "Archive reason", 3, 180);
    const now = Date.now();
    await ctx.db.patch(binding._id, {
      state: "archived",
      webhookSetupLeaseId: undefined,
      webhookSetupLeaseExpiresAt: undefined,
      webhookSetupRetryAt: undefined,
      syncState: "ready",
      syncLeaseId: undefined,
      syncLeaseExpiresAt: undefined,
      metadataLeaseId: undefined,
      metadataLeaseExpiresAt: undefined,
      nextMetadataCheckAt: undefined,
      version: binding.version + 1,
      updatedAt: now,
    });
    await appendFigmaIntegrationReadFactById(ctx, binding._id, now);
    await refreshFigmaTeamMetrics(ctx, { eventId: event._id, teamId: team._id, now });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "figma.file.archive",
      requestFingerprint,
      targetType: "figma_file_binding",
      targetId: binding._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "integration.figma.manage",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "figma.file_archived",
      targetType: "figma_file_binding",
      targetId: binding._id,
      previousSummary: JSON.stringify({ state: binding.state, version: binding.version }),
      nextSummary: JSON.stringify({ state: "archived", version: binding.version + 1 }),
      reason,
    });
    if (binding.webhookId) {
      await integrationWorkpool.enqueueAction(
        ctx,
        internal.figmaActions.removeArchivedWebhook,
        { bindingId: binding._id },
        { retry: false },
      );
    }
    return { bindingId: binding._id };
  },
});

export const dispatchWebhookSetups = internalMutation({
  args: {},
  returns: v.object({ dispatched: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const [pending, failed] = await Promise.all([
      ctx.db
        .query("figmaFileBindings")
        .withIndex("by_state_webhook_retry", (index) =>
          index
            .eq("state", "active")
            .eq("webhookState", "pending")
            .lte("webhookSetupRetryAt", now),
        )
        .take(figmaWebhookSetupDispatchBatchSize),
      ctx.db
        .query("figmaFileBindings")
        .withIndex("by_state_webhook_retry", (index) =>
          index
            .eq("state", "active")
            .eq("webhookState", "error")
            .lte("webhookSetupRetryAt", now),
        )
        .take(figmaWebhookSetupDispatchBatchSize),
    ]);
    const candidates = [...pending, ...failed].slice(
      0,
      figmaWebhookSetupDispatchBatchSize,
    );
    for (const binding of candidates) {
      if (binding.webhookSetupRetryAt === undefined) {
        throw new Error("A due Figma webhook setup has no retry time.");
      }
      const leaseId = operationFingerprint([
        binding._id,
        binding.version,
        binding.webhookSetupRetryAt,
        now,
        "figma_webhook_recovery",
      ]);
      const leaseExpiresAt = now + figmaWebhookSetupLeaseDurationMs;
      await ctx.db.patch(binding._id, {
        webhookSetupLeaseId: leaseId,
        webhookSetupLeaseExpiresAt: leaseExpiresAt,
        webhookSetupRetryAt: leaseExpiresAt,
      });
      await integrationWorkpool.enqueueAction(
        ctx,
        internal.figmaActions.configureFileWebhook,
        { bindingId: binding._id, leaseId },
        { retry: true },
      );
    }
    return { dispatched: candidates.length };
  },
});

export const dispatchMetadataChecks = internalMutation({
  args: {},
  returns: v.object({ dispatched: v.number(), deferred: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const [unscheduled, due] = await Promise.all([
      ctx.db
        .query("figmaFileBindings")
        .withIndex("by_state_metadata_due", (index) =>
          index.eq("state", "active").eq("nextMetadataCheckAt", undefined),
        )
        .take(figmaMetadataDispatchBatchSize),
      ctx.db
        .query("figmaFileBindings")
        .withIndex("by_state_metadata_due", (index) =>
          index.eq("state", "active").lte("nextMetadataCheckAt", now),
        )
        .take(figmaMetadataDispatchBatchSize),
    ]);
    const seen = new Set<Id<"figmaFileBindings">>();
    const candidates = [...unscheduled, ...due].filter((binding) => {
      if (seen.has(binding._id) || seen.size >= figmaMetadataDispatchBatchSize) {
        return false;
      }
      seen.add(binding._id);
      return true;
    });
    let dispatched = 0;
    let deferred = 0;
    for (const binding of candidates) {
      const event = await ctx.db.get(binding.eventId);
      if (!event) throw new Error("A Figma binding references a missing event.");
      const firstDueAt =
        binding.nextMetadataCheckAt ??
        nextFigmaMetadataCheckAt({
          from: binding.lastMetadataCheckAt,
          eventStatus: event.status,
          webhookState: binding.webhookState,
          resourceKey: binding.fileKey,
        });
      const leaseUntil = binding.metadataLeaseExpiresAt ?? 0;
      const rateLimitUntil = binding.metadataRateLimitRetryAt ?? 0;
      const effectiveDueAt = Math.max(firstDueAt, leaseUntil, rateLimitUntil);
      if (effectiveDueAt > now) {
        if (binding.nextMetadataCheckAt !== effectiveDueAt) {
          await ctx.db.patch(binding._id, { nextMetadataCheckAt: effectiveDueAt });
        }
        deferred += 1;
        continue;
      }
      await ctx.db.patch(binding._id, {
        nextMetadataCheckAt: now + figmaMetadataDispatchRecoveryMs,
      });
      await integrationWorkpool.enqueueAction(
        ctx,
        internal.figmaActions.checkFileMetadata,
        { bindingId: binding._id },
        { retry: false },
      );
      dispatched += 1;
    }
    return { dispatched, deferred };
  },
});

export const beginMetadataCheck = internalMutation({
  args: { bindingId: v.id("figmaFileBindings"), leaseId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      bindingId: v.id("figmaFileBindings"),
      credentialId: v.id("figmaOAuthCredentials"),
      fileKey: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.bindingId);
    if (!binding || binding.state !== "active") return null;
    const now = Date.now();
    if ((binding.metadataRateLimitRetryAt ?? 0) > now) {
      await ctx.db.patch(binding._id, {
        nextMetadataCheckAt: binding.metadataRateLimitRetryAt,
      });
      return null;
    }
    if (binding.metadataLeaseId && (binding.metadataLeaseExpiresAt ?? 0) > now) {
      return null;
    }
    const credential = await ctx.db.get(binding.credentialId);
    if (!credential || credential.status !== "active") {
      await ctx.db.patch(binding._id, {
        state: "inaccessible",
        metadataLeaseId: undefined,
        metadataLeaseExpiresAt: undefined,
        metadataErrorCode: "authorization_unavailable",
        syncState: "error",
        syncErrorCode: "authorization_unavailable",
        version: binding.version + 1,
        updatedAt: now,
      });
      await appendFigmaIntegrationReadFactById(ctx, binding._id, now);
      await refreshFigmaTeamMetrics(ctx, {
        eventId: binding.eventId,
        teamId: binding.teamId,
        now,
      });
      return null;
    }
    const leaseExpiresAt = now + figmaMetadataLeaseDurationMs;
    await ctx.db.patch(binding._id, {
      metadataLeaseId: args.leaseId,
      metadataLeaseExpiresAt: leaseExpiresAt,
      nextMetadataCheckAt: leaseExpiresAt,
    });
    return {
      bindingId: binding._id,
      credentialId: credential._id,
      fileKey: binding.fileKey,
    };
  },
});

export const finishMetadataCheck = internalMutation({
  args: {
    bindingId: v.id("figmaFileBindings"),
    leaseId: v.string(),
    name: v.string(),
    role: v.string(),
    linkAccess: v.string(),
    editorType: v.string(),
    versionId: v.string(),
    lastTouchedAt: v.number(),
    thumbnailUrl: v.string(),
    providerObservedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.bindingId);
    if (
      !binding ||
      binding.state !== "active" ||
      binding.metadataLeaseId !== args.leaseId
    ) {
      return null;
    }
    const event = await ctx.db.get(binding.eventId);
    if (!event) throw new Error("A Figma binding references a missing event.");
    const now = Date.now();
    const acceptObservation = shouldAcceptFigmaObservation({
      currentLastTouchedAt: binding.lastTouchedAt,
      currentObservedAt: binding.lastProviderObservedAt ?? binding.lastFullCaptureAt,
      incomingLastTouchedAt: args.lastTouchedAt,
      incomingObservedAt: args.providerObservedAt,
    });
    const previousObservedVersion = binding.observedVersionId ?? binding.versionId;
    const observedVersion = acceptObservation ? args.versionId : previousObservedVersion;
    const versionChanged = acceptObservation && observedVersion !== previousObservedVersion;
    const normalizedName = normalizedText(args.name, "Figma file name", 1, 180);
    const metadataChanged =
      acceptObservation &&
      (normalizedName !== binding.name ||
        args.role !== binding.role ||
        args.linkAccess !== binding.linkAccess ||
        args.editorType !== binding.editorType ||
        args.thumbnailUrl !== binding.thumbnailUrl ||
        args.lastTouchedAt !== binding.lastTouchedAt ||
        observedVersion !== previousObservedVersion);
    const operationalErrorCleared =
      binding.metadataErrorCode !== undefined ||
      binding.metadataRateLimitRetryAt !== undefined;
    const observedRateLimitType =
      binding.metadataRateLimitType ?? binding.rateLimitType;
    const autoReconcile = versionChanged && observedRateLimitType === "high";
    const nextSyncRevision = versionChanged
      ? binding.syncRevision + 1
      : binding.syncRevision;
    const nextSyncState =
      binding.syncState === "running"
        ? "running"
        : autoReconcile
          ? "pending"
          : binding.syncState;
    await ctx.db.patch(binding._id, {
      ...(acceptObservation
        ? {
            name: normalizedName,
            role: args.role,
            linkAccess: args.linkAccess,
            editorType: args.editorType,
            observedVersionId: observedVersion,
            lastTouchedAt: args.lastTouchedAt,
            lastProviderObservedAt: args.providerObservedAt,
            thumbnailUrl: args.thumbnailUrl,
          }
        : {}),
      lastMetadataCheckAt: now,
      nextMetadataCheckAt: nextFigmaMetadataCheckAt({
        from: now,
        eventStatus: event.status,
        webhookState: binding.webhookState,
        resourceKey: binding.fileKey,
      }),
      metadataLeaseId: undefined,
      metadataLeaseExpiresAt: undefined,
      metadataErrorCode: undefined,
      contentDirty: binding.contentDirty || observedVersion !== binding.versionId,
      metadataRateLimitRetryAt: undefined,
      syncRevision: nextSyncRevision,
      syncState: nextSyncState,
      ...(metadataChanged || operationalErrorCleared
        ? { version: binding.version + 1, updatedAt: now }
        : {}),
    });
    await appendFigmaIntegrationReadFactById(ctx, binding._id, now);
    await refreshFigmaTeamMetrics(ctx, {
      eventId: binding.eventId,
      teamId: binding.teamId,
      now,
    });
    if (autoReconcile && binding.syncState !== "running") {
      await integrationWorkpool.enqueueAction(
        ctx,
        internal.figmaActions.reconcileFile,
        { bindingId: binding._id },
        { retry: false },
      );
    }
    return null;
  },
});

export const failMetadataCheck = internalMutation({
  args: {
    bindingId: v.id("figmaFileBindings"),
    leaseId: v.string(),
    state: v.union(v.literal("rate_limited"), v.literal("error")),
    errorCode: v.string(),
    retryAt: v.optional(v.number()),
    planTier: v.optional(v.string()),
    rateLimitType: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.bindingId);
    if (!binding || binding.metadataLeaseId !== args.leaseId) return null;
    const event = await ctx.db.get(binding.eventId);
    if (!event) throw new Error("A Figma binding references a missing event.");
    const now = Date.now();
    if (args.state === "rate_limited" && args.retryAt === undefined) {
      throw new Error("A rate-limited Figma metadata check must include Retry-After.");
    }
    const inaccessible = args.errorCode === "figma_file_not_found";
    const requiresReauthorization = [
      "figma_authentication_failed",
      "figma_access_denied",
    ].includes(args.errorCode);
    const nextMetadataCheckAt =
      args.retryAt ??
      (requiresReauthorization
        ? now + 30 * 60 * 1_000
        : nextFigmaMetadataFailureCheckAt({
            now,
            eventStatus: event.status,
            resourceKey: binding.fileKey,
          }));
    await ctx.db.patch(binding._id, {
      ...(inaccessible
        ? {
            state: "inaccessible" as const,
            syncState: "error" as const,
            syncErrorCode: args.errorCode,
          }
        : {}),
      metadataLeaseId: undefined,
      metadataLeaseExpiresAt: undefined,
      metadataErrorCode: args.errorCode,
      nextMetadataCheckAt,
      ...(args.retryAt !== undefined
        ? { metadataRateLimitRetryAt: args.retryAt }
        : {}),
      ...(args.planTier !== undefined
        ? { metadataRateLimitPlanTier: args.planTier }
        : {}),
      ...(args.rateLimitType !== undefined
        ? { metadataRateLimitType: args.rateLimitType }
        : {}),
      version: binding.version + 1,
      updatedAt: now,
    });
    await appendFigmaIntegrationReadFactById(ctx, binding._id, now);
    await refreshFigmaTeamMetrics(ctx, {
      eventId: binding.eventId,
      teamId: binding.teamId,
      now,
    });
    return null;
  },
});

export const beginFileSync = internalMutation({
  args: { bindingId: v.id("figmaFileBindings"), leaseId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      bindingId: v.id("figmaFileBindings"),
      credentialId: v.id("figmaOAuthCredentials"),
      accessTokenCiphertext: v.string(),
      refreshTokenCiphertext: v.string(),
      tokenExpiresAt: v.number(),
      credentialVersion: v.number(),
      fileKey: v.string(),
      eventId: v.id("events"),
      teamId: v.id("teams"),
      syncRevision: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.bindingId);
    if (!binding || binding.state !== "active") return null;
    if (binding.syncedRevision >= binding.syncRevision && !binding.contentDirty) return null;
    const now = Date.now();
    if ((binding.rateLimitRetryAt ?? 0) > now) return null;
    if (
      binding.syncState === "running" &&
      binding.syncLeaseId &&
      (binding.syncLeaseExpiresAt ?? 0) > now
    ) {
      return null;
    }
    const credential = await ctx.db.get(binding.credentialId);
    if (!credential || credential.status !== "active") {
      await ctx.db.patch(binding._id, {
        state: "inaccessible",
        syncState: "error",
        syncErrorCode: "authorization_unavailable",
        version: binding.version + 1,
        updatedAt: now,
      });
      await appendFigmaIntegrationReadFactById(ctx, binding._id, now);
      await refreshFigmaTeamMetrics(ctx, {
        eventId: binding.eventId,
        teamId: binding.teamId,
        now,
      });
      return null;
    }
    await ctx.db.patch(binding._id, {
      syncState: "running",
      syncLeaseId: args.leaseId,
      syncLeaseExpiresAt: now + 3 * 60 * 1_000,
      syncErrorCode: undefined,
    });
    await appendFigmaIntegrationReadFactById(ctx, binding._id, now);
    await refreshFigmaTeamMetrics(ctx, {
      eventId: binding.eventId,
      teamId: binding.teamId,
      now,
    });
    return {
      bindingId: binding._id,
      credentialId: credential._id,
      accessTokenCiphertext: credential.accessTokenCiphertext,
      refreshTokenCiphertext: credential.refreshTokenCiphertext,
      tokenExpiresAt: credential.tokenExpiresAt,
      credentialVersion: credential.version,
      fileKey: binding.fileKey,
      eventId: binding.eventId,
      teamId: binding.teamId,
      syncRevision: binding.syncRevision,
    };
  },
});

export const finishFileSync = internalMutation({
  args: {
    bindingId: v.id("figmaFileBindings"),
    leaseId: v.string(),
    syncRevision: v.number(),
    name: v.string(),
    role: v.string(),
    linkAccess: v.string(),
    editorType: v.string(),
    versionId: v.string(),
    lastTouchedAt: v.number(),
    providerObservedAt: v.number(),
    thumbnailUrl: v.optional(v.string()),
    metrics: fileMetrics,
    activity: snapshotActivityInput,
    previewPlan: previewPlanInput,
    artifact: artifactInput,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.bindingId);
    if (
      !binding ||
      binding.state !== "active" ||
      binding.syncState !== "running" ||
      binding.syncLeaseId !== args.leaseId
    ) {
      return null;
    }
    const metric = await ctx.db
      .query("figmaFileMetrics")
      .withIndex("by_binding", (index) => index.eq("figmaFileBindingId", binding._id))
      .unique();
    if (!metric) throw new Error("Figma file metrics are missing.");
    const event = await ctx.db.get(binding.eventId);
    if (!event) throw new Error("A Figma binding references a missing event.");
    const now = Date.now();
    const syncedRevision = Math.max(binding.syncedRevision, args.syncRevision);
    const acceptObservation = shouldAcceptFigmaObservation({
      currentLastTouchedAt: binding.lastTouchedAt,
      currentObservedAt: binding.lastProviderObservedAt ?? binding.lastFullCaptureAt,
      incomingLastTouchedAt: args.lastTouchedAt,
      incomingObservedAt: args.providerObservedAt,
    });
    const observedVersionId = acceptObservation
      ? args.versionId
      : (binding.observedVersionId ?? binding.versionId);
    const dirty =
      binding.syncRevision > syncedRevision || observedVersionId !== args.versionId;
    const metadataLeaseActive =
      binding.metadataLeaseId !== undefined &&
      (binding.metadataLeaseExpiresAt ?? 0) > now;
    await ctx.db.patch(binding._id, {
      ...(acceptObservation
        ? {
            name: args.name,
            role: args.role,
            linkAccess: args.linkAccess,
            editorType: args.editorType,
            lastTouchedAt: args.lastTouchedAt,
            lastProviderObservedAt: args.providerObservedAt,
            ...(args.thumbnailUrl !== undefined
              ? { thumbnailUrl: args.thumbnailUrl }
              : {}),
          }
        : {}),
      versionId: args.versionId,
      observedVersionId,
      lastMetadataCheckAt: now,
      ...(!metadataLeaseActive
        ? {
            nextMetadataCheckAt: nextFigmaMetadataCheckAt({
              from: now,
              eventStatus: event.status,
              webhookState: binding.webhookState,
              resourceKey: binding.fileKey,
            }),
            metadataErrorCode: undefined,
          }
        : {}),
      lastFullCaptureAt: now,
      contentDirty: dirty,
      rateLimitRetryAt: undefined,
      syncedRevision,
      syncState: dirty ? "pending" : "ready",
      syncLeaseId: undefined,
      syncLeaseExpiresAt: undefined,
      syncErrorCode: undefined,
      version: binding.version + 1,
      updatedAt: now,
    });
    await appendFigmaIntegrationReadFactById(ctx, binding._id, now);
    await ctx.db.patch(metric._id, {
      ...args.metrics,
      capturedAt: now,
      version: metric.version + 1,
    });
    await createFigmaSnapshot(ctx, {
      eventId: binding.eventId,
      teamId: binding.teamId,
      bindingId: binding._id,
      fileKey: binding.fileKey,
      reason: "reconcile",
      providerVersionId: args.versionId,
      providerLastTouchedAt: args.lastTouchedAt,
      metrics: args.metrics,
      activity: args.activity,
      artifact: args.artifact,
      previewPlan: args.previewPlan,
      createdAt: now,
    });
    await refreshFigmaTeamMetrics(ctx, {
      eventId: binding.eventId,
      teamId: binding.teamId,
      now,
    });
    if (dirty) {
      await integrationWorkpool.enqueueAction(
        ctx,
        internal.figmaActions.reconcileFile,
        { bindingId: binding._id },
        { retry: false },
      );
    }
    return null;
  },
});

export const failFileSync = internalMutation({
  args: {
    bindingId: v.id("figmaFileBindings"),
    leaseId: v.string(),
    state: v.union(v.literal("rate_limited"), v.literal("error")),
    errorCode: v.string(),
    retryAt: v.optional(v.number()),
    planTier: v.optional(v.string()),
    rateLimitType: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.bindingId);
    if (binding?.syncLeaseId === args.leaseId && binding.syncState === "running") {
      const now = Date.now();
      await ctx.db.patch(binding._id, {
        syncState: args.state,
        syncErrorCode: args.errorCode,
        ...(args.retryAt !== undefined ? { rateLimitRetryAt: args.retryAt } : {}),
        ...(args.planTier !== undefined ? { rateLimitPlanTier: args.planTier } : {}),
        ...(args.rateLimitType !== undefined ? { rateLimitType: args.rateLimitType } : {}),
        syncLeaseId: undefined,
        syncLeaseExpiresAt: undefined,
        version: binding.version + 1,
        updatedAt: now,
      });
      await appendFigmaIntegrationReadFactById(ctx, binding._id, now);
      await refreshFigmaTeamMetrics(ctx, {
        eventId: binding.eventId,
        teamId: binding.teamId,
        now,
      });
    }
    return null;
  },
});

export const claimPreviewRender = internalMutation({
  args: { previewSetId: v.id("figmaPreviewSets"), leaseId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      previewSetId: v.id("figmaPreviewSets"),
      eventId: v.id("events"),
      teamId: v.id("teams"),
      credentialId: v.id("figmaOAuthCredentials"),
      fileKey: v.string(),
      providerVersionId: v.string(),
      nodes: v.array(
        v.object({ factId: v.id("figmaNodeFacts"), nodeId: v.string() }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const previewSet = await ctx.db.get(args.previewSetId);
    if (
      !previewSet ||
      previewSet.selectedNodeCount === 0 ||
      ["ready", "partial", "failed"].includes(previewSet.state)
    ) {
      return null;
    }
    const now = Date.now();
    if (
      (previewSet.state === "running" &&
        (previewSet.renderLeaseExpiresAt ?? 0) > now) ||
      (previewSet.state === "rate_limited" && (previewSet.retryAt ?? 0) > now)
    ) {
      return null;
    }
    const [snapshot, binding, facts] = await Promise.all([
      ctx.db.get(previewSet.snapshotId),
      ctx.db.get(previewSet.figmaFileBindingId),
      ctx.db
        .query("figmaNodeFacts")
        .withIndex("by_preview_page_order", (index) =>
          index.eq("previewSetId", previewSet._id),
        )
        .collect(),
    ]);
    if (
      !snapshot ||
      !binding ||
      snapshot._id !== previewSet.snapshotId ||
      snapshot.eventId !== previewSet.eventId ||
      snapshot.teamId !== previewSet.teamId ||
      snapshot.figmaFileBindingId !== binding._id ||
      snapshot.providerVersionId !== previewSet.providerVersionId ||
      binding.eventId !== previewSet.eventId ||
      binding.teamId !== previewSet.teamId ||
      facts.length !== previewSet.selectedNodeCount ||
      facts.some(
        (fact) =>
          fact.snapshotId !== snapshot._id ||
          fact.figmaFileBindingId !== binding._id ||
          fact.providerVersionId !== snapshot.providerVersionId ||
          fact.render.state !== "pending",
      )
    ) {
      throw new Error("The Figma preview set is inconsistent with its pinned snapshot.");
    }
    const credential = await ctx.db.get(binding.credentialId);
    if (!credential || credential.status !== "active") {
      for (const fact of facts) {
        await ctx.db.patch(fact._id, {
          render: { state: "failed", failureCode: "authorization_unavailable" },
          updatedAt: now,
        });
      }
      await ctx.db.patch(previewSet._id, {
        state: "failed",
        failureCode: "authorization_unavailable",
        failedCount: facts.length,
        renderLeaseId: undefined,
        renderLeaseExpiresAt: undefined,
        retryAt: undefined,
        completedAt: now,
        updatedAt: now,
      });
      await refreshFigmaTeamMetrics(ctx, {
        eventId: previewSet.eventId,
        teamId: previewSet.teamId,
        now,
      });
      return null;
    }
    const renderLeaseExpiresAt = now + 5 * 60 * 1_000;
    await ctx.db.patch(previewSet._id, {
      state: "running",
      renderLeaseId: args.leaseId,
      renderLeaseExpiresAt,
      retryAt: undefined,
      failureCode: undefined,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(
      renderLeaseExpiresAt,
      internal.figmaIntegrations.recoverPreviewRender,
      { previewSetId: previewSet._id },
    );
    return {
      previewSetId: previewSet._id,
      eventId: previewSet.eventId,
      teamId: previewSet.teamId,
      credentialId: credential._id,
      fileKey: binding.fileKey,
      providerVersionId: previewSet.providerVersionId,
      nodes: facts.map((fact) => ({ factId: fact._id, nodeId: fact.nodeId })),
    };
  },
});

function validatePreviewResult(result: PreviewRenderResultInput) {
  if (result.state === "failed") {
    if (!/^[a-z0-9_]{1,80}$/.test(result.failureCode)) {
      throw new Error("The Figma preview failure is invalid.");
    }
    return;
  }
  const artifact = result.artifact;
  if (
    !artifact.objectKey ||
    !artifact.storageRegion ||
    !artifact.storageBucket ||
    !Number.isSafeInteger(artifact.byteCount) ||
    artifact.byteCount < 1 ||
    artifact.byteCount > 8 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.width) ||
    !Number.isSafeInteger(artifact.height) ||
    artifact.width < 1 ||
    artifact.height < 1 ||
    artifact.width * artifact.height > 32_000_000
  ) {
    throw new Error("The Figma preview artifact manifest is invalid.");
  }
}

export const finishPreviewRender = internalMutation({
  args: {
    previewSetId: v.id("figmaPreviewSets"),
    leaseId: v.string(),
    results: v.array(previewRenderResultInput),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const previewSet = await ctx.db.get(args.previewSetId);
    if (
      !previewSet ||
      previewSet.state !== "running" ||
      previewSet.renderLeaseId !== args.leaseId
    ) {
      return null;
    }
    const facts = await ctx.db
      .query("figmaNodeFacts")
      .withIndex("by_preview_page_order", (index) =>
        index.eq("previewSetId", previewSet._id),
      )
      .collect();
    const resultByFact = new Map<string, PreviewRenderResultInput>();
    for (const result of args.results) {
      validatePreviewResult(result);
      if (resultByFact.has(result.factId)) {
        throw new Error("A Figma frame has more than one render result.");
      }
      resultByFact.set(result.factId, result);
    }
    if (
      facts.length !== previewSet.selectedNodeCount ||
      resultByFact.size !== facts.length ||
      facts.some(
        (fact) =>
          fact.render.state !== "pending" || !resultByFact.has(fact._id),
      )
    ) {
      throw new Error("The Figma preview result set is incomplete.");
    }
    const now = Date.now();
    let availableCount = 0;
    for (const fact of facts) {
      const result = resultByFact.get(fact._id);
      if (!result) throw new Error("A Figma preview result is missing.");
      if (result.state === "available") {
        availableCount += 1;
        await ctx.db.patch(fact._id, {
          render: { state: "available", ...result.artifact },
          updatedAt: now,
        });
      } else {
        await ctx.db.patch(fact._id, {
          render: { state: "failed", failureCode: result.failureCode },
          updatedAt: now,
        });
      }
    }
    const failedCount = facts.length - availableCount;
    await ctx.db.patch(previewSet._id, {
      state:
        availableCount === facts.length
          ? "ready"
          : availableCount === 0
            ? "failed"
            : "partial",
      availableCount,
      failedCount,
      renderLeaseId: undefined,
      renderLeaseExpiresAt: undefined,
      retryAt: undefined,
      failureCode: availableCount === 0 ? "all_previews_failed" : undefined,
      completedAt: now,
      updatedAt: now,
    });
    await refreshFigmaTeamMetrics(ctx, {
      eventId: previewSet.eventId,
      teamId: previewSet.teamId,
      now,
    });
    return null;
  },
});

export const failPreviewRender = internalMutation({
  args: {
    previewSetId: v.id("figmaPreviewSets"),
    leaseId: v.string(),
    state: v.union(v.literal("rate_limited"), v.literal("error")),
    errorCode: v.string(),
    retryAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (
      !/^[a-z0-9_]{1,80}$/.test(args.errorCode) ||
      (args.state === "rate_limited" &&
        (args.retryAt === undefined || !Number.isSafeInteger(args.retryAt)))
    ) {
      throw new Error("The Figma preview failure is invalid.");
    }
    const previewSet = await ctx.db.get(args.previewSetId);
    if (
      !previewSet ||
      previewSet.state !== "running" ||
      previewSet.renderLeaseId !== args.leaseId
    ) {
      return null;
    }
    const now = Date.now();
    const retryAt = args.state === "rate_limited" ? args.retryAt : undefined;
    if (args.state === "error") {
      const facts = await ctx.db
        .query("figmaNodeFacts")
        .withIndex("by_preview_page_order", (index) =>
          index.eq("previewSetId", previewSet._id),
        )
        .collect();
      if (
        facts.length !== previewSet.selectedNodeCount ||
        facts.some((fact) => fact.render.state !== "pending")
      ) {
        throw new Error("The failed Figma preview set is inconsistent.");
      }
      for (const fact of facts) {
        await ctx.db.patch(fact._id, {
          render: { state: "failed", failureCode: args.errorCode },
          updatedAt: now,
        });
      }
    }
    await ctx.db.patch(previewSet._id, {
      state: args.state === "rate_limited" ? "rate_limited" : "failed",
      failureCode: args.errorCode,
      failedCount:
        args.state === "error" ? previewSet.selectedNodeCount : previewSet.failedCount,
      ...(retryAt !== undefined ? { retryAt } : { retryAt: undefined }),
      renderLeaseId: undefined,
      renderLeaseExpiresAt: undefined,
      ...(args.state === "error" ? { completedAt: now } : {}),
      updatedAt: now,
    });
    await refreshFigmaTeamMetrics(ctx, {
      eventId: previewSet.eventId,
      teamId: previewSet.teamId,
      now,
    });
    if (retryAt !== undefined) {
      await ctx.scheduler.runAt(
        Math.max(now, retryAt),
        internal.figmaIntegrations.recoverPreviewRender,
        { previewSetId: previewSet._id },
      );
    }
    return null;
  },
});

export const recoverPreviewRender = internalMutation({
  args: { previewSetId: v.id("figmaPreviewSets") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const previewSet = await ctx.db.get(args.previewSetId);
    if (!previewSet) return null;
    const now = Date.now();
    const leaseExpired =
      previewSet.state === "running" &&
      (previewSet.renderLeaseExpiresAt ?? 0) <= now;
    const retryDue =
      previewSet.state === "rate_limited" && (previewSet.retryAt ?? 0) <= now;
    if (!leaseExpired && !retryDue) return null;
    await integrationWorkpool.enqueueAction(
      ctx,
      internal.figmaActions.renderSnapshotPreviews,
      { previewSetId: previewSet._id },
      { retry: false },
    );
    return null;
  },
});

export const acceptWebhook = internalMutation({
  args: {
    deliveryKey: v.string(),
    webhookId: v.string(),
    passcodeDigest: v.string(),
    eventType: v.string(),
    fileKey: v.optional(v.string()),
    providerAt: v.number(),
  },
  returns: v.object({ duplicate: v.boolean(), accepted: v.boolean() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("figmaWebhookDeliveries")
      .withIndex("by_delivery", (index) => index.eq("deliveryKey", args.deliveryKey))
      .unique();
    if (existing) return { duplicate: true, accepted: existing.state === "accepted" };
    const binding = await ctx.db
      .query("figmaFileBindings")
      .withIndex("by_webhook", (index) => index.eq("webhookId", args.webhookId))
      .unique();
    const now = Date.now();
    if (
      !binding ||
      !binding.webhookPasscodeDigest ||
      binding.webhookPasscodeDigest !== args.passcodeDigest ||
      (args.fileKey !== undefined && args.fileKey !== binding.fileKey)
    ) {
      return { duplicate: false, accepted: false };
    }
    if (args.eventType === "FILE_UPDATE" && binding.state === "active") {
      const autoReconcile =
        (binding.rateLimitType ?? binding.metadataRateLimitType) === "high" &&
        (binding.rateLimitRetryAt ?? 0) <= now;
      await ctx.db.patch(binding._id, {
        lastProviderEventAt: Math.max(binding.lastProviderEventAt ?? 0, args.providerAt),
        contentDirty: true,
        syncRevision: binding.syncRevision + 1,
        syncState:
          binding.syncState === "running"
            ? "running"
            : autoReconcile
              ? "pending"
              : binding.syncState,
        ...(autoReconcile ? { syncErrorCode: undefined } : {}),
        version: binding.version + 1,
        updatedAt: now,
      });
      if (autoReconcile && binding.syncState !== "running") {
        await integrationWorkpool.enqueueAction(
          ctx,
          internal.figmaActions.reconcileFile,
          { bindingId: binding._id },
          { retry: false },
        );
      }
    } else if (args.eventType === "FILE_DELETE" && binding.state === "active") {
      await ctx.db.patch(binding._id, {
        state: "inaccessible",
        lastProviderEventAt: Math.max(binding.lastProviderEventAt ?? 0, args.providerAt),
        syncState: "error",
        syncErrorCode: "figma_file_deleted",
        version: binding.version + 1,
        updatedAt: now,
      });
    } else if (args.eventType === "PING") {
      await ctx.db.patch(binding._id, {
        webhookState: "active",
        webhookSetupLeaseId: undefined,
        webhookSetupLeaseExpiresAt: undefined,
        webhookSetupRetryAt: undefined,
        version: binding.version + 1,
        updatedAt: now,
      });
    }
    const accepted = ["FILE_UPDATE", "FILE_DELETE", "PING"].includes(args.eventType);
    if (accepted) {
      await appendFigmaIntegrationReadFactById(ctx, binding._id, now);
      await refreshFigmaTeamMetrics(ctx, {
        eventId: binding.eventId,
        teamId: binding.teamId,
        now,
      });
    }
    await ctx.db.insert("figmaWebhookDeliveries", {
      deliveryKey: args.deliveryKey,
      webhookId: args.webhookId,
      ...(args.fileKey !== undefined ? { fileKey: args.fileKey } : {}),
      eventType: args.eventType,
      providerAt: args.providerAt,
      state: accepted ? "accepted" : "ignored",
      reasonCode: accepted ? "binding_updated" : "unsupported_event",
      receivedAt: now,
    });
    return { duplicate: false, accepted };
  },
});
