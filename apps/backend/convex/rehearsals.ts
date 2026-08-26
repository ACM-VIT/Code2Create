import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireFreshAuthSession,
  sensitiveCommandSessionMaxAgeMs,
} from "./lib/identity";
import {
  canCompleteRehearsal,
  canTransitionRehearsalScenario,
  rehearsalTemplateWorkstreams,
  releaseRehearsalTemplate,
  releaseRehearsalTemplateVersion,
} from "./lib/rehearsal";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
} from "./lib/operations";
import {
  boundedActivePermissionGrants,
  requirePermission,
} from "./lib/permissions";
import { normalizedLongText, normalizedText } from "./lib/strings";
import {
  rehearsalRunState,
  rehearsalScenarioState,
  rehearsalWorkstream,
  type RehearsalRunState,
  type RehearsalScenarioState,
} from "./values";

type ReadCtx = QueryCtx | MutationCtx;
type RehearsalPermissionKey =
  | "rehearsal.read"
  | "rehearsal.manage"
  | "rehearsal.execute"
  | "rehearsal.complete";
const maximumActiveRehearsalPermissionGrants = 2_000;

const scenarioCounts = v.object({
  total: v.number(),
  pending: v.number(),
  running: v.number(),
  passed: v.number(),
  failed: v.number(),
  blocked: v.number(),
});

const runView = v.object({
  id: v.id("rehearsalRuns"),
  name: v.string(),
  templateVersion: v.string(),
  state: rehearsalRunState,
  version: v.number(),
  scheduledFor: v.optional(v.number()),
  createdAt: v.number(),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  cancelledAt: v.optional(v.number()),
  lastActivityAt: v.number(),
  completionSummary: v.optional(v.string()),
  cancellationReason: v.optional(v.string()),
  counts: scenarioCounts,
  assignedWorkstreamCount: v.number(),
  requiredWorkstreamCount: v.number(),
  canManage: v.boolean(),
  canExecute: v.boolean(),
  canComplete: v.boolean(),
});

const workstreamOwnerView = v.object({
  id: v.id("rehearsalWorkstreamOwners"),
  workstream: rehearsalWorkstream,
  personId: v.id("people"),
  displayName: v.string(),
  email: v.string(),
  accessActive: v.boolean(),
  version: v.number(),
  assignedAt: v.number(),
});

const scenarioView = v.object({
  id: v.id("rehearsalScenarios"),
  stableKey: v.string(),
  sequence: v.number(),
  workstream: rehearsalWorkstream,
  title: v.string(),
  expectedState: v.string(),
  recoveryAction: v.string(),
  state: rehearsalScenarioState,
  resultSummary: v.optional(v.string()),
  lastUpdatedByName: v.optional(v.string()),
  version: v.number(),
  updatedAt: v.number(),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
});

const commandRunResult = v.object({
  rehearsalRunId: v.id("rehearsalRuns"),
  state: rehearsalRunState,
  version: v.number(),
});

type CommandRunResult = {
  rehearsalRunId: Id<"rehearsalRuns">;
  state: RehearsalRunState;
  version: number;
};

function runCommandResult(
  rehearsalRunId: Id<"rehearsalRuns">,
  state: RehearsalRunState,
  version: number,
): CommandRunResult {
  return { rehearsalRunId, state, version };
}

function isRehearsalRunState(value: unknown): value is RehearsalRunState {
  return (
    value === "draft" ||
    value === "active" ||
    value === "completed" ||
    value === "cancelled"
  );
}

function isRehearsalScenarioState(value: unknown): value is RehearsalScenarioState {
  return (
    value === "pending" ||
    value === "running" ||
    value === "passed" ||
    value === "failed" ||
    value === "blocked"
  );
}

function storedStateVersion<State extends string>(
  resultJson: string | undefined,
  label: string,
  isState: (value: unknown) => value is State,
) {
  let stored: unknown;
  try {
    stored = JSON.parse(resultJson ?? "");
  } catch {
    throw new Error(`The stored ${label} result is invalid.`);
  }
  if (
    typeof stored !== "object" ||
    stored === null ||
    !("state" in stored) ||
    !("version" in stored) ||
    !isState(stored.state) ||
    typeof stored.version !== "number" ||
    !Number.isSafeInteger(stored.version) ||
    stored.version < 1
  ) {
    throw new Error(`The stored ${label} result is invalid.`);
  }
  return { state: stored.state, version: stored.version };
}

function storedRunCommandResult(
  rehearsalRunId: Id<"rehearsalRuns">,
  resultJson: string | undefined,
) {
  const result = storedStateVersion(resultJson, "rehearsal", isRehearsalRunState);
  return runCommandResult(rehearsalRunId, result.state, result.version);
}

function stateVersionJson(result: { state: string; version: number }) {
  return JSON.stringify({ state: result.state, version: result.version });
}

async function activePermissionGrants(
  ctx: ReadCtx,
  eventId: Id<"events">,
  eventAccessSubjectId: Id<"eventAccessSubjects">,
  permissionKey: RehearsalPermissionKey,
) {
  return boundedActivePermissionGrants(ctx, {
    eventId,
    eventAccessSubjectId,
    permissionKey,
    maximumGrantCount: maximumActiveRehearsalPermissionGrants,
  });
}

function hasEventGrant(grants: readonly Doc<"permissionGrants">[]) {
  return grants.some(
    (grant) => grant.scopeType === "event" && grant.scopeId === undefined,
  );
}

function exactRunIds(grants: readonly Doc<"permissionGrants">[]) {
  return new Set(
    grants.flatMap((grant) =>
      grant.scopeType === "rehearsal_run" && grant.scopeId !== undefined
        ? [grant.scopeId]
        : [],
    ),
  );
}

function canUseRunGrant(
  grants: readonly Doc<"permissionGrants">[],
  rehearsalRunId: Id<"rehearsalRuns">,
) {
  return hasEventGrant(grants) || exactRunIds(grants).has(rehearsalRunId);
}

async function requireRun(
  ctx: ReadCtx,
  eventId: Id<"events">,
  rehearsalRunId: Id<"rehearsalRuns">,
) {
  const rehearsalRun = await ctx.db.get("rehearsalRuns", rehearsalRunId);
  if (!rehearsalRun || rehearsalRun.eventId !== eventId) {
    throw new ConvexError({
      code: "REHEARSAL_NOT_FOUND",
      message: "That rehearsal run is unavailable.",
    });
  }
  return rehearsalRun;
}

function countScenarios(scenarios: readonly Doc<"rehearsalScenarios">[]) {
  const counts = {
    total: scenarios.length,
    pending: 0,
    running: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
  };
  for (const scenario of scenarios) counts[scenario.state] += 1;
  return counts;
}

async function toRunView(
  ctx: ReadCtx,
  rehearsalRun: Doc<"rehearsalRuns">,
  grants: {
    manage: readonly Doc<"permissionGrants">[];
    execute: readonly Doc<"permissionGrants">[];
    complete: readonly Doc<"permissionGrants">[];
  },
) {
  const [scenarios, owners] = await Promise.all([
    ctx.db
      .query("rehearsalScenarios")
      .withIndex("by_run_sequence", (index) =>
        index.eq("rehearsalRunId", rehearsalRun._id),
      )
      .collect(),
    ctx.db
      .query("rehearsalWorkstreamOwners")
      .withIndex("by_run_workstream", (index) =>
        index.eq("rehearsalRunId", rehearsalRun._id),
      )
      .collect(),
  ]);
  const requiredWorkstreams = new Set(scenarios.map((scenario) => scenario.workstream));
  const assignedWorkstreams = new Set(owners.map((owner) => owner.workstream));
  const lastScenarioActivity = scenarios.reduce(
    (latest, scenario) => Math.max(latest, scenario.updatedAt),
    rehearsalRun.updatedAt,
  );
  return {
    id: rehearsalRun._id,
    name: rehearsalRun.name,
    templateVersion: rehearsalRun.templateVersion,
    state: rehearsalRun.state,
    version: rehearsalRun.version,
    ...(rehearsalRun.scheduledFor !== undefined
      ? { scheduledFor: rehearsalRun.scheduledFor }
      : {}),
    createdAt: rehearsalRun.createdAt,
    ...(rehearsalRun.startedAt !== undefined
      ? { startedAt: rehearsalRun.startedAt }
      : {}),
    ...(rehearsalRun.completedAt !== undefined
      ? { completedAt: rehearsalRun.completedAt }
      : {}),
    ...(rehearsalRun.cancelledAt !== undefined
      ? { cancelledAt: rehearsalRun.cancelledAt }
      : {}),
    lastActivityAt: lastScenarioActivity,
    ...(rehearsalRun.completionSummary !== undefined
      ? { completionSummary: rehearsalRun.completionSummary }
      : {}),
    ...(rehearsalRun.cancellationReason !== undefined
      ? { cancellationReason: rehearsalRun.cancellationReason }
      : {}),
    counts: countScenarios(scenarios),
    assignedWorkstreamCount: [...requiredWorkstreams].filter((workstream) =>
      assignedWorkstreams.has(workstream),
    ).length,
    requiredWorkstreamCount: requiredWorkstreams.size,
    canManage: canUseRunGrant(grants.manage, rehearsalRun._id),
    canExecute: canUseRunGrant(grants.execute, rehearsalRun._id),
    canComplete: canUseRunGrant(grants.complete, rehearsalRun._id),
  };
}

export const list = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    serverNow: v.number(),
    canRead: v.boolean(),
    canCreate: v.boolean(),
    runs: v.array(runView),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const [readGrants, manageGrants, executeGrants, completeGrants] =
      await Promise.all([
        activePermissionGrants(ctx, event._id, subject._id, "rehearsal.read"),
        activePermissionGrants(ctx, event._id, subject._id, "rehearsal.manage"),
        activePermissionGrants(ctx, event._id, subject._id, "rehearsal.execute"),
        activePermissionGrants(ctx, event._id, subject._id, "rehearsal.complete"),
      ]);
    let runs: Doc<"rehearsalRuns">[] = [];
    if (hasEventGrant(readGrants)) {
      runs = await ctx.db
        .query("rehearsalRuns")
        .withIndex("by_event_created", (index) =>
          index.eq("eventId", event._id),
        )
        .order("desc")
        .take(20);
    } else {
      const exactIds = exactRunIds(readGrants);
      const exactRuns = await Promise.all(
        [...exactIds].map((scopeId) => {
          const rehearsalRunId = ctx.db.normalizeId("rehearsalRuns", scopeId);
          return rehearsalRunId
            ? ctx.db.get("rehearsalRuns", rehearsalRunId)
            : Promise.resolve(null);
        }),
      );
      runs = exactRuns
        .flatMap((rehearsalRun) =>
          rehearsalRun && rehearsalRun.eventId === event._id
            ? [rehearsalRun]
            : [],
        )
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, 20);
    }
    return {
      serverNow: Date.now(),
      canRead: readGrants.length > 0,
      canCreate: hasEventGrant(manageGrants),
      runs: await Promise.all(
        runs.map((rehearsalRun) =>
          toRunView(ctx, rehearsalRun, {
            manage: manageGrants,
            execute: executeGrants,
            complete: completeGrants,
          }),
        ),
      ),
    };
  },
});

export const detail = query({
  args: {
    eventSlug: v.string(),
    rehearsalRunId: v.id("rehearsalRuns"),
  },
  returns: v.object({
    run: runView,
    workstreamOwners: v.array(workstreamOwnerView),
    scenarios: v.array(scenarioView),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const rehearsalRun = await requireRun(ctx, event._id, args.rehearsalRunId);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "rehearsal.read",
      scopeType: "rehearsal_run",
      scopeId: rehearsalRun._id,
    });
    const [manageGrants, executeGrants, completeGrants, scenarios, owners] =
      await Promise.all([
        activePermissionGrants(ctx, event._id, subject._id, "rehearsal.manage"),
        activePermissionGrants(ctx, event._id, subject._id, "rehearsal.execute"),
        activePermissionGrants(ctx, event._id, subject._id, "rehearsal.complete"),
        ctx.db
          .query("rehearsalScenarios")
          .withIndex("by_run_sequence", (index) =>
            index.eq("rehearsalRunId", rehearsalRun._id),
          )
          .collect(),
        ctx.db
          .query("rehearsalWorkstreamOwners")
          .withIndex("by_run_workstream", (index) =>
            index.eq("rehearsalRunId", rehearsalRun._id),
          )
          .collect(),
      ]);
    const personIds = new Set<Id<"people">>();
    for (const owner of owners) personIds.add(owner.personId);
    for (const scenario of scenarios) {
      if (scenario.lastUpdatedByPersonId !== undefined) {
        personIds.add(scenario.lastUpdatedByPersonId);
      }
    }
    const people = await Promise.all(
      [...personIds].map((personId) => ctx.db.get("people", personId)),
    );
    const peopleById = new Map(
      people.flatMap((candidate) =>
        candidate ? [[candidate._id, candidate] as const] : [],
      ),
    );
    const ownerSubjects = await Promise.all(
      owners.map((owner) =>
        ctx.db
          .query("eventAccessSubjects")
          .withIndex("by_event_person", (index) =>
            index.eq("eventId", event._id).eq("personId", owner.personId),
          )
          .unique(),
      ),
    );
    const accessActiveByPersonId = new Map(
      owners.map((owner, index) => [
        owner.personId,
        ownerSubjects[index]?.status === "active",
      ]),
    );
    return {
      run: await toRunView(ctx, rehearsalRun, {
        manage: manageGrants,
        execute: executeGrants,
        complete: completeGrants,
      }),
      workstreamOwners: owners.map((owner) => {
        const ownerPerson = peopleById.get(owner.personId);
        return {
          id: owner._id,
          workstream: owner.workstream,
          personId: owner.personId,
          displayName: ownerPerson?.displayName ?? "Unavailable event account",
          email: ownerPerson?.verifiedEmail ?? "Unavailable",
          accessActive: accessActiveByPersonId.get(owner.personId) ?? false,
          version: owner.version,
          assignedAt: owner.assignedAt,
        };
      }),
      scenarios: scenarios.map((scenario) => ({
        id: scenario._id,
        stableKey: scenario.stableKey,
        sequence: scenario.sequence,
        workstream: scenario.workstream,
        title: scenario.title,
        expectedState: scenario.expectedState,
        recoveryAction: scenario.recoveryAction,
        state: scenario.state,
        ...(scenario.resultSummary !== undefined
          ? { resultSummary: scenario.resultSummary }
          : {}),
        ...(scenario.lastUpdatedByPersonId !== undefined
          ? {
              lastUpdatedByName:
                peopleById.get(scenario.lastUpdatedByPersonId)?.displayName ??
                "Event operator",
            }
          : {}),
        version: scenario.version,
        updatedAt: scenario.updatedAt,
        ...(scenario.startedAt !== undefined
          ? { startedAt: scenario.startedAt }
          : {}),
        ...(scenario.completedAt !== undefined
          ? { completedAt: scenario.completedAt }
          : {}),
      })),
    };
  },
});

export const scenarioHistory = query({
  args: {
    eventSlug: v.string(),
    rehearsalRunId: v.id("rehearsalRuns"),
    rehearsalScenarioId: v.id("rehearsalScenarios"),
  },
  returns: v.array(
    v.object({
      id: v.id("rehearsalScenarioActions"),
      kind: v.union(
        v.literal("started"),
        v.literal("passed"),
        v.literal("failed"),
        v.literal("blocked"),
        v.literal("rerun"),
      ),
      previousState: rehearsalScenarioState,
      nextState: rehearsalScenarioState,
      note: v.optional(v.string()),
      actorName: v.string(),
      scenarioVersion: v.number(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const rehearsalRun = await requireRun(ctx, event._id, args.rehearsalRunId);
    const scenario = await ctx.db.get(
      "rehearsalScenarios",
      args.rehearsalScenarioId,
    );
    if (!scenario || scenario.rehearsalRunId !== rehearsalRun._id) {
      throw new ConvexError({
        code: "REHEARSAL_SCENARIO_NOT_FOUND",
        message: "That rehearsal scenario is unavailable.",
      });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "rehearsal.read",
      scopeType: "rehearsal_run",
      scopeId: rehearsalRun._id,
    });
    const actions = await ctx.db
      .query("rehearsalScenarioActions")
      .withIndex("by_scenario_time", (index) =>
        index.eq("rehearsalScenarioId", scenario._id),
      )
      .order("desc")
      .take(100);
    const actorIds = new Set(actions.map((action) => action.actorPersonId));
    const actors = await Promise.all(
      [...actorIds].map((actorPersonId) =>
        ctx.db.get("people", actorPersonId),
      ),
    );
    const actorsById = new Map(
      actors.flatMap((actor) => (actor ? [[actor._id, actor] as const] : [])),
    );
    return actions.reverse().map((action) => ({
      id: action._id,
      kind: action.kind,
      previousState: action.previousState,
      nextState: action.nextState,
      ...(action.note !== undefined ? { note: action.note } : {}),
      actorName:
        actorsById.get(action.actorPersonId)?.displayName ?? "Event operator",
      scenarioVersion: action.scenarioVersion,
      createdAt: action.createdAt,
    }));
  },
});

const ownerOption = v.object({
  id: v.id("people"),
  displayName: v.string(),
  email: v.string(),
});

export const ownerOptions = query({
  args: {
    eventSlug: v.string(),
    rehearsalRunId: v.id("rehearsalRuns"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(ownerOption),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const rehearsalRun = await requireRun(ctx, event._id, args.rehearsalRunId);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "rehearsal.manage",
      scopeType: "rehearsal_run",
      scopeId: rehearsalRun._id,
    });
    const page = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_status_email", (index) =>
        index.eq("eventId", event._id).eq("status", "active"),
      )
      .paginate(args.paginationOpts);
    return {
      ...page,
      page: page.page.map((candidate) => ({
        id: candidate.personId,
        displayName: candidate.displayName,
        email: candidate.emailNormalized,
      })),
    };
  },
});

export const create = mutation({
  args: {
    eventSlug: v.string(),
    name: v.string(),
    scheduledFor: v.optional(v.number()),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    rehearsalRunId: v.id("rehearsalRuns"),
    state: rehearsalRunState,
    version: v.number(),
    scenarioCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "rehearsal.manage",
      scopeType: "event",
    });
    const name = normalizedText(args.name, "Rehearsal name", 3, 100);
    const reason = normalizedText(args.reason, "Audit reason", 5, 300);
    const operationId = normalizedText(
      args.clientOperationId,
      "Operation ID",
      8,
      100,
    );
    const now = Date.now();
    const requestFingerprint = operationFingerprint([
      name,
      args.scheduledFor ?? null,
      reason,
      releaseRehearsalTemplateVersion,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "rehearsal.create",
      requestFingerprint,
    });
    if (prior) {
      const rehearsalRunId = ctx.db.normalizeId(
        "rehearsalRuns",
        prior.targetId,
      );
      if (!rehearsalRunId) throw new Error("The stored rehearsal result is invalid.");
      return {
        ...storedRunCommandResult(rehearsalRunId, prior.resultJson),
        scenarioCount: releaseRehearsalTemplate.length,
      };
    }
    if (
      args.scheduledFor !== undefined &&
      (!Number.isSafeInteger(args.scheduledFor) || args.scheduledFor <= now)
    ) {
      throw new ConvexError({
        code: "INVALID_REHEARSAL_SCHEDULE",
        message: "Choose a future rehearsal time or leave the schedule empty.",
      });
    }
    const rehearsalRunId = await ctx.db.insert("rehearsalRuns", {
      eventId: event._id,
      name,
      templateVersion: releaseRehearsalTemplateVersion,
      ...(args.scheduledFor !== undefined
        ? { scheduledFor: args.scheduledFor }
        : {}),
      state: "draft",
      version: 1,
      createdByPersonId: person._id,
      createdAt: now,
      updatedAt: now,
    });
    await Promise.all(
      releaseRehearsalTemplate.map((templateScenario) =>
        ctx.db.insert("rehearsalScenarios", {
          eventId: event._id,
          rehearsalRunId,
          stableKey: templateScenario.stableKey,
          sequence: templateScenario.sequence,
          workstream: templateScenario.workstream,
          title: templateScenario.title,
          expectedState: templateScenario.expectedState,
          recoveryAction: templateScenario.recoveryAction,
          state: "pending",
          version: 1,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    );
    const result = runCommandResult(rehearsalRunId, "draft", 1);
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "rehearsal.create",
      requestFingerprint,
      targetType: "rehearsal_run",
      targetId: rehearsalRunId,
      resultJson: stateVersionJson(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "rehearsal.manage",
      grantIds,
      scopeType: "event",
      action: "rehearsal.created",
      targetType: "rehearsal_run",
      targetId: rehearsalRunId,
      nextSummary: JSON.stringify({
        state: "draft",
        version: 1,
        templateVersion: releaseRehearsalTemplateVersion,
        scenarioCount: releaseRehearsalTemplate.length,
      }),
      reason,
    });
    return {
      ...result,
      scenarioCount: releaseRehearsalTemplate.length,
    };
  },
});

export const assignWorkstreamOwner = mutation({
  args: {
    eventSlug: v.string(),
    rehearsalRunId: v.id("rehearsalRuns"),
    workstream: rehearsalWorkstream,
    ownerPersonId: v.id("people"),
    expectedRunVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: commandRunResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const rehearsalRun = await requireRun(ctx, event._id, args.rehearsalRunId);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "rehearsal.manage",
      scopeType: "rehearsal_run",
      scopeId: rehearsalRun._id,
    });
    const reason = normalizedText(args.reason, "Audit reason", 5, 300);
    const operationId = normalizedText(
      args.clientOperationId,
      "Operation ID",
      8,
      100,
    );
    const requestFingerprint = operationFingerprint([
      rehearsalRun._id,
      args.workstream,
      args.ownerPersonId,
      args.expectedRunVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "rehearsal.assignWorkstreamOwner",
      requestFingerprint,
    });
    if (prior) {
      return storedRunCommandResult(rehearsalRun._id, prior.resultJson);
    }
    if (rehearsalRun.state === "completed" || rehearsalRun.state === "cancelled") {
      throw new ConvexError({
        code: "REHEARSAL_IMMUTABLE",
        message: "A completed or cancelled rehearsal cannot be reassigned.",
      });
    }
    if (rehearsalRun.version !== args.expectedRunVersion) {
      throw new ConvexError({
        code: "REHEARSAL_CHANGED",
        message: "The rehearsal changed. Refresh before assigning an owner.",
      });
    }
    const hasWorkstream = rehearsalTemplateWorkstreams().some(
      (workstream) => workstream === args.workstream,
    );
    if (!hasWorkstream) {
      throw new ConvexError({
        code: "REHEARSAL_WORKSTREAM_UNAVAILABLE",
        message: "That workstream is not part of this rehearsal template.",
      });
    }
    const ownerSubject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (index) =>
        index
          .eq("eventId", event._id)
          .eq("personId", args.ownerPersonId),
      )
      .unique();
    if (!ownerSubject || ownerSubject.status !== "active") {
      throw new ConvexError({
        code: "REHEARSAL_OWNER_UNAVAILABLE",
        message: "Choose an active event account as the workstream owner.",
      });
    }
    const existing = await ctx.db
      .query("rehearsalWorkstreamOwners")
      .withIndex("by_run_workstream", (index) =>
        index
          .eq("rehearsalRunId", rehearsalRun._id)
          .eq("workstream", args.workstream),
      )
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch("rehearsalWorkstreamOwners", existing._id, {
        personId: args.ownerPersonId,
        version: existing.version + 1,
        assignedByPersonId: person._id,
        assignedAt: now,
      });
    } else {
      await ctx.db.insert("rehearsalWorkstreamOwners", {
        eventId: event._id,
        rehearsalRunId: rehearsalRun._id,
        workstream: args.workstream,
        personId: args.ownerPersonId,
        version: 1,
        assignedByPersonId: person._id,
        assignedAt: now,
      });
    }
    await ctx.db.patch("rehearsalRuns", rehearsalRun._id, {
      version: rehearsalRun.version + 1,
      updatedAt: now,
    });
    const result = runCommandResult(
      rehearsalRun._id,
      rehearsalRun.state,
      rehearsalRun.version + 1,
    );
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "rehearsal.assignWorkstreamOwner",
      requestFingerprint,
      targetType: "rehearsal_run",
      targetId: rehearsalRun._id,
      resultJson: stateVersionJson(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "rehearsal.manage",
      grantIds,
      scopeType: "rehearsal_run",
      scopeId: rehearsalRun._id,
      action: "rehearsal.workstream_owner_assigned",
      targetType: "rehearsal_run",
      targetId: rehearsalRun._id,
      ...(existing
        ? {
            previousSummary: JSON.stringify({
              workstream: args.workstream,
              ownerPersonId: existing.personId,
              ownerVersion: existing.version,
              runVersion: rehearsalRun.version,
            }),
          }
        : {}),
      nextSummary: JSON.stringify({
        workstream: args.workstream,
        ownerPersonId: args.ownerPersonId,
        ownerVersion: (existing?.version ?? 0) + 1,
        runVersion: rehearsalRun.version + 1,
      }),
      reason,
    });
    return result;
  },
});

export const start = mutation({
  args: {
    eventSlug: v.string(),
    rehearsalRunId: v.id("rehearsalRuns"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: commandRunResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const rehearsalRun = await requireRun(ctx, event._id, args.rehearsalRunId);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "rehearsal.manage",
      scopeType: "rehearsal_run",
      scopeId: rehearsalRun._id,
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    const reason = normalizedText(args.reason, "Audit reason", 5, 300);
    const operationId = normalizedText(
      args.clientOperationId,
      "Operation ID",
      8,
      100,
    );
    const requestFingerprint = operationFingerprint([
      rehearsalRun._id,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "rehearsal.start",
      requestFingerprint,
    });
    if (prior) {
      return storedRunCommandResult(rehearsalRun._id, prior.resultJson);
    }
    if (rehearsalRun.state !== "draft" || rehearsalRun.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "REHEARSAL_CHANGED",
        message: "Only the current draft rehearsal can be started.",
      });
    }
    const activeRun = await ctx.db
      .query("rehearsalRuns")
      .withIndex("by_event_state_created", (index) =>
        index.eq("eventId", event._id).eq("state", "active"),
      )
      .first();
    if (activeRun && activeRun._id !== rehearsalRun._id) {
      throw new ConvexError({
        code: "REHEARSAL_ALREADY_ACTIVE",
        message: "Finish or cancel the active rehearsal before starting another.",
      });
    }
    const [scenarios, owners] = await Promise.all([
      ctx.db
        .query("rehearsalScenarios")
        .withIndex("by_run_sequence", (index) =>
          index.eq("rehearsalRunId", rehearsalRun._id),
        )
        .collect(),
      ctx.db
        .query("rehearsalWorkstreamOwners")
        .withIndex("by_run_workstream", (index) =>
          index.eq("rehearsalRunId", rehearsalRun._id),
        )
        .collect(),
    ]);
    if (scenarios.length !== releaseRehearsalTemplate.length) {
      throw new ConvexError({
        code: "REHEARSAL_TEMPLATE_INCOMPLETE",
        message: "This rehearsal does not contain the complete release scenario set.",
      });
    }
    const requiredWorkstreams = new Set(
      scenarios.map((scenario) => scenario.workstream),
    );
    const ownersByWorkstream = new Map(
      owners.map((owner) => [owner.workstream, owner]),
    );
    const missingWorkstreams = [...requiredWorkstreams].filter(
      (workstream) => !ownersByWorkstream.has(workstream),
    );
    if (missingWorkstreams.length > 0) {
      throw new ConvexError({
        code: "REHEARSAL_OWNER_REQUIRED",
        message: "Assign every rehearsal workstream before starting.",
      });
    }
    const ownerSubjects = await Promise.all(
      owners.map((owner) =>
        ctx.db
          .query("eventAccessSubjects")
          .withIndex("by_event_person", (index) =>
            index.eq("eventId", event._id).eq("personId", owner.personId),
          )
          .unique(),
      ),
    );
    if (ownerSubjects.some((ownerSubject) => ownerSubject?.status !== "active")) {
      throw new ConvexError({
        code: "REHEARSAL_OWNER_UNAVAILABLE",
        message: "Replace inactive workstream owners before starting.",
      });
    }
    const now = Date.now();
    await ctx.db.patch("rehearsalRuns", rehearsalRun._id, {
      state: "active",
      version: rehearsalRun.version + 1,
      startedByPersonId: person._id,
      startedAt: now,
      updatedAt: now,
    });
    const result = runCommandResult(
      rehearsalRun._id,
      "active",
      rehearsalRun.version + 1,
    );
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "rehearsal.start",
      requestFingerprint,
      targetType: "rehearsal_run",
      targetId: rehearsalRun._id,
      resultJson: stateVersionJson(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "rehearsal.manage",
      grantIds,
      scopeType: "rehearsal_run",
      scopeId: rehearsalRun._id,
      action: "rehearsal.started",
      targetType: "rehearsal_run",
      targetId: rehearsalRun._id,
      previousSummary: JSON.stringify({
        state: rehearsalRun.state,
        version: rehearsalRun.version,
      }),
      nextSummary: JSON.stringify({
        state: "active",
        version: rehearsalRun.version + 1,
        scenarioCount: scenarios.length,
        workstreamCount: requiredWorkstreams.size,
      }),
      reason,
    });
    return result;
  },
});

function actionKind(
  previous: RehearsalScenarioState,
  next: RehearsalScenarioState,
) {
  if (next === "passed") return "passed" as const;
  if (next === "failed") return "failed" as const;
  if (next === "blocked") return "blocked" as const;
  if (previous === "pending") return "started" as const;
  return "rerun" as const;
}

function scenarioNote(
  previous: RehearsalScenarioState,
  next: RehearsalScenarioState,
  note: string | undefined,
) {
  const needsNote =
    next === "passed" ||
    next === "failed" ||
    next === "blocked" ||
    (next === "running" && previous !== "pending");
  if (needsNote) {
    return normalizedLongText(note ?? "", "Scenario result", 5, 1_000);
  }
  if (note === undefined || note.trim().length === 0) return undefined;
  return normalizedLongText(note, "Scenario note", 2, 1_000);
}

export const updateScenario = mutation({
  args: {
    eventSlug: v.string(),
    rehearsalRunId: v.id("rehearsalRuns"),
    rehearsalScenarioId: v.id("rehearsalScenarios"),
    nextState: rehearsalScenarioState,
    note: v.optional(v.string()),
    expectedVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    rehearsalScenarioId: v.id("rehearsalScenarios"),
    state: rehearsalScenarioState,
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const rehearsalRun = await requireRun(ctx, event._id, args.rehearsalRunId);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "rehearsal.execute",
      scopeType: "rehearsal_run",
      scopeId: rehearsalRun._id,
    });
    const scenario = await ctx.db.get(
      "rehearsalScenarios",
      args.rehearsalScenarioId,
    );
    if (!scenario || scenario.rehearsalRunId !== rehearsalRun._id) {
      throw new ConvexError({
        code: "REHEARSAL_SCENARIO_NOT_FOUND",
        message: "That rehearsal scenario is unavailable.",
      });
    }
    const note = scenarioNote(scenario.state, args.nextState, args.note);
    const operationId = normalizedText(
      args.clientOperationId,
      "Operation ID",
      8,
      100,
    );
    const requestFingerprint = operationFingerprint([
      rehearsalRun._id,
      scenario._id,
      args.nextState,
      note ?? null,
      args.expectedVersion,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "rehearsal.updateScenario",
      requestFingerprint,
    });
    if (prior) {
      const result = storedStateVersion(
        prior.resultJson,
        "rehearsal scenario",
        isRehearsalScenarioState,
      );
      return {
        rehearsalScenarioId: scenario._id,
        ...result,
      };
    }
    if (rehearsalRun.state !== "active") {
      throw new ConvexError({
        code: "REHEARSAL_NOT_ACTIVE",
        message: "Scenario results can be recorded only during the active rehearsal.",
      });
    }
    if (scenario.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "REHEARSAL_SCENARIO_CHANGED",
        message: "This scenario changed. Refresh before recording another result.",
      });
    }
    if (!canTransitionRehearsalScenario(scenario.state, args.nextState)) {
      throw new ConvexError({
        code: "INVALID_REHEARSAL_TRANSITION",
        message: "Run a completed scenario again before recording a different outcome.",
      });
    }
    const now = Date.now();
    const terminal =
      args.nextState === "passed" ||
      args.nextState === "failed" ||
      args.nextState === "blocked";
    await ctx.db.patch("rehearsalScenarios", scenario._id, {
      state: args.nextState,
      ...(terminal ? { resultSummary: note } : { resultSummary: undefined }),
      lastUpdatedByPersonId: person._id,
      version: scenario.version + 1,
      updatedAt: now,
      ...(args.nextState === "running"
        ? { startedAt: now, completedAt: undefined }
        : {
            startedAt: scenario.startedAt ?? now,
            completedAt: now,
          }),
    });
    await ctx.db.insert("rehearsalScenarioActions", {
      eventId: event._id,
      rehearsalRunId: rehearsalRun._id,
      rehearsalScenarioId: scenario._id,
      kind: actionKind(scenario.state, args.nextState),
      previousState: scenario.state,
      nextState: args.nextState,
      ...(note !== undefined ? { note } : {}),
      actorPersonId: person._id,
      scenarioVersion: scenario.version + 1,
      createdAt: now,
    });
    const result = {
      rehearsalScenarioId: scenario._id,
      state: args.nextState,
      version: scenario.version + 1,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "rehearsal.updateScenario",
      requestFingerprint,
      targetType: "rehearsal_scenario",
      targetId: scenario._id,
      resultJson: stateVersionJson(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "rehearsal.execute",
      grantIds,
      scopeType: "rehearsal_run",
      scopeId: rehearsalRun._id,
      action: `rehearsal.scenario_${actionKind(scenario.state, args.nextState)}`,
      targetType: "rehearsal_scenario",
      targetId: scenario._id,
      previousSummary: JSON.stringify({
        state: scenario.state,
        version: scenario.version,
      }),
      nextSummary: JSON.stringify({
        state: args.nextState,
        version: scenario.version + 1,
      }),
      reason: note ?? "Scenario execution started",
    });
    return result;
  },
});

export const complete = mutation({
  args: {
    eventSlug: v.string(),
    rehearsalRunId: v.id("rehearsalRuns"),
    expectedVersion: v.number(),
    summary: v.string(),
    clientOperationId: v.string(),
  },
  returns: commandRunResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const rehearsalRun = await requireRun(ctx, event._id, args.rehearsalRunId);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "rehearsal.complete",
      scopeType: "rehearsal_run",
      scopeId: rehearsalRun._id,
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    const summary = normalizedLongText(
      args.summary,
      "Completion summary",
      10,
      1_000,
    );
    const operationId = normalizedText(
      args.clientOperationId,
      "Operation ID",
      8,
      100,
    );
    const requestFingerprint = operationFingerprint([
      rehearsalRun._id,
      args.expectedVersion,
      summary,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "rehearsal.complete",
      requestFingerprint,
    });
    if (prior) {
      return storedRunCommandResult(rehearsalRun._id, prior.resultJson);
    }
    if (rehearsalRun.state !== "active" || rehearsalRun.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "REHEARSAL_CHANGED",
        message: "Only the current active rehearsal can be completed.",
      });
    }
    const scenarios = await ctx.db
      .query("rehearsalScenarios")
      .withIndex("by_run_sequence", (index) =>
        index.eq("rehearsalRunId", rehearsalRun._id),
      )
      .collect();
    if (!canCompleteRehearsal(scenarios.map((scenario) => scenario.state))) {
      throw new ConvexError({
        code: "REHEARSAL_INCOMPLETE",
        message: "Every rehearsal scenario must pass before final sign-off.",
      });
    }
    const now = Date.now();
    await ctx.db.patch("rehearsalRuns", rehearsalRun._id, {
      state: "completed",
      version: rehearsalRun.version + 1,
      completionSummary: summary,
      completedByPersonId: person._id,
      completedAt: now,
      updatedAt: now,
    });
    const result = runCommandResult(
      rehearsalRun._id,
      "completed",
      rehearsalRun.version + 1,
    );
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "rehearsal.complete",
      requestFingerprint,
      targetType: "rehearsal_run",
      targetId: rehearsalRun._id,
      resultJson: stateVersionJson(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "rehearsal.complete",
      grantIds,
      scopeType: "rehearsal_run",
      scopeId: rehearsalRun._id,
      action: "rehearsal.completed",
      targetType: "rehearsal_run",
      targetId: rehearsalRun._id,
      previousSummary: JSON.stringify({
        state: rehearsalRun.state,
        version: rehearsalRun.version,
      }),
      nextSummary: JSON.stringify({
        state: "completed",
        version: rehearsalRun.version + 1,
        scenarioCount: scenarios.length,
      }),
      reason: summary,
    });
    return result;
  },
});

export const cancel = mutation({
  args: {
    eventSlug: v.string(),
    rehearsalRunId: v.id("rehearsalRuns"),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: commandRunResult,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const rehearsalRun = await requireRun(ctx, event._id, args.rehearsalRunId);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "rehearsal.manage",
      scopeType: "rehearsal_run",
      scopeId: rehearsalRun._id,
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    const reason = normalizedLongText(args.reason, "Cancellation reason", 5, 500);
    const operationId = normalizedText(
      args.clientOperationId,
      "Operation ID",
      8,
      100,
    );
    const requestFingerprint = operationFingerprint([
      rehearsalRun._id,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "rehearsal.cancel",
      requestFingerprint,
    });
    if (prior) {
      return storedRunCommandResult(rehearsalRun._id, prior.resultJson);
    }
    if (
      (rehearsalRun.state !== "draft" && rehearsalRun.state !== "active") ||
      rehearsalRun.version !== args.expectedVersion
    ) {
      throw new ConvexError({
        code: "REHEARSAL_CHANGED",
        message: "Only the current draft or active rehearsal can be cancelled.",
      });
    }
    const now = Date.now();
    await ctx.db.patch("rehearsalRuns", rehearsalRun._id, {
      state: "cancelled",
      version: rehearsalRun.version + 1,
      cancellationReason: reason,
      cancelledByPersonId: person._id,
      cancelledAt: now,
      updatedAt: now,
    });
    const result = runCommandResult(
      rehearsalRun._id,
      "cancelled",
      rehearsalRun.version + 1,
    );
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "rehearsal.cancel",
      requestFingerprint,
      targetType: "rehearsal_run",
      targetId: rehearsalRun._id,
      resultJson: stateVersionJson(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "rehearsal.manage",
      grantIds,
      scopeType: "rehearsal_run",
      scopeId: rehearsalRun._id,
      action: "rehearsal.cancelled",
      targetType: "rehearsal_run",
      targetId: rehearsalRun._id,
      previousSummary: JSON.stringify({
        state: rehearsalRun.state,
        version: rehearsalRun.version,
      }),
      nextSummary: JSON.stringify({
        state: "cancelled",
        version: rehearsalRun.version + 1,
      }),
      reason,
    });
    return result;
  },
});
