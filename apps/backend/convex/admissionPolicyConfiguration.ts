import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import {
  admissionConfigurationFromDocuments,
  admissionConfigurationInput,
  loadAdmissionConfigurationVersion,
  loadPublishedAdmissionConfiguration,
  normalizeAdmissionConfiguration,
  publishAdmissionConfiguration,
  saveAdmissionConfigurationDraft,
} from "./lib/admissionPolicy";
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
import { normalizedText } from "./lib/strings";

const releaseView = v.object({
  policyId: v.id("admissionPolicyVersions"),
  modelConfigId: v.union(v.null(), v.id("admissionModelConfigVersions")),
  status: v.union(
    v.literal("draft"),
    v.literal("published"),
    v.literal("superseded"),
    v.literal("retired"),
  ),
  policyChecksum: v.string(),
  modelChecksum: v.union(v.null(), v.string()),
  createdAt: v.number(),
  publishedAt: v.optional(v.number()),
  configuration: admissionConfigurationInput,
});

function readRelease(
  policy: Doc<"admissionPolicyVersions">,
  model: Doc<"admissionModelConfigVersions"> | null,
) {
  return {
    policyId: policy._id,
    modelConfigId: model?._id ?? null,
    status: policy.status,
    policyChecksum: policy.checksum,
    modelChecksum: model?.checksum ?? null,
    createdAt: policy.createdAt,
    ...(policy.publishedAt !== undefined ? { publishedAt: policy.publishedAt } : {}),
    configuration: admissionConfigurationFromDocuments(policy, model),
  };
}

async function configurationPermissions(
  ctx: Parameters<typeof matchingPermissionGrantIds>[0],
  eventId: Doc<"events">["_id"],
  subjectId: Doc<"eventAccessSubjects">["_id"],
) {
  const [draft, validate, publish] = await Promise.all([
    matchingPermissionGrantIds(ctx, {
      eventId,
      eventAccessSubjectId: subjectId,
      permissionKey: "configuration.admission.draft.create",
      scopeType: "event",
    }),
    matchingPermissionGrantIds(ctx, {
      eventId,
      eventAccessSubjectId: subjectId,
      permissionKey: "configuration.admission.validate",
      scopeType: "event",
    }),
    matchingPermissionGrantIds(ctx, {
      eventId,
      eventAccessSubjectId: subjectId,
      permissionKey: "configuration.admission.publish",
      scopeType: "event",
    }),
  ]);
  return {
    canDraft: draft.length > 0,
    canValidate: validate.length > 0,
    canPublish: publish.length > 0,
  };
}

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    eventVersion: v.number(),
    publicationLocked: v.boolean(),
    publishedRelease: releaseView,
    draftRelease: v.union(v.null(), releaseView),
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
      permissionKey: "configuration.admission.read",
      scopeType: "event",
    });
    const [published, draftPolicy, firstApplication, permissions] = await Promise.all([
      loadPublishedAdmissionConfiguration(ctx, event),
      ctx.db
        .query("admissionPolicyVersions")
        .withIndex("by_event_status", (index) =>
          index.eq("eventId", event._id).eq("status", "draft"),
        )
        .unique(),
      ctx.db
        .query("applications")
        .withIndex("by_event_state_submitted", (index) => index.eq("eventId", event._id))
        .first(),
      configurationPermissions(ctx, event._id, subject._id),
    ]);
    const draft = draftPolicy
      ? await loadAdmissionConfigurationVersion(ctx, draftPolicy)
      : null;
    return {
      eventVersion: event.version,
      publicationLocked: firstApplication !== null,
      publishedRelease: readRelease(published.policy, published.model),
      draftRelease: draft ? readRelease(draft.policy, draft.model) : null,
      ...permissions,
    };
  },
});

function describeChanges(
  published: ReturnType<typeof normalizeAdmissionConfiguration>,
  draft: ReturnType<typeof normalizeAdmissionConfiguration>,
) {
  const changes: string[] = [];
  if (published.minimumHumanReviews !== draft.minimumHumanReviews) {
    changes.push(`Require ${draft.minimumHumanReviews} human review${draft.minimumHumanReviews === 1 ? "" : "s"}.`);
  }
  if (published.overallParticipantCapacity !== draft.overallParticipantCapacity) {
    changes.push(`Set participant capacity to ${draft.overallParticipantCapacity}.`);
  }
  if (JSON.stringify(published.criteria) !== JSON.stringify(draft.criteria)) {
    changes.push("Update the published year-adjusted criteria.");
  }
  if (JSON.stringify(published.decisionReasonCodes) !== JSON.stringify(draft.decisionReasonCodes)) {
    changes.push("Update the human decision reasons.");
  }
  if (published.model === null && draft.model !== null) {
    changes.push("Enable structured AI admission recommendations.");
  } else if (published.model !== null && draft.model === null) {
    changes.push("Disable AI admission recommendations; human review remains available.");
  } else if (JSON.stringify(published.model) !== JSON.stringify(draft.model)) {
    changes.push("Update the admission-model release.");
  }
  return changes.length > 0 ? changes : ["No operational admission changes."];
}

export const validateDraft = query({
  args: { eventSlug: v.string(), draftPolicyId: v.id("admissionPolicyVersions") },
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
      permissionKey: "configuration.admission.validate",
      scopeType: "event",
    });
    const draftPolicy = await ctx.db.get(args.draftPolicyId);
    if (!draftPolicy || draftPolicy.eventId !== event._id || draftPolicy.status !== "draft") {
      throw new ConvexError({
        code: "ADMISSION_CONFIGURATION_DRAFT_CHANGED",
        message: "That admission configuration is no longer the current draft.",
      });
    }
    const [draft, published] = await Promise.all([
      loadAdmissionConfigurationVersion(ctx, draftPolicy),
      loadPublishedAdmissionConfiguration(ctx, event),
    ]);
    const normalized = normalizeAdmissionConfiguration(draft.configuration);
    return {
      valid: true,
      issues: [],
      changes: describeChanges(published.configuration, normalized),
    };
  },
});

export const createDraft = mutation({
  args: {
    eventSlug: v.string(),
    configuration: admissionConfigurationInput,
    expectedEventVersion: v.number(),
    expectedDraftPolicyId: v.optional(v.id("admissionPolicyVersions")),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    policyVersionId: v.id("admissionPolicyVersions"),
    modelConfigVersionId: v.union(v.null(), v.id("admissionModelConfigVersions")),
    policyChecksum: v.string(),
    modelChecksum: v.union(v.null(), v.string()),
    changed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.expectedEventVersion,
      args.expectedDraftPolicyId ?? null,
      JSON.stringify(args.configuration),
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.admission.draft",
      requestFingerprint,
    });
    if (prior) {
      const policyVersionId = ctx.db.normalizeId("admissionPolicyVersions", prior.targetId);
      const policy = policyVersionId ? await ctx.db.get(policyVersionId) : null;
      if (!policy) throw new Error("The prior admission draft no longer resolves.");
      const release = await loadAdmissionConfigurationVersion(ctx, policy);
      return {
        policyVersionId: policy._id,
        modelConfigVersionId: release.model?._id ?? null,
        policyChecksum: policy.checksum,
        modelChecksum: release.model?.checksum ?? null,
        changed: false,
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.admission.draft.create",
      scopeType: "event",
    });
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before saving admission policy.",
      });
    }
    const reason = normalizedText(args.reason, "Draft reason", 5, 500);
    const now = Date.now();
    const result = await saveAdmissionConfigurationDraft(ctx, {
      event,
      actorPersonId: person._id,
      configuration: args.configuration,
      ...(args.expectedDraftPolicyId !== undefined
        ? { expectedDraftPolicyId: args.expectedDraftPolicyId }
        : {}),
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.admission.draft",
      requestFingerprint,
      targetType: "admission_policy",
      targetId: result.policyVersionId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.admission.draft.create",
      grantIds,
      scopeType: "event",
      action: "configuration.admission_drafted",
      targetType: "admission_policy",
      targetId: result.policyVersionId,
      nextSummary: JSON.stringify(result),
      reason,
    });
    return result;
  },
});

export const publish = mutation({
  args: {
    eventSlug: v.string(),
    draftPolicyId: v.id("admissionPolicyVersions"),
    expectedPolicyChecksum: v.string(),
    expectedModelConfigId: v.union(v.null(), v.id("admissionModelConfigVersions")),
    expectedModelChecksum: v.union(v.null(), v.string()),
    expectedEventVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    policyVersionId: v.id("admissionPolicyVersions"),
    modelConfigVersionId: v.union(v.null(), v.id("admissionModelConfigVersions")),
    eventVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.draftPolicyId,
      args.expectedPolicyChecksum,
      args.expectedModelConfigId,
      args.expectedModelChecksum,
      args.expectedEventVersion,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.admission.publish",
      requestFingerprint,
    });
    if (prior) {
      const policyVersionId = ctx.db.normalizeId("admissionPolicyVersions", prior.targetId);
      const policy = policyVersionId ? await ctx.db.get(policyVersionId) : null;
      if (!policy) throw new Error("The prior admission publication no longer resolves.");
      const release = await loadAdmissionConfigurationVersion(ctx, policy);
      return {
        policyVersionId: policy._id,
        modelConfigVersionId: release.model?._id ?? null,
        eventVersion: event.version,
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.admission.publish",
      scopeType: "event",
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before publishing admission policy.",
      });
    }
    const reason = normalizedText(args.reason, "Publication reason", 5, 500);
    const now = Date.now();
    const result = await publishAdmissionConfiguration(ctx, {
      event,
      draftPolicyId: args.draftPolicyId,
      expectedPolicyChecksum: args.expectedPolicyChecksum,
      expectedModelConfigId: args.expectedModelConfigId,
      expectedModelChecksum: args.expectedModelChecksum,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.admission.publish",
      requestFingerprint,
      targetType: "admission_policy",
      targetId: result.policyVersionId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.admission.publish",
      grantIds,
      scopeType: "event",
      action: "configuration.admission_published",
      targetType: "admission_policy",
      targetId: result.policyVersionId,
      previousSummary: JSON.stringify({
        policyVersionId: event.publishedAdmissionPolicyId ?? null,
        modelConfigVersionId: event.publishedAdmissionModelConfigId ?? null,
        eventVersion: event.version,
      }),
      nextSummary: JSON.stringify(result),
      reason,
    });
    return result;
  },
});
