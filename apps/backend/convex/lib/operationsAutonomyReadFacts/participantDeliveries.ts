import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  closeOperationsAutonomyFactVersion,
  nextOperationsAutonomyFactSequence,
} from "../operationsAutonomyReadFactLedger";

function failureClass(state: Doc<"participantNotificationDeliveries">["state"]) {
  switch (state) {
    case "delivery_delayed": return "delayed" as const;
    case "bounced": return "bounced" as const;
    case "failed": return "failed" as const;
    case "suppressed": return "suppressed" as const;
    case "unknown": return "unknown" as const;
    default: return undefined;
  }
}

export async function appendParticipantDeliveryReadFact(
  ctx: MutationCtx,
  row: Doc<"participantNotificationDeliveries">,
  now: number,
) {
  const source = "participant_deliveries" as const;
  const entityKey = `delivery:${row._id}`;
  const sequence = await nextOperationsAutonomyFactSequence(ctx, row.eventId, source, now);
  await closeOperationsAutonomyFactVersion(ctx, { eventId: row.eventId, source, entityKey, sequence });
  const classified = failureClass(row.state);
  await ctx.db.insert("operationsAutonomyReadFacts", {
    eventId: row.eventId,
    source,
    entityKey,
    sequence,
    value: {
      deliveryId: row._id,
      state: row.state,
      templateKey: row.templateKey,
      policyVersionId: row.communicationsPolicyVersionId,
      retryNumber: row.retryNumber,
      attemptCount: row.attemptCount,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.nextAttemptAt === undefined ? {} : { nextAttemptAt: row.nextAttemptAt }),
      ...(row.completedAt === undefined ? {} : { completedAt: row.completedAt }),
      ...(classified === undefined ? {} : { failureClass: classified }),
    },
    createdAt: now,
  });
}

export async function appendParticipantDeliveryReadFactById(
  ctx: MutationCtx,
  deliveryId: Id<"participantNotificationDeliveries">,
  now: number,
) {
  const row = await ctx.db.get(deliveryId);
  if (!row) throw new Error("The participant delivery is missing after its write.");
  await appendParticipantDeliveryReadFact(ctx, row, now);
}
