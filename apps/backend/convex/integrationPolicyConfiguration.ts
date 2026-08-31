import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import {
  configurationDraftResultJson,
  configurationPublicationResultJson,
  storedConfigurationDraftResult,
  storedConfigurationPublicationResult,
} from "./lib/configurationOperationResult";
import { requireEventBySlug } from "./lib/events";
import {
  integrationPolicyChecksum,
  integrationPolicyFromDocument,
  integrationPolicyInput,
  integrationPolicyPublicationIssues,
  normalizeIntegrationPolicy,
  publishIntegrationPolicy,
  saveIntegrationPolicyDraft,
  type IntegrationPolicy,
} from "./lib/integrationPolicy";
import {
  requireCurrentPerson,
  requireEventSubject,
} from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";

const policyView = v.object({
  id: v.id("integrationPolicyVersions"),
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
  policy: integrationPolicyInput,
});

function readPolicy(policy: Doc<"integrationPolicyVersions">) {
  const normalized = normalizeIntegrationPolicy(integrationPolicyFromDocument(policy));
  if (integrationPolicyChecksum(normalized) !== policy.checksum) {
    throw new Error("The integration-policy checksum does not match its content.");
  }
  return {
    id: policy._id,
    version: policy.version,
    status: policy.status,
    checksum: policy.checksum,
    createdAt: policy.createdAt,
    ...(policy.publishedAt !== undefined ? { publishedAt: policy.publishedAt } : {}),
    policy: normalized,
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
      permissionKey: "configuration.integration.read",
      scopeType: "event",
    });
    const publishedId = event.publishedIntegrationPolicyId;
    const published = publishedId ? await ctx.db.get(publishedId) : null;
    if (!published || published.eventId !== event._id || published.status !== "published") {
      throw new Error("The event's published integration policy is invalid.");
    }
    const draft = await ctx.db
      .query("integrationPolicyVersions")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", event._id).eq("status", "draft"),
      )
      .unique();
    const [draftGrants, validateGrants, publishGrants] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.integration.draft.create",
        scopeType: "event",
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.integration.validate",
        scopeType: "event",
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.integration.publish",
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
    draftPolicyId: v.id("integrationPolicyVersions"),
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
      permissionKey: "configuration.integration.validate",
      scopeType: "event",
    });
    const [draft, published] = await Promise.all([
      ctx.db.get(args.draftPolicyId),
      event.publishedIntegrationPolicyId
        ? ctx.db.get(event.publishedIntegrationPolicyId)
        : Promise.resolve(null),
    ]);
    if (!draft || draft.eventId !== event._id || draft.status !== "draft") {
      throw new ConvexError({
        code: "INTEGRATION_POLICY_DRAFT_CHANGED",
        message: "That integration-policy draft is no longer current.",
      });
    }
    if (!published || published.eventId !== event._id || published.status !== "published") {
      throw new Error("The event's published integration policy is invalid.");
    }
    const publishedPolicy = readPolicy(published).policy;
    const normalized = normalizeIntegrationPolicy(integrationPolicyFromDocument(draft));
    const issues = await integrationPolicyPublicationIssues(ctx, {
      eventId: event._id,
      policy: normalized,
    });
    if (integrationPolicyChecksum(normalized) !== draft.checksum) {
      issues.unshift("The draft checksum does not match its integration policy.");
    }
    return {
      valid: issues.length === 0,
      issues,
      changes: describeChanges(publishedPolicy, normalized),
    };
  },
});

function describeChanges(published: IntegrationPolicy, draft: IntegrationPolicy) {
  const changes: string[] = [];
  if (published.policyVersion !== draft.policyVersion) {
    changes.push(`Label the release ${draft.policyVersion}.`);
  }
  if (published.requiredGitHubTopic !== draft.requiredGitHubTopic) {
    changes.push(
      `Require the GitHub topic ${draft.requiredGitHubTopic} and recheck every active repository.`,
    );
  }
  if (
    published.maxActiveGitHubRepositoriesPerTeam !==
    draft.maxActiveGitHubRepositoriesPerTeam
  ) {
    changes.push(
      `Allow up to ${draft.maxActiveGitHubRepositoriesPerTeam} active GitHub repositories per team.`,
    );
  }
  if (published.maxActiveFigmaFilesPerTeam !== draft.maxActiveFigmaFilesPerTeam) {
    changes.push(
      `Allow up to ${draft.maxActiveFigmaFilesPerTeam} active Figma files per team.`,
    );
  }
  if (published.githubFreezeAt !== draft.githubFreezeAt) {
    changes.push(
      draft.githubFreezeAt === undefined
        ? "Remove the GitHub change freeze."
        : "Change the exact GitHub freeze time.",
    );
  }
  if (published.figmaFreezeAt !== draft.figmaFreezeAt) {
    changes.push(
      draft.figmaFreezeAt === undefined
        ? "Remove the Figma change freeze."
        : "Change the exact Figma freeze time.",
    );
  }
  return changes.length > 0 ? changes : ["No integration-policy changes."];
}

export const createDraft = mutation({
  args: {
    eventSlug: v.string(),
    policy: integrationPolicyInput,
    expectedEventVersion: v.number(),
    expectedDraftPolicyId: v.optional(v.id("integrationPolicyVersions")),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    policyVersionId: v.id("integrationPolicyVersions"),
    policyVersion: v.number(),
    checksum: v.string(),
    changed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const policy = normalizeIntegrationPolicy(args.policy);
    const reason = normalizedText(args.reason, "Draft reason", 5, 500);
    const clientOperationId = normalizedText(
      args.clientOperationId,
      "Client operation ID",
      8,
      120,
    );
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
      commandName: "configuration.integration_policy.draft",
      requestFingerprint,
    });
    if (prior) {
      const policyVersionId = ctx.db.normalizeId("integrationPolicyVersions", prior.targetId);
      if (!policyVersionId) throw new Error("The prior integration-policy draft is invalid.");
      const stored = storedConfigurationDraftResult(
        prior.resultJson,
        "integration-policy draft",
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
      permissionKey: "configuration.integration.draft.create",
      scopeType: "event",
    });
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before saving integrations.",
      });
    }
    const now = Date.now();
    const result = await saveIntegrationPolicyDraft(ctx, {
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
      commandName: "configuration.integration_policy.draft",
      requestFingerprint,
      targetType: "integration_policy",
      targetId: result.policyVersionId,
      resultJson: configurationDraftResultJson({
        version: result.policyVersion,
        checksum: result.checksum,
        changed: result.changed,
      }),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.integration.draft.create",
      grantIds,
      scopeType: "event",
      action: "configuration.integration_policy_drafted",
      targetType: "integration_policy",
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
    draftPolicyId: v.id("integrationPolicyVersions"),
    expectedDraftChecksum: v.string(),
    expectedEventVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    policyVersionId: v.id("integrationPolicyVersions"),
    policyVersion: v.number(),
    eventVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const reason = normalizedText(args.reason, "Publication reason", 5, 500);
    const clientOperationId = normalizedText(
      args.clientOperationId,
      "Client operation ID",
      8,
      120,
    );
    const requestFingerprint = operationFingerprint([
      args.draftPolicyId,
      args.expectedDraftChecksum,
      args.expectedEventVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "configuration.integration_policy.publish",
      requestFingerprint,
    });
    if (prior) {
      const policyVersionId = ctx.db.normalizeId("integrationPolicyVersions", prior.targetId);
      if (!policyVersionId) {
        throw new Error("The prior integration-policy publication is invalid.");
      }
      const stored = storedConfigurationPublicationResult(
        prior.resultJson,
        "integration-policy publication",
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
      permissionKey: "configuration.integration.publish",
      scopeType: "event",
    });
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before publishing integrations.",
      });
    }
    const now = Date.now();
    const previousPolicyId = event.publishedIntegrationPolicyId;
    const result = await publishIntegrationPolicy(ctx, {
      event,
      draftPolicyId: args.draftPolicyId,
      expectedDraftChecksum: args.expectedDraftChecksum,
      now,
    });
    const eventVersion = event.version + 1;
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId,
      commandName: "configuration.integration_policy.publish",
      requestFingerprint,
      targetType: "integration_policy",
      targetId: result.policyVersionId,
      resultJson: configurationPublicationResultJson({
        version: result.policyVersion,
        eventVersion,
      }),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.integration.publish",
      grantIds,
      scopeType: "event",
      action: "configuration.integration_policy_published",
      targetType: "integration_policy",
      targetId: result.policyVersionId,
      previousSummary: JSON.stringify({ policyVersionId: previousPolicyId }),
      nextSummary: JSON.stringify({
        policyVersionId: result.policyVersionId,
        policyVersion: result.policyVersion,
        eventVersion,
      }),
      reason,
    });
    if (result.requiredGitHubTopicChanged) {
      await ctx.scheduler.runAfter(0, internal.githubIntegrations.revalidateRequiredTopic, {
        eventId: event._id,
        cursor: null,
      });
    }
    return {
      policyVersionId: result.policyVersionId,
      policyVersion: result.policyVersion,
      eventVersion,
    };
  },
});
