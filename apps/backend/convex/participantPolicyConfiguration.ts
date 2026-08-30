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
  requireCurrentPerson,
  requireEventSubject,
  requireFreshAuthSession,
  sensitiveCommandSessionMaxAgeMs,
} from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import {
  loadPublishedParticipantCapacity,
  normalizeParticipantPolicy,
  participantPolicyChecksum,
  participantPolicyFromDocument,
  participantPolicyInput,
  participantPolicyPublicationIssue,
  publishParticipantPolicy,
  saveParticipantPolicyDraft,
} from "./lib/participantPolicy";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";

const policyView = v.object({
  id: v.id("participantPolicyVersions"),
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
  policy: participantPolicyInput,
});

function readPolicy(policy: Doc<"participantPolicyVersions">) {
  return {
    id: policy._id,
    version: policy.version,
    status: policy.status,
    checksum: policy.checksum,
    createdAt: policy.createdAt,
    ...(policy.publishedAt !== undefined ? { publishedAt: policy.publishedAt } : {}),
    policy: participantPolicyFromDocument(policy),
  };
}

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    eventVersion: v.number(),
    applicationDeadlines: v.object({
      externalApplicationsCloseAt: v.number(),
      vitApplicationsCloseAt: v.number(),
    }),
    participantCapacity: v.number(),
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
      permissionKey: "configuration.participant.read",
      scopeType: "event",
    });
    const publishedId = event.publishedParticipantPolicyId;
    const published = publishedId ? await ctx.db.get(publishedId) : null;
    if (!published || published.eventId !== event._id || published.status !== "published") {
      throw new Error("The event's published participant policy is invalid.");
    }
    const draft = await ctx.db
      .query("participantPolicyVersions")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", event._id).eq("status", "draft"),
      )
      .unique();
    const participantCapacity = await loadPublishedParticipantCapacity(ctx, event);
    if (event.externalApplicationsCloseAt === undefined) {
      throw new Error("The external-participant application deadline is not configured.");
    }
    const [draftGrants, validateGrants, publishGrants] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.participant.draft.create",
        scopeType: "event",
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.participant.validate",
        scopeType: "event",
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.participant.publish",
        scopeType: "event",
      }),
    ]);
    return {
      eventVersion: event.version,
      applicationDeadlines: {
        externalApplicationsCloseAt: event.externalApplicationsCloseAt,
        vitApplicationsCloseAt: event.applicationsCloseAt,
      },
      participantCapacity,
      publishedPolicy: readPolicy(published),
      draftPolicy: draft ? readPolicy(draft) : null,
      canDraft: draftGrants.length > 0,
      canValidate: validateGrants.length > 0,
      canPublish: publishGrants.length > 0,
    };
  },
});

export const updateApplicationDeadlines = mutation({
  args: {
    eventSlug: v.string(),
    externalApplicationsCloseAt: v.number(),
    vitApplicationsCloseAt: v.number(),
    expectedEventVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    externalApplicationsCloseAt: v.number(),
    vitApplicationsCloseAt: v.number(),
    eventVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.externalApplicationsCloseAt,
      args.vitApplicationsCloseAt,
      args.expectedEventVersion,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.participant_deadlines.update",
      requestFingerprint,
    });
    if (prior) {
      return {
        externalApplicationsCloseAt: args.externalApplicationsCloseAt,
        vitApplicationsCloseAt: args.vitApplicationsCloseAt,
        eventVersion: storedOperationVersion(prior.resultJson, "application deadlines"),
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.participant.publish",
      scopeType: "event",
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Review the application deadlines again.",
      });
    }
    const now = Date.now();
    if (
      !Number.isSafeInteger(args.externalApplicationsCloseAt) ||
      !Number.isSafeInteger(args.vitApplicationsCloseAt) ||
      args.externalApplicationsCloseAt <= now ||
      args.externalApplicationsCloseAt > args.vitApplicationsCloseAt ||
      args.vitApplicationsCloseAt <= now ||
      (event.startsAt !== undefined && args.vitApplicationsCloseAt > event.startsAt)
    ) {
      throw new ConvexError({
        code: "INVALID_APPLICATION_DEADLINES",
        message: "Both deadlines must be in the future, external must close no later than VIT, and VIT must close before the event starts.",
      });
    }
    if (event.status !== "draft" && event.status !== "registration_open") {
      throw new ConvexError({
        code: "APPLICATION_DEADLINES_LOCKED",
        message: "Application deadlines cannot change after applications close.",
      });
    }
    const reason = normalizedText(args.reason, "Deadline-change reason", 5, 500);
    const eventVersion = event.version + 1;
    await ctx.db.patch(event._id, {
      externalApplicationsCloseAt: args.externalApplicationsCloseAt,
      applicationsCloseAt: args.vitApplicationsCloseAt,
      version: eventVersion,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(
      args.externalApplicationsCloseAt,
      internal.eventLifecycle.markExternalRegistrationClosedAtDeadline,
      {
        eventId: event._id,
        expectedExternalApplicationsCloseAt:
          args.externalApplicationsCloseAt,
      },
    );
    await ctx.scheduler.runAt(
      args.vitApplicationsCloseAt,
      internal.eventLifecycle.closeRegistrationAtDeadline,
      {
        eventId: event._id,
        expectedApplicationsCloseAt: args.vitApplicationsCloseAt,
      },
    );
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.participant_deadlines.update",
      requestFingerprint,
      targetType: "event",
      targetId: event._id,
      resultJson: String(eventVersion),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.participant.publish",
      grantIds,
      scopeType: "event",
      action: "configuration.participant_deadlines_updated",
      targetType: "event",
      targetId: event._id,
      previousSummary: JSON.stringify({
        externalApplicationsCloseAt: event.externalApplicationsCloseAt,
        vitApplicationsCloseAt: event.applicationsCloseAt,
      }),
      nextSummary: JSON.stringify({
        externalApplicationsCloseAt: args.externalApplicationsCloseAt,
        vitApplicationsCloseAt: args.vitApplicationsCloseAt,
      }),
      reason,
    });
    return {
      externalApplicationsCloseAt: args.externalApplicationsCloseAt,
      vitApplicationsCloseAt: args.vitApplicationsCloseAt,
      eventVersion,
    };
  },
});

function describeChanges(
  published: ReturnType<typeof participantPolicyFromDocument>,
  draft: ReturnType<typeof participantPolicyFromDocument>,
) {
  const changes: string[] = [];
  if (
    published.teamMinimumSize !== draft.teamMinimumSize ||
    published.teamMaximumSize !== draft.teamMaximumSize ||
    published.mixedParticipantClassesAllowed !== draft.mixedParticipantClassesAllowed
  ) {
    changes.push("Update team size or mixed-team eligibility.");
  }
  if (
    published.phoneField !== draft.phoneField ||
    published.vitRegistrationNumberField !== draft.vitRegistrationNumberField ||
    published.vitProgrammeField !== draft.vitProgrammeField ||
    published.vitCampusField !== draft.vitCampusField ||
    published.externalCityField !== draft.externalCityField ||
    published.externalCountryField !== draft.externalCountryField ||
    published.vitHostelDetailsField !== draft.vitHostelDetailsField
  ) {
    changes.push("Update class-aware profile fields.");
  }
  if (
    JSON.stringify(published.vitHostelResidenceCatalog) !==
    JSON.stringify(draft.vitHostelResidenceCatalog)
  ) {
    changes.push("Update the VIT residence catalogue.");
  }
  if (
    published.label !== draft.label ||
    published.profileNotice !== draft.profileNotice ||
    published.projectTextNotice !== draft.projectTextNotice ||
    published.privacyNoticeUrl !== draft.privacyNoticeUrl
  ) {
    changes.push("Update the participant notice and privacy link.");
  }
  if (
    published.freshProjectAttestation !== draft.freshProjectAttestation ||
    published.finalSubmissionWarning !== draft.finalSubmissionWarning
  ) {
    changes.push("Update the submission acknowledgement or lock warning.");
  }
  return changes.length > 0 ? changes : ["No participant-facing changes."];
}

export const validateDraft = query({
  args: { eventSlug: v.string(), draftPolicyId: v.id("participantPolicyVersions") },
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
      permissionKey: "configuration.participant.validate",
      scopeType: "event",
    });
    const draft = await ctx.db.get(args.draftPolicyId);
    if (!draft || draft.eventId !== event._id || draft.status !== "draft") {
      throw new ConvexError({
        code: "PARTICIPANT_POLICY_DRAFT_CHANGED",
        message: "That participant-policy draft is no longer current.",
      });
    }
    const publishedId = event.publishedParticipantPolicyId;
    const published = publishedId ? await ctx.db.get(publishedId) : null;
    if (!published || published.eventId !== event._id || published.status !== "published") {
      throw new Error("The event's published participant policy is invalid.");
    }
    const normalized = normalizeParticipantPolicy(participantPolicyFromDocument(draft));
    const issues = participantPolicyChecksum(normalized) === draft.checksum
      ? []
      : ["The draft checksum does not match its participant policy."];
    const publicationIssue = await participantPolicyPublicationIssue(
      ctx,
      event,
      normalized,
    );
    if (publicationIssue) issues.push(publicationIssue);
    return {
      valid: issues.length === 0,
      issues,
      changes: describeChanges(participantPolicyFromDocument(published), normalized),
    };
  },
});

export const createDraft = mutation({
  args: {
    eventSlug: v.string(),
    policy: participantPolicyInput,
    expectedEventVersion: v.number(),
    expectedDraftPolicyId: v.optional(v.id("participantPolicyVersions")),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    policyVersionId: v.id("participantPolicyVersions"),
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
      commandName: "configuration.participant_policy.draft",
      requestFingerprint,
    });
    if (prior) {
      const policyVersionId = ctx.db.normalizeId("participantPolicyVersions", prior.targetId);
      if (!policyVersionId) throw new Error("The prior participant-policy draft is invalid.");
      const stored = storedConfigurationDraftResult(
        prior.resultJson,
        "participant-policy draft",
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
      permissionKey: "configuration.participant.draft.create",
      scopeType: "event",
    });
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before saving the participant policy.",
      });
    }
    const reason = normalizedText(args.reason, "Draft reason", 5, 500);
    const now = Date.now();
    const result = await saveParticipantPolicyDraft(ctx, {
      event,
      actorPersonId: person._id,
      policy: args.policy,
      ...(args.expectedDraftPolicyId !== undefined
        ? { expectedDraftPolicyId: args.expectedDraftPolicyId }
        : {}),
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.participant_policy.draft",
      requestFingerprint,
      targetType: "participant_policy",
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
      permissionKey: "configuration.participant.draft.create",
      grantIds,
      scopeType: "event",
      action: "configuration.participant_policy_drafted",
      targetType: "participant_policy",
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
    draftPolicyId: v.id("participantPolicyVersions"),
    expectedDraftChecksum: v.string(),
    expectedEventVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    policyVersionId: v.id("participantPolicyVersions"),
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
      commandName: "configuration.participant_policy.publish",
      requestFingerprint,
    });
    if (prior) {
      const policyVersionId = ctx.db.normalizeId("participantPolicyVersions", prior.targetId);
      if (!policyVersionId) throw new Error("The prior participant-policy publication is invalid.");
      const stored = storedConfigurationPublicationResult(
        prior.resultJson,
        "participant-policy publication",
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
      permissionKey: "configuration.participant.publish",
      scopeType: "event",
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before publishing the participant policy.",
      });
    }
    const reason = normalizedText(args.reason, "Publication reason", 5, 500);
    const previousPolicyId = event.publishedParticipantPolicyId;
    const now = Date.now();
    const result = await publishParticipantPolicy(ctx, {
      event,
      draftPolicyId: args.draftPolicyId,
      expectedDraftChecksum: args.expectedDraftChecksum,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.participant_policy.publish",
      requestFingerprint,
      targetType: "participant_policy",
      targetId: result.policyVersionId,
      resultJson: configurationPublicationResultJson({
        version: result.policyVersion,
        eventVersion: event.version + 1,
      }),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.participant.publish",
      grantIds,
      scopeType: "event",
      action: "configuration.participant_policy_published",
      targetType: "participant_policy",
      targetId: result.policyVersionId,
      previousSummary: JSON.stringify({ policyVersionId: previousPolicyId }),
      nextSummary: JSON.stringify(result),
      reason,
    });
    return { ...result, eventVersion: event.version + 1 };
  },
});
