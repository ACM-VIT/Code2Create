import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { z } from "zod";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
} from "./lib/identity";
import {
  bundleBindingRequirements,
  bundleContentChecksum,
  normalizeBundleBindings,
  normalizeBundleEntries,
  resolveBundleGrants,
  resolvedBundleSourceId,
  type BundleBinding,
  type ResolvedBundleGrant,
} from "./lib/permissionBundleEntries";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
  type OperationFingerprintPart,
} from "./lib/operations";
import type { PermissionKey } from "./lib/permissionCatalog";
import { insertPermissionGrant } from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import { scopeType } from "./values";

type ReadCtx = QueryCtx | MutationCtx;
type BundleDoc = Doc<"permissionBundles">;
type BundleVersionDoc = Doc<"permissionBundleVersions">;
type GrantBatchDoc = Doc<"permissionGrantBatches">;
type GrantDoc = Doc<"permissionGrants">;
type SubjectDoc = Doc<"eventAccessSubjects">;

const maximumBundleEntries = 48;
const maximumMigrationTargets = 5;
const maximumCandidatePageSize = 5;
const maximumSourceVersionPageSize = 20;
const maximumPermissionGrantsPerKey = 500;
const maximumMigrationChanges = maximumMigrationTargets * maximumBundleEntries * 2;

const bindingInput = v.object({ key: v.string(), scopeId: v.string() });
const migrationSelectionInput = v.object({
  sourceGrantBatchId: v.id("permissionGrantBatches"),
  bindings: v.array(bindingInput),
});
const confirmedMigrationSelectionInput = v.object({
  sourceGrantBatchId: v.id("permissionGrantBatches"),
  bindings: v.array(bindingInput),
  expectedAccessVersion: v.number(),
});

const sourceVersionSummary = v.object({
  id: v.id("permissionBundleVersions"),
  label: v.string(),
  version: v.number(),
  entryCount: v.number(),
  checksum: v.string(),
  publishedAt: v.optional(v.number()),
  retiredAt: v.optional(v.number()),
});

const candidateBinding = v.object({
  key: v.string(),
  scopeType,
  permissionKey: v.string(),
  suggestedScopeId: v.optional(v.string()),
});

const migrationCandidate = v.object({
  sourceGrantBatchId: v.id("permissionGrantBatches"),
  targetPersonId: v.id("people"),
  displayName: v.string(),
  email: v.string(),
  expectedAccessVersion: v.number(),
  activeGrantCount: v.number(),
  preservedExceptionCount: v.number(),
  validUntil: v.optional(v.number()),
  bindings: v.array(candidateBinding),
});

const migrationAction = v.union(
  v.literal("add"),
  v.literal("replace"),
  v.literal("remove"),
  v.literal("preserve_exception"),
);

const migrationChange = v.object({
  permissionKey: v.string(),
  scopeType,
  scopeId: v.optional(v.string()),
  action: migrationAction,
  destinationAlreadyExists: v.boolean(),
});

const migrationTargetPreview = v.object({
  sourceGrantBatchId: v.id("permissionGrantBatches"),
  targetPersonId: v.id("people"),
  displayName: v.string(),
  email: v.string(),
  expectedAccessVersion: v.number(),
  validUntil: v.optional(v.number()),
  createdCount: v.number(),
  reusedCount: v.number(),
  supersededCount: v.number(),
  preservedCount: v.number(),
  changes: v.array(migrationChange),
});

const migrationPreview = v.object({
  bundleId: v.id("permissionBundles"),
  bundleLabel: v.string(),
  sourceBundleVersionId: v.id("permissionBundleVersions"),
  sourceVersion: v.number(),
  destinationBundleVersionId: v.id("permissionBundleVersions"),
  destinationVersion: v.number(),
  previewChecksum: v.string(),
  targetCount: v.number(),
  createdCount: v.number(),
  reusedCount: v.number(),
  supersededCount: v.number(),
  preservedCount: v.number(),
  targets: v.array(migrationTargetPreview),
});

const confirmedMigration = v.object({
  bundleId: v.id("permissionBundles"),
  sourceBundleVersionId: v.id("permissionBundleVersions"),
  destinationBundleVersionId: v.id("permissionBundleVersions"),
  batchIds: v.array(v.id("permissionGrantBatches")),
  targetCount: v.number(),
  createdCount: v.number(),
  reusedCount: v.number(),
  supersededCount: v.number(),
  preservedCount: v.number(),
});

const storedMigrationResult = z
  .object({
    bundleId: z.string(),
    sourceBundleVersionId: z.string(),
    destinationBundleVersionId: z.string(),
    batchIds: z.array(z.string()).max(maximumMigrationTargets),
    targetCount: z.number().int().positive().max(maximumMigrationTargets),
    createdCount: z.number().int().nonnegative(),
    reusedCount: z.number().int().nonnegative(),
    supersededCount: z.number().int().nonnegative(),
    preservedCount: z.number().int().nonnegative(),
  })
  .strict();

type MigrationSelection = {
  sourceGrantBatchId: Id<"permissionGrantBatches">;
  bindings: BundleBinding[];
};

type VersionContext = {
  bundle: BundleDoc;
  sourceVersion: BundleVersionDoc;
  destinationVersion: BundleVersionDoc;
  sourceEntries: ReturnType<typeof normalizeBundleEntries>;
  destinationEntries: ReturnType<typeof normalizeBundleEntries>;
};

type SourceApplicationState = {
  bindings: BundleBinding[];
  activeGrants: GrantDoc[];
  exceptionGrants: GrantDoc[];
};

type PreparedDestinationGrant = {
  grant: ResolvedBundleGrant;
  sourceGrant: GrantDoc | null;
  existingDestinationGrant: GrantDoc | null;
};

type PreparedTarget = {
  sourceBatch: GrantBatchDoc;
  targetSubject: SubjectDoc;
  targetPerson: Doc<"people">;
  bindings: BundleBinding[];
  destinationSourceId: string;
  validUntil: number | undefined;
  supersededGrants: GrantDoc[];
  preservedGrants: GrantDoc[];
  destinationGrants: PreparedDestinationGrant[];
  changes: Array<{
    permissionKey: string;
    scopeType: GrantDoc["scopeType"];
    scopeId?: string;
    action: "add" | "replace" | "remove" | "preserve_exception";
    destinationAlreadyExists: boolean;
  }>;
  createdCount: number;
  reusedCount: number;
  authorizingGrantIds: Id<"permissionGrants">[];
  checksum: string;
};

function checkedPageSize(numItems: number, maximum: number) {
  if (!Number.isSafeInteger(numItems) || numItems < 1 || numItems > maximum) {
    throw new ConvexError({
      code: "INVALID_PAGE_SIZE",
      message: `Load between 1 and ${maximum} items at a time.`,
    });
  }
}

function grantIdentity(grant: {
  permissionKey: string;
  scopeType: GrantDoc["scopeType"];
  scopeId?: string;
}) {
  return [
    grant.permissionKey,
    grant.scopeType,
    grant.scopeType === "event" ? "" : grant.scopeId ?? "",
  ].join("|");
}

function migratableSourceGrant(grant: GrantDoc, now: number) {
  return (
    (grant.status === "active" || grant.status === "scheduled") &&
    (grant.validUntil === undefined || grant.validUntil > now)
  );
}

function effectivePermissionGrant(grant: GrantDoc, now: number) {
  return (
    grant.status === "active" &&
    grant.validFrom <= now &&
    (grant.validUntil === undefined || grant.validUntil > now)
  );
}

async function activePermissionGrants(
  ctx: ReadCtx,
  eventId: Id<"events">,
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
  return grants.filter(
    (grant) => grant.eventId === eventId && effectivePermissionGrant(grant, now),
  );
}

function coversScope(
  grants: readonly GrantDoc[],
  scopeType: "person" | "permission_bundle",
  scopeId: string,
) {
  return grants.some(
    (grant) =>
      grant.scopeType === "event" ||
      (grant.scopeType === scopeType && grant.scopeId === scopeId),
  );
}

function requireCoveredScope(
  grants: readonly GrantDoc[],
  scopeType: "person" | "permission_bundle",
  scopeId: string,
) {
  const matching = grants.filter(
    (grant) =>
      grant.scopeType === "event" ||
      (grant.scopeType === scopeType && grant.scopeId === scopeId),
  );
  if (matching.length === 0) {
    throw new ConvexError({
      code: "ACCESS_DENIED",
      message: "This account does not have permission for that exact resource.",
    });
  }
  return matching.map((grant) => grant._id);
}

async function requireBundleMigrationAccess(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    actorSubjectId: Id<"eventAccessSubjects">;
    bundleId: Id<"permissionBundles">;
  },
) {
  const [readGrants, migrationGrants] = await Promise.all([
    activePermissionGrants(
      ctx,
      args.eventId,
      args.actorSubjectId,
      "access.permission_bundles.read",
    ),
    activePermissionGrants(
      ctx,
      args.eventId,
      args.actorSubjectId,
      "access.permission_bundles.migrate",
    ),
  ]);
  const readGrantIds = requireCoveredScope(
    readGrants,
    "permission_bundle",
    args.bundleId,
  );
  const migrationGrantIds = requireCoveredScope(
    migrationGrants,
    "permission_bundle",
    args.bundleId,
  );
  return [...new Set([...readGrantIds, ...migrationGrantIds])];
}

async function requireTargetMigrationAccess(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    actorSubjectId: Id<"eventAccessSubjects">;
    targetPersonId: Id<"people">;
  },
) {
  const [readGrants, migrationGrants] = await Promise.all([
    activePermissionGrants(
      ctx,
      args.eventId,
      args.actorSubjectId,
      "access.permissions.read",
    ),
    activePermissionGrants(
      ctx,
      args.eventId,
      args.actorSubjectId,
      "access.permission_bundles.migrate",
    ),
  ]);
  const readGrantIds = requireCoveredScope(
    readGrants,
    "person",
    args.targetPersonId,
  );
  const migrationGrantIds = requireCoveredScope(
    migrationGrants,
    "person",
    args.targetPersonId,
  );
  return [...new Set([...readGrantIds, ...migrationGrantIds])];
}

function verifiedVersionEntries(version: BundleVersionDoc) {
  const entries = normalizeBundleEntries(version.entries);
  const checksum = bundleContentChecksum({
    key: version.key,
    label: version.label,
    defaultRole: version.defaultRole,
    entries,
  });
  if (checksum !== version.checksum) {
    throw new Error("Permission bundle version checksum is invalid.");
  }
  return entries;
}

async function versionContext(
  ctx: ReadCtx,
  eventId: Id<"events">,
  sourceBundleVersionId: Id<"permissionBundleVersions">,
): Promise<VersionContext> {
  const sourceVersion = await ctx.db.get(
    "permissionBundleVersions",
    sourceBundleVersionId,
  );
  const bundle = sourceVersion
    ? await ctx.db.get("permissionBundles", sourceVersion.bundleId)
    : null;
  const destinationVersion = bundle?.publishedVersionId
    ? await ctx.db.get("permissionBundleVersions", bundle.publishedVersionId)
    : null;
  if (
    !sourceVersion ||
    !bundle ||
    !destinationVersion ||
    sourceVersion.eventId !== eventId ||
    bundle.eventId !== eventId ||
    destinationVersion.eventId !== eventId ||
    sourceVersion.bundleId !== bundle._id ||
    destinationVersion.bundleId !== bundle._id ||
    sourceVersion.status !== "retired" ||
    bundle.status !== "active" ||
    destinationVersion.status !== "published" ||
    bundle.publishedVersionId !== destinationVersion._id ||
    sourceVersion.version >= destinationVersion.version
  ) {
    throw new ConvexError({
      code: "BUNDLE_MIGRATION_UNAVAILABLE",
      message: "Choose an older retired version of an active bundle with a newer published version.",
    });
  }
  return {
    bundle,
    sourceVersion,
    destinationVersion,
    sourceEntries: verifiedVersionEntries(sourceVersion),
    destinationEntries: verifiedVersionEntries(destinationVersion),
  };
}

async function grantDocuments(
  ctx: ReadCtx,
  grantIds: readonly Id<"permissionGrants">[],
) {
  if (
    grantIds.length > maximumBundleEntries ||
    new Set(grantIds).size !== grantIds.length
  ) {
    throw new Error("Permission grant batch contains an invalid grant set.");
  }
  const grants = await Promise.all(
    grantIds.map((grantId) => ctx.db.get("permissionGrants", grantId)),
  );
  if (grants.some((grant) => grant === null)) {
    throw new Error("Permission grant batch provenance is missing.");
  }
  const present: GrantDoc[] = [];
  for (const grant of grants) {
    if (grant) present.push(grant);
  }
  return present;
}

function inferredBindings(
  sourceEntries: ReturnType<typeof normalizeBundleEntries>,
  resultGrants: readonly GrantDoc[],
) {
  if (sourceEntries.length !== resultGrants.length) {
    throw new Error("Legacy permission bundle application cannot resolve its original bindings.");
  }
  const collected: BundleBinding[] = [];
  const bindingValues = new Map<string, string>();
  for (let index = 0; index < sourceEntries.length; index += 1) {
    const entry = sourceEntries[index];
    const grant = resultGrants[index];
    if (
      !entry ||
      !grant ||
      entry.permissionKey !== grant.permissionKey ||
      entry.scopeType !== grant.scopeType
    ) {
      throw new Error("Legacy permission bundle grant order is inconsistent.");
    }
    if (entry.scopeSource !== "binding" || entry.bindingKey === undefined) continue;
    if (grant.scopeType === "event" || grant.scopeId === undefined) {
      throw new Error("Legacy permission bundle binding is missing its resource.");
    }
    const prior = bindingValues.get(entry.bindingKey);
    if (prior !== undefined && prior !== grant.scopeId) {
      throw new Error("Legacy permission bundle binding resolved to multiple resources.");
    }
    if (prior === undefined) {
      bindingValues.set(entry.bindingKey, grant.scopeId);
      collected.push({ key: entry.bindingKey, scopeId: grant.scopeId });
    }
  }
  return normalizeBundleBindings(
    bundleBindingRequirements(sourceEntries),
    collected,
  );
}

function validateGrantOwner(
  grant: GrantDoc,
  args: {
    eventId: Id<"events">;
    targetPersonId: Id<"people">;
    targetSubjectId: Id<"eventAccessSubjects">;
  },
) {
  if (
    grant.eventId !== args.eventId ||
    grant.personId !== args.targetPersonId ||
    grant.eventAccessSubjectId !== args.targetSubjectId ||
    grant.sourceType !== "bundle"
  ) {
    throw new Error("Permission bundle grant is outside its recorded target.");
  }
}

async function sourceApplicationState(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    sourceVersion: BundleVersionDoc;
    sourceEntries: ReturnType<typeof normalizeBundleEntries>;
    sourceBatch: GrantBatchDoc;
    targetSubject: SubjectDoc;
  },
): Promise<SourceApplicationState | null> {
  if (
    args.sourceBatch.eventId !== args.eventId ||
    args.sourceBatch.bundleId !== args.sourceVersion.bundleId ||
    args.sourceBatch.bundleVersionId !== args.sourceVersion._id ||
    args.sourceBatch.status !== "complete" ||
    (args.sourceBatch.action !== "apply_bundle" &&
      args.sourceBatch.action !== "migrate_bundle") ||
    args.sourceBatch.targetPersonId !== args.targetSubject.personId
  ) {
    throw new ConvexError({
      code: "BUNDLE_MIGRATION_SOURCE_CHANGED",
      message: "The selected bundle application is no longer a valid migration source.",
    });
  }
  const [resultGrants, preservedGrants] = await Promise.all([
    grantDocuments(ctx, args.sourceBatch.resultGrantIds),
    grantDocuments(ctx, args.sourceBatch.preservedGrantIds ?? []),
  ]);
  for (const grant of [...resultGrants, ...preservedGrants]) {
    validateGrantOwner(grant, {
      eventId: args.eventId,
      targetPersonId: args.sourceBatch.targetPersonId,
      targetSubjectId: args.targetSubject._id,
    });
  }
  const bindings =
    args.sourceBatch.resolvedBindings !== undefined
      ? normalizeBundleBindings(
          bundleBindingRequirements(args.sourceEntries),
          args.sourceBatch.resolvedBindings,
        )
      : inferredBindings(args.sourceEntries, resultGrants);
  const planned = await resolveBundleGrants(ctx, {
    eventId: args.eventId,
    targetPersonId: args.sourceBatch.targetPersonId,
    entries: args.sourceEntries,
    bindings,
  });
  const stateByIdentity = new Map<string, GrantDoc>();
  for (const grant of [...resultGrants, ...preservedGrants]) {
    const identity = grantIdentity(grant);
    if (stateByIdentity.has(identity)) {
      throw new Error("Permission bundle application records one grant identity twice.");
    }
    stateByIdentity.set(identity, grant);
  }
  const plannedIdentities = new Set(planned.map(grantIdentity));
  if (
    stateByIdentity.size !== plannedIdentities.size ||
    [...stateByIdentity.keys()].some((identity) => !plannedIdentities.has(identity))
  ) {
    throw new Error("Permission bundle application no longer matches its version.");
  }
  const now = Date.now();
  const preservedIds = new Set(preservedGrants.map((grant) => grant._id));
  const activeGrants: GrantDoc[] = [];
  const exceptionGrants: GrantDoc[] = [];
  for (const plannedGrant of planned) {
    const recorded = stateByIdentity.get(grantIdentity(plannedGrant));
    if (!recorded) {
      throw new Error("Permission bundle application is missing a planned grant.");
    }
    if (!preservedIds.has(recorded._id) && migratableSourceGrant(recorded, now)) {
      activeGrants.push(recorded);
    } else {
      exceptionGrants.push(recorded);
    }
  }
  if (activeGrants.length === 0) return null;
  if (!resultGrants.some((grant) => grant.grantBatchId === args.sourceBatch._id)) {
    return null;
  }
  return { bindings, activeGrants, exceptionGrants };
}

function destinationValidity(
  event: Doc<"events">,
  sourceValidUntil: number | undefined,
  now: number,
) {
  const validUntil =
    sourceValidUntil === undefined
      ? event.endsAt
      : event.endsAt === undefined
        ? sourceValidUntil
        : Math.min(sourceValidUntil, event.endsAt);
  if (validUntil !== undefined && validUntil <= now) {
    throw new ConvexError({
      code: "BUNDLE_MIGRATION_SOURCE_EXPIRED",
      message: "That bundle application no longer has a future validity window.",
    });
  }
  return validUntil;
}

function candidateBindings(
  context: VersionContext,
  sourceBindings: readonly BundleBinding[],
) {
  const sourceRequirements = new Map(
    bundleBindingRequirements(context.sourceEntries).map((requirement) => [
      requirement.key,
      requirement,
    ]),
  );
  const sourceValues = new Map(
    sourceBindings.map((binding) => [binding.key, binding.scopeId]),
  );
  return bundleBindingRequirements(context.destinationEntries).map((requirement) => {
    const sourceRequirement = sourceRequirements.get(requirement.key);
    const suggestedScopeId =
      sourceRequirement?.scopeType === requirement.scopeType
        ? sourceValues.get(requirement.key)
        : undefined;
    return {
      key: requirement.key,
      scopeType: requirement.scopeType,
      permissionKey: requirement.permissionKey,
      ...(suggestedScopeId !== undefined ? { suggestedScopeId } : {}),
    };
  });
}

async function prepareTarget(
  ctx: ReadCtx,
  args: {
    event: Doc<"events">;
    actorSubjectId: Id<"eventAccessSubjects">;
    context: VersionContext;
    selection: MigrationSelection;
    bundleGrantIds: readonly Id<"permissionGrants">[];
    now: number;
  },
): Promise<PreparedTarget> {
  const sourceBatch = await ctx.db.get(
    "permissionGrantBatches",
    args.selection.sourceGrantBatchId,
  );
  if (!sourceBatch) {
    throw new ConvexError({
      code: "BUNDLE_MIGRATION_SOURCE_CHANGED",
      message: "The selected bundle application no longer exists.",
    });
  }
  const [targetSubject, targetPerson, targetGrantIds] = await Promise.all([
    requireEventSubject(ctx, args.event._id, sourceBatch.targetPersonId),
    ctx.db.get("people", sourceBatch.targetPersonId),
    requireTargetMigrationAccess(ctx, {
      eventId: args.event._id,
      actorSubjectId: args.actorSubjectId,
      targetPersonId: sourceBatch.targetPersonId,
    }),
  ]);
  if (!targetPerson || targetPerson.status !== "active") {
    throw new ConvexError({
      code: "BUNDLE_MIGRATION_TARGET_UNAVAILABLE",
      message: "The selected target account is unavailable.",
    });
  }
  const sourceState = await sourceApplicationState(ctx, {
    eventId: args.event._id,
    sourceVersion: args.context.sourceVersion,
    sourceEntries: args.context.sourceEntries,
    sourceBatch,
    targetSubject,
  });
  if (!sourceState) {
    throw new ConvexError({
      code: "BUNDLE_MIGRATION_SOURCE_CHANGED",
      message: "The selected application has no current source grants left to migrate.",
    });
  }
  const bindings = normalizeBundleBindings(
    bundleBindingRequirements(args.context.destinationEntries),
    args.selection.bindings,
  );
  const destination = await resolveBundleGrants(ctx, {
    eventId: args.event._id,
    targetPersonId: sourceBatch.targetPersonId,
    entries: args.context.destinationEntries,
    bindings,
  });
  const validUntil = destinationValidity(
    args.event,
    sourceBatch.validUntil,
    args.now,
  );
  const destinationSourceId = resolvedBundleSourceId({
    bundleVersionId: args.context.destinationVersion._id,
    targetPersonId: sourceBatch.targetPersonId,
    validUntil,
    grants: destination,
  });
  const existingDestinationHistory = await ctx.db
    .query("permissionGrants")
    .withIndex("by_source", (index) =>
      index
        .eq("eventId", args.event._id)
        .eq("sourceType", "bundle")
        .eq("sourceId", destinationSourceId),
    )
    .take(maximumBundleEntries * 5 + 1);
  if (existingDestinationHistory.length > maximumBundleEntries * 5) {
    throw new Error("Destination bundle source history exceeds the supported grant bound.");
  }
  for (const grant of existingDestinationHistory) {
    validateGrantOwner(grant, {
      eventId: args.event._id,
      targetPersonId: sourceBatch.targetPersonId,
      targetSubjectId: targetSubject._id,
    });
    if (grant.validUntil !== validUntil) {
      throw new Error("Destination bundle grant validity is inconsistent.");
    }
  }
  const activeByIdentity = new Map(
    sourceState.activeGrants.map((grant) => [grantIdentity(grant), grant]),
  );
  const exceptionByIdentity = new Map(
    sourceState.exceptionGrants.map((grant) => [grantIdentity(grant), grant]),
  );
  const existingByIdentity = new Map<string, GrantDoc>();
  const destinationExceptionByIdentity = new Map<string, GrantDoc>();
  for (const grant of existingDestinationHistory) {
    const identity = grantIdentity(grant);
    if (migratableSourceGrant(grant, args.now)) {
      if (existingByIdentity.has(identity)) {
        throw new Error("Destination bundle source has two current grants for one identity.");
      }
      existingByIdentity.set(identity, grant);
      continue;
    }
    const prior = destinationExceptionByIdentity.get(identity);
    if (!prior || prior.createdAt < grant.createdAt) {
      destinationExceptionByIdentity.set(identity, grant);
    }
  }
  const destinationIdentities = new Set(destination.map(grantIdentity));
  const destinationGrants: PreparedDestinationGrant[] = [];
  const preservedGrants: GrantDoc[] = [];
  const changes: PreparedTarget["changes"] = [];
  let createdCount = 0;
  let reusedCount = 0;
  for (const planned of destination) {
    const identity = grantIdentity(planned);
    const sourceGrant = activeByIdentity.get(identity) ?? null;
    const existing = existingByIdentity.get(identity) ?? null;
    const exception = existing
      ? null
      : destinationExceptionByIdentity.get(identity) ??
        exceptionByIdentity.get(identity) ??
        null;
    if (exception) {
      preservedGrants.push(exception);
      changes.push({
        permissionKey: planned.permissionKey,
        scopeType: planned.scopeType,
        ...(planned.scopeType === "event" ? {} : { scopeId: planned.scopeId }),
        action: "preserve_exception",
        destinationAlreadyExists: false,
      });
      continue;
    }
    destinationGrants.push({
      grant: planned,
      sourceGrant,
      existingDestinationGrant: existing,
    });
    if (existing) reusedCount += 1;
    else createdCount += 1;
    changes.push({
      permissionKey: planned.permissionKey,
      scopeType: planned.scopeType,
      ...(planned.scopeType === "event" ? {} : { scopeId: planned.scopeId }),
      action: sourceGrant ? "replace" : "add",
      destinationAlreadyExists: existing !== null,
    });
  }
  for (const sourceGrant of sourceState.activeGrants) {
    if (destinationIdentities.has(grantIdentity(sourceGrant))) continue;
    changes.push({
      permissionKey: sourceGrant.permissionKey,
      scopeType: sourceGrant.scopeType,
      ...(sourceGrant.scopeType === "event"
        ? {}
        : { scopeId: sourceGrant.scopeId }),
      action: "remove",
      destinationAlreadyExists: false,
    });
  }
  const checksumParts: OperationFingerprintPart[] = [
    sourceBatch._id,
    sourceBatch.bundleVersionId,
    targetSubject._id,
    targetSubject.accessVersion,
    validUntil ?? null,
    destinationSourceId,
  ];
  for (const binding of bindings) checksumParts.push(binding.key, binding.scopeId);
  for (const grant of [...sourceState.activeGrants, ...sourceState.exceptionGrants]) {
    checksumParts.push(
      grant._id,
      grant.status,
      grant.permissionKey,
      grant.scopeType,
      grant.scopeId ?? null,
      grant.validFrom,
      grant.validUntil ?? null,
    );
  }
  for (const grant of existingDestinationHistory) {
    checksumParts.push(
      grant._id,
      grant.permissionKey,
      grant.scopeType,
      grant.scopeId ?? null,
      grant.validFrom,
      grant.validUntil ?? null,
    );
  }
  for (const change of changes) {
    checksumParts.push(
      change.permissionKey,
      change.scopeType,
      change.scopeId ?? null,
      change.action,
      change.destinationAlreadyExists,
    );
  }
  return {
    sourceBatch,
    targetSubject,
    targetPerson,
    bindings,
    destinationSourceId,
    validUntil,
    supersededGrants: sourceState.activeGrants,
    preservedGrants,
    destinationGrants,
    changes,
    createdCount,
    reusedCount,
    authorizingGrantIds: [...new Set([...args.bundleGrantIds, ...targetGrantIds])],
    checksum: operationFingerprint(checksumParts),
  };
}

async function prepareMigration(
  ctx: ReadCtx,
  args: {
    event: Doc<"events">;
    actorSubjectId: Id<"eventAccessSubjects">;
    sourceBundleVersionId: Id<"permissionBundleVersions">;
    selections: readonly MigrationSelection[];
  },
) {
  if (
    args.selections.length < 1 ||
    args.selections.length > maximumMigrationTargets
  ) {
    throw new ConvexError({
      code: "INVALID_BUNDLE_MIGRATION_SIZE",
      message: `Migrate between 1 and ${maximumMigrationTargets} bundle applications at a time.`,
    });
  }
  const sortedSelections = [...args.selections].sort((left, right) =>
    left.sourceGrantBatchId.localeCompare(right.sourceGrantBatchId),
  );
  if (
    new Set(sortedSelections.map((selection) => selection.sourceGrantBatchId))
      .size !== sortedSelections.length
  ) {
    throw new ConvexError({
      code: "DUPLICATE_BUNDLE_MIGRATION_TARGET",
      message: "Choose each source bundle application once.",
    });
  }
  const context = await versionContext(
    ctx,
    args.event._id,
    args.sourceBundleVersionId,
  );
  const bundleGrantIds = await requireBundleMigrationAccess(ctx, {
    eventId: args.event._id,
    actorSubjectId: args.actorSubjectId,
    bundleId: context.bundle._id,
  });
  const now = Date.now();
  const targets = await Promise.all(
    sortedSelections.map((selection) =>
      prepareTarget(ctx, {
        event: args.event,
        actorSubjectId: args.actorSubjectId,
        context,
        selection,
        bundleGrantIds,
        now,
      }),
    ),
  );
  const destinationSourceIds = targets.map((target) => target.destinationSourceId);
  if (new Set(destinationSourceIds).size !== destinationSourceIds.length) {
    throw new ConvexError({
      code: "DUPLICATE_BUNDLE_MIGRATION_DESTINATION",
      message: "Two selected applications resolve to the same destination. Migrate them separately.",
    });
  }
  const sourceGrantIds = targets.flatMap((target) =>
    target.supersededGrants.map((grant) => grant._id),
  );
  if (new Set(sourceGrantIds).size !== sourceGrantIds.length) {
    throw new ConvexError({
      code: "DUPLICATE_BUNDLE_MIGRATION_SOURCE",
      message: "Two selected applications share a source grant. Migrate them separately.",
    });
  }
  const changeCount = targets.reduce(
    (total, target) => total + target.changes.length,
    0,
  );
  if (changeCount > maximumMigrationChanges) {
    throw new ConvexError({
      code: "BUNDLE_MIGRATION_TOO_LARGE",
      message: "This migration resolves too many grant changes for one atomic operation.",
    });
  }
  const previewChecksum = operationFingerprint([
    context.bundle._id,
    context.sourceVersion._id,
    context.sourceVersion.checksum,
    context.destinationVersion._id,
    context.destinationVersion.checksum,
    ...targets.flatMap((target) => [target.sourceBatch._id, target.checksum]),
  ]);
  return { context, targets, previewChecksum };
}

function publicPreview(prepared: Awaited<ReturnType<typeof prepareMigration>>) {
  const totals = prepared.targets.reduce(
    (current, target) => ({
      createdCount: current.createdCount + target.createdCount,
      reusedCount: current.reusedCount + target.reusedCount,
      supersededCount:
        current.supersededCount + target.supersededGrants.length,
      preservedCount: current.preservedCount + target.preservedGrants.length,
    }),
    {
      createdCount: 0,
      reusedCount: 0,
      supersededCount: 0,
      preservedCount: 0,
    },
  );
  return {
    bundleId: prepared.context.bundle._id,
    bundleLabel: prepared.context.destinationVersion.label,
    sourceBundleVersionId: prepared.context.sourceVersion._id,
    sourceVersion: prepared.context.sourceVersion.version,
    destinationBundleVersionId: prepared.context.destinationVersion._id,
    destinationVersion: prepared.context.destinationVersion.version,
    previewChecksum: prepared.previewChecksum,
    targetCount: prepared.targets.length,
    ...totals,
    targets: prepared.targets.map((target) => ({
      sourceGrantBatchId: target.sourceBatch._id,
      targetPersonId: target.targetPerson._id,
      displayName: target.targetPerson.displayName,
      email: target.targetPerson.verifiedEmail,
      expectedAccessVersion: target.targetSubject.accessVersion,
      ...(target.validUntil !== undefined
        ? { validUntil: target.validUntil }
        : {}),
      createdCount: target.createdCount,
      reusedCount: target.reusedCount,
      supersededCount: target.supersededGrants.length,
      preservedCount: target.preservedGrants.length,
      changes: target.changes,
    })),
  };
}

export const sources = query({
  args: {
    eventSlug: v.string(),
    bundleId: v.id("permissionBundles"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(sourceVersionSummary),
  handler: async (ctx, args) => {
    checkedPageSize(args.paginationOpts.numItems, maximumSourceVersionPageSize);
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    const bundle = await ctx.db.get("permissionBundles", args.bundleId);
    if (
      !bundle ||
      bundle.eventId !== event._id ||
      bundle.status !== "active" ||
      bundle.publishedVersionId === undefined
    ) {
      throw new ConvexError({
        code: "BUNDLE_MIGRATION_UNAVAILABLE",
        message: "This permission bundle has no published migration destination.",
      });
    }
    await requireBundleMigrationAccess(ctx, {
      eventId: event._id,
      actorSubjectId: actorSubject._id,
      bundleId: bundle._id,
    });
    const page = await ctx.db
      .query("permissionBundleVersions")
      .withIndex("by_bundle_status", (index) =>
        index.eq("bundleId", bundle._id).eq("status", "retired"),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...page,
      page: page.page.map((version) => {
        if (version.eventId !== event._id) {
          throw new Error("Permission bundle version is outside its event.");
        }
        verifiedVersionEntries(version);
        return {
          id: version._id,
          label: version.label,
          version: version.version,
          entryCount: version.entries.length,
          checksum: version.checksum,
          ...(version.publishedAt !== undefined
            ? { publishedAt: version.publishedAt }
            : {}),
          ...(version.retiredAt !== undefined
            ? { retiredAt: version.retiredAt }
            : {}),
        };
      }),
    };
  },
});

export const candidates = query({
  args: {
    eventSlug: v.string(),
    sourceBundleVersionId: v.id("permissionBundleVersions"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(migrationCandidate),
  handler: async (ctx, args) => {
    checkedPageSize(args.paginationOpts.numItems, maximumCandidatePageSize);
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    const context = await versionContext(
      ctx,
      event._id,
      args.sourceBundleVersionId,
    );
    await requireBundleMigrationAccess(ctx, {
      eventId: event._id,
      actorSubjectId: actorSubject._id,
      bundleId: context.bundle._id,
    });
    const [readGrants, migrationGrants, page] = await Promise.all([
      activePermissionGrants(
        ctx,
        event._id,
        actorSubject._id,
        "access.permissions.read",
      ),
      activePermissionGrants(
        ctx,
        event._id,
        actorSubject._id,
        "access.permission_bundles.migrate",
      ),
      ctx.db
        .query("permissionGrantBatches")
        .withIndex("by_event_bundle_version_status_created", (index) =>
          index
            .eq("eventId", event._id)
            .eq("bundleVersionId", context.sourceVersion._id)
            .eq("status", "complete"),
        )
        .order("desc")
        .paginate(args.paginationOpts),
    ]);
    const visible: Array<{
      sourceGrantBatchId: Id<"permissionGrantBatches">;
      targetPersonId: Id<"people">;
      displayName: string;
      email: string;
      expectedAccessVersion: number;
      activeGrantCount: number;
      preservedExceptionCount: number;
      validUntil?: number;
      bindings: Array<{
        key: string;
        scopeType: GrantDoc["scopeType"];
        permissionKey: PermissionKey;
        suggestedScopeId?: string;
      }>;
    }> = [];
    for (const batch of page.page) {
      if (
        !coversScope(readGrants, "person", batch.targetPersonId) ||
        !coversScope(migrationGrants, "person", batch.targetPersonId)
      ) {
        continue;
      }
      const [subject, targetPerson] = await Promise.all([
        ctx.db
          .query("eventAccessSubjects")
          .withIndex("by_event_person", (index) =>
            index.eq("eventId", event._id).eq("personId", batch.targetPersonId),
          )
          .unique(),
        ctx.db.get("people", batch.targetPersonId),
      ]);
      if (
        !subject ||
        subject.status !== "active" ||
        !targetPerson ||
        targetPerson.status !== "active" ||
        (batch.validUntil !== undefined && batch.validUntil <= Date.now()) ||
        (event.endsAt !== undefined && event.endsAt <= Date.now())
      ) {
        continue;
      }
      const sourceState = await sourceApplicationState(ctx, {
        eventId: event._id,
        sourceVersion: context.sourceVersion,
        sourceEntries: context.sourceEntries,
        sourceBatch: batch,
        targetSubject: subject,
      });
      if (!sourceState) continue;
      visible.push({
        sourceGrantBatchId: batch._id,
        targetPersonId: targetPerson._id,
        displayName: targetPerson.displayName,
        email: targetPerson.verifiedEmail,
        expectedAccessVersion: subject.accessVersion,
        activeGrantCount: sourceState.activeGrants.length,
        preservedExceptionCount: sourceState.exceptionGrants.length,
        ...(batch.validUntil !== undefined ? { validUntil: batch.validUntil } : {}),
        bindings: candidateBindings(context, sourceState.bindings),
      });
    }
    return { ...page, page: visible };
  },
});

export const preview = query({
  args: {
    eventSlug: v.string(),
    sourceBundleVersionId: v.id("permissionBundleVersions"),
    selections: v.array(migrationSelectionInput),
  },
  returns: migrationPreview,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    return publicPreview(
      await prepareMigration(ctx, {
        event,
        actorSubjectId: actorSubject._id,
        sourceBundleVersionId: args.sourceBundleVersionId,
        selections: args.selections,
      }),
    );
  },
});

export const confirm = mutation({
  args: {
    eventSlug: v.string(),
    sourceBundleVersionId: v.id("permissionBundleVersions"),
    selections: v.array(confirmedMigrationSelectionInput),
    previewChecksum: v.string(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: confirmedMigration,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const operationId = normalizedText(
      args.clientOperationId,
      "Client operation ID",
      10,
      100,
    );
    const normalizedSelections = [...args.selections].sort((left, right) =>
      left.sourceGrantBatchId.localeCompare(right.sourceGrantBatchId),
    );
    const requestFingerprint = operationFingerprint([
      args.sourceBundleVersionId,
      args.previewChecksum,
      reason,
      ...normalizedSelections.flatMap((selection) => [
        selection.sourceGrantBatchId,
        selection.expectedAccessVersion,
        operationFingerprint(
          selection.bindings.flatMap((binding) => [binding.key, binding.scopeId]),
        ),
      ]),
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "permissionBundleMigrations.confirm",
      requestFingerprint,
    });
    if (prior) {
      const stored = storedOperationResult(
        prior.resultJson,
        "permission bundle migration",
        storedMigrationResult,
      );
      const bundleId = ctx.db.normalizeId("permissionBundles", stored.bundleId);
      const sourceBundleVersionId = ctx.db.normalizeId(
        "permissionBundleVersions",
        stored.sourceBundleVersionId,
      );
      const destinationBundleVersionId = ctx.db.normalizeId(
        "permissionBundleVersions",
        stored.destinationBundleVersionId,
      );
      const batchIds = stored.batchIds.map((id) =>
        ctx.db.normalizeId("permissionGrantBatches", id),
      );
      if (
        !bundleId ||
        !sourceBundleVersionId ||
        !destinationBundleVersionId ||
        batchIds.some((id) => id === null)
      ) {
        throw new Error("Prior permission bundle migration IDs are invalid.");
      }
      const resolvedBatchIds: Id<"permissionGrantBatches">[] = [];
      for (const batchId of batchIds) {
        if (batchId) resolvedBatchIds.push(batchId);
      }
      return {
        bundleId,
        sourceBundleVersionId,
        destinationBundleVersionId,
        batchIds: resolvedBatchIds,
        targetCount: stored.targetCount,
        createdCount: stored.createdCount,
        reusedCount: stored.reusedCount,
        supersededCount: stored.supersededCount,
        preservedCount: stored.preservedCount,
      };
    }
    const prepared = await prepareMigration(ctx, {
      event,
      actorSubjectId: actorSubject._id,
      sourceBundleVersionId: args.sourceBundleVersionId,
      selections: normalizedSelections,
    });
    const expectedVersions = new Map(
      normalizedSelections.map((selection) => [
        selection.sourceGrantBatchId,
        selection.expectedAccessVersion,
      ]),
    );
    if (
      prepared.previewChecksum !== args.previewChecksum ||
      prepared.targets.some(
        (target) =>
          expectedVersions.get(target.sourceBatch._id) !==
          target.targetSubject.accessVersion,
      )
    ) {
      throw new ConvexError({
        code: "BUNDLE_MIGRATION_PREVIEW_STALE",
        message: "The bundle applications or target access changed. Review the migration again.",
      });
    }
    const now = Date.now();
    const pendingBatches: Array<{
      id: Id<"permissionGrantBatches">;
      target: PreparedTarget;
      resultGrantIds: Id<"permissionGrants">[];
      createdCount: number;
    }> = [];
    for (const target of prepared.targets) {
      const batchId = await ctx.db.insert("permissionGrantBatches", {
        eventId: event._id,
        clientOperationId: operationFingerprint([
          operationId,
          target.sourceBatch._id,
        ]),
        requestFingerprint: target.checksum,
        action: "migrate_bundle",
        actorPersonId: person._id,
        targetPersonId: target.targetPerson._id,
        bundleId: prepared.context.bundle._id,
        bundleVersionId: prepared.context.destinationVersion._id,
        sourceBundleVersionId: prepared.context.sourceVersion._id,
        sourceGrantBatchId: target.sourceBatch._id,
        resolvedBindings: target.bindings,
        reason,
        authorizingGrantIds: target.authorizingGrantIds,
        expectedAccessVersion: target.targetSubject.accessVersion,
        previewChecksum: target.checksum,
        ...(target.validUntil !== undefined
          ? { validUntil: target.validUntil }
          : {}),
        status: "applying",
        resultGrantIds: [],
        supersededGrantIds: target.supersededGrants.map((grant) => grant._id),
        preservedGrantIds: target.preservedGrants.map((grant) => grant._id),
        createdCount: 0,
        resultAccessVersion: target.targetSubject.accessVersion,
        createdAt: now,
      });
      const resultGrantIds: Id<"permissionGrants">[] = [];
      let createdCount = 0;
      for (const destination of target.destinationGrants) {
        if (destination.existingDestinationGrant) {
          resultGrantIds.push(destination.existingDestinationGrant._id);
          continue;
        }
        const validFrom =
          destination.sourceGrant && destination.sourceGrant.validFrom > now
            ? destination.sourceGrant.validFrom
            : now;
        const result = await insertPermissionGrant(ctx, {
          eventId: event._id,
          personId: target.targetPerson._id,
          eventAccessSubjectId: target.targetSubject._id,
          permissionKey: destination.grant.permissionKey,
          ...(destination.grant.scopeType === "event"
            ? { scopeType: "event" as const }
            : {
                scopeType: destination.grant.scopeType,
                scopeId: destination.grant.scopeId,
              }),
          sourceType: "bundle",
          sourceId: target.destinationSourceId,
          grantBatchId: batchId,
          grantedByPersonId: person._id,
          reason,
          validFrom,
          ...(target.validUntil !== undefined
            ? { validUntil: target.validUntil }
            : {}),
        });
        resultGrantIds.push(result.grantId);
        if (result.created) createdCount += 1;
      }
      for (const sourceGrant of target.supersededGrants) {
        await ctx.db.patch("permissionGrants", sourceGrant._id, {
          status: "superseded",
          revokedAt: now,
          revokedByPersonId: person._id,
          revokeReason: reason,
        });
      }
      pendingBatches.push({
        id: batchId,
        target,
        resultGrantIds,
        createdCount,
      });
    }
    const finalVersions = new Map<Id<"eventAccessSubjects">, number>();
    for (const target of prepared.targets) {
      if (!finalVersions.has(target.targetSubject._id)) {
        const accessVersion = target.targetSubject.accessVersion + 1;
        finalVersions.set(target.targetSubject._id, accessVersion);
        await ctx.db.patch("eventAccessSubjects", target.targetSubject._id, {
          accessVersion,
          updatedAt: now,
        });
      }
    }
    for (const batch of pendingBatches) {
      const resultAccessVersion = finalVersions.get(batch.target.targetSubject._id);
      if (resultAccessVersion === undefined) {
        throw new Error("Permission bundle migration target version is missing.");
      }
      await ctx.db.patch("permissionGrantBatches", batch.id, {
        status: "complete",
        resultGrantIds: batch.resultGrantIds,
        createdCount: batch.createdCount,
        resultAccessVersion,
        completedAt: now,
      });
    }
    const result = {
      bundleId: prepared.context.bundle._id,
      sourceBundleVersionId: prepared.context.sourceVersion._id,
      destinationBundleVersionId: prepared.context.destinationVersion._id,
      batchIds: pendingBatches.map((batch) => batch.id),
      targetCount: prepared.targets.length,
      createdCount: pendingBatches.reduce(
        (total, batch) => total + batch.createdCount,
        0,
      ),
      reusedCount: prepared.targets.reduce(
        (total, target) => total + target.reusedCount,
        0,
      ),
      supersededCount: prepared.targets.reduce(
        (total, target) => total + target.supersededGrants.length,
        0,
      ),
      preservedCount: prepared.targets.reduce(
        (total, target) => total + target.preservedGrants.length,
        0,
      ),
    };
    const authorizingGrantIds = [
      ...new Set(
        prepared.targets.flatMap((target) => target.authorizingGrantIds),
      ),
    ];
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "access.permission_bundles.migrate",
      grantIds: authorizingGrantIds,
      scopeType: "permission_bundle",
      scopeId: prepared.context.bundle._id,
      action: "access.permission_bundle_migrated",
      targetType: "permission_bundle_version",
      targetId: prepared.context.destinationVersion._id,
      previousSummary: JSON.stringify({
        version: prepared.context.sourceVersion.version,
        targetCount: result.targetCount,
        grantCount: result.supersededCount,
      }),
      nextSummary: JSON.stringify({
        version: prepared.context.destinationVersion.version,
        targetCount: result.targetCount,
        createdCount: result.createdCount,
        reusedCount: result.reusedCount,
        preservedCount: result.preservedCount,
      }),
      reason,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "permissionBundleMigrations.confirm",
      requestFingerprint,
      targetType: "permission_bundle",
      targetId: prepared.context.bundle._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    return result;
  },
});
