import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
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
} from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import {
  describePhaseScheduleChanges,
  loadPhaseScheduleWindows,
  loadPublishedPhaseSchedule,
  phaseScheduleChecksum,
  phaseScheduleInput,
  phaseScheduleIssues,
  phaseSchedulePublicationIssues,
  phaseWindowInput,
  publishPhaseSchedule,
  savePhaseScheduleDraft,
} from "./lib/phaseSchedule";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import { eventPhaseKey } from "./values";

const phaseView = v.object({
  phaseKey: eventPhaseKey,
  displayName: v.string(),
  description: v.string(),
  startsAt: v.number(),
  endsAt: v.number(),
  displayOrder: v.number(),
});

const scheduleView = v.object({
  id: v.id("eventPhaseScheduleVersions"),
  version: v.number(),
  status: v.union(v.literal("draft"), v.literal("published")),
  checksum: v.string(),
  createdAt: v.number(),
  publishedAt: v.optional(v.number()),
  phases: v.array(phaseView),
});

async function readSchedule(
  ctx: QueryCtx,
  schedule: Doc<"eventPhaseScheduleVersions">,
) {
  if (schedule.status !== "draft" && schedule.status !== "published") {
    throw new Error("The current event-phase schedule has an invalid status.");
  }
  const windows = await loadPhaseScheduleWindows(ctx, schedule._id);
  if (windows.some((window) => window.eventId !== schedule.eventId)) {
    throw new Error("An event-phase schedule contains a foreign row.");
  }
  return {
    id: schedule._id,
    version: schedule.version,
    status: schedule.status,
    checksum: schedule.checksum,
    createdAt: schedule.createdAt,
    ...(schedule.publishedAt !== undefined ? { publishedAt: schedule.publishedAt } : {}),
    phases: windows.map(phaseWindowInput),
  };
}

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    eventVersion: v.number(),
    timezone: v.string(),
    publishedSchedule: v.union(v.null(), scheduleView),
    draftSchedule: v.union(v.null(), scheduleView),
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
      permissionKey: "configuration.phase.read",
      scopeType: "event",
    });
    const [published, draft, draftGrantIds, validateGrantIds, publishGrantIds] =
      await Promise.all([
        loadPublishedPhaseSchedule(ctx, event),
        ctx.db
          .query("eventPhaseScheduleVersions")
          .withIndex("by_event_status", (index) =>
            index.eq("eventId", event._id).eq("status", "draft"),
          )
          .unique(),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "configuration.phase.draft.create",
          scopeType: "event",
        }),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "configuration.phase.validate",
          scopeType: "event",
        }),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "configuration.phase.publish",
          scopeType: "event",
        }),
      ]);
    return {
      eventVersion: event.version,
      timezone: event.timezone,
      publishedSchedule: published ? await readSchedule(ctx, published.schedule) : null,
      draftSchedule: draft ? await readSchedule(ctx, draft) : null,
      canDraft: draftGrantIds.length > 0,
      canValidate: validateGrantIds.length > 0,
      canPublish: publishGrantIds.length > 0,
    };
  },
});

export const validateDraft = query({
  args: {
    eventSlug: v.string(),
    draftScheduleId: v.id("eventPhaseScheduleVersions"),
  },
  returns: v.object({
    valid: v.boolean(),
    issues: v.array(v.string()),
    changes: v.array(v.string()),
    evaluatedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.phase.validate",
      scopeType: "event",
    });
    const draft = await ctx.db.get(args.draftScheduleId);
    if (!draft || draft.eventId !== event._id || draft.status !== "draft") {
      throw new ConvexError({
        code: "PHASE_DRAFT_CHANGED",
        message: "That event-phase draft is no longer current.",
      });
    }
    const draftWindows = await loadPhaseScheduleWindows(ctx, draft._id);
    const draftPhases = draftWindows.map(phaseWindowInput);
    const issues = phaseScheduleIssues(draftPhases);
    if (phaseScheduleChecksum(draftPhases) !== draft.checksum) {
      issues.push("The draft checksum does not match its phase rows.");
    }
    const published = await loadPublishedPhaseSchedule(ctx, event);
    const publishedPhases = published
      ? published.windows.map(phaseWindowInput)
      : [];
    const evaluatedAt = Date.now();
    issues.push(
      ...phaseSchedulePublicationIssues(publishedPhases, draftPhases, evaluatedAt),
    );
    return {
      valid: issues.length === 0,
      issues: [...new Set(issues)],
      changes: describePhaseScheduleChanges(publishedPhases, draftPhases),
      evaluatedAt,
    };
  },
});

export const createDraft = mutation({
  args: {
    eventSlug: v.string(),
    phases: v.array(phaseScheduleInput),
    expectedEventVersion: v.number(),
    expectedDraftScheduleId: v.optional(v.id("eventPhaseScheduleVersions")),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    scheduleVersionId: v.id("eventPhaseScheduleVersions"),
    scheduleVersion: v.number(),
    checksum: v.string(),
    changed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.expectedEventVersion,
      args.expectedDraftScheduleId ?? null,
      JSON.stringify(args.phases),
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.phase_schedule.draft",
      requestFingerprint,
    });
    if (prior) {
      const scheduleVersionId = ctx.db.normalizeId(
        "eventPhaseScheduleVersions",
        prior.targetId,
      );
      if (!scheduleVersionId) throw new Error("The prior phase-draft result is invalid.");
      const stored = storedConfigurationDraftResult(prior.resultJson, "phase-draft");
      return {
        scheduleVersionId,
        scheduleVersion: stored.version,
        checksum: stored.checksum,
        changed: stored.changed,
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.phase.draft.create",
      scopeType: "event",
    });
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before saving the phase draft.",
      });
    }
    const reason = normalizedText(args.reason, "Draft reason", 5, 500);
    const now = Date.now();
    const result = await savePhaseScheduleDraft(ctx, {
      event,
      actorPersonId: person._id,
      phases: args.phases,
      ...(args.expectedDraftScheduleId !== undefined
        ? { expectedDraftScheduleId: args.expectedDraftScheduleId }
        : {}),
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.phase_schedule.draft",
      requestFingerprint,
      targetType: "event_phase_schedule",
      targetId: result.scheduleVersionId,
      resultJson: configurationDraftResultJson({
        version: result.scheduleVersion,
        checksum: result.checksum,
        changed: result.changed,
      }),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.phase.draft.create",
      grantIds,
      scopeType: "event",
      action: "configuration.phase_schedule_drafted",
      targetType: "event_phase_schedule",
      targetId: result.scheduleVersionId,
      nextSummary: JSON.stringify({
        scheduleVersion: result.scheduleVersion,
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
    draftScheduleId: v.id("eventPhaseScheduleVersions"),
    expectedDraftChecksum: v.string(),
    expectedEventVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    scheduleVersionId: v.id("eventPhaseScheduleVersions"),
    scheduleVersion: v.number(),
    eventVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.draftScheduleId,
      args.expectedDraftChecksum,
      args.expectedEventVersion,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.phase_schedule.publish",
      requestFingerprint,
    });
    if (prior) {
      const scheduleVersionId = ctx.db.normalizeId(
        "eventPhaseScheduleVersions",
        prior.targetId,
      );
      if (!scheduleVersionId) throw new Error("The prior phase-publication result is invalid.");
      const stored = storedConfigurationPublicationResult(
        prior.resultJson,
        "phase-publication",
      );
      return {
        scheduleVersionId,
        scheduleVersion: stored.version,
        eventVersion: stored.eventVersion,
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.phase.publish",
      scopeType: "event",
    });
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before publishing the phase schedule.",
      });
    }
    const reason = normalizedText(args.reason, "Publication reason", 5, 500);
    const previousScheduleId = event.publishedEventPhaseScheduleId;
    const now = Date.now();
    const result = await publishPhaseSchedule(ctx, {
      event,
      draftScheduleId: args.draftScheduleId,
      expectedDraftChecksum: args.expectedDraftChecksum,
      now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.phase_schedule.publish",
      requestFingerprint,
      targetType: "event_phase_schedule",
      targetId: result.scheduleVersionId,
      resultJson: configurationPublicationResultJson({
        version: result.scheduleVersion,
        eventVersion: event.version + 1,
      }),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.phase.publish",
      grantIds,
      scopeType: "event",
      action: "configuration.phase_schedule_published",
      targetType: "event_phase_schedule",
      targetId: result.scheduleVersionId,
      previousSummary: JSON.stringify({ scheduleVersionId: previousScheduleId }),
      nextSummary: JSON.stringify({
        scheduleVersionId: result.scheduleVersionId,
        scheduleVersion: result.scheduleVersion,
      }),
      reason,
    });
    return { ...result, eventVersion: event.version + 1 };
  },
});
