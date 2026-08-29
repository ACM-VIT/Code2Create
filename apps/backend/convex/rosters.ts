import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  ensurePerson,
  requireCurrentPerson,
  requireEventSubject,
  requireFreshAuthSession,
  requireVerifiedGoogleIdentity,
  sensitiveCommandSessionMaxAgeMs,
} from "./lib/identity";
import {
  bundleBindingRequirements,
  bundleContentChecksum,
  normalizeBundleEntries,
  resolveBundleGrants,
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
import {
  addEventSubjectSelfGrants,
  insertPermissionGrant,
  currentSourceGrants,
  requirePermission,
} from "./lib/permissions";
import { selfScopeKind } from "./lib/grantScopes";
import { grantSupremeRolePermissions } from "./lib/rolePermissions";
import { normalizeEmail, normalizedText } from "./lib/strings";
import { eventRoleLabels } from "@code2create/domain";

import { eventRole, rosterEntryStatus } from "./values";

type ReadCtx = QueryCtx | MutationCtx;
type GrantDoc = Doc<"permissionGrants">;
type RosterEntryDoc = Doc<"rosterEntries">;
type BundleVersionDoc = Doc<"permissionBundleVersions">;

const rosterEmail = z.email().max(254);
const maximumRowsPerImport = 200;
const maximumBundlesPerImport = 8;
const maximumExactVisibleEntries = 500;
const maximumPermissionGrantsPerKey = 500;
const maximumBundlesPerEvent = 100;
const claimedOutcome: "claimed" = "claimed";
const alreadyClaimedOutcome: "already_claimed" = "already_claimed";
const revokedStatus: "revoked" = "revoked";

const rosterImportOperationResult = z
  .object({
    rosterImportId: z.string().min(1),
    createdCount: z.number().int().nonnegative(),
    replacedCount: z.number().int().nonnegative(),
    unchangedCount: z.number().int().nonnegative(),
    alreadyClaimedCount: z.number().int().nonnegative(),
  })
  .strict();

const rosterClaimOperationResult = z
  .object({
    outcome: z.enum(["claimed", "already_claimed"]),
    rosterEntryId: z.string().min(1),
    personId: z.string().min(1),
    eventAccessSubjectId: z.string().min(1),
    role: z.enum(["supreme", "board", "sc", "jc", "external_judge"]),
    bundleCount: z.number().int().nonnegative(),
    grantCount: z.number().int().nonnegative(),
    accessVersion: z.number().int().positive(),
  })
  .strict();

const importRow = v.object({
  rowNumber: v.number(),
  email: v.string(),
  displayName: v.string(),
  role: eventRole,
});

const importRequestArgs = {
  eventSlug: v.string(),
  sourceName: v.string(),
  sourceFileName: v.optional(v.string()),
  validFrom: v.number(),
  validUntil: v.number(),
  bundleVersionIds: v.array(v.id("permissionBundleVersions")),
  rows: v.array(importRow),
  reason: v.string(),
};

const rowOutcome = v.union(
  v.literal("create"),
  v.literal("replace_pending"),
  v.literal("replace_expired"),
  v.literal("unchanged_pending"),
  v.literal("already_claimed"),
);

const previewResult = v.object({
  previewChecksum: v.string(),
  configurationChecksum: v.string(),
  validFrom: v.number(),
  validUntil: v.number(),
  bundles: v.array(
    v.object({
      bundleId: v.id("permissionBundles"),
      versionId: v.id("permissionBundleVersions"),
      label: v.string(),
      version: v.number(),
      entryCount: v.number(),
    }),
  ),
  rows: v.array(
    v.object({
      rowNumber: v.number(),
      email: v.string(),
      displayName: v.string(),
      role: eventRole,
      outcome: rowOutcome,
    }),
  ),
  counts: v.object({
    create: v.number(),
    replace: v.number(),
    unchanged: v.number(),
    alreadyClaimed: v.number(),
  }),
});

type ImportRequest = {
  sourceName: string;
  sourceFileName?: string;
  validFrom: number;
  validUntil: number;
  bundleVersionIds: Id<"permissionBundleVersions">[];
  rows: Array<{
    rowNumber: number;
    email: string;
    displayName: string;
    role: Doc<"rosterEntries">["role"];
  }>;
  reason: string;
};

function exactRosterEmail(value: string) {
  const email = normalizeEmail(value);
  if (!rosterEmail.safeParse(email).success) {
    throw new ConvexError({
      code: "INVALID_ROSTER_EMAIL",
      message: "Every roster row needs one complete Google account email address.",
    });
  }
  return email;
}

function checkedValidity(
  event: Doc<"events">,
  validFrom: number,
  validUntil: number,
  now: number,
) {
  if (event.endsAt === undefined) {
    throw new ConvexError({
      code: "EVENT_SCHEDULE_REQUIRED",
      message: "Set the event end time before importing access from a roster.",
    });
  }
  if (
    !Number.isSafeInteger(validFrom) ||
    !Number.isSafeInteger(validUntil) ||
    validUntil <= validFrom ||
    validUntil <= now ||
    validUntil > event.endsAt
  ) {
    throw new ConvexError({
      code: "INVALID_ROSTER_VALIDITY",
      message: "Roster access must end after it starts, remain in the future, and not outlive the event.",
    });
  }
  return { validFrom, validUntil };
}

function normalizeImportRequest(
  event: Doc<"events">,
  request: ImportRequest,
  now: number,
) {
  if (request.rows.length < 1 || request.rows.length > maximumRowsPerImport) {
    throw new ConvexError({
      code: "INVALID_ROSTER_SIZE",
      message: `Import between 1 and ${maximumRowsPerImport} roster rows at a time.`,
    });
  }
  if (
    request.bundleVersionIds.length > maximumBundlesPerImport ||
    new Set(request.bundleVersionIds).size !== request.bundleVersionIds.length
  ) {
    throw new ConvexError({
      code: "INVALID_ROSTER_BUNDLES",
      message: `Choose at most ${maximumBundlesPerImport} different permission bundles.`,
    });
  }
  const sourceName = normalizedText(request.sourceName, "Roster source", 3, 100);
  const sourceFileName = request.sourceFileName
    ? normalizedText(request.sourceFileName, "Source file name", 1, 160)
    : undefined;
  const reason = normalizedText(request.reason, "Reason", 5, 300);
  const validity = checkedValidity(event, request.validFrom, request.validUntil, now);
  const seenRows = new Set<number>();
  const seenEmails = new Set<string>();
  const rows = request.rows.map((row) => {
    if (
      !Number.isSafeInteger(row.rowNumber) ||
      row.rowNumber < 2 ||
      seenRows.has(row.rowNumber)
    ) {
      throw new ConvexError({
        code: "INVALID_ROSTER_ROW",
        message: "Roster source row numbers must be unique positive spreadsheet rows.",
      });
    }
    const email = exactRosterEmail(row.email);
    if (seenEmails.has(email)) {
      throw new ConvexError({
        code: "DUPLICATE_ROSTER_EMAIL",
        message: `${email} appears more than once in this import.`,
      });
    }
    seenRows.add(row.rowNumber);
    seenEmails.add(email);
    return {
      rowNumber: row.rowNumber,
      email,
      displayName: normalizedText(row.displayName, "Roster name", 2, 100),
      role: row.role,
    };
  });
  rows.sort((left, right) => left.rowNumber - right.rowNumber);
  const bundleVersionIds = [...request.bundleVersionIds].sort((left, right) =>
    left.localeCompare(right),
  );
  return {
    sourceName,
    ...(sourceFileName !== undefined ? { sourceFileName } : {}),
    ...validity,
    bundleVersionIds,
    rows,
    reason,
  };
}

async function effectivePermissionGrants(
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
  return grants.filter(
    (grant) =>
      grant.validFrom <= now &&
      (grant.validUntil === undefined || grant.validUntil > now),
  );
}

function coversScope(
  grants: readonly GrantDoc[],
  scopeType: "permission_bundle" | "roster_entry",
  scopeId: string,
) {
  return grants.some(
    (grant) =>
      grant.scopeType === "event" ||
      (grant.scopeType === scopeType && grant.scopeId === scopeId),
  );
}

function hasEventScope(grants: readonly GrantDoc[]) {
  return grants.some((grant) => grant.scopeType === "event");
}

function bundleIsRosterCompatible(version: BundleVersionDoc) {
  const entries = normalizeBundleEntries(version.entries);
  if (bundleBindingRequirements(entries).length > 0) return false;
  return !entries.some(
    (entry) =>
      entry.scopeType === "self" &&
      selfScopeKind(entry.permissionKey) === "participant_membership",
  );
}

function rosterConfigurationChecksum(args: {
  validFrom: number;
  validUntil: number;
  bundleSelections: readonly {
    bundleId: Id<"permissionBundles">;
    bundleVersionId: Id<"permissionBundleVersions">;
    bundleChecksum: string;
  }[];
}) {
  const parts: OperationFingerprintPart[] = [args.validFrom, args.validUntil];
  for (const selection of args.bundleSelections) {
    parts.push(
      selection.bundleId,
      selection.bundleVersionId,
      selection.bundleChecksum,
    );
  }
  return operationFingerprint(parts);
}

async function currentBundleOption(
  ctx: ReadCtx,
  eventId: Id<"events">,
  bundle: Doc<"permissionBundles">,
) {
  const version = bundle.publishedVersionId
    ? await ctx.db.get("permissionBundleVersions", bundle.publishedVersionId)
    : null;
  if (!version) return null;
  if (
    version.eventId !== eventId ||
    version.bundleId !== bundle._id ||
    version.status !== "published" ||
    version.version !== bundle.publishedVersion
  ) {
    throw new Error("Published permission bundle pointer is inconsistent.");
  }
  return {
    bundleId: bundle._id,
    versionId: version._id,
    label: version.label,
    version: version.version,
    entryCount: version.entries.length,
    rosterCompatible: bundleIsRosterCompatible(version),
  };
}

function displayedRosterStatus(entry: RosterEntryDoc, now: number) {
  return entry.status === "pending" && entry.validUntil <= now
    ? "expired" as const
    : entry.status;
}

const workspaceEntry = v.object({
  id: v.id("rosterEntries"),
  email: v.string(),
  displayName: v.string(),
  role: eventRole,
  status: rosterEntryStatus,
  validFrom: v.number(),
  validUntil: v.number(),
  version: v.number(),
  sourceName: v.string(),
  createdAt: v.number(),
  canRevoke: v.boolean(),
});

async function rosterEntryViews(
  ctx: ReadCtx,
  eventId: Id<"events">,
  entries: readonly RosterEntryDoc[],
  revokeGrants: readonly GrantDoc[],
) {
  const imports = await Promise.all(
    entries.map((entry) => ctx.db.get("rosterImports", entry.rosterImportId)),
  );
  const now = Date.now();
  return entries.map((entry, index) => {
    const source = imports[index];
    if (!source || source.eventId !== eventId) {
      throw new Error("Roster entry import provenance is missing.");
    }
    return {
      id: entry._id,
      email: entry.emailNormalized,
      displayName: entry.displayName,
      role: entry.role,
      status: displayedRosterStatus(entry, now),
      validFrom: entry.validFrom,
      validUntil: entry.validUntil,
      version: entry.version,
      sourceName: source.sourceName,
      createdAt: entry.createdAt,
      canRevoke:
        entry.status === "pending" &&
        entry.validUntil > now &&
        coversScope(revokeGrants, "roster_entry", entry._id),
    };
  });
}

export const workspace = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    canImport: v.boolean(),
    canReadAll: v.boolean(),
    serverNow: v.number(),
    recommendedValidFrom: v.number(),
    recommendedValidUntil: v.optional(v.number()),
    importBlocker: v.optional(v.string()),
    bundles: v.array(
      v.object({
        bundleId: v.id("permissionBundles"),
        versionId: v.id("permissionBundleVersions"),
        label: v.string(),
        version: v.number(),
        entryCount: v.number(),
        rosterCompatible: v.boolean(),
      }),
    ),
    entries: v.array(workspaceEntry),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const [readGrants, importGrants, revokeGrants, bundleReadGrants, bundleApplyGrants] =
      await Promise.all([
        effectivePermissionGrants(ctx, subject._id, "access.roster.read"),
        effectivePermissionGrants(ctx, subject._id, "access.roster.import"),
        effectivePermissionGrants(ctx, subject._id, "access.roster.revoke"),
        effectivePermissionGrants(ctx, subject._id, "access.permission_bundles.read"),
        effectivePermissionGrants(ctx, subject._id, "access.permission_bundles.apply"),
      ]);
    if (readGrants.length === 0 && importGrants.length === 0 && revokeGrants.length === 0) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account has no roster workspace permission.",
      });
    }
    const canReadAll = hasEventScope(readGrants);
    const hasImportPermission = hasEventScope(importGrants);
    const canImport = hasImportPermission && event.endsAt !== undefined;
    let entries: RosterEntryDoc[] = [];
    if (!canReadAll) {
      const exactIds = new Set<Id<"rosterEntries">>();
      for (const grant of readGrants) {
        if (grant.scopeType !== "roster_entry" || !grant.scopeId) continue;
        const id = ctx.db.normalizeId("rosterEntries", grant.scopeId);
        if (id) exactIds.add(id);
      }
      if (exactIds.size > maximumExactVisibleEntries) {
        throw new Error("The account has more exact roster rows than the supported bound.");
      }
      const resolved = await Promise.all(
        [...exactIds].map((id) => ctx.db.get("rosterEntries", id)),
      );
      const exactEntries: RosterEntryDoc[] = [];
      for (const entry of resolved) {
        if (entry && entry.eventId === event._id) exactEntries.push(entry);
      }
      entries = exactEntries;
      entries.sort((left, right) => right.createdAt - left.createdAt);
    }
    const now = Date.now();
    const entryViews = await rosterEntryViews(ctx, event._id, entries, revokeGrants);

    let bundles: Array<NonNullable<Awaited<ReturnType<typeof currentBundleOption>>>> = [];
    if (canImport && hasEventScope(bundleApplyGrants) && bundleReadGrants.length > 0) {
      const available = await ctx.db
        .query("permissionBundles")
        .withIndex("by_event_status_label", (index) =>
          index.eq("eventId", event._id).eq("status", "active"),
        )
        .take(maximumBundlesPerEvent + 1);
      if (available.length > maximumBundlesPerEvent) {
        throw new Error("The event has more permission bundles than the supported bound.");
      }
      const options = await Promise.all(
        available
          .filter(
            (bundle) =>
              coversScope(bundleReadGrants, "permission_bundle", bundle._id) &&
              coversScope(bundleApplyGrants, "permission_bundle", bundle._id),
          )
          .map((bundle) => currentBundleOption(ctx, event._id, bundle)),
      );
      bundles = options.filter((option) => option !== null);
    }
    return {
      canImport,
      canReadAll,
      serverNow: now,
      recommendedValidFrom: event.startsAt ?? now,
      ...(event.endsAt !== undefined ? { recommendedValidUntil: event.endsAt } : {}),
      ...(hasImportPermission && event.endsAt === undefined
        ? { importBlocker: "Set the event end time before importing roster access." }
        : {}),
      bundles,
      entries: entryViews,
    };
  },
});

export const list = query({
  args: {
    eventSlug: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(workspaceEntry),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "access.roster.read",
      scopeType: "event",
    });
    const revokeGrants = await effectivePermissionGrants(
      ctx,
      subject._id,
      "access.roster.revoke",
    );
    const page = await ctx.db
      .query("rosterEntries")
      .withIndex("by_event_created", (index) => index.eq("eventId", event._id))
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...page,
      page: await rosterEntryViews(ctx, event._id, page.page, revokeGrants),
    };
  },
});

async function selectedBundles(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    actorSubjectId: Id<"eventAccessSubjects">;
    bundleVersionIds: readonly Id<"permissionBundleVersions">[];
  },
) {
  const authorizingGrantIds: Id<"permissionGrants">[] = [];
  if (args.bundleVersionIds.length > 0) {
    authorizingGrantIds.push(
      ...(await requirePermission(ctx, {
        eventId: args.eventId,
        eventAccessSubjectId: args.actorSubjectId,
        permissionKey: "access.permission_bundles.apply",
        scopeType: "event",
      })),
    );
  }
  const selected = [];
  const seenBundles = new Set<Id<"permissionBundles">>();
  for (const versionId of args.bundleVersionIds) {
    const version = await ctx.db.get("permissionBundleVersions", versionId);
    const bundle = version
      ? await ctx.db.get("permissionBundles", version.bundleId)
      : null;
    if (
      !version ||
      !bundle ||
      version.eventId !== args.eventId ||
      bundle.eventId !== args.eventId ||
      version.status !== "published" ||
      bundle.status !== "active" ||
      bundle.publishedVersionId !== version._id ||
      seenBundles.has(bundle._id)
    ) {
      throw new ConvexError({
        code: "ROSTER_BUNDLE_UNAVAILABLE",
        message: "Choose each current published permission bundle at most once.",
      });
    }
    if (!bundleIsRosterCompatible(version)) {
      throw new ConvexError({
        code: "ROSTER_BUNDLE_NEEDS_ASSIGNMENT",
        message: `${version.label} needs a participant or resource binding and cannot be applied by roster import.`,
      });
    }
    const entries = normalizeBundleEntries(version.entries);
    const checksum = bundleContentChecksum({
      key: version.key,
      label: version.label,
      defaultRole: version.defaultRole,
      entries,
    });
    if (checksum !== version.checksum) {
      throw new Error("Permission bundle checksum is invalid.");
    }
    const [readGrantIds, applyGrantIds] = await Promise.all([
      requirePermission(ctx, {
        eventId: args.eventId,
        eventAccessSubjectId: args.actorSubjectId,
        permissionKey: "access.permission_bundles.read",
        scopeType: "permission_bundle",
        scopeId: bundle._id,
      }),
      requirePermission(ctx, {
        eventId: args.eventId,
        eventAccessSubjectId: args.actorSubjectId,
        permissionKey: "access.permission_bundles.apply",
        scopeType: "permission_bundle",
        scopeId: bundle._id,
      }),
    ]);
    authorizingGrantIds.push(...readGrantIds, ...applyGrantIds);
    seenBundles.add(bundle._id);
    selected.push({ bundle, version, entries });
  }
  return {
    selected,
    authorizingGrantIds: [...new Set(authorizingGrantIds)],
  };
}

type PreparedRow = {
  rowNumber: number;
  email: string;
  displayName: string;
  role: RosterEntryDoc["role"];
  outcome:
    | "create"
    | "replace_pending"
    | "replace_expired"
    | "unchanged_pending"
    | "already_claimed";
  existingPending: RosterEntryDoc | null;
};

async function prepareImport(
  ctx: ReadCtx,
  event: Doc<"events">,
  actorSubjectId: Id<"eventAccessSubjects">,
  request: ImportRequest,
) {
  const now = Date.now();
  const normalized = normalizeImportRequest(event, request, now);
  const rosterGrantIds = await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: actorSubjectId,
    permissionKey: "access.roster.import",
    scopeType: "event",
  });
  const bundleContext = await selectedBundles(ctx, {
    eventId: event._id,
    actorSubjectId,
    bundleVersionIds: normalized.bundleVersionIds,
  });
  const configurationChecksum = rosterConfigurationChecksum({
    validFrom: normalized.validFrom,
    validUntil: normalized.validUntil,
    bundleSelections: bundleContext.selected.map(({ bundle, version }) => ({
      bundleId: bundle._id,
      bundleVersionId: version._id,
      bundleChecksum: version.checksum,
    })),
  });
  const rows = await Promise.all(
    normalized.rows.map(async (row): Promise<PreparedRow> => {
      const [pending, claimed] = await Promise.all([
        ctx.db
          .query("rosterEntries")
          .withIndex("by_event_email_status", (index) =>
            index
              .eq("eventId", event._id)
              .eq("emailNormalized", row.email)
              .eq("status", "pending"),
          )
          .unique(),
        ctx.db
          .query("rosterEntries")
          .withIndex("by_event_email_status", (index) =>
            index
              .eq("eventId", event._id)
              .eq("emailNormalized", row.email)
              .eq("status", "claimed"),
          )
          .unique(),
      ]);
      if (pending) {
        if (pending.validUntil <= now) {
          return { ...row, outcome: "replace_expired", existingPending: pending };
        }
        if (
          pending.displayName === row.displayName &&
          pending.role === row.role &&
          pending.configurationChecksum === configurationChecksum
        ) {
          return { ...row, outcome: "unchanged_pending", existingPending: pending };
        }
        return { ...row, outcome: "replace_pending", existingPending: pending };
      }
      if (claimed) {
        return { ...row, outcome: "already_claimed", existingPending: null };
      }
      return { ...row, outcome: "create", existingPending: null };
    }),
  );
  const previewParts: OperationFingerprintPart[] = [
    event._id,
    normalized.sourceName,
    normalized.sourceFileName ?? null,
    normalized.reason,
    configurationChecksum,
  ];
  for (const row of rows) {
    previewParts.push(
      row.rowNumber,
      row.email,
      row.displayName,
      row.role,
      row.outcome,
      row.existingPending?._id ?? null,
      row.existingPending?.version ?? null,
    );
  }
  const counts = {
    create: rows.filter((row) => row.outcome === "create").length,
    replace: rows.filter(
      (row) =>
        row.outcome === "replace_pending" || row.outcome === "replace_expired",
    ).length,
    unchanged: rows.filter((row) => row.outcome === "unchanged_pending").length,
    alreadyClaimed: rows.filter((row) => row.outcome === "already_claimed").length,
  };
  return {
    normalized,
    bundleContext,
    configurationChecksum,
    previewChecksum: operationFingerprint(previewParts),
    rows,
    counts,
    authorizingGrantIds: [
      ...new Set([...rosterGrantIds, ...bundleContext.authorizingGrantIds]),
    ],
  };
}

function publicPreview(prepared: Awaited<ReturnType<typeof prepareImport>>) {
  return {
    previewChecksum: prepared.previewChecksum,
    configurationChecksum: prepared.configurationChecksum,
    validFrom: prepared.normalized.validFrom,
    validUntil: prepared.normalized.validUntil,
    bundles: prepared.bundleContext.selected.map(({ bundle, version }) => ({
      bundleId: bundle._id,
      versionId: version._id,
      label: version.label,
      version: version.version,
      entryCount: version.entries.length,
    })),
    rows: prepared.rows.map((row) => ({
      rowNumber: row.rowNumber,
      email: row.email,
      displayName: row.displayName,
      role: row.role,
      outcome: row.outcome,
    })),
    counts: prepared.counts,
  };
}

export const previewImport = query({
  args: importRequestArgs,
  returns: previewResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    return publicPreview(await prepareImport(ctx, event, subject._id, args));
  },
});

export const confirmImport = mutation({
  args: {
    ...importRequestArgs,
    previewChecksum: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    rosterImportId: v.id("rosterImports"),
    createdCount: v.number(),
    replacedCount: v.number(),
    unchangedCount: v.number(),
    alreadyClaimedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const operationId = normalizedText(
      args.clientOperationId,
      "Client operation ID",
      10,
      100,
    );
    const requestFingerprint = operationFingerprint([
      args.previewChecksum,
      operationFingerprint(
        args.rows.flatMap((row) => [
          row.rowNumber,
          row.email,
          row.displayName,
          row.role,
        ]),
      ),
      args.sourceName,
      args.sourceFileName ?? null,
      args.validFrom,
      args.validUntil,
      operationFingerprint(args.bundleVersionIds),
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "rosters.confirmImport",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "roster import",
        rosterImportOperationResult,
      );
      const rosterImportId = ctx.db.normalizeId("rosterImports", result.rosterImportId);
      if (!rosterImportId || rosterImportId !== prior.targetId) {
        throw new Error("The stored roster import is invalid.");
      }
      return {
        rosterImportId,
        createdCount: result.createdCount,
        replacedCount: result.replacedCount,
        unchangedCount: result.unchangedCount,
        alreadyClaimedCount: result.alreadyClaimedCount,
      };
    }
    const prepared = await prepareImport(ctx, event, subject._id, args);
    if (prepared.previewChecksum !== args.previewChecksum) {
      throw new ConvexError({
        code: "ROSTER_PREVIEW_STALE",
        message: "The roster, bundle versions, or import settings changed. Review the import again.",
      });
    }
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    const now = Date.now();
    const rosterImportId = await ctx.db.insert("rosterImports", {
      eventId: event._id,
      sourceName: prepared.normalized.sourceName,
      ...(prepared.normalized.sourceFileName !== undefined
        ? { sourceFileName: prepared.normalized.sourceFileName }
        : {}),
      validFrom: prepared.normalized.validFrom,
      validUntil: prepared.normalized.validUntil,
      bundleSelections: prepared.bundleContext.selected.map(({ bundle, version }) => ({
        bundleId: bundle._id,
        bundleVersionId: version._id,
        bundleChecksum: version.checksum,
      })),
      configurationChecksum: prepared.configurationChecksum,
      previewChecksum: prepared.previewChecksum,
      rowCount: prepared.rows.length,
      createdCount: prepared.counts.create,
      replacedCount: prepared.counts.replace,
      unchangedCount: prepared.counts.unchanged,
      alreadyClaimedCount: prepared.counts.alreadyClaimed,
      reason: prepared.normalized.reason,
      authorizingGrantIds: prepared.authorizingGrantIds,
      createdByPersonId: person._id,
      clientOperationId: operationId,
      createdAt: now,
    });
    let insertedCount = 0;
    for (const row of prepared.rows) {
      if (row.outcome === "unchanged_pending" || row.outcome === "already_claimed") {
        continue;
      }
      const rosterEntryId = await ctx.db.insert("rosterEntries", {
        eventId: event._id,
        rosterImportId,
        sourceRowNumber: row.rowNumber,
        emailNormalized: row.email,
        displayName: row.displayName,
        role: row.role,
        configurationChecksum: prepared.configurationChecksum,
        validFrom: prepared.normalized.validFrom,
        validUntil: prepared.normalized.validUntil,
        status: "pending",
        version: 1,
        createdByPersonId: person._id,
        createdAt: now,
      });
      insertedCount += 1;
      if (row.existingPending) {
        await ctx.db.patch("rosterEntries", row.existingPending._id, {
          status:
            row.outcome === "replace_expired" ? "expired" : "superseded",
          version: row.existingPending.version + 1,
          supersededByRosterEntryId: rosterEntryId,
          supersededAt: now,
          ...(row.outcome === "replace_expired" ? { expiredAt: now } : {}),
        });
      }
    }
    if (insertedCount > 0) {
      await ctx.scheduler.runAt(
        prepared.normalized.validUntil,
        internal.rosters.expireImportEntries,
        { rosterImportId },
      );
    }
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "access.roster.import",
      grantIds: prepared.authorizingGrantIds,
      scopeType: "event",
      action: "access.roster_imported",
      targetType: "roster_import",
      targetId: rosterImportId,
      nextSummary: JSON.stringify({
        sourceName: prepared.normalized.sourceName,
        rowCount: prepared.rows.length,
        createdCount: prepared.counts.create,
        replacedCount: prepared.counts.replace,
        unchangedCount: prepared.counts.unchanged,
        alreadyClaimedCount: prepared.counts.alreadyClaimed,
        bundleVersionIds: prepared.normalized.bundleVersionIds,
        validFrom: prepared.normalized.validFrom,
        validUntil: prepared.normalized.validUntil,
      }),
      reason: prepared.normalized.reason,
    });
    const result = {
      rosterImportId,
      createdCount: prepared.counts.create,
      replacedCount: prepared.counts.replace,
      unchangedCount: prepared.counts.unchanged,
      alreadyClaimedCount: prepared.counts.alreadyClaimed,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "rosters.confirmImport",
      requestFingerprint,
      targetType: "roster_import",
      targetId: rosterImportId,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    return result;
  },
});

export const expireImportEntries = internalMutation({
  args: { rosterImportId: v.id("rosterImports") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rosterImport = await ctx.db.get("rosterImports", args.rosterImportId);
    if (!rosterImport || rosterImport.validUntil > Date.now()) return null;
    const rows = await ctx.db
      .query("rosterEntries")
      .withIndex("by_import_row", (index) =>
        index.eq("rosterImportId", rosterImport._id),
      )
      .take(maximumRowsPerImport + 1);
    if (rows.length > maximumRowsPerImport) {
      throw new Error("Roster import contains more rows than its supported bound.");
    }
    const now = Date.now();
    await Promise.all(
      rows
        .filter((row) => row.status === "pending" && row.validUntil <= now)
        .map((row) =>
          ctx.db.patch("rosterEntries", row._id, {
            status: "expired",
            version: row.version + 1,
            expiredAt: now,
          }),
        ),
    );
    return null;
  },
});

export const mine = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      id: v.id("rosterEntries"),
      eventName: v.string(),
      email: v.string(),
      displayName: v.string(),
      role: eventRole,
      sourceName: v.string(),
      validFrom: v.number(),
      validUntil: v.number(),
      version: v.number(),
      bundles: v.array(
        v.object({
          label: v.string(),
          version: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { googleIdentity } = await requireVerifiedGoogleIdentity(ctx);
    const entry = await ctx.db
      .query("rosterEntries")
      .withIndex("by_event_email_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("emailNormalized", googleIdentity.verifiedEmail)
          .eq("status", "pending"),
      )
      .unique();
    if (!entry || entry.validUntil <= Date.now()) return null;
    const rosterImport = await ctx.db.get("rosterImports", entry.rosterImportId);
    if (!rosterImport || rosterImport.eventId !== event._id) {
      throw new Error("Roster import provenance is missing.");
    }
    if (
      entry.configurationChecksum !== rosterImport.configurationChecksum ||
      entry.validFrom !== rosterImport.validFrom ||
      entry.validUntil !== rosterImport.validUntil ||
      rosterConfigurationChecksum({
        validFrom: rosterImport.validFrom,
        validUntil: rosterImport.validUntil,
        bundleSelections: rosterImport.bundleSelections,
      }) !== rosterImport.configurationChecksum
    ) {
      throw new Error("Roster entry configuration is inconsistent with its import.");
    }
    const versions = await Promise.all(
      rosterImport.bundleSelections.map((selection) =>
        ctx.db.get("permissionBundleVersions", selection.bundleVersionId),
      ),
    );
    const bundles = versions.map((version, index) => {
      const selection = rosterImport.bundleSelections[index];
      if (
        !version ||
        !selection ||
        version.eventId !== event._id ||
        version.checksum !== selection.bundleChecksum
      ) {
        throw new Error("Roster bundle version is missing or inconsistent.");
      }
      return { label: version.label, version: version.version };
    });
    return {
      id: entry._id,
      eventName: event.name,
      email: entry.emailNormalized,
      displayName: entry.displayName,
      role: entry.role,
      sourceName: rosterImport.sourceName,
      validFrom: entry.validFrom,
      validUntil: entry.validUntil,
      version: entry.version,
      bundles,
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

export const claim = mutation({
  args: {
    eventSlug: v.string(),
    rosterEntryId: v.id("rosterEntries"),
    expectedVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    outcome: v.union(v.literal("claimed"), v.literal("already_claimed")),
    rosterEntryId: v.id("rosterEntries"),
    personId: v.id("people"),
    eventAccessSubjectId: v.id("eventAccessSubjects"),
    role: eventRole,
    bundleCount: v.number(),
    grantCount: v.number(),
    accessVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { user, person, googleIdentity } = await ensurePerson(ctx);
    const operationId = normalizedText(
      args.clientOperationId,
      "Client operation ID",
      10,
      100,
    );
    const requestFingerprint = operationFingerprint([
      args.rosterEntryId,
      args.expectedVersion,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "rosters.claim",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "roster claim",
        rosterClaimOperationResult,
      );
      const rosterEntryId = ctx.db.normalizeId("rosterEntries", result.rosterEntryId);
      const personId = ctx.db.normalizeId("people", result.personId);
      const eventAccessSubjectId = ctx.db.normalizeId(
        "eventAccessSubjects",
        result.eventAccessSubjectId,
      );
      if (
        !rosterEntryId ||
        !personId ||
        !eventAccessSubjectId ||
        rosterEntryId !== prior.targetId ||
        personId !== person._id
      ) {
        throw new Error("The stored roster claim is invalid.");
      }
      return {
        outcome: result.outcome,
        rosterEntryId,
        personId,
        eventAccessSubjectId,
        role: result.role,
        bundleCount: result.bundleCount,
        grantCount: result.grantCount,
        accessVersion: result.accessVersion,
      };
    }

    const entry = await ctx.db.get("rosterEntries", args.rosterEntryId);
    if (!entry || entry.eventId !== event._id) {
      throw new ConvexError({
        code: "ROSTER_ENTRY_NOT_FOUND",
        message: "That roster entry is unavailable.",
      });
    }
    if (entry.emailNormalized !== person.verifiedEmail) {
      throw new ConvexError({
        code: "ROSTER_IDENTITY_MISMATCH",
        message: "Sign in with the exact Google account named on the roster.",
      });
    }
    if (
      entry.status === "claimed" &&
      entry.claimedByPersonId === person._id &&
      entry.claimedEventAccessSubjectId !== undefined
    ) {
      const subject = await ctx.db.get(
        "eventAccessSubjects",
        entry.claimedEventAccessSubjectId,
      );
      if (!subject || subject.eventId !== event._id) {
        throw new Error("Claimed roster event account is missing.");
      }
      const result = {
        outcome: alreadyClaimedOutcome,
        rosterEntryId: entry._id,
        personId: person._id,
        eventAccessSubjectId: subject._id,
        role: entry.role,
        bundleCount: entry.permissionGrantBatchIds?.length ?? 0,
        grantCount: 0,
        accessVersion: subject.accessVersion,
      };
      await recordOperation(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        clientOperationId: operationId,
        commandName: "rosters.claim",
        requestFingerprint,
        targetType: "roster_entry",
        targetId: entry._id,
        resultJson: JSON.stringify(result),
        createdAt: Date.now(),
      });
      return result;
    }
    if (entry.status !== "pending" || entry.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "ROSTER_ENTRY_CHANGED",
        message: "This roster entry changed. Refresh before claiming it.",
      });
    }
    const now = Date.now();
    if (entry.validUntil <= now) {
      throw new ConvexError({
        code: "ROSTER_ENTRY_EXPIRED",
        message: "This roster entry expired. Ask the roster owner to import it again.",
      });
    }
    const rosterImport = await ctx.db.get("rosterImports", entry.rosterImportId);
    if (!rosterImport || rosterImport.eventId !== event._id) {
      throw new Error("Roster import provenance is missing.");
    }
    const emailOwner = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_email", (index) =>
        index.eq("eventId", event._id).eq("emailNormalized", person.verifiedEmail),
      )
      .unique();
    if (emailOwner && emailOwner.personId !== person._id) {
      throw new ConvexError({
        code: "EVENT_EMAIL_CONFLICT",
        message: "That verified email is already linked to another event account.",
      });
    }
    let subject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (subject && subject.status !== "active") {
      throw new ConvexError({
        code: "EVENT_ACCESS_NOT_ACTIVE",
        message: "This event account is not active. Ask an access administrator to reactivate it.",
      });
    }
    const subjectCreated = !subject;
    if (!subject) {
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId: event._id,
        personId: person._id,
        emailNormalized: person.verifiedEmail,
        displayName: person.displayName,
        status: "active",
        linkedBy: "roster_claim",
        accessVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      subject = await ctx.db.get("eventAccessSubjects", subjectId);
    } else if (
      subject.emailNormalized !== person.verifiedEmail ||
      subject.displayName !== person.displayName
    ) {
      await ctx.db.patch("eventAccessSubjects", subject._id, {
        emailNormalized: person.verifiedEmail,
        displayName: person.displayName,
        updatedAt: now,
      });
      subject = await ctx.db.get("eventAccessSubjects", subject._id);
    }
    if (!subject) throw new Error("Roster event account creation did not persist.");

    const createdSupportGrantCount = await addEventSubjectSelfGrants(ctx, {
      eventId: event._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
    });

    let currentRole = await ctx.db
      .query("eventRoles")
      .withIndex("by_event_person_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("personId", person._id)
          .eq("status", "active"),
      )
      .unique();
    if (currentRole && currentRole.validUntil !== undefined && currentRole.validUntil <= now) {
      await ctx.db.patch("eventRoles", currentRole._id, {
        status: "expired",
        endedAt: now,
        endReason: "Role validity ended before roster claim.",
      });
      currentRole = null;
    }
    if (currentRole && currentRole.role !== entry.role) {
      throw new ConvexError({
        code: "ROSTER_ROLE_CONFLICT",
        message: `This account already has the ${eventRoleLabels[currentRole.role]} role. Resolve that role before claiming ${eventRoleLabels[entry.role]}.`,
      });
    }
    let roleId = currentRole?._id;
    let roleCreated = false;
    if (!roleId) {
      roleId = await ctx.db.insert("eventRoles", {
        eventId: event._id,
        personId: person._id,
        eventAccessSubjectId: subject._id,
        role: entry.role,
        validFrom: entry.validFrom,
        validUntil: entry.validUntil,
        status: "active",
        sourceType: "roster",
        sourceId: `roster:${entry._id}`,
        assignedByPersonId: rosterImport.createdByPersonId,
        createdAt: now,
        reason: rosterImport.reason,
      });
      roleCreated = true;
    }

    const batchResults: Array<{
      batchId: Id<"permissionGrantBatches">;
      grantIds: Id<"permissionGrants">[];
      createdCount: number;
    }> = [];
    let totalCreatedGrants = 0;
    for (const selection of rosterImport.bundleSelections) {
      const version = await ctx.db.get(
        "permissionBundleVersions",
        selection.bundleVersionId,
      );
      const bundle = await ctx.db.get("permissionBundles", selection.bundleId);
      const entries = version ? normalizeBundleEntries(version.entries) : null;
      const checksum = version
        ? bundleContentChecksum({
            key: version.key,
            label: version.label,
            defaultRole: version.defaultRole,
            entries: entries ?? [],
          })
        : null;
      if (
        !version ||
        !bundle ||
        !entries ||
        version.eventId !== event._id ||
        version.bundleId !== bundle._id ||
        version.checksum !== selection.bundleChecksum ||
        checksum !== selection.bundleChecksum ||
        (version.status !== "published" && version.status !== "retired") ||
        !bundleIsRosterCompatible(version)
      ) {
        throw new ConvexError({
          code: "ROSTER_BUNDLE_CHANGED",
          message: "A pinned roster permission bundle is no longer valid. Ask the roster owner to import this row again.",
        });
      }
      const grants = await resolveBundleGrants(ctx, {
        eventId: event._id,
        targetPersonId: person._id,
        entries,
        bindings: [],
      });
      const sourceId = `roster:${entry._id}:bundle:${version._id}`;
      const existingSourceGrants = await currentSourceGrants(ctx, {
        eventId: event._id,
        sourceType: "bundle",
        sourceId,
      });
      const batchPreviewChecksum = operationFingerprint([
        entry._id,
        version._id,
        person._id,
        entry.validFrom,
        entry.validUntil,
        ...grants.flatMap((grant) => [
          grant.permissionKey,
          grant.scopeType,
          grant.scopeType === "event" ? null : grant.scopeId,
        ]),
      ]);
      const batchId = await ctx.db.insert("permissionGrantBatches", {
        eventId: event._id,
        clientOperationId: `${operationId}:${version._id}`,
        requestFingerprint: batchPreviewChecksum,
        action: "apply_bundle",
        actorPersonId: rosterImport.createdByPersonId,
        targetPersonId: person._id,
        bundleId: bundle._id,
        bundleVersionId: version._id,
        resolvedBindings: [],
        reason: rosterImport.reason,
        authorizingGrantIds: rosterImport.authorizingGrantIds,
        expectedAccessVersion: subject.accessVersion,
        previewChecksum: batchPreviewChecksum,
        validUntil: entry.validUntil,
        status: "applying",
        resultGrantIds: [],
        createdCount: 0,
        resultAccessVersion: subject.accessVersion,
        createdAt: now,
      });
      const grantIds: Id<"permissionGrants">[] = [];
      let createdCount = 0;
      for (const planned of grants) {
        const existing = existingSourceGrants.find((grant) =>
          sameResolvedGrant(grant, planned),
        );
        if (existing) {
          grantIds.push(existing._id);
          continue;
        }
        const result = await insertPermissionGrant(ctx, {
          eventId: event._id,
          personId: person._id,
          eventAccessSubjectId: subject._id,
          permissionKey: planned.permissionKey,
          ...(planned.scopeType === "event"
            ? { scopeType: "event" as const }
            : { scopeType: planned.scopeType, scopeId: planned.scopeId }),
          sourceType: "bundle",
          sourceId,
          grantBatchId: batchId,
          grantedByPersonId: rosterImport.createdByPersonId,
          reason: rosterImport.reason,
          validFrom: entry.validFrom,
          validUntil: entry.validUntil,
        });
        grantIds.push(result.grantId);
        if (result.created) createdCount += 1;
      }
      totalCreatedGrants += createdCount;
      batchResults.push({ batchId, grantIds, createdCount });
    }

    if (entry.role === "supreme") {
      totalCreatedGrants += await grantSupremeRolePermissions(ctx, {
        eventId: event._id,
        personId: person._id,
        eventAccessSubjectId: subject._id,
        roleId,
        grantedByPersonId: rosterImport.createdByPersonId,
      });
    }

    const accessChanged =
      roleCreated || totalCreatedGrants > 0 || createdSupportGrantCount > 0;
    const accessVersion =
      !subjectCreated && accessChanged
        ? subject.accessVersion + 1
        : subject.accessVersion;
    if (accessVersion !== subject.accessVersion) {
      await ctx.db.patch("eventAccessSubjects", subject._id, {
        accessVersion,
        updatedAt: now,
      });
    }
    await Promise.all(
      batchResults.map((batch) =>
        ctx.db.patch("permissionGrantBatches", batch.batchId, {
          status: "complete",
          resultGrantIds: batch.grantIds,
          createdCount: batch.createdCount,
          resultAccessVersion: accessVersion,
          completedAt: now,
        }),
      ),
    );
    await ctx.db.patch("rosterEntries", entry._id, {
      status: "claimed",
      version: entry.version + 1,
      claimedByPersonId: person._id,
      claimedEventAccessSubjectId: subject._id,
      claimedEventRoleId: roleId,
      permissionGrantBatchIds: batchResults.map((batch) => batch.batchId),
      claimOperationId: operationId,
      claimedAuthUserId: user._id,
      claimedGoogleSubject: googleIdentity.googleSubject,
      claimedAt: now,
    });
    const result = {
      outcome: claimedOutcome,
      rosterEntryId: entry._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
      role: entry.role,
      bundleCount: batchResults.length,
      grantCount: totalCreatedGrants,
      accessVersion,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "rosters.claim",
      requestFingerprint,
      targetType: "roster_entry",
      targetId: entry._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await ctx.db.insert("auditEvents", {
      eventId: event._id,
      actorPersonId: person._id,
      authorizingPermissionKey: "verified_google_identity_and_roster",
      authorizingGrantIds: rosterImport.authorizingGrantIds,
      resolvedScopeType: "roster_entry",
      resolvedScopeId: entry._id,
      action: "access.roster_claimed",
      targetType: "event_access_subject",
      targetId: subject._id,
      previousSummary: JSON.stringify({
        rosterEntryId: entry._id,
        sourceName: rosterImport.sourceName,
      }),
      nextSummary: JSON.stringify({
        personId: person._id,
        role: entry.role,
        bundleCount: batchResults.length,
        grantCount: totalCreatedGrants,
        accessVersion,
      }),
      reason: "Exact-email roster entry claimed by the authenticated Google account.",
      serverTime: now,
    });
    return result;
  },
});

export const revoke = mutation({
  args: {
    eventSlug: v.string(),
    rosterEntryId: v.id("rosterEntries"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    rosterEntryId: v.id("rosterEntries"),
    status: v.literal("revoked"),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const operationId = normalizedText(
      args.clientOperationId,
      "Client operation ID",
      10,
      100,
    );
    const requestFingerprint = operationFingerprint([
      args.rosterEntryId,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "rosters.revoke",
      requestFingerprint,
    });
    if (prior) {
      const rosterEntryId = ctx.db.normalizeId("rosterEntries", prior.targetId);
      if (!rosterEntryId) throw new Error("The stored roster revocation is invalid.");
      return { rosterEntryId, status: revokedStatus };
    }
    const authorizingGrantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "access.roster.revoke",
      scopeType: "roster_entry",
      scopeId: args.rosterEntryId,
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    const entry = await ctx.db.get("rosterEntries", args.rosterEntryId);
    if (!entry || entry.eventId !== event._id) {
      throw new ConvexError({
        code: "ROSTER_ENTRY_NOT_FOUND",
        message: "That roster entry is outside this event.",
      });
    }
    if (entry.version !== args.expectedVersion || entry.status !== "pending") {
      throw new ConvexError({
        code: "ROSTER_ENTRY_CHANGED",
        message: "Only the current pending roster entry can be revoked.",
      });
    }
    if (entry.validUntil <= Date.now()) {
      throw new ConvexError({
        code: "ROSTER_ENTRY_EXPIRED",
        message: "That roster entry has already expired.",
      });
    }
    const now = Date.now();
    await ctx.db.patch("rosterEntries", entry._id, {
      status: "revoked",
      version: entry.version + 1,
      revokedByPersonId: person._id,
      revokeOperationId: operationId,
      revokedAt: now,
      revokeReason: reason,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "access.roster.revoke",
      grantIds: authorizingGrantIds,
      scopeType: "roster_entry",
      scopeId: entry._id,
      action: "access.roster_revoked",
      targetType: "roster_entry",
      targetId: entry._id,
      previousSummary: JSON.stringify({
        status: entry.status,
        version: entry.version,
      }),
      nextSummary: JSON.stringify({ status: "revoked", version: entry.version + 1 }),
      reason,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "rosters.revoke",
      requestFingerprint,
      targetType: "roster_entry",
      targetId: entry._id,
      createdAt: now,
    });
    return { rosterEntryId: entry._id, status: revokedStatus };
  },
});
