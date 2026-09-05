import { areaForPermission, emergencyReviewsBundle, permissionName } from "@code2create/domain";
import { ConvexError, v, type Infer } from "convex/values";
import { z } from "zod";

import type { Doc, Id } from "./_generated/dataModel";
import { api } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  bundleBindingRequirements,
  bundleContentChecksum,
  normalizeBundleBindings,
  normalizeBundleEntries,
  resolveBundleGrants,
  resolvedBundleChecksum,
  resolvedBundleSourceId,
  type BundleBinding,
  type ResolvedBundleGrant,
} from "./lib/permissionBundleEntries";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
} from "./lib/operations";
import { permissionCatalog, type PermissionKey } from "./lib/permissionCatalog";
import {
  insertPermissionGrant,
  currentSourceGrants,
  matchingPermissionGrantIds,
  requirePermission,
} from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import { eventRole, permissionBundleEntry, scopeType } from "./values";

type ReadCtx = QueryCtx | MutationCtx;
type BundleDoc = Doc<"permissionBundles">;
type BundleVersionDoc = Doc<"permissionBundleVersions">;
type GrantDoc = Doc<"permissionGrants">;

const maximumBundlesPerEvent = 100;
const maximumBundleEntries = 48;
const maximumPermissionGrantsPerKey = 500;
const bundleKeyPattern = /^[a-z][a-z0-9_]{2,47}$/;
const bindingInput = v.object({ key: v.string(), scopeId: v.string() });
const savedDraftOperationResult = z
  .object({
    bundleId: z.string(),
    bundleVersion: z.number().int().nonnegative(),
    draftVersionId: z.string(),
    draftVersion: z.number().int().positive(),
    draftRevision: z.number().int().positive(),
    checksum: z.string(),
  })
  .strict();
const publishedOperationResult = z
  .object({
    bundleId: z.string(),
    bundleVersion: z.number().int().positive(),
    publishedVersionId: z.string(),
    publishedVersion: z.number().int().positive(),
    checksum: z.string(),
  })
  .strict();
const bundleApplicationOperationResult = z
  .object({
    accessVersion: z.number().int().positive(),
    grantCount: z.number().int().nonnegative(),
    createdCount: z.number().int().nonnegative(),
  })
  .strict();

const versionSummary = v.object({
  id: v.id("permissionBundleVersions"),
  version: v.number(),
  revision: v.number(),
  label: v.string(),
  status: v.union(v.literal("draft"), v.literal("published"), v.literal("retired")),
  entryCount: v.number(),
  checksum: v.string(),
  updatedAt: v.number(),
  publishedAt: v.optional(v.number()),
});

const bundleSummary = v.object({
  id: v.id("permissionBundles"),
  key: v.string(),
  label: v.string(),
  defaultRole: v.optional(eventRole),
  publishedVersion: v.number(),
  version: v.number(),
  canEdit: v.boolean(),
  canMigrate: v.boolean(),
  draft: v.optional(versionSummary),
  published: v.optional(versionSummary),
});

const bundleDetail = v.object({
  bundle: v.object({
    id: v.id("permissionBundles"),
    key: v.string(),
    label: v.string(),
    defaultRole: v.optional(eventRole),
    publishedVersion: v.number(),
    version: v.number(),
  }),
  draft: v.optional(
    v.object({
      id: v.id("permissionBundleVersions"),
      version: v.number(),
      revision: v.number(),
      label: v.string(),
      defaultRole: v.optional(eventRole),
      entries: v.array(permissionBundleEntry),
      checksum: v.string(),
      updatedAt: v.number(),
    }),
  ),
  published: v.optional(
    v.object({
      id: v.id("permissionBundleVersions"),
      version: v.number(),
      revision: v.number(),
      label: v.string(),
      defaultRole: v.optional(eventRole),
      entries: v.array(permissionBundleEntry),
      checksum: v.string(),
      publishedAt: v.number(),
    }),
  ),
});

const savedDraft = v.object({
  bundleId: v.id("permissionBundles"),
  bundleVersion: v.number(),
  draftVersionId: v.id("permissionBundleVersions"),
  draftVersion: v.number(),
  draftRevision: v.number(),
  checksum: v.string(),
});

const publishedResult = v.object({
  bundleId: v.id("permissionBundles"),
  bundleVersion: v.number(),
  publishedVersionId: v.id("permissionBundleVersions"),
  publishedVersion: v.number(),
  checksum: v.string(),
});

const bindingRequirement = v.object({
  key: v.string(),
  scopeType,
  permissionKey: v.string(),
});

const applicableBundle = v.object({
  bundleId: v.id("permissionBundles"),
  versionId: v.id("permissionBundleVersions"),
  key: v.string(),
  label: v.string(),
  version: v.number(),
  entryCount: v.number(),
  bindings: v.array(bindingRequirement),
});

const applicationPreview = v.object({
  bundleId: v.id("permissionBundles"),
  bundleVersionId: v.id("permissionBundleVersions"),
  bundleLabel: v.string(),
  bundleVersion: v.number(),
  targetPersonId: v.id("people"),
  expectedAccessVersion: v.number(),
  validUntil: v.optional(v.number()),
  previewChecksum: v.string(),
  grants: v.array(
    v.object({
      permissionKey: v.string(),
      scopeType,
      scopeId: v.optional(v.string()),
      alreadyEffective: v.boolean(),
    }),
  ),
});

function checkedBundleKey(value: string) {
  const key = value.trim().toLowerCase();
  if (!bundleKeyPattern.test(key)) {
    throw new ConvexError({
      code: "INVALID_BUNDLE_KEY",
      message: "Bundle keys must be 3–48 lowercase letters, numbers, or underscores.",
    });
  }
  return key;
}

function effectiveGrant(grant: GrantDoc, now: number) {
  return (
    grant.status === "active" &&
    grant.validFrom <= now &&
    (grant.validUntil === undefined || grant.validUntil > now)
  );
}

async function activePermissionGrants(
  ctx: ReadCtx,
  eventAccessSubjectId: Id<"eventAccessSubjects">,
  permissionKey: PermissionKey,
) {
  const now = Date.now();
  const grants = await ctx.db
    .query("permissionGrants")
    .withIndex("by_subject_permission_status", (index) =>
      index
        .eq("eventAccessSubjectId", eventAccessSubjectId)
        .eq("permissionKey", permissionKey)
        .eq("status", "active"),
    )
    .take(maximumPermissionGrantsPerKey + 1);
  if (grants.length > maximumPermissionGrantsPerKey) {
    throw new Error("The account has more grants for one permission than the supported bound.");
  }
  return grants.filter((grant) => effectiveGrant(grant, now));
}

function coversScope(
  grants: readonly GrantDoc[],
  scopeType: "person" | "permission_bundle",
  scopeId: string,
) {
  return grants.some(
    (grant) =>
      (grant.scopeType === scopeType && grant.scopeId === scopeId) || grant.scopeType === "event",
  );
}

function hasEventScope(grants: readonly GrantDoc[]) {
  return grants.some((grant) => grant.scopeType === "event");
}

async function requireBundlePermissions(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    actorSubjectId: Id<"eventAccessSubjects">;
    bundleId: Id<"permissionBundles">;
    permissionKeys: readonly (
      | "access.permission_bundles.read"
      | "access.permission_bundles.publish"
      | "access.permission_bundles.apply"
      | "access.permission_bundles.migrate"
    )[];
  },
) {
  const groups = await Promise.all(
    args.permissionKeys.map((permissionKey) =>
      requirePermission(ctx, {
        eventId: args.eventId,
        eventAccessSubjectId: args.actorSubjectId,
        permissionKey,
        scopeType: "permission_bundle",
        scopeId: args.bundleId,
      }),
    ),
  );
  return [...new Set(groups.flat())];
}

function summarizeVersion(version: BundleVersionDoc) {
  return {
    id: version._id,
    version: version.version,
    revision: version.revision,
    label: version.label,
    status: version.status,
    entryCount: version.entries.length,
    checksum: version.checksum,
    updatedAt: version.updatedAt,
    ...(version.publishedAt !== undefined ? { publishedAt: version.publishedAt } : {}),
  };
}

async function bundleVersions(ctx: ReadCtx, bundle: BundleDoc) {
  const [draft, published] = await Promise.all([
    bundle.draftVersionId ? ctx.db.get("permissionBundleVersions", bundle.draftVersionId) : null,
    bundle.publishedVersionId
      ? ctx.db.get("permissionBundleVersions", bundle.publishedVersionId)
      : null,
  ]);
  if (
    (draft && (draft.bundleId !== bundle._id || draft.status !== "draft")) ||
    (published && (published.bundleId !== bundle._id || published.status !== "published"))
  ) {
    throw new Error("Permission bundle version pointers are inconsistent.");
  }
  return { draft, published };
}

export const workspace = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    canCreate: v.boolean(),
    catalog: v.array(
      v.object({
        key: v.string(),
        label: v.string(),
        area: v.string(),
        eventWide: v.boolean(),
        scopes: v.array(scopeType),
      }),
    ),
    bundles: v.array(bundleSummary),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    const [readGrants, publishGrants, migrateGrants] = await Promise.all([
      activePermissionGrants(ctx, actorSubject._id, "access.permission_bundles.read"),
      activePermissionGrants(ctx, actorSubject._id, "access.permission_bundles.publish"),
      activePermissionGrants(ctx, actorSubject._id, "access.permission_bundles.migrate"),
    ]);
    if (readGrants.length === 0) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account cannot read permission bundles.",
      });
    }
    const allBundles = await ctx.db
      .query("permissionBundles")
      .withIndex("by_event_status_label", (index) =>
        index.eq("eventId", event._id).eq("status", "active"),
      )
      .take(maximumBundlesPerEvent + 1);
    if (allBundles.length > maximumBundlesPerEvent) {
      throw new Error("The event has more permission bundles than the supported bound.");
    }
    const visible = hasEventScope(readGrants)
      ? allBundles
      : allBundles.filter((bundle) => coversScope(readGrants, "permission_bundle", bundle._id));
    const bundles = await Promise.all(
      visible.map(async (bundle) => {
        const { draft, published } = await bundleVersions(ctx, bundle);
        return {
          id: bundle._id,
          key: bundle.key,
          label: bundle.label,
          ...(bundle.defaultRole !== undefined ? { defaultRole: bundle.defaultRole } : {}),
          publishedVersion: bundle.publishedVersion,
          version: bundle.version,
          canEdit:
            coversScope(readGrants, "permission_bundle", bundle._id) &&
            coversScope(publishGrants, "permission_bundle", bundle._id),
          canMigrate:
            coversScope(readGrants, "permission_bundle", bundle._id) &&
            coversScope(migrateGrants, "permission_bundle", bundle._id),
          ...(draft ? { draft: summarizeVersion(draft) } : {}),
          ...(published ? { published: summarizeVersion(published) } : {}),
        };
      }),
    );
    return {
      canCreate: hasEventScope(readGrants) && hasEventScope(publishGrants),
      catalog: Object.entries(permissionCatalog)
        .filter(
          ([key]) =>
            key !== "access.permissions.grant_scoped" && key !== "access.permissions.revoke_scoped",
        )
        .map(([key, definition]) => ({
          key,
          label: permissionName(key),
          area: areaForPermission(key),
          eventWide: definition.eventWide,
          scopes: [...definition.scopes],
        })),
      bundles,
    };
  },
});

export const detail = query({
  args: {
    eventSlug: v.string(),
    bundleId: v.id("permissionBundles"),
  },
  returns: bundleDetail,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    const bundle = await ctx.db.get("permissionBundles", args.bundleId);
    if (!bundle || bundle.eventId !== event._id || bundle.status !== "active") {
      throw new ConvexError({
        code: "BUNDLE_NOT_FOUND",
        message: "Permission bundle not found.",
      });
    }
    await requireBundlePermissions(ctx, {
      eventId: event._id,
      actorSubjectId: actorSubject._id,
      bundleId: bundle._id,
      permissionKeys: ["access.permission_bundles.read"],
    });
    const { draft, published } = await bundleVersions(ctx, bundle);
    return {
      bundle: {
        id: bundle._id,
        key: bundle.key,
        label: bundle.label,
        ...(bundle.defaultRole !== undefined ? { defaultRole: bundle.defaultRole } : {}),
        publishedVersion: bundle.publishedVersion,
        version: bundle.version,
      },
      ...(draft
        ? {
            draft: {
              id: draft._id,
              version: draft.version,
              revision: draft.revision,
              label: draft.label,
              ...(draft.defaultRole !== undefined ? { defaultRole: draft.defaultRole } : {}),
              entries: draft.entries,
              checksum: draft.checksum,
              updatedAt: draft.updatedAt,
            },
          }
        : {}),
      ...(published && published.publishedAt !== undefined
        ? {
            published: {
              id: published._id,
              version: published.version,
              revision: published.revision,
              label: published.label,
              ...(published.defaultRole !== undefined
                ? { defaultRole: published.defaultRole }
                : {}),
              entries: published.entries,
              checksum: published.checksum,
              publishedAt: published.publishedAt,
            },
          }
        : {}),
    };
  },
});

function draftResult(bundle: BundleDoc, draft: BundleVersionDoc) {
  if (draft.status !== "draft" || draft.bundleId !== bundle._id) {
    throw new Error("The saved permission bundle draft is inconsistent.");
  }
  return {
    bundleId: bundle._id,
    bundleVersion: bundle.version,
    draftVersionId: draft._id,
    draftVersion: draft.version,
    draftRevision: draft.revision,
    checksum: draft.checksum,
  };
}

export const createEmergencyReviews = mutation({
  args: { eventSlug: v.string(), clientOperationId: v.string() },
  returns: v.object({ bundleId: v.id("permissionBundles") }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await Promise.all((["access.permission_bundles.read", "access.permission_bundles.publish"] as const)
      .map((permissionKey) => requirePermission(ctx, {
        eventId: event._id, eventAccessSubjectId: subject._id, permissionKey, scopeType: "event",
      })));
    const existing = await ctx.db.query("permissionBundles")
      .withIndex("by_event_key", (index) =>
        index.eq("eventId", event._id).eq("key", emergencyReviewsBundle.key))
      .unique();
    if (existing) return { bundleId: existing._id };
    const clientOperationId = normalizedText(args.clientOperationId, "Client operation ID", 10, 80);
    // Nested mutations share this transaction, so the ready-to-assign bundle
    // is created atomically using the same authorization and audit path as the editor.
    const draft: Infer<typeof savedDraft> = await ctx.runMutation(api.permissionBundles.saveDraft, {
      eventSlug: args.eventSlug,
      ...emergencyReviewsBundle,
      entries: [...emergencyReviewsBundle.entries],
      bundleId: null,
      expectedBundleVersion: 0,
      expectedDraftRevision: null,
      reason: "Create the Emergency Reviews access bundle",
      clientOperationId: `${clientOperationId}:draft`,
    });
    await ctx.runMutation(api.permissionBundles.publish, {
      eventSlug: args.eventSlug,
      bundleId: draft.bundleId,
      expectedBundleVersion: draft.bundleVersion,
      expectedDraftRevision: draft.draftRevision,
      reason: "Enable review-deck access for emergency reviewers",
      clientOperationId: `${clientOperationId}:publish`,
    });
    return { bundleId: draft.bundleId };
  },
});

export const saveDraft = mutation({
  args: {
    eventSlug: v.string(),
    bundleId: v.union(v.id("permissionBundles"), v.null()),
    key: v.string(),
    label: v.string(),
    defaultRole: v.union(eventRole, v.null()),
    entries: v.array(permissionBundleEntry),
    expectedBundleVersion: v.number(),
    expectedDraftRevision: v.union(v.number(), v.null()),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: savedDraft,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    const key = checkedBundleKey(args.key);
    const label = normalizedText(args.label, "Bundle label", 3, 80);
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const operationId = normalizedText(args.clientOperationId, "Client operation ID", 10, 100);
    const entries = normalizeBundleEntries(args.entries);
    const defaultRole = args.defaultRole ?? undefined;
    const checksum = bundleContentChecksum({ key, label, defaultRole, entries });
    const requestFingerprint = operationFingerprint([
      args.bundleId,
      key,
      label,
      defaultRole ?? null,
      checksum,
      args.expectedBundleVersion,
      args.expectedDraftRevision,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "permissionBundles.saveDraft",
      requestFingerprint,
    });
    if (prior) {
      const stored = storedOperationResult(
        prior.resultJson,
        "permission bundle draft",
        savedDraftOperationResult,
      );
      const bundleId = ctx.db.normalizeId("permissionBundles", stored.bundleId);
      const draftVersionId = ctx.db.normalizeId("permissionBundleVersions", stored.draftVersionId);
      if (!bundleId || !draftVersionId) {
        throw new Error("Prior permission bundle draft IDs are invalid.");
      }
      return {
        bundleId,
        bundleVersion: stored.bundleVersion,
        draftVersionId,
        draftVersion: stored.draftVersion,
        draftRevision: stored.draftRevision,
        checksum: stored.checksum,
      };
    }

    const now = Date.now();
    let bundle: BundleDoc;
    let draft: BundleVersionDoc | null;
    let authorizingGrantIds: Id<"permissionGrants">[];
    if (args.bundleId === null) {
      const [readGrantIds, publishGrantIds] = await Promise.all([
        requirePermission(ctx, {
          eventId: event._id,
          eventAccessSubjectId: actorSubject._id,
          permissionKey: "access.permission_bundles.read",
          scopeType: "event",
        }),
        requirePermission(ctx, {
          eventId: event._id,
          eventAccessSubjectId: actorSubject._id,
          permissionKey: "access.permission_bundles.publish",
          scopeType: "event",
        }),
      ]);
      authorizingGrantIds = [...new Set([...readGrantIds, ...publishGrantIds])];
      if (args.expectedBundleVersion !== 0 || args.expectedDraftRevision !== null) {
        throw new ConvexError({
          code: "BUNDLE_CHANGED",
          message: "This new-bundle form is stale. Start again.",
        });
      }
      const existing = await ctx.db
        .query("permissionBundles")
        .withIndex("by_event_key", (index) => index.eq("eventId", event._id).eq("key", key))
        .unique();
      if (existing) {
        throw new ConvexError({
          code: "BUNDLE_EXISTS",
          message: "That permission bundle key already exists.",
        });
      }
      const bundleCount = await ctx.db
        .query("permissionBundles")
        .withIndex("by_event_status_label", (index) =>
          index.eq("eventId", event._id).eq("status", "active"),
        )
        .take(maximumBundlesPerEvent);
      if (bundleCount.length >= maximumBundlesPerEvent) {
        throw new ConvexError({
          code: "BUNDLE_LIMIT_REACHED",
          message: "This event has reached its permission-bundle limit.",
        });
      }
      const bundleId = await ctx.db.insert("permissionBundles", {
        eventId: event._id,
        key,
        label,
        ...(defaultRole !== undefined ? { defaultRole } : {}),
        status: "active",
        publishedVersion: 0,
        version: 1,
        createdByPersonId: person._id,
        createdAt: now,
        updatedAt: now,
      });
      const draftVersionId = await ctx.db.insert("permissionBundleVersions", {
        eventId: event._id,
        bundleId,
        key,
        label,
        ...(defaultRole !== undefined ? { defaultRole } : {}),
        version: 1,
        revision: 1,
        status: "draft",
        entries,
        checksum,
        createdByPersonId: person._id,
        createdAt: now,
        updatedByPersonId: person._id,
        updatedAt: now,
      });
      await ctx.db.patch("permissionBundles", bundleId, { draftVersionId });
      const [createdBundle, createdDraft] = await Promise.all([
        ctx.db.get("permissionBundles", bundleId),
        ctx.db.get("permissionBundleVersions", draftVersionId),
      ]);
      if (!createdBundle || !createdDraft) {
        throw new Error("Permission bundle draft creation failed.");
      }
      bundle = createdBundle;
      draft = createdDraft;
    } else {
      const existingBundle = await ctx.db.get("permissionBundles", args.bundleId);
      if (
        !existingBundle ||
        existingBundle.eventId !== event._id ||
        existingBundle.status !== "active"
      ) {
        throw new ConvexError({
          code: "BUNDLE_NOT_FOUND",
          message: "Permission bundle not found.",
        });
      }
      if (existingBundle.key !== key) {
        throw new ConvexError({
          code: "BUNDLE_KEY_IMMUTABLE",
          message: "A permission bundle key cannot change after creation.",
        });
      }
      authorizingGrantIds = await requireBundlePermissions(ctx, {
        eventId: event._id,
        actorSubjectId: actorSubject._id,
        bundleId: existingBundle._id,
        permissionKeys: ["access.permission_bundles.read", "access.permission_bundles.publish"],
      });
      if (existingBundle.version !== args.expectedBundleVersion) {
        throw new ConvexError({
          code: "BUNDLE_CHANGED",
          message: "This permission bundle changed. Review the current draft and try again.",
        });
      }
      const existingDraft = existingBundle.draftVersionId
        ? await ctx.db.get("permissionBundleVersions", existingBundle.draftVersionId)
        : null;
      if (
        existingDraft &&
        (existingDraft.bundleId !== existingBundle._id || existingDraft.status !== "draft")
      ) {
        throw new Error("Permission bundle draft pointer is inconsistent.");
      }
      if ((existingDraft?.revision ?? null) !== args.expectedDraftRevision) {
        throw new ConvexError({
          code: "BUNDLE_CHANGED",
          message: "This permission bundle draft changed. Review it and try again.",
        });
      }
      if (existingDraft) {
        await ctx.db.patch("permissionBundleVersions", existingDraft._id, {
          label,
          ...(defaultRole !== undefined ? { defaultRole } : { defaultRole: undefined }),
          revision: existingDraft.revision + 1,
          entries,
          checksum,
          updatedByPersonId: person._id,
          updatedAt: now,
        });
        await ctx.db.patch("permissionBundles", existingBundle._id, {
          version: existingBundle.version + 1,
          updatedAt: now,
        });
        draft = await ctx.db.get("permissionBundleVersions", existingDraft._id);
      } else {
        const draftVersionId = await ctx.db.insert("permissionBundleVersions", {
          eventId: event._id,
          bundleId: existingBundle._id,
          key,
          label,
          ...(defaultRole !== undefined ? { defaultRole } : {}),
          version: existingBundle.publishedVersion + 1,
          revision: 1,
          status: "draft",
          entries,
          checksum,
          createdByPersonId: person._id,
          createdAt: now,
          updatedByPersonId: person._id,
          updatedAt: now,
        });
        await ctx.db.patch("permissionBundles", existingBundle._id, {
          draftVersionId,
          version: existingBundle.version + 1,
          updatedAt: now,
        });
        draft = await ctx.db.get("permissionBundleVersions", draftVersionId);
      }
      const updatedBundle = await ctx.db.get("permissionBundles", existingBundle._id);
      if (!updatedBundle) throw new Error("Permission bundle disappeared during draft save.");
      bundle = updatedBundle;
    }
    if (!draft) throw new Error("Permission bundle draft save failed.");
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "access.permission_bundles.publish",
      grantIds: authorizingGrantIds,
      scopeType: args.bundleId === null ? "event" : "permission_bundle",
      ...(args.bundleId !== null ? { scopeId: args.bundleId } : {}),
      action: "access.permission_bundle_draft_saved",
      targetType: "permission_bundle_version",
      targetId: draft._id,
      nextSummary: JSON.stringify({
        bundleId: bundle._id,
        key,
        draftVersion: draft.version,
        revision: draft.revision,
        entryCount: entries.length,
        checksum,
      }),
      reason,
    });
    const result = draftResult(bundle, draft);
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "permissionBundles.saveDraft",
      requestFingerprint,
      targetType: "permission_bundle_version",
      targetId: draft._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    return result;
  },
});

export const publish = mutation({
  args: {
    eventSlug: v.string(),
    bundleId: v.id("permissionBundles"),
    expectedBundleVersion: v.number(),
    expectedDraftRevision: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: publishedResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const operationId = normalizedText(args.clientOperationId, "Client operation ID", 10, 100);
    const requestFingerprint = operationFingerprint([
      args.bundleId,
      args.expectedBundleVersion,
      args.expectedDraftRevision,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "permissionBundles.publish",
      requestFingerprint,
    });
    if (prior) {
      const stored = storedOperationResult(
        prior.resultJson,
        "permission bundle publication",
        publishedOperationResult,
      );
      const bundleId = ctx.db.normalizeId("permissionBundles", stored.bundleId);
      const publishedVersionId = ctx.db.normalizeId(
        "permissionBundleVersions",
        stored.publishedVersionId,
      );
      if (!bundleId || !publishedVersionId) {
        throw new Error("Prior permission bundle publication IDs are invalid.");
      }
      return {
        bundleId,
        bundleVersion: stored.bundleVersion,
        publishedVersionId,
        publishedVersion: stored.publishedVersion,
        checksum: stored.checksum,
      };
    }

    const bundle = await ctx.db.get("permissionBundles", args.bundleId);
    if (!bundle || bundle.eventId !== event._id || bundle.status !== "active") {
      throw new ConvexError({
        code: "BUNDLE_NOT_FOUND",
        message: "Permission bundle not found.",
      });
    }
    const authorizingGrantIds = await requireBundlePermissions(ctx, {
      eventId: event._id,
      actorSubjectId: actorSubject._id,
      bundleId: bundle._id,
      permissionKeys: ["access.permission_bundles.read", "access.permission_bundles.publish"],
    });
    if (bundle.version !== args.expectedBundleVersion || !bundle.draftVersionId) {
      throw new ConvexError({
        code: "BUNDLE_CHANGED",
        message: "This permission bundle changed or no longer has a draft.",
      });
    }
    const [draft, currentPublished] = await Promise.all([
      ctx.db.get("permissionBundleVersions", bundle.draftVersionId),
      bundle.publishedVersionId
        ? ctx.db.get("permissionBundleVersions", bundle.publishedVersionId)
        : null,
    ]);
    if (
      !draft ||
      draft.bundleId !== bundle._id ||
      draft.status !== "draft" ||
      draft.revision !== args.expectedDraftRevision ||
      draft.version !== bundle.publishedVersion + 1
    ) {
      throw new ConvexError({
        code: "BUNDLE_CHANGED",
        message: "This permission bundle draft changed. Review it and try again.",
      });
    }
    if (
      currentPublished &&
      (currentPublished.bundleId !== bundle._id ||
        currentPublished.status !== "published" ||
        currentPublished.version !== bundle.publishedVersion)
    ) {
      throw new Error("Published permission bundle pointer is inconsistent.");
    }
    const entries = normalizeBundleEntries(draft.entries);
    const checksum = bundleContentChecksum({
      key: draft.key,
      label: draft.label,
      defaultRole: draft.defaultRole,
      entries,
    });
    if (checksum !== draft.checksum) {
      throw new Error("Permission bundle draft checksum is invalid.");
    }

    const now = Date.now();
    if (currentPublished) {
      await ctx.db.patch("permissionBundleVersions", currentPublished._id, {
        status: "retired",
        retiredAt: now,
        updatedByPersonId: person._id,
        updatedAt: now,
      });
    }
    await ctx.db.patch("permissionBundleVersions", draft._id, {
      status: "published",
      publishedByPersonId: person._id,
      publishedAt: now,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    await ctx.db.patch("permissionBundles", bundle._id, {
      label: draft.label,
      ...(draft.defaultRole !== undefined
        ? { defaultRole: draft.defaultRole }
        : { defaultRole: undefined }),
      publishedVersionId: draft._id,
      draftVersionId: undefined,
      publishedVersion: draft.version,
      version: bundle.version + 1,
      updatedAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "access.permission_bundles.publish",
      grantIds: authorizingGrantIds,
      scopeType: "permission_bundle",
      scopeId: bundle._id,
      action: "access.permission_bundle_published",
      targetType: "permission_bundle_version",
      targetId: draft._id,
      ...(currentPublished
        ? {
            previousSummary: JSON.stringify({
              version: currentPublished.version,
              checksum: currentPublished.checksum,
            }),
          }
        : {}),
      nextSummary: JSON.stringify({
        version: draft.version,
        entryCount: entries.length,
        checksum,
      }),
      reason,
    });
    const result = {
      bundleId: bundle._id,
      bundleVersion: bundle.version + 1,
      publishedVersionId: draft._id,
      publishedVersion: draft.version,
      checksum,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "permissionBundles.publish",
      requestFingerprint,
      targetType: "permission_bundle_version",
      targetId: draft._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    return result;
  },
});

function checkedValidUntil(
  event: Doc<"events">,
  requestedValidUntil: number | undefined,
  now: number,
) {
  const validUntil = requestedValidUntil ?? event.endsAt;
  if (validUntil === undefined) return undefined;
  if (
    !Number.isSafeInteger(validUntil) ||
    validUntil <= now ||
    (event.endsAt !== undefined && validUntil > event.endsAt)
  ) {
    throw new ConvexError({
      code: "INVALID_GRANT_EXPIRY",
      message: "Bundle access must expire in the future and cannot outlive the event.",
    });
  }
  return validUntil;
}

async function publishedBundle(
  ctx: ReadCtx,
  eventId: Id<"events">,
  bundleVersionId: Id<"permissionBundleVersions">,
) {
  const version = await ctx.db.get("permissionBundleVersions", bundleVersionId);
  const bundle = version ? await ctx.db.get("permissionBundles", version.bundleId) : null;
  if (
    !version ||
    !bundle ||
    version.eventId !== eventId ||
    bundle.eventId !== eventId ||
    version.status !== "published" ||
    bundle.status !== "active" ||
    bundle.publishedVersionId !== version._id
  ) {
    throw new ConvexError({
      code: "BUNDLE_NOT_PUBLISHED",
      message: "Choose the current published version of an active permission bundle.",
    });
  }
  return { bundle, version };
}

async function applicationContext(
  ctx: ReadCtx,
  args: {
    event: Doc<"events">;
    actorSubjectId: Id<"eventAccessSubjects">;
    targetPersonId: Id<"people">;
    bundleVersionId: Id<"permissionBundleVersions">;
    bindings: readonly BundleBinding[];
    requestedValidUntil: number | undefined;
  },
) {
  const targetSubject = await requireEventSubject(ctx, args.event._id, args.targetPersonId);
  const { bundle, version } = await publishedBundle(ctx, args.event._id, args.bundleVersionId);
  const [targetReadGrantIds, bundleGrantIds, targetApplyGrantIds] = await Promise.all([
    requirePermission(ctx, {
      eventId: args.event._id,
      eventAccessSubjectId: args.actorSubjectId,
      permissionKey: "access.permissions.read",
      scopeType: "person",
      scopeId: args.targetPersonId,
    }),
    requireBundlePermissions(ctx, {
      eventId: args.event._id,
      actorSubjectId: args.actorSubjectId,
      bundleId: bundle._id,
      permissionKeys: ["access.permission_bundles.read", "access.permission_bundles.apply"],
    }),
    requirePermission(ctx, {
      eventId: args.event._id,
      eventAccessSubjectId: args.actorSubjectId,
      permissionKey: "access.permission_bundles.apply",
      scopeType: "person",
      scopeId: args.targetPersonId,
    }),
  ]);
  const bindings = normalizeBundleBindings(
    bundleBindingRequirements(version.entries),
    args.bindings,
  );
  const grants = await resolveBundleGrants(ctx, {
    eventId: args.event._id,
    targetPersonId: args.targetPersonId,
    entries: version.entries,
    bindings,
  });
  const validUntil = checkedValidUntil(args.event, args.requestedValidUntil, Date.now());
  const previewChecksum = resolvedBundleChecksum({
    bundleChecksum: version.checksum,
    targetPersonId: args.targetPersonId,
    expectedAccessVersion: targetSubject.accessVersion,
    validUntil,
    grants,
  });
  return {
    targetSubject,
    bundle,
    version,
    grants,
    bindings,
    validUntil,
    previewChecksum,
    authorizingGrantIds: [
      ...new Set([...targetReadGrantIds, ...bundleGrantIds, ...targetApplyGrantIds]),
    ],
  };
}

export const applicableToTarget = query({
  args: {
    eventSlug: v.string(),
    targetPersonId: v.id("people"),
  },
  returns: v.array(applicableBundle),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    await requireEventSubject(ctx, event._id, args.targetPersonId);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: actorSubject._id,
      permissionKey: "access.permissions.read",
      scopeType: "person",
      scopeId: args.targetPersonId,
    });
    const [readGrants, applyGrants, bundles] = await Promise.all([
      activePermissionGrants(ctx, actorSubject._id, "access.permission_bundles.read"),
      activePermissionGrants(ctx, actorSubject._id, "access.permission_bundles.apply"),
      ctx.db
        .query("permissionBundles")
        .withIndex("by_event_status_label", (index) =>
          index.eq("eventId", event._id).eq("status", "active"),
        )
        .take(maximumBundlesPerEvent + 1),
    ]);
    if (bundles.length > maximumBundlesPerEvent) {
      throw new Error("The event has more permission bundles than the supported bound.");
    }
    if (!coversScope(applyGrants, "person", args.targetPersonId)) return [];
    const applicable = bundles.filter(
      (bundle) =>
        bundle.publishedVersionId !== undefined &&
        coversScope(readGrants, "permission_bundle", bundle._id) &&
        coversScope(applyGrants, "permission_bundle", bundle._id),
    );
    return Promise.all(
      applicable.map(async (bundle) => {
        const version = bundle.publishedVersionId
          ? await ctx.db.get("permissionBundleVersions", bundle.publishedVersionId)
          : null;
        if (!version || version.status !== "published") {
          throw new Error("Published permission bundle pointer is inconsistent.");
        }
        return {
          bundleId: bundle._id,
          versionId: version._id,
          key: bundle.key,
          label: version.label,
          version: version.version,
          entryCount: version.entries.length,
          bindings: bundleBindingRequirements(version.entries),
        };
      }),
    );
  },
});

export const previewApplication = query({
  args: {
    eventSlug: v.string(),
    targetPersonId: v.id("people"),
    bundleVersionId: v.id("permissionBundleVersions"),
    bindings: v.array(bindingInput),
    validUntil: v.optional(v.number()),
  },
  returns: applicationPreview,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    const context = await applicationContext(ctx, {
      event,
      actorSubjectId: actorSubject._id,
      targetPersonId: args.targetPersonId,
      bundleVersionId: args.bundleVersionId,
      bindings: args.bindings,
      requestedValidUntil: args.validUntil,
    });
    const grants = await Promise.all(
      context.grants.map(async (grant) => ({
        permissionKey: grant.permissionKey,
        scopeType: grant.scopeType,
        ...(grant.scopeType === "event" ? {} : { scopeId: grant.scopeId }),
        alreadyEffective:
          (
            await matchingPermissionGrantIds(ctx, {
              eventId: event._id,
              eventAccessSubjectId: context.targetSubject._id,
              permissionKey: grant.permissionKey,
              ...(grant.scopeType === "event"
                ? { scopeType: "event" as const }
                : { scopeType: grant.scopeType, scopeId: grant.scopeId }),
            })
          ).length > 0,
      })),
    );
    return {
      bundleId: context.bundle._id,
      bundleVersionId: context.version._id,
      bundleLabel: context.version.label,
      bundleVersion: context.version.version,
      targetPersonId: args.targetPersonId,
      expectedAccessVersion: context.targetSubject.accessVersion,
      ...(context.validUntil !== undefined ? { validUntil: context.validUntil } : {}),
      previewChecksum: context.previewChecksum,
      grants,
    };
  },
});

function sameResolvedGrant(grant: GrantDoc, planned: ResolvedBundleGrant) {
  return (
    grant.permissionKey === planned.permissionKey &&
    grant.scopeType === planned.scopeType &&
    grant.scopeId === (planned.scopeType === "event" ? undefined : planned.scopeId)
  );
}

export const apply = mutation({
  args: {
    eventSlug: v.string(),
    targetPersonId: v.id("people"),
    bundleVersionId: v.id("permissionBundleVersions"),
    bindings: v.array(bindingInput),
    validUntil: v.optional(v.number()),
    expectedAccessVersion: v.number(),
    previewChecksum: v.string(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    batchId: v.id("permissionGrantBatches"),
    accessVersion: v.number(),
    grantCount: v.number(),
    createdCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const operationId = normalizedText(args.clientOperationId, "Client operation ID", 10, 100);
    const bindingFingerprint = operationFingerprint(
      args.bindings.flatMap((binding) => [binding.key, binding.scopeId]),
    );
    const requestFingerprint = operationFingerprint([
      args.targetPersonId,
      args.bundleVersionId,
      bindingFingerprint,
      args.validUntil ?? null,
      args.expectedAccessVersion,
      args.previewChecksum,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "permissionBundles.apply",
      requestFingerprint,
    });
    if (prior) {
      const batchId = ctx.db.normalizeId("permissionGrantBatches", prior.targetId);
      if (!batchId) throw new Error("Prior permission bundle application is invalid.");
      const stored = storedOperationResult(
        prior.resultJson,
        "permission bundle application",
        bundleApplicationOperationResult,
      );
      return {
        batchId,
        accessVersion: stored.accessVersion,
        grantCount: stored.grantCount,
        createdCount: stored.createdCount,
      };
    }

    const context = await applicationContext(ctx, {
      event,
      actorSubjectId: actorSubject._id,
      targetPersonId: args.targetPersonId,
      bundleVersionId: args.bundleVersionId,
      bindings: args.bindings,
      requestedValidUntil: args.validUntil,
    });
    if (
      context.targetSubject.accessVersion !== args.expectedAccessVersion ||
      context.previewChecksum !== args.previewChecksum
    ) {
      throw new ConvexError({
        code: "BUNDLE_PREVIEW_STALE",
        message: "The target access or resolved bundle changed. Review it again before applying.",
      });
    }

    const sourceId = resolvedBundleSourceId({
      bundleVersionId: context.version._id,
      targetPersonId: args.targetPersonId,
      validUntil: context.validUntil,
      grants: context.grants,
    });
    const existingSourceGrants = await currentSourceGrants(ctx, {
      eventId: event._id,
      sourceType: "bundle",
      sourceId,
    });
    if (existingSourceGrants.length > maximumBundleEntries) {
      throw new Error("A permission-bundle source has more grants than the supported bound.");
    }
    const now = Date.now();
    const batchId = await ctx.db.insert("permissionGrantBatches", {
      eventId: event._id,
      clientOperationId: operationId,
      requestFingerprint,
      action: "apply_bundle",
      actorPersonId: person._id,
      targetPersonId: args.targetPersonId,
      bundleId: context.bundle._id,
      bundleVersionId: context.version._id,
      resolvedBindings: context.bindings,
      reason,
      authorizingGrantIds: context.authorizingGrantIds,
      expectedAccessVersion: args.expectedAccessVersion,
      previewChecksum: args.previewChecksum,
      ...(context.validUntil !== undefined ? { validUntil: context.validUntil } : {}),
      status: "applying",
      resultGrantIds: [],
      createdCount: 0,
      resultAccessVersion: args.expectedAccessVersion,
      createdAt: now,
    });
    const resultGrantIds: Id<"permissionGrants">[] = [];
    let createdCount = 0;
    for (const planned of context.grants) {
      const existing = existingSourceGrants.find((grant) => sameResolvedGrant(grant, planned));
      if (existing) {
        resultGrantIds.push(existing._id);
        continue;
      }
      const result = await insertPermissionGrant(ctx, {
        eventId: event._id,
        personId: args.targetPersonId,
        eventAccessSubjectId: context.targetSubject._id,
        permissionKey: planned.permissionKey,
        ...(planned.scopeType === "event"
          ? { scopeType: "event" as const }
          : { scopeType: planned.scopeType, scopeId: planned.scopeId }),
        sourceType: "bundle",
        sourceId,
        grantBatchId: batchId,
        grantedByPersonId: person._id,
        reason,
        ...(context.validUntil !== undefined ? { validUntil: context.validUntil } : {}),
      });
      resultGrantIds.push(result.grantId);
      if (result.created) createdCount += 1;
    }
    const accessVersion =
      createdCount > 0
        ? context.targetSubject.accessVersion + 1
        : context.targetSubject.accessVersion;
    if (createdCount > 0) {
      await ctx.db.patch("eventAccessSubjects", context.targetSubject._id, {
        accessVersion,
        updatedAt: now,
      });
    }
    await ctx.db.patch("permissionGrantBatches", batchId, {
      status: "complete",
      resultGrantIds,
      createdCount,
      resultAccessVersion: accessVersion,
      completedAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "access.permission_bundles.apply",
      grantIds: context.authorizingGrantIds,
      scopeType: "permission_bundle",
      scopeId: context.bundle._id,
      action: "access.permission_bundle_applied",
      targetType: "permission_grant_batch",
      targetId: batchId,
      previousSummary: JSON.stringify({
        accessVersion: context.targetSubject.accessVersion,
      }),
      nextSummary: JSON.stringify({
        accessVersion,
        bundleVersion: context.version.version,
        grantCount: resultGrantIds.length,
        createdCount,
      }),
      reason,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "permissionBundles.apply",
      requestFingerprint,
      targetType: "permission_grant_batch",
      targetId: batchId,
      resultJson: JSON.stringify({
        accessVersion,
        grantCount: resultGrantIds.length,
        createdCount,
      }),
      createdAt: now,
    });
    return {
      batchId,
      accessVersion,
      grantCount: resultGrantIds.length,
      createdCount,
    };
  },
});
