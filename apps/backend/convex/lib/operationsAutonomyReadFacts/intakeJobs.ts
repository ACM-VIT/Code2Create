import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  closeOperationsAutonomyFactVersion,
  nextOperationsAutonomyFactSequence,
} from "../operationsAutonomyReadFactLedger";

function failureClass(state: Doc<"intakeInterpretations">["state"]) {
  switch (state) {
    case "refused":
      return "refused" as const;
    case "invalid":
      return "invalid" as const;
    case "timed_out":
      return "timeout" as const;
    case "rate_limited":
      return "rate_limited" as const;
    case "failed":
      return "failed" as const;
    default:
      return undefined;
  }
}

export async function appendIntakeJobReadFact(
  ctx: MutationCtx,
  row: Doc<"intakeInterpretations">,
  now: number,
) {
  const source = "intake_jobs" as const;
  const entityKey = `intake:${row._id}`;
  const sequence = await nextOperationsAutonomyFactSequence(ctx, row.eventId, source, now);
  await closeOperationsAutonomyFactVersion(ctx, {
    eventId: row.eventId,
    source,
    entityKey,
    sequence,
  });
  const classified = failureClass(row.state);
  await ctx.db.insert("operationsAutonomyReadFacts", {
    eventId: row.eventId,
    source,
    entityKey,
    sequence,
    value: {
      jobId: row._id,
      state: row.state,
      policyVersionId: row.intakePolicyVersionId,
      ordinal: row.ordinal,
      createdAt: row.createdAt,
      ...(row.completedAt === undefined ? {} : { completedAt: row.completedAt }),
      ...(row.latencyMs === undefined ? {} : { latencyMs: row.latencyMs }),
      ...(classified === undefined ? {} : { failureClass: classified }),
    },
    createdAt: now,
  });
}

export async function appendIntakeJobReadFactById(
  ctx: MutationCtx,
  jobId: Id<"intakeInterpretations">,
  now: number,
) {
  const row = await ctx.db.get(jobId);
  if (!row) throw new Error("The intake job is missing after its write.");
  await appendIntakeJobReadFact(ctx, row, now);
}
