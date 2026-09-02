import type { OperationsAutonomyReadTool } from "@code2create/domain";

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { operationsAutonomyAvailable } from "./operationsAutonomyAvailability";
import {
  operationsAutonomyPolicyChecksum,
  operationsAutonomyPolicyFromDocument,
} from "./operationsAutonomyPolicy";
import { matchingPermissionGrantIds } from "./permissions";

const terminalRunStates = new Set<Doc<"operationsAutonomyRuns">["lifecycle"]["kind"]>([
  "succeeded",
  "no_op",
  "escalated",
  "failed",
  "canceled",
]);

export function autonomyRunIsTerminal(run: Doc<"operationsAutonomyRuns">) {
  return terminalRunStates.has(run.lifecycle.kind);
}

export async function requireCurrentAutonomyAuthority(
  ctx: QueryCtx | MutationCtx,
  run: Doc<"operationsAutonomyRuns">,
  now: number,
) {
  const [event, policy, state] = await Promise.all([
    ctx.db.get(run.eventId),
    ctx.db.get(run.policyVersionId),
    ctx.db
      .query("operationsAutonomyStates")
      .withIndex("by_policy", (index) => index.eq("policyVersionId", run.policyVersionId))
      .unique(),
  ]);
  if (!event || !operationsAutonomyAvailable(event, now)) {
    return { state: "revoked" as const, reason: "event_not_live" as const };
  }
  const normalizedPolicy = policy ? operationsAutonomyPolicyFromDocument(policy) : null;
  const policyChecksum = normalizedPolicy
    ? operationsAutonomyPolicyChecksum(normalizedPolicy)
    : null;
  if (
    !policy ||
    policy.eventId !== event._id ||
    policy.status !== "published" ||
    policy.checksum !== run.policyChecksum ||
    policyChecksum !== policy.checksum ||
    policy.version !== run.policyVersion ||
    policy.mode !== run.mode ||
    policy.escalationSeverity !== run.escalationSeverity ||
    JSON.stringify(policy.allowedReadTools) !== JSON.stringify(run.allowedReadTools) ||
    JSON.stringify(policy.allowedRecommendationKinds) !==
      JSON.stringify(run.allowedRecommendationKinds) ||
    !state ||
    state.eventId !== event._id ||
    state.lifecycle.kind !== "active"
  ) {
    return { state: "revoked" as const, reason: "policy_superseded" as const };
  }
  const owner = await ctx.db.get(policy.accountableOwnerEventAccessSubjectId);
  if (!owner || owner.eventId !== event._id || owner.status !== "active") {
    return { state: "revoked" as const, reason: "owner_revoked" as const };
  }
  const readGrants = await matchingPermissionGrantIds(ctx, {
    eventId: event._id,
    eventAccessSubjectId: owner._id,
    permissionKey: "operations.intelligence.read",
    scopeType: "event",
  });
  const generateGrants =
    policy.mode === "recommend"
      ? await matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: owner._id,
          permissionKey: "operations.intelligence.generate",
          scopeType: "event",
        })
      : [];
  if (readGrants.length === 0 || (policy.mode === "recommend" && generateGrants.length === 0)) {
    return { state: "revoked" as const, reason: "owner_revoked" as const };
  }
  return { state: "active" as const, event, policy, scheduler: state };
}

export function readToolAllowed(
  run: Doc<"operationsAutonomyRuns">,
  read: OperationsAutonomyReadTool,
) {
  return run.allowedReadTools.some((candidate) => candidate === read);
}
