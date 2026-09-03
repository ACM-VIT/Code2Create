import type { OperationsAutonomyReadTool, OperationsHealthSnapshot } from "@code2create/domain";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { operationFingerprint } from "./operations";

function qualifyingSignalKeys(
  policy: Doc<"operationsAutonomyPolicyVersions">,
  snapshot: OperationsHealthSnapshot,
) {
  return snapshot.signals
    .filter(
      (signal) =>
        policy.triggerSeverities.includes(signal.severity) &&
        policy.triggerAreas.includes(signal.area),
    )
    .map((signal) => signal.key)
    .sort();
}

function signalFingerprint(
  policy: Doc<"operationsAutonomyPolicyVersions">,
  snapshot: OperationsHealthSnapshot,
  signalKeys: readonly string[],
  sourceHighWatermarks: readonly (readonly [string, number])[],
) {
  return operationFingerprint([
    policy.checksum,
    JSON.stringify(
      signalKeys.map((key) => {
        const signal = snapshot.signals.find((candidate) => candidate.key === key);
        return signal
          ? [
              signal.key,
              signal.area,
              signal.severity,
              signal.title,
              signal.detail,
              signal.owner,
              signal.nextAction,
              signal.count,
              signal.atLeast,
              signal.oldestAt ?? null,
            ]
          : [key];
      }),
    ),
    JSON.stringify(sourceHighWatermarks),
  ]);
}

function sourceArea(source: Doc<"operationsAutonomyReadFactStates">["source"]) {
  switch (source) {
    case "intake_jobs":
      return "intake" as const;
    case "admission_jobs":
      return "admissions" as const;
    case "participant_deliveries":
    case "support_load":
      return "communications" as const;
    case "integration_jobs":
      return "integrations" as const;
    case "round_export_jobs":
      return "scores" as const;
    case "synesthesia_operations":
      return "synesthesia" as const;
    case "incident_readiness":
      return "system" as const;
    case "attendance_operations":
      return "attendance" as const;
    case "operations_attention":
    case "review_exceptions":
      return "reviews" as const;
  }
}

async function readSourceFactHighWatermarks(
  ctx: MutationCtx,
  eventId: Id<"events">,
  allowedReadTools: readonly OperationsAutonomyReadTool[],
) {
  const allowed = new Set<OperationsAutonomyReadTool>(allowedReadTools);
  return (
    await ctx.db
      .query("operationsAutonomyReadFactStates")
      .withIndex("by_event_source", (index) => index.eq("eventId", eventId))
      .collect()
  )
    .filter((row) => allowed.has(row.source))
    .map((row) => ({ read: row.source, sequence: row.sequence }))
    .sort((left, right) => left.read.localeCompare(right.read));
}

export async function enqueueOperationsAutonomySignal(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    snapshot: OperationsHealthSnapshot;
    now: number;
  },
) {
  const policy = await ctx.db
    .query("operationsAutonomyPolicyVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", args.eventId).eq("status", "published"),
    )
    .unique();
  if (!policy || !policy.enabled) return null;
  const state = await ctx.db
    .query("operationsAutonomyStates")
    .withIndex("by_policy", (index) => index.eq("policyVersionId", policy._id))
    .unique();
  if (!state || state.lifecycle.kind !== "active") return null;
  const signalKeys = qualifyingSignalKeys(policy, args.snapshot);
  if (signalKeys.length === 0) {
    if (state.lastTriggerFingerprint !== undefined) {
      await ctx.db.patch(state._id, {
        lastTriggerFingerprint: undefined,
        lastSignalAt: args.now,
        updatedAt: args.now,
        version: state.version + 1,
      });
    }
    return null;
  }
  const qualifyingAreas = new Set(
    args.snapshot.signals
      .filter((signal) => signalKeys.includes(signal.key))
      .map((signal) => signal.area),
  );
  const sourceFactHighWatermarks = await readSourceFactHighWatermarks(
    ctx,
    args.eventId,
    policy.allowedReadTools,
  );
  const sourceHighWatermarks = sourceFactHighWatermarks
    .filter((row) => qualifyingAreas.has(sourceArea(row.read)))
    .map((row) => [row.read, row.sequence] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const fingerprint = signalFingerprint(policy, args.snapshot, signalKeys, sourceHighWatermarks);
  if (state.lastTriggerFingerprint === fingerprint) return null;
  const episode = state.cycle + 1;
  const operationKey = `signal:${policy._id}:${episode}:${fingerprint}`;
  const existing = await ctx.db
    .query("operationsAutonomyInbox")
    .withIndex("by_event_operation_key", (index) =>
      index.eq("eventId", args.eventId).eq("operationKey", operationKey),
    )
    .unique();
  if (existing) return existing._id;
  const sourceChecksum = operationFingerprint([
    JSON.stringify(args.snapshot),
    JSON.stringify(sourceFactHighWatermarks),
  ]);
  const inboxId = await ctx.db.insert("operationsAutonomyInbox", {
    eventId: args.eventId,
    policyVersionId: policy._id,
    operationKey,
    trigger: { kind: "signal", fingerprint, signalKeys },
    sourceSnapshot: args.snapshot,
    sourceFactHighWatermarks,
    sourceChecksum,
    nextAttemptAt: args.now,
    lifecycle: { kind: "pending" },
    createdAt: args.now,
    updatedAt: args.now,
  });
  await ctx.db.patch(state._id, {
    pendingWorkCount: state.pendingWorkCount + 1,
    lastTriggerFingerprint: fingerprint,
    lastSignalAt: args.now,
    cycle: episode,
    updatedAt: args.now,
    version: state.version + 1,
  });
  return inboxId;
}

export async function enqueueOperationsAutonomySchedule(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    policy: Doc<"operationsAutonomyPolicyVersions">;
    snapshot: OperationsHealthSnapshot;
    scheduledFor: number;
    now: number;
  },
) {
  const operationKey = `schedule:${args.policy._id}:${args.scheduledFor}`;
  const existing = await ctx.db
    .query("operationsAutonomyInbox")
    .withIndex("by_event_operation_key", (index) =>
      index.eq("eventId", args.eventId).eq("operationKey", operationKey),
    )
    .unique();
  if (existing) return existing._id;
  const state = await ctx.db
    .query("operationsAutonomyStates")
    .withIndex("by_policy", (index) => index.eq("policyVersionId", args.policy._id))
    .unique();
  if (!state || state.lifecycle.kind !== "active") return null;
  const highWatermarks = await readSourceFactHighWatermarks(
    ctx,
    args.eventId,
    args.policy.allowedReadTools,
  );
  const inboxId = await ctx.db.insert("operationsAutonomyInbox", {
    eventId: args.eventId,
    policyVersionId: args.policy._id,
    operationKey,
    trigger: { kind: "schedule", scheduledFor: args.scheduledFor },
    sourceSnapshot: args.snapshot,
    sourceFactHighWatermarks: highWatermarks,
    sourceChecksum: operationFingerprint([
      JSON.stringify(args.snapshot),
      JSON.stringify(highWatermarks),
    ]),
    nextAttemptAt: args.now,
    lifecycle: { kind: "pending" },
    createdAt: args.now,
    updatedAt: args.now,
  });
  await ctx.db.patch(state._id, {
    pendingWorkCount: state.pendingWorkCount + 1,
    updatedAt: args.now,
    version: state.version + 1,
  });
  return inboxId;
}

export async function enqueueOperationsAutonomyManual(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    policy: Doc<"operationsAutonomyPolicyVersions">;
    snapshot: OperationsHealthSnapshot;
    requestedByPersonId: Id<"people">;
    clientOperationId: string;
    now: number;
  },
) {
  const operationKey = `manual:${args.policy._id}:${args.requestedByPersonId}:${args.clientOperationId}`;
  const existing = await ctx.db
    .query("operationsAutonomyInbox")
    .withIndex("by_event_operation_key", (index) =>
      index.eq("eventId", args.eventId).eq("operationKey", operationKey),
    )
    .unique();
  if (existing) return existing;
  const state = await ctx.db
    .query("operationsAutonomyStates")
    .withIndex("by_policy", (index) => index.eq("policyVersionId", args.policy._id))
    .unique();
  if (!state || state.lifecycle.kind !== "active") return null;
  const highWatermarks = await readSourceFactHighWatermarks(
    ctx,
    args.eventId,
    args.policy.allowedReadTools,
  );
  const inboxId = await ctx.db.insert("operationsAutonomyInbox", {
    eventId: args.eventId,
    policyVersionId: args.policy._id,
    operationKey,
    trigger: {
      kind: "manual",
      requestedByPersonId: args.requestedByPersonId,
      clientOperationId: args.clientOperationId,
    },
    sourceSnapshot: args.snapshot,
    sourceFactHighWatermarks: highWatermarks,
    sourceChecksum: operationFingerprint([
      JSON.stringify(args.snapshot),
      JSON.stringify(highWatermarks),
    ]),
    nextAttemptAt: args.now,
    lifecycle: { kind: "pending" },
    createdAt: args.now,
    updatedAt: args.now,
  });
  await ctx.db.patch(state._id, {
    pendingWorkCount: state.pendingWorkCount + 1,
    updatedAt: args.now,
    version: state.version + 1,
  });
  const inserted = await ctx.db.get(inboxId);
  if (!inserted) throw new Error("The manual autonomy work item could not be read.");
  return inserted;
}
