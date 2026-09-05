import { createHash } from "node:crypto";
import type { ShortlistTask } from "@code2create/domain";

// The run directory already identifies the model, release, seed and targets.
// Successful recovery can still change this task within that same directory.
export function shortlistAuditCacheKey(
  task: Extract<ShortlistTask, { kind: "audit" }>,
) {
  return `audit-${createHash("sha256").update(JSON.stringify(task)).digest("hex")}`;
}
