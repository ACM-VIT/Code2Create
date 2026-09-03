import {
  intelligenceRecommendationKinds,
  operationsAutonomyScheduleIntervalMinutes,
  operationsAutonomyModes,
  operationsAutonomyReadTools,
  operationsHealthAreas,
  operationsHealthSeverities,
  type IntelligenceRecommendationKind,
  type OperationsAutonomyPolicyConfiguration,
  type OperationsAutonomyReadTool,
  type OperationsHealthArea,
  type OperationsHealthSeverity,
} from "@code2create/domain";
import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { matchingPermissionGrantIds } from "./permissions";
import { fingerprintText } from "./strings";
import { revokeOperationsAutonomyPolicy } from "./operationsAutonomyRevocation";

export type OperationsAutonomyPolicy = Omit<
  OperationsAutonomyPolicyConfiguration,
  "accountableOwnerEventAccessSubjectId"
> & { accountableOwnerEventAccessSubjectId: Id<"eventAccessSubjects"> };

export const defaultOperationsAutonomyPolicy = (
  ownerId: Id<"eventAccessSubjects">,
): OperationsAutonomyPolicy => ({
  enabled: false,
  mode: "observe",
  scheduleIntervalMinutes: 5,
  triggerSeverities: ["critical"],
  triggerAreas: [...operationsHealthAreas],
  escalationSeverity: "critical",
  allowedReadTools: [...operationsAutonomyReadTools],
  allowedRecommendationKinds: [],
  accountableOwnerEventAccessSubjectId: ownerId,
  audience: "operations_dashboard",
});

function invalidPolicy(message: string): never {
  throw new ConvexError({ code: "INVALID_OPERATIONS_AUTONOMY_POLICY", message });
}

function wholeNumber(value: number, field: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalidPolicy(`${field} must be a whole number from ${minimum} through ${maximum}.`);
  }
  return value;
}

function normalizedSet<Value extends string>(
  values: readonly Value[],
  allowed: readonly Value[],
  field: string,
  allowEmpty = false,
) {
  if (!allowEmpty && values.length === 0) invalidPolicy(`${field} must not be empty.`);
  if (new Set(values).size !== values.length)
    invalidPolicy(`${field} must not contain duplicates.`);
  if (values.some((value) => !allowed.includes(value))) {
    invalidPolicy(`${field} contains an unsupported value.`);
  }
  return allowed.filter((value) => values.includes(value));
}

export function normalizeOperationsAutonomyPolicy(
  input: OperationsAutonomyPolicy,
): OperationsAutonomyPolicy {
  const [mode] = normalizedSet([input.mode], operationsAutonomyModes, "Autonomy mode");
  if (!mode) invalidPolicy("Autonomy mode is required.");
  const allowedRecommendationKinds = normalizedSet<IntelligenceRecommendationKind>(
    input.allowedRecommendationKinds,
    intelligenceRecommendationKinds,
    "Allowed recommendation kinds",
    mode === "observe",
  );
  if (mode === "observe" && allowedRecommendationKinds.length > 0) {
    invalidPolicy("Observe mode cannot publish recommendations.");
  }
  if (mode === "recommend" && allowedRecommendationKinds.length === 0) {
    invalidPolicy("Recommend mode must allow at least one typed recommendation kind.");
  }
  const allowedReadTools = normalizedSet<OperationsAutonomyReadTool>(
    input.allowedReadTools,
    operationsAutonomyReadTools,
    "Allowed read tools",
  );
  if (!allowedReadTools.includes("operations_health")) {
    invalidPolicy("Autonomous operations must always read current operations health.");
  }
  return {
    enabled: input.enabled,
    mode,
    scheduleIntervalMinutes: wholeNumber(
      input.scheduleIntervalMinutes,
      "Schedule interval",
      operationsAutonomyScheduleIntervalMinutes.minimum,
      operationsAutonomyScheduleIntervalMinutes.maximum,
    ),
    triggerSeverities: normalizedSet<OperationsHealthSeverity>(
      input.triggerSeverities,
      operationsHealthSeverities,
      "Trigger severities",
    ),
    triggerAreas: normalizedSet<OperationsHealthArea>(
      input.triggerAreas,
      operationsHealthAreas,
      "Trigger areas",
    ),
    escalationSeverity:
      input.escalationSeverity === "attention" || input.escalationSeverity === "critical"
        ? input.escalationSeverity
        : invalidPolicy("Escalation severity must be attention or critical."),
    allowedReadTools,
    allowedRecommendationKinds,
    accountableOwnerEventAccessSubjectId: input.accountableOwnerEventAccessSubjectId,
    audience: "operations_dashboard",
  };
}

export function operationsAutonomyPolicyChecksum(policy: OperationsAutonomyPolicy) {
  return fingerprintText(JSON.stringify(normalizeOperationsAutonomyPolicy(policy)));
}

export function operationsAutonomyPolicyFromDocument(
  policy: Doc<"operationsAutonomyPolicyVersions">,
): OperationsAutonomyPolicy {
  return {
    enabled: policy.enabled,
    mode: policy.mode,
    scheduleIntervalMinutes: policy.scheduleIntervalMinutes,
    triggerSeverities: [...policy.triggerSeverities],
    triggerAreas: [...policy.triggerAreas],
    escalationSeverity: policy.escalationSeverity,
    allowedReadTools: [...policy.allowedReadTools],
    allowedRecommendationKinds: [...policy.allowedRecommendationKinds],
    accountableOwnerEventAccessSubjectId: policy.accountableOwnerEventAccessSubjectId,
    audience: policy.audience,
  };
}

export async function requireValidAutonomyOwner(
  ctx: MutationCtx | QueryCtx,
  eventId: Id<"events">,
  subjectId: Id<"eventAccessSubjects">,
  mode: OperationsAutonomyPolicy["mode"],
) {
  const subject = await ctx.db.get(subjectId);
  if (!subject || subject.eventId !== eventId || subject.status !== "active") {
    invalidPolicy("The accountable autonomy owner must be an active event account.");
  }
  const [readGrants, generateGrants] = await Promise.all([
    matchingPermissionGrantIds(ctx, {
      eventId,
      eventAccessSubjectId: subjectId,
      permissionKey: "operations.intelligence.read",
      scopeType: "event",
    }),
    mode === "recommend"
      ? matchingPermissionGrantIds(ctx, {
          eventId,
          eventAccessSubjectId: subjectId,
          permissionKey: "operations.intelligence.generate",
          scopeType: "event",
        })
      : Promise.resolve([]),
  ]);
  if (readGrants.length === 0 || (mode === "recommend" && generateGrants.length === 0)) {
    invalidPolicy(
      mode === "recommend"
        ? "The accountable owner must be able to read and generate event intelligence."
        : "The accountable owner must be able to read event intelligence.",
    );
  }
  return subject;
}

export async function saveOperationsAutonomyPolicyDraft(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    actorPersonId: Id<"people">;
    policy: OperationsAutonomyPolicy;
    expectedDraftPolicyId?: Id<"operationsAutonomyPolicyVersions">;
    now: number;
  },
) {
  const policy = normalizeOperationsAutonomyPolicy(args.policy);
  await requireValidAutonomyOwner(
    ctx,
    args.event._id,
    policy.accountableOwnerEventAccessSubjectId,
    policy.mode,
  );
  const checksum = operationsAutonomyPolicyChecksum(policy);
  const currentDraft = await ctx.db
    .query("operationsAutonomyPolicyVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", args.event._id).eq("status", "draft"),
    )
    .unique();
  if (currentDraft?._id !== args.expectedDraftPolicyId) {
    throw new ConvexError({
      code: "OPERATIONS_AUTONOMY_POLICY_DRAFT_CHANGED",
      message: "The autonomy-policy draft changed in another session.",
    });
  }
  if (currentDraft && currentDraft.checksum === checksum) {
    return {
      policyVersionId: currentDraft._id,
      policyVersion: currentDraft.version,
      checksum,
      changed: false,
    };
  }
  if (currentDraft) await ctx.db.patch(currentDraft._id, { status: "retired" });
  const latest = await ctx.db
    .query("operationsAutonomyPolicyVersions")
    .withIndex("by_event_version", (index) => index.eq("eventId", args.event._id))
    .order("desc")
    .first();
  const version = (latest?.version ?? 0) + 1;
  const policyVersionId = await ctx.db.insert("operationsAutonomyPolicyVersions", {
    eventId: args.event._id,
    version,
    status: "draft",
    ...policy,
    checksum,
    createdByPersonId: args.actorPersonId,
    createdAt: args.now,
  });
  return { policyVersionId, policyVersion: version, checksum, changed: true };
}

export async function publishOperationsAutonomyPolicy(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    draftPolicyId: Id<"operationsAutonomyPolicyVersions">;
    expectedDraftChecksum: string;
    actorPersonId: Id<"people">;
    now: number;
  },
) {
  const draft = await ctx.db.get(args.draftPolicyId);
  if (
    !draft ||
    draft.eventId !== args.event._id ||
    draft.status !== "draft" ||
    draft.checksum !== args.expectedDraftChecksum
  ) {
    throw new ConvexError({
      code: "OPERATIONS_AUTONOMY_POLICY_DRAFT_CHANGED",
      message: "The autonomy-policy draft changed in another session.",
    });
  }
  const normalized = normalizeOperationsAutonomyPolicy(operationsAutonomyPolicyFromDocument(draft));
  await requireValidAutonomyOwner(
    ctx,
    args.event._id,
    normalized.accountableOwnerEventAccessSubjectId,
    normalized.mode,
  );
  if (operationsAutonomyPolicyChecksum(normalized) !== draft.checksum) {
    invalidPolicy("The autonomy-policy checksum does not match its contents.");
  }
  const priorPolicy = await ctx.db
    .query("operationsAutonomyPolicyVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", args.event._id).eq("status", "published"),
    )
    .unique();
  const priorState = priorPolicy
    ? await ctx.db
        .query("operationsAutonomyStates")
        .withIndex("by_policy", (index) => index.eq("policyVersionId", priorPolicy._id))
        .unique()
    : null;
  if (priorPolicy && (!priorState || priorState.eventId !== args.event._id)) {
    throw new Error("The event's current autonomy scheduler state is invalid.");
  }
  if (priorState) {
    await revokeOperationsAutonomyPolicy(ctx, {
      eventId: args.event._id,
      policyVersionId: priorState.policyVersionId,
      reason: "policy_superseded",
      now: args.now,
    });
    await ctx.db.patch(priorState._id, {
      lifecycle: { kind: "superseded", supersededAt: args.now },
      updatedAt: args.now,
      version: priorState.version + 1,
    });
  }
  if (priorPolicy) await ctx.db.patch(priorPolicy._id, { status: "superseded" });
  await ctx.db.patch(draft._id, { status: "published", publishedAt: args.now });
  await ctx.db.insert("operationsAutonomyStates", {
    eventId: args.event._id,
    policyVersionId: draft._id,
    lifecycle: normalized.enabled
      ? { kind: "active" }
      : {
          kind: "disabled",
          disabledAt: args.now,
          disabledByPersonId: args.actorPersonId,
          reason: "Published with autonomous operations disabled.",
        },
    nextEvaluationAt: args.now,
    pendingWorkCount: 0,
    cycle: 1,
    version: 1,
    updatedAt: args.now,
  });
  await ctx.db.patch(args.event._id, {
    version: args.event.version + 1,
    updatedAt: args.now,
  });
  return { policyVersionId: draft._id, policyVersion: draft.version };
}
