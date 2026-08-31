import { ConvexError, v } from "convex/values";
import { z } from "zod";

import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
} from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import { appendIncidentReadFactById } from "./lib/operationsAutonomyReadFacts/incidentReadiness";

const severity = v.union(
  v.literal("service_disruption"),
  v.literal("major"),
  v.literal("critical"),
);

const affectedService = v.union(
  v.literal("attendance_backend"),
  v.literal("review_backend"),
);

const incidentView = v.object({
  id: v.id("incidents"),
  title: v.string(),
  summary: v.string(),
  severity,
  state: v.union(v.literal("open"), v.literal("monitoring"), v.literal("resolved")),
  manualModeState: v.union(
    v.literal("not_requested"),
    v.literal("pending"),
    v.literal("approved"),
    v.literal("closed"),
  ),
  manualModeApprovalCount: v.number(),
  openedAt: v.number(),
  resolvedAt: v.optional(v.number()),
  version: v.number(),
  canApproveManualMode: v.boolean(),
  canResolve: v.boolean(),
  approvals: v.array(
    v.object({
      personId: v.id("people"),
      displayName: v.string(),
      approvedAt: v.number(),
    }),
  ),
});

type ActiveIncidentView = {
  id: Id<"incidents">;
  title: string;
  summary: string;
  severity: "service_disruption" | "major" | "critical";
  affectedService: "attendance_backend" | "review_backend";
  state: "open" | "monitoring";
  manualModeState: "not_requested" | "pending" | "approved" | "closed";
  openedAt: number;
  version: number;
};

const maximumActiveIncidentsPerEvent = 20;

const manualApprovalOperationResult = z
  .object({
    version: z.number().int().positive(),
    approvalCount: z.number().int().min(1).max(2),
  })
  .strict();

function storedManualApprovalResult(resultJson: string | undefined) {
  const parsed = resultJson
    ? manualApprovalOperationResult.safeParse(JSON.parse(resultJson))
    : null;
  if (!parsed?.success) throw new Error("The stored manual-mode approval is invalid.");
  return parsed.data;
}

async function visibleActiveIncidents(
  ctx: QueryCtx,
  eventId: Id<"events">,
  eventAccessSubjectId: Id<"eventAccessSubjects">,
) {
  const [open, monitoring, eventGrantIds] = await Promise.all([
    ctx.db
      .query("incidents")
      .withIndex("by_event_state_opened", (index) =>
        index.eq("eventId", eventId).eq("state", "open"),
      )
      .order("desc")
      .take(maximumActiveIncidentsPerEvent + 1),
    ctx.db
      .query("incidents")
      .withIndex("by_event_state_opened", (index) =>
        index.eq("eventId", eventId).eq("state", "monitoring"),
      )
      .order("desc")
      .take(maximumActiveIncidentsPerEvent + 1),
    matchingPermissionGrantIds(ctx, {
      eventId,
      eventAccessSubjectId,
      permissionKey: "incident.read",
      scopeType: "event",
    }),
  ]);
  const candidates = [...open, ...monitoring];
  if (candidates.length > maximumActiveIncidentsPerEvent) {
    throw new Error(
      `An event cannot have more than ${maximumActiveIncidentsPerEvent} active incidents.`,
    );
  }
  const visible =
    eventGrantIds.length > 0
      ? candidates
      : (
          await Promise.all(
            candidates.map(async (incident) => {
              const grantIds = await matchingPermissionGrantIds(ctx, {
                eventId,
                eventAccessSubjectId,
                permissionKey: "incident.read",
                scopeType: "incident",
                scopeId: incident._id,
              });
              return grantIds.length > 0 ? incident : null;
            }),
          )
        ).filter((incident) => incident !== null);
  return visible.sort((left, right) => right.openedAt - left.openedAt);
}

export const active = query({
  args: { eventSlug: v.string() },
  returns: v.array(
    v.object({
      id: v.id("incidents"),
      title: v.string(),
      summary: v.string(),
      severity,
      affectedService,
      state: v.union(v.literal("open"), v.literal("monitoring")),
      manualModeState: v.union(
        v.literal("not_requested"),
        v.literal("pending"),
        v.literal("approved"),
        v.literal("closed"),
      ),
      openedAt: v.number(),
      version: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const incidents = await visibleActiveIncidents(ctx, event._id, subject._id);
    const visible: ActiveIncidentView[] = [];
    for (const incident of incidents) {
      if (incident.state === "open" || incident.state === "monitoring") {
        visible.push({
          id: incident._id,
          title: incident.title,
          summary: incident.summary,
          severity: incident.severity,
          affectedService: incident.affectedService,
          state: incident.state,
          manualModeState: incident.manualModeState,
          openedAt: incident.openedAt,
          version: incident.version,
        });
      }
    }
    return visible;
  },
});

export const activeSummary = query({
  args: { eventSlug: v.string() },
  returns: v.object({ liveCount: v.number(), pendingManualModeCount: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const incidents = await visibleActiveIncidents(ctx, event._id, subject._id);
    return {
      liveCount: incidents.length,
      pendingManualModeCount: incidents.filter(
        (incident) => incident.manualModeState === "pending",
      ).length,
    };
  },
});

export const forService = query({
  args: { eventSlug: v.string(), affectedService },
  returns: v.object({
    currentPersonId: v.id("people"),
    canCreate: v.boolean(),
    incidents: v.array(incidentView),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const createGrants = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "incident.create",
      scopeType: "event",
    });
    const candidates = await ctx.db
      .query("incidents")
      .withIndex("by_event_service_opened", (index) =>
        index
          .eq("eventId", event._id)
          .eq("affectedService", args.affectedService),
      )
      .order("desc")
      .take(20);
    const visible = [];
    for (const incident of candidates) {
      const [readGrants, approveGrants, resolveGrants] = await Promise.all([
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "incident.read",
          scopeType: "incident",
          scopeId: incident._id,
        }),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "incident.manual_mode.approve",
          scopeType: "incident",
          scopeId: incident._id,
        }),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: subject._id,
          permissionKey: "incident.resolve",
          scopeType: "incident",
          scopeId: incident._id,
        }),
      ]);
      if (readGrants.length === 0) continue;
      const approvals = await ctx.db
        .query("incidentManualModeApprovals")
        .withIndex("by_incident_time", (index) => index.eq("incidentId", incident._id))
        .collect();
      const approvalViews = [];
      for (const approval of approvals) {
        const approver = await ctx.db.get(approval.approvedByPersonId);
        approvalViews.push({
          personId: approval.approvedByPersonId,
          displayName: approver?.displayName ?? "Event staff",
          approvedAt: approval.approvedAt,
        });
      }
      visible.push({
        id: incident._id,
        title: incident.title,
        summary: incident.summary,
        severity: incident.severity,
        state: incident.state,
        manualModeState: incident.manualModeState,
        manualModeApprovalCount: incident.manualModeApprovalCount,
        openedAt: incident.openedAt,
        ...(incident.resolvedAt !== undefined ? { resolvedAt: incident.resolvedAt } : {}),
        version: incident.version,
        canApproveManualMode:
          approveGrants.length > 0 &&
          incident.state !== "resolved" &&
          incident.manualModeState !== "approved" &&
          !approvals.some((approval) => approval.approvedByPersonId === person._id),
        canResolve: resolveGrants.length > 0 && incident.state !== "resolved",
        approvals: approvalViews,
      });
    }
    return {
      currentPersonId: person._id,
      canCreate: createGrants.length > 0,
      incidents: visible,
    };
  },
});

export const create = mutation({
  args: {
    eventSlug: v.string(),
    title: v.string(),
    summary: v.string(),
    severity,
    affectedService,
    clientOperationId: v.string(),
  },
  returns: v.object({ id: v.id("incidents"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const title = normalizedText(args.title, "Incident title", 3, 100);
    const summary = normalizedText(args.summary, "Incident summary", 10, 500);
    const requestFingerprint = operationFingerprint([
      title,
      summary,
      args.severity,
      args.affectedService,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "incident.create",
      requestFingerprint,
    });
    if (prior) {
      const incidentId = ctx.db.normalizeId("incidents", prior.targetId);
      if (!incidentId) throw new Error("The stored incident creation is invalid.");
      return {
        id: incidentId,
        version: storedOperationVersion(prior.resultJson, "incident"),
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "incident.create",
      scopeType: "event",
    });
    const activeIncidents = (
      await Promise.all(
        (["open", "monitoring"] as const).map((state) =>
          ctx.db
            .query("incidents")
            .withIndex("by_event_state_opened", (index) =>
              index.eq("eventId", event._id).eq("state", state),
            )
            .take(maximumActiveIncidentsPerEvent + 1),
        ),
      )
    ).flat();
    if (activeIncidents.length >= maximumActiveIncidentsPerEvent) {
      throw new ConvexError({
        code: "INCIDENT_LIMIT_REACHED",
        message: `Resolve an active incident before opening more than ${maximumActiveIncidentsPerEvent}.`,
      });
    }
    const now = Date.now();
    const incidentId = await ctx.db.insert("incidents", {
      eventId: event._id,
      title,
      summary,
      severity: args.severity,
      affectedService: args.affectedService,
      state: "open",
      manualModeState: "not_requested",
      manualModeApprovalCount: 0,
      openedByPersonId: person._id,
      openedAt: now,
      version: 1,
      updatedAt: now,
    });
    await appendIncidentReadFactById(ctx, incidentId, now);
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "incident.create",
      requestFingerprint,
      targetType: "incident",
      targetId: incidentId,
      resultJson: "1",
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "incident.create",
      grantIds,
      scopeType: "event",
      action: "incident.opened",
      targetType: "incident",
      targetId: incidentId,
      nextSummary: JSON.stringify({
        severity: args.severity,
        affectedService: args.affectedService,
      }),
      reason: summary,
    });
    return { id: incidentId, version: 1 };
  },
});

export const approveManualMode = mutation({
  args: {
    eventSlug: v.string(),
    incidentId: v.id("incidents"),
    expectedIncidentVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ id: v.id("incidents"), version: v.number(), approvalCount: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const reason = normalizedText(args.reason, "Approval reason", 5, 300);
    const requestFingerprint = operationFingerprint([
      args.incidentId,
      args.expectedIncidentVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "incident.manual_mode.approve",
      requestFingerprint,
    });
    if (prior) {
      const incidentId = ctx.db.normalizeId("incidents", prior.targetId);
      if (!incidentId) throw new Error("The stored manual-mode approval is invalid.");
      return {
        id: incidentId,
        ...storedManualApprovalResult(prior.resultJson),
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const incident = await ctx.db.get(args.incidentId);
    if (!incident || incident.eventId !== event._id) {
      throw new ConvexError({ code: "INCIDENT_NOT_FOUND", message: "Incident not found." });
    }
    if (incident.version !== args.expectedIncidentVersion) {
      throw new ConvexError({ code: "INCIDENT_CHANGED", message: "The incident changed. Refresh and try again." });
    }
    if (incident.state === "resolved" || incident.manualModeState === "closed") {
      throw new ConvexError({ code: "INCIDENT_CLOSED", message: "Manual mode is closed for this incident." });
    }
    if (incident.manualModeState === "approved") {
      throw new ConvexError({ code: "MANUAL_MODE_APPROVED", message: "Manual mode already has both approvals." });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "incident.manual_mode.approve",
      scopeType: "incident",
      scopeId: incident._id,
    });
    const existingApproval = await ctx.db
      .query("incidentManualModeApprovals")
      .withIndex("by_incident_person", (index) =>
        index.eq("incidentId", incident._id).eq("approvedByPersonId", person._id),
      )
      .unique();
    if (existingApproval) {
      throw new ConvexError({
        code: "SECOND_APPROVER_REQUIRED",
        message: "A different authorized person must provide the second approval.",
      });
    }
    const approvals = await ctx.db
      .query("incidentManualModeApprovals")
      .withIndex("by_incident_time", (index) => index.eq("incidentId", incident._id))
      .collect();
    if (approvals.length >= 2 || approvals.length !== incident.manualModeApprovalCount) {
      throw new Error("Manual-mode approval count is inconsistent.");
    }
    const now = Date.now();
    await ctx.db.insert("incidentManualModeApprovals", {
      eventId: event._id,
      incidentId: incident._id,
      approvedByPersonId: person._id,
      incidentVersion: incident.version,
      reason,
      approvedAt: now,
    });
    const approvalCount = approvals.length + 1;
    const version = incident.version + 1;
    await ctx.db.patch(incident._id, {
      manualModeState: approvalCount === 2 ? "approved" : "pending",
      manualModeApprovalCount: approvalCount,
      version,
      updatedAt: now,
    });
    await appendIncidentReadFactById(ctx, incident._id, now);
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "incident.manual_mode.approve",
      requestFingerprint,
      targetType: "incident",
      targetId: incident._id,
      resultJson: JSON.stringify({ version, approvalCount }),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "incident.manual_mode.approve",
      grantIds,
      scopeType: "incident",
      scopeId: incident._id,
      action: "incident.manual_mode_approved",
      targetType: "incident",
      targetId: incident._id,
      previousSummary: JSON.stringify({
        manualModeState: incident.manualModeState,
        approvalCount: incident.manualModeApprovalCount,
        version: incident.version,
      }),
      nextSummary: JSON.stringify({
        manualModeState: approvalCount === 2 ? "approved" : "pending",
        approvalCount,
        version,
      }),
      reason,
    });
    return { id: incident._id, version, approvalCount };
  },
});

export const resolve = mutation({
  args: {
    eventSlug: v.string(),
    incidentId: v.id("incidents"),
    expectedIncidentVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ id: v.id("incidents"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const reason = normalizedText(args.reason, "Resolution reason", 5, 300);
    const requestFingerprint = operationFingerprint([
      args.incidentId,
      args.expectedIncidentVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "incident.resolve",
      requestFingerprint,
    });
    if (prior) {
      const incidentId = ctx.db.normalizeId("incidents", prior.targetId);
      if (!incidentId) throw new Error("The stored incident resolution is invalid.");
      return {
        id: incidentId,
        version: storedOperationVersion(prior.resultJson, "incident"),
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const incident = await ctx.db.get(args.incidentId);
    if (!incident || incident.eventId !== event._id) {
      throw new ConvexError({ code: "INCIDENT_NOT_FOUND", message: "Incident not found." });
    }
    if (incident.version !== args.expectedIncidentVersion) {
      throw new ConvexError({ code: "INCIDENT_CHANGED", message: "The incident changed. Refresh and try again." });
    }
    if (incident.state === "resolved") {
      throw new ConvexError({ code: "INCIDENT_RESOLVED", message: "This incident is already resolved." });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "incident.resolve",
      scopeType: "incident",
      scopeId: incident._id,
    });
    const [draftSheet, submittedSheet, draftReview, submittedReview, activeRoundPause] = await Promise.all([
      ctx.db
        .query("attendanceManualSheets")
        .withIndex("by_incident_status_created", (index) =>
          index.eq("incidentId", incident._id).eq("status", "draft"),
        )
        .first(),
      ctx.db
        .query("attendanceManualSheets")
        .withIndex("by_incident_status_created", (index) =>
          index.eq("incidentId", incident._id).eq("status", "submitted"),
        )
        .first(),
      ctx.db
        .query("manualReviewRecords")
        .withIndex("by_incident_status_created", (index) =>
          index.eq("incidentId", incident._id).eq("status", "draft"),
        )
        .first(),
      ctx.db
        .query("manualReviewRecords")
        .withIndex("by_incident_status_created", (index) =>
          index.eq("incidentId", incident._id).eq("status", "submitted"),
        )
        .first(),
      ctx.db
        .query("reviewRoundPauses")
        .withIndex("by_incident_state", (index) =>
          index.eq("incidentId", incident._id).eq("state", "active"),
        )
        .first(),
    ]);
    if (activeRoundPause) {
      throw new ConvexError({
        code: "ROUND_STILL_PAUSED",
        message: "Resume every review round linked to this incident before resolving it.",
      });
    }
    if (draftSheet || submittedSheet || draftReview || submittedReview) {
      throw new ConvexError({
        code: "MANUAL_RECORDS_PENDING",
        message: "Cancel, reject, or import every pending paper record before resolving the incident.",
      });
    }
    const now = Date.now();
    const version = incident.version + 1;
    await ctx.db.patch(incident._id, {
      state: "resolved",
      manualModeState: "closed",
      resolvedByPersonId: person._id,
      resolutionReason: reason,
      resolvedAt: now,
      version,
      updatedAt: now,
    });
    await appendIncidentReadFactById(ctx, incident._id, now);
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "incident.resolve",
      requestFingerprint,
      targetType: "incident",
      targetId: incident._id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "incident.resolve",
      grantIds,
      scopeType: "incident",
      scopeId: incident._id,
      action: "incident.resolved",
      targetType: "incident",
      targetId: incident._id,
      previousSummary: JSON.stringify({ state: incident.state, manualModeState: incident.manualModeState }),
      nextSummary: JSON.stringify({ state: "resolved", manualModeState: "closed", version }),
      reason,
    });
    return { id: incident._id, version };
  },
});
