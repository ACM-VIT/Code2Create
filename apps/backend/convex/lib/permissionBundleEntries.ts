import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { validateGrantScope } from "./grantScopes";
import { operationFingerprint, type OperationFingerprintPart } from "./operations";
import {
  permissionCatalog,
  type PermissionKey,
} from "./permissionCatalog";
import { assertPermissionKey } from "./permissions";

type ReadCtx = QueryCtx | MutationCtx;
type BundleEntry = Doc<"permissionBundleVersions">["entries"][number];
type PermissionScopeType = Doc<"permissionGrants">["scopeType"];
type ResourceScopeType = Exclude<PermissionScopeType, "event">;

export type ResolvedBundleGrant = { permissionKey: PermissionKey } & (
  | { scopeType: "event" }
  | { scopeType: ResourceScopeType; scopeId: string }
);

export type BundleBinding = {
  key: string;
  scopeId: string;
};

const minimumBundleEntries = 1;
const maximumBundleEntries = 48;
const bindingKeyPattern = /^[a-z][a-z0-9_]{1,39}$/;

function checkedBindingKey(value: string) {
  const key = value.trim().toLowerCase();
  if (!bindingKeyPattern.test(key)) {
    throw new ConvexError({
      code: "INVALID_BUNDLE_ENTRY",
      message: "Binding keys must be 2–40 lowercase letters, numbers, or underscores.",
    });
  }
  return key;
}

export function normalizeBundleEntries(entries: readonly BundleEntry[]) {
  if (entries.length < minimumBundleEntries || entries.length > maximumBundleEntries) {
    throw new ConvexError({
      code: "INVALID_BUNDLE_ENTRIES",
      message: `A permission bundle needs ${minimumBundleEntries}–${maximumBundleEntries} entries.`,
    });
  }

  const seenEntries = new Set<string>();
  const bindingScopes = new Map<string, PermissionScopeType>();
  return entries.map((entry) => {
    const permissionKey = assertPermissionKey(entry.permissionKey);
    if (
      permissionKey === "access.permissions.grant_scoped" ||
      permissionKey === "access.permissions.revoke_scoped"
    ) {
      throw new ConvexError({
        code: "INVALID_BUNDLE_ENTRY",
        message: "Scoped grant and revoke authority must be configured as one explicit person-specific delegation, not through a bundle.",
      });
    }
    const definition = permissionCatalog[permissionKey];
    if (entry.scopeType === "event") {
      if (!definition.eventWide || entry.scopeSource !== "event" || entry.bindingKey !== undefined) {
        throw new ConvexError({
          code: "INVALID_BUNDLE_ENTRY",
          message: `${permissionKey} cannot use that event-scope rule.`,
        });
      }
    } else {
      if (!definition.scopes.some((scope) => scope === entry.scopeType)) {
        throw new ConvexError({
          code: "INVALID_BUNDLE_ENTRY",
          message: `${entry.scopeType} is not valid for ${permissionKey}.`,
        });
      }
      if (entry.scopeType === "self") {
        if (entry.scopeSource !== "target" || entry.bindingKey !== undefined) {
          throw new ConvexError({
            code: "INVALID_BUNDLE_ENTRY",
            message: "Self-scoped bundle entries must resolve to the target account.",
          });
        }
      } else if (entry.scopeSource === "event") {
        throw new ConvexError({
          code: "INVALID_BUNDLE_ENTRY",
          message: "Only event scope can use the event source.",
        });
      } else if (entry.scopeSource === "target") {
        if (entry.scopeType !== "person" || entry.bindingKey !== undefined) {
          throw new ConvexError({
            code: "INVALID_BUNDLE_ENTRY",
            message: "Only person scope can resolve directly to the target account.",
          });
        }
      }
    }

    const bindingKey =
      entry.scopeSource === "binding"
        ? checkedBindingKey(entry.bindingKey ?? "")
        : undefined;
    if (entry.scopeSource === "binding") {
      if (entry.scopeType === "event" || entry.scopeType === "self") {
        throw new ConvexError({
          code: "INVALID_BUNDLE_ENTRY",
          message: "Event and self scopes cannot use an application binding.",
        });
      }
      const priorScope = bindingScopes.get(bindingKey ?? "");
      if (priorScope !== undefined && priorScope !== entry.scopeType) {
        throw new ConvexError({
          code: "INVALID_BUNDLE_ENTRY",
          message: `Binding ${bindingKey} cannot represent two resource types.`,
        });
      }
      if (bindingKey !== undefined) bindingScopes.set(bindingKey, entry.scopeType);
    }

    const identity = [
      permissionKey,
      entry.scopeType,
      entry.scopeSource,
      bindingKey ?? "",
    ].join("|");
    if (seenEntries.has(identity)) {
      throw new ConvexError({
        code: "DUPLICATE_BUNDLE_ENTRY",
        message: "A permission bundle cannot contain the same grant twice.",
      });
    }
    seenEntries.add(identity);
    return {
      permissionKey,
      scopeType: entry.scopeType,
      scopeSource: entry.scopeSource,
      ...(bindingKey !== undefined ? { bindingKey } : {}),
      validityRule: "bundle" as const,
    };
  });
}

export function bundleContentChecksum(args: {
  key: string;
  label: string;
  defaultRole: Doc<"permissionBundleVersions">["defaultRole"];
  entries: readonly BundleEntry[];
}) {
  const parts: OperationFingerprintPart[] = [
    args.key,
    args.label,
    args.defaultRole ?? null,
  ];
  for (const entry of args.entries) {
    parts.push(
      entry.permissionKey,
      entry.scopeType,
      entry.scopeSource,
      entry.bindingKey ?? null,
      entry.validityRule,
    );
  }
  return operationFingerprint(parts);
}

export function bundleBindingRequirements(entries: readonly BundleEntry[]) {
  const requirements = new Map<
    string,
    { key: string; scopeType: ResourceScopeType; permissionKey: PermissionKey }
  >();
  for (const entry of entries) {
    if (entry.scopeSource !== "binding" || entry.bindingKey === undefined) continue;
    if (entry.scopeType === "event") continue;
    const permissionKey = assertPermissionKey(entry.permissionKey);
    if (!requirements.has(entry.bindingKey)) {
      requirements.set(entry.bindingKey, {
        key: entry.bindingKey,
        scopeType: entry.scopeType,
        permissionKey,
      });
    }
  }
  return [...requirements.values()];
}

export function normalizeBundleBindings(
  requirements: ReturnType<typeof bundleBindingRequirements>,
  bindings: readonly BundleBinding[],
) {
  const expected = new Map(requirements.map((requirement) => [requirement.key, requirement]));
  const resolved = new Map<string, string>();
  for (const binding of bindings) {
    const key = checkedBindingKey(binding.key);
    const scopeId = binding.scopeId.trim();
    if (!expected.has(key) || !scopeId || resolved.has(key)) {
      throw new ConvexError({
        code: "INVALID_BUNDLE_BINDING",
        message: "Bundle bindings must name every required resource exactly once.",
      });
    }
    resolved.set(key, scopeId);
  }
  if (resolved.size !== expected.size) {
    throw new ConvexError({
      code: "INVALID_BUNDLE_BINDING",
      message: "Choose every resource required by this permission bundle.",
    });
  }
  return requirements.map((requirement) => {
    const scopeId = resolved.get(requirement.key);
    if (!scopeId) {
      throw new Error("Validated permission-bundle binding did not resolve.");
    }
    return { key: requirement.key, scopeId };
  });
}

async function targetSelfScopeId(
  ctx: ReadCtx,
  eventId: Id<"events">,
  targetPersonId: Id<"people">,
  permissionKey: PermissionKey,
) {
  if (
    permissionKey === "reviewer.device.register" ||
    permissionKey === "communications.call_consent.manage"
  ) {
    const subject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", eventId).eq("personId", targetPersonId),
      )
      .unique();
    if (!subject || subject.status !== "active") {
      throw new ConvexError({
        code: "INVALID_BUNDLE_TARGET",
        message: "The target event account is not active.",
      });
    }
    return subject._id;
  }
  const membership = await ctx.db
    .query("eventMemberships")
    .withIndex("by_event_person", (index) =>
      index.eq("eventId", eventId).eq("personId", targetPersonId),
    )
    .unique();
  if (!membership) {
    throw new ConvexError({
      code: "INVALID_BUNDLE_TARGET",
      message: "This bundle contains participant-only access, but the target is not a participant.",
    });
  }
  return membership._id;
}

export async function resolveBundleGrants(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    targetPersonId: Id<"people">;
    entries: readonly BundleEntry[];
    bindings: readonly BundleBinding[];
  },
) {
  const requirements = bundleBindingRequirements(args.entries);
  const normalizedBindings = normalizeBundleBindings(requirements, args.bindings);
  const bindings = new Map(
    normalizedBindings.map((binding) => [binding.key, binding.scopeId]),
  );
  const resolved: ResolvedBundleGrant[] = [];
  const identities = new Set<string>();
  for (const entry of args.entries) {
    const permissionKey = assertPermissionKey(entry.permissionKey);
    const scopeId =
      entry.scopeSource === "event"
        ? undefined
        : entry.scopeSource === "target"
          ? entry.scopeType === "self"
            ? await targetSelfScopeId(
                ctx,
                args.eventId,
                args.targetPersonId,
                permissionKey,
              )
            : args.targetPersonId
          : bindings.get(entry.bindingKey ?? "");
    const scope = await validateGrantScope(
      ctx,
      args.eventId,
      args.targetPersonId,
      permissionKey,
      entry.scopeType,
      scopeId,
    );
    const identity = [
      permissionKey,
      scope.scopeType,
      scope.scopeType === "event" ? "" : scope.scopeId,
    ].join("|");
    if (identities.has(identity)) {
      throw new ConvexError({
        code: "DUPLICATE_RESOLVED_BUNDLE_GRANT",
        message: "Two bundle entries resolve to the same permission and resource.",
      });
    }
    identities.add(identity);
    resolved.push({ permissionKey, ...scope });
  }
  return resolved;
}

export function resolvedBundleChecksum(args: {
  bundleChecksum: string;
  targetPersonId: Id<"people">;
  expectedAccessVersion: number;
  validUntil: number | undefined;
  grants: readonly ResolvedBundleGrant[];
}) {
  const parts: OperationFingerprintPart[] = [
    args.bundleChecksum,
    args.targetPersonId,
    args.expectedAccessVersion,
    args.validUntil ?? null,
  ];
  for (const grant of args.grants) {
    parts.push(
      grant.permissionKey,
      grant.scopeType,
      "scopeId" in grant ? grant.scopeId : null,
    );
  }
  return operationFingerprint(parts);
}

export function resolvedBundleSourceId(args: {
  bundleVersionId: Id<"permissionBundleVersions">;
  targetPersonId: Id<"people">;
  validUntil: number | undefined;
  grants: readonly ResolvedBundleGrant[];
}) {
  const parts: OperationFingerprintPart[] = [
    args.targetPersonId,
    args.validUntil ?? null,
  ];
  for (const grant of args.grants) {
    parts.push(
      grant.permissionKey,
      grant.scopeType,
      "scopeId" in grant ? grant.scopeId : null,
    );
  }
  return `bundle:${args.bundleVersionId}:${operationFingerprint(parts)}`;
}
