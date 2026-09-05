import { TableAggregate } from "@convex-dev/aggregate";

import { components } from "../_generated/api";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type ServiceQueueKind = Doc<"participantServiceQueueEntries">["kind"];
type ServiceQueueNamespace = [Id<"events">, ServiceQueueKind];
type NewServiceQueueEntry = Omit<
  Doc<"participantServiceQueueEntries">,
  "_id" | "_creationTime"
>;

const participantServiceQueues = new TableAggregate<{
  Namespace: ServiceQueueNamespace;
  Key: [number, number];
  DataModel: DataModel;
  TableName: "participantServiceQueueEntries";
}>(components.participantServiceQueues, {
  namespace: (entry) => [entry.eventId, entry.kind],
  sortKey: (entry) => [entry.joinedAt, entry._creationTime],
});

function namespace(eventId: Id<"events">, kind: ServiceQueueKind): ServiceQueueNamespace {
  return [eventId, kind];
}

export async function insertParticipantServiceQueueEntry(
  ctx: MutationCtx,
  value: NewServiceQueueEntry,
) {
  const entryId = await ctx.db.insert("participantServiceQueueEntries", value);
  const entry = await ctx.db.get(entryId);
  if (!entry) throw new Error("The participant service queue entry did not persist.");
  await participantServiceQueues.insert(ctx, entry);
  return entry;
}

export async function deleteParticipantServiceQueueEntry(
  ctx: MutationCtx,
  entry: Doc<"participantServiceQueueEntries">,
) {
  await ctx.db.delete(entry._id);
  await participantServiceQueues.delete(ctx, entry);
}

export async function participantServiceQueueStatus(
  ctx: QueryCtx,
  eventId: Id<"events">,
  kind: ServiceQueueKind,
  ownEntry: Doc<"participantServiceQueueEntries"> | null,
) {
  const queueNamespace = namespace(eventId, kind);
  const waitingCount = await participantServiceQueues.count(ctx, {
    namespace: queueNamespace,
  });
  if (!ownEntry) return { position: null, waitingCount };
  const position = await participantServiceQueues.indexOfDoc(ctx, ownEntry);
  const projected = await participantServiceQueues.at(ctx, position, {
    namespace: queueNamespace,
  });
  if (
    projected.id !== ownEntry._id ||
    projected.key[0] !== ownEntry.joinedAt ||
    projected.key[1] !== ownEntry._creationTime
  ) {
    throw new Error("The participant is missing from the service queue projection.");
  }
  return { position: position + 1, waitingCount };
}
