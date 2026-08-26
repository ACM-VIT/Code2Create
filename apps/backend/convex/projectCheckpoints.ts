import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { z } from "zod";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireMembership,
} from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
  storedOperationVersion,
} from "./lib/operations";
import { loadPublishedPhaseSchedule } from "./lib/phaseSchedule";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import {
  loadPublishedProjectCheckpointPlan,
  projectCheckpointKeys,
} from "./lib/projectCheckpointPlan";
import { normalizedLongText } from "./lib/strings";
import { activeGrantScopes } from "./lib/synesthesia";
import { maximumReviewTeamsPerEvent } from "./lib/reviewLimits";
import { projectCheckpointKey, teamStatus, type ProjectCheckpointKey } from "./values";

const checkpointAvailability = v.union(
  v.literal("awaiting_confirmation"),
  v.literal("upcoming"),
  v.literal("open"),
  v.literal("late"),
  v.literal("closed"),
  v.literal("submitted"),
);

type CheckpointAvailability =
  | "awaiting_confirmation"
  | "upcoming"
  | "open"
  | "late"
  | "closed"
  | "submitted";

const draftView = v.object({
  id: v.id("teamCheckpointDrafts"),
  stage: v.union(
    v.literal("update"),
    v.literal("follow_up"),
    v.literal("review"),
    v.literal("submitted"),
  ),
  updateText: v.optional(v.string()),
  followUpAnswer: v.optional(v.string()),
  version: v.number(),
  updatedAt: v.number(),
});

const submissionView = v.object({
  id: v.id("teamCheckpointSubmissions"),
  updateText: v.string(),
  followUpAnswer: v.string(),
  timing: v.union(v.literal("on_time"), v.literal("late")),
  submittedAt: v.number(),
});

const checkpointSubmissionOperationResult = z
  .object({
    submissionId: z.string().min(1),
    timing: z.enum(["on_time", "late"]),
    submittedAt: z.number().int().nonnegative(),
  })
  .strict();

const checkpointView = v.object({
  checkpointKey: projectCheckpointKey,
  displayName: v.string(),
  prompt: v.string(),
  followUpQuestion: v.string(),
  phaseName: v.string(),
  opensAt: v.number(),
  dueAt: v.number(),
  closesAt: v.number(),
  availability: checkpointAvailability,
  canEdit: v.boolean(),
  draft: v.union(v.null(), draftView),
  submission: v.union(v.null(), submissionView),
});

const admittedTeamStatuses = [
  "confirmed",
  "checked_in",
  "active",
  "completed",
] as const satisfies readonly Doc<"teams">["status"][];

function isAdmittedTeam(team: Doc<"teams">) {
  return admittedTeamStatuses.some((status) => status === team.status);
}

function requireAdmittedTeam(team: Doc<"teams">) {
  if (!isAdmittedTeam(team)) {
    throw new ConvexError({
      code: "CHECKPOINTS_NOT_AVAILABLE",
      message: "Project checkpoints open after the team confirms its event place.",
    });
  }
}

export function projectCheckpointClosesAt(dueAt: number, graceMinutes: number) {
  return dueAt + graceMinutes * 60_000;
}

export function projectCheckpointAvailabilityAt(args: {
  admitted: boolean;
  submitted: boolean;
  startsAt: number;
  dueAt: number;
  closesAt: number;
  now: number;
}): CheckpointAvailability {
  if (args.submitted) return "submitted";
  if (!args.admitted) return "awaiting_confirmation";
  if (args.now < args.startsAt) return "upcoming";
  if (args.now <= args.dueAt) return "open";
  if (args.now < args.closesAt) return "late";
  return "closed";
}

function requireEditableAvailability(availability: CheckpointAvailability) {
  if (availability !== "open" && availability !== "late") {
    throw new ConvexError({
      code: "CHECKPOINT_NOT_OPEN",
      message:
        availability === "upcoming"
          ? "This checkpoint has not opened yet."
          : availability === "awaiting_confirmation"
            ? "Confirm the team's event place before completing checkpoints."
            : "This checkpoint is closed.",
    });
  }
}

async function currentTeamForRead(ctx: QueryCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const membership = await requireMembership(ctx, event._id, person._id);
  const member = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index
        .eq("eventId", event._id)
        .eq("membershipId", membership._id)
        .eq("status", "active"),
    )
    .unique();
  if (!member) throw new ConvexError({ code: "TEAM_REQUIRED", message: "Join a team first." });
  const team = await ctx.db.get(member.teamId);
  if (!team || team.eventId !== event._id) {
    throw new Error("The active team membership is invalid.");
  }
  await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "project.checkpoint.read",
    scopeType: "team",
    scopeId: team._id,
  });
  return { event, subject, team };
}

async function currentTeamForWrite(ctx: MutationCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const membership = await requireMembership(ctx, event._id, person._id);
  const member = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index
        .eq("eventId", event._id)
        .eq("membershipId", membership._id)
        .eq("status", "active"),
    )
    .unique();
  if (!member) throw new ConvexError({ code: "TEAM_REQUIRED", message: "Join a team first." });
  const team = await ctx.db.get(member.teamId);
  if (!team || team.eventId !== event._id) {
    throw new Error("The active team membership is invalid.");
  }
  const grantIds = await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "team.project.write",
    scopeType: "team",
    scopeId: team._id,
  });
  requireAdmittedTeam(team);
  return { event, person, membership, team, grantIds };
}

async function definitionForDraft(
  ctx: QueryCtx | MutationCtx,
  eventId: Id<"events">,
  draft: Doc<"teamCheckpointDrafts">,
) {
  const [plan, definition] = await Promise.all([
    ctx.db.get(draft.planVersionId),
    ctx.db.get(draft.definitionId),
  ]);
  if (
    !plan ||
    !definition ||
    plan.eventId !== eventId ||
    definition.eventId !== eventId ||
    definition.planVersionId !== plan._id ||
    definition.checkpointKey !== draft.checkpointKey ||
    (plan.status !== "published" && plan.status !== "superseded") ||
    definition.status !== "published"
  ) {
    throw new Error("The team checkpoint draft has an invalid pinned definition.");
  }
  return definition;
}

async function currentDefinition(
  ctx: QueryCtx | MutationCtx,
  event: Doc<"events">,
  checkpointKey: ProjectCheckpointKey,
) {
  const published = await loadPublishedProjectCheckpointPlan(ctx, event);
  if (!published) {
    throw new ConvexError({
      code: "CHECKPOINT_PLAN_UNAVAILABLE",
      message: "Project checkpoints are not configured yet.",
    });
  }
  const definition = published.rows.find((row) => row.checkpointKey === checkpointKey);
  if (!definition) throw new Error("The published checkpoint plan is incomplete.");
  return definition;
}

async function currentWindow(
  ctx: QueryCtx | MutationCtx,
  event: Doc<"events">,
  definition: Doc<"projectCheckpointDefinitions">,
) {
  const published = await loadPublishedPhaseSchedule(ctx, event);
  if (!published) {
    throw new ConvexError({
      code: "PHASE_SCHEDULE_UNAVAILABLE",
      message: "The event schedule is not available yet.",
    });
  }
  const window = published.windows.find((row) => row.phaseKey === definition.phaseKey);
  if (!window) throw new Error("The published phase schedule is incomplete.");
  return { schedule: published.schedule, window };
}

async function existingDraft(
  ctx: QueryCtx | MutationCtx,
  teamId: Id<"teams">,
  checkpointKey: ProjectCheckpointKey,
) {
  return ctx.db
    .query("teamCheckpointDrafts")
    .withIndex("by_team_key", (index) =>
      index.eq("teamId", teamId).eq("checkpointKey", checkpointKey),
    )
    .unique();
}

async function existingSubmission(
  ctx: QueryCtx | MutationCtx,
  teamId: Id<"teams">,
  checkpointKey: ProjectCheckpointKey,
) {
  return ctx.db
    .query("teamCheckpointSubmissions")
    .withIndex("by_team_key", (index) =>
      index.eq("teamId", teamId).eq("checkpointKey", checkpointKey),
    )
    .unique();
}

function checkpointDraftView(draft: Doc<"teamCheckpointDrafts">) {
  return {
    id: draft._id,
    stage: draft.stage,
    ...(draft.updateText !== undefined ? { updateText: draft.updateText } : {}),
    ...(draft.followUpAnswer !== undefined
      ? { followUpAnswer: draft.followUpAnswer }
      : {}),
    version: draft.version,
    updatedAt: draft.updatedAt,
  };
}

function checkpointSubmissionView(submission: Doc<"teamCheckpointSubmissions">) {
  return {
    id: submission._id,
    updateText: submission.updateText,
    followUpAnswer: submission.followUpAnswer,
    timing: submission.timing,
    submittedAt: submission.submittedAt,
  };
}

export const mine = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    serverTime: v.number(),
    configured: v.boolean(),
    checkpoints: v.array(checkpointView),
  }),
  handler: async (ctx, args) => {
    const { event, subject, team } = await currentTeamForRead(ctx, args.eventSlug);
    const [publishedPlan, publishedSchedule, writeGrantIds] = await Promise.all([
      loadPublishedProjectCheckpointPlan(ctx, event),
      loadPublishedPhaseSchedule(ctx, event),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "team.project.write",
        scopeType: "team",
        scopeId: team._id,
      }),
    ]);
    const now = Date.now();
    if (!publishedPlan || !publishedSchedule) {
      return { serverTime: now, configured: false, checkpoints: [] };
    }
    const checkpoints = [];
    for (const checkpointKey of projectCheckpointKeys) {
      const [draft, submission] = await Promise.all([
        existingDraft(ctx, team._id, checkpointKey),
        existingSubmission(ctx, team._id, checkpointKey),
      ]);
      const definition = draft
        ? await definitionForDraft(ctx, event._id, draft)
        : publishedPlan.rows.find((row) => row.checkpointKey === checkpointKey);
      if (!definition) throw new Error("The published checkpoint plan is incomplete.");
      const window = publishedSchedule.windows.find(
        (candidate) => candidate.phaseKey === definition.phaseKey,
      );
      if (!window) throw new Error("The published phase schedule is incomplete.");
      const closesAt = projectCheckpointClosesAt(window.endsAt, definition.graceMinutes);
      const availability = projectCheckpointAvailabilityAt({
        admitted: isAdmittedTeam(team),
        submitted: submission !== null,
        startsAt: window.startsAt,
        dueAt: window.endsAt,
        closesAt,
        now,
      });
      checkpoints.push({
        checkpointKey,
        displayName: definition.displayName,
        prompt: definition.prompt,
        followUpQuestion: definition.followUpQuestion,
        phaseName: window.displayName,
        opensAt: window.startsAt,
        dueAt: window.endsAt,
        closesAt,
        availability,
        canEdit:
          writeGrantIds.length > 0 &&
          (availability === "open" || availability === "late"),
        draft: draft ? checkpointDraftView(draft) : null,
        submission: submission ? checkpointSubmissionView(submission) : null,
      });
    }
    return { serverTime: now, configured: true, checkpoints };
  },
});

export const eventState = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    serverTime: v.number(),
    configured: v.boolean(),
    checkpoints: v.array(
      v.object({
        checkpointKey: projectCheckpointKey,
        displayName: v.string(),
        phaseName: v.string(),
        opensAt: v.number(),
        dueAt: v.number(),
        closesAt: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const scope = await readableProjectTeamScope(ctx, event._id, subject._id);
    if (!scope.eventWide && scope.teamIds.length === 0) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account cannot read project checkpoints.",
      });
    }
    const [publishedPlan, publishedSchedule] = await Promise.all([
      loadPublishedProjectCheckpointPlan(ctx, event),
      loadPublishedPhaseSchedule(ctx, event),
    ]);
    const now = Date.now();
    if (!publishedPlan || !publishedSchedule) {
      return { serverTime: now, configured: false, checkpoints: [] };
    }
    return {
      serverTime: now,
      configured: true,
      checkpoints: publishedPlan.rows.map((definition) => {
        const window = publishedSchedule.windows.find(
          (candidate) => candidate.phaseKey === definition.phaseKey,
        );
        if (!window) throw new Error("The published phase schedule is incomplete.");
        return {
          checkpointKey: definition.checkpointKey,
          displayName: definition.displayName,
          phaseName: window.displayName,
          opensAt: window.startsAt,
          dueAt: window.endsAt,
          closesAt: projectCheckpointClosesAt(window.endsAt, definition.graceMinutes),
        };
      }),
    };
  },
});

async function replayDraftOperation(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    personId: Id<"people">;
    clientOperationId: string;
    commandName: string;
    requestFingerprint: string;
  },
) {
  const operation = await findOperation(ctx, {
    eventId: args.eventId,
    actorPersonId: args.personId,
    clientOperationId: args.clientOperationId,
    commandName: args.commandName,
    requestFingerprint: args.requestFingerprint,
  });
  if (!operation) return null;
  const draftId = ctx.db.normalizeId("teamCheckpointDrafts", operation.targetId);
  if (!draftId) throw new Error("The prior checkpoint-draft result is invalid.");
  const draftVersion = storedOperationVersion(operation.resultJson, "checkpoint-draft");
  return { draftId, draftVersion };
}

async function recordDraftOperation(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    personId: Id<"people">;
    clientOperationId: string;
    commandName: string;
    requestFingerprint: string;
    draftId: Id<"teamCheckpointDrafts">;
    draftVersion: number;
    createdAt: number;
  },
) {
  await recordOperation(ctx, {
    eventId: args.eventId,
    actorPersonId: args.personId,
    clientOperationId: args.clientOperationId,
    commandName: args.commandName,
    requestFingerprint: args.requestFingerprint,
    targetType: "team_checkpoint_draft",
    targetId: args.draftId,
    resultJson: String(args.draftVersion),
    createdAt: args.createdAt,
  });
}

function requireDraftVersion(actual: number, expected: number) {
  if (actual !== expected) {
    throw new ConvexError({
      code: "CHECKPOINT_CHANGED",
      message: "This team update changed in another session. Review it and try again.",
    });
  }
}

export const saveUpdate = mutation({
  args: {
    eventSlug: v.string(),
    checkpointKey: projectCheckpointKey,
    updateText: v.string(),
    expectedDraftVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ draftId: v.id("teamCheckpointDrafts"), draftVersion: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, membership, team, grantIds } = await currentTeamForWrite(
      ctx,
      args.eventSlug,
    );
    const updateText = normalizedLongText(args.updateText, "Project update", 10, 4_000);
    const requestFingerprint = operationFingerprint([
      team._id,
      args.checkpointKey,
      args.expectedDraftVersion,
      updateText,
    ]);
    const prior = await replayDraftOperation(ctx, {
      eventId: event._id,
      personId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "project.checkpoint.update.save",
      requestFingerprint,
    });
    if (prior) return prior;
    const draft = await existingDraft(ctx, team._id, args.checkpointKey);
    requireDraftVersion(draft?.version ?? 0, args.expectedDraftVersion);
    if (draft?.submissionId || draft?.stage === "submitted") {
      throw new ConvexError({
        code: "CHECKPOINT_SUBMITTED",
        message: "This checkpoint is already submitted.",
      });
    }
    const definition = draft
      ? await definitionForDraft(ctx, event._id, draft)
      : await currentDefinition(ctx, event, args.checkpointKey);
    const { window } = await currentWindow(ctx, event, definition);
    const now = Date.now();
    const closesAt = projectCheckpointClosesAt(window.endsAt, definition.graceMinutes);
    requireEditableAvailability(
      projectCheckpointAvailabilityAt({
        admitted: true,
        submitted: false,
        startsAt: window.startsAt,
        dueAt: window.endsAt,
        closesAt,
        now,
      }),
    );
    const draftVersion = (draft?.version ?? 0) + 1;
    let draftId: Id<"teamCheckpointDrafts">;
    if (draft) {
      const changed = draft.updateText !== updateText;
      await ctx.db.patch(draft._id, {
        stage: "follow_up",
        updateText,
        ...(changed ? { followUpAnswer: undefined } : {}),
        version: draftVersion,
        lastEditedByMembershipId: membership._id,
        updatedAt: now,
      });
      draftId = draft._id;
    } else {
      draftId = await ctx.db.insert("teamCheckpointDrafts", {
        eventId: event._id,
        teamId: team._id,
        planVersionId: definition.planVersionId,
        definitionId: definition._id,
        checkpointKey: args.checkpointKey,
        stage: "follow_up",
        updateText,
        version: draftVersion,
        lastEditedByMembershipId: membership._id,
        updatedAt: now,
      });
    }
    await recordDraftOperation(ctx, {
      eventId: event._id,
      personId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "project.checkpoint.update.save",
      requestFingerprint,
      draftId,
      draftVersion,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "team.project.write",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "project.checkpoint_update_saved",
      targetType: "team_checkpoint_draft",
      targetId: draftId,
      nextSummary: JSON.stringify({ checkpointKey: args.checkpointKey, draftVersion }),
      reason: "Team saved a project checkpoint update",
    });
    return { draftId, draftVersion };
  },
});

export const saveFollowUp = mutation({
  args: {
    eventSlug: v.string(),
    checkpointKey: projectCheckpointKey,
    answer: v.string(),
    expectedDraftVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ draftId: v.id("teamCheckpointDrafts"), draftVersion: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, membership, team, grantIds } = await currentTeamForWrite(
      ctx,
      args.eventSlug,
    );
    const answer = normalizedLongText(args.answer, "Checkpoint answer", 2, 2_000);
    const requestFingerprint = operationFingerprint([
      team._id,
      args.checkpointKey,
      args.expectedDraftVersion,
      answer,
    ]);
    const prior = await replayDraftOperation(ctx, {
      eventId: event._id,
      personId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "project.checkpoint.follow_up.save",
      requestFingerprint,
    });
    if (prior) return prior;
    const draft = await existingDraft(ctx, team._id, args.checkpointKey);
    if (!draft?.updateText) {
      throw new ConvexError({
        code: "CHECKPOINT_UPDATE_REQUIRED",
        message: "Save the project update first.",
      });
    }
    requireDraftVersion(draft.version, args.expectedDraftVersion);
    if (draft.submissionId || draft.stage === "submitted") {
      throw new ConvexError({
        code: "CHECKPOINT_SUBMITTED",
        message: "This checkpoint is already submitted.",
      });
    }
    const definition = await definitionForDraft(ctx, event._id, draft);
    const { window } = await currentWindow(ctx, event, definition);
    const now = Date.now();
    const closesAt = projectCheckpointClosesAt(window.endsAt, definition.graceMinutes);
    requireEditableAvailability(
      projectCheckpointAvailabilityAt({
        admitted: true,
        submitted: false,
        startsAt: window.startsAt,
        dueAt: window.endsAt,
        closesAt,
        now,
      }),
    );
    const draftVersion = draft.version + 1;
    await ctx.db.patch(draft._id, {
      stage: "review",
      followUpAnswer: answer,
      version: draftVersion,
      lastEditedByMembershipId: membership._id,
      updatedAt: now,
    });
    await recordDraftOperation(ctx, {
      eventId: event._id,
      personId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "project.checkpoint.follow_up.save",
      requestFingerprint,
      draftId: draft._id,
      draftVersion,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "team.project.write",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "project.checkpoint_follow_up_saved",
      targetType: "team_checkpoint_draft",
      targetId: draft._id,
      nextSummary: JSON.stringify({ checkpointKey: args.checkpointKey, draftVersion }),
      reason: "Team saved a project checkpoint reflection",
    });
    return { draftId: draft._id, draftVersion };
  },
});

export const submit = mutation({
  args: {
    eventSlug: v.string(),
    checkpointKey: projectCheckpointKey,
    expectedDraftVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    submissionId: v.id("teamCheckpointSubmissions"),
    timing: v.union(v.literal("on_time"), v.literal("late")),
    submittedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const { event, person, membership, team, grantIds } = await currentTeamForWrite(
      ctx,
      args.eventSlug,
    );
    const requestFingerprint = operationFingerprint([
      team._id,
      args.checkpointKey,
      args.expectedDraftVersion,
    ]);
    const priorOperation = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "project.checkpoint.submit",
      requestFingerprint,
    });
    if (priorOperation) {
      const result = storedOperationResult(
        priorOperation.resultJson,
        "checkpoint submission",
        checkpointSubmissionOperationResult,
      );
      const submissionId = ctx.db.normalizeId(
        "teamCheckpointSubmissions",
        result.submissionId,
      );
      if (!submissionId || submissionId !== priorOperation.targetId) {
        throw new Error("The stored checkpoint submission is invalid.");
      }
      return {
        submissionId,
        timing: result.timing,
        submittedAt: result.submittedAt,
      };
    }
    const [draft, existing] = await Promise.all([
      existingDraft(ctx, team._id, args.checkpointKey),
      existingSubmission(ctx, team._id, args.checkpointKey),
    ]);
    if (existing) {
      throw new ConvexError({
        code: "CHECKPOINT_SUBMITTED",
        message: "This checkpoint is already submitted.",
      });
    }
    if (!draft?.updateText || !draft.followUpAnswer) {
      throw new ConvexError({
        code: "CHECKPOINT_INCOMPLETE",
        message: "Complete both short checkpoint answers before submitting.",
      });
    }
    requireDraftVersion(draft.version, args.expectedDraftVersion);
    const definition = await definitionForDraft(ctx, event._id, draft);
    const { schedule, window } = await currentWindow(ctx, event, definition);
    const now = Date.now();
    const closesAt = projectCheckpointClosesAt(window.endsAt, definition.graceMinutes);
    const availability = projectCheckpointAvailabilityAt({
      admitted: true,
      submitted: false,
      startsAt: window.startsAt,
      dueAt: window.endsAt,
      closesAt,
      now,
    });
    requireEditableAvailability(availability);
    const sequence = definition.displayOrder + 1;
    const previousSubmission = await ctx.db
      .query("teamCheckpointSubmissions")
      .withIndex("by_team_sequence", (index) =>
        index.eq("teamId", team._id).lt("sequence", sequence),
      )
      .order("desc")
      .first();
    const timing: Doc<"teamCheckpointSubmissions">["timing"] =
      now <= window.endsAt ? "on_time" : "late";
    const submissionId = await ctx.db.insert("teamCheckpointSubmissions", {
      eventId: event._id,
      teamId: team._id,
      planVersionId: definition.planVersionId,
      definitionId: definition._id,
      phaseScheduleVersionId: schedule._id,
      phaseWindowId: window._id,
      checkpointKey: args.checkpointKey,
      sequence,
      displayName: definition.displayName,
      prompt: definition.prompt,
      updateText: draft.updateText,
      followUpQuestion: definition.followUpQuestion,
      followUpAnswer: draft.followUpAnswer,
      dueAt: window.endsAt,
      closesAt,
      timing,
      ...(previousSubmission ? { previousSubmissionId: previousSubmission._id } : {}),
      sourceDraftVersion: draft.version,
      submittedByMembershipId: membership._id,
      submittedAt: now,
    });
    await ctx.db.patch(draft._id, {
      stage: "submitted",
      submissionId,
      version: draft.version + 1,
      lastEditedByMembershipId: membership._id,
      updatedAt: now,
    });
    const result = { submissionId, timing, submittedAt: now };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "project.checkpoint.submit",
      requestFingerprint,
      targetType: "team_checkpoint_submission",
      targetId: submissionId,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "team.project.write",
      grantIds,
      scopeType: "team",
      scopeId: team._id,
      action: "project.checkpoint_submitted",
      targetType: "team_checkpoint_submission",
      targetId: submissionId,
      nextSummary: JSON.stringify({
        checkpointKey: args.checkpointKey,
        sequence,
        timing,
        sourceDraftVersion: draft.version,
      }),
      reason: "Team explicitly submitted its project checkpoint",
    });
    return result;
  },
});

const operationsTeamView = v.object({
  teamId: v.id("teams"),
  teamName: v.string(),
  teamStatus,
  availability: checkpointAvailability,
  draftVersion: v.optional(v.number()),
  updateText: v.optional(v.string()),
  followUpAnswer: v.optional(v.string()),
  submittedAt: v.optional(v.number()),
  timing: v.optional(v.union(v.literal("on_time"), v.literal("late"))),
});

const operationsSummary = v.object({
  totalTeamCount: v.number(),
  submittedCount: v.number(),
  outstandingCount: v.number(),
});

export function projectCheckpointSummaryCounts(
  readableTeamIds: readonly string[],
  submittedTeamIds: ReadonlySet<string>,
) {
  const submittedCount = readableTeamIds.filter((teamId) =>
    submittedTeamIds.has(teamId),
  ).length;
  return {
    totalTeamCount: readableTeamIds.length,
    submittedCount,
    outstandingCount: readableTeamIds.length - submittedCount,
  };
}

async function readableProjectTeamScope(
  ctx: QueryCtx,
  eventId: Id<"events">,
  eventAccessSubjectId: Id<"eventAccessSubjects">,
) {
  const scopes = await activeGrantScopes(ctx, {
    eventId,
    eventAccessSubjectId,
    permissionKey: "project.checkpoint.read",
    maximumScopeCount: maximumReviewTeamsPerEvent,
  });
  return {
    eventWide: scopes.eventWide,
    teamIds: [...scopes.scopeIds].flatMap((scopeId) => {
      const teamId = ctx.db.normalizeId("teams", scopeId);
      return teamId ? [teamId] : [];
    }),
  };
}

export const teams = query({
  args: {
    eventSlug: v.string(),
    checkpointKey: projectCheckpointKey,
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(operationsTeamView),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const scope = await readableProjectTeamScope(ctx, event._id, subject._id);
    const eventTeams = ctx.db
      .query("teams")
      .withIndex("by_event_status", (index) => index.eq("eventId", event._id));
    const readableTeams = scope.eventWide
      ? eventTeams
      : scope.teamIds.length === 0
        ? eventTeams.filter((filter) =>
            filter.neq(filter.field("eventId"), event._id),
          )
        : eventTeams.filter((filter) =>
            filter.or(
              ...scope.teamIds.map((teamId) =>
                filter.eq(filter.field("_id"), teamId),
              ),
            ),
          );
    const page = await readableTeams.paginate(args.paginationOpts);
    const visible = [];
    const now = Date.now();
    for (const team of page.page) {
      const [draft, submission] = await Promise.all([
        existingDraft(ctx, team._id, args.checkpointKey),
        existingSubmission(ctx, team._id, args.checkpointKey),
      ]);
      const definition = draft
        ? await definitionForDraft(ctx, event._id, draft)
        : await currentDefinition(ctx, event, args.checkpointKey);
      const { window } = await currentWindow(ctx, event, definition);
      const closesAt = projectCheckpointClosesAt(window.endsAt, definition.graceMinutes);
      const availability = projectCheckpointAvailabilityAt({
        admitted: isAdmittedTeam(team),
        submitted: submission !== null,
        startsAt: window.startsAt,
        dueAt: window.endsAt,
        closesAt,
        now,
      });
      visible.push({
        teamId: team._id,
        teamName: team.name,
        teamStatus: team.status,
        availability,
        ...(draft ? { draftVersion: draft.version } : {}),
        ...(draft?.updateText !== undefined ? { updateText: draft.updateText } : {}),
        ...(draft?.followUpAnswer !== undefined
          ? { followUpAnswer: draft.followUpAnswer }
          : {}),
        ...(submission
          ? { submittedAt: submission.submittedAt, timing: submission.timing }
          : {}),
      });
    }
    return { ...page, page: visible };
  },
});

export const operationsCheckpointSummary = query({
  args: {
    eventSlug: v.string(),
    checkpointKey: projectCheckpointKey,
  },
  returns: operationsSummary,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const scope = await readableProjectTeamScope(ctx, event._id, subject._id);
    const eventTeams = await ctx.db
      .query("teams")
      .withIndex("by_event_status", (index) => index.eq("eventId", event._id))
      .collect();
    const readableTeams = (scope.eventWide
      ? eventTeams
      : eventTeams.filter((team) => scope.teamIds.some((teamId) => teamId === team._id)))
      .filter(isAdmittedTeam);
    const submissions = await ctx.db
      .query("teamCheckpointSubmissions")
      .withIndex("by_event_key_submitted", (index) =>
        index.eq("eventId", event._id).eq("checkpointKey", args.checkpointKey),
      )
      .collect();
    return projectCheckpointSummaryCounts(
      readableTeams.map((team) => team._id),
      new Set(submissions.map((submission) => submission.teamId)),
    );
  },
});
