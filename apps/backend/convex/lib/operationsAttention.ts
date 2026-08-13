/** Shared detector contract. Proposals are data and carry no authority. */

import type { AttentionProposal } from "./operationsAttentionProposals";
import type {
  AttentionDetectorKey,
  AttentionScopeType,
  AttentionSeverity,
  AttentionSubjectType,
} from "../values";

/** The grant that lets a caller see the item at all, checked on every read. */
export type AttentionVisibility = {
  permissionKey: string;
  scopeType: AttentionScopeType;
  scopeId: string;
};

export type DetectedAttentionItem = {
  detectorKey: AttentionDetectorKey;
  /** Detector plus subject. Never a count, an age, or anything that varies. */
  dedupeKey: string;
  subjectType: AttentionSubjectType;
  subjectId: string;
  severity: AttentionSeverity;
  statement: string;
  route: string;
  actionLabel: string;
  visibility: AttentionVisibility;
  /** Raw detector input retained for audit. */
  evidenceJson: string;
  /**
   * Inhibition applies only to items that share a `panel:<id>` or `team:<id>`
   * locus.
   */
  scopes: readonly string[];
  proposal?: AttentionProposal;
};

export const severityRank: Record<AttentionSeverity, number> = {
  critical: 0,
  attention: 1,
  watch: 2,
};

/** Clear delay prevents a flapping condition from resolving immediately. */
export const attentionClearDelayMs = 90_000;

/** Suppresses lower-severity symptoms that share a locus with their cause. */
const inhibitedBy: Record<AttentionDetectorKey, readonly AttentionDetectorKey[]> = {
  panel_seat_empty: [],
  seat_at_risk: ["panel_seat_empty"],
  review_overdue: [],
  review_presence_incomplete: ["panel_seat_empty", "seat_at_risk"],
  team_below_minimum: [],
  team_held: [],
  team_call_overdue: [],
  team_waiting_long: [
    "panel_seat_empty",
    "panel_bottleneck",
    "team_below_minimum",
    "team_held",
  ],
  round_finish_forecast: [],
  panel_bottleneck: ["panel_seat_empty"],
  scorecard_outstanding: [],
};

/** Drops items whose cause is already stated by a higher-severity neighbour. */
export function applyInhibition<Item extends DetectedAttentionItem>(
  items: readonly Item[],
): Item[] {
  return items.filter((item) => {
    const suppressors = inhibitedBy[item.detectorKey];
    if (suppressors.length === 0) return true;
    return !items.some(
      (other) =>
        other !== item &&
        suppressors.includes(other.detectorKey) &&
        other.scopes.some((scope) => item.scopes.includes(scope)),
    );
  });
}

/** Worst first, then the oldest, so the top row is the next job. */
export function sortAttentionItems<
  Item extends { severity: AttentionSeverity; firstObservedAt: number; subjectId: string },
>(items: readonly Item[]): Item[] {
  return [...items].sort(
    (left, right) =>
      severityRank[left.severity] - severityRank[right.severity] ||
      left.firstObservedAt - right.firstObservedAt ||
      left.subjectId.localeCompare(right.subjectId),
  );
}

export function durationPhrase(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
  if (minutes > 0) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

export function countPhrase(count: number, singular: string, plural: string) {
  return count === 1 ? `one ${singular}` : `${count} ${plural}`;
}

export function joinNames(names: readonly string[]) {
  if (names.length === 0) throw new Error("A statement cannot list no names.");
  if (names.length === 1) return names[0] ?? "";
  const head = names.slice(0, -1).join(", ");
  return `${head} and ${names[names.length - 1] ?? ""}`;
}
