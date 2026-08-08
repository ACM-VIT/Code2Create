import {
  operationsHealthAreas,
  operationsHealthSeverities,
  type OperationsHealthArea,
  type OperationsHealthSeverity,
} from "@code2create/domain";
import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  operationsHealthArea,
  operationsHealthSeverity,
} from "./operationsIntelligenceValidators";
import { fingerprintText, normalizedText } from "./strings";

export const operationsIntelligencePolicyInput = v.object({
  enabled: v.boolean(),
  triggerSeverities: v.array(operationsHealthSeverity),
  triggerAreas: v.array(operationsHealthArea),
  cooldownMinutes: v.number(),
  maximumBriefsPerLocalDay: v.number(),
  relevanceMinutes: v.number(),
  accountableOwner: v.string(),
  audience: v.literal("operations_dashboard"),
});

export type OperationsIntelligencePolicy = {
  enabled: boolean;
  triggerSeverities: OperationsHealthSeverity[];
  triggerAreas: OperationsHealthArea[];
  cooldownMinutes: number;
  maximumBriefsPerLocalDay: number;
  relevanceMinutes: number;
  accountableOwner: string;
  audience: "operations_dashboard";
};

export const defaultOperationsIntelligencePolicy: OperationsIntelligencePolicy = {
  enabled: false,
  triggerSeverities: ["critical"],
  triggerAreas: [...operationsHealthAreas],
  cooldownMinutes: 30,
  maximumBriefsPerLocalDay: 8,
  relevanceMinutes: 60,
  accountableOwner: "Technical operations",
  audience: "operations_dashboard",
};

function invalidPolicy(message: string): never {
  throw new ConvexError({ code: "INVALID_OPERATIONS_INTELLIGENCE_POLICY", message });
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
) {
  if (values.length === 0) invalidPolicy(`${field} must contain at least one value.`);
  if (new Set(values).size !== values.length) {
    invalidPolicy(`${field} must not contain duplicates.`);
  }
  if (values.some((value) => !allowed.includes(value))) {
    invalidPolicy(`${field} contains an unsupported value.`);
  }
  return allowed.filter((value) => values.includes(value));
}

export function normalizeOperationsIntelligencePolicy(
  input: OperationsIntelligencePolicy,
): OperationsIntelligencePolicy {
  return {
    enabled: input.enabled,
    triggerSeverities: normalizedSet(
      input.triggerSeverities,
      operationsHealthSeverities,
      "Trigger severities",
    ),
    triggerAreas: normalizedSet(
      input.triggerAreas,
      operationsHealthAreas,
      "Trigger areas",
    ),
    cooldownMinutes: wholeNumber(input.cooldownMinutes, "Cooldown", 15, 360),
    maximumBriefsPerLocalDay: wholeNumber(
      input.maximumBriefsPerLocalDay,
      "Daily brief budget",
      1,
      24,
    ),
    relevanceMinutes: wholeNumber(input.relevanceMinutes, "Brief relevance", 15, 240),
    accountableOwner: normalizedText(
      input.accountableOwner,
      "Accountable owner",
      2,
      80,
    ),
    audience: "operations_dashboard",
  };
}

export function operationsIntelligencePolicyChecksum(
  policy: OperationsIntelligencePolicy,
) {
  return fingerprintText(JSON.stringify(normalizeOperationsIntelligencePolicy(policy)));
}

export function operationsIntelligencePolicyFromDocument(
  policy: Doc<"operationsIntelligencePolicyVersions">,
): OperationsIntelligencePolicy {
  return {
    enabled: policy.enabled,
    triggerSeverities: [...policy.triggerSeverities],
    triggerAreas: [...policy.triggerAreas],
    cooldownMinutes: policy.cooldownMinutes,
    maximumBriefsPerLocalDay: policy.maximumBriefsPerLocalDay,
    relevanceMinutes: policy.relevanceMinutes,
    accountableOwner: policy.accountableOwner,
    audience: policy.audience,
  };
}

export function localDateKey(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(timestamp);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("The event timezone did not produce a date.");
  return `${year}-${month}-${day}`;
}

export async function saveOperationsIntelligencePolicyDraft(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    actorPersonId: Id<"people">;
    policy: OperationsIntelligencePolicy;
    expectedDraftPolicyId?: Id<"operationsIntelligencePolicyVersions">;
    now: number;
  },
) {
  const policy = normalizeOperationsIntelligencePolicy(args.policy);
  const checksum = operationsIntelligencePolicyChecksum(policy);
  const currentDraft = await ctx.db
    .query("operationsIntelligencePolicyVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", args.event._id).eq("status", "draft"),
    )
    .unique();
  if (currentDraft?._id !== args.expectedDraftPolicyId) {
    throw new ConvexError({
      code: "OPERATIONS_INTELLIGENCE_POLICY_DRAFT_CHANGED",
      message: "The intelligence-policy draft changed in another session.",
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
    .query("operationsIntelligencePolicyVersions")
    .withIndex("by_event_version", (index) => index.eq("eventId", args.event._id))
    .order("desc")
    .first();
  const version = (latest?.version ?? 0) + 1;
  const policyVersionId = await ctx.db.insert("operationsIntelligencePolicyVersions", {
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

export async function publishOperationsIntelligencePolicy(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    draftPolicyId: Id<"operationsIntelligencePolicyVersions">;
    expectedDraftChecksum: string;
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
      code: "OPERATIONS_INTELLIGENCE_POLICY_DRAFT_CHANGED",
      message: "The intelligence-policy draft changed in another session.",
    });
  }
  const normalized = normalizeOperationsIntelligencePolicy(
    operationsIntelligencePolicyFromDocument(draft),
  );
  if (operationsIntelligencePolicyChecksum(normalized) !== draft.checksum) {
    throw new ConvexError({
      code: "INVALID_OPERATIONS_INTELLIGENCE_POLICY",
      message: "The draft checksum does not match its intelligence policy.",
    });
  }
  const previousPolicyId = args.event.publishedOperationsIntelligencePolicyId;
  const previousPolicy = previousPolicyId ? await ctx.db.get(previousPolicyId) : null;
  if (
    previousPolicy &&
    (previousPolicy.eventId !== args.event._id || previousPolicy.status !== "published")
  ) {
    throw new Error("The event's published intelligence policy is invalid.");
  }
  const currentStates = await ctx.db
    .query("operationsIntelligenceAutomationStates")
    .withIndex("by_event", (index) => index.eq("eventId", args.event._id))
    .collect();
  const effectiveStates = currentStates.filter((state) => state.state !== "superseded");
  if (effectiveStates.length > 1) {
    throw new Error("The event has more than one current intelligence automation state.");
  }
  for (const state of effectiveStates) {
    await ctx.db.patch(state._id, {
      state: "superseded",
      updatedAt: args.now,
      version: state.version + 1,
    });
  }
  if (previousPolicy) await ctx.db.patch(previousPolicy._id, { status: "superseded" });
  await ctx.db.patch(draft._id, { status: "published", publishedAt: args.now });
  await ctx.db.insert("operationsIntelligenceAutomationStates", {
    eventId: args.event._id,
    policyVersionId: draft._id,
    state: normalized.enabled ? "active" : "disabled",
    nextEvaluationAt: args.now,
    cycle: 1,
    localBudgetDate: localDateKey(args.now, args.event.timezone),
    briefsStartedToday: 0,
    version: 1,
    updatedAt: args.now,
  });
  await ctx.db.patch(args.event._id, {
    publishedOperationsIntelligencePolicyId: draft._id,
    version: args.event.version + 1,
    updatedAt: args.now,
  });
  return { policyVersionId: draft._id, policyVersion: draft.version };
}
