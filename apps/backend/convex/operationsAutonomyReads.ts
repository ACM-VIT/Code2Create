import {
  operationsIntelligenceProtocolVersion,
  type OperationsAutonomyReadRequest,
  type OperationsAutonomyReadTool,
} from "@code2create/domain";
import { ConvexError, v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { cancelAutonomyRun } from "./lib/operationsAutonomyCancellation";
import {
  assertAutonomyReadAllowed,
  autonomyOperationFingerprint,
  nextAutonomySequence,
  patchAutonomyCheckpoint,
  requireAutonomyBoundary,
} from "./lib/operationsAutonomyLedger";
import { operationsAutonomyReadTool } from "./lib/operationsAutonomyValidators";
import { operationsAutonomyReadPageMaximumBytes } from "./lib/operationsAutonomyReadLimits";
import { requireCurrentAutonomyAuthority } from "./lib/operationsAutonomyRuntime";

const factReadTools = [
  "operations_attention",
  "review_exceptions",
  "support_load",
  "intake_jobs",
  "admission_jobs",
  "participant_deliveries",
  "integration_jobs",
  "round_export_jobs",
  "synesthesia_operations",
  "incident_readiness",
  "attendance_operations",
] as const satisfies readonly OperationsAutonomyReadTool[];

type FactReadTool = (typeof factReadTools)[number];

function isFactReadTool(read: OperationsAutonomyReadTool): read is FactReadTool {
  return factReadTools.some((candidate) => candidate === read);
}

function frozenCursorState(snapshot: string) {
  return JSON.stringify({ kind: "frozen", snapshot, offset: 0 });
}

function factCursorState(snapshot: string) {
  return JSON.stringify({ kind: "facts", snapshot, afterSequence: 0 });
}

function emptySupportSummary() {
  return {
    byState: { open: 0, investigating: 0, waiting: 0, resolved: 0, closed: 0 },
    openByCategory: [],
    unassignedActiveCount: 0,
  };
}

export const autonomyReadRequest = v.object({
  protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
  runId: v.string(),
  policyVersionId: v.string(),
  policyChecksum: v.string(),
  sourceChecksum: v.string(),
  operationId: v.string(),
  read: operationsAutonomyReadTool,
  cursor: v.optional(v.string()),
});

export const prepareRead = internalMutation({
  args: { request: autonomyReadRequest, now: v.number() },
  returns: v.union(
    v.object({ state: v.literal("replay"), responseJson: v.string() }),
    v.object({
      state: v.literal("capture"),
      eventId: v.id("events"),
      runId: v.id("operationsAutonomyRuns"),
      read: operationsAutonomyReadTool,
      traversalSnapshot: v.string(),
      cursorStateJson: v.string(),
      generatedAt: v.number(),
      maximumBytes: v.number(),
    }),
    v.object({
      state: v.literal("execute"),
      eventId: v.id("events"),
      runId: v.id("operationsAutonomyRuns"),
      read: operationsAutonomyReadTool,
      traversalSnapshot: v.string(),
      cursorStateJson: v.string(),
      generatedAt: v.number(),
      maximumBytes: v.number(),
    }),
    v.object({ state: v.literal("rejected"), code: v.literal("authority_revoked") }),
  ),
  handler: async (ctx, args) => {
    const request: OperationsAutonomyReadRequest = args.request;
    const fingerprint = autonomyOperationFingerprint(request);
    const boundary = await requireAutonomyBoundary(ctx, {
      ...request,
      kind: "read",
      fingerprint,
      now: args.now,
    });
    if (boundary.state === "replay") {
      if (boundary.prior.kind !== "read") throw new Error("The autonomy read receipt is corrupt.");
      if (boundary.prior.state === "completed") {
        return { state: "replay" as const, responseJson: boundary.prior.responseJson };
      }
      if (boundary.prior.state !== "reserved") {
        throw new ConvexError({
          code: "OPERATIONS_AUTONOMY_READ_TERMINAL_FAILURE",
          message: "The stored autonomy read receipt cannot be resumed.",
        });
      }
      const authority = await requireCurrentAutonomyAuthority(ctx, boundary.run, args.now);
      if (authority.state !== "active") {
        await cancelAutonomyRun(ctx, {
          runId: boundary.run._id,
          reason: authority.reason,
          now: args.now,
        });
        return { state: "rejected" as const, code: "authority_revoked" as const };
      }
      return {
        state: isFactReadTool(boundary.prior.read) ? ("execute" as const) : ("capture" as const),
        eventId: boundary.run.eventId,
        runId: boundary.run._id,
        read: boundary.prior.read,
        traversalSnapshot: boundary.prior.traversalSnapshot,
        cursorStateJson: boundary.prior.cursorStateJson,
        generatedAt: boundary.prior.createdAt,
        maximumBytes: boundary.prior.maximumBytes,
      };
    }
    if (boundary.state === "revoked") {
      await cancelAutonomyRun(ctx, {
        runId: boundary.run._id,
        reason: boundary.reason,
        now: args.now,
      });
      return { state: "rejected" as const, code: "authority_revoked" as const };
    }
    assertAutonomyReadAllowed(boundary.run, request.read);
    if (boundary.checkpoint.activeRead.kind !== "none") {
      throw new ConvexError({
        code: "OPERATIONS_AUTONOMY_READ_IN_PROGRESS",
        message: "Another autonomy read page is still in progress.",
      });
    }
    let traversalSnapshot: string;
    let cursorStateJson: string;
    if (request.cursor === undefined) {
      traversalSnapshot = `snapshot:${autonomyOperationFingerprint({
        runId: boundary.run._id,
        operationId: boundary.operationId,
        createdAt: args.now,
      })}`;
      cursorStateJson = isFactReadTool(request.read)
        ? factCursorState(traversalSnapshot)
        : frozenCursorState(traversalSnapshot);
    } else {
      const priorPage = await ctx.db
        .query("operationsAutonomyOperationReceipts")
        .withIndex("by_run_continue_cursor", (index) =>
          index.eq("runId", boundary.run._id).eq("continueCursor", request.cursor),
        )
        .unique();
      if (
        !priorPage ||
        priorPage.kind !== "read" ||
        priorPage.state !== "completed" ||
        priorPage.read !== request.read ||
        priorPage.isDone ||
        priorPage.nextCursorStateJson === undefined
      ) {
        throw new ConvexError({
          code: "OPERATIONS_AUTONOMY_CURSOR_INVALID",
          message: "The autonomy read cursor is invalid or belongs to another traversal.",
        });
      }
      traversalSnapshot = priorPage.traversalSnapshot;
      cursorStateJson = priorPage.nextCursorStateJson;
    }
    if (request.cursor === undefined && isFactReadTool(request.read)) {
      const factRead = request.read;
      const state = await ctx.db
        .query("operationsAutonomyReadFactStates")
        .withIndex("by_event_source", (index) =>
          index.eq("eventId", boundary.run.eventId).eq("source", factRead),
        )
        .unique();
      const frozenHighWatermark =
        boundary.run.sourceFactHighWatermarks.find((entry) => entry.read === factRead)?.sequence ??
        0;
      if ((state?.sequence ?? 0) < frozenHighWatermark) {
        throw new Error("The autonomy source fact ledger is behind its frozen high-watermark.");
      }
      const highWatermark = frozenHighWatermark;
      const summary =
        factRead === "support_load"
          ? state?.source === "support_load"
            ? {
                byState: state.byState,
                openByCategory: state.openByCategory,
                unassignedActiveCount: state.unassignedActiveCount,
                ...(state.oldestOpenAt === undefined ? {} : { oldestOpenAt: state.oldestOpenAt }),
              }
            : emptySupportSummary()
          : {};
      await ctx.db.insert("operationsAutonomyReadTraversals", {
        eventId: boundary.run.eventId,
        runId: boundary.run._id,
        snapshot: traversalSnapshot,
        read: factRead,
        generatedAt: args.now,
        kind: "facts",
        highWatermark,
        summaryJson: JSON.stringify(summary),
        createdAt: args.now,
      });
    }
    const sequence = await nextAutonomySequence(ctx, boundary.checkpoint);
    await ctx.db.insert("operationsAutonomyOperationReceipts", {
      eventId: boundary.run.eventId,
      runId: boundary.run._id,
      operationId: boundary.operationId,
      sequence,
      fingerprint,
      kind: "read",
      state: "reserved",
      read: request.read,
      maximumBytes: operationsAutonomyReadPageMaximumBytes,
      traversalSnapshot,
      ...(request.cursor === undefined ? {} : { requestedCursor: request.cursor }),
      cursorStateJson,
      createdAt: args.now,
    });
    await patchAutonomyCheckpoint(ctx, boundary.checkpoint, {
      sequence,
      toolCallsUsed: boundary.checkpoint.toolCallsUsed + 1,
      activeRead: {
        kind: "reserved",
        operationId: boundary.operationId,
        sequence,
        fingerprint,
        maximumBytes: operationsAutonomyReadPageMaximumBytes,
      },
      now: args.now,
    });
    return {
      state:
        request.cursor === undefined && !isFactReadTool(request.read)
          ? ("capture" as const)
          : ("execute" as const),
      eventId: boundary.run.eventId,
      runId: boundary.run._id,
      read: request.read,
      traversalSnapshot,
      cursorStateJson,
      generatedAt: args.now,
      maximumBytes: operationsAutonomyReadPageMaximumBytes,
    };
  },
});

export const storeFrozenTraversal = internalMutation({
  args: {
    request: autonomyReadRequest,
    dataJson: v.string(),
    generatedAt: v.number(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runId = ctx.db.normalizeId("operationsAutonomyRuns", args.request.runId);
    if (!runId) throw new Error("The autonomy read run ID is invalid.");
    const operationId = args.request.operationId.trim();
    const fingerprint = autonomyOperationFingerprint(args.request);
    const stored = await ctx.db
      .query("operationsAutonomyOperationReceipts")
      .withIndex("by_run_operation", (index) =>
        index.eq("runId", runId).eq("operationId", operationId),
      )
      .unique();
    if (
      !stored ||
      stored.kind !== "read" ||
      stored.state !== "reserved" ||
      stored.fingerprint !== fingerprint ||
      isFactReadTool(stored.read) ||
      stored.createdAt !== args.generatedAt
    ) {
      throw new Error("The frozen autonomy traversal reservation is invalid.");
    }
    const existing = await ctx.db
      .query("operationsAutonomyReadTraversals")
      .withIndex("by_run_snapshot", (index) =>
        index.eq("runId", runId).eq("snapshot", stored.traversalSnapshot),
      )
      .unique();
    if (existing) {
      if (existing.kind !== "frozen" || existing.read !== stored.read) {
        throw new Error("The stored autonomy traversal conflicts with the read.");
      }
      return null;
    }
    await ctx.db.insert("operationsAutonomyReadTraversals", {
      eventId: stored.eventId,
      runId,
      snapshot: stored.traversalSnapshot,
      read: stored.read,
      generatedAt: args.generatedAt,
      kind: "frozen",
      dataJson: args.dataJson,
      createdAt: args.now,
    });
    return null;
  },
});

export const commitRead = internalMutation({
  args: {
    request: autonomyReadRequest,
    dataJson: v.string(),
    dataBytes: v.number(),
    generatedAt: v.number(),
    citationRows: v.array(v.array(v.string())),
    isDone: v.boolean(),
    nextCursorStateJson: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.union(
    v.object({ state: v.literal("committed"), responseJson: v.string() }),
    v.object({ state: v.literal("rejected"), code: v.literal("authority_revoked") }),
  ),
  handler: async (ctx, args) => {
    if (args.dataBytes > operationsAutonomyReadPageMaximumBytes) {
      throw new ConvexError({
        code: "OPERATIONS_AUTONOMY_PAGE_TOO_LARGE",
        message: "The redacted autonomy read page exceeds the technical response limit.",
      });
    }
    if (args.isDone === (args.nextCursorStateJson !== undefined)) {
      throw new Error("The autonomy read page continuation state is inconsistent.");
    }
    const runId = ctx.db.normalizeId("operationsAutonomyRuns", args.request.runId);
    if (!runId) throw new Error("The autonomy read run ID is invalid.");
    const operationId = args.request.operationId.trim();
    const fingerprint = autonomyOperationFingerprint(args.request);
    const stored = await ctx.db
      .query("operationsAutonomyOperationReceipts")
      .withIndex("by_run_operation", (index) =>
        index.eq("runId", runId).eq("operationId", operationId),
      )
      .unique();
    if (!stored || stored.kind !== "read" || stored.fingerprint !== fingerprint) {
      throw new Error("The autonomy read reservation is missing or conflicts.");
    }
    if (stored.state === "completed") {
      return { state: "committed" as const, responseJson: stored.responseJson };
    }
    if (stored.state !== "reserved")
      throw new Error("The autonomy read reservation is not writable.");
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("The autonomy read run is missing.");
    const authority = await requireCurrentAutonomyAuthority(ctx, run, args.now);
    if (authority.state !== "active") {
      await cancelAutonomyRun(ctx, {
        runId,
        reason: authority.reason,
        now: args.now,
      });
      return { state: "rejected" as const, code: "authority_revoked" as const };
    }
    const checkpoint = await ctx.db
      .query("operationsAutonomyRunCheckpoints")
      .withIndex("by_run", (index) => index.eq("runId", runId))
      .unique();
    if (
      !checkpoint ||
      checkpoint.activeRead.kind !== "reserved" ||
      checkpoint.activeRead.operationId !== operationId ||
      checkpoint.activeRead.sequence !== stored.sequence
    )
      throw new Error("The autonomy read checkpoint does not own this reservation.");
    const continueCursor = args.isDone
      ? undefined
      : `cursor:${autonomyOperationFingerprint({
          runId,
          sequence: stored.sequence,
          operationId,
          next: args.nextCursorStateJson,
        })}`;
    const data: unknown = JSON.parse(args.dataJson);
    const receipt = {
      state: "accepted",
      sequence: stored.sequence,
      read: stored.read,
      data,
      page: {
        ...(continueCursor === undefined ? {} : { cursor: continueCursor }),
        isDone: args.isDone,
        snapshot: stored.traversalSnapshot,
      },
    };
    const responseJson = JSON.stringify(receipt);
    await ctx.db.replace(stored._id, {
      eventId: stored.eventId,
      runId: stored.runId,
      operationId: stored.operationId,
      sequence: stored.sequence,
      fingerprint: stored.fingerprint,
      kind: "read",
      state: "completed",
      read: stored.read,
      generatedAt: args.generatedAt,
      traversalSnapshot: stored.traversalSnapshot,
      ...(continueCursor === undefined ? {} : { continueCursor }),
      ...(args.nextCursorStateJson === undefined
        ? {}
        : { nextCursorStateJson: args.nextCursorStateJson }),
      isDone: args.isDone,
      citationRows: args.citationRows,
      responseJson,
      responseBytes: args.dataBytes,
      createdAt: stored.createdAt,
    });
    await patchAutonomyCheckpoint(ctx, checkpoint, {
      sequence: checkpoint.sequence,
      readBytesUsed: checkpoint.readBytesUsed + args.dataBytes,
      activeRead: { kind: "none" },
      now: args.now,
    });
    return { state: "committed" as const, responseJson };
  },
});
