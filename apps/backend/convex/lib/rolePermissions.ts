import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  eventOwnerPermissionKeys,
  isPermissionKey,
  permissionCatalog,
  type PermissionKey,
} from "./permissionCatalog";
import { insertPermissionGrant } from "./permissions";

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
  let createdCount = 0;
  for (const permissionKey of eventOwnerPermissionKeys) {
    const result = await insertPermissionGrant(ctx, {
      eventId: args.eventId,
      personId: args.personId,
      eventAccessSubjectId: args.eventAccessSubjectId,
      permissionKey,
      scopeType: "event",
      sourceType: "role_template",
      sourceId: args.roleId,
      grantedByPersonId: args.grantedByPersonId,
      reason: "Supreme role authority",
    });
    if (result.created) createdCount += 1;
  }
  for (const permissionKey of supremeSelfPermissionKeys) {
    const result = await insertPermissionGrant(ctx, {
      eventId: args.eventId,
      personId: args.personId,
      eventAccessSubjectId: args.eventAccessSubjectId,
      permissionKey,
      scopeType: "self",
      scopeId: args.eventAccessSubjectId,
      sourceType: "role_template",
      sourceId: args.roleId,
      grantedByPersonId: args.grantedByPersonId,
      reason: "Supreme role authority",
    });
    if (result.created) createdCount += 1;
  }
  return createdCount;
}
