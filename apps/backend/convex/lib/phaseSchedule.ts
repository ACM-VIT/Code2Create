import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { eventPhaseKey, type EventPhaseKey } from "../values";
import { fingerprintText, normalizedText } from "./strings";

type ReadCtx = QueryCtx | MutationCtx;

export const eventPhaseKeys = [
  "introduction",
  "ideation",
  "build",
  "intermediate_update",
  "final_update",
] as const satisfies readonly EventPhaseKey[];

export const phaseScheduleInput = v.object({
  phaseKey: eventPhaseKey,
  displayName: v.string(),
  description: v.string(),
  startsAt: v.number(),
  endsAt: v.number(),
});

export type PhaseScheduleInput = {
  phaseKey: EventPhaseKey;
  displayName: string;
  description: string;
  startsAt: number;
  endsAt: number;
};

export type NormalizedPhase = PhaseScheduleInput & { displayOrder: number };

function invalidSchedule(message: string): never {
  throw new ConvexError({ code: "INVALID_PHASE_SCHEDULE", message });
}

function phaseOrder(phaseKey: EventPhaseKey) {
  return eventPhaseKeys.indexOf(phaseKey);
}

export function phaseScheduleIssues(phases: readonly NormalizedPhase[]) {
  const issues: string[] = [];
  if (phases.length !== eventPhaseKeys.length) {
    issues.push("The schedule must contain one definition for each of the five event phases.");
  }
  const keys = phases.map((phase) => phase.phaseKey);
  if (new Set(keys).size !== keys.length) issues.push("Every event phase may appear only once.");
  for (const phaseKey of eventPhaseKeys) {
    if (!keys.includes(phaseKey))
      issues.push(`The ${phaseKey.replaceAll("_", " ")} phase is missing.`);
  }
  for (const phase of phases) {
    if (
      !Number.isSafeInteger(phase.startsAt) ||
      !Number.isSafeInteger(phase.endsAt) ||
      phase.startsAt < 0 ||
      phase.endsAt <= phase.startsAt
    ) {
      issues.push(`${phase.displayName} must have a valid start and end.`);
      continue;
    }
    const duration = phase.endsAt - phase.startsAt;
    if (duration < 60_000 || duration > 14 * 24 * 60 * 60_000) {
      issues.push(`${phase.displayName} must last between one minute and fourteen days.`);
    }
    if (phase.displayOrder !== phaseOrder(phase.phaseKey)) {
      issues.push(`${phase.displayName} is not in the canonical event-phase order.`);
    }
  }
  const ordered = phases.toSorted((left, right) => left.displayOrder - right.displayOrder);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous && current && current.startsAt < previous.endsAt) {
      issues.push(`${current.displayName} overlaps ${previous.displayName}.`);
    }
  }
  const first = ordered[0];
  const last = ordered.at(-1);
  if (first && last && last.endsAt - first.startsAt > 60 * 24 * 60 * 60_000) {
    issues.push("The event-phase schedule cannot span more than sixty days.");
  }
  return issues;
}

export function normalizePhaseSchedule(phases: readonly PhaseScheduleInput[]): NormalizedPhase[] {
  const normalized = phases
    .map((phase) => ({
      phaseKey: phase.phaseKey,
      displayName: normalizedText(phase.displayName, "Phase name", 2, 80),
      description: normalizedText(phase.description, "Phase description", 5, 500),
      startsAt: phase.startsAt,
      endsAt: phase.endsAt,
      displayOrder: phaseOrder(phase.phaseKey),
    }))
    .toSorted((left, right) => left.displayOrder - right.displayOrder);
  const issue = phaseScheduleIssues(normalized)[0];
  if (issue) invalidSchedule(issue);
  return normalized;
}

export function phaseScheduleChecksum(phases: readonly NormalizedPhase[]) {
  return fingerprintText(JSON.stringify(phases));
}

export async function loadPhaseScheduleWindows(
  ctx: ReadCtx,
  scheduleVersionId: Id<"eventPhaseScheduleVersions">,
) {
  return ctx.db
    .query("eventPhaseWindows")
    .withIndex("by_schedule_order", (index) => index.eq("scheduleVersionId", scheduleVersionId))
    .collect();
}

export function phaseWindowInput(phase: Doc<"eventPhaseWindows">): NormalizedPhase {
  return {
    phaseKey: phase.phaseKey,
    displayName: phase.displayName,
    description: phase.description,
    startsAt: phase.startsAt,
    endsAt: phase.endsAt,
    displayOrder: phase.displayOrder,
  };
}

export async function loadPublishedPhaseSchedule(ctx: ReadCtx, event: Doc<"events">) {
  if (!event.publishedEventPhaseScheduleId) return null;
  const schedule = await ctx.db.get(event.publishedEventPhaseScheduleId);
  if (!schedule || schedule.eventId !== event._id || schedule.status !== "published") {
    throw new Error("The event's published phase schedule is invalid.");
  }
  const windows = await loadPhaseScheduleWindows(ctx, schedule._id);
  const phases = normalizePhaseSchedule(windows.map(phaseWindowInput));
  if (
    windows.some((window) => window.eventId !== event._id || window.status !== "published") ||
    phaseScheduleChecksum(phases) !== schedule.checksum
  ) {
    throw new Error("The event's published phase schedule is incomplete.");
  }
  return { schedule, windows };
}

export function phaseSchedulePublicationIssues(
  published: readonly NormalizedPhase[],
  draft: readonly NormalizedPhase[],
  now: number,
) {
  const issues: string[] = [];
  const draftByKey = new Map(draft.map((phase) => [phase.phaseKey, phase]));
  for (const prior of published) {
    const next = draftByKey.get(prior.phaseKey);
    if (!next) continue;
    if (prior.endsAt <= now) {
      if (JSON.stringify(prior) !== JSON.stringify(next)) {
        issues.push(`${prior.displayName} has ended and cannot be rewritten.`);
      }
      continue;
    }
    if (prior.startsAt <= now) {
      const sameStartedPhase =
        prior.phaseKey === next.phaseKey &&
        prior.displayName === next.displayName &&
        prior.description === next.description &&
        prior.startsAt === next.startsAt &&
        prior.displayOrder === next.displayOrder;
      if (!sameStartedPhase) {
        issues.push(`${prior.displayName} has started; only its end time may change.`);
      } else if (next.endsAt <= now) {
        issues.push(`${prior.displayName} cannot be ended retroactively.`);
      }
    }
  }
  const publishedByKey = new Map(published.map((phase) => [phase.phaseKey, phase]));
  for (const next of draft) {
    if (next.startsAt >= now) continue;
    const prior = publishedByKey.get(next.phaseKey);
    if (!prior || prior.startsAt > now || prior.startsAt !== next.startsAt) {
      issues.push(`${next.displayName} cannot be moved into the past.`);
    }
  }
  return [...new Set(issues)];
}

export function describePhaseScheduleChanges(
  published: readonly NormalizedPhase[],
  draft: readonly NormalizedPhase[],
) {
  if (published.length === 0) return ["Create the first participant-visible event-phase schedule."];
  const publishedByKey = new Map(published.map((phase) => [phase.phaseKey, phase]));
  const changes = draft.flatMap((phase) => {
    const prior = publishedByKey.get(phase.phaseKey);
    return prior && JSON.stringify(prior) === JSON.stringify(phase)
      ? []
      : [`Update ${phase.displayName}.`];
  });
  return changes.length > 0 ? changes : ["No participant-visible phase changes."];
}

export async function savePhaseScheduleDraft(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    actorPersonId: Id<"people">;
    phases: readonly PhaseScheduleInput[];
    expectedDraftScheduleId?: Id<"eventPhaseScheduleVersions">;
    now: number;
  },
) {
  const phases = normalizePhaseSchedule(args.phases);
  const checksum = phaseScheduleChecksum(phases);
  const currentDraft = await ctx.db
    .query("eventPhaseScheduleVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", args.event._id).eq("status", "draft"),
    )
    .unique();
  if (currentDraft?._id !== args.expectedDraftScheduleId) {
    throw new ConvexError({
      code: "PHASE_DRAFT_CHANGED",
      message: "The phase draft changed in another session. Refresh before saving.",
    });
  }
  if (currentDraft?.checksum === checksum) {
    return {
      scheduleVersionId: currentDraft._id,
      scheduleVersion: currentDraft.version,
      checksum,
      changed: false,
    };
  }
  const latest = await ctx.db
    .query("eventPhaseScheduleVersions")
    .withIndex("by_event_version", (index) => index.eq("eventId", args.event._id))
    .order("desc")
    .first();
  const version = (latest?.version ?? 0) + 1;
  if (currentDraft) {
    const currentWindows = await loadPhaseScheduleWindows(ctx, currentDraft._id);
    await ctx.db.patch(currentDraft._id, { status: "retired" });
    for (const window of currentWindows) await ctx.db.patch(window._id, { status: "retired" });
  }
  const scheduleVersionId = await ctx.db.insert("eventPhaseScheduleVersions", {
    eventId: args.event._id,
    version,
    status: "draft",
    checksum,
    createdByPersonId: args.actorPersonId,
    createdAt: args.now,
  });
  for (const phase of phases) {
    await ctx.db.insert("eventPhaseWindows", {
      eventId: args.event._id,
      scheduleVersionId,
      ...phase,
      status: "draft",
      createdAt: args.now,
    });
  }
  return { scheduleVersionId, scheduleVersion: version, checksum, changed: true };
}

export async function publishPhaseSchedule(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    draftScheduleId: Id<"eventPhaseScheduleVersions">;
    expectedDraftChecksum: string;
    now: number;
  },
) {
  const draft = await ctx.db.get(args.draftScheduleId);
  const currentDraft = await ctx.db
    .query("eventPhaseScheduleVersions")
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
      code: "PHASE_DRAFT_CHANGED",
      message: "The phase draft changed in another session. Refresh before publishing.",
    });
  }
  const draftWindows = await loadPhaseScheduleWindows(ctx, draft._id);
  const phases = normalizePhaseSchedule(draftWindows.map(phaseWindowInput));
  if (
    draftWindows.some((window) => window.eventId !== args.event._id || window.status !== "draft") ||
    phaseScheduleChecksum(phases) !== draft.checksum
  ) {
    throw new ConvexError({
      code: "PHASE_DRAFT_INVALID",
      message: "The phase draft no longer matches its validated contents.",
    });
  }
  const publishedId = args.event.publishedEventPhaseScheduleId;
  const published = publishedId ? await ctx.db.get(publishedId) : null;
  if (
    publishedId &&
    (!published || published.eventId !== args.event._id || published.status !== "published")
  ) {
    throw new Error("The event's published phase schedule is invalid.");
  }
  if (published) {
    const publishedWindows = await loadPhaseScheduleWindows(ctx, published._id);
    const publishedPhases = normalizePhaseSchedule(publishedWindows.map(phaseWindowInput));
    if (
      publishedWindows.some(
        (window) => window.eventId !== args.event._id || window.status !== "published",
      ) ||
      phaseScheduleChecksum(publishedPhases) !== published.checksum
    ) {
      throw new Error("The event's published phase schedule is incomplete.");
    }
    const issues = phaseSchedulePublicationIssues(publishedPhases, phases, args.now);
    const issue = issues[0];
    if (issue) {
      throw new ConvexError({ code: "PHASE_SCHEDULE_RETROACTIVE", message: issue });
    }
    await ctx.db.patch(published._id, { status: "superseded" });
  }
  await ctx.db.patch(draft._id, { status: "published", publishedAt: args.now });
  for (const window of draftWindows) await ctx.db.patch(window._id, { status: "published" });
  await ctx.db.patch(args.event._id, {
    publishedEventPhaseScheduleId: draft._id,
    version: args.event.version + 1,
    updatedAt: args.now,
  });
  return { scheduleVersionId: draft._id, scheduleVersion: draft.version };
}
