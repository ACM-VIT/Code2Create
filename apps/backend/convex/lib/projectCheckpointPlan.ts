import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  eventPhaseKey,
  projectCheckpointKey,
  type EventPhaseKey,
  type ProjectCheckpointKey,
} from "../values";
import { fingerprintText, normalizedText } from "./strings";

type ReadCtx = QueryCtx | MutationCtx;

export const projectCheckpointKeys = [
  "ideation",
  "intermediate_update",
  "final_update",
] as const satisfies readonly ProjectCheckpointKey[];

const requiredPhaseByCheckpoint = {
  ideation: "ideation",
  intermediate_update: "intermediate_update",
  final_update: "final_update",
} as const satisfies Record<ProjectCheckpointKey, EventPhaseKey>;

export const projectCheckpointDefinitionInput = v.object({
  checkpointKey: projectCheckpointKey,
  phaseKey: eventPhaseKey,
  displayName: v.string(),
  prompt: v.string(),
  followUpQuestion: v.string(),
  graceMinutes: v.number(),
});

export type ProjectCheckpointDefinitionInput = {
  checkpointKey: ProjectCheckpointKey;
  phaseKey: EventPhaseKey;
  displayName: string;
  prompt: string;
  followUpQuestion: string;
  graceMinutes: number;
};

export type NormalizedProjectCheckpointDefinition =
  ProjectCheckpointDefinitionInput & { displayOrder: number };

function invalidPlan(message: string): never {
  throw new ConvexError({ code: "INVALID_CHECKPOINT_PLAN", message });
}

function checkpointOrder(checkpointKey: ProjectCheckpointKey) {
  return projectCheckpointKeys.indexOf(checkpointKey);
}

export function projectCheckpointPlanIssues(
  definitions: readonly NormalizedProjectCheckpointDefinition[],
) {
  const issues: string[] = [];
  if (definitions.length !== projectCheckpointKeys.length) {
    issues.push("The plan must define ideation, intermediate update, and final update.");
  }
  const keys = definitions.map((definition) => definition.checkpointKey);
  if (new Set(keys).size !== keys.length) {
    issues.push("Every project checkpoint may appear only once.");
  }
  for (const checkpointKey of projectCheckpointKeys) {
    if (!keys.includes(checkpointKey)) {
      issues.push(`The ${checkpointKey.replaceAll("_", " ")} checkpoint is missing.`);
    }
  }
  for (const definition of definitions) {
    if (definition.phaseKey !== requiredPhaseByCheckpoint[definition.checkpointKey]) {
      issues.push(
        `${definition.displayName} must use the ${requiredPhaseByCheckpoint[
          definition.checkpointKey
        ].replaceAll("_", " ")} phase.`,
      );
    }
    if (definition.displayOrder !== checkpointOrder(definition.checkpointKey)) {
      issues.push(`${definition.displayName} is not in checkpoint order.`);
    }
    if (
      !Number.isSafeInteger(definition.graceMinutes) ||
      definition.graceMinutes < 0 ||
      definition.graceMinutes > 24 * 60
    ) {
      issues.push(`${definition.displayName} grace must be between zero and 1,440 minutes.`);
    }
  }
  return issues;
}

export function normalizeProjectCheckpointPlan(
  definitions: readonly ProjectCheckpointDefinitionInput[],
): NormalizedProjectCheckpointDefinition[] {
  const normalized = definitions
    .map((definition) => ({
      checkpointKey: definition.checkpointKey,
      phaseKey: definition.phaseKey,
      displayName: normalizedText(definition.displayName, "Checkpoint name", 2, 80),
      prompt: normalizedText(definition.prompt, "Checkpoint prompt", 5, 500),
      followUpQuestion: normalizedText(
        definition.followUpQuestion,
        "Checkpoint follow-up",
        5,
        180,
      ),
      graceMinutes: definition.graceMinutes,
      displayOrder: checkpointOrder(definition.checkpointKey),
    }))
    .toSorted((left, right) => left.displayOrder - right.displayOrder);
  const issue = projectCheckpointPlanIssues(normalized)[0];
  if (issue) invalidPlan(issue);
  return normalized;
}

export function projectCheckpointPlanChecksum(
  definitions: readonly NormalizedProjectCheckpointDefinition[],
) {
  return fingerprintText(JSON.stringify(definitions));
}

export async function loadProjectCheckpointDefinitions(
  ctx: ReadCtx,
  planVersionId: Id<"projectCheckpointPlanVersions">,
) {
  return ctx.db
    .query("projectCheckpointDefinitions")
    .withIndex("by_plan_order", (index) => index.eq("planVersionId", planVersionId))
    .collect();
}

export function projectCheckpointDefinitionFromRow(
  definition: Doc<"projectCheckpointDefinitions">,
): NormalizedProjectCheckpointDefinition {
  return {
    checkpointKey: definition.checkpointKey,
    phaseKey: definition.phaseKey,
    displayName: definition.displayName,
    prompt: definition.prompt,
    followUpQuestion: definition.followUpQuestion,
    graceMinutes: definition.graceMinutes,
    displayOrder: definition.displayOrder,
  };
}

export async function loadPublishedProjectCheckpointPlan(
  ctx: ReadCtx,
  event: Doc<"events">,
) {
  if (!event.publishedProjectCheckpointPlanId) return null;
  const plan = await ctx.db.get(event.publishedProjectCheckpointPlanId);
  if (!plan || plan.eventId !== event._id || plan.status !== "published") {
    throw new Error("The event's published project-checkpoint plan is invalid.");
  }
  const rows = await loadProjectCheckpointDefinitions(ctx, plan._id);
  const definitions = normalizeProjectCheckpointPlan(
    rows.map(projectCheckpointDefinitionFromRow),
  );
  if (
    rows.some((row) => row.eventId !== event._id || row.status !== "published") ||
    projectCheckpointPlanChecksum(definitions) !== plan.checksum
  ) {
    throw new Error("The event's published project-checkpoint plan is incomplete.");
  }
  return { plan, rows };
}

export async function saveProjectCheckpointPlanDraft(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    actorPersonId: Id<"people">;
    definitions: readonly ProjectCheckpointDefinitionInput[];
    expectedDraftPlanId?: Id<"projectCheckpointPlanVersions">;
    now: number;
  },
) {
  const definitions = normalizeProjectCheckpointPlan(args.definitions);
  const checksum = projectCheckpointPlanChecksum(definitions);
  const currentDraft = await ctx.db
    .query("projectCheckpointPlanVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", args.event._id).eq("status", "draft"),
    )
    .unique();
  if (currentDraft?._id !== args.expectedDraftPlanId) {
    throw new ConvexError({
      code: "CHECKPOINT_PLAN_DRAFT_CHANGED",
      message: "The checkpoint draft changed in another session. Refresh before saving.",
    });
  }
  if (currentDraft?.checksum === checksum) {
    return {
      planVersionId: currentDraft._id,
      planVersion: currentDraft.version,
      checksum,
      changed: false,
    };
  }
  const latest = await ctx.db
    .query("projectCheckpointPlanVersions")
    .withIndex("by_event_version", (index) => index.eq("eventId", args.event._id))
    .order("desc")
    .first();
  const version = (latest?.version ?? 0) + 1;
  if (currentDraft) {
    const currentRows = await loadProjectCheckpointDefinitions(ctx, currentDraft._id);
    await ctx.db.patch(currentDraft._id, { status: "retired" });
    for (const row of currentRows) await ctx.db.patch(row._id, { status: "retired" });
  }
  const planVersionId = await ctx.db.insert("projectCheckpointPlanVersions", {
    eventId: args.event._id,
    version,
    status: "draft",
    checksum,
    createdByPersonId: args.actorPersonId,
    createdAt: args.now,
  });
  for (const definition of definitions) {
    await ctx.db.insert("projectCheckpointDefinitions", {
      eventId: args.event._id,
      planVersionId,
      ...definition,
      status: "draft",
      createdAt: args.now,
    });
  }
  return { planVersionId, planVersion: version, checksum, changed: true };
}

export async function publishProjectCheckpointPlan(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    draftPlanId: Id<"projectCheckpointPlanVersions">;
    expectedDraftChecksum: string;
    now: number;
  },
) {
  if (!args.event.publishedEventPhaseScheduleId) {
    throw new ConvexError({
      code: "PHASE_SCHEDULE_REQUIRED",
      message: "Publish the event-phase schedule before publishing checkpoints.",
    });
  }
  const schedule = await ctx.db.get(args.event.publishedEventPhaseScheduleId);
  if (!schedule || schedule.eventId !== args.event._id || schedule.status !== "published") {
    throw new Error("The event's published phase schedule is invalid.");
  }
  const draft = await ctx.db.get(args.draftPlanId);
  const currentDraft = await ctx.db
    .query("projectCheckpointPlanVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", args.event._id).eq("status", "draft"),
    )
    .unique();
  if (
    !draft ||
    draft.eventId !== args.event._id ||
    currentDraft?._id !== draft._id ||
    draft.checksum !== args.expectedDraftChecksum
  ) {
    throw new ConvexError({
      code: "CHECKPOINT_PLAN_DRAFT_CHANGED",
      message: "The checkpoint draft changed in another session. Refresh before publishing.",
    });
  }
  const rows = await loadProjectCheckpointDefinitions(ctx, draft._id);
  const definitions = normalizeProjectCheckpointPlan(
    rows.map(projectCheckpointDefinitionFromRow),
  );
  if (
    rows.some((row) => row.eventId !== args.event._id || row.status !== "draft") ||
    projectCheckpointPlanChecksum(definitions) !== draft.checksum
  ) {
    throw new ConvexError({
      code: "CHECKPOINT_PLAN_DRAFT_INVALID",
      message: "The checkpoint draft no longer matches its validated contents.",
    });
  }
  const publishedId = args.event.publishedProjectCheckpointPlanId;
  const published = publishedId ? await ctx.db.get(publishedId) : null;
  if (
    publishedId &&
    (!published || published.eventId !== args.event._id || published.status !== "published")
  ) {
    throw new Error("The event's published project-checkpoint plan is invalid.");
  }
  if (published) await ctx.db.patch(published._id, { status: "superseded" });
  await ctx.db.patch(draft._id, { status: "published", publishedAt: args.now });
  for (const row of rows) await ctx.db.patch(row._id, { status: "published" });
  await ctx.db.patch(args.event._id, {
    publishedProjectCheckpointPlanId: draft._id,
    version: args.event.version + 1,
    updatedAt: args.now,
  });
  return { planVersionId: draft._id, planVersion: draft.version };
}
