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
      .collect(),
    ctx.db
      .query("permissionGrants")
      .withIndex("by_source", (query) =>
        query
          .eq("eventId", args.eventId)
          .eq("sourceType", args.sourceType)
          .eq("sourceId", args.sourceId)
          .eq("status", "scheduled"),
      )
      .collect(),
  ]);
  return [...active, ...scheduled];
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

  const now = Date.now();
  const grants = await ctx.db
    .query("permissionGrants")
    .withIndex("by_subject_permission_status", (query) =>
      query
        .eq("eventAccessSubjectId", args.eventAccessSubjectId)
        .eq("permissionKey", args.permissionKey)
        .eq("status", "active"),
    )
    .collect();

  const matching = grants.filter((grant) => {
    if (grant.eventId !== args.eventId) return false;
    if (grant.validFrom > now || (grant.validUntil !== undefined && grant.validUntil <= now)) {
      return false;
    }
    if (grant.scopeType === args.scopeType && grant.scopeId === args.scopeId) return true;
    return definition.eventWide && grant.scopeType === "event" && grant.scopeId === undefined;
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

export async function insertPermissionGrant(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    personId: Id<"people">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    permissionKey: PermissionKey;
    sourceType: GrantSource;
    sourceId: string;
    grantBatchId?: Id<"permissionGrantBatches">;
    grantedByPersonId?: Id<"people">;
    reason: string;
    validFrom?: number;
    validUntil?: number;
    delegation?: Doc<"permissionGrants">["delegation"];
  } & GrantScope,
): Promise<{ grantId: Id<"permissionGrants">; created: boolean }> {
  const definition = permissionCatalog[args.permissionKey];
  if (args.scopeType === "event") {
    if (!definition.eventWide || args.scopeId !== undefined) {
      throw new Error(`Permission ${args.permissionKey} cannot be granted event-wide.`);
    }
  } else if (!definition.scopes.some((scope) => scope === args.scopeType)) {
    throw new Error(`Invalid ${args.scopeType} scope for ${args.permissionKey}.`);
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

  const isScopedAuthority =
    args.permissionKey === "access.permissions.grant_scoped" ||
    args.permissionKey === "access.permissions.revoke_scoped";
  if (isScopedAuthority !== (args.delegation !== undefined)) {
    throw new Error("Scoped permission authority requires one delegation ceiling, and ordinary grants cannot carry one.");
  }
  if (args.delegation) {
    if (args.scopeType !== "event" || args.validUntil === undefined) {
      throw new Error("A delegation ceiling must be event-scoped and time-bounded.");
    }
    if (
      !isPermissionKey(args.delegation.permissionKey) ||
      args.delegation.permissionKey === "access.permissions.grant_any" ||
      args.delegation.permissionKey === "access.permissions.revoke_any" ||
      args.delegation.permissionKey === "access.permissions.grant_scoped" ||
      args.delegation.permissionKey === "access.permissions.revoke_scoped"
    ) {
      throw new Error("A delegation ceiling must name one non-administrative catalog permission.");
    }
    const delegatedDefinition = permissionCatalog[args.delegation.permissionKey];
    if (args.delegation.scopeType === "event") {
      if (!delegatedDefinition.eventWide || args.delegation.scopeId !== undefined) {
        throw new Error("The delegated permission cannot use that event scope.");
      }
    } else if (
      !delegatedDefinition.scopes.some(
        (scope) => scope === args.delegation?.scopeType,
      ) ||
      args.delegation.scopeId === undefined
    ) {
      throw new Error("The delegated permission needs one legal exact resource scope.");
    }
    if (
      args.delegation.target.kind === "any_event_person" &&
      (args.delegation.scopeType === "self" ||
        args.delegation.scopeType === "page" ||
        (args.delegation.scopeType === "scorecard" &&
          scorecardScopeMustMatchTarget(args.delegation.permissionKey)))
    ) {
      throw new Error("That target-owned scope requires one exact target person.");
    }
    if (args.delegation.target.kind === "exact_person") {
      const delegatedTargetPersonId = args.delegation.target.personId;
      const delegatedTarget = await ctx.db
        .query("eventAccessSubjects")
        .withIndex("by_event_person", (query) =>
          query
            .eq("eventId", args.eventId)
            .eq("personId", delegatedTargetPersonId),
        )
        .unique();
      if (!delegatedTarget || delegatedTarget.status !== "active") {
        throw new Error("The delegation target must be an active account in this event.");
      }
    }
  }

  const [activeSourceGrants, scheduledSourceGrants] = await Promise.all([
    ctx.db
      .query("permissionGrants")
      .withIndex("by_subject_permission_status", (query) =>
        query
          .eq("eventAccessSubjectId", args.eventAccessSubjectId)
          .eq("permissionKey", args.permissionKey)
          .eq("status", "active"),
      )
      .collect(),
    ctx.db
      .query("permissionGrants")
      .withIndex("by_subject_permission_status", (query) =>
        query
          .eq("eventAccessSubjectId", args.eventAccessSubjectId)
          .eq("permissionKey", args.permissionKey)
          .eq("status", "scheduled"),
      )
      .collect(),
  ]);
  const existing = [...activeSourceGrants, ...scheduledSourceGrants].filter(
    (grant) =>
      grant.sourceType === args.sourceType && grant.sourceId === args.sourceId,
  );
  const duplicate = existing.find(
    (grant) =>
      grant.eventAccessSubjectId === args.eventAccessSubjectId &&
      grant.permissionKey === args.permissionKey &&
      grant.scopeType === args.scopeType &&
      grant.scopeId === args.scopeId,
  );
  if (duplicate) return { grantId: duplicate._id, created: false };
  const status = validFrom > now ? "scheduled" : "active";
  const grantId = await ctx.db.insert("permissionGrants", {
    eventId: args.eventId,
    personId: args.personId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    permissionKey: args.permissionKey,
    scopeType: args.scopeType,
    ...(args.scopeType === "event" ? {} : { scopeId: args.scopeId }),
    ...(args.delegation !== undefined ? { delegation: args.delegation } : {}),
    validFrom,
    ...(args.validUntil !== undefined ? { validUntil: args.validUntil } : {}),
    status,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    ...(args.grantBatchId !== undefined ? { grantBatchId: args.grantBatchId } : {}),
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
  return { grantId, created: true };
}

export async function addEventSubjectSelfGrants(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    personId: Id<"people">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
  },
) {
  const priorGrants = await ctx.db
    .query("permissionGrants")
    .withIndex("by_source", (query) =>
      query
        .eq("eventId", args.eventId)
        .eq("sourceType", "event_subject")
        .eq("sourceId", args.eventAccessSubjectId),
    )
    .collect();
  const permissionKeys = [
    "support.case.create",
    "support.case.read",
    "support.case.reply",
  ] satisfies PermissionKey[];
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
