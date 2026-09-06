import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  closeOperationsAutonomyFactVersion,
  nextOperationsAutonomyFactSequence,
} from "../operationsAutonomyReadFactLedger";

function githubFailure(row: Doc<"githubRepositoryBindings">) {
  if (row.state === "inaccessible") return "inaccessible" as const;
  if (row.syncState === "rate_limited") return "rate_limited" as const;
  if (row.syncState === "error") return "sync_error" as const;
  return undefined;
}

export async function appendGithubIntegrationReadFact(
  ctx: MutationCtx,
  row: Doc<"githubRepositoryBindings">,
  now: number,
) {
  const source = "integration_jobs" as const;
  const entityKey = `github:${row._id}`;
  const sequence = await nextOperationsAutonomyFactSequence(ctx, row.eventId, source, now);
  await closeOperationsAutonomyFactVersion(ctx, {
    eventId: row.eventId,
    source,
    entityKey,
    sequence,
  });
  const classified = githubFailure(row);
  await ctx.db.insert("operationsAutonomyReadFacts", {
    eventId: row.eventId,
    source,
    entityKey,
    sequence,
    value: {
      provider: "github",
      bindingId: row._id,
      state: row.state,
      syncState: row.syncState,
      topicState: row.topicState,
      version: row.version,
      syncRevision: row.syncRevision,
      syncedRevision: row.syncedRevision,
      connectedAt: row.connectedAt,
      updatedAt: row.updatedAt,
      ...(row.syncLeaseExpiresAt === undefined ? {} : { leaseExpiresAt: row.syncLeaseExpiresAt }),
      ...(classified === undefined ? {} : { failureClass: classified }),
    },
    createdAt: now,
  });
}

export async function appendGithubIntegrationReadFactById(
  ctx: MutationCtx,
  bindingId: Id<"githubRepositoryBindings">,
  now: number,
) {
  const row = await ctx.db.get(bindingId);
  if (!row) throw new Error("The GitHub integration binding is missing after its write.");
  await appendGithubIntegrationReadFact(ctx, row, now);
}
