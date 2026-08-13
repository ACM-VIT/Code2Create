import { ConvexError } from "convex/values";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { advanceAccessVersion } from "./accessVersion";
import { scorecardScopeMustMatchTarget } from "./grantScopes";
import { isPermissionKey, permissionCatalog, type PermissionKey } from "./permissionCatalog";

type ReadCtx = QueryCtx | MutationCtx;
type ScopeType = Doc<"permissionGrants">["scopeType"];
type ResourceScopeType = Exclude<ScopeType, "event">;

type PermissionRequest = {
  eventId: Id<"events">;
  eventAccessSubjectId: Id<"eventAccessSubjects">;
  permissionKey: PermissionKey;
} & (
  | { scopeType: "event"; scopeId?: never }
  | { scopeType: ResourceScopeType; scopeId: string }
);

type GrantScope =
  | { scopeType: "event"; scopeId?: never }
  | { scopeType: ResourceScopeType; scopeId: string };

export type PermissionGrantPlan = {
  permissionKey: PermissionKey;
  delegation?: Doc<"permissionGrants">["delegation"];
} & GrantScope;

type PermissionGrantGroupArgs = {
  eventId: Id<"events">;
  personId: Id<"people">;
  eventAccessSubjectId: Id<"eventAccessSubjects">;
  sourceType: GrantSource;
  sourceId: string;
  grantBatchId?: Id<"permissionGrantBatches">;
  grantedByPersonId?: Id<"people">;
  reason: string;
  validFrom?: number;
  validUntil?: number;
  grants: readonly PermissionGrantPlan[];
};

type PermissionGrantInsertArgs = Omit<PermissionGrantGroupArgs, "grants"> &
  PermissionGrantPlan;

type PermissionGrantInsertResult = {
  grantId: Id<"permissionGrants">;
  created: boolean;
};

function samePermissionDelegation(
  left: Doc<"permissionGrants">["delegation"],
  right: Doc<"permissionGrants">["delegation"],
) {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.permissionKey === right.permissionKey &&
    left.scopeType === right.scopeType &&
    left.scopeId === right.scopeId &&
    left.target.kind === right.target.kind &&
    (left.target.kind === "any_event_person" ||
      (right.target.kind === "exact_person" &&
        left.target.personId === right.target.personId))
  );
}

/** One resource may have a few independent grant owners, never an open-ended ledger. */
export const maximumCurrentGrantsPerPermissionScope = 32;

/** A source is one bounded business operation, bundle, assignment, or bootstrap. */
export const maximumCurrentGrantsPerSource = 256;

const maximumPermissionScopesPerBoundedRead = 2_000;

export type GrantSource =
  | "production_seed"
  | "participant_membership"
  | "team_membership"
  | "team_lead"
  | "role_template"
  | "bundle"
  | "application_assignment"
  | "panel_assignment"
  | "reserve_assignment"
  | "page_assignment"
  | "station_assignment"
  | "event_subject"
  | "manual"
  | "delegated";

export async function currentSourceGrants(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    sourceType: GrantSource;
    sourceId: string;
  },
) {
  const [active, scheduled] = await Promise.all([
    ctx.db
      .query("permissionGrants")
      .withIndex("by_source", (query) =>
        query
          .eq("eventId", args.eventId)
          .eq("sourceType", args.sourceType)
          .eq("sourceId", args.sourceId)
          .eq("status", "active"),
      )
      .take(maximumCurrentGrantsPerSource + 1),
    ctx.db
      .query("permissionGrants")
      .withIndex("by_source", (query) =>
        query
          .eq("eventId", args.eventId)
          .eq("sourceType", args.sourceType)
          .eq("sourceId", args.sourceId)
          .eq("status", "scheduled"),
      )
      .take(maximumCurrentGrantsPerSource + 1),
  ]);
  const grants = [...active, ...scheduled];
  if (grants.length > maximumCurrentGrantsPerSource) {
    throw new Error("A permission source exceeds the current-grant limit.");
  }
  return grants;
}

async function activeExactPermissionGrants(
  ctx: ReadCtx,
  args: PermissionRequest,
) {
  const grants = await ctx.db
    .query("permissionGrants")
    .withIndex("by_subject_permission_status_scope", (query) =>
      query
        .eq("eventAccessSubjectId", args.eventAccessSubjectId)
        .eq("permissionKey", args.permissionKey)
        .eq("status", "active")
        .eq("scopeType", args.scopeType)
        .eq("scopeId", args.scopeId),
    )
    .take(maximumCurrentGrantsPerPermissionScope + 1);
  if (grants.length > maximumCurrentGrantsPerPermissionScope) {
    throw new Error("An exact permission scope exceeds the current-grant limit.");
  }
  return grants;
}

async function currentExactPermissionGrants(
  ctx: ReadCtx,
  args: PermissionRequest,
) {
  const [active, scheduled] = await Promise.all([
    activeExactPermissionGrants(ctx, args),
    ctx.db
      .query("permissionGrants")
      .withIndex("by_subject_permission_status_scope", (query) =>
        query
          .eq("eventAccessSubjectId", args.eventAccessSubjectId)
          .eq("permissionKey", args.permissionKey)
          .eq("status", "scheduled")
          .eq("scopeType", args.scopeType)
          .eq("scopeId", args.scopeId),
      )
      .take(maximumCurrentGrantsPerPermissionScope + 1),
  ]);
  const grants = [...active, ...scheduled];
  if (grants.length > maximumCurrentGrantsPerPermissionScope) {
    throw new Error("An exact permission scope exceeds the current-grant limit.");
  }
  return grants;
}

/**
 * Returns exact resource IDs for a domain query that deliberately supports scoped access.
 * The domain supplies its product ceiling; overflow is an invariant failure, not truncation.
 */
export async function boundedActivePermissionScopeIds(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    permissionKey: PermissionKey;
    scopeType: ResourceScopeType;
    maximumScopeCount: number;
  },
) {
  if (
    !Number.isSafeInteger(args.maximumScopeCount) ||
    args.maximumScopeCount < 1 ||
    args.maximumScopeCount > maximumPermissionScopesPerBoundedRead
  ) {
    throw new Error("The permission-scope read limit is invalid.");
  }
  const definition = permissionCatalog[args.permissionKey];
  if (!definition.scopes.some((scope) => scope === args.scopeType)) {
    throw new Error(`Permission ${args.permissionKey} cannot resolve ${args.scopeType}.`);
  }
  const maximumGrantCount =
    args.maximumScopeCount * maximumCurrentGrantsPerPermissionScope;
  const grants = await ctx.db
    .query("permissionGrants")
    .withIndex("by_subject_permission_status_scope", (query) =>
      query
        .eq("eventAccessSubjectId", args.eventAccessSubjectId)
        .eq("permissionKey", args.permissionKey)
        .eq("status", "active")
        .eq("scopeType", args.scopeType),
    )
    .take(maximumGrantCount + 1);
  if (grants.length > maximumGrantCount) {
    throw new Error("The active permission-scope ledger exceeds its grant-row limit.");
  }
  const now = Date.now();
  const scopeIds = new Set<string>();
  for (const grant of grants) {
    if (grant.eventId !== args.eventId) {
      throw new Error("A permission grant belongs to the wrong event account.");
    }
    if (grant.validFrom > now || (grant.validUntil !== undefined && grant.validUntil <= now)) {
      continue;
    }
    if (grant.scopeId === undefined) {
      throw new Error("A resource-scoped permission grant is missing its resource ID.");
    }
    scopeIds.add(grant.scopeId);
    if (scopeIds.size > args.maximumScopeCount) {
      throw new Error("The active permission-scope ledger exceeds its resource limit.");
    }
  }
  return scopeIds;
}

/** Reads a domain-owned, explicitly capped set of current grants for one permission. */
export async function boundedActivePermissionGrants(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    permissionKey: PermissionKey;
    maximumGrantCount: number;
  },
) {
  if (
    !Number.isSafeInteger(args.maximumGrantCount) ||
    args.maximumGrantCount < 1 ||
    args.maximumGrantCount >
      maximumPermissionScopesPerBoundedRead * maximumCurrentGrantsPerPermissionScope
  ) {
    throw new Error("The active permission-grant read limit is invalid.");
  }
  const grants = await ctx.db
    .query("permissionGrants")
    .withIndex("by_subject_permission_status", (query) =>
      query
        .eq("eventAccessSubjectId", args.eventAccessSubjectId)
        .eq("permissionKey", args.permissionKey)
        .eq("status", "active"),
    )
    .take(args.maximumGrantCount + 1);
  if (grants.length > args.maximumGrantCount) {
    throw new Error("The active permission ledger exceeds its domain limit.");
  }
  const now = Date.now();
  return grants.filter((grant) =>
    activeGrantIsCurrent(grant, args.eventId, now),
  );
}

function activeGrantIsCurrent(
  grant: Doc<"permissionGrants">,
  eventId: Id<"events">,
  now: number,
) {
  if (grant.eventId !== eventId) {
    throw new Error("A permission grant belongs to the wrong event account.");
  }
  if (grant.validFrom > now) {
    throw new Error("An active permission grant starts in the future.");
  }
  return grant.validUntil === undefined || grant.validUntil > now;
}

async function activeGrantByValidity(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    permissionKey: PermissionKey;
    scopeType?: ScopeType;
  },
) {
  const now = Date.now();
  const scopeTypeValue = args.scopeType;
  const [perpetual, expiring] =
    scopeTypeValue === undefined
      ? await Promise.all([
          ctx.db
            .query("permissionGrants")
            .withIndex("by_subject_permission_status_valid_until", (query) =>
              query
                .eq("eventAccessSubjectId", args.eventAccessSubjectId)
                .eq("permissionKey", args.permissionKey)
                .eq("status", "active")
                .eq("validUntil", undefined),
            )
            .first(),
          ctx.db
            .query("permissionGrants")
            .withIndex("by_subject_permission_status_valid_until", (query) =>
              query
                .eq("eventAccessSubjectId", args.eventAccessSubjectId)
                .eq("permissionKey", args.permissionKey)
                .eq("status", "active")
                .gt("validUntil", now),
            )
            .first(),
        ])
      : await Promise.all([
          ctx.db
            .query("permissionGrants")
            .withIndex(
              "by_subject_permission_status_scope_type_valid_until",
              (query) =>
                query
                  .eq("eventAccessSubjectId", args.eventAccessSubjectId)
                  .eq("permissionKey", args.permissionKey)
                  .eq("status", "active")
                  .eq("scopeType", scopeTypeValue)
                  .eq("validUntil", undefined),
            )
            .first(),
          ctx.db
            .query("permissionGrants")
            .withIndex(
              "by_subject_permission_status_scope_type_valid_until",
              (query) =>
                query
                  .eq("eventAccessSubjectId", args.eventAccessSubjectId)
                  .eq("permissionKey", args.permissionKey)
                  .eq("status", "active")
                  .eq("scopeType", scopeTypeValue)
                  .gt("validUntil", now),
            )
            .first(),
        ]);
  return [perpetual, expiring].some(
    (grant) => grant !== null && activeGrantIsCurrent(grant, args.eventId, now),
  );
}

/** Resolves a navigation/capability bit without loading the subject's grant ledger. */
export async function hasAnyActivePermissionGrant(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    permissionKey: PermissionKey;
  },
) {
  return activeGrantByValidity(ctx, args);
}

/** Finds a future scheduled row for access-administration previews. */
export async function hasAnyScheduledPermissionGrant(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    permissionKey: PermissionKey;
  },
) {
  const scheduled = await ctx.db
    .query("permissionGrants")
    .withIndex("by_subject_permission_status", (query) =>
      query
        .eq("eventAccessSubjectId", args.eventAccessSubjectId)
        .eq("permissionKey", args.permissionKey)
        .eq("status", "scheduled"),
    )
    .first();
  if (scheduled && scheduled.eventId !== args.eventId) {
    throw new Error("A permission grant belongs to the wrong event account.");
  }
  return scheduled !== null;
}

/** Resolves a capability only from the explicitly allowed scope kinds. */
export async function hasActivePermissionGrantAtScopeTypes(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    permissionKey: PermissionKey;
    scopeTypes: readonly ScopeType[];
  },
) {
  const definition = permissionCatalog[args.permissionKey];
  for (const requestedScopeType of args.scopeTypes) {
    if (
      (requestedScopeType === "event" && !definition.eventWide) ||
      (requestedScopeType !== "event" &&
        !definition.scopes.some((scope) => scope === requestedScopeType))
    ) {
      throw new Error(
        `Permission ${args.permissionKey} cannot resolve ${requestedScopeType}.`,
      );
    }
  }
  const matches = await Promise.all(
    args.scopeTypes.map((requestedScopeType) =>
      activeGrantByValidity(ctx, { ...args, scopeType: requestedScopeType }),
    ),
  );
  return matches.some(Boolean);
}

export async function matchingPermissionGrantIds(
  ctx: ReadCtx,
  args: PermissionRequest,
) {
  const subject = await ctx.db.get(args.eventAccessSubjectId);
  if (!subject || subject.eventId !== args.eventId || subject.status !== "active") {
    throw new ConvexError({ code: "ACCESS_DENIED", message: "Event access is not active." });
  }

  const definition = permissionCatalog[args.permissionKey];
  if (args.scopeType === "event" && !definition.eventWide) {
    throw new Error(`Permission ${args.permissionKey} cannot resolve event scope.`);
  }
  if (
    args.scopeType !== "event" &&
    !definition.scopes.some((scope) => scope === args.scopeType)
  ) {
    throw new Error(`Permission ${args.permissionKey} cannot resolve ${args.scopeType}.`);
  }

  const eventScopeRequest = {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    permissionKey: args.permissionKey,
    scopeType: "event" as const,
  };
  const [requestedGrants, eventGrants] = await Promise.all([
    activeExactPermissionGrants(ctx, args),
    args.scopeType !== "event" && definition.eventWide
      ? activeExactPermissionGrants(ctx, eventScopeRequest)
      : Promise.resolve([]),
  ]);
  const now = Date.now();
  const matching = [...requestedGrants, ...eventGrants].filter((grant) => {
    return activeGrantIsCurrent(grant, args.eventId, now);
  });

  return matching.map((grant) => grant._id);
}

export async function requirePermission(
  ctx: ReadCtx,
  args: PermissionRequest,
) {
  const matchingGrantIds = await matchingPermissionGrantIds(ctx, args);

  if (matchingGrantIds.length === 0) {
    throw new ConvexError({
      code: "ACCESS_DENIED",
      message: "This account does not have permission for that exact resource.",
    });
  }

  return matchingGrantIds;
}

export async function insertPermissionGrantGroup(
  ctx: MutationCtx,
  args: PermissionGrantGroupArgs,
): Promise<{
  results: PermissionGrantInsertResult[];
  createdCount: number;
}> {
  if (args.grants.length === 0) {
    throw new Error("A permission grant group must contain at least one grant.");
  }
  if (args.grants.length > maximumCurrentGrantsPerSource) {
    throw new Error("A permission grant group exceeds the current-grant source limit.");
  }

  const subject = await ctx.db.get(args.eventAccessSubjectId);
  if (
    !subject ||
    subject.eventId !== args.eventId ||
    subject.personId !== args.personId ||
    subject.status !== "active"
  ) {
    throw new Error("Permission grant target must be one active event account.");
  }

  const now = Date.now();
  const validFrom = args.validFrom ?? now;
  if (
    !Number.isSafeInteger(validFrom) ||
    (args.validUntil !== undefined &&
      (!Number.isSafeInteger(args.validUntil) ||
        args.validUntil <= validFrom ||
        args.validUntil <= now))
  ) {
    throw new Error("Permission grant validity is invalid.");
  }

  const status = validFrom > now ? "scheduled" : "active";
  const currentSourceGrantRows = await currentSourceGrants(ctx, {
    eventId: args.eventId,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
  });
  let currentSourceGrantCount = currentSourceGrantRows.length;
  let createdCount = 0;
  const results: PermissionGrantInsertResult[] = [];
  const sourceResultByExactScope = new Map<
    string,
    PermissionGrantInsertResult & {
      delegation: Doc<"permissionGrants">["delegation"];
    }
  >();

  for (const planned of args.grants) {
    const definition = permissionCatalog[planned.permissionKey];
    if (planned.scopeType === "event") {
      if (!definition.eventWide || planned.scopeId !== undefined) {
        throw new Error(
          `Permission ${planned.permissionKey} cannot be granted event-wide.`,
        );
      }
    } else if (!definition.scopes.some((scope) => scope === planned.scopeType)) {
      throw new Error(
        `Invalid ${planned.scopeType} scope for ${planned.permissionKey}.`,
      );
    }

    const isScopedAuthority =
      planned.permissionKey === "access.permissions.grant_scoped" ||
      planned.permissionKey === "access.permissions.revoke_scoped";
    if (isScopedAuthority !== (planned.delegation !== undefined)) {
      throw new Error(
        "Scoped permission authority requires one delegation ceiling, and ordinary grants cannot carry one.",
      );
    }
    if (planned.delegation) {
      if (planned.scopeType !== "event" || args.validUntil === undefined) {
        throw new Error("A delegation ceiling must be event-scoped and time-bounded.");
      }
      if (
        !isPermissionKey(planned.delegation.permissionKey) ||
        planned.delegation.permissionKey === "access.permissions.grant_any" ||
        planned.delegation.permissionKey === "access.permissions.revoke_any" ||
        planned.delegation.permissionKey === "access.permissions.grant_scoped" ||
        planned.delegation.permissionKey === "access.permissions.revoke_scoped"
      ) {
        throw new Error(
          "A delegation ceiling must name one non-administrative catalog permission.",
        );
      }
      const delegatedDefinition = permissionCatalog[planned.delegation.permissionKey];
      if (planned.delegation.scopeType === "event") {
        if (
          !delegatedDefinition.eventWide ||
          planned.delegation.scopeId !== undefined
        ) {
          throw new Error("The delegated permission cannot use that event scope.");
        }
      } else if (
        !delegatedDefinition.scopes.some(
          (scope) => scope === planned.delegation?.scopeType,
        ) ||
        planned.delegation.scopeId === undefined
      ) {
        throw new Error(
          "The delegated permission needs one legal exact resource scope.",
        );
      }
      if (
        planned.delegation.target.kind === "any_event_person" &&
        (planned.delegation.scopeType === "self" ||
          planned.delegation.scopeType === "page" ||
          (planned.delegation.scopeType === "scorecard" &&
            scorecardScopeMustMatchTarget(planned.delegation.permissionKey)))
      ) {
        throw new Error("That target-owned scope requires one exact target person.");
      }
      if (planned.delegation.target.kind === "exact_person") {
        const delegatedTargetPersonId = planned.delegation.target.personId;
        const delegatedTarget = await ctx.db
          .query("eventAccessSubjects")
          .withIndex("by_event_person", (query) =>
            query
              .eq("eventId", args.eventId)
              .eq("personId", delegatedTargetPersonId),
          )
          .unique();
        if (!delegatedTarget || delegatedTarget.status !== "active") {
          throw new Error(
            "The delegation target must be an active account in this event.",
          );
        }
      }
    }

    const exactScopeKey = JSON.stringify([
      planned.permissionKey,
      planned.scopeType,
      planned.scopeType === "event" ? null : planned.scopeId,
    ]);
    const knownResult = sourceResultByExactScope.get(exactScopeKey);
    if (knownResult) {
      if (!samePermissionDelegation(knownResult.delegation, planned.delegation)) {
        throw new Error(
          "A permission grant group repeats one exact scope with different delegation.",
        );
      }
      results.push({ grantId: knownResult.grantId, created: false });
      continue;
    }

    const permissionRequest =
      planned.scopeType === "event"
        ? {
            eventId: args.eventId,
            eventAccessSubjectId: args.eventAccessSubjectId,
            permissionKey: planned.permissionKey,
            scopeType: "event" as const,
          }
        : {
            eventId: args.eventId,
            eventAccessSubjectId: args.eventAccessSubjectId,
            permissionKey: planned.permissionKey,
            scopeType: planned.scopeType,
            scopeId: planned.scopeId,
          };
    const currentScopeGrants = await currentExactPermissionGrants(
      ctx,
      permissionRequest,
    );
    const existing = currentScopeGrants.filter(
      (grant) =>
        grant.sourceType === args.sourceType && grant.sourceId === args.sourceId,
    );
    if (existing.length > 1) {
      throw new Error(
        "A permission source owns duplicate grants for one exact scope.",
      );
    }
    const duplicate = existing[0];
    if (duplicate) {
      if (
        !samePermissionDelegation(duplicate.delegation, planned.delegation) ||
        (args.validFrom !== undefined && duplicate.validFrom !== args.validFrom) ||
        duplicate.validUntil !== args.validUntil ||
        duplicate.grantBatchId !== args.grantBatchId ||
        duplicate.grantedByPersonId !== args.grantedByPersonId ||
        duplicate.reason !== args.reason
      ) {
        throw new Error(
          "A permission source reused one exact scope with different grant semantics.",
        );
      }
      const result = {
        grantId: duplicate._id,
        created: false,
        delegation: duplicate.delegation,
      };
      sourceResultByExactScope.set(exactScopeKey, result);
      results.push({ grantId: result.grantId, created: false });
      continue;
    }
    if (currentScopeGrants.length >= maximumCurrentGrantsPerPermissionScope) {
      throw new Error("An exact permission scope has reached its current-grant limit.");
    }
    if (currentSourceGrantCount >= maximumCurrentGrantsPerSource) {
      throw new Error("A permission source has reached its current-grant limit.");
    }

    const grantId = await ctx.db.insert("permissionGrants", {
      eventId: args.eventId,
      personId: args.personId,
      eventAccessSubjectId: args.eventAccessSubjectId,
      permissionKey: planned.permissionKey,
      scopeType: planned.scopeType,
      ...(planned.scopeType === "event" ? {} : { scopeId: planned.scopeId }),
      ...(planned.delegation !== undefined
        ? { delegation: planned.delegation }
        : {}),
      validFrom,
      ...(args.validUntil !== undefined ? { validUntil: args.validUntil } : {}),
      status,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      ...(args.grantBatchId !== undefined
        ? { grantBatchId: args.grantBatchId }
        : {}),
      ...(args.grantedByPersonId !== undefined
        ? { grantedByPersonId: args.grantedByPersonId }
        : {}),
      reason: args.reason,
      createdAt: now,
      ...(status === "active" ? { activatedAt: now } : {}),
    });
    if (status === "scheduled") {
      await ctx.scheduler.runAt(
        validFrom,
        internal.permissionGrantLifecycle.transitionGrant,
        { grantId },
      );
    }
    if (args.validUntil !== undefined) {
      await ctx.scheduler.runAt(
        args.validUntil,
        internal.permissionGrantLifecycle.transitionGrant,
        { grantId },
      );
    }
    currentSourceGrantCount += 1;
    createdCount += 1;
    const result = { grantId, created: true, delegation: planned.delegation };
    sourceResultByExactScope.set(exactScopeKey, result);
    results.push({ grantId: result.grantId, created: true });
  }

  return { results, createdCount };
}

export async function insertPermissionGrant(
  ctx: MutationCtx,
  args: PermissionGrantInsertArgs,
): Promise<PermissionGrantInsertResult> {
  const plan: PermissionGrantPlan =
    args.scopeType === "event"
      ? {
          permissionKey: args.permissionKey,
          scopeType: "event",
          ...(args.delegation !== undefined
            ? { delegation: args.delegation }
            : {}),
        }
      : {
          permissionKey: args.permissionKey,
          scopeType: args.scopeType,
          scopeId: args.scopeId,
          ...(args.delegation !== undefined
            ? { delegation: args.delegation }
            : {}),
        };
  const group = await insertPermissionGrantGroup(ctx, {
    eventId: args.eventId,
    personId: args.personId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    ...(args.grantBatchId !== undefined
      ? { grantBatchId: args.grantBatchId }
      : {}),
    ...(args.grantedByPersonId !== undefined
      ? { grantedByPersonId: args.grantedByPersonId }
      : {}),
    reason: args.reason,
    ...(args.validFrom !== undefined ? { validFrom: args.validFrom } : {}),
    ...(args.validUntil !== undefined ? { validUntil: args.validUntil } : {}),
    grants: [plan],
  });
  const [result] = group.results;
  if (!result) throw new Error("A single permission grant did not produce a result.");
  return result;
}

export async function addEventSubjectSelfGrants(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    personId: Id<"people">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
  },
) {
  const permissionKeys = [
    "support.case.create",
    "support.case.read",
    "support.case.reply",
  ] satisfies PermissionKey[];
  const priorGrants = await ctx.db
    .query("permissionGrants")
    .withIndex("by_source", (query) =>
      query
        .eq("eventId", args.eventId)
        .eq("sourceType", "event_subject")
        .eq("sourceId", args.eventAccessSubjectId),
    )
    .take(permissionKeys.length + 1);
  if (priorGrants.length > permissionKeys.length) {
    throw new Error("An event-account self-grant source exceeds its fixed permission set.");
  }
  let createdCount = 0;
  for (const permissionKey of permissionKeys) {
    const existed = priorGrants.some(
      (grant) =>
        grant.eventAccessSubjectId === args.eventAccessSubjectId &&
        grant.permissionKey === permissionKey &&
        grant.scopeType === "self" &&
        grant.scopeId === args.eventAccessSubjectId,
    );
    if (existed) continue;
    const result = await insertPermissionGrant(ctx, {
      ...args,
      permissionKey,
      scopeType: "self",
      scopeId: args.eventAccessSubjectId,
      sourceType: "event_subject",
      sourceId: args.eventAccessSubjectId,
      reason: "Active event account self-service",
    });
    if (result.created) createdCount += 1;
  }
  return createdCount;
}

export async function revokeSourceGrants(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    sourceType: GrantSource;
    sourceId: string;
    revokedByPersonId?: Id<"people">;
    reason: string;
  },
) {
  await revokeSourceGrantGroups(ctx, {
    eventId: args.eventId,
    sources: [{ sourceType: args.sourceType, sourceId: args.sourceId }],
    ...(args.revokedByPersonId !== undefined
      ? { revokedByPersonId: args.revokedByPersonId }
      : {}),
    reason: args.reason,
  });
}

export async function revokeSourceGrantGroups(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    sources: Array<{ sourceType: GrantSource; sourceId: string }>;
    revokedByPersonId?: Id<"people">;
    reason: string;
  },
) {
  const grantGroups = await Promise.all(
    args.sources.map((source) =>
      currentSourceGrants(ctx, {
        eventId: args.eventId,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
      }),
    ),
  );
  const now = Date.now();
  const subjectIds = new Set<Id<"eventAccessSubjects">>();
  for (const grants of grantGroups) {
    for (const grant of grants) {
      await ctx.db.patch(grant._id, {
        status: "revoked",
        revokedAt: now,
        ...(args.revokedByPersonId !== undefined
          ? { revokedByPersonId: args.revokedByPersonId }
          : {}),
        revokeReason: args.reason,
      });
      subjectIds.add(grant.eventAccessSubjectId);
    }
  }
  for (const subjectId of subjectIds) {
    await advanceAccessVersion(ctx, subjectId, now);
  }
}

export function assertPermissionKey(value: string): PermissionKey {
  if (!isPermissionKey(value)) {
    throw new ConvexError({ code: "UNKNOWN_PERMISSION", message: "Unknown permission key." });
  }
  return value;
}
