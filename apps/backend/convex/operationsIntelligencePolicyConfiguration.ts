import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireFreshAuthSession,
  sensitiveCommandSessionMaxAgeMs,
} from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import {
  normalizeOperationsIntelligencePolicy,
  operationsIntelligencePolicyChecksum,
  operationsIntelligencePolicyFromDocument,
  operationsIntelligencePolicyInput,
  publishOperationsIntelligencePolicy,
  saveOperationsIntelligencePolicyDraft,
  type OperationsIntelligencePolicy,
} from "./lib/operationsIntelligencePolicy";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";

const policyView = v.object({
  id: v.id("operationsIntelligencePolicyVersions"),
  version: v.number(),
  status: v.union(
    v.literal("draft"),
    v.literal("published"),
    v.literal("superseded"),
    v.literal("retired"),
  ),
  checksum: v.string(),
  createdAt: v.number(),
  publishedAt: v.optional(v.number()),
  policy: operationsIntelligencePolicyInput,
});

function readPolicy(
  policy: Parameters<typeof operationsIntelligencePolicyFromDocument>[0],
) {
  return {
    id: policy._id,
    version: policy.version,
    status: policy.status,
    checksum: policy.checksum,
    createdAt: policy.createdAt,
    ...(policy.publishedAt !== undefined ? { publishedAt: policy.publishedAt } : {}),
    policy: operationsIntelligencePolicyFromDocument(policy),
  };
}

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    eventVersion: v.number(),
    publishedPolicy: policyView,
    draftPolicy: v.union(v.null(), policyView),
    automation: v.union(
      v.null(),
      v.object({
        state: v.union(v.literal("active"), v.literal("disabled")),
        nextEvaluationAt: v.number(),
        lastEvaluatedAt: v.optional(v.number()),
        lastTriggerAt: v.optional(v.number()),
        localBudgetDate: v.string(),
        briefsStartedToday: v.number(),
      }),
    ),
    canDraft: v.boolean(),
    canValidate: v.boolean(),
    canPublish: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.intelligence.read",
      scopeType: "event",
    });
    const publishedPolicyId = event.publishedOperationsIntelligencePolicyId;
    const publishedPolicy = publishedPolicyId ? await ctx.db.get(publishedPolicyId) : null;
    if (
      !publishedPolicy ||
      publishedPolicy.eventId !== event._id ||
      publishedPolicy.status !== "published"
    ) {
      throw new Error("The event's published intelligence policy is invalid.");
    }
    const draftPolicy = await ctx.db
      .query("operationsIntelligencePolicyVersions")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", event._id).eq("status", "draft"),
      )
      .unique();
    const automationState = await ctx.db
      .query("operationsIntelligenceAutomationStates")
      .withIndex("by_policy", (index) => index.eq("policyVersionId", publishedPolicy._id))
      .unique();
    const [draftGrantIds, validateGrantIds, publishGrantIds] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.intelligence.draft.create",
        scopeType: "event",
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.intelligence.validate",
        scopeType: "event",
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.intelligence.publish",
        scopeType: "event",
      }),
    ]);
    return {
      eventVersion: event.version,
      publishedPolicy: readPolicy(publishedPolicy),
      draftPolicy: draftPolicy ? readPolicy(draftPolicy) : null,
      automation:
        automationState && automationState.state !== "superseded"
          ? {
              state: automationState.state,
              nextEvaluationAt: automationState.nextEvaluationAt,
              ...(automationState.lastEvaluatedAt !== undefined
                ? { lastEvaluatedAt: automationState.lastEvaluatedAt }
                : {}),
              ...(automationState.lastTriggerAt !== undefined
                ? { lastTriggerAt: automationState.lastTriggerAt }
                : {}),
              localBudgetDate: automationState.localBudgetDate,
              briefsStartedToday: automationState.briefsStartedToday,
            }
          : null,
      canDraft: draftGrantIds.length > 0,
      canValidate: validateGrantIds.length > 0,
      canPublish: publishGrantIds.length > 0,
    };
  },
});

export const validateDraft = query({
  args: {
    eventSlug: v.string(),
    draftPolicyId: v.id("operationsIntelligencePolicyVersions"),
  },
  returns: v.object({
    valid: v.boolean(),
    issues: v.array(v.string()),
    changes: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.intelligence.validate",
      scopeType: "event",
    });
    const draft = await ctx.db.get(args.draftPolicyId);
    if (!draft || draft.eventId !== event._id || draft.status !== "draft") {
      throw new ConvexError({
        code: "OPERATIONS_INTELLIGENCE_POLICY_DRAFT_CHANGED",
        message: "That intelligence-policy draft is no longer current.",
      });
    }
    const publishedId = event.publishedOperationsIntelligencePolicyId;
    const published = publishedId ? await ctx.db.get(publishedId) : null;
    if (!published || published.eventId !== event._id || published.status !== "published") {
      throw new Error("The event's published intelligence policy is invalid.");
    }
    const normalized = normalizeOperationsIntelligencePolicy(
      operationsIntelligencePolicyFromDocument(draft),
    );
    const issues =
      operationsIntelligencePolicyChecksum(normalized) === draft.checksum
        ? []
        : ["The draft checksum does not match its intelligence policy."];
    return {
      valid: issues.length === 0,
      issues,
      changes: describeChanges(
        operationsIntelligencePolicyFromDocument(published),
        normalized,
      ),
    };
  },
});

function describeChanges(
  published: OperationsIntelligencePolicy,
  draft: OperationsIntelligencePolicy,
) {
  const changes: string[] = [];
  if (published.enabled !== draft.enabled) {
    changes.push(draft.enabled ? "Enable proactive briefs." : "Disable proactive briefs.");
  }
  if (
    JSON.stringify(published.triggerSeverities) !== JSON.stringify(draft.triggerSeverities) ||
    JSON.stringify(published.triggerAreas) !== JSON.stringify(draft.triggerAreas)
  ) {
    changes.push("Change which current health signals may trigger a brief.");
  }
  if (
    published.cooldownMinutes !== draft.cooldownMinutes ||
    published.maximumBriefsPerLocalDay !== draft.maximumBriefsPerLocalDay ||
    published.relevanceMinutes !== draft.relevanceMinutes
  ) {
    changes.push("Change the cooldown, daily budget, or relevance window.");
  }
  if (published.accountableOwner !== draft.accountableOwner) {
    changes.push("Change the accountable operations owner.");
  }
  return changes.length > 0 ? changes : ["No automation-policy changes."];
}

export const createDraft = mutation({
  args: {
    eventSlug: v.string(),
    policy: operationsIntelligencePolicyInput,
    expectedEventVersion: v.number(),
    expectedDraftPolicyId: v.optional(v.id("operationsIntelligencePolicyVersions")),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    policyVersionId: v.id("operationsIntelligencePolicyVersions"),
    policyVersion: v.number(),
    checksum: v.string(),
    changed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.expectedEventVersion,
      args.expectedDraftPolicyId ?? null,
      JSON.stringify(args.policy),
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.operations_intelligence_policy.draft",
      requestFingerprint,
    });
    if (prior) {
      const policyVersionId = ctx.db.normalizeId(
        "operationsIntelligencePolicyVersions",
        prior.targetId,
      );
      const policy = policyVersionId ? await ctx.db.get(policyVersionId) : null;
      if (!policy) throw new Error("The prior intelligence-policy draft no longer resolves.");
      return {
        policyVersionId: policy._id,
        policyVersion: policy.version,
        checksum: policy.checksum,
        changed: false,
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.intelligence.draft.create",
      scopeType: "event",
    });
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before saving the intelligence policy.",
      });
    }
    const reason = normalizedText(args.reason, "Draft reason", 5, 500);
    const result = await saveOperationsIntelligencePolicyDraft(ctx, {
      event,
      actorPersonId: person._id,
      policy: args.policy,
      ...(args.expectedDraftPolicyId !== undefined
        ? { expectedDraftPolicyId: args.expectedDraftPolicyId }
        : {}),
      now: Date.now(),
    });
    const now = Date.now();
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.operations_intelligence_policy.draft",
      requestFingerprint,
      targetType: "operations_intelligence_policy",
      targetId: result.policyVersionId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.intelligence.draft.create",
      grantIds,
      scopeType: "event",
      action: "configuration.operations_intelligence_policy_drafted",
      targetType: "operations_intelligence_policy",
      targetId: result.policyVersionId,
      nextSummary: JSON.stringify({
        policyVersion: result.policyVersion,
        checksum: result.checksum,
        changed: result.changed,
      }),
      reason,
    });
    return result;
  },
});

export const publish = mutation({
  args: {
    eventSlug: v.string(),
    draftPolicyId: v.id("operationsIntelligencePolicyVersions"),
    expectedDraftChecksum: v.string(),
    expectedEventVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    policyVersionId: v.id("operationsIntelligencePolicyVersions"),
    policyVersion: v.number(),
    eventVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.draftPolicyId,
      args.expectedDraftChecksum,
      args.expectedEventVersion,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.operations_intelligence_policy.publish",
      requestFingerprint,
    });
    if (prior) {
      const policyVersionId = ctx.db.normalizeId(
        "operationsIntelligencePolicyVersions",
        prior.targetId,
      );
      const policy = policyVersionId ? await ctx.db.get(policyVersionId) : null;
      if (!policy) throw new Error("The prior intelligence-policy publication no longer resolves.");
      return {
        policyVersionId: policy._id,
        policyVersion: policy.version,
        eventVersion: event.version,
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.intelligence.publish",
      scopeType: "event",
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before publishing the intelligence policy.",
      });
    }
    const reason = normalizedText(args.reason, "Publication reason", 5, 500);
    const previousPolicyId = event.publishedOperationsIntelligencePolicyId;
    const result = await publishOperationsIntelligencePolicy(ctx, {
      event,
      draftPolicyId: args.draftPolicyId,
      expectedDraftChecksum: args.expectedDraftChecksum,
      now: Date.now(),
    });
    const now = Date.now();
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.operations_intelligence_policy.publish",
      requestFingerprint,
      targetType: "operations_intelligence_policy",
      targetId: result.policyVersionId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.intelligence.publish",
      grantIds,
      scopeType: "event",
      action: "configuration.operations_intelligence_policy_published",
      targetType: "operations_intelligence_policy",
      targetId: result.policyVersionId,
      previousSummary: JSON.stringify({ policyVersionId: previousPolicyId }),
      nextSummary: JSON.stringify(result),
      reason,
    });
    return { ...result, eventVersion: event.version + 1 };
  },
});
