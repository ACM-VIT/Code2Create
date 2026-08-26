import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { advanceAccessVersion } from "./accessVersion";
import { insertPermissionGrant } from "./permissions";

export async function grantPanelMemberAccess(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    roundId: Id<"reviewRounds">;
    panelId: Id<"reviewPanels">;
    panelMemberId: Id<"reviewPanelMembers">;
    reviewerPersonId: Id<"people">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    grantedByPersonId: Id<"people">;
    isCoordinator: boolean;
    reason: string;
  },
) {
  const common = {
    eventId: args.eventId,
    personId: args.reviewerPersonId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    sourceType: "panel_assignment" as const,
    sourceId: args.panelMemberId,
    grantedByPersonId: args.grantedByPersonId,
    reason: args.reason,
  };
  let createdCount = 0;
  for (const permissionKey of [
    "reviewer.device.register",
    "communications.call_consent.manage",
  ] as const) {
    const result = await insertPermissionGrant(ctx, {
      ...common,
      permissionKey,
      scopeType: "self",
      scopeId: args.eventAccessSubjectId,
    });
    if (result.created) createdCount += 1;
  }
  for (const permissionKey of ["reviewer.clock_in", "round.read"] as const) {
    const result = await insertPermissionGrant(ctx, {
      ...common,
      permissionKey,
      scopeType: "round",
      scopeId: args.roundId,
    });
    if (result.created) createdCount += 1;
  }
  const panelGrant = await insertPermissionGrant(ctx, {
    ...common,
    permissionKey: "panel.read",
    scopeType: "panel",
    scopeId: args.panelId,
  });
  if (panelGrant.created) createdCount += 1;
  if (args.isCoordinator) {
    for (const permissionKey of ["queue.manage", "review.prepare"] as const) {
      const result = await insertPermissionGrant(ctx, {
        ...common,
        permissionKey,
        scopeType: "panel",
        scopeId: args.panelId,
      });
      if (result.created) createdCount += 1;
    }
  }
  if (createdCount > 0) {
    await advanceAccessVersion(ctx, args.eventAccessSubjectId, Date.now());
  }
}

export async function grantReviewAssignmentAccess(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    reviewSessionId: Id<"reviewSessions">;
    scorecardId: Id<"scorecards">;
    assignmentId: Id<"reviewAssignments">;
    reviewerPersonId: Id<"people">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    grantedByPersonId: Id<"people">;
    isCoordinator: boolean;
  },
) {
  const common = {
    eventId: args.eventId,
    personId: args.reviewerPersonId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    sourceType: "panel_assignment" as const,
    sourceId: args.assignmentId,
    grantedByPersonId: args.grantedByPersonId,
    reason: "Fixed review assignment",
  };
  let createdCount = 0;
  for (const permissionKey of [
    "review.read",
    "review.presence.confirm",
    "review.conflict.report",
    "review.evidence.read",
  ] as const) {
    const result = await insertPermissionGrant(ctx, {
      ...common,
      permissionKey,
      scopeType: "review",
      scopeId: args.reviewSessionId,
    });
    if (result.created) createdCount += 1;
  }
  for (const permissionKey of [
    "scorecard.draft.write",
    "scorecard.submit",
    "scorecard.correction.request",
  ] as const) {
    const result = await insertPermissionGrant(ctx, {
      ...common,
      permissionKey,
      scopeType: "scorecard",
      scopeId: args.scorecardId,
    });
    if (result.created) createdCount += 1;
  }
  if (args.isCoordinator) {
    for (const permissionKey of [
      "review.start",
      "review.timer.extend",
      "review.shared_notes.write",
      "review.complete",
    ] as const) {
      const result = await insertPermissionGrant(ctx, {
        ...common,
        permissionKey,
        scopeType: "review",
        scopeId: args.reviewSessionId,
      });
      if (result.created) createdCount += 1;
    }
  }
  if (createdCount > 0) {
    await advanceAccessVersion(ctx, args.eventAccessSubjectId, Date.now());
  }
}
