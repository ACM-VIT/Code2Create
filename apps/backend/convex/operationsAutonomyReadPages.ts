import { v } from "convex/values";
import type { OperationsAutonomyReadTool } from "@code2create/domain";

import type { Doc } from "./_generated/dataModel";
import { internalAction, internalQuery } from "./_generated/server";
import { runIntelligenceRead } from "./intelligenceReads";
import { operationsAttentionIntelligenceStatement } from "./lib/operationsAutonomyReadFacts";
import {
  operationsAutonomyReadPageMaximumBytes,
  operationsAutonomyReadPageMaximumRows,
} from "./lib/operationsAutonomyReadLimits";
import { operationsAutonomyReadTool } from "./lib/operationsAutonomyValidators";

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
] as const;

type FactReadTool = (typeof factReadTools)[number];

function isFactReadTool(read: OperationsAutonomyReadTool): read is FactReadTool {
  return factReadTools.some((candidate) => candidate === read);
}

const utf8 = new TextEncoder();

type FrozenCursor = { kind: "frozen"; snapshot: string; offset: number };
type FactCursor = { kind: "facts"; snapshot: string; afterSequence: number };
type CursorState = FrozenCursor | FactCursor;

function cursorState(value: string): CursorState {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("kind" in parsed) ||
    !("snapshot" in parsed)
  ) {
    throw new Error("The autonomy read cursor state is invalid.");
  }
  if (typeof parsed.snapshot !== "string" || parsed.snapshot.length === 0) {
    throw new Error("The autonomy read cursor snapshot is invalid.");
  }
  if (
    parsed.kind === "frozen" &&
    "offset" in parsed &&
    typeof parsed.offset === "number" &&
    Number.isSafeInteger(parsed.offset) &&
    parsed.offset >= 0
  )
    return { kind: "frozen", snapshot: parsed.snapshot, offset: parsed.offset };
  if (
    parsed.kind === "facts" &&
    "afterSequence" in parsed &&
    typeof parsed.afterSequence === "number" &&
    Number.isSafeInteger(parsed.afterSequence) &&
    parsed.afterSequence >= 0
  )
    return { kind: "facts", snapshot: parsed.snapshot, afterSequence: parsed.afterSequence };
  throw new Error("The autonomy read cursor state is invalid.");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The frozen autonomy read projection is invalid.");
  }
  return Object.fromEntries(Object.entries(value));
}

function frozenRows(read: string, value: unknown) {
  const data = record(value);
  switch (read) {
    case "operations_health":
      return { data, rows: Array<unknown>(), key: null };
    case "review_rounds":
      return { data, rows: Array.isArray(data.rounds) ? data.rounds : [], key: "rounds" };
    case "attendance_counts":
      return { data, rows: Array.isArray(data.sessions) ? data.sessions : [], key: "sessions" };
    case "floor_mapping_progress":
      return { data, rows: Array.isArray(data.zones) ? data.zones : [], key: "zones" };
    default:
      throw new Error("This autonomy read does not use a frozen projection.");
  }
}

function frozenPage(args: {
  data: Record<string, unknown>;
  key: string;
  rows: unknown[];
  offset: number;
  generatedAt: number;
}) {
  if (args.offset > args.rows.length) {
    throw new Error("The frozen autonomy read offset is outside its snapshot.");
  }
  let pageRows: unknown[] = [];
  let dataJson = JSON.stringify({
    ...args.data,
    generatedAt: args.generatedAt,
    [args.key]: pageRows,
  });
  for (
    let index = args.offset;
    index < args.rows.length && pageRows.length < operationsAutonomyReadPageMaximumRows;
    index += 1
  ) {
    const candidateRows = [...pageRows, args.rows[index]];
    const candidateJson = JSON.stringify({
      ...args.data,
      generatedAt: args.generatedAt,
      [args.key]: candidateRows,
    });
    if (utf8.encode(candidateJson).byteLength > operationsAutonomyReadPageMaximumBytes) {
      if (pageRows.length === 0) {
        throw new Error("One frozen autonomy read row exceeds the technical page limit.");
      }
      break;
    }
    pageRows = candidateRows;
    dataJson = candidateJson;
  }
  const nextOffset = args.offset + pageRows.length;
  return { dataJson, nextOffset, isDone: nextOffset >= args.rows.length };
}

function activeAttention(
  value: Extract<Doc<"operationsAutonomyReadFacts">, { source: "operations_attention" }>["value"],
) {
  return value.state === "open" || value.state === "acknowledged";
}

function activeReview(
  value: Extract<Doc<"operationsAutonomyReadFacts">, { source: "review_exceptions" }>["value"],
) {
  return (
    value.kind === "vacancy" ||
    (value.kind === "team" &&
      ["queued", "called", "at_table", "held", "missed"].includes(value.state))
  );
}

function activeSupport(
  value: Extract<Doc<"operationsAutonomyReadFacts">, { source: "support_load" }>["value"],
) {
  return value.state === "open" || value.state === "investigating" || value.state === "waiting";
}

export const captureProjection: ReturnType<typeof internalAction> = internalAction({
  args: {
    eventId: v.id("events"),
    read: operationsAutonomyReadTool,
    generatedAt: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    if (isFactReadTool(args.read)) {
      throw new Error("A fact-ledger autonomy read cannot be captured as a mutable projection.");
    }
    const value: unknown = await runIntelligenceRead(ctx, {
      read: args.read,
      eventId: args.eventId,
      now: args.generatedAt,
    });
    if (value === null) throw new Error("The autonomy read is unavailable.");
    return JSON.stringify(value);
  },
});

export const executePage = internalQuery({
  args: {
    runId: v.id("operationsAutonomyRuns"),
    read: operationsAutonomyReadTool,
    cursorStateJson: v.string(),
  },
  returns: v.object({
    dataJson: v.string(),
    generatedAt: v.number(),
    isDone: v.boolean(),
    nextCursorStateJson: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const cursor = cursorState(args.cursorStateJson);
    const traversal = await ctx.db
      .query("operationsAutonomyReadTraversals")
      .withIndex("by_run_snapshot", (index) =>
        index.eq("runId", args.runId).eq("snapshot", cursor.snapshot),
      )
      .unique();
    if (!traversal || traversal.read !== args.read) {
      throw new Error("The autonomy read traversal is missing or conflicts.");
    }
    if (cursor.kind === "frozen") {
      if (traversal.kind !== "frozen") throw new Error("The autonomy traversal kind conflicts.");
      const projection = frozenRows(args.read, JSON.parse(traversal.dataJson));
      if (projection.key === null) {
        return {
          dataJson: JSON.stringify({ ...projection.data, generatedAt: traversal.generatedAt }),
          generatedAt: traversal.generatedAt,
          isDone: true,
        };
      }
      const page = frozenPage({
        data: projection.data,
        key: projection.key,
        rows: projection.rows,
        offset: cursor.offset,
        generatedAt: traversal.generatedAt,
      });
      return {
        dataJson: page.dataJson,
        generatedAt: traversal.generatedAt,
        isDone: page.isDone,
        ...(page.isDone
          ? {}
          : { nextCursorStateJson: JSON.stringify({ ...cursor, offset: page.nextOffset }) }),
      };
    }
    if (traversal.kind !== "facts") throw new Error("The autonomy traversal kind conflicts.");
    const facts = await ctx.db
      .query("operationsAutonomyReadFacts")
      .withIndex("by_event_source_sequence_entity", (index) =>
        index
          .eq("eventId", traversal.eventId)
          .eq("source", traversal.read)
          .gt("sequence", cursor.afterSequence)
          .lte("sequence", traversal.highWatermark),
      )
      .order("asc")
      .take(operationsAutonomyReadPageMaximumRows + 1);
    const pageFacts = facts.slice(0, operationsAutonomyReadPageMaximumRows);
    const effectiveFacts = pageFacts.filter(
      (fact) =>
        fact.effectiveThroughSequence === undefined ||
        fact.effectiveThroughSequence >= traversal.highWatermark,
    );
    const isDone = facts.length <= operationsAutonomyReadPageMaximumRows;
    const afterSequence = pageFacts.at(-1)?.sequence ?? cursor.afterSequence;
    const summary = record(JSON.parse(traversal.summaryJson));
    let data: Record<string, unknown>;
    if (traversal.read === "operations_attention") {
      const active = effectiveFacts
        .filter((fact) => fact.source === "operations_attention")
        .map((fact) => fact.value)
        .filter(activeAttention);
      data = {
        generatedAt: traversal.generatedAt,
        items: active.map((value) => ({
          ...value,
          statement:
            "detectorKey" in value
              ? operationsAttentionIntelligenceStatement(value.detectorKey)
              : "",
        })),
        atLeast: !isDone,
      };
    } else if (traversal.read === "review_exceptions") {
      const active = effectiveFacts
        .filter((fact) => fact.source === "review_exceptions")
        .map((fact) => fact.value)
        .filter(activeReview);
      data = {
        generatedAt: traversal.generatedAt,
        vacancies: active
          .filter((value) => "kind" in value && value.kind === "vacancy")
          .map(({ kind: _kind, ...value }) => value),
        teams: active
          .filter((value) => "kind" in value && value.kind === "team")
          .map(({ kind: _kind, ...value }) => value),
        atLeast: !isDone,
      };
    } else if (traversal.read === "support_load") {
      const active = effectiveFacts
        .filter((fact) => fact.source === "support_load")
        .map((fact) => fact.value)
        .filter(activeSupport);
      data = {
        generatedAt: traversal.generatedAt,
        ...summary,
        atLeast: !isDone,
        cases: active,
      };
    } else {
      const deepValues = effectiveFacts
        .filter((fact) => fact.source === traversal.read)
        .map((fact) => fact.value);
      const key =
        traversal.read === "participant_deliveries"
          ? "deliveries"
          : traversal.read === "integration_jobs"
            ? "bindings"
            : traversal.read === "round_export_jobs"
              ? "exports"
              : traversal.read === "incident_readiness"
                ? "items"
                : traversal.read === "synesthesia_operations" ||
                    traversal.read === "attendance_operations"
                  ? "operations"
                  : "jobs";
      data = { generatedAt: traversal.generatedAt, [key]: deepValues };
    }
    return {
      dataJson: JSON.stringify(data),
      generatedAt: traversal.generatedAt,
      isDone,
      ...(isDone
        ? {}
        : {
            nextCursorStateJson: JSON.stringify({
              kind: "facts",
              snapshot: traversal.snapshot,
              afterSequence,
            }),
          }),
    };
  },
});
