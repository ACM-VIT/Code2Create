import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  closeOperationsAutonomyFactVersion,
  nextOperationsAutonomyFactSequence,
} from "../operationsAutonomyReadFactLedger";

function failureClass(state: Doc<"admissionAIRecommendations">["state"]) {
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

export async function appendAdmissionJobReadFact(
  ctx: MutationCtx,
  row: Doc<"admissionAIRecommendations">,
  now: number,
) {
  const source = "admission_jobs" as const;
  const entityKey = `admission:${row._id}`;
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
      policyVersionId: row.admissionPolicyVersionId,
      ...(row.modelConfigVersionId === undefined
        ? {}
        : { modelConfigVersionId: row.modelConfigVersionId }),
      applicationContentVersion: row.applicationContentVersion,
      createdAt: row.createdAt,
      ...(row.completedAt === undefined ? {} : { completedAt: row.completedAt }),
      ...(row.latencyMs === undefined ? {} : { latencyMs: row.latencyMs }),
      ...(classified === undefined ? {} : { failureClass: classified }),
    },
    createdAt: now,
  });
}

export async function appendAdmissionJobReadFactById(
  ctx: MutationCtx,
  jobId: Id<"admissionAIRecommendations">,
  now: number,
) {
  const row = await ctx.db.get(jobId);
  if (!row) throw new Error("The admission job is missing after its write.");
  await appendAdmissionJobReadFact(ctx, row, now);
}
