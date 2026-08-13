import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { mutation, query, type QueryCtx } from "./_generated/server";
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
  normalizeOperationsAutonomyPolicy,
  operationsAutonomyPolicyChecksum,
  operationsAutonomyPolicyFromDocument,
  publishOperationsAutonomyPolicy,
  requireValidAutonomyOwner,
  saveOperationsAutonomyPolicyDraft,
} from "./lib/operationsAutonomyPolicy";
import { operationsAutonomyPolicyInput } from "./lib/operationsAutonomyValidators";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { revokeOperationsAutonomyPolicy } from "./lib/operationsAutonomyRevocation";
import { normalizedText } from "./lib/strings";

const policyView = v.object({
  id: v.id("operationsAutonomyPolicyVersions"),
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
  policy: operationsAutonomyPolicyInput,
});

const schedulerView = v.object({
  lifecycle: v.union(
    v.object({
      kind: v.literal("active"),
    }),
    v.object({
      kind: v.literal("disabled"),
      disabledAt: v.number(),
      disabledByPersonId: v.id("people"),
      reason: v.string(),
    }),
  ),
  version: v.number(),
  nextEvaluationAt: v.number(),
  pendingWorkCount: v.number(),
  lastEvaluatedAt: v.optional(v.number()),
  lastRunAt: v.optional(v.number()),
});

const ownerView = v.object({
  eventAccessSubjectId: v.id("eventAccessSubjects"),
  displayName: v.string(),
  email: v.string(),
  canRead: v.boolean(),
  canGenerate: v.boolean(),
});

const ownerPageSize = 20;

async function ownerProjection(
  ctx: QueryCtx,
  eventId: Parameters<typeof requireValidAutonomyOwner>[1],
  eventAccessSubjectId: Parameters<typeof requireValidAutonomyOwner>[2],
) {
  const subject = await ctx.db.get(eventAccessSubjectId);
  if (!subject || subject.eventId !== eventId) {
    throw new Error("The autonomy policy accountable owner is missing or outside its event.");
  }
  const [readGrants, generateGrants] = subject.status === "active"
    ? await Promise.all([
        matchingPermissionGrantIds(ctx, {
          eventId,
          eventAccessSubjectId: subject._id,
          permissionKey: "operations.intelligence.read",
          scopeType: "event",
        }),
        matchingPermissionGrantIds(ctx, {
          eventId,
          eventAccessSubjectId: subject._id,
          permissionKey: "operations.intelligence.generate",
          scopeType: "event",
        }),
      ])
    : [[], []];
  return {
    eventAccessSubjectId: subject._id,
    displayName: subject.displayName,
    email: subject.emailNormalized,
    canRead: readGrants.length > 0,
    canGenerate: generateGrants.length > 0,
  };
}

function readPolicy(policy: Parameters<typeof operationsAutonomyPolicyFromDocument>[0]) {
  return {
    id: policy._id,
    version: policy.version,
    status: policy.status,
    checksum: policy.checksum,
    createdAt: policy.createdAt,
    ...(policy.publishedAt !== undefined ? { publishedAt: policy.publishedAt } : {}),
    policy: operationsAutonomyPolicyFromDocument(policy),
  };
}

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    eventVersion: v.number(),
    publishedPolicy: policyView,
    draftPolicy: v.union(v.null(), policyView),
    scheduler: schedulerView,
    selectedOwner: ownerView,
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
    const [published, draft, draftGrants, validateGrants, publishGrants] = await Promise.all([
      ctx.db
        .query("operationsAutonomyPolicyVersions")
        .withIndex("by_event_status", (index) =>
          index.eq("eventId", event._id).eq("status", "published"),
        )
        .unique(),
      ctx.db
        .query("operationsAutonomyPolicyVersions")
        .withIndex("by_event_status", (index) =>
          index.eq("eventId", event._id).eq("status", "draft"),
        )
        .unique(),
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
    if (!published) throw new Error("The event must have exactly one published autonomy policy.");
    const scheduler = await ctx.db
      .query("operationsAutonomyStates")
      .withIndex("by_policy", (index) => index.eq("policyVersionId", published._id))
      .unique();
    if (!scheduler || scheduler.eventId !== event._id || scheduler.lifecycle.kind === "superseded") {
      throw new Error("The event's autonomy scheduler state is invalid.");
    }
    const selectedPolicy = draft ?? published;
    const selectedOwner = await ownerProjection(
      ctx,
      event._id,
      selectedPolicy.accountableOwnerEventAccessSubjectId,
    );
    return {
      eventVersion: event.version,
      publishedPolicy: readPolicy(published),
      draftPolicy: draft ? readPolicy(draft) : null,
      scheduler: {
        lifecycle: scheduler.lifecycle,
        version: scheduler.version,
        nextEvaluationAt: scheduler.nextEvaluationAt,
        pendingWorkCount: scheduler.pendingWorkCount,
        ...(scheduler.lastEvaluatedAt !== undefined
          ? { lastEvaluatedAt: scheduler.lastEvaluatedAt }
          : {}),
        ...(scheduler.lastRunAt !== undefined ? { lastRunAt: scheduler.lastRunAt } : {}),
      },
      selectedOwner,
      canDraft: draftGrants.length > 0,
      canValidate: validateGrants.length > 0,
      canPublish: publishGrants.length > 0,
    };
  },
});

export const ownerOptionsPage = query({
  args: {
    eventSlug: v.string(),
    search: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(ownerView),
  handler: async (ctx, args) => {
    if (args.paginationOpts.numItems !== ownerPageSize) {
      throw new ConvexError({
        code: "INVALID_PAGE_SIZE",
        message: `Autonomy owner pages contain exactly ${ownerPageSize} event accounts.`,
      });
    }
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const caller = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: caller._id,
      permissionKey: "configuration.intelligence.read",
      scopeType: "event",
    });
    const search = args.search?.trim();
    const page = search
      ? await ctx.db
          .query("eventAccessSubjects")
          .withSearchIndex("search_by_event_status_name", (index) =>
            index
              .search("displayName", search)
              .eq("eventId", event._id)
              .eq("status", "active"),
          )
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("eventAccessSubjects")
          .withIndex("by_event_status_email", (index) =>
            index.eq("eventId", event._id).eq("status", "active"),
          )
          .paginate(args.paginationOpts);
    const projected = await Promise.all(
      page.page.map((subject) => ownerProjection(ctx, event._id, subject._id)),
    );
    return {
      ...page,
      page: projected.filter((owner) => owner.canRead),
    };
  },
});

export const validateDraft = query({
  args: { eventSlug: v.string(), draftPolicyId: v.id("operationsAutonomyPolicyVersions") },
  returns: v.object({ valid: v.boolean(), issues: v.array(v.string()) }),
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
        code: "OPERATIONS_AUTONOMY_POLICY_DRAFT_CHANGED",
        message: "That autonomy-policy draft is no longer current.",
      });
    }
    let issues: string[] = [];
    try {
      const policy = normalizeOperationsAutonomyPolicy(operationsAutonomyPolicyFromDocument(draft));
      await requireValidAutonomyOwner(
        ctx,
        event._id,
        policy.accountableOwnerEventAccessSubjectId,
        policy.mode,
      );
      if (operationsAutonomyPolicyChecksum(policy) !== draft.checksum) {
        issues = ["The draft checksum does not match its autonomy policy."];
      }
    } catch (error) {
      issues = [error instanceof Error ? error.message : "The autonomy policy is invalid."];
    }
    return { valid: issues.length === 0, issues };
  },
});

const draftResult = v.object({
  policyVersionId: v.id("operationsAutonomyPolicyVersions"),
  policyVersion: v.number(),
  checksum: v.string(),
  changed: v.boolean(),
});

export const createDraft = mutation({
  args: {
    eventSlug: v.string(),
    policy: operationsAutonomyPolicyInput,
    expectedEventVersion: v.number(),
    expectedDraftPolicyId: v.optional(v.id("operationsAutonomyPolicyVersions")),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: draftResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.intelligence.draft.create",
      scopeType: "event",
    });
    const policy = normalizeOperationsAutonomyPolicy(args.policy);
    const reason = normalizedText(args.reason, "Draft reason", 5, 500);
    const clientOperationId = normalizedText(args.clientOperationId, "Operation ID", 8, 120);
    const requestFingerprint = operationFingerprint([
      args.expectedEventVersion,
      args.expectedDraftPolicyId ?? null,
      JSON.stringify(policy),
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "configuration.operations_autonomy_policy.draft",
      requestFingerprint,
    });
    if (prior) {
      const id = ctx.db.normalizeId("operationsAutonomyPolicyVersions", prior.targetId);
      const row = id ? await ctx.db.get(id) : null;
      if (!row || (prior.resultJson !== "changed" && prior.resultJson !== "unchanged")) {
        throw new Error("The prior autonomy-policy draft result is invalid.");
      }
      return {
        policyVersionId: row._id,
        policyVersion: row.version,
        checksum: row.checksum,
        changed: prior.resultJson === "changed",
      };
    }
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before saving the autonomy policy.",
      });
    }
    const now = Date.now();
    const result = await saveOperationsAutonomyPolicyDraft(ctx, {
      event,
      actorPersonId: person._id,
      policy,
      ...(args.expectedDraftPolicyId !== undefined
        ? { expectedDraftPolicyId: args.expectedDraftPolicyId }
        : {}),
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "configuration.operations_autonomy_policy.draft",
      requestFingerprint,
      targetType: "operations_autonomy_policy",
      targetId: result.policyVersionId,
      resultJson: result.changed ? "changed" : "unchanged",
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.intelligence.draft.create",
      grantIds,
      scopeType: "event",
      action: "configuration.operations_autonomy_policy_drafted",
      targetType: "operations_autonomy_policy",
      targetId: result.policyVersionId,
      nextSummary: JSON.stringify({
        policyVersion: result.policyVersion,
        checksum: result.checksum,
        enabled: policy.enabled,
        mode: policy.mode,
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
    draftPolicyId: v.id("operationsAutonomyPolicyVersions"),
    expectedDraftChecksum: v.string(),
    expectedEventVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    policyVersionId: v.id("operationsAutonomyPolicyVersions"),
    policyVersion: v.number(),
    eventVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.intelligence.publish",
      scopeType: "event",
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    const reason = normalizedText(args.reason, "Publication reason", 5, 500);
    const clientOperationId = normalizedText(args.clientOperationId, "Operation ID", 8, 120);
    const checksum = normalizedDigest(args.expectedDraftChecksum);
    const requestFingerprint = operationFingerprint([
      args.draftPolicyId,
      checksum,
      args.expectedEventVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "configuration.operations_autonomy_policy.publish",
      requestFingerprint,
    });
    if (prior) {
      const id = ctx.db.normalizeId("operationsAutonomyPolicyVersions", prior.targetId);
      const row = id ? await ctx.db.get(id) : null;
      const eventVersion = Number(prior.resultJson);
      if (!row || !Number.isSafeInteger(eventVersion) || eventVersion < 1) {
        throw new Error("The prior autonomy-policy publication result is invalid.");
      }
      return { policyVersionId: row._id, policyVersion: row.version, eventVersion };
    }
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before publishing the autonomy policy.",
      });
    }
    const now = Date.now();
    const previousPolicy = await ctx.db
      .query("operationsAutonomyPolicyVersions")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", event._id).eq("status", "published"),
      )
      .unique();
    const result = await publishOperationsAutonomyPolicy(ctx, {
      event,
      draftPolicyId: args.draftPolicyId,
      expectedDraftChecksum: checksum,
      actorPersonId: person._id,
      now,
    });
    const eventVersion = event.version + 1;
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "configuration.operations_autonomy_policy.publish",
      requestFingerprint,
      targetType: "operations_autonomy_policy",
      targetId: result.policyVersionId,
      resultJson: String(eventVersion),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.intelligence.publish",
      grantIds,
      scopeType: "event",
      action: "configuration.operations_autonomy_policy_published",
      targetType: "operations_autonomy_policy",
      targetId: result.policyVersionId,
      ...(previousPolicy
        ? {
            previousSummary: JSON.stringify({
              policyVersionId: previousPolicy._id,
              policyVersion: previousPolicy.version,
              checksum: previousPolicy.checksum,
              enabled: previousPolicy.enabled,
              mode: previousPolicy.mode,
              accountableOwnerEventAccessSubjectId:
                previousPolicy.accountableOwnerEventAccessSubjectId,
            }),
          }
        : {}),
      nextSummary: JSON.stringify({
        ...result,
        checksum,
        enabled: (await ctx.db.get(result.policyVersionId))?.enabled,
        mode: (await ctx.db.get(result.policyVersionId))?.mode,
        eventVersion,
      }),
      reason,
    });
    return { ...result, eventVersion };
  },
});

export const disable = mutation({
  args: {
    eventSlug: v.string(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ state: v.literal("disabled"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.intelligence.publish",
      scopeType: "event",
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    const reason = normalizedText(args.reason, "Disable reason", 5, 500);
    const clientOperationId = normalizedText(args.clientOperationId, "Operation ID", 8, 120);
    const requestFingerprint = operationFingerprint([event._id, reason]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "configuration.operations_autonomy.disable",
      requestFingerprint,
    });
    if (prior) {
      const priorStateId = ctx.db.normalizeId("operationsAutonomyStates", prior.targetId);
      const priorState = priorStateId ? await ctx.db.get(priorStateId) : null;
      const priorVersion = Number(prior.resultJson);
      if (!priorState || !Number.isSafeInteger(priorVersion) || priorVersion < 1) {
        throw new Error("The prior autonomy disable result is invalid.");
      }
      return { state: "disabled" as const, version: priorVersion };
    }
    const policy = await ctx.db
      .query("operationsAutonomyPolicyVersions")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", event._id).eq("status", "published"),
      )
      .unique();
    const state = policy
      ? await ctx.db
          .query("operationsAutonomyStates")
          .withIndex("by_policy", (index) => index.eq("policyVersionId", policy._id))
          .unique()
      : null;
    if (!state || state.eventId !== event._id || state.lifecycle.kind === "superseded") {
      throw new Error("The event's autonomy scheduler state is invalid.");
    }
    const now = Date.now();
    const version = state.version + 1;
    if (state.lifecycle.kind === "disabled") {
      await recordOperation(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        clientOperationId,
        commandName: "configuration.operations_autonomy.disable",
        requestFingerprint,
        targetType: "operations_autonomy_state",
        targetId: state._id,
        resultJson: String(state.version),
        createdAt: now,
      });
      return { state: "disabled" as const, version: state.version };
    }
    await revokeOperationsAutonomyPolicy(ctx, {
      eventId: event._id,
      policyVersionId: state.policyVersionId,
      reason: "kill_switch",
      now,
    });
    await ctx.db.patch(state._id, {
      lifecycle: {
        kind: "disabled",
        disabledAt: now,
        disabledByPersonId: person._id,
        reason,
      },
      version,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "configuration.operations_autonomy.disable",
      requestFingerprint,
      targetType: "operations_autonomy_state",
      targetId: state._id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.intelligence.publish",
      grantIds,
      scopeType: "event",
      action: "configuration.operations_autonomy_disabled",
      targetType: "operations_autonomy_state",
      targetId: state._id,
      previousSummary: JSON.stringify({ state: "active", version: state.version }),
      nextSummary: JSON.stringify({ state: "disabled", version }),
      reason,
    });
    return { state: "disabled" as const, version };
  },
});

function normalizedDigest(value: string) {
  const checksum = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(checksum)) {
    throw new ConvexError({
      code: "INVALID_FIELD",
      field: "Expected draft checksum",
      message: "Expected draft checksum must be a SHA-256 digest.",
    });
  }
  return checksum;
}
