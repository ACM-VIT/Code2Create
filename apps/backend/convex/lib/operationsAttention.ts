/**
 * The contract every attention detector writes to, and the two things that keep
 * a durable ledger honest: hysteresis and inhibition.
 *
 * `specs/06-operations-dashboard.md:5` asks the dashboard to answer two
 * questions — what needs my attention now, and where do I do that work. A
 * severity and a count answer neither. Every item here names the thing that is
 * stuck, says what is wrong in the words an operator would use, carries the
 * route to the screen where it gets fixed, and where a single command can fix
 * it, carries that command with its arguments already filled in.
 *
 * A proposal is data. `specs/06-operations-dashboard.md:181` is explicit that
 * execution is never an agent tool: confirming a proposal opens the ordinary
 * mutation, which rechecks the confirming human's grant, scope, current state,
 * and version. Nothing here holds authority.
 */

import type {
  AttentionDetectorKey,
  AttentionScopeType,
  AttentionSeverity,
  AttentionSubjectType,
} from "../values";

/**
 * A prefilled command. `argsJson` is the argument object the ordinary mutation
 * takes, minus the operation ID the confirming client mints. It carries the
 * target's current version so a stale proposal fails against current state the
 * same way a stale operator command does.
 */
export type AttentionProposal = {
  commandName: string;
  permissionKey: string;
  scopeType: AttentionScopeType;
  scopeId: string;
  argsJson: string;
  expiresAt: number;
};

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
  /** What the detector read, kept verbatim so a row can be argued with later. */
  evidenceJson: string;
  /**
   * The loci this item belongs to, as `panel:<id>` or `team:<id>`. Inhibition
   * only fires between items that share a locus, so a short panel silences the
   * teams queued behind it and nothing else.
   */
  scopes: readonly string[];
  proposal?: AttentionProposal;
};

export const severityRank: Record<AttentionSeverity, number> = {
  critical: 0,
  attention: 1,
  watch: 2,
};

/**
 * How long a condition must stay clear before its item resolves.
 *
 * Flapping is solved with time, not cleverness. The persistence side of the
 * same idea lives in each detector, which only reports a condition that has
 * already lasted a stated interval, measured from a timestamp the database
 * already holds rather than from a counter this layer would have to keep.
 */
export const attentionClearDelayMs = 90_000;

/** How long a prefilled command stays offered before the desk must re-derive it. */
export const attentionProposalLifetimeMs = 10 * 60 * 1_000;

/**
 * A high-severity item suppresses the low-severity ones it causes.
 *
 * Without this the board states one problem several times: a panel missing a
 * reviewer also shows every team queued behind it as waiting too long, and the
 * desk reads five rows where there is one job.
 */
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
export function applyInhibition(
  items: readonly DetectedAttentionItem[],
): DetectedAttentionItem[] {
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

/** "9m40s", the unit an operator uses out loud for a pace or an overrun. */
export function durationPhrase(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
  if (minutes > 0) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

/** "4 teams" / "one team", so a statement reads like a sentence. */
export function countPhrase(count: number, singular: string, plural: string) {
  return count === 1 ? `one ${singular}` : `${count} ${plural}`;
}

export function joinNames(names: readonly string[]) {
  if (names.length === 0) throw new Error("A statement cannot list no names.");
  if (names.length === 1) return names[0] ?? "";
  const head = names.slice(0, -1).join(", ");
  return `${head} and ${names[names.length - 1] ?? ""}`;
}
