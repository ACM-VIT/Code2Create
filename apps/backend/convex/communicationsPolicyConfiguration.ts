import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import {
  communicationsPolicyChecksum,
  communicationsPolicyFromDocument,
  communicationsPolicyInput,
  normalizeCommunicationsPolicy,
  publishCommunicationsPolicy,
  saveCommunicationsPolicyDraft,
} from "./lib/communicationsPolicy";
import {
  configurationDraftResultJson,
  configurationPublicationResultJson,
  storedConfigurationDraftResult,
  storedConfigurationPublicationResult,
} from "./lib/configurationOperationResult";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
} from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";

const policyView = v.object({
  id: v.id("communicationsPolicyVersions"),
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
  policy: communicationsPolicyInput,
});

function readPolicy(policy: Doc<"communicationsPolicyVersions">) {
  return {
    id: policy._id,
    version: policy.version,
    status: policy.status,
    checksum: policy.checksum,
    createdAt: policy.createdAt,
    ...(policy.publishedAt !== undefined ? { publishedAt: policy.publishedAt } : {}),
    policy: communicationsPolicyFromDocument(policy),
  };
}

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    eventVersion: v.number(),
    timezone: v.string(),
    publishedPolicy: policyView,
    draftPolicy: v.union(v.null(), policyView),
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
      permissionKey: "configuration.communications.read",
      scopeType: "event",
    });
    const publishedId = event.publishedCommunicationsPolicyId;
    const published = publishedId ? await ctx.db.get(publishedId) : null;
    if (!published || published.eventId !== event._id || published.status !== "published") {
      throw new Error("The event's published communications policy is invalid.");
    }
    const draft = await ctx.db
      .query("communicationsPolicyVersions")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", event._id).eq("status", "draft"),
      )
      .unique();
    const [draftGrants, validateGrants, publishGrants] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.communications.draft.create",
        scopeType: "event",
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.communications.validate",
        scopeType: "event",
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.communications.publish",
        scopeType: "event",
      }),
    ]);
    return {
      eventVersion: event.version,
      timezone: event.timezone,
      publishedPolicy: readPolicy(published),
      draftPolicy: draft ? readPolicy(draft) : null,
      canDraft: draftGrants.length > 0,
      canValidate: validateGrants.length > 0,
      canPublish: publishGrants.length > 0,
    };
  },
});

export const validateDraft = query({
  args: {
    eventSlug: v.string(),
    draftPolicyId: v.id("communicationsPolicyVersions"),
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
      permissionKey: "configuration.communications.validate",
      scopeType: "event",
    });
    const draft = await ctx.db.get(args.draftPolicyId);
    if (!draft || draft.eventId !== event._id || draft.status !== "draft") {
      throw new ConvexError({
        code: "COMMUNICATIONS_POLICY_DRAFT_CHANGED",
        message: "That communications-policy draft is no longer current.",
      });
    }
    const publishedId = event.publishedCommunicationsPolicyId;
    const published = publishedId ? await ctx.db.get(publishedId) : null;
    if (!published || published.eventId !== event._id || published.status !== "published") {
      throw new Error("The event's published communications policy is invalid.");
    }
    const normalized = normalizeCommunicationsPolicy(communicationsPolicyFromDocument(draft));
    const issues: string[] = [];
    if (communicationsPolicyChecksum(normalized) !== draft.checksum) {
      issues.push("The draft checksum does not match its communications policy.");
    }
    if (event.startsAt !== normalized.startsAt || event.endsAt !== normalized.endsAt) {
      issues.push("The draft dates no longer match the event's operational window.");
    }
    return {
      valid: issues.length === 0,
      issues,
      changes: describeChanges(
        communicationsPolicyFromDocument(published),
        normalized,
      ),
    };
  },
});

function describeChanges(
  published: ReturnType<typeof communicationsPolicyFromDocument>,
  draft: ReturnType<typeof communicationsPolicyFromDocument>,
) {
  const changes: string[] = [];
  if (
    published.venueName !== draft.venueName ||
    published.venueAddress !== draft.venueAddress ||
    published.venueMapUrl !== draft.venueMapUrl ||
    published.startsAt !== draft.startsAt ||
    published.endsAt !== draft.endsAt
  ) {
    changes.push("Update accepted-team venue or event dates.");
  }
  if (JSON.stringify(published.nextSteps) !== JSON.stringify(draft.nextSteps)) {
    changes.push("Update the ordered accepted-team next steps.");
  }
  if (
    published.discordUrl !== draft.discordUrl ||
    published.discordLabel !== draft.discordLabel
  ) {
    changes.push("Update the accepted-team Discord destination.");
  }
  if (
    published.notificationSubject !== draft.notificationSubject ||
    published.notificationIntro !== draft.notificationIntro
  ) {
    changes.push("Update the generic verified-email notification wording.");
  }
  return changes.length > 0 ? changes : ["No participant-facing changes."];
}

export const createDraft = mutation({
  args: {
    eventSlug: v.string(),
    policy: communicationsPolicyInput,
    expectedEventVersion: v.number(),
    expectedDraftPolicyId: v.optional(v.id("communicationsPolicyVersions")),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    policyVersionId: v.id("communicationsPolicyVersions"),
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
      commandName: "configuration.communications_policy.draft",
      requestFingerprint,
    });
    if (prior) {
      const policyVersionId = ctx.db.normalizeId("communicationsPolicyVersions", prior.targetId);
      if (!policyVersionId) throw new Error("The prior communications-policy draft is invalid.");
      const stored = storedConfigurationDraftResult(
        prior.resultJson,
        "communications-policy draft",
      );
      return {
        policyVersionId,
        policyVersion: stored.version,
        checksum: stored.checksum,
        changed: stored.changed,
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.communications.draft.create",
      scopeType: "event",
    });
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before saving communications.",
      });
    }
    const reason = normalizedText(args.reason, "Draft reason", 5, 500);
    const result = await saveCommunicationsPolicyDraft(ctx, {
      event,
      actorPersonId: person._id,
      policy: args.policy,
      ...(args.expectedDraftPolicyId !== undefined
        ? { expectedDraftPolicyId: args.expectedDraftPolicyId }
        : {}),
      now: Date.now(),
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.communications_policy.draft",
      requestFingerprint,
      targetType: "communications_policy",
      targetId: result.policyVersionId,
      resultJson: configurationDraftResultJson({
        version: result.policyVersion,
        checksum: result.checksum,
        changed: result.changed,
      }),
      createdAt: Date.now(),
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.communications.draft.create",
      grantIds,
      scopeType: "event",
      action: "configuration.communications_policy_drafted",
      targetType: "communications_policy",
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
    draftPolicyId: v.id("communicationsPolicyVersions"),
    expectedDraftChecksum: v.string(),
    expectedEventVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    policyVersionId: v.id("communicationsPolicyVersions"),
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
      commandName: "configuration.communications_policy.publish",
      requestFingerprint,
    });
    if (prior) {
      const policyVersionId = ctx.db.normalizeId("communicationsPolicyVersions", prior.targetId);
      if (!policyVersionId) throw new Error("The prior communications-policy publication is invalid.");
      const stored = storedConfigurationPublicationResult(
        prior.resultJson,
        "communications-policy publication",
      );
      return {
        policyVersionId,
        policyVersion: stored.version,
        eventVersion: stored.eventVersion,
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.communications.publish",
      scopeType: "event",
    });
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before publishing communications.",
      });
    }
    const reason = normalizedText(args.reason, "Publication reason", 5, 500);
    const previousPolicyId = event.publishedCommunicationsPolicyId;
    const result = await publishCommunicationsPolicy(ctx, {
      event,
      draftPolicyId: args.draftPolicyId,
      expectedDraftChecksum: args.expectedDraftChecksum,
      now: Date.now(),
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.communications_policy.publish",
      requestFingerprint,
      targetType: "communications_policy",
      targetId: result.policyVersionId,
      resultJson: configurationPublicationResultJson({
        version: result.policyVersion,
        eventVersion: event.version + 1,
      }),
      createdAt: Date.now(),
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.communications.publish",
      grantIds,
      scopeType: "event",
      action: "configuration.communications_policy_published",
      targetType: "communications_policy",
      targetId: result.policyVersionId,
      previousSummary: JSON.stringify({ policyVersionId: previousPolicyId }),
      nextSummary: JSON.stringify(result),
      reason,
    });
    return { ...result, eventVersion: event.version + 1 };
  },
});
