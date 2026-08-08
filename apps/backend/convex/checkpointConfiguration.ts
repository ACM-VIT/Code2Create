import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
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
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import {
  loadProjectCheckpointDefinitions,
  loadPublishedProjectCheckpointPlan,
  normalizeProjectCheckpointPlan,
  projectCheckpointDefinitionFromRow,
  projectCheckpointDefinitionInput,
  projectCheckpointPlanChecksum,
  projectCheckpointPlanIssues,
  publishProjectCheckpointPlan,
  saveProjectCheckpointPlanDraft,
} from "./lib/projectCheckpointPlan";
import { normalizedText } from "./lib/strings";
import { eventPhaseKey, projectCheckpointKey } from "./values";

const definitionView = v.object({
  checkpointKey: projectCheckpointKey,
  phaseKey: eventPhaseKey,
  displayName: v.string(),
  prompt: v.string(),
  followUpQuestion: v.string(),
  graceMinutes: v.number(),
  displayOrder: v.number(),
});

const planView = v.object({
  id: v.id("projectCheckpointPlanVersions"),
  version: v.number(),
  status: v.union(v.literal("draft"), v.literal("published")),
  checksum: v.string(),
  createdAt: v.number(),
  publishedAt: v.optional(v.number()),
  definitions: v.array(definitionView),
});

async function readPlan(ctx: QueryCtx, plan: Doc<"projectCheckpointPlanVersions">) {
  if (plan.status !== "draft" && plan.status !== "published") {
    throw new Error("The current checkpoint plan has an invalid status.");
  }
  const rows = await loadProjectCheckpointDefinitions(ctx, plan._id);
  if (rows.some((row) => row.eventId !== plan.eventId)) {
    throw new Error("A checkpoint plan contains a foreign definition.");
  }
  return {
    id: plan._id,
    version: plan.version,
    status: plan.status,
    checksum: plan.checksum,
    createdAt: plan.createdAt,
    ...(plan.publishedAt !== undefined ? { publishedAt: plan.publishedAt } : {}),
    definitions: rows.map(projectCheckpointDefinitionFromRow),
  };
}

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    eventVersion: v.number(),
    hasPublishedPhaseSchedule: v.boolean(),
    publishedPlan: v.union(v.null(), planView),
    draftPlan: v.union(v.null(), planView),
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
      permissionKey: "configuration.checkpoint.read",
      scopeType: "event",
    });
    const [published, draft, draftGrantIds, validateGrantIds, publishGrantIds] =
      await Promise.all([
        loadPublishedProjectCheckpointPlan(ctx, event),
        ctx.db
          .query("projectCheckpointPlanVersions")
          .withIndex("by_event_status", (index) =>
            index.eq("eventId", event._id).eq("status", "draft"),
          )
          .unique(),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "configuration.checkpoint.draft.create",
          scopeType: "event",
        }),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "configuration.checkpoint.validate",
          scopeType: "event",
        }),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "configuration.checkpoint.publish",
          scopeType: "event",
        }),
      ]);
    return {
      eventVersion: event.version,
      hasPublishedPhaseSchedule: event.publishedEventPhaseScheduleId !== undefined,
      publishedPlan: published ? await readPlan(ctx, published.plan) : null,
      draftPlan: draft ? await readPlan(ctx, draft) : null,
      canDraft: draftGrantIds.length > 0,
      canValidate: validateGrantIds.length > 0,
      canPublish: publishGrantIds.length > 0,
    };
  },
});

export const validateDraft = query({
  args: {
    eventSlug: v.string(),
    draftPlanId: v.id("projectCheckpointPlanVersions"),
  },
  returns: v.object({ valid: v.boolean(), issues: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.checkpoint.validate",
      scopeType: "event",
    });
    const draft = await ctx.db.get(args.draftPlanId);
    if (!draft || draft.eventId !== event._id || draft.status !== "draft") {
      throw new ConvexError({
        code: "CHECKPOINT_PLAN_DRAFT_CHANGED",
        message: "That checkpoint draft is no longer current.",
      });
    }
    const rows = await loadProjectCheckpointDefinitions(ctx, draft._id);
    const definitions = rows.map(projectCheckpointDefinitionFromRow);
    const issues = projectCheckpointPlanIssues(definitions);
    if (projectCheckpointPlanChecksum(definitions) !== draft.checksum) {
      issues.push("The draft checksum does not match its checkpoint definitions.");
    }
    if (!event.publishedEventPhaseScheduleId) {
      issues.push("Publish the event-phase schedule before publishing checkpoints.");
    }
    return { valid: issues.length === 0, issues: [...new Set(issues)] };
  },
});

export const createDraft = mutation({
  args: {
    eventSlug: v.string(),
    definitions: v.array(projectCheckpointDefinitionInput),
    expectedEventVersion: v.number(),
    expectedDraftPlanId: v.optional(v.id("projectCheckpointPlanVersions")),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    planVersionId: v.id("projectCheckpointPlanVersions"),
    planVersion: v.number(),
    checksum: v.string(),
    changed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const normalizedDefinitions = normalizeProjectCheckpointPlan(args.definitions);
    const requestFingerprint = operationFingerprint([
      args.expectedEventVersion,
      args.expectedDraftPlanId ?? null,
      JSON.stringify(normalizedDefinitions),
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.checkpoint_plan.draft",
      requestFingerprint,
    });
    if (prior) {
      const planVersionId = ctx.db.normalizeId(
        "projectCheckpointPlanVersions",
        prior.targetId,
      );
      if (!planVersionId) throw new Error("The prior checkpoint-draft result is invalid.");
      const plan = await ctx.db.get(planVersionId);
      if (!plan) throw new Error("The prior checkpoint draft no longer resolves.");
      return {
        planVersionId,
        planVersion: plan.version,
        checksum: plan.checksum,
        changed: false,
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.checkpoint.draft.create",
      scopeType: "event",
    });
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before saving the checkpoint draft.",
      });
    }
    const reason = normalizedText(args.reason, "Draft reason", 5, 500);
    const now = Date.now();
    const result = await saveProjectCheckpointPlanDraft(ctx, {
      event,
      actorPersonId: person._id,
      definitions: normalizedDefinitions,
      ...(args.expectedDraftPlanId !== undefined
        ? { expectedDraftPlanId: args.expectedDraftPlanId }
        : {}),
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.checkpoint_plan.draft",
      requestFingerprint,
      targetType: "project_checkpoint_plan",
      targetId: result.planVersionId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.checkpoint.draft.create",
      grantIds,
      scopeType: "event",
      action: "configuration.checkpoint_plan_drafted",
      targetType: "project_checkpoint_plan",
      targetId: result.planVersionId,
      nextSummary: JSON.stringify({
        planVersion: result.planVersion,
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
    draftPlanId: v.id("projectCheckpointPlanVersions"),
    expectedDraftChecksum: v.string(),
    expectedEventVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    planVersionId: v.id("projectCheckpointPlanVersions"),
    planVersion: v.number(),
    eventVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.draftPlanId,
      args.expectedDraftChecksum,
      args.expectedEventVersion,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.checkpoint_plan.publish",
      requestFingerprint,
    });
    if (prior) {
      const planVersionId = ctx.db.normalizeId(
        "projectCheckpointPlanVersions",
        prior.targetId,
      );
      if (!planVersionId) throw new Error("The prior checkpoint publication is invalid.");
      const plan = await ctx.db.get(planVersionId);
      if (!plan) throw new Error("The prior published checkpoint plan no longer resolves.");
      return { planVersionId, planVersion: plan.version, eventVersion: event.version };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.checkpoint.publish",
      scopeType: "event",
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before publishing checkpoints.",
      });
    }
    const reason = normalizedText(args.reason, "Publication reason", 5, 500);
    const previousPlanId = event.publishedProjectCheckpointPlanId;
    const now = Date.now();
    const result = await publishProjectCheckpointPlan(ctx, {
      event,
      draftPlanId: args.draftPlanId,
      expectedDraftChecksum: args.expectedDraftChecksum,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.checkpoint_plan.publish",
      requestFingerprint,
      targetType: "project_checkpoint_plan",
      targetId: result.planVersionId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.checkpoint.publish",
      grantIds,
      scopeType: "event",
      action: "configuration.checkpoint_plan_published",
      targetType: "project_checkpoint_plan",
      targetId: result.planVersionId,
      previousSummary: JSON.stringify({ planVersionId: previousPlanId }),
      nextSummary: JSON.stringify(result),
      reason,
    });
    return { ...result, eventVersion: event.version + 1 };
  },
});
