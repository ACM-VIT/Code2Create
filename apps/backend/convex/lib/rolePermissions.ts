import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  eventOwnerPermissionKeys,
  isPermissionKey,
  permissionCatalog,
  type PermissionKey,
} from "./permissionCatalog";
import {
  currentSourceGrants,
  insertPermissionGrantGroup,
  type PermissionGrantPlan,
} from "./permissions";

export const supremeSelfPermissionKeys: readonly PermissionKey[] = Object.keys(
  permissionCatalog,
)
  .filter(isPermissionKey)
  .filter((permissionKey) => {
    const definition = permissionCatalog[permissionKey];
    return !definition.eventWide && definition.scopes.some((scope) => scope === "self");
  });

export async function grantSupremeRolePermissions(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    personId: Id<"people">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    roleId: Id<"eventRoles">;
    grantedByPersonId: Id<"people">;
  },
) {
  const plannedGrants: PermissionGrantPlan[] = [
    ...eventOwnerPermissionKeys.map((permissionKey) => ({
      permissionKey,
      scopeType: "event" as const,
    })),
    ...supremeSelfPermissionKeys.map((permissionKey) => ({
      permissionKey,
      scopeType: "self" as const,
      scopeId: args.eventAccessSubjectId,
    })),
  ];
  const currentGrants = await currentSourceGrants(ctx, {
    eventId: args.eventId,
    sourceType: "role_template",
    sourceId: args.roleId,
  });
  const currentGrantKeys = new Set<string>();
  for (const grant of currentGrants) {
    if (!isPermissionKey(grant.permissionKey)) {
      throw new Error("A Supreme role template contains an unknown permission.");
    }
    if (
      grant.personId !== args.personId ||
      grant.eventAccessSubjectId !== args.eventAccessSubjectId
    ) {
      throw new Error("A Supreme role template targets the wrong event account.");
    }
    const key = permissionGrantKey({
      permissionKey: grant.permissionKey,
      scopeType: grant.scopeType,
      scopeId: grant.scopeId,
    });
    if (currentGrantKeys.has(key)) {
      throw new Error("A Supreme role template owns duplicate permission scopes.");
    }
    currentGrantKeys.add(key);
  }
  const missingGrants = plannedGrants.filter(
    (grant) => !currentGrantKeys.has(permissionGrantKey(grant)),
  );
  if (missingGrants.length === 0) return 0;
  const result = await insertPermissionGrantGroup(ctx, {
    eventId: args.eventId,
    personId: args.personId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    sourceType: "role_template",
    sourceId: args.roleId,
    grantedByPersonId: args.grantedByPersonId,
    reason: "Supreme role authority",
    grants: missingGrants,
  });
  return result.createdCount;
}

function permissionGrantKey(grant: {
  permissionKey: PermissionKey;
  scopeType: PermissionGrantPlan["scopeType"];
  scopeId?: string | undefined;
}) {
  return JSON.stringify([
    grant.permissionKey,
    grant.scopeType,
    grant.scopeType === "event" ? null : grant.scopeId,
  ]);
}
