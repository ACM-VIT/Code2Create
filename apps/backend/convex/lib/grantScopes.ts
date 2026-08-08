import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { PermissionKey } from "./permissionCatalog";

type ReadCtx = QueryCtx | MutationCtx;
type PermissionScopeType = Doc<"permissionGrants">["scopeType"];
type ResourceScopeType = Exclude<PermissionScopeType, "event">;

export function selfScopeKind(permissionKey: PermissionKey) {
  if (
    permissionKey === "reviewer.device.register" ||
    permissionKey === "support.case.create" ||
    permissionKey === "support.case.read" ||
    permissionKey === "support.case.reply"
  ) {
    return "event_subject" as const;
  }
  if (
    permissionKey === "participant.profile.read" ||
    permissionKey === "participant.profile.write" ||
    permissionKey === "team.join" ||
    permissionKey === "communications.delivery.self.read" ||
    permissionKey === "attendance.self.read" ||
    permissionKey === "attendance.remedy.self.read" ||
    permissionKey === "attendance.remedy.self.open" ||
    permissionKey === "attendance.portal_qr.mint"
  ) {
    return "participant_membership" as const;
  }
  return null;
}

export function scorecardScopeMustMatchTarget(permissionKey: PermissionKey) {
  return (
    permissionKey === "scorecard.draft.write" ||
    permissionKey === "scorecard.submit" ||
    permissionKey === "scorecard.correction.request"
  );
}

function unhandledScope(scope: never): never {
  throw new ConvexError({
    code: "SCOPE_NOT_AVAILABLE",
    message: `No resource resolver exists for ${scope}.`,
  });
}

export async function validateGrantScope(
  ctx: ReadCtx,
  eventId: Id<"events">,
  targetPersonId: Id<"people">,
  permissionKey: PermissionKey,
  requestedScopeType: PermissionScopeType,
  scopeId: string | undefined,
): Promise<
  | { scopeType: "event" }
  | { scopeType: ResourceScopeType; scopeId: string }
> {
  if (requestedScopeType === "event") {
    if (scopeId !== undefined) {
      throw new ConvexError({ code: "INVALID_SCOPE", message: "Event scope has no ID." });
    }
    return { scopeType: "event" };
  }
  if (!scopeId) {
    throw new ConvexError({
      code: "INVALID_SCOPE",
      message: "This scope needs a resource ID.",
    });
  }

  if (requestedScopeType === "team") {
    const id = ctx.db.normalizeId("teams", scopeId);
    const team = id ? await ctx.db.get("teams", id) : null;
    if (!id || !team || team.eventId !== eventId) {
      throw new ConvexError({ code: "INVALID_SCOPE", message: "Team scope is outside this event." });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "application") {
    const id = ctx.db.normalizeId("applications", scopeId);
    const application = id ? await ctx.db.get("applications", id) : null;
    if (!id || !application || application.eventId !== eventId) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "Application scope is outside this event.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "person") {
    const id = ctx.db.normalizeId("people", scopeId);
    if (!id) {
      throw new ConvexError({ code: "INVALID_SCOPE", message: "Person scope is invalid." });
    }
    const subject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", eventId).eq("personId", id),
      )
      .unique();
    const requiredStatus =
      permissionKey === "access.subjects.reactivate" ? "suspended" : "active";
    if (!subject || subject.status !== requiredStatus) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message:
          requiredStatus === "suspended"
            ? "Reactivation scope must be a suspended account in this event."
            : "Person is outside this event or inactive.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "self") {
    const kind = selfScopeKind(permissionKey);
    if (kind === "event_subject") {
      const id = ctx.db.normalizeId("eventAccessSubjects", scopeId);
      const subject = id ? await ctx.db.get("eventAccessSubjects", id) : null;
      if (
        !id ||
        !subject ||
        subject.eventId !== eventId ||
        subject.personId !== targetPersonId ||
        subject.status !== "active"
      ) {
        throw new ConvexError({
          code: "INVALID_SCOPE",
          message: "Self scope must be the target's own active event account.",
        });
      }
      return { scopeType: requestedScopeType, scopeId: id };
    }
    if (kind !== "participant_membership") {
      throw new ConvexError({
        code: "SCOPE_NOT_AVAILABLE",
        message: "The selected permission has no self resource resolver.",
      });
    }
    const id = ctx.db.normalizeId("eventMemberships", scopeId);
    const membership = id ? await ctx.db.get("eventMemberships", id) : null;
    if (
      !id ||
      !membership ||
      membership.eventId !== eventId ||
      membership.personId !== targetPersonId
    ) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "Self scope must be the target's own participant membership.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "attendance_plan") {
    const id = ctx.db.normalizeId("attendancePlanVersions", scopeId);
    const plan = id ? await ctx.db.get("attendancePlanVersions", id) : null;
    if (!id || !plan || plan.eventId !== eventId || plan.status !== "draft") {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "Attendance-plan publication can target only this event's current draft.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "floor_plan") {
    const id = ctx.db.normalizeId("floorPlanVersions", scopeId);
    const plan = id ? await ctx.db.get("floorPlanVersions", id) : null;
    const stateIsValid =
      plan !== null &&
      plan.eventId === eventId &&
      plan.status !== "retired" &&
      (permissionKey !== "floor.plan.publish" || plan.status === "draft") &&
      (permissionKey !== "floor.plan.freeze" ||
        (plan.status === "published" && plan.mappingState === "open"));
    if (!id || !stateIsValid) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "Floor plan is outside this event or unavailable for that permission.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "floor_zone") {
    const id = ctx.db.normalizeId("floorZones", scopeId);
    const zone = id ? await ctx.db.get("floorZones", id) : null;
    const plan = zone ? await ctx.db.get(zone.planVersionId) : null;
    if (
      !id ||
      !zone ||
      zone.eventId !== eventId ||
      !plan ||
      plan.eventId !== eventId ||
      plan.status !== "published"
    ) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "Floor zone is outside this event's published plan.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "attendance_session") {
    const id = ctx.db.normalizeId("attendanceSessions", scopeId);
    const session = id ? await ctx.db.get("attendanceSessions", id) : null;
    if (!id || !session || session.eventId !== eventId) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "Attendance session is outside this event.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "station") {
    const id = ctx.db.normalizeId("attendanceStations", scopeId);
    const station = id ? await ctx.db.get("attendanceStations", id) : null;
    if (!id || !station || station.eventId !== eventId) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "Attendance station is outside this event.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "incident") {
    const id = ctx.db.normalizeId("incidents", scopeId);
    const incident = id ? await ctx.db.get("incidents", id) : null;
    if (!id || !incident || incident.eventId !== eventId) {
      throw new ConvexError({ code: "INVALID_SCOPE", message: "Incident is outside this event." });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "synesthesia_window") {
    const id = ctx.db.normalizeId("synesthesiaWindows", scopeId);
    const window = id ? await ctx.db.get("synesthesiaWindows", id) : null;
    if (!id || !window || window.eventId !== eventId) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "Synesthesia window is outside this event.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "song_request") {
    const id = ctx.db.normalizeId("songRequests", scopeId);
    const request = id ? await ctx.db.get("songRequests", id) : null;
    if (!id || !request || request.eventId !== eventId) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "Song request is outside this event.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "round") {
    const id = ctx.db.normalizeId("reviewRounds", scopeId);
    const round = id ? await ctx.db.get("reviewRounds", id) : null;
    if (!id || !round || round.eventId !== eventId) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "Review round is outside this event.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "panel") {
    const id = ctx.db.normalizeId("reviewPanels", scopeId);
    const panel = id ? await ctx.db.get("reviewPanels", id) : null;
    if (!id || !panel || panel.eventId !== eventId) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "Review panel is outside this event.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "review") {
    const id = ctx.db.normalizeId("reviewSessions", scopeId);
    const review = id ? await ctx.db.get("reviewSessions", id) : null;
    if (!id || !review || review.eventId !== eventId) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "Review session is outside this event.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "page") {
    const id = ctx.db.normalizeId("reviewerPages", scopeId);
    const page = id ? await ctx.db.get("reviewerPages", id) : null;
    if (
      !id ||
      !page ||
      page.eventId !== eventId ||
      page.targetPersonId !== targetPersonId ||
      (page.state !== "sent" && page.state !== "opened") ||
      page.expiresAt <= Date.now()
    ) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "Reviewer page must belong to the target account in this event.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "scorecard") {
    const id = ctx.db.normalizeId("scorecards", scopeId);
    const scorecard = id ? await ctx.db.get("scorecards", id) : null;
    if (
      !id ||
      !scorecard ||
      scorecard.eventId !== eventId ||
      (scorecardScopeMustMatchTarget(permissionKey) &&
        scorecard.reviewerPersonId !== targetPersonId)
    ) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "Scorecard must belong to the target account in this event.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "evidence_checkpoint") {
    const id = ctx.db.normalizeId("reviewEvidenceCheckpointSets", scopeId);
    const checkpoint = id
      ? await ctx.db.get("reviewEvidenceCheckpointSets", id)
      : null;
    if (!id || !checkpoint || checkpoint.eventId !== eventId) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "Evidence checkpoint is outside this event.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "permission_bundle") {
    const id = ctx.db.normalizeId("permissionBundles", scopeId);
    const bundle = id ? await ctx.db.get("permissionBundles", id) : null;
    if (!id || !bundle || bundle.eventId !== eventId || bundle.status !== "active") {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "Permission bundle is outside this event or retired.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "roster_entry") {
    const id = ctx.db.normalizeId("rosterEntries", scopeId);
    const entry = id ? await ctx.db.get("rosterEntries", id) : null;
    if (
      !id ||
      !entry ||
      entry.eventId !== eventId ||
      (permissionKey === "access.roster.revoke" && entry.status !== "pending")
    ) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message:
          permissionKey === "access.roster.revoke"
            ? "Roster revocation must target a pending row in this event."
            : "Roster entry is outside this event.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "support_case") {
    const id = ctx.db.normalizeId("supportCases", scopeId);
    const supportCase = id ? await ctx.db.get("supportCases", id) : null;
    if (!id || !supportCase || supportCase.eventId !== eventId) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "Support case is outside this event.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  if (requestedScopeType === "rehearsal_run") {
    const id = ctx.db.normalizeId("rehearsalRuns", scopeId);
    const rehearsalRun = id ? await ctx.db.get("rehearsalRuns", id) : null;
    if (!id || !rehearsalRun || rehearsalRun.eventId !== eventId) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "Rehearsal run is outside this event.",
      });
    }
    return { scopeType: requestedScopeType, scopeId: id };
  }
  return unhandledScope(requestedScopeType);
}
