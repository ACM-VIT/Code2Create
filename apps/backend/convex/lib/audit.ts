import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { PermissionKey } from "./permissionCatalog";

export async function writeAuditEvent(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    actorPersonId: Id<"people">;
    permissionKey: PermissionKey;
    grantIds: Id<"permissionGrants">[];
    scopeType: Doc<"permissionGrants">["scopeType"];
    scopeId?: string;
    action: string;
    targetType: string;
    targetId: string;
    previousSummary?: string;
    nextSummary: string;
    reason: string;
  },
) {
  await ctx.db.insert("auditEvents", {
    eventId: args.eventId,
    actorPersonId: args.actorPersonId,
    authorizingPermissionKey: args.permissionKey,
    authorizingGrantIds: args.grantIds,
    resolvedScopeType: args.scopeType,
    ...(args.scopeId !== undefined ? { resolvedScopeId: args.scopeId } : {}),
    action: args.action,
    targetType: args.targetType,
    targetId: args.targetId,
    ...(args.previousSummary !== undefined ? { previousSummary: args.previousSummary } : {}),
    nextSummary: args.nextSummary,
    reason: args.reason,
    serverTime: Date.now(),
  });
}
