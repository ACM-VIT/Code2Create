import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { scorecardScopeMustMatchTarget } from "./grantScopes";
import { isPermissionKey, type PermissionKey } from "./permissionCatalog";
import { matchingPermissionGrantIds } from "./permissions";

type ReadCtx = QueryCtx | MutationCtx;
type PermissionScopeType = Doc<"permissionGrants">["scopeType"];
type ScopedAuthorityKey = "access.permissions.grant_scoped" | "access.permissions.revoke_scoped";

export type PermissionAdministrationAction = {
  permissionKey: PermissionKey;
  scopeType: PermissionScopeType;
  scopeId?: string;
  targetPersonId: Id<"people">;
  validUntil?: number;
};

export type PermissionDelegationAuthority = {
  id: Id<"permissionGrants">;
  permissionKey: string;
  status: Doc<"permissionGrants">["status"];
  validFrom: number;
  validUntil?: number;
  delegation?: Doc<"permissionGrants">["delegation"];
};

export type ResolvedPermissionAuthority = {
  permissionKey:
    | "access.permissions.grant_any"
    | "access.permissions.revoke_any"
    | ScopedAuthorityKey;
  grantIds: Id<"permissionGrants">[];
};

const permissionAdministrationKeys = [
  "access.permissions.grant_any",
  "access.permissions.revoke_any",
  "access.permissions.grant_scoped",
  "access.permissions.revoke_scoped",
] as const satisfies readonly PermissionKey[];

export function isPermissionAdministrationKey(permissionKey: PermissionKey) {
  return permissionAdministrationKeys.some((key) => key === permissionKey);
}

export function isScopedPermissionAuthority(
  permissionKey: PermissionKey,
): permissionKey is ScopedAuthorityKey {
  return (
    permissionKey === "access.permissions.grant_scoped" ||
    permissionKey === "access.permissions.revoke_scoped"
  );
}

export function delegationCanTargetAnyPerson(
  permissionKey: PermissionKey,
  scopeType: PermissionScopeType,
) {
  return (
    scopeType !== "self" &&
    scopeType !== "page" &&
    !(scopeType === "scorecard" && scorecardScopeMustMatchTarget(permissionKey))
  );
}

export function scopedAuthorityMatches(
  authority: PermissionDelegationAuthority,
  authorityKey: ScopedAuthorityKey,
  action: PermissionAdministrationAction,
  now: number,
) {
  if (
    authority.permissionKey !== authorityKey ||
    authority.status !== "active" ||
    authority.validFrom > now ||
    authority.validUntil === undefined ||
    authority.validUntil <= now ||
    !authority.delegation ||
    authority.delegation.permissionKey !== action.permissionKey ||
    authority.delegation.scopeType !== action.scopeType ||
    authority.delegation.scopeId !== action.scopeId ||
    isPermissionAdministrationKey(action.permissionKey)
  ) {
    return false;
  }
  if (
    authority.delegation.target.kind === "exact_person" &&
    authority.delegation.target.personId !== action.targetPersonId
  ) {
    return false;
  }
  if (authorityKey === "access.permissions.grant_scoped") {
    return (
      action.validUntil !== undefined &&
      action.validUntil > now &&
      action.validUntil <= authority.validUntil
    );
  }
  return true;
}

async function activeAuthorityGrants(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    permissionKey: ScopedAuthorityKey;
  },
) {
  const ids = await matchingPermissionGrantIds(ctx, {
    ...args,
    scopeType: "event",
  });
  const grants = await Promise.all(ids.map((id) => ctx.db.get(id)));
  return grants.filter((grant) => grant !== null);
}

async function anyAuthorityGrantIds(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    permissionKey: "access.permissions.grant_any" | "access.permissions.revoke_any";
  },
) {
  return matchingPermissionGrantIds(ctx, {
    ...args,
    scopeType: "event",
  });
}

export async function requireGrantAuthority(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    actorPersonId: Id<"people">;
    action: PermissionAdministrationAction;
  },
): Promise<ResolvedPermissionAuthority> {
  return requireGrantAuthorities(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    actorPersonId: args.actorPersonId,
    actions: [args.action],
  });
}

export async function requireGrantAuthorities(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    actorPersonId: Id<"people">;
    actions: readonly PermissionAdministrationAction[];
  },
): Promise<ResolvedPermissionAuthority> {
  if (args.actions.length === 0) {
    throw new Error("Permission administration requires at least one action.");
  }
  const unrestrictedIds = await anyAuthorityGrantIds(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    permissionKey: "access.permissions.grant_any",
  });
  if (unrestrictedIds.length > 0) {
    return {
      permissionKey: "access.permissions.grant_any",
      grantIds: unrestrictedIds,
    };
  }
  if (
    args.actions.some(
      (action) =>
        args.actorPersonId === action.targetPersonId ||
        isPermissionAdministrationKey(action.permissionKey),
    )
  ) {
    throw new ConvexError({
      code: "ACCESS_DENIED",
      message:
        "Scoped grant authority cannot create permission-administration authority or grant access to itself.",
    });
  }
  const scoped = await activeAuthorityGrants(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    permissionKey: "access.permissions.grant_scoped",
  });
  const now = Date.now();
  const matchingGrantIds = new Set<Id<"permissionGrants">>();
  for (const action of args.actions) {
    const matching = scoped.filter((grant) =>
      scopedAuthorityMatches(
        {
          id: grant._id,
          permissionKey: grant.permissionKey,
          status: grant.status,
          validFrom: grant.validFrom,
          ...(grant.validUntil !== undefined ? { validUntil: grant.validUntil } : {}),
          ...(grant.delegation !== undefined ? { delegation: grant.delegation } : {}),
        },
        "access.permissions.grant_scoped",
        action,
        now,
      ),
    );
    if (matching.length === 0) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account cannot grant that permission to that person, resource, or expiry.",
      });
    }
    for (const grant of matching) matchingGrantIds.add(grant._id);
  }
  return {
    permissionKey: "access.permissions.grant_scoped",
    grantIds: [...matchingGrantIds],
  };
}

export async function requireRevokeAuthority(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    action: PermissionAdministrationAction;
  },
): Promise<ResolvedPermissionAuthority> {
  return requireRevokeAuthorities(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    actions: [args.action],
  });
}

export async function requireRevokeAuthorities(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    actions: readonly PermissionAdministrationAction[];
  },
): Promise<ResolvedPermissionAuthority> {
  if (args.actions.length === 0) {
    throw new Error("Permission administration requires at least one action.");
  }
  const unrestrictedIds = await anyAuthorityGrantIds(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    permissionKey: "access.permissions.revoke_any",
  });
  if (unrestrictedIds.length > 0) {
    return {
      permissionKey: "access.permissions.revoke_any",
      grantIds: unrestrictedIds,
    };
  }
  if (args.actions.some((action) => isPermissionAdministrationKey(action.permissionKey))) {
    throw new ConvexError({
      code: "ACCESS_DENIED",
      message: "Scoped revoke authority cannot revoke permission-administration authority.",
    });
  }
  const scoped = await activeAuthorityGrants(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    permissionKey: "access.permissions.revoke_scoped",
  });
  const now = Date.now();
  const matchingGrantIds = new Set<Id<"permissionGrants">>();
  for (const action of args.actions) {
    const matching = scoped.filter((grant) =>
      scopedAuthorityMatches(
        {
          id: grant._id,
          permissionKey: grant.permissionKey,
          status: grant.status,
          validFrom: grant.validFrom,
          ...(grant.validUntil !== undefined ? { validUntil: grant.validUntil } : {}),
          ...(grant.delegation !== undefined ? { delegation: grant.delegation } : {}),
        },
        "access.permissions.revoke_scoped",
        action,
        now,
      ),
    );
    if (matching.length === 0) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account cannot revoke that person’s exact permission grant.",
      });
    }
    for (const grant of matching) matchingGrantIds.add(grant._id);
  }
  return {
    permissionKey: "access.permissions.revoke_scoped",
    grantIds: [...matchingGrantIds],
  };
}

export function assertDelegatedPermissionKey(value: string) {
  if (!isPermissionKey(value) || isPermissionAdministrationKey(value)) {
    throw new ConvexError({
      code: "INVALID_DELEGATION",
      message: "Delegation must name one non-administrative catalog permission.",
    });
  }
  return value;
}
