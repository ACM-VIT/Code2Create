import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { ConvexError } from "convex/values";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type OperationFingerprintPart = string | number | boolean | null;

export function operationFingerprint(parts: readonly OperationFingerprintPart[]) {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(parts))));
}

export async function findOperation(
  ctx: QueryCtx | MutationCtx,
  args: {
    eventId: Id<"events">;
    actorPersonId: Id<"people">;
    clientOperationId: string;
    commandName: string;
    requestFingerprint: string;
  },
) {
  const operation = await ctx.db
    .query("operationResults")
    .withIndex("by_actor_operation", (index) =>
      index
        .eq("actorPersonId", args.actorPersonId)
        .eq("clientOperationId", args.clientOperationId),
    )
    .unique();
  if (!operation) return null;
  if (
    operation.eventId !== args.eventId ||
    operation.commandName !== args.commandName ||
    operation.requestFingerprint !== args.requestFingerprint
  ) {
    throw new ConvexError({
      code: "OPERATION_ID_REUSED",
      message: "That operation ID was already used for another command.",
    });
  }
  return operation;
}

export async function recordOperation(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    actorPersonId: Id<"people">;
    clientOperationId: string;
    commandName: string;
    requestFingerprint: string;
    targetType: string;
    targetId: string;
    resultJson?: string;
    createdAt: number;
  },
) {
  await ctx.db.insert("operationResults", args);
}
